# U3.3 Docker garbage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill U3.1's Docker cycle slot with the garbage planner and executor: empty compose networks and orphan stacks are removed automatically (after the report-only first cycle), and no volume is ever removed.

**Architecture:** A pure planner (`docker-garbage-core.ts`) turns U3.2's `EmptyNetworkPlan` plus the containers scan's stack verdicts plus the shelved-worktree paths into a garbage plan and into `DockerAction`s. A shell (`docker-garbage-shell.ts`) binds the planner's facts, re-probes each target right before acting, and acts only through three injected mutators: `docker stop`, `docker rm` (never forced, never `-v`) and `docker network rm`. Orphan stacks go through the existing `runContainersAction` (`stop`, then `remove` with `removeVolumes: false`) under actor `autopilot`, so the tier table is enforced a second time and the journal is the existing one. `docker-cycle.ts` is unchanged except for the optional wiring in `gc-ipc.ts`; the report-only branch, cap, pause and kill switch already live there.

**Tech Stack:** TypeScript, vitest, Electron main process (no renderer change).

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §3, §4 U3 "Garbage", §5, §7 C1/C3/C5/C8, §10 A-1. Card: `T646`.

## Global Constraints

- English only in code, comments, docs, commits; Conventional Commits with a `(U3.3)` suffix.
- No volume is ever removed: no `docker volume rm`, no `-v`/`--volumes`, no `prune`, no `--force`/`-f` on a mutation.
- Journal actor for every automatic action is `autopilot`.
- A fact that is missing is never a deletion: unreadable shelved store, unresolved compose config, unavailable scan all plan nothing for the affected part.
- `held` networks are reported with their reason and never removed.
- CPU: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- CHANGELOG entry, `docs/user/` pages and `docs/harnu-features.md` (marker bump) updated in the same change.

## Review Focus

- A shelved worktree's stack looks like an orphan (its folder is gone on purpose): must be excluded, and an unreadable shelved store must exclude every orphan.
- A container attaches to an empty network (or a stack gains a container) between plan and act: refusal "changed since decided", nothing removed.
- A running orphan: stop (graceful), then remove; if the stop fails nothing is removed and it counts as a failure.
- A network that is `held` (external / externals unresolved) next to a garbage one: only the garbage one is planned.
- Docker unavailable while planning: plans nothing, is not a failure and does not trip the kill switch.

---

### Task 1: Journal fields for the reason and the kept-volume owner

**Files:**

- Modify: `src/main/containers/containers-wire.ts` (`Tombstone`, `TombstoneStack`)
- Modify: `src/main/containers/containers-journal.ts` (`isTombstoneStack`, `isTombstone`)
- Test: `tests/docker-garbage-journal.test.ts`

**Interfaces:**

- Produces: `Tombstone.reason?: string` (the Activity sentence, English); `TombstoneStack.keptVolumeOwner?: { reason: 'worktree-removed'; project: string | null; worktreePath: string | null }`.

- [ ] **Step 1: Write the failing tests** — `parseJournal` keeps a line carrying `reason` and `keptVolumeOwner`; a line with `reason: 5` or a malformed `keptVolumeOwner` is skipped; a line without either still parses (old journal lines).
- [ ] **Step 2: Run, expect FAIL** (malformed lines currently accepted).
- [ ] **Step 3: Add the two optional fields to the wire types and validate them in the journal guards** (absent or well-typed).
- [ ] **Step 4: Run, expect PASS**. Commit test (red) then implementation.

### Task 2: Pure garbage planner

**Files:**

- Create: `src/main/gc/docker-garbage-core.ts`
- Test: `tests/docker-garbage-core.test.ts`

**Interfaces:**

