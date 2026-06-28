"""Tests for the Hermes Theme scan tool wrapper."""
from __future__ import annotations


def test_theme_scan_schema_describes_index_first_scan():
    import tools.theme_scan_tool as theme_scan_tool

    description = theme_scan_tool.THEME_SCAN_SCHEMA["description"]

    assert "默认不生成或更新 themes/*.md" in description
    assert "Theme View 是关系地图" in description
    assert "索引图谱" in description
    assert "不再逐篇调用 LLM 精筛" in description
    assert "不是扫描失败" in description
    assert "照抄 chat_preview" in description
    assert "内部 ID" in description


def test_theme_scan_schema_prevents_unconfirmed_rescan_and_preserves_next_action_handoff():
    import tools.theme_scan_tool as theme_scan_tool

    description = theme_scan_tool.THEME_SCAN_SCHEMA["description"]

    assert "整理主题关联" in description
    assert "沉淀成知识卡片" in description
    assert "不要自动改成 rescan_all=true" in description
    assert "先问用户是否全库扫描" in description
    assert "用户回复编号" in description
    assert "synthesize_garden" in description
    assert "question_id" in description


def test_theme_scan_schema_routes_existing_candidate_followups_to_theme_candidates():
    import tools.theme_scan_tool as theme_scan_tool

    description = theme_scan_tool.THEME_SCAN_SCHEMA["description"]

    assert "有哪些内容" in description
    assert "theme_candidates" in description
    assert "不要用 search_my_notes" in description


def test_theme_scan_schema_exposes_file_export_flag():
    import tools.theme_scan_tool as theme_scan_tool

    props = theme_scan_tool.THEME_SCAN_SCHEMA["parameters"]["properties"]

    assert props["export_file"]["type"] == "boolean"
    assert "明确要求发文件" in props["export_file"]["description"]
