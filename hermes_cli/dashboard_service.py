"""macOS launchd service management for ``hermes dashboard``."""

from __future__ import annotations

import ipaddress
import os
import plistlib
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from hermes_constants import get_hermes_home
from hermes_cli.gateway import (
    _build_service_path_dirs,
    _detect_venv_dir,
    _launchd_domain,
    _launchd_user_home,
    _profile_arg,
    _profile_suffix,
    get_python_path,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class DashboardLaunchdStatus:
    installed: bool
    loaded: bool
    label: str
    path: Path
    pid: int | None = None
    state: str = ""


def get_dashboard_launchd_label() -> str:
    suffix = _profile_suffix()
    return f"ai.hermes.dashboard-{suffix}" if suffix else "ai.hermes.dashboard"


def get_dashboard_launchd_plist_path() -> Path:
    return (
        _launchd_user_home()
        / "Library"
        / "LaunchAgents"
        / f"{get_dashboard_launchd_label()}.plist"
    )


def _target() -> str:
    return f"{_launchd_domain()}/{get_dashboard_launchd_label()}"


def _require_macos() -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Dashboard service management currently supports macOS launchd only")


def _validate_loopback_host(host: str) -> str:
    normalized = str(host or "").strip()
    if normalized.lower() == "localhost":
        return normalized
    try:
        if ipaddress.ip_address(normalized.strip("[]")).is_loopback:
            return normalized
    except ValueError:
        pass
    raise ValueError("Dashboard launchd service must bind to a loopback host")


def validate_dashboard_launchd_service_options(host: str, port: int) -> tuple[str, int]:
    """Validate service arguments before any existing dashboard is stopped."""
    normalized_host = _validate_loopback_host(host)
    normalized_port = int(port)
    if not 1 <= normalized_port <= 65535:
        raise ValueError("Dashboard port must be between 1 and 65535")
    return normalized_host, normalized_port


def require_dashboard_launchd_service_installed() -> Path:
    """Reject unsupported or missing services before destructive CLI actions."""
    _require_macos()
    path = get_dashboard_launchd_plist_path()
    if not path.exists():
        raise RuntimeError("Dashboard service is not installed; run with --install-service")
    return path


def generate_dashboard_launchd_plist(
    *,
    host: str = "127.0.0.1",
    port: int = 9119,
    embedded_chat: bool = False,
) -> str:
    host, port = validate_dashboard_launchd_service_options(host, port)

    python_path = get_python_path()
    hermes_home = get_hermes_home().resolve()
    log_dir = hermes_home / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    detected_venv = _detect_venv_dir()
    venv_dir = detected_venv or Path(python_path).resolve().parent.parent
    priority_dirs = _build_service_path_dirs()
    resolved_node = shutil.which("node")
    if resolved_node:
        node_dir = str(Path(resolved_node).resolve().parent)
        if node_dir not in priority_dirs:
            priority_dirs.append(node_dir)
    sane_path = ":".join(
        dict.fromkeys(
            priority_dirs
            + [part for part in os.environ.get("PATH", "").split(":") if part]
        )
    )

    arguments = [python_path, "-m", "hermes_cli.main"]
    profile_arg = _profile_arg(str(hermes_home))
    if profile_arg:
        arguments.extend(profile_arg.split())
    arguments.extend(
        [
            "dashboard",
            "--no-open",
            "--host",
            host,
            "--port",
            str(port),
        ]
    )
    if embedded_chat:
        arguments.append("--tui")

    payload = {
        "Label": get_dashboard_launchd_label(),
        "ProgramArguments": arguments,
        "WorkingDirectory": str(PROJECT_ROOT),
        "EnvironmentVariables": {
            "PATH": sane_path,
            "VIRTUAL_ENV": str(venv_dir),
            "HERMES_HOME": str(hermes_home),
        },
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 5,
        "LimitLoadToSessionType": "Aqua",
        "StandardOutPath": str(log_dir / "dashboard.log"),
        "StandardErrorPath": str(log_dir / "dashboard.error.log"),
    }
    return plistlib.dumps(payload, sort_keys=False).decode("utf-8")


def get_dashboard_launchd_status() -> DashboardLaunchdStatus:
    path = get_dashboard_launchd_plist_path()
    label = get_dashboard_launchd_label()
    if sys.platform != "darwin":
        return DashboardLaunchdStatus(path.exists(), False, label, path)

    result = subprocess.run(
        ["launchctl", "print", _target()],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        return DashboardLaunchdStatus(path.exists(), False, label, path)

    state_match = re.search(r"^\s*state = (.+)$", result.stdout, re.MULTILINE)
    pid_match = re.search(r"^\s*pid = (\d+)$", result.stdout, re.MULTILINE)
    return DashboardLaunchdStatus(
        installed=path.exists(),
        loaded=True,
        label=label,
        path=path,
        pid=int(pid_match.group(1)) if pid_match else None,
        state=state_match.group(1).strip() if state_match else "",
    )


def install_dashboard_launchd_service(
    *,
    host: str = "127.0.0.1",
    port: int = 9119,
    embedded_chat: bool = False,
) -> None:
    _require_macos()
    content = generate_dashboard_launchd_plist(
        host=host,
        port=port,
        embedded_chat=embedded_chat,
    )
    path = get_dashboard_launchd_plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["launchctl", "bootout", _target()],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    try:
        temp_path.write_text(content, encoding="utf-8")
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    subprocess.run(
        ["launchctl", "bootstrap", _launchd_domain(), str(path)],
        check=True,
        timeout=30,
    )
    subprocess.run(
        ["launchctl", "kickstart", _target()],
        check=True,
        timeout=30,
    )
    print(f"✓ Dashboard service installed and started: {path}")


def start_dashboard_launchd_service() -> None:
    path = require_dashboard_launchd_service_installed()
    status = get_dashboard_launchd_status()
    if not status.loaded:
        subprocess.run(
            ["launchctl", "bootstrap", _launchd_domain(), str(path)],
            check=True,
            timeout=30,
        )
    subprocess.run(["launchctl", "kickstart", _target()], check=True, timeout=30)
    print("✓ Dashboard service started")


def stop_dashboard_launchd_service() -> None:
    _require_macos()
    subprocess.run(
        ["launchctl", "bootout", _target()],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def restart_dashboard_launchd_service() -> None:
    path = require_dashboard_launchd_service_installed()
    status = get_dashboard_launchd_status()
    if not status.loaded:
        subprocess.run(
            ["launchctl", "bootstrap", _launchd_domain(), str(path)],
            check=True,
            timeout=30,
        )
    subprocess.run(
        ["launchctl", "kickstart", "-k", _target()],
        check=True,
        timeout=30,
    )
    print("✓ Dashboard service restarted")


def uninstall_dashboard_launchd_service() -> None:
    _require_macos()
    stop_dashboard_launchd_service()
    path = get_dashboard_launchd_plist_path()
    path.unlink(missing_ok=True)
    print(f"✓ Dashboard service uninstalled: {path}")
