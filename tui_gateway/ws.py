"""WebSocket transport for the tui_gateway JSON-RPC server.

Reuses :func:`tui_gateway.server.dispatch` verbatim so every RPC method, every
slash command, every approval/clarify/sudo flow, and every agent event flows
through the same handlers whether the client is Ink over stdio or an iOS /
web client over WebSocket.

Wire protocol
-------------
Identical to stdio: newline-delimited JSON-RPC in both directions. The server
emits a ``gateway.ready`` event immediately after connection accept, then
echoes responses/events for inbound requests. No framing differences.

Mounting
--------
    from fastapi import WebSocket
    from tui_gateway.ws import handle_ws

    @app.websocket("/api/ws")
    async def ws(ws: WebSocket):
        await handle_ws(ws)
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from tui_gateway import server

_log = logging.getLogger(__name__)

# Max seconds a pool-dispatched handler will block waiting for the event loop
# to flush a WS frame before we mark the transport dead. Protects handler
# threads from a wedged socket.
_WS_WRITE_TIMEOUT_S = 10.0

# Keep starlette optional at import time; handle_ws uses the real class when
# it's available and falls back to a generic Exception sentinel otherwise.
try:
    from starlette.websockets import WebSocketDisconnect as _WebSocketDisconnect
except ImportError:  # pragma: no cover - starlette is a required install path
    _WebSocketDisconnect = Exception  # type: ignore[assignment]


class WSTransport:
    """Per-connection WS transport with non-blocking ordered FIFO delivery.

    ``write`` is safe to call from any thread (including pool worker threads
    streaming LLM tokens).  Frames are enqueued onto the owning event loop in
    FIFO order and drained by a single writer task so fast streaming never
    blocks the model thread per token or races concurrent ``send_text`` calls.
    """

    is_web = True

    def __init__(self, ws: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._ws = ws
        self._loop = loop
        self._closed = False
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._writer_task: asyncio.Task[None] | None = loop.create_task(self._writer_loop())

    async def _writer_loop(self) -> None:
        try:
            while True:
                line = await self._queue.get()
                if line is None:
                    break
                if self._closed:
                    continue
                try:
                    await self._ws.send_text(line)
                except Exception as exc:
                    self._closed = True
                    _log.debug("ws send failed: %s", exc)
                    try:
                        await self._ws.close()
                    except Exception:
                        pass
                    break
        except asyncio.CancelledError:
            pass

    def _enqueue(self, line: str) -> None:
        if not self._closed:
            self._queue.put_nowait(line)

    def write(self, obj: dict) -> bool:
        if self._closed:
            return False

        line = json.dumps(obj, ensure_ascii=False)

        try:
            on_loop = asyncio.get_running_loop() is self._loop
        except RuntimeError:
            on_loop = False

        if on_loop:
            self._enqueue(line)
            return True

        try:
            self._loop.call_soon_threadsafe(self._enqueue, line)
            return not self._closed
        except Exception as exc:
            self._closed = True
            _log.debug("ws enqueue failed: %s", exc)
            return False

    async def write_async(self, obj: dict) -> bool:
        """Send from the owning event loop (ordered behind any queued deltas)."""
        if self._closed:
            return False
        self._enqueue(json.dumps(obj, ensure_ascii=False))
        return not self._closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, None)
        except Exception:
            pass


async def handle_ws(ws: Any) -> None:
    """Run one WebSocket session. Wire-compatible with ``tui_gateway.entry``."""
    await ws.accept()

    transport = WSTransport(ws, asyncio.get_running_loop())

    await transport.write_async(
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "gateway.ready",
                "payload": {"skin": server.resolve_skin()},
            },
        }
    )

    try:
        while True:
            try:
                raw = await ws.receive_text()
            except _WebSocketDisconnect:
                break

            line = raw.strip()
            if not line:
                continue

            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                ok = await transport.write_async(
                    {
                        "jsonrpc": "2.0",
                        "error": {"code": -32700, "message": "parse error"},
                        "id": None,
                    }
                )
                if not ok:
                    break
                continue

            # dispatch() may schedule long handlers on the pool; it returns
            # None in that case and the worker writes the response itself via
            # the transport we pass in (a separate thread, so transport.write
            # is the safe path there). For inline handlers it returns the
            # response dict, which we write here from the loop.
            resp = await asyncio.to_thread(server.dispatch, req, transport)
            if resp is not None and not await transport.write_async(resp):
                break
    finally:
        transport.close()

        # Detach the transport from any sessions it owned so later emits
        # fall back to stdio instead of crashing into a closed socket.
        for _, sess in list(server._sessions.items()):
            if sess.get("transport") is transport:
                sess["transport"] = server._stdio_transport

        try:
            await ws.close()
        except Exception:
            pass
