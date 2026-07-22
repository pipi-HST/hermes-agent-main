from hermes_cli.gateway import _runtime_health_lines


def test_runtime_health_lines_include_fatal_platform_and_startup_reason(monkeypatch):
    monkeypatch.setattr(
        "gateway.status.read_runtime_status",
        lambda: {
            "gateway_state": "startup_failed",
            "exit_reason": "telegram conflict",
            "platforms": {
                "telegram": {
                    "state": "fatal",
                    "error_message": "another poller is active",
                }
            },
        },
    )

    lines = _runtime_health_lines()

    assert "⚠ telegram: another poller is active" in lines
    assert "⚠ Last startup issue: telegram conflict" in lines


def test_runtime_health_lines_warn_when_status_heartbeat_is_stale(monkeypatch):
    monkeypatch.setattr(
        "gateway.status.read_runtime_status",
        lambda: {
            "gateway_state": "running",
            "updated_at": "2026-07-13T10:32:54+00:00",
            "platforms": {
                "weixin": {
                    "state": "connected",
                    "updated_at": "2026-07-13T10:32:54+00:00",
                }
            },
        },
    )
    monkeypatch.setattr("gateway.status.runtime_status_is_stale", lambda state: True)

    lines = _runtime_health_lines()

    assert any("stale" in line.lower() for line in lines)


def test_runtime_health_lines_include_retrying_platform(monkeypatch):
    monkeypatch.setattr(
        "gateway.status.read_runtime_status",
        lambda: {
            "gateway_state": "degraded",
            "updated_at": "2026-07-20T10:32:54+00:00",
            "platforms": {
                "weixin": {
                    "state": "retrying",
                    "error_message": "connection lost",
                    "updated_at": "2026-07-20T10:32:54+00:00",
                }
            },
        },
    )
    monkeypatch.setattr("gateway.status.runtime_status_is_stale", lambda state: False)

    lines = _runtime_health_lines()

    assert "⚠ weixin: retrying (connection lost)" in lines
