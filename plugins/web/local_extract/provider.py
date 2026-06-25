"""Local HTTP page extraction provider."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider
from tools.url_safety import is_safe_url

logger = logging.getLogger(__name__)


class LocalExtractWebProvider(WebSearchProvider):
    """Extract readable page text locally with httpx and trafilatura."""

    @property
    def name(self) -> str:
        return "local"

    @property
    def display_name(self) -> str:
        return "Local Extract"

    def is_available(self) -> bool:
        try:
            import trafilatura  # noqa: F401

            return True
        except ImportError:
            return False

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def extract(self, urls: List[str], **_kwargs: Any) -> List[Dict[str, Any]]:
        import httpx
        import trafilatura

        documents: List[Dict[str, Any]] = []
        for url in urls:
            if not is_safe_url(url):
                documents.append(_error_document(url, "Blocked: URL targets a private or internal network address"))
                continue
            try:
                response = httpx.get(
                    url,
                    follow_redirects=True,
                    timeout=8,
                    headers={
                        "User-Agent": (
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/126.0 Safari/537.36"
                        ),
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    },
                )
                response.raise_for_status()
                final_url = str(response.url)
                if not is_safe_url(final_url):
                    documents.append(_error_document(url, "Blocked: redirect targets a private or internal network address"))
                    continue
                extracted = trafilatura.extract(
                    response.text,
                    url=final_url,
                    include_comments=False,
                    include_tables=True,
                    output_format="markdown",
                )
                content = (extracted or "").strip() or _plain_html_text(response.text)
                if not content:
                    documents.append(_error_document(final_url, "No readable page text extracted"))
                    continue
                documents.append(
                    {
                        "url": final_url,
                        "title": "",
                        "content": content,
                        "raw_content": content,
                        "metadata": {"sourceURL": final_url},
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("Local web extract failed for %s: %s", url, exc)
                documents.append(_error_document(url, f"Local extraction failed: {exc}"))
        return documents

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Local Extract",
            "badge": "free · local",
            "tag": "Fetches URLs locally and extracts readable text with trafilatura. Pair with a search provider.",
            "env_vars": [],
        }


def _error_document(url: str, error: str) -> Dict[str, Any]:
    return {
        "url": url,
        "title": "",
        "content": "",
        "raw_content": "",
        "error": error,
        "metadata": {"sourceURL": url},
    }


def _plain_html_text(html_text: str) -> str:
    try:
        from lxml import html

        document = html.fromstring(html_text)
        for node in document.xpath("//script|//style|//noscript|//svg"):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
        text = document.text_content()
    except Exception:  # noqa: BLE001
        text = html_text
    lines = [" ".join(line.split()) for line in text.splitlines()]
    lines = [line for line in lines if len(line) >= 20]
    return "\n".join(lines)[:12000].strip()
