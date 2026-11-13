"""Hermes tool: commit_garden_draft — 确认 Knowledge Card 草稿入库."""
from __future__ import annotations

from tools.hermes_custom_envelope import (
    envelope_error_json,
    envelope_success_json,
)
from tools.registry import registry

COMMIT_GARDEN_DRAFT_SCHEMA = {
    "name": "commit_garden_draft",
    "description": (
        "在用户明确确认后，把 Knowledge Card 草稿写入知识卡片库。"
        "会创建 garden_cards 结构化记录；默认不写常驻 Markdown 卡片文件。"
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


def do_commit(**kwargs):
    from tools.hermes_custom_envelope import call_custom_bridge

    return call_custom_bridge("garden_bridge", "commit_garden_draft", **kwargs)


def _handler(params: dict, **kw) -> str:
    try:
        result = do_commit(
            draft_id=params.get("draft_id", ""),
            confirmation=kw.get("user_task", ""),
        )
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="garden", intent="commit_garden_draft", exc=exc)


registry.register(
    name=COMMIT_GARDEN_DRAFT_SCHEMA["name"],
    schema=COMMIT_GARDEN_DRAFT_SCHEMA,
    handler=_handler,
    toolset="personal-assistant",
)
