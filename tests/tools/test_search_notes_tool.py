def test_search_notes_schema_describes_rag_answer_and_trace_followup():
    import tools.search_notes_tool as tool

    description = tool.SEARCH_SCHEMA["description"]

    assert "回答问题" in description
    assert "Knowledge Card" in description
    assert "Theme View" in description
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


def test_search_notes_schema_routes_previous_rag_export_to_continue_tool():
    import tools.search_notes_tool as tool

    description = tool.SEARCH_SCHEMA["description"]
    export_description = tool.SEARCH_SCHEMA["parameters"]["properties"]["export_file"]["description"]

    assert "导出文档" in description
    assert "continue_rag_answer(export_file=true)" in description
    assert "不要重新调用本工具" in description
    assert "上一条 RAG 回答" in export_description


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


def test_search_my_notes_handler_preserves_empty_knowledge_result(monkeypatch):
    import json
    import tools.search_notes_tool as tool

    def fake_search(query, export_file=False):
        assert query == "空库能回答吗？"
        assert export_file is False
        return {
            "status": "success",
            "agent": "rag",
            "intent": "search_knowledge_base",
            "chat_preview": "无知识库资料：当前本地知识库没有可引用的资料。",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"result_count": 0},
        }

    monkeypatch.setattr(tool, "do_search", fake_search)

    payload = json.loads(tool._handler({"query": "空库能回答吗？"}))

    assert payload["chat_preview"] == "无知识库资料：当前本地知识库没有可引用的资料。"
    assert payload["source_map"] == []
    assert payload["meta"]["result_count"] == 0
