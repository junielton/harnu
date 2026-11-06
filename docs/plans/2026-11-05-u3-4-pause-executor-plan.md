# U3.4 Pause executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring a compose stack down without touching its volumes, journal everything needed to bring it back (a working `compose up -d` command), remember paused stacks durably, and fix the wrong `docker start` restore hint.

**Architecture:** A pure `park-core.ts` (compose-config parsing, restore facts, confirm-only rules, `pauseStack` orchestration over injected deps) and a thin `park-shell.ts` (real `docker`/`docker compose` calls). A pause is journaled as a `stop` tombstone (no new verb, so the MCP verb parity stays intact) whose stack entry carries a `paused` record. The paused registry is **derived from the journal** (newest `paused` tombstone per stack, dropped when any later tombstone touches the stack or when the project has containers again), so there is no second file to drift. The snapshot gains a top-level `paused` list; the verdict table is untouched, so a stack with no containers is never classified.

**Tech Stack:** TypeScript (Electron main), Vue 3 + Tailwind renderer, vitest.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §2, §4 U3 "Park" + "Correct restore hint", AC-U3d, §5, §7 C5/C7, §10 Amendments (A-2 "Paused"/"Pausada"). Risks: `docs/studies/2026-10-27-autonomous-cleanup-risks.md` 8, 9, 12.

## Global Constraints

- `compose down` never gets `-v`/`--volumes` and never `--rmi`; docker never sees `--force`.
- UI says **"Paused"** (pt-BR **"Pausada"**); code, journal and docs keep "park" (A-2). Never the word "parked" in a UI string.
- Journal entries written by the executor use `actor: 'autopilot'` when Harnu acts on its own (U3.1 made it legal); the actor is a parameter, never read from a request.
- Every new i18n key goes in BOTH `en.json` and `pt-BR.json`; `design.md` §6 is edited before the component.
- CHANGELOG entry, `docs/user/` pages and `docs/harnu-features.md` (marker v123 → v124) in the same change.
- English only. CPU budget: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.

## Review Focus

1. A compose file that cannot be read by `docker compose config` (missing env var, broken YAML): the pause must refuse **before** `down`, because no correct restore command can be built.
2. A stack whose containers changed between decision and action (one added, one gone, verdict flipped to `active`): refuse "changed since decided", `down` never runs.
3. A database container with its data on an anonymous volume, or with no mount on the image's data path: `confirm-required`, never paused.
4. Paths with spaces or quotes in the working dir, compose files or env file: the restore command stays pasteable (shell-quoted).
5. A journal write failing after `down` succeeded: the result is a failure that still carries the restore command, never silent.

---

### Task 1: The compose restore command and the corrected hints

**Files:**

- Modify: `src/main/containers/containers-wire.ts` (add `ComposeRestoreFacts`)
- Modify: `src/main/containers/containers-journal.ts` (`composeUpCommand`, `restoreHintForStop`, `restoreHintForRemove`)
- Modify: `src/main/containers/containers-actions.ts` (`restoreHint()` passes compose facts; optional `restoreFacts` dep)
- Modify: `src/main/containers/containers-core.ts` (`StackRow.compose` built from the container labels)
- Test: `tests/containers-journal.test.ts`, `tests/containers-actions.test.ts`, `tests/containers-core.test.ts`

**Interfaces:**

- Produces: `ComposeRestoreFacts = { project: string; workingDir: string; configFiles: string[]; profiles: string[]; envFile: string | null; hasBuild: boolean }`
- Produces: `composeUpCommand(f: ComposeRestoreFacts): string` →
  `docker compose -p P --project-directory WD [-f F]… [--profile X]… [--env-file E] up -d [--build]`
- Produces: `restoreHintForStop(stack: { kind; compose: ComposeRestoreFacts | null }, containerIds: readonly string[]): string | null` — compose stack → `composeUpCommand`, or null when its facts are unknown (never `docker start`); standalone container → `docker start <ids>`.
- Produces: `restoreHintForRemove` takes the same facts plus `worktreeExists`, returns `composeUpCommand` or null.
- Produces: `StackRow.compose: { workingDir: string | null; configFiles: string[]; envFile: string | null } | null` (labels `com.docker.compose.project.working_dir`, `…config_files` comma-split, `…environment_file`).
- Produces: `ActionDeps.restoreFacts?(stack: StackRow): Promise<ComposeRestoreFacts | null>` (optional; absent → labels only, profiles `[]`, `hasBuild` false).

