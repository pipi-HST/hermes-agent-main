"""Hermes tool: review_feedback — record knowledge review feedback."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

REVIEW_FEEDBACK_SCHEMA = {
    "name": "review_feedback",
    "description": (
        "记录用户对每日回顾讲解的偏好。只在用户明确回复有用、以后再讲、不用复习"
        "这类偏好反馈时调用；未给 item_id 时默认作用于最近讲过的回顾项。"
        "不要用于展开一下、举例、对比、这对我有什么启发、讲深一点等内容追问。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "item_id": {
                "type": "string",
                "description": "可选。daily_review 返回的复习项编号；不填则使用最近讲过的回顾项。",
            },
            "outcome": {
                "type": "string",
                "enum": ["useful", "revisit", "mute"],
                "description": (
                    "用户偏好反馈：有用=useful，以后再讲=revisit，不用复习=mute。"
                ),
            },
        },
        "required": ["outcome"],
    },
}


def record_review_feedback(**kwargs):
    return call_custom_bridge("review_bridge", "record_review_feedback", **kwargs)


def _handler(args: dict, **kw) -> str:
    try:
        result = record_review_feedback(
            item_id=str(args.get("item_id") or "").strip(),
            outcome=str(args.get("outcome") or "").strip(),
        )
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="review", intent="record_review_feedback", exc=exc)


registry.register(
    name="review_feedback",
    toolset="knowledge-review",
    schema=REVIEW_FEEDBACK_SCHEMA,
    handler=_handler,
    emoji="🧠",
)
