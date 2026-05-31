import json


def test_agent_run_status_handler_passes_limit(monkeypatch):
    import tools.agent_run_status_tool as tool

    calls = []

    def fake_get_agent_run_status(limit: int = 5):
        calls.append(limit)
        return {
            "status": "success",
            "agent": "system",
            "intent": "agent_run_status",
            "chat_preview": "最近 1 次 Agent 运行",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"run_count": 1},
        }

    monkeypatch.setattr(tool, "get_agent_run_status", fake_get_agent_run_status)

    result = json.loads(tool._handler({"limit": 3}))

    assert calls == [3]
    assert result["intent"] == "agent_run_status"
    assert result["chat_preview"] == "最近 1 次 Agent 运行"


def test_agent_run_status_registered_in_personal_assistant_toolset():
    import tools.agent_run_status_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("agent_run_status")

    assert entry is not None
    assert entry.toolset == "personal-assistant"


def test_agent_run_status_description_requires_verbatim_source_names():
    import tools.agent_run_status_tool as tool

    description = tool.AGENT_RUN_STATUS_SCHEMA["description"]

    assert "刚刚" in description
    assert "limit=1" in description
    assert "原样返回" in description
    assert "不要使用“同上”" in description
