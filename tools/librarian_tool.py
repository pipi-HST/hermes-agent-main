"""Hermes tool: audit_library — 手动触发知识库审计/安全修复."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.librarian_bridge import run_librarian_audit
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

LIBRARIAN_SCHEMA = {
    "name": "audit_library",
    "description": (
        "检查 Hermes Knowledge File storage 与 SQLite 数据是否一致，并检查长文是否缺少目录。"
        "默认只审计、不修改任何数据。只有当用户明确说“执行修复”“确认修复”“应用修复”"
        "这类确认语句时，才把 apply 设为 true。返回微信友好的审计摘要和本地报告路径。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "apply": {
                "type": "boolean",
                "description": (
                    "是否执行安全机械修复。默认 false；只有用户明确确认执行修复时才传 true。"
                ),
            },
            "export_file": {
                "type": "boolean",
                "description": "只有用户明确要求发文件、导出完整审计报告或附件时才设为 true；普通审计保持 false。",
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = run_librarian_audit(
            apply=bool(args.get("apply", False)),
            export_file=bool(args.get("export_file", False)),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="librarian", intent="audit_library", exc=exc)


registry.register(
    name="audit_library",
    toolset="personal-assistant",
    schema=LIBRARIAN_SCHEMA,
    handler=_handler,
    emoji="📚",
)