- [ ] **Step 1: Write failing tests.** `composeUpCommand`: image-only (`docker compose -p proj --project-directory /w up -d`), build fixture (`… up -d --build`), multi-file (`-f /w/a.yml -f /w/b.yml` in order), profile (`--profile web`), env file (`--env-file /w/.env.x`), a path with a space and a quote (single-quoted). `restoreHintForStop`: compose → full command and the string never contains `docker start`; standalone → `docker start`; compose without facts → null. `restoreHintForRemove` keeps null for gone worktree. `containers-core`: a compose container's labels yield `StackRow.compose`. `containers-actions`: a `stop` of a compose stack journals the compose command; with a `restoreFacts` dep the profile/`--build` appear.
- [ ] **Step 2: Run, verify fail** (`composeUpCommand` not exported).
- [ ] **Step 3: Implement** the signatures above; `shellQuote` for every path/name; order is fixed as in the Interfaces line.
- [ ] **Step 4: Run, verify pass; fix the existing `restoreHintFor*` tests that pinned `docker start` for compose stacks (assertion changes to the new, correct value — the old value was the bug).**
- [ ] **Step 5: Commit** red (`test(containers): ... (U3.4)`) then green (`feat(containers): ... (U3.4)`).

### Task 2: Pause rules — compose config, confirm-only, pausable verdicts (pure)

**Files:**

- Create: `src/main/containers/park-core.ts`
- Modify: `src/main/containers/containers-core.ts` (`MountFact.destination`, parsed from `Mounts[].Destination`)
- Test: `tests/park-core.test.ts`

**Interfaces:**

- Produces: `parseComposeConfig(stdout: string): ComposeServices | null` where `ComposeServices = Record<string, { profiles: string[]; build: boolean }>` (from `docker compose config --format json`, `null` on malformed).
- Produces: `composeFactsFor(args: { project; workingDir; configFiles; envFile; services: ComposeServices; runningServices: readonly string[] }): ComposeRestoreFacts` — `profiles` = union of the profiles of services that have a container; `hasBuild` = any service in the restored set (no profile, or an active profile) with `build`.
- Produces: `DATABASE_IMAGES` (single list: postgres, postgresql, mysql, mariadb, mongo, mongodb, redis, elasticsearch, opensearch, rabbitmq → their data paths, including the common `bitnami` layouts).
- Produces: `confirmOnlyReason(containers: readonly InspectedContainer[]): string | null` — anonymous volume (64-hex volume name) or a database image with no mount whose destination is, or contains, one of its data paths.
- Produces: `isPausableVerdict(v: Verdict): boolean` — only `zombie` and `pending` (`unknown`, `protected`, `active`, `orphan` refuse; `orphan` because the working dir is gone and `compose down` needs it).
- Produces: `pauseDownArgs(facts: ComposeRestoreFacts): string[]` → `['compose','-p',P,'--project-directory',WD,...('-f',F),'down']` — never `-v`, `--volumes`, `--rmi`.

- [ ] **Step 1: Write failing tests**: `parseComposeConfig` (profiles, build present/absent, malformed → null); `composeFactsFor` (profile union, `build:` only counts when its service is in the restored set); `confirmOnlyReason` for postgres with and without `/var/lib/postgresql/data` mount, a bind-mounted data dir (ok), redis `/data`, an anonymous volume on a plain `nginx` (confirm), a non-database image with no volumes (null), image spellings (`docker.io/library/postgres:16`, `bitnami/postgresql@sha256:…`); `pauseDownArgs` exact argv and a `not.toContain` for the forbidden flags.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** in `park-core.ts` (image name = last path segment before `:`/`@`).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** red/green.

### Task 3: `pauseStack` — re-probe, config, down, journal

