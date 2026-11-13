"""
Hermes Agent — Web UI server.

Provides a FastAPI backend serving the Vite/React frontend and REST API
endpoints for managing configuration, environment variables, and sessions.

Usage:
    python -m hermes_cli.main web          # Start on http://127.0.0.1:9119
    python -m hermes_cli.main web --port 8080
"""

import asyncio
import base64
import hmac
import importlib
import importlib.util
import json
import logging
import os
import plistlib
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from hermes_cli import __version__, __release_date__
from hermes_cli.config import (
    cfg_get,
    DEFAULT_CONFIG,
    OPTIONAL_ENV_VARS,
    get_config_path,
    get_env_path,
    get_hermes_home,
    load_config,
    load_env,
    save_config,
    save_env_value,
    remove_env_value,
    check_config_version,
    redact_key,
)
from gateway.status import get_running_pid, read_runtime_status, runtime_status_is_stale

try:
    from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel, Field
except ImportError:
    # First try lazy-installing the dashboard extras. Only the user actually
    # running `hermes dashboard` needs fastapi+uvicorn; lazy install keeps
    # them out of every other install path. After install, re-import.
    try:
        from tools.lazy_deps import ensure as _lazy_ensure
        _lazy_ensure("tool.dashboard", prompt=False)
        from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
        from fastapi.staticfiles import StaticFiles
        from pydantic import BaseModel, Field
    except Exception:
        raise SystemExit(
            "Web UI requires fastapi and uvicorn.\n"
            f"Install with: {sys.executable} -m pip install 'fastapi' 'uvicorn[standard]'"
        )

WEB_DIST = Path(os.environ["HERMES_WEB_DIST"]) if "HERMES_WEB_DIST" in os.environ else Path(__file__).parent / "web_dist"
_log = logging.getLogger(__name__)

app = FastAPI(title="Hermes Agent", version=__version__)

# ---------------------------------------------------------------------------
# Session token for protecting sensitive endpoints (reveal).
# Generated fresh on every server start — dies when the process exits.
# Injected into the SPA HTML so only the legitimate web UI can use it.
# ---------------------------------------------------------------------------
_SESSION_TOKEN = secrets.token_urlsafe(32)
_SESSION_HEADER_NAME = "X-Hermes-Session-Token"
_AI_OPERATION_HEADER_NAME = "X-Hermes-AI-Operation-Id"
MAX_SELECTION_SEARCH_CHARS = 1000
KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS = float(
    os.environ.get("HERMES_KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS", "95")
)

# In-browser terminal Chat tab (/chat, /api/pty, …). Off unless
# ``hermes dashboard --tui`` or HERMES_DASHBOARD_TUI=1. The JSON-RPC sidecar
# at /api/ws stays available to non-terminal dashboard pages such as
# /knowledge-chat, guarded by the same token and loopback checks.
_DASHBOARD_EMBEDDED_CHAT_ENABLED = False

# Simple rate limiter for the reveal endpoint
_reveal_timestamps: List[float] = []
_REVEAL_MAX_PER_WINDOW = 5
_REVEAL_WINDOW_SECONDS = 30

# CORS: restrict to localhost origins only.  The web UI is intended to run
# locally; binding to 0.0.0.0 with allow_origins=["*"] would let any website
# read/modify config and secrets.

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Endpoints that do NOT require the session token.  Everything else under
# /api/ is gated by the auth middleware below.  Keep this list minimal —
# only truly non-sensitive, read-only endpoints belong here.
# ---------------------------------------------------------------------------
_PUBLIC_API_PATHS: frozenset = frozenset({
    "/api/status",
    "/api/config/defaults",
    "/api/config/schema",
    "/api/model/info",
    "/api/dashboard/themes",
    "/api/dashboard/plugins",
    "/api/dashboard/plugins/rescan",
})


def _has_valid_session_token(request: Request) -> bool:
    """True if the request carries a valid dashboard session token.

    The dedicated session header avoids collisions with reverse proxies that
    already use ``Authorization`` (for example Caddy ``basic_auth``). We still
    accept the legacy Bearer path for backward compatibility with older
    dashboard bundles.
    """
    session_header = request.headers.get(_SESSION_HEADER_NAME, "")
    if session_header and hmac.compare_digest(
        session_header.encode(),
        _SESSION_TOKEN.encode(),
    ):
        return True

    auth = request.headers.get("authorization", "")
    expected = f"Bearer {_SESSION_TOKEN}"
    return hmac.compare_digest(auth.encode(), expected.encode())


def _require_token(request: Request) -> None:
    """Validate the ephemeral session token.  Raises 401 on mismatch."""
    if not _has_valid_session_token(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


# Accepted Host header values for loopback binds. DNS rebinding attacks
# point a victim browser at an attacker-controlled hostname (evil.test)
# which resolves to 127.0.0.1 after a TTL flip — bypassing same-origin
# checks because the browser now considers evil.test and our dashboard
# "same origin". Validating the Host header at the app layer rejects any
# request whose Host isn't one we bound for. See GHSA-ppp5-vxwm-4cf7.
_LOOPBACK_HOST_VALUES: frozenset = frozenset({
    "localhost", "127.0.0.1", "::1",
})


def _is_accepted_host(host_header: str, bound_host: str) -> bool:
    """True if the Host header targets the interface we bound to.

    Accepts:
    - Exact bound host (with or without port suffix)
    - Loopback aliases when bound to loopback
    - Any host when bound to 0.0.0.0 (explicit opt-in to non-loopback,
      no protection possible at this layer)
    """
    if not host_header:
        return False
    # Strip port suffix. IPv6 addresses use bracket notation:
    #   [::1]         — no port
    #   [::1]:9119    — with port
    # Plain hosts/v4:
    #   localhost:9119
    #   127.0.0.1:9119
    h = host_header.strip()
    if h.startswith("["):
        # IPv6 bracketed — port (if any) follows "]:"
        close = h.find("]")
        if close != -1:
            host_only = h[1:close]  # strip brackets
        else:
            host_only = h.strip("[]")
    else:
        host_only = h.rsplit(":", 1)[0] if ":" in h else h
    host_only = host_only.lower()

    # 0.0.0.0 bind means operator explicitly opted into all-interfaces
    # (requires --insecure per web_server.start_server). No Host-layer
    # defence can protect that mode; rely on operator network controls.
    if bound_host in {"0.0.0.0", "::"}:
        return True

    # Loopback bind: accept the loopback names
    bound_lc = bound_host.lower()
    if bound_lc in _LOOPBACK_HOST_VALUES:
        return host_only in _LOOPBACK_HOST_VALUES

    # Explicit non-loopback bind: require exact host match
    return host_only == bound_lc


@app.middleware("http")
async def host_header_middleware(request: Request, call_next):
    """Reject requests whose Host header doesn't match the bound interface.

    Defends against DNS rebinding: a victim browser on a localhost
    dashboard is tricked into fetching from an attacker hostname that
    TTL-flips to 127.0.0.1. CORS and same-origin checks don't help —
    the browser now treats the attacker origin as same-origin with the
    dashboard. Host-header validation at the app layer catches it.

    See GHSA-ppp5-vxwm-4cf7.
    """
    # Store the bound host on app.state so this middleware can read it —
    # set by start_server() at listen time.
    bound_host = getattr(app.state, "bound_host", None)
    if bound_host:
        host_header = request.headers.get("host", "")
        if not _is_accepted_host(host_header, bound_host):
            return JSONResponse(
                status_code=400,
                content={
                    "detail": (
                        "Invalid Host header. Dashboard requests must use "
                        "the hostname the server was bound to."
                    ),
                },
            )
    return await call_next(request)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Require the session token on all /api/ routes except the public list."""
    path = request.url.path
    if path.startswith("/api/") and path not in _PUBLIC_API_PATHS:
        if not _has_valid_session_token(request):
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"},
            )
    return await call_next(request)


# ---------------------------------------------------------------------------
# Config schema — auto-generated from DEFAULT_CONFIG
# ---------------------------------------------------------------------------

# Manual overrides for fields that need select options or custom types
_SCHEMA_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "model": {
        "type": "string",
        "description": "Default model (e.g. anthropic/claude-sonnet-4.6)",
        "category": "general",
    },
    "model_context_length": {
        "type": "number",
        "description": "Context window override (0 = auto-detect from model metadata)",
        "category": "general",
    },
    "terminal.backend": {
        "type": "select",
        "description": "Terminal execution backend",
        "options": ["local", "docker", "ssh", "modal", "daytona", "vercel_sandbox", "singularity"],
    },
    "terminal.vercel_runtime": {
        "type": "select",
        "description": "Vercel Sandbox runtime",
        "options": ["node24", "node22", "python3.13"],  # sync with _SUPPORTED_VERCEL_RUNTIMES in terminal_tool.py
    },
    "terminal.modal_mode": {
        "type": "select",
        "description": "Modal sandbox mode",
        "options": ["sandbox", "function"],
    },
    "tts.provider": {
        "type": "select",
        "description": "Text-to-speech provider",
        "options": ["edge", "elevenlabs", "openai", "neutts"],
    },
    "stt.provider": {
        "type": "select",
        "description": "Speech-to-text provider",
        # "mistral" temporarily removed — mistralai PyPI package quarantined
        # (malicious 2.4.6 release on 2026-05-12). Restore once available.
        "options": ["local", "openai"],
    },
    "display.skin": {
        "type": "select",
        "description": "CLI visual theme",
        "options": ["default", "ares", "mono", "slate"],
    },
    "dashboard.theme": {
        "type": "select",
        "description": "Web dashboard visual theme",
        "options": ["default", "midnight", "ember", "mono", "cyberpunk", "rose"],
    },
    "display.resume_display": {
        "type": "select",
        "description": "How resumed sessions display history",
        "options": ["minimal", "full", "off"],
    },
    "display.busy_input_mode": {
        "type": "select",
        "description": "Input behavior while agent is running",
        "options": ["interrupt", "queue", "steer"],
    },
    "memory.provider": {
        "type": "select",
        "description": "Memory provider plugin",
        "options": ["builtin", "honcho"],
    },
    "approvals.mode": {
        "type": "select",
        "description": "Dangerous command approval mode",
        "options": ["ask", "yolo", "deny"],
    },
    "context.engine": {
        "type": "select",
        "description": "Context management engine",
        "options": ["default", "custom"],
    },
    "human_delay.mode": {
        "type": "select",
        "description": "Simulated typing delay mode",
        "options": ["off", "typing", "fixed"],
    },
    "logging.level": {
        "type": "select",
        "description": "Log level for agent.log",
        "options": ["DEBUG", "INFO", "WARNING", "ERROR"],
    },
    "agent.service_tier": {
        "type": "select",
        "description": "API service tier (OpenAI/Anthropic)",
        "options": ["", "auto", "default", "flex"],
    },
    "delegation.reasoning_effort": {
        "type": "select",
        "description": "Reasoning effort for delegated subagents",
        "options": ["", "low", "medium", "high"],
    },
}

# Categories with fewer fields get merged into "general" to avoid tab sprawl.
_CATEGORY_MERGE: Dict[str, str] = {
    "privacy": "security",
    "context": "agent",
    "skills": "agent",
    "cron": "agent",
    "network": "agent",
    "checkpoints": "agent",
    "approvals": "security",
    "human_delay": "display",
    "dashboard": "display",
    "code_execution": "agent",
    "prompt_caching": "agent",
    "goals": "agent",
    # Only `telegram.reactions` currently lives under telegram — fold it in
    # with the other messaging-platform config (discord) so it isn't an
    # orphan tab of one field.
    "telegram": "discord",
}

# Display order for tabs — unlisted categories sort alphabetically after these.
_CATEGORY_ORDER = [
    "general", "agent", "terminal", "display", "delegation",
    "memory", "compression", "security", "browser", "voice",
    "tts", "stt", "logging", "discord", "auxiliary",
]


def _infer_type(value: Any) -> str:
    """Infer a UI field type from a Python value."""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "number"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return "string"


def _build_schema_from_config(
    config: Dict[str, Any],
    prefix: str = "",
) -> Dict[str, Dict[str, Any]]:
    """Walk DEFAULT_CONFIG and produce a flat dot-path → field schema dict."""
    schema: Dict[str, Dict[str, Any]] = {}
    for key, value in config.items():
        full_key = f"{prefix}.{key}" if prefix else key

        # Skip internal / version keys
        if full_key in {"_config_version",}:
            continue

        # Category is the first path component for nested keys, or "general"
        # for top-level scalar fields (model, toolsets, timezone, etc.).
        if prefix:
            category = prefix.split(".")[0]
        elif isinstance(value, dict):
            category = key
        else:
            category = "general"

        if isinstance(value, dict):
            # Recurse into nested dicts
            schema.update(_build_schema_from_config(value, full_key))
        else:
            entry: Dict[str, Any] = {
                "type": _infer_type(value),
                "description": full_key.replace(".", " → ").replace("_", " ").title(),
                "category": category,
            }
            # Apply manual overrides
            if full_key in _SCHEMA_OVERRIDES:
                entry.update(_SCHEMA_OVERRIDES[full_key])
            # Merge small categories
            entry["category"] = _CATEGORY_MERGE.get(entry["category"], entry["category"])
            schema[full_key] = entry
    return schema


CONFIG_SCHEMA = _build_schema_from_config(DEFAULT_CONFIG)

# Inject virtual fields that don't live in DEFAULT_CONFIG but are surfaced
# by the normalize/denormalize cycle.  Insert model_context_length right after
# the "model" key so it renders adjacent in the frontend.
_mcl_entry = _SCHEMA_OVERRIDES["model_context_length"]
_ordered_schema: Dict[str, Dict[str, Any]] = {}
for _k, _v in CONFIG_SCHEMA.items():
    _ordered_schema[_k] = _v
    if _k == "model":
        _ordered_schema["model_context_length"] = _mcl_entry
CONFIG_SCHEMA = _ordered_schema


class ConfigUpdate(BaseModel):
    config: dict


class EnvVarUpdate(BaseModel):
    key: str
    value: str


class EnvVarDelete(BaseModel):
    key: str


class EnvVarReveal(BaseModel):
    key: str


class DashboardUploadBody(BaseModel):
    name: str
    mime_type: str = ""
    content_base64: str


class ModelAssignment(BaseModel):
    """Payload for POST /api/model/set — assign a provider/model to a slot.

    scope="main"        → writes model.provider + model.default
    scope="auxiliary"   → writes auxiliary.<task>.provider + auxiliary.<task>.model
    scope="auxiliary" with task=""  → applied to every auxiliary.* slot
    scope="auxiliary" with task="__reset__"  → resets every slot to provider="auto"
    """
    scope: str
    provider: str
    model: str
    task: str = ""


_GATEWAY_HEALTH_URL = os.getenv("GATEWAY_HEALTH_URL")
_DASHBOARD_UPLOAD_MAX_BYTES = 25 * 1024 * 1024


def _safe_dashboard_upload_name(name: str) -> str:
    raw = Path(name or "upload").name
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", raw).strip(" .")
    return cleaned or "upload"


try:
    _GATEWAY_HEALTH_TIMEOUT = float(os.getenv("GATEWAY_HEALTH_TIMEOUT", "3"))
except (ValueError, TypeError):
    _log.warning(
        "Invalid GATEWAY_HEALTH_TIMEOUT value %r — using default 3.0s",
        os.getenv("GATEWAY_HEALTH_TIMEOUT"),
    )
    _GATEWAY_HEALTH_TIMEOUT = 3.0

# DEPRECATED (scheduled for removal): GATEWAY_HEALTH_URL / GATEWAY_HEALTH_TIMEOUT.
# Cross-container / cross-host gateway liveness detection will be folded into a
# first-class dashboard config key so it's no longer Docker-adjacent lore buried
# in env vars.  The env vars still work for now so existing Compose deployments
# don't break.  Do not add new callers — wire new uses through the planned
# config surface.


def _probe_gateway_health() -> tuple[bool, dict | None]:
    """Probe the gateway via its HTTP health endpoint (cross-container).

    .. deprecated::
        Driven by the deprecated ``GATEWAY_HEALTH_URL`` /
        ``GATEWAY_HEALTH_TIMEOUT`` env vars.  Scheduled for removal alongside
        a move to a first-class dashboard config key.  See
        :data:`_GATEWAY_HEALTH_URL` for context.

    Uses ``/health/detailed`` first (returns full state), falling back to
    the simpler ``/health`` endpoint.  Returns ``(is_alive, body_dict)``.

    Accepts any of these as ``GATEWAY_HEALTH_URL``:
    - ``http://gateway:8642``                (base URL — recommended)
    - ``http://gateway:8642/health``         (explicit health path)
    - ``http://gateway:8642/health/detailed`` (explicit detailed path)

    This is a **blocking** call — run via ``run_in_executor`` from async code.
    """
    if not _GATEWAY_HEALTH_URL:
        return False, None

    # Normalise to base URL so we always probe the right paths regardless of
    # whether the user included /health or /health/detailed in the env var.
    base = _GATEWAY_HEALTH_URL.rstrip("/")
    if base.endswith("/health/detailed"):
        base = base[: -len("/health/detailed")]
    elif base.endswith("/health"):
        base = base[: -len("/health")]

    for path in (f"{base}/health/detailed", f"{base}/health"):
        try:
            req = urllib.request.Request(path, method="GET")
            with urllib.request.urlopen(req, timeout=_GATEWAY_HEALTH_TIMEOUT) as resp:
                if resp.status == 200:
                    body = json.loads(resp.read())
                    return True, body
        except Exception:
            continue
    return False, None


# ── /api/status redaction ──────────────────────────────────────────────────
# The dashboard renders these fields, so every credential shape that can reach
# them must be stripped.  The previous version only handled a bare
# ``token=<value>`` shape and, worse, left the credential itself in place for
# ``Authorization: Bearer <jwt>`` (it masked the word "Bearer" only).
_REDACTED = "<redacted>"

# Sensitive key names, including vendor-prefixed spellings such as
# ``OPENAI_API_KEY`` or ``access_token``.  ``(?:[A-Za-z0-9]+[_-])*`` allows
# arbitrary ``_``/``-`` joined prefixes while keeping "monkey"-style words out.
_STATUS_SECRET_KEY = (
    r"(?:[A-Za-z0-9]+[_-])*(?:"
    r"api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"token|secret|password|passwd|authorization"
    r")"
)
_STATUS_SECRET_FIELD_RE = re.compile(_STATUS_SECRET_KEY, re.IGNORECASE)
_STATUS_SECRET_PAIR_QUOTED_RE = re.compile(
    r"(?P<key>" + _STATUS_SECRET_KEY + r""")\s*["']?\s*[:=]\s*["'](?P<value>[^"\n]*)["']""",
    re.IGNORECASE,
)
_STATUS_SECRET_PAIR_RE = re.compile(
    r"(?P<key>" + _STATUS_SECRET_KEY + r""")\s*["']?\s*[:=]\s*[^\s"',;}\n]+""",
    re.IGNORECASE,
)
_STATUS_AUTH_RE = re.compile(
    r"""(?i)\b[a-z0-9_-]*authorization[a-z0-9_-]*\b\s*["']?\s*[:=]\s*["']?"""
    r"""(?:bearer|basic|digest|token)\s+[^\s"',;}\n]+"""
)
_STATUS_BEARER_RE = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]{10,}=*")
_STATUS_TELEGRAM_BOT_RE = re.compile(r"(?i)\bbot(\d{3,}):[A-Za-z0-9_-]{5,}")
_STATUS_URL_CRED_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s]+@")
_STATUS_BARE_KEY_RE = re.compile(r"(?i)\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}")


def _redact_status_pair(match: "re.Match[str]") -> str:
    """Keep the field name visible while dropping the secret value."""
    return f"{match.group('key')}={_REDACTED}"


def _redact_status_text(value: Any, limit: int = 300) -> Any:
    """Redact credentials from a status string, then bound its length.

    Handles, in order: ``Authorization`` headers (dropping the credential
    itself), quoted/unquoted ``KEY=value`` pairs (JSON included), Telegram bot
    URLs, ``user:pass@`` URL credentials and bare ``sk-`` style keys.
    """
    if not isinstance(value, str):
        return value
    text = _STATUS_AUTH_RE.sub("authorization=<redacted>", value)
    text = _STATUS_BEARER_RE.sub(lambda m: f"{m.group(1)} {_REDACTED}", text)
    text = _STATUS_TELEGRAM_BOT_RE.sub(
        lambda m: f"bot{m.group(1)}:{_REDACTED}", text
    )
    text = _STATUS_SECRET_PAIR_QUOTED_RE.sub(_redact_status_pair, text)
    text = _STATUS_SECRET_PAIR_RE.sub(_redact_status_pair, text)
    text = _STATUS_URL_CRED_RE.sub(r"\1<redacted>@", text)
    text = _STATUS_BARE_KEY_RE.sub(_REDACTED, text)
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return text


def _redact_status_payload(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict = {}
        for key, item in value.items():
            # Field-level handling: a mapping such as ``{"api_key": "..."}``
            # must be redacted by key name so values with spaces cannot slip
            # past the string patterns.
            if (
                isinstance(key, str)
                and _STATUS_SECRET_FIELD_RE.fullmatch(key)
                and item is not None
                and item != ""
            ):
                result[key] = _REDACTED
            else:
                result[key] = _redact_status_payload(item)
        return result
    if isinstance(value, list):
        return [_redact_status_payload(item) for item in value]
    return _redact_status_text(value)


def _knowledge_status_block() -> dict[str, Any]:
    """Report the configured knowledge mode plus the cached contract check.

    ``/api/status`` is a public, unauthenticated endpoint: it must never probe
    the knowledge service (no network I/O, no timing side channel).  The
    contract fields therefore only reflect a check this process already did.
    """
    block: dict[str, Any] = {
        "mode": "disabled",
        "contract_version": None,
        "compatible": None,
    }
    try:
        from integrations.hermes_knowledge import configured_root
        from integrations.hermes_knowledge.client import (
            cached_contract_status,
            load_config,
        )
    except Exception:  # noqa: BLE001 - status must never fail on optional deps
        return block

    raw_url = (os.environ.get("HERMES_KNOWLEDGE_URL") or "").strip()
    config = None
    if raw_url:
        block["mode"] = "http"
        try:
            config = load_config()
        except Exception:
            # Misconfigured URL/timeout: still report the configured mode, but
            # leave the contract fields empty instead of failing /api/status.
            config = None
    else:
        try:
            if configured_root() is not None:
                block["mode"] = "local"
        except Exception:
            pass

    if config is not None:
        try:
            cached = cached_contract_status(config.base_url)
        except Exception:
            cached = None
        if cached:
            block["contract_version"] = cached.get("contract_version")
            block["compatible"] = cached.get("compatible")
    return block


@app.get("/api/status")
async def get_status():
    current_ver, latest_ver = check_config_version()

    # --- Gateway liveness detection ---
    # Try local PID check first (same-host).  If that fails and a remote
    # GATEWAY_HEALTH_URL is configured, probe the gateway over HTTP so the
    # dashboard works when the gateway runs in a separate container.
    gateway_pid = get_running_pid()
    gateway_running = gateway_pid is not None
    remote_health_body: dict | None = None

    if not gateway_running and _GATEWAY_HEALTH_URL:
        loop = asyncio.get_running_loop()
        alive, remote_health_body = await loop.run_in_executor(
            None, _probe_gateway_health
        )
        if alive:
            gateway_running = True
            # PID from the remote container (display only — not locally valid)
            if remote_health_body:
                gateway_pid = remote_health_body.get("pid")

    gateway_state = None
    gateway_platforms: dict = {}
    gateway_exit_reason = None
    gateway_updated_at = None
    gateway_status_stale = False
    configured_gateway_platforms: set[str] | None = None
    try:
        from gateway.config import load_gateway_config

        gateway_config = load_gateway_config()
        configured_gateway_platforms = {
            platform.value for platform in gateway_config.get_connected_platforms()
        }
    except Exception:
        configured_gateway_platforms = None

    # Prefer the detailed health endpoint response (has full state) when the
    # local runtime status file is absent or stale (cross-container).
    runtime = read_runtime_status()
    if runtime is None and remote_health_body and remote_health_body.get("gateway_state"):
        runtime = remote_health_body

    if runtime:
        gateway_state = runtime.get("gateway_state")
        gateway_platforms = runtime.get("platforms") or {}
        if configured_gateway_platforms is not None:
            gateway_platforms = {
                key: value
                for key, value in gateway_platforms.items()
                if key in configured_gateway_platforms
            }
        gateway_exit_reason = runtime.get("exit_reason")
        gateway_updated_at = runtime.get("updated_at")
        gateway_status_stale = (
            gateway_running
            and remote_health_body is None
            and runtime_status_is_stale(runtime)
        )
        if not gateway_running:
            gateway_state = gateway_state if gateway_state in {"stopped", "startup_failed"} else "stopped"
            gateway_platforms = {}
        elif gateway_running and remote_health_body is not None:
            # The health probe confirmed the gateway is alive, but the local
            # runtime status file may be stale (cross-container).  Override
            # stopped/None state so the dashboard shows the correct badge.
            if gateway_state in {None, "stopped"}:
                gateway_state = "running"

        degraded_platform_states = {"fatal", "retrying", "paused", "disconnected"}
        gateway_platforms = _redact_status_payload(gateway_platforms)
        gateway_exit_reason = _redact_status_text(gateway_exit_reason)
        if gateway_running and gateway_state not in {"startup_failed", "draining"} and (
            gateway_status_stale
            or any(
                platform.get("state") in degraded_platform_states
                for platform in gateway_platforms.values()
            )
        ):
            gateway_state = "degraded"

    # If there was no runtime info at all but the health probe confirmed alive,
    # ensure we still report the gateway as running (no shared volume scenario).
    if gateway_running and gateway_state is None and remote_health_body is not None:
        gateway_state = "running"

    active_sessions = 0
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        try:
            sessions = db.list_sessions_rich(limit=50)
            now = time.time()
            active_sessions = sum(
                1 for s in sessions
                if s.get("ended_at") is None
                and (now - s.get("last_active", s.get("started_at", 0))) < 300
            )
        finally:
            db.close()
    except Exception:
        pass

    return {
        "version": __version__,
        "release_date": __release_date__,
        "hermes_home": str(get_hermes_home()),
        "config_path": str(get_config_path()),
        "env_path": str(get_env_path()),
        "config_version": current_ver,
        "latest_config_version": latest_ver,
        "gateway_running": gateway_running,
        "gateway_pid": gateway_pid,
        "gateway_health_url": _redact_status_text(_GATEWAY_HEALTH_URL),
        "gateway_state": gateway_state,
        "gateway_platforms": gateway_platforms,
        "gateway_exit_reason": gateway_exit_reason,
        "gateway_updated_at": gateway_updated_at,
        "gateway_status_stale": gateway_status_stale,
        "knowledge": _knowledge_status_block(),
        "active_sessions": active_sessions,
    }


@app.post("/api/dashboard/uploads")
async def upload_dashboard_file(body: DashboardUploadBody, request: Request):
    _require_token(request)
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 content")

    if len(data) > _DASHBOARD_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Upload too large")

    upload_dir = PROJECT_ROOT / "tmp" / "dashboard-uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_dashboard_upload_name(body.name)
    saved_path = upload_dir / f"{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(4)}-{safe_name}"
    saved_path.write_bytes(data)

    return {
        "ok": True,
        "name": safe_name,
        "path": str(saved_path.resolve()),
        "mime_type": body.mime_type,
        "size": len(data),
    }


# ---------------------------------------------------------------------------
# Gateway + update actions (invoked from the Status page).
#
# Both commands are spawned as detached subprocesses so the HTTP request
# returns immediately.  stdin is closed (``DEVNULL``) so any stray ``input()``
# calls fail fast with EOF rather than hanging forever.  stdout/stderr are
# streamed to a per-action log file under ``~/.hermes/logs/<action>.log`` so
# the dashboard can tail them back to the user.
# ---------------------------------------------------------------------------

_ACTION_LOG_DIR: Path = get_hermes_home() / "logs"

# Short ``name`` (from the URL) → absolute log file path.
_ACTION_LOG_FILES: Dict[str, str] = {
    "gateway-restart": "gateway-restart.log",
    "hermes-update": "hermes-update.log",
}

# ``name`` → most recently spawned Popen handle.  Used so ``status`` can
# report liveness and exit code without shelling out to ``ps``.
_ACTION_PROCS: Dict[str, subprocess.Popen] = {}


def _spawn_hermes_action(subcommand: List[str], name: str) -> subprocess.Popen:
    """Spawn ``hermes <subcommand>`` detached and record the Popen handle.

    Uses the running interpreter's ``hermes_cli.main`` module so the action
    inherits the same venv/PYTHONPATH the web server is using.
    """
    log_file_name = _ACTION_LOG_FILES[name]
    _ACTION_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = _ACTION_LOG_DIR / log_file_name
    log_file = open(log_path, "ab", buffering=0)
    log_file.write(
        f"\n=== {name} started {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode()
    )

    cmd = [sys.executable, "-m", "hermes_cli.main", *subcommand]

    popen_kwargs: Dict[str, Any] = {
        "cwd": str(PROJECT_ROOT),
        "stdin": subprocess.DEVNULL,
        "stdout": log_file,
        "stderr": subprocess.STDOUT,
        "env": {**os.environ, "HERMES_NONINTERACTIVE": "1"},
    }
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    _ACTION_PROCS[name] = proc
    return proc


def _tail_lines(path: Path, n: int) -> List[str]:
    """Return the last ``n`` lines of ``path``.  Reads the whole file — fine
    for our small per-action logs.  Binary-decoded with ``errors='replace'``
    so log corruption doesn't 500 the endpoint."""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    lines = text.splitlines()
    return lines[-n:] if n > 0 else lines


@app.post("/api/gateway/restart")
async def restart_gateway():
    """Kick off a ``hermes gateway restart`` in the background."""
    try:
        proc = _spawn_hermes_action(["gateway", "restart"], "gateway-restart")
    except Exception as exc:
        _log.exception("Failed to spawn gateway restart")
        raise HTTPException(status_code=500, detail=f"Failed to restart gateway: {exc}")
    return {
        "ok": True,
        "pid": proc.pid,
        "name": "gateway-restart",
    }


@app.post("/api/hermes/update")
async def update_hermes():
    """Kick off ``hermes update`` in the background."""
    try:
        proc = _spawn_hermes_action(["update"], "hermes-update")
    except Exception as exc:
        _log.exception("Failed to spawn hermes update")
        raise HTTPException(status_code=500, detail=f"Failed to start update: {exc}")
    return {
        "ok": True,
        "pid": proc.pid,
        "name": "hermes-update",
    }


@app.get("/api/actions/{name}/status")
async def get_action_status(name: str, lines: int = 200):
    """Tail an action log and report whether the process is still running."""
    log_file_name = _ACTION_LOG_FILES.get(name)
    if log_file_name is None:
        raise HTTPException(status_code=404, detail=f"Unknown action: {name}")

    log_path = _ACTION_LOG_DIR / log_file_name
    tail = _tail_lines(log_path, min(max(lines, 1), 2000))

    proc = _ACTION_PROCS.get(name)
    if proc is None:
        running = False
        exit_code: Optional[int] = None
        pid: Optional[int] = None
    else:
        exit_code = proc.poll()
        running = exit_code is None
        pid = proc.pid

    return {
        "name": name,
        "running": running,
        "exit_code": exit_code,
        "pid": pid,
        "lines": tail,
    }


@app.get("/api/sessions")
async def get_sessions(limit: int = 20, offset: int = 0):
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        try:
            sessions = db.list_sessions_rich(limit=limit, offset=offset)
            total = db.session_count()
            now = time.time()
            for s in sessions:
                s["is_active"] = (
                    s.get("ended_at") is None
                    and (now - s.get("last_active", s.get("started_at", 0))) < 300
                )
            return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}
        finally:
            db.close()
    except Exception:
        _log.exception("GET /api/sessions failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/sessions/search")
async def search_sessions(q: str = "", limit: int = 20):
    """Full-text search across session message content using FTS5."""
    if not q or not q.strip():
        return {"results": []}
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        try:
            # Auto-add prefix wildcards so partial words match
            # e.g. "nimb" → "nimb*" matches "nimby"
            # Preserve quoted phrases and existing wildcards as-is
            import re
            terms = []
            for token in re.findall(r'"[^"]*"|\S+', q.strip()):
                if token.startswith('"') or token.endswith("*"):
                    terms.append(token)
                else:
                    terms.append(token + "*")
            prefix_query = " ".join(terms)
            matches = db.search_messages(query=prefix_query, limit=limit)
            # Group by session_id — return unique sessions with their best snippet
            seen: dict = {}
            for m in matches:
                sid = m["session_id"]
                if sid not in seen:
                    seen[sid] = {
                        "session_id": sid,
                        "snippet": m.get("snippet", ""),
                        "role": m.get("role"),
                        "source": m.get("source"),
                        "model": m.get("model"),
                        "session_started": m.get("session_started"),
                    }
            return {"results": list(seen.values())}
        finally:
            db.close()
    except Exception:
        _log.exception("GET /api/sessions/search failed")
        raise HTTPException(status_code=500, detail="Search failed")


