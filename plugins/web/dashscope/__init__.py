"""Alibaba Cloud Model Studio (DashScope/Bailian) web search plugin."""

from __future__ import annotations

from plugins.web.dashscope.provider import DashScopeWebSearchProvider


def register(ctx) -> None:
    """Register the DashScope web-search provider with the plugin context."""
    ctx.register_web_search_provider(DashScopeWebSearchProvider())
