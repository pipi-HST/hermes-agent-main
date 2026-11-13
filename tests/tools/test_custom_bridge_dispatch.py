"""HTTP-mode dispatch for the custom-envelope tools (``call_custom_bridge``)."""
from __future__ import annotations

import json

import pytest


class _FakeServiceClient:
    """Records ``call_tool`` invocations, closes itself once."""

    def __init__(self, result=None):
        self.result = result if result is not None else {"status": "ok"}
        self.calls: list[tuple] = []
        self.closed = False

    def call_tool(self, module_name, function_name, *, args=None, kwargs=None):
        self.calls.append((module_name, function_name, args, kwargs))
        return self.result

    def close(self):
        self.closed = True


def test_call_custom_bridge_dispatches_to_service(monkeypatch):
    import integrations.hermes_knowledge.tool_bridge as tool_bridge
    from tools.hermes_custom_envelope import call_custom_bridge

    fake = _FakeServiceClient()
    monkeypatch.setattr(tool_bridge, "get_client", lambda: fake)

    result = call_custom_bridge(
        "rag_bridge", "search_knowledge_base", query="hello", limit=5
    )

    assert result == {"status": "ok"}
    assert fake.calls == [
        (
            "rag_bridge",
            "search_knowledge_base",
            [],
            {"query": "hello", "limit": 5},
        )
    ]
    assert fake.closed is True


def test_search_notes_handler_reaches_the_service(monkeypatch):
    """Tool smoke: a real handler's args reach ``client.call_tool``."""
    import integrations.hermes_knowledge.tool_bridge as tool_bridge
    import tools.search_notes_tool as search_notes_tool

    fake = _FakeServiceClient(
        result={
            "status": "ok",
            "chat_preview": "answer",
            "source_map": [],
            "meta": {},
        }
    )
    monkeypatch.setattr(tool_bridge, "get_client", lambda: fake)
    # The envelope helpers would otherwise try to import the local checkout.
    monkeypatch.setattr(
        search_notes_tool,
        "envelope_success_json",
        lambda payload: json.dumps({"envelope": payload}, ensure_ascii=False),
    )
    monkeypatch.setattr(
        search_notes_tool,
        "envelope_error_json",
        lambda **kwargs: json.dumps({"error": str(kwargs.get("exc"))}),
    )

    raw = search_notes_tool._handler({"query": "AI 周报"})

    assert json.loads(raw)["envelope"]["chat_preview"] == "answer"
    assert fake.calls == [
        (
            "rag_bridge",
            "search_knowledge_base",
            [],
            {"query": "AI 周报"},
        )
    ]
    assert fake.closed is True


def test_call_custom_bridge_http_failure_is_raised_to_tool_layer(monkeypatch):
    import integrations.hermes_knowledge.tool_bridge as tool_bridge
    from integrations.hermes_knowledge import KnowledgeUnavailable
    from tools.hermes_custom_envelope import call_custom_bridge

    class _BrokenClient:
        def __init__(self):
            self.closed = False

        def call_tool(self, *args, **kwargs):
            raise KnowledgeUnavailable("service down")

        def close(self):
            self.closed = True

    fake = _BrokenClient()
    monkeypatch.setattr(tool_bridge, "get_client", lambda: fake)

    with pytest.raises(KnowledgeUnavailable, match="service down"):
        call_custom_bridge("rag_bridge", "search")

    assert fake.closed is True
