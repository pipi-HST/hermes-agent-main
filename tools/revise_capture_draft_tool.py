"""Hermes tool: revise_capture_draft — 修改待确认捕获草稿."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.capture_bridge import revise_capture_draft
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

REVISE_CAPTURE_DRAFT_SCHEMA = {
    "name": "revise_capture_draft",
    "description": (
        "按用户反馈修改最近或指定的捕获草稿。把用户修改要求的原话尽量完整放入 instruction，"
        "不要自行压缩、改写或把“着重阐述”改成“只保留”。例如“再短一点”“聚焦某部分”"
        "“不要泛泛总结”。只更新草稿，不正式入库。"
        "只有用户明确是在修改已经生成的草稿时才调用本工具。"
        "如果用户是在发送新文档、新链接、新图片，或要求整理/总结刚发送的文件路径，"
        "应调用 capture_content(content=文件路径或链接, instruction=用户原话)，不要调用本工具。"
        "若用户针对已入库文章继续修改，"
        "可把该文章的 capture_id 作为 draft_id 传入，工具会基于原文和已入库笔记创建修订草稿。"
        "工具会生成待确认整理稿并返回微信可读预览。修改成功后直接把工具返回的 USER_VISIBLE_REPLY "
        "发给用户，不要自动调用 show_capture_draft；用户后续明确要求“展开草稿/查看草稿/看全文/继续看”"
        "时才调用 show_capture_draft。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {
                "type": "string",
                "description": "要修改的草稿编号；也可传已入库文章的 capture_id 来创建修订草稿（可选，不填则修改最近未入库草稿）",
            },
            "instruction": {
                "type": "string",
                "description": (
                    "用户要求的修改或提取方向；尽量传用户原话，不要自行总结成更短指令。"
                    "如果用户说“着重/特别阐述某部分”，"
                    "表示保留全文主要脉络并加重这些部分，不要改写成只保留这些部分，"
                    "除非用户明确说“只要/仅保留”。"
                ),
            },
        },
        "required": ["instruction"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = revise_capture_draft(
            args.get("draft_id", ""),
            args.get("instruction", ""),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="revise_capture_draft", exc=exc)


registry.register(
    name="revise_capture_draft",
    toolset="personal-assistant",
    schema=REVISE_CAPTURE_DRAFT_SCHEMA,
    handler=_handler,
    emoji="✏️",
)
