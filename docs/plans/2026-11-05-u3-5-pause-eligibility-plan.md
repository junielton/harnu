# U3.5 Pause eligibility and cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide which compose stacks Cleanup pauses on its own and when, and wire that into U3.1's Docker slot so idle stacks are paused without a click (after the report-only first cycle).

**Architecture:** A pure eligibility core (`park-eligibility-core.ts`) turns per-stack facts into a ranked list of pause decisions plus a refusal per stack that was skipped. A thin planner/executor (`park-cycle.ts`) gathers the facts (containers snapshot, GC bundles, U3.2 activity, Harnu browser panes, host connections, the journal) and calls `getContainersService().pause(decision, 'autopilot')`. U3.1's `docker-cycle.ts` gains a composition point (`composeDockerPlanners`) so U3.3's garbage planner and this pause planner sit side by side.

**Tech Stack:** TypeScript, vitest, Electron main process (no renderer work).

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U3 "Park", AC-U3b, §5, §7 C1/C7/C10, §10 A-2/A-3. Risks: `docs/studies/2026-10-27-autonomous-cleanup-risks.md` 10 and 11. Card: T648.

## Global Constraints

- Defaults (spec §10 A-3): pause after **2 h** idle (`docker.idleHours`), **6** pauses per hour (`docker.maxParksPerHour`), **30 min** minimum since the stack's last `up` (`docker.minAgeMinutes`). Names are the existing ones in `gc-prefs.ts`; no new pref.
- UI word is **"Paused"** (pt-BR "Pausada"); code, journal and spec keep "park".
- `keep` and `neverClean` always protect, under pressure too; an open PR does NOT protect (C7).
- Every rule fails closed: a fact that could not be read is a refusal, never a pass.
- The pause action is U3.4's (`getContainersService().pause`); this unit calls it and does not change it.
- English only in code, comments, tests, docs, commits. Commits are Conventional Commits with a `(U3.5)` suffix, no attribution lines.
- CPU budget: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- Touch only the files listed in "File structure".

## Review Focus

- A stack with no container start time and no session activity (age unknown) is never paused (`unknown-age`).
- The host-connection probe failing (no `ss`, unsupported platform) refuses every stack with `connections-unknown`; it never reads as "no connections".
- U3.2's activity read failing (docker busy, stats error) refuses every stack with `activity-unknown`.
- A stack whose project has no U3.2 activity row (not running) is not a pause candidate at all (nothing to pause).
- Two bundles sharing one stack: if either has a busy session or a protection mark, the stack stays.
- The journal being unreadable makes the hourly cap unknowable: plan nothing (`cap-unknown`) rather than ignore the cap.

## File structure

- Create `src/main/gc/park-eligibility-core.ts` — pure rules: `parkVerdict`, `planPauses`, `pausesInLastHour`, `paneTargetsPort`, `pauseActivityLine`.
- Create `src/main/gc/park-cycle.ts` — `createParkPlanner(deps): DockerPlanner`: fact gathering, `plan()`, `execute()`.
- Create `src/main/containers/docker-listeners-shell.ts` — read-only host-connection probe (`ss` on Linux, `lsof` on macOS).
- Modify `src/main/browser/browser-service.ts` — read-only `listOpenPaneUrls()`.
- Modify `src/main/gc/docker-cycle.ts` — `DockerPlanner` + `composeDockerPlanners` + would-pause list in the report-only notice.
- Modify `src/main/gc/shelve-eligibility-core.ts` — paused stacks do not refuse shelving.
- Modify `src/main/gc/shelve-cycle.ts` / `src/main/gc/gc-ipc.ts` — pass the paused registry to the shelve context; wire the pause planner into the Docker slot.
- Tests: `tests/gc-park-eligibility.test.ts`, `tests/gc-park-cycle.test.ts`, `tests/docker-listeners-shell.test.ts`, `tests/browser-pane-urls.test.ts`, extend `tests/gc-docker-cycle.test.ts` and `tests/gc-shelve-eligibility.test.ts`.
- Docs: `CHANGELOG.md`, `docs/user/cleanup.md`, `docs/user/containers.md`; `docs/harnu-features.md` only if an agent-visible field changes (none planned).

---

