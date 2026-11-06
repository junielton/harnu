# U2.3a — Restore Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (one session, inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shelved worktree comes back by itself whenever someone goes to use it, shelving turns on by default (still report-only first), and a shelved archive can no longer be deleted by hand.

**Architecture:** One restore service (`shelve-restore-*.ts`) wraps U2.1's `restoreWorktree` with the shelved store, a single-flight map, the per-repo lock and a leftovers rule. Every spawn already funnels through `createPty` (`src/main/pty.ts`): resume, new session and terminal from the renderer's `pty:create`, and `spawn_terminal` via `createTerminalPty`. One hook there covers all of them; MCP `create_session` restores up front so its ACK is truthful. Scheduler ticks spawn with `child_process.spawn` and never reach `createPty`, so they never restore (pinned by a test). The Cleanup screen gets a Shelved card with a Restore button, the Archives card refuses shelved entries, and Settings → Cleanup gets the switch and the acknowledge action. The default flips ON in the last code task, after every trigger exists.

**Tech Stack:** Electron main (Node, `node:child_process` git), Vue 3 + Tailwind v4 + vue-i18n, Vitest (real-git fixtures in `tests/gc-shelve-fixture.ts`).

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U2 "Restore", AC-U2b, §7 C1/C3/C4, §8 D-B. Engine: `docs/plans/2026-11-05-u2-1-preserve-restore-plan.md`, cycle/store: `docs/plans/2026-11-05-u2-2-shelve-cycle-plan.md`.

## Global Constraints

- Restore never overwrites: it moves leftovers aside, it never deletes them (spec "Shelving is refused if preservation fails" spirit; U2.1 `restoreWorktree` refuses an existing path).
- A restore failure never starts a session in another folder (BUG-144 shape): no ancestor/home fallback for a shelved path.
- Scheduler ticks never restore (C3).
- Every refusal has an in-app guided path (memory "Cleanup: no dead ends").
- Shelve switch default ON; first cycle report-only; its own acknowledgement (C1).
- English only; no client identifiers; every new i18n key in `en.json` and `pt-BR.json`; no raw colors (design.md tokens only).
- CPU: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- Commits: Conventional Commits with `(U2.3a)`; a failing-test commit precedes each implementation commit; no attribution lines.
- Contracts per change: `CHANGELOG.md` (dated 2026-11-05), `docs/user/cleanup.md`, `docs/harnu-features.md` (bump `v121` → `v122`), `design.md` for new variants.

## Review Focus

- Resume and a new terminal hit the same shelved path at once → one restore, both succeed (no `path-exists` race). Pinned in Task 1.
- A session whose cwd is a subfolder of the shelved worktree (`WT/api`) → the worktree is restored and the subfolder exists afterwards. Pinned in Tasks 1 and 2.
- Restore fails (archive ref gone, repo busy) → a Claude session shows a restore-failed notice and spawns nothing; a shell terminal rejects; neither lands in home or an ancestor. Pinned in Task 2.
- A folder already sits at the shelved path (cycle died halfway through the delete, or the user made one) → live session inside it: refuse; otherwise move it aside, never delete. Pinned in Task 1.
- Prefs: a file with an explicit `shelve.enabled: false` stays off; a file that never mentions shelve reads ON but cannot shelve before the acknowledgement. Pinned in Task 7.

## File Structure

