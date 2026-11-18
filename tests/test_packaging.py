"""Packaging regressions: every runtime-imported package must ship.

``tools/hermes_custom_envelope.py`` imports ``integrations.hermes_knowledge``
at import time.  When the setuptools package list omitted ``integrations``,
non-editable installs silently dropped it and all 19 custom-envelope tools
disappeared (the import failure was swallowed during tool discovery).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path

import pytest

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


def _builtin_plugin_manifests() -> set[str]:
    return {
        path.relative_to(PROJECT_ROOT).as_posix()
        for path in (PROJECT_ROOT / "plugins").rglob("plugin.y*ml")
        if path.name in {"plugin.yaml", "plugin.yml"}
    }


_WHEEL_ROOT_FILES = (
    "pyproject.toml",
    "README.md",
    "MANIFEST.in",
    "run_agent.py",
    "model_tools.py",
    "toolsets.py",
    "batch_runner.py",
    "trajectory_compressor.py",
    "toolset_distributions.py",
    "cli.py",
    "hermes_bootstrap.py",
    "hermes_constants.py",
    "hermes_state.py",
    "hermes_time.py",
    "hermes_logging.py",
    "utils.py",
)

_WHEEL_PACKAGE_DIRS = (
    "agent",
    "tools",
    "hermes_cli",
    "gateway",
    "tui_gateway",
    "cron",
    "acp_adapter",
    "plugins",
    "providers",
    "integrations",
)

_WHEEL_COPY_IGNORE = shutil.ignore_patterns(
    "__pycache__", "*.py[cod]", "node_modules", ".git", "build", "dist", ".tmp"
)


def _wheel_build_root() -> Path:
    """Create a short, private build root.

    CI sometimes points TMPDIR at a deep workspace directory, which overflows
    Windows' path limit inside pip's ephemeral wheel cache.  Prefer a short
    system temp directory and fall back to whatever is available.
    """
    if os.name == "nt":
        candidates = [
            Path(tempfile.gettempdir()),
            Path.home() / "AppData" / "Local" / "Temp",
            Path(os.environ.get("SystemRoot", "C:\\")) / "Temp",
        ]
    else:
        candidates = [Path("/tmp"), Path(tempfile.gettempdir())]
    candidates.append(Path.home() / ".cache")

    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            if len(str(base)) > 80:
                continue
            return Path(tempfile.mkdtemp(prefix="hw-", dir=base))
        except OSError:
            continue
    return Path(tempfile.mkdtemp(prefix="hw-"))


def _copy_wheel_source(dest: Path) -> None:
    """Copy just the files the wheel build needs, isolated from the checkout."""
    dest.mkdir(parents=True)
    for name in _WHEEL_ROOT_FILES:
        shutil.copy2(PROJECT_ROOT / name, dest / name)
    for name in _WHEEL_PACKAGE_DIRS:
        shutil.copytree(
            PROJECT_ROOT / name,
            dest / name,
            ignore=_WHEEL_COPY_IGNORE,
        )


@pytest.fixture(scope="module")
def wheel_path() -> Path:
    """Build the wheel offline from an isolated copy of the source tree."""
    root = _wheel_build_root()
    src = root / "src"
    out_dir = root / "out"
    tmp_dir = root / "tmp"
    out_dir.mkdir()
    tmp_dir.mkdir()
    try:
        _copy_wheel_source(src)
        env = {
            **os.environ,
            "PIP_NO_INDEX": "1",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_CACHE_DIR": str(root / "cache"),
            "TMPDIR": str(tmp_dir),
            "TEMP": str(tmp_dir),
            "TMP": str(tmp_dir),
        }
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                str(src),
                "--no-deps",
                "--no-build-isolation",
                "--no-index",
                "--no-cache-dir",
                "--disable-pip-version-check",
                "-w",
                str(out_dir),
            ],
            cwd=src,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert result.returncode == 0, result.stdout + result.stderr
        wheels = list(out_dir.glob("*.whl"))
        assert len(wheels) == 1, wheels
        yield wheels[0]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_wheel_ships_every_builtin_plugin_manifest(wheel_path):
    with zipfile.ZipFile(wheel_path) as wheel:
        shipped = {
            name
            for name in wheel.namelist()
            if name.startswith("plugins/") and name.endswith(("plugin.yaml", "plugin.yml"))
        }

    assert _builtin_plugin_manifests() <= shipped


def test_bundled_plugins_are_discovered_from_wheel(wheel_path, monkeypatch):
    extract_dir = wheel_path.parent / "extract"
    with zipfile.ZipFile(wheel_path) as wheel:
        wheel.extractall(extract_dir)

    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(extract_dir / "plugins"))

    from hermes_cli.plugins import PluginManager

    manager = PluginManager()
    manager.discover_and_load()

    # One flat plugin, one category plugin, and one platform plugin: the three
    # bundled layouts must all survive packaging.
    assert "disk-cleanup" in manager._plugins
    assert "image_gen/openai" in manager._plugins
    assert "irc-platform" in manager._plugins
