#!/usr/bin/env python3
"""Regenerate the "patched upstream files" table in ``docs/fork-upstream.md``.

This checkout is a fork snapshot: ``e01abb0`` imported the upstream tree, and
fork commits then patched some of those files (plus added fork-only files such
as ``integrations/`` and ``tools/hermes_custom_envelope.py``).  The governance
doc needs an accurate list of *upstream* files this fork has touched.

A file counts as upstream-original when it exists in the baseline commit
(``git cat-file -e e01abb0:<path>``).  Fork-only added files are excluded by
design: the doc's rules cover patches to upstream core files.

By default the baseline is compared against the **working tree**, so the table
matches the change you are about to commit.  Pass ``--rev <ref>`` to compare
committed history only (e.g. in CI).

Usage:
    # Print the markdown table (no writes).
    python scripts/fork_delta.py

    # Regenerate the table inside docs/fork-upstream.md.
    python scripts/fork_delta.py --write

    # CI guard: non-zero exit when the doc is stale.
    python scripts/fork_delta.py --check

    # Compare against committed history only (default: working tree).
    python scripts/fork_delta.py --baseline e01abb0 --rev HEAD

Exit status: 0 — table rendered (and written/validated where requested);
1 — ``--check`` found the doc stale; 2 — setup/usage error.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOC_PATH = REPO_ROOT / "docs" / "fork-upstream.md"
DEFAULT_BASELINE = "e01abb0"
DEFAULT_REV: str | None = None

START_MARKER = "<!-- fork-delta:start -->"
END_MARKER = "<!-- fork-delta:end -->"

_CHANGE_LABELS = {
    "M": "modified",
    "D": "deleted",
    "T": "type changed",
}


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and result.returncode != 0:
        raise SystemExit(
            f"git {' '.join(args)} failed ({result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result


def _exists_in_baseline(baseline: str, path: str) -> bool:
    """True when ``path`` is part of the upstream tree at ``baseline``."""
    result = _git("cat-file", "-e", f"{baseline}:{path}", check=False)
    return result.returncode == 0


def _diff_range(baseline: str, rev: str | None) -> str:
    """Return the ``git diff`` target: working tree by default, else ``base..rev``."""
    return f"{baseline}..{rev}" if rev else baseline


def _diff_entries(baseline: str, rev: str | None) -> list[tuple[str, str]]:
    """Return ``(status, path)`` for changed paths, no rename detection."""
    output = _git(
        "diff", "--name-status", "--no-renames", _diff_range(baseline, rev)
    ).stdout
    entries: list[tuple[str, str]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        entries.append((fields[0].strip(), fields[-1].strip()))
    return entries


def _line_deltas(baseline: str, rev: str | None) -> dict[str, tuple[str, str]]:
    """Map path -> (added, removed) from a single ``--numstat`` call."""
    output = _git("diff", "--numstat", "--no-renames", _diff_range(baseline, rev)).stdout
    deltas: dict[str, tuple[str, str]] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        deltas[fields[-1].strip()] = (fields[0].strip(), fields[1].strip())
    return deltas


def collect_rows(baseline: str, rev: str | None) -> list[tuple[str, str, str]]:
    """Return sorted ``(path, change_label, line_delta)`` upstream patches."""
    deltas = _line_deltas(baseline, rev)
    rows: list[tuple[str, str, str]] = []
    for status, path in _diff_entries(baseline, rev):
        if status == "A":
            continue  # fork-only file, not an upstream patch
        if not _exists_in_baseline(baseline, path):
            continue  # e.g. renamed file's new path
        label = _CHANGE_LABELS.get(status, status.lower())
        added, removed = deltas.get(path, ("?", "?"))
        if added == "-" or removed == "-":
            line_delta = "binary"
        elif added == "?" or removed == "?":
            line_delta = "n/a"
        else:
            line_delta = f"+{added} / -{removed}"
        rows.append((path, label, line_delta))
    rows.sort(key=lambda row: row[0])
    return rows


def render_table(rows: list[tuple[str, str, str]]) -> str:
    lines = [
        "| File | Change | Lines (+/-) |",
        "|---|---|---|",
    ]
    for path, label, line_delta in rows:
        lines.append(f"| `{path}` | {label} | {line_delta} |")
    return "\n".join(lines)


def render_block(rows: list[tuple[str, str, str]], baseline: str, target: str) -> str:
    count = len(rows)
    note = (
        f"<!-- generated by scripts/fork_delta.py: {count} upstream files changed "
        f"between {baseline} and {target} -->"
    )
    return "\n".join(
        [
            START_MARKER,
            note,
            "",
            f"Unlike fork-only files, these are upstream files (present in `{baseline}`)",
            "that this fork has patched. **Generated table — do not edit by hand;**",
            "run `python scripts/fork_delta.py --write` after rebasing/merging.",
            "",
            render_table(rows),
            "",
            END_MARKER,
        ]
    )


def _read_doc() -> str:
    if not DOC_PATH.is_file():
        raise SystemExit(f"doc not found: {DOC_PATH}")
    return DOC_PATH.read_text(encoding="utf-8")


def _doc_block(text: str) -> str | None:
    start = text.find(START_MARKER)
    end = text.find(END_MARKER)
    if start < 0 or end < 0 or end < start:
        return None
    return text[start : end + len(END_MARKER)]


def write_doc(block: str) -> None:
    text = _read_doc()
    current = _doc_block(text)
    if current is None:
        raise SystemExit(
            f"{DOC_PATH.relative_to(REPO_ROOT)} is missing the "
            f"{START_MARKER} / {END_MARKER} markers"
        )
    start = text.find(START_MARKER)
    end = text.find(END_MARKER) + len(END_MARKER)
    updated = text[:start] + block + text[end:]
    with DOC_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(updated)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate the fork-vs-upstream patched-file table.",
    )
    parser.add_argument("--baseline", default=DEFAULT_BASELINE, help="upstream baseline commit")
    parser.add_argument(
        "--rev",
        default=DEFAULT_REV,
        help="fork revision to compare (default: working tree)",
    )
    parser.add_argument("--write", action="store_true", help=f"rewrite {DOC_PATH.name} table")
    parser.add_argument("--check", action="store_true", help="exit 1 when the doc table is stale")
    args = parser.parse_args(argv)

    rows = collect_rows(args.baseline, args.rev)
    block = render_block(rows, args.baseline, args.rev or "the working tree")

    if args.write and args.check:
        parser.error("--write and --check are mutually exclusive")

    if args.write:
        write_doc(block)
        print(f"updated {DOC_PATH.relative_to(REPO_ROOT)} ({len(rows)} files)")
        return 0

    if args.check:
        current = _doc_block(_read_doc())
        if current != block:
            print(
                "docs/fork-upstream.md is stale — run "
                "`python scripts/fork_delta.py --write`",
                file=sys.stderr,
            )
            return 1
        print(f"docs/fork-upstream.md is up to date ({len(rows)} files)")
        return 0

    print(block)
    return 0


if __name__ == "__main__":
    sys.exit(main())
