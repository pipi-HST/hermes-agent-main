"""Locate the external Hermes Knowledge service / checkout.

Historically the runtime hard-coded ``/Users/pipi/hermes-custom`` and inserted
it on ``sys.path`` at request time.  That made the feature machine-bound and
turned a data directory into an import path for the gateway process.

This module centralises the lookup so every call site fails closed with a clear
message when the service is not configured, and validates the path before it is
ever inserted into ``sys.path``.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


class KnowledgeUnavailable(RuntimeError):
    """Raised when the Hermes Knowledge backend is not configured/valid."""


_ENV_KEYS = ("HERMES_KNOWLEDGE_LOCAL_ROOT", "HERMES_CUSTOM_ROOT")


def configured_root() -> Path | None:
    """Return the configured local checkout, or None when unset."""
    for key in _ENV_KEYS:
        value = (os.environ.get(key) or "").strip()
        if value:
            return Path(value).expanduser()
    return None


def validate_root(root: Path | None) -> Path:
    """Validate a local checkout path before adding it to ``sys.path``."""
    if root is None:
        raise KnowledgeUnavailable(
            "Hermes Knowledge is not configured: set HERMES_KNOWLEDGE_URL "
            "(HTTP mode) or HERMES_KNOWLEDGE_LOCAL_ROOT (local checkout)."
        )
    if not root.is_absolute():
        raise KnowledgeUnavailable(f"knowledge root must be an absolute path: {root}")
    if not root.is_dir():
        raise KnowledgeUnavailable(f"knowledge root does not exist: {root}")
    # Refuse directories that other users could modify: a swapped module would
    # execute inside the gateway/dashboard process.
    try:
        st = root.stat()
    except OSError as exc:
        raise KnowledgeUnavailable(f"knowledge root is not readable: {root}") from exc
    if os.name != "nt" and (st.st_mode & 0o022):
        raise KnowledgeUnavailable(
            f"knowledge root is group/world-writable, refusing to import code from it: {root}"
        )
    return root


def ensure_custom_path() -> Path:
    """Return the validated local checkout and ensure it is importable.

    Only call this from startup/legacy local mode.  New integrations should use
    the HTTP client instead of importing modules out of another checkout.
    """
    root = validate_root(configured_root())
    resolved = str(root)
    if resolved not in sys.path:
        sys.path.insert(0, resolved)
    return root
