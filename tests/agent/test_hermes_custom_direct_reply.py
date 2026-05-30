import json

from agent.hermes_custom_envelope_adapter import (
    direct_reply_from_latest_tool_result,
    direct_reply_from_tool_result_content,
)


def _tool_content(chat_preview: str, *, agent: str = "capture") -> str:
    structured = {
        "status": "success",
        "agent": agent,
        "intent": "show_capture_draft",
        "durable_artifacts": [],
        "source_map": [],
        "next_actions": [],
        "warnings": [],
        "errors": [],
        "meta": {},
    }
    return (
        "USER_VISIBLE_REPLY:\n"
        f"{chat_preview}\n\n"
        "STRUCTURED_AGENT_RESULT_DO_NOT_REWRITE:\n"
        f"{json.dumps(structured, ensure_ascii=False)}\n\n"
        "Return USER_VISIBLE_REPLY as-is as the chat response; do not summarize or shorten it."
    )


def test_direct_reply_extracts_capture_user_visible_reply_for_weixin():
    content = _tool_content("草稿第 1 页正文")

    assert (
        direct_reply_from_tool_result_content(
            "show_capture_draft",
            content,
            platform="weixin",
        )
        == "草稿第 1 页正文"
    )


def test_direct_reply_extracts_life_rejection_for_weixin():
    content = _tool_content("这条我暂时不能作为生活记录保存。", agent="life")

    assert (
        direct_reply_from_tool_result_content(
            "record_life_event",
            content,
            platform="weixin",
        )
        == "这条我暂时不能作为生活记录保存。"
    )


def test_direct_reply_is_disabled_outside_weixin():
    content = _tool_content("草稿第 1 页正文")

    assert (
        direct_reply_from_tool_result_content(
            "show_capture_draft",
            content,
            platform="feishu",
        )
        is None
    )


def test_direct_reply_enforces_weixin_length_limit():
    content = _tool_content("字" * 1600)

    reply = direct_reply_from_tool_result_content(
        "show_capture_draft",
        content,
        platform="weixin",
    )

    assert reply is not None
    assert len(reply) <= 1500
    assert reply.endswith("…")


def test_direct_reply_uses_latest_capture_tool_result_in_current_batch():
    messages = [
        {"role": "user", "content": "展开草稿"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
                {"id": "call2", "function": {"name": "show_capture_draft"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _tool_content("搜索答案", agent="rag"),
            "tool_call_id": "call1",
        },
        {
            "role": "tool",
            "name": "show_capture_draft",
            "content": _tool_content("草稿正文"),
            "tool_call_id": "call2",
        },
    ]

    assert direct_reply_from_latest_tool_result(messages, platform="weixin") == (
        "草稿正文",
        "show_capture_draft",
    )
