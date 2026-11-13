"""TUI gateway knowledge-source enrichment: HTTP mode uses the service."""
from __future__ import annotations

import pytest

import tui_gateway.server as server


class _FakeServiceClient:
    def __init__(self, items=None, *, fail=False):
        self.items = items or {}
        self.fail = fail
        self.calls: list[dict] = []
        self.closed = False

    def list_library_items(self, **query):
        self.calls.append(dict(query))
        if self.fail:
            raise RuntimeError("knowledge service down")
        item = self.items.get(query.get("search", ""))
        return {"items": [item] if item else [], "total": 1 if item else 0}

    def close(self):
        self.closed = True


@pytest.fixture()
def http_mode(monkeypatch):
    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://127.0.0.1:8123")
    monkeypatch.setattr(server, "_HTTP_KNOWLEDGE_SOURCE_CACHE", {})
    return monkeypatch


def _patch_client(monkeypatch, client):
    import integrations.hermes_knowledge.client as knowledge_client

    monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: client)
    return client


def test_http_mode_enriches_sources_from_service(http_mode):
    fake = _patch_client(
        http_mode,
        _FakeServiceClient(
            {
                "笔记A": {"id": "cap-1", "kind": "capture"},
                "草稿B": {"id": "d1", "kind": "capture_draft"},
            }
        ),
    )

    enriched = server._enrich_gateway_knowledge_sources(
        [
            {"title": "笔记A"},
            {"title": "笔记A"},
            {"title": "草稿B"},
            {"title": "未命中"},
        ]
    )

    assert enriched[0]["item_id"] == "cap-1"
    assert enriched[0]["item_kind"] == "capture"
    assert enriched[0]["open_url"] == "/knowledge-library?kind=capture&item=cap-1"
    assert enriched[1]["open_url"] == enriched[0]["open_url"]
    assert enriched[2]["item_kind"] == "capture_draft"
    assert "open_url" not in enriched[3]
    # One request per distinct title; the duplicate is served from the cache.
    assert fake.calls == [
        {"search": "笔记A", "limit": 1},
        {"search": "草稿B", "limit": 1},
        {"search": "未命中", "limit": 1},
    ]
    assert fake.closed is True


def test_http_mode_never_reads_local_sqlite(http_mode):
    fake = _patch_client(
        http_mode, _FakeServiceClient({"笔记A": {"id": "cap-1", "kind": "capture"}})
    )

    def _boom(*args, **kwargs):
        raise AssertionError("HTTP mode must not open the local knowledge DB")

    http_mode.setattr(server.sqlite3, "connect", _boom)
    http_mode.setattr(server, "_load_knowledge_config", _boom)

    enriched = server._enrich_gateway_knowledge_sources([{"title": "笔记A"}])

    assert enriched[0]["item_id"] == "cap-1"
    assert fake.closed is True


def test_http_mode_lookup_failure_degrades_silently(http_mode):
    fake = _patch_client(http_mode, _FakeServiceClient(fail=True))

    sources = [{"title": "笔记A", "open_url": "/original"}]
    enriched = server._enrich_gateway_knowledge_sources(sources)

    assert enriched == sources
    assert fake.closed is True


def test_http_mode_get_client_failure_returns_sources_unchanged(http_mode):
    import integrations.hermes_knowledge.client as knowledge_client

    def _unavailable(transport=None):
        raise knowledge_client.KnowledgeUnavailable("unreachable")

    http_mode.setattr(knowledge_client, "get_client", _unavailable)

    sources = [{"title": "笔记A"}]
    assert server._enrich_gateway_knowledge_sources(sources) == sources


def test_local_mode_still_uses_the_local_path(monkeypatch):
    monkeypatch.delenv("HERMES_KNOWLEDGE_URL", raising=False)
    monkeypatch.setattr(server, "_HTTP_KNOWLEDGE_SOURCE_CACHE", {})
    calls: list[tuple] = []

    class _Conn:
        row_factory = None

        def close(self):
            pass

    monkeypatch.setattr(server.sqlite3, "connect", lambda *a, **k: _Conn())
    monkeypatch.setattr(server, "_load_knowledge_config", lambda: ("db", "vault"))
    monkeypatch.setattr(
        server,
        "_enrich_gateway_knowledge_source",
        lambda conn, vault_path, source: calls.append((conn, vault_path, source))
        or {**source, "item_id": "local-id"},
    )

    result = server._enrich_gateway_knowledge_sources([{"title": "笔记A"}])

    assert result[0]["item_id"] == "local-id"
    assert calls and calls[0][1] == "vault"
    assert isinstance(calls[0][0], _Conn)
