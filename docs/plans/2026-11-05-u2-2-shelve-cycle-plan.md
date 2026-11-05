# U2.2 — Shelve idle unproven worktrees in the cleanup cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cleanup cycle shelves a worktree whose branch is not proven merged and that has been idle past a threshold — preserve, verify, delete the folder for real, keep the branch — behind its own switch (default OFF) and its own report-only first cycle.

**Architecture:** Pure cores decide (prefs, eligibility, store, cycle plan); thin shells probe and act (probe, executor, repo lock). The executor chains U2.1's `preserveWorktree` → `verifyPreservation` → `rawRm` of the folder → `removeWorktreeAdmin` of that worktree only. The cycle runs after the existing clean in `runGcCycle`, through the same job queue (so `afterJob` forgets the shelved items from the Reaper snapshot). A durable store (`gc-shelved.json`) remembers shelved worktrees so transcripts, ghosts, the snapshot and `list_cleanup` treat them as shelved, never as removed.

**Tech Stack:** TypeScript (Electron main), vitest, git CLI ≥ 2.31.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` — §2, §3 anti-goals, §4 U2, §5, §7 (C1, C3, C4, C10), §8 (D-A, D-B). Also `docs/plans/2026-11-05-u2-1-preserve-restore-plan.md`, risks 4–7 in `docs/studies/2026-10-27-autonomous-cleanup-risks.md`. Card: T641.

## Global Constraints

- English only in code, comments, tests, commit messages. Conventional Commits with a `(U2.2)` suffix. No attribution lines. No PR, no `ship`.
- Shelving is autopilot-only: no MCP verb and no IPC channel shelves. Switch `gc-prefs.shelve.enabled` defaults to `false`; U2.3 flips it on. The CHANGELOG entry says so.
- Shelve never: pushes, fetches, runs `git gc`, `stash push|pop|drop`, deletes a branch, deletes any `refs/archive/**` ref, calls `detachFromSidebar` / `recordRemovedFolder` / `removeGhostFoldersUnder`, or removes the worktree through git (`git worktree remove`): the folder goes through `rawRm`, the registration through `removeWorktreeAdmin` (that worktree's own admin dir, never `git worktree prune`).
- Shelve threshold default `thresholdDays = 3`; per-cycle cap default `maxPerCycle = 3`; failure-streak kill switch default `failureLimit = 3`.
- Dependency dirs passed to `preserveWorktree` come from the repo's own `WORKTREE.md` `ephemeral:` list (read with `readRepoManifest`), at ANY depth (`packages/*/node_modules`). An unreadable or degraded manifest yields `[]` (nothing excluded; the 256 MiB cap then refuses), never the default list.
- Test repos are throwaway repos in `os.tmpdir()`. CPU budget: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- Out of scope: restore triggers, sidebar/Archived UI, Docker, digest UI, a Settings control for the switch.

## Review Focus

1. Anything changes between decision and action (HEAD moves, a file is edited, a session opens) → refuse `changed-since-decided`, folder untouched. Tasks 4, 6.
2. A worktree with a nested worktree/foreign checkout, a stack bound to it, or an open-idle session → never shelved (deleting would take it along). Task 3.
3. Folder removal fails halfway → the shelved entry stays (never a silent loss), the archive verifies, the failure counts toward the streak. Task 6.
4. Two Harnu instances on one repo, and a crash that leaves a stale lock → second waits out, stale lock is reclaimed. Task 7.
5. `WORKTREE.md` unreadable → treated as delegating (not shelved); manifest `ephemeral:` custom list honoured exactly. Tasks 2, 4.

---

### Task 1: Shelve prefs — own switch, own acknowledgement

**Files:** Modify `src/main/gc/gc-prefs.ts`; Test `tests/gc-shelve-prefs.test.ts`.

**Interfaces:**

- Produces: `interface ShelvePrefs { enabled: boolean; firstReportAcknowledged: boolean; thresholdDays: number; maxPerCycle: number; failureLimit: number }`; `GcPrefs.shelve: ShelvePrefs`; `withShelveAcknowledged(p: GcPrefs): GcPrefs`; `withShelveDisabled(p: GcPrefs): GcPrefs`. `normalizeGcPrefs` clamps `thresholdDays` 1..365, `maxPerCycle` 1..20, `failureLimit` 1..10 and falls back to the defaults above; `mergeIncomingPrefs` merges a partial `shelve` key field by field, can never set `firstReportAcknowledged`, and resets it to `false` when `enabled` goes off→on.

- [ ] **Step 1: Write the failing test** — AC-1: `defaultGcPrefs().shelve` equals `{ enabled: false, firstReportAcknowledged: false, thresholdDays: 3, maxPerCycle: 3, failureLimit: 3 }`; junk/missing/out-of-range values normalize to clamped values; setting `autopilot: true` / `firstReportAcknowledged: true` on the top level leaves `shelve` untouched, and acknowledging `shelve` leaves `firstReportAcknowledged` untouched; `mergeIncomingPrefs(current, { shelve: { enabled: true } })` resets `shelve.firstReportAcknowledged` to false even when it was true; `{ shelve: { firstReportAcknowledged: true } }` does not acknowledge; a partial `{ shelve: { thresholdDays: 5 } }` keeps the other fields; an old prefs file with no `shelve` key reads as the defaults. Run → FAIL. **Commit** `test(gc): shelve switch and acknowledgement are independent of the autopilot's (U2.2)`.
- [ ] **Step 2: Implement** in `gc-prefs.ts` (keep `normalizeGcPrefs`' base-fallback pattern). Run → PASS; run `tests/gc-prefs*.test.ts` and `npm run typecheck` (fix fixtures that build a `GcPrefs` by hand). **Commit** `feat(gc): shelving gets its own switch and acknowledgement, off by default (U2.2)`.

### Task 2: Dependency dirs at any depth, from the repo's manifest

**Files:** Modify `src/main/gc/shelve-core.ts`, `src/main/gc/shelve-shell.ts` (normalisation inside `preserve` / `listIgnored` only); Create `src/main/gc/shelve-manifest-shell.ts`; Test `tests/gc-shelve-depdirs.test.ts`, `tests/gc-shelve-depdirs-real-git.test.ts`.

**Interfaces:**

- Produces in `shelve-core.ts`: `ANY_DEPTH = '**/'`; `dependencyDirsFor(ephemeral: readonly string[]): string[]` — each entry normalised with `normalizeEphemeralEntry`; a single-segment entry `x` yields both `x` and `**/x`; a multi-segment entry yields itself only; entries that do not normalise are dropped; `isDependencyPath(rel, dirs)` additionally returns true when a `**/x` entry equals ANY path segment of `rel`.
- Produces in `shelve-manifest-shell.ts`: `readShelveManifest(repoPath: string): Promise<{ dependencyDirs: string[]; delegates: boolean }>` — `dependencyDirs = dependencyDirsFor(ephemeral)` using `readManifestSources` + `resolveManifest` (the same pair `readRepoManifest` uses); `delegates` is true when the resolved manifest has `create` or `remove`; any read error, or a manifest file present that resolved to `source: 'default'` (degraded), gives `{ dependencyDirs: [], delegates: true }` (fail closed).

- [ ] **Step 1: Write the failing tests** — pure: `dependencyDirsFor(['node_modules','packages/x/dist'])` → `['node_modules','**/node_modules','packages/x/dist']`; `isDependencyPath('packages/a/node_modules/b/index.js', ['**/node_modules'])` true, `'packages/a/my_node_modules/x'` false, `'node_modules_x/a'` false. Real git (AC-3, owner's deltas): a repo whose manifest lists `ephemeral: [.cache-x]` — `readShelveManifest` returns it, `preserveWorktree` with those dirs snapshots `node_modules/pkg/index.js` (ignored, not listed) and `.env` but NOT `.cache-x/blob`; a monorepo worktree with an ignored `packages/a/node_modules` of 300 KiB and `capBytes` 100 KiB → preserve `ok`, the snapshot lacks it, `verifyPreservation` live `ok`, restore does not recreate it; delegating manifest (`create:`) → `delegates: true`; unparsable front matter → `{ [], true }`. Run → FAIL. **Commit** `test(gc): dependency dirs at any depth come from the repo manifest (U2.2)`.
- [ ] **Step 2: Implement.** In `preserve`/`listIgnored`, entries starting with `**/` bypass `normalizeEphemeralEntry` for the prefix and validate the remainder with it. Run the new tests plus `tests/gc-shelve-*.test.ts` → PASS. **Commit** `feat(gc): shelving reads the repo's own dependency dirs, at any depth (U2.2)`.

### Task 3: Eligibility core — one rule, one test

**Files:** Create `src/main/gc/shelve-eligibility-core.ts`; Modify `src/main/gc/gc-transcripts.ts` (add `drifted` to `scanTranscripts`); Test `tests/gc-shelve-eligibility.test.ts`, `tests/gc-transcripts-drift.test.ts`.

**Interfaces:**

- Produces: `interface ShelveProbe { headSha: string | null; workStamp: string | null; newestMtime: number | null; lastCommitAt: number | null; manifestDelegates: boolean }`; `type ShelveRefusal = 'not-a-worktree' | 'merged' | 'stack' | 'session' | 'protected' | 'operation' | 'locked' | 'nested' | 'unresolved' | 'blind' | 'drifted' | 'delegated-manifest' | 'unknown-age' | 'too-recent' | 'unreadable'`; `shelveCandidate(b: WorktreeBundle, ctx: { prefs: GcPrefs; driftedCwds: readonly string[]; canonical?: CanonicalPath }): ShelveRefusal | null` (bundle-level rules, no I/O); `shelveVerdict(b, probe, ctx: { prefs; now: number; driftedCwds; canonical? }): { eligible: true; idleMs: number; since: number } | { eligible: false; reason: ShelveRefusal }`; `scanTranscripts(...)` result gains `drifted: string[]` — the `cwd` of every transcript whose project slug is not `slugOfPath(cwd)` nor a slug continuing it (the session was started elsewhere and moved here, C4).
- Rules (AC-2): kind is `worktree` or `detached-worktree`; NOT `fate.fate === 'merged' && fate.strong` (D-A); no stack (`stackIds`, `sharedStackIds` empty) and not `dockerBlind`; `session === 'none'` (working, needs-input AND open-idle all refuse: a live process would lose its cwd); `isProtectedNow(b, prefs, canonical)` false (main checkout, `keep`, ANY `prefs.keep[id]` incl. a stale one, `neverClean`); `operation` undefined; `locked` not true; `nestedWorktrees` and `foreignCheckouts` are arrays and empty; `pathsResolved === true`; no `driftedCwds` entry inside the worktree path; `probe.manifestDelegates` false; `since = max(lastSignOfLifeAt, lastCommitAt, newestMtime)` known and `now - since >= thresholdDays * DAY`; a null `headSha`/`lastCommitAt`/`lastSignOfLifeAt` → `unreadable`/`unknown-age`.

- [ ] **Step 1: Write the failing tests** — a `base` eligible bundle (fate `closed-unmerged`, session none, idle 10 d) passes; then ONE case per rule flipping only that rule (strong merged → `merged`; weak merge signal stays eligible; open PR (`fate: open`) stays eligible; `session: 'working' | 'needs-input' | 'open-idle'` → `session`; `keep: true`; `prefs.keep[id]` stale with `keep: false` → `protected`; `neverClean`; `isMainCheckout`; `operation: 'rebase'`; `locked: true`; non-empty `nestedWorktrees`; `foreignCheckouts` undefined; `pathsResolved: false`; `stackIds: ['s']`; `dockerBlind`; drifted cwd inside the path → `drifted`, outside → still eligible; `manifestDelegates` → `delegated-manifest`; idle 2 d with threshold 3 → `too-recent`; recent commit with old transcripts → `too-recent`; recent file mtime → `too-recent`; null commit time → `unknown-age`); `detached-worktree` is eligible, `local-branch` → `not-a-worktree`. Transcript drift: a transcript in slug dir `-a-b` with `cwd` `/a/b/wt` → `drifted: ['/a/b/wt']`; a transcript whose slug matches its cwd → none. Run → FAIL. **Commit** `test(gc): shelve eligibility — one test per rule, drift detected from transcripts (U2.2)`.
- [ ] **Step 2: Implement.** Reuse `isProtectedNow`; the `scanTranscripts` change is additive (existing fields unchanged). Run these plus `tests/gc-transcripts*.test.ts` → PASS. **Commit** `feat(gc): shelve eligibility core and session-drift detection (U2.2)`.

### Task 4: Probe shell — the facts a decision is bound to

**Files:** Create `src/main/gc/shelve-probe-shell.ts`; Test `tests/gc-shelve-probe-real-git.test.ts`.

**Interfaces:**

- Consumes: `workStampOf` (`gc-work-stamp.ts`), `readShelveManifest` (Task 2), `ShelveProbe` (Task 3).
- Produces: `probeShelve(b: Pick<WorktreeBundle,'item'>): Promise<ShelveProbe>` — `headSha` from `rev-parse HEAD`; `workStamp` from `workStampOf` (null when clean); `newestMtime` the newest mtime of the paths `git status --porcelain=v1 -z` lists (null when none) — a probe that fails sets the field to `null` and `headSha` to `null`; `lastCommitAt` from `log -1 --format=%ct` × 1000; `manifestDelegates` from `readShelveManifest(item.repoPath).delegates`. Also `type ShelveBinding = Pick<ShelveProbe,'headSha'|'workStamp'|'newestMtime'>` and `sameBinding(a: ShelveBinding, b: ShelveBinding): boolean` (pure, strict equality of the three).

- [ ] **Step 1: Write the failing test** (real git): clean worktree → `workStamp: null`, `newestMtime: null`, `lastCommitAt` equals the commit's committer date; editing a tracked file changes `workStamp` and sets `newestMtime` to that file's mtime; a new commit changes `headSha`; a folder that is not a repository → `headSha: null`; `sameBinding` true/false cases. Run → FAIL. **Commit** `test(gc): shelve probe reads the facts a decision is bound to (U2.2)`.
- [ ] **Step 2: Implement; run → PASS. Commit** `feat(gc): shelve probe shell (U2.2)`.

### Task 5: Shelved store — a shelved worktree is remembered, not removed

**Files:** Create `src/main/gc/shelve-store.ts`; Modify `src/main/gc/gc-orphan-transcripts.ts`, `src/main/gc/gc-orphan-shell.ts`; Test `tests/gc-shelve-store.test.ts`, `tests/gc-shelve-orphans.test.ts`.

**Interfaces:**

- Produces: `interface ShelvedEntry { id: string; repoPath: string; worktreePath: string; branch: string | null; headSha: string; namespace: string; shelvedAt: number; idleDays: number; reason: string; freedBytes: number | null }`; `interface ShelvedFile { version: 1; entries: ShelvedEntry[] }`; `SHELVED_FILE = 'gc-shelved.json'`; pure `normalizeShelved(raw: unknown): ShelvedFile` (drops malformed entries), `withShelved(f, e)` (replaces the same `id`), `withoutShelved(f, ids)`, `shelvedFolders(f): string[]`, `isShelvedFolder(f, folder: string, platform?: string): boolean` (equal to, or inside, a shelved worktree path, `canonicalPathKey`); shell `readShelved(file): Promise<ShelvedFile>` (missing/corrupt → empty), `writeShelved(file, data): Promise<void>` (tmp + rename). `OrphanInput` gains `shelvedFolders?: readonly string[]`; the planner never lists a slug whose folder `isShelvedFolder`, whatever its proof; `realOrphanSource({ known, repoPaths, shelvedFolders? })`.

- [ ] **Step 1: Write the failing tests** — store round-trip; corrupt JSON → empty; `withShelved` replaces by id; `isShelvedFolder('/ws/wt/api')` true when `/ws/wt` shelved, `/ws/wt-other` false. Orphans (AC-5): a transcript project whose cwd is a missing shelved folder is NOT in `orphanTranscripts` even with `proof` returning true; the same project without the shelved entry IS listed (control). Run → FAIL. **Commit** `test(gc): a shelved worktree's transcripts are not orphans (U2.2)`.
- [ ] **Step 2: Implement; run these + `tests/gc-orphans*.test.ts` → PASS. Commit** `feat(gc): durable shelved-worktree store; transcripts of shelved folders are not orphans (U2.2)`.

### Task 6: Executor — preserve, verify, delete, unregister, bound to the decision

**Files:** Create `src/main/gc/shelve-exec-shell.ts`; Test `tests/gc-shelve-exec.test.ts` (fake deps), `tests/gc-shelve-exec-real-git.test.ts`.

**Interfaces:**

- Consumes: `preserveWorktree`, `verifyPreservation`, `restoreWorktree` (U2.1), `probeShelve`/`sameBinding` (Task 4), `readShelveManifest` (Task 2), `rawRm`, `removeWorktreeAdmin`, store (Task 5).
- Produces: `interface ShelveDecision { id: string; repoPath: string; worktreePath: string; branch: string | null; binding: ShelveBinding; since: number; idleDays: number; diskBytes: number | null }`; `type ShelveStep = 'reprobe' | 'in-use' | 'preserve' | 'verify' | 'remove' | 'unregister'`; `type ShelveOutcome = { ok: true; entry: ShelvedEntry; record: ShelveRecord } | { ok: false; step: ShelveStep; reason: string; message: string; folderRemoved: boolean }`; `interface ShelveExecDeps { probe(d): Promise<ShelveProbe>; inUse(path: string): Promise<boolean>; manifest(repoPath): Promise<{ dependencyDirs: string[]; delegates: boolean }>; preserve: typeof preserveWorktree; verify: typeof verifyPreservation; remember(entry: ShelvedEntry): Promise<void>; forget(id: string): Promise<void>; removeFolder(p: string): Promise<void>; unregister(repo: string, p: string): Promise<boolean>; now(): number }`; `shelveWorktree(d: ShelveDecision, deps: ShelveExecDeps): Promise<ShelveOutcome>`; `defaultShelveExecDeps(rememberFile: string): ShelveExecDeps`.
- Order: (1) `probe` — `manifestDelegates` true → `reprobe`/`delegated-manifest`; `!sameBinding` → `reprobe`/`changed-since-decided` (AC-4); (2) `inUse` → `in-use`; (3) `preserve` with the manifest's `dependencyDirs`; (4) `verify` in `live` mode; (5) `remember(entry)` BEFORE deleting; (6) `removeFolder`; failure → if `verify` live is still `ok` the folder is intact: `forget` and return `remove` with `folderRemoved: false`, else keep the entry and return `folderRemoved: true`; (7) `unregister` (false/throw → `unregister` failure, entry kept, folder gone). Any failure at steps 1–4 leaves the worktree untouched and no entry.

- [ ] **Step 1: Write the failing tests.** Fake deps: success order of calls is `probe,inUse,manifest,preserve,verify,remember,removeFolder,unregister`; changed HEAD / `workStamp` / `newestMtime` → `changed-since-decided`, nothing after `probe` is called; in-use → refusal; `preserve` refused (`snapshot-too-large`) / `verify` failed → no `remember`, no `removeFolder`; `removeFolder` throws with folder intact → `forget` called, `folderRemoved: false`; throws with folder gone → no `forget`, `folderRemoved: true`; `unregister` false → failure, entry kept. Real git (AC-3): idle unproven worktree → after `shelveWorktree` the folder is gone, `git worktree list` no longer lists it, `git worktree add <same path> <branch>` succeeds, `git branch --list` still shows the branch, every `refs/archive/**` ref exists, `restoreWorktree(record)` returns it byte-identical (tracked edit, untracked, ignored `.env`); another worktree that is temporarily missing (rm -rf'd, not locked) keeps its registration (no repo-wide prune); a locked worktree → `unregister` failure and nothing else registered is touched; no `git push|fetch|gc|stash` in the source. Run → FAIL. **Commit** `test(gc): shelveWorktree — bound to its decision, fails closed at every step (U2.2)`.
- [ ] **Step 2: Implement; run → PASS. Commit** `feat(gc): shelveWorktree preserves, verifies, then frees the disk (U2.2)`.

### Task 7: Per-repo lock

**Files:** Create `src/main/gc/repo-lock-shell.ts`; Test `tests/gc-repo-lock.test.ts`.

**Interfaces:** Produces `withRepoLock<T>(repoPath: string, fn: () => Promise<T>, opts?: { now?: () => number; staleMs?: number; pid?: number; alive?: (pid: number) => boolean }): Promise<{ ok: true; value: T } | { ok: false; reason: 'locked'; holder: { pid: number; at: number } | null }>` — an exclusive file `<git common dir>/harnu-gc.lock` (`wx`, content `{pid, at}`), removed in `finally`; a lock older than `staleMs` (default 30 min) or whose pid is not alive is reclaimed; in-process callers on the same repo serialise on the same file.

- [ ] **Step 1: Write the failing test** (real temp repo): two concurrent calls → one `ok`, one `locked` with the holder pid; lock removed after `fn` throws; a stale lock file (old `at`) is reclaimed; a dead pid is reclaimed; a live fresh foreign lock is respected. Run → FAIL. **Commit** `test(gc): per-repo lock around shelve cycles (U2.2)`.
- [ ] **Step 2: Implement; run → PASS. Commit** `feat(gc): per-repo lock for shelve cycles (U2.2)`.

### Task 8: The shelve cycle — report-only first, cap, kill switch, journal, Activity

**Files:** Create `src/main/gc/shelve-cycle.ts`; Modify `src/main/gc/gc-cycle.ts`, `src/main/gc/gc-wire.ts`; Test `tests/gc-shelve-cycle.test.ts`.

**Interfaces:**

- Consumes: Tasks 1, 3, 4, 6, 7; `JobQueue`; `GcItemResult`.
- Produces: `interface ShelveCycleRecord { mode: 'off' | 'report' | 'shelve'; found: number; foundBytes: number; shelved: ShelvedSummary[]; refused: number; failed: number; deferred: number; paused: boolean; locked: number }`; `interface ShelvedSummary { id: string; branch: string | null; folderAlias: string; folderPath: string; idleDays: number; freedBytes: number | null }`; `CycleRecord.shelve?: ShelveCycleRecord`; `CycleState.shelveFailures: Map<string, { at: number; reason: string }>`, `shelveStreak: number`; `interface ShelveCycleDeps { prefs(): GcPrefs; driftedCwds(): readonly string[]; canonical?: CanonicalPath; probe(b): Promise<ShelveProbe>; exec: ShelveExecDeps; lock: typeof withRepoLock; queue: JobQueue; journal(t: Tombstone): Promise<void>; disableShelving(): Promise<void>; notify(n: { title: string; body: string }): void; now(): number }`; `runShelveCycle(deps: ShelveCycleDeps, bundles: readonly WorktreeBundle[], state: CycleState): Promise<ShelveCycleRecord>`; `GcCycleDeps.shelve?: (bundles: WorktreeBundle[]) => Promise<ShelveCycleRecord>` called by `runGcCycle` after the clean and recorded on `CycleRecord.shelve`.
- Behaviour: `enabled === false` → `mode: 'off'`, probes nothing. Candidates = `shelveCandidate === null`, not in `state.shelveFailures` within 24 h, sorted oldest `lastSignOfLifeAt` first; each is probed and judged with `shelveVerdict`. Not acknowledged → `mode: 'report'`: counts `found`/`foundBytes` (sum of `item.diskBytes`), shelves nothing, notifies once per changed count ("Found N idle worktrees it would shelve (branch kept), X — review them in Cleanup"). Acknowledged → `mode: 'shelve'`: at most `maxPerCycle` per cycle (rest `deferred`), each inside `lock(repoPath)` (a locked repo counts `locked`, not failed) and submitted through `queue.submit('autopilot', ids, work)` with results mapped to `GcItemResult`. Each success appends ONE tombstone (`kind: 'shelved-worktree'`, `branch`, `sha: headSha`, `deleted: [worktreePath]`, `archiveTipRef`, `archiveWipRef`, `restoreHint` = `git -C <repo> worktree add <path> <branch>` or the tip ref when detached, `actor: 'autopilot'`) and contributes one `ShelvedSummary` (the Activity line is rendered from it, Task 9). A failure sets `state.shelveFailures`, increments `shelveStreak`; a success resets it; reaching `failureLimit` calls `disableShelving()`, sets `paused: true`, notifies "Shelving paused after N failures in a row", and stops the loop. A thrown `journal` is a failure of that item reported but the shelve itself already happened (entry stays).

- [ ] **Step 1: Write the failing tests** (fakes for every dep; AC-1, AC-6, AC-7): off → nothing probed; enabled but not acknowledged → `mode: 'report'`, `exec` never called, one notice, same count next cycle → no second notice; acknowledged with 5 eligible and `maxPerCycle: 2` → 2 shelved, `deferred: 3`, oldest first; strongly merged bundles never reach `exec`; a repo lock refused → `locked: 1`, no failure counted; 3 failures in a row with `failureLimit: 3` → `disableShelving` called once, `paused: true`, remaining candidates untouched; a success between failures resets the streak; a failed item is not retried within 24 h; each success → exactly one `journal` call with `kind: 'shelved-worktree'` and `actor: 'autopilot'` and a summary with `idleDays` 9 for a 9-day-idle fixture; `detachFromSidebar`/`recordRemovedFolder` are not importable from `shelve-cycle.ts` (assert the module source has no import of `user-projects` or `gc-removed-folders`). Run → FAIL. **Commit** `test(gc): shelve cycle — report-only first, cap, kill switch, journal (U2.2)`.
- [ ] **Step 2: Implement** `shelve-cycle.ts` and the two small hooks in `gc-cycle.ts` / `gc-wire.ts` (CycleRecord field; `createCycleState` gains the new fields). Run these + `tests/gc-cycle.test.ts` → PASS. **Commit** `feat(gc): the cleanup cycle shelves idle unproven worktrees (U2.2)`.

### Task 9: Wiring — gather, snapshot, IPC, Activity line, `list_cleanup`

**Files:** Modify `src/main/gc/gc-scan-shell.ts` (`GcGathered.shelved`, `driftedCwds`; pass shelved folders to the orphan source), `src/main/gc/gc-wire.ts` (`GcSnapshot.shelved: ShelvedEntry[]`), `src/main/gc/gc-ipc.ts` (store file under userData, `cycleDeps.shelve`, `buildSnapshot`, `gc:shelve:ack` handler + `GcService.ackShelveReport()`), `src/preload/index.ts` (`gcAckShelveReport`), `src/main/mcp/cleanup-listing.ts` and `src/main/mcp/tool-catalog.ts` (`list_cleanup` description), `src/renderer/src/stores/gc.ts` (`onGcCycle` pushes one Activity row per `cycle.shelve.shelved` item, once per cycle `at`), `src/renderer/src/i18n/en.json` + `pt-BR.json` (`cleanup.gc.shelved.activity`: "Shelved `{branch}` — idle {days} d, branch kept"); Test `tests/gc-shelve-wire.test.ts`, `tests/gc-shelve-listing.test.ts`, `tests/gc-shelve-activity.test.ts`.

**Interfaces:**

- Produces: `ListedShelved { id: string; folderAlias: string; branch: string | null; shelvedAt: number; idleDays: number; reason: string }`; `CleanupListing.shelved: ListedShelved[]` (path-free, scoped like bundles); `CleanupTotals.shelved: number`; `CleanupListing.shelving: { enabled: boolean; reportOnly: boolean; thresholdDays: number }`; `window.api.gcAckShelveReport(): Promise<GcPrefs>`.

- [ ] **Step 1: Write the failing tests** (AC-5, AC-7): a snapshot with a shelved entry survives `JSON.parse(JSON.stringify())` and carries `shelved`; the gather's `bundles` exclude a shelved folder after the Reaper forgot it (no `folderGone` ghost); `list_cleanup` lists the shelved worktree by `folderAlias` with no absolute path anywhere in the JSON, `totals.shelved` counts it, `shelving.reportOnly` is true until `shelve.firstReportAcknowledged`; the cycle-to-renderer path: feeding the store a `CycleRecord` with one shelved summary adds exactly one notification whose title comes from `cleanup.gc.shelved.activity` ("Shelved `feat/x` — idle 9 d, branch kept"), and replaying the same record adds none; `tests/cleanup-gc-i18n.test.ts` stays green (both locale files carry the key). A source test: none of the shelve files calls `detachFromSidebar`, `recordRemovedFolder` or `removeGhostFoldersUnder`. Run → FAIL. **Commit** `test(gc): shelved worktrees are a coherent state in snapshot, list_cleanup and Activity (U2.2)`.
- [ ] **Step 2: Implement.** `gatherGc` reads the store and collects `driftedCwds` from `scanTranscripts`; `gc-ipc` constructs `ShelveCycleDeps` from the real shells and the live `prefs`; `disableShelving` persists `withShelveDisabled`. Run the new tests, `tests/gc-ipc-surface.test.ts`, `tests/cleanup-view-gc.test.ts`, `tests/gc-opinion-wiring.test.ts`, `npm run typecheck` → PASS. **Commit** `feat(gc): wire shelving into the gather, snapshot, IPC, list_cleanup and Activity (U2.2)`.

### Task 10: Contracts, gates, live verification, report

**Files:** Modify `CHANGELOG.md`, `docs/user/cleanup.md`, `docs/harnu-features.md` (`list_cleanup`'s `shelved` / `shelving` fields; bump `<!-- harnu-features v119 -->` → `v120`); Test `tests/gc-shelve-docs.test.ts` (the three docs mention shelving; marker is v120).

- [ ] **Step 1: Docs.** CHANGELOG `### Added` entry dated 2026-11-05: shelving exists, **off by default until restore lands (U2.3)**, report-only first cycle, branch always kept. `docs/user/cleanup.md`: what shelving is, when a worktree qualifies, that there is no Settings control yet (the `shelve` block of `gc-prefs.json`), and that nothing is restored automatically in this version. Written from the code, not the spec. Commit `docs(gc): shelving in the changelog, user docs and agent awareness (U2.2)`.
- [ ] **Step 2: Gates** after the last code commit, nice'd and capped: `npm run typecheck`, `npm run lint`, `nice -n 19 npx vitest run --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`, `npm run build` — all green; `git push`.
- [ ] **Step 3: AC-9.** `npm run build:unpack` (or the renderer on `:5174`), launch an ISOLATED instance per `docs/dev/live-verify-second-instance.md` with `--user-data-dir=/tmp/harnu-verify-u22` and an alt `--remote-debugging-port`; create a throwaway repo and an unproven worktree (back-dated commit) with an ignored `.env` under `/tmp`; pin it; write `gc-prefs.json` with `shelve: { enabled: true, thresholdDays: 1 }`; trigger a cycle: first cycle reports only (folder still there); `gcAckShelveReport()`; next cycle: folder gone, branch present, `refs/archive/**/shelve/record` present, its session still listed (`foldersLoad`). Paste the evidence into the report. Tear down only PIDs spawned.
- [ ] **Step 4: Report.** Write `.harnu/REPORT.md` in the card's format (first line `Report for session 6fc87a06-587d-4c27-8e06-0f498126fa63 · mission mnt-a94474cc · step stp-2`), `git status --porcelain` empty, then `ListAgents` and `SendMessage` the same content to the owner. State plainly: restore stages changes unstaged (U2.1 limit); any-depth dependency exclusion is by name from the repo's own `ephemeral:` list; open-idle sessions also block (stricter than AC-2); the Activity row is pushed by a small renderer-store hook plus an i18n key (no new UI); hibernation.ts needed no change.

## Self-review

- Spec coverage: AC-1 → Tasks 1, 8; AC-2 → Task 3; AC-3 → Tasks 2, 6 (incl. the owner's custom-ephemeral and any-depth deltas); AC-4 → Tasks 4, 6; AC-5 → Tasks 5, 9; AC-6 → Tasks 7, 8; AC-7 → Tasks 8, 9; AC-8 → Task 10; AC-9 → Task 10. C1 → Tasks 1, 8; C3 → Tasks 5, 9; C4 → Task 3; C10 → Tasks 2, 3.
- Types: `ShelveProbe`/`ShelveBinding` (Tasks 3–4) are the same objects Tasks 6 and 8 consume; `ShelvedEntry` (Task 5) is what Tasks 6, 9 persist and list; `ShelveCycleRecord` (Task 8) is what Task 9 renders.
- Open risk: `GcItemResult` fields for mapping shelve outcomes onto the job queue are read at Task 8 implementation time; if the shape cannot carry a shelve honestly, the cycle runs its items under `reaper.runExclusive` directly and the renderer ghost-forgetting is done by `forgetItems` in the cycle — noted in the report.
