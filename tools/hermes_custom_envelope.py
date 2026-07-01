"""Helpers for Hermes custom Agent Result Envelope tools."""

from __future__ import annotations

import json
import importlib
import os
import sys
from typing import Any

DEFAULT_HERMES_CUSTOM_ROOT = "/Users/pipi/hermes-custom"


def ensure_hermes_custom_path() -> None:
    custom_root = os.environ.get("HERMES_CUSTOM_ROOT", DEFAULT_HERMES_CUSTOM_ROOT)
    if custom_root not in sys.path:
        sys.path.insert(0, custom_root)


def _load_result_envelope():
    ensure_hermes_custom_path()
    from bridge.result_envelope import envelope_json, error_envelope

    return envelope_json, error_envelope


def _sanitize_error(message: str) -> str:
    try:
        from model_tools import _sanitize_tool_error
    except Exception:
        return message
    return _sanitize_tool_error(message)


def envelope_success_json(payload: dict[str, Any]) -> str:
    try:
        envelope_json, _ = _load_result_envelope()
        return envelope_json(payload)
    except Exception:
        return json.dumps(payload, ensure_ascii=False)


def call_custom_bridge(module_name: str, function_name: str, *args, **kwargs):
    ensure_hermes_custom_path()
    module = importlib.import_module(f"bridge.{module_name}")
    function = getattr(module, function_name)
    return function(*args, **kwargs)


def envelope_error_json(*, agent: str, intent: str, exc: Exception, meta: dict[str, Any] | None = None) -> str:
    error = _sanitize_error(f"{type(exc).__name__}: {exc}")
    error_meta = {
        "exception_type": type(exc).__name__,
        **(meta or {}),
    }
    try:
        envelope_json, error_envelope = _load_result_envelope()
        return envelope_json(
            error_envelope(
                agent=agent,
                intent=intent,
                error=error,
                chat_preview=f"工具执行失败：{error}",
                meta=error_meta,
            )
        )
    except Exception:
        return json.dumps(
            {
                "status": "error",
                "agent": agent,
                "intent": intent,
                "chat_preview": f"工具执行失败：{error}",
                "durable_artifacts": [],
                "source_map": [],
                "next_actions": [],
                "warnings": [],
                "errors": [error],
                "meta": error_meta,
            },
            ensure_ascii=False,
        )
