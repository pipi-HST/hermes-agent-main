"""HTTP client for the Hermes Knowledge service (contract v1).

The runtime previously imported the knowledge checkout out of tree on every
request.  This client is the supported integration path: configure
``HERMES_KNOWLEDGE_URL`` + ``HERMES_KNOWLEDGE_TOKEN`` and the runtime talks to
the service over HTTP instead of touching another checkout's files.

Endpoints used (all under ``/api``, bearer auth):

* ``GET  /health``
* ``GET  /captures`` / ``POST /captures``
* ``PATCH /captures/{id}``
* ``POST /capture-drafts/{id}/confirmation`` / ``/commit``
* ``POST /reading/drafts/{id}/confirmation`` / ``/commit``
* ``POST /library/items`` / ``PATCH /library/items/{kind}/{id}`` / ``DELETE``
* ``GET  /library/folders`` / ``POST`` / ``PATCH /library/folders/{path}``
* ``PATCH /capture-drafts/{id}`` / ``DELETE /capture-drafts/{id}``
* ``DELETE /reading/drafts/{id}``
* ``DELETE /knowledge/library/items/{kind}/{id}/permanent``
* ``GET  /knowledge/search``
* ``POST /knowledge/graph/refresh``

Failures are typed so callers can preserve the service's semantics instead of
flattening every error into a 502: 404 -> :class:`KnowledgeNotFound`, 409 ->
:class:`KnowledgeConflict` (carrying the service ``detail`` payload so a
"still referenced" response stays actionable), other 4xx ->
:class:`KnowledgeInvalid`, 5xx / transport errors / invalid configuration ->
:class:`KnowledgeUnavailable`.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from integrations.hermes_knowledge import KnowledgeIncompatible, KnowledgeUnavailable

SERVICE_NAME = "hermes-knowledge"
MIN_CONTRACT_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 30.0

# Only idempotent reads are retried; POST/DELETE must never be replayed.
_RETRYABLE_METHODS = frozenset({"GET", "HEAD"})
_RETRY_ATTEMPTS = 2
_RETRY_BACKOFF_SECONDS = 0.2


# ``KnowledgeUnavailable`` / ``KnowledgeIncompatible`` are re-exported from the
# package: a second definition here used to make ``except package.Exception``
# miss every client failure.
class KnowledgeHttpError(KnowledgeUnavailable):
    """A non-2xx response from the knowledge service."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


class KnowledgeNotFound(KnowledgeHttpError):
    """HTTP 404 — the addressed object does not exist."""


class KnowledgeConflict(KnowledgeHttpError):
    """HTTP 409 — the object is still referenced or otherwise in conflict."""


class KnowledgeInvalid(KnowledgeHttpError):
    """Another HTTP 4xx — the request itself was rejected."""


@dataclass(frozen=True)
class KnowledgeConfig:
    base_url: str
    token: str = ""
    timeout: float = DEFAULT_TIMEOUT_SECONDS


def _parse_timeout(raw: str | None) -> float:
    """Parse ``HERMES_KNOWLEDGE_TIMEOUT`` into seconds.

    A bare ``float()`` used to raise ``ValueError`` for values like ``"30s"``,
    which surfaced as a 500 from the web route.  Bad input is configuration
    error, not a server crash, so it raises :class:`KnowledgeUnavailable`.
    """
    if raw is None or not str(raw).strip():
        return DEFAULT_TIMEOUT_SECONDS
    try:
        timeout = float(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_TIMEOUT must be a number of seconds "
            f"(e.g. 30), got {raw!r}"
        ) from exc
    if timeout <= 0:
        raise KnowledgeUnavailable(
            f"HERMES_KNOWLEDGE_TIMEOUT must be positive, got {raw!r}"
        )
    return timeout


def _normalize_base_url(raw: str) -> str:
    """Validate ``HERMES_KNOWLEDGE_URL`` and strip a trailing slash."""
    value = str(raw or "").strip().rstrip("/")
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_URL must be an absolute http(s) URL "
            f"(e.g. http://127.0.0.1:8001), got {raw!r}"
        )
    if parts.path or parts.query or parts.fragment:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_URL must not include a path, query or fragment "
            f"(the client appends /api itself), got {raw!r}"
        )
    return value


