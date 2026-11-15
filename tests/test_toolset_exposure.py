"""Contract for the supervisor-facing tool surface.

This is not a catalog snapshot: ``personal-assistant`` is the *routing surface*
shown to the model on every turn, so its exact membership is the contract.  The
23-tool pre-convergence surface stays frozen in ``personal-assistant-legacy``.
"""
from __future__ import annotations

from toolsets import TOOLSETS

REQUIRED_TOOLS = {
    # 1. 伴读
    "start_reading_session",
    "discuss_reading",
    "summarize_reading_session",
    # 2. 好文收集
    "capture_content",
    "commit_capture_draft",
    "refine_capture",
    # 3. 卡片沉淀
    "save_answer_to_knowledge",
    "commit_reading_artifact",
    "synthesize_garden",
    "commit_garden_draft",
    # 4. 专题检索 / 扫描 / 推送
    "search_my_notes",
    "continue_rag_answer",
    "theme_scan",
    "send_message",
}

FORBIDDEN_IN_ROUTER = {
    # Review/debug/maintenance tools that caused routing confusion.
    "daily_review",
    "review_feedback",
    "review_followup",
    "audit_library",
    "agent_run_status",
    "graph_report",
    "show_capture_draft",
    "revise_capture_draft",
    "revise_garden_draft",
    "show_reading_session",
}


def test_supervisor_surface_is_the_four_intent_loop():
    tools = TOOLSETS["personal-assistant"]["tools"]
    assert set(tools) == REQUIRED_TOOLS
    assert len(tools) == 14
    assert not (set(tools) & FORBIDDEN_IN_ROUTER)


def test_legacy_surface_is_frozen_and_superset():
    legacy = set(TOOLSETS["personal-assistant-legacy"]["tools"])
    supervisor = set(TOOLSETS["personal-assistant"]["tools"])
    assert len(legacy) == 23
    # The only deliberate addition relative to the frozen 23 is theme_scan.
    assert supervisor - legacy == {"theme_scan"}
    assert not (legacy - supervisor) - FORBIDDEN_IN_ROUTER - {
        "show_capture_draft",
        "revise_capture_draft",
        "revise_garden_draft",
        "show_reading_session",
        "graph_report",
        "daily_review",
        "review_feedback",
        "review_followup",
        "audit_library",
        "agent_run_status",
    }


def test_every_exposed_tool_is_registered():
    """A name in a toolset that no tool registers is silently invisible."""
    import model_tools  # noqa: F401 - triggers builtin discovery
    from tools.registry import registry

    registered = set(registry.get_all_tool_names())
    missing = set(TOOLSETS["personal-assistant"]["tools"]) - registered
    assert not missing, f"toolset exposes unregistered tools: {sorted(missing)}"