**Files:**

- Modify: `src/main/containers/park-core.ts`
- Modify: `src/main/containers/containers-wire.ts` (`PausedRecord`, `TombstoneStack.paused?`)
- Modify: `src/main/containers/containers-journal.ts` (`isTombstoneStack` accepts `paused`)
- Test: `tests/park-core.test.ts`, `tests/containers-journal.test.ts`

**Interfaces:**

- Produces: `PausedRecord = ComposeRestoreFacts & { ports: number[]; restoreCommand: string; pausedAt: number }`.
- Produces: `PauseDecision = { stack: string; containerIds: string[]; verdict: Verdict }`.
- Produces: `PauseDeps = { scan(): Promise<ContainersSnapshot>; run(args: readonly string[]): Promise<{ stdout: string }>; appendTombstone(t: Tombstone): Promise<void>; now(): number }`.
- Produces: `PauseOutcome = { ok: true; outcome: 'paused'; record: PausedRecord; tombstone: Tombstone } | { ok: false; outcome: 'refused' | 'confirm-required' | 'failed'; code: PauseCode; message: string; record?: PausedRecord }`; `PauseCode = 'DOCKER_UNAVAILABLE' | 'STACK_NOT_FOUND' | 'NOT_COMPOSE' | 'CHANGED_SINCE_DECIDED' | 'NOT_PAUSABLE' | 'CONFIRM_ONLY' | 'CONFIG_UNREADABLE' | 'DOWN_FAILED' | 'JOURNAL_FAILED'`.
- Produces: `pauseStack(decision: PauseDecision, actor: Actor, deps: PauseDeps): Promise<PauseOutcome>`.
- Order inside: scan → find stack (compose kind) → same container ids as decided → same verdict as decided → `isPausableVerdict` → strict `docker inspect <ids>` → `confirmOnlyReason` → `docker compose … config --format json --profile '*'` → `composeFactsFor` → `down` → append a `stop` tombstone (`containerIds` = the ids, `freed.ports`, `keptVolumes` = every volume name, `paused: record`, `restoreHint: record.restoreCommand`).

- [ ] **Step 1: Write failing tests** with a fake `run` recording argv: happy path asserts the exact `down` argv and tombstone shape (image-only fixture and `build:` fixture); container list differs → `CHANGED_SINCE_DECIDED` and no `down`; verdict `protected`/`unknown`/`active`/`orphan` → refused; stack gone → `STACK_NOT_FOUND`; postgres without data mount → `confirm-required` + `CONFIRM_ONLY` and no `down`; config fails → `CONFIG_UNREADABLE`, no `down`; `down` fails → `failed`, no tombstone; `appendTombstone` rejects → `JOURNAL_FAILED` with `record` present. Journal test: a tombstone with `paused` round-trips `parseJournal`; a malformed `paused` is rejected.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** No `-v`, no `--rmi`; errors summarised with `summarizeDockerError`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** red/green.

### Task 4: The paused registry and the snapshot

**Files:**

- Modify: `src/main/containers/park-core.ts` (`derivePaused`)
- Modify: `src/main/containers/containers-wire.ts` (`PausedStack`, `ContainersSnapshotAvailable.paused`)
- Modify: `src/main/containers/containers-core.ts` (`ScanInput.paused`, `buildSnapshot`)
- Modify: `src/main/containers/containers-shell.ts` (feed `derivePaused(req.journal, containers)`)
- Test: `tests/park-core.test.ts`, `tests/containers-core.test.ts`

**Interfaces:**

- Produces: `PausedStack = PausedRecord & { stack: string; name: string; actor: Actor }`.
- Produces: `derivePaused(journal: readonly Tombstone[], liveProjects: ReadonlySet<string>): PausedStack[]` — newest first; a stack is paused when its newest tombstone entry carries `paused` and its project has no containers; any later tombstone for the same stack id (start/stop/remove/sweep) ends the pause.

- [ ] **Step 1: Write failing tests**: pause survives (derived from a journal read cold); ended by a later `start`/`remove` tombstone; ended when the project has containers again; two pauses of the same project → one entry; the snapshot has `paused` and `stacks` contains no row for it (no zombie/orphan verdict); `unavailableSnapshot` unchanged.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** red/green.

