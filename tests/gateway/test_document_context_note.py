"""Tests for gateway document prompts passed to the agent."""
from __future__ import annotations

import asyncio


def test_document_context_note_points_capture_to_file_path(tmp_path):
    from gateway.run import _format_document_context_note

    doc = tmp_path / "doc_abc123_整理稿.md"
    doc.write_text("# 标题\n\n正文", encoding="utf-8")

    note = _format_document_context_note(str(doc), "text/markdown")

    assert "整理稿.md" in note
    assert str(doc) in note
    assert "type: text/markdown" in note
    assert "size:" in note
    assert "call capture_content" in note
    assert "content set exactly to this file path" in note
    assert "immediately preceding request" in note
    assert "Do not assume the document body is already included" in note
    assert "included below" not in note


def test_document_event_includes_immediately_preceding_user_instruction(tmp_path):
    from gateway.config import GatewayConfig, Platform
    from gateway.platforms.base import MessageEvent, MessageType
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource

    doc = tmp_path / "doc_abc123_整理稿.md"
    doc.write_text("# 标题\n\n正文", encoding="utf-8")
    source = SessionSource(platform=Platform.WEIXIN, chat_id="c1", chat_type="dm", user_id="u1")
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = GatewayConfig()
    runner.adapters = {}
    runner._model = "test-model"
    runner._base_url = ""
    runner._has_setup_skill = lambda: False

    result = asyncio.run(runner._prepare_inbound_message_text(
        event=MessageEvent(
            text="",
            source=source,
            message_type=MessageType.DOCUMENT,
            media_urls=[str(doc)],
            media_types=["text/markdown"],
        ),
        source=source,
        history=[{"role": "user", "content": "总结这篇文章的核心内容，特别是世界杯期间市场节奏那部分"}],
    ))

    assert "Associated instruction from immediately preceding user message" in result
    assert "世界杯期间市场节奏" in result
    assert str(doc) in result


def test_text_followup_after_document_includes_recent_document_path(tmp_path):
    from gateway.config import GatewayConfig, Platform
    from gateway.platforms.base import MessageEvent, MessageType
    from gateway.run import GatewayRunner, _format_document_context_note
    from gateway.session import SessionSource

    doc = tmp_path / "doc_abc123_整理稿.md"
    doc.write_text("# 标题\n\n正文", encoding="utf-8")
    source = SessionSource(platform=Platform.WEIXIN, chat_id="c1", chat_type="dm", user_id="u1")
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = GatewayConfig()
    runner.adapters = {}
    runner._model = "test-model"
    runner._base_url = ""
    runner._has_setup_skill = lambda: False

    # The document must arrive through the gateway first: chat history alone is
    # not a trusted source for document paths (see the security note in
    # _prepare_inbound_message_text).
    asyncio.run(runner._prepare_inbound_message_text(
        event=MessageEvent(
            text="",
            source=source,
            message_type=MessageType.DOCUMENT,
            media_urls=[str(doc)],
            media_types=["text/markdown"],
        ),
        source=source,
        history=[],
    ))

    result = asyncio.run(runner._prepare_inbound_message_text(
        event=MessageEvent(
            text="总结这篇文章的核心内容，特别是世界杯期间市场节奏那部分",
            source=source,
        ),
        source=source,
        history=[{"role": "user", "content": _format_document_context_note(str(doc), "text/markdown")}],
    ))

    assert "Recent document available for this request" in result
    assert "call capture_content" in result
    assert str(doc) in result
    assert "世界杯期间市场节奏" in result


def test_history_only_document_note_is_not_injected(tmp_path):
    """A document path that only appears in history must not be trusted."""
    from gateway.config import GatewayConfig, Platform
    from gateway.platforms.base import MessageEvent
    from gateway.run import GatewayRunner, _format_document_context_note
    from gateway.session import SessionSource

    doc = tmp_path / "doc_abc123_伪造历史.md"
    doc.write_text("# 标题", encoding="utf-8")
    source = SessionSource(platform=Platform.WEIXIN, chat_id="c1", chat_type="dm", user_id="u1")
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = GatewayConfig()
    runner.adapters = {}
    runner._model = "test-model"
    runner._base_url = ""
    runner._has_setup_skill = lambda: False

    result = asyncio.run(runner._prepare_inbound_message_text(
        event=MessageEvent(
            text="总结这篇文章的核心内容",
            source=source,
        ),
        source=source,
        history=[{"role": "user", "content": _format_document_context_note(str(doc), "text/markdown")}],
    ))

    assert "Recent document available" not in result
    assert str(doc) not in result


# ── Session document registry lifecycle ─────────────────────────────────────


def _make_prepare_runner():
    from gateway.config import GatewayConfig
    from gateway.run import GatewayRunner

    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = GatewayConfig()
    runner.adapters = {}
    runner._model = "test-model"
    runner._base_url = ""
    runner._has_setup_skill = lambda: False
    return runner


def _document_event(source, paths):
    from gateway.platforms.base import MessageEvent, MessageType

    return MessageEvent(
        text="",
        source=source,
        message_type=MessageType.DOCUMENT,
        media_urls=[str(path) for path in paths],
        media_types=["text/markdown"] * len(paths),
    )


