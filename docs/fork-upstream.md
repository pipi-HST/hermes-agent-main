# Fork governance — hermes-agent-main vs upstream NousResearch/hermes-agent

This checkout is a **fork snapshot** of `NousResearch/hermes-agent`, not a
branch of upstream.  The initial commit `e01abb0 "Initial Hermes agent runtime
checkpoint"` imports 3,488 upstream files and already contains fork-specific
files (`tools/capture_tool.py`, `tools/hermes_custom_envelope.py`,
`agent/hermes_custom_envelope_adapter.py`).  There is no `upstream` remote and
no merge base, so "rebase onto upstream" is currently a manual re-merge.

## Rules for new work

1. **Do not patch upstream core files** unless there is no documented seam:
   - Prefer `plugins/<name>/` (`PluginManager`, see `AGENTS.md`).
   - Prefer `gateway/builtin_hooks/` for gateway hooks.
   - Prefer `integrations/` for external service clients.
   - `web_server.py`, `web/src/App.tsx`, `conversation_loop.py`,
     `tool_executor.py`, `gateway/run.py`, `model_tools.py` are **frozen** for
     new custom logic until the migration steps below are done.
2. Any patch to a frozen file must be listed in the table below with a reason.
3. New dashboard pages must not replace the embedded TUI chat surface
   (`AGENTS.md` → "TUI in the Dashboard").
4. Every delta file needs a test under `tests/`; contract scripts under
   `web/package.json` must run in CI.

## Patched upstream files (current delta)

| File | Why | Risk on upstream sync |
|---|---|---|
| `hermes_cli/web_server.py` | knowledge API, dashboard routes | high — +72% lines |
| `web/src/App.tsx` | knowledge navigation/default route | medium |
| `agent/conversation_loop.py` | envelope/direct-reply integration | high |
| `agent/tool_executor.py` | custom tool dispatch | high |
| `gateway/run.py` | document-context follow-ups | medium |
| `tui_gateway/server.py` | knowledge source enrichment | medium |
| `hermes_cli/config.py`, `cli.py` | knowledge commands | low |

## Migration plan (in order)

1. **Stop the bleeding** — new code only in `integrations/`, `plugins/`,
   `gateway/builtin_hooks/`.
2. **Extract the knowledge API** — move the ~3,200 lines added to
   `hermes_cli/web_server.py` into `plugins/web_knowledge/`; the core file keeps
   only a registration call.
3. **Config-drive the dashboard navigation** — replace hard-coded Chinese nav
   items in `web/src/App.tsx` with a config table.
4. **Add an upstream remote and pin the imported version** — document the
   upstream tag/commit that `e01abb0` corresponds to, then set up a periodic
   `git fetch upstream` + manual merge review.

## Verification for any rebase attempt

- `scripts/run_tests.sh` green.
- `npm run lint` and the 8 `check:*` scripts green.
- Manual smoke: dashboard `/knowledge-chat`, capture → draft → confirm →
  knowledge file, permanent delete, gateway restart.
