"""Contract tests for the Hermes Knowledge HTTP client."""
from __future__ import annotations

import httpx
import pytest

from integrations.hermes_knowledge.client import (
    KnowledgeClient,
    KnowledgeConfig,
    KnowledgeIncompatible,
    KnowledgeUnavailable,
    load_config,
)


def _client(handler) -> KnowledgeClient:
    return KnowledgeClient(
        KnowledgeConfig(base_url="http://knowledge.test", token="t"),
        transport=httpx.MockTransport(handler),
    )


def test_health_requires_expected_service():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"service": "other", "contract_version": 1})

    with pytest.raises(KnowledgeIncompatible):
        _client(handler).assert_compatible()


def test_health_rejects_old_contract_version():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"service": "hermes-knowledge", "contract_version": 0})

    with pytest.raises(KnowledgeIncompatible):
        _client(handler).assert_compatible()


def test_health_accepts_current_contract():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"service": "hermes-knowledge", "contract_version": 1})

    health = _client(handler).assert_compatible()
    assert health["contract_version"] == 1


def test_http_errors_become_knowledge_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "down"})

    with pytest.raises(KnowledgeUnavailable):
        _client(handler).search("anything")


def test_commit_sends_confirmation_token():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"ok": True})

    _client(handler).commit_draft("capture-drafts", "d1", "tok")
    assert "/api/capture-drafts/d1/commit" in seen["url"]
    assert "tok" in seen["body"]


def test_load_config_is_none_without_url(monkeypatch):
    monkeypatch.delenv("HERMES_KNOWLEDGE_URL", raising=False)
    assert load_config() is None

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://127.0.0.1:8000/")
    config = load_config()
    assert config is not None
    assert config.base_url == "http://127.0.0.1:8000"
