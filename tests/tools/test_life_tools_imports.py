"""Life tools must not depend on a hard-coded checkout path.

The tools are registered at import time on every machine, so importing them
must never touch ``sys.path``.  The hermes-life checkout is resolved from
``HERMES_LIFE_ROOT`` on the first tool call; a missing or invalid checkout must
surface as a tool error envelope, not as an exception or a broken registration.
"""
from __future__ import annotations

import importlib
import json
import sys

import pytest


def _import_tools():
    sys.modules.pop("tools.record_life_event_tool", None)
    sys.modules.pop("tools.life_tick_tool", None)
    record_tool = importlib.import_module("tools.record_life_event_tool")
    tick_tool = importlib.import_module("tools.life_tick_tool")
    return record_tool, tick_tool


@pytest.fixture()
def life_env(monkeypatch):
    """Isolate the life/custom checkout env and restore import state after."""
    for key in ("HERMES_LIFE_ROOT", "HERMES_CUSTOM_ROOT", "HERMES_KNOWLEDGE_LOCAL_ROOT"):
        monkeypatch.delenv(key, raising=False)
    saved_path = list(sys.path)
    saved_modules = {
        name: module
        for name, module in sys.modules.items()
        if name == "hermes_life" or name.startswith("hermes_life.")
    }
    for name in list(saved_modules):
        sys.modules.pop(name, None)
    try:
        yield monkeypatch
    finally:
        sys.path[:] = saved_path
        for name in [
            name
            for name in list(sys.modules)
            if name == "hermes_life" or name.startswith("hermes_life.")
        ]:
            sys.modules.pop(name, None)
        sys.modules.update(saved_modules)


def test_import_registers_tools_without_sys_path_side_effects(life_env):
    from tools.registry import registry

    record_tool, tick_tool = _import_tools()

    assert callable(record_tool._handler)
    assert callable(tick_tool._handler)
    # Tool registration must survive an unconfigured checkout.
    assert registry.get_schema("record_life_event") is not None
    assert registry.get_schema("life_tick") is not None
    assert "/Users/pipi/hermes-life" not in sys.path
    assert not any("hermes-life" in path for path in sys.path)


def test_unconfigured_life_root_returns_error_envelope(life_env):
    record_tool, tick_tool = _import_tools()

    record_payload = json.loads(record_tool._handler({"message": "午饭吃了牛肉饭"}))
    tick_payload = json.loads(tick_tool._handler({"dry_run": True}))

    for payload in (record_payload, tick_payload):
        rendered = json.dumps(payload, ensure_ascii=False)
        assert payload["status"] == "error"
        assert "HERMES_LIFE_ROOT" in rendered


def test_invalid_life_root_returns_error_envelope(life_env, tmp_path):
    record_tool, _tick_tool = _import_tools()

    for bad_root in ("relative/hermes-life", str(tmp_path / "missing-hermes-life")):
        life_env.setenv("HERMES_LIFE_ROOT", bad_root)
        payload = json.loads(record_tool._handler({"message": "记一下"}))
        rendered = json.dumps(payload, ensure_ascii=False)
        assert payload["status"] == "error"
        assert "HERMES_LIFE_ROOT" in rendered


def test_configured_life_root_makes_tool_calls_work(life_env, tmp_path):
    life_root = tmp_path / "hermes-life"
    package_dir = life_root / "hermes_life"
    bridge_dir = package_dir / "bridge"
    bridge_dir.mkdir(parents=True)
    (package_dir / "__init__.py").write_text("", encoding="utf-8")
    (bridge_dir / "__init__.py").write_text("", encoding="utf-8")
    (bridge_dir / "life_bridge.py").write_text(
        "def life_tick(**kwargs):\n"
        "    return {'status': 'ok', 'dry_run': kwargs.get('dry_run'), 'now': kwargs.get('now')}\n"
        "\n"
        "def record_life_event(message, received_at=''):\n"
        "    return {'status': 'ok', 'message': message, 'received_at': received_at}\n",
        encoding="utf-8",
    )
    (bridge_dir / "result_envelope.py").write_text(
        "import json\n"
        "\n"
        "def envelope_json(payload):\n"
        "    return json.dumps({'envelope': payload}, ensure_ascii=False)\n",
        encoding="utf-8",
    )
    life_env.setenv("HERMES_LIFE_ROOT", str(life_root))

    record_tool, tick_tool = _import_tools()

    # Import alone must not add the checkout to sys.path.
    assert str(life_root) not in sys.path

    tick_payload = json.loads(tick_tool._handler({"dry_run": True}))
    record_payload = json.loads(record_tool._handler({"message": "午饭吃了牛肉饭"}))

    assert str(life_root) in sys.path
    assert tick_payload == {
        "envelope": {"status": "ok", "dry_run": True, "now": ""},
    }
    assert record_payload == {
        "envelope": {
            "status": "ok",
            "message": "午饭吃了牛肉饭",
            "received_at": "",
        },
    }
