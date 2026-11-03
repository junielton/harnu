---
status: approved
tier: large
---

# BUG-240 · Stop the mission derive from flooding the main process with spawns

## Problem

Harnu lags globally, like a game running at low FPS: input, scrolling, terminal output and
clicks all stutter. It is most visible on key repeat: holding `.` for 30 s in a text box
produced 537 characters, where the desktop's repeat settings (KDE, Wayland, 600 ms delay,
25/s) predict about 735. About 27 % of the repeats are lost.

Harnu runs as a native Wayland client. There, Chromium handles every input event, key
repeat, frame callback and IPC reply on the main process UI thread. A stall on that thread
is lag everywhere, not in one pane.

Measured on 2026-11-02 against the packaged AppImage, idle apart from one waiting session:

- **CPU profile, 15 s, main process** (inspector opened with `SIGUSR1`):
  - The main thread is busy 8.3 s of 15.3 s of wall time. It stalls 116 times for more
    than 16 ms (one frame) and 20 times for more than 100 ms; the longest stall is 291 ms.
  - 6.46 s of the busy time is inside the synchronous part of `child_process.spawn`
    (median 7.3 ms per spawn, max 81.6 ms). Forking the Electron main process (about
    1.4 TB of virtual address space) is expensive, and `execFile` does it on the main
    thread.
- **Spawn census, 20 s**, made by patching `ChildProcess.prototype.spawn` to log each
  `file` and `args`, then restoring it. There were 636 spawns, bunched into about 8 s of
  each 20 s poll:

  | spawns / 20 s | command                                             | caller                               |
  | ------------- | --------------------------------------------------- | ------------------------------------ |
  | 198           | `git log -1 --format=%H%x00%s%x00%cI`               | `worktreeHead`                       |
  | 97            | `git rev-parse --abbrev-ref HEAD`                   | `worktreeHead`                       |
  | 99            | `git rev-list --count <ref>..HEAD`                  | `commitsAhead`                       |
  | 93            | `git symbolic-ref --short refs/remotes/origin/HEAD` | `defaultBranchOf`                    |
  | 72            | `gh pr view <n> --json mergeCommit`                 | `mainCiOf`                           |
  | 72            | `gh run list --commit <oid>`                        | `mainCiOf`                           |
  | 5             | `gh pr list`                                        | `fetchPrs` (already cached for 60 s) |

  The PR Stack canvas (`behindCounts`) ran none of them. There are 122 distinct `-C`
  paths in the census.

All of these come from `deriveMissionSignals` (`src/main/mcp/tool-handlers.ts`):

- The renderer's mission store (`src/renderer/src/stores/missions.ts`) polls
  `mission:list` every 20 s, and each poll derives every non-closed mission in every known
  repo (36 open missions on this machine). `mission_get`, `campaign_get`, the steward's
  `gatesFor` and the merge-batch dialog run the same derive.
- Per existing `worktree` link, `findPrsForWorktrees` (`src/main/pr-stack.ts`) spawns
  `git log`, `git rev-parse`, `git symbolic-ref` (`defaultBranchOf`, uncached) and one to
  four `git rev-list`. Nothing is cached.
- About 100 of the 198 `git log` calls fail, because their path is not a git working tree:
  `worktree` links that point to a file (a spec document) or a directory with no `.git`.
  `git log` failing is the only result such a link can get, yet it is paid for again on
  every poll.
- Per merged PR, `resolveMainCi` re-asks `findMainCi` until the merge commit's CI has been
  green for 30 minutes (`MAIN_CI_FINAL_AFTER_MS`). `findMainCi` caches for 60 s, and each
  miss costs two `gh` spawns. So a merged PR whose main CI is failing, missing or never
  green (CI disabled, billing block) costs two `gh` spawns every minute, forever.
  `gh pr view --json mergeCommit` is re-asked even though a merged PR's merge commit never
  changes.
- Paths that no longer exist are already skipped (`pathExists` in `deriveMissionSignals`).
  That part needs no change.

