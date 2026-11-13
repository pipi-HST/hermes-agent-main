"""Locate the external Hermes Life Assistant checkout.

The life tools used to hard-code ``/Users/pipi/hermes-life`` and insert it into
``sys.path`` at import time.  That made tool registration machine-bound: on
another machine the import still "succeeded", but every call failed with an
opaque ``ImportError``, and a data directory was turned into an import path for
the gateway process.

This module centralises the lookup so the tools fail with a clear error
envelope when the checkout is not configured, and validates the path before it
is ever inserted into ``sys.path``.  Import-time code must not call this — the
path is resolved on first tool use.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


class LifeUnavailable(RuntimeError):
    """Raised when the Hermes Life Assistant checkout is not configured/valid."""


_ENV_KEY = "HERMES_LIFE_ROOT"


def configured_root() -> Path | None:
    """Return the configured life checkout, or None when unset."""
    value = (os.environ.get(_ENV_KEY) or "").strip()
    if not value:
        return None
    return Path(value).expanduser()


def validate_root(root: Path | None) -> Path:
    """Validate a checkout path before adding it to ``sys.path``."""
    if root is None:
        raise LifeUnavailable(
            "Hermes Life is not configured: set HERMES_LIFE_ROOT to the "
            "absolute path of the hermes-life checkout."
        )
    if not root.is_absolute():
        raise LifeUnavailable(f"HERMES_LIFE_ROOT must be an absolute path: {root}")
    if not root.is_dir():
        raise LifeUnavailable(f"HERMES_LIFE_ROOT does not exist: {root}")
    # Refuse directories that other users could modify: a swapped module would
    # execute inside the gateway/dashboard process.
    try:
        st = root.stat()
    except OSError as exc:
        raise LifeUnavailable(f"HERMES_LIFE_ROOT is not readable: {root}") from exc
    if os.name != "nt" and (st.st_mode & 0o022):
        raise LifeUnavailable(
            f"HERMES_LIFE_ROOT is group/world-writable, refusing to import "
            f"code from it: {root}"
        )
    return root


def ensure_life_path() -> Path:
    """Return the validated checkout and make it importable.

    Call this at tool-call time (never at module import time).
    """
    root = validate_root(configured_root())
    resolved = str(root)
    if resolved not in sys.path:
        sys.path.insert(0, resolved)
    return root
