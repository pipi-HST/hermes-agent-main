"""Tests for hermes_cli.web_server and related config utilities."""

import base64
import asyncio
import os
import json
import tempfile
import sys
import types
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from hermes_cli.config import (
    DEFAULT_CONFIG,
    reload_env,
    redact_key,
    _EXTRA_ENV_KEYS,
    OPTIONAL_ENV_VARS,
)


@pytest.fixture(autouse=True)
def _reset_knowledge_contract_cache():
    """The contract cache is process-global; isolate it between tests."""
    from integrations.hermes_knowledge.client import clear_contract_cache

    clear_contract_cache()
    yield
    clear_contract_cache()


class _FakeKnowledgeServiceClient:
    """Stand-in for ``integrations.hermes_knowledge.client.KnowledgeClient``."""

    def __init__(
        self,
        *,
        error=None,
        result=None,
        issued=None,
        update_result=None,
        responses=None,
    ):
        self.error = error
        self.result = (
            result if result is not None else {"ok": True, "status": "permanently_deleted"}
        )
        self.issued = issued if issued is not None else {"token": "tok"}
        self.update_result = (
            update_result
            if update_result is not None
            else {"capture_id": "cap-1", "item": {"id": "cap-1"}}
        )
        self.responses = dict(responses or {})
        self.closed = False
        self.delete_calls: list[tuple[str, str, str]] = []
        self.update_calls: list[dict] = []
        self.calls: list[dict] = []

    def _respond(self, method, *args, **kwargs):
        if self.error is not None:
            raise self.error
        self.calls.append({"method": method, "args": args, "kwargs": kwargs})
        if method in self.responses:
            result = self.responses[method]
            return dict(result) if isinstance(result, dict) else result
        return {"ok": True, "method": method}

    def create_library_item(self, **fields):
        return self._respond("create_library_item", **fields)

    def patch_library_item(self, kind, item_id, **fields):
        return self._respond("patch_library_item", kind, item_id, **fields)

    def delete_library_item(self, kind, item_id):
        return self._respond("delete_library_item", kind, item_id)

    def list_library_folders(self):
        return self._respond("list_library_folders")

    def create_library_folder(self, name):
        return self._respond("create_library_folder", name)

    def rename_library_folder(self, folder_path, name):
        return self._respond("rename_library_folder", folder_path, name)

    def patch_capture_draft(self, draft_id, **fields):
        return self._respond("patch_capture_draft", draft_id, **fields)

    def delete_capture_draft(self, draft_id):
        return self._respond("delete_capture_draft", draft_id)

    def delete_reading_draft(self, draft_id):
        return self._respond("delete_reading_draft", draft_id)

    def list_library_items(self, **query):
        return self._respond("list_library_items", **query)

    def get_library_item(self, kind, item_id):
        return self._respond("get_library_item", kind, item_id)

    def create_garden_draft(self, *, capture_ids=None, title="", card_kind="", instruction=""):
        return self._respond(
            "create_garden_draft",
            capture_ids=capture_ids,
            title=title,
            card_kind=card_kind,
            instruction=instruction,
        )

    def list_garden_cards(self, *, limit=100, status=""):
        return self._respond("list_garden_cards", limit=limit, status=status)

    def delete_garden_card(self, card_id):
        return self._respond("delete_garden_card", card_id)

    def graph(self, *, focus_kind="", focus_id="", depth=1, limit=80):
        return self._respond(
            "graph",
            focus_kind=focus_kind,
            focus_id=focus_id,
            depth=depth,
            limit=limit,
        )

    def refresh_graph(self):
        return self._respond("refresh_graph")

    def create_answer_draft(self, payload):
        return self._respond("create_answer_draft", payload)

    def update_capture(self, capture_id, *, body="", title="", folder_path=None):
        if self.error is not None:
            raise self.error
        self.update_calls.append(
            {
                "capture_id": capture_id,
                "body": body,
                "title": title,
                "folder_path": folder_path,
            }
        )
        return self.update_result

    def issue_library_delete_confirmation(self, kind, item_id):
        if self.error is not None:
            raise self.error
        return self.issued

    def permanent_delete_library_item(self, kind, item_id, confirmation_token):
        if self.error is not None:
            raise self.error
        self.delete_calls.append((kind, item_id, confirmation_token))
        return self.result

    def close(self):
        self.closed = True


# ---------------------------------------------------------------------------
# reload_env tests
# ---------------------------------------------------------------------------


class TestReloadEnv:
    """Tests for reload_env() — re-reads .env into os.environ."""

    def test_adds_new_vars(self, tmp_path):
        """reload_env() adds vars from .env that are not in os.environ."""
        env_file = tmp_path / ".env"
        env_file.write_text("TEST_RELOAD_VAR=hello123\n")
        with patch.dict(reload_env.__globals__, {"get_env_path": lambda: env_file}):
            os.environ.pop("TEST_RELOAD_VAR", None)
            count = reload_env()
            assert count >= 1
            assert os.environ.get("TEST_RELOAD_VAR") == "hello123"
        os.environ.pop("TEST_RELOAD_VAR", None)

    def test_updates_changed_vars(self, tmp_path):
        """reload_env() updates vars whose value changed on disk."""
        env_file = tmp_path / ".env"
        env_file.write_text("TEST_RELOAD_VAR=old_value\n")
        with patch.dict(reload_env.__globals__, {"get_env_path": lambda: env_file}):
            os.environ["TEST_RELOAD_VAR"] = "old_value"
            # Now change the file
            env_file.write_text("TEST_RELOAD_VAR=new_value\n")
            count = reload_env()
            assert count >= 1
            assert os.environ.get("TEST_RELOAD_VAR") == "new_value"
        os.environ.pop("TEST_RELOAD_VAR", None)

    def test_removes_deleted_known_vars(self, tmp_path):
        """reload_env() removes known Hermes vars not present in .env."""
        env_file = tmp_path / ".env"
        env_file.write_text("")  # empty .env
        # Pick a known key from OPTIONAL_ENV_VARS
        known_key = next(iter(OPTIONAL_ENV_VARS.keys()))
        with patch.dict(reload_env.__globals__, {"get_env_path": lambda: env_file}):
            os.environ[known_key] = "stale_value"
            count = reload_env()
            assert known_key not in os.environ
            assert count >= 1

    def test_does_not_remove_unknown_vars(self, tmp_path):
        """reload_env() preserves non-Hermes env vars even when absent from .env."""
        env_file = tmp_path / ".env"
        env_file.write_text("")
        with patch.dict(reload_env.__globals__, {"get_env_path": lambda: env_file}):
            os.environ["MY_CUSTOM_UNRELATED_VAR"] = "keep_me"
            reload_env()
            assert os.environ.get("MY_CUSTOM_UNRELATED_VAR") == "keep_me"
        os.environ.pop("MY_CUSTOM_UNRELATED_VAR", None)


# ---------------------------------------------------------------------------
# redact_key tests
# ---------------------------------------------------------------------------


class TestRedactKey:
    def test_long_key_shows_prefix_suffix(self):
        result = redact_key("sk-1234567890abcdef")
        assert result.startswith("sk-1")
        assert result.endswith("cdef")
        assert "..." in result

    def test_short_key_fully_masked(self):
        assert redact_key("short") == "***"

    def test_empty_key(self):
        result = redact_key("")
        assert "not set" in result.lower() or result == "***" or "\x1b" in result


# ---------------------------------------------------------------------------
# web_server tests (FastAPI endpoints)
# ---------------------------------------------------------------------------


