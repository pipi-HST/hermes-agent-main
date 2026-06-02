"""Hermes tool: record_life_event — 记录 Life Assistant 生活事件."""
from __future__ import annotations

import sys
sys.path.insert(0, "/Users/pipi/hermes-life")

from hermes_life.bridge.life_bridge import record_life_event as do_record_life_event
from hermes_life.bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

RECORD_LIFE_EVENT_SCHEMA = {
    "name": "record_life_event",
    "description": (
        "记录 Life Assistant 支持的生活节奏事件或提醒回复。"
        "仅在消息明确属于生活/健康记录、长期决定/长期决策复盘、带有「生活：」「健康：」前缀，"
        "或正在回复 Life 提醒时调用；长期决定的内容、补充下次复盘时间、复盘回复都交给本工具解析；"
        "不要用于知识笔记、读书摘录、观点记录或手动状态查询。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "用户原始生活消息，例如「午饭吃了牛肉饭」「我睡了」「今天不练了」「长期决定：未来三个月优先打磨 Life Assistant」。",
            },
            "received_at": {
                "type": "string",
                "description": "可选 ISO 时间；为空时由 Life Assistant 使用当前时间。",
            },
        },
        "required": ["message"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = do_record_life_event(
            args.get("message", ""),
            received_at=args.get("received_at", ""),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="life", intent="record_life_event", exc=exc)


registry.register(
    name="record_life_event",
    toolset="personal-assistant",
    schema=RECORD_LIFE_EVENT_SCHEMA,
    handler=_handler,
    emoji="🌿",
)
