"""Tests for the Hermes show_capture_draft tool schema."""
from __future__ import annotations


def test_show_capture_draft_schema_restricts_review_followups_to_rag():
    import tools.show_capture_draft_tool as show_capture_draft_tool

    description = show_capture_draft_tool.SHOW_CAPTURE_DRAFT_SCHEMA["description"]

    assert "只用于待确认 Capture 草稿" in description
    assert "daily_review" in description
    assert "Review" in description
    assert "展开一下" in description
    assert "search_my_notes" in description