class TestWebServerEndpoints:
    """Test the FastAPI REST endpoints using Starlette TestClient."""

    @pytest.fixture(autouse=True)
    def _setup_test_client(self, monkeypatch, _isolate_hermes_home):
        """Create a TestClient and isolate the state DB under the test HERMES_HOME."""
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        import hermes_state
        from hermes_constants import get_hermes_home
        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")

        self.client = TestClient(app)
        self.client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_get_status(self):
        resp = self.client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "version" in data
        assert "hermes_home" in data
        assert "active_sessions" in data

    def test_dashboard_upload_writes_file_under_tmp_uploads(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "PROJECT_ROOT", tmp_path)
        text = "# hello\nbody"
        payload = {
            "name": "../notes/测试材料.md",
            "mime_type": "text/markdown",
            "content_base64": base64.b64encode(text.encode()).decode(),
        }

        response = self.client.post("/api/dashboard/uploads", json=payload)

        assert response.status_code == 200
        data = response.json()
        saved = Path(data["path"])
        assert saved.parent == tmp_path / "tmp" / "dashboard-uploads"
        assert saved.name.endswith("-测试材料.md")
        assert saved.read_text(encoding="utf-8") == text
        assert data["name"] == "测试材料.md"
        assert data["mime_type"] == "text/markdown"
        assert data["size"] == len(text.encode())

    def test_dashboard_plugins_skip_missing_frontend_entry(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as ws

        bundled = tmp_path / "bundled"
        dashboard = bundled / "broken" / "dashboard"
        dashboard.mkdir(parents=True)
        (dashboard / "manifest.json").write_text(
            json.dumps(
                {
                    "name": "broken",
                    "label": "Broken",
                    "entry": "dist/index.js",
                }
            ),
            encoding="utf-8",
        )

        monkeypatch.setattr(ws, "get_hermes_home", lambda: tmp_path / "home")
        monkeypatch.setattr(
            "hermes_cli.plugins.get_bundled_plugins_dir",
            lambda: bundled,
        )

        assert ws._discover_dashboard_plugins() == []

    def test_knowledge_file_url_uses_percent_encoded_spaces(self):
        import hermes_cli.web_server as ws

        url = ws._knowledge_file_url(
            Path("/Users/pipi/Hermes/knowledge"),
            "captures/Subagent 的三岔路-2026-06-17-6de5161b.md",
        )

        assert url.startswith("file:///Users/pipi/Hermes/knowledge/captures/")
        assert "%E7%9A%84" in url
        assert "+" not in url

    def test_knowledge_file_url_rejects_paths_outside_storage(self):
        import hermes_cli.web_server as ws

        root = Path("/Users/pipi/Hermes/knowledge")

        assert ws._knowledge_file_url(root, "/etc/passwd") == ""
        assert ws._knowledge_file_url(root, "../secrets.md") == ""

    def test_open_knowledge_library_capture_opens_existing_file(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as ws

        vault = tmp_path / "vault"
        target = vault / "captures" / "note.md"
        target.parent.mkdir(parents=True)
        target.write_text("# Note\n", encoding="utf-8")
        db_path = tmp_path / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE captures (id TEXT PRIMARY KEY, file_path TEXT, review_state TEXT)")
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state) VALUES (?, ?, ?)",
            ("cap-1", "captures/note.md", "captured"),
        )
        conn.commit()
        conn.close()
        calls: list[list[str]] = []

        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))
        monkeypatch.setattr(ws, "_knowledge_vault_path", lambda: vault)
        monkeypatch.setattr(ws.subprocess, "Popen", lambda cmd, **_kwargs: calls.append(cmd))

        response = self.client.post("/api/knowledge/library/items/capture/cap-1/open-local")

        assert response.status_code == 200
        assert response.json() == {"ok": True, "path": str(target.resolve())}
        if sys.platform == "darwin":
            expected_cmd = ["open", str(target.resolve())]
        elif sys.platform.startswith("linux"):
            expected_cmd = ["xdg-open", str(target.resolve())]
        elif sys.platform.startswith("win"):
            expected_cmd = ["cmd", "/c", "start", "", str(target.resolve())]
        else:
            expected_cmd = []
        assert calls == [expected_cmd]

    @pytest.mark.parametrize(
        ("kind", "file_path", "expected_status"),
        [
            ("capture_draft", "", 400),
            ("capture", "", 400),
            ("capture", "/etc/passwd", 400),
            ("capture", "../outside.md", 400),
            ("capture", "captures/missing.md", 404),
        ],
    )
    def test_open_knowledge_library_capture_rejects_unsafe_targets(
        self,
        monkeypatch,
        tmp_path,
        kind,
        file_path,
        expected_status,
    ):
        import sqlite3
        import hermes_cli.web_server as ws

        vault = tmp_path / "vault"
        vault.mkdir()
        db_path = tmp_path / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE captures (id TEXT PRIMARY KEY, file_path TEXT, review_state TEXT)")
        conn.execute("CREATE TABLE capture_drafts (id TEXT PRIMARY KEY)")
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state) VALUES (?, ?, ?)",
            ("cap-1", file_path, "captured"),
        )
        conn.execute("INSERT INTO capture_drafts (id) VALUES (?)", ("draft-1",))
        conn.commit()
        conn.close()

        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))
        monkeypatch.setattr(ws, "_knowledge_vault_path", lambda: vault)
        monkeypatch.setattr(
            ws.subprocess,
            "Popen",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("should not open file")),
        )

        item_id = "draft-1" if kind == "capture_draft" else "cap-1"
        response = self.client.post(f"/api/knowledge/library/items/{kind}/{item_id}/open-local")

        assert response.status_code == expected_status

    def test_knowledge_capture_drafts_api_returns_reviewable_drafts(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as ws

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE capture_drafts (
               id TEXT PRIMARY KEY,
               raw_text TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL DEFAULT '',
               source_type TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               word_count INTEGER NOT NULL DEFAULT 0,
               draft_text TEXT NOT NULL DEFAULT '',
               instruction TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'raw_extracted',
               committed_capture_id TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               capture_intent TEXT NOT NULL DEFAULT '{}'
            )"""
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, raw_text, source_type, title, word_count, draft_text,
                instruction, summary, tags, status, capture_intent, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-1",
                "原文正文",
                "document",
                "智能问数",
                4,
                "# 智能问数\n\n整理稿正文",
                "全文入库",
                "这是一篇智能问数材料。",
                '["ai","data"]',
                "draft_ready",
                '{"material_intent":"verbatim_full_text","output_shape":["full_text"]}',
                "2026-06-15T00:00:00+00:00",
            ),
        )
        conn.executemany(
            """INSERT INTO capture_drafts
               (id, title, status, updated_at)
               VALUES (?, ?, ?, ?)""",
            [
                ("draft-abandoned", "已删除 Capture", "abandoned", "2026-06-16T00:00:00+00:00"),
                ("draft-discarded", "已丢弃 Capture", "discarded", "2026-06-17T00:00:00+00:00"),
            ],
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        list_resp = self.client.get("/api/knowledge/capture-drafts")
        detail_resp = self.client.get("/api/knowledge/capture-drafts/draft-1")

        assert list_resp.status_code == 200
        drafts = list_resp.json()["drafts"]
        assert [draft["id"] for draft in drafts] == ["draft-1"]
        assert drafts[0]["id"] == "draft-1"
        assert drafts[0]["title"] == "智能问数"
        assert drafts[0]["user_intent"] == "verbatim_full_text"
        assert drafts[0]["tags"] == ["ai", "data"]
        assert "整理稿正文" in drafts[0]["draft_preview"]
        assert detail_resp.status_code == 200
        detail = detail_resp.json()
        assert detail["draft"]["draft_text"] == "# 智能问数\n\n整理稿正文"
        assert detail["draft"]["raw_text"] == "原文正文"

    def test_knowledge_capture_library_item_reads_identity_index(self, tmp_path):
        import sqlite3
        import hermes_cli.web_server as ws

        vault = tmp_path / "vault"
        capture_dir = vault / "captures"
        capture_dir.mkdir(parents=True)
        (capture_dir / "indexed.md").write_text(
            "---\n"
            "title: 已索引材料\n"
            "status: processed\n"
            "---\n\n"
            "## 正文\n\n已索引正文。\n",
            encoding="utf-8",
        )
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """CREATE TABLE captures (
               id TEXT PRIMARY KEY,
               file_path TEXT,
               raw_path TEXT,
               review_state TEXT,
               created_at TEXT,
               updated_at TEXT
            )"""
        )
        conn.execute(
            """CREATE TABLE capture_embeddings (
               id TEXT PRIMARY KEY,
               capture_id TEXT,
               kind TEXT,
               embedding BLOB
            )"""
        )
        conn.execute(
            "INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?)",
            ("cap-indexed", "captures/indexed.md", "", "captured", "", ""),
        )
        conn.execute(
            "INSERT INTO capture_embeddings VALUES (?, ?, ?, ?)",
            ("emb-indexed", "cap-indexed", "identity", b"embedding"),
        )
        row = conn.execute("SELECT * FROM captures WHERE id = ?", ("cap-indexed",)).fetchone()

        item = ws._knowledge_capture_library_item(vault, row, conn=conn)

        assert item["indexed"] is True
        conn.close()

    def test_knowledge_reading_drafts_list_hides_deleted_statuses(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE reading_drafts (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL DEFAULT '',
               output_type TEXT NOT NULL DEFAULT '',
               target_capture_id TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'open',
               draft_text TEXT NOT NULL DEFAULT '',
               meta_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"""
        )
        conn.executemany(
            """INSERT INTO reading_drafts
               (id, title, status, updated_at)
               VALUES (?, ?, ?, ?)""",
            [
                ("reading-open", "待处理回答", "open", "2026-06-15T00:00:00+00:00"),
                ("reading-abandoned", "已删除回答", "abandoned", "2026-06-16T00:00:00+00:00"),
                ("reading-discarded", "已丢弃回答", "discarded", "2026-06-17T00:00:00+00:00"),
            ],
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        response = self.client.get("/api/knowledge/reading-drafts")

        assert response.status_code == 200
        assert [draft["id"] for draft in response.json()["drafts"]] == ["reading-open"]

    def test_knowledge_library_selection_chat_uses_async_research_bridge(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE capture_drafts (
               id TEXT PRIMARY KEY,
               raw_text TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL DEFAULT '',
               source_type TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               word_count INTEGER NOT NULL DEFAULT 0,
               draft_text TEXT NOT NULL DEFAULT '',
               instruction TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'draft_ready',
               committed_capture_id TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               capture_intent TEXT NOT NULL DEFAULT '{}'
            )"""
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, raw_text, title, word_count, draft_text, summary, tags, status, capture_intent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-chat-1",
                "原文",
                "测试文章",
                2,
                "# 测试文章\n\n苹果现在的市值多少",
                "摘要",
                '["test"]',
                "draft_ready",
                '{"folder_path":"Inbox"}',
            ),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        if str(custom_root) not in sys.path:
            sys.path.insert(0, str(custom_root))

        fake_bridge = types.ModuleType("bridge")
        fake_bridge.__path__ = []
        research_bridge = types.ModuleType("bridge.research_bridge")
        monkeypatch.setitem(sys.modules, "bridge", fake_bridge)
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", research_bridge)

        called = {}

        async def fake_async_web_assist_answer(**kwargs):
            called.update(kwargs)
            return {
                "status": "success",
                "chat_preview": "联网回答 [W1]",
                "warnings": [],
                "meta": {
                    "mode": kwargs["mode"],
                    "knowledge_sources": [],
                    "web_sources": [
                        {
                            "ref": "W1",
                            "type": "web",
                            "id": "https://example.com",
                            "title": "网页来源",
                            "url": "https://example.com",
                            "excerpt": "网页正文",
                        }
                    ],
                    "reasoning_trace": {"source": "api", "api_reasoning": "检索后回答"},
                    "updated_history_summary": "已讨论苹果市值。",
                    "updated_history_summary_version": 4,
                },
            }

        monkeypatch.setattr(research_bridge, "async_web_assist_answer", fake_async_web_assist_answer, raising=False)

        resp = self.client.post(
            "/api/knowledge/library/items/capture_draft/draft-chat-1/selection-chat",
            json={
                "question": "苹果现在的市值多少",
                "selected_text": "苹" * 1000,
                "mode": "web_only",
                "history": [{"role": "user", "content": "上一问"}],
                "history_summary": "旧摘要",
                "history_summary_version": 3,
                "history_overflow": [{"role": "assistant", "content": "旧回答"}],
                "force_web": True,
            },
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["answer"] == "联网回答 [W1]"
        assert data["mode"] == "web_only"
        assert data["sources"]["web"][0]["ref"] == "W1"
        assert data["meta"]["reasoning_trace"]["source"] == "api"
        assert data["meta"]["updated_history_summary"] == "已讨论苹果市值。"
        assert data["meta"]["updated_history_summary_version"] == 4
        assert called["mode"] == "web_only"
        assert called["selection_context"]["selected_text"] == "苹" * 1000
        assert called["history"] == [{"role": "user", "content": "上一问"}]
        assert called["history_summary"] == "旧摘要"
        assert called["history_summary_version"] == 3
        assert called["history_overflow"] == [{"role": "assistant", "content": "旧回答"}]
        assert called["force_web"] is True

    def test_knowledge_library_selection_chat_merges_and_enriches_source_map(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "captures").mkdir(parents=True)
        (vault / "captures" / "source.md").write_text("# 来源笔记\n", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                raw_text TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                draft_text TEXT NOT NULL DEFAULT '',
                instruction TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'draft_ready',
                committed_capture_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                capture_intent TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                embedding BLOB
            );
            """
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, raw_text, title, word_count, draft_text, summary, tags, status, capture_intent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-chat-1",
                "原文",
                "测试文章",
                2,
                "# 测试文章\n\nLLM 是什么",
                "摘要",
                '["test"]',
                "draft_ready",
                '{"folder_path":"Inbox"}',
            ),
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("cap-1", "captures/source.md", "captured", "2026-06-20T00:00:00+00:00", "2026-06-20T00:00:00+00:00"),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        if str(custom_root) not in sys.path:
            sys.path.insert(0, str(custom_root))

        fake_bridge = types.ModuleType("bridge")
        fake_bridge.__path__ = []
        research_bridge = types.ModuleType("bridge.research_bridge")
        monkeypatch.setitem(sys.modules, "bridge", fake_bridge)
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", research_bridge)

        async def fake_async_web_assist_answer(**kwargs):
            return {
                "status": "success",
                "chat_preview": "合并来源回答 [K1][W1]",
                "warnings": [],
                "source_map": [
                    {
                        "ref": "K1",
                        "type": "capture_note",
                        "id": "cap-1",
                        "title": "来源笔记",
                        "file_path": "captures/source.md",
                    },
                    {
                        "ref": "W1",
                        "type": "web",
                        "title": "网页来源",
                        "url": "https://example.com/source",
                        "excerpt": "网页材料",
                    },
                ],
                "meta": {
                    "mode": kwargs["mode"],
                    "knowledge_sources": [{"ref": "K1", "title": "来源笔记"}],
                    "web_sources": [],
                },
            }

        monkeypatch.setattr(research_bridge, "async_web_assist_answer", fake_async_web_assist_answer, raising=False)

        resp = self.client.post(
            "/api/knowledge/library/items/capture_draft/draft-chat-1/selection-chat",
            json={
                "question": "LLM 是什么",
                "selected_text": "",
                "mode": "local_web",
            },
        )

        assert resp.status_code == 200
        data = resp.json()
        knowledge = data["sources"]["knowledge"][0]
        web = data["sources"]["web"][0]
        assert knowledge["ref"] == "K1"
        assert knowledge["item_kind"] == "capture"
        assert knowledge["item_id"] == "cap-1"
        assert knowledge["open_url"] == "/knowledge-library?kind=capture&item=cap-1"
        assert knowledge["file_url"].startswith("file://")
        assert web["ref"] == "W1"
        assert web["url"] == "https://example.com/source"

    def test_knowledge_library_selection_chat_rejects_overlong_selection_before_research(self, monkeypatch):
        calls = {"count": 0}

        async def fake_async_web_assist_answer(**_kwargs):
            calls["count"] += 1
            return {"status": "success", "chat_preview": "不应调用", "warnings": [], "meta": {}}

        fake_module = types.ModuleType("bridge.research_bridge")
        fake_module.async_web_assist_answer = fake_async_web_assist_answer
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", fake_module)

        response = self.client.post(
            "/api/knowledge/library/items/capture/missing/selection-chat",
            json={
                "question": "这两个有什么区别",
                "selected_text": "选" * 1001,
                "mode": "local_web",
            },
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "选区超过 1000 字，当前不支持基于超长选区检索。请缩短选区后再试。"
        assert calls["count"] == 0

        stream_response = self.client.post(
            "/api/knowledge/library/items/capture/missing/selection-chat/stream",
            json={
                "question": "这两个有什么区别",
                "selected_text": "选" * 1001,
                "mode": "local_web",
            },
        )

        assert stream_response.status_code == 200
        events = [
            json.loads(line.removeprefix("data: "))
            for line in stream_response.text.splitlines()
            if line.startswith("data: ")
        ]
        assert events[0] == {"event": "start", "mode": "local_web"}
        assert events[1] == {
            "event": "error",
            "message": "选区超过 1000 字，当前不支持基于超长选区检索。请缩短选区后再试。",
        }
        assert calls["count"] == 0

    def test_knowledge_selection_chat_uses_offsets_for_duplicate_short_selection(self):
        import hermes_cli.web_server as ws

        article_body = "# 测试文章\n\n## 第一节\nterm 在这里不是目标。\n\n## 第二节\n这里的 term 才是用户选中的目标。"
        selected_start = article_body.rfind("term")
        body = ws._KnowledgeLibrarySelectionChatBody(
            question="这是什么意思",
            selected_text="term",
            selection_start=selected_start,
            selection_end=selected_start + len("term"),
            selection_confidence="offset",
        )

        messages = ws._knowledge_selection_chat_messages(
            {
                "title": "测试文章",
                "kind": "capture",
                "folder_path": "Inbox",
                "summary": "",
                "tags": [],
                "body": article_body,
            },
            body,
        )

        assert "标题路径：测试文章 > 第二节" in messages[1]["content"]

    def test_knowledge_library_selection_chat_streams_progress_before_final_answer(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE capture_drafts (
               id TEXT PRIMARY KEY,
               raw_text TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL DEFAULT '',
               source_type TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               word_count INTEGER NOT NULL DEFAULT 0,
               draft_text TEXT NOT NULL DEFAULT '',
               instruction TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'draft_ready',
               committed_capture_id TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               capture_intent TEXT NOT NULL DEFAULT '{}'
            )"""
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, raw_text, title, word_count, draft_text, summary, tags, status, capture_intent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-stream-1",
                "原文",
                "测试文章",
                2,
                "# 测试文章\n\nCoding agent",
                "摘要",
                '["test"]',
                "draft_ready",
                '{"folder_path":"Inbox"}',
            ),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        if str(custom_root) not in sys.path:
            sys.path.insert(0, str(custom_root))

        fake_bridge = types.ModuleType("bridge")
        fake_bridge.__path__ = []
        research_bridge = types.ModuleType("bridge.research_bridge")
        monkeypatch.setitem(sys.modules, "bridge", fake_bridge)
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", research_bridge)

        async def fake_async_web_assist_answer(**kwargs):
            event_callback = kwargs.get("event_callback")
            assert event_callback is not None
            await event_callback(
                {
                    "type": "plan",
                    "plan_status": "planned_web_forced_by_mode",
                    "needs_web": True,
                    "queries": ["what is a coding agent"],
                }
            )
            await event_callback(
                {
                    "type": "web_query_done",
                    "query": "what is a coding agent",
                    "result_count": 1,
                    "web_sources": [
                        {
                            "ref": "W1",
                            "title": "What Is an AI Coding Agent?",
                            "url": "https://example.com/coding-agent",
                        }
                    ],
                }
            )
            await event_callback({"type": "answer_delta", "delta": "Coding agent"})
            await event_callback({"type": "answer_delta", "delta": " 是"})
            await event_callback(
                {
                    "type": "summary_updated",
                    "updated_history_summary": "已讨论 coding agent。",
                    "updated_history_summary_version": 2,
                }
            )
            return {
                "status": "success",
                "chat_preview": "Coding agent 是能自主完成软件工程任务的 AI 系统 [W1]",
                "warnings": [],
                "meta": {
                    "mode": kwargs["mode"],
                    "knowledge_sources": [],
                    "web_sources": [
                        {
                            "ref": "W1",
                            "type": "web",
                            "id": "https://example.com/coding-agent",
                            "title": "What Is an AI Coding Agent?",
                            "url": "https://example.com/coding-agent",
                            "excerpt": "AI coding agents plan and complete software tasks.",
                        }
                    ],
                    "research_trace": {
                        "plan_status": "planned_web_forced_by_mode",
                        "web_search_attempted": True,
                        "web_queries": ["what is a coding agent"],
                    },
                },
            }

        monkeypatch.setattr(research_bridge, "async_web_assist_answer", fake_async_web_assist_answer, raising=False)

        resp = self.client.post(
            "/api/knowledge/library/items/capture_draft/draft-stream-1/selection-chat/stream",
            json={
                "question": "什么是 coding agent",
                "selected_text": "Coding agent",
                "mode": "web_only",
            },
        )

        assert resp.status_code == 200
        events = [
            json.loads(line.removeprefix("data: "))
            for line in resp.text.splitlines()
            if line.startswith("data: ")
        ]
        assert [event["event"] for event in events[:7]] == [
            "start",
            "progress",
            "progress",
            "progress",
            "progress",
            "summary_updated",
            "complete",
        ]
        assert events[1]["type"] == "plan"
        assert events[2]["web_sources"][0]["title"] == "What Is an AI Coding Agent?"
        assert events[3] == {"event": "progress", "type": "answer_delta", "delta": "Coding agent"}
        assert events[4] == {"event": "progress", "type": "answer_delta", "delta": " 是"}
        assert events[5]["updated_history_summary"] == "已讨论 coding agent。"
        assert events[5]["updated_history_summary_version"] == 2
        assert events[-1]["response"]["answer"].startswith("Coding agent 是")
        assert events[-1]["response"]["sources"]["web"][0]["ref"] == "W1"

    def test_knowledge_library_selection_chat_stream_times_out_stuck_research(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as web_server

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE capture_drafts (
               id TEXT PRIMARY KEY,
               raw_text TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL DEFAULT '',
               source_type TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               word_count INTEGER NOT NULL DEFAULT 0,
               draft_text TEXT NOT NULL DEFAULT '',
               instruction TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'draft_ready',
               committed_capture_id TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               capture_intent TEXT NOT NULL DEFAULT '{}'
            )"""
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, raw_text, title, word_count, draft_text, summary, tags, status, capture_intent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-timeout-1",
                "原文",
                "测试文章",
                2,
                "# 测试文章\n\nvibecoder",
                "摘要",
                '["test"]',
                "draft_ready",
                '{"folder_path":"Inbox"}',
            ),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        async def fake_async_web_assist_answer(**_kwargs):
            await asyncio.sleep(1.0)
            return {"status": "success", "chat_preview": "too late", "warnings": [], "meta": {}}

        fake_module = types.ModuleType("bridge.research_bridge")
        fake_module.async_web_assist_answer = fake_async_web_assist_answer
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", fake_module)
        monkeypatch.setattr(web_server, "KNOWLEDGE_SELECTION_CHAT_STREAM_TIMEOUT_SECONDS", 0.05, raising=False)

        resp = self.client.post(
            "/api/knowledge/library/items/capture_draft/draft-timeout-1/selection-chat/stream",
            json={
                "question": "这是什么意思",
                "selected_text": "vibecoder",
                "mode": "local_web",
            },
        )

        assert resp.status_code == 200
        events = [
            json.loads(line.removeprefix("data: "))
            for line in resp.text.splitlines()
            if line.startswith("data: ")
        ]
        assert events[0] == {"event": "start", "mode": "local_web"}
        assert events[-1]["event"] == "error"
        assert "超时" in events[-1]["message"]

    def test_knowledge_editable_capture_draft_api_delegates_to_bridge(self, monkeypatch, tmp_path):
        custom_root = tmp_path / "hermes-custom"
        custom_root.mkdir()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        calls = {}

        bridge_pkg = types.ModuleType("bridge")
        bridge_pkg.__path__ = []
        capture_bridge = types.ModuleType("bridge.capture_bridge")

        def create_editable_capture_draft(**kwargs):
            calls["create"] = kwargs
            return {
                "status": "success",
                "intent": "create_editable_capture_draft",
                "meta": {"draft_id": "draft-editable", "title": "AI 标题"},
            }

        capture_bridge.create_editable_capture_draft = create_editable_capture_draft
        monkeypatch.setitem(sys.modules, "bridge", bridge_pkg)
        monkeypatch.setitem(sys.modules, "bridge.capture_bridge", capture_bridge)

        resp = self.client.post(
            "/api/knowledge/capture-drafts/editable",
            json={
                "content": "自由粘贴正文",
                "source": "微信公众号",
                "source_type": "manual",
                "instruction": "保留例子",
                "title": "用户标题",
            },
        )

        assert resp.status_code == 200
        assert resp.json()["meta"]["draft_id"] == "draft-editable"
        assert calls["create"] == {
            "content": "自由粘贴正文",
            "source": "微信公众号",
            "source_type": "manual",
            "instruction": "保留例子",
            "title": "用户标题",
            "title_source": "",
            "organize": True,
            "existing_folders": ["Inbox", "AI 产品", "数据 Agent", "待读", "临时"],
        }

    def test_knowledge_ai_operation_header_and_cancel_endpoint(self, monkeypatch, tmp_path):
        custom_root = tmp_path / "hermes-custom"
        custom_root.mkdir()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        bridge_pkg = types.ModuleType("bridge")
        bridge_pkg.__path__ = []
        ai_cancel = types.ModuleType("bridge.ai_cancel")
        capture_bridge = types.ModuleType("bridge.capture_bridge")
        state = {"current": "", "cancelled": set()}
        calls = {}

        class AIOperationCancelled(RuntimeError):
            def __init__(self, operation_id: str, stage: str = ""):
                super().__init__(f"cancelled {operation_id} {stage}")
                self.operation_id = operation_id
                self.stage = stage

        class operation_context:
            def __init__(self, operation_id: str):
                self.operation_id = operation_id
                self.previous = ""

            def __enter__(self):
                self.previous = state["current"]
                state["current"] = self.operation_id
                return self.operation_id

            def __exit__(self, *_exc):
                state["current"] = self.previous
                return False

        def normalize_operation_id(operation_id):
            return str(operation_id or "").strip()

        def cancel_operation(operation_id):
            state["cancelled"].add(normalize_operation_id(operation_id))
            return True

        def raise_if_cancelled(stage=""):
            if state["current"] in state["cancelled"]:
                raise AIOperationCancelled(state["current"], stage)

        ai_cancel.AIOperationCancelled = AIOperationCancelled
        ai_cancel.operation_context = operation_context
        ai_cancel.normalize_operation_id = normalize_operation_id
        ai_cancel.cancel_operation = cancel_operation
        ai_cancel.raise_if_cancelled = raise_if_cancelled

        def create_editable_capture_draft(**kwargs):
            calls["operation_id"] = state["current"]
            calls["create"] = kwargs
            return {
                "status": "success",
                "intent": "create_editable_capture_draft",
                "meta": {"draft_id": "draft-editable"},
            }

        capture_bridge.create_editable_capture_draft = create_editable_capture_draft
        monkeypatch.setitem(sys.modules, "bridge", bridge_pkg)
        monkeypatch.setitem(sys.modules, "bridge.ai_cancel", ai_cancel)
        monkeypatch.setitem(sys.modules, "bridge.capture_bridge", capture_bridge)

        cancel_resp = self.client.post("/api/knowledge/ai-operations/op-create/cancel")
        assert cancel_resp.status_code == 200
        assert cancel_resp.json()["status"] == "cancel_requested"
        assert "op-create" in state["cancelled"]

        resp = self.client.post(
            "/api/knowledge/capture-drafts/editable",
            headers={"X-Hermes-AI-Operation-Id": "op-create-2"},
            json={"content": "自由粘贴正文", "title": "用户标题"},
        )

        assert resp.status_code == 200
        assert resp.json()["meta"]["draft_id"] == "draft-editable"
        assert calls["operation_id"] == "op-create-2"

    def test_knowledge_editable_capture_draft_update_api_delegates_to_bridge(self, monkeypatch, tmp_path):
        custom_root = tmp_path / "hermes-custom"
        custom_root.mkdir()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        calls = {}

        bridge_pkg = types.ModuleType("bridge")
        bridge_pkg.__path__ = []
        capture_bridge = types.ModuleType("bridge.capture_bridge")

        def update_editable_capture_draft(**kwargs):
            calls["update"] = kwargs
            return {
                "status": "success",
                "intent": "update_editable_capture_draft",
                "meta": {"draft_id": "draft-editable", "title": "用户标题"},
            }

        capture_bridge.update_editable_capture_draft = update_editable_capture_draft
        monkeypatch.setitem(sys.modules, "bridge", bridge_pkg)
        monkeypatch.setitem(sys.modules, "bridge.capture_bridge", capture_bridge)

        resp = self.client.patch(
            "/api/knowledge/capture-drafts/draft-editable/editable",
            json={"content": "用户编辑后的正文", "title": "用户标题"},
        )

        assert resp.status_code == 200
        assert resp.json()["intent"] == "update_editable_capture_draft"
        assert calls["update"] == {
            "draft_id": "draft-editable",
            "content": "用户编辑后的正文",
            "title": "用户标题",
            "title_source": "",
            "summary": None,
            "tags": None,
            "folder_path": "",
            "folder_suggestion": None,
            "card_suggestion": None,
            "organize": True,
            "existing_folders": ["Inbox", "AI 产品", "数据 Agent", "待读", "临时"],
        }

    def test_knowledge_editable_capture_draft_missing_dependency_returns_guidance(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as web_server

        custom_root = tmp_path / "hermes-custom"
        custom_root.mkdir()
        (custom_root / "requirements.txt").write_text("numpy==2.4.6\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        original_import_module = web_server.importlib.import_module

        def fake_import_module(name, package=None):
            if name == "bridge.capture_bridge":
                raise ModuleNotFoundError("No module named 'numpy'", name="numpy")
            return original_import_module(name, package)

        monkeypatch.setattr(web_server.importlib, "import_module", fake_import_module)

        resp = self.client.post(
            "/api/knowledge/capture-drafts/editable",
            json={"content": "自由粘贴正文", "title": "用户标题"},
        )

        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["reason"] == "missing_dependency"
        assert detail["module"] == "bridge.capture_bridge"
        assert detail["missing_module"] == "numpy"
        assert str(custom_root / "requirements.txt") in detail["install_command"]

    def test_knowledge_runtime_check_reports_custom_bridge_dependency_state(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as web_server

        custom_root = tmp_path / "hermes-custom"
        custom_root.mkdir()
        (custom_root / "requirements.txt").write_text("numpy==2.4.6\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        def fake_import_module(name, package=None):
            if name == "bridge.answer_bridge":
                raise ModuleNotFoundError("No module named 'numpy'", name="numpy")
            return types.SimpleNamespace()

        monkeypatch.setattr(web_server.importlib, "import_module", fake_import_module)

        resp = self.client.get("/api/knowledge/runtime-check")

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        failed = [item for item in data["checks"] if item["module"] == "bridge.answer_bridge"][0]
        assert failed["ok"] is False
        assert failed["status_code"] == 503
        assert failed["detail"]["missing_module"] == "numpy"

    def test_knowledge_capture_update_backs_up_and_runs_library(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        vault.mkdir()
        db_path = data_dir / "captures.db"
        sqlite3.connect(db_path).close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setattr("hermes_cli.web_server._knowledge_vault_path", lambda: vault)
        calls = {}

        agents_pkg = types.ModuleType("agents")
        markdown_writer = types.ModuleType("agents.markdown_writer")
        bridge_pkg = types.ModuleType("bridge")
        write_service_mod = types.ModuleType("bridge.knowledge_write_service")
        db_pkg = types.ModuleType("db")
        repo_mod = types.ModuleType("db.repo")
        api_pkg = types.ModuleType("api")
        routes_pkg = types.ModuleType("api.routes")
        captures_mod = types.ModuleType("api.routes.captures")
        agents_pkg.__path__ = []
        bridge_pkg.__path__ = []
        db_pkg.__path__ = []
        api_pkg.__path__ = []
        routes_pkg.__path__ = []

        markdown_writer.read_note = lambda vault_path, file_path: ({"title": "旧标题"}, "旧正文")

        class FakeMarkdownWriteRequest:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class FakeKnowledgeWriteService:
            def __init__(self, vault_path):
                self.vault_path = vault_path

            def write_markdown_artifact(self, request):
                calls["write"] = {
                    "vault_path": self.vault_path,
                    "request": request.kwargs,
                }
                return types.SimpleNamespace(backup_path="backups/cap-1.md")

        class FakeCaptureRepo:
            def __init__(self, conn):
                self.conn = conn

            def get_by_id(self, capture_id):
                calls.setdefault("get_by_id", []).append(capture_id)
                return {"id": capture_id, "file_path": "captures/cap-1.md"}

            def log_change(self, *args, **kwargs):
                calls["log_change"] = {"args": args, "kwargs": kwargs}

        def fake_render_markdown(frontmatter, body):
            calls["render"] = {"frontmatter": dict(frontmatter), "body": body}
            return f"---\ntitle: {frontmatter.get('title')}\n---\n\n{body}"

        def fake_maintain_capture_after_edit(repo, vault_path, capture_id, config):
            calls["maintain"] = {
                "vault_path": vault_path,
                "capture_id": capture_id,
                "config": config,
            }
            return {"status": "ok"}

        captures_mod._render_markdown = fake_render_markdown
        captures_mod._maintain_capture_after_edit = fake_maintain_capture_after_edit
        captures_mod._hydrate_capture = lambda vault_path, row: {"id": row["id"], "title": "用户标题"}
        captures_mod._strip_binary = lambda item: item
        write_service_mod.KnowledgeWriteService = FakeKnowledgeWriteService
        write_service_mod.MarkdownWriteRequest = FakeMarkdownWriteRequest
        repo_mod.CaptureRepo = FakeCaptureRepo

        monkeypatch.setitem(sys.modules, "agents", agents_pkg)
        monkeypatch.setitem(sys.modules, "agents.markdown_writer", markdown_writer)
        monkeypatch.setitem(sys.modules, "bridge", bridge_pkg)
        monkeypatch.setitem(sys.modules, "bridge.knowledge_write_service", write_service_mod)
        monkeypatch.setitem(sys.modules, "db", db_pkg)
        monkeypatch.setitem(sys.modules, "db.repo", repo_mod)
        monkeypatch.setitem(sys.modules, "api", api_pkg)
        monkeypatch.setitem(sys.modules, "api.routes", routes_pkg)
        monkeypatch.setitem(sys.modules, "api.routes.captures", captures_mod)

        resp = self.client.patch(
            "/api/knowledge/captures/cap-1",
            json={"body": "用户修改后的正文", "title": "用户标题"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["backup_path"] == "backups/cap-1.md"
        assert data["library_postprocess"] == {"status": "ok"}
        assert calls["render"]["frontmatter"]["title"] == "用户标题"
        assert calls["render"]["frontmatter"]["title_source"] == "user"
        assert calls["render"]["frontmatter"]["word_count"] == len("用户修改后的正文")
        assert calls["render"]["body"] == "用户修改后的正文"
        assert calls["write"]["request"]["requires_backup"] is True
        assert calls["maintain"]["capture_id"] == "cap-1"

    def test_committed_capture_draft_detail_reads_capture_note_body(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "captures").mkdir(parents=True)
        (vault / "captures" / "cap-1.md").write_text(
            "---\ntitle: 入库标题\nword_count: 12\n---\n\n真实入库正文",
            encoding="utf-8",
        )
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT '',
                raw_text TEXT NOT NULL DEFAULT '',
                draft_text TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                instruction TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                capture_intent TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, raw_path) VALUES (?, ?, ?)",
            ("cap-1", "captures/cap-1.md", ""),
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, title, status, committed_capture_id, raw_text, draft_text)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("draft-1", "历史草稿标题", "committed", "cap-1", "原文", "过期历史草稿正文"),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.get("/api/knowledge/capture-drafts/draft-1")

        assert response.status_code == 200
        draft = response.json()["draft"]
        assert draft["draft_text"] == "真实入库正文"
        assert draft["title"] == "入库标题"
        assert draft["historical_draft_text"] == "过期历史草稿正文"

    def test_revise_knowledge_capture_returns_preview_without_writing(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as web_server
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        vault.mkdir(parents=True)
        sqlite3.connect(data_dir / "captures.db").close()
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setattr("hermes_cli.web_server._knowledge_vault_path", lambda: vault)
        calls = {}

        agents_pkg = types.ModuleType("agents")
        markdown_writer = types.ModuleType("agents.markdown_writer")
        db_pkg = types.ModuleType("db")
        repo_mod = types.ModuleType("db.repo")
        agents_pkg.__path__ = []
        db_pkg.__path__ = []

        def fake_read_note(vault_path, file_path):
            if file_path == "captures/cap-1.md":
                return ({"title": "旧标题", "tags": ["old"], "story": "旧摘要"}, "当前笔记正文")
            if file_path == "_archive/raw/cap-1.md":
                return ({}, "原始全文材料")
            return None

        class FakeCaptureRepo:
            def __init__(self, conn):
                self.conn = conn

            def get_by_id(self, capture_id):
                return {
                    "id": capture_id,
                    "file_path": "captures/cap-1.md",
                    "raw_path": "_archive/raw/cap-1.md",
                }

            def log_change(self, *args, **kwargs):
                calls["log_change"] = True

        class FakeSummarizer:
            def summarize(self, text, existing_tags=None):
                calls["summarize_text"] = text
                return {"title": "AI 标题", "summary": "AI 摘要", "tags": ["ai"]}

        class FakeLLMResult:
            incomplete = False

            def __init__(self, text):
                self.text = text

        class FakeCaptureAgent:
            def __init__(self):
                self.summarizer = FakeSummarizer()

            def _call_llm(self, prompt):
                calls["prompt"] = prompt
                return FakeLLMResult("AI 修订后的正文")

        markdown_writer.read_note = fake_read_note
        repo_mod.CaptureRepo = FakeCaptureRepo
        monkeypatch.setitem(sys.modules, "agents", agents_pkg)
        monkeypatch.setitem(sys.modules, "agents.markdown_writer", markdown_writer)
        monkeypatch.setitem(sys.modules, "db", db_pkg)
        monkeypatch.setitem(sys.modules, "db.repo", repo_mod)
        monkeypatch.setattr(web_server, "_new_capture_agent", lambda: FakeCaptureAgent(), raising=False)

        response = self.client.post(
            "/api/knowledge/captures/cap-1/revise",
            json={"instruction": "保留全部信息并重新分段"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert data["capture_id"] == "cap-1"
        assert data["body"] == "AI 修订后的正文"
        assert data["title"] == "AI 标题"
        assert data["summary"] == "AI 摘要"
        assert data["tags"] == ["ai"]
        assert data["source"] == "ai_revision"
        assert "当前笔记正文" in calls["prompt"]
        assert "原始全文材料" in calls["prompt"]
        assert "保留全部信息并重新分段" in calls["prompt"]
        assert "log_change" not in calls

    def test_knowledge_library_capture_delete_archives_and_reports_dependencies(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text(
            "---\n"
            "title: 入库文件\n"
            "folder_path: Inbox\n"
            "---\n\n"
            "正文",
            encoding="utf-8",
        )
        (vault / "notes" / "ref.md").write_text(
            "这里引用 cap-1 和 notes/cap-1。",
            encoding="utf-8",
        )
        config = custom_root / "config.yaml"
        config.write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                embedding BLOB
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT '',
                raw_text TEXT NOT NULL DEFAULT '',
                draft_text TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                instruction TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                capture_intent TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE agent_run_objects (
                run_id TEXT NOT NULL,
                object_id TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "captured", "2026-06-19T00:00:00+00:00", "2026-06-19T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO garden_cards (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("card-1", "卡片", "active", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO garden_drafts (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("garden-draft-1", "卡片草稿", "open", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO capture_drafts (id, title, status, committed_capture_id) VALUES (?, ?, ?, ?)",
            ("draft-1", "历史草稿", "committed", "cap-1"),
        )
        conn.execute(
            "INSERT INTO garden_cards (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("card-archived", "已归档卡片", "archived", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO garden_drafts (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("garden-draft-committed", "已提交卡片草稿", "committed", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO agent_run_objects (run_id, object_id) VALUES (?, ?)",
            ("run-1", "cap-1"),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        preview_resp = self.client.get("/api/knowledge/library/items/capture/cap-1/dependencies")
        delete_resp = self.client.delete("/api/knowledge/library/items/capture/cap-1")

        assert preview_resp.status_code == 200
        preview = preview_resp.json()["dependencies"]
        assert len(preview["garden_cards"]) == 1
        assert len(preview["garden_drafts"]) == 1
        assert len(preview["committed_drafts"]) == 1
        assert len(preview["backlinks"]) == 1
        assert preview["event_count"] == 1
        assert preview["policy"]["action"] == "archive_capture_only"

        assert delete_resp.status_code == 200
        data = delete_resp.json()
        assert data["status"] == "archived"
        assert data["dependencies"]["garden_cards"][0]["id"] == "card-1"
        conn = sqlite3.connect(db_path)
        review_state = conn.execute("SELECT review_state FROM captures WHERE id = ?", ("cap-1",)).fetchone()[0]
        card_count = conn.execute("SELECT COUNT(*) FROM garden_cards WHERE id = ?", ("card-1",)).fetchone()[0]
        conn.close()
        assert review_state == "archived"
        assert card_count == 1

    def test_knowledge_library_capture_permanent_delete_rejects_referenced_capture(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text("# 入库文件\n", encoding="utf-8")
        (vault / "notes" / "ref.md").write_text("这里引用 cap-1。", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state) VALUES (?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "captured"),
        )
        conn.execute(
            "INSERT INTO garden_cards (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("card-1", "卡片", "active", json.dumps(["cap-1"])),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert response.status_code == 409
        data = response.json()
        assert "dependencies" in data["detail"]
        assert data["detail"]["dependencies"]["garden_cards"][0]["id"] == "card-1"
        assert (vault / "notes" / "cap-1.md").exists()
        conn = sqlite3.connect(db_path)
        assert conn.execute("SELECT COUNT(*) FROM captures WHERE id = 'cap-1'").fetchone()[0] == 1
        conn.close()

    def test_knowledge_library_capture_permanent_delete_allows_history_and_run_records(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text("# 入库文件\n", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE agent_run_objects (
                run_id TEXT NOT NULL,
                object_id TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state) VALUES (?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "captured"),
        )
        conn.execute(
            "INSERT INTO capture_drafts (id, title, status, committed_capture_id) VALUES (?, ?, ?, ?)",
            ("draft-1", "历史草稿", "committed", "cap-1"),
        )
        conn.execute(
            "INSERT INTO garden_cards (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("card-archived", "已归档卡片", "archived", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO garden_drafts (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("garden-draft-committed", "已提交卡片草稿", "committed", json.dumps(["cap-1"])),
        )
        conn.execute(
            "INSERT INTO agent_run_objects (run_id, object_id) VALUES (?, ?)",
            ("run-1", "cap-1"),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert response.status_code == 200
        assert not (vault / "notes" / "cap-1.md").exists()
        conn = sqlite3.connect(db_path)
        assert conn.execute("SELECT COUNT(*) FROM captures WHERE id = 'cap-1'").fetchone()[0] == 0
        assert conn.execute("SELECT committed_capture_id FROM capture_drafts WHERE id = 'draft-1'").fetchone()[0] == ""
        assert conn.execute("SELECT status FROM capture_drafts WHERE id = 'draft-1'").fetchone()[0] == "abandoned"
        assert conn.execute("SELECT COUNT(*) FROM agent_run_objects WHERE object_id = 'cap-1'").fetchone()[0] == 0
        assert conn.execute("SELECT status FROM garden_cards WHERE id = 'card-archived'").fetchone()[0] == "archived"
        assert conn.execute("SELECT status FROM garden_drafts WHERE id = 'garden-draft-committed'").fetchone()[0] == "committed"
        conn.close()

    @pytest.mark.parametrize("draft_status", ["draft_ready", "revision_requested", "open"])
    def test_knowledge_library_capture_permanent_delete_rejects_active_garden_draft(self, monkeypatch, tmp_path, draft_status):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text("# 入库文件\n", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state) VALUES (?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "captured"),
        )
        conn.execute(
            "INSERT INTO garden_drafts (id, title, status, capture_ids) VALUES (?, ?, ?, ?)",
            ("garden-draft-1", "待提交卡片草稿", draft_status, json.dumps(["cap-1"])),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert response.status_code == 409
        data = response.json()
        assert data["detail"]["dependencies"]["garden_drafts"][0]["id"] == "garden-draft-1"
        assert data["detail"]["dependencies"]["garden_drafts"][0]["status"] == draft_status
        assert (vault / "notes" / "cap-1.md").exists()

    def test_knowledge_library_capture_permanent_delete_removes_isolated_capture_and_files(self, monkeypatch, tmp_path):
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "_archive" / "raw").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text("# 入库文件\n", encoding="utf-8")
        (vault / "_archive" / "raw" / "cap-1.md").write_text("raw", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE capture_embeddings (
                id TEXT PRIMARY KEY,
                capture_id TEXT NOT NULL
            );
            CREATE TABLE capture_metadata (
                capture_id TEXT PRIMARY KEY,
                outline_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE review_items (
                id TEXT PRIMARY KEY,
                capture_id TEXT NOT NULL DEFAULT '',
                object_type TEXT NOT NULL DEFAULT 'capture',
                object_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE capture_version_backups (
                id TEXT PRIMARY KEY,
                capture_id TEXT NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, raw_path, review_state) VALUES (?, ?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "_archive/raw/cap-1.md", "captured"),
        )
        conn.execute("INSERT INTO capture_embeddings (id, capture_id) VALUES (?, ?)", ("emb-1", "cap-1"))
        conn.execute("INSERT INTO capture_metadata (capture_id, outline_json) VALUES (?, ?)", ("cap-1", "[]"))
        conn.execute("INSERT INTO review_items (id, capture_id, object_type, object_id) VALUES (?, ?, ?, ?)", ("ri-1", "cap-1", "capture", "cap-1"))
        conn.execute("INSERT INTO capture_version_backups (id, capture_id) VALUES (?, ?)", ("backup-1", "cap-1"))
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "permanently_deleted"
        assert data["deleted"]["knowledge_file"] == "notes/cap-1.md"
        assert data["deleted"]["raw_file"] == "_archive/raw/cap-1.md"
        assert not (vault / "notes" / "cap-1.md").exists()
        assert not (vault / "_archive" / "raw" / "cap-1.md").exists()
        conn = sqlite3.connect(db_path)
        for table, column in [
            ("captures", "id"),
            ("capture_embeddings", "capture_id"),
            ("capture_metadata", "capture_id"),
            ("review_items", "capture_id"),
            ("capture_version_backups", "capture_id"),
        ]:
            assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = 'cap-1'").fetchone()[0] == 0
        conn.close()

    def test_knowledge_library_capture_permanent_delete_legacy_review_items_schema(self, monkeypatch, tmp_path):
        """Legacy two-column ``review_items`` must not 500 the permanent delete.

        Old vaults only have ``review_items(id, capture_id)``, which misses the
        modern (capture_id, object_type, object_id) tuple, so deletion falls
        back to the column-delete helper — which must accept the table.
        """
        import sqlite3

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "_archive" / "raw").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text("# 入库文件\n", encoding="utf-8")
        (vault / "_archive" / "raw" / "cap-1.md").write_text("raw", encoding="utf-8")
        (custom_root / "config.yaml").write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE garden_cards (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE garden_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                capture_ids TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                committed_capture_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE review_items (
                id TEXT PRIMARY KEY,
                capture_id TEXT NOT NULL DEFAULT ''
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, raw_path, review_state) VALUES (?, ?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "_archive/raw/cap-1.md", "captured"),
        )
        conn.execute("INSERT INTO review_items (id, capture_id) VALUES (?, ?)", ("ri-legacy", "cap-1"))
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))

        response = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert response.status_code == 200
        assert response.json()["status"] == "permanently_deleted"
        assert not (vault / "notes" / "cap-1.md").exists()
        conn = sqlite3.connect(db_path)
        assert conn.execute("SELECT COUNT(*) FROM review_items WHERE capture_id = 'cap-1'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM captures WHERE id = 'cap-1'").fetchone()[0] == 0
        conn.close()

    def test_permanent_delete_maps_service_not_found_to_404(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            error=knowledge_client.KnowledgeNotFound(
                "gone", status_code=404, detail={"message": "missing in service"}
            )
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 404
        assert resp.json()["detail"] == {"message": "missing in service"}
        assert fake.closed is True

    def test_permanent_delete_maps_service_conflict_to_409(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        conflict_detail = {
            "detail": "still referenced",
            "dependencies": {"garden_cards": [{"id": "gc-1"}]},
        }
        fake = _FakeKnowledgeServiceClient(
            error=knowledge_client.KnowledgeConflict(
                "conflict", status_code=409, detail=conflict_detail
            )
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 409
        assert resp.json()["detail"] == conflict_detail
        assert fake.closed is True

    def test_permanent_delete_maps_service_failure_to_502(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            error=knowledge_client.KnowledgeUnavailable("upstream down")
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 502
        assert "upstream down" in resp.json()["detail"]
        assert fake.closed is True

    def test_permanent_delete_reports_misconfigured_service_as_503(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        def _misconfigured(transport=None):
            raise knowledge_client.KnowledgeUnavailable(
                "HERMES_KNOWLEDGE_TIMEOUT must be a number of seconds"
            )

        monkeypatch.setattr(knowledge_client, "get_client", _misconfigured)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 503
        assert "not configured correctly" in resp.json()["detail"]

    def test_permanent_delete_reports_contract_incompatible_preflight_as_503(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        def _incompatible(transport=None):
            raise knowledge_client.KnowledgeIncompatible(
                "knowledge contract v0 < required v1"
            )

        monkeypatch.setattr(knowledge_client, "get_client", _incompatible)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["code"] == "contract_incompatible"
        assert "incompatible" in detail["message"]

    def test_permanent_delete_reports_contract_incompatible_from_service_as_503(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            error=knowledge_client.KnowledgeIncompatible(
                "knowledge contract v0 < required v1"
            )
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "contract_incompatible"
        assert fake.closed is True

    def test_permanent_delete_uses_service_token_and_closes_client(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            result={"ok": True, "status": "permanently_deleted"},
            issued={"confirmation_token": "ctok"},
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.delete("/api/knowledge/library/items/capture/cap-1/permanent")

        assert resp.status_code == 200
        assert resp.json()["status"] == "permanently_deleted"
        assert fake.delete_calls == [("capture", "cap-1", "ctok")]
        assert fake.closed is True

    def test_capture_patch_delegates_to_the_knowledge_service(self, monkeypatch):
        """HTTP mode: the service writes the note, not the dashboard process."""
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            update_result={
                "capture_id": "cap-1",
                "file_path": "notes/cap-1.md",
                "library_postprocess": {"status": "queued"},
                "item": {"id": "cap-1", "title": "changed"},
            }
        )
        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

        resp = self.client.patch(
            "/api/knowledge/captures/cap-1",
            json={"body": "new body", "title": "changed", "folder_path": "Inbox"},
        )

        assert resp.status_code == 200
        assert resp.json()["item"]["title"] == "changed"
        assert fake.update_calls == [
            {
                "capture_id": "cap-1",
                "body": "new body",
                "title": "changed",
                "folder_path": "Inbox",
            }
        ]
        assert fake.closed is True

    def test_capture_patch_maps_service_errors(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        cases = [
            (knowledge_client.KnowledgeNotFound("gone", status_code=404), 404),
            (knowledge_client.KnowledgeConflict("busy", status_code=409), 409),
            (knowledge_client.KnowledgeInvalid("bad", status_code=422), 422),
            (knowledge_client.KnowledgeUnavailable("down"), 502),
            (knowledge_client.KnowledgeIncompatible("v0 < v1"), 503),
        ]
        for error, expected in cases:
            fake = _FakeKnowledgeServiceClient(error=error)
            monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None, f=fake: f)

            resp = self.client.patch(
                "/api/knowledge/captures/cap-1", json={"body": "x"}
            )

            assert resp.status_code == expected, (type(error).__name__, resp.status_code)
            assert fake.closed is True

    # ── HTTP-mode delegation: library items / folders / drafts ──────────────

    def _patch_knowledge_client(self, monkeypatch, fake):
        import integrations.hermes_knowledge.client as knowledge_client

        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: fake)

    def test_library_folders_get_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "list_library_folders": {
                    "folders": [{"path": "Inbox", "name": "Inbox", "count": 3}],
                    "smart_views": [{"key": "recent", "label": "最近入库", "count": 3}],
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.get("/api/knowledge/library/folders")

        assert resp.status_code == 200
        assert resp.json()["folders"][0]["path"] == "Inbox"
        assert [call["method"] for call in fake.calls] == ["list_library_folders"]
        assert fake.closed is True

    def test_library_folder_create_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "create_library_folder": {
                    "ok": True,
                    "folder": {"path": "新目录", "name": "新目录", "count": 0},
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.post("/api/knowledge/library/folders", json={"name": "新目录"})

        assert resp.status_code == 200
        assert resp.json()["folder"]["path"] == "新目录"
        assert fake.calls == [
            {"method": "create_library_folder", "args": ("新目录",), "kwargs": {}}
        ]
        assert fake.closed is True

    def test_library_folder_rename_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "rename_library_folder": {
                    "ok": True,
                    "folders": [{"path": "New", "name": "New", "count": 1}],
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.patch("/api/knowledge/library/folders/Old", json={"name": "New"})

        assert resp.status_code == 200
        assert resp.json()["folders"][0]["path"] == "New"
        assert fake.calls == [
            {"method": "rename_library_folder", "args": ("Old", "New"), "kwargs": {}}
        ]
        assert fake.closed is True

    def test_library_item_create_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "create_library_item": {
                    "ok": True,
                    "draft_id": "d1",
                    "item": {"id": "d1"},
                    "result": {"status": "ok"},
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.post(
            "/api/knowledge/library/items",
            json={"title": "T", "body": "B", "folder_path": "AI 产品"},
        )

        assert resp.status_code == 200
        assert resp.json()["draft_id"] == "d1"
        call = fake.calls[0]
        assert call["method"] == "create_library_item"
        assert call["kwargs"] == {
            "body": "B",
            "title": "T",
            "source": "Hermes Knowledge Library",
            "source_type": "manual",
            "folder_path": "AI 产品",
        }
        assert fake.closed is True

    def test_library_item_patch_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "patch_library_item": {"ok": True, "item": {"id": "d1", "title": "T2"}}
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.patch(
            "/api/knowledge/library/items/capture_draft/d1",
            json={"title": "T2", "body": "B2", "folder_path": "Inbox", "tags": ["a"]},
        )

        assert resp.status_code == 200
        assert resp.json()["item"]["title"] == "T2"
        call = fake.calls[0]
        assert call["method"] == "patch_library_item"
        assert call["args"] == ("capture_draft", "d1")
        assert call["kwargs"]["title"] == "T2"
        assert call["kwargs"]["body"] == "B2"
        assert call["kwargs"]["folder_path"] == "Inbox"
        assert call["kwargs"]["tags"] == ["a"]
        assert fake.closed is True

    def test_library_item_delete_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"delete_library_item": {"ok": True, "status": "discarded"}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.delete("/api/knowledge/library/items/capture_draft/d1")

        assert resp.status_code == 200
        assert resp.json()["status"] == "discarded"
        assert fake.calls == [
            {
                "method": "delete_library_item",
                "args": ("capture_draft", "d1"),
                "kwargs": {},
            }
        ]
        assert fake.closed is True

    def test_editable_capture_draft_patch_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"patch_capture_draft": {"ok": True, "item": {"id": "d1"}}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.patch(
            "/api/knowledge/capture-drafts/d1/editable",
            json={
                "content": "新正文",
                "title": "T",
                "summary": "S",
                "tags": ["a", "b"],
                "folder_path": "AI 产品",
            },
        )

        assert resp.status_code == 200
        call = fake.calls[0]
        assert call["method"] == "patch_capture_draft"
        assert call["args"] == ("d1",)
        assert call["kwargs"] == {
            "title": "T",
            "draft_text": "新正文",
            "summary": "S",
            "tags": ["a", "b"],
            "capture_intent": {"folder_path": "AI 产品"},
        }
        assert fake.closed is True

    def test_capture_draft_delete_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"delete_capture_draft": {"ok": True, "status": "abandoned"}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.delete("/api/knowledge/capture-drafts/d1")

        assert resp.status_code == 200
        assert resp.json()["status"] == "abandoned"
        assert fake.calls == [
            {"method": "delete_capture_draft", "args": ("d1",), "kwargs": {}}
        ]
        assert fake.closed is True

    def test_reading_draft_delete_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"delete_reading_draft": {"ok": True, "status": "deleted"}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.delete("/api/knowledge/reading-drafts/d1")

        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
        assert fake.calls == [
            {"method": "delete_reading_draft", "args": ("d1",), "kwargs": {}}
        ]
        assert fake.closed is True

    def test_library_folders_error_mapping(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        cases = [
            (knowledge_client.KnowledgeNotFound("gone", status_code=404), 404),
            (knowledge_client.KnowledgeConflict("busy", status_code=409), 409),
            (knowledge_client.KnowledgeInvalid("bad", status_code=422), 422),
            (knowledge_client.KnowledgeUnavailable("down"), 502),
        ]
        for error, expected in cases:
            fake = _FakeKnowledgeServiceClient(error=error)
            self._patch_knowledge_client(monkeypatch, fake)

            resp = self.client.get("/api/knowledge/library/folders")

            assert resp.status_code == expected, (type(error).__name__, resp.status_code)
            assert fake.closed is True

    def test_capture_draft_delete_maps_contract_incompatible_to_503(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        fake = _FakeKnowledgeServiceClient(
            error=knowledge_client.KnowledgeIncompatible(
                "contract v0 < required v1"
            )
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.delete("/api/knowledge/capture-drafts/d1")

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "contract_incompatible"
        assert fake.closed is True

    def test_library_item_create_startup_failure_maps_to_503(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        def _unavailable(transport=None):
            raise knowledge_client.KnowledgeUnavailable(
                "HERMES_KNOWLEDGE_TIMEOUT must be a number of seconds"
            )

        monkeypatch.setattr(knowledge_client, "get_client", _unavailable)

        resp = self.client.post("/api/knowledge/library/items", json={"title": "T"})

        assert resp.status_code == 503
        assert "not configured correctly" in resp.json()["detail"]

    def test_http_mode_never_touches_local_knowledge_modules(self, monkeypatch):
        """HTTP mode must not import the local checkout or open local SQLite."""
        import hermes_cli.web_server as web_server

        fake = _FakeKnowledgeServiceClient(
            responses={"create_library_item": {"ok": True, "draft_id": "d1"}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        def _boom(*args, **kwargs):
            raise AssertionError(
                "local knowledge checkout must not be touched in HTTP mode"
            )

        monkeypatch.setattr(web_server, "_knowledge_custom_module", _boom)
        monkeypatch.setattr(web_server, "_knowledge_conn", _boom)
        monkeypatch.setattr(web_server, "_knowledge_vault_path", _boom)

        resp = self.client.post("/api/knowledge/library/items", json={"title": "T"})

        assert resp.status_code == 200
        assert fake.closed is True

    # ── HTTP-mode delegation: library reads / garden / cards / graph ────────

    def test_library_items_read_delegates_and_matches_local_shape(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "list_library_items": {
                    "items": [{"id": "cap-1", "kind": "capture"}],
                    "total": 1,
                    "counts": {"capture": 1, "capture_draft": 0, "all": 1},
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.get(
            "/api/knowledge/library/items",
            params={"folder": "AI 产品", "search": "日报", "limit": 50},
        )

        assert resp.status_code == 200
        payload = resp.json()
        # Same top-level shape as the local branch; the contract-only "counts"
        # block is not part of the dashboard response.
        assert set(payload) == {"items", "total"}
        assert payload["items"] == [{"id": "cap-1", "kind": "capture"}]
        assert payload["total"] == 1
        call = fake.calls[0]
        assert call["method"] == "list_library_items"
        assert call["kwargs"] == {
            "folder": "AI 产品",
            "view": "",
            "search": "日报",
            "limit": 50,
        }
        assert fake.closed is True

    def test_library_item_detail_delegates_and_matches_local_shape(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "get_library_item": {"ok": True, "item": {"id": "cap-1", "title": "T"}}
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.get("/api/knowledge/library/items/capture/cap-1")

        assert resp.status_code == 200
        assert set(resp.json()) == {"item"}
        assert resp.json()["item"]["title"] == "T"
        call = fake.calls[0]
        assert call["method"] == "get_library_item"
        assert call["args"] == ("capture", "cap-1")
        assert fake.closed is True

    def test_garden_draft_create_delegates_envelope(self, monkeypatch):
        envelope = {
            "status": "ok",
            "agent": "garden",
            "intent": "garden.synthesize",
            "chat_preview": "已生成卡片",
            "durable_artifacts": [{"type": "garden_card", "id": "k1"}],
            "meta": {},
        }
        fake = _FakeKnowledgeServiceClient(responses={"create_garden_draft": envelope})
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.post(
            "/api/knowledge/garden-drafts",
            json={
                "capture_ids": ["cap-1"],
                "title": "T",
                "card_kind": "viewpoint",
                "instruction": "I",
            },
        )

        assert resp.status_code == 200
        assert resp.json() == envelope
        call = fake.calls[0]
        assert call["method"] == "create_garden_draft"
        assert call["kwargs"] == {
            "capture_ids": ["cap-1"],
            "title": "T",
            "card_kind": "viewpoint",
            "instruction": "I",
        }
        assert fake.closed is True

    def test_cards_read_delegates_and_rebuilds_local_shape(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "list_garden_cards": {
                    "items": [
                        {"id": "k1", "kind": "viewpoint"},
                        {"id": "k2", "kind": "method"},
                        {"id": "k3", "kind": "viewpoint"},
                    ],
                    "total": 3,
                }
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.get("/api/knowledge/cards", params={"limit": 500})

        assert resp.status_code == 200
        payload = resp.json()
        # Same top-level shape as the local branch: {"cards", "groups", "total"}.
        assert set(payload) == {"cards", "groups", "total"}
        assert len(payload["cards"]) == 3
        assert payload["groups"] == {
            "viewpoint": 2,
            "method": 1,
            "fact": 0,
            "risk": 0,
        }
        assert payload["total"] == 3
        call = fake.calls[0]
        assert call["method"] == "list_garden_cards"
        # Local branch clamps the limit to 300 before reading.
        assert call["kwargs"] == {"limit": 300, "status": ""}
        assert fake.closed is True

    def test_card_delete_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={
                "delete_garden_card": {"ok": True, "status": "deleted", "id": "k1"}
            }
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.delete("/api/knowledge/cards/k1")

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "status": "deleted", "id": "k1"}
        assert fake.calls[0]["method"] == "delete_garden_card"
        assert fake.calls[0]["args"] == ("k1",)
        assert fake.closed is True

    def test_graph_read_delegates_with_query_parameters(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"graph": {"nodes": [{"id": "n1"}], "edges": []}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.get(
            "/api/knowledge/graph",
            params={
                "focus_kind": "capture",
                "focus_id": "cap-1",
                "depth": 2,
                "limit": 500,
            },
        )

        assert resp.status_code == 200
        assert resp.json() == {"nodes": [{"id": "n1"}], "edges": []}
        call = fake.calls[0]
        assert call["method"] == "graph"
        # Query parameters pass through; the local branch clamps limit to 120.
        assert call["kwargs"] == {
            "focus_kind": "capture",
            "focus_id": "cap-1",
            "depth": 2,
            "limit": 120,
        }
        assert fake.closed is True

    def test_graph_refresh_delegates_to_service(self, monkeypatch):
        fake = _FakeKnowledgeServiceClient(
            responses={"refresh_graph": {"ok": True, "nodes": 4, "edges": 6}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.post("/api/knowledge/graph/refresh")

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "nodes": 4, "edges": 6}
        assert fake.calls[0]["method"] == "refresh_graph"
        assert fake.closed is True

    def test_answer_draft_delegates_and_keeps_envelope(self, monkeypatch):
        envelope = {
            "status": "ok",
            "agent": "answer",
            "intent": "answer.create_draft",
            "chat_preview": "已保存",
            "durable_artifacts": [],
            "meta": {"draft_id": "r1"},
        }
        fake = _FakeKnowledgeServiceClient(responses={"create_answer_draft": envelope})
        self._patch_knowledge_client(monkeypatch, fake)

        resp = self.client.post(
            "/api/knowledge/answer-drafts",
            json={
                "assistant_answer": "answer",
                "user_message": "question",
                "output_type": "viewpoint",
            },
        )

        assert resp.status_code == 200
        assert resp.json() == envelope
        call = fake.calls[0]
        assert call["method"] == "create_answer_draft"
        payload = call["args"][0]
        assert payload["assistant_answer"] == "answer"
        assert payload["user_message"] == "question"
        assert payload["output_type"] == "viewpoint"
        assert fake.closed is True

    def test_library_read_error_mapping(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        cases = [
            (knowledge_client.KnowledgeNotFound("gone", status_code=404), 404),
            (knowledge_client.KnowledgeUnavailable("down"), 502),
        ]
        for error, expected in cases:
            fake = _FakeKnowledgeServiceClient(error=error)
            self._patch_knowledge_client(monkeypatch, fake)

            resp = self.client.get("/api/knowledge/library/items")

            assert resp.status_code == expected, (type(error).__name__, resp.status_code)
            assert fake.closed is True

    def test_garden_draft_error_mapping(self, monkeypatch):
        import integrations.hermes_knowledge.client as knowledge_client

        cases = [
            (knowledge_client.KnowledgeConflict("busy", status_code=409), 409),
            (knowledge_client.KnowledgeIncompatible("v0 < v1"), 503),
        ]
        for error, expected in cases:
            fake = _FakeKnowledgeServiceClient(error=error)
            self._patch_knowledge_client(monkeypatch, fake)

            resp = self.client.post(
                "/api/knowledge/garden-drafts", json={"capture_ids": ["cap-1"]}
            )

            assert resp.status_code == expected, (type(error).__name__, resp.status_code)
            assert fake.closed is True

    def test_http_mode_library_read_never_touches_local_modules(self, monkeypatch):
        import hermes_cli.web_server as web_server

        fake = _FakeKnowledgeServiceClient(
            responses={"list_library_items": {"items": [], "total": 0}}
        )
        self._patch_knowledge_client(monkeypatch, fake)

        def _boom(*args, **kwargs):
            raise AssertionError(
                "local knowledge checkout must not be touched in HTTP mode"
            )

        monkeypatch.setattr(web_server, "_knowledge_custom_module", _boom)
        monkeypatch.setattr(web_server, "_knowledge_conn", _boom)
        monkeypatch.setattr(web_server, "_knowledge_vault_path", _boom)

        resp = self.client.get("/api/knowledge/library/items")

        assert resp.status_code == 200
        assert resp.json() == {"items": [], "total": 0}
        assert fake.closed is True

    def test_automation_boundaries_degrades_without_knowledge_config(self, monkeypatch):
        """An unconfigured Knowledge feature must not 503 the whole inventory."""
        import hermes_cli.web_server as web_server

        for key in ("HERMES_KNOWLEDGE_URL", "HERMES_KNOWLEDGE_LOCAL_ROOT", "HERMES_CUSTOM_ROOT"):
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(web_server, "_read_launchagent_plist", lambda label: {})
        monkeypatch.setattr(web_server, "_launchagent_status", lambda label: ("not_loaded", None))

        resp = self.client.get("/api/knowledge/automation-boundaries")

        assert resp.status_code == 200
        items = {item["id"]: item for item in resp.json()["items"]}
        # Non-knowledge automation data still reports normally.
        assert "gateway_ticker:cron" in items
        assert items["gateway_ticker:cron"]["enabled"] is False
        # Knowledge-specific items degrade to empty paths instead of failing.
        watcher = items["watcher:watch_vault"]
        assert watcher["writes_paths"] == []
        assert watcher["source_path"] == ""
        repair = items["repair:repair_data"]
        assert repair["source_path"] == ""

    def test_automation_boundaries_resolves_knowledge_paths_when_configured(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as web_server

        custom_root = tmp_path / "hermes-custom"
        (custom_root / "scripts").mkdir(parents=True)
        monkeypatch.delenv("HERMES_KNOWLEDGE_URL", raising=False)
        monkeypatch.setenv("HERMES_KNOWLEDGE_LOCAL_ROOT", str(custom_root))
        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(web_server, "_read_launchagent_plist", lambda label: {})
        monkeypatch.setattr(web_server, "_launchagent_status", lambda label: ("not_loaded", None))

        resp = self.client.get("/api/knowledge/automation-boundaries")

        assert resp.status_code == 200
        items = {item["id"]: item for item in resp.json()["items"]}
        watcher = items["watcher:watch_vault"]
        assert watcher["source_path"] == str(custom_root / "scripts" / "watch_vault.py")
        assert str(custom_root / "data") in watcher["writes_paths"]
        assert items["repair:repair_data"]["source_path"] == str(
            custom_root / "scripts" / "repair_data.py"
        )

    def test_automation_boundaries_degrades_one_bad_cron_item(self, monkeypatch):
        """One malformed cron job must not hide the rest of the inventory."""
        import cron.jobs as cron_jobs
        import hermes_cli.web_server as web_server

        def _list_jobs(include_disabled=True):
            return [
                {"id": "j1", "name": "daily-review", "enabled": True},
                {"id": "j2", "name": "broken-job", "enabled": True},
            ]

        def _boundary(job):
            if job.get("id") == "j2":
                raise RuntimeError("cannot describe this job")
            return {"id": "cron:j1", "name": "daily-review", "kind": "cron"}

        monkeypatch.setattr(cron_jobs, "list_jobs", _list_jobs)
        monkeypatch.setattr(web_server, "_automation_boundary_for_cron_job", _boundary)
        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(web_server, "_read_launchagent_plist", lambda label: {})
        monkeypatch.setattr(web_server, "_launchagent_status", lambda label: ("not_loaded", None))

        resp = self.client.get("/api/knowledge/automation-boundaries")

        assert resp.status_code == 200
        item_ids = {item["id"] for item in resp.json()["items"]}
        assert "cron:j1" in item_ids
        assert "cron:j2" not in item_ids

    def test_knowledge_library_selection_chat_uses_capture_selection_context(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as ws

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        vault = tmp_path / "vault"
        data_dir.mkdir(parents=True)
        (vault / "notes").mkdir(parents=True)
        (vault / "notes" / "cap-1.md").write_text(
            "---\n"
            "title: AI 工作台\n"
            "summary: 讨论知识库浏览模式。\n"
            "folder_path: AI 产品\n"
            "tags:\n"
            "  - ai\n"
            "---\n\n"
            "# 总览\n\n"
            "前文说明。\n\n"
            "## 选区章节\n\n"
            "这个概念需要结合上下文解释。\n\n"
            "后文说明。",
            encoding="utf-8",
        )
        config = custom_root / "config.yaml"
        config.write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE captures (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL DEFAULT '',
                raw_path TEXT NOT NULL DEFAULT '',
                review_state TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                embedding BLOB
            );
            """
        )
        conn.execute(
            "INSERT INTO captures (id, file_path, review_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("cap-1", "notes/cap-1.md", "captured", "2026-06-20T00:00:00+00:00", "2026-06-20T00:00:00+00:00"),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))
        calls = {}

        def fake_web_assist_answer(**kwargs):
            calls.update(kwargs)
            return {
                "status": "success",
                "agent": "research",
                "intent": "web_assist_answer",
                "chat_preview": "这是结合上下文的解释。",
                "durable_artifacts": [],
                "source_map": [],
                "next_actions": [],
                "warnings": [],
                "errors": [],
                "meta": {
                    "mode": kwargs["mode"],
                    "knowledge_sources": [{"ref": "K1", "title": "AI 工作台"}],
                    "web_sources": [{"ref": "W1", "title": "网页资料", "url": "https://example.com"}],
                    "research_trace": {
                        "plan_status": "planned_web_forced_by_mode",
                        "web_search_attempted": True,
                        "web_queries": ["SQL是什么意思"],
                    },
                },
            }

        fake_module = types.ModuleType("bridge.research_bridge")
        fake_module.web_assist_answer = fake_web_assist_answer
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", fake_module)

        response = self.client.post(
            "/api/knowledge/library/items/capture/cap-1/selection-chat",
            json={
                "question": "这段是什么意思？",
                "selected_text": "这个概念需要结合上下文解释。",
                "surrounding_before": "## 选区章节\n\n",
                "surrounding_after": "\n\n后文说明。",
                "heading_path": ["总览", "选区章节"],
                "mode": "local_web",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["answer"] == "这是结合上下文的解释。"
        assert data["used_selection"] is True
        assert data["citations"][0]["label"] == "当前选区"
        assert data["sources"]["knowledge"][0]["ref"] == "K1"
        assert data["sources"]["web"][0]["ref"] == "W1"
        assert data["meta"]["research_trace"]["plan_status"] == "planned_web_forced_by_mode"
        assert data["meta"]["research_trace"]["web_search_attempted"] is True
        assert data["meta"]["research_trace"]["web_queries"] == ["SQL是什么意思"]
        assert calls["mode"] == "local_web"
        assert calls["article_context"]["title"] == "AI 工作台"
        assert calls["selection_context"]["selected_text"] == "这个概念需要结合上下文解释。"
        assert calls["selection_context"]["heading_path"] == ["总览", "选区章节"]

    def test_knowledge_library_selection_chat_supports_draft_without_selection(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as ws

        custom_root = tmp_path / "hermes-custom"
        data_dir = custom_root / "data"
        data_dir.mkdir(parents=True)
        db_path = data_dir / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE capture_drafts (
                id TEXT PRIMARY KEY,
                raw_text TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                draft_text TEXT NOT NULL DEFAULT '',
                instruction TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'draft_ready',
                committed_capture_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                capture_intent TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        conn.execute(
            """INSERT INTO capture_drafts
               (id, title, draft_text, summary, tags, status, capture_intent, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "draft-1",
                "草稿文件",
                "# 草稿\n\n这是一篇还没有入库的材料。",
                "草稿摘要",
                '["draft"]',
                "draft_ready",
                '{"folder_path":"Inbox"}',
                "2026-06-20T00:00:00+00:00",
                "2026-06-20T00:00:00+00:00",
            ),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))
        monkeypatch.setenv("HERMES_KNOWLEDGE_DB", str(db_path))
        calls = {}

        def fake_web_assist_answer(**kwargs):
            calls.update(kwargs)
            return {
                "status": "success",
                "agent": "research",
                "intent": "web_assist_answer",
                "chat_preview": "草稿整体回答。",
                "durable_artifacts": [],
                "source_map": [],
                "next_actions": [],
                "warnings": [],
                "errors": [],
                "meta": {
                    "mode": kwargs["mode"],
                    "knowledge_sources": [],
                    "web_sources": [],
                },
            }

        fake_module = types.ModuleType("bridge.research_bridge")
        fake_module.web_assist_answer = fake_web_assist_answer
        monkeypatch.setitem(sys.modules, "bridge.research_bridge", fake_module)

        response = self.client.post(
            "/api/knowledge/library/items/capture_draft/draft-1/selection-chat",
            json={"question": "这篇文章的核心判断是什么？"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["answer"] == "草稿整体回答。"
        assert data["used_selection"] is False
        assert calls["article_context"]["kind"] == "capture_draft"
        assert calls["article_context"]["body"] == "这是一篇还没有入库的材料。"
        assert calls["query"] == "这篇文章的核心判断是什么？"

    def test_knowledge_cards_api_returns_grouped_cards_with_readable_sources(
        self, monkeypatch, tmp_path
    ):
        import sqlite3
        import hermes_cli.web_server as ws

        custom_root = tmp_path / "hermes-custom"
        vault = tmp_path / "vault"
        (custom_root / "data").mkdir(parents=True)
        (vault / "captures").mkdir(parents=True)
        (vault / "garden").mkdir(parents=True)
        (vault / "captures" / "source.md").write_text(
            "---\n"
            "title: Building Effective AI Agents\n"
            "story: Anthropic agent workflow guidance.\n"
            "---\n\n"
            "# Building Effective AI Agents\n\n正文",
            encoding="utf-8",
        )
        (vault / "garden" / "legacy-card-1.md").write_text(
            "---\n"
            "title: Legacy Markdown Card\n"
            "source_theme: Legacy Theme\n"
            "---\n\n"
            "# Legacy Markdown Card\n\n旧 garden 文件不应成为卡片 API 的主数据。",
            encoding="utf-8",
        )
        config = custom_root / "config.yaml"
        config.write_text(f"vault:\n  path: {vault}\n", encoding="utf-8")
        db_path = custom_root / "data" / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE captures (
               id TEXT PRIMARY KEY,
               file_path TEXT NOT NULL DEFAULT '',
               raw_path TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"""
        )
        conn.execute(
            """CREATE TABLE garden_cards (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL DEFAULT '',
               one_liner TEXT NOT NULL DEFAULT '',
               card_kind TEXT NOT NULL DEFAULT 'viewpoint',
               core_arguments TEXT NOT NULL DEFAULT '[]',
               knowledge_links TEXT NOT NULL DEFAULT '[]',
               key_materials TEXT NOT NULL DEFAULT '[]',
               my_view TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'seed',
               capture_ids TEXT NOT NULL DEFAULT '[]',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"""
        )
        conn.execute(
            "INSERT INTO captures (id, file_path) VALUES (?, ?)",
            ("cap-1", "captures/source.md"),
        )
        conn.execute(
            """INSERT INTO garden_cards
               (id, title, one_liner, card_kind, core_arguments, key_materials,
                my_view, status, capture_ids, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "card-1",
                "Agent 工作流选型",
                "先从增强型调用开始，再逐步引入工作流。",
                "method",
                '[{"claim":"复杂度应该服务于任务不确定性。"}]',
                '["工具质量","上下文工程"]',
                "适合评估 agent 产品架构。",
                "seed",
                '["cap-1"]',
                "2026-06-15T00:00:00+00:00",
            ),
        )
        conn.commit()
        conn.close()
        monkeypatch.setenv("HERMES_CUSTOM_ROOT", str(custom_root))

        resp = self.client.get("/api/knowledge/cards")

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["groups"]["method"] == 1
        card = payload["cards"][0]
        assert card["id"] == "card-1"
        assert card["kind"] == "method"
        assert card["summary"] == "先从增强型调用开始，再逐步引入工作流。"
        assert card["file_path"] == ""
        assert card["source_theme"] == ""
        assert card["markdown"] == ""
        assert card["core_arguments"] == [{"claim": "复杂度应该服务于任务不确定性。"}]
        assert card["key_materials"] == ["工具质量", "上下文工程"]
        assert card["my_view"] == "适合评估 agent 产品架构。"
        assert card["sources"] == [
            {
                "id": "cap-1",
                "title": "Building Effective AI Agents",
                "file_path": "captures/source.md",
                "summary": "Anthropic agent workflow guidance.",
            }
        ]

    def test_knowledge_graph_api_uses_custom_service_and_main_routes(self, monkeypatch, tmp_path):
        import hermes_cli.web_server as web_server

        db_path = tmp_path / "hermes-custom" / "data" / "captures.db"
        vault_path = tmp_path / "vault"
        calls = {"init_db": [], "refresh": 0, "focus": []}

        class FakeConn:
            def close(self):
                calls["closed"] = calls.get("closed", 0) + 1

        class FakeSchemaModule:
            @staticmethod
            def init_db(path):
                calls["init_db"].append(path)
                return FakeConn()

        class FakeKnowledgeGraphService:
            def __init__(self, conn, vault):
                calls["service_vault"] = str(vault)

            def refresh(self):
                calls["refresh"] += 1
                return {
                    "node_count": 2,
                    "edge_count": 1,
                    "relation_counts": {"card_uses_capture": 1},
                }

            def focus_graph(self, **kwargs):
                calls["focus"].append(kwargs)
                return {
                    "nodes": [
                        {
                            "id": "cap-1",
                            "kind": "capture",
                            "title": "来源笔记",
                            "summary": "摘要",
                            "file_path": "captures/source.md",
                            "open_url": "/knowledge-library?kind=capture&item=cap-1",
                            "file_url": "file:///tmp/source.md",
                        }
                    ],
                    "edges": [],
                    "meta": {
                        "focus_kind": kwargs["focus_kind"],
                        "focus_id": kwargs["focus_id"],
                        "depth": 1,
                        "edge_count": 0,
                    },
                }

        fake_graph_module = types.SimpleNamespace(KnowledgeGraphService=FakeKnowledgeGraphService)

        def fake_custom_module(module_name, label):
            if module_name == "db.schema":
                return FakeSchemaModule
            if module_name == "agents.knowledge_graph":
                return fake_graph_module
            raise AssertionError((module_name, label))

        monkeypatch.setattr(web_server, "_knowledge_custom_module", fake_custom_module)
        monkeypatch.setattr(web_server, "_knowledge_db_path", lambda: db_path)
        monkeypatch.setattr(web_server, "_knowledge_vault_path", lambda: vault_path)

        refresh = self.client.post("/api/knowledge/graph/refresh")
        graph = self.client.get("/api/knowledge/graph?focus_kind=garden_card&focus_id=card-1")

        assert refresh.status_code == 200
        assert refresh.json()["edge_count"] == 1
        assert graph.status_code == 200
        payload = graph.json()
        assert payload["nodes"][0]["open_url"] == "/knowledge-library?kind=capture&item=cap-1"
        assert calls["init_db"] == [str(db_path), str(db_path)]
        assert calls["refresh"] == 1
        assert calls["focus"][0]["focus_kind"] == "garden_card"
        assert calls["focus"][0]["focus_id"] == "card-1"

    def test_post_knowledge_answer_draft_calls_bridge(self, monkeypatch, tmp_path):
        import types
        import hermes_cli.web_server as web_server

        monkeypatch.setattr(web_server, "_knowledge_custom_root", lambda: tmp_path)
        called = {}

        def fake_save(**kwargs):
            called.update(kwargs)
            return {
                "status": "success",
                "agent": "reading",
                "intent": "save_answer_to_knowledge",
                "chat_preview": "已生成 Capture Note 草稿",
                "durable_artifacts": [],
                "source_map": [],
                "next_actions": [],
                "warnings": [],
                "errors": [],
                "meta": {"reading_draft_id": "draft1"},
            }

        fake_module = types.ModuleType("bridge.answer_bridge")
        fake_module.save_answer_to_knowledge = fake_save
        monkeypatch.setitem(sys.modules, "bridge.answer_bridge", fake_module)

        response = self.client.post(
            "/api/knowledge/answer-drafts",
            json={
                "hermes_session_id": "session1",
                "user_message": "为什么重要？",
                "assistant_answer": "因为它可复用。",
                "instruction": "存起来",
                "output_type": "auto",
                "assistant_message_id": "assistant1",
                "sources": [{"type": "capture_note", "id": "cap1", "title": "A"}],
            },
        )

        assert response.status_code == 200
        assert response.json()["meta"]["reading_draft_id"] == "draft1"
        assert called["assistant_answer"] == "因为它可复用。"

    def test_local_commit_routes_pass_token_verified(self, monkeypatch):
        """Local mode: the dashboard click is the confirmation.

        The confirmation gate no longer trusts a ``confirmation_source`` string,
        so the dashboard's own commit routes must tell the bridge that the
        request was already confirmed (``token_verified=True``) or every commit
        would fail with a "please confirm" error envelope.
        """
        import types
        import hermes_cli.web_server as web_server
        import integrations.hermes_knowledge.client as knowledge_client

        monkeypatch.setattr(knowledge_client, "get_client", lambda transport=None: None)

        calls: dict[str, dict] = {}

        def record(name):
            def _call(*args, **kwargs):
                calls[name] = {"args": args, **kwargs}
                return {"status": "ok", "intent": name}

            return _call

        fake_capture = types.ModuleType("bridge.capture_bridge")
        fake_capture.commit_capture_draft = record("commit_capture_draft")
        fake_reading = types.ModuleType("bridge.reading_bridge")
        fake_reading.commit_reading_artifact = record("commit_reading_artifact")
        fake_garden = types.ModuleType("bridge.garden_bridge")
        fake_garden.commit_garden_draft = record("commit_garden_draft")

        def fake_custom_module(module_name, label):
            mapping = {
                "bridge.capture_bridge": fake_capture,
                "bridge.reading_bridge": fake_reading,
                "bridge.garden_bridge": fake_garden,
            }
            if module_name not in mapping:
                raise AssertionError((module_name, label))
            return mapping[module_name]

        monkeypatch.setattr(web_server, "_knowledge_custom_module", fake_custom_module)

        assert self.client.post("/api/knowledge/capture-drafts/draft-1/commit").status_code == 200
        assert self.client.post("/api/knowledge/reading-drafts/draft-1/commit").status_code == 200

        assert calls["commit_capture_draft"]["token_verified"] is True
        assert calls["commit_capture_draft"]["args"] == ("draft-1",)
        assert calls["commit_reading_artifact"]["token_verified"] is True
        assert calls["commit_reading_artifact"]["draft_id"] == "draft-1"

    def test_get_knowledge_reading_draft_returns_full_text(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as web_server

        db_path = tmp_path / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE reading_drafts (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               output_type TEXT NOT NULL DEFAULT '',
               target_capture_id TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               draft_text TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'open',
               meta_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"""
        )
        conn.execute(
            """INSERT INTO reading_drafts
               (id, session_id, output_type, title, summary, draft_text, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("draft1", "session1", "local_learning_note", "标题", "摘要", "# 标题\n正文", "open"),
        )
        conn.commit()
        conn.close()

        monkeypatch.setattr(web_server, "_knowledge_db_path", lambda: db_path)

        response = self.client.get("/api/knowledge/reading-drafts/draft1")

        assert response.status_code == 200
        assert response.json()["draft"]["draft_text"] == "# 标题\n正文"

    def test_get_knowledge_reading_drafts_lists_answer_drafts(self, monkeypatch, tmp_path):
        import sqlite3
        import hermes_cli.web_server as web_server

        db_path = tmp_path / "captures.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE reading_drafts (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               output_type TEXT NOT NULL DEFAULT '',
               target_capture_id TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL DEFAULT '',
               draft_text TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'open',
               meta_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"""
        )
        conn.execute(
            """INSERT INTO reading_drafts
               (id, session_id, output_type, title, summary, draft_text, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("draft1", "session1", "local_learning_note", "企业级取数 Agent", "摘要", "# 正文", "open"),
        )
        conn.execute(
            """INSERT INTO reading_drafts
               (id, session_id, output_type, title, summary, draft_text, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("draft2", "session1", "knowledge_card", "旧卡片", "摘要", "# 卡片", "committed"),
        )
        conn.commit()
        conn.close()

        monkeypatch.setattr(web_server, "_knowledge_db_path", lambda: db_path)

        response = self.client.get("/api/knowledge/reading-drafts")

        assert response.status_code == 200
        payload = response.json()
        assert payload["total"] == 2
        assert payload["open_count"] == 1
        assert payload["drafts"][0]["title"] in {"企业级取数 Agent", "旧卡片"}

    def test_post_knowledge_reading_draft_revise_calls_bridge(self, monkeypatch, tmp_path):
        import types
        import hermes_cli.web_server as web_server

        monkeypatch.setattr(web_server, "_knowledge_custom_root", lambda: tmp_path)
        called = {}

        def fake_revise(**kwargs):
            called.update(kwargs)
            return {
                "status": "success",
                "agent": "reading",
                "intent": "revise_answer_draft",
                "chat_preview": "已修改文稿草稿",
                "durable_artifacts": [],
                "source_map": [],
                "next_actions": [],
                "warnings": [],
                "errors": [],
                "meta": {"reading_draft_id": "draft1"},
            }

        fake_module = types.ModuleType("bridge.answer_bridge")
        fake_module.revise_answer_draft = fake_revise
        monkeypatch.setitem(sys.modules, "bridge.answer_bridge", fake_module)

        response = self.client.post(
            "/api/knowledge/reading-drafts/draft1/revise",
            json={"instruction": "展开第二段"},
        )

        assert response.status_code == 200
        assert response.json()["meta"]["reading_draft_id"] == "draft1"
        assert called == {"draft_id": "draft1", "instruction": "展开第二段"}

    def test_get_status_filters_unconfigured_gateway_platforms(self, monkeypatch):
        import gateway.config as gateway_config
        import hermes_cli.web_server as web_server

        class _Platform:
            def __init__(self, value):
                self.value = value

        class _GatewayConfig:
            def get_connected_platforms(self):
                return [_Platform("telegram")]

        monkeypatch.setattr(web_server, "get_running_pid", lambda: 1234)
        monkeypatch.setattr(
            web_server,
            "read_runtime_status",
            lambda: {
                "gateway_state": "running",
                "updated_at": "2026-04-12T00:00:00+00:00",
                "platforms": {
                    "telegram": {"state": "connected", "updated_at": "2026-04-12T00:00:00+00:00"},
                    "whatsapp": {"state": "retrying", "updated_at": "2026-04-12T00:00:00+00:00"},
                    "feishu": {"state": "connected", "updated_at": "2026-04-12T00:00:00+00:00"},
                },
            },
        )
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(gateway_config, "load_gateway_config", lambda: _GatewayConfig())

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["gateway_platforms"] == {
            "telegram": {"state": "connected", "updated_at": "2026-04-12T00:00:00+00:00"},
        }

    def test_get_status_hides_stale_platforms_when_gateway_not_running(self, monkeypatch):
        import gateway.config as gateway_config
        import hermes_cli.web_server as web_server

        class _GatewayConfig:
            def get_connected_platforms(self):
                return []

        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(
            web_server,
            "read_runtime_status",
            lambda: {
                "gateway_state": "startup_failed",
                "updated_at": "2026-04-12T00:00:00+00:00",
                "platforms": {
                    "whatsapp": {"state": "retrying", "updated_at": "2026-04-12T00:00:00+00:00"},
                    "feishu": {"state": "connected", "updated_at": "2026-04-12T00:00:00+00:00"},
                },
            },
        )
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(gateway_config, "load_gateway_config", lambda: _GatewayConfig())

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["gateway_state"] == "startup_failed"
        assert resp.json()["gateway_platforms"] == {}

    def test_get_status_marks_live_gateway_degraded_when_runtime_heartbeat_is_stale(self, monkeypatch):
        import gateway.config as gateway_config
        import hermes_cli.web_server as web_server

        class _GatewayConfig:
            def get_connected_platforms(self):
                return []

        monkeypatch.setattr(web_server, "get_running_pid", lambda: 1234)
        monkeypatch.setattr(
            web_server,
            "read_runtime_status",
            lambda: {
                "gateway_state": "running",
                "updated_at": "2026-07-13T10:32:54+00:00",
                "platforms": {},
            },
        )
        monkeypatch.setattr(web_server, "runtime_status_is_stale", lambda state: True)
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(gateway_config, "load_gateway_config", lambda: _GatewayConfig())

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["gateway_running"] is True
        assert resp.json()["gateway_state"] == "degraded"
        assert resp.json()["gateway_status_stale"] is True

    def test_get_status_marks_gateway_degraded_when_configured_platform_is_retrying(self, monkeypatch):
        import gateway.config as gateway_config
        import hermes_cli.web_server as web_server

        class _Platform:
            value = "weixin"

        class _GatewayConfig:
            def get_connected_platforms(self):
                return [_Platform()]

        monkeypatch.setattr(web_server, "get_running_pid", lambda: 1234)
        monkeypatch.setattr(
            web_server,
            "read_runtime_status",
            lambda: {
                "gateway_state": "running",
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
        monkeypatch.setattr(web_server, "runtime_status_is_stale", lambda state: False)
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(gateway_config, "load_gateway_config", lambda: _GatewayConfig())

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["gateway_state"] == "degraded"
        assert resp.json()["gateway_status_stale"] is False

    def test_status_redaction_strips_credential_shapes(self):
        import hermes_cli.web_server as web_server

        secrets = {
            "json_api_key": "sk-live-json0123456789abcdef",
            "env_key": "sk-proj-env0123456789abcdef",
            "bearer": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
            "telegram": "AAHtelegramsecret0123456789",
            "access": "at-0123456789abcdef",
            "refresh": "rt-0123456789abcdef",
            "bare": "sk-bare0123456789abcdef",
            "url_password": "s3cr3tpassw0rd",
        }
        payload = {
            "gateway_platforms": {
                "telegram": {
                    "state": "retrying",
                    "error": f"Authorization: Bearer {secrets['bearer']}",
                    "hint": f"OPENAI_API_KEY={secrets['env_key']}",
                    "webhook": (
                        "https://api.telegram.org/bot123456789:"
                        f"{secrets['telegram']}/getUpdates"
                    ),
                },
                "discord": {
                    "debug": '{"api_key": "' + secrets["json_api_key"] + '", "retries": 3}',
                    "query": f"access_token={secrets['access']}&refresh_token={secrets['refresh']}",
                    "health_url": f"https://alice:{secrets['url_password']}@example.com/health",
                },
                "memory": {"state": "connected", "note": f"bare key {secrets['bare']} trailing"},
            },
            "gateway_exit_reason": (
                "token budget: 100 · gateway running · https://api.example.com/health"
            ),
            "nested": {
                "api_key": "value with spaces 0123456789",
                "plain": "6 sessions active",
            },
        }

        redacted = json.dumps(web_server._redact_status_payload(payload))

        for name, secret in secrets.items():
            assert secret not in redacted, f"{name} leaked into the status payload"
        # Innocent text must survive the shape patterns.
        assert "gateway running" in redacted
        assert "https://api.example.com/health" in redacted
        assert "6 sessions active" in redacted
        assert "token budget: 100" in redacted
        assert "retrying" in redacted
        assert "retries" in redacted

    def test_status_endpoint_redacts_platform_and_exit_reason_credentials(self, monkeypatch):
        import gateway.config as gateway_config
        import hermes_cli.web_server as web_server

        class _Platform:
            value = "telegram"

        class _GatewayConfig:
            def get_connected_platforms(self):
                return [_Platform()]

        bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
        telegram_token = "AAHtelegramsecret0123456789"
        api_key = "sk-live-endpoint0123456789abcdef"
        access_token = "at-endpoint0123456789abcdef"
        monkeypatch.setattr(web_server, "get_running_pid", lambda: 1234)
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(web_server, "runtime_status_is_stale", lambda state: False)
        monkeypatch.setattr(
            web_server,
            "read_runtime_status",
            lambda: {
                "gateway_state": "running",
                "updated_at": "2026-11-13T00:00:00+00:00",
                "platforms": {
                    "telegram": {
                        "state": "retrying",
                        "error": f"Authorization: Bearer {bearer}",
                        "last_error": f"OPENAI_API_KEY={api_key}",
                        "webhook": (
                            "https://api.telegram.org/bot123456789:"
                            f"{telegram_token}/getUpdates"
                        ),
                    }
                },
                "exit_reason": f"still retrying; access_token={access_token}",
            },
        )
        monkeypatch.setattr(gateway_config, "load_gateway_config", lambda: _GatewayConfig())

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        body = json.dumps(resp.json())
        for leaked in (bearer, telegram_token, api_key, access_token):
            assert leaked not in body
        assert resp.json()["gateway_exit_reason"].startswith("still retrying")

    def test_status_redacts_gateway_health_url(self, monkeypatch):
        import hermes_cli.web_server as web_server

        monkeypatch.setattr(
            web_server,
            "_GATEWAY_HEALTH_URL",
            "https://monitor:hunter2-secret@example.com/health",
        )
        monkeypatch.setattr(web_server, "_probe_gateway_health", lambda: (False, None))
        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        health_url = resp.json()["gateway_health_url"]
        assert health_url is not None
        assert "hunter2-secret" not in health_url
        assert "<redacted>" in health_url

    def _clear_knowledge_env(self, monkeypatch):
        for key in (
            "HERMES_KNOWLEDGE_URL",
            "HERMES_KNOWLEDGE_LOCAL_ROOT",
            "HERMES_CUSTOM_ROOT",
        ):
            monkeypatch.delenv(key, raising=False)

    def _patch_status_environment(self, monkeypatch):
        import hermes_cli.web_server as web_server

        monkeypatch.setattr(web_server, "get_running_pid", lambda: None)
        monkeypatch.setattr(web_server, "check_config_version", lambda: (1, 1))
        monkeypatch.setattr(web_server, "read_runtime_status", lambda: None)

    def test_status_knowledge_block_disabled(self, monkeypatch):
        self._clear_knowledge_env(monkeypatch)
        self._patch_status_environment(monkeypatch)

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["knowledge"] == {
            "mode": "disabled",
            "contract_version": None,
            "compatible": None,
        }

    def test_status_knowledge_block_local(self, monkeypatch, tmp_path):
        self._clear_knowledge_env(monkeypatch)
        monkeypatch.setenv("HERMES_KNOWLEDGE_LOCAL_ROOT", str(tmp_path))
        self._patch_status_environment(monkeypatch)

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["knowledge"] == {
            "mode": "local",
            "contract_version": None,
            "compatible": None,
        }

    def test_status_knowledge_block_http_reports_config_without_probing(self, monkeypatch):
        """Status is public: it must report the mode without touching the network."""
        import integrations.hermes_knowledge.client as knowledge_client

        self._clear_knowledge_env(monkeypatch)
        monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://127.0.0.1:8123")
        self._patch_status_environment(monkeypatch)

        class _NoClientConstruction:
            def __init__(self, *args, **kwargs):
                raise AssertionError("status must not construct a knowledge client")

        monkeypatch.setattr(knowledge_client, "KnowledgeClient", _NoClientConstruction)

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["knowledge"] == {
            "mode": "http",
            "contract_version": None,
            "compatible": None,
        }

    def test_status_knowledge_block_http_uses_cached_contract(self, monkeypatch):
        """Once the process validated the contract, status reports it from cache."""
        import httpx

        import integrations.hermes_knowledge.client as knowledge_client

        self._clear_knowledge_env(monkeypatch)
        monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "http://127.0.0.1:8123")
        self._patch_status_environment(monkeypatch)

        probe = knowledge_client.KnowledgeClient(
            knowledge_client.KnowledgeConfig(
                base_url="http://127.0.0.1:8123", token="t"
            ),
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={"service": "hermes-knowledge", "contract_version": 1},
                )
            ),
        )
        knowledge_client.ensure_compatible(probe)
        probe.close()

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["knowledge"] == {
            "mode": "http",
            "contract_version": 1,
            "compatible": True,
        }

    def test_status_knowledge_block_survives_invalid_knowledge_config(self, monkeypatch):
        self._clear_knowledge_env(monkeypatch)
        monkeypatch.setenv("HERMES_KNOWLEDGE_URL", "127.0.0.1:8123")  # no scheme
        self._patch_status_environment(monkeypatch)

        resp = self.client.get("/api/status")

        assert resp.status_code == 200
        assert resp.json()["knowledge"] == {
            "mode": "http",
            "contract_version": None,
            "compatible": None,
        }

    def test_get_config_schema(self):
        resp = self.client.get("/api/config/schema")
        assert resp.status_code == 200
        data = resp.json()
        assert "fields" in data
        assert "category_order" in data
        schema = data["fields"]
        assert len(schema) > 100  # Should have 150+ fields
        assert "model" in schema
        # Verify category_order is a non-empty list
        assert isinstance(data["category_order"], list)
        assert len(data["category_order"]) > 0
        assert "general" in data["category_order"]

    def test_get_config_defaults(self):
        resp = self.client.get("/api/config/defaults")
        assert resp.status_code == 200
        defaults = resp.json()
        assert "model" in defaults

    def test_get_env_vars(self):
        resp = self.client.get("/api/env")
        assert resp.status_code == 200
        data = resp.json()
        # Should contain known env var names
        assert any(k.endswith("_API_KEY") or k.endswith("_TOKEN") for k in data.keys())

    def test_reveal_env_var(self, tmp_path):
        """POST /api/env/reveal should return the real unredacted value."""
        from hermes_cli.config import save_env_value
        from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN
        save_env_value("TEST_REVEAL_KEY", "super-secret-value-12345")
        resp = self.client.post(
            "/api/env/reveal",
            json={"key": "TEST_REVEAL_KEY"},
            headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["key"] == "TEST_REVEAL_KEY"
        assert data["value"] == "super-secret-value-12345"

    def test_reveal_env_var_not_found(self):
        """POST /api/env/reveal should 404 for unknown keys."""
        from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN
        resp = self.client.post(
            "/api/env/reveal",
            json={"key": "NONEXISTENT_KEY_XYZ"},
            headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
        )
        assert resp.status_code == 404

    def test_reveal_env_var_no_token(self, tmp_path):
        """POST /api/env/reveal without token should return 401."""
        from starlette.testclient import TestClient
        from hermes_cli.web_server import app
        from hermes_cli.config import save_env_value
        save_env_value("TEST_REVEAL_NOAUTH", "secret-value")
        # Use a fresh client WITHOUT the dashboard session header
        unauth_client = TestClient(app)
        resp = unauth_client.post(
            "/api/env/reveal",
            json={"key": "TEST_REVEAL_NOAUTH"},
        )
        assert resp.status_code == 401

    def test_reveal_env_var_bad_token(self, tmp_path):
        """POST /api/env/reveal with wrong token should return 401."""
        from hermes_cli.config import save_env_value
        from hermes_cli.web_server import _SESSION_HEADER_NAME
        save_env_value("TEST_REVEAL_BADAUTH", "secret-value")
        resp = self.client.post(
            "/api/env/reveal",
            json={"key": "TEST_REVEAL_BADAUTH"},
            headers={_SESSION_HEADER_NAME: "wrong-token-here"},
        )
        assert resp.status_code == 401

    def test_reveal_env_var_custom_session_header_ignores_proxy_authorization(self, tmp_path):
        """A valid dashboard session header should coexist with proxy auth."""
        from hermes_cli.config import save_env_value
        from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

        save_env_value("TEST_REVEAL_PROXY_AUTH", "secret-value")
        resp = self.client.post(
            "/api/env/reveal",
            json={"key": "TEST_REVEAL_PROXY_AUTH"},
            headers={
                _SESSION_HEADER_NAME: _SESSION_TOKEN,
                "Authorization": "Basic dXNlcjpwYXNz",
            },
        )

        assert resp.status_code == 200
        assert resp.json()["value"] == "secret-value"

    def test_reveal_env_var_legacy_authorization_header_still_works(self, tmp_path):
        """Keep old dashboard bundles working while the new header rolls out."""
        from hermes_cli.config import save_env_value
        from hermes_cli.web_server import _SESSION_TOKEN

        save_env_value("TEST_REVEAL_LEGACY_AUTH", "secret-value")
        resp = self.client.post(
            "/api/env/reveal",
            json={"key": "TEST_REVEAL_LEGACY_AUTH"},
            headers={"Authorization": f"Bearer {_SESSION_TOKEN}"},
        )

        assert resp.status_code == 200

    def test_session_token_endpoint_removed(self):
        """GET /api/auth/session-token should no longer exist (token injected via HTML)."""
        resp = self.client.get("/api/auth/session-token")
        # The endpoint is gone — the catch-all SPA route serves index.html
        # or the middleware returns 401 for unauthenticated /api/ paths.
        assert resp.status_code in {200, 404}
        # Either way, it must NOT return the token as JSON
        try:
            data = resp.json()
            assert "token" not in data
        except Exception:
            pass  # Not JSON — that's fine (SPA HTML)

    def test_unauthenticated_api_blocked(self):
        """API requests without the session token should be rejected."""
        from starlette.testclient import TestClient
        from hermes_cli.web_server import app
        # Create a client WITHOUT the dashboard session header
        unauth_client = TestClient(app)
        resp = unauth_client.get("/api/env")
        assert resp.status_code == 401
        resp = unauth_client.get("/api/config")
        assert resp.status_code == 401
        # Public endpoints should still work
        resp = unauth_client.get("/api/status")
        assert resp.status_code == 200

    def test_path_traversal_blocked(self):
        """Verify URL-encoded path traversal is blocked."""
        # %2e%2e = ..
        resp = self.client.get("/%2e%2e/%2e%2e/etc/passwd")
        # Should return 200 with index.html (SPA fallback), not the actual file
        assert resp.status_code in {200, 404}
        if resp.status_code == 200:
            # Should be the SPA fallback, not the system file
            assert "root:" not in resp.text

    def test_path_traversal_dotdot_blocked(self):
        """Direct .. path traversal via encoded sequences."""
        resp = self.client.get("/%2e%2e/hermes_cli/web_server.py")
        assert resp.status_code in {200, 404}
        if resp.status_code == 200:
            assert "FastAPI" not in resp.text  # Should not serve the actual source


# ---------------------------------------------------------------------------
# _build_schema_from_config tests
# ---------------------------------------------------------------------------


class TestBuildSchemaFromConfig:
    def test_produces_expected_field_count(self):
        from hermes_cli.web_server import CONFIG_SCHEMA
        # DEFAULT_CONFIG has ~150+ leaf fields
        assert len(CONFIG_SCHEMA) > 100

    def test_schema_entries_have_required_fields(self):
        from hermes_cli.web_server import CONFIG_SCHEMA
        for key, entry in list(CONFIG_SCHEMA.items())[:10]:
            assert "type" in entry, f"Missing type for {key}"
            assert "category" in entry, f"Missing category for {key}"

    def test_overrides_applied(self):
        from hermes_cli.web_server import CONFIG_SCHEMA
        # terminal.backend should be a select with options
        if "terminal.backend" in CONFIG_SCHEMA:
            entry = CONFIG_SCHEMA["terminal.backend"]
            assert entry["type"] == "select"
            assert "options" in entry
            assert "local" in entry["options"]
            assert "vercel_sandbox" in entry["options"]
        runtime_entry = CONFIG_SCHEMA["terminal.vercel_runtime"]
        assert runtime_entry["type"] == "select"
        assert "node24" in runtime_entry["options"]
        assert "python3.13" in runtime_entry["options"]
        assert len(runtime_entry["options"]) >= 3

    def test_empty_prefix_produces_correct_keys(self):
        from hermes_cli.web_server import _build_schema_from_config
        test_config = {"model": "test", "nested": {"key": "val"}}
        schema = _build_schema_from_config(test_config)
        assert "model" in schema
        assert "nested.key" in schema

    def test_top_level_scalars_get_general_category(self):
        """Top-level scalar fields should be in 'general' category."""
        from hermes_cli.web_server import CONFIG_SCHEMA
        assert CONFIG_SCHEMA["model"]["category"] == "general"

    def test_nested_keys_get_parent_category(self):
        """Nested fields should use the top-level parent as their category."""
        from hermes_cli.web_server import CONFIG_SCHEMA
        if "agent.max_turns" in CONFIG_SCHEMA:
            assert CONFIG_SCHEMA["agent.max_turns"]["category"] == "agent"

    def test_category_merge_applied(self):
        """Small categories should be merged into larger ones."""
        from hermes_cli.web_server import CONFIG_SCHEMA
        categories = {e["category"] for e in CONFIG_SCHEMA.values()}
        # These should be merged away
        assert "privacy" not in categories  # merged into security
        assert "context" not in categories  # merged into agent

    def test_no_single_field_categories(self):
        """After merging, no category should have just 1 field."""
        from hermes_cli.web_server import CONFIG_SCHEMA
        from collections import Counter
        cats = Counter(e["category"] for e in CONFIG_SCHEMA.values())
        for cat, count in cats.items():
            assert count >= 2, f"Category '{cat}' has only {count} field(s) — should be merged"


# ---------------------------------------------------------------------------
# Config round-trip tests
# ---------------------------------------------------------------------------


class TestConfigRoundTrip:
    """Verify config survives GET → edit → PUT without data loss."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")
        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
        self.client = TestClient(app)
        self.client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_get_config_no_internal_keys(self):
        """GET /api/config should not expose _config_version or _model_meta."""
        config = self.client.get("/api/config").json()
        internal = [k for k in config if k.startswith("_")]
        assert not internal, f"Internal keys leaked to frontend: {internal}"

    def test_get_config_model_is_string(self):
        """GET /api/config should normalize model dict to a string."""
        config = self.client.get("/api/config").json()
        assert isinstance(config.get("model"), str), \
            f"model should be string, got {type(config.get('model'))}"

    def test_round_trip_preserves_model_subkeys(self):
        """Save and reload should not lose model.provider, model.base_url, etc."""
        from hermes_cli.config import load_config, save_config

        # Set up a config with model as a dict (the common user config form)
        save_config({
            "model": {
                "default": "anthropic/claude-sonnet-4",
                "provider": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "api_mode": "openai",
            }
        })

        before = load_config()
        assert isinstance(before.get("model"), dict)
        original_keys = set(before["model"].keys())

        # GET → PUT unchanged
        web_config = self.client.get("/api/config").json()
        assert isinstance(web_config.get("model"), str), "GET should normalize model to string"

        self.client.put("/api/config", json={"config": web_config})

        after = load_config()
        assert isinstance(after.get("model"), dict), "model should still be a dict after save"
        assert set(after["model"].keys()) >= original_keys, \
            f"Lost model subkeys: {original_keys - set(after['model'].keys())}"

    def test_edit_model_name_preserved(self):
        """Changing the model string should update model.default on disk."""
        from hermes_cli.config import load_config

        web_config = self.client.get("/api/config").json()
        original_model = web_config["model"]

        # Change model
        web_config["model"] = "test/editing-model"
        self.client.put("/api/config", json={"config": web_config})

        after = load_config()
        if isinstance(after.get("model"), dict):
            assert after["model"]["default"] == "test/editing-model"
        else:
            assert after["model"] == "test/editing-model"

        # Restore
        web_config["model"] = original_model
        self.client.put("/api/config", json={"config": web_config})

    def test_edit_nested_value(self):
        """Editing a nested config value should persist correctly."""
        from hermes_cli.config import load_config

        web_config = self.client.get("/api/config").json()
        original_turns = web_config.get("agent", {}).get("max_turns")

        # Change max_turns
        if "agent" not in web_config:
            web_config["agent"] = {}
        web_config["agent"]["max_turns"] = 42

        self.client.put("/api/config", json={"config": web_config})

        after = load_config()
        assert after.get("agent", {}).get("max_turns") == 42

        # Restore
        web_config["agent"]["max_turns"] = original_turns
        self.client.put("/api/config", json={"config": web_config})

    def test_schema_types_match_config_values(self):
        """Every schema field should have a matching-type value in the config."""
        config = self.client.get("/api/config").json()
        schema_resp = self.client.get("/api/config/schema").json()
        schema = schema_resp["fields"]

        def get_nested(obj, path):
            parts = path.split(".")
            cur = obj
            for p in parts:
                if cur is None or not isinstance(cur, dict):
                    return None
                cur = cur.get(p)
            return cur

        mismatches = []
        for key, entry in schema.items():
            val = get_nested(config, key)
            if val is None:
                continue  # not set in user config — fine
            expected = entry["type"]
            if expected in {"string", "select"} and not isinstance(val, str):
                mismatches.append(f"{key}: expected str, got {type(val).__name__}")
            elif expected == "number" and not isinstance(val, (int, float)):
                mismatches.append(f"{key}: expected number, got {type(val).__name__}")
            elif expected == "boolean" and not isinstance(val, bool):
                mismatches.append(f"{key}: expected bool, got {type(val).__name__}")
            elif expected == "list" and not isinstance(val, list):
                mismatches.append(f"{key}: expected list, got {type(val).__name__}")
        assert not mismatches, f"Type mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# New feature endpoint tests
# ---------------------------------------------------------------------------


class TestNewEndpoints:
    """Tests for session detail, logs, cron, skills, tools, raw config, analytics."""

    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch, _isolate_hermes_home):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        import hermes_state
        from hermes_constants import get_hermes_home
        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")

        self.client = TestClient(app)
        self.client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_get_logs_default(self):
        resp = self.client.get("/api/logs")
        assert resp.status_code == 200
        data = resp.json()
        assert "file" in data
        assert "lines" in data
        assert isinstance(data["lines"], list)

    def test_get_logs_invalid_file(self):
        resp = self.client.get("/api/logs?file=nonexistent")
        assert resp.status_code == 400

    def test_cron_list(self):
        resp = self.client.get("/api/cron/jobs")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_cron_job_not_found(self):
        resp = self.client.get("/api/cron/jobs/nonexistent-id")
        assert resp.status_code == 404

    # --- Profiles ---

    def test_profiles_list_includes_default(self):
        from hermes_constants import get_hermes_home
        get_hermes_home().mkdir(parents=True, exist_ok=True)

        resp = self.client.get("/api/profiles")
        assert resp.status_code == 200
        names = [p["name"] for p in resp.json()["profiles"]]
        assert "default" in names

    def test_profiles_list_falls_back_when_profile_listing_fails(self, monkeypatch):
        from hermes_constants import get_hermes_home
        import hermes_cli.profiles as profiles_mod

        hermes_home = get_hermes_home()
        hermes_home.mkdir(parents=True, exist_ok=True)
        (hermes_home / "config.yaml").write_text(
            "model:\n  provider: openrouter\n  name: anthropic/claude-sonnet-4.6\n",
            encoding="utf-8",
        )
        named = hermes_home / "profiles" / "multi-agent"
        named.mkdir(parents=True)
        (named / ".env").write_text("EXAMPLE=1\n", encoding="utf-8")
        (named / "skills" / "demo").mkdir(parents=True)
        (named / "skills" / "demo" / "SKILL.md").write_text("---\nname: demo\n---\n", encoding="utf-8")

        monkeypatch.setattr(
            profiles_mod,
            "list_profiles",
            lambda: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        resp = self.client.get("/api/profiles")

        assert resp.status_code == 200
        profiles = {p["name"]: p for p in resp.json()["profiles"]}
        assert profiles["default"]["is_default"] is True
        assert profiles["default"]["provider"] == "openrouter"
        assert profiles["multi-agent"]["has_env"] is True
        assert profiles["multi-agent"]["skill_count"] == 1

    def test_profiles_create_rename_delete_round_trip(self, monkeypatch):
        # Stub gateway service teardown so the test doesn't shell out to
        # launchctl/systemctl on the host.
        import hermes_cli.profiles as profiles_mod
        monkeypatch.setattr(profiles_mod, "_cleanup_gateway_service", lambda *a, **kw: None)

        created = self.client.post("/api/profiles", json={"name": "test-prof"})
        assert created.status_code == 200

        renamed = self.client.patch(
            "/api/profiles/test-prof",
            json={"new_name": "test-prof-2"},
        )
        assert renamed.status_code == 200

        names = [p["name"] for p in self.client.get("/api/profiles").json()["profiles"]]
        assert "test-prof" not in names
        assert "test-prof-2" in names

        deleted = self.client.delete("/api/profiles/test-prof-2")
        assert deleted.status_code == 200
        names = [p["name"] for p in self.client.get("/api/profiles").json()["profiles"]]
        assert "test-prof-2" not in names

    def test_profile_setup_command_uses_named_profile_wrapper(self):
        from hermes_constants import get_hermes_home

        (get_hermes_home() / "profiles" / "coder").mkdir(parents=True)

        resp = self.client.get("/api/profiles/coder/setup-command")

        assert resp.status_code == 200
        assert resp.json()["command"] == "coder setup"

    def test_profile_setup_command_uses_hermes_for_default_profile(self):
        from hermes_constants import get_hermes_home

        get_hermes_home().mkdir(parents=True, exist_ok=True)

        resp = self.client.get("/api/profiles/default/setup-command")

        assert resp.status_code == 200
        assert resp.json()["command"] == "hermes setup"

    def test_profiles_create_creates_wrapper_alias_when_safe(self, monkeypatch, tmp_path):
        import hermes_cli.profiles as profiles_mod

        wrapper_dir = tmp_path / "bin"
        wrapper_dir.mkdir()
        monkeypatch.setattr(profiles_mod, "_get_wrapper_dir", lambda: wrapper_dir)

        resp = self.client.post(
            "/api/profiles",
            json={"name": "writer", "clone_from_default": False},
        )

        assert resp.status_code == 200
        wrapper_path = wrapper_dir / "writer"
        assert wrapper_path.exists()
        assert wrapper_path.read_text() == '#!/bin/sh\nexec hermes -p writer "$@"\n'

    def test_profiles_create_with_clone_from_default_copies_default_skills(self, monkeypatch):
        from hermes_constants import get_hermes_home
        import hermes_cli.profiles as profiles_mod

        monkeypatch.setattr(profiles_mod, "create_wrapper_script", lambda name: None)
        default_skill = get_hermes_home() / "skills" / "custom" / "new-skill"
        default_skill.mkdir(parents=True)
        (default_skill / "SKILL.md").write_text("---\nname: new-skill\n---\n", encoding="utf-8")

        resp = self.client.post(
            "/api/profiles",
            json={"name": "cloned", "clone_from_default": True},
        )

        assert resp.status_code == 200
        cloned_skill = get_hermes_home() / "profiles" / "cloned" / "skills" / "custom" / "new-skill" / "SKILL.md"
        assert cloned_skill.exists()
        profiles = {p["name"]: p for p in self.client.get("/api/profiles").json()["profiles"]}
        assert profiles["cloned"]["skill_count"] == 1

    def test_profiles_create_without_clone_seeds_bundled_skills(self, monkeypatch):
        from hermes_constants import get_hermes_home
        import hermes_cli.profiles as profiles_mod

        monkeypatch.setattr(profiles_mod, "create_wrapper_script", lambda name: None)

        def fake_seed(profile_dir, quiet=False):
            skill_dir = profile_dir / "skills" / "software-development" / "plan"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: plan\n---\n", encoding="utf-8")
            return {"copied": ["plan"]}

        monkeypatch.setattr(profiles_mod, "seed_profile_skills", fake_seed)

        resp = self.client.post(
            "/api/profiles",
            json={"name": "fresh", "clone_from_default": False},
        )

        assert resp.status_code == 200
        seeded_skill = get_hermes_home() / "profiles" / "fresh" / "skills" / "software-development" / "plan" / "SKILL.md"
        assert seeded_skill.exists()
        profiles = {p["name"]: p for p in self.client.get("/api/profiles").json()["profiles"]}
        assert profiles["fresh"]["skill_count"] == 1

    def test_profile_open_terminal_uses_macos_terminal(self, monkeypatch):
        from hermes_constants import get_hermes_home
        import hermes_cli.web_server as web_server

        (get_hermes_home() / "profiles" / "coder").mkdir(parents=True)
        calls = []
        monkeypatch.setattr(web_server.sys, "platform", "darwin")
        monkeypatch.setattr(web_server.subprocess, "Popen", lambda args, **kwargs: calls.append(args))

        resp = self.client.post("/api/profiles/coder/open-terminal")

        assert resp.status_code == 200
        assert calls
        assert calls[0][0] == "osascript"
        assert "coder setup" in " ".join(calls[0])

    def test_profile_open_terminal_uses_windows_cmd(self, monkeypatch):
        from hermes_constants import get_hermes_home
        import hermes_cli.web_server as web_server

        (get_hermes_home() / "profiles" / "coder").mkdir(parents=True)
        calls = []
        monkeypatch.setattr(web_server.sys, "platform", "win32")
        monkeypatch.setattr(web_server.subprocess, "Popen", lambda args, **kwargs: calls.append(args))

        resp = self.client.post("/api/profiles/coder/open-terminal")

        assert resp.status_code == 200
        assert calls
        assert calls[0][:4] == ["cmd.exe", "/c", "start", ""]
        assert calls[0][-1] == "coder setup"

    def test_profiles_create_rejects_invalid_name(self):
        resp = self.client.post("/api/profiles", json={"name": "Has Spaces"})
        assert resp.status_code == 400

    def test_profiles_delete_default_forbidden(self):
        resp = self.client.delete("/api/profiles/default")
        assert resp.status_code == 400

    def test_profiles_delete_not_found(self):
        resp = self.client.delete("/api/profiles/does-not-exist")
        assert resp.status_code == 404

    def test_profile_soul_round_trip(self, monkeypatch):
        import hermes_cli.profiles as profiles_mod
        monkeypatch.setattr(profiles_mod, "_cleanup_gateway_service", lambda *a, **kw: None)

        self.client.post("/api/profiles", json={"name": "soul-prof"})
        get1 = self.client.get("/api/profiles/soul-prof/soul")
        assert get1.status_code == 200
        assert get1.json()["exists"] is True

        put = self.client.put(
            "/api/profiles/soul-prof/soul",
            json={"content": "# Edited soul"},
        )
        assert put.status_code == 200

        got = self.client.get("/api/profiles/soul-prof/soul").json()
        assert got["content"] == "# Edited soul"

        self.client.delete("/api/profiles/soul-prof")

    def test_profile_soul_unknown_profile_404(self):
        resp = self.client.get("/api/profiles/nonexistent/soul")
        assert resp.status_code == 404

    def test_skills_list(self):
        resp = self.client.get("/api/skills")
        assert resp.status_code == 200
        skills = resp.json()
        assert isinstance(skills, list)
        if skills:
            assert "name" in skills[0]
            assert "enabled" in skills[0]

    def test_skills_list_includes_disabled_skills(self, monkeypatch):
        import tools.skills_tool as skills_tool
        import hermes_cli.skills_config as skills_config
        import hermes_cli.web_server as web_server

        def _fake_find_all_skills(*, skip_disabled=False):
            if skip_disabled:
                return [
                    {"name": "active-skill", "description": "active", "category": "demo"},
                    {"name": "disabled-skill", "description": "disabled", "category": "demo"},
                ]
            return [
                {"name": "active-skill", "description": "active", "category": "demo"},
            ]

        monkeypatch.setattr(skills_tool, "_find_all_skills", _fake_find_all_skills)
        monkeypatch.setattr(skills_config, "get_disabled_skills", lambda config: {"disabled-skill"})
        monkeypatch.setattr(web_server, "load_config", lambda: {"skills": {"disabled": ["disabled-skill"]}})

        resp = self.client.get("/api/skills")

        assert resp.status_code == 200
        assert resp.json() == [
            {
                "name": "active-skill",
                "description": "active",
                "category": "demo",
                "enabled": True,
            },
            {
                "name": "disabled-skill",
                "description": "disabled",
                "category": "demo",
                "enabled": False,
            },
        ]

    def test_toolsets_list(self):
        resp = self.client.get("/api/tools/toolsets")
        assert resp.status_code == 200
        toolsets = resp.json()
        assert isinstance(toolsets, list)
        if toolsets:
            assert "name" in toolsets[0]
            assert "label" in toolsets[0]
            assert "enabled" in toolsets[0]

    def test_toolsets_list_matches_cli_enabled_state(self, monkeypatch):
        import hermes_cli.tools_config as tools_config
        import toolsets as toolsets_module
        import hermes_cli.web_server as web_server

        monkeypatch.setattr(
            tools_config,
            "_get_effective_configurable_toolsets",
            lambda: [
                ("web", "🔍 Web Search & Scraping", "web_search, web_extract"),
                ("skills", "📚 Skills", "list, view, manage"),
                ("memory", "💾 Memory", "persistent memory across sessions"),
            ],
        )
        monkeypatch.setattr(
            tools_config,
            "_get_platform_tools",
            lambda config, platform, include_default_mcp_servers=False: {"web", "skills"},
        )
        monkeypatch.setattr(
            tools_config,
            "_toolset_has_keys",
            lambda ts_key, config=None: ts_key != "web",
        )
        monkeypatch.setattr(
            toolsets_module,
            "resolve_toolset",
            lambda name: {
                "web": ["web_search", "web_extract"],
                "skills": ["skills_list", "skill_view"],
                "memory": ["memory_read"],
            }[name],
        )
        monkeypatch.setattr(web_server, "load_config", lambda: {"platform_toolsets": {"cli": ["web", "skills"]}})

        resp = self.client.get("/api/tools/toolsets")

        assert resp.status_code == 200
        assert resp.json() == [
            {
                "name": "web",
                "label": "🔍 Web Search & Scraping",
                "description": "web_search, web_extract",
                "enabled": True,
                "available": True,
                "configured": False,
                "tools": ["web_extract", "web_search"],
            },
            {
                "name": "skills",
                "label": "📚 Skills",
                "description": "list, view, manage",
                "enabled": True,
                "available": True,
                "configured": True,
                "tools": ["skill_view", "skills_list"],
            },
            {
                "name": "memory",
                "label": "💾 Memory",
                "description": "persistent memory across sessions",
                "enabled": False,
                "available": False,
                "configured": True,
                "tools": ["memory_read"],
            },
        ]

    def test_config_raw_get(self):
        resp = self.client.get("/api/config/raw")
        assert resp.status_code == 200
        assert "yaml" in resp.json()

    def test_config_raw_put_valid(self):
        resp = self.client.put(
            "/api/config/raw",
            json={"yaml_text": "model: test\ntoolsets:\n  - all\n"},
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

    def test_config_raw_put_invalid(self):
        resp = self.client.put(
            "/api/config/raw",
            json={"yaml_text": "- this is a list not a dict"},
        )
        assert resp.status_code == 400

    def test_analytics_usage(self):
        resp = self.client.get("/api/analytics/usage?days=7")
        assert resp.status_code == 200
        data = resp.json()
        assert "daily" in data
        assert "by_model" in data
        assert "totals" in data
        assert "skills" in data
        assert isinstance(data["daily"], list)
        assert "total_sessions" in data["totals"]
        assert "total_api_calls" in data["totals"]
        assert data["skills"] == {
            "summary": {
                "total_skill_loads": 0,
                "total_skill_edits": 0,
                "total_skill_actions": 0,
                "distinct_skills_used": 0,
            },
            "top_skills": [],
        }

    def test_analytics_usage_includes_skill_breakdown(self):
        from hermes_state import SessionDB

        db = SessionDB()
        try:
            db.create_session(
                session_id="skills-analytics-test",
                source="cli",
                model="anthropic/claude-sonnet-4",
            )
            db.update_token_counts(
                "skills-analytics-test",
                input_tokens=120,
                output_tokens=45,
            )
            db.append_message(
                "skills-analytics-test",
                role="assistant",
                content="Loading and updating skills.",
                tool_calls=[
                    {
                        "function": {
                            "name": "skill_view",
                            "arguments": '{"name":"github-pr-workflow"}',
                        }
                    },
                    {
                        "function": {
                            "name": "skill_manage",
                            "arguments": '{"name":"github-code-review"}',
                        }
                    },
                ],
            )
        finally:
            db.close()

        resp = self.client.get("/api/analytics/usage?days=7")
        assert resp.status_code == 200

        data = resp.json()
        assert data["skills"]["summary"] == {
            "total_skill_loads": 1,
            "total_skill_edits": 1,
            "total_skill_actions": 2,
            "distinct_skills_used": 2,
        }
        assert len(data["skills"]["top_skills"]) == 2

        top_skill = data["skills"]["top_skills"][0]
        assert top_skill["skill"] == "github-pr-workflow"
        assert top_skill["view_count"] == 1
        assert top_skill["manage_count"] == 0
        assert top_skill["total_count"] == 1
        assert top_skill["last_used_at"] is not None

    def test_session_token_endpoint_removed(self):
        """GET /api/auth/session-token no longer exists."""
        resp = self.client.get("/api/auth/session-token")
        # Should not return a JSON token object
        assert resp.status_code in {200, 404}
        try:
            data = resp.json()
            assert "token" not in data
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Model context length: normalize/denormalize + /api/model/info
# ---------------------------------------------------------------------------


class TestModelContextLength:
    """Tests for model_context_length in normalize/denormalize and /api/model/info."""

    def test_normalize_extracts_context_length_from_dict(self):
        """normalize should surface context_length from model dict."""
        from hermes_cli.web_server import _normalize_config_for_web

        cfg = {
            "model": {
                "default": "anthropic/claude-opus-4.6",
                "provider": "openrouter",
                "context_length": 200000,
            }
        }
        result = _normalize_config_for_web(cfg)
        assert result["model"] == "anthropic/claude-opus-4.6"
        assert result["model_context_length"] == 200000

    def test_normalize_bare_string_model_yields_zero(self):
        """normalize should set model_context_length=0 for bare string model."""
        from hermes_cli.web_server import _normalize_config_for_web

        result = _normalize_config_for_web({"model": "anthropic/claude-sonnet-4"})
        assert result["model"] == "anthropic/claude-sonnet-4"
        assert result["model_context_length"] == 0

    def test_normalize_dict_without_context_length_yields_zero(self):
        """normalize should default to 0 when model dict has no context_length."""
        from hermes_cli.web_server import _normalize_config_for_web

        cfg = {"model": {"default": "test/model", "provider": "openrouter"}}
        result = _normalize_config_for_web(cfg)
        assert result["model_context_length"] == 0

    def test_normalize_non_int_context_length_yields_zero(self):
        """normalize should coerce non-int context_length to 0."""
        from hermes_cli.web_server import _normalize_config_for_web

        cfg = {"model": {"default": "test/model", "context_length": "invalid"}}
        result = _normalize_config_for_web(cfg)
        assert result["model_context_length"] == 0

    def test_denormalize_writes_context_length_into_model_dict(self):
        """denormalize should write model_context_length back into model dict."""
        from hermes_cli.web_server import _denormalize_config_from_web
        from hermes_cli.config import save_config

        # Set up disk config with model as a dict
        save_config({
            "model": {"default": "anthropic/claude-opus-4.6", "provider": "openrouter"}
        })

        result = _denormalize_config_from_web({
            "model": "anthropic/claude-opus-4.6",
            "model_context_length": 100000,
        })
        assert isinstance(result["model"], dict)
        assert result["model"]["context_length"] == 100000
        assert "model_context_length" not in result  # virtual field removed

    def test_denormalize_zero_removes_context_length(self):
        """denormalize with model_context_length=0 should remove context_length key."""
        from hermes_cli.web_server import _denormalize_config_from_web
        from hermes_cli.config import save_config

        save_config({
            "model": {
                "default": "anthropic/claude-opus-4.6",
                "provider": "openrouter",
                "context_length": 50000,
            }
        })

        result = _denormalize_config_from_web({
            "model": "anthropic/claude-opus-4.6",
            "model_context_length": 0,
        })
        assert isinstance(result["model"], dict)
        assert "context_length" not in result["model"]

    def test_denormalize_upgrades_bare_string_to_dict(self):
        """denormalize should upgrade bare string model to dict when context_length set."""
        from hermes_cli.web_server import _denormalize_config_from_web
        from hermes_cli.config import save_config

        # Disk has model as bare string
        save_config({"model": "anthropic/claude-sonnet-4"})

        result = _denormalize_config_from_web({
            "model": "anthropic/claude-sonnet-4",
            "model_context_length": 65000,
        })
        assert isinstance(result["model"], dict)
        assert result["model"]["default"] == "anthropic/claude-sonnet-4"
        assert result["model"]["context_length"] == 65000

    def test_denormalize_bare_string_stays_string_when_zero(self):
        """denormalize should keep bare string model as string when context_length=0."""
        from hermes_cli.web_server import _denormalize_config_from_web
        from hermes_cli.config import save_config

        save_config({"model": "anthropic/claude-sonnet-4"})

        result = _denormalize_config_from_web({
            "model": "anthropic/claude-sonnet-4",
            "model_context_length": 0,
        })
        assert result["model"] == "anthropic/claude-sonnet-4"

    def test_denormalize_coerces_string_context_length(self):
        """denormalize should handle string model_context_length from frontend."""
        from hermes_cli.web_server import _denormalize_config_from_web
        from hermes_cli.config import save_config

        save_config({
            "model": {"default": "test/model", "provider": "openrouter"}
        })

        result = _denormalize_config_from_web({
            "model": "test/model",
            "model_context_length": "32000",
        })
        assert isinstance(result["model"], dict)
        assert result["model"]["context_length"] == 32000


class TestModelContextLengthSchema:
    """Tests for model_context_length placement in CONFIG_SCHEMA."""

    def test_schema_has_model_context_length(self):
        from hermes_cli.web_server import CONFIG_SCHEMA
        assert "model_context_length" in CONFIG_SCHEMA

    def test_schema_model_context_length_after_model(self):
        """model_context_length should appear immediately after model in schema."""
        from hermes_cli.web_server import CONFIG_SCHEMA
        keys = list(CONFIG_SCHEMA.keys())
        model_idx = keys.index("model")
        assert keys[model_idx + 1] == "model_context_length"

    def test_schema_model_context_length_is_number(self):
        from hermes_cli.web_server import CONFIG_SCHEMA
        entry = CONFIG_SCHEMA["model_context_length"]
        assert entry["type"] == "number"
        assert "category" in entry


class TestModelInfoEndpoint:
    """Tests for GET /api/model/info endpoint."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")
        from hermes_cli.web_server import app
        self.client = TestClient(app)

    def test_model_info_returns_200(self):
        resp = self.client.get("/api/model/info")
        assert resp.status_code == 200
        data = resp.json()
        assert "model" in data
        assert "provider" in data
        assert "auto_context_length" in data
        assert "config_context_length" in data
        assert "effective_context_length" in data
        assert "capabilities" in data

    def test_model_info_with_dict_config(self, monkeypatch):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {
            "model": {
                "default": "anthropic/claude-opus-4.6",
                "provider": "openrouter",
                "context_length": 100000,
            }
        })

        with patch("agent.model_metadata.get_model_context_length", return_value=200000):
            resp = self.client.get("/api/model/info")

        data = resp.json()
        assert data["model"] == "anthropic/claude-opus-4.6"
        assert data["provider"] == "openrouter"
        assert data["auto_context_length"] == 200000
        assert data["config_context_length"] == 100000
        assert data["effective_context_length"] == 100000  # override wins

    def test_model_info_auto_detect_when_no_override(self, monkeypatch):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {
            "model": {"default": "anthropic/claude-opus-4.6", "provider": "openrouter"}
        })

        with patch("agent.model_metadata.get_model_context_length", return_value=200000):
            resp = self.client.get("/api/model/info")

        data = resp.json()
        assert data["auto_context_length"] == 200000
        assert data["config_context_length"] == 0
        assert data["effective_context_length"] == 200000  # auto wins

    def test_model_info_empty_model(self, monkeypatch):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {"model": ""})

        resp = self.client.get("/api/model/info")
        data = resp.json()
        assert data["model"] == ""
        assert data["effective_context_length"] == 0

    def test_model_info_bare_string_model(self, monkeypatch):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {
            "model": "anthropic/claude-sonnet-4"
        })

        with patch("agent.model_metadata.get_model_context_length", return_value=200000):
            resp = self.client.get("/api/model/info")

        data = resp.json()
        assert data["model"] == "anthropic/claude-sonnet-4"
        assert data["provider"] == ""
        assert data["config_context_length"] == 0
        assert data["effective_context_length"] == 200000

    def test_model_info_capabilities(self, monkeypatch):
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {
            "model": {"default": "anthropic/claude-opus-4.6", "provider": "openrouter"}
        })

        mock_caps = MagicMock()
        mock_caps.supports_tools = True
        mock_caps.supports_vision = True
        mock_caps.supports_reasoning = True
        mock_caps.context_window = 200000
        mock_caps.max_output_tokens = 32000
        mock_caps.model_family = "claude-opus"

        with patch("agent.model_metadata.get_model_context_length", return_value=200000), \
             patch("agent.models_dev.get_model_capabilities", return_value=mock_caps):
            resp = self.client.get("/api/model/info")

        caps = resp.json()["capabilities"]
        assert caps["supports_tools"] is True
        assert caps["supports_vision"] is True
        assert caps["supports_reasoning"] is True
        assert caps["max_output_tokens"] == 32000
        assert caps["model_family"] == "claude-opus"

    def test_model_info_graceful_on_metadata_error(self, monkeypatch):
        """Endpoint should return zeros on import/resolution errors, not 500."""
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "load_config", lambda: {
            "model": "some/obscure-model"
        })

        with patch("agent.model_metadata.get_model_context_length", side_effect=Exception("boom")):
            resp = self.client.get("/api/model/info")

        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_context_length"] == 0


# ---------------------------------------------------------------------------
# Gateway health probe tests
# ---------------------------------------------------------------------------


class TestProbeGatewayHealth:
    """Tests for _probe_gateway_health() — cross-container gateway detection."""

    def test_returns_false_when_no_url_configured(self, monkeypatch):
        """When GATEWAY_HEALTH_URL is unset, the probe returns (False, None)."""
        import hermes_cli.web_server as ws
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", None)
        alive, body = ws._probe_gateway_health()
        assert alive is False
        assert body is None

    def test_normalizes_url_with_health_suffix(self, monkeypatch):
        """If the user sets the URL to include /health, it's stripped to base."""
        import hermes_cli.web_server as ws
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642/health")
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_TIMEOUT", 1)
        # Both paths should fail (no server), but we verify they were constructed
        # correctly by checking the URLs attempted.
        calls = []
        original_urlopen = ws.urllib.request.urlopen

        def mock_urlopen(req, **kwargs):
            calls.append(req.full_url)
            raise ConnectionError("mock")

        monkeypatch.setattr(ws.urllib.request, "urlopen", mock_urlopen)
        alive, body = ws._probe_gateway_health()
        assert alive is False
        assert "http://gw:8642/health/detailed" in calls
        assert "http://gw:8642/health" in calls

    def test_normalizes_url_with_health_detailed_suffix(self, monkeypatch):
        """If the user sets the URL to include /health/detailed, it's stripped to base."""
        import hermes_cli.web_server as ws
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642/health/detailed")
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_TIMEOUT", 1)
        calls = []

        def mock_urlopen(req, **kwargs):
            calls.append(req.full_url)
            raise ConnectionError("mock")

        monkeypatch.setattr(ws.urllib.request, "urlopen", mock_urlopen)
        ws._probe_gateway_health()
        assert "http://gw:8642/health/detailed" in calls
        assert "http://gw:8642/health" in calls

    def test_successful_detailed_probe(self, monkeypatch):
        """Successful /health/detailed probe returns (True, body_dict)."""
        import hermes_cli.web_server as ws
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642")
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_TIMEOUT", 1)

        response_body = json.dumps({
            "status": "ok",
            "gateway_state": "running",
            "pid": 42,
        })

        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = response_body.encode()
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)

        monkeypatch.setattr(ws.urllib.request, "urlopen", lambda req, **kw: mock_resp)
        alive, body = ws._probe_gateway_health()
        assert alive is True
        assert body["status"] == "ok"
        assert body["pid"] == 42

    def test_detailed_fails_falls_back_to_simple_health(self, monkeypatch):
        """If /health/detailed fails, falls back to /health."""
        import hermes_cli.web_server as ws
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642")
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_TIMEOUT", 1)

        call_count = [0]

        def mock_urlopen(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise ConnectionError("detailed failed")
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.read.return_value = json.dumps({"status": "ok"}).encode()
            mock_resp.__enter__ = MagicMock(return_value=mock_resp)
            mock_resp.__exit__ = MagicMock(return_value=False)
            return mock_resp

        monkeypatch.setattr(ws.urllib.request, "urlopen", mock_urlopen)
        alive, body = ws._probe_gateway_health()
        assert alive is True
        assert body["status"] == "ok"
        assert call_count[0] == 2


class TestStatusRemoteGateway:
    """Tests for /api/status with remote gateway health fallback."""

    @pytest.fixture(autouse=True)
    def _setup_test_client(self):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
        self.client = TestClient(app)
        self.client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_status_falls_back_to_remote_probe(self, monkeypatch):
        """When local PID check fails and remote probe succeeds, gateway shows running."""
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "get_running_pid", lambda: None)
        monkeypatch.setattr(ws, "read_runtime_status", lambda: None)
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642")
        monkeypatch.setattr(ws, "_probe_gateway_health", lambda: (True, {
            "status": "ok",
            "gateway_state": "running",
            "platforms": {"telegram": {"state": "connected"}},
            "pid": 999,
        }))

        resp = self.client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["gateway_running"] is True
        assert data["gateway_pid"] == 999
        assert data["gateway_state"] == "running"
        assert data["gateway_health_url"] == "http://gw:8642"

    def test_status_remote_probe_not_attempted_when_local_pid_found(self, monkeypatch):
        """When local PID check succeeds, the remote probe is never called."""
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "get_running_pid", lambda: 1234)
        monkeypatch.setattr(ws, "read_runtime_status", lambda: {
            "gateway_state": "running",
            "platforms": {},
        })
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642")
        probe_called = [False]
        original = ws._probe_gateway_health

        def track_probe():
            probe_called[0] = True
            return original()

        monkeypatch.setattr(ws, "_probe_gateway_health", track_probe)

        resp = self.client.get("/api/status")
        assert resp.status_code == 200
        assert not probe_called[0]

    def test_status_remote_probe_not_attempted_when_no_url(self, monkeypatch):
        """When GATEWAY_HEALTH_URL is unset, no probe is attempted."""
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "get_running_pid", lambda: None)
        monkeypatch.setattr(ws, "read_runtime_status", lambda: None)
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", None)

        resp = self.client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["gateway_running"] is False
        assert data["gateway_health_url"] is None

    def test_status_remote_running_null_pid(self, monkeypatch):
        """Remote gateway running but PID not in response — pid should be None."""
        import hermes_cli.web_server as ws

        monkeypatch.setattr(ws, "get_running_pid", lambda: None)
        monkeypatch.setattr(ws, "read_runtime_status", lambda: None)
        monkeypatch.setattr(ws, "_GATEWAY_HEALTH_URL", "http://gw:8642")
        monkeypatch.setattr(ws, "_probe_gateway_health", lambda: (True, {
            "status": "ok",
        }))

        resp = self.client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["gateway_running"] is True
        assert data["gateway_pid"] is None
        assert data["gateway_state"] == "running"


# ---------------------------------------------------------------------------
# Dashboard theme normaliser tests
# ---------------------------------------------------------------------------


class TestNormaliseThemeDefinition:
    """Tests for _normalise_theme_definition() — parses YAML theme files."""

    def test_rejects_missing_name(self):
        from hermes_cli.web_server import _normalise_theme_definition
        assert _normalise_theme_definition({}) is None
        assert _normalise_theme_definition({"name": ""}) is None
        assert _normalise_theme_definition({"name": "   "}) is None

    def test_rejects_non_dict(self):
        from hermes_cli.web_server import _normalise_theme_definition
        assert _normalise_theme_definition("string") is None
        assert _normalise_theme_definition(None) is None
        assert _normalise_theme_definition([1, 2, 3]) is None

    def test_loose_colors_shorthand(self):
        """Bare hex strings under `colors` parse as {hex, alpha=1.0}."""
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({
            "name": "loose",
            "colors": {"background": "#000000", "midground": "#ffffff"},
        })
        assert result is not None
        assert result["palette"]["background"] == {"hex": "#000000", "alpha": 1.0}
        assert result["palette"]["midground"] == {"hex": "#ffffff", "alpha": 1.0}
        # foreground falls back to default (transparent white)
        assert result["palette"]["foreground"]["hex"] == "#ffffff"
        assert result["palette"]["foreground"]["alpha"] == 0.0

    def test_full_palette_form(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({
            "name": "full",
            "palette": {
                "background": {"hex": "#0a1628", "alpha": 1.0},
                "midground": {"hex": "#a8d0ff", "alpha": 0.9},
                "warmGlow": "rgba(255, 0, 0, 0.5)",
                "noiseOpacity": 0.5,
            },
        })
        assert result["palette"]["background"]["hex"] == "#0a1628"
        assert result["palette"]["midground"]["alpha"] == 0.9
        assert result["palette"]["warmGlow"] == "rgba(255, 0, 0, 0.5)"
        assert result["palette"]["noiseOpacity"] == 0.5

    def test_default_typography_applied_when_missing(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({"name": "minimal"})
        typo = result["typography"]
        assert "fontSans" in typo
        assert "fontMono" in typo
        assert typo["baseSize"] == "15px"
        assert typo["lineHeight"] == "1.55"
        assert typo["letterSpacing"] == "0"

    def test_partial_typography_merges_with_defaults(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({
            "name": "partial",
            "typography": {
                "fontSans": "MyFont, sans-serif",
                "baseSize": "12px",
            },
        })
        assert result["typography"]["fontSans"] == "MyFont, sans-serif"
        assert result["typography"]["baseSize"] == "12px"
        # fontMono defaulted
        assert "monospace" in result["typography"]["fontMono"]

    def test_layout_defaults(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({"name": "minimal"})
        assert result["layout"]["radius"] == "0.5rem"
        assert result["layout"]["density"] == "comfortable"

    def test_invalid_density_falls_back(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({
            "name": "bad",
            "layout": {"density": "ultra-spacious"},
        })
        assert result["layout"]["density"] == "comfortable"

    def test_valid_densities_accepted(self):
        from hermes_cli.web_server import _normalise_theme_definition
        for d in ("compact", "comfortable", "spacious"):
            r = _normalise_theme_definition({"name": "x", "layout": {"density": d}})
            assert r["layout"]["density"] == d

    def test_color_overrides_filter_unknown_keys(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({
            "name": "o",
            "colorOverrides": {
                "card": "#123456",
                "fakeToken": "#abcdef",
                "primary": 42,  # non-string rejected
                "destructive": "#ff0000",
            },
        })
        assert result["colorOverrides"] == {
            "card": "#123456",
            "destructive": "#ff0000",
        }

    def test_color_overrides_omitted_when_empty(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({"name": "x"})
        assert "colorOverrides" not in result

    def test_alpha_clamped_to_unit_range(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "c",
            "palette": {"background": {"hex": "#000", "alpha": 99.5}},
        })
        assert r["palette"]["background"]["alpha"] == 1.0
        r2 = _normalise_theme_definition({
            "name": "c",
            "palette": {"background": {"hex": "#000", "alpha": -5}},
        })
        assert r2["palette"]["background"]["alpha"] == 0.0

    def test_invalid_alpha_uses_default(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "c",
            "palette": {"background": {"hex": "#000", "alpha": "not a number"}},
        })
        assert r["palette"]["background"]["alpha"] == 1.0


class TestDiscoverUserThemes:
    """Tests for _discover_user_themes() — scans ~/.hermes/dashboard-themes/."""

    def test_returns_empty_when_dir_missing(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        from hermes_cli import web_server
        assert web_server._discover_user_themes() == []

    def test_loads_and_normalises_yaml(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        themes_dir = tmp_path / "dashboard-themes"
        themes_dir.mkdir()
        (themes_dir / "ocean.yaml").write_text(
            "name: ocean\n"
            "label: Ocean\n"
            "palette:\n"
            "  background:\n"
            "    hex: \"#0a1628\"\n"
            "    alpha: 1.0\n"
            "layout:\n"
            "  density: spacious\n"
        )
        from hermes_cli import web_server
        results = web_server._discover_user_themes()
        assert len(results) == 1
        assert results[0]["name"] == "ocean"
        assert results[0]["label"] == "Ocean"
        assert results[0]["palette"]["background"]["hex"] == "#0a1628"
        assert results[0]["layout"]["density"] == "spacious"
        # defaults filled in
        assert "fontSans" in results[0]["typography"]

    def test_malformed_yaml_skipped(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        themes_dir = tmp_path / "dashboard-themes"
        themes_dir.mkdir()
        (themes_dir / "bad.yaml").write_text("::: not valid yaml :::\n\tindent wrong")
        (themes_dir / "nameless.yaml").write_text("label: No Name Here\n")
        (themes_dir / "ok.yaml").write_text("name: ok\n")
        from hermes_cli import web_server
        results = web_server._discover_user_themes()
        names = [r["name"] for r in results]
        assert "ok" in names
        assert "bad" not in names  # malformed YAML
        assert len(results) == 1  # only the valid one


class TestNormaliseThemeExtensions:
    """Tests for the extended normaliser fields (assets, customCSS,
    componentStyles, layoutVariant) — the surfaces themes use to reskin
    the dashboard without shipping code."""

    def test_layout_variant_defaults_to_standard(self):
        from hermes_cli.web_server import _normalise_theme_definition
        result = _normalise_theme_definition({"name": "t"})
        assert result["layoutVariant"] == "standard"

    def test_layout_variant_accepts_known_values(self):
        from hermes_cli.web_server import _normalise_theme_definition
        for variant in ("standard", "cockpit", "tiled"):
            r = _normalise_theme_definition({"name": "t", "layoutVariant": variant})
            assert r["layoutVariant"] == variant

    def test_layout_variant_rejects_unknown(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({"name": "t", "layoutVariant": "warship"})
        assert r["layoutVariant"] == "standard"
        r2 = _normalise_theme_definition({"name": "t", "layoutVariant": 12})
        assert r2["layoutVariant"] == "standard"

    def test_assets_named_slots_passthrough(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "t",
            "assets": {
                "bg": "https://example.com/bg.jpg",
                "hero": "linear-gradient(180deg, red, blue)",
                "crest": "/ds-assets/crest.svg",
                "logo": "  ",  # whitespace-only — dropped
                "notAKnownKey": "ignored",
            },
        })
        assert r["assets"]["bg"] == "https://example.com/bg.jpg"
        assert r["assets"]["hero"].startswith("linear-gradient")
        assert r["assets"]["crest"] == "/ds-assets/crest.svg"
        assert "logo" not in r["assets"]  # whitespace-only rejected
        assert "notAKnownKey" not in r["assets"]  # unknown slot ignored

    def test_assets_custom_block(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "t",
            "assets": {
                "custom": {
                    "scan-lines": "/img/scan.png",
                    "my_overlay": "/img/ov.png",
                    "bad key!": "x",  # non-alnum key — rejected
                    "empty": "",        # empty value — rejected
                },
            },
        })
        assert r["assets"]["custom"] == {
            "scan-lines": "/img/scan.png",
            "my_overlay": "/img/ov.png",
        }

    def test_assets_absent_means_no_field(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({"name": "t"})
        assert "assets" not in r

    def test_custom_css_passthrough_and_capped(self):
        from hermes_cli.web_server import _normalise_theme_definition
        # Small CSS passes through verbatim.
        r = _normalise_theme_definition({
            "name": "t",
            "customCSS": "body { color: red; }",
        })
        assert r["customCSS"] == "body { color: red; }"

        # 40 KiB of CSS gets clipped to the 32 KiB cap.
        huge = "/* x */ " * (40 * 1024 // 8 + 10)
        r2 = _normalise_theme_definition({"name": "t", "customCSS": huge})
        assert len(r2["customCSS"]) <= 32 * 1024

    def test_custom_css_empty_dropped(self):
        from hermes_cli.web_server import _normalise_theme_definition
        for val in ("", "   \n\t", None):
            r = _normalise_theme_definition({"name": "t", "customCSS": val})
            assert "customCSS" not in r

    def test_component_styles_per_bucket(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "t",
            "componentStyles": {
                "card": {
                    "clipPath": "polygon(0 0, 100% 0, 100% 100%, 0 100%)",
                    "boxShadow": "inset 0 0 0 1px red",
                    "bad prop!": "ignored",  # non-alnum prop rejected
                },
                "header": {"background": "linear-gradient(red, blue)"},
                "rogueBucket": {"foo": "bar"},  # not a known bucket — rejected
            },
        })
        assert r["componentStyles"]["card"] == {
            "clipPath": "polygon(0 0, 100% 0, 100% 100%, 0 100%)",
            "boxShadow": "inset 0 0 0 1px red",
        }
        assert r["componentStyles"]["header"]["background"].startswith("linear-gradient")
        assert "rogueBucket" not in r["componentStyles"]

    def test_component_styles_empty_buckets_dropped(self):
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "t",
            "componentStyles": {
                "card": {},        # empty — dropped entirely
                "header": {"bad prop!": "ignored"},  # all props rejected — bucket dropped
                "footer": {"background": "black"},
            },
        })
        assert "card" not in r.get("componentStyles", {})
        assert "header" not in r.get("componentStyles", {})
        assert r["componentStyles"]["footer"]["background"] == "black"

    def test_component_styles_accepts_numeric_values(self):
        """Numeric values (e.g. opacity: 0.8) are coerced to strings."""
        from hermes_cli.web_server import _normalise_theme_definition
        r = _normalise_theme_definition({
            "name": "t",
            "componentStyles": {"card": {"opacity": 0.8, "zIndex": 5}},
        })
        assert r["componentStyles"]["card"] == {"opacity": "0.8", "zIndex": "5"}


class TestPluginAPIAuth:
    """Tests that plugin API routes require the session token (issue #19533)."""

    @pytest.fixture(autouse=True)
    def _setup_test_client(self, monkeypatch, _isolate_hermes_home):
        """Create a TestClient without the session token header."""
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        import hermes_state
        from hermes_constants import get_hermes_home
        from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")

        self.client = TestClient(app)
        self.auth_client = TestClient(app)
        self.auth_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    def test_plugin_route_requires_auth(self):
        """Plugin API routes should return 401 without a valid session token."""
        # Use a known plugin route (kanban board)
        resp = self.client.get("/api/plugins/kanban/board")
        assert resp.status_code == 401

    def test_plugin_route_allows_auth(self):
        """Plugin API routes should work with a valid session token.

        Use the kanban board route, a stable plugin GET that's loaded in tests.
        With a valid token the handler should run (200); without one the
        middleware should 401 before the handler is reached.
        """
        # Without auth: middleware blocks before reaching the handler.
        resp = self.client.get("/api/plugins/kanban/board")
        assert resp.status_code == 401

        # With auth: handler runs.
        resp = self.auth_client.get("/api/plugins/kanban/board")
        assert resp.status_code == 200

    def test_plugin_post_requires_auth(self):
        """Plugin POST routes should return 401 without a valid session token."""
        resp = self.client.post("/api/plugins/kanban/tasks", json={"title": "test"})
        assert resp.status_code == 401

    def test_plugin_patch_requires_auth(self):
        """Plugin PATCH routes should return 401 without a valid session token.

        PATCH is the mutation method most commonly used by the dashboard for
        kanban task edits — explicitly cover it so a future middleware
        regression that whitelists non-GET methods can't sneak through.
        """
        resp = self.client.patch(
            "/api/plugins/kanban/tasks/t_fake",
            json={"title": "renamed"},
        )
        assert resp.status_code == 401

    def test_plugin_delete_requires_auth(self):
        """Plugin DELETE routes should return 401 without a valid session token."""
        resp = self.client.delete("/api/plugins/kanban/tasks/t_fake")
        assert resp.status_code == 401

    def test_non_kanban_plugin_route_requires_auth(self):
        """Auth must be plugin-agnostic, not kanban-specific.

        The middleware fix is at the gate level (no per-plugin allowlist),
        so any plugin's API surface — kanban, hermes-achievements, future
        plugins — must require the session token. Hit a non-kanban plugin
        path to lock that in.
        """
        # Real plugin path (hermes-achievements is loaded by default).
        resp = self.client.get("/api/plugins/hermes-achievements/overview")
        assert resp.status_code == 401
        # Same for an arbitrary plugin namespace that doesn't even exist —
        # the middleware should 401 before routing decides 404, so an
        # attacker can't fingerprint plugin names by status codes.
        resp = self.client.get("/api/plugins/_definitely_not_a_plugin_/anything")
        assert resp.status_code == 401

    def test_plugin_websocket_unaffected_by_http_middleware(self):
        """The kanban /events WebSocket has its own ``?token=`` check;
        the HTTP middleware change must not start gating WS upgrades.

        Starlette doesn't run HTTP middleware on WebSocket upgrades anyway,
        but pin the behavior so a future refactor that moves auth into a
        shared layer can't silently break the WS auth contract.
        """
        from starlette.websockets import WebSocketDisconnect
        from hermes_cli.web_server import _SESSION_TOKEN

        # Without a token the WS endpoint must close the upgrade itself
        # (its own _check_ws_token), NOT 401 from the HTTP middleware.
        try:
            with self.client.websocket_connect(
                "/api/plugins/kanban/events"
            ):
                pass  # if we got here without disconnect, the WS accepted us
        except WebSocketDisconnect:
            pass  # expected — WS endpoint rejected via its own check
        except Exception:
            # The kanban plugin may not be mounted in this test environment,
            # in which case the route doesn't exist at all (3xx/4xx during
            # upgrade). That's fine for this regression — it only matters
            # that the HTTP middleware didn't start intercepting WS upgrades.
            pass


class TestDashboardPluginManifestExtensions:
    """Tests for the extended plugin manifest fields (tab.override,
    tab.hidden, slots) read by _discover_dashboard_plugins()."""

    def _write_plugin(self, tmp_path, name, manifest):
        import json
        plug_dir = tmp_path / "plugins" / name / "dashboard"
        plug_dir.mkdir(parents=True)
        (plug_dir / "manifest.json").write_text(json.dumps(manifest))
        return plug_dir

    def test_override_and_hidden_carried_through(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_plugin(tmp_path, "skin-home", {
            "name": "skin-home",
            "label": "Skin Home",
            "tab": {"path": "/skin-home", "override": "/", "hidden": True},
            "slots": ["sidebar", "header-left"],
            "entry": "dist/index.js",
        })
        from hermes_cli import web_server
        # Bust the process-level cache so the test plugin is picked up.
        web_server._dashboard_plugins_cache = None
        plugins = web_server._get_dashboard_plugins(force_rescan=True)
        entry = next(p for p in plugins if p["name"] == "skin-home")
        assert entry["tab"]["override"] == "/"
        assert entry["tab"]["hidden"] is True
        assert entry["slots"] == ["sidebar", "header-left"]

    def test_override_requires_leading_slash(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_plugin(tmp_path, "bad-override", {
            "name": "bad-override",
            "label": "Bad",
            "tab": {"path": "/bad", "override": "no-leading-slash"},
            "entry": "dist/index.js",
        })
        from hermes_cli import web_server
        web_server._dashboard_plugins_cache = None
        plugins = web_server._get_dashboard_plugins(force_rescan=True)
        entry = next(p for p in plugins if p["name"] == "bad-override")
        assert "override" not in entry["tab"]

    def test_slots_default_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_plugin(tmp_path, "no-slots", {
            "name": "no-slots",
            "label": "No Slots",
            "tab": {"path": "/no-slots"},
            "entry": "dist/index.js",
        })
        from hermes_cli import web_server
        web_server._dashboard_plugins_cache = None
        plugins = web_server._get_dashboard_plugins(force_rescan=True)
        entry = next(p for p in plugins if p["name"] == "no-slots")
        assert entry["slots"] == []
        assert "hidden" not in entry["tab"]
        assert "override" not in entry["tab"]

    def test_slots_filters_non_string_entries(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_plugin(tmp_path, "mixed-slots", {
            "name": "mixed-slots",
            "label": "Mixed",
            "tab": {"path": "/mixed-slots"},
            "slots": ["sidebar", "", 42, None, "header-right"],
            "entry": "dist/index.js",
        })
        from hermes_cli import web_server
        web_server._dashboard_plugins_cache = None
        plugins = web_server._get_dashboard_plugins(force_rescan=True)
        entry = next(p for p in plugins if p["name"] == "mixed-slots")
        assert entry["slots"] == ["sidebar", "header-right"]

    def test_page_scoped_slots_preserved(self, tmp_path, monkeypatch):
        """Page-scoped slot names (e.g. ``sessions:top``) round-trip through
        the manifest loader untouched.  The backend has no allowlist — the
        frontend ``<PluginSlot name="...">`` placements decide what actually
        renders — but the loader must not mangle colons in slot names."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_plugin(tmp_path, "page-slots", {
            "name": "page-slots",
            "label": "Page Slots",
            "tab": {"path": "/page-slots", "hidden": True},
            "slots": [
                "sessions:top",
                "analytics:bottom",
                "logs:top",
                "skills:bottom",
                "config:top",
                "env:bottom",
                "docs:top",
                "cron:bottom",
                "chat:top",
            ],
            "entry": "dist/index.js",
        })
        from hermes_cli import web_server
        web_server._dashboard_plugins_cache = None
        plugins = web_server._get_dashboard_plugins(force_rescan=True)
        entry = next(p for p in plugins if p["name"] == "page-slots")
        assert entry["slots"] == [
            "sessions:top",
            "analytics:bottom",
            "logs:top",
            "skills:bottom",
            "config:top",
            "env:bottom",
            "docs:top",
            "cron:bottom",
            "chat:top",
        ]


# ---------------------------------------------------------------------------
# /api/pty WebSocket — terminal bridge for the dashboard "Chat" tab.
#
# These tests drive the endpoint with a tiny fake command (typically ``cat``
# or ``sh -c 'printf …'``) instead of the real ``hermes --tui`` binary.  The
# endpoint resolves its argv through ``_resolve_chat_argv``, so tests
# monkeypatch that hook.
# ---------------------------------------------------------------------------

import sys


skip_on_windows = pytest.mark.skipif(
    sys.platform.startswith("win"), reason="PTY bridge is POSIX-only"
)


@skip_on_windows
class TestPtyWebSocket:
    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch, _isolate_hermes_home):
        from starlette.testclient import TestClient

        import hermes_cli.web_server as ws

        # Avoid exec'ing the actual TUI in tests: every test below installs
        # its own fake argv via ``ws._resolve_chat_argv``.
        self.ws_module = ws
        monkeypatch.setattr(ws, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", True)
        self.token = ws._SESSION_TOKEN
        self.client = TestClient(ws.app)

    def _url(self, token: str | None = None, **params: str) -> str:
        tok = token if token is not None else self.token
        # TestClient.websocket_connect takes the path; it reconstructs the
        # query string, so we pass it inline.
        from urllib.parse import urlencode

        q = {"token": tok, **params}
        return f"/api/pty?{urlencode(q)}"

    def test_rejects_when_embedded_chat_disabled(self, monkeypatch):
        monkeypatch.setattr(self.ws_module, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", False)
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as exc:
            with self.client.websocket_connect(self._url()):
                pass
        assert exc.value.code == 4403

    def test_rejects_missing_token(self, monkeypatch):
        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            lambda resume=None, sidecar_url=None: (["/bin/cat"], None, None),
        )
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as exc:
            with self.client.websocket_connect("/api/pty"):
                pass
        assert exc.value.code == 4401

    def test_rejects_bad_token(self, monkeypatch):
        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            lambda resume=None, sidecar_url=None: (["/bin/cat"], None, None),
        )
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as exc:
            with self.client.websocket_connect(self._url(token="wrong")):
                pass
        assert exc.value.code == 4401

    def test_streams_child_stdout_to_client(self, monkeypatch):
        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            lambda resume=None, sidecar_url=None: (
                ["/bin/sh", "-c", "printf hermes-ws-ok"],
                None,
                None,
            ),
        )
        with self.client.websocket_connect(self._url()) as conn:
            # Drain frames until we see the needle or time out.  TestClient's
            # recv_bytes blocks; loop until we have the signal byte string.
            buf = b""
            import time

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                try:
                    frame = conn.receive_bytes()
                except Exception:
                    break
                if frame:
                    buf += frame
                if b"hermes-ws-ok" in buf:
                    break
            assert b"hermes-ws-ok" in buf

    def test_client_input_reaches_child_stdin(self, monkeypatch):
        # ``cat`` echoes stdin back, so a write → read round-trip proves
        # the full duplex path.
        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            lambda resume=None, sidecar_url=None: (["/bin/cat"], None, None),
        )
        with self.client.websocket_connect(self._url()) as conn:
            conn.send_bytes(b"round-trip-payload\n")
            buf = b""
            import time

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                frame = conn.receive_bytes()
                if frame:
                    buf += frame
                if b"round-trip-payload" in buf:
                    break
            assert b"round-trip-payload" in buf

    def test_resize_escape_is_forwarded(self, monkeypatch):
        # Resize escape gets intercepted and applied via TIOCSWINSZ, then the
        # child reads the TTY ioctl directly. Avoid tput because CI may not set
        # TERM for non-interactive shells.
        import sys

        winsize_script = (
            "import fcntl, struct, termios, time; "
            "time.sleep(0.15); "
            "rows, cols, *_ = struct.unpack('HHHH', "
            "fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\0' * 8)); "
            "print(cols); print(rows)"
        )
        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            # sleep gives the test time to push the resize before the child reads the ioctl.
            lambda resume=None, sidecar_url=None: (
                [sys.executable, "-c", winsize_script],
                None,
                None,
            ),
        )
        with self.client.websocket_connect(self._url()) as conn:
            conn.send_text("\x1b[RESIZE:99;41]")
            buf = b""
            import time

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                frame = conn.receive_bytes()
                if frame:
                    buf += frame
                if b"99" in buf and b"41" in buf:
                    break
            assert b"99" in buf and b"41" in buf

    def test_unavailable_platform_closes_with_message(self, monkeypatch):
        from hermes_cli.pty_bridge import PtyUnavailableError

        def _raise(argv, **kwargs):
            raise PtyUnavailableError("pty missing for tests")

        monkeypatch.setattr(
            self.ws_module,
            "_resolve_chat_argv",
            lambda resume=None, sidecar_url=None: (["/bin/cat"], None, None),
        )
        # Patch PtyBridge.spawn at the web_server module's binding.
        import hermes_cli.web_server as ws_mod

        monkeypatch.setattr(ws_mod.PtyBridge, "spawn", classmethod(lambda cls, *a, **k: _raise(*a, **k)))

        with self.client.websocket_connect(self._url()) as conn:
            # Expect a final text frame with the error message, then close.
            msg = conn.receive_text()
            assert "pty missing" in msg or "unavailable" in msg.lower() or "pty" in msg.lower()

    def test_resume_parameter_is_forwarded_to_argv(self, monkeypatch):
        captured: dict = {}

        def fake_resolve(resume=None, sidecar_url=None):
            captured["resume"] = resume
            return (["/bin/sh", "-c", "printf resume-arg-ok"], None, None)

        monkeypatch.setattr(self.ws_module, "_resolve_chat_argv", fake_resolve)

        with self.client.websocket_connect(self._url(resume="sess-42")) as conn:
            # Drain briefly so the handler actually invokes the resolver.
            try:
                conn.receive_bytes()
            except Exception:
                pass
        assert captured.get("resume") == "sess-42"

    def test_channel_param_propagates_sidecar_url(self, monkeypatch):
        """When /api/pty is opened with ?channel=, the PTY child gets a
        HERMES_TUI_SIDECAR_URL env var pointing back at /api/pub on the
        same channel — which is how tool events reach the dashboard sidebar."""
        captured: dict = {}

        def fake_resolve(resume=None, sidecar_url=None):
            captured["sidecar_url"] = sidecar_url
            return (["/bin/sh", "-c", "printf sidecar-ok"], None, None)

        monkeypatch.setattr(self.ws_module, "_resolve_chat_argv", fake_resolve)
        monkeypatch.setattr(
            self.ws_module.app.state, "bound_host", "127.0.0.1", raising=False
        )
        monkeypatch.setattr(
            self.ws_module.app.state, "bound_port", 9119, raising=False
        )

        with self.client.websocket_connect(self._url(channel="abc-123")) as conn:
            try:
                conn.receive_bytes()
            except Exception:
                pass

        url = captured.get("sidecar_url") or ""
        assert url.startswith("ws://127.0.0.1:9119/api/pub?")
        assert "channel=abc-123" in url
        assert "token=" in url

    def test_pub_broadcasts_to_events_subscribers(self, monkeypatch):
        """Frame written to /api/pub is rebroadcast verbatim to every
        /api/events subscriber on the same channel."""
        import time
        from urllib.parse import urlencode
        from hermes_cli import web_server as ws_mod

        qs = urlencode({"token": self.token, "channel": "broadcast-test"})
        pub_path = f"/api/pub?{qs}"
        sub_path = f"/api/events?{qs}"

        with self.client.websocket_connect(sub_path) as sub:
            # Wait for the subscriber to be registered on the server side.
            # websocket_connect returns when ws.accept() completes, but the
            # server adds us to ``_event_channels`` in a follow-up await,
            # so a publish immediately after connect can race ahead of the
            # subscriber registration and the message is dropped.
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if ws_mod._event_channels.get("broadcast-test"):
                    break
                time.sleep(0.01)
            else:
                raise AssertionError(
                    "subscriber did not register on channel within 5s"
                )

            with self.client.websocket_connect(pub_path) as pub:
                pub.send_text('{"type":"tool.start","payload":{"tool_id":"t1"}}')
                received = sub.receive_text()

        assert "tool.start" in received
        assert '"tool_id":"t1"' in received

    def test_events_rejects_missing_channel(self):
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as exc:
            with self.client.websocket_connect(
                f"/api/events?token={self.token}"
            ):
                pass
        assert exc.value.code == 4400


class TestGatewayWebSocket:
    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch, _isolate_hermes_home):
        from starlette.testclient import TestClient

        import hermes_cli.web_server as ws

        self.ws_module = ws
        self.token = ws._SESSION_TOKEN
        self.client = TestClient(ws.app)

    def _url(self, token: str | None = None) -> str:
        from urllib.parse import urlencode

        tok = token if token is not None else self.token
        return f"/api/ws?{urlencode({'token': tok})}"

    def test_gateway_ws_stays_available_when_embedded_chat_disabled(self, monkeypatch):
        monkeypatch.setattr(self.ws_module, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", False)

        async def fake_handle_ws(ws):
            await ws.accept()
            await ws.send_text("gateway-sidecar-ok")
            await ws.close()

        monkeypatch.setattr("tui_gateway.ws.handle_ws", fake_handle_ws)

        with self.client.websocket_connect(self._url()) as conn:
            assert conn.receive_text() == "gateway-sidecar-ok"
