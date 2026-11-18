"""
Tests for cross-platform audio/voice media routing.

These tests pin the expected delivery path for audio media files across
Telegram (where Bot-API sendAudio only accepts MP3/M4A and .ogg/.opus
only renders as a voice bubble when explicitly flagged) and via
``GatewayRunner._deliver_media_from_response``.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.attachment_policy import AgentReply, LocalAttachment
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.run import GatewayRunner
from gateway.session import SessionSource, build_session_key


class _MediaRoutingAdapter(BasePlatformAdapter):
    def __init__(self):
        super().__init__(PlatformConfig(enabled=True, token="test"), Platform.TELEGRAM)

    async def connect(self):
        return True

    async def disconnect(self):
        pass

    async def send(self, chat_id, content=None, **kwargs):
        return SendResult(success=True, message_id="text")

    async def get_chat_info(self, chat_id):
        return {"id": chat_id, "type": "dm"}


def _event(thread_id=None):
    source = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="chat-1",
        chat_type="dm",
        thread_id=thread_id,
    )
    return MessageEvent(
        text="make speech",
        message_type=MessageType.TEXT,
        source=source,
        message_id="msg-1",
    )


@pytest.mark.asyncio
async def test_base_adapter_routes_attachment_only_reply_to_document_sender(tmp_path):
    adapter = _MediaRoutingAdapter()
    event = _event()
    path = tmp_path / "speech.flac"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter._message_handler = AsyncMock(return_value=AgentReply("", (LocalAttachment(path, identity),)))
    adapter.send_voice = AsyncMock(return_value=SendResult(success=True, message_id="voice"))
    adapter.send_document = AsyncMock(return_value=SendResult(success=True, message_id="doc"))

    await adapter._process_message_background(event, build_session_key(event.source))

    adapter.send_document.assert_awaited_once_with(
        chat_id="chat-1",
        file_path=str(path),
        metadata=None,
    )
    adapter.send_voice.assert_not_awaited()


@pytest.mark.asyncio
async def test_base_adapter_routes_non_voice_telegram_ogg_to_document_sender(tmp_path):
    adapter = _MediaRoutingAdapter()
    event = _event()
    path = tmp_path / "speech.ogg"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter._message_handler = AsyncMock(return_value=AgentReply("speech", (LocalAttachment(path, identity),)))
    adapter.send_voice = AsyncMock(return_value=SendResult(success=True, message_id="voice"))
    adapter.send_document = AsyncMock(return_value=SendResult(success=True, message_id="doc"))

    await adapter._process_message_background(event, build_session_key(event.source))

    adapter.send_document.assert_awaited_once_with(
        chat_id="chat-1",
        file_path=str(path),
        metadata={"notify": True},
    )
    adapter.send_voice.assert_not_awaited()


@pytest.mark.asyncio
async def test_base_adapter_routes_telegram_voice_ogg_to_voice_sender(tmp_path):
    adapter = _MediaRoutingAdapter()
    event = _event()
    path = tmp_path / "speech.ogg"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter._message_handler = AsyncMock(
        return_value=AgentReply("speech", (LocalAttachment(path, identity, is_voice=True),))
    )
    adapter.send_voice = AsyncMock(return_value=SendResult(success=True, message_id="voice"))
    adapter.send_document = AsyncMock(return_value=SendResult(success=True, message_id="doc"))

    await adapter._process_message_background(event, build_session_key(event.source))

    adapter.send_voice.assert_awaited_once_with(
        chat_id="chat-1",
        audio_path=str(path),
        metadata={"notify": True},
    )
    adapter.send_document.assert_not_awaited()


def _fake_runner(thread_meta):
    """Build a fake GatewayRunner-like object with the helper methods needed by
    _deliver_media_from_response."""
    runner = SimpleNamespace(
        _thread_metadata_for_source=lambda source, anchor=None: thread_meta,
        _reply_anchor_for_event=lambda event: None,
    )
    return runner


@pytest.mark.asyncio
async def test_streaming_delivery_routes_telegram_flac_media_tag_to_document_sender(tmp_path):
    event = _event(thread_id="topic-1")
    path = tmp_path / "speech.flac"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter = SimpleNamespace(
        name="test",
        extract_media=BasePlatformAdapter.extract_media,
        extract_images=BasePlatformAdapter.extract_images,
        extract_local_files=BasePlatformAdapter.extract_local_files,
        send_voice=AsyncMock(return_value=SendResult(success=True, message_id="voice")),
        send_document=AsyncMock(return_value=SendResult(success=True, message_id="doc")),
        send_image_file=AsyncMock(return_value=SendResult(success=True, message_id="image")),
        send_video=AsyncMock(return_value=SendResult(success=True, message_id="video")),
    )

    await GatewayRunner._deliver_media_from_response(
        _fake_runner({"thread_id": "topic-1"}),
        AgentReply("speech", (LocalAttachment(path, identity),)),
        event,
        adapter,
    )

    adapter.send_document.assert_awaited_once_with(
        chat_id="chat-1",
        file_path=str(path),
        metadata={"thread_id": "topic-1"},
    )
    adapter.send_voice.assert_not_awaited()


@pytest.mark.asyncio
async def test_streaming_delivery_routes_non_voice_telegram_ogg_media_tag_to_document_sender(tmp_path):
    event = _event(thread_id="topic-1")
    path = tmp_path / "speech.ogg"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter = SimpleNamespace(
        name="test",
        extract_media=BasePlatformAdapter.extract_media,
        extract_images=BasePlatformAdapter.extract_images,
        extract_local_files=BasePlatformAdapter.extract_local_files,
        send_voice=AsyncMock(return_value=SendResult(success=True, message_id="voice")),
        send_document=AsyncMock(return_value=SendResult(success=True, message_id="doc")),
        send_image_file=AsyncMock(return_value=SendResult(success=True, message_id="image")),
        send_video=AsyncMock(return_value=SendResult(success=True, message_id="video")),
    )

    await GatewayRunner._deliver_media_from_response(
        _fake_runner({"thread_id": "topic-1"}),
        AgentReply("speech", (LocalAttachment(path, identity),)),
        event,
        adapter,
    )

    adapter.send_document.assert_awaited_once_with(
        chat_id="chat-1",
        file_path=str(path),
        metadata={"thread_id": "topic-1"},
    )
    adapter.send_voice.assert_not_awaited()


@pytest.mark.asyncio
async def test_streaming_delivery_routes_telegram_mp3_media_tag_to_voice_sender(tmp_path):
    """MP3 audio on Telegram must go through send_voice (which routes to
    sendAudio internally); Telegram accepts MP3 for the audio player."""
    event = _event(thread_id="topic-1")
    path = tmp_path / "speech.mp3"
    path.write_bytes(b"audio")
    identity = LocalAttachment.file_identity(path)
    assert identity is not None
    adapter = SimpleNamespace(
        name="test",
        extract_media=BasePlatformAdapter.extract_media,
        extract_images=BasePlatformAdapter.extract_images,
        extract_local_files=BasePlatformAdapter.extract_local_files,
        send_voice=AsyncMock(return_value=SendResult(success=True, message_id="voice")),
        send_document=AsyncMock(return_value=SendResult(success=True, message_id="doc")),
        send_image_file=AsyncMock(return_value=SendResult(success=True, message_id="image")),
        send_video=AsyncMock(return_value=SendResult(success=True, message_id="video")),
    )

    await GatewayRunner._deliver_media_from_response(
        _fake_runner({"thread_id": "topic-1"}),
        AgentReply("speech", (LocalAttachment(path, identity, is_voice=True),)),
        event,
        adapter,
    )

    adapter.send_voice.assert_awaited_once_with(
        chat_id="chat-1",
        audio_path=str(path),
        metadata={"thread_id": "topic-1"},
    )
    adapter.send_document.assert_not_awaited()
