#!/usr/bin/env bash
#
# Bump the app version, then build the Linux artifacts (.deb + AppImage).
#
# The version is validated as strict SemVer BEFORE building — a value like
# `0.2.02` (leading zero) is invalid and crashes electron-updater at boot, see
# docs/lessons/framework/003-invalid-semver-crashes-electron-updater-at-boot.md.
#
# Usage:
#   scripts/release-linux.sh            # patch bump (default): 0.2.2 -> 0.2.3
#   scripts/release-linux.sh minor      # 0.2.2 -> 0.3.0
#   scripts/release-linux.sh major      # 0.2.2 -> 1.0.0
#   scripts/release-linux.sh 0.4.0      # set an explicit version
#
# The version bump touches package.json (+ package-lock.json) only — no git
# commit/tag, so you can review the diff. After the artifacts look good, commit
# the bump and tag the release for the GitHub Release the auto-updater tracks.

set -euo pipefail

# Run from the repo root regardless of where the script is invoked.
cd "$(dirname "$0")/.."

# --- node/npm: not on PATH in non-interactive shells (node is via mise) --------
if ! command -v npm >/dev/null 2>&1; then
  for d in "$HOME/.local/share/mise/installs/node"/*/bin; do
    if [ -x "$d/npm" ]; then export PATH="$d:$PATH"; break; fi
  done
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found on PATH (node is installed via mise — run inside a mise-activated shell)" >&2
  exit 1
fi

# Help short-circuits before reading the version (so it prints cleanly).
case "${1:-}" in
  -h|--help|help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

BUMP="${1:-patch}"

# Official SemVer regex (MAJOR.MINOR.PATCH + optional pre-release/build).
# The (0|[1-9][0-9]*) groups reject leading zeros — exactly the `0.2.02` trap.
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

CURRENT="$(node -p "require('./package.json').version")"
echo "current version: $CURRENT"

case "$BUMP" in
  patch|minor|major)
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
  *)
    if [[ ! "$BUMP" =~ $SEMVER_RE ]]; then
      echo "error: '$BUMP' is not valid SemVer (e.g. leading zeros like 0.2.02 crash electron-updater)." >&2
      echo "       pass patch|minor|major, or a valid x.y.z version." >&2
      exit 1
    fi
    npm version "$BUMP" --no-git-tag-version --allow-same-version >/dev/null
    ;;
esac

NEW="$(node -p "require('./package.json').version")"

# Defense in depth: never ship an invalid version, even from a bump path.
if [[ ! "$NEW" =~ $SEMVER_RE ]]; then
  echo "error: resulting version '$NEW' is invalid SemVer — reverting and aborting before build." >&2
  npm version "$CURRENT" --no-git-tag-version --allow-same-version >/dev/null
  exit 1
fi

echo "bumped: $CURRENT -> $NEW"
echo "building Linux artifacts (.deb + AppImage)…"
echo

npm run build:linux

echo
echo "✓ built version $NEW"
shopt -s nullglob
artifacts=(dist/*.AppImage dist/*.deb)
if [ ${#artifacts[@]} -gt 0 ]; then
  echo "artifacts:"
  ls -lh "${artifacts[@]}" | awk '{print "  " $9 "  (" $5 ")"}'
else
  echo "(no .AppImage/.deb found under dist/ — check electron-builder output)"
fi
echo
echo "next: review the version bump, then commit + tag for the GitHub Release:"
echo "  git commit -am \"chore(release): v$NEW\" && git tag \"v$NEW\""
