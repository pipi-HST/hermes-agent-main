"""Hermes tool: theme_scan — 手动触发主题聚类."""
from __future__ import annotations

import sys
sys.path.insert(0, "/Users/pipi/hermes-custom")

from bridge.theme_bridge import run_theme_scan
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

THEME_SCAN_SCHEMA = {
    "name": "theme_scan",
    "description": (
        "手动触发知识库主题聚类扫描，发现最近保存内容之间的关联。"
        "默认只扫描最近未扫描的新内容；当用户明确要求“重建主题页”"
        "“扫描全部知识库”“重新整理主题/MOC”时，传 rescan_all=true。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "rescan_all": {
                "type": "boolean",
                "description": (
                    "是否重扫已扫描过的 captures。默认 false；只有用户明确要求"
                    "重建/扫描全部/重新整理主题页时才设为 true。"
                ),
            }
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = run_theme_scan(rescan_all=bool(args.get("rescan_all")))
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="theme", intent="run_theme_scan", exc=exc)


registry.register(
    name="theme_scan",
    toolset="personal-assistant",
    schema=THEME_SCAN_SCHEMA,
    handler=_handler,
    emoji="🔗",
)
