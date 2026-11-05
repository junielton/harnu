# U3.2 Docker facts core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Read-only Docker facts for U3.3 (garbage), U3.5 (pause eligibility) and U3.6 (capacity watcher): per-container network attachments, empty compose networks, free bridge-network slots, per-stack CPU/IO activity, engine kind.

**Architecture:** Three pure cores (`docker-networks-core`, `docker-capacity-core`, `docker-activity-core`) plus one thin shell (`docker-facts-shell`) whose every function takes an injected `DockerRun`, so it unit-tests with a recording fake and runs outside Electron. `containers-core.parseInspect` grows a `networks` field. Nothing here changes docker state.

**Tech Stack:** TypeScript, vitest (tests live flat under `tests/`), existing `runDocker` (`containers-shell.ts:73`) supplied by the caller.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U3 ("Garbage", "Capacity watcher", "Park"), §7 C8, C11; `docs/studies/2026-10-27-autonomous-cleanup-risks.md` risk 10.

## Global Constraints

- No docker command that changes state. Allowed verbs only: `ps`, `inspect`, `network ls|inspect`, `stats --no-stream`, `info`, `context inspect`, `compose … config`. A shell test enforces this on every recorded argv.
- Cores are pure (no I/O, no Electron). Shell code decides nothing.
- Empty network (C8): compose project label, zero containers attached (running OR stopped) counted from containers' `NetworkSettings`, not `network inspect`; excluded when any stack on the machine declares it `external`.
- Capacity (C11): known only on a native Linux engine; Docker Desktop, rootless, remote context → `unknown` with a reason; garbage and activity facts are still produced.
- English only; Conventional Commits with a `(U3.2)` suffix. No CHANGELOG entry (no user-visible behaviour), no `docs/user` change (no new top-level component, no `tool-catalog.ts` change; new files are under `src/main/containers/`, not top-level `src/main/`).
- Do not touch `gc-prefs.ts`, `gc-cycle.ts`, `containers-journal.ts`, `containers-wire.ts`, Settings UI.

## Review Focus

- A stopped container still holds its network (inspect keeps `NetworkID` + name key): the network must NOT be reported empty.
- A network a different project declares `external` while that project is down: excluded.
- A project whose `compose config` fails for a reason other than "files gone" (unset required env): externals are incomplete, so NO network is released as garbage (held, reason `externals-unresolved`).
- User subnets inside the default pools (e.g. a `/24` in `172.20.0.0/16`) consume a whole pool slot; subnets outside the pools consume none.
- A container restarted between the two stats samples (cumulative counters reset) reads as active, never as negative IO.
- `daemon.json` that is invalid JSON or has overlapping/IPv6-only pools → capacity `unknown` with a reason, never a guessed number.

---

### Task 1: Network attachments in `parseInspect`

**Files:** Modify `src/main/containers/containers-core.ts` (`InspectedContainer`, `parseInspect`); fixtures builder `tests/containers-fixtures.ts` and any literal constructors the typecheck flags; Test `tests/containers-core.test.ts`.

**Interfaces:**

- Produces: `interface NetworkAttachment { name: string; id: string | null }`; `InspectedContainer.networks: NetworkAttachment[]` (name = key of `NetworkSettings.Networks`; `id` = its `NetworkID` or null when empty), sorted by name.

- [ ] **Step 1: failing tests** in `tests/containers-core.test.ts`: `parseInspect reads NetworkSettings.Networks into attachments` (running container on `p_default` + `shared`; expect `[{name:'p_default',id:'abc'},{name:'shared',id:'def'}]`); `parseInspect keeps attachments of a stopped container` (Endpoint empty, `NetworkID` present); `parseInspect returns [] networks for network_mode host with empty map`; `NetworkID ''` → `id: null`.
- [ ] **Step 2:** run `nice -n 19 npx vitest run tests/containers-core.test.ts --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1` → FAIL.
- [ ] **Step 3:** implement `parseNetworks(networkSettings: unknown): NetworkAttachment[]` next to `parsePorts`; wire into `parseInspect`. Make the field required; fix fixture builders so `npm run typecheck:node` passes.
- [ ] **Step 4:** tests + `npm run typecheck:node` pass.
- [ ] **Step 5:** commit test (red) then impl: `test(containers): network attachments in parseInspect (U3.2)`, `feat(containers): parse network attachments from inspect (U3.2)`.

