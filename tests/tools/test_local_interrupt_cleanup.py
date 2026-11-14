"""Regression tests for _wait_for_process subprocess cleanup on exception exit.

When the poll loop exits via KeyboardInterrupt or SystemExit (SIGTERM via
cli.py signal handler, SIGINT on the main thread in non-interactive -q mode,
or explicit sys.exit from some caller), the child subprocess must be killed
before the exception propagates — otherwise the local backend's use of
os.setsid leaves an orphan with PPID=1.

The live repro that motivated this: hermes chat -q ... 'sleep 300', SIGTERM
to the python process, sleep 300 survived with PPID=1 for the full 300 s
because _wait_for_process never got to call _kill_process before python
died.  See commit message for full context.
"""
import os
import shutil
import signal
import subprocess
import time
from types import SimpleNamespace

import pytest

from tools.environments import base
from tools.environments.local import LocalEnvironment


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "logs").mkdir(exist_ok=True)


def _pgid_still_alive(pgid: int) -> bool:
    """Return True if any process in the given process group is still alive."""
    try:
        os.killpg(pgid, 0)  # signal 0 = existence check
        return True
    except ProcessLookupError:
        return False


def _process_group_snapshot(pgid: int) -> str:
    """Return a process-table snapshot for diagnostics."""
    return subprocess.run(
        ["ps", "-o", "pid,ppid,pgid,stat,cmd", "-g", str(pgid)],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()


def _wait_for_pgid_exit(pgid: int, timeout: float = 10.0) -> bool:
    """Wait for a process group to disappear under loaded xdist hosts."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pgid_still_alive(pgid):
            return True
        time.sleep(0.1)
    return not _pgid_still_alive(pgid)


class _RealPopenHandle:
    """Minimal ProcessHandle facade over a real ``subprocess.Popen``.

    ``_wait_for_process`` only needs ``poll``, ``wait``, ``kill``, ``pid`` and
    a fileno-backed ``stdout``; wrapping a real child keeps the cleanup path
    (real ``os.killpg`` against a real process group) under test.
    """

    def __init__(self, popen: "subprocess.Popen"):
        self._popen = popen
        self.pid = popen.pid
        self.stdout = popen.stdout

    def poll(self):
        return self._popen.poll()

    def wait(self, timeout=None):
        return self._popen.wait(timeout=timeout)

    def kill(self):
        self._popen.kill()


def test_kill_process_uses_cached_pgid_if_wrapper_already_exited(monkeypatch):
    """If the shell wrapper exits before cleanup, still kill its process group.

    Without the cached pgid fallback, ``os.getpgid(proc.pid)`` raises for the
    dead wrapper and cleanup falls back to ``proc.kill()``, which cannot reach
    orphaned grandchildren still running in the original process group.
    """
    env = object.__new__(LocalEnvironment)
    proc = SimpleNamespace(
        pid=12345,
        _hermes_pgid=67890,
        poll=lambda: 0,
        kill=lambda: None,
    )
    killpg_calls = []

    def fake_getpgid(_pid):
        raise ProcessLookupError

    def fake_killpg(pgid, sig):
        killpg_calls.append((pgid, sig))
        if sig == 0:
            raise ProcessLookupError

    monkeypatch.setattr(os, "getpgid", fake_getpgid)
    monkeypatch.setattr(os, "killpg", fake_killpg)

    env._kill_process(proc)

    assert killpg_calls == [(67890, signal.SIGTERM), (67890, 0)]


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group semantics only")
@pytest.mark.skipif(shutil.which("sleep") is None, reason="needs a `sleep` binary")
def test_wait_for_process_kills_subprocess_on_keyboardinterrupt(monkeypatch, tmp_path):
    """When KeyboardInterrupt arrives mid-poll, the subprocess group must be
    killed before the exception is re-raised.

    The interrupt is injected deterministically (the poll loop's sleep raises it)
    instead of via ``ctypes.PyThreadState_SetAsyncExc`` from a helper thread:
    async exceptions are only delivered when the target thread re-enters the
    eval loop, so on a loaded CI host the interrupt could land on the drain
    thread instead, leaving the worker alive and the test red for the wrong
    reason (observed on Linux shard 4/4).
    """
    env = object.__new__(LocalEnvironment)
    popen = subprocess.Popen(  # noqa: S603 — fixed argv, no shell
        ["sleep", "60"],
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    proc = _RealPopenHandle(popen)
    real_time = base.time
    try:
        pgid = os.getpgid(popen.pid)
        assert _pgid_still_alive(pgid), "sanity: subprocess should be alive"

        calls = {"sleep": 0}

        def fake_sleep(_seconds):
            calls["sleep"] += 1
            raise KeyboardInterrupt

        monkeypatch.setattr(
            base,
            "time",
            SimpleNamespace(
                monotonic=real_time.monotonic,
                time=real_time.time,
                sleep=fake_sleep,
            ),
        )

        # The interrupt must propagate after cleanup (not be swallowed).
        with pytest.raises(KeyboardInterrupt):
            env._wait_for_process(proc, timeout=60)

        assert calls["sleep"] == 1, "poll loop should sleep exactly once here"
        # The critical assertion: the subprocess GROUP must be dead.  Not just
        # the wrapper — every member of the group too.
        assert _wait_for_pgid_exit(pgid), (
            f"subprocess group {pgid} is STILL ALIVE after the poll loop got "
            f"KeyboardInterrupt — orphan bug regressed.  This is the "
            f"sleep-300-survives-SIGTERM scenario from Physikal's Apr 2026 "
            f"report.  See tools/environments/base.py _wait_for_process "
            f"except-block.\n{_process_group_snapshot(pgid)}"
        )
    finally:
        monkeypatch.setattr(base, "time", real_time)
        try:
            popen.kill()
        except Exception:
            pass
        try:
            popen.wait(timeout=5)
        except Exception:
            pass
        try:
            popen.stdout.close()
        except Exception:
            pass
