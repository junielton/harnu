# Worktree manifest commands run on Windows — resolve a POSIX shell, or fail loudly

**Date:** 2026-07-19
**Card:** `bug-29-create-worktree-is-broken-on-windows-manifest-setup-shell`
**ADR:** `docs/adr/0005-worktree-manifest-commands-are-posix.md`
**Status:** design approved, not implemented

## Problem

`create_worktree` is unavailable on Windows for any repo whose `WORKTREE.md`
declares a `setup:` step or a `copy:` seed — which is the normal case (Capy's own
manifest declares `npm ci`).

Two unconditional POSIX assumptions, both verified in code:

1. **Manifest commands shell to `sh`.** `runManifestCommand` runs every `setup:` /
   `create:` / `remove:` string as `runFile('sh', ['-c', cmd], ...)`
   (`src/main/worktree-ipc.ts:340`) with no platform branch. There is no `sh` on a
   stock Windows box → `spawn sh ENOENT`.
2. **The seed shells to `cp`.** `applySeedPlan` builds `['-a', ...reflink, from, to]`
   and calls `runFile('cp', args, ...)` (`src/main/worktree-ipc.ts:313-316`). No `cp`
   on Windows → `spawn cp ENOENT`.

Because create is transactional, either ENOENT triggers `rollbackWorktree`
(`worktree-ipc.ts:376`), which removes the checkout **and deletes the branch
`git worktree add -b` just created**. The user is left with a bare `spawn sh ENOENT`
and no worktree — the failure mode BUG-28's disclosure work exists to prevent, here
arriving with an error string that doesn't even name a real cause.

Notably the only platform check in the whole file is `platform() === 'linux'` gating
the `--reflink=auto` flag (`worktree-ipc.ts:293`) — the portability thought went into
the micro-optimization and skipped the fundamentals.

## Root cause

Two hardcoded POSIX binaries on the create path, in a module that otherwise never
consults `process.platform`. The repo already owns the pattern this needs:
`defaultShell()` (`src/main/pty.ts:71-80`) resolves the shell per platform
(`process.env.ComSpec ?? 'powershell.exe'` on `win32`, `$SHELL ?? /bin/bash`
otherwise), and `pty.ts:140` already builds a PowerShell `-NoProfile -Command`
invocation. That resolver is private to `pty.ts` and was never reachable from
`worktree-ipc.ts`.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`WORKTREE.md` `setup:`/`create:`/`remove:` commands are POSIX-shell strings on every platform.** They are not translated, not run through PowerShell, not parsed. See ADR-0005 for why.                                                                                                                                                                                          |
| D2  | On Windows, resolve a real POSIX shell (Git Bash) and run the command through it. Resolution order: `%CAPY_POSIX_SHELL%` (escape hatch) → `where.exe bash` → the standard Git-for-Windows install paths (`%ProgramFiles%\Git\bin\bash.exe`, `%ProgramFiles(x86)%\Git\bin\bash.exe`, `%LocalAppData%\Programs\Git\bin\bash.exe`). First hit wins; the result is cached per process. |
| D3  | **No POSIX shell found ⇒ fail LOUDLY at create time, before `git worktree add` runs.** The pre-flight check runs before any mutation, so nothing is created and nothing is rolled back. The error names the requirement and how to satisfy it — never `spawn sh ENOENT`.                                                                                                           |
| D4  | Replace the `cp` subprocess with Node's `fs.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })` on every platform. Keep the Linux `cp --reflink=auto` fast path, tried first and falling back to `fs.cp` if the binary is missing or fails.                                                                                                       |
| D5  | Extract the per-platform shell resolver from `pty.ts` into a shared `src/main/shell-resolve.ts`; `pty.ts` imports it rather than keeping a private copy. No duplicated platform logic.                                                                                                                                                                                             |

**Product-rule grounding.** Zero-friction says a worktree is born usable, so we do the
work of finding Git Bash rather than making the user configure it (D2). Honest errors
says when we genuinely cannot proceed we say so precisely and early, rather than
emitting a subprocess-level ENOENT after silently destroying a branch (D3).

