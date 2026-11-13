"""Packaging regressions: every runtime-imported package must ship.

``tools/hermes_custom_envelope.py`` imports ``integrations.hermes_knowledge``
at import time.  When the setuptools package list omitted ``integrations``,
non-editable installs silently dropped it and all 19 custom-envelope tools
disappeared (the import failure was swallowed during tool discovery).
"""

from __future__ import annotations

import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PROJECT_ROOT / "pyproject.toml"


def _packages_find_include() -> list[str]:
    with PYPROJECT.open("rb") as fh:
        data = tomllib.load(fh)
    return data["tool"]["setuptools"]["packages"]["find"]["include"]


def test_setuptools_include_covers_integrations_package():
    include = _packages_find_include()
    assert "integrations" in include
    assert "integrations.*" in include


def test_integrations_knowledge_client_is_importable():
    """The exact module the custom-envelope import chain needs must import."""
    import integrations.hermes_knowledge.client as client

    assert client.__name__ == "integrations.hermes_knowledge.client"
    # And through the package import used by tools/hermes_custom_envelope.py.
    from integrations.hermes_knowledge import KnowledgeUnavailable, ensure_custom_path

    assert issubclass(KnowledgeUnavailable, RuntimeError)
    assert callable(ensure_custom_path)
