# U3.1 — Docker Autonomy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (one session, inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Docker's autonomous actions their own switch, report-only first cycle, acknowledgement, a global "pause autonomous cleanup", a lock-guarded and capped Docker slot in the cleanup cycle with a failure-streak kill switch, and an `autopilot` journal actor — with an EMPTY planner.

**Architecture:** A `docker: DockerAutonomyPrefs` block and a top-level `pauseAutonomous` flag join `GcPrefs` (copying `shelve`'s shape but sharing no state with it). `runGcCycle` gets an optional `docker` slot, implemented in `src/main/gc/docker-cycle.ts` (`runDockerCycle`), which runs after the scan, under a machine-wide file lock, and plans nothing yet. `pauseAutonomous` makes the whole cycle (clean, housekeeping, expiry, shelve, Docker) act on nothing. Settings → Cleanup gets a "Docker" section.

**Tech Stack:** Electron main (Node), Vue 3 + Tailwind v4 + vue-i18n, Vitest.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §2, §3, §4 U3, §5, §6, §7 C1/C5–C8/C11, §10 Amendments (2026-11-05). Pattern copied (not shared): `docs/plans/2026-11-05-u2-2-shelve-cycle-plan.md`.

## Global Constraints

- Docker autonomy has ONE switch (pausing + Docker garbage removal), independent of `autopilot`, `firstReportAcknowledged` and `shelve`; default ENABLED; first cycle report-only; turning it on resets its acknowledgement; no settings write can acknowledge.
- Defaults (spec §10 A-3): pause after **2 h** idle (`idleHours`), low-water **3** free bridge slots (`lowWaterSlots`), **6** pauses/hour (`maxParksPerHour`), **30 min** minimum since last `up` (`minAgeMinutes`); plus `maxPerCycle` 5 and `failureLimit` 3.
- UI word is **"Paused"** / pt-BR **"Pausada"**; code, journal and docs keep "park".
- This unit changes NO docker state: no `down`, `rm`, `network rm`. The planner returns `[]`. No `docker-*-core.ts` files (U3.2 owns them).
- Never autonomous: delete a volume, empty trash, `git gc`, expire an archive (spec §5). Global pause stops every autonomous action.
- English only; no client identifiers; every i18n key in `en.json` AND `pt-BR.json`; no raw colors (design.md tokens); `design.md` §6 before the Settings UI.
- CPU: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- Commits: Conventional Commits with `(U3.1)`; a failing-test commit precedes each implementation commit; no attribution lines.
- Contracts: `CHANGELOG.md` (2026-11-05), `docs/user/cleanup.md`, `docs/harnu-features.md` (bump `v122` → `v123`).

## Review Focus

- A prefs file written before this unit (no `docker` key) loads ENABLED + unacknowledged, never acting before the first report is acknowledged. Pinned in Task 1.
- Two Harnu instances (`--user-data-dir`) cycle at once: exactly one runs the Docker slot, the other reports `locked` and does nothing. Pinned in Task 3 (real lock file).
- Kill switch trips, then a stale settings form saves with `enabled: false` unchanged: it stays off and the acknowledgement is not touched; a real off→on toggle resets the acknowledgement. Pinned in Task 1.
- Global pause on while a report-only/ack'd state exists: acknowledgement is untouched and nothing is notified. Pinned in Task 4.
- A throwing Docker slot never fails the cycle, shelving still runs. Pinned in Task 4.

---

### Task 1: Docker autonomy prefs + global pause

**Files:** Modify `src/main/gc/gc-prefs.ts`; Test `tests/gc-docker-prefs.test.ts`.

**Interfaces — Produces:**
`interface DockerAutonomyPrefs { enabled; firstReportAcknowledged; idleHours; lowWaterSlots; maxParksPerHour; minAgeMinutes; maxPerCycle; failureLimit }`; `GcPrefs.docker: DockerAutonomyPrefs`; `GcPrefs.pauseAutonomous: boolean`; `defaultDockerPrefs()`; `withDockerAcknowledged(p)`, `withDockerDisabled(p)`; constants `DEFAULT_DOCKER_IDLE_HOURS=2`, `DEFAULT_DOCKER_LOW_WATER_SLOTS=3`, `DEFAULT_DOCKER_PARKS_PER_HOUR=6`, `DEFAULT_DOCKER_MIN_AGE_MINUTES=30`, `DEFAULT_DOCKER_PER_CYCLE=5`, `DEFAULT_DOCKER_FAILURE_LIMIT=3`.

- [ ] Write failing tests (mirror `tests/gc-shelve-prefs.test.ts`): defaults equal the spec values with `enabled: true`, `firstReportAcknowledged: false`; `pauseAutonomous` defaults `false`; an old file (no `docker`, `shelve` only) reads docker defaults and keeps shelve untouched; explicit `enabled:false` stays off; junk/corrupt reads defaults; clamps (`idleHours` 0→1, `maxParksPerHour` 999→60, `failureLimit` -4→1…); `mergeIncomingPrefs` off→on resets the docker ack and on→on keeps it; a write carrying `docker.firstReportAcknowledged: true` cannot acknowledge; the shelve ack and the autopilot ack are unaffected by docker changes and vice versa; `pauseAutonomous` is writable through `mergeIncomingPrefs`; `withDockerAcknowledged` / `withDockerDisabled` touch only the docker block.
- [ ] Run: FAIL (missing exports).
- [ ] Implement in `gc-prefs.ts` next to `shelve` (bounds: `idleHours` 1..720, `lowWaterSlots` 1..30, `maxParksPerHour` 1..60, `minAgeMinutes` 1..1440, `maxPerCycle` 1..20, `failureLimit` 1..10).
- [ ] Run: PASS. Commit test then implementation separately.

### Task 2: `autopilot` journal actor

**Files:** Modify `src/main/containers/containers-wire.ts:137`, `containers-journal.ts:28`; Tests `tests/containers-journal.test.ts`, `tests/containers-wire.test.ts` (or `tests/mcp-containers-listing*.test.ts`), `docs/harnu-features.md`.

**Produces:** `type Actor = 'operator' | 'agent' | 'autopilot'`; `ACTORS` (journal) derived from an exported `ACTORS` roster in the wire.

- [ ] Failing tests: a tombstone with `actor: 'autopilot'` round-trips `serializeTombstone` → `parseJournal`; an unknown actor is still dropped; `list_containers.recent[].actor` keeps `'autopilot'` through the listing; `docs/harnu-features.md` says `operator`, `agent` or `autopilot` and the marker is `v123` (docs test in the style of `tests/gc-shelve-docs.test.ts`).
- [ ] Implement; update the sentence at `docs/harnu-features.md` ("`actor` is `operator` or `agent`") and bump the marker.
- [ ] PASS; commit pair.

### Task 3: Machine-wide lock primitive

**Files:** Modify `src/main/gc/repo-lock-shell.ts` (extract only); Test `tests/gc-docker-lock.test.ts`.

**Produces:** `withLockFile<T>(file: string, work: () => Promise<T>, opts?: RepoLockOpts): Promise<RepoLockResult<T>>` (the body of `withRepoLock` after the lock path is known; `withRepoLock` becomes `lockPathOf` + `withLockFile`); `dockerLockPath(tmpDir = os.tmpdir(), uid = process.getuid?.()): string` → `harnu-docker-autonomy-<uid|u>.lock`.

- [ ] Failing tests on a real temp dir: second concurrent `withLockFile` on the same file is `locked`; a stale lock (dead pid) is reclaimed; `dockerLockPath` is under the given tmp dir and carries the uid. Existing `tests/*repo-lock*` stay green (behaviour preserved).
- [ ] Extract; run the repo-lock tests + new test; commit pair.

### Task 4: Docker slot, global pause, wire record

**Files:** Create `src/main/gc/docker-cycle.ts`; Modify `gc-cycle.ts` (state fields `dockerStreak`, `dockerReportKey`; `deps.docker` slot; global pause), `gc-wire.ts` (`DockerCycleRecord`, `CycleRecord.docker?`, `CycleRecord.paused?`, `ShelveCycleRecord.mode` gains `'paused'`), `shelve-cycle.ts` (honour pause); Tests `tests/gc-docker-cycle.test.ts`, extend `tests/gc-cycle.test.ts` fixtures if `CycleState` is built by hand.

**Interfaces — Produces:**

```ts
type DockerAction = { kind: 'park' | 'prune-network' | 'remove-orphan'; id: string; reason: string }
type DockerOutcome = { ok: true } | { ok: false; reason: string; refusal?: boolean }
interface DockerCycleDeps {
  prefs(): GcPrefs
  plan(): Promise<DockerAction[]> // EMPTY in this unit
  execute(a: DockerAction): Promise<DockerOutcome> // never throws
  lock<T>(work: () => Promise<T>): Promise<RepoLockResult<T>>
  disableDocker(): Promise<void>
  notify(n: { title: string; body: string }): void
  now(): number
}
interface DockerCycleRecord {
  mode: 'off' | 'paused' | 'report' | 'act'
  found: number
  acted: number
  refused: number
  failed: number
  deferred: number
  locked: boolean
  paused: boolean
  pausedReason: string | null
}
function runDockerCycle(deps: DockerCycleDeps, state: CycleState): Promise<DockerCycleRecord>
```

`GcCycleDeps.docker?(): Promise<DockerCycleRecord>`; `CycleRecord.docker?: DockerCycleRecord`.

- [ ] Failing tests (fakes): switch off → `mode:'off'`, `plan` never called, lock never taken; `pauseAutonomous` → `mode:'paused'`, nothing called, acknowledgement untouched; unacknowledged → `mode:'report'`, `found` = planned count, `execute` never called, one notice per changed count; acknowledged + 7 actions with `maxPerCycle` 5 → 5 executed, `deferred` 2; a streak of `failureLimit` failures → stops, `disableDocker` called, `paused:true`, `pausedReason` names the limit and the last failure reason, one notice that says why; refusals (`refusal:true`) never count; streak persists across cycles through `state.dockerStreak` and resets on success; lock `locked` → `locked:true`, nothing planned; empty planner → record all zeros in report and act modes; two overlapping `runDockerCycle` calls over the REAL `withLockFile` (temp dir, slow `plan`) → exactly one runs; in `runGcCycle`: `docker` slot runs after the scan and after the shelve slot, a throwing slot is logged and does not fail the cycle, the record carries `docker`; `pauseAutonomous` makes `runGcCycle` clean nothing, run no housekeeping/expiry/shelve/docker, notify nothing, return `paused:true` and still emit the record; `runShelveCycle` under pause returns `mode:'paused'` without probing.
- [ ] Implement `docker-cycle.ts` (copy `shelve-cycle.ts`'s report/cap/kill-switch branches); wire `gc-cycle.ts`/`gc-wire.ts`/`shelve-cycle.ts`.
- [ ] PASS + existing `gc-cycle`, `gc-shelve-cycle` tests green; commit pair.

### Task 5: IPC, preload, store

**Files:** Modify `src/main/gc/gc-ipc.ts` (`ackDockerReport`, `gc:docker:ack`, `docker:` slot with `lock: (w) => withLockFile(dockerLockPath(), w)`, `plan: async () => []`, `execute` that refuses `not-implemented`, `disableDocker` persisting `withDockerDisabled`), `src/preload/index.ts` (`gcAckDockerReport`), `src/renderer/src/stores/gc.ts` (`ackDockerReport`); Test `tests/gc-docker-wiring.test.ts` (source-level wiring checks in the style of `tests/gc-shelve-wiring.test.ts`).

- [ ] Failing wiring test: `gc:docker:ack` handler exists and calls `withDockerAcknowledged`; the slot passes the machine-wide lock; the kill switch persists `withDockerDisabled`; preload and store expose the call; `execute` does not call `docker` (no `execFile`/`docker` in the slot's file).
- [ ] Implement; PASS; commit pair.

### Task 6: Settings → Cleanup "Docker" section

**Files:** Modify `design.md` §6 (own commit, FIRST), `CleanupSettingsPane.vue`, `en.json`, `pt-BR.json`; Test `tests/cleanup-settings-docker.test.ts` (source/i18n-parity checks in the style of existing Settings-pane tests).

- [ ] `design.md` §6 Settings → Cleanup: add the Docker section (`data-testid="cleanup-settings-docker"`; `gc-docker` toggle; status line `gc-docker-status` with report-only text + `gc-docker-ack` Soft button, or the active text; `gc-pause-all` toggle row "Pause all autonomous cleanup" with the `--warning` note when on). Commit.
- [ ] Failing test: the section, test ids and every `cleanup.gc.settings.docker.*` key exist in BOTH locales; no string says "parked"/"Parked" for stacks, the UI says "Paused"/"Pausada".
- [ ] Implement the section (copy of the shelve block) + keys; typecheck; PASS; commit pair.

### Task 7: Contracts, docs, visual proof, report

**Files:** `CHANGELOG.md`, `docs/user/cleanup.md`, `.harnu/out/u31/*.png`, `.harnu/REPORT.md`, `.harnu/memory/decisions.md` (via `memory_append`).

- [ ] CHANGELOG entry (2026-11-05, Added); `docs/user/cleanup.md` section "Docker: pausing and garbage" (switch, report-only first cycle, acknowledge, global pause, nothing acts yet in this release).
- [ ] Gates: `npm run typecheck`, `npm run lint`, the full suite at half cores, `npm run build`.
- [ ] Isolated instance (`--user-data-dir=/tmp/harnu-verify-u31`), screenshot the section dark + light into `.harnu/out/u31/`.
- [ ] Write `.harnu/REPORT.md`; record the decisions; commit; push; `git status` clean.
