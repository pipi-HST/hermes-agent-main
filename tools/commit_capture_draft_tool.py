"""Hermes tool: commit_capture_draft — 确认草稿入库."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.capture_bridge import commit_capture_draft
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

COMMIT_CAPTURE_DRAFT_SCHEMA = {
    "name": "commit_capture_draft",
    "description": (
        "只在用户已经看到待审草稿后，又用一条独立消息明确确认“确认存库/存库/入库/就这样”时调用。"
        "如果用户在同一条消息里说“提取并入库/整理后存库”，仍应先调用 capture_content 生成待审草稿，"
        "不要在同一轮继续调用本工具。把最近或指定草稿提交为知识库正式记录，并保留来源材料正文。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "要入库的草稿编号（可选，不填则提交最近未入库草稿）",
            },
            "confirmation": {
                "type": "string",
                "description": "用户最新一条独立确认消息原文，例如“确认存库”。不要传生成草稿那条消息里的整理要求。",
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = commit_capture_draft(
            args.get("draft_id", ""),
            confirmation=args.get("confirmation", ""),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="commit_capture_draft", exc=exc)


registry.register(
    name="commit_capture_draft",
    toolset="personal-assistant",
    schema=COMMIT_CAPTURE_DRAFT_SCHEMA,
    handler=_handler,
    emoji="📚",
)