def load_config() -> KnowledgeConfig | None:
    base_url = (os.environ.get("HERMES_KNOWLEDGE_URL") or "").strip()
    if not base_url:
        return None
    return KnowledgeConfig(
        base_url=_normalize_base_url(base_url),
        token=(os.environ.get("HERMES_KNOWLEDGE_TOKEN") or "").strip(),
        timeout=_parse_timeout(os.environ.get("HERMES_KNOWLEDGE_TIMEOUT")),
    )


# ── Contract check cache ────────────────────────────────────────────────────
# One successful health probe is enough for the life of the process: the
# contract version of a running service does not change mid-request, repeated
# probes would add latency to every knowledge tool call, and the public
# ``/api/status`` endpoint must never perform network I/O.  Failures are never
# cached so a service that is still starting up (or being upgraded) is retried
# on the next call.
_CONTRACT_CACHE: dict[str, dict[str, Any]] = {}
_CONTRACT_CACHE_LOCK = threading.Lock()
# One probe lock per service base_url; see _probe_lock().
_CONTRACT_PROBE_LOCKS: dict[str, threading.Lock] = {}


def clear_contract_cache() -> None:
    """Drop cached contract checks (tests and post-upgrade diagnostics)."""
    with _CONTRACT_CACHE_LOCK:
        _CONTRACT_CACHE.clear()


def _probe_lock(base_url: str) -> threading.Lock:
    """Return the per-service lock that serialises the health probe.

    The probe performs network I/O, so it must never run while the cache lock
    is held: ``/api/status`` reads the cache and a slow service would otherwise
    block it for the whole timeout.  A per-URL lock still guarantees that
    concurrent cold-cache callers issue exactly one probe.
    """
    key = str(base_url or "")
    with _CONTRACT_CACHE_LOCK:
        lock = _CONTRACT_PROBE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _CONTRACT_PROBE_LOCKS[key] = lock
        return lock


def _cached_contract_entry(base_url: str) -> dict[str, Any] | None:
    """Return a copy of the cache entry.  The caller must hold the lock."""
    entry = _CONTRACT_CACHE.get(str(base_url or ""))
    return dict(entry) if entry else None


def cached_contract_status(base_url: str) -> dict[str, Any] | None:
    """Read the cached contract check for ``base_url`` without any I/O.

    Returns ``{"contract_version": int, "compatible": bool}`` or ``None`` when
    this process has not successfully validated that service yet.  Request-hot
    callers (``/api/status``) must use this instead of probing the service.
    """
    with _CONTRACT_CACHE_LOCK:
        entry = _cached_contract_entry(base_url)
    if entry is None:
        return None
    return {
        "contract_version": entry.get("contract_version"),
        "compatible": entry.get("compatible"),
    }


