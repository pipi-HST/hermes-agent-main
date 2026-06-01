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


def test_show_capture_draft_schema_rejects_expand_full_text_after_rag_answer():
    import tools.show_capture_draft_tool as show_capture_draft_tool

    description = show_capture_draft_tool.SHOW_CAPTURE_DRAFT_SCHEMA["description"]

    assert "展开全文" in description
    assert "知识库回答" in description


def test_show_capture_draft_as_file_is_explicit_opt_in():
    import tools.show_capture_draft_tool as tool

    prop = tool.SHOW_CAPTURE_DRAFT_SCHEMA["parameters"]["properties"]["as_file"]

    assert prop["type"] == "boolean"
    assert "只有用户明确要求" in prop["description"]


def test_show_capture_draft_handler_passes_as_file(monkeypatch):
    import tools.show_capture_draft_tool as tool

    captured = {}

    def fake_show(draft_id="", page=1, as_file=False):
        captured["draft_id"] = draft_id
        captured["page"] = page
        captured["as_file"] = as_file
        return {
            "status": "success",
            "agent": "capture",
            "intent": "show_capture_draft",
            "chat_preview": "已生成草稿全文文件。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(tool, "show_capture_draft", fake_show)
    tool._handler({"draft_id": "d1", "page": 2, "as_file": True})

    assert captured == {"draft_id": "d1", "page": 2, "as_file": True}
