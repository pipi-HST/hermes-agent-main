"""Tests for continue_rag_answer tool schema."""
from __future__ import annotations


def test_continue_rag_answer_schema_targets_rag_followups():
    import tools.continue_rag_answer_tool as tool

    description = tool.CONTINUE_RAG_ANSWER_SCHEMA["description"]

    assert "继续展开" in description
    assert "上一条 RAG" in description
    assert "不要重新检索" in description


def test_continue_rag_answer_registered_in_personal_assistant_toolset():
    import tools.continue_rag_answer_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("continue_rag_answer")

    assert entry is not None
    assert entry.toolset == "personal-assistant"
