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
