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
    from gateway.platforms.base import MessageEvent
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