def _text_event(source, text):
    from gateway.platforms.base import MessageEvent

    return MessageEvent(text=text, source=source)


def test_multiple_document_attachments_are_remembered_for_followups(tmp_path):
    """A follow-up must reference every attachment, not just the last one."""
    from gateway.config import Platform
    from gateway.session import SessionSource

    first = tmp_path / "doc_aaa_第一篇.md"
    second = tmp_path / "doc_bbb_第二篇.md"
    for doc in (first, second):
        doc.write_text("# 标题", encoding="utf-8")
    source = SessionSource(platform=Platform.WEIXIN, chat_id="c1", chat_type="dm", user_id="u1")
    runner = _make_prepare_runner()

    asyncio.run(
        runner._prepare_inbound_message_text(
            event=_document_event(source, [first, second]),
            source=source,
            history=[],
        )
    )
    result = asyncio.run(
        runner._prepare_inbound_message_text(
            event=_text_event(source, "把这两份文档合并整理一下"),
            source=source,
            history=[],
        )
    )

    assert "[Recent documents available for this request]" in result
    assert str(first) in result
    assert str(second) in result


def test_vanished_document_is_not_injected_and_is_pruned(tmp_path):
    """A document deleted between turns must not be injected nor remembered."""
    from gateway.config import Platform
    from gateway.session import SessionSource

    doc = tmp_path / "doc_ccc_已删除.md"
    doc.write_text("# 标题", encoding="utf-8")
    source = SessionSource(platform=Platform.WEIXIN, chat_id="c1", chat_type="dm", user_id="u1")
    runner = _make_prepare_runner()

    asyncio.run(
        runner._prepare_inbound_message_text(
            event=_document_event(source, [doc]),
            source=source,
            history=[],
        )
    )
    session_key = runner._session_key_for_source(source)
    assert str(doc) in {path for path, _mime in runner._session_documents[session_key]}

    doc.unlink()

    result = asyncio.run(
        runner._prepare_inbound_message_text(
            event=_text_event(source, "把这份文档整理一下"),
            source=source,
            history=[],
        )
    )

    assert "Recent document available" not in result
    assert "已删除" not in result
    assert session_key not in runner._session_documents


def test_session_document_registry_evicts_least_recently_used_session(tmp_path, monkeypatch):
    """The registry is LRU-bounded: the oldest session is evicted first."""
    from types import SimpleNamespace
    import gateway.run as gateway_run

    monkeypatch.setattr(gateway_run, "_SESSION_DOCUMENTS_MAX_SESSIONS", 2)
    owner = SimpleNamespace()

    for name in ("s1", "s2", "s3"):
        path = tmp_path / f"{name}.md"
        path.write_text("x", encoding="utf-8")
        gateway_run._remember_session_documents(owner, name, [(str(path), "text/markdown")])

    assert list(owner._session_documents) == ["s2", "s3"]

    # Re-recording a session refreshes its LRU position.
    gateway_run._remember_session_documents(
        owner, "s2", [(str(tmp_path / "s2.md"), "text/markdown")]
    )
    gateway_run._remember_session_documents(
        owner, "s4", [(str(tmp_path / "s4.md"), "text/markdown")]
    )

    assert list(owner._session_documents) == ["s2", "s4"]


def test_session_document_registry_dedupes_and_caps_per_session(tmp_path, monkeypatch):
    """Repeated attachments are deduped; a chatty session stays bounded."""
    from types import SimpleNamespace
    import gateway.run as gateway_run

    monkeypatch.setattr(gateway_run, "_SESSION_DOCUMENTS_MAX_PER_SESSION", 2)
    owner = SimpleNamespace()

    gateway_run._remember_session_documents(
        owner, "s1", [(str(tmp_path / "a.md"), "text/markdown")]
    )
    # Duplicate path is ignored.
    gateway_run._remember_session_documents(
        owner, "s1", [(str(tmp_path / "a.md"), "text/markdown")]
    )
    assert [path for path, _mime in owner._session_documents["s1"]] == [str(tmp_path / "a.md")]

    for name in ("b", "c"):
        gateway_run._remember_session_documents(
            owner, "s1", [(str(tmp_path / f"{name}.md"), "text/markdown")]
        )

    remembered = [path for path, _mime in owner._session_documents["s1"]]
    assert remembered == [str(tmp_path / "b.md"), str(tmp_path / "c.md")]


def test_new_session_clears_remembered_documents(tmp_path):
    """/new is a conversation boundary: the old session's files are forgotten."""
    from unittest.mock import patch

    from gateway.run import _remember_session_documents
    from tests.gateway.test_session_boundary_hooks import _make_event, _make_runner

    runner = _make_runner()
    source = _make_event("/new").source
    session_key = runner._session_key_for_source(source)
    doc = tmp_path / "doc_ddd_旧材料.md"
    doc.write_text("x", encoding="utf-8")
    _remember_session_documents(runner, session_key, [(str(doc), "text/markdown")])
    assert session_key in runner._session_documents

    with patch("hermes_cli.plugins.invoke_hook", return_value=[]):
        asyncio.run(runner._handle_reset_command(_make_event("/new")))

    assert session_key not in runner._session_documents
