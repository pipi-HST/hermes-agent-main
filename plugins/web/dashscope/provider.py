"""DashScope/Bailian web search and extraction provider."""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, Iterable, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

_DASHSCOPE_API_SUFFIX = "/services/aigc/text-generation/generation"
_MAX_EXTRACTED_TEXT_CHARS = 12_000


class DashScopeWebSearchProvider(WebSearchProvider):
    """Alibaba Cloud Model Studio search provider using DashScope native API."""

    @property
    def name(self) -> str:
        return "dashscope"

    @property
    def display_name(self) -> str:
        return "Alibaba Bailian Web Search"

    def is_available(self) -> bool:
        return bool(os.getenv("DASHSCOPE_API_KEY", "").strip())

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        import httpx

        api_key = _env_value("DASHSCOPE_API_KEY").strip()
        if not api_key:
            return {"success": False, "error": "DASHSCOPE_API_KEY is not set"}

        strategy = _env_value("DASHSCOPE_WEB_SEARCH_STRATEGY", "max").strip().lower() or "max"
        if strategy not in {"turbo", "max", "agent"}:
            strategy = "turbo"
        model = _env_value("DASHSCOPE_WEB_SEARCH_MODEL", "qwen-plus").strip() or "qwen-plus"
        workspace_id = _env_value("DASHSCOPE_WORKSPACE_ID").strip()
        endpoint = _dashscope_generation_endpoint(workspace_id)
        max_results = max(1, min(int(limit), 20))

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if workspace_id:
            headers["X-DashScope-WorkSpace"] = workspace_id

        payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "请联网搜索并返回与问题最相关的网页来源。"
                            "回答可以简短，但必须保留搜索来源信息。"
                            "请称依据为“联网搜索结果”，不要称为“知识库”。\n\n"
                            f"问题：{query}"
                        ),
                    }
                ]
            },
            "parameters": {
                "result_format": "message",
                "enable_search": True,
                "search_options": {
                    "forced_search": True,
                    "search_strategy": strategy,
                    "enable_source": True,
                    "enable_citation": True,
                },
            },
        }

        try:
            response = httpx.post(endpoint, headers=headers, json=payload, timeout=_request_timeout_seconds())
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.warning("DashScope search HTTP error: %s", exc)
            return {
                "success": False,
                "error": f"DashScope returned HTTP {exc.response.status_code}",
            }
        except httpx.RequestError as exc:
            logger.warning("DashScope search request error: %s", exc)
            return {"success": False, "error": f"Could not reach DashScope: {exc}"}
        except Exception as exc:  # noqa: BLE001
            logger.warning("DashScope response parse error: %s", exc)
            return {"success": False, "error": f"Could not parse DashScope response: {exc}"}

        answer_text = _dashscope_answer_text(data)
        results = _normalize_dashscope_search_results(data, limit=max_results, answer_text=answer_text)
        if not results:
            results = _results_from_prepended_search_text(answer_text, limit=max_results)

        return {
            "success": True,
            "data": {"web": results[:max_results]},
            "meta": {
                "provider": "dashscope",
                "search_strategy": strategy,
                "model": model,
                "has_workspace": bool(workspace_id),
            },
        }

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        import httpx

        api_key = _env_value("DASHSCOPE_API_KEY").strip()
        if not api_key:
            return [
                {
                    "url": url,
                    "title": "",
                    "content": "",
                    "raw_content": "",
                    "error": "DASHSCOPE_API_KEY is not set",
                }
                for url in urls
            ]

        model = _env_value("DASHSCOPE_WEB_EXTRACT_MODEL", "qwen3.7-max").strip() or "qwen3.7-max"
        workspace_id = _env_value("DASHSCOPE_WORKSPACE_ID").strip()
        endpoint = _dashscope_responses_endpoint(workspace_id)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        selected_urls = [str(url or "").strip() for url in urls if str(url or "").strip()]
        results: List[Dict[str, Any]] = []
        for url in selected_urls:
            payload = {
                "model": model,
                "input": (
                    "请访问下面这个 URL，并提取网页正文中对用户有用的主要内容。"
                    "尽量保留事实、数字、日期、机构名和原文表述；不要写泛泛介绍。"
                    "如果无法访问，请明确说明无法访问原因。\n\n"
                    f"URL: {url}"
                ),
                "tools": [
                    {"type": "web_search"},
                    {"type": "web_extractor"},
                ],
                "enable_thinking": True,
            }
            try:
                response = httpx.post(endpoint, headers=headers, json=payload, timeout=_extract_timeout_seconds())
                response.raise_for_status()
                data = response.json()
                content = _dashscope_extracted_text(data)
                title = _dashscope_extracted_title(data) or url
                results.append(
                    {
                        "url": url,
                        "title": title,
                        "content": content,
                        "raw_content": content,
                        "metadata": {
                            "provider": "dashscope",
                            "model": model,
                            "has_workspace": bool(workspace_id),
                            "web_extractor": True,
                        },
                    }
                )
            except httpx.HTTPStatusError as exc:
                logger.warning("DashScope extract HTTP error: %s", exc)
                results.append(
                    {
                        "url": url,
                        "title": "",
                        "content": "",
                        "raw_content": "",
                        "error": f"DashScope returned HTTP {exc.response.status_code}",
                    }
                )
            except httpx.RequestError as exc:
                logger.warning("DashScope extract request error: %s", exc)
                results.append(
                    {
                        "url": url,
                        "title": "",
                        "content": "",
                        "raw_content": "",
                        "error": f"Could not reach DashScope: {exc}",
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("DashScope extract parse error: %s", exc)
                results.append(
                    {
                        "url": url,
                        "title": "",
                        "content": "",
                        "raw_content": "",
                        "error": f"Could not parse DashScope extraction response: {exc}",
                    }
                )
        return results

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Alibaba Bailian Web Search",
            "badge": "paid · native sources",
            "tag": "DashScope native enable_search, defaults to search_strategy=max.",
            "env_vars": [
                {
                    "key": "DASHSCOPE_API_KEY",
                    "prompt": "DashScope API key",
                    "url": "https://bailian.console.aliyun.com/",
                },
                {
                    "key": "DASHSCOPE_WORKSPACE_ID",
                    "prompt": "Bailian Workspace ID",
                    "url": "https://bailian.console.aliyun.com/",
                },
            ],
        }


def _dashscope_generation_endpoint(workspace_id: str) -> str:
    configured = _env_value("DASHSCOPE_API_URL").strip().rstrip("/")
    if configured:
        if configured.endswith("/generation"):
            return configured
        if configured.endswith("/api/v1"):
            return f"{configured}{_DASHSCOPE_API_SUFFIX}"
        return configured
    if workspace_id:
        return f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1{_DASHSCOPE_API_SUFFIX}"
    return f"https://dashscope.aliyuncs.com/api/v1{_DASHSCOPE_API_SUFFIX}"


def _dashscope_responses_endpoint(workspace_id: str) -> str:
    configured = _env_value("DASHSCOPE_RESPONSES_API_URL").strip().rstrip("/")
    if configured:
        if configured.endswith("/responses"):
            return configured
        return f"{configured}/responses"
    if workspace_id:
        return f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses"
    return "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"


def _env_value(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is not None:
        return value
    try:
        from hermes_cli.config import get_env_value

        configured = get_env_value(name)
        if configured is not None:
            return configured
    except Exception:
        pass
    return default


def _request_timeout_seconds() -> float:
    raw = _env_value("DASHSCOPE_WEB_SEARCH_TIMEOUT_SECONDS", "18").strip()
    try:
        value = float(raw)
    except ValueError:
        value = 18.0
    return max(3.0, min(value, 45.0))


def _extract_timeout_seconds() -> float:
    raw = _env_value("DASHSCOPE_WEB_EXTRACT_TIMEOUT_SECONDS", "45").strip()
    try:
        value = float(raw)
    except ValueError:
        value = 45.0
    return max(5.0, min(value, 120.0))


def _dashscope_extracted_text(payload: Dict[str, Any]) -> str:
    text = payload.get("output_text")
    if isinstance(text, str) and text.strip():
        return _clean_multiline_text(text)[:_MAX_EXTRACTED_TEXT_CHARS]

    parts = list(_iter_responses_text_blocks(payload.get("output")))
    if not parts:
        fallback = _dashscope_answer_text(payload)
        if fallback:
            parts.append(fallback)
    return _clean_multiline_text("\n\n".join(parts))[:_MAX_EXTRACTED_TEXT_CHARS]


def _dashscope_extracted_title(payload: Dict[str, Any]) -> str:
    for item in _iter_source_like_dicts(payload):
        title = _first_text(item, "title", "name", "site_name")
        if title:
            return title[:180]

    text = _dashscope_extracted_text(payload)
    for raw_line in text.splitlines():
        line = raw_line.strip(" #*-:：")
        if line and not line.startswith("http") and len(line) <= 180:
            return line
    return ""


def _iter_responses_text_blocks(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        output_text = value.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            yield output_text

        item_type = str(value.get("type") or "").lower()
        text = value.get("text")
        if item_type in {"output_text", "summary_text"} and isinstance(text, str) and text.strip():
            yield text

        content = value.get("content")
        if isinstance(content, str) and content.strip():
            yield content
        else:
            yield from _iter_responses_text_blocks(content)

        for key in ("output", "summary"):
            yield from _iter_responses_text_blocks(value.get(key))
    elif isinstance(value, list):
        for child in value:
            yield from _iter_responses_text_blocks(child)


def _normalize_dashscope_search_results(
    payload: Dict[str, Any],
    *,
    limit: int,
    answer_text: str = "",
) -> List[Dict[str, Any]]:
    raw_results = list(_iter_source_like_dicts(payload))
    citation_snippets = _citation_snippets_by_index(answer_text)
    answer_summary = _answer_summary(answer_text)
    seen: set[str] = set()
    normalized: List[Dict[str, Any]] = []
    for item in raw_results:
        url = _first_text(item, "url", "link", "href", "source_url", "page_url", "site_url")
        title = _first_text(item, "title", "name", "site_name", "hostname")
        source_index = _source_index(item)
        description = _first_text(
            item,
            "description",
            "snippet",
            "summary",
            "content",
            "text",
            "body",
            "page_content",
        )
        if not description and source_index in citation_snippets:
            description = citation_snippets[source_index]
        if not description and answer_summary:
            description = answer_summary
        if not (url or title or description):
            continue
        key = url or f"{title}\n{description}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "title": title or url or f"DashScope source {len(normalized) + 1}",
                "url": url,
                "description": description,
                "position": len(normalized) + 1,
            }
        )
        if len(normalized) >= limit:
            break
    return normalized


def _iter_source_like_dicts(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        if _looks_like_source(value):
            yield value
        for key, child in value.items():
            if key in {"usage", "request_id"}:
                continue
            yield from _iter_source_like_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_source_like_dicts(child)


def _looks_like_source(item: Dict[str, Any]) -> bool:
    keys = {str(key).lower() for key in item}
    has_url = bool(keys & {"url", "link", "href", "source_url", "page_url", "site_url"})
    has_title = bool(keys & {"title", "name", "site_name", "hostname"})
    has_snippet = bool(keys & {"description", "snippet", "summary", "content", "text", "body", "page_content"})
    return has_url and (has_title or has_snippet)


def _first_text(item: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return _clean_text(value)
        if isinstance(value, (int, float)):
            return str(value)
    return ""


def _source_index(item: Dict[str, Any]) -> int | None:
    value = item.get("index")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _clean_multiline_text(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\f\v]+", " ", line).strip() for line in normalized.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _dashscope_answer_text(payload: Dict[str, Any]) -> str:
    output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    choices = output.get("choices") if isinstance(output.get("choices"), list) else []
    parts: List[str] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text") or block.get("content")
                    if isinstance(text, str):
                        parts.append(text)
    text = output.get("text")
    if isinstance(text, str):
        parts.append(text)
    return "\n".join(parts)


def _citation_snippets_by_index(text: str) -> Dict[int, str]:
    snippets: Dict[int, List[str]] = {}
    for sentence in _split_sentences(text):
        indexes = {
            int(match)
            for match in re.findall(r"\[(\d+)\]", sentence)
            if match.isdigit()
        }
        if not indexes:
            continue
        cleaned = _clean_text(re.sub(r"\[\d+\]", "", sentence))
        if not cleaned:
            continue
        for index in indexes:
            snippets.setdefault(index, []).append(cleaned)
    return {
        index: _clean_text(" ".join(parts))[:900]
        for index, parts in snippets.items()
    }


def _answer_summary(text: str) -> str:
    cleaned = _clean_text(re.sub(r"\[\d+\]", "", text or ""))
    if not cleaned:
        return ""
    return cleaned[:900]


def _split_sentences(text: str) -> List[str]:
    compact = _clean_text(text)
    if not compact:
        return []
    return [
        item.strip()
        for item in re.split(r"(?<=[。！？.!?])\s+", compact)
        if item.strip()
    ]


def _results_from_prepended_search_text(text: str, *, limit: int) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    current_title = ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        url_match = re.search(r"https?://[^\s)\]>\"']+", line)
        if not url_match:
            current_title = re.sub(r"^\s*(?:\[\d+\]|\d+[.)、-])\s*", "", line).strip()[:180]
            continue
        url = url_match.group(0).rstrip(".,;")
        title = current_title or line[:180]
        description = line.replace(url, "").strip(" -:：")
        results.append(
            {
                "title": title or url,
                "url": url,
                "description": description,
                "position": len(results) + 1,
            }
        )
        current_title = ""
        if len(results) >= limit:
            break
    return results
