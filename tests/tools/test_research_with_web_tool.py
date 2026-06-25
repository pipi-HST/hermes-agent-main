import asyncio
import json


def test_research_with_web_tool_preserves_research_envelope(monkeypatch):
    from tools import research_with_web_tool

    expected = {
        "status": "success",
        "agent": "research",
        "intent": "research_answer",
        "chat_preview": "回答 [K1][W1]",
        "durable_artifacts": [],
        "source_map": [{"ref": "K1"}, {"ref": "W1"}],
        "next_actions": [],
        "warnings": [],
        "errors": [],
        "meta": {"knowledge_sources": [{"ref": "K1"}], "web_sources": [{"ref": "W1"}]},
    }
    called = {}

    async def fake_research_answer(**kwargs):
        called.update(kwargs)
        return expected

    monkeypatch.setattr(research_with_web_tool, "async_research_answer", fake_research_answer)

    payload = json.loads(
        research_with_web_tool._handler(
            {
                "query": "最近有什么变化？",
                "mode": "local_web",
                "article_context": {"title": "文章"},
                "selection_context": {"selected_text": "选区"},
            }
        )
    )

    assert payload["chat_preview"] == "回答 [K1][W1]"
    assert payload["source_map"] == [{"ref": "K1"}, {"ref": "W1"}]
    assert called["mode"] == "local_web"
    assert called["article_context"]["title"] == "文章"
    assert callable(called["event_callback"])


def test_research_with_web_tool_emits_research_progress(monkeypatch):
    from tools import research_with_web_tool

    async def fake_research_answer(**kwargs):
        await kwargs["event_callback"]({"type": "planning_start"})
        await kwargs["event_callback"]({"type": "web_query_start", "query": "OpenAI 是什么"})
        await kwargs["event_callback"](
            {
                "type": "evidence_critic_done",
                "web_sources": [{"ref": "W1", "title": "OpenAI"}],
                "rejected_sources": [],
            }
        )
        return {
            "status": "success",
            "agent": "research",
            "intent": "research_answer",
            "chat_preview": "回答 [W1]",
            "durable_artifacts": [],
            "source_map": [{"ref": "W1"}],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    events = []
    monkeypatch.setattr(research_with_web_tool, "async_research_answer", fake_research_answer)

    payload = json.loads(
        research_with_web_tool._handler(
            {"query": "OpenAI 是什么", "mode": "web_only"},
            tool_progress_callback=lambda *args, **kwargs: events.append((args, kwargs)),
        )
    )

    assert payload["chat_preview"] == "回答 [W1]"
    assert [args[0] for args, _kwargs in events] == ["research.progress"] * 3
    assert events[0][0][2] == "规划检索任务"
    assert events[1][0][2] == "搜索：OpenAI 是什么"
    assert events[2][1]["stage"] == "evidence_critic_done"
    assert events[2][1]["status"] == "completed"


def test_research_with_web_tool_runs_inside_existing_event_loop(monkeypatch):
    from tools import research_with_web_tool

    async def fake_research_answer(**kwargs):
        return {
            "status": "success",
            "agent": "research",
            "intent": "research_answer",
            "chat_preview": "event loop safe [W1]",
            "durable_artifacts": [],
            "source_map": [{"ref": "W1"}],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(research_with_web_tool, "async_research_answer", fake_research_answer)

    async def call_handler_from_running_loop():
        return json.loads(
            research_with_web_tool._handler({"query": "测试", "mode": "web_only"})
        )

    payload = asyncio.run(call_handler_from_running_loop())

    assert payload["chat_preview"] == "event loop safe [W1]"


def test_knowledge_research_toolset_contains_research_tool():
    from toolsets import resolve_toolset

    tools = resolve_toolset("knowledge-research")

    assert "research_with_web" in tools
    assert "web_search" in tools
    assert "web_extract" in tools
    assert "search_my_notes" in tools


def test_personal_assistant_does_not_get_research_tool_by_default():
    from tools.registry import discover_builtin_tools
    from toolsets import resolve_toolset

    discover_builtin_tools()

    assert "research_with_web" not in resolve_toolset("personal-assistant")
