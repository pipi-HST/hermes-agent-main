"""Hermes tool: commit_capture_draft — 确认草稿保存."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

COMMIT_CAPTURE_DRAFT_SCHEMA = {
    "name": "commit_capture_draft",
    "description": (
        "只在用户已经看到待审草稿后，又用一条独立消息明确确认“确认存库/存库/保存/就这样”时调用。"
        "如果用户在同一条消息里说“提取并保存/整理后存库”，仍应先调用 capture_content 生成待审草稿，"
        "不要在同一轮继续调用本工具。把最近或指定草稿提交为知识库正式记录，并保留来源材料正文。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "要保存的草稿编号（可选，不填则提交最近未保存草稿）",
            },
        },
        "required": [],
    },
}


def commit_capture_draft(*args, **kwargs):
    return call_custom_bridge("capture_bridge", "commit_capture_draft", *args, **kwargs)


def _handler(args: dict, **kw) -> str:
    try:
        result = commit_capture_draft(
            args.get("draft_id", ""),
            confirmation=kw.get("user_task", ""),
        )
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="commit_capture_draft", exc=exc)


registry.register(
    name="commit_capture_draft",
    toolset="personal-assistant",
    schema=COMMIT_CAPTURE_DRAFT_SCHEMA,
    handler=_handler,
    emoji="📚",
)