## Scope boundary — files

**In scope:**

- `src/main/shell-resolve.ts` — **new.** `defaultShell()` moved from `pty.ts`, plus
  `resolvePosixShell(): Promise<string | null>` (D2, cached) and
  `posixShellRequirementError()` (the D3 message).
- `src/main/pty.ts` — delete the local `defaultShell()` (`:71-80`), import from
  `shell-resolve.ts`. No behavior change.
- `src/main/worktree-ipc.ts` — `runManifestCommand` (`:338-350`) uses the resolved
  POSIX shell; `applySeedPlan` (`:292-325`) uses `fs.cp` with the Linux reflink fast
  path; `createWorktree` gains the D3 pre-flight before `git worktree add`.
- `docs/user/` — the `WORKTREE.md` manifest page states the POSIX contract and the
  Windows requirement.
- `CHANGELOG.md` — dated entry under `### Fixed`.

**Out of scope:** translating manifest commands to PowerShell; a WSL execution mode;
bundling a shell with Capy; any change to how manifests are parsed or to the seed
plan's `link` (symlink) branch; BUG-28's error-disclosure work (separate card, stacked).

**Not agent-facing.** No MCP verb signature or ACK shape changes, so no
`docs/capy-features.md` edit and no version-marker bump. The D3 failure surfaces
through the existing `create_worktree` error channel.

## Acceptance criteria

1. On `win32` with Git Bash installed, a repo with a `setup:` step and a `copy:` seed
   provisions a worktree successfully.
2. On `win32` with **no** POSIX shell resolvable, `create_worktree` fails before
   `git worktree add` runs, with an error naming Git Bash as the requirement and the
   `CAPY_POSIX_SHELL` override. No worktree is created; no branch is created or
   deleted; the message is never `spawn sh ENOENT`.
3. The seed no longer depends on a `cp` binary existing on any platform.
4. On Linux the reflink fast path is still attempted, and a reflink failure silently
   falls back to `fs.cp` rather than failing the create.
5. POSIX behavior is unchanged: manifest commands still run via `$SHELL`-independent
   `sh -c` semantics with the same `spawnEnv()` (BUG-27's login-shell PATH) and the
   same `SETUP_TIMEOUT_MS` / `SETUP_MAX_BUFFER` limits.
6. `pty.ts` has no local shell resolver; both call sites use `shell-resolve.ts`.

## TDD plan

Harness: **vitest** (`npm run test`). Nearest existing suite:
`tests/worktree-manifest.test.ts`.

**Write this failing test FIRST**, in a new `tests/worktree-shell-resolve.test.ts`:

```
describe('runManifestCommand shell resolution', () => {
  it('runs manifest commands through the resolved POSIX shell on Windows', ...)
})
```

Stub `process.platform` → `'win32'` and stub the shell resolver to return
`C:\Program Files\Git\bin\bash.exe`, then assert the injected command runner was
invoked with that binary and `['-c', cmd]` — **not** `'sh'`. Today the call site is
unconditional (`worktree-ipc.ts:340`), so this fails on the literal `'sh'`.

Then, in the same file:

1. `platform='win32'`, resolver returns `null` → `createWorktree` rejects with an
   error matching `/Git Bash|CAPY_POSIX_SHELL/`, and the git runner was **never**
   called with `worktree add` (proves the pre-flight ordering, AC2).
2. `applySeedPlan` with a `copy` op on `platform='win32'` calls the `fs.cp` seam and
   never spawns `cp` (AC3).
3. `platform='linux'` attempts `cp --reflink=auto` first; when that runner rejects,
   `fs.cp` is called and the op resolves (AC4).
4. `platform='linux'` manifest command still resolves to `sh -c` with `spawnEnv()`
   applied (AC5 — the regression guard).

Extract the command runner, the `fs.cp` call, and the platform read as injectable
seams so none of these tests touch a real filesystem or spawn a process, matching how
`tests/worktree-manifest.test.ts` already isolates the manifest layer.
