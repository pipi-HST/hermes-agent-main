"""Hermes Knowledge Dashboard HTTP routes (extracted from hermes_cli.web_server).

Mounted onto the Dashboard FastAPI app via ``register_knowledge_routes(app, host)``.
Production traffic delegates over HTTP to the Hermes Knowledge Service; local
checkout fallbacks remain dev-only compatibility paths.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

import yaml
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

_log = logging.getLogger("hermes_cli.web_server")
_AI_OPERATION_HEADER_NAME = "X-Hermes-AI-Operation-Id"
MAX_SELECTION_SEARCH_CHARS = 1000
KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS = float(
    os.environ.get("HERMES_KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS", "95")
)

router = APIRouter()
_host: Any = None


def _host_attr(name: str, default: Any = None) -> Any:
    if _host is not None and hasattr(_host, name):
        return getattr(_host, name)
    return default


def _require_token(request: Request) -> None:
    fn = _host_attr("_require_token")
    if fn is not None:
        fn(request)


def _knowledge_transport_mode() -> str:
    fn = _host_attr("_knowledge_transport_mode")
    if fn is not None:
        return fn()
    if (os.environ.get("HERMES_KNOWLEDGE_URL") or "").strip():
        return "http"
    return "local"


def register_knowledge_routes(app: FastAPI, *, host: Any = None) -> None:
    """Bind the host module (for auth/config/test seams) and mount knowledge routes."""
    global _host
    _host = host
    app.include_router(router)


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


class _KnowledgeEditableCaptureSuggestionBody(BaseModel):
    content: str
    title: str = ""
    title_source: str = ""
    folder_path: str = ""
    existing_folders: list[str] = []


class _KnowledgeCaptureUpdateBody(BaseModel):
    body: str = ""
    title: str = ""
    folder_path: str | None = None
    expected_revision: str | None = None


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
    source_run_id: str = ""
    folder_path: str = ""


class _KnowledgeGardenDraftBody(BaseModel):
    capture_ids: list[str] = []
    title: str = ""
    card_kind: str = ""
    instruction: str = ""


class _KnowledgeGardenDraftUpdateBody(BaseModel):
    title: str | None = None
    card_kind: str | None = None
    claim: str | None = None
    markdown: str | None = None
    when_to_use: list[str] | None = None
    core_judgments: list[dict[str, Any]] | None = None
    boundaries: list[str] | None = None
    action_items: list[str] | None = None


class _KnowledgeGardenCardUpdateBody(BaseModel):
    title: str | None = None
    card_kind: str | None = None
    claim: str | None = None
    markdown: str | None = None
    source_theme: str | None = None


class _KnowledgeGardenDraftReviseBody(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=2000)


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
    expected_revision: str | None = None


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


def _knowledge_local_root() -> Path | None:
    """Return the validated dev-only local checkout, or None when unset.

    HTTP mode is the supported production shape and normally leaves this
    unset.  The local checkout exists for offline development and debugging,
    not as a deployment option.
    """
    _override = _host_attr("_knowledge_local_root", None)
    if _override is not None and _override is not _knowledge_local_root:
        return _override()
    from integrations.hermes_knowledge import KnowledgeUnavailable, configured_root, validate_root

    root = configured_root()
    if root is None:
        return None
    try:
        return validate_root(root)
    except KnowledgeUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "feature_disabled", "message": str(exc)},
        ) from exc


def _knowledge_custom_root() -> Path:
    """Return a path anchor for Knowledge files.

    HTTP mode has no checkout, so this must not fail just because only
    ``HERMES_KNOWLEDGE_URL`` is configured.  Some dashboard helpers still
    resolve the SQLite DB / vault path directly, so without a local root this
    falls back to the directory around ``HERMES_KNOWLEDGE_DB`` or the
    conventional ``~/Hermes/knowledge`` path.  Those variables are a known
    exception for reads, not an HTTP-mode requirement.  Callers that truly
    need to import local Python modules must use
    :func:`_knowledge_custom_module`, which fails with a precise
    local-checkout error instead.
    """
    root = _knowledge_local_root()
    if root is not None:
        return root
    configured_db = (os.environ.get("HERMES_KNOWLEDGE_DB") or "").strip()
    if configured_db:
        # <repo>/data/captures.db -> <repo>
        return Path(configured_db).expanduser().resolve().parent.parent
    return Path("~/Hermes/knowledge").expanduser()


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
    _override = _host_attr("_knowledge_custom_module", None)
    if _override is not None and _override is not _knowledge_custom_module:
        return _override(module_name, label)
    root = _knowledge_local_root()
    if root is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "local_checkout_required",
                "message": (
                    f"{label} requires a local Hermes Knowledge checkout. "
                    "Set HERMES_KNOWLEDGE_LOCAL_ROOT for local development, or "
                    "use the HTTP-mode route that delegates to the service."
                ),
                "module": module_name,
            },
        )
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    try:
        return _host_attr("importlib", importlib).import_module(module_name)
    except ModuleNotFoundError as exc:
        detail = _knowledge_custom_import_failure_detail(label, module_name, exc, root)
        _log.warning("%s import failed: %s", label, detail)
        raise HTTPException(status_code=503, detail=detail) from exc
    except Exception as exc:
        _log.exception("%s import failed", label)
        raise HTTPException(status_code=500, detail=f"{label} unavailable: {exc}") from exc


def _knowledge_client_startup_error(exc: Exception) -> HTTPException:
    """Map a ``get_client()`` failure to the dashboard HTTP response.

    Used by every HTTP-mode delegation handler, mirroring the permanent-delete
    route: an incompatible contract reports 503 with a machine-readable code,
    while a configuration/transport problem keeps the R2 wording.
    """
    from integrations.hermes_knowledge import KnowledgeIncompatible

    if isinstance(exc, KnowledgeIncompatible):
        return HTTPException(
            status_code=503,
            detail={
                "code": "contract_incompatible",
                "message": f"knowledge service contract is incompatible: {exc}",
            },
        )
    return HTTPException(
        status_code=503,
        detail=f"knowledge service is not configured correctly: {exc}",
    )


def _knowledge_client_operation_error(exc: Exception) -> HTTPException:
    """Map a knowledge-client operation failure to the dashboard HTTP response.

    Order matters: the specific subclasses are checked before the generic
    fallback, and :class:`KnowledgeIncompatible` (a ``KnowledgeUnavailable``
    subclass) is checked first so an incompatible contract is never mistaken
    for a transient failure.
    """
    from integrations.hermes_knowledge.client import (
        KnowledgeConflict,
        KnowledgeIncompatible,
        KnowledgeInvalid,
        KnowledgeNotFound,
    )

    if isinstance(exc, KnowledgeIncompatible):
        return HTTPException(
            status_code=503,
            detail={
                "code": "contract_incompatible",
                "message": f"knowledge service contract is incompatible: {exc}",
            },
        )
    if isinstance(exc, KnowledgeNotFound):
        detail = getattr(exc, "detail", None)
        if not isinstance(detail, (dict, str)) or not detail:
            detail = str(exc) or "Knowledge object not found"
        return HTTPException(status_code=404, detail=detail)
    if isinstance(exc, KnowledgeConflict):
        detail = getattr(exc, "detail", None)
        if not isinstance(detail, dict):
            detail = {"message": str(detail or exc)}
        return HTTPException(status_code=409, detail=detail)
    if isinstance(exc, KnowledgeInvalid):
        detail = getattr(exc, "detail", None)
        if not isinstance(detail, (dict, str)) or not detail:
            detail = str(exc)
        return HTTPException(status_code=422, detail=detail)
    return HTTPException(status_code=502, detail=f"knowledge service request failed: {exc}")


def _knowledge_ai_cancel_module():
    return _knowledge_custom_module("bridge.ai_cancel", "AI operation cancellation")


def _normalize_ai_operation_id(operation_id: str | None) -> str:
    text = str(operation_id or "").strip()
    if not text:
        return ""
    return "".join(ch for ch in text if ch.isalnum() or ch in "-_:")[:120]


def _knowledge_ai_operation_id(request: Request) -> str:
    return _normalize_ai_operation_id(request.headers.get(_AI_OPERATION_HEADER_NAME, ""))


def _knowledge_http_operation_kwargs(request: Request) -> dict[str, str]:
    operation_id = _knowledge_ai_operation_id(request)
    return {"operation_id": operation_id} if operation_id else {}


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


@router.post("/api/knowledge/ai-operations/{operation_id}/cancel")
async def post_knowledge_ai_operation_cancel(request: Request, operation_id: str):
    _require_token(request)

    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(client.cancel_ai_operation, operation_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    cancel_module = _knowledge_ai_cancel_module()
    cancelled = getattr(cancel_module, "cancel_operation")(operation_id)
    normalized = _normalize_ai_operation_id(operation_id)
    return {"ok": bool(cancelled), "operation_id": normalized, "status": "cancel_requested"}


def _knowledge_db_path() -> Path:
    """Path to the knowledge SQLite DB.

    ``HERMES_KNOWLEDGE_DB`` must win without touching a local checkout:
    the old form passed the checkout-derived default as a function argument,
    which Python evaluates eagerly, so setting the env var still raised the
    fail-closed 503 when no checkout was configured.

    This is also the documented read-route exception in HTTP mode: most reads
    delegate to the service, but some local compatibility branches still open
    the DB directly.  Unset in HTTP mode means the conventional
    ``~/Hermes/knowledge/data/captures.db`` path, not a required setting.
    """
    _override = _host_attr("_knowledge_db_path", None)
    if _override is not None and _override is not _knowledge_db_path:
        return _override()
    configured = (os.environ.get("HERMES_KNOWLEDGE_DB") or "").strip()
    if configured:
        return Path(configured).expanduser()
    root = _knowledge_local_root()
    if root is not None:
        return root / "data" / "captures.db"
    if _knowledge_transport_mode() == "http":
        return Path("~/Hermes/knowledge/data/captures.db").expanduser()
    raise HTTPException(
        status_code=503,
        detail={"code": "feature_disabled", "message": "Hermes Knowledge is not configured."},
    )


def _knowledge_vault_path() -> Path:
    """Path to the Knowledge vault.

    ``HERMES_KNOWLEDGE_VAULT`` is the vault-side counterpart to the
    ``HERMES_KNOWLEDGE_DB`` read exception: most HTTP-mode routes delegate to
    the service, but some helpers (automation inventory, local compatibility
    branches) still resolve files under the vault.  It is not a required
    HTTP-mode setting.
    """
    _override = _host_attr("_knowledge_vault_path", None)
    if _override is not None and _override is not _knowledge_vault_path:
        return _override()
    configured = (os.environ.get("HERMES_KNOWLEDGE_VAULT") or "").strip()
    if configured:
        return Path(configured).expanduser()
    root = _knowledge_local_root()
    config_path = root / "config.yaml" if root is not None else None
    if config_path is not None and config_path.exists():
        try:
            cfg = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            vault = cfg.get("vault") if isinstance(cfg, dict) else {}
            if isinstance(vault, dict) and vault.get("path"):
                return Path(str(vault["path"])).expanduser()
        except Exception:
            _log.warning("Failed to read Hermes Knowledge config at %s", config_path)
    if root is not None or _knowledge_transport_mode() == "http":
        return Path("~/Hermes/knowledge").expanduser()
    raise HTTPException(
        status_code=503,
        detail={"code": "feature_disabled", "message": "Hermes Knowledge is not configured."},
    )


def _knowledge_conn(*, factory: type[sqlite3.Connection] = sqlite3.Connection) -> sqlite3.Connection:
    _override = _host_attr("_knowledge_conn", None)
    if _override is not None and _override is not _knowledge_conn:
        return _override() if factory is sqlite3.Connection else _override(factory=factory)
    db_path = _knowledge_db_path()
    if not db_path.exists():
        raise HTTPException(status_code=404, detail=f"Knowledge DB not found: {db_path}")
    conn = sqlite3.connect(str(db_path), factory=factory)
    conn.row_factory = sqlite3.Row
    return conn


def _knowledge_graph_conn() -> sqlite3.Connection:
    schema_module = _knowledge_custom_module("db.schema", "Knowledge schema")
    return schema_module.init_db(str(_knowledge_db_path()))


@router.get("/api/knowledge/runtime-check")
async def get_knowledge_runtime_check(request: Request):
    _require_token(request)
    if _knowledge_transport_mode() == "http":
        return {
            "ok": True,
            "mode": "http",
            "custom_root": "",
            "python": sys.executable,
            "checks": [
                {
                    "module": "hermes-knowledge-http",
                    "label": "Knowledge Service over HTTP",
                    "ok": True,
                }
            ],
        }
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
        "mode": _knowledge_transport_mode(),
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
    try:
        module = _knowledge_custom_module(
            "agents.garden_card_payload", "Knowledge card payload"
        )
    except Exception:
        return {}
    return module.normalize_garden_payload(
        module.parse_payload_json(str(data.get("payload_json") or "{}")),
        legacy=data,
    )


def _clip_text(text: str, limit: int = 360) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _knowledge_read_note(vault_path: Path, file_path: str) -> tuple[dict, str] | None:
    snapshot = _knowledge_read_note_snapshot(vault_path, file_path)
    return snapshot[:2] if snapshot is not None else None


def _knowledge_read_note_snapshot(vault_path: Path, file_path: str) -> tuple[dict, str, str] | None:
    if not file_path:
        return None
    try:
        # Same containment rule as the other knowledge paths: resolve under the
        # vault, reject absolute/'..' escapes and symlinks out of the vault.
        path = _knowledge_local_file_path(vault_path, file_path)
    except HTTPException:
        return None
    try:
        raw_text = path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return None
    text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                frontmatter = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                frontmatter = {}
            return frontmatter, parts[2].strip(), raw_text
    return {}, text, raw_text


# Keep in sync with hermes-custom/bridge/folder_store.py:DEFAULT_FOLDERS.
_KNOWLEDGE_DEFAULT_FOLDERS = [
    "Inbox",
    "AI 产品面试",
    "Agent 与大模型",
    "行业与产品拆解",
    "读书与随笔",
]
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
    # The Knowledge service stores the topic registry inside the vault
    # (``<vault>/.hermes/knowledge_folders.json``). Keep the local fallback on
    # the same file so both modes read and write one registry.
    return _knowledge_vault_path() / ".hermes" / "knowledge_folders.json"


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
            "database_row": "retained_with_archived_at",
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
    snapshot = _knowledge_read_note_snapshot(vault_path, file_path)
    frontmatter, body, raw_text = snapshot if snapshot is not None else ({}, "", "")
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
        "status": str(frontmatter.get("status") or ("archived" if data.get("archived_at") else "") or "captured"),
        "file_path": file_path,
        "raw_path": str(data.get("raw_path") or ""),
        "word_count": int(frontmatter.get("word_count") or len(body)),
        "created_at": str(data.get("created_at") or ""),
        "updated_at": str(data.get("updated_at") or ""),
        "indexed": indexed,
        "title_source": str(frontmatter.get("title_source") or "").strip(),
        "garden_card_count": _knowledge_garden_card_count(conn, capture_id),
    }
    if full and snapshot is not None:
        from hashlib import sha256

        item["note_revision"] = sha256(raw_text.encode("utf-8")).hexdigest()
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
           WHERE archived_at IS NULL
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


@router.get("/api/knowledge/library/folders")
async def get_knowledge_library_folders(request: Request):
    _require_token(request)
    # HTTP mode: the service owns the vault, so folder listing (and its counts)
    # must come from the service instead of the dashboard's local SQLite.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(client.list_library_folders)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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
        {"key": "recent", "label": "最近保存", "count": len(items)},
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


@router.post("/api/knowledge/library/folders")
async def post_knowledge_library_folder(
    request: Request,
    body: _KnowledgeLibraryFolderCreateBody,
):
    _require_token(request)
    folder = _knowledge_folder(body.name)
    if len(folder) > 80:
        raise HTTPException(status_code=400, detail="folder name is too long")

    # HTTP mode: creating a folder must go through the service so its vault and
    # folder registry stay authoritative.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.create_library_folder(folder)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    _knowledge_save_stored_folder(folder)
    return {"ok": True, "folder": {"path": folder, "name": folder, "count": 0}}


@router.patch("/api/knowledge/library/folders/{folder_path:path}")
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

    # HTTP mode: folder renames rewrite captures inside the service, never in
    # the dashboard process (there is no local checkout to touch).
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.rename_library_folder(old_folder, new_folder)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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
            "SELECT * FROM captures WHERE archived_at IS NULL"
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
            capture_id = str(data.get("id") or "")
            conn.execute(
                "UPDATE captures SET updated_at = datetime('now') WHERE id = ?",
                (capture_id,),
            )
            conn.execute(
                """INSERT INTO capture_metadata
                       (capture_id, folder_path, created_at, updated_at)
                   VALUES (?, ?, datetime('now'), datetime('now'))
                   ON CONFLICT(capture_id) DO UPDATE SET
                       folder_path=excluded.folder_path,
                       updated_at=excluded.updated_at""",
                (capture_id, new_folder),
            )
            updated_items += 1
        conn.execute(
            """UPDATE garden_cards
               SET source_theme = ?, updated_at = datetime('now')
               WHERE source_theme = ?""",
            (new_folder, old_folder),
        )
        conn.commit()

    _knowledge_rename_stored_folder(old_folder, new_folder)
    return {
        "ok": True,
        "folder": {"path": new_folder, "name": new_folder, "count": updated_items},
        "updated_items": updated_items,
    }


@router.get("/api/knowledge/library/items")
async def get_knowledge_library_items(
    request: Request,
    folder: str = "",
    view: str = "",
    search: str = "",
    limit: int = 200,
):
    _require_token(request)

    # HTTP mode: the service owns the vault, so list reads must come from it.
    # Normalise to the local branch's shape exactly ({"items", "total"}); the
    # contract's extra ``counts`` block is not part of the dashboard response.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            payload = await asyncio.to_thread(
                client.list_library_items,
                folder=folder,
                view=view,
                search=search,
                limit=limit,
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
        payload = payload if isinstance(payload, dict) else {}
        items = payload.get("items")
        items = items if isinstance(items, list) else []
        total = payload.get("total")
        return {"items": items, "total": total if isinstance(total, int) else len(items)}

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


@router.get("/api/knowledge/library/items/{kind}/{item_id}")
async def get_knowledge_library_item(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()

    # HTTP mode: single-item reads are served by the service.  Keep the local
    # response shape exactly ({"item": ...}); the service envelope's ``ok``
    # flag is not part of the dashboard response.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            payload = await asyncio.to_thread(client.get_library_item, kind, item_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
        payload = payload if isinstance(payload, dict) else {}
        return {"item": payload.get("item")}

    vault_path = _knowledge_vault_path()
    with closing(_knowledge_conn()) as conn:
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


@router.get("/api/knowledge/library/items/{kind}/{item_id}/dependencies")
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
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.item_dependencies(kind, item_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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
            if row["archived_at"]:
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
    _host_attr("subprocess", subprocess).Popen(cmd, shell=False)


@router.post("/api/knowledge/library/items/{kind}/{item_id}/open-local")
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
    # Keep capture/draft/card routing in one place.  The dashboard and the TUI
    # gateway share the same source map contract; a local copy here silently
    # omitted garden cards and made [K] card links unopenable.
    from integrations.hermes_knowledge.sources import enrich_source

    return enrich_source(conn, vault_path, source)


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
    if _knowledge_transport_mode() == "http":
        # The service owns the item and source metadata; enriching here would
        # require a local checkout and reintroduce the split we removed.
        return {"knowledge": knowledge_sources, "web": web_sources}
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
            "source_run_id": meta.get("source_run_id") if isinstance(meta.get("source_run_id"), str) else "",
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


@router.post("/api/knowledge/library/items/{kind}/{item_id}/selection-chat")
async def post_knowledge_library_item_selection_chat(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibrarySelectionChatBody,
):
    _require_token(request)

    # HTTP mode: the service owns the item + research bridge call.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            result = await asyncio.to_thread(client.selection_chat, kind, item_id, body.model_dump())
            return _knowledge_library_selection_chat_response(result, body)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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
            result = await asyncio.to_thread(sync_answer, **research_kwargs)
    except HTTPException:
        raise
    except Exception as exc:
        _log.exception("knowledge selection chat failed")
        raise HTTPException(status_code=502, detail=f"Selection chat failed: {exc}") from exc
    return _knowledge_library_selection_chat_response(result, body)


@router.post("/api/knowledge/library/items/{kind}/{item_id}/selection-chat/stream")
async def post_knowledge_library_item_selection_chat_stream(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibrarySelectionChatBody,
):
    _require_token(request)

    from integrations.hermes_knowledge.client import (
        KnowledgeNotFound,
        KnowledgeUnavailable,
        get_client,
    )

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        async def http_event_stream():
            yield _sse_json({"event": "start", "mode": body.mode})

            def complete_event(result: dict[str, Any]) -> str:
                return _sse_json(
                    {
                        "event": "complete",
                        "response": _knowledge_library_selection_chat_response(
                            result, body
                        ),
                    }
                )

            try:
                # Relay the service stream: progress and token deltas arrive
                # while the answer is still being written.
                async for event in client.astream_selection_chat(
                    kind, item_id, body.model_dump()
                ):
                    if event.get("event") == "complete":
                        result = event.get("result")
                        yield complete_event(result if isinstance(result, dict) else {})
                    else:
                        yield _sse_json(event)
            except KnowledgeNotFound:
                # Service predates the streaming endpoint: one blocking call.
                try:
                    result = await asyncio.to_thread(
                        client.selection_chat, kind, item_id, body.model_dump()
                    )
                    yield complete_event(result)
                except KnowledgeUnavailable as exc:
                    yield _sse_json(
                        {
                            "event": "error",
                            "message": _knowledge_client_operation_error(exc).detail,
                        }
                    )
                except Exception as exc:
                    yield _sse_json(
                        {"event": "error", "message": f"Selection chat failed: {exc}"}
                    )
            except KnowledgeUnavailable as exc:
                yield _sse_json(
                    {
                        "event": "error",
                        "message": _knowledge_client_operation_error(exc).detail,
                    }
                )
            except Exception as exc:
                yield _sse_json(
                    {"event": "error", "message": f"Selection chat failed: {exc}"}
                )
            finally:
                client.close()

        return StreamingResponse(
            http_event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

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
                    timeout=max(1.0, float(_host_attr("KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS", KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS))),
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


@router.post("/api/knowledge/library/items")
async def post_knowledge_library_item(request: Request, body: _KnowledgeLibraryCreateBody):
    _require_token(request)
    content = (body.body or "").strip()
    title = (body.title or "").strip()
    if not content and not title:
        raise HTTPException(status_code=400, detail="title or body is required")

    # HTTP mode: the service creates the editable library draft (contract v1).
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.create_library_item(
                body=content or title,
                title=title,
                source=body.source,
                source_type=body.source_type,
                folder_path=_knowledge_folder(body.folder_path),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    create_editable_capture_draft = capture_bridge.create_editable_capture_draft
    result = create_editable_capture_draft(
        content=content or title,
        source=body.source,
        source_type=body.source_type,
        instruction="自由编辑后保存到资料库",
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


def _patch_local_capture_with_revision(
    capture_id: str, *, body: str, title: str, folder_path: str | None, expected_revision: str
) -> dict:
    # The opt-in editor save uses the same snapshot check and writer as the
    # service, even when developing with a local Knowledge checkout.
    writer = _knowledge_custom_module("agents.markdown_writer", "Markdown writer")
    if not hasattr(writer, "read_note_snapshot"):
        raise HTTPException(
            status_code=503,
            detail={"code": "contract_incompatible", "message": "请先升级本地 Knowledge checkout。"},
        )
    captures = _knowledge_custom_module("api.routes.captures", "Capture route helpers")
    repo_module = _knowledge_custom_module("db.repo", "Capture repository")
    concurrency = _knowledge_custom_module("db.concurrency", "Knowledge database transactions")
    vault_path = _knowledge_vault_path()
    # The shared writer owns its transaction; a plain SQLite connection would
    # let repo.log_change() commit it prematurely.
    with closing(_knowledge_conn(factory=concurrency.SerializedConnection)) as conn:
        repo = repo_module.CaptureRepo(conn)
        result = captures.apply_capture_update(
            repo, vault_path, None, capture_id,
            body=body, title=title, folder_path=folder_path, expected_revision=expected_revision,
        )
        result["library_postprocess"] = captures._maintain_capture_after_edit(
            repo, vault_path, capture_id, None,
        )
        return result


@router.patch("/api/knowledge/library/items/{kind}/{item_id}")
async def patch_knowledge_library_item(
    request: Request,
    kind: str,
    item_id: str,
    body: _KnowledgeLibraryUpdateBody,
):
    _require_token(request)
    kind = (kind or "").strip()
    folder_path = _knowledge_folder(body.folder_path) if body.folder_path is not None else None

    # HTTP mode: edits are applied by the service, which owns the vault file and
    # the SQLite row; the dashboard only forwards the fields the user changed.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.patch_library_item(
                kind,
                item_id,
                title=body.title,
                body=body.body,
                summary=body.summary,
                tags=body.tags,
                folder_path=folder_path,
                folder_suggestion=body.folder_suggestion,
                card_suggestion=body.card_suggestion,
                **({"expected_revision": body.expected_revision} if body.expected_revision is not None else {}),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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
        if body.expected_revision is not None:
            result = await asyncio.to_thread(
                _patch_local_capture_with_revision,
                item_id,
                body=body.body or "",
                title=body.title,
                folder_path=folder_path,
                expected_revision=body.expected_revision,
            )
            return {"ok": True, "backup_path": result["backup_path"], "item": result["item"]}
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
            if folder_path is not None:
                # Keep the SQL mirror in step; otherwise folder filters hide
                # the note until a full repair run.
                conn.execute(
                    """INSERT INTO capture_metadata
                           (capture_id, folder_path, created_at, updated_at)
                       VALUES (?, ?, datetime('now'), datetime('now'))
                       ON CONFLICT(capture_id) DO UPDATE SET
                           folder_path=excluded.folder_path,
                           updated_at=excluded.updated_at""",
                    (item_id, folder_path),
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
    _override = _host_attr("_new_capture_agent", None)
    if _override is not None and _override is not _new_capture_agent:
        return _override()
    capture_agent_module = _knowledge_custom_module("agents.capture_agent", "Capture agent")
    root = _knowledge_local_root()
    if root is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "local_checkout_required",
                "message": "Capture revision requires a local checkout; use the service route in HTTP mode.",
            },
        )
    CaptureAgent = capture_agent_module.CaptureAgent
    load_capture_config = capture_agent_module.load_config
    return CaptureAgent(load_capture_config(str(root / "config.yaml")))


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
    return f"""你是 Hermes Knowledge 的保存笔记修订助手。

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