def _normalize_config_for_web(config: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize config for the web UI.

    Hermes supports ``model`` as either a bare string (``"anthropic/claude-sonnet-4"``)
    or a dict (``{default: ..., provider: ..., base_url: ...}``).  The schema is built
    from DEFAULT_CONFIG where ``model`` is a string, but user configs often have the
    dict form.  Normalize to the string form so the frontend schema matches.

    Also surfaces ``model_context_length`` as a top-level field so the web UI can
    display and edit it.  A value of 0 means "auto-detect".
    """
    config = dict(config)  # shallow copy
    model_val = config.get("model")
    if isinstance(model_val, dict):
        # Extract context_length before flattening the dict
        ctx_len = model_val.get("context_length", 0)
        config["model"] = model_val.get("default", model_val.get("name", ""))
        config["model_context_length"] = ctx_len if isinstance(ctx_len, int) else 0
    else:
        config["model_context_length"] = 0
    return config


@app.get("/api/config")
async def get_config():
    config = _normalize_config_for_web(load_config())
    # Strip internal keys that the frontend shouldn't see or send back
    return {k: v for k, v in config.items() if not k.startswith("_")}


@app.get("/api/config/defaults")
async def get_defaults():
    return DEFAULT_CONFIG


@app.get("/api/config/schema")
async def get_schema():
    return {"fields": CONFIG_SCHEMA, "category_order": _CATEGORY_ORDER}


_EMPTY_MODEL_INFO: dict = {
    "model": "",
    "provider": "",
    "auto_context_length": 0,
    "config_context_length": 0,
    "effective_context_length": 0,
    "capabilities": {},
}


@app.get("/api/model/info")
def get_model_info():
    """Return resolved model metadata for the currently configured model.

    Calls the same context-length resolution chain the agent uses, so the
    frontend can display "Auto-detected: 200K" alongside the override field.
    Also returns model capabilities (vision, reasoning, tools) when available.
    """
    try:
        cfg = load_config()
        model_cfg = cfg.get("model", "")

        # Extract model name and provider from the config
        if isinstance(model_cfg, dict):
            model_name = model_cfg.get("default", model_cfg.get("name", ""))
            provider = model_cfg.get("provider", "")
            base_url = model_cfg.get("base_url", "")
            config_ctx = model_cfg.get("context_length")
        else:
            model_name = str(model_cfg) if model_cfg else ""
            provider = ""
            base_url = ""
            config_ctx = None

        if not model_name:
            return dict(_EMPTY_MODEL_INFO, provider=provider)

        # Resolve auto-detected context length (pass config_ctx=None to get
        # purely auto-detected value, then separately report the override)
        try:
            from agent.model_metadata import get_model_context_length
            auto_ctx = get_model_context_length(
                model=model_name,
                base_url=base_url,
                provider=provider,
                config_context_length=None,  # ignore override — we want auto value
            )
        except Exception:
            auto_ctx = 0

        config_ctx_int = 0
        if isinstance(config_ctx, int) and config_ctx > 0:
            config_ctx_int = config_ctx

        # Effective is what the agent actually uses
        effective_ctx = config_ctx_int if config_ctx_int > 0 else auto_ctx

        # Try to get model capabilities from models.dev
        caps = {}
        try:
            from agent.models_dev import get_model_capabilities
            mc = get_model_capabilities(provider=provider, model=model_name)
            if mc is not None:
                caps = {
                    "supports_tools": mc.supports_tools,
                    "supports_vision": mc.supports_vision,
                    "supports_reasoning": mc.supports_reasoning,
                    "context_window": mc.context_window,
                    "max_output_tokens": mc.max_output_tokens,
                    "model_family": mc.model_family,
                }
        except Exception:
            pass

        return {
            "model": model_name,
            "provider": provider,
            "auto_context_length": auto_ctx,
            "config_context_length": config_ctx_int,
            "effective_context_length": effective_ctx,
            "capabilities": caps,
        }
    except Exception:
        _log.exception("GET /api/model/info failed")
        return dict(_EMPTY_MODEL_INFO)


# ---------------------------------------------------------------------------
# Model assignment — pick provider+model for main slot or auxiliary slots.
# Mirrors the model.options JSON-RPC from tui_gateway but uses REST so the
# Models page (which has no chat PTY open) can drive it.
# ---------------------------------------------------------------------------

# Canonical auxiliary task slots. Keep in sync with DEFAULT_CONFIG["auxiliary"]
# in hermes_cli/config.py — listed here for deterministic ordering in the UI.
_AUX_TASK_SLOTS: Tuple[str, ...] = (
    "vision",
    "web_extract",
    "compression",
    "session_search",
    "skills_hub",
    "approval",
    "mcp",
    "title_generation",
    "curator",
)


@app.get("/api/model/options")
def get_model_options():
    """Return authenticated providers + their curated model lists.

    REST equivalent of the ``model.options`` JSON-RPC on tui_gateway, so the
    dashboard Models page can render the picker without a live chat session.
    The response shape matches ``model.options`` 1:1 so ``ModelPickerDialog``
    can share the same types.
    """
    try:
        from hermes_cli.inventory import build_models_payload, load_picker_context

        return build_models_payload(load_picker_context(), max_models=50)
    except Exception:
        _log.exception("GET /api/model/options failed")
        raise HTTPException(status_code=500, detail="Failed to list model options")


@app.get("/api/model/auxiliary")
def get_auxiliary_models():
    """Return current auxiliary task assignments.

    Shape:
      {
        "tasks": [
          {"task": "vision", "provider": "auto", "model": "", "base_url": ""},
          ...
        ],
        "main": {"provider": "openrouter", "model": "anthropic/claude-opus-4.7"},
      }
    """
    try:
        cfg = load_config()
        aux_cfg = cfg.get("auxiliary", {})
        if not isinstance(aux_cfg, dict):
            aux_cfg = {}

        tasks = []
        for slot in _AUX_TASK_SLOTS:
            slot_cfg = aux_cfg.get(slot, {}) if isinstance(aux_cfg.get(slot), dict) else {}
            tasks.append({
                "task": slot,
                "provider": str(slot_cfg.get("provider", "auto") or "auto"),
                "model": str(slot_cfg.get("model", "") or ""),
                "base_url": str(slot_cfg.get("base_url", "") or ""),
            })

        model_cfg = cfg.get("model", {})
        if isinstance(model_cfg, dict):
            main = {
                "provider": str(model_cfg.get("provider", "") or ""),
                "model": str(model_cfg.get("default", model_cfg.get("name", "")) or ""),
            }
        else:
            main = {"provider": "", "model": str(model_cfg) if model_cfg else ""}

        return {"tasks": tasks, "main": main}
    except Exception:
        _log.exception("GET /api/model/auxiliary failed")
        raise HTTPException(status_code=500, detail="Failed to read auxiliary config")


@app.post("/api/model/set")
async def set_model_assignment(body: ModelAssignment):
    """Assign a model to the main slot or an auxiliary task slot.

    Writes to ``~/.hermes/config.yaml`` — applies to **new** sessions only.
    The currently running chat PTY (if any) is not affected; use the
    ``/model`` slash command inside a chat to hot-swap that specific session.
    """
    scope = (body.scope or "").strip().lower()
    provider = (body.provider or "").strip()
    model = (body.model or "").strip()
    task = (body.task or "").strip().lower()

    if scope not in {"main", "auxiliary"}:
        raise HTTPException(status_code=400, detail="scope must be 'main' or 'auxiliary'")

    try:
        cfg = load_config()

        if scope == "main":
            if not provider or not model:
                raise HTTPException(status_code=400, detail="provider and model required for main")
            model_cfg = cfg.get("model", {})
            if not isinstance(model_cfg, dict):
                model_cfg = {}
            model_cfg["provider"] = provider
            model_cfg["default"] = model
            # Clear stale base_url so the resolver picks the provider's own default.
            if "base_url" in model_cfg and model_cfg.get("base_url"):
                model_cfg["base_url"] = ""
            # Also clear hardcoded context_length override — new model may have
            # a different context window.
            if "context_length" in model_cfg:
                model_cfg.pop("context_length", None)
            cfg["model"] = model_cfg
            save_config(cfg)
            return {"ok": True, "scope": "main", "provider": provider, "model": model}

        # scope == "auxiliary"
        aux = cfg.get("auxiliary")
        if not isinstance(aux, dict):
            aux = {}

        if task == "__reset__":
            # Reset every slot to provider="auto", model="" — keeps other fields intact.
            for slot in _AUX_TASK_SLOTS:
                slot_cfg = aux.get(slot)
                if not isinstance(slot_cfg, dict):
                    slot_cfg = {}
                slot_cfg["provider"] = "auto"
                slot_cfg["model"] = ""
                aux[slot] = slot_cfg
            cfg["auxiliary"] = aux
            save_config(cfg)
            return {"ok": True, "scope": "auxiliary", "reset": True}

        if not provider:
            raise HTTPException(status_code=400, detail="provider required for auxiliary")

        targets = [task] if task else list(_AUX_TASK_SLOTS)
        for slot in targets:
            if slot not in _AUX_TASK_SLOTS:
                raise HTTPException(status_code=400, detail=f"unknown auxiliary task: {slot}")
            slot_cfg = aux.get(slot)
            if not isinstance(slot_cfg, dict):
                slot_cfg = {}
            slot_cfg["provider"] = provider
            slot_cfg["model"] = model
            aux[slot] = slot_cfg

        cfg["auxiliary"] = aux
        save_config(cfg)
        return {
            "ok": True,
            "scope": "auxiliary",
            "tasks": targets,
            "provider": provider,
            "model": model,
        }
    except HTTPException:
        raise
    except Exception:
        _log.exception("POST /api/model/set failed")
        raise HTTPException(status_code=500, detail="Failed to save model assignment")




def _denormalize_config_from_web(config: Dict[str, Any]) -> Dict[str, Any]:
    """Reverse _normalize_config_for_web before saving.

    Reconstructs ``model`` as a dict by reading the current on-disk config
    to recover model subkeys (provider, base_url, api_mode, etc.) that were
    stripped from the GET response.  The frontend only sees model as a flat
    string; the rest is preserved transparently.

    Also handles ``model_context_length`` — writes it back into the model dict
    as ``context_length``.  A value of 0 or absent means "auto-detect" (omitted
    from the dict so get_model_context_length() uses its normal resolution).
    """
    config = dict(config)
    # Remove any _model_meta that might have leaked in (shouldn't happen
    # with the stripped GET response, but be defensive)
    config.pop("_model_meta", None)

    # Extract and remove model_context_length before processing model
    ctx_override = config.pop("model_context_length", 0)
    if not isinstance(ctx_override, int):
        try:
            ctx_override = int(ctx_override)
        except (TypeError, ValueError):
            ctx_override = 0

    model_val = config.get("model")
    if isinstance(model_val, str) and model_val:
        # Read the current disk config to recover model subkeys
        try:
            disk_config = load_config()
            disk_model = disk_config.get("model")
            if isinstance(disk_model, dict):
                # Preserve all subkeys, update default with the new value
                disk_model["default"] = model_val
                # Write context_length into the model dict (0 = remove/auto)
                if ctx_override > 0:
                    disk_model["context_length"] = ctx_override
                else:
                    disk_model.pop("context_length", None)
                config["model"] = disk_model
            # Model was previously a bare string — upgrade to dict if
            # user is setting a context_length override
            elif ctx_override > 0:
                config["model"] = {
                    "default": model_val,
                    "context_length": ctx_override,
                }
        except Exception:
            pass  # can't read disk config — just use the string form
    return config


@app.put("/api/config")
async def update_config(body: ConfigUpdate):
    try:
        save_config(_denormalize_config_from_web(body.config))
        return {"ok": True}
    except Exception:
        _log.exception("PUT /api/config failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/env")
async def get_env_vars():
    env_on_disk = load_env()
    result = {}
    for var_name, info in OPTIONAL_ENV_VARS.items():
        value = env_on_disk.get(var_name)
        result[var_name] = {
            "is_set": bool(value),
            "redacted_value": redact_key(value) if value else None,
            "description": info.get("description", ""),
            "url": info.get("url"),
            "category": info.get("category", ""),
            "is_password": info.get("password", False),
            "tools": info.get("tools", []),
            "advanced": info.get("advanced", False),
        }
    return result


@app.put("/api/env")
async def set_env_var(body: EnvVarUpdate):
    try:
        save_env_value(body.key, body.value)
        return {"ok": True, "key": body.key}
    except Exception:
        _log.exception("PUT /api/env failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.delete("/api/env")
async def remove_env_var(body: EnvVarDelete):
    try:
        removed = remove_env_value(body.key)
        if not removed:
            raise HTTPException(status_code=404, detail=f"{body.key} not found in .env")
        return {"ok": True, "key": body.key}
    except HTTPException:
        raise
    except Exception:
        _log.exception("DELETE /api/env failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/env/reveal")
async def reveal_env_var(body: EnvVarReveal, request: Request):
    """Return the real (unredacted) value of a single env var.

    Protected by:
    - Ephemeral session token (generated per server start, injected into SPA)
    - Rate limiting (max 5 reveals per 30s window)
    - Audit logging
    """
    # --- Token check ---
    _require_token(request)

    # --- Rate limit ---
    now = time.time()
    cutoff = now - _REVEAL_WINDOW_SECONDS
    _reveal_timestamps[:] = [t for t in _reveal_timestamps if t > cutoff]
    if len(_reveal_timestamps) >= _REVEAL_MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many reveal requests. Try again shortly.")
    _reveal_timestamps.append(now)

    # --- Reveal ---
    env_on_disk = load_env()
    value = env_on_disk.get(body.key)
    if value is None:
        raise HTTPException(status_code=404, detail=f"{body.key} not found in .env")

    _log.info("env/reveal: %s", body.key)
    return {"key": body.key, "value": value}


# ---------------------------------------------------------------------------
# OAuth provider endpoints — status + disconnect (Phase 1)
# ---------------------------------------------------------------------------
#
# Phase 1 surfaces *which OAuth providers exist* and whether each is
# connected, plus a disconnect button. The actual login flow (PKCE for
# Anthropic, device-code for Nous/Codex) still runs in the CLI for now;
# Phase 2 will add in-browser flows. For unconnected providers we return
# the canonical ``hermes auth add <provider>`` command so the dashboard
# can surface a one-click copy.


def _truncate_token(value: Optional[str], visible: int = 6) -> str:
    """Return ``...XXXXXX`` (last N chars) for safe display in the UI.

    We never expose more than the trailing ``visible`` characters of an
    OAuth access token. JWT prefixes (the part before the first dot) are
    stripped first when present so the visible suffix is always part of
    the signing region rather than a meaningless header chunk.
    """
    if not value:
        return ""
    s = str(value)
    if "." in s and s.count(".") >= 2:
        # Looks like a JWT — show the trailing piece of the signature only.
        s = s.rsplit(".", 1)[-1]
    if len(s) <= visible:
        return s
    return f"…{s[-visible:]}"


def _anthropic_oauth_status() -> Dict[str, Any]:
    """Combined status across the three Anthropic credential sources we read.

    Hermes resolves Anthropic creds in this order at runtime:
    1. ``~/.hermes/.anthropic_oauth.json`` — Hermes-managed PKCE flow
    2. ``~/.claude/.credentials.json`` — Claude Code CLI credentials (auto)
    3. ``ANTHROPIC_TOKEN`` / ``ANTHROPIC_API_KEY`` env vars
    The dashboard reports the highest-priority source that's actually present.
    """
    try:
        from agent.anthropic_adapter import (
            read_hermes_oauth_credentials,
            read_claude_code_credentials,
            _HERMES_OAUTH_FILE,
        )
    except ImportError:
        read_claude_code_credentials = None  # type: ignore
        read_hermes_oauth_credentials = None  # type: ignore
        _HERMES_OAUTH_FILE = None  # type: ignore

    hermes_creds = None
    if read_hermes_oauth_credentials:
        try:
            hermes_creds = read_hermes_oauth_credentials()
        except Exception:
            hermes_creds = None
    if hermes_creds and hermes_creds.get("accessToken"):
        return {
            "logged_in": True,
            "source": "hermes_pkce",
            "source_label": f"Hermes PKCE ({_HERMES_OAUTH_FILE})",
            "token_preview": _truncate_token(hermes_creds.get("accessToken")),
            "expires_at": hermes_creds.get("expiresAt"),
            "has_refresh_token": bool(hermes_creds.get("refreshToken")),
        }

    cc_creds = None
    if read_claude_code_credentials:
        try:
            cc_creds = read_claude_code_credentials()
        except Exception:
            cc_creds = None
    if cc_creds and cc_creds.get("accessToken"):
        return {
            "logged_in": True,
            "source": "claude_code",
            "source_label": "Claude Code (~/.claude/.credentials.json)",
            "token_preview": _truncate_token(cc_creds.get("accessToken")),
            "expires_at": cc_creds.get("expiresAt"),
            "has_refresh_token": bool(cc_creds.get("refreshToken")),
        }

    env_token = os.getenv("ANTHROPIC_TOKEN") or os.getenv("CLAUDE_CODE_OAUTH_TOKEN")
    if env_token:
        return {
            "logged_in": True,
            "source": "env_var",
            "source_label": "ANTHROPIC_TOKEN environment variable",
            "token_preview": _truncate_token(env_token),
            "expires_at": None,
            "has_refresh_token": False,
        }
    return {"logged_in": False, "source": None}


def _claude_code_only_status() -> Dict[str, Any]:
    """Surface Claude Code CLI credentials as their own provider entry.

    Independent of the Anthropic entry above so users can see whether their
    Claude Code subscription tokens are actively flowing into Hermes even
    when they also have a separate Hermes-managed PKCE login.
    """
    try:
        from agent.anthropic_adapter import read_claude_code_credentials
        creds = read_claude_code_credentials()
    except Exception:
        creds = None
    if creds and creds.get("accessToken"):
        return {
            "logged_in": True,
            "source": "claude_code_cli",
            "source_label": "~/.claude/.credentials.json",
            "token_preview": _truncate_token(creds.get("accessToken")),
            "expires_at": creds.get("expiresAt"),
            "has_refresh_token": bool(creds.get("refreshToken")),
        }
    return {"logged_in": False, "source": None}


# Provider catalog. The order matters — it's how we render the UI list.
# ``cli_command`` is what the dashboard surfaces as the copy-to-clipboard
# fallback while Phase 2 (in-browser flows) isn't built yet.
# ``flow`` describes the OAuth shape so the future modal can pick the
# right UI: ``pkce`` = open URL + paste callback code, ``device_code`` =
# show code + verification URL + poll, ``external`` = read-only (delegated
# to a third-party CLI like Claude Code or Qwen).
_OAUTH_PROVIDER_CATALOG: tuple[Dict[str, Any], ...] = (
    {
        "id": "anthropic",
        "name": "Anthropic (Claude API)",
        "flow": "pkce",
        "cli_command": "hermes auth add anthropic",
        "docs_url": "https://docs.claude.com/en/api/getting-started",
        "status_fn": _anthropic_oauth_status,
    },
    {
        "id": "claude-code",
        "name": "Claude Code (subscription)",
        "flow": "external",
        "cli_command": "claude setup-token",
        "docs_url": "https://docs.claude.com/en/docs/claude-code",
        "status_fn": _claude_code_only_status,
    },
    {
        "id": "nous",
        "name": "Nous Portal",
        "flow": "device_code",
        "cli_command": "hermes auth add nous",
        "docs_url": "https://portal.nousresearch.com",
        "status_fn": None,  # dispatched via auth.get_nous_auth_status
    },
    {
        "id": "openai-codex",
        "name": "OpenAI Codex (ChatGPT)",
        "flow": "device_code",
        "cli_command": "hermes auth add openai-codex",
        "docs_url": "https://platform.openai.com/docs",
        "status_fn": None,  # dispatched via auth.get_codex_auth_status
    },
    {
        "id": "qwen-oauth",
        "name": "Qwen (via Qwen CLI)",
        "flow": "external",
        "cli_command": "hermes auth add qwen-oauth",
        "docs_url": "https://github.com/QwenLM/qwen-code",
        "status_fn": None,  # dispatched via auth.get_qwen_auth_status
    },
    {
        "id": "minimax-oauth",
        "name": "MiniMax (OAuth)",
        # MiniMax's flow is structurally device-code (verification URI +
        # user code, backend polls the token endpoint) with a PKCE
        # extension for code-binding. The dashboard renders the same UX
        # as Nous's device-code flow; the PKCE bit is a security
        # extension that doesn't change the operator experience.
        "flow": "device_code",
        "cli_command": "hermes auth add minimax-oauth",
        "docs_url": "https://www.minimax.io",
        "status_fn": None,  # dispatched via auth.get_minimax_oauth_auth_status
    },
)


def _resolve_provider_status(provider_id: str, status_fn) -> Dict[str, Any]:
    """Dispatch to the right status helper for an OAuth provider entry."""
    if status_fn is not None:
        try:
            return status_fn()
        except Exception as e:
            return {"logged_in": False, "error": str(e)}
    try:
        from hermes_cli import auth as hauth
        if provider_id == "nous":
            raw = hauth.get_nous_auth_status()
            return {
                "logged_in": bool(raw.get("logged_in")),
                "source": "nous_portal",
                "source_label": raw.get("portal_base_url") or "Nous Portal",
                "token_preview": _truncate_token(raw.get("access_token")),
                "expires_at": raw.get("access_expires_at"),
                "has_refresh_token": bool(raw.get("has_refresh_token")),
            }
        if provider_id == "openai-codex":
            raw = hauth.get_codex_auth_status()
            return {
                "logged_in": bool(raw.get("logged_in")),
                "source": raw.get("source") or "openai_codex",
                "source_label": raw.get("auth_mode") or "OpenAI Codex",
                "token_preview": _truncate_token(raw.get("api_key")),
                "expires_at": None,
                "has_refresh_token": False,
                "last_refresh": raw.get("last_refresh"),
            }
        if provider_id == "qwen-oauth":
            raw = hauth.get_qwen_auth_status()
            return {
                "logged_in": bool(raw.get("logged_in")),
                "source": "qwen_cli",
                "source_label": raw.get("auth_store_path") or "Qwen CLI",
                "token_preview": _truncate_token(raw.get("access_token")),
                "expires_at": raw.get("expires_at"),
                "has_refresh_token": bool(raw.get("has_refresh_token")),
            }
        if provider_id == "minimax-oauth":
            raw = hauth.get_minimax_oauth_auth_status()
            return {
                "logged_in": bool(raw.get("logged_in")),
                "source": "minimax_oauth",
                "source_label": f"MiniMax ({raw.get('region', 'global')})",
                "token_preview": None,
                "expires_at": raw.get("expires_at"),
                "has_refresh_token": True,
            }
    except Exception as e:
        return {"logged_in": False, "error": str(e)}
    return {"logged_in": False}


@app.get("/api/providers/oauth")
async def list_oauth_providers():
    """Enumerate every OAuth-capable LLM provider with current status.

    Response shape (per provider):
        id              stable identifier (used in DELETE path)
        name            human label
        flow            "pkce" | "device_code" | "external"
        cli_command     fallback CLI command for users to run manually
        docs_url        external docs/portal link for the "Learn more" link
        status:
          logged_in        bool — currently has usable creds
          source           short slug ("hermes_pkce", "claude_code", ...)
          source_label     human-readable origin (file path, env var name)
          token_preview    last N chars of the token, never the full token
          expires_at       ISO timestamp string or null
          has_refresh_token bool
    """
    providers = []
    for p in _OAUTH_PROVIDER_CATALOG:
        status = _resolve_provider_status(p["id"], p.get("status_fn"))
        providers.append({
            "id": p["id"],
            "name": p["name"],
            "flow": p["flow"],
            "cli_command": p["cli_command"],
            "docs_url": p["docs_url"],
            "status": status,
        })
    return {"providers": providers}


@app.delete("/api/providers/oauth/{provider_id}")
async def disconnect_oauth_provider(provider_id: str, request: Request):
    """Disconnect an OAuth provider. Token-protected (matches /env/reveal)."""
    _require_token(request)

    valid_ids = {p["id"] for p in _OAUTH_PROVIDER_CATALOG}
    if provider_id not in valid_ids:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {provider_id}. "
                   f"Available: {', '.join(sorted(valid_ids))}",
        )

    # Anthropic and claude-code clear the same Hermes-managed PKCE file
    # AND forget the Claude Code import. We don't touch ~/.claude/* directly
    # — that's owned by the Claude Code CLI; users can re-auth there if they
    # want to undo a disconnect.
    if provider_id in {"anthropic", "claude-code"}:
        try:
            from agent.anthropic_adapter import _HERMES_OAUTH_FILE
            if _HERMES_OAUTH_FILE.exists():
                _HERMES_OAUTH_FILE.unlink()
        except Exception:
            pass
        # Also clear the credential pool entry if present.
        try:
            from hermes_cli.auth import clear_provider_auth
            clear_provider_auth("anthropic")
        except Exception:
            pass
        _log.info("oauth/disconnect: %s", provider_id)
        return {"ok": True, "provider": provider_id}

    try:
        from hermes_cli.auth import clear_provider_auth
        cleared = clear_provider_auth(provider_id)
        _log.info("oauth/disconnect: %s (cleared=%s)", provider_id, cleared)
        return {"ok": bool(cleared), "provider": provider_id}
    except Exception as e:
        _log.exception("disconnect %s failed", provider_id)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# OAuth Phase 2 — in-browser PKCE & device-code flows
# ---------------------------------------------------------------------------
#
# Two flow shapes are supported:
#
#   PKCE (Anthropic):
#     1. POST /api/providers/oauth/anthropic/start
#          → server generates code_verifier + challenge, builds claude.ai
#            authorize URL, stashes verifier in _oauth_sessions[session_id]
#          → returns { session_id, flow: "pkce", auth_url }
#     2. UI opens auth_url in a new tab. User authorizes, copies code.
#     3. POST /api/providers/oauth/anthropic/submit { session_id, code }
#          → server exchanges (code + verifier) → tokens at console.anthropic.com
#          → persists to ~/.hermes/.anthropic_oauth.json AND credential pool
#          → returns { ok: true, status: "approved" }
#
#   Device code (Nous, OpenAI Codex):
#     1. POST /api/providers/oauth/{nous|openai-codex}/start
#          → server hits provider's device-auth endpoint
#          → gets { user_code, verification_url, device_code, interval, expires_in }
#          → spawns background poller thread that polls the token endpoint
#            every `interval` seconds until approved/expired
#          → stores poll status in _oauth_sessions[session_id]
#          → returns { session_id, flow: "device_code", user_code,
#                      verification_url, expires_in, poll_interval }
#     2. UI opens verification_url in a new tab and shows user_code.
#     3. UI polls GET /api/providers/oauth/{provider}/poll/{session_id}
#          every 2s until status != "pending".
#     4. On "approved" the background thread has already saved creds; UI
#        refreshes the providers list.
#
# Sessions are kept in-memory only (single-process FastAPI) and time out
# after 15 minutes. A periodic cleanup runs on each /start call to GC
# expired sessions so the dict doesn't grow without bound.

_OAUTH_SESSION_TTL_SECONDS = 15 * 60
_oauth_sessions: Dict[str, Dict[str, Any]] = {}
_oauth_sessions_lock = threading.Lock()

# Import OAuth constants from canonical source instead of duplicating.
# Guarded so hermes web still starts if anthropic_adapter is unavailable;
# Phase 2 endpoints will return 501 in that case.
try:
    from agent.anthropic_adapter import (
        _OAUTH_CLIENT_ID as _ANTHROPIC_OAUTH_CLIENT_ID,
        _OAUTH_TOKEN_URL as _ANTHROPIC_OAUTH_TOKEN_URL,
        _OAUTH_REDIRECT_URI as _ANTHROPIC_OAUTH_REDIRECT_URI,
        _OAUTH_SCOPES as _ANTHROPIC_OAUTH_SCOPES,
        _generate_pkce as _generate_pkce_pair,
    )
    _ANTHROPIC_OAUTH_AVAILABLE = True
except ImportError:
    _ANTHROPIC_OAUTH_AVAILABLE = False
_ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"


def _gc_oauth_sessions() -> None:
    """Drop expired sessions. Called opportunistically on /start."""
    cutoff = time.time() - _OAUTH_SESSION_TTL_SECONDS
    with _oauth_sessions_lock:
        stale = [sid for sid, sess in _oauth_sessions.items() if sess["created_at"] < cutoff]
        for sid in stale:
            _oauth_sessions.pop(sid, None)


def _new_oauth_session(provider_id: str, flow: str) -> tuple[str, Dict[str, Any]]:
    """Create + register a new OAuth session, return (session_id, session_dict)."""
    sid = secrets.token_urlsafe(16)
    sess = {
        "session_id": sid,
        "provider": provider_id,
        "flow": flow,
        "created_at": time.time(),
        "status": "pending",  # pending | approved | denied | expired | error
        "error_message": None,
    }
    with _oauth_sessions_lock:
        _oauth_sessions[sid] = sess
    return sid, sess


def _save_anthropic_oauth_creds(access_token: str, refresh_token: str, expires_at_ms: int) -> None:
    """Persist Anthropic PKCE creds to both Hermes file AND credential pool.

    Mirrors what auth_commands.add_command does so the dashboard flow leaves
    the system in the same state as ``hermes auth add anthropic``.
    """
    from agent.anthropic_adapter import _HERMES_OAUTH_FILE
    payload = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at_ms,
    }
    _HERMES_OAUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    _HERMES_OAUTH_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # Best-effort credential-pool insert. Failure here doesn't invalidate
    # the file write — pool registration only matters for the rotation
    # strategy, not for runtime credential resolution.
    try:
        from agent.credential_pool import (
            PooledCredential,
            load_pool,
            AUTH_TYPE_OAUTH,
            SOURCE_MANUAL,
        )
        import uuid
        pool = load_pool("anthropic")
        # Avoid duplicate entries: delete any prior dashboard-issued OAuth entry
        existing = [e for e in pool.entries() if getattr(e, "source", "").startswith(f"{SOURCE_MANUAL}:dashboard_pkce")]
        for e in existing:
            try:
                pool.remove_entry(getattr(e, "id", ""))
            except Exception:
                pass
        entry = PooledCredential(
            provider="anthropic",
            id=uuid.uuid4().hex[:6],
            label="dashboard PKCE",
            auth_type=AUTH_TYPE_OAUTH,
            priority=0,
            source=f"{SOURCE_MANUAL}:dashboard_pkce",
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at_ms=expires_at_ms,
        )
        pool.add_entry(entry)
    except Exception as e:
        _log.warning("anthropic pool add (dashboard) failed: %s", e)


def _start_anthropic_pkce() -> Dict[str, Any]:
    """Begin PKCE flow. Returns the auth URL the UI should open."""
    if not _ANTHROPIC_OAUTH_AVAILABLE:
        raise HTTPException(status_code=501, detail="Anthropic OAuth not available (missing adapter)")
    verifier, challenge = _generate_pkce_pair()
    sid, sess = _new_oauth_session("anthropic", "pkce")
    sess["verifier"] = verifier
    sess["state"] = verifier  # Anthropic round-trips verifier as state
    params = {
        "code": "true",
        "client_id": _ANTHROPIC_OAUTH_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": _ANTHROPIC_OAUTH_REDIRECT_URI,
        "scope": _ANTHROPIC_OAUTH_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": verifier,
    }
    auth_url = f"{_ANTHROPIC_OAUTH_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"
    return {
        "session_id": sid,
        "flow": "pkce",
        "auth_url": auth_url,
        "expires_in": _OAUTH_SESSION_TTL_SECONDS,
    }


def _submit_anthropic_pkce(session_id: str, code_input: str) -> Dict[str, Any]:
    """Exchange authorization code for tokens. Persists on success."""
    with _oauth_sessions_lock:
        sess = _oauth_sessions.get(session_id)
    if not sess or sess["provider"] != "anthropic" or sess["flow"] != "pkce":
        raise HTTPException(status_code=404, detail="Unknown or expired session")
    if sess["status"] != "pending":
        return {"ok": False, "status": sess["status"], "message": sess.get("error_message")}

    # Anthropic's redirect callback page formats the code as `<code>#<state>`.
    # Strip the state suffix if present (we already have the verifier server-side).
    parts = code_input.strip().split("#", 1)
    code = parts[0].strip()
    if not code:
        return {"ok": False, "status": "error", "message": "No code provided"}
    state_from_callback = parts[1] if len(parts) > 1 else ""

    exchange_data = json.dumps({
        "grant_type": "authorization_code",
        "client_id": _ANTHROPIC_OAUTH_CLIENT_ID,
        "code": code,
        "state": state_from_callback or sess["state"],
        "redirect_uri": _ANTHROPIC_OAUTH_REDIRECT_URI,
        "code_verifier": sess["verifier"],
    }).encode()
    req = urllib.request.Request(
        _ANTHROPIC_OAUTH_TOKEN_URL,
        data=exchange_data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "hermes-dashboard/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read().decode())
    except Exception as e:
        with _oauth_sessions_lock:
            sess["status"] = "error"
            sess["error_message"] = f"Token exchange failed: {e}"
        return {"ok": False, "status": "error", "message": sess["error_message"]}

    access_token = result.get("access_token", "")
    refresh_token = result.get("refresh_token", "")
    expires_in = int(result.get("expires_in") or 3600)
    if not access_token:
        with _oauth_sessions_lock:
            sess["status"] = "error"
            sess["error_message"] = "No access token returned"
        return {"ok": False, "status": "error", "message": sess["error_message"]}

    expires_at_ms = int(time.time() * 1000) + (expires_in * 1000)
    try:
        _save_anthropic_oauth_creds(access_token, refresh_token, expires_at_ms)
    except Exception as e:
        with _oauth_sessions_lock:
            sess["status"] = "error"
            sess["error_message"] = f"Save failed: {e}"
        return {"ok": False, "status": "error", "message": sess["error_message"]}
    with _oauth_sessions_lock:
        sess["status"] = "approved"
    _log.info("oauth/pkce: anthropic login completed (session=%s)", session_id)
    return {"ok": True, "status": "approved"}


async def _start_device_code_flow(provider_id: str) -> Dict[str, Any]:
    """Initiate a device-code flow (Nous, OpenAI Codex, or MiniMax).

    Calls the provider's device-auth endpoint via the existing CLI helpers,
    then spawns a background poller. Returns the user-facing display fields
    so the UI can render the verification page link + user code.
    """
    if provider_id == "nous":
        from hermes_cli.auth import (
            _nous_device_scope_with_env_override,
            _request_nous_device_code_with_scope_fallback,
            PROVIDER_REGISTRY,
        )
        import httpx
        pconfig = PROVIDER_REGISTRY["nous"]
        portal_base_url = (
            os.getenv("HERMES_PORTAL_BASE_URL")
            or os.getenv("NOUS_PORTAL_BASE_URL")
            or pconfig.portal_base_url
        ).rstrip("/")
        client_id = pconfig.client_id
        scope, explicit_scope = _nous_device_scope_with_env_override(
            None,
            default_scope=pconfig.scope,
        )

        def _do_nous_device_request():
            with httpx.Client(
                timeout=httpx.Timeout(15.0),
                headers={"Accept": "application/json"},
            ) as client:
                return _request_nous_device_code_with_scope_fallback(
                    client=client,
                    portal_base_url=portal_base_url,
                    client_id=client_id,
                    scope=scope,
                    allow_legacy_fallback=not explicit_scope,
                )

        device_data, effective_scope = await asyncio.get_running_loop().run_in_executor(
            None, _do_nous_device_request
        )
        sid, sess = _new_oauth_session("nous", "device_code")
        sess["device_code"] = str(device_data["device_code"])
        sess["interval"] = int(device_data["interval"])
        sess["expires_at"] = time.time() + int(device_data["expires_in"])
        sess["portal_base_url"] = portal_base_url
        sess["client_id"] = client_id
        sess["scope"] = effective_scope
        threading.Thread(
            target=_nous_poller, args=(sid,), daemon=True, name=f"oauth-poll-{sid[:6]}"
        ).start()
        return {
            "session_id": sid,
            "flow": "device_code",
            "user_code": str(device_data["user_code"]),
            "verification_url": str(device_data["verification_uri_complete"]),
            "expires_in": int(device_data["expires_in"]),
            "poll_interval": int(device_data["interval"]),
        }

    if provider_id == "openai-codex":
        # Codex uses fixed OpenAI device-auth endpoints; reuse the helper.
        sid, _ = _new_oauth_session("openai-codex", "device_code")
        # Use the helper but in a thread because it polls inline.
        # We can't extract just the start step without refactoring auth.py,
        # so we run the full helper in a worker and proxy the user_code +
        # verification_url back via the session dict. The helper prints
        # to stdout — we capture nothing here, just status.
        threading.Thread(
            target=_codex_full_login_worker, args=(sid,), daemon=True,
            name=f"oauth-codex-{sid[:6]}",
        ).start()
        # Block briefly until the worker has populated the user_code, OR error.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with _oauth_sessions_lock:
                s = _oauth_sessions.get(sid)
            if s and (s.get("user_code") or s["status"] != "pending"):
                break
            await asyncio.sleep(0.1)
        with _oauth_sessions_lock:
            s = _oauth_sessions.get(sid, {})
        if s.get("status") == "error":
            raise HTTPException(status_code=500, detail=s.get("error_message") or "device-auth failed")
        if not s.get("user_code"):
            raise HTTPException(status_code=504, detail="device-auth timed out before returning a user code")
        return {
            "session_id": sid,
            "flow": "device_code",
            "user_code": s["user_code"],
            "verification_url": s["verification_url"],
            "expires_in": int(s.get("expires_in") or 900),
            "poll_interval": int(s.get("interval") or 5),
        }

    if provider_id == "minimax-oauth":
        # MiniMax uses a device-code-style flow (verification URI + user
        # code + background poll) with a PKCE extension on top. From the
        # operator's perspective it's identical to Nous's device-code
        # flow; the PKCE bit (verifier + challenge from
        # _minimax_pkce_pair) is a security extension that binds the
        # token exchange to the original session.
        from hermes_cli.auth import (
            _minimax_pkce_pair,
            _minimax_request_user_code,
            MINIMAX_OAUTH_CLIENT_ID,
            MINIMAX_OAUTH_GLOBAL_BASE,
        )
        import httpx
        verifier, challenge, state = _minimax_pkce_pair()
        portal_base_url = (
            os.getenv("MINIMAX_PORTAL_BASE_URL") or MINIMAX_OAUTH_GLOBAL_BASE
        ).rstrip("/")
        def _do_minimax_request():
            with httpx.Client(
                timeout=httpx.Timeout(15.0),
                headers={"Accept": "application/json"},
                follow_redirects=True,
            ) as client:
                return _minimax_request_user_code(
                    client=client,
                    portal_base_url=portal_base_url,
                    client_id=MINIMAX_OAUTH_CLIENT_ID,
                    code_challenge=challenge,
                    state=state,
                )
        device_data = await asyncio.get_event_loop().run_in_executor(
            None, _do_minimax_request
        )
        sid, sess = _new_oauth_session("minimax-oauth", "device_code")
        # The CLI flow names this `interval_ms` because MiniMax's
        # `interval` field is in milliseconds (defensive default 2000ms
        # in _minimax_poll_token).
        interval_raw = device_data.get("interval")
        sess["interval_ms"] = (
            int(interval_raw) if interval_raw is not None else None
        )
        sess["user_code"] = str(device_data["user_code"])
        sess["code_verifier"] = verifier
        sess["state"] = state
        sess["portal_base_url"] = portal_base_url
        sess["client_id"] = MINIMAX_OAUTH_CLIENT_ID
        sess["region"] = "global"
        # `expired_in` from MiniMax is overloaded — could be a unix-ms
        # timestamp OR a seconds-from-now duration. Mirror the heuristic
        # in _minimax_poll_token. Stash the raw value for the poller;
        # compute a derived expires_at + UI-friendly expires_in seconds.
        expired_in_raw = int(device_data["expired_in"])
        sess["expired_in_raw"] = expired_in_raw
        if expired_in_raw > 1_000_000_000_000:  # likely unix-ms
            expires_at_ts = expired_in_raw / 1000.0
            expires_in_seconds = max(0, int(expires_at_ts - time.time()))
        else:
            expires_at_ts = time.time() + expired_in_raw
            expires_in_seconds = expired_in_raw
        sess["expires_at"] = expires_at_ts
        threading.Thread(
            target=_minimax_poller,
            args=(sid,),
            daemon=True,
            name=f"oauth-poll-{sid[:6]}",
        ).start()
        return {
            "session_id": sid,
            "flow": "device_code",
            "user_code": str(device_data["user_code"]),
            "verification_url": str(device_data["verification_uri"]),
            "expires_in": expires_in_seconds,
            "poll_interval": max(2, (sess["interval_ms"] or 2000) // 1000),
        }

    raise HTTPException(status_code=400, detail=f"Provider {provider_id} does not support device-code flow")


def _nous_poller(session_id: str) -> None:
    """Background poller that drives a Nous device-code flow to completion."""
    from hermes_cli.auth import (
        NOUS_INFERENCE_AUTH_MODE_FRESH,
        _poll_for_token,
        refresh_nous_oauth_from_state,
    )
    from datetime import datetime, timezone
    import httpx
    with _oauth_sessions_lock:
        sess = _oauth_sessions.get(session_id)
    if not sess:
        return
    portal_base_url = sess["portal_base_url"]
    client_id = sess["client_id"]
    device_code = sess["device_code"]
    interval = sess["interval"]
    scope = sess.get("scope")
    expires_in = max(60, int(sess["expires_at"] - time.time()))
    try:
        with httpx.Client(timeout=httpx.Timeout(15.0), headers={"Accept": "application/json"}) as client:
            token_data = _poll_for_token(
                client=client,
                portal_base_url=portal_base_url,
                client_id=client_id,
                device_code=device_code,
                expires_in=expires_in,
                poll_interval=interval,
            )
        # Same post-processing as _nous_device_code_login (mint agent key)
        now = datetime.now(timezone.utc)
        token_ttl = int(token_data.get("expires_in") or 0)
        auth_state = {
            "portal_base_url": portal_base_url,
            "inference_base_url": token_data.get("inference_base_url"),
            "client_id": client_id,
            "scope": token_data.get("scope") or scope,
            "token_type": token_data.get("token_type", "Bearer"),
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "obtained_at": now.isoformat(),
            "expires_at": (
                datetime.fromtimestamp(now.timestamp() + token_ttl, tz=timezone.utc).isoformat()
                if token_ttl else None
            ),
            "expires_in": token_ttl,
        }
        full_state = refresh_nous_oauth_from_state(
            auth_state,
            min_key_ttl_seconds=300,
            timeout_seconds=15.0,
            force_refresh=False,
            inference_auth_mode=NOUS_INFERENCE_AUTH_MODE_FRESH,
        )
        from hermes_cli.auth import persist_nous_credentials
        persist_nous_credentials(full_state)
        with _oauth_sessions_lock:
            sess["status"] = "approved"
        _log.info("oauth/device: nous login completed (session=%s)", session_id)
    except Exception as e:
        _log.warning("nous device-code poll failed (session=%s): %s", session_id, e)
        with _oauth_sessions_lock:
            sess["status"] = "error"
            sess["error_message"] = str(e)


def _minimax_poller(session_id: str) -> None:
    """Background poller that drives a MiniMax OAuth flow to completion.

    Mirrors `_nous_poller` but calls the MiniMax-specific token endpoint,
    which uses a PKCE-style ``code_verifier`` + ``user_code`` rather than
    the ``device_code`` field used by Nous. On success, builds the same
    auth_state dict that ``_minimax_oauth_login`` (the CLI flow) builds
    and persists via ``_minimax_save_auth_state`` — so the dashboard
    path leaves the system in the same state as
    ``hermes auth add minimax-oauth``.
    """
    from hermes_cli.auth import (
        _minimax_poll_token,
        _minimax_resolve_token_expiry_unix,
        _minimax_save_auth_state,
        MINIMAX_OAUTH_GLOBAL_INFERENCE,
        MINIMAX_OAUTH_SCOPE,
    )
    from datetime import datetime, timezone
    import httpx
    with _oauth_sessions_lock:
        sess = _oauth_sessions.get(session_id)
    if not sess:
        return
    portal_base_url = sess["portal_base_url"]
    client_id = sess["client_id"]
    user_code = sess["user_code"]
    code_verifier = sess["code_verifier"]
    interval_ms = sess.get("interval_ms")
    expired_in_raw = sess["expired_in_raw"]
    try:
        with httpx.Client(
            timeout=httpx.Timeout(15.0),
            headers={"Accept": "application/json"},
            follow_redirects=True,
        ) as client:
            token_data = _minimax_poll_token(
                client=client,
                portal_base_url=portal_base_url,
                client_id=client_id,
                user_code=user_code,
                code_verifier=code_verifier,
                expired_in=expired_in_raw,
                interval_ms=interval_ms,
            )
        # Build the auth_state dict in the same shape as the CLI flow's
        # `_minimax_oauth_login` so `_minimax_save_auth_state` writes
        # the canonical record. Region is fixed to "global" for the
        # dashboard path; cn-region operators can still use the CLI
        # flow which supports `--region cn`.
        now = datetime.now(timezone.utc)
        expires_at_ts = _minimax_resolve_token_expiry_unix(
            int(token_data["expired_in"]), now=now,
        )
        expires_in_s = max(0, int(expires_at_ts - now.timestamp()))
        auth_state = {
            "provider": "minimax-oauth",
            "region": sess.get("region", "global"),
            "portal_base_url": portal_base_url,
            "inference_base_url": MINIMAX_OAUTH_GLOBAL_INFERENCE,
            "client_id": client_id,
            "scope": MINIMAX_OAUTH_SCOPE,
            "token_type": token_data.get("token_type", "Bearer"),
            "access_token": token_data["access_token"],
            "refresh_token": token_data["refresh_token"],
            "resource_url": token_data.get("resource_url"),
            "obtained_at": now.isoformat(),
            "expires_at": datetime.fromtimestamp(
                expires_at_ts, tz=timezone.utc
            ).isoformat(),
            "expires_in": expires_in_s,
        }
        _minimax_save_auth_state(auth_state)
        with _oauth_sessions_lock:
            sess["status"] = "approved"
        _log.info("oauth/device: minimax login completed (session=%s)", session_id)
    except Exception as e:
        _log.warning("minimax device-code poll failed (session=%s): %s", session_id, e)
        with _oauth_sessions_lock:
            sess["status"] = "error"
            sess["error_message"] = str(e)


def _codex_full_login_worker(session_id: str) -> None:
    """Run the complete OpenAI Codex device-code flow.

    Codex doesn't use the standard OAuth device-code endpoints; it has its
    own ``/api/accounts/deviceauth/usercode`` (JSON body, returns
    ``device_auth_id``) and ``/api/accounts/deviceauth/token`` (JSON body
    polled until 200). On success the response carries an
    ``authorization_code`` + ``code_verifier`` that get exchanged at
    CODEX_OAUTH_TOKEN_URL with grant_type=authorization_code.

    The flow is replicated inline (rather than calling
    _codex_device_code_login) because that helper prints/blocks/polls in a
    single function — we need to surface the user_code to the dashboard the
    moment we receive it, well before polling completes.
    """
    try:
        import httpx
        from hermes_cli.auth import (
            CODEX_OAUTH_CLIENT_ID,
            CODEX_OAUTH_TOKEN_URL,
            DEFAULT_CODEX_BASE_URL,
        )
        issuer = "https://auth.openai.com"

        # Step 1: request device code
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            resp = client.post(
                f"{issuer}/api/accounts/deviceauth/usercode",
                json={"client_id": CODEX_OAUTH_CLIENT_ID},
                headers={"Content-Type": "application/json"},
            )
        if resp.status_code != 200:
            raise RuntimeError(f"deviceauth/usercode returned {resp.status_code}")
        device_data = resp.json()
        user_code = device_data.get("user_code", "")
        device_auth_id = device_data.get("device_auth_id", "")
        poll_interval = max(3, int(device_data.get("interval", "5")))
        if not user_code or not device_auth_id:
            raise RuntimeError("device-code response missing user_code or device_auth_id")
        verification_url = f"{issuer}/codex/device"
        with _oauth_sessions_lock:
            sess = _oauth_sessions.get(session_id)
            if not sess:
                return
            sess["user_code"] = user_code
            sess["verification_url"] = verification_url
            sess["device_auth_id"] = device_auth_id
            sess["interval"] = poll_interval
            sess["expires_in"] = 15 * 60  # OpenAI's effective limit
            sess["expires_at"] = time.time() + sess["expires_in"]

        # Step 2: poll until authorized
        deadline = time.monotonic() + sess["expires_in"]
        code_resp = None
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            while time.monotonic() < deadline:
                time.sleep(poll_interval)
                poll = client.post(
                    f"{issuer}/api/accounts/deviceauth/token",
                    json={"device_auth_id": device_auth_id, "user_code": user_code},
                    headers={"Content-Type": "application/json"},
                )
                if poll.status_code == 200:
                    code_resp = poll.json()
                    break
                if poll.status_code in {403, 404}:
                    continue  # user hasn't authorized yet
                raise RuntimeError(f"deviceauth/token poll returned {poll.status_code}")

        if code_resp is None:
            with _oauth_sessions_lock:
                sess["status"] = "expired"
                sess["error_message"] = "Device code expired before approval"
            return

        # Step 3: exchange authorization_code for tokens
        authorization_code = code_resp.get("authorization_code", "")
        code_verifier = code_resp.get("code_verifier", "")
        if not authorization_code or not code_verifier:
            raise RuntimeError("device-auth response missing authorization_code/code_verifier")
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            token_resp = client.post(
                CODEX_OAUTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": authorization_code,
                    "redirect_uri": f"{issuer}/deviceauth/callback",
                    "client_id": CODEX_OAUTH_CLIENT_ID,
                    "code_verifier": code_verifier,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if token_resp.status_code != 200:
            raise RuntimeError(f"token exchange returned {token_resp.status_code}")
        tokens = token_resp.json()
        access_token = tokens.get("access_token", "")
        refresh_token = tokens.get("refresh_token", "")
        if not access_token:
            raise RuntimeError("token exchange did not return access_token")

        # Persist via credential pool — same shape as auth_commands.add_command
        from agent.credential_pool import (
            PooledCredential,
            load_pool,
            AUTH_TYPE_OAUTH,
            SOURCE_MANUAL,
        )
        import uuid as _uuid
        pool = load_pool("openai-codex")
        base_url = (
            os.getenv("HERMES_CODEX_BASE_URL", "").strip().rstrip("/")
            or DEFAULT_CODEX_BASE_URL
        )
        entry = PooledCredential(
            provider="openai-codex",
            id=_uuid.uuid4().hex[:6],
            label="dashboard device_code",
            auth_type=AUTH_TYPE_OAUTH,
            priority=0,
            source=f"{SOURCE_MANUAL}:dashboard_device_code",
            access_token=access_token,
            refresh_token=refresh_token,
            base_url=base_url,
        )
        pool.add_entry(entry)
        with _oauth_sessions_lock:
            sess["status"] = "approved"
        _log.info("oauth/device: openai-codex login completed (session=%s)", session_id)
    except Exception as e:
        _log.warning("codex device-code worker failed (session=%s): %s", session_id, e)
        with _oauth_sessions_lock:
            s = _oauth_sessions.get(session_id)
            if s:
                s["status"] = "error"
                s["error_message"] = str(e)


@app.post("/api/providers/oauth/{provider_id}/start")
async def start_oauth_login(provider_id: str, request: Request):
    """Initiate an OAuth login flow. Token-protected."""
    _require_token(request)
    _gc_oauth_sessions()
    valid = {p["id"] for p in _OAUTH_PROVIDER_CATALOG}
    if provider_id not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown provider {provider_id}")
    catalog_entry = next(p for p in _OAUTH_PROVIDER_CATALOG if p["id"] == provider_id)
    if catalog_entry["flow"] == "external":
        raise HTTPException(
            status_code=400,
            detail=f"{provider_id} uses an external CLI; run `{catalog_entry['cli_command']}` manually",
        )
    try:
        # The pkce branch is gated on provider_id == "anthropic" because
        # `_start_anthropic_pkce()` is hardcoded to the Anthropic flow.
        # Routing any other future pkce-flagged provider through it would
        # silently launch the Anthropic OAuth flow (the bug fixed in this
        # change for MiniMax). New PKCE providers must add their own
        # start function and an explicit branch here.
        if catalog_entry["flow"] == "pkce" and provider_id == "anthropic":
            return _start_anthropic_pkce()
        if catalog_entry["flow"] == "device_code":
            return await _start_device_code_flow(provider_id)
    except HTTPException:
        raise
    except Exception as e:
        _log.exception("oauth/start %s failed", provider_id)
        raise HTTPException(status_code=500, detail=str(e))
    raise HTTPException(status_code=400, detail="Unsupported flow")


class OAuthSubmitBody(BaseModel):
    session_id: str
    code: str


@app.post("/api/providers/oauth/{provider_id}/submit")
async def submit_oauth_code(provider_id: str, body: OAuthSubmitBody, request: Request):
    """Submit the auth code for PKCE flows. Token-protected."""
    _require_token(request)
    if provider_id == "anthropic":
        return await asyncio.get_running_loop().run_in_executor(
            None, _submit_anthropic_pkce, body.session_id, body.code,
        )
    raise HTTPException(status_code=400, detail=f"submit not supported for {provider_id}")


@app.get("/api/providers/oauth/{provider_id}/poll/{session_id}")
async def poll_oauth_session(provider_id: str, session_id: str):
    """Poll a device-code session's status (no auth — read-only state)."""
    with _oauth_sessions_lock:
        sess = _oauth_sessions.get(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    if sess["provider"] != provider_id:
        raise HTTPException(status_code=400, detail="Provider mismatch for session")
    return {
        "session_id": session_id,
        "status": sess["status"],
        "error_message": sess.get("error_message"),
        "expires_at": sess.get("expires_at"),
    }


@app.delete("/api/providers/oauth/sessions/{session_id}")
async def cancel_oauth_session(session_id: str, request: Request):
    """Cancel a pending OAuth session. Token-protected."""
    _require_token(request)
    with _oauth_sessions_lock:
        sess = _oauth_sessions.pop(session_id, None)
    if sess is None:
        return {"ok": False, "message": "session not found"}
    return {"ok": True, "session_id": session_id}


# ---------------------------------------------------------------------------
# Session detail endpoints
# ---------------------------------------------------------------------------



def _session_latest_descendant(session_id: str):
    """Resolve a session id to the newest child leaf session.

    /model may create child sessions. Dashboard refresh should continue the
    newest child instead of reopening the old parent.
    """
    from hermes_state import SessionDB

    def row_get(row, key, index):
        if isinstance(row, dict):
            return row.get(key)
        try:
            return row[key]
        except Exception:
            try:
                return row[index]
            except Exception:
                return None

    db = SessionDB()
    try:
        sid = db.resolve_session_id(session_id)
        if not sid or not db.get_session(sid):
            return None, []

        conn = (
            getattr(db, "conn", None)
            or getattr(db, "_conn", None)
            or getattr(db, "connection", None)
            or getattr(db, "_connection", None)
        )

        rows = []
        if conn is not None:
            raw_rows = conn.execute(
                "SELECT id, parent_session_id, started_at FROM sessions"
            ).fetchall()
            for row in raw_rows:
                rows.append({
                    "id": row_get(row, "id", 0),
                    "parent_session_id": row_get(row, "parent_session_id", 1),
                    "started_at": row_get(row, "started_at", 2),
                })
        else:
            rows = db.list_sessions_rich(limit=10000, offset=0)

        children = {}
        for row in rows:
            rid = row.get("id")
            parent = row.get("parent_session_id")
            if rid and parent:
                children.setdefault(parent, []).append(row)

        def started(row):
            try:
                return float(row.get("started_at") or 0)
            except Exception:
                return 0.0

        current = sid
        path = [sid]
        seen = {sid}

        while children.get(current):
            candidates = [r for r in children[current] if r.get("id") not in seen]
            if not candidates:
                break
            candidates.sort(key=started, reverse=True)
            current = candidates[0]["id"]
            path.append(current)
            seen.add(current)

        return current, path
    finally:
        db.close()

@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str):
    from hermes_state import SessionDB
    db = SessionDB()
    try:
        sid = db.resolve_session_id(session_id)
        session = db.get_session(sid) if sid else None
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session
    finally:
        db.close()



@app.get("/api/sessions/{session_id}/latest-descendant")
async def get_session_latest_descendant(session_id: str):
    latest, path = _session_latest_descendant(session_id)
    if not latest:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "requested_session_id": path[0] if path else session_id,
        "session_id": latest,
        "path": path,
        "changed": bool(path and latest != path[0]),
    }

