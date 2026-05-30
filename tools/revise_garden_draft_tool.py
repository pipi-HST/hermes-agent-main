"""Hermes tool: revise_garden_draft — 修改 Garden 观点草稿."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.garden_bridge import revise_garden_draft as do_revise
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

REVISE_GARDEN_DRAFT_SCHEMA = {
    "name": "revise_garden_draft",
    "description": (
        "根据用户修改意见更新最近或指定的 Garden 观点草稿。"
        "适用于用户对刚生成的 Garden 草稿说“不满意/改一下/补充/强调某点”。"
        "不要用它修改 Capture 草稿。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "Garden 草稿 ID；为空时默认最近一个未入库 Garden 草稿。",
            },
            "instruction": {
                "type": "string",
                "description": "用户的具体修改意见。",
            },
        },
        "required": ["instruction"],
    },
}


def _handler(params: dict, **kw) -> str:
    try:
        result = do_revise(
            draft_id=params.get("draft_id", ""),
            instruction=params.get("instruction", ""),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="garden", intent="revise_garden_draft", exc=exc)


registry.register(
    name=REVISE_GARDEN_DRAFT_SCHEMA["name"],
    schema=REVISE_GARDEN_DRAFT_SCHEMA,
    handler=_handler,
    toolset="personal-assistant",
)