### Task 2: Empty compose network planner (`docker-networks-core.ts`)

**Files:** Create `src/main/containers/docker-networks-core.ts`; Test `tests/docker-networks-core.test.ts`.

**Interfaces:**

- Consumes: `InspectedContainer`, `COMPOSE_PROJECT_LABEL` from `containers-core`.
- Produces:
  - `interface DockerNetworkFact { id: string; name: string; driver: string; project: string | null; subnets: string[] }` (IPv4 CIDRs only)
  - `parseNetworkInspect(stdout: string): DockerNetworkFact[]` (JSON array from `docker network inspect`; reads `Id`, `Name`, `Driver`, `Labels[com.docker.compose.project]`, `IPAM.Config[].Subnet`; malformed → `[]`)
  - `externalNetworkNamesOf(configJson: string): string[] | null` (parses `docker compose config --format json`: every `networks.<key>` with `external` true or an object → `entry.name ?? key`; unparseable or a name containing `$` → `null`)
  - `interface ExternalDeclarations { names: ReadonlySet<string>; unresolvedProjects: readonly string[] }`
  - `interface EmptyNetworkPlan { garbage: DockerNetworkFact[]; held: { network: DockerNetworkFact; reason: 'external' | 'externals-unresolved' }[] }`
  - `planEmptyComposeNetworks(input: { networks: readonly DockerNetworkFact[]; containers: readonly InspectedContainer[]; externals: ExternalDeclarations }): EmptyNetworkPlan`

- [ ] **Step 1: failing tests** `describe('planEmptyComposeNetworks')`: (a) compose network with no containers → garbage; (b) network with only a **stopped** container attached (matched by name key or id) → in neither list; (c) network without the compose label → ignored entirely; (d) network name in `externals.names` → `held` with `'external'`; (e) `unresolvedProjects: ['x']` → every would-be-garbage network lands in `held` with `'externals-unresolved'`; (f) built-in networks (`bridge`, `host`, `none`) never garbage; (g) result sorted by name. `externalNetworkNamesOf`: `external: true` with resolved `name`, object form, internal network ignored, `${X}` name → null, garbage → null. `parseNetworkInspect` fixture incl. IPv6 subnet dropped.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** implement the four functions. Attachment match: container attachment `name === network.name` OR (`id !== null && id === network.id`).
- [ ] **Step 4:** run → PASS. **Step 5:** commits `test(containers): empty compose network planner (U3.2)`, `feat(containers): plan empty compose networks from container attachments (U3.2)`.

### Task 3: Capacity and engine kind (`docker-capacity-core.ts`)

**Files:** Create `src/main/containers/docker-capacity-core.ts`; Test `tests/docker-capacity-core.test.ts`.

**Interfaces:**