@app.get("/api/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    from hermes_state import SessionDB
    db = SessionDB()
    try:
        sid = db.resolve_session_id(session_id)
        if not sid:
            raise HTTPException(status_code=404, detail="Session not found")
        messages = db.get_messages(sid)
        return {"session_id": sid, "messages": messages}
    finally:
        db.close()


@app.delete("/api/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    from hermes_state import SessionDB
    db = SessionDB()
    try:
        if not db.delete_session(session_id):
            raise HTTPException(status_code=404, detail="Session not found")
        return {"ok": True}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Log viewer endpoint
# ---------------------------------------------------------------------------


@app.get("/api/logs")
async def get_logs(
    file: str = "agent",
    lines: int = 100,
    level: Optional[str] = None,
    component: Optional[str] = None,
    search: Optional[str] = None,
):
    from hermes_cli.logs import _read_tail, LOG_FILES

    log_name = LOG_FILES.get(file)
    if not log_name:
        raise HTTPException(status_code=400, detail=f"Unknown log file: {file}")
    log_path = get_hermes_home() / "logs" / log_name
    if not log_path.exists():
        return {"file": file, "lines": []}

    try:
        from hermes_logging import COMPONENT_PREFIXES
    except ImportError:
        COMPONENT_PREFIXES = {}

    # Normalize "ALL" / "all" / empty → no filter. _matches_filters treats an
    # empty tuple as "must match a prefix" (startswith(()) is always False),
    # so passing () instead of None silently drops every line.
    min_level = level if level and level.upper() != "ALL" else None
    if component and component.lower() != "all":
        comp_prefixes = COMPONENT_PREFIXES.get(component)
        if comp_prefixes is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown component: {component}. "
                       f"Available: {', '.join(sorted(COMPONENT_PREFIXES))}",
            )
    else:
        comp_prefixes = None

    has_filters = bool(min_level or comp_prefixes or search)
    result = _read_tail(
        log_path, min(lines, 500) if not search else 2000,
        has_filters=has_filters,
        min_level=min_level,
        component_prefixes=comp_prefixes,
    )
    # Post-filter by search term (case-insensitive substring match).
    # _read_tail doesn't support free-text search, so we filter here and
    # trim to the requested line count afterward.
    if search:
        needle = search.lower()
        result = [l for l in result if needle in l.lower()][-min(lines, 500):]
    return {"file": file, "lines": result}


# ---------------------------------------------------------------------------
# Cron job management endpoints
# ---------------------------------------------------------------------------


class CronJobCreate(BaseModel):
    prompt: str
    schedule: str
    name: str = ""
    deliver: str = "local"


class CronJobUpdate(BaseModel):
    updates: dict


@app.get("/api/cron/jobs")
async def list_cron_jobs():
    from cron.jobs import list_jobs
    return list_jobs(include_disabled=True)


@app.get("/api/cron/jobs/{job_id}")
async def get_cron_job(job_id: str):
    from cron.jobs import get_job
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs")
async def create_cron_job(body: CronJobCreate):
    from cron.jobs import create_job
    try:
        job = create_job(prompt=body.prompt, schedule=body.schedule,
                         name=body.name, deliver=body.deliver)
        return job
    except Exception as e:
        _log.exception("POST /api/cron/jobs failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/cron/jobs/{job_id}")
async def update_cron_job(job_id: str, body: CronJobUpdate):
    from cron.jobs import update_job
    job = update_job(job_id, body.updates)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/pause")
async def pause_cron_job(job_id: str):
    from cron.jobs import pause_job
    job = pause_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/resume")
async def resume_cron_job(job_id: str):
    from cron.jobs import resume_job
    job = resume_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/trigger")
async def trigger_cron_job(job_id: str):
    from cron.jobs import trigger_job
    job = trigger_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.delete("/api/cron/jobs/{job_id}")
async def delete_cron_job(job_id: str):
    from cron.jobs import remove_job
    if not remove_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


def _automation_launchagent_plist(label: str) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"


def _read_launchagent_plist(label: str) -> dict[str, Any]:
    path = _automation_launchagent_plist(label)
    if not path.exists():
        return {}
    try:
        with path.open("rb") as fh:
            data = plistlib.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        _log.warning("Failed to read LaunchAgent plist: %s", path)
        return {}


def _launchagent_status(label: str) -> tuple[str, int | None]:
    if not hasattr(os, "getuid"):
        return ("unknown", None)
    try:
        proc = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/{label}"],  # windows-footgun: ok
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except Exception:
        return ("unknown", None)
    if proc.returncode != 0:
        return ("stopped", None)
    text = proc.stdout or ""
    state = "running" if "state = running" in text else "stopped"
    match = re.search(r"\bpid = (\d+)", text)
    return (state, int(match.group(1)) if match else None)


def _automation_enabled_from_plist(data: dict[str, Any]) -> bool:
    return bool(data.get("RunAtLoad") or data.get("KeepAlive"))


def _automation_boundary(
    *,
    item_id: str,
    name: str,
    kind: str,
    enabled: bool,
    runtime_status: str,
    read_write: str,
    writes_tables: list[str] | None = None,
    writes_paths: list[str] | None = None,
    toolsets: list[str] | None = None,
    risk_level: str = "low",
    description: str = "",
    next_run_at: str = "",
    last_run_at: str = "",
    last_status: str = "",
    pid: int | None = None,
    source_path: str = "",
) -> dict[str, Any]:
    return {
        "id": item_id,
        "name": name,
        "kind": kind,
        "enabled": enabled,
        "runtime_status": runtime_status,
        "next_run_at": next_run_at or "",
        "last_run_at": last_run_at or "",
        "last_status": last_status or "",
        "read_write": read_write,
        "writes_tables": writes_tables or [],
        "writes_paths": writes_paths or [],
        "toolsets": toolsets or [],
        "risk_level": risk_level,
        "description": description,
        "pid": pid,
        "source_path": source_path,
    }


def _knowledge_write_path(*parts: str) -> str:
    """Best-effort path under the Knowledge vault for the automation inventory.

    ``/api/knowledge/automation-boundaries`` is an observability endpoint: when
    the Knowledge service is not configured it must still describe the rest of
    the automation surface.  A 503 from ``_knowledge_vault_path()`` therefore
    degrades to an empty path for that one item instead of failing the request.
    """
    try:
        return str(_knowledge_vault_path().joinpath(*parts))
    except Exception:  # noqa: BLE001 - unconfigured feature degrades to empty
        return ""


def _knowledge_checkout_path(*parts: str) -> str:
    """Best-effort path under the Knowledge checkout (empty when unconfigured)."""
    try:
        return str(_knowledge_custom_root().joinpath(*parts))
    except Exception:  # noqa: BLE001 - unconfigured feature degrades to empty
        return ""


def _known_paths(*paths: str) -> list[str]:
    """Drop empty (unresolved) paths so degraded items stay clean."""
    return [path for path in paths if path]


def _automation_boundary_for_cron_job(job: dict[str, Any]) -> dict[str, Any]:
    name = str(job.get("name") or job.get("id") or "cron job")
    toolsets = job.get("enabled_toolsets") or job.get("toolsets") or []
    if not isinstance(toolsets, list):
        toolsets = []

    lowered = f"{name}\n{job.get('prompt') or ''}".lower()
    name_lower = name.lower()
    if "theme_scan" in lowered or "theme-scan" in name_lower:
        read_write = "knowledge_storage_write"
        writes_tables = ["captures", "pending_questions", "theme_candidates"]
        writes_paths = _known_paths(_knowledge_write_path("themes"))
        risk = "high"
        description = "Scheduled Theme View maintenance; disabled jobs cannot auto-trigger."
    elif "daily_review" in lowered or "daily-review" in lowered or "knowledge-review" in toolsets:
        read_write = "state_write"
        writes_tables = ["review_items", "captures", "agent_runs"]
        writes_paths = [str(get_hermes_home() / "cron" / "output")]
        risk = "medium"
        description = "Knowledge review job; writes review state and cron output."
    elif "life_tick" in lowered or "life-assistant" in name_lower:
        read_write = "state_write"
        writes_tables = ["life_*"]
        writes_paths = []
        risk = "high"
        description = "Life Assistant tick; disabled jobs cannot auto-trigger."
    else:
        read_write = "mixed"
        writes_tables = ["agent_runs"]
        writes_paths = [str(get_hermes_home() / "cron" / "output")]
        risk = "medium"
        description = "Scheduled Hermes agent job."

    enabled = bool(job.get("enabled", True)) and str(job.get("state") or "").lower() != "paused"
    return _automation_boundary(
        item_id=f"cron:{job.get('id') or name}",
        name=name,
        kind="cron",
        enabled=enabled,
        runtime_status="configured" if enabled else "disabled",
        next_run_at=str(job.get("next_run_at") or ""),
        last_run_at=str(job.get("last_run_at") or job.get("last_run") or ""),
        last_status=str(job.get("last_status") or ""),
        read_write=read_write,
        writes_tables=writes_tables,
        writes_paths=writes_paths,
        toolsets=[str(t) for t in toolsets],
        risk_level=risk,
        description=description,
        source_path=str(get_hermes_home() / "cron" / "jobs.json"),
    )


@app.get("/api/knowledge/automation-boundaries")
async def get_knowledge_automation_boundaries():
    items: list[dict[str, Any]] = []

    try:
        from cron.jobs import list_jobs
        cron_jobs = list_jobs(include_disabled=True)
    except Exception:
        _log.exception("Failed to list Hermes cron jobs")
        cron_jobs = []
    for job in cron_jobs:
        try:
            items.append(_automation_boundary_for_cron_job(job))
        except Exception:
            _log.exception(
                "Failed to describe automation boundary for cron job %r",
                job.get("id") or job.get("name"),
            )

    for label, name, description, writes_tables, writes_paths, risk in (
        (
            "ai.hermes.gateway",
            "Hermes gateway",
            "LaunchAgent hosts the gateway and in-process cron ticker.",
            ["agent_runs"],
            [str(get_hermes_home() / "logs")],
            "medium",
        ),
        (
            "com.pipi.hermes-vault-watcher",
            "Knowledge storage watcher",
            "LaunchAgent watches local Knowledge storage and calls repair_data(apply=True, rename_readable=True).",
            ["captures", "capture_drafts", "reading_drafts"],
            _known_paths(_knowledge_write_path(), _knowledge_checkout_path("data")),
            "high",
        ),
    ):
        plist_data = _read_launchagent_plist(label)
        runtime_status, pid = _launchagent_status(label)
        items.append(
            _automation_boundary(
                item_id=f"launchagent:{label}",
                name=name,
                kind="launchagent",
                enabled=_automation_enabled_from_plist(plist_data),
                runtime_status=runtime_status,
                read_write="mixed",
                writes_tables=writes_tables,
                writes_paths=writes_paths,
                risk_level=risk,
                description=description,
                pid=pid,
                source_path=str(_automation_launchagent_plist(label)),
            )
        )

    gateway_running = bool(get_running_pid())
    items.extend(
        [
            _automation_boundary(
                item_id="gateway_ticker:cron",
                name="Gateway cron ticker",
                kind="gateway_ticker",
                enabled=gateway_running,
                runtime_status="running" if gateway_running else "stopped",
                read_write="mixed",
                writes_tables=["agent_runs", "review_items"],
                writes_paths=[str(get_hermes_home() / "cron")],
                risk_level="medium",
                description="The gateway calls cron.scheduler.tick periodically; individual cron job enabled flags still gate execution.",
            ),
            _automation_boundary(
                item_id="gateway_ticker:kanban",
                name="Gateway kanban dispatcher",
                kind="gateway_ticker",
                enabled=gateway_running,
                runtime_status="running" if gateway_running else "stopped",
                read_write="state_write",
                writes_tables=["kanban_tasks", "kanban_runs"],
                writes_paths=[],
                risk_level="medium",
                description="Gateway-embedded dispatcher may claim and update kanban tasks when the kanban plugin is configured.",
            ),
        ]
    )

    cron_by_name = {str(item.get("name") or "").lower(): item for item in items if item.get("kind") == "cron"}
    daily_enabled = bool(cron_by_name.get("daily-review", {}).get("enabled"))
    theme_enabled = bool(cron_by_name.get("theme-scan", {}).get("enabled"))
    life_enabled = bool(cron_by_name.get("life-assistant-tick", {}).get("enabled"))

    items.extend(
        [
            _automation_boundary(
                item_id="tool:daily_review",
                name="daily_review",
                kind="tool",
                enabled=daily_enabled,
                runtime_status="configured" if daily_enabled else "disabled",
                read_write="state_write",
                writes_tables=["review_items", "captures", "agent_runs"],
                writes_paths=[],
                toolsets=["knowledge-review"],
                risk_level="medium",
                description="Knowledge review tool; scheduled only through the daily-review cron job.",
            ),
            _automation_boundary(
                item_id="tool:theme_scan",
                name="theme_scan",
                kind="tool",
                enabled=theme_enabled,
                runtime_status="configured" if theme_enabled else "disabled",
                read_write="knowledge_storage_write",
                writes_tables=["captures", "pending_questions", "theme_candidates"],
                writes_paths=_known_paths(_knowledge_write_path("themes")),
                toolsets=["knowledge-advanced"],
                risk_level="high",
                description="Theme View clustering and local Knowledge storage maintenance tool; disabled unless the theme-scan cron is enabled or invoked manually.",
            ),
            _automation_boundary(
                item_id="tool:life_tick",
                name="life_tick",
                kind="tool",
                enabled=life_enabled,
                runtime_status="configured" if life_enabled else "disabled",
                read_write="state_write",
                writes_tables=["life_*"],
                writes_paths=[],
                toolsets=["personal-assistant"],
                risk_level="high",
                description="Life Assistant scheduler tool; automatic cron trigger is disabled when life-assistant-tick is disabled.",
            ),
            _automation_boundary(
                item_id="tool:record_life_event",
                name="record_life_event",
                kind="tool",
                enabled=False,
                runtime_status="disabled",
                read_write="state_write",
                writes_tables=["life_*"],
                writes_paths=[],
                toolsets=["personal-assistant"],
                risk_level="high",
                description="Manual Life Assistant write tool. It is not part of the knowledge-review cron lane.",
            ),
            _automation_boundary(
                item_id="tool:capture_content",
                name="capture_content",
                kind="tool",
                enabled=False,
                runtime_status="configured",
                read_write="knowledge_storage_write",
                writes_tables=["capture_drafts", "agent_runs"],
                writes_paths=_known_paths(_knowledge_write_path()),
                toolsets=["personal-assistant"],
                risk_level="medium",
                description="User-invoked capture draft tool; not an automatic background job.",
            ),
            _automation_boundary(
                item_id="tool:synthesize_garden",
                name="synthesize_garden",
                kind="tool",
                enabled=False,
                runtime_status="configured",
                read_write="state_write",
                writes_tables=["garden_drafts", "garden_cards", "agent_runs"],
                writes_paths=[],
                toolsets=["personal-assistant"],
                risk_level="medium",
                description="User-invoked Knowledge Card synthesis tool; writes structured card state, not standing Markdown files.",
            ),
            _automation_boundary(
                item_id="watcher:watch_vault",
                name="Knowledge storage watcher",
                kind="watcher",
                enabled=_launchagent_status("com.pipi.hermes-vault-watcher")[0] == "running",
                runtime_status=_launchagent_status("com.pipi.hermes-vault-watcher")[0],
                read_write="knowledge_storage_write",
                writes_tables=["captures", "capture_drafts", "reading_drafts"],
                writes_paths=_known_paths(_knowledge_write_path(), _knowledge_checkout_path("data")),
                risk_level="high",
                description="Polls local Knowledge storage and runs repair_data in apply mode after detected changes.",
                source_path=_knowledge_checkout_path("scripts", "watch_vault.py"),
            ),
            _automation_boundary(
                item_id="repair:repair_data",
                name="scripts/repair_data.py",
                kind="repair",
                enabled=False,
                runtime_status="configured",
                read_write="knowledge_storage_write",
                writes_tables=["captures", "capture_drafts"],
                writes_paths=_known_paths(_knowledge_write_path(), _knowledge_checkout_path("data", "backups")),
                risk_level="high",
                description="Repair script is read-only unless called with apply=True; the Knowledge storage watcher calls it with apply=True.",
                source_path=_knowledge_checkout_path("scripts", "repair_data.py"),
            ),
        ]
    )

    return {
        "items": items,
        "total": len(items),
        "generated_at": time.time(),
    }


# ---------------------------------------------------------------------------
# Profile management endpoints (minimal — list/create/rename/delete + SOUL.md)
# ---------------------------------------------------------------------------


class ProfileCreate(BaseModel):
    name: str
    clone_from_default: bool = False
    no_skills: bool = False


class ProfileRename(BaseModel):
    new_name: str


class ProfileSoulUpdate(BaseModel):
    content: str


def _profile_attr(info, name: str, default: Any = None) -> Any:
    try:
        return getattr(info, name)
    except Exception:
        return default


def _profile_to_dict(info) -> Dict[str, Any]:
    return {
        "name": _profile_attr(info, "name", ""),
        "path": str(_profile_attr(info, "path", "")),
        "is_default": bool(_profile_attr(info, "is_default", False)),
        "model": _profile_attr(info, "model"),
        "provider": _profile_attr(info, "provider"),
        "has_env": bool(_profile_attr(info, "has_env", False)),
        "skill_count": int(_profile_attr(info, "skill_count", 0) or 0),
    }


def _fallback_profile_dicts(profiles_mod) -> List[Dict[str, Any]]:
    def _safe(callable_, default):
        try:
            return callable_()
        except Exception:
            return default

    profiles: List[Dict[str, Any]] = []
    default_home = profiles_mod._get_default_hermes_home()
    if default_home.is_dir():
        model, provider = _safe(lambda: profiles_mod._read_config_model(default_home), (None, None))
        profiles.append({
            "name": "default",
            "path": str(default_home),
            "is_default": True,
            "model": model,
            "provider": provider,
            "has_env": (default_home / ".env").exists(),
            "skill_count": _safe(lambda: profiles_mod._count_skills(default_home), 0),
        })

    profiles_root = profiles_mod._get_profiles_root()
    if profiles_root.is_dir():
        for entry in sorted(profiles_root.iterdir()):
            if not entry.is_dir() or not profiles_mod._PROFILE_ID_RE.match(entry.name):
                continue
            model, provider = _safe(lambda entry=entry: profiles_mod._read_config_model(entry), (None, None))
            profiles.append({
                "name": entry.name,
                "path": str(entry),
                "is_default": False,
                "model": model,
                "provider": provider,
                "has_env": (entry / ".env").exists(),
                "skill_count": _safe(lambda entry=entry: profiles_mod._count_skills(entry), 0),
            })

    return profiles


def _resolve_profile_dir(name: str) -> Path:
    """Validate ``name`` and resolve to its directory or raise an HTTPException."""
    from hermes_cli import profiles as profiles_mod
    try:
        profiles_mod.validate_profile_name(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not profiles_mod.profile_exists(name):
        raise HTTPException(status_code=404, detail=f"Profile '{name}' does not exist.")
    return profiles_mod.get_profile_dir(name)


def _profile_setup_command(name: str) -> str:
    """Return the shell command used to configure a profile in the CLI."""
    _resolve_profile_dir(name)
    return "hermes setup" if name == "default" else f"{name} setup"


@app.get("/api/profiles")
async def list_profiles_endpoint():
    from hermes_cli import profiles as profiles_mod
    try:
        return {"profiles": [_profile_to_dict(p) for p in profiles_mod.list_profiles()]}
    except Exception:
        _log.exception("GET /api/profiles failed; falling back to profile directory scan")
        return {"profiles": _fallback_profile_dicts(profiles_mod)}


@app.post("/api/profiles")
async def create_profile_endpoint(body: ProfileCreate):
    from hermes_cli import profiles as profiles_mod
    try:
        path = profiles_mod.create_profile(
            name=body.name,
            clone_from="default" if body.clone_from_default else None,
            clone_config=body.clone_from_default,
            no_skills=body.no_skills,
        )
        # Match the CLI's profile-create flow: fresh named profiles get the
        # bundled skills installed. When cloning from default, create_profile()
        # has already copied the source profile's skills, including any
        # user-installed skills. When no_skills=True, create_profile() wrote
        # the opt-out marker and seed_profile_skills() will no-op.
        if not body.clone_from_default:
            profiles_mod.seed_profile_skills(path, quiet=True)

        # Match the CLI's profile-create flow: named profiles should get a
        # wrapper in ~/.local/bin when the alias is safe to create.
        collision = profiles_mod.check_alias_collision(body.name)
        if not collision:
            profiles_mod.create_wrapper_script(body.name)
    except (ValueError, FileExistsError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _log.exception("POST /api/profiles failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "name": body.name, "path": str(path)}


@app.get("/api/profiles/{name}/setup-command")
async def get_profile_setup_command(name: str):
    return {"command": _profile_setup_command(name)}


@app.post("/api/profiles/{name}/open-terminal")
async def open_profile_terminal_endpoint(name: str):
    try:
        command = _profile_setup_command(name)

        if sys.platform.startswith("win"):
            subprocess.Popen(["cmd.exe", "/c", "start", "", command])
        elif sys.platform == "darwin":
            escaped = command.replace("\\", "\\\\").replace('"', '\\"')
            applescript = (
                'tell application "Terminal"\n'
                "activate\n"
                f'do script "{escaped}"\n'
                "end tell"
            )
            subprocess.Popen(["osascript", "-e", applescript])
        else:
            terminal_commands = [
                ("x-terminal-emulator", ["x-terminal-emulator", "-e", "sh", "-lc", command]),
                ("gnome-terminal", ["gnome-terminal", "--", "sh", "-lc", command]),
                ("konsole", ["konsole", "-e", "sh", "-lc", command]),
                ("xfce4-terminal", ["xfce4-terminal", "-e", f"sh -lc '{command}'"]),
                ("mate-terminal", ["mate-terminal", "-e", f"sh -lc '{command}'"]),
                ("lxterminal", ["lxterminal", "-e", f"sh -lc '{command}'"]),
                ("tilix", ["tilix", "-e", "sh", "-lc", command]),
                ("alacritty", ["alacritty", "-e", "sh", "-lc", command]),
                ("kitty", ["kitty", "sh", "-lc", command]),
                ("xterm", ["xterm", "-e", "sh", "-lc", command]),
            ]
            for executable, popen_args in terminal_commands:
                if subprocess.call(
                    ["which", executable],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                ) == 0:
                    subprocess.Popen(popen_args)
                    break
            else:
                raise HTTPException(
                    status_code=400,
                    detail="No supported terminal emulator found",
                )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        _log.exception("POST /api/profiles/%s/open-terminal failed", name)
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "command": command}


@app.patch("/api/profiles/{name}")
async def rename_profile_endpoint(name: str, body: ProfileRename):
    from hermes_cli import profiles as profiles_mod
    try:
        path = profiles_mod.rename_profile(name, body.new_name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (ValueError, FileExistsError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _log.exception("PATCH /api/profiles/%s failed", name)
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "name": body.new_name, "path": str(path)}


@app.delete("/api/profiles/{name}")
async def delete_profile_endpoint(name: str):
    """Delete a profile. The dashboard collects the user's confirmation in
    its own dialog before this request, so we always pass ``yes=True`` to
    skip the CLI's interactive prompt."""
    from hermes_cli import profiles as profiles_mod
    try:
        path = profiles_mod.delete_profile(name, yes=True)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _log.exception("DELETE /api/profiles/%s failed", name)
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(path)}


@app.get("/api/profiles/{name}/soul")
async def get_profile_soul(name: str):
    soul_path = _resolve_profile_dir(name) / "SOUL.md"
    if soul_path.exists():
        try:
            return {"content": soul_path.read_text(encoding="utf-8"), "exists": True}
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Could not read SOUL.md: {e}")
    return {"content": "", "exists": False}


@app.put("/api/profiles/{name}/soul")
async def update_profile_soul(name: str, body: ProfileSoulUpdate):
    soul_path = _resolve_profile_dir(name) / "SOUL.md"
    try:
        soul_path.write_text(body.content, encoding="utf-8")
    except OSError as e:
        _log.exception("PUT /api/profiles/%s/soul failed", name)
        raise HTTPException(status_code=500, detail=f"Could not write SOUL.md: {e}")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Skills & Tools endpoints
# ---------------------------------------------------------------------------


class SkillToggle(BaseModel):
    name: str
    enabled: bool


@app.get("/api/skills")
async def get_skills():
    from tools.skills_tool import _find_all_skills
    from hermes_cli.skills_config import get_disabled_skills
    config = load_config()
    disabled = get_disabled_skills(config)
    skills = _find_all_skills(skip_disabled=True)
    for s in skills:
        s["enabled"] = s["name"] not in disabled
    return skills


@app.put("/api/skills/toggle")
async def toggle_skill(body: SkillToggle):
    from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
    config = load_config()
    disabled = get_disabled_skills(config)
    if body.enabled:
        disabled.discard(body.name)
    else:
        disabled.add(body.name)
    save_disabled_skills(config, disabled)
    return {"ok": True, "name": body.name, "enabled": body.enabled}


@app.get("/api/tools/toolsets")
async def get_toolsets():
    from hermes_cli.tools_config import (
        _get_effective_configurable_toolsets,
        _get_platform_tools,
        _toolset_has_keys,
    )
    from toolsets import resolve_toolset

    config = load_config()
    enabled_toolsets = _get_platform_tools(
        config,
        "cli",
        include_default_mcp_servers=False,
    )
    result = []
    for name, label, desc in _get_effective_configurable_toolsets():
        try:
            tools = sorted(set(resolve_toolset(name)))
        except Exception:
            tools = []
        is_enabled = name in enabled_toolsets
        result.append({
            "name": name, "label": label, "description": desc,
            "enabled": is_enabled,
            "available": is_enabled,
            "configured": _toolset_has_keys(name, config),
            "tools": tools,
        })
    return result


# ---------------------------------------------------------------------------
# Raw YAML config endpoint
# ---------------------------------------------------------------------------


class RawConfigUpdate(BaseModel):
    yaml_text: str


@app.get("/api/config/raw")
async def get_config_raw():
    path = get_config_path()
    if not path.exists():
        return {"yaml": ""}
    return {"yaml": path.read_text(encoding="utf-8")}


@app.put("/api/config/raw")
async def update_config_raw(body: RawConfigUpdate):
    try:
        parsed = yaml.safe_load(body.yaml_text)
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail="YAML must be a mapping")
        save_config(parsed)
        return {"ok": True}
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")


# ---------------------------------------------------------------------------
# Token / cost analytics endpoint
# ---------------------------------------------------------------------------


@app.get("/api/analytics/usage")
async def get_usage_analytics(days: int = 30):
    from hermes_state import SessionDB
    from agent.insights import InsightsEngine

    db = SessionDB()
    try:
        cutoff = time.time() - (days * 86400)
        cur = db._conn.execute("""
            SELECT date(started_at, 'unixepoch') as day,
                   SUM(input_tokens) as input_tokens,
                   SUM(output_tokens) as output_tokens,
                   SUM(cache_read_tokens) as cache_read_tokens,
                   SUM(reasoning_tokens) as reasoning_tokens,
                   COALESCE(SUM(estimated_cost_usd), 0) as estimated_cost,
                   COALESCE(SUM(actual_cost_usd), 0) as actual_cost,
                   COUNT(*) as sessions,
                   SUM(COALESCE(api_call_count, 0)) as api_calls
            FROM sessions WHERE started_at > ?
            GROUP BY day ORDER BY day
        """, (cutoff,))
        daily = [dict(r) for r in cur.fetchall()]

        cur2 = db._conn.execute("""
            SELECT model,
                   SUM(input_tokens) as input_tokens,
                   SUM(output_tokens) as output_tokens,
                   COALESCE(SUM(estimated_cost_usd), 0) as estimated_cost,
                   COUNT(*) as sessions,
                   SUM(COALESCE(api_call_count, 0)) as api_calls
            FROM sessions WHERE started_at > ? AND model IS NOT NULL
            GROUP BY model ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
        """, (cutoff,))
        by_model = [dict(r) for r in cur2.fetchall()]

        cur3 = db._conn.execute("""
            SELECT SUM(input_tokens) as total_input,
                   SUM(output_tokens) as total_output,
                   SUM(cache_read_tokens) as total_cache_read,
                   SUM(reasoning_tokens) as total_reasoning,
                   COALESCE(SUM(estimated_cost_usd), 0) as total_estimated_cost,
                   COALESCE(SUM(actual_cost_usd), 0) as total_actual_cost,
                   COUNT(*) as total_sessions,
                   SUM(COALESCE(api_call_count, 0)) as total_api_calls
            FROM sessions WHERE started_at > ?
        """, (cutoff,))
        totals = dict(cur3.fetchone())
        insights_report = InsightsEngine(db).generate(days=days)
        skills = insights_report.get("skills", {
            "summary": {
                "total_skill_loads": 0,
                "total_skill_edits": 0,
                "total_skill_actions": 0,
                "distinct_skills_used": 0,
            },
            "top_skills": [],
        })

        return {
            "daily": daily,
            "by_model": by_model,
            "totals": totals,
            "period_days": days,
            "skills": skills,
        }
    finally:
        db.close()


@app.get("/api/analytics/models")
async def get_models_analytics(days: int = 30):
    """Rich per-model analytics for the Models dashboard page.

    Returns token/cost/session breakdown per model plus capability metadata
    from models.dev (context window, vision, tools, reasoning, etc.).
    """
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        cutoff = time.time() - (days * 86400)

        cur = db._conn.execute("""
            SELECT model,
                   billing_provider,
                   SUM(input_tokens) as input_tokens,
                   SUM(output_tokens) as output_tokens,
                   SUM(cache_read_tokens) as cache_read_tokens,
                   SUM(reasoning_tokens) as reasoning_tokens,
                   COALESCE(SUM(estimated_cost_usd), 0) as estimated_cost,
                   COALESCE(SUM(actual_cost_usd), 0) as actual_cost,
                   COUNT(*) as sessions,
                   SUM(COALESCE(api_call_count, 0)) as api_calls,
                   SUM(tool_call_count) as tool_calls,
                   MAX(started_at) as last_used_at,
                   AVG(input_tokens + output_tokens) as avg_tokens_per_session
            FROM sessions WHERE started_at > ? AND model IS NOT NULL AND model != ''
            GROUP BY model, billing_provider
            ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
        """, (cutoff,))
        rows = [dict(r) for r in cur.fetchall()]

        models = []
        for row in rows:
            provider = row.get("billing_provider") or ""
            model_name = row["model"]
            caps = {}
            try:
                from agent.models_dev import get_model_capabilities
                mc = get_model_capabilities(provider=provider, model=model_name)
                if mc is not None:
                    caps = {
                        "supports_tools": mc.supports_tools,
                        "supports_vision": mc.supports_vision,
                        "supports_reasoning": mc.supports_reasoning,
                        "context_window": mc.context_window,
                        "max_output_tokens": mc.max_output_tokens,
                        "model_family": mc.model_family,
                    }
            except Exception:
                pass

            models.append({
                "model": model_name,
                "provider": provider,
                "input_tokens": row["input_tokens"],
                "output_tokens": row["output_tokens"],
                "cache_read_tokens": row["cache_read_tokens"],
                "reasoning_tokens": row["reasoning_tokens"],
                "estimated_cost": row["estimated_cost"],
                "actual_cost": row["actual_cost"],
                "sessions": row["sessions"],
                "api_calls": row["api_calls"],
                "tool_calls": row["tool_calls"],
                "last_used_at": row["last_used_at"],
                "avg_tokens_per_session": row["avg_tokens_per_session"],
                "capabilities": caps,
            })

        totals_cur = db._conn.execute("""
            SELECT COUNT(DISTINCT model) as distinct_models,
                   SUM(input_tokens) as total_input,
                   SUM(output_tokens) as total_output,
                   SUM(cache_read_tokens) as total_cache_read,
                   SUM(reasoning_tokens) as total_reasoning,
                   COALESCE(SUM(estimated_cost_usd), 0) as total_estimated_cost,
                   COALESCE(SUM(actual_cost_usd), 0) as total_actual_cost,
                   COUNT(*) as total_sessions,
                   SUM(COALESCE(api_call_count, 0)) as total_api_calls
            FROM sessions WHERE started_at > ? AND model IS NOT NULL AND model != ''
        """, (cutoff,))
        totals = dict(totals_cur.fetchone())

        return {
            "models": models,
            "totals": totals,
            "period_days": days,
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# /api/pty — PTY-over-WebSocket bridge for the dashboard "Chat" tab.
#
# The endpoint spawns the same ``hermes --tui`` binary the CLI uses, behind
# a POSIX pseudo-terminal, and forwards bytes + resize escapes across a
# WebSocket.  The browser renders the ANSI through xterm.js (see
# web/src/pages/ChatPage.tsx).
#
# Auth: ``?token=<session_token>`` query param (browsers can't set
# Authorization on the WS upgrade).  Same ephemeral ``_SESSION_TOKEN`` as
# REST.  Localhost-only — we defensively reject non-loopback clients even
# though uvicorn binds to 127.0.0.1.
# ---------------------------------------------------------------------------

import re
import asyncio

# PTY bridge is POSIX-only (depends on fcntl/termios/ptyprocess).  On native
# Windows the import raises; catch and leave PtyBridge=None so the rest of
# the dashboard (sessions, jobs, metrics, config editor) still loads and the
# /api/pty endpoint cleanly refuses with a WSL-suggested message.
try:
    from hermes_cli.pty_bridge import PtyBridge, PtyUnavailableError
    _PTY_BRIDGE_AVAILABLE = True
except ImportError as _pty_import_err:  # pragma: no cover - Windows-only path
    PtyBridge = None  # type: ignore[assignment]
    _PTY_BRIDGE_AVAILABLE = False

    class PtyUnavailableError(RuntimeError):  # type: ignore[no-redef]
        """Stub on platforms where pty_bridge can't be imported."""
        pass

_RESIZE_RE = re.compile(rb"\x1b\[RESIZE:(\d+);(\d+)\]")
_PTY_READ_CHUNK_TIMEOUT = 0.2
_VALID_CHANNEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
# Starlette's TestClient reports the peer as "testclient"; treat it as
# loopback so tests don't need to rewrite request scope.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})


def _is_public_bind() -> bool:
    """True when bound to all-interfaces (operator used --insecure)."""
    return getattr(app.state, "bound_host", "") in {"0.0.0.0", "::"}


def _ws_client_is_allowed(ws: "WebSocket") -> bool:
    """Check if the WebSocket client IP is acceptable.

    Allows loopback always; allows any IP when bound to all-interfaces
    (--insecure mode, guarded by session token auth).
    """
    if _is_public_bind():
        return True
    client_host = ws.client.host if ws.client else ""
    if not client_host:
        return True
    return client_host in _LOOPBACK_HOSTS

# Per-channel subscriber registry used by /api/pub (PTY-side gateway → dashboard)
# and /api/events (dashboard → browser sidebar).  Keyed by an opaque channel id
# the chat tab generates on mount; entries auto-evict when the last subscriber
# drops AND the publisher has disconnected.
_event_channels: dict[str, set] = {}
_event_lock = asyncio.Lock()


def _resolve_chat_argv(
    resume: Optional[str] = None,
    sidecar_url: Optional[str] = None,
) -> tuple[list[str], Optional[str], Optional[dict]]:
    """Resolve the argv + cwd + env for the chat PTY.

    Default: whatever ``hermes --tui`` would run.  Tests monkeypatch this
    function to inject a tiny fake command (``cat``, ``sh -c 'printf …'``)
    so nothing has to build Node or the TUI bundle.

    Session resume is propagated via the ``HERMES_TUI_RESUME`` env var —
    matching what ``hermes_cli.main._launch_tui`` does for the CLI path.
    Appending ``--resume <id>`` to argv doesn't work because ``ui-tui`` does
    not parse its argv.

    `sidecar_url` (when set) is forwarded as ``HERMES_TUI_SIDECAR_URL`` so
    the spawned ``tui_gateway.entry`` can mirror dispatcher emits to the
    dashboard's ``/api/pub`` endpoint (see :func:`pub_ws`).
    """
    from hermes_cli.main import PROJECT_ROOT, _make_tui_argv

    argv, cwd = _make_tui_argv(PROJECT_ROOT / "ui-tui", tui_dev=False)
    env = os.environ.copy()
    env.setdefault("NODE_ENV", "production")
    # Browser-embedded chat should prefer stable wheel-based scrollback over
    # native terminal mouse tracking. When mouse tracking is enabled, wheel
    # events are consumed by the TUI and forwarded as terminal input, which
    # makes browser-side transcript scrolling feel broken. Keep the terminal
    # build unchanged for native CLI usage; only disable mouse tracking for
    # the dashboard PTY path.
    env.setdefault("HERMES_TUI_DISABLE_MOUSE", "1")

    if resume:
        latest_resume, _latest_path = _session_latest_descendant(resume)
        if latest_resume:
            resume = latest_resume
        env["HERMES_TUI_RESUME"] = resume

    if sidecar_url:
        env["HERMES_TUI_SIDECAR_URL"] = sidecar_url

    return list(argv), str(cwd) if cwd else None, env


def _build_sidecar_url(channel: str) -> Optional[str]:
    """ws:// URL the PTY child should publish events to, or None when unbound."""
    host = getattr(app.state, "bound_host", None)
    port = getattr(app.state, "bound_port", None)

    if not host or not port:
        return None

    netloc = f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"
    qs = urllib.parse.urlencode({"token": _SESSION_TOKEN, "channel": channel})

    return f"ws://{netloc}/api/pub?{qs}"


async def _broadcast_event(channel: str, payload: str) -> None:
    """Fan out one publisher frame to every subscriber on `channel`."""
    async with _event_lock:
        subs = list(_event_channels.get(channel, ()))

    for sub in subs:
        try:
            await sub.send_text(payload)
        except Exception:
            # Subscriber went away mid-send; the /api/events finally clause
            # will remove it from the registry on its next iteration.
            pass


def _channel_or_close_code(ws: WebSocket) -> Optional[str]:
    """Return the channel id from the query string or None if invalid."""
    channel = ws.query_params.get("channel", "")

    return channel if _VALID_CHANNEL_RE.match(channel) else None


@app.websocket("/api/pty")
async def pty_ws(ws: WebSocket) -> None:
    if not _DASHBOARD_EMBEDDED_CHAT_ENABLED:
        await ws.close(code=4403)
        return

    # --- auth + loopback check (before accept so we can close cleanly) ---
    token = ws.query_params.get("token", "")
    expected = _SESSION_TOKEN
    if not hmac.compare_digest(token.encode(), expected.encode()):
        await ws.close(code=4401)
        return

    if not _ws_client_is_allowed(ws):
        await ws.close(code=4403)
        return

    await ws.accept()

    # On native Windows, the POSIX PTY bridge can't be imported.  Tell the
    # client and close cleanly rather than pretending the feature works.
    if not _PTY_BRIDGE_AVAILABLE:
        await ws.send_text(
            "\r\n\x1b[31mChat unavailable: the embedded terminal requires a "
            "POSIX PTY, which native Windows Python doesn't provide.\x1b[0m\r\n"
            "\x1b[33mInstall Hermes inside WSL2 to use the dashboard's /chat "
            "tab — the rest of the dashboard works here.\x1b[0m\r\n"
        )
        await ws.close(code=1011)
        return

    # --- spawn PTY ------------------------------------------------------
    resume = ws.query_params.get("resume") or None
    channel = _channel_or_close_code(ws)
    sidecar_url = _build_sidecar_url(channel) if channel else None

    try:
        argv, cwd, env = _resolve_chat_argv(resume=resume, sidecar_url=sidecar_url)
    except SystemExit as exc:
        # _make_tui_argv calls sys.exit(1) when node/npm is missing.
        await ws.send_text(f"\r\n\x1b[31mChat unavailable: {exc}\x1b[0m\r\n")
        await ws.close(code=1011)
        return


    try:
        bridge = PtyBridge.spawn(argv, cwd=cwd, env=env)
    except PtyUnavailableError as exc:
        await ws.send_text(f"\r\n\x1b[31mChat unavailable: {exc}\x1b[0m\r\n")
        await ws.close(code=1011)
        return
    except (FileNotFoundError, OSError) as exc:
        await ws.send_text(f"\r\n\x1b[31mChat failed to start: {exc}\x1b[0m\r\n")
        await ws.close(code=1011)
        return

    loop = asyncio.get_running_loop()

    # --- reader task: PTY master → WebSocket ----------------------------
    async def pump_pty_to_ws() -> None:
        while True:
            chunk = await loop.run_in_executor(
                None, bridge.read, _PTY_READ_CHUNK_TIMEOUT
            )
            if chunk is None:  # EOF
                return
            if not chunk:  # no data this tick; yield control and retry
                await asyncio.sleep(0)
                continue
            try:
                await ws.send_bytes(chunk)
            except Exception:
                return

    reader_task = asyncio.create_task(pump_pty_to_ws())

    # --- writer loop: WebSocket → PTY master ----------------------------
    try:
        while True:
            msg = await ws.receive()
            msg_type = msg.get("type")
            if msg_type == "websocket.disconnect":
                break
            raw = msg.get("bytes")
            if raw is None:
                text = msg.get("text")
                raw = text.encode("utf-8") if isinstance(text, str) else b""
            if not raw:
                continue

            # Resize escape is consumed locally, never written to the PTY.
            match = _RESIZE_RE.match(raw)
            if match and match.end() == len(raw):
                cols = int(match.group(1))
                rows = int(match.group(2))
                bridge.resize(cols=cols, rows=rows)
                continue

            bridge.write(raw)
    except WebSocketDisconnect:
        pass
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except (asyncio.CancelledError, Exception):
            pass
        bridge.close()


# ---------------------------------------------------------------------------
# /api/ws — JSON-RPC WebSocket sidecar for dashboard chat surfaces.
#
# Drives the same `tui_gateway.dispatch` surface Ink uses over stdio, so the
# dashboard can render GUI chat, structured metadata, model badges, tool-call
# sidebars, slash launchers, and session info. Unlike /api/pty, this endpoint
# is useful without the terminal embed and remains protected by token +
# loopback checks.
# ---------------------------------------------------------------------------


@app.websocket("/api/ws")
async def gateway_ws(ws: WebSocket) -> None:
    token = ws.query_params.get("token", "")
    if not hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode()):
        await ws.close(code=4401)
        return

    if not _ws_client_is_allowed(ws):
        await ws.close(code=4403)
        return

    from tui_gateway.ws import handle_ws

    await handle_ws(ws)


# ---------------------------------------------------------------------------
# /api/pub + /api/events — chat-tab event broadcast.
#
# The PTY-side ``tui_gateway.entry`` opens /api/pub at startup (driven by
# HERMES_TUI_SIDECAR_URL set in /api/pty's PTY env) and writes every
# dispatcher emit through it.  The dashboard fans those frames out to any
# subscriber that opened /api/events on the same channel id.  This is what
# gives the React sidebar its tool-call feed without breaking the PTY
# child's stdio handshake with Ink.
# ---------------------------------------------------------------------------


@app.websocket("/api/pub")
async def pub_ws(ws: WebSocket) -> None:
    if not _DASHBOARD_EMBEDDED_CHAT_ENABLED:
        await ws.close(code=4403)
        return

    token = ws.query_params.get("token", "")
    if not hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode()):
        await ws.close(code=4401)
        return

    if not _ws_client_is_allowed(ws):
        await ws.close(code=4403)
        return

    channel = _channel_or_close_code(ws)
    if not channel:
        await ws.close(code=4400)
        return

    await ws.accept()

    try:
        while True:
            await _broadcast_event(channel, await ws.receive_text())
    except WebSocketDisconnect:
        pass


@app.websocket("/api/events")
async def events_ws(ws: WebSocket) -> None:
    if not _DASHBOARD_EMBEDDED_CHAT_ENABLED:
        await ws.close(code=4403)
        return

    token = ws.query_params.get("token", "")
    if not hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode()):
        await ws.close(code=4401)
        return

    if not _ws_client_is_allowed(ws):
        await ws.close(code=4403)
        return

    channel = _channel_or_close_code(ws)
    if not channel:
        await ws.close(code=4400)
        return

    await ws.accept()

    async with _event_lock:
        _event_channels.setdefault(channel, set()).add(ws)

    try:
        while True:
            # Subscribers don't speak — the receive() just blocks until
            # disconnect so the connection stays open as long as the
            # browser holds it.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with _event_lock:
            subs = _event_channels.get(channel)

            if subs is not None:
                subs.discard(ws)

                if not subs:
                    _event_channels.pop(channel, None)


