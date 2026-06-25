"""Hermes tool: synthesize_garden — 合成 Knowledge Card 草稿."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.garden_bridge import synthesize_garden as do_synthesize
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

SYNTHESIZE_GARDEN_SCHEMA = {
    "name": "synthesize_garden",
    "description": (
        "从知识库材料或阅读讨论中提炼一张可审阅的 Knowledge Card 草稿。"
        "卡片只保存可复用知识对象，不是文章摘要；类型为观点卡、事实卡、方法卡或风险卡。"
        "用户没指定类型时由系统判断，不要为了确定类型追问用户。"
        "它不会直接写入最终知识卡片；用户确认“确认卡片/存入知识卡片”后，"
        "再调用 commit_garden_draft。用户提出修改意见时调用 revise_garden_draft。"
        "可指定 capture_ids 直接合成；question_id 仅用于高级 Theme 候选流。"
        "用户刚确认 Capture 草稿入库后要生成卡片时，必须使用 commit_capture_draft "
        "返回的 capture_id/committed_capture_id，不要使用 draft_id。"
        "如果工具返回失败，不要减少 capture_ids 后静默重试；应明确告诉用户合成失败，"
        "并保留原始材料范围，等待用户确认是否缩小范围。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "capture_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要合成的 capture ID 列表（与 question_id 二选一）",
            },
            "question_id": {
                "type": "string",
                "description": "高级 Theme 候选问题 ID；普通知识卡片生成不要使用。",
            },
            "title": {
                "type": "string",
                "description": "可选，卡片标题；不填则由 LLM 自动生成",
            },
            "card_kind": {
                "type": "string",
                "enum": ["viewpoint", "fact", "method", "risk"],
                "description": "可选系统提示，指定知识卡片类型；不填则由系统判断，不要要求用户先选择类型。",
            },
            "export_file": {
                "type": "boolean",
                "description": "只有用户明确要求把知识卡片草稿发成文件/附件时才设为 true；普通生成草稿保持 false。",
            },
        },
        "required": [],
    },
}


def _handler(params: dict, **kw) -> str:
    try:
        result = do_synthesize(
            capture_ids=params.get("capture_ids"),
            question_id=params.get("question_id", ""),
            title=params.get("title", ""),
            card_kind=params.get("card_kind", ""),
            export_file=bool(params.get("export_file", False)),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="garden", intent="synthesize_garden", exc=exc)


registry.register(
    name=SYNTHESIZE_GARDEN_SCHEMA["name"],
    schema=SYNTHESIZE_GARDEN_SCHEMA,
    handler=_handler,
    toolset="personal-assistant",
)
