#!/usr/bin/env bash
#
# Launch a SECOND, isolated Harnu instance alongside whatever is already
# running (your main dev window, another worktree's QA instance, an
# installed AppImage) — for a human to click around and QA a change, no CDP
# driving needed. Deterministic version of the manual recipe in
# docs/dev/live-verify-second-instance.md.
#
# Isolation is keyed off the WORKTREE, not a shared /tmp path: two worktrees
# running this script at the same time never collide, because each gets its
# own userData dir + pidfile + log, derived from `git rev-parse
# --show-toplevel`'s basename. (A shared hardcoded /tmp/capy-verify path is
# exactly the bug that motivated this script — see CHANGELOG.)
#
# Usage:
#   scripts/dev/qa-parallel.sh up             # build:unpack + launch (default)
#   scripts/dev/qa-parallel.sh up --no-build  # skip the build, reuse dist/linux-unpacked
#   scripts/dev/qa-parallel.sh status         # is an instance for THIS worktree running?
#   scripts/dev/qa-parallel.sh down           # stop it, remove its userData dir
#
# What you get: a real, on-screen Electron window (needs $DISPLAY), running
# the PACKAGED build (isPackaged=true, is.dev=false) — no static file server,
# no dev-mode renderer-URL gotcha. Not wired for CDP; if you need to drive it
# programmatically instead of clicking, follow the manual CDP recipe in
# docs/dev/live-verify-second-instance.md.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

RAW_NAME=$(basename "$REPO_ROOT")
INSTANCE_NAME="${RAW_NAME//[^a-zA-Z0-9_-]/-}"

USER_DATA_DIR="/tmp/harnu-qa-${INSTANCE_NAME}"
PID_FILE="/tmp/harnu-qa-${INSTANCE_NAME}.pid"
LOG_FILE="/tmp/harnu-qa-${INSTANCE_NAME}.log"
BINARY="dist/linux-unpacked/harnu"

CMD="${1:-up}"
shift || true

running_pid() {
  # Prints the live PID for this worktree's instance, or nothing.
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

cmd_status() {
  if pid=$(running_pid); then
    echo "running: pid $pid, userData=$USER_DATA_DIR, log=$LOG_FILE"
  else
    echo "not running (worktree: $INSTANCE_NAME)"
  fi
}

cmd_down() {
  if pid=$(running_pid); then
    echo "stopping pid $pid..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  else
    echo "not running (worktree: $INSTANCE_NAME)"
  fi
  rm -f "$PID_FILE"
  rm -rf "$USER_DATA_DIR"
  echo "cleaned up $USER_DATA_DIR"
}

cmd_up() {
  if pid=$(running_pid); then
    echo "already running: pid $pid (userData=$USER_DATA_DIR)"
    echo "run '$0 down' first, or just reuse the existing window."
    exit 0
  fi

  local skip_build=false
  for arg in "$@"; do
    case "$arg" in
      --no-build) skip_build=true ;;
    esac
  done

  if [ "$skip_build" = false ] || [ ! -x "$BINARY" ]; then
    echo "building (npm run build:unpack)..."
    npm run build:unpack
  fi

  if [ ! -x "$BINARY" ]; then
    echo "error: $BINARY not found after build" >&2
    exit 1
  fi

  # This worktree's userData dir only — never touched a live process here
  # (the running_pid check above already returned early if one existed).
  rm -rf "$USER_DATA_DIR"
  mkdir -p "$USER_DATA_DIR"

  echo "launching (worktree: $INSTANCE_NAME)..."
  DISPLAY="${DISPLAY:-:0}" setsid "./$BINARY" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-sandbox \
    >"$LOG_FILE" 2>&1 <&- &
  local pid=$!
  disown
  echo "$pid" >"$PID_FILE"

  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "error: instance exited immediately — check $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi

  echo "up: pid $pid, userData=$USER_DATA_DIR, log=$LOG_FILE"
  echo "a window should appear on your screen. QA away."
  echo "when done: $0 down"
}

case "$CMD" in
  up) cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  -h | --help)
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown command: $CMD (expected up|down|status)" >&2
    exit 1
    ;;
esac
