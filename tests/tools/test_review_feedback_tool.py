"""Tests for the Hermes review_feedback tool wrapper."""
from __future__ import annotations

import json


def test_review_feedback_handler_records_outcome(monkeypatch):
    import tools.review_feedback_tool as review_feedback_tool

    calls: list[dict] = []

    def fake_record_review_feedback(item_id: str, outcome: str):
        calls.append({"item_id": item_id, "outcome": outcome})
        return {
            "status": "success",
            "agent": "review",
            "intent": "record_review_feedback",
            "chat_preview": "已更新这条回顾偏好。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"item_id": item_id, "outcome": outcome, "updated": True},
        }

    monkeypatch.setattr(
        review_feedback_tool,
        "record_review_feedback",
        fake_record_review_feedback,
    )

    result = json.loads(
        review_feedback_tool._handler({"item_id": "ri1", "outcome": "useful"})
    )

    assert calls == [{"item_id": "ri1", "outcome": "useful"}]
    assert result["agent"] == "review"
    assert result["intent"] == "record_review_feedback"
    assert result["meta"]["updated"] is True


def test_review_feedback_handler_allows_latest_item_feedback(monkeypatch):
    import tools.review_feedback_tool as review_feedback_tool

    calls: list[dict] = []

    def fake_record_review_feedback(item_id: str, outcome: str):
        calls.append({"item_id": item_id, "outcome": outcome})
        return {
            "status": "success",
            "agent": "review",
            "intent": "record_review_feedback",
            "chat_preview": "已记录。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"item_id": item_id, "outcome": outcome, "updated": True},
        }

    monkeypatch.setattr(
        review_feedback_tool,
        "record_review_feedback",
        fake_record_review_feedback,
    )

    result = json.loads(review_feedback_tool._handler({"outcome": "mute"}))

    assert calls == [{"item_id": "", "outcome": "mute"}]
    assert result["meta"]["updated"] is True


def test_review_feedback_registered_in_personal_assistant_toolset():
    import tools.review_feedback_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("review_feedback")

    assert entry is not None
    assert entry.toolset == "personal-assistant"
    assert "outcome" in entry.schema["parameters"]["required"]
    assert "item_id" not in entry.schema["parameters"]["required"]
    assert entry.schema["parameters"]["properties"]["outcome"]["enum"] == [
        "useful",
        "revisit",
        "mute",
    ]
    assert "有用" in entry.schema["description"]
    assert "展开一下" in entry.schema["description"]


def test_daily_review_schema_routes_followups_to_review_followup():
    import tools.daily_review_tool as daily_review_tool

    description = daily_review_tool.REVIEW_SCHEMA["description"]

    assert "review_followup" in description
    assert "展开一下" in description
    assert "search_my_notes" in description
