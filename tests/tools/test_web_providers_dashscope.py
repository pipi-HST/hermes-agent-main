"""Tests for the DashScope/Bailian web search provider."""

from __future__ import annotations

import json
from types import SimpleNamespace


def test_dashscope_provider_uses_max_search_options(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": "OpenAI 是一家 AI 公司。",
                                "search_results": [
                                    {
                                        "title": "OpenAI",
                                        "url": "https://openai.com/",
                                        "snippet": "OpenAI is an AI research and deployment company.",
                                    }
                                ],
                            }
                        }
                    ]
                }
            },
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setenv("DASHSCOPE_WORKSPACE_ID", "workspace-test")
    monkeypatch.delenv("DASHSCOPE_WEB_SEARCH_STRATEGY", raising=False)
    monkeypatch.setattr("httpx.post", fake_post)

    result = DashScopeWebSearchProvider().search("OpenAI是什么意思", limit=3)

    assert result["success"] is True
    assert result["data"]["web"] == [
        {
            "title": "OpenAI",
            "url": "https://openai.com/",
            "description": "OpenAI is an AI research and deployment company.",
            "position": 1,
        }
    ]
    assert captured["headers"]["X-DashScope-WorkSpace"] == "workspace-test"
    assert captured["json"]["parameters"]["enable_search"] is True
    assert captured["json"]["parameters"]["search_options"]["forced_search"] is True
    assert captured["json"]["parameters"]["search_options"]["search_strategy"] == "max"
    assert captured["json"]["parameters"]["search_options"]["enable_source"] is True
    assert captured["json"]["parameters"]["search_options"]["enable_citation"] is True
    assert "prepend_search_result" not in captured["json"]["parameters"]["search_options"]


def test_dashscope_provider_falls_back_to_prepended_source_text(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    def fake_post(*_args, **_kwargs):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "text": "OpenAI | Research & Deployment\nhttps://openai.com/ OpenAI 官方网站"
                }
            },
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setattr("httpx.post", fake_post)

    result = DashScopeWebSearchProvider().search("OpenAI是什么意思", limit=3)

    assert result["success"] is True
    assert result["data"]["web"][0]["url"] == "https://openai.com/"
    assert result["data"]["web"][0]["title"] == "OpenAI | Research & Deployment"


def test_dashscope_provider_backfills_descriptions_from_cited_answer(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    def fake_post(*_args, **_kwargs):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    "联网搜索结果：Coding Agent 是一种用于软件开发的智能代理，"
                                    "可以规划、编写和调试代码[1]。它不同于传统代码补全工具[2]。"
                                ),
                            }
                        }
                    ],
                    "search_info": {
                        "search_results": [
                            {
                                "index": 1,
                                "title": "coding-agent",
                                "url": "https://baike.baidu.com/item/coding-agent/67581685",
                            },
                            {
                                "index": 2,
                                "title": "Code Agent 与 Coding Agent",
                                "url": "https://example.com/code-vs-coding-agent",
                            },
                        ]
                    },
                }
            },
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setattr("httpx.post", fake_post)

    result = DashScopeWebSearchProvider().search("什么是 coding agent", limit=5)
    web = result["data"]["web"]

    assert "规划、编写和调试代码" in web[0]["description"]
    assert "传统代码补全工具" in web[1]["description"]


def test_dashscope_provider_uses_answer_summary_when_source_has_no_snippet_or_citation(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    def fake_post(*_args, **_kwargs):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": "联网搜索结果：Coding Agent 是能够协助开发者完成编程任务的 AI 代理。"
                            }
                        }
                    ],
                    "search_info": {
                        "search_results": [
                            {
                                "index": 1,
                                "title": "coding-agent",
                                "url": "https://example.com/coding-agent",
                            }
                        ]
                    },
                }
            },
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setattr("httpx.post", fake_post)

    result = DashScopeWebSearchProvider().search("什么是 coding agent", limit=5)

    assert "协助开发者完成编程任务" in result["data"]["web"][0]["description"]


