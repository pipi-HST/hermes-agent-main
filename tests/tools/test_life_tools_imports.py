from __future__ import annotations

import importlib
import sys


def test_life_tools_use_hermes_life_project_path():
    sys.modules.pop("tools.record_life_event_tool", None)
    sys.modules.pop("tools.life_tick_tool", None)

    record_tool = importlib.import_module("tools.record_life_event_tool")
    tick_tool = importlib.import_module("tools.life_tick_tool")

    assert "/Users/pipi/hermes-life" in record_tool.sys.path
    assert "/Users/pipi/hermes-life" in tick_tool.sys.path