@router.post("/api/knowledge/captures/{capture_id}/revise")
async def post_knowledge_capture_revise(
    request: Request,
    capture_id: str,
    body: _KnowledgeCaptureRevisionBody,
):
    _require_token(request)
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction cannot be empty")

    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.revise_capture_note, capture_id, instruction,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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


@router.delete("/api/knowledge/library/items/{kind}/{item_id}/permanent")
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
        "message": "已彻底删除保存文件及其本地索引记录。",
    }


@router.delete("/api/knowledge/library/items/{kind}/{item_id}")
async def delete_knowledge_library_item(request: Request, kind: str, item_id: str):
    _require_token(request)
    kind = (kind or "").strip()

    # HTTP mode: discarding a draft / archiving a capture is a service write.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.delete_library_item(kind, item_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    if kind == "capture_draft":
        capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
        discard_capture_draft = capture_bridge.discard_capture_draft
        return discard_capture_draft(draft_id=item_id)
    if kind == "capture":
        vault_path = _knowledge_vault_path()
        with _knowledge_conn() as conn:
            dependency_response = _knowledge_capture_dependency_response(conn, vault_path, item_id=item_id)
            conn.execute(
                "UPDATE captures SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
                (item_id,),
            )
            conn.commit()
        return {
            "ok": True,
            "status": "archived",
            "id": item_id,
            "dependencies": dependency_response["dependencies"],
            "message": "已归档保存文件；源文件、卡片、引用和历史记录已保留。",
        }
    raise HTTPException(status_code=400, detail="Unsupported library item kind")