def test_dashscope_provider_extract_uses_responses_web_extractor(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "# Samsung phones\nSamsung remained a major smartphone vendor in 2025.",
                            }
                        ],
                    }
                ]
            },
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.delenv("DASHSCOPE_WORKSPACE_ID", raising=False)
    monkeypatch.setattr("httpx.post", fake_post)

    provider = DashScopeWebSearchProvider()
    result = provider.extract(["https://example.com/samsung"])

    assert provider.supports_extract() is True
    assert captured["url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
    assert captured["headers"]["Authorization"] == "Bearer dashscope-test-key"
    assert captured["json"]["tools"] == [
        {"type": "web_search"},
        {"type": "web_extractor"},
    ]
    assert captured["json"]["enable_thinking"] is True
    assert "URL: https://example.com/samsung" in captured["json"]["input"]
    assert result == [
        {
            "url": "https://example.com/samsung",
            "title": "Samsung phones",
            "content": "# Samsung phones\nSamsung remained a major smartphone vendor in 2025.",
            "raw_content": "# Samsung phones\nSamsung remained a major smartphone vendor in 2025.",
            "metadata": {
                "provider": "dashscope",
                "model": "qwen3.7-plus",
                "has_workspace": False,
                "web_extractor": True,
            },
        }
    ]


def test_dashscope_provider_extract_keeps_responses_endpoint_with_workspace(monkeypatch):
    from plugins.web.dashscope.provider import DashScopeWebSearchProvider

    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "headers": headers})
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"output_text": "Workspace extraction works."},
        )

    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setenv("DASHSCOPE_WORKSPACE_ID", "workspace-test")
    monkeypatch.setattr("httpx.post", fake_post)

    result = DashScopeWebSearchProvider().extract(["https://example.com/page"])

    assert captured["url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
    assert captured["headers"]["X-DashScope-WorkSpace"] == "workspace-test"
    assert result[0]["content"] == "Workspace extraction works."


def test_dashscope_web_extract_tool_dispatches_to_provider(monkeypatch):
    import asyncio

    from agent.web_search_registry import _reset_for_tests
    from tools import web_tools

    _reset_for_tests()
    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"extract_backend": "dashscope"})
    monkeypatch.setattr(web_tools, "check_auxiliary_model", lambda: False)
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "json": json})
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"output_text": "Samsung extracted body from DashScope."},
        )

    monkeypatch.setattr("httpx.post", fake_post)

    raw = asyncio.run(
        web_tools.web_extract_tool(
            ["https://example.com/samsung"],
            use_llm_processing=False,
        )
    )
    payload = json.loads(raw)

    assert web_tools._get_extract_backend() == "dashscope"
    assert captured["url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
    assert captured["json"]["tools"] == [{"type": "web_search"}, {"type": "web_extractor"}]
    assert captured["json"]["enable_thinking"] is True
    assert payload["results"][0]["url"] == "https://example.com/samsung"
    assert payload["results"][0]["content"] == "Samsung extracted body from DashScope."


def test_dashscope_wiring_selects_backend_and_registers_provider(monkeypatch):
    from agent.web_search_registry import _reset_for_tests
    from tools import web_tools

    _reset_for_tests()
    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test-key")
    monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"search_backend": "dashscope"})
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

    def fake_post(*_args, **_kwargs):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "choices": [
                        {
                            "message": {
                                "search_results": [
                                    {
                                        "title": "Coding agents explained",
                                        "url": "https://example.com/coding-agent",
                                        "summary": "AI coding agents complete software tasks.",
                                    }
                                ]
                            }
                        }
                    ]
                }
            },
        )

    monkeypatch.setattr("httpx.post", fake_post)

    raw = web_tools.web_search_tool("what is a coding agent", limit=2)
    payload = json.loads(raw)

    assert web_tools._get_search_backend() == "dashscope"
    assert "DASHSCOPE_API_KEY" in web_tools._web_requires_env()
    assert payload["success"] is True
    assert payload["data"]["web"][0]["url"] == "https://example.com/coding-agent"
    assert "dashscope" in web_tools.EXTRACT_CAPABLE_WEB_BACKENDS
    assert "dashscope" not in web_tools.SEARCH_ONLY_WEB_BACKENDS


def test_dashscope_reads_hermes_dotenv_without_exported_env(monkeypatch, tmp_path):
    from agent.web_search_registry import _reset_for_tests
    from tools import web_tools

    _reset_for_tests()
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / ".env").write_text(
        "DASHSCOPE_API_KEY=dashscope-dotenv-key\n"
        "DASHSCOPE_WORKSPACE_ID=workspace-dotenv\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_WORKSPACE_ID", raising=False)
    monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"search_backend": "dashscope"})
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "output": {
                    "choices": [
                        {
                            "message": {
                                "search_results": [
                                    {
                                        "title": "Dotenv source",
                                        "url": "https://example.com/dotenv",
                                        "summary": "DashScope dotenv credentials work.",
                                    }
                                ]
                            }
                        }
                    ]
                }
            },
        )

    monkeypatch.setattr("httpx.post", fake_post)

    raw = web_tools.web_search_tool("dotenv credentials", limit=1)
    payload = json.loads(raw)

    assert web_tools._get_search_backend() == "dashscope"
    assert captured["headers"]["Authorization"] == "Bearer dashscope-dotenv-key"
    assert captured["headers"]["X-DashScope-WorkSpace"] == "workspace-dotenv"
    assert "workspace-dotenv.cn-beijing.maas.aliyuncs.com" in captured["url"]
    assert payload["success"] is True
    assert payload["data"]["web"][0]["url"] == "https://example.com/dotenv"
