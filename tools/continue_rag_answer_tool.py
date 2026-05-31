"""Hermes tool: continue_rag_answer — continue latest RAG answer."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.rag_continue_bridge import continue_latest_rag_answer
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

CONTINUE_RAG_ANSWER_SCHEMA = {
    "name": "continue_rag_answer",
    "description": (
        "继续展开上一条 RAG 知识库回答的后续内容。"
        "当用户在知识库回答后说“继续展开”“展开全文”“接着说”“后面呢”时调用。"
        "本工具只读取上一条 RAG 完整答案的下一页，不要重新检索、不要改写成新的 search_my_notes 查询。"
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = continue_latest_rag_answer()
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="rag", intent="continue_rag_answer", exc=exc)


registry.register(
    name="continue_rag_answer",
    toolset="personal-assistant",
    schema=CONTINUE_RAG_ANSWER_SCHEMA,
    handler=_handler,
    emoji="📖",
)
