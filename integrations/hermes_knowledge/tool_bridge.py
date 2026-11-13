"""Dispatch Hermes custom-bridge calls to a local checkout or the service.

The custom-envelope tools all funnel through
``tools.hermes_custom_envelope.call_custom_bridge(module, function, *args,
**kwargs)``.  Historically that imported ``bridge.<module>`` from a local
checkout inserted on ``sys.path``.  When ``HERMES_KNOWLEDGE_URL`` is configured
no local checkout exists, so the call is dispatched to the Knowledge Service's
whitelisted tool endpoint (``POST /api/tools/{module}/{function}``) instead.

Local mode keeps the exact previous behaviour: ``ensure_custom_path()`` then a
plain ``bridge.<module>`` import and call.
"""
from __future__ import annotations

import importlib
import json
from typing import Any

from integrations.hermes_knowledge import KnowledgeUnavailable, ensure_custom_path
from integrations.hermes_knowledge.client import get_client


def _raise_not_serializable(module_name: str, function_name: str, where: str, exc: Exception) -> None:
    raise KnowledgeUnavailable(
        f"cannot dispatch {module_name}.{function_name}: {where} is not JSON "
        f"serializable: {exc}"
    ) from exc


def _normalise_value(module_name: str, function_name: str, where: str, value: Any) -> Any:
    """Return a JSON-safe form of ``value`` for the HTTP dispatch payload.

    Bridge kwargs may carry ``Path`` objects or other non-JSON-native values
    (the local bridge accepts them directly).  ``default=str`` converts those,
    matching what the service-side bridge would see as strings; values that even
    that cannot encode (recursive structures) raise a typed error naming the
    offending key/position.
    """
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        pass
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError) as exc:
        _raise_not_serializable(module_name, function_name, where, exc)
        raise  # unreachable, keeps type checkers happy


def _normalise_call(
    module_name: str,
    function_name: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> tuple[list[Any], dict[str, Any]]:
    safe_args = [
        _normalise_value(module_name, function_name, f"positional argument {index}", value)
        for index, value in enumerate(args)
    ]
    safe_kwargs = {
        key: _normalise_value(module_name, function_name, f"argument '{key}'", value)
        for key, value in kwargs.items()
    }
    return safe_args, safe_kwargs


def dispatch(module_name: str, function_name: str, *args, **kwargs) -> Any:
    """Call ``bridge.<module>.<function>`` locally or via the knowledge service.

    ``get_client()`` is the single mode switch used across the knowledge
    integration: ``None`` means HTTP mode is not configured, so the local
    checkout path is used exactly as before.  In HTTP mode the client is always
    closed after the call (success or failure) so no connection leaks between
    tool invocations.
    """
    client = get_client()
    if client is None:
        ensure_custom_path()
        module = importlib.import_module(f"bridge.{module_name}")
        function = getattr(module, function_name)
        return function(*args, **kwargs)

    try:
        safe_args, safe_kwargs = _normalise_call(module_name, function_name, args, kwargs)
        return client.call_tool(
            module_name,
            function_name,
            args=safe_args,
            kwargs=safe_kwargs,
        )
    finally:
        client.close()
