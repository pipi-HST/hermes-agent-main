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
        "记录用户对复习问题的反馈。用户回复记得、忘了、跳过或掌握，并给出复习项编号时调用。"
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
                "enum": ["remembered", "forgotten", "skip", "mastered"],
                "description": "用户反馈：记得=remembered，忘了=forgotten，跳过=skip，掌握=mastered。",
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
