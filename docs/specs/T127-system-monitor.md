# T127 — System Monitor: a fleet task-manager pane

> Status: **approved (design)** · 2026-07-14 · supersedes the backlog card
> `expose-hibernation-policy-maxlive-lruidlems-hardidlems-in-settin`, which is folded in as slice S4.

## 1. Why this exists

On **2026-07-14** Capy's main process died with a V8 heap OOM (~4 GB live heap). It took every open
session down with it; MCP calls hung for minutes and the sidebar froze beforehand. The fix wave landed,
but the operator had **zero visibility while the incident was forming**. Nothing in the product showed
heap growth, per-session memory, or a rising process count.

There is a second, quieter gap. **T119 session hibernation** (`src/main/fleet-policy.ts`) parks sessions
invisibly: `maxLive: 5`, a 15-minute LRU idle threshold, a 60-minute hard sweep. A session simply stops
being live, and the product never says why, never says who is next, and never shows what the parking
bought. The policy is also unconfigurable — the three constants are hardcoded and the only way to change
them is to edit `DEFAULT_POLICY` and rebuild. T119's own spec (§7, §11) lists "Settings: `maxLive`,
`hardIdleMs` configurable" as a required deliverable that was never built.

This feature closes both gaps with one surface: **the System Monitor** — a Chrome-task-manager-style view
of every session's resource cost and health, live.

## 2. The one hard rule

`docs/specs/T123-fleet-index-and-visibility-window.md` §11 ("Observability seams") pins the data contract:

> no polling consumer may ever trigger a scan or any other work; it reads state that updates as a side
> effect of work that was happening anyway

**A monitor that causes load is the disease it diagnoses.** Concretely, in this feature:

- **Never** call `scanFolders()`, read a JSONL transcript, or run a git probe.
- The session list comes from `livePtyDescriptors()` — a read of the in-memory `Map<ptyId, PtyRec>` in
  `src/main/pty.ts` — joined with `hibernatedKeys()`, a read of the in-memory `Set` in
  `src/main/hibernation.ts`.
- The only disk touched is `/proc`, which is a memory-backed pseudo-filesystem.

Any reviewer should treat a violation of this section as a blocking finding.

## 3. Scope (approved: C+)

The operator confirmed the widest scope, **observe + act + explain, plus the policy editor**:

- **Observe** — per-Electron-process and per-session CPU/memory, live; main-process heap used vs limit.
- **Explain** — why each session is live or parked, who the next sweep candidate is, and how much RAM
  hibernation has saved.
- **Act** — per-row park-now and close; wake reuses the existing "select the session" path.
- **Configure** — `maxLive`, `lruIdleMs`, `hardIdleMs` editable in Settings, persisted, no rebuild.

## 4. Placement (approved: hybrid)

Three surfaces, each doing what it is good at.

| Surface                     | What it carries                                                                                                                 | Precedent            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Footer** (always visible) | The heap gauge, grafted into the existing fleet pill. Turns amber/red when heap-used crosses a threshold. Also the entry point. | `StatusFooter.vue`   |
| **Takeover** (opened)       | The full two-group table: processes, sessions, children, per-row actions.                                                       | `UsageDashboard.vue` |
| **Settings tab** (opened)   | The hibernation policy editor. Config belongs in Settings, not on a telemetry screen. Deep-linked from the takeover.            | `SettingsDialog.vue` |

### 4.1 Row model — two groups

The Electron processes belong to no session, and the **main process is precisely the one that OOM'd**. A
session-only table would have no home for the process that caused the incident. So the table has two
groups:

```
┌─ Capy ────────────────────────────────────────┐
│ main          4%   1.2 GB   heap ▓▓▓▓▓▓░ 78% ⚠︎ │
│ renderer      8%   410 MB                      │
│ GPU           2%   180 MB                      │
│ network       0%    40 MB                      │
├─ Sessions ────────────────────────────────────┤
│ ▾ capy/main   12%   340 MB   live              │
│    └ claude    9%   280 MB                     │
│    └ node      3%    60 MB                     │
│ ▾ om2tab       0%      —     parked ⓘ          │
│     idle 22min · LRU · saved ~290 MB           │
└───────────────────────────────────────────────┘
```

