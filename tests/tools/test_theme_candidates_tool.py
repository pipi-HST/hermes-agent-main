def test_theme_candidates_tool_schema_guides_followup_after_empty_recent_scan():
    import tools.theme_candidates_tool as tool

    description = tool.THEME_CANDIDATES_SCHEMA["description"]

    assert "Theme 候选组" in description
    assert "Knowledge Card 草稿" in description
    assert "没有待扫描的新内容" in description
    assert "第一组" in description
    assert "question_id" in description
    assert "不要用 search_my_notes" in description


def test_theme_candidates_tool_registers_in_advanced_knowledge_toolset():
    import tools.theme_candidates_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("theme_candidates")

    assert entry is not None
    assert entry.toolset == "knowledge-advanced"