def _normalise_prefix(raw: Optional[str]) -> str:
    """Normalise an X-Forwarded-Prefix header value.

    Returns a string like ``"/hermes"`` (no trailing slash) or ``""`` when
    no prefix is set / the header is malformed. We deliberately reject
    anything containing ``..`` or non-printable bytes so a hostile proxy
    can't inject HTML via the prefix.
    """
    if not raw:
        return ""
    p = raw.strip()
    if not p:
        return ""
    if not p.startswith("/"):
        p = "/" + p
    p = p.rstrip("/")
    if "//" in p or ".." in p or any(c in p for c in ('"', "'", "<", ">", " ", "\n", "\r", "\t")):
        return ""
    if len(p) > 64:
        return ""
    return p


def mount_spa(application: FastAPI):
    """Mount the built SPA. Falls back to index.html for client-side routing.

    The session token is injected into index.html via a ``<script>`` tag so
    the SPA can authenticate against protected API endpoints without a
    separate (unauthenticated) token-dispensing endpoint.

    When served behind a path-prefix reverse proxy (e.g.
    ``mission-control.tilos.com/hermes/*`` -> local Caddy -> :9119), the
    proxy injects ``X-Forwarded-Prefix: /hermes`` on every request. We
    rewrite the served ``index.html`` so absolute asset URLs (``/assets/...``)
    and the SPA's runtime ``__HERMES_BASE_PATH__`` honour that prefix
    without rebuilding the bundle.
    """
    if not WEB_DIST.exists():
        @application.get("/{full_path:path}")
        async def no_frontend(full_path: str):
            return JSONResponse(
                {"error": "Frontend not built. Run: cd web && npm run build"},
                status_code=404,
            )
        return

    _index_path = WEB_DIST / "index.html"

    def _serve_index(prefix: str = ""):
        """Return index.html with the session token + base-path injected.

        ``prefix`` is the normalised ``X-Forwarded-Prefix`` (e.g. ``/hermes``)
        or empty string when served at root.
        """
        html = _index_path.read_text()
        chat_js = "true" if _DASHBOARD_EMBEDDED_CHAT_ENABLED else "false"
        token_script = (
            f'<script>window.__HERMES_SESSION_TOKEN__="{_SESSION_TOKEN}";'
            f"window.__HERMES_DASHBOARD_EMBEDDED_CHAT__={chat_js};"
            f'window.__HERMES_BASE_PATH__="{prefix}";</script>'
        )
        if prefix:
            # Rewrite absolute asset URLs baked into the Vite build so the
            # browser fetches them through the same proxy prefix.
            html = html.replace('href="/assets/', f'href="{prefix}/assets/')
            html = html.replace('src="/assets/', f'src="{prefix}/assets/')
            html = html.replace('href="/favicon.ico"', f'href="{prefix}/favicon.ico"')
            html = html.replace('href="/fonts/', f'href="{prefix}/fonts/')
            html = html.replace('href="/ds-assets/', f'href="{prefix}/ds-assets/')
            html = html.replace('src="/ds-assets/', f'src="{prefix}/ds-assets/')
        html = html.replace("</head>", f"{token_script}</head>", 1)
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )

    # When served behind a path-prefix proxy, the built CSS contains
    # absolute ``url(/fonts/...)`` and ``url(/ds-assets/...)`` references.
    # Browsers resolve those against the document origin, which means
    # under ``/hermes`` they'd hit ``mission-control.tilos.com/fonts/...``
    # (the MC Pages app), not the Hermes backend. Intercept CSS asset
    # requests BEFORE the StaticFiles mount and rewrite the absolute paths
    # when a prefix is in play.
    @application.get("/assets/{filename}.css")
    async def serve_css(filename: str, request: Request):
        css_path = WEB_DIST / "assets" / f"{filename}.css"
        if not css_path.is_file() or not css_path.resolve().is_relative_to(
            WEB_DIST.resolve()
        ):
            return JSONResponse({"error": "not found"}, status_code=404)
        prefix = _normalise_prefix(request.headers.get("x-forwarded-prefix"))
        css = css_path.read_text()
        if prefix:
            for asset_dir in ("/fonts/", "/fonts-terminal/", "/ds-assets/", "/assets/"):
                css = css.replace(f"url({asset_dir}", f"url({prefix}{asset_dir}")
                css = css.replace(f"url(\"{asset_dir}", f"url(\"{prefix}{asset_dir}")
                css = css.replace(f"url('{asset_dir}", f"url('{prefix}{asset_dir}")
        return Response(content=css, media_type="text/css")

    application.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @application.get("/{full_path:path}")
    async def serve_spa(full_path: str, request: Request):
        prefix = _normalise_prefix(request.headers.get("x-forwarded-prefix"))
        file_path = WEB_DIST / full_path
        # Prevent path traversal via url-encoded sequences (%2e%2e/)
        if (
            full_path
            and file_path.resolve().is_relative_to(WEB_DIST.resolve())
            and file_path.exists()
            and file_path.is_file()
        ):
            return FileResponse(file_path)
        return _serve_index(prefix)


