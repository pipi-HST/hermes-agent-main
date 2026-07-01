"""Hermes tool: review_followup — expand the latest daily review item."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

REVIEW_FOLLOWUP_SCHEMA = {
    "name": "review_followup",
    "description": (
        "用于 daily_review 之后的追问，只沿着刚刚讲过的回顾项展开。"
        "用户在每日回顾后说“展开一下”“讲深一点”“举例”“这对我有什么启发”时调用。"
        "本工具只读取最近讲过的那一篇/那一节，不做全库搜索。"
        "如果用户明确要求“对比”“关联其他文章”“找相关材料”“还有哪些文章”，"
        "才改用 search_my_notes 做横向检索。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "用户对刚刚每日回顾内容的原始追问。",
            },
        },
        "required": ["question"],
    },
}


def expand_latest_review_followup(question: str):
    return call_custom_bridge("review_bridge", "expand_latest_review_followup", question)


def _handler(args: dict, **kw) -> str:
    try:
        result = expand_latest_review_followup(args.get("question", ""))
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="review", intent="expand_latest_review_followup", exc=exc)


registry.register(
    name="review_followup",
    toolset="knowledge-review",
    schema=REVIEW_FOLLOWUP_SCHEMA,
    handler=_handler,
    emoji="🔎",
)