### Task 5: The shell and the service seam

**Files:**

- Create: `src/main/containers/park-shell.ts` (`runCompose`, `pauseDeps`, `readRestoreFacts`)
- Modify: `src/main/containers/containers-shell.ts` (export a compose-capable `runDocker` reuse; `restoreFacts` for stop/remove)
- Modify: `src/main/containers/containers-ipc.ts` (`ContainersService.pause(decision, actor)`, serialized on the same `actChain`, refreshes the snapshot)
- Test: `tests/containers-ipc.test.ts`, `tests/containers-shell.test.ts`

**Interfaces:**

- Consumes: `pauseStack`, `PauseDeps`, `dockerActions`.
- Produces: `ContainersService.pause(decision: PauseDecision, actor: Actor): Promise<PauseOutcome>`.
- Produces: `readRestoreFacts(stack: StackRow): Promise<ComposeRestoreFacts | null>` (`docker compose … config --format json --profile '*'`, null on failure).

- [ ] **Step 1: Write failing tests**: `pause` runs on the action chain (an in-flight `act` finishes first), takes a fresh scan, pushes a refreshed snapshot, and a `stop` through `act` journals the compose command using `restoreFacts`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** with `ACT_OPTS`-style timeouts (a `down` waits out grace periods).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** red/green.

### Task 6: `list_containers` and the agent doc

**Files:**

- Modify: `src/main/mcp/containers-listing.ts` (`paused` list, paths redacted to `<alias>`)
- Modify: `docs/harnu-features.md` (paused flag + restore command; marker v123 → v124)
- Test: `tests/mcp-containers-listing.test.ts`, the awareness marker pins

**Interfaces:**

- Produces: `ContainersListing.paused: { id, name, pausedAt, actor, ports, project, hasBuild, restoreCommand }[]` (no absolute paths; `restoreCommand` has directory, compose files and env file shown as `<alias>`), scoped like `stacks`.

- [ ] **Step 1: Write failing tests** (redaction incl. a quoted path, scope filtering, an empty list when none).
- [ ] **Step 2: Run, verify fail.** **Step 3: Implement.** **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** red/green.

### Task 7: The "Paused" label in the Containers takeover

**Files:**

- Modify: `design.md` §6 (first, own commit)
- Modify: `src/renderer/src/components/ContainersView.vue`, `ContainersDetail.vue`, `containers-format.ts`, the containers store
- Modify: `src/renderer/src/i18n/en.json`, `pt-BR.json`
- Test: `tests/containers-view.test.ts`, `tests/containers-format.test.ts`

**Interfaces:**

- Consumes: `ContainersSnapshotAvailable.paused` through the existing preload types.
- Produces: a "Paused" section under the stack list: name, "Paused 3h ago", the freed ports, the restore command with a copy button. No action buttons (the command is the restore, C5).

- [ ] **Step 1: `design.md` §6 edit, commit.** **Step 2: failing view/format tests** (section renders only when `paused` is non-empty; label is `containers.paused.*`, both locales present). **Step 3: implement.** **Step 4: run, then screenshot on an isolated instance under `.harnu/out/u34/`.** **Step 5: commit** red/green.

### Task 8: Docs, live proof, gates

**Files:** `CHANGELOG.md`, `docs/user/containers.md`, `docs/user/cleanup.md`, a contract test `tests/park-docs.test.ts`, `.harnu/REPORT.md`.

- [ ] **Step 1: Docs + contract test** (red, then green).
- [ ] **Step 2: AC-6** — fixture `u34fixture` in `/tmp` (published port + named volume with a marker file + a `build:` service); call `pauseStack` through a tiny script against real docker; paste the journal hint by hand; check ports and marker; clean the fixture.
- [ ] **Step 3: Gates** — `npm run typecheck`, `eslint`, `prettier --check .`, the repo contract gates, full vitest at half the cores, `npm run build`.
- [ ] **Step 4: `.harnu/REPORT.md`, push, report to the owner.**
