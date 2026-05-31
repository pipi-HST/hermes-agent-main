import json

from agent.hermes_custom_envelope_adapter import (
    ensure_source_footer_for_final_response,
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


def _rag_tool_content(chat_preview: str, source_map: list[dict]) -> str:
    structured = {
        "status": "success",
        "agent": "rag",
        "intent": "search_knowledge_base",
        "durable_artifacts": [],
        "source_map": source_map,
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


def _tool_error_content(chat_preview: str, *, agent: str = "capture") -> str:
    structured = {
        "status": "error",
        "agent": agent,
        "intent": "show_capture_draft",
        "durable_artifacts": [],
        "source_map": [],
        "next_actions": [],
        "warnings": [],
        "errors": [chat_preview],
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


def test_direct_reply_extracts_garden_preview_for_weixin():
    content = _tool_content("已生成 Garden 观点草稿。", agent="garden")

    for tool_name in (
        "synthesize_garden",
        "revise_garden_draft",
        "commit_garden_draft",
        "continue_rag_answer",
        "generate_canvas",
    ):
        assert (
            direct_reply_from_tool_result_content(
                tool_name,
                content,
                platform="weixin",
            )
            == "已生成 Garden 观点草稿。"
        )


def test_direct_reply_extracts_rag_answer_for_weixin():
    content = _rag_tool_content(
        "RAG 回答\n\n📎 来源\n[1] AI文章",
        [{"title": "AI文章", "path": "captures/ai.md"}],
    )

    assert (
        direct_reply_from_tool_result_content(
            "search_my_notes",
            content,
            platform="weixin",
        )
        == "RAG 回答\n\n📎 来源\n[1] AI文章"
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


def test_direct_reply_does_not_use_error_tool_result_as_final_reply():
    content = _tool_error_content("没有找到可查看的草稿，请先发送链接或文本。")

    assert (
        direct_reply_from_tool_result_content(
            "show_capture_draft",
            content,
            platform="weixin",
        )
        is None
    )


def test_latest_direct_reply_falls_back_to_search_result_after_draft_error():
    messages = [
        {"role": "user", "content": "为什么说工具决定模型上限，详细展开讲讲"},
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
            "content": _tool_error_content("没有找到可查看的草稿，请先发送链接或文本。"),
            "tool_call_id": "call2",
        },
    ]

    assert direct_reply_from_latest_tool_result(messages, platform="weixin") == (
        "搜索答案",
        "search_my_notes",
    )


def test_source_footer_added_when_rag_answer_drops_citations():
    messages = [
        {"role": "user", "content": "展开讲讲"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "工具回答有引用 [1]",
                [
                    {
                        "role": "evidence",
                        "type": "capture_note",
                        "id": "cap1",
                        "title": "用AI的这三年，想跟你分享这9条心得。",
                        "path": "captures/ai.md",
                        "section": "",
                        "status": "",
                    }
                ],
            ),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "这是自然展开，但没有引用。"},
    ]

    reply = ensure_source_footer_for_final_response(
        "这是自然展开，但没有引用。",
        messages,
        platform="weixin",
    )

    assert "参考来源：" in reply
    assert "[1] 用AI的这三年，想跟你分享这9条心得。" in reply


def test_source_footer_added_when_final_answer_has_citation_but_no_source_list():
    messages = [
        {"role": "user", "content": "展开讲讲"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "工具回答有引用 [1]",
                [
                    {
                        "role": "evidence",
                        "type": "capture_note",
                        "id": "cap1",
                        "title": "AI文章",
                        "path": "captures/ai.md",
                        "section": "",
                        "status": "",
                    }
                ],
            ),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "这是自然展开 [1]。"},
    ]

    reply = ensure_source_footer_for_final_response(
        "这是自然展开 [1]。",
        messages,
        platform="weixin",
    )

    assert reply == "这是自然展开 [1]。\n\n参考来源：[1] AI文章"


def test_source_footer_keeps_all_cited_sources():
    source_map = [
        {"title": f"来源{i}", "path": f"captures/{i}.md"}
        for i in range(1, 7)
    ]
    messages = [
        {"role": "user", "content": "结合知识库回答"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content("工具回答", source_map),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "回答用了很多来源 [1][2][3][4][5][6]。"},
    ]

    reply = ensure_source_footer_for_final_response(
        "回答用了很多来源 [1][2][3][4][5][6]。",
        messages,
        platform="weixin",
    )

    assert "[6] 来源6" in reply


def test_source_footer_only_adds_sources_cited_by_final_answer():
    messages = [
        {"role": "user", "content": "那个没背景的银行人怎么逆袭那篇"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "工具回答用了 [1]",
                [
                    {"title": "银行人破局", "path": "captures/bank.md"},
                    {"title": "Opus 4.8", "path": "captures/opus.md"},
                    {"title": "AI稳定性", "path": "captures/stability.md"},
                ],
            ),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "真正回答只用了第一篇 [1]。"},
    ]

    reply = ensure_source_footer_for_final_response(
        "真正回答只用了第一篇 [1]。",
        messages,
        platform="weixin",
    )

    assert reply == "真正回答只用了第一篇 [1]。\n\n参考来源：[1] 银行人破局"
    assert "Opus 4.8" not in reply
    assert "AI稳定性" not in reply


def test_source_footer_not_duplicated_when_final_answer_has_source_list():
    messages = [
        {"role": "user", "content": "展开讲讲"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "工具回答有引用 [1]",
                [{"title": "AI文章", "path": "captures/ai.md"}],
            ),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "这是自然展开 [1]。\n\n参考来源：[1] AI文章"},
    ]

    reply = ensure_source_footer_for_final_response(
        "这是自然展开 [1]。\n\n参考来源：[1] AI文章",
        messages,
        platform="weixin",
    )

    assert reply == "这是自然展开 [1]。\n\n参考来源：[1] AI文章"


def test_source_footer_uses_recent_turn_only():
    messages = [
        {"role": "user", "content": "上一次搜索"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "old-call", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "旧工具回答 [1]",
                [{"title": "旧来源", "path": "captures/old.md"}],
            ),
            "tool_call_id": "old-call",
        },
        {"role": "assistant", "content": "旧回答 [1]。"},
        {"role": "user", "content": "谢谢"},
        {"role": "assistant", "content": "不客气。"},
    ]

    reply = ensure_source_footer_for_final_response(
        "不客气。",
        messages,
        platform="weixin",
    )

    assert reply == "不客气。"


def test_source_footer_keeps_weixin_reply_under_limit():
    messages = [
        {"role": "user", "content": "展开讲讲"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call1", "function": {"name": "search_my_notes"}},
            ],
        },
        {
            "role": "tool",
            "name": "search_my_notes",
            "content": _rag_tool_content(
                "工具回答有引用 [1]",
                [{"title": "AI文章", "path": "captures/ai.md"}],
            ),
            "tool_call_id": "call1",
        },
        {"role": "assistant", "content": "很长的解释"},
    ]

    reply = ensure_source_footer_for_final_response(
        "字" * 1700,
        messages,
        platform="weixin",
    )

    assert len(reply) <= 1500
    assert reply.endswith("参考来源：[1] AI文章")
    assert "…" in reply
