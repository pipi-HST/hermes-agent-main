from __future__ import annotations

import plistlib
from pathlib import Path
from types import SimpleNamespace

import pytest


def test_dashboard_launchd_label_and_path_are_profile_scoped(monkeypatch, tmp_path):
    import hermes_cli.dashboard_service as service

    monkeypatch.setattr(service, "_profile_suffix", lambda: "coder")
    monkeypatch.setattr(service, "_launchd_user_home", lambda: tmp_path)

    assert service.get_dashboard_launchd_label() == "ai.hermes.dashboard-coder"
    assert service.get_dashboard_launchd_plist_path() == (
        tmp_path / "Library" / "LaunchAgents" / "ai.hermes.dashboard-coder.plist"
    )


def test_generate_dashboard_launchd_plist_captures_runtime_contract(monkeypatch, tmp_path):
    import hermes_cli.dashboard_service as service

    project_root = tmp_path / "hermes-agent"
    venv = project_root / ".venv"
    hermes_home = tmp_path / ".hermes" / "profiles" / "coder"

    monkeypatch.setattr(service, "PROJECT_ROOT", project_root)
    monkeypatch.setattr(service, "get_python_path", lambda: str(venv / "bin" / "python"))
    monkeypatch.setattr(service, "get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(service, "_detect_venv_dir", lambda: venv)
    monkeypatch.setattr(service, "_build_service_path_dirs", lambda: [str(venv / "bin"), "/usr/bin"])
    monkeypatch.setattr(service, "_profile_arg", lambda _home: "--profile coder")
    monkeypatch.setattr(service, "get_dashboard_launchd_label", lambda: "ai.hermes.dashboard-coder")

    payload = plistlib.loads(
        service.generate_dashboard_launchd_plist(
            host="127.0.0.1",
            port=9123,
            embedded_chat=True,
        ).encode("utf-8")
    )

    assert payload["Label"] == "ai.hermes.dashboard-coder"
    assert payload["WorkingDirectory"] == str(project_root)
    assert payload["EnvironmentVariables"]["HERMES_HOME"] == str(hermes_home)
    assert payload["RunAtLoad"] is True
    assert payload["KeepAlive"] == {"SuccessfulExit": False}
    assert payload["ProgramArguments"] == [
        str(venv / "bin" / "python"),
        "-m",
        "hermes_cli.main",
        "--profile",
        "coder",
        "dashboard",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "9123",
        "--tui",
    ]


def test_generate_dashboard_launchd_plist_rejects_public_bind():
    import hermes_cli.dashboard_service as service

    with pytest.raises(ValueError, match="loopback"):
        service.generate_dashboard_launchd_plist(host="0.0.0.0", port=9119)


def test_install_rejects_invalid_config_before_touching_launchd(monkeypatch):
    import hermes_cli.dashboard_service as service

    monkeypatch.setattr(service.sys, "platform", "darwin")
    calls = []
    monkeypatch.setattr(
        service.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)),
    )

    with pytest.raises(ValueError, match="loopback"):
        service.install_dashboard_launchd_service(host="0.0.0.0", port=9119)

    assert calls == []


def test_install_dashboard_launchd_service_replaces_and_bootstraps(monkeypatch, tmp_path):
    import hermes_cli.dashboard_service as service

    plist_path = tmp_path / "ai.hermes.dashboard.plist"
    calls = []

    monkeypatch.setattr(service.sys, "platform", "darwin")
    monkeypatch.setattr(service, "get_dashboard_launchd_plist_path", lambda: plist_path)
    monkeypatch.setattr(service, "get_dashboard_launchd_label", lambda: "ai.hermes.dashboard")
    monkeypatch.setattr(service, "_launchd_domain", lambda: "gui/501")
    monkeypatch.setattr(service, "generate_dashboard_launchd_plist", lambda **_kwargs: "<plist>new</plist>\n")
    monkeypatch.setattr(
        service.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)) or SimpleNamespace(returncode=0, stdout=""),
    )

    service.install_dashboard_launchd_service(host="127.0.0.1", port=9119)

    assert plist_path.read_text(encoding="utf-8") == "<plist>new</plist>\n"
    assert calls[0][0] == ["launchctl", "bootout", "gui/501/ai.hermes.dashboard"]
    assert calls[1][0] == ["launchctl", "bootstrap", "gui/501", str(plist_path)]
    assert calls[2][0] == ["launchctl", "kickstart", "gui/501/ai.hermes.dashboard"]


def test_stop_dashboard_launchd_service_boots_out_loaded_job(monkeypatch):
    import hermes_cli.dashboard_service as service

    calls = []
    monkeypatch.setattr(service.sys, "platform", "darwin")
    monkeypatch.setattr(service, "get_dashboard_launchd_label", lambda: "ai.hermes.dashboard")
    monkeypatch.setattr(service, "_launchd_domain", lambda: "gui/501")
    monkeypatch.setattr(
        service.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)) or SimpleNamespace(returncode=0),
    )

    service.stop_dashboard_launchd_service()

    assert calls == [
        (
            ["launchctl", "bootout", "gui/501/ai.hermes.dashboard"],
            {"check": False, "capture_output": True, "text": True, "timeout": 30},
        )
    ]