The answers almost never change between polls. A worktree's head, branch and commit counts
only move on a commit, checkout or fetch. A merged PR's merge commit never moves. A
completed CI run only moves on a re-run.

Request atoms:

- R-1 Harnu stutters globally, like a game at low FPS.
- R-2 Holding a key for 30 s produces far fewer characters than the repeat rate predicts.

## Goals

- G-1 With the operator's current missions open and nothing changing on disk or on
  GitHub, a mission poll spawns no `git` and almost no `gh`, and the main thread no longer
  stalls on spawns.
- G-2 What a mission reports (`derived` links, commits, PRs, gates and progress) is the
  same as before, both while nothing changes and right after a commit, checkout, fetch or
  CI re-run.

**Non-goals:**

- Moving `git`/`gh` work into a `utilityProcess` or worker. That is the follow-up if this
  spec is not enough (D-2).
- Changing the 20 s poll interval, `LIST_CONCURRENCY`, or the shape of any derived field.
- The smaller spawn sites seen in the profile (`probeGitMeta` in `claude-reader.ts`,
  `runGit` in `gatherGitEvidence`). Together they took under 0.1 s in 15 s.
- The renderer's idle CPU (about 46 %). It is a separate suspect, profiled separately.

**Anti-goals:**

- A cache that serves a stale commit count, branch or CI state after the thing it describes
  changed. A mission that says "0 commits" for a branch that has commits, or "main green"
  after a red re-run, is worse than a slow one.
- A file-reading shortcut that is wrong on a repo layout it did not anticipate (packed refs,
  linked worktrees, detached HEAD, a reftable repo). Anything it does not fully understand
  must fall back to today's spawn path.
- Swapping spawns for synchronous file I/O on the main thread. Every new read uses
  `fs/promises`; no `*Sync` call is added.

## Slices

