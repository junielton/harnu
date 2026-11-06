# U3.6 Capacity Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, one session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Docker capacity becomes a live concern: a watcher reads free bridge-network slots on a short trigger, acts at once below the low-water mark (garbage, then pauses), and notifies when nothing is left to free; the report-only first cycle records the LIST of what it would do.

**Architecture:** A pure core (`capacity-watcher-core.ts`) decides one pass and the notice ladder from injected facts. A thin shell (`capacity-watcher.ts`) schedules passes (Docker `events` for network create/destroy, debounced, plus a 30 s fallback interval) and serialises them. `gc-ipc.ts` wires the pass to the SAME composed Docker planners the hourly cycle uses (`dockerPlanners`, no second planner), the same machine-wide lock, the same failure-streak kill switch (`state.dockerStreak`). The result travels on a new `gc:docker:watch` push and in `GcSnapshot.dockerWatch`; the renderer turns `notice` into an Activity entry + push.

**Tech Stack:** TypeScript (main, Node), Vue 3 + Pinia + vue-i18n, vitest.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U3 "Capacity watcher", "Out of capacity", AC-U3b, AC-U3c, §5, §7 C1/C6/C11, §8 D-D, §10 (low-water **3**). Card: `T649` (AC-1..AC-8).

## Global Constraints

- Low-water mark = `prefs.docker.lowWaterSlots` (default **3**, field already exists). "Below the mark" acts when `free <= mark`; recovery is `free > mark`.
- Hourly pause cap + min age + idle floor still apply under pressure (design C7, orchestrator decision): the watcher never bypasses `planPauses`. Cap/min-age leaving capacity ≤ mark with an empty plan IS "nothing left to free".
- Capacity on Docker Desktop / rootless / remote / non-system socket reads `known:false` with a reason: no watcher action, no capacity notice. Garbage and pauses keep running on the hourly cycle.
- Docker switch off or global pause → the watcher acts on, and notifies about, nothing.
- Report-only first cycle: nothing runs; the LIST (kind network|orphan|pause, target, reason) is recorded.
- Machine-wide lock `dockerLockPath()`; per-pass cap `prefs.docker.maxPerCycle`; kill switch `prefs.docker.failureLimit` over `state.dockerStreak` (shared with the cycle).
- No volume is ever removed; no new docker mutation (garbage/park executors are reused as they are).
- English only in code/docs/commits; user-visible renderer strings through i18n in BOTH `en.json` and `pt-BR.json`. Main-process notice text is English like every other main `notify`.
- Every feature adds a `CHANGELOG.md` entry, `docs/user/` updates, `docs/harnu-features.md` bump (**v127**) and updates the tests that pin the marker. `design.md` §6 entry lands in its own commit BEFORE the UI commit.
- CPU: `nice -n 19 npx vitest run <files> --maxWorkers=10 --minWorkers=1`.

## Review Focus

- Capacity oscillating around the mark (3 → 4 → 3) must not renotify: pinned in Task 2 (`notice ladder: no repeat until above the mark`).
- Docker daemon goes away mid-pass: capacity read fails → treated as unknown, no action, no notice: Task 2.
- The `docker events` child dies or never starts: the fallback interval still drives passes; the reader restarts with back-off: Task 3.
- Two Harnu instances / the hourly cycle holding the lock: the pass records `locked` and does nothing, no notice: Task 2.
- Watcher passes overlapping themselves (event burst): serialised, one trailing pass: Task 3.

---

### Task 1: The report-only list and the truthful notice (cycle half of AC-5, AC-6)

**Files:**

- Modify: `src/main/gc/gc-wire.ts` (types), `src/main/gc/docker-cycle.ts`
- Test: `tests/gc-docker-report-list.test.ts` (new)

**Interfaces:**

- Produces (gc-wire.ts):
  - `type DockerReportKind = 'network' | 'orphan' | 'pause'`
  - `interface DockerReportItem { kind: DockerReportKind; target: string; reason: string }`
  - `DockerCycleRecord.items: DockerReportItem[]` (report mode: every found action, capped at `DOCKER_REPORT_ITEMS_MAX = 100`; otherwise `[]`)
- Produces (docker-cycle.ts): `reportItemsOf(actions: readonly DockerAction[]): DockerReportItem[]` (prune-network→network, remove-orphan→orphan, park→pause; target = `action.id`; reason = `action.reason`); `wouldDoText(actions)` replaces the stale clause.

