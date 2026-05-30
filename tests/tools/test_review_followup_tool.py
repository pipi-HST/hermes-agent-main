"""Tests for the Hermes review_followup tool wrapper."""
from __future__ import annotations

import json


def test_review_followup_handler_passes_question(monkeypatch):
    import tools.review_followup_tool as review_followup_tool

    calls: list[str] = []

    def fake_expand_latest_review_followup(question: str):
        calls.append(question)
        return {
            "status": "success",
            "agent": "review",
            "intent": "expand_latest_review_followup",
            "chat_preview": "只展开刚刚讲过的材料。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"question": question},
        }

    monkeypatch.setattr(
        review_followup_tool,
        "expand_latest_review_followup",
        fake_expand_latest_review_followup,
    )

    result = json.loads(review_followup_tool._handler({"question": "展开一下"}))

    assert calls == ["展开一下"]
    assert result["intent"] == "expand_latest_review_followup"
    assert "刚刚讲过" in result["chat_preview"]


def test_review_followup_registered_in_personal_assistant_toolset():
    import tools.review_followup_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("review_followup")

    assert entry is not None
    assert entry.toolset == "personal-assistant"
    assert "daily_review" in entry.schema["description"]
    assert "search_my_notes" in entry.schema["description"]
    assert "对比" in entry.schema["description"]
