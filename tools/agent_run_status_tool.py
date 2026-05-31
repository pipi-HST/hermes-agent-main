"""Hermes tool: agent_run_status — show recent Hermes Agent runs."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.agent_run_bridge import get_agent_run_status
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

AGENT_RUN_STATUS_SCHEMA = {
    "name": "agent_run_status",
    "description": (
        "查看最近 Hermes 知识库 Agent 实际运行记录。"
        "当用户问“刚刚跑了什么”“RAG 查了哪些材料”“这个任务有没有执行成功”"
        "或需要排查工具调用路径时调用。"
        "如果用户问“刚刚/上一次”查了什么，传 limit=1。"
        "返回后应原样返回 USER_VISIBLE_REPLY 中的来源列表，"
        "不要改写成表格，不要合并重复行，不要使用“同上”。只读，不会修改知识库。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "返回最近多少条运行记录，默认 5，最大 10。",
            }
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = get_agent_run_status(limit=int(args.get("limit") or 5))
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="system", intent="agent_run_status", exc=exc)


registry.register(
    name="agent_run_status",
    toolset="personal-assistant",
    schema=AGENT_RUN_STATUS_SCHEMA,
    handler=_handler,
    emoji="🧾",
)
