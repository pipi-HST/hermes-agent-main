"""Tests for Hermes Garden draft tool wrappers."""
from __future__ import annotations

import json


def test_revise_garden_draft_tool_preserves_envelope(monkeypatch):
    import tools.revise_garden_draft_tool as tool

    expected = {
        "status": "success",
        "agent": "garden",
        "intent": "revise_garden_draft",
        "chat_preview": "已修改 Garden 草稿。",
        "durable_artifacts": [
            {
                "type": "garden_draft",
                "id": "draft1",
                "title": "草稿",
                "path": "",
                "status": "draft_ready",
            }
        ],
        "source_map": [],
        "next_actions": [
            {
                "label": "确认卡片保存",
                "intent": "commit_garden_draft",
                "payload": {"draft_id": "draft1"},
                "requires_confirmation": True,
            }
        ],
        "warnings": [],
        "errors": [],
        "meta": {},
    }
    monkeypatch.setattr(tool, "do_revise", lambda **kwargs: expected)

    result = json.loads(tool._handler({
        "draft_id": "draft1",
        "instruction": "更强调反例",
    }))

    assert result["agent"] == "garden"
    assert result["intent"] == "revise_garden_draft"
    assert result["next_actions"][0]["requires_confirmation"] is True


def test_commit_garden_draft_tool_preserves_envelope(monkeypatch):
    import tools.commit_garden_draft_tool as tool

    expected = {
        "status": "success",
        "agent": "garden",
        "intent": "commit_garden_draft",
        "chat_preview": "已存入知识花园。",
        "durable_artifacts": [
            {
                "type": "garden_card",
                "id": "card1",
                "title": "观点",
                "status": "seed",
            }
        ],
        "source_map": [],
        "next_actions": [],
        "warnings": [],
        "errors": [],
        "meta": {},
    }
    observed = {}

    def fake_commit(**kwargs):
        observed.update(kwargs)
        return expected

    monkeypatch.setattr(tool, "do_commit", fake_commit)

    result = json.loads(
        tool._handler({"draft_id": "draft1"}, user_task="确认卡片")
    )

    assert result["agent"] == "garden"
    assert result["intent"] == "commit_garden_draft"
    assert result["durable_artifacts"][0]["type"] == "garden_card"
    assert observed == {"draft_id": "draft1", "confirmation": "确认卡片"}


def test_garden_draft_tools_register_in_personal_assistant_toolset():
    import tools.commit_garden_draft_tool  # noqa: F401
    import tools.revise_garden_draft_tool  # noqa: F401
    from tools.registry import registry

    revise_entry = registry.get_entry("revise_garden_draft")
    commit_entry = registry.get_entry("commit_garden_draft")

    assert revise_entry is not None
    assert revise_entry.toolset == "personal-assistant"
    assert "instruction" in revise_entry.schema["parameters"]["required"]
    assert "修改" in revise_entry.schema["description"]

    assert commit_entry is not None
    assert commit_entry.toolset == "personal-assistant"
    assert commit_entry.schema["parameters"]["required"] == []
    assert "确认" in commit_entry.schema["description"]


def test_synthesize_garden_schema_forbids_silent_capture_reduction():
    import tools.synthesize_garden_tool as tool

    description = tool.SYNTHESIZE_GARDEN_SCHEMA["description"]

    assert "不要减少 capture_ids" in description
    assert "明确告诉用户" in description


def test_synthesize_garden_tool_accepts_card_kind(monkeypatch):
    import tools.synthesize_garden_tool as tool

    captured = {}

    def fake_synthesize(**kwargs):
        captured.update(kwargs)
        return {
            "status": "success",
            "agent": "garden",
            "intent": "synthesize_garden",
            "chat_preview": "已生成 Garden 方法卡草稿。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"card_kind": "method"},
        }

    monkeypatch.setattr(tool, "do_synthesize", fake_synthesize)

    result = json.loads(tool._handler({
        "capture_ids": ["cap1"],
        "card_kind": "method",
    }))

    assert result["meta"]["card_kind"] == "method"
    assert captured["card_kind"] == "method"
    assert captured["export_file"] is False
    assert tool.SYNTHESIZE_GARDEN_SCHEMA["parameters"]["properties"]["card_kind"]["enum"] == [
        "viewpoint",
        "fact",
        "method",
        "risk",
    ]
    assert tool.SYNTHESIZE_GARDEN_SCHEMA["parameters"]["properties"]["export_file"]["type"] == "boolean"


def test_synthesize_garden_tool_treats_card_kind_as_optional_agent_hint():
    import tools.synthesize_garden_tool as tool

    description = tool.SYNTHESIZE_GARDEN_SCHEMA["description"]
    card_kind_description = (
        tool.SYNTHESIZE_GARDEN_SCHEMA["parameters"]["properties"]["card_kind"]["description"]
    )

    assert "不要为了确定类型追问用户" in description
    assert "系统提示" in card_kind_description


def test_synthesize_garden_routes_through_shared_bridge_transport(monkeypatch):
    """HTTP mode must reach the service, not import a local checkout."""
    import tools.synthesize_garden_tool as tool

    calls = {}

    def fake_call(module_name, function_name, **kwargs):
        calls["module"] = module_name
        calls["function"] = function_name
        calls["kwargs"] = kwargs
        return {
            "status": "success",
            "agent": "garden",
            "intent": "synthesize_garden",
            "chat_preview": "ok",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(tool, "call_custom_bridge", fake_call)

    result = json.loads(tool._handler({"capture_ids": ["cap1"]}))

    assert result["status"] == "success"
    assert calls == {
        "module": "garden_bridge",
        "function": "synthesize_garden",
        "kwargs": {
            "capture_ids": ["cap1"],
            "question_id": "",
            "title": "",
            "card_kind": "",
            "export_file": False,
        },
    }