- [ ] **Step 1: tests** — `report mode records the list`: three actions (one of each kind) in an unacknowledged cycle → `record.items` equals `[{kind:'network',target:'n1',reason:'r1'},{kind:'orphan',…},{kind:'pause',…}]`, `found: 3`, `acted: 0`; acknowledged cycle → `items: []`; more than 100 actions → `items.length === 100`, `found` the true count. `notice is truthful`: the report notice body matches `/remove empty networks and orphan stacks/i`, `/pause idle stacks/i`, `/No volume is ever removed/i` and does NOT match `/stacks paused, never removed with their volumes/`; a plan with only pauses names only pausing.
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement** `reportItemsOf`, the `items` field in `empty()` and in the report branch, and the notice body built from the kinds present ("`N` Docker items would be handled: `<empty networks and orphan stacks would be removed>` / `<idle stacks paused>`. No volume is ever removed. Open Settings → Cleanup to review and acknowledge." + the existing `Would pause:` suffix).
- [ ] **Step 4: run, expect PASS; also run `tests/gc-docker-*.test.ts` and fix assertions that pinned the old string** (only the string, never the behaviour assertions).
- [ ] **Step 5: commit** red (`test(gc): the report-only Docker cycle lists what it would do, failing (U3.6)`) then green (`feat(gc): …`).

### Task 2: The watcher core: one pass and the notice ladder (AC-1, AC-2, AC-3)

**Files:**

- Create: `src/main/gc/capacity-watcher-core.ts`
- Modify: `src/main/gc/gc-wire.ts` (wire types), `src/main/gc/gc-cycle.ts` (`CycleState.dockerCapacityNotice`, `dockerWatch`)
- Test: `tests/gc-capacity-watcher-core.test.ts` (new)

**Interfaces:**

- Produces (gc-wire.ts): `DockerCapacityView = { known: true; total; used; free; source: 'daemon.json'|'default' } | { known: false; reason: string }`; `DockerCapacityNotice = { level: 'low'|'zero'; free: number; total: number; mark: number }`; `DockerWatchRecord = { at; trigger: 'event'|'timer'|'boot'; mode: 'off'|'paused'|'report'|'act'; mark: number; capacity: DockerCapacityView | null; pressure: boolean; found; acted; refused; failed; deferred; locked: boolean; paused: boolean; pausedReason: string|null; nothingLeft: boolean; items: DockerReportItem[]; notice: DockerCapacityNotice | null }`; `GcSnapshot.dockerWatch: DockerWatchRecord | null`.
- Produces (core): `type NoticeState = 'none'|'low'|'zero'`; `nextCapacityNotice(prev: NoticeState, free: number, mark: number, nothingLeft: boolean): { next: NoticeState; level: 'low'|'zero'|null }`; `runCapacityPass(deps: CapacityPassDeps, state: CycleState, trigger): Promise<DockerWatchRecord>` with `CapacityPassDeps = { prefs(); readCapacity(): Promise<BridgeCapacityResult>; plan(): Promise<DockerAction[]>; execute(a): Promise<DockerOutcome>; lock; disableDocker(); notify(n); now() }` where `BridgeCapacityResult` is `readBridgeCapacity`'s `DockerFactsResult<BridgeCapacity>`.
- Consumes: `DockerAction`, `DockerOutcome`, `reportItemsOf` (Task 1), `CycleState`.

- [ ] **Step 1: tests (all with fakes, no docker)**
  - ladder: above mark → `{none,null}`; `3` nothing left → `low`; same again → no level; `4` (above) resets; `3` again → `low` again; `0` after `low` → `zero` once, again `0` → none; `1` after `zero` stays `zero` (no repeat); not nothingLeft → never a level.
  - `free > mark` → no plan call, no execute, record `pressure:false`.
  - `free <= mark`, acknowledged: garbage action then park action planned; capacity read after each; capacity rises above the mark after the first → the park action never executes (`execute` call log is exactly `[garbage]`), `acted: 1`.
  - runs garbage before pauses in plan order; stops at `maxPerCycle` with `deferred` counted and `nothingLeft:false`, no notice.
  - plan fully attempted (one refused, one failed) and still ≤ mark → `nothingLeft:true`, notice `low`; plan empty and free 0 → notice `zero` (one `notify` call per level, none on a repeat pass).
  - failure streak: `failureLimit` failures → `disableDocker` called, `paused:true`, `pausedReason`, notice still raised once for the capacity (nothing left Harnu may free).
  - report-only (`firstReportAcknowledged:false`): nothing executes, `mode:'report'`, `items` lists the actions, no notice when items exist; empty plan → notice.
  - `pauseAutonomous` → `mode:'paused'`, `readCapacity` not called; `docker.enabled:false` → `mode:'off'`, same.
  - `readCapacity` → `{known:false,reason}` → record `capacity:{known:false,reason}`, no plan/execute/notice; `{ok:false}` (docker down) → `capacity:{known:false, reason:'Docker is not reachable.'}`, same; a later known reading does not see a stale notice state reset by the unknown one.
  - lock held (`{ok:false}`) → `locked:true`, nothing executed, no notice.
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement** the core as specified; the pass reads capacity BEFORE taking the lock (cheap, read-only), takes `deps.lock` only under pressure, re-reads capacity after every action, calls `deps.notify({title:'Workspace cleanup', body})` for the OS notice with the free/total/mark in the body ("Docker is nearly out of network slots: 3 of 31 free and Harnu has nothing left to free automatically …" / "… no free slot left …"), and fills `notice` for the renderer. Notice state lives in `state.dockerCapacityNotice`; `state.dockerWatch` keeps the last record.
- [ ] **Step 4: run, expect PASS.**
- [ ] **Step 5: commit** red then green (`feat(gc): the capacity watcher pass and its out-of-capacity ladder (U3.6)`).

