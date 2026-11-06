#!/usr/bin/env bash
# T1 spike, eval layer 2: A/B the doc-reader read gate with `claude plugin eval`.
#
#   evals/doc-reader/run.sh [--runs N] [--model M] [--case GLOB] [--min-lines N] [-j N] [--variant gate|agent-only]
#
# The "with" arm loads this directory as a plugin: the read gate hook plus the Haiku
# `doc-reader` agent. The "without" arm is plugin eval's no-plugin baseline. Both run the same
# cases on the same main model, against a pinned snapshot of Harnu docs (fixtures/).
#
# Output: evals/doc-reader/results/<timestamp>/ with eval.json (plugin eval's own result), usage.json
# (per-model tokens and cost from each run's trace) and summary.md (the comparison table).
# This spends real tokens on your own credential. Each run is a full `claude` child.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RUNS=3
MODEL=sonnet
CASE=""
MIN_LINES=""
JOBS=1
VARIANT=gate
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --case) CASE="$2"; shift 2 ;;
    --min-lines) MIN_LINES="$2"; shift 2 ;;
    -j|--concurrency) JOBS="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
OUT="$HERE/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir -p "$OUT"

# The gate the hook runs is the product rule, bundled fresh, so the eval can never test a stale copy.
# esbuild comes in through electron-vite, not as a direct dependency, so check for it by name.
ESBUILD="$REPO/node_modules/.bin/esbuild"
[[ -x "$ESBUILD" ]] || { echo "esbuild not found at $ESBUILD; run npm install" >&2; exit 2; }
"$ESBUILD" "$HERE/hooks/gate-entry.ts" --bundle --platform=node \
  --format=esm --target=node20 --log-level=warning --outfile="$HERE/hooks/gate.mjs"

# Hooks run under /bin/sh with a minimal PATH, where a version-manager node (nvm, fnm, asdf) is
# not found. The hook then exits 127 and the gate silently fails open. Pin the absolute path.
NODE_BIN="${NODE_BIN:-$(command -v node)}"
[[ -x "$NODE_BIN" ]] || { echo "node not found; set NODE_BIN" >&2; exit 2; }
sed "s|@NODE@|$NODE_BIN|" "$HERE/hooks/hooks.json.in" > "$HERE/hooks/hooks.json"

# --variant agent-only evaluates a copy of the plugin with no hooks: the Haiku agent is offered
# but nothing enforces it. That separates the gate's effect from the agent's mere presence.
PLUGIN="$HERE"
if [[ "$VARIANT" == "agent-only" ]]; then
  PLUGIN="$OUT/plugin-agent-only"
  mkdir -p "$PLUGIN"
  cp -R "$HERE/.claude-plugin" "$HERE/agents" "$HERE/evals" "$HERE/fixtures" "$PLUGIN/"
elif [[ "$VARIANT" != "gate" ]]; then
  echo "unknown --variant: $VARIANT (gate | agent-only)" >&2
  exit 2
fi
echo "variant: $VARIANT" > "$OUT/variant.txt"

args=(plugin eval "$PLUGIN" --model "$MODEL" --runs "$RUNS" -j "$JOBS" --scaffold --trust-plugin
  --allow-tools Edit --keep-temp --no-publish --threshold 0 --output-dir "$OUT/plugin-eval" --json "$OUT/eval.json")
[[ -n "$CASE" ]] && args+=(--case "$CASE")

echo "running: claude ${args[*]}" >&2
# --min-lines reaches the hook through the environment the eval's claude children inherit.
HARNU_DOC_READER_MIN_LINES="${MIN_LINES}" "$CLAUDE_BIN" "${args[@]}" 2>"$OUT/eval.stderr" || true

node "$HERE/summarize.mjs" "$OUT/eval.json" "$OUT" "$MODEL" "$RUNS" "${MIN_LINES:-350}"

# plugin eval seals kept sandboxes (mode 000). The traces are copied out by summarize.mjs; remove
# the sandboxes so they do not pile up in /tmp.
node -e '
  const r = require(process.argv[1]); const fs = require("fs"); const path = require("path")
  const traces = path.join(path.dirname(process.argv[1]), "traces")
  fs.mkdirSync(traces, { recursive: true })
  for (const c of r.cases ?? []) for (const [arm, runs] of Object.entries(c.arms ?? {})) runs.forEach((run, i) => {
    if (!run.tracePath) return
    try { fs.copyFileSync(run.tracePath, path.join(traces, `${c.name}-${arm}-${i}.jsonl`)) } catch {}
    const root = path.dirname(path.dirname(run.tracePath))
    if (!/^\/(private\/)?tmp\/e-[A-Za-z0-9]+$/.test(root)) return
    try { fs.chmodSync(root, 0o700); fs.chmodSync(path.join(root, "sealed"), 0o700) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })' "$OUT/eval.json"

echo "results: $OUT/summary.md" >&2
