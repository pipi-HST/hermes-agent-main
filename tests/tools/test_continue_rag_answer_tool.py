"""Tests for continue_rag_answer tool schema."""
from __future__ import annotations


def test_continue_rag_answer_schema_targets_rag_followups():
    import tools.continue_rag_answer_tool as tool

    description = tool.CONTINUE_RAG_ANSWER_SCHEMA["description"]

    assert "继续展开" in description
    assert "上一条 RAG" in description
    assert "不要重新检索" in description
    assert "导出文档" in description
    assert "发文件" in description
    assert "保存成 Markdown" in description


def test_continue_rag_answer_registered_in_personal_assistant_toolset():
    import tools.continue_rag_answer_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("continue_rag_answer")

    assert entry is not None
    assert entry.toolset == "personal-assistant"


def test_continue_rag_answer_export_file_is_explicit_opt_in():
    import tools.continue_rag_answer_tool as tool

    prop = tool.CONTINUE_RAG_ANSWER_SCHEMA["parameters"]["properties"]["export_file"]

    assert prop["type"] == "boolean"
    assert "只有用户明确要求" in prop["description"]


def test_continue_rag_answer_handler_passes_export_file(monkeypatch):
    import tools.continue_rag_answer_tool as tool

    captured = {}

    def fake_continue(export_file=False):
        captured["export_file"] = export_file
        return {
            "status": "success",
            "agent": "rag",
            "intent": "continue_rag_answer",
            "chat_preview": "已生成文件。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(tool, "continue_latest_rag_answer", fake_continue)
    tool._handler({"export_file": True})

    assert captured["export_file"] is True