# ---------------------------------------------------------------------------
# Dashboard theme endpoints
# ---------------------------------------------------------------------------

# Built-in dashboard themes — label + description only.  The actual color
# definitions live in the frontend (web/src/themes/presets.ts).
_BUILTIN_DASHBOARD_THEMES = [
    {"name": "default",       "label": "Hermes Paper",         "description": "Light paper workspace for reading and knowledge work"},
    {"name": "default-large", "label": "Hermes Paper (Large)", "description": "Hermes Paper with bigger fonts and roomier spacing"},
    {"name": "hermes-teal",   "label": "Hermes Teal",          "description": "Classic dark teal — the legacy Hermes look"},
    {"name": "midnight",      "label": "Midnight",            "description": "Deep blue-violet with cool accents"},
    {"name": "ember",     "label": "Ember",          "description": "Warm crimson and bronze — forge vibes"},
    {"name": "mono",      "label": "Mono",           "description": "Clean grayscale — minimal and focused"},
    {"name": "cyberpunk", "label": "Cyberpunk",      "description": "Neon green on black — matrix terminal"},
    {"name": "rose",      "label": "Rosé",           "description": "Soft pink and warm ivory — easy on the eyes"},
]


def _parse_theme_layer(value: Any, default_hex: str, default_alpha: float = 1.0) -> Optional[Dict[str, Any]]:
    """Normalise a theme layer spec from YAML into `{hex, alpha}` form.

    Accepts shorthand (a bare hex string) or full dict form.  Returns
    ``None`` on garbage input so the caller can fall back to a built-in
    default rather than blowing up.
    """
    if value is None:
        return {"hex": default_hex, "alpha": default_alpha}
    if isinstance(value, str):
        return {"hex": value, "alpha": default_alpha}
    if isinstance(value, dict):
        hex_val = value.get("hex", default_hex)
        alpha_val = value.get("alpha", default_alpha)
        if not isinstance(hex_val, str):
            return None
        try:
            alpha_f = float(alpha_val)
        except (TypeError, ValueError):
            alpha_f = default_alpha
        return {"hex": hex_val, "alpha": max(0.0, min(1.0, alpha_f))}
    return None


_THEME_DEFAULT_TYPOGRAPHY: Dict[str, str] = {
    "fontSans": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    "fontMono": 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
    "baseSize": "15px",
    "lineHeight": "1.55",
    "letterSpacing": "0",
}

_THEME_DEFAULT_LAYOUT: Dict[str, str] = {
    "radius": "0.5rem",
    "density": "comfortable",
}

_THEME_OVERRIDE_KEYS = {
    "card", "cardForeground", "popover", "popoverForeground",
    "primary", "primaryForeground", "secondary", "secondaryForeground",
    "muted", "mutedForeground", "accent", "accentForeground",
    "destructive", "destructiveForeground", "success", "warning",
    "border", "input", "ring",
}

# Well-known named asset slots themes can populate.  Any other keys under
# ``assets.custom`` are exposed as ``--theme-asset-custom-<key>`` CSS vars
# for plugin/shell use.
_THEME_NAMED_ASSET_KEYS = {"bg", "hero", "logo", "crest", "sidebar", "header"}

# Component-style buckets themes can override.  The value under each bucket
# is a mapping from camelCase property name to CSS string; each pair emits
# ``--component-<bucket>-<kebab-property>`` on :root.  The frontend's shell
# components (Card, App header, Backdrop, etc.) consume these vars so themes
# can restyle chrome (clip-path, border-image, segmented progress, etc.)
# without shipping their own CSS.
_THEME_COMPONENT_BUCKETS = {
    "card", "header", "footer", "sidebar", "tab",
    "progress", "badge", "backdrop", "page",
}

_THEME_LAYOUT_VARIANTS = {"standard", "cockpit", "tiled"}

# Cap on customCSS length so a malformed/oversized theme YAML can't blow up
# the response payload or the <style> tag.  32 KiB is plenty for every
# practical reskin (the Strike Freedom demo is ~2 KiB).
_THEME_CUSTOM_CSS_MAX = 32 * 1024


def _normalise_theme_definition(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalise a user theme YAML into the wire format `ThemeProvider`
    expects.  Returns ``None`` if the theme is unusable.

    Accepts both the full schema (palette/typography/layout) and a loose
    form with bare hex strings, so hand-written YAMLs stay friendly.
    """
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    # Palette
    palette_src = data.get("palette", {}) if isinstance(data.get("palette"), dict) else {}
    # Allow top-level `colors.background` as a shorthand too.
    colors_src = data.get("colors", {}) if isinstance(data.get("colors"), dict) else {}

    def _layer(key: str, default_hex: str, default_alpha: float = 1.0) -> Dict[str, Any]:
        spec = palette_src.get(key, colors_src.get(key))
        parsed = _parse_theme_layer(spec, default_hex, default_alpha)
        return parsed if parsed is not None else {"hex": default_hex, "alpha": default_alpha}

    palette = {
        "background": _layer("background", "#041c1c", 1.0),
        "midground": _layer("midground", "#ffe6cb", 1.0),
        "foreground": _layer("foreground", "#ffffff", 0.0),
        "warmGlow": palette_src.get("warmGlow") or data.get("warmGlow") or "rgba(255, 189, 56, 0.35)",
        "noiseOpacity": 1.0,
    }
    raw_noise = palette_src.get("noiseOpacity", data.get("noiseOpacity"))
    try:
        palette["noiseOpacity"] = float(raw_noise) if raw_noise is not None else 1.0
    except (TypeError, ValueError):
        palette["noiseOpacity"] = 1.0

    # Typography
    typo_src = data.get("typography", {}) if isinstance(data.get("typography"), dict) else {}
    typography = dict(_THEME_DEFAULT_TYPOGRAPHY)
    for key in ("fontSans", "fontMono", "fontDisplay", "fontUrl", "baseSize", "lineHeight", "letterSpacing"):
        val = typo_src.get(key)
        if isinstance(val, str) and val.strip():
            typography[key] = val

    # Layout
    layout_src = data.get("layout", {}) if isinstance(data.get("layout"), dict) else {}
    layout = dict(_THEME_DEFAULT_LAYOUT)
    radius = layout_src.get("radius")
    if isinstance(radius, str) and radius.strip():
        layout["radius"] = radius
    density = layout_src.get("density")
    if isinstance(density, str) and density in {"compact", "comfortable", "spacious"}:
        layout["density"] = density

    # Color overrides — keep only valid keys with string values.
    overrides_src = data.get("colorOverrides", {})
    color_overrides: Dict[str, str] = {}
    if isinstance(overrides_src, dict):
        for key, val in overrides_src.items():
            if key in _THEME_OVERRIDE_KEYS and isinstance(val, str) and val.strip():
                color_overrides[key] = val

    # Assets — named slots + arbitrary user-defined keys.  Values must be
    # strings (URLs or CSS ``url(...)``/``linear-gradient(...)`` expressions).
    # We don't fetch remote assets here; the frontend just injects them as
    # CSS vars.  Empty values are dropped so a theme can explicitly clear a
    # slot by setting ``hero: ""``.
    assets_out: Dict[str, Any] = {}
    assets_src = data.get("assets", {}) if isinstance(data.get("assets"), dict) else {}
    for key in _THEME_NAMED_ASSET_KEYS:
        val = assets_src.get(key)
        if isinstance(val, str) and val.strip():
            assets_out[key] = val
    custom_assets_src = assets_src.get("custom")
    if isinstance(custom_assets_src, dict):
        custom_assets: Dict[str, str] = {}
        for key, val in custom_assets_src.items():
            if (
                isinstance(key, str)
                and key.replace("-", "").replace("_", "").isalnum()
                and isinstance(val, str)
                and val.strip()
            ):
                custom_assets[key] = val
        if custom_assets:
            assets_out["custom"] = custom_assets

    # Custom CSS — raw CSS text the frontend injects as a scoped <style>
    # tag on theme apply.  Clipped to _THEME_CUSTOM_CSS_MAX to keep the
    # payload bounded.  We intentionally do NOT parse/sanitise the CSS
    # here — the dashboard is localhost-only and themes are user-authored
    # YAML in ~/.hermes/, same trust level as the config file itself.
    custom_css_val = data.get("customCSS")
    custom_css: Optional[str] = None
    if isinstance(custom_css_val, str) and custom_css_val.strip():
        custom_css = custom_css_val[:_THEME_CUSTOM_CSS_MAX]

    # Component style overrides — per-bucket dicts of camelCase CSS
    # property -> CSS string.  The frontend converts these into CSS vars
    # that shell components (Card, App header, Backdrop) consume.
    component_styles_src = data.get("componentStyles", {})
    component_styles: Dict[str, Dict[str, str]] = {}
    if isinstance(component_styles_src, dict):
        for bucket, props in component_styles_src.items():
            if bucket not in _THEME_COMPONENT_BUCKETS or not isinstance(props, dict):
                continue
            clean: Dict[str, str] = {}
            for prop, value in props.items():
                if (
                    isinstance(prop, str)
                    and prop.replace("-", "").replace("_", "").isalnum()
                    and isinstance(value, (str, int, float))
                    and str(value).strip()
                ):
                    clean[prop] = str(value)
            if clean:
                component_styles[bucket] = clean

    layout_variant_src = data.get("layoutVariant")
    layout_variant = (
        layout_variant_src
        if isinstance(layout_variant_src, str) and layout_variant_src in _THEME_LAYOUT_VARIANTS
        else "standard"
    )

    result: Dict[str, Any] = {
        "name": name,
        "label": data.get("label") or name,
        "description": data.get("description", ""),
        "palette": palette,
        "typography": typography,
        "layout": layout,
        "layoutVariant": layout_variant,
    }
    if color_overrides:
        result["colorOverrides"] = color_overrides
    if assets_out:
        result["assets"] = assets_out
    if custom_css is not None:
        result["customCSS"] = custom_css
    if component_styles:
        result["componentStyles"] = component_styles
    return result


def _discover_user_themes() -> list:
    """Scan ~/.hermes/dashboard-themes/*.yaml for user-created themes.

    Returns a list of fully-normalised theme definitions ready to ship
    to the frontend, so the client can apply them without a secondary
    round-trip or a built-in stub.
    """
    themes_dir = get_hermes_home() / "dashboard-themes"
    if not themes_dir.is_dir():
        return []
    result = []
    for f in sorted(themes_dir.glob("*.yaml")):
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        normalised = _normalise_theme_definition(data)
        if normalised is not None:
            result.append(normalised)
    return result


@app.get("/api/dashboard/themes")
async def get_dashboard_themes():
    """Return available themes and the currently active one.

    Built-in entries ship name/label/description only (the frontend owns
    their full definitions in `web/src/themes/presets.ts`).  User themes
    from `~/.hermes/dashboard-themes/*.yaml` ship with their full
    normalised definition under `definition`, so the client can apply
    them without a stub.
    """
    config = load_config()
    active = cfg_get(config, "dashboard", "theme", default="default")
    user_themes = _discover_user_themes()
    seen = set()
    themes = []
    for t in _BUILTIN_DASHBOARD_THEMES:
        seen.add(t["name"])
        themes.append(t)
    for t in user_themes:
        if t["name"] in seen:
            continue
        themes.append({
            "name": t["name"],
            "label": t["label"],
            "description": t["description"],
            "definition": t,
        })
        seen.add(t["name"])
    return {"themes": themes, "active": active}


class ThemeSetBody(BaseModel):
    name: str


@app.put("/api/dashboard/theme")
async def set_dashboard_theme(body: ThemeSetBody):
    """Set the active dashboard theme (persists to config.yaml)."""
    config = load_config()
    if "dashboard" not in config:
        config["dashboard"] = {}
    config["dashboard"]["theme"] = body.name
    save_config(config)
    return {"ok": True, "theme": body.name}


# ---------------------------------------------------------------------------
# Dashboard plugin system
# ---------------------------------------------------------------------------

def _discover_dashboard_plugins() -> list:
    """Scan plugins/*/dashboard/manifest.json for dashboard extensions.

    Checks three plugin sources (same as hermes_cli.plugins):
    1. User plugins:    ~/.hermes/plugins/<name>/dashboard/manifest.json
    2. Bundled plugins: <repo>/plugins/<name>/dashboard/manifest.json  (memory/, etc.)
    3. Project plugins: ./.hermes/plugins/  (only if HERMES_ENABLE_PROJECT_PLUGINS)
    """
    plugins = []
    seen_names: set = set()

    from hermes_cli.plugins import get_bundled_plugins_dir
    bundled_root = get_bundled_plugins_dir()
    search_dirs = [
        (get_hermes_home() / "plugins", "user"),
        (bundled_root / "memory", "bundled"),
        (bundled_root, "bundled"),
    ]
    if os.environ.get("HERMES_ENABLE_PROJECT_PLUGINS"):
        search_dirs.append((Path.cwd() / ".hermes" / "plugins", "project"))

    for plugins_root, source in search_dirs:
        if not plugins_root.is_dir():
            continue
        for child in sorted(plugins_root.iterdir()):
            if not child.is_dir():
                continue
            manifest_file = child / "dashboard" / "manifest.json"
            if not manifest_file.exists():
                continue
            try:
                data = json.loads(manifest_file.read_text(encoding="utf-8"))
                name = data.get("name", child.name)
                if name in seen_names:
                    continue
                seen_names.add(name)
                # Tab options: ``path`` + ``position`` for a new tab, optional
                # ``override`` to replace a built-in route, and ``hidden`` to
                # register the plugin component/slots without adding a tab
                # (useful for slot-only plugins like a header-crest injector).
                raw_tab = data.get("tab", {}) if isinstance(data.get("tab"), dict) else {}
                entry = data.get("entry", "dist/index.js")
                if source == "bundled" and entry and not (child / "dashboard" / str(entry)).is_file():
                    _log.warning(
                        "Skipping dashboard plugin %s: missing entry %s",
                        name,
                        entry,
                    )
                    continue
                tab_info = {
                    "path": raw_tab.get("path", f"/{name}"),
                    "position": raw_tab.get("position", "end"),
                }
                override_path = raw_tab.get("override")
                if isinstance(override_path, str) and override_path.startswith("/"):
                    tab_info["override"] = override_path
                if bool(raw_tab.get("hidden")):
                    tab_info["hidden"] = True
                # Slots: list of named slot locations this plugin populates.
                # The frontend exposes ``registerSlot(pluginName, slotName, Component)``
                # on window; plugins with non-empty slots call it from their JS bundle.
                slots_src = data.get("slots")
                slots: List[str] = []
                if isinstance(slots_src, list):
                    slots = [s for s in slots_src if isinstance(s, str) and s]
                plugins.append({
                    "name": name,
                    "label": data.get("label", name),
                    "description": data.get("description", ""),
                    "icon": data.get("icon", "Puzzle"),
                    "version": data.get("version", "0.0.0"),
                    "tab": tab_info,
                    "slots": slots,
                    "entry": entry,
                    "css": data.get("css"),
                    "has_api": bool(data.get("api")),
                    "source": source,
                    "_dir": str(child / "dashboard"),
                    "_api_file": data.get("api"),
                })
            except Exception as exc:
                _log.warning("Bad dashboard plugin manifest %s: %s", manifest_file, exc)
                continue
    return plugins


# Cache discovered plugins per-process (refresh on explicit re-scan).
_dashboard_plugins_cache: Optional[list] = None


def _get_dashboard_plugins(force_rescan: bool = False) -> list:
    global _dashboard_plugins_cache
    if _dashboard_plugins_cache is None or force_rescan:
        _dashboard_plugins_cache = _discover_dashboard_plugins()
    elif _dashboard_plugins_cache:
        if any(not Path(p["_dir"]).is_dir() for p in _dashboard_plugins_cache):
            _dashboard_plugins_cache = _discover_dashboard_plugins()
    return _dashboard_plugins_cache


@app.get("/api/dashboard/plugins")
async def get_dashboard_plugins():
    """Return discovered dashboard plugins (excludes user-hidden ones)."""
    plugins = _get_dashboard_plugins()
    # Read user's hidden plugins list from config.
    config = load_config()
    hidden: list = cfg_get(config, "dashboard", "hidden_plugins", default=[]) or []
    # Strip internal fields before sending to frontend and filter out hidden.
    return [
        {k: v for k, v in p.items() if not k.startswith("_")}
        for p in plugins
        if p["name"] not in hidden
    ]


@app.get("/api/dashboard/plugins/rescan")
async def rescan_dashboard_plugins():
    """Force re-scan of dashboard plugins."""
    plugins = _get_dashboard_plugins(force_rescan=True)
    return {"ok": True, "count": len(plugins)}


class _AgentPluginInstallBody(BaseModel):
    identifier: str
    force: bool = False
    enable: bool = True


def _strip_dashboard_manifest(p: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def _merged_plugins_hub() -> Dict[str, Any]:
    """Agent discovery + dashboard manifests + optional provider picker metadata."""
    from hermes_cli.plugins_cmd import (
        _discover_all_plugins,
        _get_current_context_engine,
        _get_current_memory_provider,
        _discover_context_engines,
        _discover_memory_providers,
        _get_disabled_set,
        _get_enabled_set,
        _read_manifest as _read_plugin_manifest_at,
    )

    dashboard_list = _get_dashboard_plugins()
    dash_by_name = {str(p["name"]): p for p in dashboard_list}

    disabled_set = _get_disabled_set()
    enabled_set = _get_enabled_set()

    # Read user-hidden plugins from config for the user_hidden field.
    config = load_config()
    hidden_plugins: list = cfg_get(config, "dashboard", "hidden_plugins", default=[]) or []

    plugins_root_resolved = (get_hermes_home() / "plugins").resolve()
    rows: List[Dict[str, Any]] = []

    for name, version, description, source, dir_str in _discover_all_plugins():
        if name in disabled_set:
            runtime_status = "disabled"
        elif name in enabled_set:
            runtime_status = "enabled"
        else:
            runtime_status = "inactive"

        dir_path = Path(dir_str)
        dm = dash_by_name.get(name)
        has_dash_manifest = dm is not None or (dir_path / "dashboard" / "manifest.json").exists()

        under_user_tree = False
        try:
            dir_path.resolve().relative_to(plugins_root_resolved)
            under_user_tree = True
        except ValueError:
            pass

        can_remove_update = (
            source in {"user", "git"} and under_user_tree and Path(dir_str).is_dir()
        )

        # Check if this plugin provides tools that require auth
        auth_required = False
        auth_command = ""
        manifest_data = _read_plugin_manifest_at(dir_path)
        provides_tools = manifest_data.get("provides_tools") or []
        if provides_tools:
            try:
                from tools.registry import registry
                for tname in provides_tools:
                    entry = registry.get_entry(tname)
                    if entry and entry.check_fn and not entry.check_fn():
                        auth_required = True
                        auth_command = f"hermes auth {name}"
                        break
            except Exception:
                pass

        rows.append({
            "name": name,
            "version": version or "",
            "description": description or "",
            "source": source,
            "runtime_status": runtime_status,
            "has_dashboard_manifest": has_dash_manifest,
            "dashboard_manifest": _strip_dashboard_manifest(dm) if dm else None,
            "path": dir_str,
            "can_remove": can_remove_update,
            "can_update_git": can_remove_update and (Path(dir_str) / ".git").exists(),
            "auth_required": auth_required,
            "auth_command": auth_command,
            "user_hidden": name in hidden_plugins,
        })

    agent_names = {r["name"] for r in rows}
    orphan_dashboard = [
        _strip_dashboard_manifest(p)
        for p in dashboard_list
        if str(p["name"]) not in agent_names
    ]

    memory_providers: List[Dict[str, str]] = []
    try:
        for n, desc in _discover_memory_providers():
            memory_providers.append({"name": n, "description": desc})
    except Exception:
        memory_providers = []

    context_engines: List[Dict[str, str]] = []
    try:
        for n, desc in _discover_context_engines():
            context_engines.append({"name": n, "description": desc})
    except Exception:
        context_engines = []

    return {
        "plugins": rows,
        "orphan_dashboard_plugins": orphan_dashboard,
        "providers": {
            "memory_provider": _get_current_memory_provider() or "",
            "memory_options": memory_providers,
            "context_engine": _get_current_context_engine(),
            "context_options": context_engines,
        },
    }


@app.get("/api/dashboard/plugins/hub")
async def get_plugins_hub(request: Request):
    """Unified agent plugins + dashboard extension metadata (session protected)."""
    _require_token(request)
    try:
        return _merged_plugins_hub()
    except Exception as exc:
        _log.warning("plugins/hub failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to build plugins hub.") from exc


@app.post("/api/dashboard/agent-plugins/install")
async def post_agent_plugin_install(request: Request, body: _AgentPluginInstallBody):
    _require_token(request)
    from hermes_cli.plugins_cmd import dashboard_install_plugin

    result = dashboard_install_plugin(
        body.identifier.strip(),
        force=body.force,
        enable=body.enable,
    )
    if not result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=result.get("error") or "Install failed.",
        )
    _get_dashboard_plugins(force_rescan=True)
    # Strip internal paths from the response
    result.pop("after_install_path", None)
    return result


def _validate_plugin_name(name: str) -> str:
    """Reject path-traversal attempts in plugin name URL parameters."""
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid plugin name.")
    return name


@app.post("/api/dashboard/agent-plugins/{name}/enable")
async def post_agent_plugin_enable(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled

    result = dashboard_set_agent_plugin_enabled(name, enabled=True)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Enable failed.")
    return result


@app.post("/api/dashboard/agent-plugins/{name}/disable")
async def post_agent_plugin_disable(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled

    result = dashboard_set_agent_plugin_enabled(name, enabled=False)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Disable failed.")
    return result


@app.post("/api/dashboard/agent-plugins/{name}/update")
async def post_agent_plugin_update(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from hermes_cli.plugins_cmd import dashboard_update_user_plugin

    result = dashboard_update_user_plugin(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Update failed.")
    _get_dashboard_plugins(force_rescan=True)
    return result


@app.delete("/api/dashboard/agent-plugins/{name}")
async def delete_agent_plugin(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from hermes_cli.plugins_cmd import dashboard_remove_user_plugin

    result = dashboard_remove_user_plugin(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Remove failed.")
    _get_dashboard_plugins(force_rescan=True)
    return result


class _PluginProvidersPutBody(BaseModel):
    memory_provider: Optional[str] = None
    context_engine: Optional[str] = None


@app.put("/api/dashboard/plugin-providers")
async def put_plugin_providers(request: Request, body: _PluginProvidersPutBody):
    """Persist memory provider / context engine selection (writes config.yaml)."""
    _require_token(request)
    from hermes_cli.plugins_cmd import (
        _save_context_engine,
        _save_memory_provider,
    )

    if body.memory_provider is not None:
        _save_memory_provider(body.memory_provider)
    if body.context_engine is not None:
        _save_context_engine(body.context_engine)
    return {"ok": True}


class _PluginVisibilityBody(BaseModel):
    hidden: bool


@app.post("/api/dashboard/plugins/{name}/visibility")
async def post_plugin_visibility(request: Request, name: str, body: _PluginVisibilityBody):
    """Toggle a plugin's sidebar visibility (persists to config.yaml dashboard.hidden_plugins)."""
    _require_token(request)
    name = _validate_plugin_name(name)

    config = load_config()
    if "dashboard" not in config or not isinstance(config.get("dashboard"), dict):
        config["dashboard"] = {}
    hidden_list: list = config["dashboard"].get("hidden_plugins") or []
    if not isinstance(hidden_list, list):
        hidden_list = []

    if body.hidden and name not in hidden_list:
        hidden_list.append(name)
    elif not body.hidden and name in hidden_list:
        hidden_list.remove(name)

    config["dashboard"]["hidden_plugins"] = hidden_list
    save_config(config)
    return {"ok": True, "name": name, "hidden": body.hidden}


# ---------------------------------------------------------------------------
# Hermes Knowledge product APIs
# ---------------------------------------------------------------------------

_KNOWLEDGE_CARD_KINDS = ("viewpoint", "method", "fact", "risk")


class _KnowledgeDraftRevisionBody(BaseModel):
    instruction: str


class _KnowledgeCaptureRevisionBody(BaseModel):
    instruction: str


class _KnowledgeEditableCaptureDraftBody(BaseModel):
    content: str
    source: str = ""
    source_type: str = "manual"
    instruction: str = ""
    title: str = ""
    title_source: str = ""
    folder_path: str = ""
    organize: bool = True
    summary: str | None = None
    tags: list[str] | None = None
    folder_suggestion: dict[str, Any] | None = None
    card_suggestion: dict[str, Any] | None = None
    existing_folders: list[str] = []


class _KnowledgeCaptureUpdateBody(BaseModel):
    body: str = ""
    title: str = ""
    folder_path: str | None = None


class _KnowledgeAnswerDraftBody(BaseModel):
    hermes_session_id: str = ""
    user_message: str = ""
    assistant_answer: str
    instruction: str = ""
    output_type: str = "auto"
    assistant_message_id: str = ""
    sources: list[dict[str, Any]] = []
    target_capture_id: str = ""
    answer_source: str = "auto"


class _KnowledgeGardenDraftBody(BaseModel):
    capture_ids: list[str] = []
    title: str = ""
    card_kind: str = ""
    instruction: str = ""


class _KnowledgeLibraryCreateBody(BaseModel):
    title: str = ""
    body: str = ""
    folder_path: str = "Inbox"
    source: str = "Hermes Knowledge Library"
    source_type: str = "manual"


class _KnowledgeLibraryFolderCreateBody(BaseModel):
    name: str


class _KnowledgeLibraryFolderUpdateBody(BaseModel):
    name: str


class _KnowledgeLibraryUpdateBody(BaseModel):
    title: str = ""
    body: str | None = None
    folder_path: str | None = None
    summary: str | None = None
    tags: list[str] | None = None
    folder_suggestion: dict[str, Any] | None = None
    card_suggestion: dict[str, Any] | None = None


class _KnowledgeLibrarySelectionChatBody(BaseModel):
    question: str
    selected_text: str = ""
    surrounding_before: str = ""
    surrounding_after: str = ""
    heading_path: list[str] = []
    selection_start: int | None = None
    selection_end: int | None = None
    selection_confidence: str = "none"
    mode: str = "local_web"
    history: list[dict[str, str]] = Field(default_factory=list)
    history_summary: str = ""
    history_summary_version: int = 0
    history_overflow: list[dict[str, str]] = Field(default_factory=list)
    force_web: bool = False


def _knowledge_custom_root() -> Path:
    """Return the validated Hermes Knowledge checkout, or fail closed."""
    from integrations.hermes_knowledge import KnowledgeUnavailable, configured_root, validate_root

    root = configured_root()
    if root is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "feature_disabled",
                "message": (
                    "Hermes Knowledge is not configured. Set HERMES_KNOWLEDGE_URL "
                    "(HTTP mode) or HERMES_KNOWLEDGE_LOCAL_ROOT (local checkout) "
                    "and restart the dashboard."
                ),
            },
        )
    try:
        return validate_root(root)
    except KnowledgeUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "feature_disabled", "message": str(exc)},
        ) from exc


