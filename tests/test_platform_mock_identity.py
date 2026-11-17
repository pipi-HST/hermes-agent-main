"""Guards the one-mock-per-worker rule for platform SDK stand-ins.

A conftest that replaces ``sys.modules["discord"]`` after another module has
already imported it leaves that module on a stale object; isinstance checks
and monkeypatches then miss. These tests pin the object identity.
"""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

from tests._platform_mocks import ensure_discord_mock, ensure_telegram_mock


def test_discord_mock_identity_is_stable():
    before = sys.modules["discord"]
    ensure_discord_mock()
    ensure_discord_mock()
    assert sys.modules["discord"] is before

    import discord

    assert discord.app_commands.Command is not None
    assert discord.app_commands.autocomplete is not None
    assert discord.Permissions(0).value == 0
    assert discord.ui.View().children == []


def test_telegram_mock_identity_is_stable():
    before = sys.modules["telegram"]
    ensure_telegram_mock()
    ensure_telegram_mock()
    assert sys.modules["telegram"] is before


def test_ensure_upgrades_a_weak_mock_without_replacing_it(monkeypatch):
    weak = MagicMock()
    monkeypatch.setitem(sys.modules, "discord", weak)

    ensure_discord_mock()

    assert sys.modules["discord"] is weak
    assert weak.app_commands.Command is not None
    assert weak.ui.View is not None
