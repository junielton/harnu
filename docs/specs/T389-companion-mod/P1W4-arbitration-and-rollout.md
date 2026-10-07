# T389 P1W4 — Arbitration, task-state hub, rollout, parity, status UI

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Wave P1W4.
Rulebook: [`00-master.md`](00-master.md) · Wire: [`01-contract.md`](01-contract.md) ·
Decisions: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D4, C9).
Verified against Claude Code CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on:** P1W1 (binding table, lease clock), P1W2 (CLI gate, spawn path), P1W3 (hello,
  identity claim). Base branch: P1W3.
- **Unblocks:** P1W5, P1W6, P2W1, P2W5, P3W1, P4W3, P4W1 part B, and every flip to `active`.
- **Interfaces this wave consumes** (signatures are the owner's, master §12.1):
  - P1W1 host facade: `companionHost.getBinding`, `bindingForSession`, `bindingForSid`,
    `onBindingChange`, `spawnRecord(owner): SpawnRecordView | null` (token-free),
    `setEnablePolicy(fn)`, `revoke(b)`, `markProven` / `revokeProof`; `BindingView`,
    `TrustClass`, `SpawnOwner`. The lease clock is monotonic with one `LEASE_TTL_MS` of grace
    after the machine wakes (contract §11.3).
  - P1W1 mode seam (`src/main/companion/mode.ts`): the types `CompanionMode`, `FactFamily` and
    the signatures `getCompanionMode`, `familyMode`, `hydrateCompanionMode`. **This wave writes
    their bodies.**
  - P1W2: `cliGate(v, ceiling): CliGate` (`'unknown' | 'below' | 'ok' | 'above'`; `unknown`
    behaves as `below`), `gateAllowsInjection`. P1W2's `spawn-inject.ts` calls this wave's
    `companionInjectDecision()` (§7.3) and reports a sideload exit.
  - P1W3: the first enable policy (`sense.identity` only), which this wave replaces through
    `setEnablePolicy`; hello refusals on the binding; `IdentityParityRecord` and the `via`
    labels (`'agent-correlation' | 'collapse' | 'resolved-window' | 'companion'`).
  - This wave creates the shared policy probe (§7.6; master §12.1, first lander): P4W1 and P4W3
    reuse it.

## 3. Summary

This wave adds the arbiter and nothing that senses. It ships (1) a pure arbitration core that
answers "who writes this fact for this session", (2) the task-state hub extracted from
`hook-bridge.ts` so a second source can feed the same fold, (3) `companion-prefs.json` with
`off | shadow | active` per family, a per-folder ramp and the extension point for feature keys,
(4) a persisted parity ledger with a pure comparator, and (5) the only new UI of phases 1–3: the
Harnu mod state line, the one-time disclosure and the kill switch. It flips the shipped default
from `off` to `shadow`, which is operator decision point **OD-1** (master §13).

## 4. Evidence

| Id                | Verdict             | What this wave takes from it                                                                                                                                                             |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke A5          | CONFIRMED           | Hook throws are fail-open and unload nothing; reload wipes state. Lease, not errors, is the signal.                                                                                      |
| smoke B6          | CONFIRMED / REFUTED | A wedge unloads only the culprit and skips the chain for one call; "three crashes unload all" is not                                                                                     |
| smoke A2          | CONFIRMED           | Hello lands 657–827 ms after spawn; no `session.start` behind the resume picker or login screens                                                                                         |
| smoke §1 confound | n/a                 | The live bridge adds about 3.5 s under tool calls; parity skew budgets must absorb it                                                                                                    |
| smoke §9          | UNTESTED            | `sec-default`, `allowManagedModsOnly`, the remote kill switch (Q8); unattributable crashes (Q9)                                                                                          |
| code              | read                | `BridgeEvent` has no `source` (`hook-bridge.ts:64-73`); the shadow ring holds 200 entries in memory (`responder-registry.ts:163`); the ramp is `interceptActive` (`user-projects.ts:69`) |

## 5. Deviations from the study

None of its own. The wave implements D4. Two refinements of panel opinion, not of the study:

- The "Harnu mod unloaded" toast fires only when the session owned at least one family at the
  moment of loss. In pure `shadow` nothing changed for the operator, so the state line changes
  silently (product paper §1 proposed it unconditionally).
- A cause is named only when it was observed (DOC-8): "Blocked by your organization's policy"
  for the sideload exit only once its exit text has been recorded (LV-P1W4-e, Q6) and matched;
  until then the early exit reads "the mod did not load". The neutral "turned off by a setting or by your organization's policy"
  when the probe only shows mods are off, "the mod did not load" otherwise (Q8).

## 6. Scope / Non-goals

**In scope:** `arbitration-core.ts`, `session-arbiter.ts`, `detect/task-state-hub.ts`,
`companion-prefs` with its extension point, the bodies of `mode.ts`, the folder ramp,
`computeEnable` and `feature-policy.ts`, the parity ledger and comparator, the `identity`
parity rule, Harnu mod state derivation, IPC, the three UI touches, the disclosure, the kill
switch.

**Non-goals:** any sensor or adapter (P1W5, P1W6); any command (P2W1); a UI for per-family
modes or for the folder ramp (IPC only; the file is hand-editable); the Mods tab (P4W1);
deleting or uninstalling any legacy seam (ARB-8, P5W1).

## 7. Design

### 7.1 Arbitration core — `src/main/companion/arbitration-core.ts` (pure)

```ts
import type { CompanionMode, FactFamily } from './mode' // P1W1 owns the types
export type FactSource = 'legacy' | 'companion'

/** This wave's own view of a binding; P1W1 owns `BindingView`. */
export interface ArbiterBinding {
  sessionKey: string | null
  folder: string | null // normalized like responder-registry.ts normalizeFolder
  leaseLive: boolean
  enabled: ReadonlySet<FeatureId>
  proven: ReadonlySet<FeatureId>
  revoked: ReadonlySet<FactFamily> // sticky reversions, ARB-4c
}
export interface RolloutView {
  enabled: boolean // kill switch
  cliGate: CliGate // P1W2: 'unknown' | 'below' | 'ok' | 'above'
  families: Partial<Record<FactFamily, CompanionMode>> // persisted overrides
  defaultMode?: CompanionMode // P1W1's developer key `mode`, §7.3
  allFolders: boolean
  rampFolders: ReadonlySet<string>
}
export type OwnReason =
  | 'owned'
  | 'mode-off'
  | 'mode-shadow'
  | 'off-ramp'
  | 'cli-above-ceiling'
  | 'no-binding'
  | 'lease-lost'
  | 'unproven'
  | 'revoked'

export function effectiveMode(f: FactFamily, folder: string | null, r: RolloutView): CompanionMode
export function ownerOf(
  f: FactFamily,
  b: ArbiterBinding | null,
  r: RolloutView
): { owner: FactSource; reason: OwnReason }
export type Admit = 'apply' | 'record-only' | 'drop'
export function admit(
  f: FactFamily,
  src: FactSource,
  b: ArbiterBinding | null,
  r: RolloutView
): Admit
```

`effectiveMode`, first match wins:

1. `!r.enabled`, or `cliGate` is `below` or `unknown` → `off`.
2. `m = r.families[f] ?? r.defaultMode ?? DEFAULT_FAMILY_MODE[f]`; a value outside the enum
   reads `shadow` (ARB-6a).
3. `m === 'active'` and `cliGate === 'above'` → `shadow` (ARB-7b).
4. `m === 'active'` and not (`allFolders` or `folder ∈ rampFolders`) → `shadow`.
5. else `m`.

`ownerOf` returns `companion` only when all of ARB-3 hold: effective mode `active`, `leaseLive`,
every feature that contract §11.1 lists for `f` is in `proven`, and `f ∉ revoked`. Otherwise
`legacy`, with the first failing reason.

`admit`:

| Owner     | Source `legacy`                         | Source `companion`                                  |
| --------- | --------------------------------------- | --------------------------------------------------- |
| legacy    | `apply`                                 | `record-only` (mode `shadow`) / `drop` (mode `off`) |
| companion | `drop`, recorded in the ledger (ARB-2b) | `apply`                                             |

Proof is evaluated **before** admission: the event that proves a feature may itself be applied.

**`session-arbiter.ts`** is the stateful shell. It builds an `ArbiterBinding` from P1W1's
`BindingView`, subscribes to `onBindingChange`, and exports what consumers call (master §12.1):

```ts
export function owns(sessionKeyOrSid: string, family: FactFamily): boolean
export function ownerFor(
  sessionKeyOrSid: string,
  family: FactFamily
): { owner: FactSource; reason: OwnReason }
export function isStickyLegacy(sessionKeyOrSid: string, family?: FactFamily): boolean
export function reportFailedProof(sessionKeyOrSid: string, feature: FeatureId): void
export function onOwnershipChange(fn: (sessionKey: string | null, sid: Sid) => void): () => void
export function bindingCounters(sessionKeyOrSid: string): { modErrors: number; leaseLosses: number }
```

**Stickiness.** On lease loss the arbiter adds every family to `revoked` for that binding
(ARB-4b/c). A failed proof (`reportFailedProof`, or a proof revoked per contract §11.2) is
sticky the same way for the families that need the feature. `revoked` is cleared only when the
session ends or the host restarts. Identity already bound is kept (ARB-4d). An inert binding
(`enable: []`) has no lease to lose: its silence adds nothing to `revoked` and records no sticky
reason (contract §11.3).

The arbiter also keeps, keyed by the spawn owner, the inject decision of §7.3 and a reported
sideload exit; P1W1's spawn record carries neither.

`DEFAULT_FAMILY_MODE` shipped by this wave: every family `shadow`. Only overrides are persisted,
so a later release that changes a default to `active` (after its parity gate, ARB-6c/d) reaches
users who never touched the file.

**`mode.ts` bodies.** `familyMode(family, folder)` is `effectiveMode` over the current
`RolloutView`. `getCompanionMode()` is `off` when `enabled` is false or the gate is `below` or
`unknown`; else `active` when any family is effectively `active`; else `shadow`.
`hydrateCompanionMode()` reads the prefs and the ramp at boot. `listenerWanted()` is `enabled`
and (the developer `mode` key or some family is not `off`); **it never reads the CLI gate**, which
is per binary and still `unknown` for the first moments of a run (P1W2 fires the probe at boot and
the spawn path never awaits it), so a gate-dependent test would keep the socket down for good.
The gate decides injection (`companionInjectDecision`) and `enable` (`computeEnable`), not whether
the host exists. `onModeChange(fn)` fires on a prefs write, on `companionSetEnabled` and when
`resolveClaudeVersion()` settles; P1W1's `reconcileListener()` listens to it (P1W1 §7.7).

### 7.2 `computeEnable` (hello)

```ts
export function computeEnable(
  declared: FeatureId[],
  ctx: {
    profile: 'interactive' | 'headless' | 'external'
    folder: string | null
    rollout: RolloutView
    trust: TrustClass // P1W1: 'operator' | 'agent' | 'read-only' | 'tick'
  }
): FeatureId[]
```

It is handed to the host wrapped as an `EnablePolicy` through
`companionHost.setEnablePolicy(fn)`, replacing P1W3's first policy. **First step, before any
rule: when `getCompanionMode()` is `off` (the kill switch is off, or the CLI gate is `below` or
`unknown`) the result is `[]`**, so no later wave's rule, feature-key rules included, can keep a
mod live past the kill switch (contract §11.1, §11.2 item 2). Otherwise a feature is enabled when
it was declared and its rule in `feature-policy.ts` passes:

```ts
export function registerFeaturePolicy(feature: FeatureId, rule: (b: BindingView) => boolean): void
```

This wave registers the P1 rows, as contract §11.1 "Enabled by" states them. Each later wave
registers its own row; none edits another wave's. A feature with no registered rule is not
enabled.

| Feature                                           | Rule registered here                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| `sense.identity`                                  | `getCompanionMode() ≠ off`                               |
| `sense.turn`, `sense.attention`, `sense.subagent` | `familyMode('taskState') ≠ off`                          |
| `sense.usage`                                     | `familyMode('telemetry') ≠ off` or `('planUsage') ≠ off` |

The profile narrows the result: `headless` gets `sense.*` only (contract §16), `external` the
set of contract §21.

### 7.3 Prefs, ramp, injection — `src/main/companion/companion-prefs.ts` (+ `-core.ts`)

`<userData>/companion-prefs.json`, mode `0600`, mirrors `responder-prefs.json`
(`responder-registry.ts:50-152`): an in-memory mirror hydrated at boot, written on change.

```ts
interface CompanionPrefsFile {
  v: 1
  enabled?: boolean // default true; the kill switch
  mode?: CompanionMode // P1W1's developer key: the default for every family with no entry below
  families?: Partial<Record<FactFamily, CompanionMode>>
  allFolders?: boolean // default false; ramp escape hatch, like trustAll
  disclosureShownAt?: number // epoch ms; absent until the notice was rendered
  keys?: Record<string, unknown> // feature keys, each parsed by its registered spec
}
```

- No file, invalid JSON or a wrong type degrades field by field to the defaults; never throws.
- **Extension point** for features with no fact family (ARB-6b, contract §11.5). The keys,
  values and defaults are the contract's; each is registered by its wave, which never edits
  this schema:

```ts
export function registerPrefsKey<T>(
  key: string,
  spec: { default: T; parse(raw: unknown): T; observeCap?: T }
): void
export function prefsKey<T>(key: string): T // capped at observeCap when the CLI gate is 'above'
export function setPrefsKey<T>(key: string, value: T): void
```

- **Folder ramp:** `projects.json` gains `companionActive?: boolean` next to `interceptActive`
  (`user-projects.ts:69`), with `setCompanionActive(path, on)` and `companionActivePaths()`
  copied from `:933-1010`. `setRampFolders()` normalizes like `setInterceptFolders`.
- **Injection decision** (called from P1W2's `spawn-inject.ts`):

```ts
export function companionInjectDecision(ctx: { kind: string; cliGate: CliGate }): {
  inject: boolean
  skip?: 'off' | 'pre-disclosure' | 'cli-too-old' | 'cli-unknown' | 'not-claude'
}
```

`inject` is true only when `enabled`, `disclosureShownAt` is set, the gate is `ok` or `above`
and the PTY kind is a `claude-*` kind. The decision is kept by `session-arbiter.ts`, keyed by
the spawn owner. A session spawned before the notice rendered runs without the mod (ARB-6e);
the operator is never asked to click.

- **Kill switch off** (ARB-7d): the arbiter answers `legacy` for everything at once (rule 1).
  The host calls `revoke(b)` for every binding, spawned and external; the listener stays up, so
  each re-hello is answered `enable: []` and the mod goes inert (contract §3 item 9, §11.2
  item 2). Switching back on reaches new sessions only; running ones stay `off`. No flapping.

### 7.4 Task-state hub — `src/main/detect/task-state-hub.ts`

The body of `handleBridgeEvent` (`hook-bridge.ts:409-448`), the `TaskStateRegistry` instance
(`:214`), `getTaskStates` (`:222`), `pruneTaskState` (`:231`), `HookTaskEvent` (`:242-254`) and
the observer set (`:256-271`) move here unchanged, plus one field and two gates.

```ts
export interface BridgeEvent { /* as today */ source: 'hook' | 'companion' }
export interface HookTaskEvent { /* as today */ source?: 'hook' | 'companion' }
export function ingest(ev: BridgeEvent, getWindow: () => BrowserWindow | null): void
export function noteLiveness(sessionId: string, ts: number, getWindow: …): void
export function configureHub(deps: { isHibernated; admit; record }): void
```

`ingest`, in order:

1. `if (isHibernated(ev.sessionId)) return` — first, as today (ARB-5).
2. **Terminal edge (ARB-2d).** A `SessionEnd` whose matcher is not `clear` is admitted from
   either source the first time it arrives for a session id and dropped afterwards. The `ended`
   set is pruned with `pruneTaskState`. A lost `bye` must not swallow the edge that
   `memory-digest.ts:238`, `orchestrator-guard.ts:526` and `terminal-ledger.ts:216` depend on.
3. Otherwise `a = admit('taskState', ev.source, …)`. `drop` or `record-only`: append to the
   parity ledger, call `noteLiveness` when the dropped event is a legacy one, return.
4. Fold, fan out to observers, send `claude:hook` — byte for byte as today, with `source` added
   to both payloads (additive; `HookEvent` in `src/preload/index.ts:716`).

`noteLiveness` sends `claude:liveness { sessionId, ts }`; the renderer calls `bumpLastEvent`
(`stores/sessions.ts:5337`). It exists so that dropping a legacy `PreToolUse` for an owned
session does not starve the stuck timer's anchor (`fleet-state.ts:174-177`, ARB-2b).

`hook-bridge.ts` keeps `handleBridgeEvent(ev, getWindow)` as a one-line delegate that stamps
`source: 'hook'`, and re-exports `addTaskEventObserver`, `getTaskStates`, `pruneTaskState`,
`HookTaskEvent` and `BridgeEvent`. The four observers (`mcp/tool-handlers.ts:3248`,
`memory-digest.ts:439`, `terminal-ledger.ts:234`, `orchestrator-guard.ts:522`), `pty.ts:26` and
`tests/hook-bridge.test.ts` therefore change no import. `hooks:stateFor` (`:494`) reads the hub.
With no companion wired, `admit` is `apply` for every hook event: behaviour is identical.

### 7.5 Parity ledger — `src/main/companion/parity-ledger.ts` + `parity-core.ts` (pure)

Files `<userData>/companion/parity/<stream>.ndjson`, mode `0600`, rotated at 5 MiB, three
generations, 14 days. Appends are buffered (64 records or 2 s) and flushed on quit. Nothing is
written when the stream's effective mode is `off`. A stream is a fact family or a feature key
(`channel`, `stamp`, `sentinel`, `external`).

```ts
interface ParityRecord {
  v: 1
  stream: FactFamily | FeatureKey
  source: FactSource
  owner: FactSource // who was authoritative when it was recorded
  reason: OwnReason // why; P5W1 counts legacy sessions by it
  disposition: 'applied' | 'record-only' | 'dropped'
  sk: string // first 12 hex of SHA256(installSalt + sid); never the sid
  t: number // host receive time, epoch ms
  ts?: number // source event time
  k: string // normalized fact key, stream-defined, e.g. "state:working"
  d?: Record<string, string | number | boolean | null> // normalized, scrubbed
  cli: string
  mod: string | null
}
```

Scrubbing (QA-9, SEC-8): no prompt text, no tool input, no absolute path, no token, no `conn`.
The only entry point is
`recordFact(stream: FactFamily | FeatureKey, source: FactSource, sid: Sid, k: string, d?)`.

```ts
export interface ParityRule {
  stream: FactFamily | FeatureKey
  compare(sessionRecords: ParityRecord[]): Divergence[]
}
export interface Divergence {
  sk: string
  at: number
  legacy: string | null
  companion: string | null
  class: string | null // a class named by the rule = explained; null = unexplained
}
export function registerParityRule(rule: ParityRule): void
export function parityReport(
  stream,
  records
): {
  sessions: number
  facts: number
  explained: Record<string, number>
  unexplained: Divergence[]
}
export function gateStatus(
  report,
  gate: { minSessions: number; minFacts?: number }
): { pass: boolean; why: string[] }
```

This wave ships the framework and hosts the **`identity` rule**. Its input is P1W3's
`IdentityParityRecord` with P1W3's `via` labels; a second row for one sid is unexplained. The
flip gate of `identity` is P1W3 §13's (per-shape minimums, bind rate, latency), not defined
here. `scripts/dev/companion-parity-export.mjs` writes a scrubbed trace to
`tests/fixtures/companion-parity/<stream>/` for replay.

### 7.6 Harnu mod state — `companion-state-core.ts` (pure) + `companion-ipc.ts`

```ts
type CompanionState =
  { state: 'live' } | { state: 'off' } | { state: 'legacy'; reason: LegacyReason }
type LegacyReason =
  | 'cliTooOld'
  | 'cliUnknown'
  | 'policy'
  | 'modsOff'
  | 'remoteOff'
  | 'noHello'
  | 'refused'
  | 'unloaded'
  | 'hostRestart'
  | 'notInjected'
```

First match wins; `null` means "show no line" (parked and shell rows; external rows until P4W3
gives them a state; a spawn still inside `HELLO_GRACE_MS` = 15 000, host-only).

| #   | Condition                                                                                                                             | Result                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | no Harnu PTY for the row, or kind is not `claude-*`                                                                                   | `null`                                                                                          |
| 2   | kill switch off now, or spawn `skip === 'off'`                                                                                        | `off`                                                                                           |
| 3   | spawn `skip === 'cli-too-old'`                                                                                                        | `legacy / cliTooOld`                                                                            |
| 4   | spawn `skip === 'cli-unknown'`                                                                                                        | `legacy / cliUnknown`                                                                           |
| 5   | spawn exited early and was respawned bare (P1W2), and its kept exit output matches the recorded sideload refusal text (Q6, LV-P1W4-e) | `legacy / policy`; with no match, or while no text is recorded, `legacy / noHello`              |
| 6   | spawn `skip === 'pre-disclosure'`                                                                                                     | `legacy / notInjected`                                                                          |
| 7   | hello refused (dormant mod)                                                                                                           | `legacy / refused`; `hostRestart` when the refusal is `UNKNOWN_SESSION` after a `bootId` change |
| 8   | hello answered `enable: []` (inert: the kill switch, or no enable policy registered)                                                  | `off`; never a lease loss                                                                       |
| 9   | hello done, lease lost                                                                                                                | `legacy / unloaded`                                                                             |
| 10  | injected, no hello, younger than `HELLO_GRACE_MS`                                                                                     | `null`                                                                                          |
| 11  | injected, no hello, probe `off-here` / `off-remote`                                                                                   | `legacy / modsOff` / `legacy / remoteOff`                                                       |
| 12  | injected, no hello, probe `loads` or `unknown`                                                                                        | `legacy / noHello`                                                                              |
| 13  | lease live                                                                                                                            | `live`                                                                                          |

**Policy probe.** The shared pure classifier
`classifyPolicyProbe(output: string): 'loads' | 'off-here' | 'off-remote' | 'unknown'`
(`src/main/claude-policy-probe-core.ts`, created by this wave; P4W1 and P4W3 reuse it) and its
one shell (`claude-policy-probe.ts`), which runs
`claude plugin test <staged dir>` at most once per boot and per CLI binary, lazily on the first
candidate for row 11, off the spawn path. `off-here` cannot tell a personal setting from a
managed policy, so it maps to the neutral reason `modsOff`; `policy` is kept for the sideload
exit once its text is recorded and matched, a positively identified managed cause (DOC-8); a
behavioural retry alone is not enough. The mapping comes from the CLI's
documented refusal lines, not from a smoke run (Q8, §14). Detection is read-only; nothing is
retried, re-staged or worked around (SEC-9f).

IPC (`companion:*`, exposed on `window.api`): `companionStatus()` → `{ enabled,
disclosureShownAt, stagedDir, modVersion, cliGate, families, sessions, probe }`, where each
`sessions[sessionKey | sid]` is `{ state: CompanionState | null; ownership: Record<FactFamily,
{ owner: FactSource; reason: OwnReason }> }`; `companionSetEnabled(on)`;
`companionDisclosureShown()`; `companionReveal()`; `companionParityReport(stream)`;
`companionSetFolderActive(path, on)`; event `onCompanionUpdated` (debounced 150 ms). Renderer
store: `stores/companion.ts`.

### 7.7 Contract additions

None — merged into `01-contract.md` §3 item 9 and §11.2 item 2 (the kill switch revokes `conn`
and the re-hello is answered `enable: []`).

## 8. Arbitration & fallback

| Situation                               | Behaviour                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mod absent (never injected, CLI old)    | No binding; `ownerOf` → `legacy / no-binding`; hub admits every hook event                                                                                                        |
| CLI version not yet probed (`unknown`)  | Treated as `below`: no injection, mode `off`, state `legacy / cliUnknown`                                                                                                         |
| Managed policy, `--safe-mode`, `--bare` | No hello → rows 10–11; legacy throughout; no workaround (ARB-7c)                                                                                                                  |
| Kill switch turned off mid-session      | Every `conn` is revoked, each re-hello is answered `enable: []`, the mod is inert, legacy wins at once (no TTL wait); state `off`                                                 |
| Lease lost mid-operation                | All families `revoked` within one TTL; the next legacy event is applied; no state is reset                                                                                        |
| Process survives with the mod unloaded  | Same as lease loss: `legacy / unloaded`, sticky (master Q7)                                                                                                                       |
| Failed proof                            | The families that need the feature are `revoked` for the session (ARB-4c)                                                                                                         |
| Host restart                            | `revoked` is in memory, so it clears; re-hello re-proves features; until then `legacy`                                                                                            |
| Hot reload                              | Covered by `LEASE_TTL_MS`; the binding and its proofs are kept (contract §15)                                                                                                     |
| `/clear`, in-session `/resume`          | P1W3 moves the binding to the new sid; `revoked` and proofs follow the binding, not the sid. A `/resume` into a session live in another tab is a conflict: no re-key (master Q28) |
| Headless                                | `sense.*` only; ownership needs the heartbeat lease (contract §11.3)                                                                                                              |
| CLI above the tested ceiling            | Rule 3: families forced to `shadow`, feature keys capped at `observeCap`; state line stays `live`                                                                                 |
| Sibling mod wedge (C9, R5)              | Invisible to the host for one call; a wedge by the companion is a lease loss. Counted per binding and exported as `bindingCounters(…)`; P3W1 reads it for `contested`             |
| Ledger disk full or unwritable          | Appends are dropped and counted; arbitration is unaffected                                                                                                                        |
| Prefs file corrupt                      | Field-by-field defaults; `shadow` for an invalid mode                                                                                                                             |

## 9. Security requirements

Inherits SEC-1…SEC-9. Wave-specific:

- The arbiter grants ownership from host-side state only (mode, lease, proof); nothing in a
  request can raise it (SEC-3b). In `shadow` a family with a legacy rival gets no actuation and
  no authority; what still runs is listed in ARB-6b and contract §11.5.
- Ledger records are scrubbed at `recordFact`; a unit test fails on any field outside the
  allow-list (SEC-8).
- The disclosure text carries the three facts DOC-8 requires. The state line never implies
  protection (SEC-7).
- `companionSetEnabled`, `companionSetFolderActive` and `setPrefsKey` are reachable from
  renderer IPC only; no MCP verb reaches them.

## 10. UX & copy

`design.md` is edited first (DOC-4): §6 "Settings dialog" (General → Integrations row and its
search anchor), §6 "Hover preview" (one line), §6 "System Monitor" (state-detail column),
§6 "Toast" (two uses, no new variant), §8 (Harnu mod wording). Tokens only; no new component.
No user-visible string says "companion" (master §15).

- **Kill switch** (Q10 settled: General → Integrations until P4W1 hosts it): a block
  `id="set-companion"` after `set-statusline` in `SettingsDialog.vue` (same anatomy as `:1477-1502`),
  `ToggleSwitch`, two `SettingHint` lines, the staged path (`font-mono` 11px `--text-4`) with a
  "Reveal folder" ghost button, and at most one status line (`--text-3`, no warning colour:
  `legacy` is not an error). Registered in the settings search index with keywords
  `harnu mod, mod, mods, plugin`. Later waves mount their switches (feature keys) in the region
  `id="set-companion-keys"` at the end of this block; P4W1 moves the whole block to its tab.
- **Hover preview** (`SessionPreview.vue`, after the mode line `:224-239`): one
  `font-mono text-text-4` 11px line; absent when the state is `null`.
- **System Monitor row** (`SystemMonitorRow.vue`, live session rows, after the state pip):
  `text-[11px] text-text-3`, the reason in `title`. New optional prop
  `companion?: CompanionState | null`; `SystemMonitor.vue` reads `stores/companion.ts`.
- **Disclosure:** one sticky `info` toast with an action (§6 Toast: a toast with an `action`
  is sticky), pushed once when `enabled` and `disclosureShownAt` is unset; mounting it calls
  `companionDisclosureShown()`. The action opens Settings at `set-companion`.
- **Unloaded toast:** `warning`, once per session, only if a family was owned.

| Key                               | en                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnuMod.settings.label`         | Harnu mod                                                                                                                                     |
| `harnuMod.settings.description`   | Harnu loads a small mod into the sessions it starts. It runs unsandboxed inside the `claude` process and talks only to Harnu on this machine. |
| `harnuMod.settings.offHint`       | Off stops Harnu from using it now and from loading it into new sessions. Off means hooks and polling.                                         |
| `harnuMod.settings.reveal`        | Reveal folder                                                                                                                                 |
| `harnuMod.settings.policy`        | Blocked by your organization's policy.                                                                                                        |
| `harnuMod.settings.modsOff`       | Turned off by a setting or by your organization's policy.                                                                                     |
| `harnuMod.settings.remoteOff`     | Mods are turned off remotely for this Claude Code install.                                                                                    |
| `harnuMod.settings.cliTooOld`     | Needs Claude Code 2.1.287 or newer.                                                                                                           |
| `harnuMod.settings.cliUntested`   | This Claude Code version is newer than the last one tested. The mod only observes.                                                            |
| `harnuMod.state.live`             | Harnu mod: live                                                                                                                               |
| `harnuMod.state.off`              | Harnu mod: off                                                                                                                                |
| `harnuMod.state.legacy`           | Harnu mod: legacy — {reason}                                                                                                                  |
| `harnuMod.reason.cliTooOld`       | Claude Code older than 2.1.287                                                                                                                |
| `harnuMod.reason.cliUnknown`      | Claude Code version not checked yet                                                                                                           |
| `harnuMod.reason.policy`          | blocked by your organization's policy                                                                                                         |
| `harnuMod.reason.modsOff`         | turned off by a setting or by your organization's policy                                                                                      |
| `harnuMod.reason.remoteOff`       | mods turned off remotely                                                                                                                      |
| `harnuMod.reason.noHello`         | the mod did not load                                                                                                                          |
| `harnuMod.reason.refused`         | handshake refused                                                                                                                             |
| `harnuMod.reason.unloaded`        | unloaded mid-session                                                                                                                          |
| `harnuMod.reason.hostRestart`     | lost when Harnu restarted                                                                                                                     |
| `harnuMod.reason.notInjected`     | started without it                                                                                                                            |
| `harnuMod.monitor.state`          | Harnu mod {state}                                                                                                                             |
| `harnuMod.toast.disclosure.title` | Harnu now loads the Harnu mod                                                                                                                 |
| `harnuMod.toast.disclosure.body`  | It runs unsandboxed inside the `claude` process of the sessions Harnu starts and talks only to Harnu on this machine.                         |
| `harnuMod.toast.openSettings`     | Open Settings                                                                                                                                 |
| `harnuMod.toast.unloaded`         | Harnu mod unloaded in {session}. Running on hooks.                                                                                            |

The pt-BR wording is written into `pt-BR.json` under the same keys and is not repeated in this spec (the language
policy keeps Portuguese in the locale file). `live`, `legacy`, `off` stay untranslated (state nouns, §8 principle 4).

## 11. Acceptance criteria

```
AC-P1W4-1 [unit] Given mode active, a live lease and every taskState feature proven, When ownerOf
  runs, Then it returns companion/owned, and removing any one of the three returns legacy with
  the matching reason.
  Evidence: tests/companion/arbitration-core.test.ts › "ownership needs mode, lease and proof"
AC-P1W4-2 [unit] Given a binding whose lease expired once, When the lease becomes live again,
  Then ownerFor still returns legacy/revoked for every family until the session ends.
  Evidence: tests/companion/session-arbiter.test.ts › "reversion is sticky"
AC-P1W4-3 [unit] Given a prefs file with mode "banana" for one family, When it is read, Then
  that family's effective mode is shadow and no error is thrown.
  Evidence: tests/companion/companion-prefs-core.test.ts › "invalid mode reads as shadow"
AC-P1W4-4 [unit] Given mode active and a folder off the ramp with allFolders false, When
  effectiveMode runs, Then the result is shadow.
  Evidence: tests/companion/arbitration-core.test.ts › "off-ramp folder stays shadow"
AC-P1W4-5 [unit] Given cliGate above, When any family is configured active, Then effectiveMode
  is shadow.
  Evidence: tests/companion/arbitration-core.test.ts › "above ceiling forces shadow"
AC-P1W4-6 [unit] Given no companion wired, When the existing hook-bridge suite runs against the
  hub, Then every existing assertion passes unchanged.
  Evidence: tests/hook-bridge.test.ts (whole file, no edits to assertions)
  Guards: BUG-1, BUG-54
AC-P1W4-7 [unit] Given a hibernated session, When ingest receives an event from either source,
  Then no fold, no observer call and no renderer send happen.
  Evidence: tests/companion/task-state-hub.test.ts › "isHibernated guards both sources"
AC-P1W4-8 [unit] Given the companion owns taskState, When a hook event other than a first
  non-clear SessionEnd arrives, Then the state map is unchanged, one ledger record with
  disposition dropped exists, and claude:liveness is sent.
  Evidence: tests/companion/task-state-hub.test.ts › "legacy input for an owned family is dropped"
AC-P1W4-9 [unit] Given mode shadow, When a companion event arrives, Then all four observer
  kinds receive nothing and the ledger holds one record-only record.
  Evidence: tests/companion/task-state-hub.test.ts › "shadow never applies"
AC-P1W4-10 [unit] Given any call to recordFact with a path, a prompt or a conn in d, When the
  record is built, Then the disallowed field is absent from the serialized line.
  Evidence: tests/companion/parity-core.test.ts › "records are scrubbed"
AC-P1W4-11 [unit] Given a recorded identity trace with one duplicate row, When parityReport
  runs, Then unexplained has exactly one entry and gateStatus.pass is false.
  Evidence: tests/companion/parity-core.test.ts › "identity rule" (fixture identity/dup-row.ndjson)
  Guards: BUG-65
AC-P1W4-12 [unit] Given each row of the state table in §7.6, When deriveCompanionState runs,
  Then it returns that row's result.
  Evidence: tests/companion/companion-state-core.test.ts › "state table"
AC-P1W4-13 [unit] Given disclosureShownAt unset, When companionInjectDecision runs, Then inject
  is false with skip pre-disclosure.
  Evidence: tests/companion/companion-prefs-core.test.ts › "no injection before the notice"
AC-P1W4-14 [contract] Given the kill switch turns off mid-session, When a bound mod sends any
  request, Then it receives STALE_CONN and its re-hello is answered with enable [].
  Evidence: tests/companion/kill-switch.contract.test.ts › "off revokes and disables"
AC-P1W4-15 [integration] Given a real claude spawned with the mod and the kill switch on, When
  the handshake completes, Then companionStatus reports live for that session within 2 s of hello.
  Evidence: tests/cli/companion-state.cli.test.ts › "live after hello"
AC-P1W4-16 [live-verify] Given a fresh userData, When the app first opens, Then the disclosure
  toast is visible and a session started after it reports live while one started before it
  reports legacy — started without it.
  Evidence: LV-P1W4-a
AC-P1W4-17 [live-verify] Given a live session, When the mod's worker is wedged by a test hook,
  Then within 20 s the state reads legacy — unloaded mid-session and stays so after the mod is
  reloaded.
  Evidence: LV-P1W4-b
AC-P1W4-18 [live-verify] Given disableAllHooks set in the user's Claude settings, When a session
  is spawned, Then its state reads legacy with the neutral modsOff reason and no retry was
  attempted.
  Evidence: LV-P1W4-c (settles the classifier half of Q8)
AC-P1W4-19 [live-verify] Given a sibling mod that wedges the worker once, When it does, Then the
  companion's binding stays live and bindingCounters shows no new lease loss.
  Evidence: LV-P1W4-d (Q9)
AC-P1W4-20 [unit] Given both locale files, When the i18n parity check runs, Then every key of
  §10 exists in en.json and pt-BR.json.
  Evidence: local-ci JSON step=i18n (scripts/ci/i18n-parity.mjs)
AC-P1W4-21 [unit] Given the companion owns taskState and its session.end never arrives, When the
  legacy non-clear SessionEnd hook arrives and then arrives again, Then observers receive
  exactly one completed edge.
  Evidence: tests/companion/task-state-hub.test.ts › "terminal edge, first writer wins" (ARB-2d)
AC-P1W4-22 [unit] Given a bound session whose PTY stays alive and whose requests stop, When
  LEASE_TTL_MS elapses on the monotonic clock, Then its state is legacy/unloaded and every
  family is revoked.
  Evidence: tests/companion/session-arbiter.test.ts › "a surviving process without the mod" (Q7)
AC-P1W4-23 [unit] Given cliGate unknown, When companionInjectDecision and effectiveMode run,
  Then inject is false with skip cli-unknown and every family is off.
  Evidence: tests/companion/companion-prefs-core.test.ts › "unknown gate behaves as below"
AC-P1W4-24 [unit] Given a key registered with observeCap and cliGate above, When prefsKey reads
  it, Then it returns the cap whatever the file holds.
  Evidence: tests/companion/companion-prefs-core.test.ts › "feature keys are capped above the ceiling"
AC-P1W4-25 [unit] Given a feature reported through reportFailedProof, When ownerFor runs for a
  family that needs it, Then it returns legacy/revoked until the session ends.
  Evidence: tests/companion/session-arbiter.test.ts › "a failed proof is sticky"
AC-P1W4-29 [unit] Given the kill switch is on and the CLI gate is unknown, Then listenerWanted
  returns true.
  Evidence: tests/companion/companion-prefs-core.test.ts › "the listener does not wait for the CLI gate"
AC-P1W4-30 [unit] Given the kill switch is off, When a feature rule that returns true is registered
  and computeEnable runs, Then the result is [].
  Evidence: tests/companion/feature-policy.test.ts › "the kill switch overrides every rule"
AC-P1W4-31 [unit] Given the kill switch was off at boot, When companionSetEnabled(true) runs, Then
  onModeChange fires once.
  Evidence: tests/companion/companion-prefs-core.test.ts › "turning the switch on wakes the host"
```

**Human**

```
AC-P1W4-26 [human] The disclosure reads as a notice, not a prompt, and names the three facts
  (unsandboxed, in the CLI process, this machine only).
  Evidence: screenshot LV-P1W4-a step 3
AC-P1W4-27 [human] In the hover preview and the System Monitor row, legacy does not look like
  an error (no warning or red colour).
  Evidence: screenshots LV-P1W4-b step 5
AC-P1W4-28 [human] On a managed machine, the run of LV-P1W4-e is completed and its answer sheet
  (one line per question of Q8 and Q6) is attached to the wave's evidence.
  Evidence: LV-P1W4-e answer sheet
```

**Live-verify recipes** (second isolated instance, `docs/dev/live-verify-second-instance.md`):

- **LV-P1W4-a.** (1) Launch with an empty `--user-data-dir`. (2) Start a session before
  dismissing anything; read `companionStatus()` over CDP. (3) Screenshot the toast. (4) Start a
  second session; wait for hello. (5) Hover both rows; screenshot. (6) Record `claude --version`.
- **LV-P1W4-b.** (1) Instance started with `HARNU_COMPANION_DEV=1`. (2) Start a session, confirm
  `live`. (3) Enable the test-only spinning hook (`HARNU_COMPANION_TEST_WEDGE`, dev only, never
  staged). (4) Wait 25 s. (5) Screenshot hover and System Monitor. (6) Remove the hook, let the
  mod reload, confirm the state is unchanged.
- **LV-P1W4-c.** (1) Add `"disableAllHooks": true` to a temp config dir's settings. (2) Spawn.
  (3) After 15 s read the state and the probe result. (4) Confirm one probe run in the log.
- **LV-P1W4-d.** (1) Add a second `--plugin-dir` with a mod that spins once in `tool.check`.
  (2) Trigger a tool call. (3) Read `bindingCounters` and the debug file.
- **LV-P1W4-e (managed machine, one run).** With a `--debug-file` on every spawn, record:
  (1) under `allowManagedModsOnly`: the state, the probe class and the refusal line; (2) under
  `sec-default` alone: `probes`, and whether it pins `$.command.register` (P4W2),
  `session.send` / `session.receive` (P2W3) and `model.fork` (P4W4); (3) under
  `disableSideloadFlags`: the exact exit text (Q6); (4) under a managed `disableAllHooks`:
  whether hooks passed through `--settings` still fire (P5W1); (5) the remote kill switch or a
  gateway served `off`, if reproducible: the probe class.

## 12. Docs deliverables

| Doc                            | Change                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                 | `Added`: the Harnu mod (what it is, the switch, the state line). Written for users.                  |
| `docs/harnu-features.md`       | none (not agent-facing).                                                                             |
| `docs/user/settings.md`        | The "Harnu mod" switch; what off means.                                                              |
| `docs/user/system-monitor.md`  | The Harnu mod state in the session row.                                                              |
| `docs/user/troubleshooting.md` | "Harnu mod: legacy" and each reason; managed machines; says plainly that sensors are observing only. |
| `design.md`                    | §6 Settings dialog, Hover preview, System Monitor, Toast; §8 wording.                                |
| i18n                           | The 27 keys of §10 in `en.json` and `pt-BR.json`, namespace `harnuMod.*`.                            |
| `01-contract.md`               | none: already merged (§7.7).                                                                         |

No new top-level component. This wave adds two top-level files under `src/main/`
(`claude-policy-probe-core.ts` and its shell `claude-policy-probe.ts`), so the user-docs gate
fires; the `troubleshooting.md` entry above (the `modsOff` and `remoteOff` reasons the probe
produces) satisfies it in this PR.

## 13. Rollout & parity gate

- This wave owns no fact family. It changes the shipped default from `off` to `shadow` for
  every family, behind the disclosure (ARB-6e). This is **OD-1** (master §13): the default the
  specs implement is "yes, loaded by default"; the alternative is opt-in.
- `shadow` is ARB-6b: no actuation and no authority for a family that has a legacy rival;
  sensors report and are recorded, never applied. Features with no fact family are governed by
  their own key (`registerPrefsKey`), the companion mode and the lease (contract §11.5).
- A family's flip to `active` is a later change to `DEFAULT_FAMILY_MODE`, made by that family's
  wave when `gateStatus` passes on a recorded ledger, and confirmed by the operator (ARB-6c/d).
- The `identity` rule is hosted here; its flip gate is P1W3 §13's.
- **Demotes:** nothing. Merge bar: QA-4 with `--with-e2e` and `--with-cli`.

## 14. Open questions

| #    | Question                                                                                                                                                                                                                                                                                                 | Fallback designed                                                                    | Owner |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| Q8   | One managed-machine run: the lines `allowManagedModsOnly`, `sec-default` and the remote kill switch produce for a `--plugin-dir` mod; whether `sec-default` pins `$.command.register`, `session.send`/`session.receive`, `model.fork`; whether `disableAllHooks` drops hooks passed through `--settings` | `unknown` → "the mod did not load"; AC-P1W4-18 (`disableAllHooks`), AC-P1W4-28 (run) | P1W4  |
| Q6   | The real `disableSideloadFlags` exit text                                                                                                                                                                                                                                                                | P1W2 detects by behaviour; LV-P1W4-e step 3 records the text                         | P1W4  |
| Q7   | A process that survives with the mod unloaded                                                                                                                                                                                                                                                            | Lease expiry → `legacy / unloaded`; AC-P1W4-22                                       | P1W4  |
| Q9   | An unattributable worker crash; three crashes blamed on one mod                                                                                                                                                                                                                                          | Any of them is a lease loss → sticky legacy; AC-P1W4-17, -19                         | P1W4  |
| Q10  | Where the switch lives before the Mods tab                                                                                                                                                                                                                                                               | Settled: General → Integrations; P4W1 moves it                                       | —     |
| Q28  | A `/resume` into a session live in another tab: re-key and close the other tab?                                                                                                                                                                                                                          | Default: no. The conflict leaves both rows and the binding on its current sid        | P1W4  |
| OQ-a | Does `claude plugin test` print the refusal lines for a staged dir with no tests, and is it affected by a gateway `off` like a session?                                                                                                                                                                  | `unknown` → `noHello` wording                                                        | P1W4  |

## 15. Risks

| Risk                                                     | Mitigation                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R17: loading the mod surprises users                     | Injection waits for the notice; kill switch; ARB-6e; OD-1                                                                                      |
| R5: a wedge skips the chain for one call                 | Lease is the only trusted signal; `bindingCounters` feeds P3W1's `contested`                                                                   |
| The hub extraction changes an observer's behaviour       | AC-P1W4-6: the existing suite runs unmodified; re-exports keep imports                                                                         |
| Two instances (dev, verify, production) run side by side | Prefs, ramp (`<userData>/projects.json`), socket and ledger are per `<userData>`; nothing is written to a shared file (lesson `framework/005`) |
| The ledger grows or leaks                                | Rotation, retention, scrub test (AC-P1W4-10)                                                                                                   |
| Sticky reversion hides a recoverable mod                 | By design (ARB-4c); the state line says why; a new session recovers                                                                            |
