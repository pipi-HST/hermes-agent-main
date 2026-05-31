def test_generate_canvas_tool_schema_routes_canvas_requests():
    import tools.generate_canvas_tool as tool

    description = tool.GENERATE_CANVAS_SCHEMA["description"]

    assert "Canvas" in description
    assert "关系图" in description
    assert "画板" in description
    assert "Obsidian" in description


def test_generate_canvas_tool_registers_in_personal_assistant_toolset():
    import tools.generate_canvas_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("generate_canvas")

    assert entry is not None
    assert entry.toolset == "personal-assistant"