### Task 3: Triggers: the `docker events` reader and the watcher shell (AC-1)

**Files:**

- Modify: `src/main/containers/docker-facts-shell.ts` (events reader only)
- Create: `src/main/gc/capacity-watcher.ts`
- Test: `tests/docker-facts-events.test.ts`, `tests/gc-capacity-watcher-shell.test.ts` (new)

**Interfaces:**

- Produces (facts shell): `watchNetworkEvents(deps: { spawn: EventsSpawn; setTimeout/clearTimeout? }, onEvent: (e: { action: 'create'|'destroy'; id: string }) => void): { stop(): void }` where `EventsSpawn = (args: readonly string[]) => { onLine(cb): void; onExit(cb): void; kill(): void }`. Args are exactly `['events','--filter','type=network','--filter','event=create','--filter','event=destroy','--format','{{json .}}']`; restarts after exit with back-off 5 s → 60 s; ignores unparsable lines.
- Produces (watcher shell): `createCapacityWatcher(deps: { pass(trigger): Promise<void>; subscribe(onEvent): { stop(): void }; intervalMs: number (30_000); debounceMs: number (1_500); timers }): { start(): void; stop(): void; poke(trigger?): void }`. Passes never overlap; a request during a pass schedules exactly one trailing pass; an event burst inside the debounce window is one pass.

- [ ] **Step 1: tests** — events: argv equals the list above and contains no mutating verb; JSON lines yield events, junk is skipped; exit restarts after 5 s, a second fast exit waits 10 s; `stop()` kills and never restarts. Shell: boot pass on `start`; interval fires passes every `intervalMs` (fake timers); 5 events within 1 s → one pass after the debounce; event during a running pass → one trailing pass; `stop()` clears timers and the subscription; a rejecting `pass` never kills the loop.
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement both.** Production `spawn` is built in Task 4 with `child_process.spawn('docker', args, { env: await spawnEnvOnce(), windowsHide: true })`.
- [ ] **Step 4: run, expect PASS.**
- [ ] **Step 5: commit** red then green.

### Task 4: Wire it: pass, push, snapshot, preload (AC-1, AC-3, AC-5 watcher half)

**Files:**

- Modify: `src/main/gc/gc-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/stores/gc.ts` (subscription + state only)
- Test: `tests/gc-capacity-watcher-wiring.test.ts` (new); update `tests/gc-docker-wiring.test.ts` only if an assertion contradicts the new truth

**Interfaces:**

- Consumes: `dockerPlanners.plan/execute` (the single composed instance, not a second planner), `readBridgeCapacity({ run: runDocker })`, `withLockFile(dockerLockPath(), …)`, `persist(withDockerDisabled(prefs))`, `notify`.
- Produces: push `gc:docker:watch` (payload `DockerWatchRecord`, sent only when the record changes besides `at`/`trigger`); `window.api.onGcDockerWatch(cb)`; `GcSnapshot.dockerWatch`; the watcher starts in `registerGcHandlers` and stops on `app` `before-quit`.

- [ ] **Step 1: wiring test** — source-level assertions as the existing wiring tests: `gc-ipc.ts` calls `runCapacityPass`, `readBridgeCapacity`, `watchNetworkEvents`, `...dockerPlanners` is the only planner composition (`createParkPlanner(` appears once), the pass uses `dockerLockPath()`, `send('gc:docker:watch'`, `before-quit`; preload exposes `onGcDockerWatch`; the snapshot builder includes `dockerWatch`.
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement the wiring.** Emit only on change; `snapshot.dockerWatch = state.dockerWatch`.
- [ ] **Step 4: run, expect PASS; typecheck.**
- [ ] **Step 5: commit** red then green.

### Task 5: `design.md` §6 (own commit, before any UI)

**Files:** Modify `design.md` §6.

