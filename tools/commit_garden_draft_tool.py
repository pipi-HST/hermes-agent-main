"""Hermes tool: commit_garden_draft — 确认 Knowledge Card 草稿入库."""
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
        "在用户明确确认后，把 Knowledge Card 草稿写入知识卡片库。"
        "会创建 garden_cards 记录并写入 Obsidian garden/*.md。"
        "只有用户说“确认卡片/存入知识卡片/可以入库”这类确认语义时才调用。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "Knowledge Card 草稿 ID；为空时默认最近一个未入库知识卡片草稿。",
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
