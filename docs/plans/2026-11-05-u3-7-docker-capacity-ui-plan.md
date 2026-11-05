# Autonomous Cleanup U3.7 — Docker capacity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, one session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Cleanup Docker card shows network-slot capacity, Paused stacks and the newest automatic actions; a one-time callout opens a guided address-pool advice dialog; Activity warns when a live project mounts a volume that belonged to a removed worktree.

**Architecture:** Pure view helpers in the renderer (`lib/docker-*-view.ts`) turn U3.6's wire records (`dockerWatch`, `dockerReport`) and the Containers snapshot (`paused`, `recent`) into the card's view model; three small child components render the blocks so `CleanupDockerCard.vue` only composes them. The stale-volume warning is detected in main by a pure core (`stale-volume-core.ts`) fed from the Containers scan that already runs, remembered in a small userData ledger (the new-zombie alert's pattern), and delivered on a new `containers:staleVolumes` push that the Containers store words into an Activity row. The pool-advice "squeeze seen" and "dismissed" flags are renderer-persisted conveniences (`persistedRef`), keyed by the engine's pools.

**Tech Stack:** TypeScript (main, Node), Vue 3 + Pinia + vue-i18n + Tailwind v4, vitest.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U3 "Address pool advice", "Stale-volume warning", §7 C5/C11, §10 Amendments ("Paused"/"Pausada", low-water **3**). Mockup: `docs/design/2026-11-05-u3-7-docker-capacity/` (approved 2026-11-05). Card: `T650` (AC-1..AC-7).

## Global Constraints

- Low-water mark = `prefs.docker.lowWaterSlots` (default **3**). Low state = `free <= mark` and `free > 0`; none left = `free === 0`.
- Newest **5** automatic actions on the card + a "Show all in Activity" link; the pool advice is a one-time **callout**, never an auto-popup; "Report only · first cycle" badge + "Would have" rows, acknowledgement stays in Settings → Cleanup (the badge links to it).
- UI word is **Paused** / **Pausada**, never "parked". "Rebuilds on restore" value reads **Yes** (design.md).
- Snippet: `10.200.0.0/16`, size 24, with the VPN/LAN clash note. Harnu never edits `daemon.json`.
- Stale-volume: one row per project, grouped when several in one scan; fires once per `(volume, removed worktree, mounting worktree)`.
- Tokens only (Tailwind utilities backed by `themes.css`); every string through `$t` in BOTH `en.json` and `pt-BR.json`; English only in code, comments, docs, commits; neutral fixture names (`ext-12`, `feat-old`, `proj-34`).
- No change to the watcher, garbage, pause executor or eligibility (U3.1–U3.6). No new MCP verb, so `docs/harnu-features.md` and its marker stay as they are.
- CPU: `nice -n 19 npx vitest run <files> --maxWorkers=$(( $(nproc) / 2 )) --minWorkers=1`.
- Commits: Conventional Commits, `(U3.7)` suffix, no attribution lines. Failing-test commit, then implementation commit, per task.

## Review Focus

- Capacity unknown, or no pass has read it yet (`dockerWatch` null): the block reads "Unknown", never `0 of 0`: Task 3.
- Off/paused Docker autonomy still reads capacity (U3.6 delta): the Low caption says why nothing is freed: Task 3.
- A kept volume the operator later removed and compose recreated is fresh data, not stale: Task 1.
- Reason sentences that do not match a known shape (older journal lines, other actors) fall back to the English sentence and never throw: Task 3.
- A dismissed advice stays dismissed across restarts, and returns only when the pools change: Task 4.

## File Structure

- Create `src/main/gc/stale-volume-core.ts` — pure: `findStaleVolumes`, ledger key.
- Create `src/main/gc/stale-volume-shell.ts` — ledger file read/write (atomic), like the zombie ledger.
- Modify `src/main/containers/containers-ipc.ts`, `containers-wire.ts`, `src/preload/index.ts` — hook after each scan, `containers:staleVolumes` push, `onContainersStaleVolumes`.
- Modify `src/renderer/src/stores/containers.ts` — word the push into an Activity row.
- Create `src/renderer/src/lib/docker-card-view.ts` — capacity state, action rows, paused rows, would-have wording, pool-advice decision.
- Create `CleanupDockerSlots.vue`, `CleanupDockerPaused.vue`, `CleanupDockerActions.vue`, `CleanupPoolAdviceDialog.vue` under `src/renderer/src/components/`.
- Modify `CleanupDockerCard.vue`, `CleanupView.vue`, `CleanupSettingsPane.vue` (would-have wording), `ContainersPausedDetail.vue` + `en.json`/`pt-BR.json` (`containers.value.yes`), `stores/gc.ts` (advice flags).

---

### Task 1: Stale-volume detection (main)

**Files:** Create `src/main/gc/stale-volume-core.ts`, `src/main/gc/stale-volume-shell.ts`; Modify `src/main/containers/containers-ipc.ts`, `containers-wire.ts`; Test `tests/gc-stale-volume-core.test.ts`, `tests/gc-stale-volume-shell.test.ts`, `tests/containers-stale-volume-alert.test.ts`.

**Interfaces:**

- Produces `StaleVolumeFinding = { key: string; volume: string; project: string; worktree: string }` where `project` is the mounting live project and `worktree` the removed worktree's folder name.
- Produces `findStaleVolumes(input: { journal: readonly Tombstone[]; stacks: readonly StackRow[]; seen: ReadonlySet<string> }): { fresh: StaleVolumeFinding[]; seen: Set<string> }`.
- Produces `StaleVolumesAlert = { warnings: { volume: string; project: string; worktree: string }[] }` (containers-wire) and `ContainersServiceDeps.alertStaleVolumes?(alert: StaleVolumesAlert): void`.
- Produces `readStaleLedger(file): Promise<Set<string>>`, `writeStaleLedger(file, keys): Promise<void>`, `staleLedgerFile(userDataDir): string`.

- [ ] **Step 1: Write the failing core tests.** Cases (names are the test titles): `warns once when a live project mounts a volume kept for a removed worktree`; `a stack in an orphan or unknown verdict never warns`; `a later removal of the volume voids the owner (fresh data, not stale)`; `the same volume mounted by a different worktree warns again`; `the same volume, same mounting worktree, never warns twice`; `a volume with no keptVolumeOwner never warns`; `worktree is the folder name of keptVolumeOwner.worktreePath, falling back to owner.project`; `the returned seen set keeps every key already seen`.
- [ ] **Step 2: Run, expect FAIL** (`Cannot find module ../src/main/gc/stale-volume-core`).
- [ ] **Step 3: Implement `findStaleVolumes`.** Walk the journal oldest→newest keeping `volume → owner`: set from `stacks[].keptVolumes` + `keptVolumeOwner`, delete when a later line lists the volume in `stacks[].freed.volumes`. For each compose stack whose verdict is not `orphan`/`unknown`, for each `stack.volumes[].name` with an owner, key = `${volume}\u0000${owner.worktreePath ?? owner.project}\u0000${stack.attribution.path ?? stack.id}`; fresh if not in `seen`.
- [ ] **Step 4: Write the failing shell test** (`tests/gc-stale-volume-shell.test.ts`): round-trips a set through a temp file; a missing or corrupt file reads as empty; the write is atomic (`.tmp` renamed); the set is capped at 500 keys, newest kept. Implement `stale-volume-shell.ts` with the zombie ledger's file pattern (`containers-stale-volumes-notified.json`, `{ version: 1, keys: [...] }`).
- [ ] **Step 5: Write the failing service test** (`tests/containers-stale-volume-alert.test.ts`, built on the existing `createContainersService` fixtures): after a scan whose snapshot has a live stack mounting a kept volume, `alertStaleVolumes` is called once with the project, volume and worktree; a second scan and a restart (new service, same `userDataDir`) call it zero times; an unavailable Docker never calls it.
- [ ] **Step 6: Wire it.** In `runScan` call `noteStaleVolumes(snap, journal)` right after `noteNewZombies` (same error handling); persist only when the set changed; add `alertStaleVolumes` to `registerContainersHandlers` sending `containers:staleVolumes` to the window.
- [ ] **Step 7: Run the three files, expect PASS; commit** the red tests (`test(gc): …, failing (U3.7)`) before the implementation (`feat(gc): …(U3.7)`).

### Task 2: Stale-volume Activity row (renderer)

**Files:** Modify `src/preload/index.ts`, `src/renderer/src/stores/containers.ts`, `en.json`, `pt-BR.json`; Test `tests/containers-stale-volume-store.test.ts`.

**Interfaces:**

- Consumes `StaleVolumesAlert` (Task 1). Produces `window.api.onContainersStaleVolumes(cb): () => void`.

- [ ] **Step 1: Write the failing store test.** One project, one volume → one record: `kind: 'warning'`, `source: 'app'`, title `Data in this volume may be stale`, description `Project ext-12 mounts volume ext-12_mysql that belonged to a removed worktree (feat-old). Its data may be stale.`, `action: { label: 'Open Containers' }`, `target: { view: 'containers' }`. One project, two volumes → one record whose description names both. Two projects → ONE grouped record (`group: 'stale-volume'`, title `2 projects mount volumes that may be stale`, one `items[]` entry per project: id = project, title = its volumes, description `Used by ext-12 · from removed feat-old`). The same alert twice adds a second record only because it is a second call (main dedupes). pt-BR keys exist for all of it.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `recordStaleVolumes(alert)` in `stores/containers.ts` (beside `recordNewZombies`), subscribed in the same place as `onContainersNewZombies`; add the preload subscription; add `containers.staleVolume.*` keys to both locales.
- [ ] **Step 4: Run, expect PASS; commit** (red, then green).

### Task 3: Card view model (pure) and the three blocks

**Files:** Create `src/renderer/src/lib/docker-card-view.ts`, `CleanupDockerSlots.vue`, `CleanupDockerPaused.vue`, `CleanupDockerActions.vue`; Modify `CleanupDockerCard.vue`, `CleanupView.vue`, `en.json`, `pt-BR.json`; Test `tests/docker-card-view.test.ts`, `tests/cleanup-docker-capacity-blocks.test.ts`, extend `tests/cleanup-docker-card.test.ts`.

**Interfaces (all in `docker-card-view.ts`):**

- `slotsState(watch: DockerWatchRecord | null, mark: number): { kind: 'known'; level: 'ok'|'low'|'zero'; free: number; total: number; source: 'daemon.json'|'default'; autonomy: 'on'|'off'|'paused' } | { kind: 'unknown'; reason: string | null }`.
- `describeAction(item: { kind?: DockerReportKind; reason: string }): { kind: DockerReportKind | null; target: string | null; detail: string | null; raw: string }` — parses the three journal sentences (`Removed empty network \`x\` — no containers`, `Removed orphan stack \`p\` — worktree gone, volumes kept: a, b`, `Paused \`s\` — idle 3 h[ · bring back: …]`, or just `idle 3 h`for a pause report item); anything else returns`kind: null`and`raw`.
- `automaticActions(recent: readonly ContainersTombstone[], limit = 5): ActionRow[]` — only actor `autopilot` lines that are a pause (`stacks[].paused`), an orphan removal (`keptVolumeOwner`) or an empty-network removal (`verb: 'remove'`, `stacks: []`); newest first; the pre-removal stop line is skipped.
- `wouldHaveRows(report: { items: DockerReportItem[]; found: number } | null, limit = 5): ActionRow[]`.
- `pausedRows(paused: readonly ContainersPausedStack[], limit = 3): { rows: PausedRow[]; more: number }`.
- `ActionRow = { id: string; kind: DockerReportKind | null; target: string | null; detail: string | null; raw: string; at: number | null; would: boolean }`.

- [ ] **Step 1: Write the failing view tests.** `slotsState`: null watch → unknown/null reason; `capacity: {known:false, reason}` → unknown with the reason; free 16/31 → ok; free 3 with mark 3 → low; free 0 → zero; `mode: 'off'` → `autonomy: 'off'`. `describeAction`: the three shapes above plus an unmatched sentence (`kind: null`, `raw` kept). `automaticActions`: five newest of seven; skips operator lines and the pre-removal stop; a network removal parses to `kind: 'network'`. `wouldHaveRows`: marks `would: true`; empty/null → `[]`. `pausedRows`: three rows plus `more: 2` for five stacks, newest first.
- [ ] **Step 2: Run, expect FAIL; commit red.**
- [ ] **Step 3: Implement `docker-card-view.ts`** (no Vue imports; types from `gc-wire` and `containers-wire`).
- [ ] **Step 4: Write the failing component tests.** Slots block: ok/low/zero/unknown texts and badges from the mockup (`16 of 31 network slots free`, `Low`, `None left`, `Unknown` + the reason), caption "Cleanup acts when 3 or fewer are free", the off/paused caption. Paused block: `3 paused`, `None paused`, `Would pause 3` while reporting, three rows with a copy button that writes `restoreCommand`, `+ 2 more in Inspect stacks`. Actions block: five rows max, `Show all in Activity` emits `showAll`, the empty sentence, the `Would have` chip and rewritten verbs (`Would remove empty network x`), `nothing was changed` caption. Card: the report-only badge and `Review in Settings` emit `openSettings`; the blocks sit in the order slots, paused, existing three, (leftovers), actions.
- [ ] **Step 5: Run, expect FAIL; commit red.**
- [ ] **Step 6: Implement the three components** from the mockup markup with Tailwind tokens (gauge `bg-green`/`bg-warning`/`bg-red` over `bg-surface-2`, badges as in the existing card), add the i18n keys (`cleanup.gc.docker.slots.*`, `.paused.*`, `.actions.*`) to both locales, and compose them in `CleanupDockerCard.vue` with new props `watch`, `paused`, `recent`, `report` and emits `openSettings`, `showAll`. In `CleanupView.vue` feed them from `useGcStore().dockerWatch`/`dockerReport` and `useContainersStore().paused`/`recent` (calling the containers store `init()` when the view mounts), and wire `openSettings` to `ui.openSettings('cleanup')` and `showAll` to `ui.openPopover('activity')`.
- [ ] **Step 7: Run these files plus `cleanup-docker-card`, `cleanup-stack-leftovers-card`, `cleanup-view-gc`; expect PASS; commit.**

### Task 4: Address-pool advice (callout, dialog, persistence)

**Files:** Modify `src/renderer/src/lib/docker-card-view.ts`, `stores/gc.ts`, `CleanupDockerCard.vue`, `CleanupView.vue`, locales; Create `CleanupPoolAdviceDialog.vue`; Test `tests/docker-pool-advice.test.ts`, `tests/gc-pool-advice-store.test.ts`.

**Interfaces:**

- `poolsKey(c: { total: number; source: 'daemon.json'|'default' }): string` → `` `${source}:${total}` ``.
- `adviceOffer(args: { capacity: DockerCapacityView | null; state: { squeezeSeenFor: string | null; dismissedFor: string | null } }): boolean` — true only for known capacity with `source === 'default'`, `squeezeSeenFor === poolsKey`, `dismissedFor !== poolsKey`.
- Store: `gc.poolAdvice` (readonly `{ squeezeSeenFor, dismissedFor }`, `persistedRef('om2tab.gc.poolAdvice', …)`), `gc.dismissPoolAdvice()`; every adopted watch record with known capacity, `source: 'default'` and `free <= mark` sets `squeezeSeenFor`.
- Dialog props: `{ free: number; total: number }`; emits `dismiss`.

- [ ] **Step 1: Write the failing tests.** `adviceOffer` truth table (custom pools never; no squeeze never; dismissed never; changed pools → true again after a dismissal for the old key); store: a low record with default pools sets the flag, an `ok` record does not, `dismissPoolAdvice` persists through a re-created store, a record with `source: 'daemon.json'` never sets it; dialog: shows the snippet text containing `"base": "10.200.0.0/16"` and `"size": 24`, `/etc/docker/daemon.json`, the restart note, the clash caption, `Harnu never edits this file. You'll only see this once.`; **Copy** writes exactly the JSON snippet and flips to **Copied**; **Dismiss** and Esc emit `dismiss`; the callout shows only when `adviceOffer` is true and its button opens the dialog (it never opens by itself).
- [ ] **Step 2: Run, expect FAIL; commit red.**
- [ ] **Step 3: Implement** the pure helpers, the store additions (inside the existing watch adoption, `flush: 'sync'` free), `CleanupPoolAdviceDialog.vue` on the standard `Dialog` shell (real overlay class), the callout in the card, and the locale keys.
- [ ] **Step 4: Run, expect PASS; commit.**

### Task 5: Settings list wording and the "Yes" fix

**Files:** Modify `CleanupSettingsPane.vue`, `ContainersPausedDetail.vue` (only if the value is wrong there), `en.json`, `pt-BR.json`; Test extend `tests/cleanup-settings-pane.test.ts`, add `tests/containers-paused-detail-yes.test.ts`.

- [ ] **Step 1: Failing tests.** The Settings first-report list shows `Would remove empty network x — no containers` (and the orphan and pause equivalents, pt-BR too) using `describeAction`, falling back to the raw reason when it does not parse; the Paused detail's Rebuilds-on-restore value reads `Yes` (`containers.value.yes` is `yes` today).
- [ ] **Step 2: Run, expect FAIL; commit red.**
- [ ] **Step 3: Implement.** Capitalise `containers.value.yes` only if every other consumer of the key reads right; otherwise add `containers.paused.evidence.buildYes` and use it. Reuse the `would` title keys from Task 3 in the Settings list.
- [ ] **Step 4: Run, expect PASS; commit.**

### Task 6: Docs, changelog, entity map

**Files:** Modify `CHANGELOG.md`, `docs/user/cleanup.md`, `docs/user/containers.md`, `CLAUDE.md` (entity map rows for the four new components), `docs/specs/…` untouched.

- [ ] **Step 1:** CHANGELOG `## 2026-11-05` (Added: card capacity/Paused/actions, advice, stale-volume warning; Fixed: "Yes"). `docs/user/cleanup.md`: the three blocks, the report-only badge, the one-time advice (and that Harnu never edits `daemon.json`). `docs/user/containers.md`: the stale-volume warning and what to do about it. `CLAUDE.md`: map rows.
- [ ] **Step 2:** Run the local gates: `scripts/ci/local-pipeline.sh --skip test --skip mod`, then the full vitest suite at half the cores, `npm run typecheck`, `npm run build`. Commit docs.

### Task 7: Live proof and mockup QA

- [ ] **Step 1:** Isolated instance per `docs/dev/live-verify-second-instance.md` (`--user-data-dir=/tmp/harnu-verify-u37`, empty HOME, throwaway `u37fixture-dind` engine as U3.6 did). Capture known / low / zero / unknown / report-only with Would-have rows / Paused rows, the advice dialog (default and copied), and the stale-volume row into the main checkout's `.harnu/out/u37/built/`.
- [ ] **Step 2:** Run `/dtk:mockup-qa` against the committed mockup, fix what it finds (red→green where it is code), re-capture changed screens.
- [ ] **Step 3:** Tear down by PID, remove fixtures, write `.harnu/REPORT.md`, push, send the report to the owner.

## Addendum — what the live run changed (U3.7)

- **Opening Cleanup always scans Containers once, and again whenever the watcher or the hourly cycle reports it acted.** Cleanup's own Docker actions write the journal without going through the Containers service, so its snapshot never saw them (found live: the real autopilot removal was missing from Automatic actions). Tests in `tests/cleanup-view-gc.test.ts`.
- **A report-only plan with no pause in it keeps showing the stacks that are already paused;** "Would pause n" only replaces the count when n is above zero (found live).
- **The pool-advice dialog is a hand-rolled shell** registered in the T460 dialog nets (`dialog-shell-ratchet`, `dialog-surfaces.characterization`), as `MergeBatchDialog` and `TrustedHostsDialog` were, because `ui/Dialog.vue` does not exist yet.