A **parked session is a row with no processes** — CPU and RAM render as an em-dash, and the row carries
the explanation instead. That is deliberate: it is the only place the product can show what hibernation
bought.

## 5. The two cadences

This is the load-bearing decision. The brief's rule is "the sampler runs only while the pane is visible" —
but an early-warning signal that requires you to already be looking at it would not have caught the
2026-07-14 incident, because the pane was not open. The operator explicitly approved the exception below.

|              | Heartbeat                                                       | Full sampler                           |
| ------------ | --------------------------------------------------------------- | -------------------------------------- |
| **Runs**     | Always                                                          | Only while the takeover is visible     |
| **Interval** | 30 s                                                            | 1–2 s                                  |
| **Reads**    | `v8.getHeapStatistics()` only                                   | `+ app.getAppMetrics()` `+ /proc` walk |
| **Cost**     | Negligible — no `/proc`, no process walk, no allocation of note | Bounded by the live PTY count          |
| **Channel**  | `monitor:heap`                                                  | `monitor:sample`                       |
| **Feeds**    | The footer gauge                                                | The takeover table                     |

The full sampler is started on the takeover's mount and stopped on unmount **and on window blur/hide**. It
is refcounted, so a double-start is safe and a stray stop cannot silence a still-open pane.

## 6. Architecture

Pure cores at the leaves, thin shells at the edge — per `docs/adr/0001-coverage-as-reliable-regression-gate-for-agent-written-code.md`,
and following the template that already exists in `src/main/detect/foreground-process.ts` (a pure
`parseTpgid` + a thin `readFileSync` shell). That split is what makes `fleet-policy` testable without fake
timers, and it is the posture this feature matches.

### 6.1 Pure modules (unit-tested, framework-free, clock injected)

| Module                                | Contract                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/monitor/proc-parse.ts`      | Raw `/proc/<pid>/stat` and `/proc/<pid>/statm` text → `{ utime, stime, ppid, comm, rssBytes }`. No I/O.                                                                              |
| `src/main/monitor/cpu-delta.ts`       | `/proc` reports **cumulative** jiffies; CPU% is the derivative between two samples. `(prev, curr, ticksPerSec, coreCount) → cpuPct`. No `Date.now()` inside — timestamps are inputs. |
| `src/main/monitor/aggregate.ts`       | A flat process list plus a root pid → the subtree total. Pure tree fold.                                                                                                             |
| `src/main/monitor/thresholds.ts`      | `heapStatus(usedBytes, limitBytes)` → `'ok' \| 'warn' \| 'critical'`. Defaults: **warn at 70%**, **critical at 85%** of the limit.                                                   |
| `src/main/fleet-policy.ts` (extended) | New sibling `explainFleet(sessions, now, policy)` → per session `{ sessionKey, parkable, idleMs, reason, sweepRank }`.                                                               |

**On `explainFleet`.** `evaluateFleet` today returns only a `string[]` of session keys to park — no reason,
no score, no candidate ranking. "Explain" is therefore not a free read; it needs a richer return.
`evaluateFleet` **is reimplemented on top of `explainFleet`** so there is exactly one source of truth for
the policy. Its existing `string[]` contract — consumed by `pty.ts:529` — does not change, and its
existing tests must still pass untouched.

### 6.2 Thin shells (at the edge, not unit-tested)

| Module                           | Role                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/monitor/proc-linux.ts` | `readFileSync` over `/proc` plus the child walk, behind a `ProcessSampler` interface.                                                                                                                                                               |
| `src/main/monitor/sampler.ts`    | Owns both intervals; joins `getAppMetrics()` + `getHeapStatistics()` + the walk into one payload; owns the start/stop refcount.                                                                                                                     |
| `src/main/pty.ts`                | **One new export**: `livePtyDescriptors(): { ptyId, sessionKey, pid, kind, startedAt, lastActivityAt }[]`. Read-only. Nothing today exposes the fleet with pids — `PtyRec` does not even store `cwd`, and `pid` is reachable only as `rec.pty.pid`. |