- Create `src/main/gc/shelve-restore-core.ts` — pure: pick the entry for a folder, name the leftover folder.
- Create `src/main/gc/shelve-restore-shell.ts` — `createShelveRestorer`, the default singleton `ensureShelvedRestored`, `restoreShelvedById`.
- Modify `src/main/pty.ts` — hook in `createPty`, restore-failed notice, `ShelvedRestoreError`.
- Modify `src/main/mcp/tool-handlers.ts` — `createSessionHandler`, `spawnTerminalHandler`.
- Modify `src/main/gc/gc-ipc.ts`, `src/preload/index.ts` (+ `index.d.ts` only if the type file needs it), `src/renderer/src/stores/gc.ts` — `gc:shelve:restore`, `gc:shelved:changed`.
- Create `src/renderer/src/components/CleanupShelvedCard.vue`; modify `CleanupView.vue`, `CleanupArchivesCard.vue`, `CleanupSettingsPane.vue`.
- Modify `src/main/gc/gc-exhaust-shell.ts` — archive guard. Modify `src/main/gc/gc-prefs.ts` — default ON.
- Tests: `tests/gc-shelve-restore-core.test.ts`, `tests/gc-shelve-restore-shell.test.ts`, `tests/gc-shelve-restore-service-real-git.test.ts` (the engine's own `gc-shelve-restore-real-git.test.ts` already exists), `tests/pty-shelved-restore.test.ts`, `tests/mcp-shelved-restore.test.ts`, `tests/cleanup-shelved-card.test.ts`; extend `tests/cleanup-archives-card.test.ts`, `tests/gc-exhaust-wiring.test.ts`, `tests/gc-shelve-prefs.test.ts`.

---

### Task 0: Commit this plan alone

- [ ] `git add docs/plans/2026-11-05-u2-3a-restore-triggers-plan.md && git commit -m "docs(plan): U2.3a restore triggers plan (U2.3a)"` then `git push -u origin card/T642-autonomous-cleanup-u2-3a-restore-triggers`.

### Task 1: The restore service (AC-1, AC-2, AC-5 engine)

**Files:** Create `shelve-restore-core.ts`, `shelve-restore-shell.ts`; Test `tests/gc-shelve-restore-core.test.ts`, `tests/gc-shelve-restore-shell.test.ts`, `tests/gc-shelve-restore-service-real-git.test.ts`.

**Interfaces:**

- Consumes: `ShelvedFile`/`ShelvedEntry`/`readShelved`/`writeShelved`/`withoutShelved` (`shelve-store.ts`), `canonicalPathKey` (`bundle-core.ts`), `isInside` (`containers/containers-core`), `readShelveRecord`/`restoreWorktree`/`verifyPreservation` (`shelve-shell.ts`), `withRepoLock` (`repo-lock-shell.ts`), `isFolderInUse` (`reaper/scanner-shell`).
- Produces (core):
  - `shelvedEntryFor(file: ShelvedFile, folder: string, platform?: string): ShelvedEntry | null` — the entry whose `worktreePath` equals or contains `folder` (same matching as `isShelvedFolder`).
  - `leftoverPathFor(worktreePath: string, now: number): string` — `<worktreePath>.leftover-YYYYMMDDTHHMMSS` (UTC).
- Produces (shell):

  ```ts
  export type ShelvedRestoreFailure =
    | RestoreFailure
    | 'record-missing'
    | 'repo-busy'
    | 'in-use'
    | 'move-aside-failed'
    | 'store-failed'
  export type ShelvedRestoreOutcome =
    | { status: 'not-shelved' }
    | { status: 'present'; entry: ShelvedEntry } // folder already whole; stale entry dropped
    | { status: 'restored'; entry: ShelvedEntry; attached: boolean; movedAside: string | null }
    | { status: 'failed'; entry: ShelvedEntry; reason: ShelvedRestoreFailure; message: string }
  export interface ShelveRestoreDeps {
    readStore(): Promise<ShelvedFile>
    forget(id: string): Promise<void>
    readRecord(repo: string, ns: string): Promise<ShelveRecord | null>
    restore(r: ShelveRecord): Promise<RestoreResult>
    verifyLive(r: ShelveRecord): Promise<VerifyResult>
    exists(p: string): Promise<boolean>
    inUse(p: string): Promise<boolean>
    moveAside(from: string, to: string): Promise<void>
    lock<T>(repo: string, work: () => Promise<T>): Promise<RepoLockResult<T>>
    sleep(ms: number): Promise<void>
    now(): number
    changed(): void
  }
  export function createShelveRestorer(deps: ShelveRestoreDeps): {
    ensure(folder: string): Promise<ShelvedRestoreOutcome>
    restoreById(id: string): Promise<ShelvedRestoreOutcome>
  }
  export function ensureShelvedRestored(folder: string): Promise<ShelvedRestoreOutcome> // default singleton, real deps
  export function restoreShelvedById(id: string): Promise<ShelvedRestoreOutcome>
  export function onShelvedChanged(cb: () => void): () => void
  ```

- [ ] **Step 1: failing core tests** (`gc-shelve-restore-core.test.ts`): `shelvedEntryFor(file, '/t/feat-x/api')` returns the `/t/feat-x` entry; `'/t/feat-xy'` returns null (prefix is not containment); empty file → null; Windows platform compares case-insensitively; `leftoverPathFor('/t/feat-x', Date.UTC(2026,10,5,9,8,7))` equals `/t/feat-x.leftover-20261105T090807`.
- [ ] **Step 2:** run, expect FAIL (module missing). **Step 3:** implement `shelve-restore-core.ts`. **Step 4:** PASS. Commit `test(gc): …` then `feat(gc): …`.
- [ ] **Step 5: failing shell tests with fakes** (`gc-shelve-restore-shell.test.ts`), one `it` each:
  - not shelved → `{status:'not-shelved'}` and `restore` never called (and no lock taken: a plain resume of an ordinary folder costs one store read).
  - shelved, folder missing → locks the repo, reads the record, calls `restore`, `forget(entry.id)`, `changed()`, returns `restored` with `movedAside: null`.
  - two concurrent `ensure` for the same folder (one `WT`, one `WT/api`) → `restore` called once, both resolve to the same `restored` outcome (single-flight keyed by entry id).
  - folder exists and `verifyLive` ok → `present`, `forget` called, `restore` not called.
  - folder exists, `verifyLive` not ok, `inUse` true → `failed`/`in-use`, nothing moved.
  - folder exists, not ok, not in use → `moveAside(path, leftoverPathFor(path, now))`, then `restore`; outcome `restored` with `movedAside` set; `restore` fails after the move → `failed` and the leftovers stay at the moved path (assert `moveAside` not reversed).
  - `readRecord` null → `failed`/`record-missing`, entry kept.
  - `restore` returns `{ok:false, reason:'archive-unverified'}` → `failed` with that reason and message; entry kept; `forget` not called.
  - `lock` answers `locked` five times (sleep 500 ms each, faked) → `failed`/`repo-busy`; answers `locked` twice then ok → proceeds.
  - `forget` throws after a good restore → outcome stays `restored` (the folder is real), a warning is logged; the next `ensure` sees the folder whole → `present`.
- [ ] **Step 6:** run, expect FAIL. **Step 7:** implement `createShelveRestorer`: read store → `shelvedEntryFor` → single-flight map by `entry.id` → up to 5 `lock` attempts, `sleep(500)` between (`reason:'locked'`; `'unavailable'` fails at once as `repo-busy` with its message) → record → existing-path rule above → `restore` → `forget` → `changed()`. Default deps: store file `path.join(app.getPath('userData'), SHELVED_FILE)` resolved lazily; `forget` serialised like `defaultShelveExecDeps`; `moveAside` is `fs.rename`; `inUse` is `isFolderInUse(...).catch(() => true)`. `restoreById` finds the entry by id and runs the same path (Cleanup's button). **Step 8:** PASS; commit pair.
- [ ] **Step 9: real-git test** (`gc-shelve-restore-service-real-git.test.ts`, fixture from `gc-shelve-fixture.ts`): shelve the fixture worktree with the real executor, `digestTree` before; `ensureShelvedRestored(wt + '/notes')` → worktree back, digest equal (AC-U2a bytes), entry gone from the store, `refs/archive/**` still present; second case: leave half a folder at the path (delete `node_modules` and `.git` of a restored copy, keep `tracked.txt` edited) with the entry kept → `restored`, leftovers sit at `<wt>.leftover-…` with their bytes intact. Commit.

### Task 2: Hook `createPty` (AC-1, AC-2 UI paths)

**Files:** Modify `src/main/pty.ts`; Test `tests/pty-shelved-restore.test.ts` (mock `electron` and `node-pty` exactly like `tests/pty-create-pty.test.ts`).

**Interfaces:**

- Consumes: `ensureShelvedRestored`, `ShelvedRestoreOutcome` (Task 1).
- Produces: `CreatePtyDeps.restoreShelved?: (cwd: string) => Promise<ShelvedRestoreOutcome>` (optional, defaults to `ensureShelvedRestored`); `export class ShelvedRestoreError extends Error { reason: ShelvedRestoreFailure; folder: string }`; `export function buildPosixRestoreFailedNotice(cwd: string, message: string): { command: string; args: string[] }` (same positional-argument injection guard as `buildPosixMissingDirNotice`).

- [ ] **Step 1: failing tests**:
  - `claude-resume` with cwd inside a shelved worktree: `restoreShelved` is awaited BEFORE `node-pty` `spawn` (assert call order); spawn cwd equals the requested cwd; on a `restored` outcome nothing else changes.
  - `restoreShelved` → `failed`: for `claude-resume`/`claude-new`/`claude-fork`, the spawned command is the restore-failed notice (`/bin/sh`, cwd and message as trailing positional args, never in the script body — reuse the malicious-cwd list from `pty-missing-dir-notice.test.ts`), spawn cwd is home, and no `claude` argv is built; for `shell`, `createPty` rejects with `ShelvedRestoreError` and `spawn` is never called.
  - `not-shelved`/`present` for a missing non-shelved cwd keeps today's behaviour (ancestor fallback for shell, missing-dir notice for claude kinds) — existing tests stay untouched and green.
  - `createTerminalPty` on a shelved folder restores first (the `spawn_terminal` path).
  - `cwd` undefined/empty → `restoreShelved` not called.
- [ ] **Step 2:** FAIL. **Step 3:** In `createPty`, right after the dedup guard and before `runPolicy('cap')`: `const restored = opts.cwd ? await (deps.restoreShelved ?? ensureShelvedRestored)(opts.cwd) : null`. On `failed`: claude kinds set `noSpawnReason = restored` and the later stale-directory branch is entered when `wantedDirMissing || noSpawnReason` using the new notice (and `applyCompanionEnv({dirMissing: true})`); shell kinds throw `ShelvedRestoreError`. The Windows notice is plain text via PowerShell like `buildMissingDirNotice`. Note in a comment that this is the BUG-144 guard for shelved paths. **Step 4:** PASS + run the existing `pty-*.test.ts` files. Commit pair.
- [ ] **Step 5:** check how the renderer reacts to a rejected `ptyCreate` for a shell pane (`TerminalPane.vue`, helper terminals); if it swallows the error silently, surface the message through the existing toast path (smallest change, with a test) — otherwise leave it. Note the finding in the REPORT either way.

### Task 3: MCP `create_session` / `spawn_terminal` (AC-2)

**Files:** Modify `src/main/mcp/tool-handlers.ts` (+ the steer-error catalog it uses for `PANE_FOLDER_UNKNOWN`); Test `tests/mcp-shelved-restore.test.ts`.

**Interfaces:** Consumes `ensureShelvedRestored`, `ShelvedRestoreError`. Produces steer error code `SHELVED_RESTORE_FAILED` with `nextActions`: open Cleanup → Shelved → Restore, or run the entry's `git worktree add` command.

- [ ] **Step 1: failing tests** (fake bridge as in existing MCP handler tests): `create_session` for a shelved folder calls restore before `bridge.dispatch('session.create')`; a failed restore returns `SHELVED_RESTORE_FAILED` and dispatches nothing; `spawn_terminal` whose `createTerminalPty` rejects with `ShelvedRestoreError` returns the same code and releases the terminal slot; a Scheduler-style call path is not touched: `tests/mcp-shelved-restore.test.ts` also asserts `src/main/scheduler-shell.ts` and `src/main/scheduler-core.ts` do not import `shelve-restore` (read the file text; AC-2 "ticks never restore").
- [ ] **Step 2:** FAIL. **Step 3:** implement in `createSessionHandler` (first statement after the bridge check) and catch `ShelvedRestoreError` in `spawnTerminalHandler`. **Step 4:** PASS; commit pair.

### Task 4: Restore action in Cleanup (AC-3, AC-5 UI)

**Files:** Modify `gc-ipc.ts`, `preload/index.ts`, `stores/gc.ts`, `CleanupView.vue`, `design.md`, both i18n files; Create `CleanupShelvedCard.vue`; Test `tests/cleanup-shelved-card.test.ts`, extend the IPC-surface test that lists channels (the U2.2 commit `3d155637` touched it; find it with `grep -l "gc:shelve:ack" tests`).

**Interfaces:**

- Produces: IPC `gc:shelve:restore` (`id: string`) → `ShelveRestoreAck = { ok: boolean; status: ShelvedRestoreOutcome['status']; attached?: boolean; movedAside?: string | null; reason?: ShelvedRestoreFailure; message?: string }`; preload `gcRestoreShelved(id): Promise<ShelveRestoreAck>`; event `gc:shelved:changed` (preload `onGcShelvedChanged(cb)`), sent whenever `onShelvedChanged` fires; store `gc.restoreShelved(id)` (toasts, then `refresh()`).
- `CleanupShelvedCard` props `{ shelved: ShelvedEntry[]; busyIds: ReadonlySet<string> }`, emits `restore: [id: string]`; renders only when `shelved.length > 0`.

- [ ] **Step 1: design.md first.** Add "Shelved card" under the Archives card section (§6): same `rounded border border-border bg-surface` shell and header as the Archives card, `ArchiveRestore` icon, one row per entry (folder alias, branch in mono, "idle N d", relative shelved time, freed size), a `Button variant="soft"` Restore, busy state shows the existing spinner pattern; empty = not rendered; failure copy is inline under the row, never only a toast.
- [ ] **Step 2: failing tests**: card renders one row per entry with the branch and a `data-testid="shelved-restore"` button; click emits `restore` with the entry id; a busy id disables its button; no rows → nothing rendered. Store test: ack `ok:true` with `movedAside` shows a toast naming that path (AC-5 wording: "kept at … delete it when you like"); `repo-busy` shows "try again in a moment"; `record-missing` shows the copyable `git worktree add <path> <branch>` for the entry (the branch still exists) — every failure reason has copy plus a next step.
- [ ] **Step 3:** FAIL. **Step 4:** implement the handler (`restoreShelvedById`), preload, store, card, and mount the card in `CleanupView.vue` between `CleanupArchivesCard` and `CleanupTrashCard`, fed by `gc.snapshot?.shelved`. Subscribe the store to `gc:shelved:changed` → `refresh()`. i18n keys under `cleanup.gc.shelved.*` in both locales (keep the existing `activity` keys). **Step 5:** PASS; `npm run typecheck:web`. Commit pair.

### Task 5: Archive guard (AC-4)

**Files:** Modify `gc-exhaust-shell.ts`, `gc-ipc.ts` (`gc:archives:delete` passes the shelved namespaces), `preload/index.ts` (ack type), `stores/gc.ts` (toast), `CleanupArchivesCard.vue`, both i18n files, `design.md`; Test extend `tests/gc-exhaust-wiring.test.ts`, `tests/cleanup-archives-card.test.ts`.

**Interfaces:**

- `deleteConfirmedArchives(req, neverClean = [], git = execGit, shelved: ReadonlyMap<string, ShelvedEntry> = new Map())` — keyed by `entry.namespace`. `ArchiveDeleteAck.shelvedArchives?: Array<{ namespace: string; id: string; branch: string | null }>`; `ok` is false when non-empty. The card gets `shelved: ReadonlyMap<string, ShelvedEntry>` and emits `restore: [id: string]`.

- [ ] **Step 1: failing tests**: with a shelved map containing namespace N, confirming N plus an ordinary archive deletes only the ordinary one and acks `shelvedArchives: [{namespace: N, …}]` (no `git update-ref -d` for N's refs — assert on the fake runner); an expiry run (`expireArchivesNow`) is unchanged (already skips shelved; keep an assertion). Card: a shelved row's Delete button is disabled with a title "Shelved worktree — restore it first" and a visible Restore button next to it that emits `restore`; non-shelved rows unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** implement; the gc-ipc handler reads the store via `readShelved` and builds the map. Store toast: "Kept N archives of shelved worktrees. Restore the worktree first (Cleanup → Shelved)." **Step 4:** PASS; commit pair. design.md: add the disabled-with-guide state to the Archives card spec.

### Task 6: Settings → Cleanup switch and acknowledge (AC-6 UI)

**Files:** Modify `CleanupSettingsPane.vue`, `stores/gc.ts` (`ackShelveReport()` → `window.api.gcAckShelveReport()` then applies the returned prefs), both i18n files, `design.md` (new Settings row variant: status line + inline action button); Test extend `tests/cleanup-settings-pane.test.ts` (find with `ls tests | grep settings-pane`; create it if absent).

- [ ] **Step 1: failing tests**: a "Shelving" section with `data-testid="gc-shelve"` toggle; toggling writes `shelve: { ...prefs.shelve, enabled }` through `saveGc` (a whole `ShelvePrefs`, since main fills missing fields); when `enabled && !firstReportAcknowledged` a status line says the first pass only reports and an `Acknowledge first report` button (`data-testid="gc-shelve-ack"`) calls `gc.ackShelveReport()`; after acknowledgement the line reads "Shelving is active" and the button is gone; when off the section explains what shelving does in one sentence.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; commit pair.

### Task 7: Default ON (AC-6 default)

**Files:** Modify `gc-prefs.ts` (`defaultShelvePrefs().enabled = true`, fix the field comment), Test `tests/gc-shelve-prefs.test.ts`.

- [ ] **Step 1: failing tests** (edit the existing default expectation and add the new cases; the change of the default is the spec's C1 flip, not a weakened test): defaults read `enabled: true, firstReportAcknowledged: false`; a stored file with no `shelve` key reads ON; `shelve: { enabled: false }` stays false; the kill-switch write (`withShelveDisabled`) round-trips as false; `mergePrefs` from a settings write keeps `firstReportAcknowledged` unless off→on; `runShelveCycle` with default prefs and `firstReportAcknowledged: false` returns `mode: 'report'` and never calls `shelve` (extend `tests/gc-shelve-cycle.test.ts` with that one case).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run `tests/gc-shelve-*.test.ts` — any other test that relied on the old default is updated to pass its prefs explicitly. Commit pair.

### Task 8: Docs and contracts (AC-7)

- [ ] `CHANGELOG.md`: under `## 2026-11-05` add `### Added` bullets (resume / new session / terminal / `create_session` / `spawn_terminal` restore a shelved worktree; Restore button and Shelved card; Settings switch and acknowledge) and `### Changed` (shelving is on by default, report-only until acknowledged; the Archives card refuses to delete a shelved worktree's archive). User-facing wording.
- [ ] `docs/user/cleanup.md`: rewrite "Shelving idle worktrees (off until restore lands)" → on by default, how restore happens, the Restore button, leftovers moved aside, the archive guard. Run `tests/gc-shelve-docs.test.ts` and adjust only if it pins stale wording.
- [ ] `docs/harnu-features.md`: resume / `create_session` / `spawn_terminal` restore a shelved path first (and can fail with `SHELVED_RESTORE_FAILED`); `list_cleanup` unchanged; bump marker to `v122 (2026-11-05)`.
- [ ] Commit `docs(gc): …`.

### Task 9: Gates and live proof (AC-7 gates, AC-8)

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, the touched tests, then the full suite under the CPU cap, then `npm run build`. Fix failures at the cause.
- [ ] AC-8 via `docs/dev/live-verify-second-instance.md`: `--user-data-dir=/tmp/harnu-verify-u23a`, fake HOME, throwaway repo under `/tmp`; lower the threshold, acknowledge the report, shelve a worktree, record its `digestTree`, resume its session → folder restored with the same digest and the session open there with history; then try Delete on its archive → refused with "Restore it first". Screenshots of the Shelved card, the guarded Archives row and the Settings section go to `.harnu/out/u23a/`, then onto the card with `update_card { images }` if the `harnu` MCP is reachable; otherwise state that in the report as `AC-8: partially met` with the paths.
- [ ] Write `.harnu/REPORT.md` in the card's format, `git status --porcelain` empty, push, then `ListAgents` and `SendMessage` the owner.

## Self-review

- Spec coverage: AC-1 → Tasks 1–2; AC-2 → Tasks 2–3 (+ scheduler pin); AC-3 → Task 4; AC-4 → Task 5; AC-5 → Tasks 1 and 4 (leftovers moved aside, guided copy); AC-6 → Tasks 6–7; AC-7 → Tasks 8–9; AC-8 → Task 9.
- Order: the default flips only in Task 7, after every restore trigger (U2.2 finding 1).
- Not in this unit: Archived sidebar section (U2.3b), U2.2 findings 5–11 except where they overlap, `worktree:create` onto a shelved path (it would hit `path-exists` later; recorded as a finding), BUG-144.
