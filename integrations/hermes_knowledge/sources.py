"""Shared helpers for knowledge source references.

Both the dashboard backend (``hermes_cli/web_server.py``) and the TUI gateway
(``tui_gateway/server.py``) render the same source objects; keep the URL and
containment rules in one place so they cannot drift apart.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

_CARD_SOURCE_KINDS = {"garden_card", "knowledge_card"}


def source_open_url(kind: str, item_id: str) -> str:
    normalized = (kind or "").strip()
    if normalized in _CARD_SOURCE_KINDS:
        return f"/cards-board/{quote(str(item_id), safe='')}"
    return "/knowledge-library?" + urlencode({"kind": kind, "item": item_id})


def file_url(vault_path: Path | str, file_path: str) -> str:
    """Return a file:// URL for a vault-relative path, or "" when outside."""
    if not file_path:
        return ""
    relative = Path(file_path)
    if relative.is_absolute() or ".." in relative.parts:
        return ""
    root = Path(vault_path).expanduser().resolve()
    target = (root / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return ""
    return target.as_uri()


def enrich_source(conn: Any, vault_path: Path | str, source: dict) -> dict:
    """Attach capture/draft/card routing fields to a knowledge source."""
    enriched = dict(source)
    enriched["type"] = enriched.get("type") or "knowledge"
    source_id = str(enriched.get("id") or enriched.get("item_id") or "").strip()
    source_path = str(enriched.get("file_path") or enriched.get("path") or "").strip()

    row = None
    if source_id:
        row = conn.execute(
            "SELECT id, file_path FROM captures WHERE id = ?", (source_id,)
        ).fetchone()
    if row is None and source_path:
        row = conn.execute(
            "SELECT id, file_path FROM captures WHERE file_path = ? OR raw_path = ?",
            (source_path, source_path),
        ).fetchone()
    if row is None and source_id and len(source_id) >= 6:
        rows = conn.execute(
            "SELECT id, file_path FROM captures WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2",
            (f"{source_id}%",),
        ).fetchall()
        if len(rows) == 1:
            row = rows[0]

    if row is not None:
        item_id = str(row["id"] or "")
        path = str(row["file_path"] or source_path)
        enriched.update(
            {
                "item_kind": "capture",
                "item_id": item_id,
                "file_path": path,
                "path": source_path or path,
                "open_url": source_open_url("capture", item_id),
            }
        )
        if path:
            enriched["file_url"] = file_url(vault_path, path)
        return enriched

    if source_id and conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'garden_cards'"
    ).fetchone() is not None:
        card = conn.execute(
            "SELECT id FROM garden_cards WHERE id = ?", (source_id,)
        ).fetchone()
        if card is None and len(source_id) >= 6:
            cards = conn.execute(
                "SELECT id FROM garden_cards WHERE id LIKE ? LIMIT 2",
                (f"{source_id}%",),
            ).fetchall()
            if len(cards) == 1:
                card = cards[0]
        if card is not None:
            item_id = str(card["id"] or "")
            enriched.update(
                {
                    "item_kind": "garden_card",
                    "item_id": item_id,
                    "open_url": source_open_url("garden_card", item_id),
                }
            )
            return enriched

    if source_id:
        draft = conn.execute(
            "SELECT id FROM capture_drafts WHERE id = ?", (source_id,)
        ).fetchone()
        if draft is not None:
            item_id = str(draft["id"] or "")
            enriched.update(
                {
                    "item_kind": "capture_draft",
                    "item_id": item_id,
                    "open_url": source_open_url("capture_draft", item_id),
                }
            )
    return enriched