**Platform seam.** `createSampler()` returns the Linux implementation on Linux and a `NullSampler`
elsewhere. **Stated cost, accepted:** on macOS and Windows the _Sessions_ group ships showing **state but
no consumption numbers** until someone writes an adapter. The _Capy_ group is correct on all three
platforms, because `app.getAppMetrics()` is cross-platform. This is the same Linux-first-with-a-fallback
posture `detect/foreground-process.ts` already takes. `pidusage` was considered and rejected: on macOS and
Windows it shells out to `ps`/`wmic` on every tick, and a monitor that spawns a process per tick edges
toward being the disease it diagnoses.

### 6.3 Transport

**Correction to the original brief:** it says to mirror `pty:data:<uuid>`. That pattern **no longer
exists** — it was deleted in favour of a single multiplexed channel with preload-side fan-out
(`src/preload/index.ts:330-375`), precisely to kill the "N listeners per PTY" problem. Do **not**
reintroduce a per-id channel.

Copy instead the generic helper already at `src/preload/index.ts:711`:

```ts
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}
```

| Channel                                   | Direction              | Purpose                                        |
| ----------------------------------------- | ---------------------- | ---------------------------------------------- |
| `monitor:sample`                          | main → renderer (push) | The full sample. One channel, one payload.     |
| `monitor:heap`                            | main → renderer (push) | The cheap heartbeat.                           |
| `monitor:start` / `monitor:stop`          | `ipcMain.handle`       | Refcounted control of the full sampler.        |
| `monitor:park`                            | `ipcMain.handle`       | Park one session now. Reuses `hibernation.ts`. |
| `monitor:policyGet` / `monitor:policySet` | `ipcMain.handle`       | Read/write the persisted policy.               |

**Wake and close introduce no new verbs** — wake is the existing "select the session" path, close is the
existing `closeSession`.

### 6.4 The payload — the contract between S1 and the UI slices

S1 owns these types and exports them; S2, S3, and S4 consume them and **must not redefine them**. This is
the seam across which independently-built slices meet, so it is pinned here rather than left to whoever
writes it first.

```ts
/** Pushed on `monitor:heap` every 30 s, always. */
export interface HeapSample {
  atMs: number
  usedBytes: number
  limitBytes: number
  status: 'ok' | 'warn' | 'critical' // from thresholds.ts
}

/** One OS process — an Electron process or a session's child. */
export interface ProcSample {
  pid: number
  name: string // 'main' | 'renderer' | 'GPU' | ... for Electron; comm for /proc
  cpuPct: number | null // null when the platform sampler cannot measure (macOS/Windows)
  rssBytes: number | null
}

/** One session row. `procs` is empty and costs are null when parked. */
export interface SessionSample {
  sessionKey: string
  kind: string // PtyKind
  state: 'live' | 'parked'
  cpuPct: number | null // subtree total, from aggregate.ts
  rssBytes: number | null
  procs: ProcSample[]
  /** From explainFleet — why this row is in the state it is in. */
  idleMs: number
  parkable: boolean
  reason: string // e.g. 'lru' | 'hard-idle' | 'selected' | 'not-parkable'
  sweepRank: number | null // 1 = next to be swept; null = not a candidate
  savedBytes: number | null // RSS reclaimed by parking, if known
}

/** Pushed on `monitor:sample` every 1–2 s, only while the takeover is visible. */
export interface MonitorSample {
  atMs: number
  heap: HeapSample
  capy: ProcSample[] // the 'Capy' group — from app.getAppMetrics()
  sessions: SessionSample[] // the 'Sessions' group
  counters?: FleetCounters // §6.5 — absent today
}
```

Every cost field is `| null`, not `0`. A `NullSampler` platform and a genuinely-idle process must not
render the same, and a parked session's cost is _unknown_, not _zero_. The UI renders `null` as an
em-dash.

### 6.5 Slots for the T123 §11 counters

The sample payload carries an **optional** `counters?: { fleet?, scanner?, window?, deadline? }` block.
**None of these exist today** — `fleet-model.ts` exposes only `__fleetScanStatsForTests()` returning
`{ fullScans, slugScans }`, which is a test-only seam. S4's `inFlightToolCalls` / `timeoutsFired` do not
exist at all.