### S-1 · Spawn-free repeat derive

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/pr-stack.ts`, `src/main/git/refs.ts` (new), `tests/pr-stack-mission-join.test.ts`, `tests/pr-stack-main-ci.test.ts` (new or existing), `tests/git-refs.test.ts` (new), `CHANGELOG.md`, `docs/specs/2026-11-02-BUG-240-git-spawn-storm.md`
- produces: —
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11

Design, in the order the executor builds it:

1. **`src/main/git/refs.ts`: read refs from the git directory without spawning.** It lives
   in a nested directory on purpose: a new file directly under `src/main/` trips the
   user-docs gate, and this one is internal. It exports two functions: one resolves
   `{ gitDir, commonDir }` for a working-tree path, and one reads a ref's sha.
   - Locate the git directory by checking the path itself for `.git`. Do not walk up the
     parents.
   - A `.git` directory means the git dir and the common dir are the same. A `.git` file
     holds `gitdir: <path>`, where a relative path resolves against the worktree. The common
     dir is then `<gitdir>/commondir`, resolved against the git dir, when that file exists;
     otherwise it is the git dir.
   - `HEAD` is either `ref: refs/heads/<name>` (a branch) or a 40-hex sha (detached).
   - To resolve a ref: read the loose file `<commonDir>/<ref>` first. If it does not exist,
     look the ref up in `<commonDir>/packed-refs` and skip `^` peeled lines.
   - Return a sentinel ("can't tell") instead of guessing when any of these hold:
     `<commonDir>/reftable` exists, `extensions.refStorage` is set in `<commonDir>/config`,
     a file holds content of an unexpected shape, a symbolic ref has more than one level,
     or any read throws. On the sentinel the caller uses the spawn path.
   - Reads use `fs/promises` only.
2. **Short-circuit paths that are not working trees.** If the path is not a directory, or it
   has no `.git` entry, `worktreeHead` returns `{ exists: false, branch: null, head: null }`
   without spawning. That is exactly what today's failing `git log` returns.
3. **Cache `worktreeHead`, keyed by the head.** Key it by
   `(realpath, headSha, symbolic ref or "detached")`, read through `git/refs`.
   - On a hit, return the cached `{ branch, head }` without spawning. The commit subject and
     date are fixed by the sha, so a hit is exact.
   - On a miss, run today's two spawns and store the result.
   - On the sentinel, run today's two spawns and store nothing.
4. **Cache `commitsAhead`, keyed by every input that can change the answer.** Key it by
   `(realpath, headSha, prBase ?? "", defaultBranch, sha or "missing" of every candidate
base ref)`. The candidates are `origin/<base>` and `<base>` for each base, in today's
   order.
   - On a hit, return the cached number (or `undefined`) without spawning.
   - On a miss, run today's loop and store the result.
   - On the sentinel, run today's loop and store nothing.
5. **Memoize `defaultBranchOf` per common dir, keyed by the content of
   `<commonDir>/refs/remotes/origin/HEAD`.** Read it as a symbolic ref through `git/refs`.
   When the file is absent, or the sentinel fires, fall back to today's spawn and cache that
   result for 10 minutes, so a repo without `origin/HEAD` does not spawn on every poll.
6. **Make the `main` gate cheap.** All in `pr-stack.ts`, inside `findMainCi`; the stickiness
   in `resolveMainCi` is unchanged.
   - Cache a merged PR's merge-commit oid (`gh pr view --json mergeCommit`) for the life of
     the process: a merged PR's merge commit never changes. A lookup that returns no oid is
     not cached.
   - Cache the `gh run list` verdict by oid. Re-ask a `pending` verdict after 60 s, as
     today. Re-ask a completed verdict (`passing` or `failing`) or an empty one (no runs)
     after 10 minutes, so a CI re-run is still noticed within 10 minutes.
7. **Bound and share the caches.**
   - Each cache is a `Map` with at most 512 entries. When full, it evicts the oldest
     insertion.
   - A miss is single-flight per key: concurrent derives of missions that share a worktree
     or a PR await one promise. A rejected promise is not kept.
   - The module exports a `resetGitJoinCachesForTest()` for tests.
8. **Spec-first and test-first.**
   - The first commit on the branch adds this spec at
     `docs/specs/2026-11-02-BUG-240-git-spawn-storm.md`, with `status: approved`.
   - The second commit adds the failing tests for AC-1 to AC-8.
   - The report names which tests went red before the implementation and green after.

## Acceptance criteria

The join tests count spawns at the existing `execFile` seam in
`tests/pr-stack-mission-join.test.ts`. `git` still runs for real against a throwaway repo
there, the seam only counts calls, and `gh` stays faked.

| id    | statement                                                                                                                                                                                                                                                                                                                                                                       | proof                                                                                                                       | refines/inherits | covers   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| AC-1  | A second `findPrsForWorktrees` call on an unchanged worktree spawns zero `git` processes, and returns the same `worktrees[path]` as the first.                                                                                                                                                                                                                                  | test:tests/pr-stack-mission-join.test.ts::repeat join on an unchanged worktree spawns no git                                | —                | R-1, R-2 |
| AC-2  | After a new commit in the worktree, the next call reports the new head sha, subject and commit count.                                                                                                                                                                                                                                                                           | test:tests/pr-stack-mission-join.test.ts::a new commit invalidates the cached head and count                                | AC-1             | R-1      |
| AC-3  | After `git checkout -b` to another branch, the next call reports the new branch. After the base ref moves (a new commit on the base branch), the next call reports the new `commits` count.                                                                                                                                                                                     | test:tests/pr-stack-mission-join.test.ts::checkout and a moved base invalidate the cache                                    | AC-1             | R-1      |
| AC-4  | A `worktree` link that points to a regular file, or to a directory with no `.git` entry, spawns zero `git` processes and returns `{ exists: false, branch: null, head: null }`, the same as today.                                                                                                                                                                              | test:tests/pr-stack-mission-join.test.ts::a link that is not a working tree spawns no git                                   | —                | R-1      |
| AC-5  | `git/refs` resolves HEAD and refs for a main checkout, a linked worktree (`.git` file plus `commondir`), a detached HEAD, a ref that exists only in `packed-refs`, and a missing ref. It returns the "can't tell" sentinel for a `reftable` directory and for malformed `HEAD` content, and on the sentinel the join falls back to spawning and still returns the right answer. | test:tests/git-refs.test.ts::resolves refs across layouts and falls back when unsure                                        | —                | R-1      |
| AC-6  | `defaultBranchOf` spawns at most once per repo across repeated calls while `refs/remotes/origin/HEAD` is unchanged, and picks up a changed `origin/HEAD` on the next call.                                                                                                                                                                                                      | test:tests/pr-stack-mission-join.test.ts::default branch is read once per repo                                              | AC-1             | R-1      |
| AC-7  | `findMainCi` asks `gh pr view` for a merged PR's merge commit once per process. A `passing`, `failing` or empty verdict is not re-asked for 10 minutes, a `pending` verdict is re-asked after 60 s, and a verdict that changes after a re-run is reported once the 10-minute window has passed.                                                                                 | test:tests/pr-stack-main-ci.test.ts::main CI is cached by merge commit and re-checked on a schedule                         | —                | R-1      |
| AC-8  | Two derives of missions that share a worktree and a merged PR, started at the same time, cost exactly one set of spawns.                                                                                                                                                                                                                                                        | test:tests/pr-stack-mission-join.test.ts::concurrent derives share one lookup                                               | AC-1             | R-1      |
| AC-9  | All the existing mission, PR-stack and derive tests pass unchanged.                                                                                                                                                                                                                                                                                                             | script:npx vitest run tests/pr-stack-mission-join.test.ts tests/mission-derived-signals.test.ts tests/pr-stack-core.test.ts | AC-1             | R-1      |
| AC-10 | Measured on the operator's own data with the recipe below, a 40 s spawn census taken after the first mission poll has settled counts at most 10 `git` and at most 10 `gh` spawns. A 15 s CPU profile over the same state shows under 0.5 s of self time in `spawn`. The before and after numbers are in the PR body.                                                            | record:profile                                                                                                              | —                | R-1, R-2 |
| AC-11 | `CHANGELOG.md` has a `### Fixed` entry under the merge date describing the lag fix in user terms.                                                                                                                                                                                                                                                                               | record:changelog                                                                                                            | —                | R-1      |

