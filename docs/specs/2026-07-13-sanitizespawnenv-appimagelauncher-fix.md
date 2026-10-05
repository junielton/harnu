# sanitizeSpawnEnv must detect the real squashfs mount, not trust APPDIR

**Date:** 2026-07-13
**Card:** `bug-30-sanitizespawnenv-strips-nothing-under-appimagelauncher-ap`
**Status:** design approved, not implemented

## Problem

`sanitizeSpawnEnv` (`src/main/appimage-env.ts:28`) exists to hand a spawned child "the
environment the child would have seen if launched from a normal terminal" — it deletes the
AppImage marker vars and drops every colon-list segment rooted in the squashfs mount. It
finds that mount by trusting a single variable:

```ts
const appdir = out.APPDIR
if (!appdir) return out                                    // "not an AppImage"
...
const kept = value.split(':').filter((seg) => seg !== '' && !seg.startsWith(appdir))
```

That is `APPDIR === the mount`. Under **AppImageLauncher** it is not. Captured from a live
AppImage run while verifying the BUG-27 fix:

```
APPDIR=/opt/appimagelauncher.AppDir                                    <- what the sanitizer trusts
PATH=/tmp/.mount_Capy-0lrvEDd:/tmp/.mount_Capy-0lrvEDd/usr/sbin:...    <- the actual pollution
```

No PATH segment starts with `/opt/appimagelauncher.AppDir`, so the filter keeps everything.
The sanitizer **silently no-ops exactly where it is supposed to work**: `APPDIR` is truthy, so
we do not take the "not an AppImage" early return either — we run the full loop and strip
nothing. Every mount-rooted entry survives into every spawned child.

Two secondary observations from the same capture:

- `APPIMAGE` / `ARGV0` / `OWD` were **absent** from that env, so the marker-var cleanup also
  had nothing to do. (`APPDIR` itself was present and is deleted — correctly, it is still
  pollution, just not the mount.)
- The synthetic fixture in `tests/appimage-env.test.ts:23` (`appImageEnv()`) sets
  `APPDIR: MOUNT`. It is green today **because it encodes the assumption under test**. The
  case that reproduces is not covered.

Impact today is bounded but real. This env reaches the PTY sessions (as it always has) and,
since BUG-27, the `WORKTREE.md` `setup`/`create` shell. `mergeLoginPath` folds the login PATH
in _front_, so a mount-rooted `node`/`npm` no longer wins a lookup — the practical BUG-27
symptom stays fixed. But the function's advertised postcondition is not being kept, PATH still
carries dead squashfs entries, and a mount-rooted `LD_LIBRARY_PATH` (which no PATH ordering
saves us from — the dynamic loader has no login-shell fallback in front of it) would leak
straight through to every child if the runtime set one.

## Design

Stop asking `APPDIR` where the mount is. Derive it from evidence, and strip on **every**
prefix we have reason to distrust.

### 1. Detect the real mount

Two independent signals, used together:

- **`process.execPath`** — the authoritative one. Inside an AppImage the Electron binary runs
  from the squashfs mount, so `execPath` is literally under it. The mount is the
  `/tmp/.mount_*` ancestor of `execPath` (match the first path component after `/tmp` whose
  basename starts with `.mount_`). This is caller-supplied, not read from `process` inside the
  function — `sanitizeSpawnEnv` must stay pure and unit-testable (it takes an env record and
  imports nothing from electron; see the module docblock). Add an optional second parameter
  (e.g. `opts?: { execPath?: string }`) defaulted by the call sites in `buildSpawnEnv`.
- **The colon-list values themselves** — scan `PATH` and `LD_LIBRARY_PATH` segments for the
  `/tmp/.mount_*` shape and take the mount root from any that match. This catches a mount the
  `execPath` heuristic misses (a runtime that mounts elsewhere, a future launcher shim) and is
  what the captured env above would trigger on.

The result is a **set of prefixes to strip**, not a single string.

### 2. Strip on the union

Strip a segment when it is rooted in **any** detected mount **or** in `APPDIR`. `APPDIR` stays
in the set as belt-and-suspenders: under AppImageLauncher `/opt/appimagelauncher.AppDir` is
itself pollution and does not belong in a child's PATH, and under a plain AppImage run `APPDIR`
_is_ the mount, so the existing behavior is preserved by construction.

Prefix matching must be **path-boundary aware** — `seg === prefix || seg.startsWith(prefix + '/')`
— so a detected mount `/tmp/.mount_Capy-0lrv` cannot chew a sibling `/tmp/.mount_Capy-0lrvXX`.
(The current `startsWith(appdir)` is boundary-blind; fixing it here is free.)

