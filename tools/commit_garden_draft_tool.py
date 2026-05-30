"""Hermes tool: commit_garden_draft — 确认 Garden 草稿入库."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.garden_bridge import commit_garden_draft as do_commit
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

COMMIT_GARDEN_DRAFT_SCHEMA = {
    "name": "commit_garden_draft",
    "description": (
        "在用户明确确认后，把 Garden 观点草稿写入知识花园。"
        "会创建 garden_cards 记录并写入 Obsidian garden/*.md。"
        "只有用户说“确认观点/存入花园/可以入库”这类确认语义时才调用。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "Garden 草稿 ID；为空时默认最近一个未入库 Garden 草稿。",
            },
        },
        "required": [],
    },
}


def _handler(params: dict, **kw) -> str:
    try:
        result = do_commit(draft_id=params.get("draft_id", ""))
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="garden", intent="commit_garden_draft", exc=exc)


registry.register(
    name=COMMIT_GARDEN_DRAFT_SCHEMA["name"],
    schema=COMMIT_GARDEN_DRAFT_SCHEMA,
    handler=_handler,
    toolset="personal-assistant",
)
