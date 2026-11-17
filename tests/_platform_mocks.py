"""Shared stand-ins for platform SDKs (discord, telegram) in tests.

Why this module exists
----------------------
Several test packages need ``discord`` / ``telegram`` mocked.  If a conftest
*replaces* ``sys.modules["discord"]`` after another module already did
``import discord``, those modules keep the old object while tests patch the
new one: ``isinstance`` checks and monkeypatches silently miss.  That is how
10 slash-command tests failed even though each conftest's mock looked fine in
isolation.

Rules
-----
- One module object per ``sys.modules`` key for the whole pytest worker.
- ``ensure_*`` never replaces an installed mock; it only fills in missing
  attributes.  Real libraries (``__file__`` set) are left untouched.
- The root ``tests/conftest.py`` calls both functions before collection, so
  every subdirectory conftest sees the comprehensive mock.
"""
from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock


def _is_real_module(module: object) -> bool:
    return (
        module is not None
        and not isinstance(module, MagicMock)
        and bool(getattr(module, "__file__", None))
    )


# ---------------------------------------------------------------------------
# discord
# ---------------------------------------------------------------------------


class _FakePermissions:
    def __init__(self, value=0, **_):
        self.value = value


class _FakeDMChannel:
    pass


class _FakeThread:
    pass


class _FakeForumChannel:
    pass


class _FakeMessage:
    pass


class _FakeEmbed:
    def __init__(self, *, title=None, description=None, color=None, **_):
        self.title = title
        self.description = description
        self.color = color
        self.fields = []
        self.footer = None

    def add_field(self, *, name=None, value=None, inline=False, **_):
        self.fields.append({"name": name, "value": value, "inline": inline})
        return self

    def set_footer(self, *, text=None, icon_url=None, **_):
        self.footer = {"text": text, "icon_url": icon_url}
        return self


class _FakeView:
    def __init__(self, timeout=None):
        self.timeout = timeout
        self.children = []

    def add_item(self, item):
        self.children.append(item)

    def clear_items(self):
        self.children.clear()


class _FakeSelect:
    def __init__(self, *, placeholder=None, options=None, custom_id=None, **_):
        self.placeholder = placeholder
        self.options = options or []
        self.custom_id = custom_id
        self.callback = None
        self.disabled = False


class _FakeButton:
    def __init__(
        self,
        *,
        label=None,
        style=None,
        custom_id=None,
        emoji=None,
        url=None,
        disabled=False,
        row=None,
        sku_id=None,
        **_,
    ):
        self.label = label
        self.style = style
        self.custom_id = custom_id
        self.emoji = emoji
        self.url = url
        self.disabled = disabled
        self.row = row
        self.sku_id = sku_id
        self.callback = None


class _FakeSelectOption:
    def __init__(self, *, label=None, value=None, description=None, **_):
        self.label = label
        self.value = value
        self.description = description


class _FakeCommand:
    def __init__(self, *, name, description, callback, parent=None):
        self.name = name
        self.description = description
        self.callback = callback
        self.parent = parent
        self.default_permissions = None


class _FakeGroup:
    def __init__(self, *, name, description, parent=None):
        self.name = name
        self.description = description
        self.parent = parent
        self._children: dict[str, object] = {}
        if parent is not None:
            parent.add_command(self)

    def add_command(self, cmd):
        self._children[cmd.name] = cmd


def ensure_discord_mock() -> object | None:
    """Return the shared ``discord`` module, installing/augmenting a mock."""
    module = sys.modules.get("discord")
    if _is_real_module(module):
        return module
    if not isinstance(module, MagicMock):
        module = MagicMock()
        sys.modules["discord"] = module

    module.Intents.default.return_value = MagicMock()
    module.Client = MagicMock
    module.File = MagicMock
    module.DMChannel = _FakeDMChannel
    module.Thread = _FakeThread
    module.ForumChannel = _FakeForumChannel
    module.Message = _FakeMessage
    module.Interaction = object
    module.Permissions = _FakePermissions
    module.Embed = _FakeEmbed
    module.SelectOption = _FakeSelectOption
    module.Forbidden = type("Forbidden", (Exception,), {})
    # MagicMock so every enum member test code reaches exists; pin the two
    # values the adapters compare against.
    module.MessageType = MagicMock()
    module.MessageType.default = 0
    module.MessageType.reply = 19
    module.Object = lambda *, id: SimpleNamespace(id=id)
    module.opus.is_loaded.return_value = True
    module.ui = SimpleNamespace(
        View=_FakeView,
        Select=_FakeSelect,
        Button=_FakeButton,
        button=lambda *a, **k: (lambda fn: fn),
    )
    module.ButtonStyle = SimpleNamespace(
        success=1,
        primary=2,
        secondary=2,
        danger=3,
        green=1,
        grey=2,
        blurple=2,
        red=3,
    )
    module.Color = SimpleNamespace(
        orange=lambda: 1,
        green=lambda: 2,
        blue=lambda: 3,
        red=lambda: 4,
        purple=lambda: 5,
        greyple=lambda: 6,
    )
    module.app_commands = SimpleNamespace(
        describe=lambda **kwargs: (lambda fn: fn),
        choices=lambda **kwargs: (lambda fn: fn),
        autocomplete=lambda **kwargs: (lambda fn: fn),
        Choice=lambda **kwargs: SimpleNamespace(**kwargs),
        Group=_FakeGroup,
        Command=_FakeCommand,
    )

    ext = sys.modules.get("discord.ext")
    if not isinstance(ext, MagicMock):
        ext = MagicMock()
        sys.modules["discord.ext"] = ext
    commands = sys.modules.get("discord.ext.commands")
    if not isinstance(commands, MagicMock):
        commands = MagicMock()
        sys.modules["discord.ext.commands"] = commands
    commands.Bot = MagicMock
    ext.commands = commands
    return module


# ---------------------------------------------------------------------------
# telegram
# ---------------------------------------------------------------------------


class _TgNetworkError(OSError):
    pass


class _TgTimedOut(OSError):
    pass


class _TgBadRequest(Exception):
    pass


class _TgForbidden(Exception):
    pass


class _TgInvalidToken(Exception):
    pass


class _TgRetryAfter(Exception):
    retry_after = 1


class _TgConflict(Exception):
    pass


def ensure_telegram_mock() -> object | None:
    """Return the shared ``telegram`` module, installing/augmenting a mock."""
    module = sys.modules.get("telegram")
    if _is_real_module(module):
        return module
    if not isinstance(module, MagicMock):
        module = MagicMock()
        sys.modules["telegram"] = module

    module.ext.ContextTypes.DEFAULT_TYPE = type(None)
    module.constants.ParseMode.MARKDOWN = "Markdown"
    module.constants.ParseMode.MARKDOWN_V2 = "MarkdownV2"
    module.constants.ParseMode.HTML = "HTML"
    module.constants.ChatType.PRIVATE = "private"
    module.constants.ChatType.GROUP = "group"
    module.constants.ChatType.SUPERGROUP = "supergroup"
    module.constants.ChatType.CHANNEL = "channel"
    module.error.NetworkError = _TgNetworkError
    module.error.TimedOut = _TgTimedOut
    module.error.BadRequest = _TgBadRequest
    module.error.Forbidden = _TgForbidden
    module.error.InvalidToken = _TgInvalidToken
    module.error.RetryAfter = _TgRetryAfter
    module.error.Conflict = _TgConflict
    module.Update.ALL_TYPES = []

    for name in ("telegram", "telegram.ext", "telegram.constants", "telegram.request"):
        sys.modules[name] = module
    return module
