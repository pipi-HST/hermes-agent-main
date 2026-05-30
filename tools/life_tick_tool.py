"""Hermes tool: life_tick — Life Assistant reminder scheduler tick."""
from __future__ import annotations

import sys
sys.path.insert(0, "/Users/pipi/hermes-custom")

from bridge.life_bridge import life_tick as do_life_tick
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

LIFE_TICK_SCHEMA = {
    "name": "life_tick",
    "description": (
        "运行一次 Life Assistant 定时 tick，用于久坐、运动、喝水、睡眠提醒和定时复盘。"
        "默认 dry_run=true，不应直接向用户发送消息；调度层只在返回 meta.should_notify=true 时投递 chat_preview。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "now": {
                "type": "string",
                "description": "可选 ISO 时间；为空时使用当前时间。",
            },
            "dry_run": {
                "type": "boolean",
                "description": "是否干跑。第一版默认 true，真实通知需显式关闭 dry_run 并启用通知配置。",
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = do_life_tick(
            now=args.get("now", ""),
            dry_run=bool(args.get("dry_run", True)),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="life", intent="life_tick", exc=exc)


registry.register(
    name="life_tick",
    toolset="personal-assistant",
    schema=LIFE_TICK_SCHEMA,
    handler=_handler,
    emoji="⏱️",
)