- [ ] **Step 1:** add (a) "Out-of-capacity Activity notification" (two levels `low`/`zero`, kind `warning`, title/description copy in the §8 voice, click target Settings → Cleanup, no sound/toast, one per level until recovery, push as `needs-input`), (b) "Docker first-report list" in Settings → Cleanup → Docker (a compact list under the report-only line: one row per item with a kind chip Network / Orphan / Pause, the target in mono, the reason as the muted second line, `+N more` after 8 rows; only while `!firstReportAcknowledged`). Tokens already exist; no new color/size.
- [ ] **Step 2: commit** `docs(design): out-of-capacity notification and the Docker first-report list (U3.6)`.

### Task 6: Renderer: Activity notification, push and the acknowledgement list (AC-2, AC-5, AC-6)

**Files:**

- Modify: `src/renderer/src/stores/gc.ts`, `src/renderer/src/components/CleanupSettingsPane.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`
- Test: `tests/gc-docker-watch-store.test.ts`, `tests/cleanup-settings-docker-report.test.ts` (new)

**Interfaces:**

- Produces (store): `dockerWatch` ref; `dockerReportItems` computed = items of the newest record in report mode among `snapshot.lastCycle.docker` and `dockerWatch`; `recordCapacityNotice(notice)` → `useNotificationsStore().notify({ source:'app', kind:'warning', title, description, target:{view:'settings', tab:'cleanup'} })` using i18n keys `cleanup.gc.docker.capacity.{low,zero}.{title,body}`, and `window.api.pushSend({ kind:'needs-input', title, body })`. Called once per `notice` in a pushed record (never from a snapshot refresh).
- Pane: list under the report-only paragraph, `data-testid="gc-docker-report-list"`, rows `gc-docker-report-item`.

- [ ] **Step 1: tests** — store: a pushed record with `notice` → exactly one Activity entry and one `pushSend`; a record without `notice`, or a snapshot refresh carrying the same record → none; `dockerReportItems` picks the newer report record, is `[]` once acknowledged. Pane: report-only state renders one row per item with kind label and target and `+N more` beyond 8; acknowledged state renders none. i18n parity (existing parity test covers both files).
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement.** Reuse existing tokens/components only.
- [ ] **Step 4: run, expect PASS; `npm run typecheck`.**
- [ ] **Step 5: commit** red then green.

### Task 7: Docs, contracts, marker (AC-4, AC-8)

**Files:** `docs/harnu-features.md` (v127), `CHANGELOG.md`, `docs/user/cleanup.md`, `docs/user/containers.md`, tests pinning the marker (`harnu-features-prefs`, `containers-autopilot-actor`, `gc-shelve-docs`, `park-docs`), new `tests/capacity-watcher-docs.test.ts`.

- [ ] **Step 1: tests** — features doc first line `v127`; contains `could not find an available, non-overlapping IPv4 address pool`, `port is already allocated` and `mission_set_blocker` with `owner: 'operator'` in the Docker capacity paragraph; user docs name the watcher, the low-water mark (3), the notification and the hourly cap staying in force; CHANGELOG entry exists.
- [ ] **Step 2: run, expect FAIL.** **Step 3: write the docs** (agent-facing paragraph: the notice is for the operator; a session whose `compose up` fails on address pools/ports raises the blocker and stops; it does not retry or free capacity itself). **Step 4: PASS** (and update the four pinned tests to v127). **Step 5: commit.**

### Task 8: Gates and live check (AC-7, AC-8)

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, full vitest at 10 workers, `npm run build`, the CI gate scripts (`scripts/ci/*-gate.mjs`).
- [ ] AC-7 on a throwaway `docker:dind` named `u36fixture-dind` driven by an isolated instance (`--user-data-dir=/tmp/harnu-verify-u36`); the daemon's socket is bind-mounted over `/var/run/docker.sock` inside a private user+mount namespace so the instance sees a native-looking system socket and the real daemon is never reachable. Screenshot of the acknowledgement list under `.harnu/out/u36/`. Tear everything down.
- [ ] `.harnu/REPORT.md`, commit, push, SendMessage to the owner.

## Self-review

- AC-1 → Tasks 2, 3, 4; AC-2 → Tasks 2, 6; AC-3 → Task 2 (+ Task 4 wiring); AC-4 → Task 7; AC-5 → Tasks 1, 2, 4, 6; AC-6 → Task 1; AC-7 → Task 8; AC-8 → Tasks 5, 7, 8.
- Names: `DockerReportItem`, `DockerWatchRecord`, `DockerCapacityNotice`, `nextCapacityNotice`, `runCapacityPass`, `watchNetworkEvents`, `createCapacityWatcher`, `gc:docker:watch`, `onGcDockerWatch`, `dockerWatch` are used identically across tasks.
