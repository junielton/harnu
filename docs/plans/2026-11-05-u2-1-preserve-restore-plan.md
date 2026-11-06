# U2.1 — Preserve / verify / restore engine for worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An engine that preserves everything in a worktree that git does not already hold, proves it is recoverable, and restores the worktree byte-for-byte — without removing anything.

**Architecture:** Everything lives in the repo's object store under `refs/archive/<branch>/<stamp>/…` (or `refs/archive/detached/<stamp>/<key>/…`). The existing `tip` / `wip` refs (via `archiveTip` / `archiveWip`) hold commits and uncommitted + untracked state. New refs under the same namespace add: `shelve/ignored` (a commit whose tree is the snapshot of gitignored files outside dependency dirs), `shelve/stash/<n>` (copies of matching stash commits), and `shelve/record` (a commit whose tree holds `record.json`, written last: its presence is what makes the archive a _shelve record_). Verification recomputes git tree hashes from the live worktree and compares them with the archived trees. A pure core (`shelve-core.ts`) holds the decisions; a shell (`shelve-shell.ts`) holds the git I/O (ADR-0001).

**Tech Stack:** TypeScript (Electron main), vitest, git CLI ≥ 2.31.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` — §2, §3 (anti-goals), §4 U2, §5, §7 (C3, C4, C10), §8 (D-A..D-C); risks 1, 3, 6 in `docs/studies/2026-10-27-autonomous-cleanup-risks.md`. Card: T631.

## Global Constraints

- English only in code, comments, tests, commit messages. Conventional Commits with a `(U2.1)` suffix. No attribution lines.
- This unit removes NOTHING: no folder, branch, ref (other than refs this call created and must roll back), stash or file outside a path that does not exist yet.
- Refs are written only under `refs/archive/**`. Never `git push`, `git fetch`, `git gc`, `git stash push|pop|drop`, `git prune`. The stash stack (`refs/stash` and its reflog) is only read.
- Dependency dirs = the manifest `ephemeral:` list (`DEFAULT_EPHEMERAL` = `node_modules`, `vendor`, `.venv`, `venv`), each normalised with `normalizeEphemeralEntry`; matched by exact worktree-relative path or prefix, like dehydrate. Nested occurrences are NOT excluded (dehydrate does not remove them either); they count toward the cap.
- Snapshot cap: `DEFAULT_SNAPSHOT_CAP_BYTES = 256 * 1024 * 1024` (256 MiB), overridable per call. Above the cap, preservation is refused with a reason and nothing is written; never truncated. Rationale: shelving exists to free disk (dependencies + build output are typically hundreds of MB to GB); a snapshot above 256 MiB would give most of it back, and `.env*`, dumps and `.harnu/out` screenshots measured on this corpus fit well under it.
- Fail closed: any probe or git error in preserve / verify / restore yields `ok: false` with a reason, never a throw to the caller and never a silent pass.
- Preservation data is local and durable: records are excluded from archive auto-expiry (`expiredArchives`) while their branch exists; with no way to prove the branch is gone, never expired.
- Test repos are throwaway repos in `os.tmpdir()`; never touch this repo's own refs or stash. CPU budget: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- No CHANGELOG entry (internal engine), no `docs/harnu-features.md`, no `docs/user/` (no new component, no new top-level `src/main/` file — the new files are under `src/main/gc/`).

## Review Focus

1. Untracked nested git repo (`git add -A` records a gitlink with no content) → preserve refuses `nested-repository` rather than "preserving" an empty pointer. Task 3.
2. A file edited between preserve and verify → verify fails closed (`worktree-changed`). Task 4.
3. Branch tip moved (or branch checked out in another worktree) between shelve and restore → restore lands detached at the archived HEAD and says so; never reverts newer commits' content onto a branch. Task 5.
4. Worktree folder deleted by `rm -rf` leaves a stale registration (`prunable`) → restore must still work at the same path. Task 5.
5. Two shelves of the same branch within the same second, or a stash whose subject only _contains_ the branch name (`feat/x` vs `feat/x-2`) → no overwrite, no false match. Tasks 1 and 3.

---

### Task 1: Pure core — names, record, stash matching, dependency filter, restore base

**Files:**

- Create: `src/main/gc/shelve-core.ts`
- Modify: `src/main/reaper/archive-core.ts` (export `SHELVE_REF_DIR = 'shelve'` only)
- Test: `tests/gc-shelve-core.test.ts`

**Interfaces:**

- Produces:
  - `DEFAULT_SNAPSHOT_CAP_BYTES: number`
  - `shelveRefs(namespace: string, stashCount: number): { ignored: string; record: string; stashes: string[] }` → `${namespace}/shelve/ignored`, `…/shelve/record`, `…/shelve/stash/<i>`
  - `interface ShelveRecord` (fields below) and `parseShelveRecord(json: string): ShelveRecord | null` (null on any shape/version mismatch), `serializeShelveRecord(r: ShelveRecord): string`
  - `isDependencyPath(rel: string, dependencyDirs: readonly string[]): boolean` — true when `rel` equals a dep dir or lies under one (trailing `/` on `rel` tolerated)
  - `stashesForBranch(entries: ReadonlyArray<{ sha: string; subject: string }>, branch: string): Array<{ sha: string; subject: string }>` — a subject matches only `On <branch>:` or `WIP on <branch>:` exactly (the branch followed by `:`)
  - `parseWorktreeList(porcelain: string): Array<{ path: string; branch: string | null; head: string | null; prunable: boolean }>`
  - `decideRestoreBase(i: { record: Pick<ShelveRecord, 'branch' | 'headSha'>; branchTip: string | null; checkedOutAt: string | null; targetPath: string }): { mode: 'branch' | 'detached'; reason: null | 'branch-missing' | 'branch-moved' | 'branch-checked-out-elsewhere' | 'no-branch' }` — `branch` only when the branch exists, its tip equals `record.headSha`, and it is not checked out at another path
- `ShelveRecord` = `{ version: 1; createdAt: number; repoPath: string; worktreePath: string; branch: string | null; headSha: string; namespace: string; tipRef: string; wipRef: string; wipCommit: string; wipTree: string; ignored: { ref: string; commit: string; tree: string; fileCount: number; bytes: number } | null; stashes: Array<{ ref: string; sha: string; subject: string }>; dependencyDirs: string[]; snapshotCapBytes: number }`

- [ ] **Step 1: Write the failing test** `tests/gc-shelve-core.test.ts` covering: `shelveRefs('refs/archive/feat/x/20261105T100000Z', 2)` returns the three-shape names; `parseShelveRecord(serializeShelveRecord(r))` round-trips and returns `null` for `version: 2`, a missing `wipTree`, non-JSON; `isDependencyPath('node_modules/a/b', ['node_modules'])` true, `isDependencyPath('src/node_modules', ['node_modules'])` false, `isDependencyPath('node_modules_x/a', ['node_modules'])` false; `stashesForBranch` keeps `On feat/x: wip` and `WIP on feat/x: abc1234 msg`, drops `On feat/x-2: wip` and `WIP on main: …`; a branch with regex metacharacters (`fix/a.b+c`) matches literally; `parseWorktreeList` handles `prunable` and detached entries; `decideRestoreBase` table: branch ok → `branch`; tip differs → `detached`/`branch-moved`; branch absent → `branch-missing`; checked out at another path → `branch-checked-out-elsewhere`; checked out at `targetPath` itself (stale registration) → still `branch`; `branch: null` → `detached`/`no-branch`.
- [ ] **Step 2: Run it to verify it fails**: `nice -n 19 npx vitest run tests/gc-shelve-core.test.ts --maxWorkers=10 --minWorkers=1` → FAIL (module not found). **Commit the test** (`test(gc): shelve core names, record and restore-base decisions (U2.1)`).
- [ ] **Step 3: Implement** `src/main/gc/shelve-core.ts` and the one-line constant export in `archive-core.ts`. `parseShelveRecord` validates every field's type by hand (no new dependency).
- [ ] **Step 4: Run to verify it passes**, then **commit** (`feat(gc): shelve core — record format, stash matching, restore base (U2.1)`).

### Task 2: Archive grouping knows shelve records; expiry never takes them

**Files:**

- Modify: `src/main/gc/archives-core.ts` (`ArchiveEntry.shelved`, `groupArchiveRefs`, `expiredArchives`)
- Test: `tests/gc-archives-shelved.test.ts`

**Interfaces:**

- Consumes: `SHELVE_REF_DIR` (Task 1).
- Produces: `ArchiveEntry.shelved: boolean` — true when the namespace has a `shelve/record` member; `shelve/ignored`, `shelve/stash/<n>` and `shelve/record` refs are members of their namespace's entry (sweep or detached), not stand-alone generic entries. `expiredArchives(entries, keepDays, now, branchesGone?: ReadonlySet<string>)` — a `shelved` entry is never returned unless `branchesGone` is given AND contains `entry.branch` (a detached shelved entry has no branch, so it is never returned). Existing callers pass three arguments and therefore never expire a shelved entry (fail closed).

- [ ] **Step 1: Write the failing test**: build refs by hand (`ArchiveRefInfo[]`) for a branch sweep with `tip`, `wip`, `shelve/record`, `shelve/ignored`, `shelve/stash/0` → one entry, `shelved: true`, six… five members; same without `shelve/record` → `shelved: false`; detached namespace with shelve refs → one entry, `shelved: true`; `expiredArchives(entries, 1, NOW + 3650 * DAY)` returns `[]` for shelved entries but returns an unshelved old one; with `branchesGone = new Set(['feat/x'])` the shelved `feat/x` entry is returned, the detached one still is not; shelve refs seen before `tip` in input order still group into one entry (order independence).
- [ ] **Step 2: Run to verify it fails**; **commit the test** (`test(gc): shelved archives group as one entry and never auto-expire (U2.1)`).
- [ ] **Step 3: Implement** in `archives-core.ts`: a second sweep regexp for `…/<stamp>/shelve/(record|ignored|stash/\d+)`, the same alternative added to `DETACHED_REF`'s role group, a get-or-create draft helper so ref order does not matter, `shelved` on `Draft`/`finish`. Keep `deleteArchiveEntries`/`membersOf` unchanged (they already delete every member).
- [ ] **Step 4: Run** `tests/gc-archives-shelved.test.ts tests/gc-archives-core.test.ts tests/gc-archives-detached-real-git.test.ts tests/gc-archives-real-git.test.ts tests/gc-archives-retention.test.ts` → all pass; run `npm run typecheck` (fixes any fixture needing `shelved`). **Commit** (`feat(gc): archives group shelve records and exempt them from expiry (U2.1)`).

### Task 3: `preserveWorktree` — wip, tip, detached, stashes, ignored snapshot, cap, record

**Files:**

- Create: `src/main/gc/shelve-shell.ts`
- Test: `tests/gc-shelve-preserve-real-git.test.ts`

**Interfaces:**

- Consumes: `planArchive`, `archiveNamespace`, `detachedArchiveNamespace` (via `planArchive`), `archiveTip`, `archiveWip` (`reaper/archive-*`), `DEFAULT_EPHEMERAL`, `normalizeEphemeralEntry`, Task 1 pure functions.
- Produces:
  - `type PreserveRefusal = 'worktree-missing' | 'head-unresolvable' | 'snapshot-too-large' | 'nested-repository' | 'probe-failed' | 'verification-failed' | 'ref-exists'`
  - `interface PreserveInput { repoPath: string; worktreePath: string; branch: string | null; now: number; dependencyDirs?: readonly string[]; capBytes?: number }`
  - `type PreserveResult = { ok: true; record: ShelveRecord } | { ok: false; reason: PreserveRefusal; message: string; bytes?: number; capBytes?: number }`
  - `preserveWorktree(input: PreserveInput): Promise<PreserveResult>`
  - `readShelveRecord(repoPath: string, namespace: string): Promise<ShelveRecord | null>`; `listShelveRecords(repoPath: string): Promise<ShelveRecord[]>` (`for-each-ref refs/archive/*/shelve/record`)
  - Internal, reused by Task 4/5: `snapshotIgnored(worktreePath, dependencyDirs, capBytes): Promise<{ ok: true; paths: string[]; bytes: number } | { ok: false; reason: 'snapshot-too-large' | 'nested-repository' | 'probe-failed'; bytes: number }>`, `workingTree(worktreePath): Promise<string>` (throwaway-index `read-tree HEAD` + `add -A` + `write-tree`, same recipe as `archiveWip`).

- [ ] **Step 1: Write the failing tests** (real git, `beforeEach` builds a repo + a linked worktree on `feat/x` containing a tracked edit, a staged new file, an untracked file, a deleted tracked file, an ignored `.env` and `.harnu/out/shot.txt`, and an ignored `node_modules/pkg/index.js`):
  - **AC-1**: result `ok`; `ls-tree -r <wipRef>` has the tracked/untracked files and not the ignored ones; `ls-tree -r <ignored.ref>` contains exactly `.env` and `.harnu/out/shot.txt` and NOT `node_modules/…`; `record.ignored.bytes` equals their sizes; with `capBytes` one byte below that sum → `{ ok: false, reason: 'snapshot-too-large', capBytes }` and `for-each-ref refs/archive/` is empty (nothing written); a repo with no ignored files → `record.ignored === null`.
  - **AC-2**: three stashes pushed from the worktree (`On feat/x`, `WIP on feat/x`) plus one from a branch `feat/x-2`; after preserve, `record.stashes.length === 2`, each `shelve/stash/<n>` ref resolves to the stash commit; `git stash list` output and `rev-parse refs/stash` are identical before and after.
  - **AC-3**: detached worktree (`branch: null`) → `refs/archive/detached/<stamp>/…/tip` resolves to HEAD; `record.branch === null`; stashes `[]`.
  - Nested untracked git repo inside the worktree → `nested-repository`, nothing written. Worktree path missing → `worktree-missing`. Two preserves with the same `now` for the same branch → second is `ok` (wip sibling logic) or `ref-exists` with no ref lost (assert the first record's refs still resolve).
  - Refs: every ref created is under `refs/archive/`; `git for-each-ref` outside it is unchanged; `record` ref is written last (assert via `shelve/record` absent after a forced failure — inject by `capBytes`).
- [ ] **Step 2: Run to verify it fails**; **commit the test** (`test(gc): preserveWorktree against real git — wip, ignored snapshot, stashes, detached (U2.1)`).
- [ ] **Step 3: Implement** `preserveWorktree`: validate folder + HEAD → `snapshotIgnored` (list ignored with `ls-files -z --others --ignored --exclude-standard --directory`, drop dependency paths, expand non-dependency directories with a second `ls-files -o -i` scoped to the dir, `lstat` for bytes, abort at the cap; a directory entry that survives expansion or holds a `.git` ⇒ `nested-repository`) → `planArchive` → `archiveTip` + `archiveWip` → untracked-gitlink check on the wip tree (`ls-tree -r`, mode 160000 absent from `HEAD`'s tree ⇒ `nested-repository`, roll back refs this call wrote) → ignored commit via throwaway index (`update-index --add -z --stdin`, `write-tree`, `commit-tree` with the Reaper identity, no parent) → stash copies (`stash list --format=%H%x09%gs`, `update-ref <ref> <sha>`) → `record.json` commit → `update-ref <record> <commit> <zero-oid>` (the commit point). Any throw after the first ref ⇒ delete exactly the refs this call created and return the refusal. Finally call `verifyPreservation` (Task 4) in `live` mode; failure ⇒ delete the record ref and return `verification-failed`.
- [ ] **Step 4: Run the new test file** → Task 3 tests pass except the final live-verify call, which is stubbed until Task 4: land Task 3 with `verifyPreservation` imported from the same file as a minimal archive-integrity-only implementation, then **commit** (`feat(gc): preserveWorktree — wip, ignored snapshot, stash copies, detached tip (U2.1)`).

### Task 4: `verifyPreservation`

**Files:**

- Modify: `src/main/gc/shelve-shell.ts`
- Test: `tests/gc-shelve-verify-real-git.test.ts`

**Interfaces:**

- Produces: `type VerifyMode = 'live' | 'archive'`; `type VerifyResult = { ok: true; mode: VerifyMode } | { ok: false; reason: 'ref-missing' | 'ref-moved' | 'object-missing' | 'worktree-missing' | 'worktree-changed' | 'head-moved' | 'probe-failed'; message: string; detail?: string }`; `verifyPreservation(record: ShelveRecord, opts?: { mode?: VerifyMode }): Promise<VerifyResult>` — default `live`.
- `archive` mode: tip/wip/ignored/stash refs resolve to the recorded shas; wip and ignored commits' trees equal the recorded trees; every blob and tree reachable from them exists (`ls-tree -r` + `cat-file --batch-check`). `live` mode adds: the worktree folder exists (`worktree-missing`), its HEAD equals `record.headSha` (`head-moved`), the recomputed `workingTree()` equals `record.wipTree`, and the recomputed ignored tree (Task 3's `snapshotIgnored` + tree write) equals `record.ignored.tree` (an absent snapshot requires the recomputed set to be empty) — otherwise `worktree-changed`.

- [ ] **Step 1: Write the failing tests** (reuse the Task 3 fixture): fresh record → `ok` in both modes; edit a tracked file after preserve → `worktree-changed`; add an untracked file → `worktree-changed`; edit `.env` → `worktree-changed`; add a new ignored file → `worktree-changed`; commit on the branch → `head-moved`; `update-ref -d` the wip ref → `ref-missing`; point the wip ref elsewhere → `ref-moved`; delete a blob from the object store (`rm` the loose object after `git repack`-free setup: write the blob loose, remove its file) → `object-missing` (archive mode); folder removed → `worktree-missing` in `live`, `ok` in `archive`; `repoPath` that is not a repository → `probe-failed`, never throws.
- [ ] **Step 2: Run to verify it fails**; **commit the test** (`test(gc): verifyPreservation fails closed on every mismatch (U2.1)`).
- [ ] **Step 3: Implement**; wrap each git probe so an exception maps to `probe-failed`. **Step 4: Run** Task 3 + Task 4 test files → pass. **Commit** (`feat(gc): verifyPreservation proves a worktree is recoverable by tree hash (U2.1)`).

### Task 5: `restoreWorktree`

**Files:**

- Modify: `src/main/gc/shelve-shell.ts`
- Test: `tests/gc-shelve-restore-real-git.test.ts`

**Interfaces:**

- Consumes: Task 1 `parseWorktreeList`, `decideRestoreBase`; Task 4 `verifyPreservation`.
- Produces: `type RestoreResult = { ok: true; path: string; attached: boolean; reason: ReturnType<typeof decideRestoreBase>['reason']; stashes: ShelveRecord['stashes'] } | { ok: false; reason: 'archive-unverified' | 'path-exists' | 'worktree-add-failed' | 'apply-failed' | 'snapshot-failed' | 'verification-failed'; message: string }`; `restoreWorktree(record: ShelveRecord): Promise<RestoreResult>`.
- Behavior: verify `archive` mode first (`archive-unverified`); refuse if `record.worktreePath` exists (`path-exists`, never overwrites); `mkdir -p` the parent; `git worktree list --porcelain` → `decideRestoreBase`; `git worktree add [--force when the only registration of the path is a missing/prunable one] [--detach] <path> <branch|headSha>`; apply the wip state with `read-tree -m -u HEAD <wipCommit>` then `reset -q` (working tree = archived bytes, index = HEAD); unpack the snapshot with a throwaway index (`read-tree <ignored.commit>` then `checkout-index -a --prefix=<path>/`); finally `verifyPreservation(record)` in `live` mode. A failure after `worktree add` removes the worktree THIS call just created (it holds nothing that is not in the archive), so a retry starts clean and no half-restored folder is ever offered to a session; the archive is untouched. A folder that existed before the call is never touched (`path-exists`).

- [ ] **Step 1: Write the failing tests** (AC-5, AC-U2a): preserve → `rm -rf` the folder (stale registration stays) → restore → `ok`, `attached: true`, `git status --porcelain` equals the pre-shelve status modulo staging (compare `git diff HEAD --stat` + untracked list), and a byte comparison walk (a SHA256 digest per file, path set equal) of every file outside `.git` and `node_modules` between a copy taken before shelving and the restored folder is identical (tracked edits, a deleted tracked file stays deleted, untracked, `.env`, `.harnu/out/shot.txt`, an executable script keeps its exec bit, a symlink stays a symlink); detached record restores detached at the archived HEAD; branch tip moved after shelve → `attached: false`, `reason: 'branch-moved'`, HEAD is the archived commit and no file of the newer commit is applied over it; branch checked out in another worktree → detached, `branch-checked-out-elsewhere`; `path-exists` leaves the existing folder byte-for-byte untouched; archive object missing → `archive-unverified` and no folder created; `node_modules` is not recreated.
- [ ] **Step 2: Run to verify it fails**; **commit the test** (`test(gc): restoreWorktree round-trips byte-for-byte against real git (U2.1)`).
- [ ] **Step 3: Implement. Step 4: Run** Tasks 3–5 test files → pass. **Commit** (`feat(gc): restoreWorktree recreates the worktree from a shelve record (U2.1)`).

### Task 6: Guardrails — local, durable, never expiring — and gates

**Files:**

- Test: `tests/gc-shelve-guardrails-real-git.test.ts`
- Modify: none expected.

- [ ] **Step 1: Write the tests** (AC-6): in a repo that has an unreachable `origin` URL (`git remote add origin /nonexistent`) preserve + verify + restore all succeed and `git config --get-regexp ^branch\\.` / `git for-each-ref refs/remotes` are unchanged (nothing pushed or fetched); after `rm -rf` of the folder and `git gc --prune=now` **in the throwaway repo** (a test-only call; the engine never runs gc), `verifyPreservation(record, { mode: 'archive' })` is still `ok` and `restoreWorktree` still byte-identical; `listRepoArchives` → `expiredArchives(entries, 1, far-future)` returns `[]` for the shelved entry while the branch exists and for the detached one; and returns the entry only when `branchesGone` contains the branch. A grep-style assertion: the source of `shelve-shell.ts` contains none of `'push'`, `'fetch'`, `'gc'`, `'stash', 'push'`/`pop`/`drop`.
- [ ] **Step 2: Run** (should pass without new code; if a test exposes a gap, fix the code in its owning task's file and note it in the report). **Commit** (`test(gc): shelve records stay local, durable and unexpired (U2.1)`).
- [ ] **Step 3: Gates** after the last commit: `npm run typecheck`, `npm run lint`, `nice -n 19 npx vitest run --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`, `npm run build` — all green. Write `.harnu/REPORT.md` (format in the card), commit nothing in `.harnu/` if it is ignored, push the branch.

## Self-review

- Spec coverage: AC-1 → Task 3; AC-2 → Task 3; AC-3 → Task 3; AC-4 → Task 4; AC-5 → Task 5; AC-6 → Tasks 2 + 6 + Global Constraints; AC-7 → Task 6 step 3. C3/C4/C10 and eligibility belong to U2.2/U2.3 (out of scope: no removal, no cycle).
- Known limits, to state in the report: file modes other than the executable bit, mtimes and the staged-vs-unstaged split are not preserved (git does not hold them); nested `node_modules` count toward the cap; submodule-internal dirty state is not captured.