@router.get("/api/knowledge/capture-drafts")
async def get_knowledge_capture_drafts(request: Request, limit: int = 50):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.list_capture_drafts(limit=max(1, min(limit, 200)))
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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


@router.get("/api/knowledge/capture-drafts/{draft_id}")
async def get_knowledge_capture_draft(request: Request, draft_id: str):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.get_capture_draft(draft_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute(
            "SELECT * FROM capture_drafts WHERE id = ?",
            (draft_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Capture draft not found")
        return {"draft": _draft_row(row, conn=conn, vault_path=vault_path, full=True)}


@router.post("/api/knowledge/capture-drafts/editable")
async def post_knowledge_editable_capture_draft(
    request: Request,
    body: _KnowledgeEditableCaptureDraftBody,
):
    _require_token(request)
    kwargs = {
        "content": body.content,
        "source": body.source,
        "source_type": body.source_type,
        "instruction": body.instruction,
        "title": body.title,
        "title_source": body.title_source,
        "organize": body.organize,
    }
    if body.existing_folders:
        kwargs["existing_folders"] = body.existing_folders
    if body.folder_path.strip():
        kwargs["folder_path"] = body.folder_path

    # HTTP mode: creating a draft is a service write.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.call_tool, "capture_bridge", "create_editable_capture_draft",
                kwargs=kwargs, **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    create_editable_capture_draft = capture_bridge.create_editable_capture_draft
    kwargs["existing_folders"] = body.existing_folders or _knowledge_visible_folder_paths()
    return await _run_cancellable_ai_operation(
        request,
        "capture.editable.create",
        lambda: create_editable_capture_draft(**kwargs),
    )


@router.patch("/api/knowledge/capture-drafts/{draft_id}/editable")
async def patch_knowledge_editable_capture_draft(
    request: Request,
    draft_id: str,
    body: _KnowledgeEditableCaptureDraftBody,
):
    _require_token(request)
    # AI organization must use the editable draft workflow, not a plain row edit.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        if body.organize:
            try:
                payload = body.model_dump(exclude_none=True)
                if not body.folder_path.strip():
                    payload.pop("folder_path", None)
                return await asyncio.to_thread(
                    client.update_editable_capture_draft, draft_id, payload,
                    **_knowledge_http_operation_kwargs(request),
                )
            except KnowledgeUnavailable as exc:
                raise _knowledge_client_operation_error(exc) from exc
            finally:
                client.close()
        capture_intent: dict[str, Any] = {}
        if body.folder_path.strip():
            capture_intent["folder_path"] = _knowledge_folder(body.folder_path)
        if body.folder_suggestion is not None:
            capture_intent["folder_suggestion"] = body.folder_suggestion
        if body.card_suggestion is not None:
            capture_intent["card_suggestion"] = body.card_suggestion
        try:
            return await asyncio.to_thread(
                client.patch_capture_draft,
                draft_id,
                title=body.title,
                draft_text=body.content,
                summary=body.summary,
                tags=body.tags,
                capture_intent=capture_intent,
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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


@router.post("/api/knowledge/capture-drafts/{draft_id}/suggestions/regenerate")
async def post_knowledge_capture_draft_regenerate_suggestions(
    request: Request,
    draft_id: str,
    body: _KnowledgeEditableCaptureSuggestionBody,
):
    _require_token(request)
    # AI suggestion regeneration is the editable-draft workflow with
    # organize=True (the route P1 connected), not a plain draft-row PATCH.
    # Summary, tags and the old folder/card suggestions are deliberately not
    # sent so the service regenerates them instead of preserving stale values.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        payload: dict[str, Any] = {
            "content": body.content,
            "title": body.title,
            "organize": True,
        }
        if body.title_source.strip():
            payload["title_source"] = body.title_source.strip()
        if body.folder_path.strip():
            payload["folder_path"] = body.folder_path.strip()
        if body.existing_folders:
            payload["existing_folders"] = body.existing_folders
        try:
            return await asyncio.to_thread(
                client.update_editable_capture_draft, draft_id, payload,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    update_editable_capture_draft = capture_bridge.update_editable_capture_draft
    return await _run_cancellable_ai_operation(
        request,
        "capture.editable.regenerate_suggestions",
        lambda: update_editable_capture_draft(
            draft_id=draft_id,
            content=body.content,
            title=body.title,
            title_source=body.title_source or None,
            folder_path=body.folder_path or None,
            organize=True,
            existing_folders=body.existing_folders or _knowledge_visible_folder_paths(),
        ),
    )


@router.post("/api/knowledge/capture-drafts/{draft_id}/commit")
async def post_knowledge_capture_draft_commit(request: Request, draft_id: str):
    _require_token(request)

    # HTTP mode: confirmation + commit both live in the service.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            issued = await asyncio.to_thread(client.issue_confirmation, "capture-drafts", draft_id)
            token = str((issued or {}).get("token") or "").strip()
            if not token:
                raise KnowledgeUnavailable(
                    "knowledge service did not return a capture commit token"
                )
            return await asyncio.to_thread(
                client.commit_draft, "capture-drafts", draft_id, token,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    commit_capture_draft = capture_bridge.commit_capture_draft
    result = await _run_cancellable_ai_operation(
        request,
        "capture.commit",
        lambda: commit_capture_draft(
            draft_id,
            confirmation_source="dashboard",
            # The dashboard route already authenticated the user and the click
            # is the confirmation; the bridge must not demand a chat phrase.
            token_verified=True,
        ),
    )
    return result


@router.post("/api/knowledge/capture-drafts/{draft_id}/revise")
async def post_knowledge_capture_draft_revise(
    request: Request,
    draft_id: str,
    body: _KnowledgeDraftRevisionBody,
):
    _require_token(request)

    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.call_tool,
                "capture_bridge",
                "revise_capture_draft",
                kwargs={"draft_id": draft_id, "instruction": body.instruction},
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    revise_capture_draft = capture_bridge.revise_capture_draft
    result = await _run_cancellable_ai_operation(
        request,
        "capture.revise",
        lambda: revise_capture_draft(draft_id=draft_id, instruction=body.instruction),
    )
    return result


@router.delete("/api/knowledge/capture-drafts/{draft_id}")
async def delete_knowledge_capture_draft(request: Request, draft_id: str):
    _require_token(request)

    # HTTP mode: abandoning a draft is a service write.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.delete_capture_draft(draft_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    capture_bridge = _knowledge_custom_module("bridge.capture_bridge", "Capture bridge")
    discard_capture_draft = capture_bridge.discard_capture_draft
    return discard_capture_draft(draft_id=draft_id)


@router.patch("/api/knowledge/captures/{capture_id}")
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
                **({"expected_revision": body.expected_revision} if body.expected_revision is not None else {}),
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

    if body.expected_revision is not None:
        return await asyncio.to_thread(
            _patch_local_capture_with_revision,
            capture_id,
            body=body.body,
            title=body.title,
            folder_path=_knowledge_folder(body.folder_path) if body.folder_path is not None else None,
            expected_revision=body.expected_revision,
        )

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


@router.post("/api/knowledge/answer-drafts")
async def post_knowledge_answer_draft(request: Request, body: _KnowledgeAnswerDraftBody):
    _require_token(request)

    # The service owns the draft and its cancellation checkpoints.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        payload = {
            "hermes_session_id": body.hermes_session_id,
            "user_message": body.user_message,
            "assistant_answer": body.assistant_answer,
            "instruction": body.instruction,
            "output_type": body.output_type,
            "assistant_message_id": body.assistant_message_id,
            "sources": body.sources,
            "target_capture_id": body.target_capture_id,
            "answer_source": body.answer_source,
            "source_run_id": body.source_run_id,
            "folder_path": body.folder_path,
        }
        try:
            return await asyncio.to_thread(
                client.create_answer_draft, payload, **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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
            folder_path=body.folder_path,
        ),
    )


def _garden_confirmation_token(issued: Any) -> str:
    if not isinstance(issued, dict):
        return ""
    return str(issued.get("token") or issued.get("confirmation_token") or "").strip()


def _commit_local_garden_draft(garden_bridge, draft_id: str) -> dict[str, Any]:
    """Commit through the dev-only local bridge.

    Newer checkouts expose the same ``issue_garden_confirmation`` ->
    ``confirmation_token`` handshake as the HTTP service.  Prefer it when it is
    available; older local checkouts only understand the dashboard's
    ``token_verified`` shortcut, which stays as the fallback.
    """
    issue = getattr(garden_bridge, "issue_garden_confirmation", None)
    if callable(issue):
        token = _garden_confirmation_token(issue(draft_id=draft_id))
        if token:
            return garden_bridge.commit_garden_draft(
                draft_id=draft_id, confirmation_token=token
            )
    return garden_bridge.commit_garden_draft(
        draft_id=draft_id,
        confirmation_source="dashboard",
        # The dashboard route already authenticated the user and the click
        # is the confirmation; the bridge must not demand a chat phrase.
        token_verified=True,
    )


@router.post("/api/knowledge/garden-drafts")
async def post_knowledge_garden_draft(request: Request, body: _KnowledgeGardenDraftBody):
    _require_token(request)

    # Garden synthesis only creates a draft.  Saving it is a separate,
    # user-confirmed step handled by the commit route below (issue a one-time
    # confirmation token, then commit with it).  ``auto_commit`` is neither
    # accepted nor forwarded.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.create_garden_draft,
                capture_ids=body.capture_ids,
                title=body.title,
                card_kind=body.card_kind,
                instruction=body.instruction,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    synthesize_garden = garden_bridge.synthesize_garden
    return await _run_cancellable_ai_operation(
        request,
        "garden.synthesize",
        lambda: synthesize_garden(
            capture_ids=body.capture_ids,
            title=body.title,
            card_kind=body.card_kind,
            instruction=body.instruction,
        ),
    )


@router.post("/api/knowledge/garden-drafts/preview")
async def post_knowledge_garden_draft_preview(request: Request, body: _KnowledgeGardenDraftBody):
    return await post_knowledge_garden_draft(request, body)


@router.get("/api/knowledge/garden-drafts")
async def get_knowledge_garden_drafts(
    request: Request,
    limit: int = 50,
    status: str = "draft_ready",
):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(client.list_garden_drafts, limit=limit, status=status)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    with _knowledge_conn() as conn:
        if status:
            rows = conn.execute(
                """SELECT * FROM garden_drafts WHERE status = ?
                   ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                            id DESC LIMIT ?""",
                (status, max(1, min(int(limit), 200))),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT * FROM garden_drafts
                   ORDER BY datetime(replace(substr(updated_at, 1, 19), 'T', ' ')) DESC,
                            id DESC LIMIT ?""",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            payload = _knowledge_normalized_card_payload(item)
            item["payload"] = payload
            item["one_liner"] = str(payload.get("claim") or "")
            items.append(item)
        return {"items": items, "total": len(items)}


@router.patch("/api/knowledge/garden-drafts/{draft_id}")
async def patch_knowledge_garden_draft(
    request: Request, draft_id: str, body: _KnowledgeGardenDraftUpdateBody
):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    updates = body.model_dump(exclude_none=True)
    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(client.update_garden_draft, draft_id, updates)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    garden_agent = _knowledge_custom_module("agents.garden_agent", "Garden agent")
    payload_mod = _knowledge_custom_module("agents.garden_card_payload", "Garden payload")
    repo_mod = _knowledge_custom_module("db.repo", "Capture repo")
    with _knowledge_conn() as conn:
        repo = repo_mod.CaptureRepo(conn)
        draft = garden_agent.get_garden_draft(repo, draft_id)
        if draft is None:
            raise HTTPException(status_code=404, detail="garden draft not found")
        merged = dict(payload_mod.payload_from_row(draft))
        merged.update({k: v for k, v in updates.items() if k != "markdown"})
        if "markdown" in updates:
            merged["content_markdown"] = str(updates["markdown"] or "").strip()
        else:
            merged["content_markdown"] = payload_mod.render_garden_card_body(merged).strip()
        updated = garden_agent.update_garden_draft(
            repo,
            draft_id,
            {
                "title": merged["title"],
                "card_kind": merged["card_kind"],
                "one_liner": merged["claim"],
                "payload": merged,
                "markdown": merged["content_markdown"],
            },
        )
        if updated is None:
            raise HTTPException(status_code=409, detail="garden draft is no longer open")
        item = dict(updated)
        item["payload"] = payload_mod.payload_from_row(item)
        item["one_liner"] = item["payload"]["claim"]
        return {"ok": True, "item": item}


@router.post("/api/knowledge/garden-drafts/{draft_id}/revise")
async def post_knowledge_garden_draft_revise(
    request: Request, draft_id: str, body: _KnowledgeGardenDraftReviseBody
):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.revise_garden_draft,
                draft_id,
                body.instruction.strip(),
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    return await _run_cancellable_ai_operation(
        request,
        "revise_garden_draft",
        lambda: garden_bridge.revise_garden_draft(
            draft_id=draft_id,
            instruction=body.instruction.strip(),
        ),
    )


@router.post("/api/knowledge/garden-drafts/{draft_id}/commit")
async def post_knowledge_garden_draft_commit(request: Request, draft_id: str):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            issued = await asyncio.to_thread(client.issue_garden_confirmation, draft_id)
            token = _garden_confirmation_token(issued)
            if not token:
                raise KnowledgeUnavailable(
                    "knowledge service did not return a garden confirmation token"
                )
            return await asyncio.to_thread(
                client.commit_garden_draft, draft_id, token,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    return _commit_local_garden_draft(garden_bridge, draft_id)


@router.delete("/api/knowledge/garden-drafts/{draft_id}")
async def delete_knowledge_garden_draft(request: Request, draft_id: str):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.discard_garden_draft(draft_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    with _knowledge_conn() as conn:
        cur = conn.execute(
            "UPDATE garden_drafts SET status = 'discarded', updated_at = datetime('now') WHERE id = ?",
            (draft_id,),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="garden draft not found")
        return {"ok": True, "draft_id": draft_id, "status": "discarded"}


@router.get("/api/knowledge/reading-drafts")
async def get_knowledge_reading_drafts(request: Request, limit: int = 50):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.list_reading_drafts(limit=max(1, min(limit, 200)))
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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


@router.get("/api/knowledge/reading-drafts/{draft_id}")
async def get_knowledge_reading_draft(request: Request, draft_id: str):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.get_reading_draft(draft_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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


@router.get("/api/knowledge/object-events")
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
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.object_events(object_type, object_id, limit=limit)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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


@router.post("/api/knowledge/reading-drafts/{draft_id}/commit")
async def post_knowledge_reading_draft_commit(request: Request, draft_id: str):
    _require_token(request)

    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            issued = await asyncio.to_thread(client.issue_confirmation, "reading/drafts", draft_id)
            token = str((issued or {}).get("token") or "").strip()
            if not token:
                raise KnowledgeUnavailable(
                    "knowledge service did not return a reading commit token"
                )
            return await asyncio.to_thread(
                client.commit_draft, "reading/drafts", draft_id, token,
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    reading_bridge = _knowledge_custom_module("bridge.reading_bridge", "Reading bridge")
    commit_reading_artifact = reading_bridge.commit_reading_artifact
    return await _run_cancellable_ai_operation(
        request,
        "reading.commit",
        lambda: commit_reading_artifact(
            draft_id=draft_id,
            # Dashboard click == confirmation; see the capture commit above.
            token_verified=True,
        ),
    )


@router.post("/api/knowledge/reading-drafts/{draft_id}/revise")
async def post_knowledge_reading_draft_revise(
    request: Request,
    draft_id: str,
    body: _KnowledgeDraftRevisionBody,
):
    _require_token(request)

    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(
                client.call_tool,
                "answer_bridge",
                "revise_answer_draft",
                kwargs={"draft_id": draft_id, "instruction": body.instruction},
                **_knowledge_http_operation_kwargs(request),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    answer_bridge = _knowledge_custom_module("bridge.answer_bridge", "Answer bridge")
    revise_answer_draft = answer_bridge.revise_answer_draft
    return await _run_cancellable_ai_operation(
        request,
        "reading.revise",
        lambda: revise_answer_draft(draft_id=draft_id, instruction=body.instruction),
    )


@router.delete("/api/knowledge/reading-drafts/{draft_id}")
async def delete_knowledge_reading_draft(request: Request, draft_id: str):
    _require_token(request)

    # HTTP mode: deleting a reading draft is a service write.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.delete_reading_draft(draft_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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


def _knowledge_legacy_card_fields(payload: dict) -> dict:
    """Project a v2 card payload into the legacy API fields."""
    judgments = payload.get("core_judgments") or []
    core_arguments = [
        {
            "claim": item.get("statement", ""),
            "consensus": True,
            "source_ids": [
                source_id
                for support in item.get("support") or []
                for source_id in support.get("source_ids") or []
            ],
        }
        for item in judgments
        if isinstance(item, dict)
    ]
    key_materials = [
        {
            "content": support.get("summary", ""),
            "capture_id": (support.get("source_ids") or [""])[0],
        }
        for judgment in judgments
        if isinstance(judgment, dict)
        for support in judgment.get("support") or []
        if isinstance(support, dict) and support.get("summary")
    ]
    return {
        "core_arguments": core_arguments,
        "knowledge_links": list(payload.get("related_card_ids") or []),
        "key_materials": key_materials,
        "my_view": "\n".join(f"- {item}" for item in payload.get("action_items") or []),
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
    if not payload:
        try:
            raw = json.loads(str(data.get("payload_json") or "{}"))
        except (TypeError, ValueError):
            raw = {}
        if isinstance(raw, dict):
            payload = raw
    legacy = _knowledge_legacy_card_fields(payload)
    capture_ids = payload.get("source_ids") or _json_value(str(data.get("capture_ids") or "[]"), [])
    core_arguments = legacy["core_arguments"]
    knowledge_links = legacy["knowledge_links"]
    key_materials = legacy["key_materials"]
    summary = str(payload.get("claim") or "").strip()
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
        "source_theme": str(data.get("source_theme") or ""),
        "core_arguments": core_arguments,
        "knowledge_links": knowledge_links,
        "key_materials": key_materials,
        "my_view": legacy["my_view"],
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
                "my_view": legacy["my_view"],
                "markdown": "",
            }
        )
    return card


@router.get("/api/knowledge/cards")
async def get_knowledge_cards(request: Request, limit: int = 100):
    _require_token(request)

    # HTTP mode: card reads come from the service.  Rebuild the response with
    # the local shape exactly ({"cards", "groups", "total"}): the service
    # returns {"items", "total"}, and ``groups`` is derived from card kinds the
    # same way the local branch derives it.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            payload = await asyncio.to_thread(
                client.list_garden_cards, limit=max(1, min(limit, 300))
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
        payload = payload if isinstance(payload, dict) else {}
        cards = payload.get("items")
        cards = cards if isinstance(cards, list) else []
        groups = {kind: 0 for kind in _KNOWLEDGE_CARD_KINDS}
        for card in cards:
            card_kind = str(card.get("kind") or "") if isinstance(card, dict) else ""
            if card_kind:
                groups[card_kind] = groups.get(card_kind, 0) + 1
        total = payload.get("total")
        return {
            "cards": cards,
            "groups": groups,
            "total": total if isinstance(total, int) else len(cards),
        }

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


@router.get("/api/knowledge/cards/{card_id}")
async def get_knowledge_card(request: Request, card_id: str):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            getter = getattr(client, "get_garden_card", client.get_card)
            return await asyncio.to_thread(getter, card_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
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


@router.patch("/api/knowledge/cards/{card_id}")
async def patch_knowledge_card(
    request: Request, card_id: str, body: _KnowledgeGardenCardUpdateBody
):
    _require_token(request)
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    updates = body.model_dump(exclude_none=True)
    try:
        client = await asyncio.to_thread(get_client)
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return await asyncio.to_thread(client.update_garden_card, card_id, updates)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()
    garden_agent = _knowledge_custom_module("agents.garden_agent", "Garden agent")
    payload_mod = _knowledge_custom_module("agents.garden_card_payload", "Garden payload")
    repo_mod = _knowledge_custom_module("db.repo", "Capture repo")
    vault_path = _knowledge_vault_path()
    with _knowledge_conn() as conn:
        row = conn.execute("SELECT * FROM garden_cards WHERE id = ?", (card_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Knowledge card not found")
        merged = dict(payload_mod.payload_from_row(row))
        if updates.get("title"):
            merged["title"] = str(updates["title"]).strip()[:80]
        if updates.get("card_kind"):
            merged["card_kind"] = str(updates["card_kind"]).strip()
        if "claim" in updates:
            merged["claim"] = str(updates["claim"] or "").strip()
        if "markdown" in updates:
            merged["content_markdown"] = str(updates["markdown"] or "").strip()
        repo = repo_mod.CaptureRepo(conn)
        updated = garden_agent.update_garden_card(
            repo,
            card_id,
            {
                "title": merged["title"],
                "card_kind": merged["card_kind"],
                "one_liner": merged["claim"],
                "payload": merged,
                "markdown": merged.get("content_markdown", ""),
            },
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="Knowledge card not found")
        if "source_theme" in updates:
            conn.execute(
                "UPDATE garden_cards SET source_theme = ? WHERE id = ?",
                (str(updates["source_theme"] or "").strip(), card_id),
            )
            conn.commit()
        fresh = conn.execute("SELECT * FROM garden_cards WHERE id = ?", (card_id,)).fetchone()
        return {"ok": True, "card": _knowledge_card_row(fresh, conn=conn, vault_path=vault_path, full=True)}


@router.delete("/api/knowledge/cards/{card_id}")
async def delete_knowledge_card(request: Request, card_id: str):
    _require_token(request)

    # HTTP mode: card deletion is a service write; its envelope ({"ok",
    # "status": "deleted", "id"}) is returned unchanged.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.delete_garden_card(card_id)
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    garden_bridge = _knowledge_custom_module("bridge.garden_bridge", "Garden bridge")
    archive_garden_card = garden_bridge.archive_garden_card
    return archive_garden_card(card_id=card_id)


@router.post("/api/knowledge/graph/refresh")
async def refresh_knowledge_graph(request: Request):
    _require_token(request)

    # HTTP mode: the graph rebuild runs inside the service, which owns the
    # graph DB; the response is the same graph payload the local branch returns.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.refresh_graph()
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

    graph_module = _knowledge_custom_module("agents.knowledge_graph", "Knowledge graph service")
    conn = _knowledge_graph_conn()
    try:
        return graph_module.KnowledgeGraphService(conn, _knowledge_vault_path()).refresh()
    finally:
        conn.close()


@router.get("/api/knowledge/graph")
async def get_knowledge_graph(
    request: Request,
    focus_kind: str = "",
    focus_id: str = "",
    depth: int = 1,
    limit: int = 80,
):
    _require_token(request)

    # HTTP mode: graph reads are served by the service.  Forward the same query
    # parameters and clamp them exactly like the local branch.
    from integrations.hermes_knowledge.client import KnowledgeUnavailable, get_client

    try:
        client = get_client()
    except KnowledgeUnavailable as exc:
        raise _knowledge_client_startup_error(exc) from exc
    if client is not None:
        try:
            return client.graph(
                focus_kind=focus_kind,
                focus_id=focus_id,
                depth=depth,
                limit=max(1, min(limit, 120)),
            )
        except KnowledgeUnavailable as exc:
            raise _knowledge_client_operation_error(exc) from exc
        finally:
            client.close()

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


