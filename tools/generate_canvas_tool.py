"""Hermes tool: generate_canvas — advanced Knowledge Canvas relationship maps."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

GENERATE_CANVAS_SCHEMA = {
    "name": "generate_canvas",
    "description": (
        "高级/内部工具：为 Hermes Knowledge 生成 Canvas 关系图/画板文件。"
        "新版 Hermes Knowledge 主流程不主动推荐 Canvas；只有用户明确要求"
        "“生成 Canvas”“做成关系图”“把这个主题做成画板”时才调用。"
        "本工具只生成 .canvas 文件，不改写原笔记内容。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "theme": {
                "type": "string",
                "description": "Theme View 名称或自然语言主题。",
            },
            "question_id": {
                "type": "string",
                "description": "可选，Theme candidate 的 pending question id。",
            },
            "capture_ids": {"type": "array", "items": {"type": "string"}},
            "garden_card_ids": {"type": "array", "items": {"type": "string"}},
            "export_file": {
                "type": "boolean",
                "description": "只有用户明确要求把 Canvas 文件作为附件发出时才设为 true；普通生成到 Knowledge File storage 保持 false。",
            },
        },
        "required": [],
    },
}


def generate_canvas(**kwargs):
    return call_custom_bridge("canvas_bridge", "generate_canvas", **kwargs)


def _handler(args: dict, **kw) -> str:
    try:
        result = generate_canvas(
            theme=args.get("theme", ""),
            question_id=args.get("question_id", ""),
            capture_ids=args.get("capture_ids"),
            garden_card_ids=args.get("garden_card_ids"),
            export_file=bool(args.get("export_file", False)),
        )
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="canvas", intent="generate_canvas", exc=exc)


registry.register(
    name="generate_canvas",
    toolset="knowledge-advanced",
    schema=GENERATE_CANVAS_SCHEMA,
    handler=_handler,
    emoji="🗺️",
)