- Consumes: `EmptyNetworkPlan`, `DockerNetworkFact` (`docker-networks-core`), `StackRow` (`containers-wire`), `DockerAction` (`docker-cycle`), `isShelvedFolder`-style containment (`canonicalPathKey`, `isInside`).
- Produces:
  - `planDockerGarbage(input: { networks: EmptyNetworkPlan; stacks: readonly StackRow[]; shelvedPaths: readonly string[] | null; platform?: string }): GarbagePlan` — `shelvedPaths: null` means the store was unreadable: no orphan is planned.
  - `GarbagePlan = { networks: GarbageNetwork[]; stacks: GarbageStack[]; held: { network: DockerNetworkFact; reason: HeldReason }[]; excluded: { stack: string; why: 'shelved' | 'store-unreadable' }[] }`.
  - `GarbageNetwork = { id; name; project: string | null; reason }`; `GarbageStack = { stack; name; project; kind; containerIds: string[]; worktreePath: string | null; volumes: string[]; reason }`.
  - `garbageActions(plan): DockerAction[]` — networks first (`kind: 'prune-network'`, `id: net:<id>`), then stacks (`kind: 'remove-orphan'`, `id: stack:<stack id>`), each in deterministic order.
  - `orphanChangedSince(target: GarbageStack, fresh: StackRow | undefined, shelvedPaths: readonly string[] | null): string | null` — the refusal sentence ("changed since decided: …") or null.
  - `networkReasonLine(name)` / `orphanReasonLine(project, volumes)` — the Activity sentences: ``Removed empty network `x` — no containers`` and ``Removed orphan stack `p` — worktree gone, volumes kept: a, b`` (`volumes kept: none` when it has none).

- [ ] **Step 1: Write the failing tests**, one per exclusion: stack verdict `unknown`, `protected`, `active`, `pending`, `zombie` never planned; an `orphan` stack whose `attribution.path` (or `folderPath`) lies inside a shelved worktree is `excluded: shelved`; `shelvedPaths: null` excludes every orphan with `store-unreadable`; `held` networks are echoed with their reason and absent from `networks`; an orphan is planned with its container ids, project and volume names; `garbageActions` order and ids; `orphanChangedSince` returns a sentence for a changed verdict, a new container id, a now-shelved path, a vanished stack (null stack → "gone" is NOT a refusal, it is already clean: returns `'gone'` handled by the caller), and null when containers only shrank.
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement the functions above.** Containment uses the same canonical key as `shelve-store.isShelvedFolder`.
- [ ] **Step 4: Run, expect PASS**. Commit red then green.

### Task 3: `network rm` helper

**Files:**

- Modify: `src/main/containers/containers-shell.ts` (`dockerActions.removeNetwork(id: string): Promise<{ ok: true } | { ok: false; error: string; active: boolean }>`)
- Test: `tests/containers-shell.test.ts` (extend the fake-docker suite)

- [ ] **Step 1: Failing test** against the fake docker: `removeNetwork('abc123')` runs exactly `network rm abc123` (logged argv) and returns `{ ok: true }`; a failing fake returns `ok:false` with `active: true` when stderr says `has active endpoints`; an id that is not a plain word (`-f`, `a b`) is refused without running docker.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** with the same safe-ref regexp as `gc-stack-leftovers`. **Step 4: PASS.** Commit red then green.

### Task 4: The shell — plan and execute

**Files:**

- Create: `src/main/gc/docker-garbage-shell.ts`
- Test: `tests/docker-garbage-shell.test.ts`

**Interfaces:**

- Consumes: Task 2 exports; `readEmptyComposeNetworks(FactsDeps)`; `runContainersAction` + `ActionDeps`; `Tombstone`.
- Produces: `createDockerGarbage(deps: GarbageDeps): { plan(): Promise<DockerAction[]>; execute(a: DockerAction): Promise<DockerOutcome> }` with
  `GarbageDeps = { facts: FactsDeps; scan(): Promise<ContainersSnapshot>; shelvedPaths(): Promise<readonly string[]>; mutators: { stop(ids): Promise<DockerBatchResult>; removeContainers(ids): Promise<DockerBatchResult>; removeNetwork(id): Promise<…> }; appendTombstone(t: Tombstone): Promise<void>; now(): number }`.

