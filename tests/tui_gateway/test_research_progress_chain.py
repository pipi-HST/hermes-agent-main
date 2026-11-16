import json
import sqlite3


def test_research_tool_progress_reaches_tui_gateway(monkeypatch):
    from tools import research_with_web_tool
    import tui_gateway.server as server

    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))
    server._sessions["sid-research"] = {
        "tool_progress_mode": "all",
        "edit_snapshots": {},
        "tool_started_at": {},
    }

    async def fake_research_answer(**kwargs):
        await kwargs["event_callback"]({"type": "planning_start"})
        await kwargs["event_callback"](
            {
                "type": "web_query_start",
                "query": "OpenAI 是什么",
                "queries": ["OpenAI 是什么"],
            }
        )
        await kwargs["event_callback"](
            {
                "type": "evidence_critic_done",
                "web_sources": [{"ref": "W1", "title": "OpenAI"}],
                "rejected_sources": [],
            }
        )
        return {
            "status": "success",
            "agent": "research",
            "intent": "research_answer",
            "chat_preview": "OpenAI 是一家 AI 研究与产品公司 [W1]",
            "durable_artifacts": [],
            "source_map": [{"ref": "W1", "type": "web", "title": "OpenAI", "url": "https://openai.com"}],
            "next_actions": [],
            "warnings": [],
            "errors": [],
            "meta": {
                "web_sources": [{"ref": "W1", "title": "OpenAI", "url": "https://openai.com"}],
                "research_trace": {"web_search_attempted": True},
            },
        }

    monkeypatch.setattr(research_with_web_tool, "_async_research_entry", fake_research_answer)

    server._on_tool_start("sid-research", "call-1", "research_with_web", {"query": "OpenAI 是什么"})
    result = research_with_web_tool._handler(
        {"query": "OpenAI 是什么", "mode": "web_only"},
        tool_progress_callback=lambda event, name=None, preview=None, args=None, **kwargs: server._on_tool_progress(
            "sid-research",
            event,
            name,
            preview,
            args,
            **kwargs,
        ),
    )
    server._on_tool_complete("sid-research", "call-1", "research_with_web", {"query": "OpenAI 是什么"}, result)

    assert json.loads(result)["chat_preview"] == "OpenAI 是一家 AI 研究与产品公司 [W1]"
    assert [event for event, _sid, _payload in emitted] == [
        "tool.start",
        "tool.progress",
        "tool.progress",
        "tool.progress",
        "tool.complete",
    ]
    progress_payloads = [payload for event, _sid, payload in emitted if event == "tool.progress"]
    assert [payload["preview"] for payload in progress_payloads] == [
        "规划检索任务",
        "搜索：OpenAI 是什么",
        "证据裁判完成：采用 1，拒绝 0",
    ]
    assert progress_payloads[1]["stage"] == "web_query_start"
    assert progress_payloads[2]["status"] == "completed"
    complete_payload = [payload for event, _sid, payload in emitted if event == "tool.complete"][0]
    assert complete_payload["source_map"][0]["ref"] == "W1"
    assert complete_payload["web_sources"][0]["url"] == "https://openai.com"
    assert complete_payload["research_trace"]["web_search_attempted"] is True