The UI renders an em-dash placeholder when the block is absent. **This feature does not build those
counters** — that is T123 S2/S3/S4's work. Wire them when they land.

## 7. Renderer

| File                                                    | Role                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/renderer/src/stores/monitor.ts`                    | Subscribes to both channels, holds the last sample, derives sorted rows. |
| `src/renderer/src/components/SystemMonitor.vue`         | The takeover.                                                            |
| `src/renderer/src/components/SystemMonitorRow.vue`      | One row — a process, a session, or a session's child.                    |
| `src/renderer/src/components/HeapGauge.vue`             | The footer gauge, grafted into `StatusFooter.vue`'s existing fleet pill. |
| `src/renderer/src/components/HibernationPolicyPane.vue` | The Settings tab.                                                        |

**Two hand-rolled registries must be edited on both sides** — this is a known sharp edge, not a surprise:

- The **takeover mutex** in `stores/ui.ts` is hand-rolled: `openUsageDashboard()` closes the roadmap and
  vice-versa. A third takeover must be added to _both_ sides of that mutex, plus the `v-if`/`v-else-if`
  chain in `App.vue:677`.
- **Settings tabs** are registered in two places: the `SettingsTabId` union in `stores/ui.ts:27` **and**
  the literal `tabs` array in `SettingsDialog.vue:66`. There are 12 tabs today; this adds a 13th.

## 8. Delivery slices

| #      | Slice                                                                                                                            | Base   | Touches                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| **S1** | Main core: `monitor/**` pure modules + `proc-linux` shell + sampler + both cadences + `explainFleet` + IPC + preload. **No UI.** | `main` | `src/main/monitor/**`, `fleet-policy.ts`, `pty.ts` (one export), `src/preload/index.ts`, `tests/monitor-*.test.ts` |
| **S2** | The takeover: `SystemMonitor.vue`, rows, store, `ui.ts` mutex, `App.vue`.                                                        | S1     | renderer, `design.md` §6, i18n, `docs/user/`                                                                       |
| **S3** | The footer heap gauge.                                                                                                           | S2     | `StatusFooter.vue`, `HeapGauge.vue`                                                                                |
| **S4** | Per-row actions (park/close) + the hibernation policy Settings tab.                                                              | S2     | `SettingsDialog.vue`, `HibernationPolicyPane.vue`, persistence                                                     |

S3 and S4 run **in parallel** off S2 (operator-approved). They collide only in trivial append regions of
`en.json`, `pt-BR.json`, `design.md`, and `CHANGELOG.md`; whichever lands second rebases.

## 9. Repo contracts — per PR, all mandatory

- **`CHANGELOG.md`** — a dated, user-facing entry in every slice.
- **i18n** — every new key in **both** `en.json` and `pt-BR.json`, same change. The schema is
  `typeof en`, so a missing `pt-BR` key **breaks the `vue-tsc` build**.
- **`design.md` §6** — updated **before** any Vue file is touched, for every new component.
- **`docs/user/`** — a page for the monitor. This is a new user-visible surface, and the
  `user-docs-gate` CI check fails a new top-level component without it.
- **`docs/capy-features.md`** — **not touched.** The monitor is an operator-only pane; it adds no MCP verb
  and nothing an agent can call or offer. Per CLAUDE.md's litmus, this is _out_.
- `npm run typecheck` and `npm run build` green before any slice claims done.

## 10. Definition of done

- [ ] The takeover shows both groups; numbers move on a live fleet.
- [ ] The full sampler **stops** when the pane closes or the window blurs — verifiable by the absence of
      `monitor:sample` traffic.
- [ ] The heartbeat keeps running with the pane closed, and the footer gauge crosses to amber at 70%.
- [ ] A parked session renders with an em-dash cost, its reason, and the RAM it saved.
- [ ] Park-now on a row actually parks it; the row updates on the next sample.
- [ ] Editing `maxLive` in Settings changes real behaviour without a rebuild.
- [ ] No code path in this feature reaches `scanFolders`, a JSONL read, or a git probe.
- [ ] Live-verified against a real multi-session app per `docs/dev/live-verify-second-instance.md`.