- Consumes: `DockerNetworkFact` from Task 2.
- Produces:
  - `type EngineKind = 'native-linux' | 'docker-desktop' | 'rootless' | 'remote' | 'other-local'`
  - `interface EngineFacts { kind: EngineKind; capacityKnown: boolean; reason: string | null }`
  - `detectEngineKind(input: { platform: NodeJS.Platform; dockerHost: string | null; info: { OSType?: string; OperatingSystem?: string; Name?: string; SecurityOptions?: string[] } }): EngineFacts` — `dockerHost` is the resolved endpoint (context host or `DOCKER_HOST`); non-`unix://` → `remote`; `OperatingSystem`/`Name` containing "Docker Desktop"/"docker-desktop" → `docker-desktop`; `name=rootless` in SecurityOptions → `rootless`; `platform==='linux'` + `OSType==='linux'` + host `unix:///var/run/docker.sock` or `unix:///run/docker.sock` (or null) → `native-linux`; anything else `other-local`. Only `native-linux` has `capacityKnown: true`.
  - `interface AddressPool { base: string; size: number }`; `DEFAULT_ADDRESS_POOLS: AddressPool[]` = `172.17.0.0/16`…`172.31.0.0/16` each size 16, plus `192.168.0.0/16` size 20 (31 slots)
  - `parseDaemonPools(daemonJson: string | null): { pools: AddressPool[]; source: 'daemon.json' | 'default' } | { error: string }` (null/absent key → defaults; `default-address-pools` entries `{base,size}`; IPv6 bases skipped; invalid JSON or no usable IPv4 pool → error)
  - `type BridgeCapacity = { known: true; total: number; used: number; free: number; source: 'daemon.json' | 'default' } | { known: false; reason: string }`
  - `computeBridgeCapacity(input: { pools: AddressPool[]; source: …; networks: readonly DockerNetworkFact[] }): BridgeCapacity` — total = Σ 2^(size−prefix); used = slots overlapped by any IPv4 subnet of a `bridge`-driver network (merge slot-index intervals per pool; arithmetic, no enumeration); overlapping pools → `known:false` reason `overlapping address pools`.

- [ ] **Step 1: failing tests**: engine table (native linux unix socket; DD via OperatingSystem; rootless via SecurityOptions; `tcp://`/`ssh://` remote; darwin; socket under `~/.colima` → other-local); `parseDaemonPools` (null → default, custom `[{base:'10.10.0.0/16',size:24}]`, invalid JSON error, IPv6-only error); `computeBridgeCapacity` default pools with 15 networks on distinct `/16` slots → `{total:31, used:15, free:16}`; a `/24` inside `172.20.0.0/16` consumes exactly that slot; a subnet outside pools consumes none; a `/12` network overlapping 15 slots; custom pool `10.10.0.0/16` size 24 → total 256; two overlapping pools → unknown; non-bridge drivers ignored.
- [ ] **Step 2:** FAIL. **Step 3:** implement (IPv4 CIDR → [start,end] with unsigned 32-bit math). **Step 4:** PASS. **Step 5:** commits `test(containers): bridge capacity and engine kind (U3.2)`, `feat(containers): free bridge-network slots and engine detection (U3.2)`.

### Task 4: Stack activity (`docker-activity-core.ts`)

**Files:** Create `src/main/containers/docker-activity-core.ts`; Test `tests/docker-activity-core.test.ts`.

**Interfaces:**

- Produces:
  - `interface StatsSample { at: number; rows: Map<string, { cpuPercent: number; netRxBytes: number; netTxBytes: number; blockReadBytes: number; blockWriteBytes: number }> }`
  - `parseStatsSample(stdout: string, at: number): StatsSample` (one JSON object per line; `CPUPerc` `"0.24%"`, `NetIO`/`BlockIO` `"a / b"` via `parseDockerSize`; keyed by full container id)
  - `interface ActivityThresholds { cpuPercent: number; ioBytesPerSec: number }`; `DEFAULT_ACTIVITY_THRESHOLDS = { cpuPercent: 2, ioBytesPerSec: 4096 }`
  - `interface StackActivity { project: string; cpuPercent: number; netBytes: number; blockBytes: number; ioBytesPerSec: number; restarted: boolean; active: boolean }`
  - `computeStackActivity(input: { first: StatsSample; second: StatsSample; projectOf: ReadonlyMap<string, string>; thresholds?: ActivityThresholds }): StackActivity[]` — CPU = Σ over containers of the mean of both samples; IO = Σ of positive counter deltas (net rx+tx, block r+w) divided by elapsed seconds; a counter that decreased, or a container only in `second`, sets `restarted: true` and `active: true`; containers with no project are skipped; sorted by project.

- [ ] **Step 1: failing tests**: parse with real-shape lines (incl. `"--"` CPU and malformed line skipped); idle stack (0.2% CPU, 100 B delta over 5 s) → `active:false`; busy CPU (12%) → active; IO-only (200 KiB over 5 s, 0% CPU) → active; two containers of one project aggregate; counter reset → `restarted` and active, deltas never negative; new container in second sample → active; unlabelled container skipped.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commits `test(containers): stack activity from two stats samples (U3.2)`, `feat(containers): aggregate stats samples into per-stack activity (U3.2)`.

