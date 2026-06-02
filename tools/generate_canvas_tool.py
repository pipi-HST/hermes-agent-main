"""Hermes tool: generate_canvas — generate Obsidian Canvas relationship maps."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.canvas_bridge import generate_canvas
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

GENERATE_CANVAS_SCHEMA = {
    "name": "generate_canvas",
    "description": (
        "为 Obsidian 知识库生成 Canvas 关系图/画板。"
        "当用户说“生成 Canvas”“做成关系图”“把这个主题做成画板”时调用。"
        "当用户说“Garden Card 可视化”“知识卡片画布”“卡片聚类图”时，不要硬找 Theme/MOC，"
        "直接调用本工具并把 theme 留空，工具会以 Garden cards 为主角生成聚类 Canvas。"
        "当用户明确指定主题/MOC 时，围绕 Theme/MOC 展开。"
        "本工具只生成 .canvas 文件，不改写原笔记内容。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "theme": {
                "type": "string",
                "description": "主题/MOC 名称或自然语言主题。",
            },
            "question_id": {
                "type": "string",
                "description": "可选，Theme candidate 的 pending question id。",
            },
            "capture_ids": {"type": "array", "items": {"type": "string"}},
            "garden_card_ids": {"type": "array", "items": {"type": "string"}},
            "export_file": {
                "type": "boolean",
                "description": "只有用户明确要求把 Canvas 文件作为附件发出时才设为 true；普通生成到 Obsidian 保持 false。",
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = generate_canvas(
            theme=args.get("theme", ""),
            question_id=args.get("question_id", ""),
            capture_ids=args.get("capture_ids"),
            garden_card_ids=args.get("garden_card_ids"),
            export_file=bool(args.get("export_file", False)),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="canvas", intent="generate_canvas", exc=exc)


registry.register(
    name="generate_canvas",
    toolset="personal-assistant",
    schema=GENERATE_CANVAS_SCHEMA,
    handler=_handler,
    emoji="🗺️",
)