AC-10 recipe for the verifier:

1. Find the main process: the `harnu` process with no `--type=` flag.
2. Run `kill -USR1 <pid>` to open the inspector on 127.0.0.1:9229.
3. For the census, use `Runtime.evaluate` to wrap
   `process.mainModule.require('child_process').ChildProcess.prototype.spawn` so it logs
   `opts.file` and `opts.args`. Wait 40 s, restore the original, and read the log.
4. For the profile, call `Profiler.start`, wait 15 s, call `Profiler.stop`, then sum the
   self time of the native `spawn` node.
5. Close the inspector with `process._debugEnd()`.

The key-repeat symptom (R-2) is confirmed by the operator by hand on Wayland. Hold `.` for
30 s; at least 95 % of `(30 − delay) × rate` characters must appear. This is a human check on
the mission step, not an automated AC.

## Open decisions

| id  | question                                                                                  | options                                                                                           | default   | status                                     |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------ |
| D-1 | How does the git cache know a worktree changed?                                           | sha-keyed (read the git dir files; exact), TTL (re-spawn every N s; simpler, stale for up to N s) | sha-keyed | resolved: sha-keyed (operator, 2026-11-02) |
| D-2 | Is moving `git`/`gh` spawns off the main thread (`utilityProcess`) part of this delivery? | follow-up card if AC-10 fails, include now                                                        | follow-up | resolved: follow-up (operator, 2026-11-02) |

## Amendments · Deviations

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
