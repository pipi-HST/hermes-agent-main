#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_CUSTOM_ROOT="${HERMES_CUSTOM_ROOT:-/Users/pipi/hermes-custom}"
PY="${ROOT}/.venv/bin/python"
FULL=0
RUNTIME=0

for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --runtime) RUNTIME=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: $0 [--full] [--runtime]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$PY" ]]; then
  PY="python3"
fi

echo "== Python syntax =="
cd "$ROOT"
"$PY" -m py_compile \
  model_tools.py \
  agent/agent_runtime_helpers.py \
  agent/tool_executor.py \
  gateway/platforms/api_server.py \
  tui_gateway/server.py \
  tools/research_with_web_tool.py

echo "== Research progress chain tests =="
"$PY" -m pytest \
  tests/tui_gateway/test_research_progress_chain.py \
  tests/tui_gateway/test_protocol.py::test_research_progress_forwarded_as_tool_progress \
  tests/tools/test_research_with_web_tool.py \
  -q

echo "== Web research progress UI contract =="
cd "$ROOT/web"
npm run check:research-progress
npx tsc -b

if [[ "$RUNTIME" -eq 1 ]]; then
  echo "== Runtime dashboard research progress smoke =="
  npm run smoke:research-progress
fi

if [[ "$FULL" -eq 1 ]]; then
  echo "== Web production build =="
  npm run build

  if [[ -d "$HERMES_CUSTOM_ROOT" ]]; then
    echo "== Hermes custom research quality tests =="
    cd "$HERMES_CUSTOM_ROOT"
    CUSTOM_PY="${HERMES_CUSTOM_ROOT}/.venv/bin/python"
    if [[ ! -x "$CUSTOM_PY" ]]; then
      CUSTOM_PY="python3"
    fi
    "$CUSTOM_PY" -m py_compile bridge/research_bridge.py scripts/eval_research_quality.py scripts/promote_research_fixture.py
    "$CUSTOM_PY" -m pytest tests/test_research_bridge.py tests/test_research_quality_eval.py tests/test_promote_research_fixture.py -q
    "$CUSTOM_PY" scripts/eval_research_quality.py \
      --output-jsonl output/research-eval/latest.jsonl \
      --output-md output/research-eval/latest.md
  else
    echo "skip hermes-custom checks: not found at $HERMES_CUSTOM_ROOT"
  fi
fi

echo "research pipeline free checks: ok"
