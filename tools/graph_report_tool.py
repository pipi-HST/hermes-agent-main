"""Hermes tool: graph_report — 知识图谱健康报告."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

GRAPH_REPORT_SCHEMA = {
    "name": "graph_report",
    "description": "生成知识图谱健康报告：总笔记数、主题数、孤岛笔记、桥接笔记、连接率。",
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}


def run_graph_report():
    return call_custom_bridge("theme_bridge", "run_graph_report")


def _handler(args: dict, **kw) -> str:
    try:
        result = run_graph_report()
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="theme", intent="run_graph_report", exc=exc)


registry.register(
    name="graph_report",
    toolset="personal-assistant",
    schema=GRAPH_REPORT_SCHEMA,
    handler=_handler,
    emoji="📊",
)