def _knowledge_custom_import_failure_detail(
    label: str,
    module_name: str,
    exc: ModuleNotFoundError,
    root: Path,
) -> dict[str, Any]:
    missing_name = str(getattr(exc, "name", "") or "").strip()
    requested_parts = {part for part in module_name.split(".") if part}
    if missing_name and missing_name not in requested_parts:
        reason = "missing_dependency"
        message = (
            f"{label} cannot be imported because dashboard Python is missing "
            f"dependency '{missing_name}'."
        )
    else:
        reason = "missing_bridge_module"
        message = f"{label} module '{module_name}' was not found under HERMES_CUSTOM_ROOT."

    requirements_path = root / "requirements.txt"
    install_command = (
        f"{sys.executable} -m pip install -r {requirements_path}"
        if requirements_path.exists()
        else f"{sys.executable} -m pip install {missing_name or module_name}"
    )
    return {
        "message": message,
        "reason": reason,
        "module": module_name,
        "missing_module": missing_name,
        "custom_root": str(root),
        "python": sys.executable,
        "install_command": install_command,
    }


def _knowledge_custom_module(module_name: str, label: str):
    root = _knowledge_custom_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        detail = _knowledge_custom_import_failure_detail(label, module_name, exc, root)
        _log.warning("%s import failed: %s", label, detail)
        raise HTTPException(status_code=503, detail=detail) from exc
    except Exception as exc:
        _log.exception("%s import failed", label)
        raise HTTPException(status_code=500, detail=f"{label} unavailable: {exc}") from exc


def _knowledge_ai_cancel_module():
    return _knowledge_custom_module("bridge.ai_cancel", "AI operation cancellation")


def _normalize_ai_operation_id(operation_id: str | None) -> str:
    text = str(operation_id or "").strip()
    if not text:
        return ""
    return "".join(ch for ch in text if ch.isalnum() or ch in "-_:")[:120]


def _knowledge_ai_operation_id(request: Request) -> str:
    return _normalize_ai_operation_id(request.headers.get(_AI_OPERATION_HEADER_NAME, ""))


async def _run_cancellable_ai_operation(
    request: Request,
    label: str,
    operation: Callable[[], Any],
) -> Any:
    operation_id = _knowledge_ai_operation_id(request)
    if not operation_id:
        return await asyncio.to_thread(operation)

    cancel_module = _knowledge_ai_cancel_module()
    operation_context = getattr(cancel_module, "operation_context")
    raise_if_cancelled = getattr(cancel_module, "raise_if_cancelled")
    cancelled_type = getattr(cancel_module, "AIOperationCancelled")

    def execute() -> Any:
        with operation_context(operation_id):
            raise_if_cancelled(f"{label}.start")
            return operation()

    try:
        return await asyncio.to_thread(execute)
    except cancelled_type as exc:
        return {
            "ok": False,
            "status": "cancelled",
            "cancelled": True,
            "USER_VISIBLE_REPLY": "已停止。",
            "chat_preview": "已停止。",
            "meta": {
                "operation_id": getattr(exc, "operation_id", operation_id),
                "cancelled_stage": getattr(exc, "stage", ""),
            },
        }


@app.post("/api/knowledge/ai-operations/{operation_id}/cancel")
async def post_knowledge_ai_operation_cancel(request: Request, operation_id: str):
    _require_token(request)
    cancel_module = _knowledge_ai_cancel_module()
    cancelled = getattr(cancel_module, "cancel_operation")(operation_id)
    normalized = _normalize_ai_operation_id(operation_id)
    return {"ok": bool(cancelled), "operation_id": normalized, "status": "cancel_requested"}


def _knowledge_db_path() -> Path:
    return Path(
        os.environ.get(
            "HERMES_KNOWLEDGE_DB",
            str(_knowledge_custom_root() / "data" / "captures.db"),
        )
    ).expanduser()


def _knowledge_vault_path() -> Path:
    config_path = _knowledge_custom_root() / "config.yaml"
    if config_path.exists():
        try:
            cfg = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            vault = cfg.get("vault") if isinstance(cfg, dict) else {}
            if isinstance(vault, dict) and vault.get("path"):
                return Path(str(vault["path"])).expanduser()
        except Exception:
            _log.warning("Failed to read Hermes Knowledge config at %s", config_path)
    return Path("~/Hermes/knowledge").expanduser()


def _knowledge_conn() -> sqlite3.Connection:
    db_path = _knowledge_db_path()
    if not db_path.exists():
        raise HTTPException(status_code=404, detail=f"Knowledge DB not found: {db_path}")
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _knowledge_graph_conn() -> sqlite3.Connection:
    schema_module = _knowledge_custom_module("db.schema", "Knowledge schema")
    return schema_module.init_db(str(_knowledge_db_path()))


@app.get("/api/knowledge/runtime-check")
async def get_knowledge_runtime_check(request: Request):
    _require_token(request)
    modules = [
        ("bridge.capture_bridge", "Capture bridge"),
        ("bridge.answer_bridge", "Answer bridge"),
        ("bridge.research_bridge", "Research bridge"),
        ("bridge.reading_bridge", "Reading bridge"),
    ]
    checks: list[dict[str, Any]] = []
    ok = True
    for module_name, label in modules:
        try:
            _knowledge_custom_module(module_name, label)
            checks.append({"module": module_name, "label": label, "ok": True})
        except HTTPException as exc:
            ok = False
            checks.append(
                {
                    "module": module_name,
                    "label": label,
                    "ok": False,
                    "status_code": exc.status_code,
                    "detail": exc.detail,
                }
            )
    return {
        "ok": ok,
        "custom_root": str(_knowledge_custom_root()),
        "python": sys.executable,
        "checks": checks,
    }


def _json_value(text: str, fallback):
    try:
        value = json.loads(text or "")
    except (json.JSONDecodeError, TypeError):
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def _knowledge_normalized_card_payload(data: dict) -> dict:
    root = _knowledge_custom_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    try:
        from agents.garden_card_payload import normalize_garden_payload, parse_payload_json
    except Exception:
        return {}
    return normalize_garden_payload(
        parse_payload_json(str(data.get("payload_json") or "{}")),
        legacy=data,
    )


def _clip_text(text: str, limit: int = 360) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _knowledge_read_note(vault_path: Path, file_path: str) -> tuple[dict, str] | None:
    if not file_path:
        return None
    try:
        # Same containment rule as the other knowledge paths: resolve under the
        # vault, reject absolute/'..' escapes and symlinks out of the vault.
        path = _knowledge_local_file_path(vault_path, file_path)
    except HTTPException:
        return None
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                frontmatter = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                frontmatter = {}
            return frontmatter, parts[2].strip()
    return {}, text


_KNOWLEDGE_DEFAULT_FOLDERS = ["Inbox", "AI 产品", "数据 Agent", "待读", "临时"]
_KNOWLEDGE_OPEN_DRAFT_STATUSES = {
    "raw_extracted",
    "draft_ready",
    "revision_requested",
    "draft_incomplete",
}


def _knowledge_folder(value: Any) -> str:
    folder = str(value or "").strip()
    return folder or "Inbox"


def _knowledge_folder_store_path() -> Path:
    return _knowledge_custom_root() / "data" / "knowledge_folders.json"


def _knowledge_stored_folders() -> list[str]:
    path = _knowledge_folder_store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, dict):
        data = data.get("folders", [])
    if not isinstance(data, list):
        return []
    folders = []
    for item in data:
        folder = _knowledge_folder(item)
        if folder not in folders:
            folders.append(folder)
    return folders


def _knowledge_hidden_folders() -> list[str]:
    path = _knowledge_folder_store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict):
        return []
    hidden = []
    for item in data.get("hidden", []):
        folder = _knowledge_folder(item)
        if folder not in hidden:
            hidden.append(folder)
    return hidden


def _knowledge_visible_folder_paths() -> list[str]:
    hidden_folders = set(_knowledge_hidden_folders())
    folders: list[str] = []
    for folder in _KNOWLEDGE_DEFAULT_FOLDERS:
        if folder not in hidden_folders and folder not in folders:
            folders.append(folder)
    for folder in _knowledge_stored_folders():
        if folder not in hidden_folders and folder not in folders:
            folders.append(folder)
    return folders or ["Inbox"]


def _knowledge_write_folder_store(folders: list[str], hidden: list[str] | None = None) -> None:
    clean_folders: list[str] = []
    for item in folders:
        folder = _knowledge_folder(item)
        if folder not in clean_folders:
            clean_folders.append(folder)
    clean_hidden: list[str] = []
    for item in hidden or []:
        folder = _knowledge_folder(item)
        if folder not in clean_hidden:
            clean_hidden.append(folder)
    path = _knowledge_folder_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if clean_hidden:
        payload: Any = {"folders": clean_folders, "hidden": clean_hidden}
    else:
        payload = clean_folders
    from hermes_cli.file_atomic import atomic_write_text

    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def _knowledge_save_stored_folder(folder: str) -> list[str]:
    folder = _knowledge_folder(folder)
    folders = _knowledge_stored_folders()
    if folder not in folders:
        folders.append(folder)
    hidden = [item for item in _knowledge_hidden_folders() if item != folder]
    _knowledge_write_folder_store(folders, hidden)
    return folders


def _knowledge_rename_stored_folder(old_folder: str, new_folder: str) -> None:
    old_folder = _knowledge_folder(old_folder)
    new_folder = _knowledge_folder(new_folder)
    folders = [
        (new_folder if folder == old_folder else folder)
        for folder in _knowledge_stored_folders()
    ]
    if new_folder not in folders:
        folders.append(new_folder)
    folders = [folder for folder in folders if folder != old_folder]
    hidden = [folder for folder in _knowledge_hidden_folders() if folder != new_folder]
    if old_folder in _KNOWLEDGE_DEFAULT_FOLDERS and old_folder != new_folder and old_folder not in hidden:
        hidden.append(old_folder)
    _knowledge_write_folder_store(folders, hidden)


def _knowledge_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _knowledge_render_markdown(frontmatter: dict, body: str) -> str:
    return (
        "---\n"
        + yaml.dump(frontmatter, allow_unicode=True, sort_keys=False)
        + "---\n\n"
        + (body or "").strip()
        + "\n"
    )


def _knowledge_garden_card_count(conn: sqlite3.Connection | None, capture_id: str) -> int:
    capture_id = (capture_id or "").strip()
    if not conn or not capture_id or not _knowledge_table_exists(conn, "garden_cards"):
        return 0
    rows = conn.execute(
        "SELECT capture_ids FROM garden_cards WHERE capture_ids LIKE ?",
        (f"%{capture_id}%",),
    ).fetchall()
    count = 0
    for row in rows:
        ids = _json_value(str(row["capture_ids"] or "[]"), [])
        if capture_id in {str(item).strip() for item in ids}:
            count += 1
    return count


_KNOWLEDGE_ACTIVE_GARDEN_DRAFT_STATUSES = {"draft_ready", "revision_requested", "open"}


def _knowledge_rows_referencing_capture(
    conn: sqlite3.Connection,
    table: str,
    capture_id: str,
    *,
    include_statuses: set[str] | None = None,
    exclude_statuses: set[str] | None = None,
) -> list[dict[str, str]]:
    if not _knowledge_table_exists(conn, table):
        return []
    rows = conn.execute(
        f"SELECT id, title, status, capture_ids FROM {table} WHERE capture_ids LIKE ?",
        (f"%{capture_id}%",),
    ).fetchall()
    refs: list[dict[str, str]] = []
    for row in rows:
        status = str(row["status"] or "")
        if include_statuses is not None and status not in include_statuses:
            continue
        if exclude_statuses is not None and status in exclude_statuses:
            continue
        ids = _json_value(str(row["capture_ids"] or "[]"), [])
        if capture_id not in {str(item).strip() for item in ids}:
            continue
        refs.append(
            {
                "id": str(row["id"] or ""),
                "title": str(row["title"] or ""),
                "status": status,
            }
        )
    return refs


