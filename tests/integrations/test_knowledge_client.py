"""Contract tests for the Hermes Knowledge HTTP client."""
from __future__ import annotations

import json

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
    cached_contract_status,
    clear_contract_cache,
    ensure_compatible,
    get_client,
    load_config,
)


@pytest.fixture(autouse=True)
def _reset_contract_cache():
    """Contract checks are process-global; never leak them across tests."""
    clear_contract_cache()
    yield
    clear_contract_cache()


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


# ── Contract validation caching ────────────────────────────────────────────


_HEALTHY_HEALTH = {"service": "hermes-knowledge", "contract_version": 1}


def test_get_client_probes_health_once_per_base_url(monkeypatch):
    """A second client for the same service must reuse the cached contract."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=_HEALTHY_HEALTH)

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")
    transport = httpx.MockTransport(handler)

    first = get_client(transport=transport)
    second = get_client(transport=transport)

    try:
        assert first is not None and second is not None
        assert calls == ["http://knowledge.test/api/health"]
        assert first.contract_version == 1
        assert second.contract_version == 1
    finally:
        first.close()
        second.close()


def test_get_client_rejects_old_contract(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"service": "hermes-knowledge", "contract_version": 0}
        )

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")

    with pytest.raises(KnowledgeIncompatible):
        get_client(transport=httpx.MockTransport(handler))
    assert cached_contract_status("http://knowledge.test") is None


def test_get_client_rejects_wrong_service(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"service": "someone-else", "contract_version": 1})

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")

    with pytest.raises(KnowledgeIncompatible):
        get_client(transport=httpx.MockTransport(handler))


def test_unreachable_service_failure_is_not_cached(monkeypatch):
    import integrations.hermes_knowledge.client as client_module

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)
    transport = httpx.MockTransport(handler)

    with pytest.raises(KnowledgeUnavailable):
        get_client(transport=transport)
    # The GET health probe retries transport errors once.
    assert len(calls) == 2
    assert cached_contract_status("http://knowledge.test") is None

    with pytest.raises(KnowledgeUnavailable):
        get_client(transport=transport)
    # Failure was not cached, so the second call probes again.
    assert len(calls) == 4


def test_incompatible_contract_failure_is_not_cached(monkeypatch):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            200, json={"service": "hermes-knowledge", "contract_version": 0}
        )

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")
    transport = httpx.MockTransport(handler)

    with pytest.raises(KnowledgeIncompatible):
        get_client(transport=transport)
    with pytest.raises(KnowledgeIncompatible):
        get_client(transport=transport)
    assert len(calls) == 2


def test_cached_contract_status_reflects_successful_probe(monkeypatch):
    assert cached_contract_status("http://knowledge.test") is None

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_HEALTHY_HEALTH)

    monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://knowledge.test")
    client = get_client(transport=httpx.MockTransport(handler))
    try:
        assert client is not None
        assert cached_contract_status("http://knowledge.test") == {
            "contract_version": 1,
            "compatible": True,
        }
        assert cached_contract_status("http://other.test") is None
    finally:
        client.close()


def test_concurrent_contract_checks_probe_once():
    """Double-checked locking: racing cold-cache callers share one probe."""
    import threading
    import time as time_module

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        time_module.sleep(0.05)
        return httpx.Response(200, json=_HEALTHY_HEALTH)

    transport = httpx.MockTransport(handler)
    config = KnowledgeConfig(base_url="http://knowledge.test", token="t")
    clients = [KnowledgeClient(config, transport=transport) for _ in range(4)]
    errors: list[BaseException] = []

    def run(client: KnowledgeClient) -> None:
        try:
            ensure_compatible(client)
        except BaseException as exc:  # noqa: BLE001 - recorded for the assertion
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(client,)) for client in clients]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    try:
        assert errors == []
        assert calls == ["http://knowledge.test/api/health"]
        assert all(client.contract_version == 1 for client in clients)
    finally:
        for client in clients:
            client.close()


# ── Library / folder / draft delegation paths ──────────────────────────────


def _recording_client():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    return _client(handler), seen


def _raw_path(request: httpx.Request) -> bytes:
    return request.url.raw_path.split(b"?")[0]


def test_library_item_client_methods_use_contract_paths():
    client, seen = _recording_client()

    client.create_library_item(
        body="B",
        title="T",
        source="S",
        source_type="manual",
        folder_path="Inbox",
    )
    client.patch_library_item("capture_draft", "d 1", title="T2", body=None, tags=["a"])
    client.delete_library_item("capture", "c/1")

    assert [request.method for request in seen] == ["POST", "PATCH", "DELETE"]
    assert seen[0].url.path == "/api/library/items"
    assert json.loads(seen[0].content) == {
        "body": "B",
        "title": "T",
        "source": "S",
        "source_type": "manual",
        "folder_path": "Inbox",
    }
    assert _raw_path(seen[1]) == b"/api/library/items/capture_draft/d%201"
    # None fields are omitted: only what the user edited is sent.
    assert json.loads(seen[1].content) == {"title": "T2", "tags": ["a"]}
    assert _raw_path(seen[2]) == b"/api/library/items/capture/c%2F1"


def test_library_folder_client_methods_use_contract_paths():
    client, seen = _recording_client()

    client.list_library_folders()
    client.create_library_folder("新目录")
    client.rename_library_folder("AI 产品/子目录", "新名字")

    assert [request.method for request in seen] == ["GET", "POST", "PATCH"]
    assert seen[0].url.path == "/api/library/folders"
    assert json.loads(seen[1].content) == {"name": "新目录"}
    assert _raw_path(seen[2]) == (
        b"/api/library/folders/AI%20%E4%BA%A7%E5%93%81%2F%E5%AD%90%E7%9B%AE%E5%BD%95"
    )
    assert json.loads(seen[2].content) == {"name": "新名字"}


def test_capture_draft_client_methods_use_contract_paths():
    client, seen = _recording_client()

    client.patch_capture_draft(
        "d1",
        title="T",
        draft_text="B",
        summary=None,
        tags=["a"],
        capture_intent={"folder_path": "Inbox"},
    )
    client.delete_capture_draft("d1")
    client.delete_reading_draft("r 1")

    assert [request.method for request in seen] == ["PATCH", "DELETE", "DELETE"]
    # The dashboard route carries an /editable suffix; the service contract
    # does not — the client must address /api/capture-drafts/{id}.
    assert _raw_path(seen[0]) == b"/api/capture-drafts/d1"
    assert json.loads(seen[0].content) == {
        "title": "T",
        "draft_text": "B",
        "tags": ["a"],
        "capture_intent": {"folder_path": "Inbox"},
    }
    assert _raw_path(seen[1]) == b"/api/capture-drafts/d1"
    assert _raw_path(seen[2]) == b"/api/reading/drafts/r%201"


# ── Library reads / garden / cards / graph / answer paths ──────────────────


def test_library_read_client_methods():
    client, seen = _recording_client()

    client.list_library_items(folder="AI", view="", search="", limit=50)
    client.get_library_item("capture", "c/1")

    assert [request.method for request in seen] == ["GET", "GET"]
    assert seen[0].url.path == "/api/library/items"
    # Empty query values are not sent.
    assert dict(seen[0].url.params) == {"folder": "AI", "limit": "50"}
    assert _raw_path(seen[1]) == b"/api/library/items/capture/c%2F1"


def test_garden_client_methods():
    client, seen = _recording_client()

    client.create_garden_draft(
        capture_ids=["c1", "c2"],
        title="T",
        card_kind="viewpoint",
        instruction="I",
    )
    client.list_garden_cards(limit=10)
    client.list_garden_cards(limit=5, status="active")
    client.delete_garden_card("k 1")

    assert [request.method for request in seen] == ["POST", "GET", "GET", "DELETE"]
    assert seen[0].url.path == "/api/garden/drafts"
    assert json.loads(seen[0].content) == {
        "capture_ids": ["c1", "c2"],
        "title": "T",
        "card_kind": "viewpoint",
        "instruction": "I",
    }
    assert seen[1].url.path == "/api/garden/cards"
    assert dict(seen[1].url.params) == {"limit": "10"}
    assert dict(seen[2].url.params) == {"limit": "5", "status": "active"}
    assert _raw_path(seen[3]) == b"/api/garden/cards/k%201"


def test_garden_confirmation_issues_token_and_commit_sends_it():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/confirmation"):
            return httpx.Response(
                200,
                json={
                    "token": "gtok",
                    "expires_at": "soon",
                    "intent": "commit_garden_draft",
                },
            )
        return httpx.Response(200, json={"ok": True})

    with _client(handler) as client:
        issued = client.issue_garden_confirmation("d 1")
        result = client.commit_garden_draft("d 1", issued["token"])

    assert issued["token"] == "gtok"
    assert result == {"ok": True}
    assert calls[0].method == "POST"
    assert _raw_path(calls[0]) == b"/api/garden/drafts/d%201/confirmation"
    assert calls[1].method == "POST"
    assert _raw_path(calls[1]) == b"/api/garden/drafts/d%201/commit"
    assert json.loads(calls[1].content) == {"confirmation_token": "gtok"}


def test_garden_commit_issues_token_when_omitted():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/confirmation"):
            return httpx.Response(200, json={"confirmation_token": "ctok"})
        return httpx.Response(200, json={"ok": True})

    with _client(handler) as client:
        client.commit_garden_draft("d1")

    assert [request.method for request in calls] == ["POST", "POST"]
    assert json.loads(calls[1].content) == {"confirmation_token": "ctok"}


def test_graph_and_answer_client_methods():
    client, seen = _recording_client()

    client.graph()
    client.graph(focus_kind="capture", focus_id="c1", depth=2, limit=40)
    client.refresh_graph()
    client.create_answer_draft({"assistant_answer": "a", "user_message": "q"})

    assert [request.method for request in seen] == ["GET", "GET", "POST", "POST"]
    assert seen[0].url.path == "/api/knowledge/graph"
    assert dict(seen[0].url.params) == {"depth": "1", "limit": "80"}
    assert dict(seen[1].url.params) == {
        "depth": "2",
        "limit": "40",
        "focus_kind": "capture",
        "focus_id": "c1",
    }
    assert seen[2].url.path == "/api/knowledge/graph/refresh"
    assert seen[3].url.path == "/api/knowledge/answer-drafts"
    assert json.loads(seen[3].content) == {
        "assistant_answer": "a",
        "user_message": "q",
    }


def test_cached_contract_status_does_not_block_on_an_in_flight_probe():
    """The probe must never hold the cache lock across network I/O.

    ``/api/status`` reads the cache; if the health probe kept the cache lock
    for its whole timeout, a slow knowledge service would stall the public
    status endpoint.  The probe therefore runs under a per-service lock.
    """
    import threading
    import time as time_module

    probe_started = threading.Event()
    release_probe = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        probe_started.set()
        release_probe.wait(timeout=5)
        return httpx.Response(200, json=_HEALTHY_HEALTH)

    client = KnowledgeClient(
        KnowledgeConfig(base_url="http://slow.test", token="t"),
        transport=httpx.MockTransport(handler),
    )
    thread = threading.Thread(target=lambda: ensure_compatible(client))
    thread.start()
    try:
        assert probe_started.wait(timeout=2)
        started_at = time_module.perf_counter()
        status = cached_contract_status("http://slow.test")
        elapsed = time_module.perf_counter() - started_at
        assert status is None
        assert elapsed < 0.2, f"status blocked for {elapsed:.3f}s behind the probe"
    finally:
        release_probe.set()
        thread.join(timeout=5)
        client.close()
    assert not thread.is_alive()


def test_exception_classes_are_shared_with_the_package_module():
    """A caller catching the package exception must catch client failures.

    ``client.py`` used to define its own ``KnowledgeUnavailable``; it was a
    different class from ``integrations.hermes_knowledge.KnowledgeUnavailable``,
    so ``except`` clauses on the package-level name silently missed every
    transport/HTTP error.
    """
    import integrations.hermes_knowledge as package
    import integrations.hermes_knowledge.client as client_module

    assert client_module.KnowledgeUnavailable is package.KnowledgeUnavailable
    assert client_module.KnowledgeIncompatible is package.KnowledgeIncompatible
    assert issubclass(client_module.KnowledgeNotFound, package.KnowledgeUnavailable)


# ── Tool dispatch / call_tool ──────────────────────────────────────────────


def test_call_tool_encodes_args_and_kwargs():
    client, seen = _recording_client()

    result = client.call_tool(
        "rag_bridge",
        "search_knowledge_base",
        args=["q", 2],
        kwargs={"limit": 3, "nested": {"a": 1}},
    )

    assert result == {"ok": True}
    assert seen[0].method == "POST"
    assert _raw_path(seen[0]) == b"/api/tools/rag_bridge/search_knowledge_base"
    assert json.loads(seen[0].content) == {
        "args": ["q", 2],
        "kwargs": {"limit": 3, "nested": {"a": 1}},
    }


def test_call_tool_defaults_to_empty_args_and_kwargs():
    client, seen = _recording_client()

    client.call_tool("rag_bridge", "search")

    assert json.loads(seen[0].content) == {"args": [], "kwargs": {}}


def test_call_tool_encodes_unsafe_path_segments():
    client, seen = _recording_client()

    client.call_tool("a/b", "c d")

    assert _raw_path(seen[0]) == b"/api/tools/a%2Fb/c%20d"


def test_call_tool_returns_service_error_payload_as_is():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "bridge raised"})

    assert _client(handler).call_tool("rag_bridge", "search") == {
        "error": "bridge raised"
    }


def test_dispatch_drops_callable_kwargs(monkeypatch):
    import integrations.hermes_knowledge.tool_bridge as tool_bridge

    calls: list[tuple] = []

    class _FakeClient:
        def call_tool(self, module_name, function_name, *, args=None, kwargs=None):
            calls.append((module_name, function_name, args, kwargs))
            return {"ok": True}

        def close(self):
            pass

    monkeypatch.setattr(tool_bridge, "get_client", lambda: _FakeClient())

    result = tool_bridge.dispatch(
        "research_bridge",
        "async_web_assist_answer",
        question="q",
        event_callback=lambda event: None,
    )

    assert result == {"ok": True}
    assert calls == [
        ("research_bridge", "async_web_assist_answer", [], {"question": "q"})
    ]


def test_dispatch_uses_http_client_when_configured(monkeypatch):
    import integrations.hermes_knowledge.tool_bridge as tool_bridge

    calls: list[tuple] = []
    closed: list[bool] = []

    class _FakeClient:
        def call_tool(self, module_name, function_name, *, args=None, kwargs=None):
            calls.append((module_name, function_name, args, kwargs))
            return {"ok": True}

        def close(self):
            closed.append(True)

    monkeypatch.setattr(tool_bridge, "get_client", lambda: _FakeClient())

    result = tool_bridge.dispatch(
        "rag_bridge", "search_knowledge_base", "q", limit=3, filters={"tag": "ai"}
    )

    assert result == {"ok": True}
    assert calls == [
        (
            "rag_bridge",
            "search_knowledge_base",
            ["q"],
            {"limit": 3, "filters": {"tag": "ai"}},
        )
    ]
    assert closed == [True]


def test_dispatch_local_mode_imports_local_checkout(monkeypatch):
    from types import SimpleNamespace

    import integrations.hermes_knowledge.tool_bridge as tool_bridge

    ensure_calls: list[bool] = []
    import_calls: list[str] = []

    def _fake_import(name):
        import_calls.append(name)
        return SimpleNamespace(
            run=lambda *a, **k: {"local": True, "args": a, "kwargs": k}
        )

    monkeypatch.setattr(tool_bridge, "get_client", lambda: None)
    monkeypatch.setattr(
        tool_bridge, "ensure_custom_path", lambda: ensure_calls.append(True)
    )
    monkeypatch.setattr(tool_bridge.importlib, "import_module", _fake_import)

    result = tool_bridge.dispatch("rag_bridge", "run", "q", limit=2)

    assert ensure_calls == [True]
    assert import_calls == ["bridge.rag_bridge"]
    assert result == {"local": True, "args": ("q",), "kwargs": {"limit": 2}}


def test_dispatch_normalises_non_json_kwargs(monkeypatch):
    from pathlib import Path

    import integrations.hermes_knowledge.tool_bridge as tool_bridge

    captured: dict = {}

    class _FakeClient:
        def call_tool(self, module_name, function_name, *, args=None, kwargs=None):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return {"ok": True}

        def close(self):
            pass

    monkeypatch.setattr(tool_bridge, "get_client", lambda: _FakeClient())

    tool_bridge.dispatch(
        "rag_bridge", "run", Path("notes/a.md"), target=Path("b.md")
    )

    assert captured["args"] == [str(Path("notes/a.md"))]
    assert captured["kwargs"] == {"target": str(Path("b.md"))}


def test_dispatch_rejects_unserialisable_arguments(monkeypatch):
    import integrations.hermes_knowledge.tool_bridge as tool_bridge

    class _FakeClient:
        def call_tool(self, *args, **kwargs):  # pragma: no cover - must not run
            raise AssertionError("knowledge service must not be called")

        def close(self):
            pass

    monkeypatch.setattr(tool_bridge, "get_client", lambda: _FakeClient())

    circular: list = []
    circular.append(circular)

    with pytest.raises(KnowledgeUnavailable, match="payload"):
        tool_bridge.dispatch("rag_bridge", "run", payload=circular)