### Task 1: Eligibility core (AC-1, AC-2)

**Files:**

- Create: `src/main/gc/park-eligibility-core.ts`
- Test: `tests/gc-park-eligibility.test.ts`

**Interfaces:**

- Produces:
  - `type ParkRefusal = 'not-pausable' | 'session-busy' | 'protected' | 'activity-unknown' | 'active' | 'browser-pane' | 'connections-unknown' | 'connection' | 'unknown-age' | 'too-young' | 'too-recent'`
  - `interface ParkFacts { stack: StackRow; sessions: readonly SessionPresence[]; protectedMark: boolean; activity: StackActivity | null; paneUrls: readonly string[]; established: number | null }` (`established` is the count of established host connections to the stack's published ports, null = could not tell)
  - `type ParkVerdict = { eligible: true; idleMs: number; since: number } | { eligible: false; reason: ParkRefusal }`
  - `parkVerdict(f: ParkFacts, ctx: { now: number; idleHours: number; minAgeMinutes: number }): ParkVerdict`
  - `pausesInLastHour(journal: readonly Tombstone[], now: number): number` — counts entries with `actor === 'autopilot'` and a `paused` record on any stack, `at > now - 3_600_000`.
  - `interface ParkCandidate extends ParkFacts { decision: PauseDecision }`
  - `planPauses(input: { candidates: readonly ParkCandidate[]; journal: readonly Tombstone[]; now: number; idleHours: number; minAgeMinutes: number; maxParksPerHour: number }): { pauses: Array<{ decision: PauseDecision; idleMs: number; reason: string }>; skipped: Array<{ stack: string; reason: ParkRefusal | 'hourly-cap' }> }`
  - `paneTargetsPort(url: string, ports: readonly number[]): boolean`
  - `pauseActivityLine(args: { name: string; idleMs: number; restoreCommand: string }): { title: string; body: string }`

- [ ] **Step 1: Write the failing tests** (one case per rule and per idle signal). Names and assertions:
  - `parkVerdict` refuses `not-pausable` for verdicts `active`, `protected`, `orphan`, `unknown`; accepts `zombie` and `pending`.
  - refuses `session-busy` when any linked session is `working` or `needs-input`; `open-idle` and `none` do not refuse by themselves.
  - refuses `protected` when `protectedMark` is true; a stack with an open PR but no mark is eligible (no PR input exists in the facts: the test documents C7 by asserting the fact set has no PR field).
  - `activity: null` → `activity-unknown`; `activity.active === true` → `active`.
  - a pane URL `http://localhost:<stack port>/` → `browser-pane`; `http://127.0.0.1:<port>`, `http://[::1]:<port>`, and a default-port URL (`http://localhost/` with port 80 published) match; an unrelated port or a remote host does not.
  - `established: null` → `connections-unknown`; `established: 1` → `connection`.
  - idle signals: with `lastSessionActivityAt` 1 h ago and `lastContainerEventAt` 3 h ago and the other signals quiet, idle is 1 h → `too-recent` at `idleHours: 2`, eligible at `idleHours: 0.5` with `idleMs === 3_600_000`. Symmetric case with container event newer than session. Both null → `unknown-age`.
  - `too-young`: newest `ContainerRow.startedAt` 10 min ago with `minAgeMinutes: 30` → `too-young` even when `lastContainerEventAt` is old; 31 min ago passes. A stack restarted by hand (new `startedAt`) is therefore not re-paused before the minimum age.
  - `pausesInLastHour` counts only autopilot pause entries inside the hour: an operator pause, an autopilot `stop` without `paused`, an entry 61 min old are not counted; one 59 min old is.
  - `planPauses` orders longest-idle first and, with `maxParksPerHour: 6` and 5 already in the journal, returns one pause and marks the rest `hourly-cap`; with the cap reached it returns none; ineligible candidates land in `skipped` with their refusal.
  - `pauseActivityLine({ name: 'shop', idleMs: 3 * 3_600_000, restoreCommand: 'docker compose -p shop up -d' })` → body ``Paused `shop` — idle 3 h · bring back: `docker compose -p shop up -d` ``.

- [ ] **Step 2: Run to verify failure.** Run: `nice -n 19 npx vitest run tests/gc-park-eligibility.test.ts --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1` — Expected: FAIL, module not found. Commit the red test as `test(gc): pause eligibility — verdict, idle signals, hysteresis and hourly cap, failing (U3.5)`.

- [ ] **Step 3: Implement** the signatures above in `park-eligibility-core.ts`. Rule order in `parkVerdict`: not-pausable (`isPausableVerdict`) → session-busy → protected → activity-unknown → active → browser-pane → connections-unknown → connection → unknown-age → too-young → too-recent. Idle `since` = newest of `stack.lastSessionActivityAt` and `stack.lastContainerEventAt` (the quiet signals above already refused); min age uses the newest `containers[].startedAt` among running containers. Hours format in `pauseActivityLine`: whole hours when ≥ 1 h (`3 h`), else whole minutes (`40 min`).

- [ ] **Step 4: Run to verify pass**, then commit `feat(gc): pause eligibility core — idle signals, protection, minimum age and hourly cap (U3.5)`.

### Task 2: Host-connection probe and pane URLs (AC-1 signals)

**Files:**

- Create: `src/main/containers/docker-listeners-shell.ts`
- Modify: `src/main/browser/browser-service.ts` (add `listOpenPaneUrls`)
- Test: `tests/docker-listeners-shell.test.ts`, `tests/browser-pane-urls.test.ts`

**Interfaces:**

- Produces:
  - `parseSsEstablished(stdout: string): number[]` — local port of each established TCP connection from `ss -Htn state established` output; `parseLsofEstablished(stdout: string): number[]` — same from `lsof -nP -iTCP -sTCP:ESTABLISHED -Fn` (`n127.0.0.1:5432->127.0.0.1:51234` lines).
  - `readEstablishedPorts(deps: { run(cmd: string, args: readonly string[]): Promise<{ stdout: string }>; platform: NodeJS.Platform }): Promise<Map<number, number> | null>` — port → established count; null when the platform has no probe (win32) or the command failed.
  - `listOpenPaneUrls(): string[]` — live URL of every open Harnu browser pane (discarded panes contribute their remembered address), read-only.

- [ ] **Step 1: Failing tests.** Fixtures of real `ss` and `lsof` output: counts per local port; IPv6 `[::1]:5432` and `*:8080` forms; a command that rejects → `null`; `win32` → `null`; `readEstablishedPorts` runs only `ss`/`lsof` with fixed args (assert the recorded argv). For `listOpenPaneUrls`: a registry with two panes, one live (host `info().url`), one discarded (`discarded.url`), returns both; pane with neither is skipped.
- [ ] **Step 2: Run to verify failure; commit red.**
- [ ] **Step 3: Implement.** Probe uses `execFile`-style (no shell). `listOpenPaneUrls` reads `browserRegistry.list()` and `getBrowserHost().info(paneId)?.url`; confirm the `DiscardState` field name for the remembered address before writing it.
- [ ] **Step 4: Verify pass; commit `feat(containers): read-only host-connection probe and open pane URLs (U3.5)`.**

### Task 3: Planner and executor (AC-3, AC-5)

**Files:**

- Create: `src/main/gc/park-cycle.ts`
- Test: `tests/gc-park-cycle.test.ts`

**Interfaces:**

- Consumes: Task 1 and 2 exports; `DockerAction`, `DockerOutcome` from `docker-cycle.ts`; `PauseOutcome` from `park-core.ts`; `readStackActivity` from `docker-facts-shell.ts`.
- Produces:
  - `interface ParkPlannerDeps { prefs(): GcPrefs; bundles(): readonly WorktreeBundle[]; snapshot(): Promise<ContainersSnapshot | null>; journal(): Promise<Tombstone[] | null>; activity(): Promise<StackActivity[] | null>; paneUrls(): string[]; established(): Promise<Map<number, number> | null>; pause(d: PauseDecision, actor: 'autopilot'): Promise<PauseOutcome>; activityLine(n: { title: string; body: string }): void; now(): number }`
  - `createParkPlanner(deps: ParkPlannerDeps): DockerPlanner` (`DockerPlanner` is defined in Task 4).
  - `pauseOutcomeToDocker(o: PauseOutcome): DockerOutcome` — `ok` → ok; `CHANGED_SINCE_DECIDED`, `NOT_PAUSABLE`, `CONFIRM_ONLY`, `CONFIG_UNREADABLE`, `STACK_NOT_FOUND`, `NOT_COMPOSE`, `DOCKER_UNAVAILABLE` → `{ ok: false, refusal: true }`; `DOWN_FAILED`, `JOURNAL_FAILED` → failure (no `refusal`).

- [ ] **Step 1: Failing tests** with fakes for every dep:
  - `plan()` returns `[]` when the snapshot, journal or activity read is null (`cap-unknown` / `activity-unknown`), when the stack has no activity row (not running), and for a stack with a keep mark; returns one `kind: 'park'` action whose `id` is the stack id and `reason` is e.g. `idle 3 h` for an eligible stack. Linked bundle resolution: bundle matches by `stackIds` or `sharedStackIds`; two bundles, one busy → stack stays; `protectedMark` comes from `isProtectedNow(bundle, prefs)`.
  - Containers passed to `established()` filter: only the ports of candidate stacks matter; the count for a stack is the sum over its `ports`.
  - `execute(action)` calls `pause` once with `{ stack, containerIds, verdict }` as planned and `'autopilot'`; on `ok` it emits exactly one activity line built by `pauseActivityLine` from `outcome.record.restoreCommand`; on refusal codes returns `{ ok: false, refusal: true }` and emits no line; `DOWN_FAILED`/`JOURNAL_FAILED` return a failure (no `refusal`) and emit no line; `execute` for an action it did not plan returns a refusal (`CHANGED_SINCE_DECIDED`-style) and never calls `pause`.
  - `owns('park')` true, other kinds false.
- [ ] **Step 2: Run to verify failure; commit red** (`test(gc): the pause planner and executor — facts, refusals vs failures, one Activity line per pause, failing (U3.5)`).
- [ ] **Step 3: Implement.** Decisions are kept in a per-planner `Map<stackId, { decision, idleMs }>` replaced on every `plan()`, so `DockerAction` is not extended and U3.3 merges cleanly. `sampleGapMs` stays at U3.2's default.
- [ ] **Step 4: Verify pass; commit `feat(gc): the pause planner and executor behind the Docker slot (U3.5)`.**

### Task 4: Composition point in the Docker slot (AC-3)

**Files:**

- Modify: `src/main/gc/docker-cycle.ts`
- Test: extend `tests/gc-docker-cycle.test.ts`

**Interfaces:**

- Produces:
  - `interface DockerPlanner { owns(kind: DockerAction['kind']): boolean; plan(): Promise<DockerAction[]>; execute(a: DockerAction): Promise<DockerOutcome> }`
  - `composeDockerPlanners(planners: readonly DockerPlanner[]): Pick<DockerCycleDeps, 'plan' | 'execute'>` — `plan` concatenates in array order (a planner that throws contributes nothing and is logged); `execute` routes by `owns(kind)`, and an action nobody owns is `{ ok: false, refusal: true }`.
  - The report-only notice body keeps its existing text and appends `Would pause: <id> (<reason>), …` for up to 5 `park` actions.

- [ ] **Step 1: Failing tests:** composition order and routing (a fake garbage planner first, a fake park planner second; both plans appear in order; `execute` reaches the owner only); a throwing planner does not hide the other's actions; report-only cycle with a park action acts on nothing (`execute` never called) and the notice lists the stack with its reason; after `firstReportAcknowledged` the cycle executes it; a park refusal increments `refused` and not `dockerStreak`; a `DOWN_FAILED`-style failure increments the streak and trips the kill switch at `failureLimit`; `pauseAutonomous` and `maxPerCycle` still hold.
- [ ] **Step 2: Run to verify failure; commit red.**
- [ ] **Step 3: Implement** `composeDockerPlanners` and the notice suffix. Do not change `runDockerCycle`'s flow or `DockerAction`.
- [ ] **Step 4: Verify pass; commit `feat(gc): the Docker slot composes planners and lists would-pause stacks in its report (U3.5)`.**

### Task 5: Shelve ignores a paused stack (AC-4)

**Files:**

- Modify: `src/main/gc/shelve-eligibility-core.ts`, `src/main/gc/shelve-cycle.ts`
- Test: extend `tests/gc-shelve-eligibility.test.ts`, `tests/gc-shelve-cycle.test.ts`

**Interfaces:**

- Produces: `ShelveContext.pausedStackIds?: readonly string[]` — `shelveCandidate` refuses `'stack'` only when `b.stackIds`/`b.sharedStackIds` hold an id that is not in `pausedStackIds`.

- [ ] **Step 1: Failing tests:** a bundle whose only stack id is in `pausedStackIds` is not refused `stack`; one running stack beside a paused one still is; no `pausedStackIds` behaves as today. In the cycle test: the paused registry reaches the context.
- [ ] **Step 2: Run to verify failure; commit red.**
- [ ] **Step 3: Implement.** `shelve-cycle.ts` gets a `pausedStackIds()` dep (default `[]`) and passes it into the context.
- [ ] **Step 4: Verify pass; commit `feat(gc): a worktree whose stack is Paused can be shelved (U3.5)`.**

### Task 6: Wiring (AC-3)

**Files:**

- Modify: `src/main/gc/gc-ipc.ts`
- Test: `tests/gc-ipc-surface.test.ts` stays green; a wiring test in `tests/gc-park-cycle.test.ts` is not possible without Electron, so the wiring is covered by Task 7's live run.

- [ ] **Step 1:** In the `docker:` slot replace the empty `plan` / refusing `execute` with `composeDockerPlanners([createParkPlanner({...})])`. Deps: `bundles: () => gatherer.cached()?.bundles ?? []`; `snapshot`/`journal` from `getContainersService()` (`scan()` for a fresh snapshot, `journal()`; null service → null); `activity` from `readStackActivity({ run: runDocker }, ...)` mapped to `value` or null; `paneUrls: listOpenPaneUrls`; `established` from `readEstablishedPorts` with real `execFile`; `pause: (d, a) => svc.pause(d, a)`; `activityLine: notify`. Also pass `pausedStackIds` to the shelve slot from `getContainersService()?.snapshot()?.paused`.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint`, then the unit tests of Tasks 1–5. Commit `feat(gc): wire the pause planner into the Docker slot (U3.5)`.

### Task 7: Docs and changelog (AC-7)

- [ ] `CHANGELOG.md` entry for 2026-11-05 under `### Added`; `docs/user/cleanup.md` and `docs/user/containers.md` explain when Cleanup pauses a stack (idle ≥ threshold, ≥ 30 min after last start, at most 6 per hour, first report must be acknowledged) and what protects one (a working session, `keep`/`neverClean`, CPU/IO activity, an open Harnu browser pane or connection on its ports, stacks that need a confirm). Check `tests/` doc-contract tests that name the pages. Run `npm run typecheck`, `npm run lint`, the full test suite and `npm run build`. Commit `docs: CHANGELOG and user pages for automatic pausing (U3.5)`.

### Task 8: Live verification on an isolated instance (AC-6)

- [ ] Follow `docs/dev/live-verify-second-instance.md` with `--user-data-dir=/tmp/harnu-verify-u35`. Throwaway compose fixtures `u35fixture-idle`, `u35fixture-busy` (CPU busy loop), `u35fixture-keep` (keep mark), `u35fixture-idle2` in `/tmp`, each attributed to a throwaway worktree. Lower `docker.idleHours` / `minAgeMinutes` via prefs. Record commands and output for the report: idle fixture listed by the report-only cycle, paused after acknowledging; busy and keep fixtures not paused; with `maxParksPerHour: 1` the second idle fixture waits. Touch only `u35fixture-*`; tear down only spawned PIDs and fixtures.

## Self-review

- Spec coverage: AC-1 → Task 1–2; AC-2 → Task 1; AC-3 → Tasks 3–4, 6; AC-4 → Task 5; AC-5 → Tasks 1, 3; AC-6 → Task 8; AC-7 → Task 7.
- Type consistency: `PauseDecision`, `PauseOutcome` (U3.4), `StackActivity` (U3.2), `DockerPlanner` (Task 4) are used with the names above in Tasks 3 and 6.
- Proportion: one test file per core, no function bodies in this plan beyond signatures.
