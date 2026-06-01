def test_search_notes_schema_describes_rag_answer_and_trace_followup():
    import tools.search_notes_tool as tool

    description = tool.SEARCH_SCHEMA["description"]

    assert "回答问题" in description
    assert "Garden" in description
    assert "Theme" in description
    assert "agent_run_status" in description


def test_search_notes_schema_handles_expand_followup_after_rag_answer():
    import tools.search_notes_tool as tool

    description = tool.SEARCH_SCHEMA["description"]

    assert "继续展开" in description
    assert "show_capture_draft" in description


def test_search_my_notes_export_file_is_explicit_opt_in():
    import tools.search_notes_tool as tool

    prop = tool.SEARCH_SCHEMA["parameters"]["properties"]["export_file"]

    assert prop["type"] == "boolean"
    assert "只有用户明确要求" in prop["description"]


def test_search_my_notes_handler_passes_export_file(monkeypatch):
    import tools.search_notes_tool as tool

    captured = {}

    def fake_search(query, export_file=False):
        captured["query"] = query
        captured["export_file"] = export_file
        return {
            "status": "success",
            "agent": "rag",
            "intent": "search_knowledge_base",
            "chat_preview": "已生成文件。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(tool, "do_search", fake_search)
    tool._handler({"query": "问题", "export_file": True})

    assert captured == {"query": "问题", "export_file": True}
