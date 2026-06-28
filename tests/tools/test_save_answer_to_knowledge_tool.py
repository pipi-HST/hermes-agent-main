import json


def test_save_answer_tool_registers_in_personal_assistant():
    import tools.save_answer_to_knowledge_tool  # noqa: F401
    from tools.registry import registry

    entry = registry.get_entry("save_answer_to_knowledge")

    assert entry is not None
    assert entry.toolset == "personal-assistant"


def test_save_answer_tool_handler_returns_envelope(monkeypatch):
    import tools.save_answer_to_knowledge_tool as tool

    monkeypatch.setattr(
        tool,
        "do_save",
        lambda **kwargs: {
            "status": "success",
            "agent": "reading",
            "intent": "save_answer_to_knowledge",
            "chat_preview": "已生成 Capture Note 草稿",
            "durable_artifacts": [],
            "source_map": [],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {"reading_draft_id": "draft1"},
        },
    )

    raw = tool._handler(
        {
            "hermes_session_id": "session1",
            "user_message": "为什么重要？",
            "assistant_answer": "因为它可复用。",
            "instruction": "存起来",
            "output_type": "auto",
            "assistant_message_id": "assistant1",
            "sources": [],
            "target_capture_id": "",
        }
    )

    payload = json.loads(raw)
    assert payload["status"] == "success"
    assert "已生成 Capture Note 草稿" in payload["chat_preview"]