def test_search_notes_tool_complete_emits_enriched_knowledge_sources(monkeypatch, tmp_path):
    import tui_gateway.server as server

    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))
    db_path = tmp_path / "captures.db"
    vault_path = tmp_path / "vault"
    vault_path.mkdir()
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE captures (id TEXT PRIMARY KEY, file_path TEXT, raw_path TEXT, updated_at REAL)")
    conn.execute(
        "INSERT INTO captures (id, file_path, raw_path, updated_at) VALUES (?, ?, ?, ?)",
        ("capture-1", "captures/智能问数项目的成功关键.md", "", 1),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(server, "_load_knowledge_config", lambda: (db_path, vault_path))
    server._sessions["sid-rag"] = {
        "tool_progress_mode": "all",
        "edit_snapshots": {},
        "tool_started_at": {},
    }

    result = json.dumps(
        {
            "status": "success",
            "agent": "rag",
            "intent": "search_knowledge_base",
            "chat_preview": "这篇笔记提到智能问数 [1]",
            "source_map": [
                {
                    "type": "capture_note",
                    "id": "capture-1",
                    "title": "智能问数项目的成功关键",
                    "path": "captures/智能问数项目的成功关键.md",
                }
            ],
            "meta": {"answer": "这篇笔记提到智能问数的完整答案 [1]"},
        },
        ensure_ascii=False,
    )

    server._on_tool_complete("sid-rag", "call-1", "search_my_notes", {"query": "智能问数"}, result)

    complete_payload = [payload for event, _sid, payload in emitted if event == "tool.complete"][0]
    assert complete_payload["source_map"][0]["id"] == "capture-1"
    assert complete_payload["knowledge_sources"][0]["type"] == "capture_note"
    assert complete_payload["knowledge_sources"][0]["open_url"] == "/knowledge-library?kind=capture&item=capture-1"
    assert complete_payload["knowledge_sources"][0]["file_url"].startswith("file://")
    assert complete_payload["knowledge_sources"][0]["file_path"] == "captures/智能问数项目的成功关键.md"
    assert complete_payload["answer_text"] == "这篇笔记提到智能问数的完整答案 [1]"
    assert "web_sources" not in complete_payload


def test_history_tool_messages_emit_enriched_knowledge_sources(monkeypatch, tmp_path):
    import tui_gateway.server as server

    db_path = tmp_path / "captures.db"
    vault_path = tmp_path / "vault"
    vault_path.mkdir()
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE captures (id TEXT PRIMARY KEY, file_path TEXT, raw_path TEXT, updated_at REAL)")
    conn.execute(
        "INSERT INTO captures (id, file_path, raw_path, updated_at) VALUES (?, ?, ?, ?)",
        ("capture-history-1", "captures/历史知识.md", "", 1),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(server, "_load_knowledge_config", lambda: (db_path, vault_path))

    result = json.dumps(
        {
            "status": "success",
            "agent": "rag",
            "intent": "search_knowledge_base",
            "chat_preview": "历史知识回答 [1]",
            "source_map": [
                {
                    "type": "capture_note",
                    "item_id": "capture-history-1",
                    "title": "历史知识",
                    "path": "captures/历史知识.md",
                }
            ],
            "meta": {"answer": "历史完整回答 [1]"},
        },
        ensure_ascii=False,
    )
    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-history",
                    "function": {"name": "search_my_notes", "arguments": "{\"query\":\"历史知识\"}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call-history", "content": result},
    ]

    messages = server._history_to_messages(history)

    tool_message = messages[0]
    assert tool_message["role"] == "tool"
    assert tool_message["knowledge_sources"][0]["open_url"] == "/knowledge-library?kind=capture&item=capture-history-1"
    assert tool_message["knowledge_sources"][0]["file_url"].startswith("file://")
    assert tool_message["source_map"][0]["file_path"] == "captures/历史知识.md"


def test_gateway_knowledge_source_short_id_requires_unique_match(monkeypatch, tmp_path):
    import tui_gateway.server as server

    db_path = tmp_path / "captures.db"
    vault_path = tmp_path / "vault"
    vault_path.mkdir()
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE captures (id TEXT PRIMARY KEY, file_path TEXT, raw_path TEXT, updated_at REAL)")
    conn.execute("CREATE TABLE capture_drafts (id TEXT PRIMARY KEY)")
    conn.execute(
        "INSERT INTO captures (id, file_path, raw_path, updated_at) VALUES (?, ?, ?, ?)",
        ("abcdef-1", "captures/唯一.md", "", 2),
    )
    conn.execute(
        "INSERT INTO captures (id, file_path, raw_path, updated_at) VALUES (?, ?, ?, ?)",
        ("shared-1", "captures/重复1.md", "", 2),
    )
    conn.execute(
        "INSERT INTO captures (id, file_path, raw_path, updated_at) VALUES (?, ?, ?, ?)",
        ("shared-2", "captures/重复2.md", "", 1),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(server, "_load_knowledge_config", lambda: (db_path, vault_path))

    unique, ambiguous = server._enrich_gateway_knowledge_sources(
        [
            {"id": "abcdef", "title": "唯一"},
            {"id": "shared", "title": "重复"},
        ]
    )

    assert unique["open_url"] == "/knowledge-library?kind=capture&item=abcdef-1"
    assert "open_url" not in ambiguous


def test_web_search_tool_source_payload_extracts_clickable_sources():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "success": True,
            "data": {
                "web": [
                    {
                        "title": "AI产品经理",
                        "url": "https://baike.baidu.com/item/AI产品经理/66779014",
                        "description": "AI产品经理相关说明",
                        "position": 1,
                    },
                    {
                        "title": "AI PM vs traditional PM",
                        "url": "https://example.com/ai-pm",
                        "description": "Comparison article",
                        "position": 2,
                    },
                ]
            },
        },
        ensure_ascii=False,
    )

    payload = server._tool_source_payload("web_search", result)

    assert payload["web_sources"][0] == {
        "ref": "W1",
        "type": "web",
        "title": "AI产品经理",
        "url": "https://baike.baidu.com/item/AI产品经理/66779014",
        "excerpt": "AI产品经理相关说明",
        "domain": "baike.baidu.com",
    }
    assert payload["source_map"][1]["ref"] == "W2"
    assert payload["source_map"][1]["url"] == "https://example.com/ai-pm"


