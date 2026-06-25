"""Knowledge product tool contract tests."""

from pathlib import Path

from tools.reading_session_tool import COMMIT_SCHEMA, SUMMARIZE_SCHEMA
from tools.synthesize_garden_tool import SYNTHESIZE_GARDEN_SCHEMA


def test_reading_session_uses_redesign_output_choices():
    description = SUMMARIZE_SCHEMA["description"]
    output_type = SUMMARIZE_SCHEMA["parameters"]["properties"]["output_type"]
    commit_description = COMMIT_SCHEMA["description"]

    assert "原文增强版主笔记" in description
    assert "局部学习笔记" in description
    assert "知识卡片" in description
    assert "knowledge_card" in output_type["description"]
    assert "discussion_note" not in output_type["description"]
    assert "knowledge_card 会写入知识卡片" in commit_description


def test_knowledge_card_tool_uses_slim_card_kinds():
    description = SYNTHESIZE_GARDEN_SCHEMA["description"]
    card_kind = SYNTHESIZE_GARDEN_SCHEMA["parameters"]["properties"]["card_kind"]

    assert "Knowledge Card" in description
    assert "观点卡、事实卡、方法卡或风险卡" in description
    assert card_kind["enum"] == ["viewpoint", "fact", "method", "risk"]
    assert "caution" not in card_kind["enum"]
    assert "question" not in card_kind["enum"]


def test_personal_assistant_skill_routes_explicit_theme_requests():
    skill_text = (
        Path(__file__).parents[2] / "skills" / "personal-assistant" / "SKILL.md"
    ).read_text(encoding="utf-8")

    assert "扫描最近保存的内容" in skill_text
    assert "theme_scan" in skill_text
    assert "themes/*.md" in skill_text
    assert "Canvas 仍是高级可视化能力" in skill_text
    assert "synthesize_garden" in skill_text


def test_dashboard_exposes_capture_review_workbench_route():
    web_root = Path(__file__).parents[2] / "web" / "src"
    app_text = (web_root / "App.tsx").read_text(encoding="utf-8")
    title_text = (web_root / "lib" / "resolve-page-title.ts").read_text(encoding="utf-8")

    assert '"/capture-review": KnowledgeChatPage' in app_text
    assert 'normalizedPath === "/capture-review"' in app_text
    assert '"/capture-review": "Capture Review"' in title_text
