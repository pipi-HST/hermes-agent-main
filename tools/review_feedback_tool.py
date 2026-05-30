"""Hermes tool: review_feedback — record knowledge review feedback."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.review_bridge import record_review_feedback
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

REVIEW_FEEDBACK_SCHEMA = {
    "name": "review_feedback",
    "description": (
        "记录用户对每日回顾讲解的偏好。用户回复有用、以后再讲、不用复习、讲深一点，"
        "并给出复习项编号时调用。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "item_id": {
                "type": "string",
                "description": "daily_review 返回的复习项编号。",
            },
            "outcome": {
                "type": "string",
                "enum": ["useful", "revisit", "mute", "deeper"],
                "description": (
                    "用户反馈：有用=useful，以后再讲=revisit，不用复习=mute，"
                    "讲深一点=deeper。"
                ),
            },
        },
        "required": ["item_id", "outcome"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = record_review_feedback(
            item_id=str(args.get("item_id") or "").strip(),
            outcome=str(args.get("outcome") or "").strip(),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="review", intent="record_review_feedback", exc=exc)


registry.register(
    name="review_feedback",
    toolset="personal-assistant",
    schema=REVIEW_FEEDBACK_SCHEMA,
    handler=_handler,
    emoji="🧠",
)