def test_research_tool_source_payload_forwards_provider_status():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "status": "success",
            "chat_preview": "答案",
            "meta": {
                "provider_status": {"search_backend": "fallback"},
                "research_trace": {"path": "web_context", "search_backend": "fallback"},
            },
        },
        ensure_ascii=False,
    )

    payload = server._tool_source_payload("research_with_web", result)

    assert payload["provider_status"]["search_backend"] == "fallback"
    assert payload["research_trace"]["search_backend"] == "fallback"


def test_research_tool_source_payload_falls_back_to_retrieved_web_sources():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "status": "success",
            "chat_preview": "AI PM 对数据和模型要求更高 [W8]，传统 PM 更偏功能闭环 [W1]。",
            "source_map": [
                {
                    "ref": "K1",
                    "type": "capture_note",
                    "id": "capture-1",
                    "title": "AI产品经理笔记",
                }
            ],
            "meta": {
                "answer": "AI PM 对数据和模型要求更高 [W8]，传统 PM 更偏功能闭环 [W1]。",
                "knowledge_sources": [
                    {
                        "ref": "K1",
                        "type": "capture_note",
                        "id": "capture-1",
                        "title": "AI产品经理笔记",
                    }
                ],
                "web_sources": [],
                "retrieved_web_sources": [
                    {
                        "ref": "W1",
                        "type": "web",
                        "title": "传统产品经理",
                        "url": "https://example.com/traditional-pm",
                        "description": "传统产品经理介绍",
                    },
                    {
                        "ref": "W8",
                        "type": "web",
                        "title": "AI产品经理",
                        "url": "https://example.com/ai-pm",
                        "description": "AI产品经理介绍",
                    },
                    {
                        "ref": "W16",
                        "type": "web",
                        "title": "AI产品岗位",
                        "url": "https://example.com/ai-product-role",
                    },
                ],
            },
        },
        ensure_ascii=False,
    )

    payload = server._tool_source_payload("research_with_web", result)

    assert [source["ref"] for source in payload["web_sources"]] == ["W8", "W1", "W16"]
    assert payload["web_sources"][0]["url"] == "https://example.com/ai-pm"
    assert payload["source_map"][0]["ref"] == "K1"
    assert [source["ref"] for source in payload["source_map"][1:]] == ["W8", "W1", "W16"]


def test_research_tool_source_payload_promotes_missing_cited_web_sources():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "status": "success",
            "chat_preview": "AI PM 需要处理模型不确定性 [W8]。",
            "source_map": [
                {
                    "ref": "W1",
                    "type": "web",
                    "title": "传统产品经理",
                    "url": "https://example.com/traditional-pm",
                }
            ],
            "meta": {
                "answer": "AI PM 需要处理模型不确定性 [W8]。",
                "web_sources": [
                    {
                        "ref": "W1",
                        "type": "web",
                        "title": "传统产品经理",
                        "url": "https://example.com/traditional-pm",
                    }
                ],
                "retrieved_web_sources": [
                    {
                        "ref": "W1",
                        "title": "传统产品经理",
                        "url": "https://example.com/traditional-pm",
                    },
                    {
                        "ref": "W8",
                        "title": "AI产品经理",
                        "url": "https://example.com/ai-pm",
                        "description": "AI PM 需要理解模型、数据和评估。",
                    },
                ],
            },
        },
        ensure_ascii=False,
    )

    payload = server._tool_source_payload("research_with_web", result)

    assert [source["ref"] for source in payload["web_sources"]] == ["W1", "W8"]
    assert payload["web_sources"][1]["url"] == "https://example.com/ai-pm"
    assert [source["ref"] for source in payload["source_map"]] == ["W1", "W8"]


def test_web_extract_failed_pages_do_not_emit_sources():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "results": [
                {
                    "url": "https://example.com/timeout",
                    "title": "",
                    "content": "",
                    "error": "Could not reach DashScope: The read operation timed out",
                }
            ]
        },
        ensure_ascii=False,
    )

    assert server._tool_source_payload("web_extract", result) == {}


def test_web_extract_successful_pages_emit_sources():
    import tui_gateway.server as server

    result = json.dumps(
        {
            "results": [
                {
                    "url": "https://example.com/article",
                    "title": "AI PM article",
                    "content": "A" * 300,
                },
                {
                    "url": "https://example.com/timeout",
                    "title": "",
                    "content": "",
                    "error": "Could not reach DashScope",
                },
            ]
        },
        ensure_ascii=False,
    )

    payload = server._tool_source_payload("web_extract", result)

    assert len(payload["web_sources"]) == 1
    assert payload["web_sources"][0]["ref"] == "W1"
    assert payload["web_sources"][0]["url"] == "https://example.com/article"
    assert payload["web_sources"][0]["excerpt"] == "A" * 240
