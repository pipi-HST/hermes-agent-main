"""Hermes tool: theme_candidates — existing Theme map candidates."""
from __future__ import annotations

import sys

sys.path.insert(0, "/Users/pipi/hermes-custom")

from bridge.result_envelope import envelope_json
from bridge.theme_bridge import list_theme_candidates
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

THEME_CANDIDATES_SCHEMA = {
    "name": "theme_candidates",
    "description": (
        "展示已有 Theme 候选组：读取前一次 theme_scan 生成的主题关联候选，"
        "用于继续从某个主题方向生成 Knowledge Card 草稿。"
        "当用户在 theme_scan 返回“没有待扫描的新内容”后问"
        "“有哪些内容”“有哪些组”“第一组是哪组”时调用。"
        "本工具只读取已经由 Theme Agent 生成的 pending candidates，不做全库搜索。"
        "如果用户回复“第一组/第二组”等编号，应使用返回 next_actions 里的 question_id "
        "调用 synthesize_garden，不要用 search_my_notes 重新拼材料。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "最多展示多少组，默认 5，最大 10。",
            }
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = list_theme_candidates(limit=int(args.get("limit") or 5))
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="theme", intent="list_theme_candidates", exc=exc)


registry.register(
    name="theme_candidates",
    toolset="knowledge-advanced",
    schema=THEME_CANDIDATES_SCHEMA,
    handler=_handler,
    emoji="🌱",
)
