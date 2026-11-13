"""Contract tests for the Hermes Knowledge HTTP client."""
from __future__ import annotations

import httpx
import pytest

from integrations.hermes_knowledge.client import (
    KnowledgeClient,
    KnowledgeConfig,
    KnowledgeConflict,
    KnowledgeIncompatible,
    KnowledgeInvalid,
    KnowledgeNotFound,
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


def test_library_delete_issues_then_consumes_token():
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(200, json={"token": "tok", "expires_at": "soon"})
        assert b"tok" in request.read()
        return httpx.Response(200, json={"ok": True})

    with _client(handler) as client:
        issued = client.issue_library_delete_confirmation("capture", "c1")
        result = client.permanent_delete_library_item("capture", "c1", issued["token"])

    assert result == {"ok": True}
    assert calls[0][0] == "POST"
    assert calls[0][1].endswith("/api/knowledge/library/items/capture/c1/confirmation")
    assert calls[1][0] == "DELETE"


# ── Error semantics ─────────────────────────────────────────────────────────


def _status_handler(status: int, *, json_body=None, text_body: str = "boom"):
    def handler(request: httpx.Request) -> httpx.Response:
        if json_body is not None:
            return httpx.Response(status, json=json_body)
        return httpx.Response(status, text=text_body, headers={"content-type": "text/plain"})

    return handler


def test_404_maps_to_knowledge_not_found():
    detail = {"detail": "capture not found"}
    with pytest.raises(KnowledgeNotFound) as excinfo:
        _client(_status_handler(404, json_body=detail)).search("q")

    assert excinfo.value.status_code == 404
    assert excinfo.value.detail == detail
    # Backwards compatible: callers catching KnowledgeUnavailable still work.
    assert isinstance(excinfo.value, KnowledgeUnavailable)


def test_409_maps_to_knowledge_conflict_with_detail():
    detail = {
        "detail": "still referenced",
        "dependencies": {"garden_cards": [{"id": "gc-1"}]},
    }
    with pytest.raises(KnowledgeConflict) as excinfo:
        _client(_status_handler(409, json_body=detail)).search("q")

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == detail
    assert excinfo.value.detail["dependencies"]["garden_cards"][0]["id"] == "gc-1"


def test_422_maps_to_knowledge_invalid():
    with pytest.raises(KnowledgeInvalid) as excinfo:
        _client(_status_handler(422, json_body={"detail": ["bad field"]})).search("q")

    assert excinfo.value.status_code == 422
    assert excinfo.value.detail == {"detail": ["bad field"]}


def test_500_maps_to_knowledge_unavailable():
    with pytest.raises(KnowledgeUnavailable) as excinfo:
        _client(_status_handler(500, text_body="<html>crash</html>")).search("q")

    assert not isinstance(excinfo.value, KnowledgeInvalid)
    assert "500" in str(excinfo.value)


def test_error_body_parsing_is_defensive_for_non_json():
    with pytest.raises(KnowledgeNotFound) as excinfo:
        _client(_status_handler(404, text_body="not json at all")).search("q")

    assert excinfo.value.detail == "not json at all"


def test_non_json_success_body_raises_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>dashboard</html>", headers={"content-type": "text/html"}
        )

    with pytest.raises(KnowledgeUnavailable, match="non-JSON"):
        _client(handler).search("q")


def test_redirect_is_not_followed_and_raises_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/login"})

    with pytest.raises(KnowledgeUnavailable, match="non-JSON"):
        _client(handler).search("q")


# ── Retry policy ───────────────────────────────────────────────────────────


def test_get_retries_once_then_succeeds(monkeypatch):
    import integrations.hermes_knowledge.client as client_module

    calls: list[str] = []
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            return httpx.Response(500, text="transient")
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: sleeps.append(seconds))

    result = _client(handler).search("q")

    assert result == {"ok": True}
    assert calls == ["GET", "GET"]
    assert sleeps == [0.2]


def test_get_retries_after_transport_error(monkeypatch):
    import integrations.hermes_knowledge.client as client_module

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            raise httpx.ConnectError("connection reset", request=request)
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)

    assert _client(handler).search("q") == {"ok": True}
    assert calls == ["GET", "GET"]


def test_post_errors_are_not_retried():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(500, text="boom")

    with pytest.raises(KnowledgeUnavailable):
        _client(handler).issue_confirmation("capture-drafts", "d1")

    assert calls == ["POST"]


def test_delete_errors_are_not_retried():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(500, text="boom")

    with pytest.raises(KnowledgeUnavailable):
        _client(handler).permanent_delete_library_item("capture", "c1", "tok")

    assert calls == ["DELETE"]


def test_post_transport_error_becomes_unavailable_without_retry():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(KnowledgeUnavailable, match="failed"):
        _client(handler).issue_confirmation("capture-drafts", "d1")

    assert calls == ["POST"]


def test_get_transport_error_is_retried_once_then_becomes_unavailable(monkeypatch):
    import integrations.hermes_knowledge.client as client_module

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)

    with pytest.raises(KnowledgeUnavailable, match="failed"):
        _client(handler).search("q")

    assert calls == ["GET", "GET"]


# ── Configuration robustness ───────────────────────────────────────────────


def test_invalid_timeout_env_raises_unavailable(monkeypatch):
    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("HERMES_KNOWLEDGE_TIMEOUT", "30s")

    with pytest.raises(KnowledgeUnavailable, match="HERMES_KNOWLEDGE_TIMEOUT"):
        load_config()


@pytest.mark.parametrize(
    "bad_url",
    [
        "127.0.0.1:8000",
        "ftp://knowledge.example.com",
        "http://knowledge.example.com/api",
        "http://knowledge.example.com?token=x",
    ],
)
def test_invalid_url_env_raises_unavailable(monkeypatch, bad_url):
    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", bad_url)

    with pytest.raises(KnowledgeUnavailable, match="HERMES_KNOWLEDGE_URL"):
        load_config()


def test_client_ignores_proxy_environment():
    client = _client(lambda request: httpx.Response(200, json={}))
    try:
        assert client._client.trust_env is False
    finally:
        client.close()


# ── Delete-confirmation hardening ──────────────────────────────────────────


def test_issue_confirmation_accepts_confirmation_token_spelling():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"confirmation_token": "ctok", "expires_at": "soon"}
        )

    issued = _client(handler).issue_library_delete_confirmation("capture", "c1")

    assert issued["token"] == "ctok"
    assert issued["confirmation_token"] == "ctok"


def test_issue_confirmation_without_token_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    with pytest.raises(KnowledgeUnavailable, match="confirmation token"):
        _client(handler).issue_library_delete_confirmation("capture", "c1")


def test_delete_without_token_is_refused_before_any_request():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={})

    for blank in ("", "   ", None):
        with pytest.raises(KnowledgeUnavailable, match="confirmation token"):
            _client(handler).permanent_delete_library_item("capture", "c1", blank)

    assert calls == []


def test_delete_sends_unique_idempotency_key():
    idempotency_keys: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"token": "tok"})
        idempotency_keys.append(request.headers.get("idempotency-key"))
        return httpx.Response(200, json={"ok": True})

    with _client(handler) as client:
        issued = client.issue_library_delete_confirmation("capture", "c1")
        client.permanent_delete_library_item("capture", "c1", issued["token"])
        client.permanent_delete_library_item("capture", "c1", issued["token"])

    assert all(idempotency_keys)
    assert len(idempotency_keys) == 2
    assert idempotency_keys[0] != idempotency_keys[1]
