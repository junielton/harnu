# ADR-0005 — `WORKTREE.md` manifest commands are POSIX-shell strings on every platform

**Status:** Accepted
**Date:** 2026-07-19
**Author:** junielton (via dispatched agent)
**Deciders:** junielton
**Technical context:** `src/main/worktree-ipc.ts`, `src/main/pty.ts`, BUG-29
**Spec:** `docs/specs/2026-07-19-worktree-windows-shell.md`

---

## 1. Context

`runManifestCommand` executes every `WORKTREE.md` `setup:` / `create:` / `remove:`
string as `runFile('sh', ['-c', cmd], ...)` (`src/main/worktree-ipc.ts:340`),
unconditionally. There is no `sh` on a stock Windows box, so `create_worktree`
fails with `spawn sh ENOENT` for any repo declaring a setup step — and because the
create is transactional, `rollbackWorktree` (`:376`) then deletes the checkout and
the freshly-created branch. The feature is simply unavailable on Windows.

Fixing the ENOENT is mechanical. The decision that has to be written down is the
one BUG-29's third fix direction names explicitly: **what kind of string is a
manifest command?** Every repair strategy answers that question differently, and
the answer becomes a contract every `WORKTREE.md` author in every Capy-managed repo
depends on. It cannot be settled implicitly inside a bugfix.

The manifests in the wild are POSIX today — `npm ci`, `cp .env.example .env`,
`composer install && php artisan key:generate`. They are committed repo content
authored by humans who were looking at a Linux/macOS shell when they wrote them.

## 2. Decision

**A manifest command is a POSIX-shell string, on every platform, always.** Capy
never translates, rewrites, or reinterprets it.

On Windows, Capy resolves a real POSIX shell (Git Bash) and runs the command
through it: `%CAPY_POSIX_SHELL%` → `where.exe bash` → the standard Git-for-Windows
install paths. If none resolves, `create_worktree` **fails loudly in a pre-flight
check, before `git worktree add` runs**, with an error naming Git Bash as the
requirement and the `CAPY_POSIX_SHELL` escape hatch — so nothing is created and
nothing is rolled back.

The per-platform shell resolver already living in `pty.ts:71-80` is extracted to a
shared `src/main/shell-resolve.ts` and reused, rather than duplicated.

Separately and independently: the seed's `cp` subprocess (`worktree-ipc.ts:313-316`)
is replaced by Node's `fs.cp`, keeping `cp --reflink=auto` as a Linux fast path.
That removes a POSIX binary dependency without touching the command contract at all.

## 3. Alternatives considered

- **Translate manifest commands to PowerShell on Windows.** Rejected. It is not
  implementable in the general case — `&&`, `||`, `$(...)`, globs, quoting, and
  `2>/dev/null` have no faithful mechanical translation — and a _partial_ translator
  is worse than none: it would silently mis-execute a command the manifest author
  reviewed, in a step whose whole purpose is trusted setup. It also breaks the MCP
  create confirm's contract, which discloses these commands **verbatim** to the
  operator before approval (`previewWorktreeCommands` / `buildConfirmDisclosure`,
  T08) — the operator would be approving a string Capy does not actually run.
- **Per-platform manifest keys (`setup:` / `setup.windows:`).** Rejected for now.
  It pushes the portability burden onto every repo author, doubles the manifest
  surface, and rots immediately — the Windows variant goes untested in a repo whose
  contributors are on Linux. Revisit only if a concrete repo needs genuinely
  different setup per platform; this ADR does not preclude it.
- **Run manifest commands through WSL.** Rejected as the primary path. WSL is not
  universally present, its filesystem boundary makes paths ambiguous (`/mnt/c/...`
  vs the Windows path the worktree actually lives at), and the failure modes are
  far harder to explain than "install Git for Windows".
- **Keep failing, document Windows as unsupported.** Rejected. Git Bash ships with
  Git for Windows, which any user running `git worktree` already has — the
  requirement is effectively already satisfied on a developer machine. Declaring the
  feature unsupported would be a bigger admission than the fix costs.
- **Silently skip the setup step when no shell is found.** Rejected outright, and
  worth naming because it is the tempting shortcut. It produces exactly the failure
  Capy's worktree manifest exists to eliminate: a worktree that _looks_ created but
  has no deps and no `.env`, discovered minutes later as a confusing build error.
  Honest errors over a broken-but-quiet success.

## 4. Consequences

- `WORKTREE.md` authors write one command set and it means the same thing
  everywhere. No `if windows` in committed manifests.
- Windows gains a hard dependency on Git for Windows for repos with `setup:` steps.
  This is stated plainly in `docs/user/`, and surfaced at create time by the D3
  pre-flight rather than discovered as a subprocess error.
- The pre-flight adds a resolution step before `git worktree add`. The result is
  cached per process, so the cost is one `where.exe` probe per app run on Windows
  and zero on POSIX.
- Extracting `defaultShell()` into `shell-resolve.ts` gives Capy one place where
  "which shell" is decided. Any future caller (a task runner, a hook executor) must
  use it rather than hardcoding a binary — that is the point of the extraction, and
  a reviewer should push back on a new hardcoded `'sh'` or `'powershell.exe'`
  anywhere in `src/main/`.
- If a future feature genuinely needs a non-POSIX command surface, it needs its own
  ADR revising this one — not a quiet second execution path bolted onto
  `runManifestCommand`.
