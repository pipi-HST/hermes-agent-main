import json


def test_research_tool_progress_reaches_tui_gateway(monkeypatch):
    from tools import research_with_web_tool
    import tui_gateway.server as server

    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))
    server._sessions["sid-research"] = {
        "tool_progress_mode": "all",
        "edit_snapshots": {},
        "tool_started_at": {},
    }

    async def fake_research_answer(**kwargs):
        await kwargs["event_callback"]({"type": "planning_start"})
        await kwargs["event_callback"](
            {
                "type": "web_query_start",
                "query": "OpenAI 是什么",
                "queries": ["OpenAI 是什么"],
            }
        )
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
            "chat_preview": "OpenAI 是一家 AI 研究与产品公司 [W1]",
            "durable_artifacts": [],
            "source_map": [{"ref": "W1"}],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {},
        }

    monkeypatch.setattr(research_with_web_tool, "async_research_answer", fake_research_answer)

    server._on_tool_start("sid-research", "call-1", "research_with_web", {"query": "OpenAI 是什么"})
    result = research_with_web_tool._handler(
        {"query": "OpenAI 是什么", "mode": "web_only"},
        tool_progress_callback=lambda event, name=None, preview=None, args=None, **kwargs: server._on_tool_progress(
            "sid-research",
            event,
            name,
            preview,
            args,
            **kwargs,
        ),
    )
    server._on_tool_complete("sid-research", "call-1", "research_with_web", {"query": "OpenAI 是什么"}, result)

    assert json.loads(result)["chat_preview"] == "OpenAI 是一家 AI 研究与产品公司 [W1]"
    assert [event for event, _sid, _payload in emitted] == [
        "tool.start",
        "tool.progress",
        "tool.progress",
        "tool.progress",
        "tool.complete",
    ]
    progress_payloads = [payload for event, _sid, payload in emitted if event == "tool.progress"]
    assert [payload["preview"] for payload in progress_payloads] == [
        "规划检索任务",
        "搜索：OpenAI 是什么",
        "证据裁判完成：采用 1，拒绝 0",
    ]
    assert progress_payloads[1]["stage"] == "web_query_start"
    assert progress_payloads[2]["status"] == "completed"
