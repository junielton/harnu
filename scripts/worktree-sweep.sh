#!/usr/bin/env bash
#
# Sweep git worktrees that are safe to remove: branch fully merged into
# origin/main, clean working tree, and no live process with its cwd inside
# the worktree.
#
# DEFAULT IS DRY-RUN. Nothing is ever removed unless --apply is passed, and
# even then the script never forces anything — `git worktree remove` (no
# --force) and `git branch -d` (no -D) are used, so git itself refuses
# anything that isn't actually safe (uncommitted changes, unmerged commits,
# a worktree in active use, etc).
#
# Usage:
#   scripts/worktree-sweep.sh                    # dry-run over every worktree
#   scripts/worktree-sweep.sh --apply            # remove every candidate
#   scripts/worktree-sweep.sh --apply <path>      # remove only if <path> is a candidate
#   scripts/worktree-sweep.sh <path>              # dry-run scoped to <path>
#
# A candidate is a worktree (other than the main one) where ALL of:
#   (a) its branch is an ancestor of origin/main (git merge-base --is-ancestor)
#   (b) `git -C <path> status --porcelain` is empty (no uncommitted changes)
#   (c) no process on this machine has a cwd inside the worktree path
#         (scanned via /proc/*/cwd — permission errors on other users'
#         processes are ignored, same method already validated for fleet
#         idle/stalled checks)
#
# Anything else is listed as "skipped" with the reason (detached HEAD,
# locked, branch not merged, dirty tree, live process, etc).

set -euo pipefail

cd "$(dirname "$0")/.."

APPLY=false
FILTER_PATH=""

for arg in "$@"; do
  case "$arg" in
    --apply)
      APPLY=true
      ;;
    -h | --help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      FILTER_PATH="$arg"
      ;;
  esac
done

realpath_of() {
  readlink -f "$1" 2>/dev/null || echo "$1"
}

# Find any process whose cwd resolves inside (or equal to) the given path.
# Prints the first matching PID and returns 0, or returns 1 if none found.
# Permission errors reading other users' /proc/<pid>/cwd are silently ignored.
find_live_pid() {
  local target_real="$1"
  local cwd_link cwd_real pid
  for cwd_link in /proc/[0-9]*/cwd; do
    [ -e "$cwd_link" ] || continue
    cwd_real=$(readlink -f "$cwd_link" 2>/dev/null) || continue
    case "$cwd_real" in
      "$target_real" | "$target_real"/*)
        pid="${cwd_link#/proc/}"
        pid="${pid%/cwd}"
        echo "$pid"
        return 0
        ;;
    esac
  done
  return 1
}

FILTER_REAL=""
if [ -n "$FILTER_PATH" ]; then
  FILTER_REAL=$(realpath_of "$FILTER_PATH")
fi

# --- Parse `git worktree list --porcelain` into TSV: path \t branch \t locked \t lockedReason ---
RECORDS=$(git worktree list --porcelain | awk '
  function flush() { if (path != "") { print path "\t" branch "\t" locked "\t" reason } }
  /^worktree / { flush(); path=$0; sub(/^worktree /, "", path); branch=""; locked=0; reason="" }
  /^branch /   { branch=$0; sub(/^branch /, "", branch); sub(/^refs\/heads\//, "", branch) }
  /^detached/  { branch="(detached)" }
  /^locked/    { locked=1; reason=$0; sub(/^locked ?/, "", reason); if (reason == "") reason="(no reason given)" }
  END { flush() }
')

CANDIDATES=()
CANDIDATE_BRANCHES=()
declare -a SKIPPED_ROWS=()
declare -a CANDIDATE_ROWS=()

MAIN_WORKTREE=""
while IFS=$'\t' read -r path branch locked reason; do
  [ -n "$path" ] || continue
  if [ -d "$path/.git" ]; then
    MAIN_WORKTREE=$(realpath_of "$path")
  fi
done <<<"$RECORDS"

while IFS=$'\t' read -r path branch locked reason; do
  [ -n "$path" ] || continue
  path_real=$(realpath_of "$path")

  # Skip the main worktree entirely — it is never a candidate.
  if [ "$path_real" = "$MAIN_WORKTREE" ]; then
    continue
  fi

  if [ -n "$FILTER_REAL" ] && [ "$path_real" != "$FILTER_REAL" ]; then
    continue
  fi

  if [ "$branch" = "(detached)" ]; then
    SKIPPED_ROWS+=("$path	-	detached HEAD (no branch to check)")
    continue
  fi

  if [ "$locked" = "1" ]; then
    SKIPPED_ROWS+=("$path	$branch	locked: $reason")
    continue
  fi

  if ! git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
    SKIPPED_ROWS+=("$path	$branch	branch not merged into origin/main")
    continue
  fi

  if ! status_out=$(git -C "$path" status --porcelain 2>/dev/null); then
    SKIPPED_ROWS+=("$path	$branch	could not read worktree status")
    continue
  fi
  if [ -n "$status_out" ]; then
    SKIPPED_ROWS+=("$path	$branch	dirty working tree (uncommitted changes)")
    continue
  fi

  if pid=$(find_live_pid "$path_real"); then
    SKIPPED_ROWS+=("$path	$branch	live process (pid $pid) has cwd inside worktree")
    continue
  fi

  CANDIDATE_ROWS+=("$path	$branch	merged + clean + idle")
  CANDIDATES+=("$path")
  CANDIDATE_BRANCHES+=("$branch")
done <<<"$RECORDS"

print_table() {
  local title="$1"
  shift
  echo "== $title =="
  if [ "$#" -eq 0 ]; then
    echo "(none)"
    echo
    return
  fi
  printf '%-55s %-40s %s\n' "PATH" "BRANCH" "REASON"
  for row in "$@"; do
    IFS=$'\t' read -r p b r <<<"$row"
    printf '%-55s %-40s %s\n' "$p" "$b" "$r"
  done
  echo
}

print_table "Candidates (safe to remove)" "${CANDIDATE_ROWS[@]+"${CANDIDATE_ROWS[@]}"}"
print_table "Skipped" "${SKIPPED_ROWS[@]+"${SKIPPED_ROWS[@]}"}"

if [ "$APPLY" != "true" ]; then
  echo "Dry-run only — nothing removed. Pass --apply to remove the candidates above"
  echo "(optionally scoped to a single path: --apply <path>)."
  exit 0
fi

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "No candidates to remove."
  exit 0
fi

echo "Applying — removing ${#CANDIDATES[@]} candidate(s)..."
for i in "${!CANDIDATES[@]}"; do
  path="${CANDIDATES[$i]}"
  branch="${CANDIDATE_BRANCHES[$i]}"
  echo "--- $path (branch: $branch) ---"
  if git worktree remove "$path"; then
    echo "  removed worktree"
  else
    echo "  git worktree remove refused/failed — leaving in place"
    continue
  fi
  if git branch -d "$branch"; then
    echo "  deleted branch $branch"
  else
    echo "  git branch -d refused/failed — branch left in place"
  fi
done