### Task 5: Thin shell (`docker-facts-shell.ts`) + live read

**Files:** Create `src/main/containers/docker-facts-shell.ts`; Test `tests/docker-facts-shell.test.ts`. Reuse `inspectAll` is NOT imported (it pulls Electron); the shell issues `ps -aq --no-trunc` + chunked `inspect` itself via the injected run.

**Interfaces:**

- Consumes: `DockerRun` type (re-declared locally as `(argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string }>` so the production caller adapts `runDocker`), cores from Tasks 1–4, `summarizeDockerError` from `containers-core`.
- Produces (all take a `deps` object `{ run, readFile?, fileExists?, platform?, env? }`, defaults to node):
  - `type DockerFactsResult<T> = { ok: true; value: T } | { ok: false; error: { kind: 'docker-unavailable' | 'failed'; message: string } }`
  - `readEngineFacts(deps): Promise<DockerFactsResult<EngineFacts>>` — `docker info --format '{{json .}}'`, `docker context inspect --format '{{json .Endpoints.docker.Host}}'` (skipped when `DOCKER_HOST` set)
  - `readEmptyComposeNetworks(deps): Promise<DockerFactsResult<EmptyNetworkPlan>>` — strict inspect of every container, `network ls -q --no-trunc` + `network inspect`, then per compose project `compose -p P --project-directory WD -f … config --format json` (cap 4 concurrent, 30 s timeout). Config files all missing on disk → project contributes nothing (nobody can `up` it); config command fails otherwise or `externalNetworkNamesOf` returns null → project listed in `unresolvedProjects`. A partial `inspect` makes the whole read `failed` (never plan on a partial picture).
  - `readBridgeCapacity(deps): Promise<DockerFactsResult<BridgeCapacity>>` — engine first; not `capacityKnown` → `{ known:false, reason }`; reads `/etc/docker/daemon.json` (ENOENT → null).
  - `readStackActivity(deps, opts?: { sampleGapMs?: number; thresholds?: ActivityThresholds }): Promise<DockerFactsResult<StackActivity[]>>` — two `docker stats --no-stream --no-trunc --format '{{json .}}'` samples `sampleGapMs` apart (default 5000), project map from inspect labels.

- [ ] **Step 1: failing tests** with a recording fake `run` keyed on argv: (a) `readEmptyComposeNetworks` finds the empty network and holds the external one; (b) a project whose `compose config` rejects → everything `held` `externals-unresolved`; (c) config files missing on disk → project ignored, networks still garbage; (d) a failing chunk of `inspect` → `ok:false`; (e) docker down (`run` rejects ENOENT/daemon error) → `{ ok:false, error.kind:'docker-unavailable' }` for all four readers; (f) `readBridgeCapacity` on Docker Desktop info → `known:false`; on native with no daemon.json → defaults; (g) **read-only guard**: across (a)–(f) every recorded argv matches the allowlist (`ps`, `inspect`, `network ls|inspect`, `stats`, `info`, `context inspect`, `compose … config`) and none contains `rm`, `down`, `stop`, `kill`, `prune`, `up`, `start`, `create`, `disconnect`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commits `test(containers): docker facts shell readers (U3.2)`, `feat(containers): read-only docker facts shell (U3.2)`.
- [ ] **Step 6 (live, not committed):** scratch script in the session scratchpad run with `npx tsx` imports the shell, supplies a `node:child_process` `docker` runner, prints the empty compose networks, capacity, engine kind and activity. Paste output into the report (AC-5). Read-only.

### Task 6: Gates and report

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run` (capped workers, `nice -n 19`), `npm run build` all green; plan checkboxes ticked.
- [ ] Write `.harnu/REPORT.md` (format in the card), push the branch, confirm `git status --porcelain` empty and `git rev-list --count origin/main..HEAD` > 0, append a decision to `.harnu/memory/decisions.md` via `memory_append`, SendMessage the owner (resolve name with `ListAgents` first).