The rest of the loop is unchanged: empty segments are dropped, a var that ends up with zero
segments is deleted.

### 3. Widen the early return

The `if (!appdir) return out` guard becomes "no detected mount **and** no `APPDIR`" — i.e.
return early only when the prefix set is empty. This keeps the dev / `.deb` / normal-terminal
passthrough exactly as it is (no mount, no `APPDIR`, nothing to do), while letting an env with a
mount but a missing/foreign `APPDIR` still be cleaned.

### 4. Marker vars: unchanged

`APPIMAGE_MARKER_VARS` (`APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`) are still deleted unconditionally
when we decide we are in an AppImage context. The captured env simply had fewer of them set;
`delete` on an absent key is a no-op. No change needed, and none is proposed.

Nothing outside `appimage-env.ts` moves. `buildSpawnEnv` remains the one composition both spawn
seams share (BUG-27's lesson), so both the PTY path and `worktree-ipc` inherit the fix with no
call-site change beyond threading `process.execPath` in.

## Testing

All in `tests/appimage-env.test.ts`.

- **New fixture, built from the REAL captured env** — a second builder alongside `appImageEnv()`
  (e.g. `appImageLauncherEnv()`) with `APPDIR: '/opt/appimagelauncher.AppDir'`, a `PATH` whose
  head segments are `/tmp/.mount_Capy-0lrvEDd` and `/tmp/.mount_Capy-0lrvEDd/usr/sbin` followed by
  the system entries, and **no** `APPIMAGE`/`ARGV0`/`OWD`. This fixture must **fail against the
  current implementation** — that is the point of it; the synthetic one cannot.
- **Acceptance (the reported bug):** `sanitizeSpawnEnv(appImageLauncherEnv())` leaves a `PATH`
  with no `/tmp/.mount_Capy-*` segment, and the system entries intact and in order.
- **`APPDIR` is also stripped:** an `/opt/appimagelauncher.AppDir/...` segment in that env's
  colon-lists does not survive either (belt-and-suspenders, §2).
- **`LD_LIBRARY_PATH` leak:** the same fixture with a mount-rooted `LD_LIBRARY_PATH` (the case
  no PATH ordering rescues) is deleted; a real out-of-mount entry (`/opt/cuda/lib64`) survives —
  mirroring the existing assertion at `tests/appimage-env.test.ts:75`.
- **Mount detected from `execPath` alone:** an env whose colon-lists are clean but whose
  `execPath` is under `/tmp/.mount_*` still yields the mount (proves the two signals are
  independent, not one dressed as two).
- **Boundary safety:** a sibling `/tmp/.mount_Capy-0lrvEDdXX/bin` segment is **not** stripped by
  a detected mount of `/tmp/.mount_Capy-0lrvEDd`.
- **Regression — the existing suite is untouched and still green.** Every current
  `appImageEnv()`-based assertion (markers deleted, PATH/XDG stripped, `LD_LIBRARY_PATH` deleted,
  non-mount vars preserved, `buildSpawnEnv` composition) must pass with no edit. The
  non-AppImage passthrough (`sanitizeSpawnEnv(clean)` deep-equals `clean`) is the guard that the
  widened early return did not turn into a false positive.

## Contract obligations

- **`CHANGELOG.md` — mandatory.** This is a user-visible env-hygiene fix: under AppImageLauncher
  the child environment handed to terminal sessions and worktree setup shells was never actually
  cleaned. One bullet under `### Fixed`.
- **`docs/capy-features.md` — NOT required; deliberately skipped.** Per CLAUDE.md's litmus, a
  change is agent-facing only when it touches an MCP verb in `tool-catalog.ts`, the shape of an
  ACK the agent must read, grant/confirm semantics, or a UI affordance the agent should offer.
  This touches none of them: it is an internal environment-sanitization detail in `src/main/`,
  with no new verb, no new ACK field, and nothing for a session to call or proactively offer.
  It is squarely in the "fact the session can't act on" bucket (same standing as fleet-state
  heuristic tuning). The CI awareness gate is not triggered either — the diff touches neither
  `src/main/mcp/tool-catalog.ts` nor `src/main/capy-features.ts`.
- **`docs/user/` — NOT required,** for the same reason: no new top-level component, no new
  top-level `src/main/` file (this edits an existing one), no MCP verb change. Nothing new for a
  person to see or do; the user-docs gate does not fire.
