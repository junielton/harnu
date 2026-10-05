#!/usr/bin/env bash
# Local mirror of the `verify` job in .github/workflows/ci.yml.
#
# Runs the same gates, in the same order, with the same commands CI runs — so a
# green local run means the same thing a green CI run means. The production
# build (`npm run build`) is NOT part of `verify` and is skipped by default; the
# `e2e` job is opt-in via --with-e2e because it needs build output to exist.
#
# Unlike CI, this collects every failure instead of stopping at the first one:
# you fix the whole batch in one pass rather than one push per gate.
#
# Usage:
#   scripts/ci/local-pipeline.sh [options]
#
# Options:
#   --base <ref>     git ref the contract gates diff against (default: origin/main).
#                    CI passes the PR base sha here.
#   --labels <list>  PR labels, comma-separated (e.g. no-user-docs) so escape
#                    hatches behave exactly as they do on the real PR.
#   --fast           run `npm run test` instead of `npm run test:coverage`
#                    (skips coverage-threshold enforcement — NOT CI parity).
#   --with-e2e       also run the `e2e` job: `npm run build` + xvfb-run npm run e2e:ci.
#                    Implies a build, since e2e loads out/.
#   --skip <step>    skip a step by id (repeatable). Ids: format, i18n, changelog,
#                    awareness, user-docs, typecheck, lint, test.
#   --json <path>    write a machine-readable summary for an orchestrator to read.
#
# Exit code: 0 only when every step that ran passed.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

BASE="origin/main"
LABELS=""
FAST=0
WITH_E2E=0
JSON_OUT=""
SKIPPED=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --fast) FAST=1; shift ;;
    --with-e2e) WITH_E2E=1; shift ;;
    --skip) SKIPPED="$SKIPPED,$2"; shift 2 ;;
    --json) JSON_OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "!! base ref '$BASE' not found — run: git fetch origin main" >&2
  exit 2
fi

export CHANGELOG_GATE_BASE="$BASE"
export AWARENESS_GATE_BASE="$BASE"
export USER_DOCS_GATE_BASE="$BASE"
export GATE_PR_LABELS="$LABELS"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'

LOG_DIR="$(mktemp -d -t harnu-local-ci-XXXXXX)"
declare -a RESULT_IDS=() RESULT_STATES=() RESULT_SECS=() RESULT_LOGS=()

is_skipped() { [[ ",$SKIPPED," == *",$1,"* ]]; }

run_step() {
  local id="$1" label="$2"; shift 2
  local log="$LOG_DIR/$id.log"

  if is_skipped "$id"; then
    printf '%s⏭️  %-22s%s %sskipped%s\n' "$DIM" "$label" "$OFF" "$DIM" "$OFF"
    RESULT_IDS+=("$id"); RESULT_STATES+=("skipped"); RESULT_SECS+=("0"); RESULT_LOGS+=("")
    return 0
  fi

  printf '%s▶  %-22s%s %s…%s' "$BOLD" "$label" "$OFF" "$DIM" "$OFF"
  local start; start=$SECONDS
  if "$@" >"$log" 2>&1; then
    local secs=$((SECONDS - start))
    printf '\r%s✅ %-22s%s %s%ss%s\033[K\n' "$GREEN" "$label" "$OFF" "$DIM" "$secs" "$OFF"
    RESULT_IDS+=("$id"); RESULT_STATES+=("pass"); RESULT_SECS+=("$secs"); RESULT_LOGS+=("$log")
  else
    local secs=$((SECONDS - start))
    printf '\r%s❌ %-22s%s %s%ss — %s%s\033[K\n' "$RED" "$label" "$OFF" "$DIM" "$secs" "$log" "$OFF"
    RESULT_IDS+=("$id"); RESULT_STATES+=("fail"); RESULT_SECS+=("$secs"); RESULT_LOGS+=("$log")
  fi
}

echo
echo "${BOLD}Local CI — mirroring the 'verify' job${OFF}  ${DIM}(base: $BASE)${OFF}"
echo

# Same order as .github/workflows/ci.yml. The contract gates run before the slow
# steps so a missing CHANGELOG entry costs you 2 seconds, not 4 minutes.
run_step format    "format:check"      npm run format:check
run_step i18n      "i18n parity"       node scripts/ci/i18n-parity.mjs
run_step english   "English gate"      node scripts/ci/english-gate.mjs
run_step changelog "CHANGELOG gate"    node scripts/ci/changelog-gate.mjs
run_step awareness "self-awareness"    node scripts/ci/awareness-gate.mjs
run_step user-docs "user-docs gate"    node scripts/ci/user-docs-gate.mjs
run_step typecheck "typecheck"         npm run typecheck
run_step lint      "lint"              npm run lint

if [[ $FAST -eq 1 ]]; then
  run_step test "test (no coverage)" npm run test
else
  run_step test "test:coverage" npm run test:coverage
fi

if [[ $WITH_E2E -eq 1 ]]; then
  run_step build "build" npm run build
  if command -v xvfb-run >/dev/null 2>&1; then
    run_step e2e "e2e (headless)" xvfb-run -a npm run e2e:ci
  else
    run_step e2e "e2e (headless)" npm run e2e:ci
  fi
fi

FAILED=0
for state in "${RESULT_STATES[@]}"; do
  [[ "$state" == "fail" ]] && FAILED=$((FAILED + 1))
done

echo
if [[ $FAILED -eq 0 ]]; then
  echo "${GREEN}${BOLD}verify: green${OFF} — same gates CI runs."
  [[ $WITH_E2E -eq 0 ]] && echo "${DIM}Not covered: npm run build, e2e job (rerun with --with-e2e).${OFF}"
else
  echo "${RED}${BOLD}verify: $FAILED failing${OFF} — logs in $LOG_DIR"
fi
[[ $FAST -eq 1 ]] && echo "${YELLOW}Coverage thresholds were NOT enforced (--fast).${OFF}"
echo

if [[ -n "$JSON_OUT" ]]; then
  {
    printf '{"base":"%s","failed":%d,"logDir":"%s","steps":[' "$BASE" "$FAILED" "$LOG_DIR"
    for i in "${!RESULT_IDS[@]}"; do
      [[ $i -gt 0 ]] && printf ','
      printf '{"id":"%s","state":"%s","seconds":%s,"log":"%s"}' \
        "${RESULT_IDS[$i]}" "${RESULT_STATES[$i]}" "${RESULT_SECS[$i]}" "${RESULT_LOGS[$i]}"
    done
    printf ']}\n'
  } > "$JSON_OUT"
fi

exit $((FAILED > 0 ? 1 : 0))