def _knowledge_capture_backlinks(
    vault_path: Path,
    *,
    capture_id: str,
    file_path: str,
    title: str,
    limit: int = 20,
) -> list[dict[str, str]]:
    targets = {
        value
        for value in (
            capture_id,
            file_path,
            file_path.removesuffix(".md"),
            Path(file_path).stem if file_path else "",
            title,
        )
        if value
    }
    if not targets or not vault_path.exists():
        return []
    backlinks: list[dict[str, str]] = []
    for path in vault_path.rglob("*.md"):
        try:
            rel_path = path.relative_to(vault_path).as_posix()
        except ValueError:
            continue
        if rel_path == file_path or rel_path.startswith("_archive/"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if not any(target in text for target in targets):
            continue
        backlinks.append({"path": rel_path, "title": path.stem})
        if len(backlinks) >= limit:
            break
    return backlinks


def _knowledge_capture_dependency_summary(
    conn: sqlite3.Connection,
    vault_path: Path,
    *,
    capture_id: str,
    file_path: str,
    title: str,
) -> dict[str, Any]:
    garden_cards = _knowledge_rows_referencing_capture(
        conn,
        "garden_cards",
        capture_id,
        exclude_statuses={"archived"},
    )
    garden_drafts = _knowledge_rows_referencing_capture(
        conn,
        "garden_drafts",
        capture_id,
        include_statuses=_KNOWLEDGE_ACTIVE_GARDEN_DRAFT_STATUSES,
    )
    committed_draft_rows = conn.execute(
        "SELECT id, title, status FROM capture_drafts WHERE committed_capture_id = ?",
        (capture_id,),
    ).fetchall()
    committed_drafts = [
        {
            "id": str(row["id"] or ""),
            "title": str(row["title"] or ""),
            "status": str(row["status"] or ""),
        }
        for row in committed_draft_rows
    ]
    event_count = 0
    if _knowledge_table_exists(conn, "agent_run_objects"):
        event_count = int(
            conn.execute(
                "SELECT COUNT(DISTINCT run_id) FROM agent_run_objects WHERE object_id = ?",
                (capture_id,),
            ).fetchone()[0]
            or 0
        )
    backlinks = _knowledge_capture_backlinks(
        vault_path,
        capture_id=capture_id,
        file_path=file_path,
        title=title,
    )
    return {
        "garden_cards": garden_cards,
        "garden_drafts": garden_drafts,
        "committed_drafts": committed_drafts,
        "backlinks": backlinks,
        "event_count": event_count,
        "policy": {
            "action": "archive_capture_only",
            "knowledge_file": "retained",
            "database_row": "retained_with_review_state_archived",
            "garden_cards": "retained",
            "garden_drafts": "retained",
            "committed_drafts": "retained",
            "backlinks": "retained",
        },
    }


def _knowledge_capture_dependency_response(
    conn: sqlite3.Connection,
    vault_path: Path,
    *,
    item_id: str,
) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Library capture not found")
    item = _knowledge_capture_library_item(vault_path, row, conn=conn, full=False)
    dependencies = _knowledge_capture_dependency_summary(
        conn,
        vault_path,
        capture_id=item_id,
        file_path=str(row["file_path"] or ""),
        title=str(item.get("title") or ""),
    )
    return {
        "ok": True,
        "id": item_id,
        "dependencies": dependencies,
    }


def _knowledge_capture_library_item(
    vault_path: Path,
    row: sqlite3.Row,
    *,
    conn: sqlite3.Connection | None = None,
    full: bool = False,
) -> dict:
    data = dict(row)
    file_path = str(data.get("file_path") or "")
    note = _knowledge_read_note(vault_path, file_path)
    frontmatter, body = note if note else ({}, "")
    title = str(frontmatter.get("title") or "").strip() or Path(file_path).stem or str(data.get("id") or "未命名")
    summary = str(frontmatter.get("story") or frontmatter.get("summary") or "").strip()
    capture_id = str(data.get("id") or "")
    indexed = data.get("embedding") is not None
    embedding_columns = _knowledge_table_columns(conn, "capture_embeddings") if conn is not None else set()
    if not indexed and conn is not None and {"capture_id", "kind", "embedding"} <= embedding_columns:
        indexed = conn.execute(
            """SELECT 1 FROM capture_embeddings
               WHERE capture_id = ? AND kind = 'identity'
                 AND embedding IS NOT NULL
               LIMIT 1""",
            (capture_id,),
        ).fetchone() is not None
    item = {
        "id": capture_id,
        "kind": "capture",
        "title": title,
        "summary": summary,
        "preview": _clip_text(summary or body, 360),
        "body": body if full else "",
        "folder_path": _knowledge_folder(frontmatter.get("folder_path") or frontmatter.get("folder")),
        "tags": _knowledge_tags(frontmatter.get("tags")),
        "source": str(frontmatter.get("source") or "").strip(),
        "source_type": str(frontmatter.get("source_type") or "").strip(),
        "status": str(frontmatter.get("status") or data.get("review_state") or "captured"),
        "file_path": file_path,
        "raw_path": str(data.get("raw_path") or ""),
        "word_count": int(frontmatter.get("word_count") or len(body)),
        "created_at": str(data.get("created_at") or ""),
        "updated_at": str(data.get("updated_at") or ""),
        "indexed": indexed,
        "title_source": str(frontmatter.get("title_source") or "").strip(),
        "garden_card_count": _knowledge_garden_card_count(conn, capture_id),
    }
    return item


def _knowledge_draft_library_item(
    row: sqlite3.Row,
    *,
    conn: sqlite3.Connection | None = None,
    full: bool = False,
) -> dict:
    data = dict(row)
    capture_intent = _json_value(str(data.get("capture_intent") or "{}"), {})
    draft_text = str(data.get("draft_text") or "")
    raw_text = str(data.get("raw_text") or "")
    body = draft_text or raw_text
    item = {
        "id": str(data.get("id") or ""),
        "kind": "capture_draft",
        "title": str(data.get("title") or "").strip() or "未命名",
        "summary": str(data.get("summary") or "").strip(),
        "preview": _clip_text(str(data.get("summary") or "") or body, 360),
        "body": body if full else "",
        "folder_path": _knowledge_folder(capture_intent.get("folder_path")),
        "tags": _json_value(str(data.get("tags") or "[]"), []),
        "source": str(data.get("source") or ""),
        "source_type": str(data.get("source_type") or ""),
        "status": str(data.get("status") or ""),
        "file_path": "",
        "raw_path": "",
        "word_count": int(data.get("word_count") or len(body)),
        "created_at": str(data.get("created_at") or ""),
        "updated_at": str(data.get("updated_at") or ""),
        "indexed": False,
        "title_source": str(capture_intent.get("title_source") or "").strip(),
        "committed_capture_id": str(data.get("committed_capture_id") or ""),
        "garden_card_count": _knowledge_garden_card_count(conn, str(data.get("committed_capture_id") or "")),
    }
    return item


def _knowledge_markdown_heading_path(body: str, before_text: str = "") -> list[str]:
    source = before_text if before_text else body
    headings: list[tuple[int, str]] = []
    for line in source.splitlines():
        match = re.match(r"^(#{1,3})\s+(.+?)\s*$", line.strip())
        if not match:
            continue
        level = len(match.group(1))
        text = match.group(2).strip()
        headings = [(old_level, old_text) for old_level, old_text in headings if old_level < level]
        headings.append((level, text))
    return [text for _, text in headings[-3:]]


def _knowledge_markdown_outline(body: str, *, limit: int = 20) -> str:
    lines = []
    for line in body.splitlines():
        stripped = line.strip()
        if not re.match(r"^#{1,3}\s+.+", stripped):
            continue
        lines.append(stripped)
        if len(lines) >= limit:
            break
    return "\n".join(lines)


def _knowledge_question_terms(question: str) -> list[str]:
    terms = re.findall(r"[\w\u4e00-\u9fff]{2,}", question.lower())
    seen: set[str] = set()
    result: list[str] = []
    for term in terms:
        if term in seen:
            continue
        seen.add(term)
        result.append(term)
    return result[:8]


def _knowledge_relevant_article_excerpt(body: str, question: str, *, limit: int = 4200) -> str:
    body = (body or "").strip()
    if len(body) <= limit:
        return body
    terms = _knowledge_question_terms(question)
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", body) if part.strip()]
    scored: list[tuple[int, int, str]] = []
    for index, paragraph in enumerate(paragraphs):
        lowered = paragraph.lower()
        score = sum(1 for term in terms if term and term in lowered)
        if score:
            scored.append((score, -index, paragraph))
    selected = [paragraph for _, _, paragraph in sorted(scored, reverse=True)[:4]]
    if not selected:
        head = body[: int(limit * 0.7)]
        tail = body[-int(limit * 0.25):]
        return f"{head}\n\n...\n\n{tail}"
    excerpt = "\n\n...\n\n".join(selected)
    if len(excerpt) < limit * 0.6:
        excerpt = f"{body[:1200]}\n\n...\n\n{excerpt}\n\n...\n\n{body[-800:]}"
    return excerpt[:limit]


def _knowledge_research_context_body(body: str) -> str:
    return re.sub(r"^\s*# [^\n]+\n{1,2}", "", body or "", count=1).strip()


def _knowledge_selection_chat_messages(item: dict, body: _KnowledgeLibrarySelectionChatBody) -> list[dict[str, str]]:
    question = body.question.strip()
    selected_text = body.selected_text.strip()
    article_body = str(item.get("body") or "")
    heading_path = [part.strip() for part in (body.heading_path or []) if part.strip()]
    if selected_text and not heading_path:
        before = body.surrounding_before
        if not before and _knowledge_selection_offset_matches(article_body, selected_text, body.selection_start, body.selection_end):
            before = article_body[: body.selection_start or 0]
        heading_path = _knowledge_markdown_heading_path(article_body, before)
    outline = _knowledge_markdown_outline(article_body)
    if selected_text:
        user_context = "\n\n".join(
            part for part in [
                f"文件标题：{item.get('title') or '未命名'}",
                f"状态：{item.get('kind')}",
                f"文件夹：{item.get('folder_path') or 'Inbox'}",
                f"摘要：{item.get('summary') or '无'}",
                f"标签：{', '.join(item.get('tags') or []) or '无'}",
                f"标题路径：{' > '.join(heading_path) if heading_path else '未识别'}",
                f"文章目录：\n{outline}" if outline else "",
                f"选中文本：\n{_clip_text(selected_text, 4000)}",
                f"选区前文：\n{_clip_text(body.surrounding_before, 2200)}" if body.surrounding_before else "",
                f"选区后文：\n{_clip_text(body.surrounding_after, 2200)}" if body.surrounding_after else "",
                f"用户问题：{question}",
            ] if part
        )
    else:
        user_context = "\n\n".join(
            part for part in [
                f"文件标题：{item.get('title') or '未命名'}",
                f"状态：{item.get('kind')}",
                f"文件夹：{item.get('folder_path') or 'Inbox'}",
                f"摘要：{item.get('summary') or '无'}",
                f"标签：{', '.join(item.get('tags') or []) or '无'}",
                f"文章目录：\n{outline}" if outline else "",
                f"文章相关内容：\n{_knowledge_relevant_article_excerpt(article_body, question)}",
                f"用户问题：{question}",
            ] if part
        )
    return [
        {
            "role": "system",
            "content": (
                "你是 Hermes Knowledge 的文章阅读助手。请根据用户问题和提供的结构化上下文回答。"
                "回答必须基于当前文章内容；如果文章没有相关信息，直接说明。"
                "不要修改正文，不要主动生成摘要、标签或知识卡片。保持中文回答，结构清晰，避免空泛。"
            ),
        },
        {"role": "user", "content": user_context},
    ]


def _knowledge_selection_offset_matches(
    article_body: str,
    selected_text: str,
    selection_start: int | None,
    selection_end: int | None,
) -> bool:
    if selection_start is None or selection_end is None:
        return False
    if selection_start < 0 or selection_end < selection_start or selection_end > len(article_body):
        return False
    return article_body[selection_start:selection_end] == selected_text


def _knowledge_call_selection_chat(messages: list[dict[str, str]]) -> str:
    from agent.auxiliary_client import call_llm, extract_content_or_reasoning

    response = call_llm(
        task="knowledge_selection_chat",
        messages=messages,
        temperature=0.2,
        max_tokens=1800,
        timeout=90,
    )
    answer = extract_content_or_reasoning(response).strip()
    if not answer:
        raise RuntimeError("selection chat returned empty answer")
    return answer


def _knowledge_library_items(
    conn: sqlite3.Connection,
    vault_path: Path,
    *,
    folder: str = "",
    view: str = "",
    search: str = "",
    limit: int = 200,
) -> list[dict]:
    rows = conn.execute(
        """SELECT * FROM captures
           WHERE COALESCE(review_state, '') != 'archived'
           ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                    rowid DESC
           LIMIT 10000""",
    ).fetchall()
    draft_rows = conn.execute(
        """SELECT * FROM capture_drafts
           WHERE COALESCE(committed_capture_id, '') = ''
             AND COALESCE(status, '') NOT IN ('abandoned', 'discarded')
           ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                    rowid DESC
           LIMIT 10000""",
    ).fetchall()
    items = [
        *[_knowledge_capture_library_item(vault_path, row, conn=conn) for row in rows],
        *[_knowledge_draft_library_item(row, conn=conn) for row in draft_rows],
    ]
    folder = folder.strip()
    view = view.strip()
    search_text = search.strip().lower()
    if folder:
        items = [item for item in items if item.get("folder_path") == folder]
    if view == "recent":
        pass
    elif view == "review":
        items = [
            item for item in items
            if item["kind"] == "capture_draft" and item["status"] in _KNOWLEDGE_OPEN_DRAFT_STATUSES
        ]
    elif view == "suggestions":
        items = [
            item for item in items
            if item["kind"] == "capture_draft" or item.get("title_source") == "ai"
        ]
    elif view == "unindexed":
        items = [item for item in items if not item.get("indexed")]
    if search_text:
        items = [
            item for item in items
            if search_text in "\n".join(
                str(item.get(key, ""))
                for key in ("title", "summary", "preview", "source", "source_type")
            ).lower()
        ]
    items.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
    return items[: max(1, min(limit, 500))]


def _hydrate_committed_draft_from_capture(
    result: dict[str, Any],
    *,
    conn: sqlite3.Connection | None,
    vault_path: Path | None,
) -> dict[str, Any]:
    capture_id = str(result.get("committed_capture_id") or "").strip()
    if not capture_id or conn is None or vault_path is None:
        return result
    capture = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
    if capture is None:
        return result
    capture_data = dict(capture)
    note = _knowledge_read_note(vault_path, str(capture_data.get("file_path") or ""))
    if note is None:
        result["capture_note_missing"] = True
        return result

    frontmatter, body = note
    historical_draft_text = str(result.get("draft_text") or "")
    title = str(frontmatter.get("title") or result.get("title") or "未命名").strip()
    result.update(
        {
            "title": title,
            "draft_text": body,
            "draft_preview": _clip_text(body, 420),
            "historical_draft_text": historical_draft_text,
            "file_path": str(capture_data.get("file_path") or ""),
            "raw_path": str(capture_data.get("raw_path") or ""),
            "word_count": int(frontmatter.get("word_count") or len(body)),
        }
    )
    raw_note = _knowledge_read_note(vault_path, str(capture_data.get("raw_path") or ""))
    if raw_note is not None:
        _raw_frontmatter, raw_body = raw_note
        result["raw_text"] = raw_body
        result["raw_preview"] = _clip_text(raw_body, 260)
    return result


def _draft_row(
    row: sqlite3.Row,
    *,
    conn: sqlite3.Connection | None = None,
    vault_path: Path | None = None,
    full: bool = False,
) -> dict:
    data = dict(row)
    capture_intent = _json_value(str(data.get("capture_intent") or "{}"), {})
    draft_text = str(data.get("draft_text") or "")
    raw_text = str(data.get("raw_text") or "")
    body = draft_text or raw_text
    result = {
        "id": data.get("id", ""),
        "title": data.get("title", "") or "未命名",
        "status": data.get("status", ""),
        "source": data.get("source", ""),
        "source_type": data.get("source_type", ""),
        "word_count": data.get("word_count", 0),
        "instruction": data.get("instruction", ""),
        "summary": data.get("summary", ""),
        "tags": _json_value(str(data.get("tags") or "[]"), []),
        "capture_intent": capture_intent,
        "user_intent": capture_intent.get("material_intent")
        or ("full_text" if capture_intent.get("output_shape") == ["full_text"] else ""),
        "committed_capture_id": data.get("committed_capture_id", ""),
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
        "draft_preview": _clip_text(body, 420),
        "raw_preview": _clip_text(raw_text, 260),
    }
    if full:
        result["draft_text"] = draft_text
        result["raw_text"] = raw_text
        if str(data.get("status") or "") == "committed":
            result = _hydrate_committed_draft_from_capture(result, conn=conn, vault_path=vault_path)
    return result


def _reading_draft_needs_capture_lookup(data: dict, meta: dict) -> bool:
    meta_capture_id = meta.get("capture_id")
    return (
        not str(data.get("target_capture_id") or "").strip()
        and not (isinstance(meta_capture_id, str) and meta_capture_id.strip())
        and data.get("status") == "committed"
        and data.get("output_type") in {"local_learning_note", "discussion_note"}
    )


def _reading_draft_capture_ids(
    conn: sqlite3.Connection,
    vault_path: Path,
    draft_ids: set[str],
) -> dict[str, str]:
    if not draft_ids:
        return {}
    resolved: dict[str, str] = {}
    rows = conn.execute(
        """SELECT id, file_path FROM captures
           WHERE file_path != ''
           ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                    rowid DESC""",
    ).fetchall()
    for row in rows:
        if len(resolved) >= len(draft_ids):
            break
        capture_id = str(row["id"] or "").strip()
        note = _knowledge_read_note(vault_path, str(row["file_path"] or ""))
        if not note:
            continue
        frontmatter, _ = note
        draft_id = str(frontmatter.get("reading_draft_id") or "").strip()
        if draft_id in draft_ids:
            resolved[draft_id] = str(frontmatter.get("id") or capture_id).strip()
    return resolved


def _reading_draft_row(
    row: sqlite3.Row,
    *,
    resolved_capture_ids: dict[str, str] | None = None,
    full: bool = False,
) -> dict:
    data = dict(row)
    meta = _json_value(str(data.get("meta_json") or "{}"), {})
    target_capture_id = str(data.get("target_capture_id") or "").strip()
    if _reading_draft_needs_capture_lookup(data, meta):
        target_capture_id = (resolved_capture_ids or {}).get(str(data.get("id") or ""), "")
        if target_capture_id:
            meta = {
                **meta,
                "capture_id": target_capture_id,
                "capture_id_source": "vault_frontmatter",
            }
    result = {
        "id": data.get("id", ""),
        "session_id": data.get("session_id", ""),
        "output_type": data.get("output_type", ""),
        "target_capture_id": target_capture_id,
        "title": data.get("title", "") or "未命名",
        "summary": data.get("summary", ""),
        "status": data.get("status", ""),
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
        "draft_preview": _clip_text(str(data.get("draft_text") or ""), 420),
        "meta": meta,
    }
    if full:
        result["draft_text"] = str(data.get("draft_text") or "")
    return result


def _knowledge_related_object_ids(
    conn: sqlite3.Connection,
    vault_path: Path,
    object_type: str,
    object_id: str,
) -> list[str]:
    object_id = (object_id or "").strip()
    if not object_id:
        return []
    ids = [object_id]
    if object_type == "reading_draft":
        row = conn.execute(
            "SELECT * FROM reading_drafts WHERE id = ?",
            (object_id,),
        ).fetchone()
        if row:
            data = dict(row)
            meta = _json_value(str(data.get("meta_json") or "{}"), {})
            target_capture_id = str(data.get("target_capture_id") or "").strip()
            if not target_capture_id and _reading_draft_needs_capture_lookup(data, meta):
                target_capture_id = _reading_draft_capture_ids(conn, vault_path, {object_id}).get(object_id, "")
            ids.extend([
                target_capture_id,
                str(meta.get("capture_id") or "").strip(),
            ])
    elif object_type == "capture_draft":
        row = conn.execute(
            "SELECT id, committed_capture_id FROM capture_drafts WHERE id = ?",
            (object_id,),
        ).fetchone()
        if row:
            ids.append(str(row["committed_capture_id"] or "").strip())
    elif object_type == "capture":
        rows = conn.execute(
            "SELECT id FROM capture_drafts WHERE committed_capture_id = ?",
            (object_id,),
        ).fetchall()
        ids.extend(str(row["id"] or "").strip() for row in rows)
    elif object_type == "garden_draft":
        row = conn.execute(
            "SELECT capture_ids FROM garden_drafts WHERE id = ?",
            (object_id,),
        ).fetchone()
        if row:
            ids.extend(str(item).strip() for item in _json_value(str(row["capture_ids"] or "[]"), []))
    elif object_type == "garden_card":
        row = conn.execute(
            "SELECT capture_ids FROM garden_cards WHERE id = ?",
            (object_id,),
        ).fetchone()
        if row:
            ids.extend(str(item).strip() for item in _json_value(str(row["capture_ids"] or "[]"), []))
    capture_ids = [value for value in ids if value]
    for capture_id in capture_ids:
        pattern = f"%{capture_id}%"
        draft_rows = conn.execute(
            "SELECT id FROM garden_drafts WHERE capture_ids LIKE ?",
            (pattern,),
        ).fetchall()
        ids.extend(str(row["id"] or "").strip() for row in draft_rows)
        card_rows = conn.execute(
            "SELECT id FROM garden_cards WHERE capture_ids LIKE ?",
            (pattern,),
        ).fetchall()
        ids.extend(str(row["id"] or "").strip() for row in card_rows)
    seen = set()
    result = []
    for value in ids:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _knowledge_object_allowed_agents(object_type: str) -> set[str] | None:
    return {
        "reading_draft": {"reading", "garden"},
        "capture_draft": {"capture", "garden"},
        "capture": {"capture", "garden"},
        "garden_draft": {"garden"},
        "garden_card": {"garden"},
    }.get(object_type)


def _knowledge_object_event_allowed(object_type: str, row: sqlite3.Row) -> bool:
    agent = str(row["agent"] or "").strip()
    allowed_agents = _knowledge_object_allowed_agents(object_type)
    if not allowed_agents:
        return True
    return agent in allowed_agents


def _knowledge_table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _knowledge_table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _knowledge_table_exists(conn, table):
        return set()
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _knowledge_run_event_row(row: sqlite3.Row) -> dict:
    data = dict(row)
    warnings = _json_value(str(data.get("warnings_json") or "[]"), [])
    errors = _json_value(str(data.get("errors_json") or "[]"), [])
    output = _json_value(str(data.get("output_json") or "{}"), {})
    evidence = _json_value(str(data.get("evidence_json") or "{}"), {})
    return {
        "id": data.get("id", ""),
        "agent": data.get("agent", ""),
        "intent": data.get("intent", ""),
        "trigger": data.get("trigger", ""),
        "status": data.get("status", ""),
        "input": _json_value(str(data.get("input_json") or "{}"), {}),
        "output": output,
        "evidence": evidence,
        "warnings": warnings,
        "errors": errors,
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
        "completed_at": data.get("completed_at", ""),
    }


@app.get("/api/knowledge/library/folders")
async def get_knowledge_library_folders(request: Request):
    _require_token(request)
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        items = _knowledge_library_items(conn, vault_path, limit=500)
    configured_folders = _knowledge_visible_folder_paths()
    counts: dict[str, int] = {folder: 0 for folder in configured_folders}
    for item in items:
        folder = _knowledge_folder(item.get("folder_path"))
        counts[folder] = counts.get(folder, 0) + 1
    folders = [
        {"path": folder, "name": folder, "count": counts.get(folder, 0)}
        for folder in configured_folders
    ]
    extra = sorted(folder for folder in counts if folder not in configured_folders)
    folders.extend({"path": folder, "name": folder, "count": counts[folder]} for folder in extra)
    smart_views = [
        {"key": "recent", "label": "最近入库", "count": len(items)},
        {
            "key": "review",
            "label": "待审阅",
            "count": sum(
                1
                for item in items
                if item["kind"] == "capture_draft" and item["status"] in _KNOWLEDGE_OPEN_DRAFT_STATUSES
            ),
        },
        {
            "key": "suggestions",
            "label": "有 AI 建议",
            "count": sum(
                1
                for item in items
                if item["kind"] == "capture_draft" or item.get("title_source") == "ai"
            ),
        },
        {
            "key": "unindexed",
            "label": "尚未检索",
            "count": sum(1 for item in items if not item.get("indexed")),
        },
    ]
    return {"folders": folders, "smart_views": smart_views}


@app.post("/api/knowledge/library/folders")
async def post_knowledge_library_folder(
    request: Request,
    body: _KnowledgeLibraryFolderCreateBody,
):
    _require_token(request)
    folder = _knowledge_folder(body.name)
    if len(folder) > 80:
        raise HTTPException(status_code=400, detail="folder name is too long")
    _knowledge_save_stored_folder(folder)
    return {"ok": True, "folder": {"path": folder, "name": folder, "count": 0}}


@app.patch("/api/knowledge/library/folders/{folder_path:path}")
async def patch_knowledge_library_folder(
    request: Request,
    folder_path: str,
    body: _KnowledgeLibraryFolderUpdateBody,
):
    _require_token(request)
    old_folder = _knowledge_folder(folder_path)
    new_folder = _knowledge_folder(body.name)
    if not new_folder:
        raise HTTPException(status_code=400, detail="folder name is required")
    if len(new_folder) > 80:
        raise HTTPException(status_code=400, detail="folder name is too long")
    if old_folder == "Inbox":
        raise HTTPException(status_code=400, detail="Inbox cannot be renamed")
    if old_folder == new_folder:
        return {"ok": True, "folder": {"path": new_folder, "name": new_folder, "count": 0}, "updated_items": 0}

    vault_path = _knowledge_vault_path()
    write_service_module = _knowledge_custom_module("bridge.knowledge_write_service", "Knowledge write service")
    KnowledgeWriteService = write_service_module.KnowledgeWriteService
    MarkdownWriteRequest = write_service_module.MarkdownWriteRequest

    updated_items = 0
    with _knowledge_conn() as conn:
        draft_rows = conn.execute(
            """SELECT * FROM capture_drafts
               WHERE COALESCE(committed_capture_id, '') = ''
                 AND COALESCE(status, '') NOT IN ('abandoned', 'discarded')"""
        ).fetchall()
        for row in draft_rows:
            data = dict(row)
            capture_intent = _json_value(str(data.get("capture_intent") or "{}"), {})
            if _knowledge_folder(capture_intent.get("folder_path")) != old_folder:
                continue
            capture_intent["folder_path"] = new_folder
            conn.execute(
                "UPDATE capture_drafts SET capture_intent = ?, updated_at = datetime('now') WHERE id = ?",
                (json.dumps(capture_intent, ensure_ascii=False), str(data.get("id") or "")),
            )
            updated_items += 1

        write_service = KnowledgeWriteService(vault_path)
        capture_rows = conn.execute(
            "SELECT * FROM captures WHERE COALESCE(review_state, '') != 'archived'"
        ).fetchall()
        for row in capture_rows:
            data = dict(row)
            file_path = str(data.get("file_path") or "")
            note = _knowledge_read_note(vault_path, file_path)
            if not note:
                continue
            frontmatter, current_body = note
            if _knowledge_folder(frontmatter.get("folder_path") or frontmatter.get("folder")) != old_folder:
                continue
            frontmatter["folder_path"] = new_folder
            write_service.write_markdown_artifact(
                MarkdownWriteRequest(
                    kind="capture_note",
                    relative_path=file_path,
                    content=_knowledge_render_markdown(frontmatter, current_body),
                    db_object_id=str(data.get("id") or ""),
                    db_table="captures",
                    requires_backup=True,
                )
            )
            conn.execute(
                "UPDATE captures SET updated_at = datetime('now') WHERE id = ?",
                (str(data.get("id") or ""),),
            )
            updated_items += 1
        conn.commit()

    _knowledge_rename_stored_folder(old_folder, new_folder)
    return {
        "ok": True,
        "folder": {"path": new_folder, "name": new_folder, "count": updated_items},
        "updated_items": updated_items,
    }


@app.get("/api/knowledge/library/items")
async def get_knowledge_library_items(
    request: Request,
    folder: str = "",
    view: str = "",
    search: str = "",
    limit: int = 200,
):
    _require_token(request)
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        items = _knowledge_library_items(
            conn,
            vault_path,
            folder=folder,
            view=view,
            search=search,
            limit=limit,
        )
    return {"items": items, "total": len(items)}


@app.get("/api/knowledge/library/items/{kind}/{item_id}")
async def get_knowledge_library_item(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        if kind == "capture":
            row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library capture not found")
            return {"item": _knowledge_capture_library_item(vault_path, row, conn=conn, full=True)}
        if kind == "capture_draft":
            row = conn.execute("SELECT * FROM capture_drafts WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library draft not found")
            return {"item": _knowledge_draft_library_item(row, conn=conn, full=True)}
    raise HTTPException(status_code=400, detail="Unsupported library item kind")


@app.get("/api/knowledge/library/items/{kind}/{item_id}/dependencies")
async def get_knowledge_library_item_dependencies(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()
    if kind != "capture":
        return {
            "ok": True,
            "id": item_id,
            "dependencies": {
                "garden_cards": [],
                "garden_drafts": [],
                "committed_drafts": [],
                "backlinks": [],
                "event_count": 0,
                "policy": {
                    "action": "delete_draft_only",
                    "database_row": "removed_or_marked_discarded_by_capture_bridge",
                },
            },
        }
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        return _knowledge_capture_dependency_response(conn, vault_path, item_id=item_id)


def _knowledge_library_selection_item(kind: str, item_id: str) -> dict[str, Any]:
    kind = (kind or "").strip()
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        if kind == "capture":
            row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library capture not found")
            if str(row["review_state"] or "") == "archived":
                raise HTTPException(status_code=409, detail="Library capture is archived")
            return _knowledge_capture_library_item(vault_path, row, conn=conn, full=True)
        if kind == "capture_draft":
            row = conn.execute("SELECT * FROM capture_drafts WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library draft not found")
            return _knowledge_draft_library_item(row, conn=conn, full=True)
    raise HTTPException(status_code=400, detail="Unsupported library item kind")


def _knowledge_library_selection_research_kwargs(
    kind: str,
    item_id: str,
    body: _KnowledgeLibrarySelectionChatBody,
) -> dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    _validate_selection_search_length(body.selected_text)
    kind = (kind or "").strip()
    item = _knowledge_library_selection_item(kind, item_id)
    return {
        "query": question,
        "mode": body.mode,
        "article_context": {
            "kind": kind,
            "id": item_id,
            "title": item.get("title") or "",
            "body": _knowledge_research_context_body(item.get("body") or item.get("preview") or ""),
            "folder_path": item.get("folder_path") or "Inbox",
            "summary": item.get("summary") or "",
            "tags": item.get("tags") or [],
            "file_path": item.get("file_path") or "",
        },
        "selection_context": {
            "selected_text": body.selected_text,
            "surrounding_before": body.surrounding_before,
            "surrounding_after": body.surrounding_after,
            "heading_path": body.heading_path,
            "selection_start": body.selection_start,
            "selection_end": body.selection_end,
            "selection_confidence": body.selection_confidence,
        },
        "history": body.history,
        "history_summary": body.history_summary,
        "history_summary_version": body.history_summary_version,
        "history_overflow": body.history_overflow,
        "force_web": body.force_web,
    }


def _validate_selection_search_length(selected_text: str) -> None:
    if len((selected_text or "").strip()) > MAX_SELECTION_SEARCH_CHARS:
        raise HTTPException(
            status_code=400,
            detail="选区超过 1000 字，当前不支持基于超长选区检索。请缩短选区后再试。",
        )


def _knowledge_file_url(vault_path: Path, file_path: str) -> str:
    from integrations.hermes_knowledge.sources import file_url

    return file_url(vault_path, file_path)


def _knowledge_local_file_path(vault_path: Path, file_path: str) -> Path:
    if not file_path:
        raise HTTPException(status_code=400, detail="capture file path is empty")
    rel_path = Path(file_path)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        raise HTTPException(status_code=400, detail="capture file path is outside Knowledge storage")
    root = vault_path.expanduser().resolve()
    target = (root / rel_path).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="capture file path is outside Knowledge storage")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="capture note file not found")
    return target


def _open_local_file(target: Path) -> None:
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    if sys.platform.startswith("win"):
        # os.startfile avoids cmd.exe parsing: a file name containing '&' or
        # '^' could break out of ``cmd /c start`` and run a command.
        os.startfile(str(target))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        cmd = ["open", str(target)]
    elif sys.platform.startswith("linux"):
        cmd = ["xdg-open", str(target)]
    else:
        raise HTTPException(status_code=400, detail="local open is not supported on this platform")
    subprocess.Popen(cmd, shell=False)


@app.post("/api/knowledge/library/items/{kind}/{item_id}/open-local")
async def post_knowledge_library_item_open_local(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()
    if kind != "capture":
        raise HTTPException(status_code=400, detail="Only committed capture files can be opened locally")
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute("SELECT file_path FROM captures WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Library capture not found")
        target = _knowledge_local_file_path(vault_path, str(row["file_path"] or ""))
    _open_local_file(target)
    return {"ok": True, "path": str(target)}


def _knowledge_source_open_url(kind: str, item_id: str) -> str:
    from integrations.hermes_knowledge.sources import source_open_url

    return source_open_url(kind, item_id)


def _enrich_knowledge_source(
    conn: sqlite3.Connection,
    vault_path: Path,
    source: dict[str, Any],
) -> dict[str, Any]:
    enriched = dict(source)
    enriched["type"] = enriched.get("type") or "knowledge"
    source_id = str(enriched.get("id") or "").strip()
    source_path = str(enriched.get("file_path") or enriched.get("path") or "").strip()
    row = None
    if source_id:
        row = conn.execute("SELECT id, file_path FROM captures WHERE id = ?", (source_id,)).fetchone()
    if row is None and source_path:
        row = conn.execute(
            "SELECT id, file_path FROM captures WHERE file_path = ? OR raw_path = ?",
            (source_path, source_path),
        ).fetchone()
    if row is None and source_id and len(source_id) >= 6:
        rows = conn.execute(
            "SELECT id, file_path FROM captures WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2",
            (f"{source_id}%",),
        ).fetchall()
        if len(rows) == 1:
            row = rows[0]
    if row is not None:
        item_id = str(row["id"] or "")
        file_path = str(row["file_path"] or source_path)
        enriched.update(
            {
                "item_kind": "capture",
                "item_id": item_id,
                "file_path": file_path,
                "path": source_path or file_path,
                "open_url": _knowledge_source_open_url("capture", item_id),
            }
        )
        if file_path:
            enriched["file_url"] = _knowledge_file_url(vault_path, file_path)
        return enriched

    if source_id:
        draft = conn.execute("SELECT id FROM capture_drafts WHERE id = ?", (source_id,)).fetchone()
        if draft is not None:
            item_id = str(draft["id"] or "")
            enriched.update(
                {
                    "item_kind": "capture_draft",
                    "item_id": item_id,
                    "open_url": _knowledge_source_open_url("capture_draft", item_id),
                }
            )
    return enriched


def _enrich_knowledge_sources(sources: Any) -> list[dict[str, Any]]:
    if not isinstance(sources, list):
        return []
    vault_path = _knowledge_vault_path()
    try:
        with _knowledge_conn() as conn:
            return [
                _enrich_knowledge_source(conn, vault_path, source)
                for source in sources
                if isinstance(source, dict)
            ]
    except Exception:
        _log.exception("failed to enrich knowledge sources")
        return [dict(source) for source in sources if isinstance(source, dict)]


def _knowledge_selection_chat_sources(result: dict[str, Any], meta: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    knowledge_sources: list[dict[str, Any]] = []
    web_sources: list[dict[str, Any]] = []
    for source in _iter_selection_chat_sources(meta.get("knowledge_sources")):
        knowledge_sources = _merge_selection_chat_source(knowledge_sources, source)
    for source in _iter_selection_chat_sources(meta.get("web_sources")):
        web_sources = _merge_selection_chat_source(web_sources, source)
    for source in _iter_selection_chat_sources(result.get("source_map")):
        if _is_selection_chat_knowledge_source(source):
            knowledge_sources = _merge_selection_chat_source(knowledge_sources, source)
        elif _is_selection_chat_web_source(source):
            web_sources = _merge_selection_chat_source(web_sources, source)
    return {
        "knowledge": _enrich_knowledge_sources(knowledge_sources),
        "web": web_sources,
    }


def _iter_selection_chat_sources(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(source) for source in value if isinstance(source, dict)]


def _merge_selection_chat_source(sources: list[dict[str, Any]], source: dict[str, Any]) -> list[dict[str, Any]]:
    key = _selection_chat_source_key(source)
    if not key:
        return [*sources, source]
    merged = list(sources)
    for index, existing in enumerate(merged):
        if _selection_chat_source_key(existing) == key:
            merged[index] = {**existing, **source}
            return merged
    merged.append(source)
    return merged


def _selection_chat_source_key(source: dict[str, Any]) -> str:
    for field in ("ref", "item_id", "id", "file_path", "path", "url", "title"):
        value = str(source.get(field) or "").strip()
        if value:
            return f"{field}:{value}"
    return ""


def _is_selection_chat_knowledge_source(source: dict[str, Any]) -> bool:
    source_type = str(source.get("type") or "").strip().lower()
    ref = str(source.get("ref") or "").strip().upper()
    return bool(
        source.get("item_kind")
        or source.get("item_id")
        or source.get("file_path")
        or source.get("path")
        or source_type in {"knowledge", "capture", "capture_note", "capture_section", "capture_draft"}
        or ref.startswith("K")
        or ref.isdigit()
    )


def _is_selection_chat_web_source(source: dict[str, Any]) -> bool:
    source_type = str(source.get("type") or "").strip().lower()
    ref = str(source.get("ref") or "").strip().upper()
    return bool(source.get("url") or source_type == "web" or ref.startswith("W"))


def _knowledge_library_selection_chat_response(
    result: dict[str, Any],
    body: _KnowledgeLibrarySelectionChatBody,
) -> dict[str, Any]:
    selected_text = body.selected_text.strip()
    citations = []
    if selected_text:
        citations.append({"label": "当前选区", "excerpt": _clip_text(selected_text, 220)})
    meta = result.get("meta") if isinstance(result, dict) else {}
    if not isinstance(meta, dict):
        meta = {}
    sources = _knowledge_selection_chat_sources(result, meta)
    return {
        "ok": True,
        "answer": result.get("chat_preview") or meta.get("answer") or "",
        "used_selection": bool(selected_text),
        "citations": citations,
        "mode": meta.get("mode") or body.mode,
        "plan": meta.get("research_plan") if isinstance(meta.get("research_plan"), dict) else {},
        "plan_status": meta.get("plan_status") or "",
        "sources": sources,
        "warnings": result.get("warnings") if isinstance(result.get("warnings"), list) else [],
        "meta": {
            "web_queries": meta.get("web_queries") if isinstance(meta.get("web_queries"), list) else [],
            "query_intent": meta.get("query_intent") or "",
            "search_quality": meta.get("search_quality") if isinstance(meta.get("search_quality"), dict) else {},
            "rewritten_web_queries": meta.get("rewritten_web_queries") if isinstance(meta.get("rewritten_web_queries"), list) else [],
            "provider_status": meta.get("provider_status") if isinstance(meta.get("provider_status"), dict) else {},
            "research_trace": meta.get("research_trace") if isinstance(meta.get("research_trace"), dict) else {},
            "reasoning_trace": meta.get("reasoning_trace") if isinstance(meta.get("reasoning_trace"), dict) else {},
            "web_search_attempted": bool(meta.get("web_search_attempted")),
            "updated_history_summary": meta.get("updated_history_summary") if isinstance(meta.get("updated_history_summary"), str) else "",
            "updated_history_summary_version": meta.get("updated_history_summary_version") or 0,
            "history_summary_failed": bool(meta.get("history_summary_failed")),
            "history_summary_error": meta.get("history_summary_error") or "",
        },
    }


def _sse_json(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


@app.post("/api/knowledge/library/items/{kind}/{item_id}/selection-chat")
async def post_knowledge_library_item_selection_chat(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibrarySelectionChatBody,
):
    _require_token(request)
    research_kwargs = _knowledge_library_selection_research_kwargs(kind, item_id, body)
    try:
        research_bridge = _knowledge_custom_module("bridge.research_bridge", "Research bridge")
        async_answer = getattr(research_bridge, "async_web_assist_answer", None)
        if callable(async_answer):
            result = await async_answer(**research_kwargs)
        else:
            sync_answer = getattr(research_bridge, "web_assist_answer", None)
            if not callable(sync_answer):
                raise HTTPException(status_code=503, detail="Web assist answer is unavailable")
            result = sync_answer(**research_kwargs)
    except HTTPException:
        raise
    except Exception as exc:
        _log.exception("knowledge selection chat failed")
        raise HTTPException(status_code=502, detail=f"Selection chat failed: {exc}") from exc
    return _knowledge_library_selection_chat_response(result, body)


@app.post("/api/knowledge/library/items/{kind}/{item_id}/selection-chat/stream")
async def post_knowledge_library_item_selection_chat_stream(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibrarySelectionChatBody,
):
    _require_token(request)

    async def event_stream():
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def on_event(event: dict[str, Any]) -> None:
            if event.get("type") == "summary_updated":
                await queue.put({"event": "summary_updated", **event})
            else:
                await queue.put({"event": "progress", **event})

        async def run_research() -> None:
            try:
                async def execute_research() -> dict[str, Any]:
                    research_kwargs = _knowledge_library_selection_research_kwargs(kind, item_id, body)
                    research_bridge = _knowledge_custom_module("bridge.research_bridge", "Research bridge")
                    async_answer = getattr(research_bridge, "async_web_assist_answer", None)
                    if callable(async_answer):
                        return await async_answer(**research_kwargs, event_callback=on_event)
                    sync_answer = getattr(research_bridge, "web_assist_answer", None)
                    if not callable(sync_answer):
                        raise HTTPException(status_code=503, detail="Web assist answer is unavailable")
                    return await asyncio.to_thread(sync_answer, **research_kwargs)

                result = await asyncio.wait_for(
                    execute_research(),
                    timeout=max(1.0, float(KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS)),
                )
                await queue.put({"event": "complete", "response": _knowledge_library_selection_chat_response(result, body)})
            except asyncio.TimeoutError:
                await queue.put({"event": "error", "message": "Selection chat stream 超时，请稍后重试或切换为当前文章模式。"})
            except HTTPException as exc:
                await queue.put({"event": "error", "message": exc.detail})
            except Exception as exc:
                _log.exception("knowledge selection chat stream failed")
                await queue.put({"event": "error", "message": f"Selection chat failed: {exc}"})

        task = asyncio.create_task(run_research())
        yield _sse_json({"event": "start", "mode": body.mode})
        try:
            while True:
                if await request.is_disconnected():
                    task.cancel()
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                yield _sse_json(event)
                if event.get("event") in {"complete", "error"}:
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/knowledge/library/items")
async def post_knowledge_library_item(request: Request, body: _KnowledgeLibraryCreateBody):
    _require_token(request)
    content = (body.body or "").strip()
    title = (body.title or "").strip()
    if not content and not title:
        raise HTTPException(status_code=400, detail="title or body is required")
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    create_editable_capture_draft = capture_bridge.create_editable_capture_draft
    result = create_editable_capture_draft(
        content=content or title,
        source=body.source,
        source_type=body.source_type,
        instruction="自由编辑后入库到知识库",
        title=title,
        folder_path=_knowledge_folder(body.folder_path),
        existing_folders=_knowledge_visible_folder_paths(),
    )
    draft_id = str((result.get("meta") or {}).get("draft_id") or result.get("draft_id") or "").strip()
    if not draft_id:
        durable = result.get("durable_artifacts") if isinstance(result.get("durable_artifacts"), list) else []
        for artifact in durable:
            if isinstance(artifact, dict) and artifact.get("type") == "capture_draft":
                draft_id = str(artifact.get("id") or "").strip()
                break
    if draft_id:
        with _knowledge_conn() as conn:
            row = conn.execute("SELECT * FROM capture_drafts WHERE id = ?", (draft_id,)).fetchone()
            if row:
                return {"ok": True, "item": _knowledge_draft_library_item(row, conn=conn, full=True), "result": result}
    return {"ok": True, "result": result}


@app.patch("/api/knowledge/library/items/{kind}/{item_id}")
async def patch_knowledge_library_item(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibraryUpdateBody,
):
    _require_token(request)
    kind = (kind or "").strip()
    folder_path = _knowledge_folder(body.folder_path) if body.folder_path is not None else None
    if kind == "capture_draft":
        with _knowledge_conn() as conn:
            row = conn.execute("SELECT * FROM capture_drafts WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library draft not found")
            data = dict(row)
            capture_intent = _json_value(str(data.get("capture_intent") or "{}"), {})
            if folder_path is not None:
                capture_intent["folder_path"] = folder_path
            if body.folder_suggestion is not None:
                capture_intent["folder_suggestion"] = body.folder_suggestion
            if body.card_suggestion is not None:
                capture_intent["card_suggestion"] = body.card_suggestion
            title = body.title.strip() if body.title.strip() else str(data.get("title") or "")
            draft_text = body.body if body.body is not None else str(data.get("draft_text") or data.get("raw_text") or "")
            summary = body.summary if body.summary is not None else str(data.get("summary") or "")
            tags = body.tags if body.tags is not None else _json_value(str(data.get("tags") or "[]"), [])
            conn.execute(
                """UPDATE capture_drafts
                   SET title = ?, draft_text = ?, word_count = ?, summary = ?, tags = ?, capture_intent = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (
                    title,
                    draft_text,
                    len(draft_text or ""),
                    summary,
                    json.dumps(tags or [], ensure_ascii=False),
                    json.dumps(capture_intent, ensure_ascii=False),
                    item_id,
                ),
            )
            conn.commit()
            refreshed = conn.execute("SELECT * FROM capture_drafts WHERE id = ?", (item_id,)).fetchone()
            return {"ok": True, "item": _knowledge_draft_library_item(refreshed, conn=conn, full=True)}
    if kind == "capture":
        vault_path = _knowledge_vault_path()
        write_service_module = _knowledge_custom_module("bridge.knowledge_write_service", "Knowledge write service")
        KnowledgeWriteService = write_service_module.KnowledgeWriteService
        MarkdownWriteRequest = write_service_module.MarkdownWriteRequest
        with _knowledge_conn() as conn:
            row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Library capture not found")
            file_path = str(row["file_path"] or "")
            note = _knowledge_read_note(vault_path, file_path)
            if not note:
                raise HTTPException(status_code=404, detail="capture note file not found")
            frontmatter, current_body = note
            updated_body = body.body if body.body is not None else current_body
            if body.title.strip():
                frontmatter["title"] = body.title.strip()
                frontmatter["title_source"] = "user"
            if folder_path is not None:
                frontmatter["folder_path"] = folder_path
            frontmatter["word_count"] = len(updated_body or "")
            write_result = KnowledgeWriteService(vault_path).write_markdown_artifact(
                MarkdownWriteRequest(
                    kind="capture_note",
                    relative_path=file_path,
                    content=_knowledge_render_markdown(frontmatter, updated_body),
                    db_object_id=item_id,
                    db_table="captures",
                    requires_backup=True,
                )
            )
            conn.execute(
                "UPDATE captures SET updated_at = datetime('now') WHERE id = ?",
                (item_id,),
            )
            conn.commit()
            refreshed = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
            return {
                "ok": True,
                "backup_path": write_result.backup_path,
                "item": _knowledge_capture_library_item(vault_path, refreshed, conn=conn, full=True),
            }
    raise HTTPException(status_code=400, detail="Unsupported library item kind")


def _knowledge_dependencies_block_permanent_delete(dependencies: dict[str, Any]) -> bool:
    return any(
        [
            bool(dependencies.get("garden_cards")),
            bool(dependencies.get("garden_drafts")),
            bool(dependencies.get("backlinks")),
        ]
    )


def _knowledge_unlink_storage_file(vault_path: Path, file_path: str) -> str:
    file_path = str(file_path or "").strip()
    if not file_path:
        return ""
    rel_path = Path(file_path)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        raise HTTPException(status_code=400, detail="capture file path is outside Knowledge storage")
    root = vault_path.expanduser().resolve()
    target = (root / rel_path).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="capture file path is outside Knowledge storage")
    if not target.exists():
        return ""
    if not target.is_file():
        raise HTTPException(status_code=400, detail="capture file path is not a file")
    target.unlink()
    return rel_path.as_posix()


_KNOWLEDGE_DELETABLE_TABLES = frozenset(
    {
        "capture_embeddings",
        "capture_metadata",
        "agent_run_objects",
        "capture_version_backups",
        "captures",
        "review_items",
    }
)


def _knowledge_delete_by_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    value: str,
) -> int:
    if table not in _KNOWLEDGE_DELETABLE_TABLES:
        raise ValueError(f"table is not deletable through this helper: {table}")
    columns = _knowledge_table_columns(conn, table)
    if column not in columns:
        return 0
    cursor = conn.execute(f"DELETE FROM {table} WHERE {column} = ?", (value,))
    return int(cursor.rowcount or 0)


def _knowledge_unlink_committed_capture_drafts(conn: sqlite3.Connection, capture_id: str) -> int:
    columns = _knowledge_table_columns(conn, "capture_drafts")
    if "committed_capture_id" not in columns:
        return 0
    if "status" in columns:
        updated_at_set = ", updated_at = datetime('now')" if "updated_at" in columns else ""
        cursor = conn.execute(
            f"""UPDATE capture_drafts
                SET committed_capture_id = '', status = 'abandoned'{updated_at_set}
                WHERE committed_capture_id = ?""",
            (capture_id,),
        )
    else:
        cursor = conn.execute(
            "UPDATE capture_drafts SET committed_capture_id = '' WHERE committed_capture_id = ?",
            (capture_id,),
        )
    return int(cursor.rowcount or 0)


def _knowledge_delete_capture_review_items(conn: sqlite3.Connection, capture_id: str) -> int:
    columns = _knowledge_table_columns(conn, "review_items")
    if not columns:
        return 0
    if {"capture_id", "object_type", "object_id"}.issubset(columns):
        cursor = conn.execute(
            """DELETE FROM review_items
               WHERE capture_id = ?
                  OR (object_type = 'capture' AND object_id = ?)""",
            (capture_id, capture_id),
        )
        return int(cursor.rowcount or 0)
    return _knowledge_delete_by_column(conn, "review_items", "capture_id", capture_id)


def _new_capture_agent():
    capture_agent_module = _knowledge_custom_module("agents.capture_agent", "Capture agent")
    CaptureAgent = capture_agent_module.CaptureAgent
    load_capture_config = capture_agent_module.load_config
    return CaptureAgent(load_capture_config(str(_knowledge_custom_root() / "config.yaml")))


def _knowledge_revision_llm_text(result: Any) -> str:
    text = getattr(result, "text", result)
    return str(text or "").strip()


def _knowledge_capture_revision_prompt(
    *,
    instruction: str,
    title: str,
    current_body: str,
    raw_body: str,
) -> str:
    raw_section = raw_body.strip() or "（没有单独 raw 来源材料；以当前笔记为准。）"
    return f"""你是 Hermes Knowledge 的入库笔记修订助手。

用户要修改的笔记标题：{title or "未命名"}

用户修改指令：
{instruction}

硬性要求：
1. 只输出修订后的 Markdown 正文，不要输出解释、前言或代码块。
2. 除非用户明确要求总结、压缩、删除或只保留部分内容，否则不得删减信息、不得改变原文观点、不得丢失例子。
3. 可以改善标题层级、段落、列表、空行和表达清晰度。
4. 当前笔记是要被修订的正文；原始来源材料只用于校验和补回遗漏信息。

当前笔记正文：
{current_body}

原始来源材料：
{raw_section}
"""


@app.post("/api/knowledge/captures/{capture_id}/revise")
async def post_knowledge_capture_revise(
    request: Request,
    capture_id: str,
    body: _KnowledgeCaptureRevisionBody,
):
    _require_token(request)
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction cannot be empty")

    markdown_writer = _knowledge_custom_module("agents.markdown_writer", "Markdown writer")
    repo_module = _knowledge_custom_module("db.repo", "Capture repository")
    read_note = markdown_writer.read_note
    CaptureRepo = repo_module.CaptureRepo

    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        repo = CaptureRepo(conn)
        item = repo.get_by_id(capture_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Capture not found")
        file_path = str(item.get("file_path") or "")
        if not file_path:
            raise HTTPException(status_code=400, detail="capture has no editable note")
        note = read_note(vault_path, file_path)
        if note is None:
            raise HTTPException(status_code=404, detail="capture note file not found")
        frontmatter, current_body = note
        raw_note = read_note(vault_path, str(item.get("raw_path") or ""))
        _raw_frontmatter, raw_body = raw_note if raw_note is not None else ({}, "")

    title = str(frontmatter.get("title") or "").strip()
    prompt = _knowledge_capture_revision_prompt(
        instruction=instruction,
        title=title,
        current_body=current_body,
        raw_body=raw_body,
    )
    agent = _new_capture_agent()
    llm_result = await asyncio.to_thread(agent._call_llm, prompt)
    revised_body = _knowledge_revision_llm_text(llm_result)
    if getattr(llm_result, "incomplete", False):
        raise HTTPException(status_code=502, detail="AI revision output was incomplete")
    if not revised_body:
        raise HTTPException(status_code=502, detail="AI revision output was empty")

    summary_result = await asyncio.to_thread(agent.summarizer.summarize, revised_body, [])
    return {
        "ok": True,
        "capture_id": capture_id,
        "title": str(summary_result.get("title") or title or "").strip(),
        "body": revised_body,
        "summary": str(summary_result.get("summary") or "").strip(),
        "tags": summary_result.get("tags", []),
        "source": "ai_revision",
    }


def _knowledge_dependency_worker(db_path: Path, vault_path: Path, item_id: str) -> dict[str, Any]:
    """Run the vault-wide dependency scan off the event loop."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        return _knowledge_capture_dependency_response(conn, vault_path, item_id=item_id)
    finally:
        conn.close()


@app.delete("/api/knowledge/library/items/{kind}/{item_id}/permanent")
async def permanent_delete_knowledge_library_item(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()
    if kind != "capture":
        raise HTTPException(status_code=400, detail="Only committed capture files can be permanently deleted")

    # Prefer the Knowledge Service when it is configured: it owns the vault and
    # the SQLite database, so the runtime must not delete files behind its back.
    from integrations.hermes_knowledge.client import (
        KnowledgeConflict,
        KnowledgeIncompatible,
        KnowledgeNotFound,
        KnowledgeUnavailable,
        get_client,
    )

    try:
        client = get_client()
    except KnowledgeIncompatible as exc:
        # Reachable service, wrong contract: tell the operator to upgrade
        # instead of pretending the service is down (must be caught before
        # KnowledgeUnavailable, its parent class).
        raise HTTPException(
            status_code=503,
            detail={
                "code": "contract_incompatible",
                "message": f"knowledge service contract is incompatible: {exc}",
            },
        ) from exc
    except KnowledgeUnavailable as exc:
        # Bad HERMES_KNOWLEDGE_URL / HERMES_KNOWLEDGE_TIMEOUT is a
        # configuration problem, not a server crash.
        raise HTTPException(
            status_code=503,
            detail=f"knowledge service is not configured correctly: {exc}",
        ) from exc
    if client is not None:
        try:
            issued = client.issue_library_delete_confirmation(kind, item_id)
            # The service has shipped both spellings of the confirmation
            # token; accept either so a rename cannot turn into a 502.
            token = str(issued.get("token") or issued.get("confirmation_token") or "")
            result = client.permanent_delete_library_item(kind, item_id, token)
        except KnowledgeNotFound as exc:
            detail = exc.detail
            if not isinstance(detail, (dict, str)) or not detail:
                detail = "Library capture not found"
            raise HTTPException(status_code=404, detail=detail) from exc
        except KnowledgeConflict as exc:
            # Preserve the service's "still referenced" payload so the UI can
            # show what blocks the delete instead of a generic 502.
            detail = exc.detail
            if not isinstance(detail, dict):
                detail = {"message": str(detail or exc)}
            raise HTTPException(status_code=409, detail=detail) from exc
        except KnowledgeIncompatible as exc:
            # Same mapping as the preflight path; ordered before the parent
            # KnowledgeUnavailable catch below.
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "contract_incompatible",
                    "message": f"knowledge service contract is incompatible: {exc}",
                },
            ) from exc
        except KnowledgeUnavailable as exc:
            raise HTTPException(
                status_code=502,
                detail=f"knowledge service delete failed: {exc}",
            ) from exc
        finally:
            client.close()
        return result

    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Library capture not found")

    # The dependency check walks the whole vault (rglob); keep it off the event
    # loop and open a dedicated connection inside the worker thread.
    dependency_response = await asyncio.to_thread(
        _knowledge_dependency_worker,
        _knowledge_db_path(),
        vault_path,
        item_id,
    )
    dependencies = dependency_response["dependencies"]
    if _knowledge_dependencies_block_permanent_delete(dependencies):
        raise HTTPException(
            status_code=409,
            detail={
                "message": "该文件仍被其他知识对象或文档引用，不能彻底删除；请先解除引用或改用归档。",
                "dependencies": dependencies,
            },
        )

    with _knowledge_conn() as conn:
        row = conn.execute("SELECT * FROM captures WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Library capture not found")
        file_path = str(row["file_path"] or "")
        raw_path = str(row["raw_path"] or "") if "raw_path" in row.keys() else ""

        # Commit the database side FIRST. Unlinking first (the old order) left
        # orphaned rows when the commit failed and destroyed the note with no
        # recovery path. Files that fail to unlink are reported for retry.
        deleted_rows = {
            "capture_embeddings": _knowledge_delete_by_column(conn, "capture_embeddings", "capture_id", item_id),
            "capture_metadata": _knowledge_delete_by_column(conn, "capture_metadata", "capture_id", item_id),
            "review_items": _knowledge_delete_capture_review_items(conn, item_id),
            "capture_drafts_unlinked": _knowledge_unlink_committed_capture_drafts(conn, item_id),
            "agent_run_objects": _knowledge_delete_by_column(conn, "agent_run_objects", "object_id", item_id),
            "capture_version_backups": _knowledge_delete_by_column(conn, "capture_version_backups", "capture_id", item_id),
            "captures": _knowledge_delete_by_column(conn, "captures", "id", item_id),
        }
        conn.commit()

    unlink_warnings: list[str] = []
    deleted_file = ""
    deleted_raw = ""
    try:
        deleted_file = _knowledge_unlink_storage_file(vault_path, file_path)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller below
        unlink_warnings.append(f"knowledge file left in place: {type(exc).__name__}: {exc}")
    if raw_path and raw_path != file_path:
        try:
            deleted_raw = _knowledge_unlink_storage_file(vault_path, raw_path)
        except Exception as exc:  # noqa: BLE001
            unlink_warnings.append(f"raw file left in place: {type(exc).__name__}: {exc}")

    return {
        "ok": True,
        "status": "permanently_deleted",
        "id": item_id,
        "deleted": {
            "knowledge_file": deleted_file,
            "raw_file": deleted_raw,
            "rows": deleted_rows,
        },
        "warnings": unlink_warnings,
        "message": "已彻底删除入库文件及其本地索引记录。",
    }


@app.delete("/api/knowledge/library/items/{kind}/{item_id}")
async def delete_knowledge_library_item(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()
    if kind == "capture_draft":
        capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
        discard_capture_draft = capture_bridge.discard_capture_draft
        return discard_capture_draft(draft_id=item_id)
    if kind == "capture":
        vault_path = _knowledge_vault_path()
        with _knowledge_conn() as conn:
            dependency_response = _knowledge_capture_dependency_response(conn, vault_path, item_id=item_id)
            conn.execute(
                "UPDATE captures SET review_state = 'archived', updated_at = datetime('now') WHERE id = ?",
                (item_id,),
            )
            conn.commit()
        return {
            "ok": True,
            "status": "archived",
            "id": item_id,
            "dependencies": dependency_response["dependencies"],
            "message": "已归档入库文件；源文件、卡片、引用和历史记录已保留。",
        }
    raise HTTPException(status_code=400, detail="Unsupported library item kind")


@app.get("/api/knowledge/capture-drafts")
async def get_knowledge_capture_drafts(request: Request, limit: int = 50):
    _require_token(request)
    with _knowledge_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM capture_drafts
               WHERE COALESCE(status, '') NOT IN ('abandoned', 'discarded')
               ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                        rowid DESC
               LIMIT ?""",
            (max(1, min(limit, 200)),),
        ).fetchall()
    drafts = [_draft_row(row) for row in rows]
    return {
        "drafts": drafts,
        "total": len(drafts),
        "open_count": sum(
            1
            for draft in drafts
            if draft["status"] in {"raw_extracted", "draft_ready", "revision_requested", "draft_incomplete"}
        ),
    }


@app.get("/api/knowledge/capture-drafts/{draft_id}")
async def get_knowledge_capture_draft(request: Request, draft_id: str):
    _require_token(request)
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute(
            "SELECT * FROM capture_drafts WHERE id = ?",
            (draft_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Capture draft not found")
        return {"draft": _draft_row(row, conn=conn, vault_path=vault_path, full=True)}


@app.post("/api/knowledge/capture-drafts/editable")
async def post_knowledge_editable_capture_draft(
    request: Request,
    body: _KnowledgeEditableCaptureDraftBody,
):
    _require_token(request)
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    create_editable_capture_draft = capture_bridge.create_editable_capture_draft
    kwargs = {
        "content": body.content,
        "source": body.source,
        "source_type": body.source_type,
        "instruction": body.instruction,
        "title": body.title,
        "title_source": body.title_source,
        "organize": body.organize,
        "existing_folders": body.existing_folders or _knowledge_visible_folder_paths(),
    }
    if body.folder_path.strip():
        kwargs["folder_path"] = body.folder_path
    return await _run_cancellable_ai_operation(
        request,
        "capture.editable.create",
        lambda: create_editable_capture_draft(**kwargs),
    )


@app.patch("/api/knowledge/capture-drafts/{draft_id}/editable")
async def patch_knowledge_editable_capture_draft(
    request: Request,
    draft_id: str,
    body: _KnowledgeEditableCaptureDraftBody,
):
    _require_token(request)
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    update_editable_capture_draft = capture_bridge.update_editable_capture_draft
    return await _run_cancellable_ai_operation(
        request,
        "capture.editable.update",
        lambda: update_editable_capture_draft(
            draft_id=draft_id,
            content=body.content,
            title=body.title,
            title_source=body.title_source,
            summary=body.summary,
            tags=body.tags,
            folder_path=body.folder_path,
            folder_suggestion=body.folder_suggestion,
            card_suggestion=body.card_suggestion,
            organize=body.organize,
            existing_folders=body.existing_folders or _knowledge_visible_folder_paths(),
        ),
    )


@app.post("/api/knowledge/capture-drafts/{draft_id}/commit")
async def post_knowledge_capture_draft_commit(request: Request, draft_id: str):
    _require_token(request)
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    commit_capture_draft = capture_bridge.commit_capture_draft
    result = await _run_cancellable_ai_operation(
        request,
        "capture.commit",
        lambda: commit_capture_draft(draft_id, confirmation_source="dashboard"),
    )
    return result


@app.post("/api/knowledge/capture-drafts/{draft_id}/revise")
async def post_knowledge_capture_draft_revise(
    request: Request,
    draft_id: str,
    body: _KnowledgeDraftRevisionBody,
):
    _require_token(request)
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    revise_capture_draft = capture_bridge.revise_capture_draft
    result = await _run_cancellable_ai_operation(
        request,
        "capture.revise",
        lambda: revise_capture_draft(draft_id=draft_id, instruction=body.instruction),
    )
    return result


@app.delete("/api/knowledge/capture-drafts/{draft_id}")
async def delete_knowledge_capture_draft(request: Request, draft_id: str):
    _require_token(request)
    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    discard_capture_draft = capture_bridge.discard_capture_draft
    return discard_capture_draft(draft_id=draft_id)


@app.patch("/api/knowledge/captures/{capture_id}")
async def patch_knowledge_capture(
    request: Request,
    capture_id: str,
    body: _KnowledgeCaptureUpdateBody,
):
    _require_token(request)

    # HTTP mode: the Knowledge Service owns the vault and the SQLite row, so
    # the dashboard must not write the Markdown file behind its back.  The
    # service returns the same shape the dashboard already consumes
    # (capture_id/file_path/backup_path/library_postprocess/item).
    from integrations.hermes_knowledge.client import (
        KnowledgeConflict,
        KnowledgeIncompatible,
        KnowledgeInvalid,
        KnowledgeNotFound,
        KnowledgeUnavailable,
        get_client,
    )

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "knowledge_unavailable", "message": str(exc)},
        ) from exc
    if client is not None:
        try:
            return client.update_capture(
                capture_id,
                body=body.body or "",
                title=body.title or "",
                folder_path=body.folder_path,
            )
        except KnowledgeNotFound as exc:
            raise HTTPException(
                status_code=404, detail=exc.detail or "Capture not found"
            ) from exc
        except KnowledgeConflict as exc:
            raise HTTPException(
                status_code=409, detail=exc.detail or str(exc)
            ) from exc
        except KnowledgeInvalid as exc:
            raise HTTPException(
                status_code=422, detail=exc.detail or str(exc)
            ) from exc
        except KnowledgeIncompatible as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "contract_incompatible", "message": str(exc)},
            ) from exc
        except KnowledgeUnavailable as exc:
            raise HTTPException(
                status_code=502,
                detail=f"knowledge service update failed: {exc}",
            ) from exc
        finally:
            client.close()

    markdown_writer = _knowledge_custom_module("agents.markdown_writer", "Markdown writer")
    write_service_module = _knowledge_custom_module("bridge.knowledge_write_service", "Knowledge write service")
    repo_module = _knowledge_custom_module("db.repo", "Capture repository")
    captures_route = _knowledge_custom_module("api.routes.captures", "Capture route helpers")
    read_note = markdown_writer.read_note
    KnowledgeWriteService = write_service_module.KnowledgeWriteService
    MarkdownWriteRequest = write_service_module.MarkdownWriteRequest
    CaptureRepo = repo_module.CaptureRepo
    _hydrate_capture = captures_route._hydrate_capture
    _maintain_capture_after_edit = captures_route._maintain_capture_after_edit
    _render_markdown = captures_route._render_markdown
    _strip_binary = captures_route._strip_binary

    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        repo = CaptureRepo(conn)
        item = repo.get_by_id(capture_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Capture not found")
        file_path = str(item.get("file_path") or "")
        if not file_path:
            raise HTTPException(status_code=400, detail="capture has no editable note")
        note = read_note(vault_path, file_path)
        if note is None:
            raise HTTPException(status_code=404, detail="capture note file not found")

        frontmatter, current_body = note
        updated_body = (body.body if body.body else current_body or "").strip()
        if not updated_body:
            raise HTTPException(status_code=400, detail="body cannot be empty")
        if body.title.strip():
            frontmatter["title"] = body.title.strip()
            frontmatter["title_source"] = "user"
        if body.folder_path is not None:
            frontmatter["folder_path"] = _knowledge_folder(body.folder_path)
        frontmatter["word_count"] = len(updated_body)
        write_result = KnowledgeWriteService(vault_path).write_markdown_artifact(
            MarkdownWriteRequest(
                kind="capture_note",
                relative_path=file_path,
                content=_render_markdown(frontmatter, updated_body),
                db_object_id=capture_id,
                db_table="captures",
                requires_backup=True,
            )
        )
        repo.log_change(
            "capture",
            capture_id,
            "body",
            old_value="",
            new_value="updated via dashboard API",
            source="dashboard",
        )
        library_report = _maintain_capture_after_edit(repo, vault_path, capture_id, None)
        refreshed = repo.get_by_id(capture_id) or item
        return {
            "capture_id": capture_id,
            "file_path": file_path,
            "backup_path": write_result.backup_path,
            "library_postprocess": library_report,
            "item": _strip_binary(_hydrate_capture(vault_path, refreshed)),
        }


@app.post("/api/knowledge/answer-drafts")
async def post_knowledge_answer_draft(request: Request, body: _KnowledgeAnswerDraftBody):
    _require_token(request)
    answer_bridge = _knowledge_custom_module("bridge.answer_bridge", "Answer bridge")
    save_answer_to_knowledge = answer_bridge.save_answer_to_knowledge
    return await _run_cancellable_ai_operation(
        request,
        "answer.create_draft",
        lambda: save_answer_to_knowledge(
            hermes_session_id=body.hermes_session_id,
            user_message=body.user_message,
            assistant_answer=body.assistant_answer,
            instruction=body.instruction,
            output_type=body.output_type,
            assistant_message_id=body.assistant_message_id,
            sources=body.sources,
            target_capture_id=body.target_capture_id,
            answer_source=body.answer_source,
        ),
    )


@app.post("/api/knowledge/garden-drafts")
async def post_knowledge_garden_draft(request: Request, body: _KnowledgeGardenDraftBody):
    _require_token(request)
    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    commit_garden_draft = garden_bridge.commit_garden_draft
    synthesize_garden = garden_bridge.synthesize_garden
    result = await _run_cancellable_ai_operation(
        request,
        "garden.synthesize",
        lambda: synthesize_garden(
            capture_ids=body.capture_ids,
            title=body.title,
            card_kind=body.card_kind,
            instruction=body.instruction,
        ),
    )
    if result.get("status") == "error":
        return result
    artifacts = result.get("durable_artifacts") if isinstance(result.get("durable_artifacts"), list) else []
    if any(isinstance(item, dict) and item.get("type") == "garden_card" for item in artifacts):
        return result
    draft_id = str((result.get("meta") or {}).get("draft_id") or "").strip()
    if not draft_id:
        for item in artifacts:
            if isinstance(item, dict) and item.get("type") == "garden_draft":
                draft_id = str(item.get("id") or "").strip()
                break
    if not draft_id:
        return result
    return await _run_cancellable_ai_operation(
        request,
        "garden.commit",
        lambda: commit_garden_draft(
            draft_id=draft_id,
            confirmation_source="dashboard",
        ),
    )


@app.get("/api/knowledge/reading-drafts")
async def get_knowledge_reading_drafts(request: Request, limit: int = 50):
    _require_token(request)
    with _knowledge_conn() as conn:
        vault_path = _knowledge_vault_path()
        rows = conn.execute(
            """SELECT * FROM reading_drafts
               WHERE COALESCE(status, '') NOT IN ('abandoned', 'discarded')
               ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                        rowid DESC
               LIMIT ?""",
            (max(1, min(limit, 200)),),
        ).fetchall()
        lookup_ids = {
            str(row["id"] or "")
            for row in rows
            if _reading_draft_needs_capture_lookup(
                dict(row),
                _json_value(str(dict(row).get("meta_json") or "{}"), {}),
            )
        }
        resolved_capture_ids = _reading_draft_capture_ids(conn, vault_path, lookup_ids)
        drafts = [_reading_draft_row(row, resolved_capture_ids=resolved_capture_ids) for row in rows]
    return {
        "drafts": drafts,
        "total": len(drafts),
        "open_count": sum(1 for draft in drafts if draft["status"] == "open"),
    }


@app.get("/api/knowledge/reading-drafts/{draft_id}")
async def get_knowledge_reading_draft(request: Request, draft_id: str):
    _require_token(request)
    with _knowledge_conn() as conn:
        vault_path = _knowledge_vault_path()
        row = conn.execute(
            "SELECT * FROM reading_drafts WHERE id = ?",
            (draft_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Reading draft not found")
        data = dict(row)
        lookup_ids = (
            {str(data.get("id") or "")}
            if _reading_draft_needs_capture_lookup(
                data,
                _json_value(str(data.get("meta_json") or "{}"), {}),
            )
            else set()
        )
        resolved_capture_ids = _reading_draft_capture_ids(conn, vault_path, lookup_ids)
        draft = _reading_draft_row(row, resolved_capture_ids=resolved_capture_ids, full=True)
    return {"draft": draft}


@app.get("/api/knowledge/object-events")
async def get_knowledge_object_events(
    request: Request,
    object_type: str,
    object_id: str,
    limit: int = 30,
):
    _require_token(request)
    object_type = (object_type or "").strip()
    object_id = (object_id or "").strip()
    if not object_type or not object_id:
        raise HTTPException(status_code=400, detail="object_type and object_id are required")
    with _knowledge_conn() as conn:
        vault_path = _knowledge_vault_path()
        related_ids = _knowledge_related_object_ids(conn, vault_path, object_type, object_id)
        if not related_ids:
            return {"events": [], "related_ids": [], "total": 0}
        limit_value = max(1, min(limit, 100))
        rows: list[sqlite3.Row] = []
        if _knowledge_table_exists(conn, "agent_run_objects"):
            id_placeholders = ", ".join("?" for _ in related_ids)
            params: list[Any] = list(related_ids)
            agent_clause = ""
            allowed_agents = _knowledge_object_allowed_agents(object_type)
            if allowed_agents:
                placeholders = ", ".join("?" for _ in allowed_agents)
                agent_clause = f" AND ar.agent IN ({placeholders})"
                params.extend(sorted(allowed_agents))
            params.append(limit_value)
            rows = conn.execute(
                f"""SELECT DISTINCT ar.* FROM agent_runs ar
                    JOIN agent_run_objects aro ON aro.run_id = ar.id
                    WHERE aro.object_id IN ({id_placeholders}){agent_clause}
                    ORDER BY datetime(replace(substr(ar.updated_at, 1, 19), 'T', ' ')) DESC,
                             ar.rowid DESC
                    LIMIT ?""",
                params,
            ).fetchall()

        clauses = []
        params: list[Any] = []
        for related_id in related_ids:
            pattern = f"%{related_id}%"
            clauses.append("(input_json LIKE ? OR output_json LIKE ? OR evidence_json LIKE ?)")
            params.extend([pattern, pattern, pattern])
        allowed_agents = _knowledge_object_allowed_agents(object_type)
        agent_clause = ""
        if allowed_agents:
            placeholders = ", ".join("?" for _ in allowed_agents)
            agent_clause = f" AND agent IN ({placeholders})"
            params.extend(sorted(allowed_agents))
        existing_ids = [str(row["id"] or "") for row in rows]
        exclude_clause = ""
        if existing_ids:
            placeholders = ", ".join("?" for _ in existing_ids)
            exclude_clause = f" AND id NOT IN ({placeholders})"
            params.extend(existing_ids)
        params.append(max(0, limit_value - len(rows)) or 1)
        fallback_rows = conn.execute(
            f"""SELECT * FROM agent_runs
                WHERE ({" OR ".join(clauses)}){agent_clause}{exclude_clause}
                ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                         rowid DESC
                LIMIT ?""",
            params,
        ).fetchall()
        rows = [*rows, *fallback_rows][:limit_value]
    events = [
        _knowledge_run_event_row(row)
        for row in rows
        if _knowledge_object_event_allowed(object_type, row)
    ]
    return {
        "events": events,
        "related_ids": related_ids,
        "total": len(events),
    }


@app.post("/api/knowledge/reading-drafts/{draft_id}/commit")
async def post_knowledge_reading_draft_commit(request: Request, draft_id: str):
    _require_token(request)
    reading_bridge = _knowledge_custom_module("bridge.reading_bridge", "Reading bridge")
    commit_reading_artifact = reading_bridge.commit_reading_artifact
    return await _run_cancellable_ai_operation(
        request,
        "reading.commit",
        lambda: commit_reading_artifact(draft_id=draft_id),
    )


@app.post("/api/knowledge/reading-drafts/{draft_id}/revise")
async def post_knowledge_reading_draft_revise(
    request: Request,
    draft_id: str,
    body: _KnowledgeDraftRevisionBody,
):
    _require_token(request)
    answer_bridge = _knowledge_custom_module("bridge.answer_bridge", "Answer bridge")
    revise_answer_draft = answer_bridge.revise_answer_draft
    return await _run_cancellable_ai_operation(
        request,
        "reading.revise",
        lambda: revise_answer_draft(draft_id=draft_id, instruction=body.instruction),
    )


@app.delete("/api/knowledge/reading-drafts/{draft_id}")
async def delete_knowledge_reading_draft(request: Request, draft_id: str):
    _require_token(request)
    reading_bridge = _knowledge_custom_module("bridge.reading_bridge", "Reading bridge")
    discard_reading_artifact = reading_bridge.discard_reading_artifact
    return discard_reading_artifact(draft_id=draft_id)


def _source_for_capture(conn: sqlite3.Connection, vault_path: Path, capture_id: str) -> dict:
    capture_id = (capture_id or "").strip()
    row = conn.execute(
        "SELECT id, file_path FROM captures WHERE id = ?",
        (capture_id,),
    ).fetchone()
    if not row and len(capture_id) >= 6:
        rows = conn.execute(
            "SELECT id, file_path FROM captures WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2",
            (f"{capture_id}%",),
        ).fetchall()
        if len(rows) == 1:
            row = rows[0]
    if not row:
        return {
            "id": capture_id,
            "title": "未找到来源材料",
            "file_path": "",
            "summary": "",
        }
    file_path = str(row["file_path"] or "")
    note = _knowledge_read_note(vault_path, file_path)
    frontmatter = note[0] if note else {}
    title = str(frontmatter.get("title") or "").strip() or Path(file_path).stem or str(row["id"])
    return {
        "id": str(row["id"]),
        "title": title,
        "file_path": file_path,
        "summary": str(frontmatter.get("story") or "").strip(),
    }


def _knowledge_card_row(
    row: sqlite3.Row,
    *,
    conn: sqlite3.Connection,
    vault_path: Path,
    full: bool = False,
) -> dict:
    data = dict(row)
    card_id = str(data.get("id") or "")
    payload = _knowledge_normalized_card_payload(data)
    capture_ids = payload.get("source_ids") or _json_value(str(data.get("capture_ids") or "[]"), [])
    core_arguments = _json_value(str(data.get("core_arguments") or "[]"), [])
    knowledge_links = _json_value(str(data.get("knowledge_links") or "[]"), [])
    key_materials = _json_value(str(data.get("key_materials") or "[]"), [])
    summary = str(payload.get("claim") or data.get("one_liner") or "").strip()
    kind = str(payload.get("card_kind") or data.get("card_kind") or "viewpoint").strip() or "viewpoint"
    if kind not in _KNOWLEDGE_CARD_KINDS:
        kind = "viewpoint"
    card = {
        "id": card_id,
        "title": payload.get("title") or data.get("title", "") or "未命名卡片",
        "kind": kind,
        "summary": summary,
        "status": data.get("status", ""),
        "updated_at": data.get("updated_at", ""),
        "created_at": data.get("created_at", ""),
        "file_path": "",
        "markdown": "",
        "source_theme": "",
        "core_arguments": core_arguments,
        "knowledge_links": knowledge_links,
        "key_materials": key_materials,
        "my_view": data.get("my_view", ""),
        "sources": [
            _source_for_capture(conn, vault_path, str(capture_id))
            for capture_id in capture_ids
            if str(capture_id).strip()
        ],
        "source_count": len(capture_ids),
    }
    if full:
        card.update(
            {
                "schema_version": payload.get("schema_version") or data.get("schema_version", ""),
                "payload": payload,
                "core_arguments": core_arguments,
                "knowledge_links": knowledge_links,
                "key_materials": key_materials,
                "my_view": data.get("my_view", ""),
                "markdown": "",
            }
        )
    return card


@app.get("/api/knowledge/cards")
async def get_knowledge_cards(request: Request, limit: int = 100):
    _require_token(request)
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM garden_cards
               WHERE COALESCE(status, '') != 'archived'
               ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                        rowid DESC
               LIMIT ?""",
            (max(1, min(limit, 300)),),
        ).fetchall()
        cards = [
            _knowledge_card_row(row, conn=conn, vault_path=vault_path, full=False)
            for row in rows
        ]
    groups = {kind: 0 for kind in _KNOWLEDGE_CARD_KINDS}
    for card in cards:
        groups[card["kind"]] = groups.get(card["kind"], 0) + 1
    return {"cards": cards, "groups": groups, "total": len(cards)}


@app.get("/api/knowledge/cards/{card_id}")
async def get_knowledge_card(request: Request, card_id: str):
    _require_token(request)
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute(
            "SELECT * FROM garden_cards WHERE id = ?",
            (card_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Knowledge card not found")
        card = _knowledge_card_row(row, conn=conn, vault_path=vault_path, full=True)
    return {"card": card}


@app.delete("/api/knowledge/cards/{card_id}")
async def delete_knowledge_card(request: Request, card_id: str):
    _require_token(request)
    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    archive_garden_card = garden_bridge.archive_garden_card
    return archive_garden_card(card_id=card_id)


@app.post("/api/knowledge/graph/refresh")
async def refresh_knowledge_graph(request: Request):
    _require_token(request)
    graph_module = _knowledge_custom_module("agents.knowledge_graph", "Knowledge graph service")
    conn = _knowledge_graph_conn()
    try:
        return graph_module.KnowledgeGraphService(conn, _knowledge_vault_path()).refresh()
    finally:
        conn.close()


@app.get("/api/knowledge/graph")
async def get_knowledge_graph(
    request: Request,
    focus_kind: str = "",
    focus_id: str = "",
    depth: int = 1,
    limit: int = 80,
):
    _require_token(request)
    graph_module = _knowledge_custom_module("agents.knowledge_graph", "Knowledge graph service")
    conn = _knowledge_graph_conn()
    try:
        return graph_module.KnowledgeGraphService(conn, _knowledge_vault_path()).focus_graph(
            focus_kind=focus_kind,
            focus_id=focus_id,
            depth=depth,
            limit=max(1, min(limit, 120)),
        )
    finally:
        conn.close()


@app.get("/dashboard-plugins/{plugin_name}/{file_path:path}")
async def serve_plugin_asset(plugin_name: str, file_path: str):
    """Serve static assets from a dashboard plugin directory.

    Only serves files from the plugin's ``dashboard/`` subdirectory.
    Path traversal is blocked by checking ``resolve().is_relative_to()``.
    """
    plugins = _get_dashboard_plugins()
    plugin = next((p for p in plugins if p["name"] == plugin_name), None)
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")

    base = Path(plugin["_dir"])
    target = (base / file_path).resolve()

    if not target.is_relative_to(base.resolve()):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Guess content type
    suffix = target.suffix.lower()
    content_types = {
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
    }
    media_type = content_types.get(suffix, "application/octet-stream")
    return FileResponse(target, media_type=media_type)


def _mount_plugin_api_routes():
    """Import and mount backend API routes from plugins that declare them.

    Each plugin's ``api`` field points to a Python file that must expose
    a ``router`` (FastAPI APIRouter).  Routes are mounted under
    ``/api/plugins/<name>/``.
    """
    for plugin in _get_dashboard_plugins():
        api_file_name = plugin.get("_api_file")
        if not api_file_name:
            continue
        api_path = Path(plugin["_dir"]) / api_file_name
        if not api_path.exists():
            _log.warning("Plugin %s declares api=%s but file not found", plugin["name"], api_file_name)
            continue
        try:
            module_name = f"hermes_dashboard_plugin_{plugin['name']}"
            spec = importlib.util.spec_from_file_location(module_name, api_path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            # Register in sys.modules BEFORE exec_module so pydantic/FastAPI
            # can resolve forward references (e.g. models defined in a file
            # that uses `from __future__ import annotations`). Without this,
            # TypeAdapter lazy-build fails at first request with
            # "is not fully defined" because the module namespace isn't
            # reachable by name for string-annotation resolution.
            sys.modules[module_name] = mod
            try:
                spec.loader.exec_module(mod)
            except Exception:
                sys.modules.pop(module_name, None)
                raise
            router = getattr(mod, "router", None)
            if router is None:
                _log.warning("Plugin %s api file has no 'router' attribute", plugin["name"])
                continue
            app.include_router(router, prefix=f"/api/plugins/{plugin['name']}")
            _log.info("Mounted plugin API routes: /api/plugins/%s/", plugin["name"])
        except Exception as exc:
            _log.warning("Failed to load plugin %s API routes: %s", plugin["name"], exc)


# Mount plugin API routes before the SPA catch-all.
_mount_plugin_api_routes()

mount_spa(app)


def start_server(
    host: str = "127.0.0.1",
    port: int = 9119,
    open_browser: bool = True,
    allow_public: bool = False,
    *,
    embedded_chat: bool = False,
):
    """Start the web UI server."""
    import uvicorn

    global _DASHBOARD_EMBEDDED_CHAT_ENABLED
    _DASHBOARD_EMBEDDED_CHAT_ENABLED = embedded_chat

    _LOCALHOST = ("127.0.0.1", "localhost", "::1")
    if host not in _LOCALHOST and not allow_public:
        raise SystemExit(
            f"Refusing to bind to {host} — the dashboard exposes API keys "
            f"and config without robust authentication.\n"
            f"Use --insecure to override (NOT recommended on untrusted networks)."
        )
    if host not in _LOCALHOST:
        _log.warning(
            "Binding to %s with --insecure — the dashboard has no robust "
            "authentication. Only use on trusted networks.", host,
        )

    # Record the bound host so host_header_middleware can validate incoming
    # Host headers against it. Defends against DNS rebinding (GHSA-ppp5-vxwm-4cf7).
    # bound_port is also stashed so /api/pty can build the back-WS URL the
    # PTY child uses to publish events to the dashboard sidebar.
    app.state.bound_host = host
    app.state.bound_port = port

    if open_browser:
        import webbrowser

        # On headless Linux (no DISPLAY or WAYLAND_DISPLAY) some registered
        # browsers are TUI programs (links, lynx, www-browser) that try to
        # take over the terminal.  That can send SIGHUP to the server process
        # and cause an immediate exit even though uvicorn bound successfully.
        # Skip the auto-open attempt on headless systems and let the user
        # open the URL manually.  macOS and Windows are always considered
        # display-capable.
        _has_display = (
            sys.platform != "linux"
            or bool(os.environ.get("DISPLAY"))
            or bool(os.environ.get("WAYLAND_DISPLAY"))
        )

        if _has_display:
            def _open():
                try:
                    time.sleep(1.0)
                    webbrowser.open(f"http://{host}:{port}")
                except Exception:
                    pass

            threading.Thread(target=_open, daemon=True).start()
        else:
            _log.debug(
                "Skipping browser-open: no DISPLAY or WAYLAND_DISPLAY detected "
                "(headless Linux). Pass --no-open to suppress this detection."
            )

    print(f"  Hermes Web UI → http://{host}:{port}")
    # proxy_headers=False so _ws_client_is_allowed sees the real connection peer
    # rather than X-Forwarded-For's rewritten value (which would defeat the
    # loopback gate when behind a reverse proxy).
    uvicorn.run(app, host=host, port=port, log_level="warning", proxy_headers=False)
