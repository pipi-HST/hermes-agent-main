"""Hermes tool: refine_capture — 兼容旧名，修改待确认草稿."""
from __future__ import annotations

import sys
sys.path.insert(0, "/Users/pipi/hermes-custom")

from bridge.capture_bridge import revise_capture_draft as do_revise
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

REFINE_SCHEMA = {
    "name": "refine_capture",
    "description": (
        "兼容旧工具名：修改最近或指定的待确认草稿。用户说「摘要不对」「重新总结」"
        "「压缩一下」「聚焦某部分」时调用。不会正式入库；用户确认后调用 commit_capture_draft。"
        "把用户修改要求的原话尽量完整放入 instruction，不要自行压缩或改写。"
        "如果用户针对已入库文章继续修改，可把该文章 capture_id 传给 capture_id，"
        "工具会基于原文和已入库笔记创建修订草稿。"
        "工具会生成待确认整理稿并返回微信可读预览。"
        "修改成功后直接把工具返回的 USER_VISIBLE_REPLY 发给用户，不要自动调用 show_capture_draft；"
        "用户后续明确要求“展开草稿/查看草稿/看全文/继续看”时才调用 show_capture_draft。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "capture_id": {
                "type": "string",
                "description": "兼容字段：要修改的 draft 编号；也可传已入库文章的 capture_id 创建修订草稿（可选，不填则修改最近草稿）",
            },
            "instruction": {
                "type": "string",
                "description": (
                    "用户要求的操作；尽量传用户原话，不要自行总结成更短指令。"
                    "例如「重新提取核心观点」「压缩到500字」。"
                    "如果用户说“着重/特别阐述某部分”，表示保留全文主要脉络并加重这些部分，"
                    "不要改写成只保留这些部分，除非用户明确说“只要/仅保留”。不填则默认重新摘要。"
                ),
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        inst = args.get("instruction", "重新生成准确的摘要和标签")
        result = do_revise(args.get("capture_id", ""), inst)
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="revise_capture_draft", exc=exc)


registry.register(
    name="refine_capture",
    toolset="personal-assistant",
    schema=REFINE_SCHEMA,
    handler=_handler,
    emoji="✏️",
)
