"""Hermes tool: show_capture_draft — 查看待确认捕获草稿."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.capture_bridge import show_capture_draft
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

SHOW_CAPTURE_DRAFT_SCHEMA = {
    "name": "show_capture_draft",
    "description": (
        "只用于待确认 Capture 草稿：查看最近或指定的未入库捕获草稿正文。"
        "用户说“展开草稿”“查看草稿”“看草稿全文”“继续看草稿”时调用。"
        "不要在 capture_content 或 revise_capture_draft 成功后自动调用；"
        "只有用户明确要求展开/看全文/继续看待确认草稿时才调用。"
        "不要用于 daily_review、Review 回顾项、已入库文章或知识库追问；"
        "用户在 Review 后说“展开一下”“讲深一点”“举例”时，应使用 review_followup。"
        "只读未入库草稿，不正式入库；入库仍需要用户明确回复“存库”。"
        "不要把 search_my_notes 返回的 capture_note/capture_section id 当成 draft_id；"
        "已入库知识库内容应继续使用 search_my_notes 回答。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "要查看的草稿编号（可选，不填则查看最近未入库草稿）",
            },
            "page": {
                "type": "integer",
                "description": "页码，从 1 开始；用户说“继续看”时查看下一页。",
            },
        },
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = show_capture_draft(
            args.get("draft_id", ""),
            args.get("page", 1),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="show_capture_draft", exc=exc)


registry.register(
    name="show_capture_draft",
    toolset="personal-assistant",
    schema=SHOW_CAPTURE_DRAFT_SCHEMA,
    handler=_handler,
    emoji="📖",
)