Behavior: `plan()` reads networks, scan and shelved paths (a facts failure or unavailable scan plans nothing for that part, never throws), binds the plan in a map keyed by action id. `execute()`:

- unknown id → refusal "not part of this plan".
- network: re-run `readEmptyComposeNetworks`; id absent from `garbage` → refusal "changed since decided: …"; docker unavailable → refusal; else `removeNetwork`; `active` error → refusal; other error → failure; success → one tombstone (`verb: 'remove'`, `stacks: []`, `actor: 'autopilot'`, `reason`, `restoreHint: null`).
- orphan: fresh `scan()`; `orphanChangedSince` refuses; stack gone → success with nothing journaled; if running → `runContainersAction({verb:'stop',stacks:[id]}, 'autopilot')`; a failed stop → failure; then `runContainersAction({verb:'remove',stack:id,removeVolumes:false}, 'autopilot')`. The `ActionDeps.appendTombstone` wrapper adds `reason` and `keptVolumeOwner` to the remove tombstone. `removeVolumes` dep always returns an error and is never reachable.

- [ ] **Step 1: Failing tests (fake mutators recording every call):** each exclusion path of `execute` (changed network, held-after-reprobe, changed stack, new container, shelved after plan, stop failure → failure, `has active endpoints` → refusal); success paths (network journaled with the AC-5 sentence and actor `autopilot`; running orphan: stop then remove, two tombstones, remove one carries `keptVolumes`, `keptVolumeOwner{project,worktreePath}`, reason line, `restoreHint` null); AC-4: across all scenarios the mutators never receive anything but container ids and network ids, `removeVolumes` of the action deps is never called, and the source files contain none of `volume rm`, `prune`, `--volumes`, `--force`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: PASS.** Commit red then green.

### Task 5: Wire the slot and prove the cycle contract

**Files:**

- Modify: `src/main/gc/gc-ipc.ts` (replace the empty `plan`/`execute` in the `docker:` slot; build `createDockerGarbage` once with real deps)
- Test: `tests/docker-garbage-cycle.test.ts`

- [ ] **Step 1: Failing test:** `runDockerCycle` with the garbage `plan`/`execute` over fakes — report-only first cycle records the plan and executes nothing; after acknowledgement it executes and journals with actor `autopilot`; the global pause acts on nothing; `maxPerCycle` defers the rest; `failureLimit` failures in a row disable the slot (refusals do not); a source-text test asserts `gc-ipc.ts` no longer contains `not implemented yet` and passes `dockerActions` mutators.
- [ ] **Step 2: FAIL. Step 3: wire** (`scanContainers` with the containers journal, `readShelvedForUpdate` for shelved paths so a corrupt store throws and plans no orphans, `dockerActions`, `appendTombstone` of the containers journal). **Step 4: PASS.** Commit.

### Task 6: Docs and contracts

**Files:** `CHANGELOG.md`, `docs/user/cleanup.md`, `docs/user/containers.md`, `docs/harnu-features.md` (marker bump: `list_containers` `recent[]` lines now carry `reason` and `stacks[].keptVolumeOwner`), `design.md` untouched (no UI).

- [ ] Write the entries; run `npm run typecheck`, `npm run lint`, the focused vitest files, the full suite and `npm run build`; commit.

### Task 7: AC-6 live verification and report

- [ ] On an isolated instance (`--user-data-dir=/tmp/harnu-verify-u33`, per `docs/dev/live-verify-second-instance.md`) with fixture objects named `u33fixture-*` only: create 2 empty compose-labelled networks and 1 orphan stack (throwaway repo + worktree in `/tmp`, `compose up` with a named volume, then delete the worktree folder); first cycle reports 3, acknowledge, all 3 cleared, `docker volume ls` before = after; also paste the report-only plan for the rest of the machine (not acknowledged). Clean the fixture (volume by hand). Write `.harnu/REPORT.md` and message the owner.