class KnowledgeClient:
    def __init__(self, config: KnowledgeConfig, *, transport: httpx.BaseTransport | None = None):
        self._config = config
        # Set by ensure_compatible() once the service contract was validated.
        self.contract_version: int | None = None
        headers = {"User-Agent": "hermes-agent/knowledge-client"}
        if config.token:
            headers["Authorization"] = f"Bearer {config.token}"
        # trust_env=False: a local HTTP(S)_PROXY must never receive the bearer
        # token meant for the knowledge service (which is often on loopback).
        self._client = httpx.Client(
            base_url=config.base_url,
            headers=headers,
            timeout=config.timeout,
            transport=transport,
            trust_env=False,
        )

    @property
    def base_url(self) -> str:
        """Service base URL, also the contract-cache key."""
        return self._config.base_url

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "KnowledgeClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    # -- transport helpers ---------------------------------------------------
    @staticmethod
    def _error_detail(response: httpx.Response) -> Any:
        """Best-effort error body extraction — never raises."""
        try:
            return response.json()
        except (TypeError, ValueError):
            pass
        try:
            text = (response.text or "").strip()
        except Exception:  # noqa: BLE001 - decoding failure is not fatal here
            text = ""
        return text[:300] or f"HTTP {response.status_code}"

    def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Send a request, retrying idempotent reads once on transient failure."""
        method = method.upper()
        attempts = _RETRY_ATTEMPTS if method in _RETRYABLE_METHODS else 1
        last_exc: httpx.HTTPError | None = None
        for attempt in range(attempts):
            try:
                response = self._client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                last_exc = exc
                if attempt + 1 < attempts:
                    time.sleep(_RETRY_BACKOFF_SECONDS)
                    continue
                raise KnowledgeUnavailable(
                    f"knowledge request {method} {path} failed: {exc}"
                ) from exc
            if (
                method in _RETRYABLE_METHODS
                and response.status_code >= 500
                and attempt + 1 < attempts
            ):
                time.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            return response
        # Defensive: the loop always returns or raises above.
        if last_exc is not None:
            raise last_exc
        raise KnowledgeUnavailable(f"knowledge request {method} {path} failed")

    def _raise_for_status(self, response: httpx.Response, method: str, path: str) -> None:
        status = int(response.status_code)
        if status < 400:
            return
        detail = self._error_detail(response)
        message = f"knowledge request {method} {path} -> HTTP {status}: {detail}"
        if status == 404:
            raise KnowledgeNotFound(message, status_code=status, detail=detail)
        if status == 409:
            raise KnowledgeConflict(message, status_code=status, detail=detail)
        if status < 500:
            raise KnowledgeInvalid(message, status_code=status, detail=detail)
        raise KnowledgeUnavailable(message)

    @staticmethod
    def _json_payload(response: httpx.Response, method: str, path: str) -> Any:
        if not response.content:
            return {}
        try:
            return response.json()
        except (TypeError, ValueError) as exc:
            raise KnowledgeUnavailable(
                f"non-JSON response from knowledge {method} {path} "
                f"(HTTP {response.status_code})"
            ) from exc

    # -- contract ------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        response = self._send("GET", "/api/health")
        if response.status_code != 200:
            raise KnowledgeUnavailable(
                f"knowledge health check failed with HTTP {response.status_code}"
            )
        payload = self._json_payload(response, "GET", "/api/health")
        if not isinstance(payload, dict):
            raise KnowledgeUnavailable(
                "non-JSON response from knowledge GET /api/health "
                f"(HTTP {response.status_code})"
            )
        if payload.get("service") != SERVICE_NAME:
            raise KnowledgeIncompatible(
                f"unexpected service: {payload.get('service')!r}"
            )
        return payload

    def assert_compatible(self) -> dict[str, Any]:
        health = self.health()
        try:
            version = int(health.get("contract_version") or 0)
        except (TypeError, ValueError):
            version = 0
        if version < MIN_CONTRACT_VERSION:
            raise KnowledgeIncompatible(
                f"knowledge contract v{version} < required v{MIN_CONTRACT_VERSION}"
            )
        return health

    # -- operations ----------------------------------------------------------
    def request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        response = self._send(method, path, **kwargs)
        self._raise_for_status(response, method, path)
        if response.status_code >= 300:
            # httpx does not follow redirects by default; a 3xx here means the
            # endpoint answered with something other than the JSON contract.
            raise KnowledgeUnavailable(
                f"non-JSON response from knowledge {method} {path} "
                f"(HTTP {response.status_code} redirect is not followed)"
            )
        return self._json_payload(response, method, path)

    def issue_confirmation(self, resource: str, resource_id: str) -> dict[str, Any]:
        """``resource`` is e.g. ``capture-drafts`` or ``reading/drafts``."""
        return self.request("POST", f"/api/{resource}/{resource_id}/confirmation")

    def commit_draft(self, resource: str, resource_id: str, confirmation_token: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/{resource}/{resource_id}/commit",
            json={"confirmation_token": confirmation_token},
        )

    def issue_library_delete_confirmation(self, kind: str, item_id: str) -> dict[str, Any]:
        """Ask the service for a permanent-delete confirmation token.

        Accepts both response shapes the service has shipped (``token`` and
        ``confirmation_token``) and normalises the value under ``token`` so
        callers do not depend on the wire spelling.
        """
        payload = self.request(
            "POST", f"/api/knowledge/library/items/{kind}/{item_id}/confirmation"
        )
        if not isinstance(payload, dict):
            payload = {}
        token = str(payload.get("token") or payload.get("confirmation_token") or "").strip()
        if not token:
            raise KnowledgeUnavailable(
                "knowledge service did not return a permanent-delete "
                "confirmation token"
            )
        normalized = dict(payload)
        normalized["token"] = token
        return normalized

    def permanent_delete_library_item(
        self, kind: str, item_id: str, confirmation_token: str
    ) -> dict[str, Any]:
        token = str(confirmation_token or "").strip()
        if not token:
            # Never send a blank confirmation token: the service would either
            # reject it (mapped to a confusing 502) or, worse, accept it.
            raise KnowledgeUnavailable(
                "refusing to request a permanent delete without a "
                "confirmation token"
            )
        return self.request(
            "DELETE",
            f"/api/knowledge/library/items/{kind}/{item_id}/permanent",
            json={"confirmation_token": token},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )

    def search(self, query: str, *, limit: int = 10) -> dict[str, Any]:
        return self.request("GET", "/api/knowledge/search", params={"q": query, "limit": limit})

    def selection_chat(
        self, kind: str, item_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Run one source-selection discussion through the Knowledge service."""
        return self.request(
            "POST",
            f"/api/knowledge/library/items/{quote(str(kind), safe='')}/"
            f"{quote(str(item_id), safe='')}/selection-chat",
            json=dict(payload),
        )

    def revise_capture_note(self, capture_id: str, instruction: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/captures/{quote(str(capture_id), safe='')}/revise",
            json={"instruction": instruction},
        )

    def cancel_ai_operation(self, operation_id: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/knowledge/ai-operations/{quote(str(operation_id), safe='')}/cancel",
        )

    def update_capture(
        self,
        capture_id: str,
        *,
        body: str = "",
        title: str = "",
        folder_path: str | None = None,
    ) -> dict[str, Any]:
        """Save an edited capture note through the service (contract v1).

        The service owns the vault and the SQLite row, so the dashboard must
        not write the Markdown file itself when HTTP mode is configured.
        """
        payload: dict[str, Any] = {}
        if body:
            payload["body"] = body
        if title:
            payload["title"] = title
        if folder_path is not None:
            payload["folder_path"] = folder_path
        return self.request("PATCH", f"/api/captures/{quote(str(capture_id), safe='')}", json=payload)

    # -- library items ------------------------------------------------------
    def create_library_item(
        self,
        *,
        body: str = "",
        title: str = "",
        source: str = "",
        source_type: str = "manual",
        folder_path: str = "Inbox",
    ) -> dict[str, Any]:
        """Create an editable library draft through the service."""
        return self.request(
            "POST",
            "/api/library/items",
            json={
                "body": body,
                "title": title,
                "source": source,
                "source_type": source_type,
                "folder_path": folder_path,
            },
        )

    def patch_library_item(self, kind: str, item_id: str, **fields: Any) -> dict[str, Any]:
        """Update a library item (``capture`` or ``capture_draft``).

        ``None`` fields are omitted from the payload: the caller only sends the
        fields the user actually edited.
        """
        payload = {key: value for key, value in fields.items() if value is not None}
        return self.request(
            "PATCH",
            f"/api/library/items/{quote(str(kind), safe='')}/{quote(str(item_id), safe='')}",
            json=payload,
        )

    def delete_library_item(self, kind: str, item_id: str) -> dict[str, Any]:
        """Discard a draft or archive a capture through the service."""
        return self.request(
            "DELETE",
            f"/api/library/items/{quote(str(kind), safe='')}/{quote(str(item_id), safe='')}",
        )

    # -- library folders ----------------------------------------------------
    def list_library_folders(self) -> dict[str, Any]:
        return self.request("GET", "/api/library/folders")

    def create_library_folder(self, name: str) -> dict[str, Any]:
        return self.request("POST", "/api/library/folders", json={"name": name})

    def rename_library_folder(self, folder_path: str, name: str) -> dict[str, Any]:
        return self.request(
            "PATCH",
            f"/api/library/folders/{quote(str(folder_path), safe='')}",
            json={"name": name},
        )

    # -- capture / reading drafts -------------------------------------------
    def patch_capture_draft(self, draft_id: str, **fields: Any) -> dict[str, Any]:
        """Update an editable capture draft (title/draft_text/summary/tags/...)."""
        payload = {key: value for key, value in fields.items() if value is not None}
        return self.request(
            "PATCH",
            f"/api/capture-drafts/{quote(str(draft_id), safe='')}",
            json=payload,
        )

    def delete_capture_draft(self, draft_id: str) -> dict[str, Any]:
        """Abandon a capture draft through the service."""
        return self.request(
            "DELETE", f"/api/capture-drafts/{quote(str(draft_id), safe='')}"
        )

    def delete_reading_draft(self, draft_id: str) -> dict[str, Any]:
        """Delete a reading draft through the service."""
        return self.request(
            "DELETE", f"/api/reading/drafts/{quote(str(draft_id), safe='')}"
        )

    # -- library reads ------------------------------------------------------
    def list_library_items(self, **query: Any) -> dict[str, Any]:
        """List library items; empty query values are not sent."""
        params = {
            key: value
            for key, value in query.items()
            if value is not None and value != ""
        }
        return self.request("GET", "/api/library/items", params=params)

    def get_library_item(self, kind: str, item_id: str) -> dict[str, Any]:
        return self.request(
            "GET",
            f"/api/library/items/{quote(str(kind), safe='')}/{quote(str(item_id), safe='')}",
        )

    # -- garden / cards -----------------------------------------------------
    def create_garden_draft(
        self,
        *,
        capture_ids: list[str] | None = None,
        title: str = "",
        card_kind: str = "",
        instruction: str = "",
        auto_commit: bool = True,
    ) -> dict[str, Any]:
        """Run garden synthesis through the service.

        ``auto_commit=True`` preserves the legacy dashboard behavior.  Review
        clients send ``False`` (or call ``preview_garden_draft``) to get a
        draft that must be confirmed explicitly.
        """
        payload = {
            "capture_ids": [str(item) for item in (capture_ids or [])],
            "title": title,
            "card_kind": card_kind,
            "instruction": instruction,
        }
        # Omit the legacy default to keep older fake clients/tests and
        # third-party callers byte-compatible.
        if not auto_commit:
            payload["auto_commit"] = False
        return self.request("POST", "/api/garden/drafts", json=payload)

    def preview_garden_draft(
        self,
        *,
        capture_ids: list[str] | None = None,
        title: str = "",
        card_kind: str = "",
        instruction: str = "",
    ) -> dict[str, Any]:
        return self.request(
            "POST",
            "/api/garden/drafts/preview",
            json={
                "capture_ids": [str(item) for item in (capture_ids or [])],
                "title": title,
                "card_kind": card_kind,
                "instruction": instruction,
            },
        )

    def list_garden_drafts(self, *, limit: int = 50, status: str = "draft_ready") -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        return self.request("GET", "/api/garden/drafts", params=params)

    def commit_garden_draft(self, draft_id: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/garden/drafts/{quote(str(draft_id), safe='')}/commit",
        )

    def discard_garden_draft(self, draft_id: str) -> dict[str, Any]:
        return self.request(
            "DELETE",
            f"/api/garden/drafts/{quote(str(draft_id), safe='')}",
        )

    def list_garden_cards(self, *, limit: int = 100, status: str = "") -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        return self.request("GET", "/api/garden/cards", params=params)

    def delete_garden_card(self, card_id: str) -> dict[str, Any]:
        return self.request(
            "DELETE", f"/api/garden/cards/{quote(str(card_id), safe='')}"
        )

    # -- graph / answer drafts ---------------------------------------------
    def graph(
        self,
        *,
        focus_kind: str = "",
        focus_id: str = "",
        depth: int = 1,
        limit: int = 80,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"depth": depth, "limit": limit}
        if focus_kind:
            params["focus_kind"] = focus_kind
        if focus_id:
            params["focus_id"] = focus_id
        return self.request("GET", "/api/knowledge/graph", params=params)

    def refresh_graph(self) -> dict[str, Any]:
        return self.request("POST", "/api/knowledge/graph/refresh")

    def create_answer_draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Save an answer draft through the service (same envelope as local)."""
        return self.request("POST", "/api/knowledge/answer-drafts", json=dict(payload))

    # -- tool dispatch ------------------------------------------------------
    def call_tool(
        self,
        module_name: str,
        function_name: str,
        *,
        args: list[Any] | None = None,
        kwargs: dict[str, Any] | None = None,
        operation_id: str = "",
    ) -> Any:
        """Invoke a whitelisted ``bridge.<module>.<function>`` on the service.

        This is the HTTP-mode replacement for importing a local checkout's
        bridge modules.  The service returns the bridge result dict as-is
        (including its own ``{"error": ...}`` shape — the tool layer already
        wraps results in the envelope).
        """
        headers = (
            {"X-Hermes-AI-Operation-Id": str(operation_id)}
            if str(operation_id or "").strip()
            else None
        )
        return self.request(
            "POST",
            f"/api/tools/{quote(str(module_name), safe='')}/{quote(str(function_name), safe='')}",
            json={
                "args": list(args or []),
                "kwargs": dict(kwargs or {}),
            },
            headers=headers,
        )


def get_client(transport: httpx.BaseTransport | None = None) -> KnowledgeClient | None:
    """Return a configured, contract-compatible client.

    ``None`` means HTTP mode is not configured (local/disabled knowledge).  A
    service that is unreachable or speaks an incompatible contract raises
    :class:`KnowledgeUnavailable` / :class:`KnowledgeIncompatible`; the client
    is closed before the error propagates so no connection is leaked.
    """
    config = load_config()
    if config is None:
        return None
    client = KnowledgeClient(config, transport=transport)
    try:
        ensure_compatible(client)
    except Exception:
        client.close()
        raise
    return client


def ensure_compatible(client: KnowledgeClient) -> dict[str, Any]:
    """Validate ``client`` against the service contract, caching success.

    The cache key is the service ``base_url``: one successful health probe per
    process is enough.  Failures are never cached, so a service that is down
    during a first attempt is retried on the next call.

    Concurrency: the fast path reads the cache without taking the lock; a miss
    takes the lock and re-checks before probing, so threads racing on a cold
    cache perform a single health request.
    """
    base_url = client.base_url
    with _CONTRACT_CACHE_LOCK:
        entry = _cached_contract_entry(base_url)
    if entry is not None:
        client.contract_version = entry.get("contract_version")
        return dict(entry.get("health") or {})

    # The probe is network I/O: run it under the per-service lock only, never
    # while holding the cache lock (``/api/status`` reads the cache and a slow
    # service would otherwise block it for a whole request timeout).
    with _probe_lock(base_url):
        with _CONTRACT_CACHE_LOCK:
            # Double-check: another thread may have finished the probe while we
            # were waiting.
            entry = _cached_contract_entry(base_url)
        if entry is not None:
            client.contract_version = entry.get("contract_version")
            return dict(entry.get("health") or {})

        health = client.assert_compatible()
        try:
            version = int(health.get("contract_version") or 0)
        except (TypeError, ValueError):
            version = 0
        with _CONTRACT_CACHE_LOCK:
            _CONTRACT_CACHE[base_url] = {
                "contract_version": version,
                "compatible": True,
                "health": dict(health),
            }

    client.contract_version = version
    return health
