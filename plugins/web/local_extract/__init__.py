"""Local web extraction plugin."""

from __future__ import annotations

from plugins.web.local_extract.provider import LocalExtractWebProvider


def register(ctx) -> None:
    """Register the local extraction provider with the plugin context."""
    ctx.register_web_search_provider(LocalExtractWebProvider())
