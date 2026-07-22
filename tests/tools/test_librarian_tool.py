"""Tests for the Hermes Librarian tool wrapper."""
from __future__ import annotations

import json


def test_audit_library_handler_defaults_to_dry_run(monkeypatch):
    import tools.librarian_tool as librarian_tool

    calls: list[dict] = []

    def fake_run_librarian_audit(
        *,
        apply: bool = False,
        export_file: bool = False,
        confirmation: str = "",
    ):
        calls.append({
            "apply": apply,
            "export_file": export_file,
            "confirmation": confirmation,
        })
        return {
            "status": "success",
            "agent": "librarian",
            "intent": "audit_library",
            "chat_preview": "审计完成。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"dry_run": True},
        }

    monkeypatch.setattr(librarian_tool, "run_librarian_audit", fake_run_librarian_audit)

    result = json.loads(librarian_tool._handler({}))

    assert calls == [{"apply": False, "export_file": False, "confirmation": ""}]
    assert result["agent"] == "librarian"
    assert result["intent"] == "audit_library"
    assert result["chat_preview"] == "审计完成。"


def test_audit_library_handler_allows_explicit_apply(monkeypatch):
    import tools.librarian_tool as librarian_tool

    calls: list[dict] = []

    def fake_run_librarian_audit(
        *,
        apply: bool = False,
        export_file: bool = False,
        confirmation: str = "",
    ):
        calls.append({
            "apply": apply,
            "export_file": export_file,
            "confirmation": confirmation,
        })
        return {
            "status": "success",
            "agent": "librarian",
            "intent": "apply_librarian_repair",
            "chat_preview": "已执行。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"dry_run": False},
        }

    monkeypatch.setattr(librarian_tool, "run_librarian_audit", fake_run_librarian_audit)

    result = json.loads(
        librarian_tool._handler({"apply": True}, user_task="确认修复")
    )

    assert calls == [{
        "apply": True,
        "export_file": False,
        "confirmation": "确认修复",
    }]
    assert result["intent"] == "apply_librarian_repair"
    assert result["meta"]["dry_run"] is False


def test_audit_library_registered_in_personal_assistant_toolset():
    import tools.librarian_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("audit_library")

    assert entry is not None
    assert entry.toolset == "personal-assistant"
    assert entry.schema["parameters"]["properties"]["apply"]["type"] == "boolean"
    assert entry.schema["parameters"]["properties"]["export_file"]["type"] == "boolean"
    assert "默认只审计" in entry.schema["description"]
