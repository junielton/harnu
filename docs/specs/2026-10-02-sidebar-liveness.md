# Spec: sidebar liveness — rows appear on time, idle CPU drops

> **Status:** Revised after independent review (stage 2 of mission `mnt-f6a013cc`) — every
> finding and its disposition is in §10. Implementation plan:
> [`docs/plans/2026-10-02-sidebar-liveness.md`](../plans/2026-10-02-sidebar-liveness.md).
> **Created:** 2026-10-02
> **Integration branch:** `feat/sidebar-liveness` (cut from `origin/main` at `e06b84a7`)
> **Cards:** BUG-147 (late rows), BUG-146 (idle CPU), T388 (always list a repo's git
> worktrees — operator decision). Reconciles with T123 (§8).
> **Evidence:** every number below was measured on 2026-10-02 against `e06b84a7` on an
> isolated second instance (own `userData`, own CDP/inspector ports, never the
> operator's running Capy). Harness and synthetic results:
> [`scripts/dev/liveness-bench/`](../../scripts/dev/liveness-bench/README.md).

---

## 0. Summary

The operator's complaint — "the sidebar takes long to show new folders, worktrees and
sessions" — has three independent causes, and the measured reality is worse than
"long": **in the current build a session started outside Capy never appears on its own
(0 of 6 trials within 20 s)**; it shows up only when some _later_, unrelated event
triggers a renderer reload. A worktree created with `git worktree add` never appears at
all, not even after Rescan.

Idle CPU has two big causes, and the biggest one was not on either card: **infinite
`box-shadow` CSS animations (the green "active" pulse dot) repaint every frame and cost
~20 points of renderer CPU plus ~8 points of GPU-process CPU**, GPU compositing on. The
second is the one BUG-146 predicted: every JSONL append triggers a slug rescan that
re-reads every subagent header in the slug from disk — 48,000 header reads per minute on
a synthetic 8-appends/s load, ~39% main-process CPU.

The fix is eight small units (one of them the measurement harness), each ≤ ~500 lines:

| Concern                    | Fix                                                                                                                          | Unit     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| (a) rows appear late/never | main pushes `fleet:changed` when the model's _membership_ changes; renderer reloads on it; `addDir` schedules a slug refresh | U1       |
| (b) worktrees never listed | main tracks the git worktrees of every repo the sidebar shows (one `fs.watch` + one `git worktree list` per change)          | U4a, U4b |
| (c) main CPU               | cache subagent headers; incremental JSONL header scrape; append-class refresh cadence                                        | U2, U3b  |
| (c) IPC + renderer CPU     | stop shipping `newLines` (27 MB measured in one event pair); coalesce per session; bounded first-append replay               | U3a      |
| (c) renderer/GPU CPU       | rewrite the pulse animation compositor-only (transform + opacity on a pseudo-element)                                        | U5       |

---

## 1. Problem and measured baseline

### 1.1 How it was measured

- **Build:** `electron-vite build` of `e06b84a7`, run unpackaged from `out/`.
- **Isolation:** `--user-data-dir=<scratch>/ud*`, page CDP on `:9347`, main-process
  Node inspector on `:9348`, static renderer on `127.0.0.1:5187`
  (`ELECTRON_RENDERER_URL`). Ports verified free before and after; only the PIDs this
  session spawned were killed.
- **Two datasets.**
  - _Real_: the operator's actual `~/.claude/projects`, read-only — 338 slugs, 10,898
    JSONLs (1,101 of them subagent transcripts), 3.1 GB. Load = whatever the operator's
    own sessions were doing, so it varies minute to minute.
  - _Synthetic_ (fake `HOME`, reproducible): 31 slugs, 1,000 JSONLs — one "heavy" slug
    with 300 transcripts of ~180 KB and 400 subagent transcripts (40 parents × 10), plus
    30 light slugs × 10 sessions. **Load = 8 appends/s** (2 sessions + 2 subagents in
    the heavy slug, each appending every 500 ms). Generator: `scripts/dev/liveness-bench/fixture.mjs`.
- **CPU** = `utime+stime` delta from `/proc/<pid>/stat` over the window, per process of
  the instance's tree. **Main-process counters** = conditional "logpoint" breakpoints set
  through the inspector at bundle lines (`scripts/dev/liveness-bench/measure.mjs`). **Renderer counters** =
  fresh `window.api.on*` subscriptions (`window.api` is frozen; it cannot be patched).
  **Profiles** = CDP `Profiler` at 500 µs sampling, main and renderer at once.
- **Dev-mode caveat.** Passing `--remote-debugging-port` makes `IS_DEV` true
  (`src/main/index.ts:28`), which calls `app.disableHardwareAcceleration()`. So the
  page-CDP runs are **GPU-off (software raster)**. Every animation number was therefore
  re-measured **GPU-on** (no page CDP; CSS injected through the main inspector with
  `webContents.insertCSS`) — `scripts/dev/liveness-bench/gpu.mjs`. Both are reported.
- **"GPU process" label.** The baseline bench read process types from `/proc/<pid>/cmdline`. With
  `--no-sandbox` the GPU process is forked from the zygote and keeps the zygote's argv, so
  the raw results label it `zygote`. It was identified as the GPU process by being the
  zygote's only non-renderer, non-utility child and by its CPU tracking compositing
  (≈ 0 with animations off). U0 replaces the `/proc` guess with Electron's
  `app.getAppMetrics()` (`type: 'GPU'`).

### 1.2 Baseline numbers

**Liveness (synthetic HOME, dev instance).**

| Scenario                                                              | Trials | Row in store within 20 s              |
| --------------------------------------------------------------------- | ------ | ------------------------------------- |
| New session (`entrypoint: cli`) in a folder the sidebar already shows | 3      | **0 / 3** (appends every 2 s)         |
| New slug dir + first JSONL (new folder)                               | 3      | **0 / 3**                             |
| `git worktree add` on a repo the sidebar shows (no session)           | 1      | **0 / 1** — still absent after Rescan |

The main-process model _did_ have every new session: `foldersLoad()` returned 7 sessions
while the store held 6. Each trial's row appeared only when the **next** trial's
`session:added` triggered a reload — exactly "rows appear at the next unrelated reload".

**CPU — synthetic dataset, 8 appends/s.**

| Measure                                                    | Value                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Idle, no load, animations off (main / renderer)            | 0.6% / 2.1%                                                                       |
| Under load, animations off, GPU off (main / renderer)      | **38.8%** / 6.3%                                                                  |
| Under load, GPU on, animations on (main / renderer / GPU)  | 26.3–35.1% / **20.6–26.9%** / **6.4–8.8%**                                        |
| Under load, GPU on, animations off (main / renderer / GPU) | 30.6% / 6.4% / 0.8%                                                               |
| Slug passes                                                | 2.0 /s (120 per 60 s)                                                             |
| Slug pass duration (heavy slug)                            | p50 72.5 ms · p90 102.7 ms · max 135.8 ms                                         |
| Pass time per minute                                       | 9.4 s                                                                             |
| `notifySlug` calls                                         | 480 /min (one per append)                                                         |
| Subagent header reads (`scrapeSubagentHeader`)             | **48,000 /min** — 400 per pass, i.e. every file, every pass                       |
| JSONL header cache misses (full re-scrape)                 | 240 /min (the two active transcripts, every pass)                                 |
| `git rev-parse` spawns                                     | 1 /min                                                                            |
| `session:updated` / `subagent:updated` IPC                 | 240 + 240 /min, ~1.4 KB each (small appends)                                      |
| Main JS profile                                            | 85% idle samples; `scrapeSubagentHeader` 5.4% inclusive; path/buffer helpers next |

Main-process CPU is ~39% while JS is ~15% busy: the rest is libuv threadpool work for the
`open`/`read`/`stat`/`readdir` syscalls each pass issues (400 subagent opens + reads of
64 KB, 300 stats, 40 subagent-dir readdirs) — the cost is the I/O fan-out, not parsing.

**CPU — real dataset.**

| Measure                                                            | Value                                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Light load (~0.3 slug pass/s), dev: main / renderer                | 5.7–9.0% / 38.6–42.5% (3 pulse dots + 2 spinners)                                                                 |
| Same, animations off: main / renderer                              | **3.1% / 1.4%**                                                                                                   |
| GPU on, 1 pulse dot + 1 spinner: renderer / GPU proc               | 22.9–26.6% / 8.8–10.5%                                                                                            |
| GPU on, animations off: renderer / GPU proc                        | **4.0% / 0.6%**                                                                                                   |
| Per-animation share (dev, GPU off, 3 dots): pulse-dot / spin       | ~33 points / ~8 points of renderer CPU                                                                            |
| Light-load slug pass                                               | p50 5.4 ms · p90 28 ms                                                                                            |
| Subagent-heavy slug active (a slug with ~390 subagent transcripts) | 1.0–2.3 passes/s, p50 137 ms, p90 177 ms, max 330 ms; 15,922 subagent header reads/min; main 25% (animations off) |
| `session:updated` payload                                          | **two events carried 27.7 MB of `newLines`** (§2, R4)                                                             |
| Full scan (Rescan, warm header cache)                              | 2,762 ms; Rescan runs **two** concurrent full scans; `rescan()` resolves in 2,844 ms                              |
| Boot → first model in the store (cold)                             | 11.1 s                                                                                                            |
| Renderer `reloadModel()` (312 folders, 1,218 sessions)             | 68–106 ms, of which `foldersLoad` IPC 63 ms (2.1 MB payload)                                                      |

The operator's own `top` on 2026-09-30 (~13% main, ~29% in a child process) is
consistent with both halves: the "child" is the renderer and/or GPU process paying for
the animations, the main share is the watcher-driven rescans.

### 1.3 What we are fixing for, in one line each

- A new session, folder or worktree shows up **within about a second**, without Rescan.
- With nothing happening, Capy costs **almost nothing** (≤ 1% main; ≤ 8% renderer and
  ≤ 3% GPU process with live dots on screen, GPU on — the AC-23 targets).
- Under a busy fleet, main CPU stops scaling with "files in the slug × appends per second".

---

## 2. Root causes — the cards checked against the code

Each cause the cards named was re-traced at `e06b84a7`. Verdicts: **confirmed**,
**corrected**, or **new** (not on any card).

| ID     | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verdict                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **Stale read, no retry.** `session:added` → `reconcileSessionAdded` (`sessions.ts:4721`) → `reloadModel()` → `foldersLoad` (`index.ts:745`) returns the model's memoized array (`fleet-model.ts:82-83`). The model refreshes only after a fixed 250 ms window (`fleet-model.ts:54`) plus the slug scan, so the read is stale. Nothing retries: `onSessionUpdated` drops unknown ids unless the append is a `/rename` (`sessions.ts:4983`), and main has no "fleet changed" channel (preload exposes only `claude:*`, `src/preload/index.ts:1614-1630`). | **Confirmed** — and the effect is "never", not "late" (§1.2).                                                                                                               |
| **R2** | **`addDir` doesn't schedule a model refresh.** `claude-watcher.ts:688-693` sends `claude:project:added` but never `notifySlug`. The renderer's 250 ms trailing debounce (`sessions.ts:4188`, wired at `:4912`) reads the model before the refresh the _session_ add schedules has landed.                                                                                                                                                                                                                                                               | **Confirmed.** The card says it "usually loses" the race; measured, it lost **3 / 3**.                                                                                      |
| **R3** | **The sidebar never enumerates git worktrees.** Folders come only from transcripts (`scanFoldersUncached`) and pins/adoptions. `worktree:list` exists (`worktree-ipc.ts:1717`) but only dialogs and MCP `list_worktrees` (`collectWorktreeListing`) use it. And even if a sessionless folder reached the store, `classifyFolder` (`src/renderer/src/stores/folder-zones.ts:154`) drops it: _empty + unpinned → stale_.                                                                                                                                  | **Confirmed**, with a path correction: `folder-zones.ts` lives in `stores/`, not `components/`. The second half (the classify rule) is not on the card.                     |
| **R4** | **First append after boot replays the whole transcript over IPC.** Production starts the watcher with `skipSeed: true` (`index.ts:755`), so tail offsets are never primed. The first `change` on any pre-existing transcript takes the `missedAdd` branch (`claude-watcher.ts:799`), tails from byte 0 — no cap — and ships the entire file as `newLines`. Measured: two events carried 27.7 MB.                                                                                                                                                        | **New.** BUG-146 attributed the payload to "tool outputs"; the dominant term is this replay.                                                                                |
| **R5** | **Infinite `box-shadow` animation.** `.anim-pulse-dot` (`main.css:187-189`) animates `box-shadow` (`main.css:117-125`, mirrored in `design.md` §6 "Pulse animation"). `box-shadow` is not compositor-animatable, so every frame repaints. 20 call sites use it. The `spin` on `.fleet-ring-arc` (`main.css:511-515`) costs less but is not free.                                                                                                                                                                                                        | **New** — the largest single idle-CPU term measured.                                                                                                                        |
| **R6** | **Per-append slug rescan.** Every session/subagent `change` calls `notifySlug` (`claude-watcher.ts` change handler), and `drainRefresh` (`fleet-model.ts:201`) runs passes back to back while events keep arriving. Each pass: re-reads a 64 KB head of **every** subagent file with no cache (`scrapeSubagentHeader`, `claude-reader.ts:965`, called from `attachSubagents` `:1044`); stats every JSONL; fully re-scrapes each grown transcript (2 MB head + 512 KB tail when large) because the header cache keys on `(mtimeMs, size)` (`:757`).      | **Confirmed.** Corrected detail: `existsSync` per folder (`:1237`) is slug-scoped on an incremental pass (1–2 calls) — negligible.                                          |
| **R7** | **Rescan runs two full scans.** `claude:rescan` (`index.ts:770-773`) calls `notifyWatcherReady()` (schedules the model's full rescan) _and_ `scanFoldersUncached({})` in parallel. Measured: two full scans starting 95 ms apart, 2.76 s each.                                                                                                                                                                                                                                                                                                          | **Confirmed.**                                                                                                                                                              |
| **R8** | **BUG-77 race.** The `change` handler checks `programmaticPaths.has(p)` at `claude-watcher.ts:792`, _before_ queueing on the per-path chain. A `change` that arrives while the `add` is still classifying passes that check; inside the chain `missedAdd` is false, so it never re-checks, and a `claude -p` transcript gets a `notifySlug` + `session:updated`.                                                                                                                                                                                        | **Confirmed by code.** Not observed in the measurement windows; cost is one wasted slug scan per affected append.                                                           |
| **R9** | **Renderer invalidation storm.** BUG-146 hypothesis 2: one deep-reactive mutation per append invalidates `triageQueue`, `boardBuckets`, `visibleFolders`, `sessionsForDisplay`.                                                                                                                                                                                                                                                                                                                                                                         | **Corrected — not dominant.** At 8 appends/s the renderer spends ≤ 8% CPU with animations off, `flushJobs` 4.2% inclusive. Worth trimming (§4.C3), not worth a restructure. |

**Not measured:** detached-PTY xterm writes (the harness instance had no PTYs open). See
§4.D, SW-5.

---

## 3. Decisions

**D1 — Push on membership change, not on every refresh.** `fleet:changed` fires only
when the set of `(folder path, session id)` pairs or a folder's git identity (branch,
`repoId`, `isMainWorktree`) changed. The signature is computed from the model's own
`state.sessions` + `state.gitByPath`, never by forcing `deriveFolders` on every pass.
(`diskExists` is not part of the model state — `deriveFolders` never sees it — so it
cannot be part of the signature either.) A full renderer reload costs
68–106 ms on the real dataset; pushing after every pass (up to 2.3/s measured) would
trade a liveness bug for a new CPU bug. Appends to known sessions already reach the
renderer through `session:updated`.

**D2 — The renderer reloads the whole model on `fleet:changed`; no delta protocol.**
`reloadModelOnce` already owns the merge with pins, synthetics, expand state and runtime
overlays. A delta protocol would duplicate that reconcile logic for a rate of events that
is, by D1, low (session/folder add/remove). Revisit only if U0's bench shows reloads
above ~1/s sustained.

**D3 — Sessionless worktrees are listed only for repos the sidebar already shows**,
and that "known repo" set is computed **without** the git-listed rows themselves.
Otherwise a repo would keep itself alive forever: its sessionless rows would make it
visible, which would keep its worktrees listed. "Shows" means: a folder of the repo is
**pinned** (or a user-project placeholder), or classifies active **on its own sessions**.
So a pinned repo always lists its worktrees, even when every session aged out.
**Remaining gap, recorded on purpose:** a repo with no pinned folder whose sessions all
aged out of the active window is not shown at all today (its own folders are stale), so
its worktrees are not listed either. "Always list" is read as "always list the worktrees
of a repo the sidebar shows"; listing every repo ever seen would mean unbounded spawns
and watches (§4.B alternatives).

**D4 — Worktree changes are observed with `fs.watch`, not polled.** `git worktree add`
creates `<common-dir>/worktrees/<name>/`; `git worktree remove`/`prune` deletes it. One
non-recursive watch on `<common-dir>/worktrees` (plus one on `<common-dir>` to catch the
`worktrees` dir appearing for a repo's first linked worktree) sees both. This is a new
watch surface, which the 2026-07-19 BUG-34 spec (D2) rejected for `.git/HEAD`. The
difference: that was a low-priority accuracy fix with a rescan fallback; this is an
operator decision ("always list") with no other event source short of polling.

**D5 — Stop sending `newLines`.** The renderer reads exactly two things from a session
delta (`custom-title` lines, and a first-prompt candidate when the row has none,
`sessions.ts:4963-5010`) and one from a subagent delta (`readAgentMeta`). Main derives
those and sends small fields instead. This removes the payload class, not just its
worst case.

**D6 — The pulse keeps its look.** Same color, same 1.8 s period, same expanding fade —
drawn on a `::after` pseudo-element animating `transform: scale()` and `opacity`, which
the compositor runs without a repaint. Removing or freezing the pulse is a product
change and is out of scope (§7).

**D7 — Append-class refreshes are rate-limited, membership-class ones are not.** The
model still needs append truth (`fileMtime`, `transcriptState`, `ctxPct`, …) for
`get_fleet`, but nobody needs it at 2 Hz per slug. Membership events keep today's 250 ms
window, so time-to-row is unaffected.

**D8 — A migrated row waits for model evidence, not for a timer.** A synthetic that
collapsed in place (`synthetic = false`, blank `fullPath`) is kept across reloads until
the model either **confirms** its id (in any folder) or **refreshes the slug of its folder
and omits it**. `fleet:changed` therefore carries which slugs it covered. This widens
BUG-88's one-reload grace in the only way that lesson allows: survival is gated on what
the model has seen, never on age (a 60 s cap is only a backstop against a lost push).
A row the model places under a different folder is dropped from the old one the moment
the model confirms it elsewhere — no cross-folder duplicate.

**D9 — Path identity is decided in main.** The renderer cannot `realpath`. Git prints
`C:/x/wt` where the transcript cwd says `C:\x\wt`; macOS lists `/private/var/...` for a
cwd of `/var/...`; a symlinked parent differs from its target. The worktree tracker
receives the repo's known folder paths and, for each listed worktree, reports the known
path when both resolve to the same directory (`normalizePath` from `user-projects.ts`:
resolve, normalize separators, strip trailing separator, `realpath`). A listed path that
matches no known folder is reported in its canonical form.

**D10 — Gating tests vs. bench evidence.** Every AC that names a machine number (a p95
latency, a CPU percentage) is split: a **gating** deterministic test (fake timers, counted
reads, counted events) that CI can hold, and a **non-gating** bench measurement that
goes in the delivery report (AC-30). A bench number below target is reported, not
hidden; it does not block the merge on its own.

---

## 4. Design

### 4.A Liveness push (BUG-147) — unit U1

**A1. Change detection (pure, `fleet-model-core.ts`).**

- `membershipSignature(state: FleetState): string` — stable string over the sorted
  `projectPath + '\0' + sessionId` pairs of `state.sessions` plus, sorted by path, each
  `gitByPath` entry's `gitBranch`, `repoId`, `isMainWorktree`. Computed from the state
  directly (D1, review finding 17), never via `deriveFolders`.
- `sessionEntriesEqual(a: SessionEntry, b: SessionEntry): boolean` — field-by-field
  equality of every `SessionEntry` field (scalars compared with `===`; `agents` compared
  by length and, per index, `agentId`, `fileMtime`, `status`, `task`, `model`;
  `stagnation` compared by JSON). Used by `mergeSlugSessions` (A2).

**A2. Version bump only on real change (`fleet-model-core.ts`).** `mergeSlugSessions`
returns the **same state object** (no `version` bump) when the slug's fresh sessions are
field-equal to the slug's current ones (same ids, `sessionEntriesEqual` for each) and
the fresh git meta equals the stored git meta for every path it touches. Any field
difference — including a `ctxPct`- or `fileMtime`-only change — bumps `version`, so
`get_fleet` never freezes on append truth (review finding 4). `replaceAllSessions` keeps
bumping unconditionally (full rescans are rare).

**A3. Change notification (`fleet-model.ts`).** API:

```ts
export interface FleetChange {
  version: number
  /** Slugs whose refresh produced this change; empty when `full` is true. */
  slugs: string[]
  /** True when a full rescan (boot, ready, degraded poll, Rescan) produced it. */
  full: boolean
}
export function onFleetChanged(listener: (c: FleetChange) => void): () => void
export function requestFullRescan(): Promise<FolderEntry[]>
```

After the boot scan and after every `drainRefresh` iteration, compare
`membershipSignature(state)` with the last emitted one; on a difference, emit
`{ version, slugs, full }` where `slugs`/`full` accumulate **every** refresh since the
previous emit (a refresh that changed nothing still counts as "the model looked at this
slug" for D8). Listener throws are logged, never break the drain. `requestFullRescan`
sets `fullRescanRequested`, schedules the drain, and resolves with `currentFolders()`
once the drain that consumed the request finishes.

**A4. Wire (`index.ts`, preload).** `index.ts` registers one `onFleetChanged` listener →
`mainWindow.webContents.send('fleet:changed', change)`. Preload: `onFleetChanged(cb)`.
`claude:rescan` becomes `return requestFullRescan()` — one full scan (SW-1).

**A5. `addDir` (`claude-watcher.ts:688`).** After `send('claude:project:added', …)`,
call `notifySlug(c.slug)`.

**A6. Renderer reload on push (`sessions.ts`).**

- `onFleetChanged` → `reloadOnFleetChange(change)`: **leading edge** when no reload ran
  in the last 250 ms, else trailing; **max-wait 1 s** (review finding 17). The same
  max-wait is added to `reloadModelDebounced` (it is a pure sliding debounce today).
  Accumulated `change.slugs`/`full` since the last reload are passed into the reload
  (D8 needs them).
- `reconcileSessionAdded`'s fallback (`sessions.ts:4736-4741`) **no longer calls
  `reloadModel()`** — that read is stale by construction (R1). It records
  `pendingCollapse.set(sessionId, Date.now())` and returns; the push brings the row
  (review finding 3).

**A7. Collapse before commit (`sessions.ts`) — review finding 1.** In
`reloadModelOnce`, **before** the synthetic re-inject loop and before `commitFolders`:
for every `pendingCollapse` id present in `merged`, find the newest still-open,
non-terminal synthetic in the same folder of `folders.value`; if one exists, run the
_duplicate_ branch of `collapseSyntheticInto` against the merged real row — carry
`spawnedBy`, move selection, `fireMigrate(synthId, realId)`, add to `bornSyntheticIds`,
`reportMaterialized` for agent synthetics — and **skip re-injecting that synthetic**.
That branch is extracted into
`absorbSyntheticIntoRealRow(synth: Session, realRow: Session, folderPath: string)` and
shared with `collapseSyntheticInto`. Ids absent from `merged` stay pending; ids older
than `SYNTH_RESOLVE_WINDOW_MS` are dropped. One commit, one row — no frame shows both.

**A8. Migrated rows wait for evidence (`sessions.ts`) — D8, review finding 2.**
`awaitingConfirm: Map<realId, { folderPath: string; since: number }>`, filled by the
in-place branch of `collapseSyntheticInto` and by `tryBindAgentMigration`. In
`reloadModelOnce`:

- id present anywhere in `merged` → confirmed: delete from the map, ordinary reconcile.
- id absent and the reload's coverage (`full`, or `slugs` containing
  `encodePathToSlug(folderPath)`) includes its folder → the model looked and it is not
  there: delete from the map, let the ordinary reconcile drop it (BUG-88 AC-7 parity).
- otherwise → re-inject the live row object into its folder in `merged` (same object:
  selection and the PTY keyed by `sessionId` ride along).
- `since` older than 60 s → drop from the map (backstop only).

**Latency budget** (existing folder): 250 ms model window + slug pass (p50 72 ms on the
heavy synthetic slug today, ≤ 25 ms after U2) + push + leading-edge reload 68–106 ms ≈
**0.4–0.5 s**. New folder adds one cold `git rev-parse` (500 ms timeout cap) ≈ **≤ 1 s**.

**Alternatives rejected.**

- _Renderer polls the model version._ BUG-147 AC-4 forbids polling; it also adds idle cost.
- _`foldersLoad` waits for pending refreshes._ Fixes the add path only; refreshes with
  no watcher event behind them (git probe, `ready`, degraded poll) still never arrive.
- _Push the changed folders as a delta._ See D2.
- _A time-based grace for migrated rows._ Rejected by the `synthetic-sessions/001`
  lesson; D8 gates on model evidence instead.

### 4.B Always-listed git worktrees (T388) — units U4a, U4b

**B1. Tracker core (new `src/main/worktree-tracker.ts`, U4a — no hub files).**

```ts
export interface TrackedRepo {
  repoId: string // realpath'd git common dir, as GitMeta.repoId
  probePath: string // any existing folder of the repo, for `git -C`
  memberPaths: string[] // the repo's folder paths the renderer knows (for D9 matching)
}
export interface TrackedWorktree {
  path: string // a memberPaths entry when it is the same directory (D9), else canonical
  branch: string
  isMainWorktree: boolean
  locked: boolean
}
export interface WorktreeTrackerDeps {
  listWorktrees(probePath: string): Promise<WorktreeListEntry[]>
  canonicalize(p: string): Promise<string> // user-projects.ts normalizePath in production
  watch(dir: string, onEvent: (event: string, filename: string | null) => void): { close(): void }
  stat(dir: string): Promise<{ mtimeMs: number } | null>
  onFocus(cb: () => void): () => void
  now(): number
}
export function createWorktreeTracker(
  deps: WorktreeTrackerDeps,
  emit: (repoId: string, entries: TrackedWorktree[]) => void
): { track(repos: TrackedRepo[]): void; close(): void }
```

- `track` is an idempotent set replace. New repo → list once, arm watches. Dropped repo →
  close its watches, forget its listing. Changed `memberPaths` → re-match without a
  re-list.
- Listing: `git -C <probePath> worktree list --porcelain` through `listWorktrees`
  (exported from `worktree-ipc.ts`), parsed by `parseWorktreeList` in
  **`worktree-core.ts`** (review finding 11), which gains `prunable` and `locked`
  fields. Bare and prunable entries are dropped by the tracker. **One spawn per repo per
  change burst**, regardless of worktree count.
- Watches (D4): `<repoId>/worktrees` (entry add/remove) and `<repoId>` filtered to the
  `worktrees` entry (first linked worktree creates the dir). Events → **500 ms trailing
  debounce per repo** → single-flight list → `emit` only when the matched entries changed.
- Platform rules (review finding 13): when `<repoId>/worktrees` reports `rename` for
  itself or disappears, **close that watch immediately** (on Windows a held handle leaves
  the dir delete-pending and the next `git worktree add` hits `EPERM`) and re-arm it from
  the parent watch when it reappears. A `null` filename (macOS) means "something changed
  here": `stat` the `worktrees` dir and re-list only when its `mtimeMs` moved.
- Bounds: ≤ **64** tracked repos — over the cap, repos are admitted in the input order
  of the latest `track()` call (the overflow is never listed or watched, logged once);
  callers pass the set ordered by priority (pinned, then active, then the rest); listing
  concurrency **4**; `GIT_TIMEOUT_MS`.
- Watch failure (`ENOSPC`/`EMFILE`/`EPERM`) → that repo re-lists on window focus,
  throttled to once per 30 s per repo. No interval timer anywhere.
- D9 matching: `canonicalize` every listed path and every member path (memoized per
  `track` call); a listed path whose canonical form equals a member's canonical form is
  reported **as the member path**.
- **Accepted staleness (review finding 12):** a `git switch` inside a sessionless
  worktree writes `worktrees/<name>/HEAD`, which the non-recursive watch does not see.
  That row's branch label updates on the repo's next re-list (any worktree add/remove in
  the repo, a track change, or a focus re-list after a watch failure). Session-backed
  folders are unaffected — their branch comes from the git probe.

**B2. Wiring and renderer (U4b).**

- `index.ts`: one tracker instance; IPC `worktrees:track` (renderer → main, the
  `TrackedRepo[]` set) and push `worktrees:changed` `{ repoId, entries }`. Preload:
  `worktreesTrack(repos)`, `onWorktreesChanged(cb)`.
- `sessions.ts`: a computed **known-repo set** (D3) — `repoId`s of folders that are
  pinned, user-project placeholders, or classify active on their own sessions (the
  classification run **without** the git-listed rule), each with a `probePath` and its
  `memberPaths`. Watched, debounced 500 ms, diffed; `worktreesTrack` only on change.
- `gitWorktrees: Map<repoId, TrackedWorktree[]>` from `onWorktreesChanged`.
- `mergeFolders` (`merge-folders.ts`) gains an optional `gitListed` argument: every
  folder whose path is in a listing gets `gitListed: true` — **including folders that
  already have sessions** (review finding 5) — and a placeholder `Folder` (`sessions: []`,
  `gitListed: true`, `repoId`, `gitBranch`, `isMainWorktree`) is injected for each listed
  path with no folder. Paths are already reconciled by main (D9), so the dedupe stays an
  exact-string match.

**B3. Classification (`folder-zones.ts`).** `ZoneFolder` gains `gitListed?: boolean`.
Order: `sessions.length === 0 && !pinned && !gitListed` → stale; hidden → hidden; pinned
→ pinned; **gitListed → active**; `diskExists === false` → stale; live/recent → active;
else stale. Hidden is still checked first, so hidden rows and the eye-slash count behave
as today.

**B4. Remove.** A removed worktree drops out of the next listing → its placeholder and
its `gitListed` flag go away. If it has sessions, it is a transcript-derived folder and
follows the ghost rule (`diskExists === false` → stale, BUG-56 D5).

**B5. Contract.** `design.md` §6 sidebar paragraph ("Stale folders (non-pinned with zero
sessions …)") gains the git-listed exception — no new token or visual; a sessionless
folder row already exists for pinned placeholders. `docs/user/folders-and-worktrees.md`
gains a "worktrees you create outside Capy" paragraph. **No new i18n keys** (no new
visible string). `list_worktrees` keeps its shape: `toWorktreeListing`
(`worktree-core.ts:654`) maps fields explicitly and does **not** start filtering
prunable rows, so `docs/capy-features.md` is untouched (review finding 11). CHANGELOG
`### Added`.

**Alternatives rejected.**

- _Poll `git worktree list` per repo._ A spawn per repo per interval forever; violates
  "no new polling loop".
- _Reaper's scanner (`reaper/scanner-shell.ts`)._ Built for a periodic sweep, not live
  add/remove.
- _Pin/adopt every discovered worktree._ Pins are user intent, persisted to
  `projects.json`; auto-pinning pollutes it and breaks unpinning.
- _List worktrees of every repo ever seen._ Unbounded spawns and watches (D3).
- _Recursive watch to catch `worktrees/<name>/HEAD`._ One more watch per worktree for a
  label on sessionless rows only; accepted staleness instead (B1).
- _Canonicalize in the renderer._ It cannot `realpath`; separator/case tricks alone
  miss symlinks and `/private/var` (D9).

### 4.C CPU — units U2, U3a, U3b, U5

**C1. Subagent header cache (`claude-reader.ts`, U2).** Subagent attribution
(`agentId`, `attributionAgent/Skill/Plugin`, first assistant `model`, first `user` task)
sits on the first lines and never changes. Cache per absolute path:
`{ ino, size, header, complete, gen }`. `complete` = every field resolved, or the read
covered the full 64 KB head. Per pass: `stat` only; re-read only when the path is new,
the inode changed, the size shrank, or the header is incomplete and the file grew.
Pruned on full scans by generation, like `headerCache`.

**C2. Incremental JSONL header (`claude-reader.ts`, U2).** `CachedHeader` gains
`{ ino, scannedBytes, hitCap, ring, partial, decoderState }`. On a pass where the file
grew and the inode is unchanged: read only `[scannedBytes, size)` and fold the new lines
exactly the way `scrapeJsonlHeader` folds lines. **Every head-derived field —
`userMessageCount`, `turnCount`, `firstPrompt`, head-seen titles, `cwd`, `gitBranch`,
`entrypoint`, team fields — freezes at `MAX_SCAN_BYTES`, exactly like a fresh scrape**
(review finding 9): bytes past the cap feed only the tail ring. Tail truth is recomputed
with the same `applyTranscriptTruth` over the ring. Inode change or shrink (`/compact`)
→ full re-scrape. For a file past the cap a fresh scrape reads a 512 KB tail window
while the incremental path keeps an 800-entry ring; a test pins that their derived
fields agree on the fixtures, and on any disagreement the incremental path falls back
to `readTailEntries` (512 KB — still far less than 2 MB + 512 KB).

**C3. Event payload and coalescing (`claude-watcher.ts` + renderer, U3a).**

- `session:updated` wire shape: `{ slug, sessionId, renameTitle?, aiTitle?,
firstPromptCandidate?, transcriptState?, ctxPct?, awaySummary?, stagnation? }` —
  `newLines` removed (D5). `firstPromptCandidate` is computed in main with
  `firstRealPrompt` (`claude-reader-derive.ts:47`), the canonical version of the
  renderer's mirror in `src/renderer/src/lib/first-prompt.ts`; that mirror is deleted
  once `sessions.ts` stops importing it (review finding 10). `aiTitle` is the cheap add.
- `subagent:updated`: `{ slug, parentSessionId, agentId, meta? }` where `meta` is
  `readAgentMeta`'s result computed in main.
- Coalescing per `(kind, id)`: 150 ms trailing, 500 ms max-wait. Merge rules:
  `renameTitle`, `aiTitle`, `transcriptState`, `ctxPct`, `awaySummary`, `stagnation` —
  latest defined value wins; `firstPromptCandidate` — first defined wins; subagent
  `meta` — **first defined wins per field** (`agentType`, `skill`, `plugin`, `model`,
  `task`), matching `readAgentMeta`'s own first-seen semantics. A `session:added` is
  never delayed and flushes any pending update for the same id **after** itself, so a
  renderer never sees an update for an id it was not told about.
- The renderer handler stops writing unchanged values (`status` when already `active`;
  `modified` once per coalesced event) — the cheap part of R9.

**C4. Append-class refresh cadence (`fleet-model.ts` + watcher, U3b).**
`notifySlugChanged(slug, cls: 'membership' | 'append' = 'membership')`. `membership`
(session/subagent add and unlink, `addDir`/`unlinkDir`, index) keeps the 250 ms fixed
window. `append` schedules that slug no sooner than **2 s** after its previous pass. A
membership event for the slug upgrades it to the 250 ms path. Consequence, stated on
purpose (review finding 16): `get_fleet` append fields (`fileMtime`, `transcriptState`,
`ctxPct`, `awaySummary`) can lag the transcript by up to ~2.3 s instead of ~0.3 s.
`docs/capy-features.md` documents no freshness bound for those fields and no verb or ACK
changes, so it is untouched.

**C5. Bounded first-append replay (`claude-watcher.ts`, U3a) — R4, review finding 8.**
The watcher runs with `ignoreInitial: true`, so every `missedAdd` is a file that existed
before it was first seen; the cap therefore applies **unconditionally** to `missedAdd`
(no mtime/birthtime predicate — mtime always postdates watcher start on a `change`, and
`birthtime` is unreliable on Linux). The tail starts at `max(0, size − 256 KB)` and drops
the first partial line. Programmatic classification no longer depends on the tail: a
separate **8 KB head read** (the first lines carry `entrypoint`) feeds
`classifyTranscriptLines` for a `missedAdd` session.

**C6. Compositor-only pulse (`main.css`, call sites, U5) — R5, review finding 7.**

- `:where(.anim-pulse-dot) { position: relative }` — zero specificity, so a call site's
  `absolute` utility (e.g. the Inbox count badge, `InboxRail.vue:289`) still wins.
- `.anim-pulse-dot::after { content: ''; position: absolute; inset: -4px;
border-radius: inherit; background: var(--color-green-soft); pointer-events: none;
animation: pulse-ring 1.8s ease-in-out infinite; }` with
  `@keyframes pulse-ring { 0%, 100% { transform: scale(var(--pulse-from, 0.43));
opacity: 1 } 50% { transform: scale(1); opacity: 0 } }`. The ring's final box is the
  dot + 4 px each side — the old `0 0 0 4px` spread. `--pulse-from` = dot ÷ (dot + 8):
  0.43 for the 6 px default; call sites with other sizes set it (5 px → 0.38,
  8 px → 0.5). Non-square call sites (the text badge) set `--pulse-from-x`/`-y`
  through a `scale(x, y)` variant documented next to the keyframe.
- **Call-site audit is part of U5:** every one of the ~20 `anim-pulse-dot` uses
  (13 files, `grep -rn anim-pulse-dot src/renderer/src`) is listed in the PR with its
  size, shape and positioning, and gets `--pulse-from` (or the x/y pair) where it is not
  a 6 px circle.
- `design.md` §6 "Pulse animation" and §7 get the new keyframe in the same change.
  `prefers-reduced-motion` keeps neutralizing both.
- `.fleet-ring--working .fleet-ring-arc` gains `will-change: transform`.
- If the GPU-on bench (AC-23) stays above target, the fallback — animate only while the
  window is focused — is a design call raised to the operator, never shipped silently.

**Alternatives rejected for (c).**

- _Feed the model from watcher deltas, drop per-append scans._ Two truth derivations
  (`deltaTruth` folds a delta, `applyTranscriptTruth` folds a ring) → `get_fleet` and the
  sidebar could disagree. C1+C2+C4 get most of the win on one path; revisit if U0 shows
  passes still dominate.
- _Worker thread / `utilityProcess`_ (T123 S2). Moves the I/O fan-out, does not remove it.
- _Raise the 250 ms window globally._ Hurts time-to-row; C4 targets appends only.
- _Restructure the renderer's reactive tree._ R9 is not dominant at measured rates.
- _`scale()` from a fixed factor for every dot._ Changes the look of 5 px/8 px dots and
  the badge, contradicting D6.

### 4.D Small wins — research results

| ID       | Win                                                                                                          | Evidence                                            | Size          | In/out                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| **SW-1** | Rescan does one full scan via `requestFullRescan()`                                                          | R7: 2 × 2.76 s concurrent scans                     | ~30 lines     | **In** (U1)                                                        |
| **SW-2** | BUG-77 race: re-check `programmaticPaths.has(p)` inside the `runExclusive` task                              | R8, by code                                         | ~5 lines      | **In** (U3a)                                                       |
| **SW-3** | Bounded first-append replay                                                                                  | R4: 27.7 MB in two events                           | ~40 lines     | **In** (U3a, = C5)                                                 |
| **SW-4** | No `version` bump when a slug pass changed nothing, by field equality (A2) — not by the membership signature | `fleet-model-core.ts:142` bumps unconditionally     | ~70 lines     | **In** (U1)                                                        |
| **SW-5** | Detached-PTY xterm writes (`TerminalPane.vue:688` writes every chunk whether attached or not)                | Code only; not measured (no PTYs in the harness)    | measure first | **Out** — new card: measure with N busy detached PTYs, then decide |
| **SW-6** | `git rev-parse` stale-while-revalidate                                                                       | 1–7 spawns/min; `spawn` 0.7–1.3% of main JS samples | ~25 lines     | **Out** — does not help the new-folder path (nothing cached yet)   |
| **SW-7** | Cold boot to first model: 11.1 s                                                                             | Measured                                            | large         | **Out** — T123 S2 (warm snapshot)                                  |
| **SW-8** | `foldersLoad` ships 2.1 MB per reload (63 ms of 68–106 ms)                                                   | Measured                                            | medium        | **Out** — only matters if D2 is revisited                          |

---

## 5. Acceptance criteria

Ids are stable: AC-1…AC-30 keep their stage-1 meaning (wording tightened by review),
AC-31+ are new. **Gating** ACs are deterministic tests or reviews; **bench** ACs are
non-gating evidence (D10), all collected under AC-30. "Bench" = the harness U0 lands
under `scripts/dev/liveness-bench/`; numbers are against the synthetic fixture and load
unless "real" is stated.

### 5.A Liveness (BUG-147)

- [ ] AC-1 — A session added in a folder the sidebar already shows reaches the store and the visible list with no Rescan; with fake timers the pipeline (250 ms model window → push → leading-edge reload) lands the row ≤ 1.0 s after the watcher event. Bench evidence (non-gating, AC-30): p95 over 10 `ttr existing-slug` trials (baseline 0/6 within 20 s) — verify: test (gating) + manual (bench) — source: §4.A
- [ ] AC-2 — A new slug dir plus its first JSONL produces the folder row and the session row with no Rescan; `addDir` schedules a slug refresh; fake-timer pipeline ≤ 1.0 s excluding the git probe. Bench evidence: p95 ≤ 1.5 s over 10 `ttr new-slug` trials (baseline 0/3) — verify: test (gating) + manual (bench) — source: §4.A A5
- [ ] AC-3 — When a synthetic's real row arrives via a `fleet:changed` reload, `commitFolders` receives exactly one row for that id (asserted at the commit point, before any later tick); same object as the synthetic when it collapsed in place, the real row otherwise; selection and PTY re-keyed once — verify: test — source: §4.A A7
- [ ] AC-4 — No new polling loop and bounded reloads: 50 appends to known sessions produce **0** `fleet:changed`; 10 session adds within 1 s produce **≤ 2** renderer reloads; `reconcileSessionAdded` performs no `reloadModel()` of its own — verify: test — source: §3 D1, §4.A A3/A6
- [ ] AC-5 — Under a continuous trigger stream (one per 100 ms for 5 s), both `reloadOnFleetChange` and `reloadModelDebounced` run a reload at least once per second (max-wait) — verify: test — source: §4.A A6
- [ ] AC-6 — A model refresh with no watcher event behind it (watcher `ready` rescan, degraded poll, Rescan) still reaches the renderer — verify: test — source: §4.A A3
- [ ] AC-31 — A row migrated in place in folder A survives a `fleet:changed` reload covering only folder B's slug (selection and PTY kept, same object); it is dropped once a reload covering A's slug omits it; it is removed from A as soon as the model places it under another folder (no cross-folder duplicate) — verify: test — source: §3 D8, §4.A A8

### 5.B Always-listed git worktrees (T388)

- [ ] AC-7 — A worktree added to a tracked repo (simulated watch event) is emitted by the tracker after the 500 ms debounce and rendered as a sessionless row under its repo group; fake timers, no restart or Rescan. Bench evidence: ≤ 2 s after a real `git worktree add` (baseline: never, not even after Rescan) — verify: test (gating) + manual (bench) — source: §4.B
- [ ] AC-8 — A removed worktree's sessionless row disappears on the next emit; a removed worktree that has sessions follows the ghost rule (`diskExists === false` → stale) — verify: test — source: §4.B B4
- [ ] AC-9 — A repo with 60 worktrees: a burst of 10 watch events produces **≤ 2** `listWorktrees` calls for that repo and **0** for other tracked repos; at most 64 repos tracked and 4 listings in flight — verify: test — source: §4.B B1
- [ ] AC-10 — A hidden path stays hidden and is counted by the Hidden-folders count; a hidden git-listed row never renders in the list — verify: test — source: §4.B B3
- [ ] AC-11 — The known-repo set ignores the git-listed rule: when a repo's last pinned or session-active folder leaves the visible list, its sessionless rows leave too and `track` drops it (watches closed) — verify: test — source: §3 D3
- [ ] AC-12 — Bare and prunable entries are never emitted; `parseWorktreeList` reports `prunable` and `locked`; `toWorktreeListing` output (MCP `list_worktrees`) is unchanged for the same input — verify: test — source: §4.B B1/B5
- [ ] AC-13 — A failed watch (simulated `ENOSPC`) makes that repo re-list on window focus at most once per 30 s; the tracker creates no interval timer — verify: test + review — source: §4.B B1
- [ ] AC-14 — `design.md` §6 and `docs/user/folders-and-worktrees.md` describe the git-listed rule; no new i18n keys; CHANGELOG `### Added` entry present — verify: review — source: §4.B B5
- [ ] AC-32 — A worktree whose only sessions are older than the active window is listed (its folder carries `gitListed` and classifies active) — verify: test — source: §4.B B2
- [ ] AC-33 — A pinned repo whose sessions all aged out still lists its sessionless worktrees — verify: test — source: §3 D3
- [ ] AC-34 — One row per worktree across path spellings: a listing that prints `C:/x/wt` for a member `C:\x\wt`, `/private/var/x/wt` for `/var/x/wt`, or a symlinked parent for its target produces **no** extra placeholder (tracker reports the member path) — verify: test (injected `canonicalize`) — source: §3 D9
- [ ] AC-35 — Watch lifecycle per platform rule: a `rename`/disappearance of `<common>/worktrees` closes that watch immediately and re-arms it when the dir reappears; a `null` filename re-lists only when the dir's `mtimeMs` moved — verify: test — source: §4.B B1
- [ ] AC-36 — Manual check on Windows and macOS: add and remove a worktree three times on a tracked repo; rows follow, no `EPERM` on the third add. **Non-gating**: recorded as run/not run with the result — verify: manual — source: §4.B B1, §9

### 5.C CPU (BUG-146 + R5)

- [ ] AC-15 — A slug pass on the fixture's heavy slug reads subagent headers only for new or incomplete files: **≤ 2 reads per pass** (baseline 400), counted by a read counter — verify: test — source: §4.C C1
- [ ] AC-16 — An append to a known transcript reads only the appended bytes; every derived header field equals a fresh full scrape's on fixtures that include a file past the 2 MB cap (head fields frozen at the cap in both) and a `/compact` rewrite — verify: test — source: §4.C C2
- [ ] AC-17 — Append-class passes per slug **≤ 0.5/s** under a fake-timer stream of 8 appends/s (baseline 2.0/s); a session add in the same slug still refreshes within the 250 ms window — verify: test (gating) + manual (bench `instr`) — source: §4.C C4
- [ ] AC-18 — A heavy-slug pass whose only change is one appended line opens ≤ 3 files and reads ≤ 64 KB in total (gating proxy for pass cost). Bench evidence: pass p50 ≤ 25 ms (baseline 72.5 ms) — verify: test (gating) + manual (bench) — source: §4.C C1–C2
- [ ] AC-19 — Bench evidence (non-gating): main CPU under bench load, animations off **≤ 10%** (baseline 38.8%); idle ≤ 1% (baseline 0.6%) — verify: manual (bench `cpu`) — source: §4.C
- [ ] AC-20 — `session:updated`/`subagent:updated` carry no `newLines`; the serialized size of any single event built from the fixtures (including a first append to a 5 MB transcript) is **≤ 16 KB** (baseline: two events carried 27.7 MB, real); `firstPromptCandidate` equals what the renderer mirror produced for the same lines — verify: test — source: §4.C C3/C5
- [ ] AC-21 — Coalescing: 20 appends to one session within 100 ms produce 1–2 `session:updated`; merge rules hold (latest truth/titles, first `firstPromptCandidate`, first-defined-per-field subagent `meta`); a `session:added` is delivered before any update for the same id — verify: test — source: §4.C C3
- [ ] AC-22 — A first append after boot to a pre-existing 5 MB transcript tails ≤ 256 KB; a `claude -p` transcript first seen this way is classified programmatic from the 8 KB head read even when the tail window holds no `entrypoint` line — verify: test — source: §4.C C5
- [ ] AC-23 — Bench evidence (non-gating): GPU on, fixture with 4 pulse dots + 2 spinners visible: renderer **≤ 8%**, GPU process (from `app.getAppMetrics()`) **≤ 3%** (baseline 20.6–26.9% / 6.4–8.8%); dots still visibly pulse — verify: manual (bench `gpu`) + visual — source: §4.C C6
- [ ] AC-24 — `pulse-ring` keyframes in `main.css` and `design.md` match and animate only `transform`/`opacity`; `prefers-reduced-motion` neutralizes them; per-size visual parity: for each audited size/shape (5 px, 6 px, 8 px circles, the text badge) a before/after screenshot pair at the animation's 0%/50% frames is attached to the PR and the ring's outer extent matches the old 4 px spread within 1 px — verify: test (CSS assertion) + visual — source: §4.C C6
- [ ] AC-25 — Liveness is unchanged by the CPU work: watcher, fleet-model and store suites stay green, and AC-1/AC-2's gating tests still pass after U2/U3a/U3b — verify: test — source: §4.C
- [ ] AC-37 — Every `anim-pulse-dot` call site keeps its positioning: an element that sets `absolute`/`fixed` keeps it (`:where()` specificity), and the U5 PR lists the full audit table — verify: test (CSS specificity assertion) + review — source: §4.C C6

### 5.D Small wins

- [ ] AC-26 — Rescan performs exactly **one** full scan and returns the refreshed model (baseline 2) — verify: test (`__fleetScanStatsForTests`) — source: §4.D SW-1
- [ ] AC-27 — A `change` queued while the same path's `add` is classifying a `claude -p` transcript emits no `notifySlug` and no `session:updated` — verify: test — source: §4.D SW-2
- [ ] AC-28 — A slug pass whose fresh sessions and git meta are field-equal to the model's does **not** bump `version` (MCP consumers keep the same array reference); a pass where only `ctxPct` or only `fileMtime` changed **does** bump it — verify: test — source: §4.A A2, §4.D SW-4

### 5.E Delivery hygiene

- [ ] AC-29 — Every unit passes `/local-ci`; contract files per unit as listed in §6 (CHANGELOG entries, `design.md`, `docs/user`, no i18n keys, no `capy-features` change) — verify: review — source: CLAUDE.md
- [ ] AC-30 — Bench evidence for AC-1, -2, -7, -17, -18, -19, -23 is recorded in the delivery report against the §1.2 baseline, on the same fixture and machine; a number below target is reported as such — verify: manual — source: §1, §3 D10

AC count per concern: liveness 7 (AC-1–6, 31), worktrees 13 (AC-7–14, 32–36), CPU 12
(AC-15–25, 37), small wins 3 (AC-26–28), hygiene 2 (AC-29–30) — **37**. Non-gating:
AC-19, AC-23, AC-30, AC-36, and the bench halves of AC-1, -2, -7, -17, -18.

---

## 6. Units

1 unit = 1 PR, ≈ ≤ 500 changed lines. **Parallel** units branch from and target
`feat/sidebar-liveness`. **Stacked** units branch from and target the unit below.
**Hub files** (`src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/stores/sessions.ts`, `src/main/fleet-model.ts`,
`src/main/claude-watcher.ts`) have one owner at a time — hence U1 → U3a → U3b → U4b.
`CHANGELOG.md` is touched by five units under one `## 2026-10-0x` heading; the conflict
is textual and resolved at each rebase.

| Unit    | Title                     | Owns (writes)                                                                                                                                                                                                                                                     | ACs                             | Base / mode                                                                                                       | Est. lines |
| ------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| **U0**  | Bench harness             | **moves** `docs/specs/2026-10-02-sidebar-liveness-bench/` → `scripts/dev/liveness-bench/` (logpoints located by pattern search; GPU via `app.getAppMetrics()`), the old folder is removed (no pointer left); section in `docs/dev/live-verify-second-instance.md` | enables AC-30                   | `feat/sidebar-liveness`, parallel                                                                                 | ~350       |
| **U1**  | `fleet:changed` push      | `fleet-model-core.ts`, `fleet-model.ts`, `claude-watcher.ts` (`addDir` only), `index.ts`, `src/preload/index.ts`, `sessions.ts`, `docs/user/folders-and-worktrees.md` (Rescan paragraph), tests, CHANGELOG `### Fixed`                                            | AC-1–6, 26, 28, 31              | `feat/sidebar-liveness`, parallel                                                                                 | ~500       |
| **U2**  | Reader caches             | `claude-reader.ts`, tests, CHANGELOG `### Fixed`                                                                                                                                                                                                                  | AC-15, 16, 18                   | `feat/sidebar-liveness`, parallel                                                                                 | ~450       |
| **U3a** | Watcher wire              | `claude-watcher.ts`, `src/preload/index.ts` (event types), `sessions.ts` (handlers), delete `src/renderer/src/lib/first-prompt.ts` (+ its test), tests, CHANGELOG `### Fixed`                                                                                     | AC-20, 21, 22, 27               | stacked on **U1**                                                                                                 | ~420       |
| **U3b** | Append cadence            | `fleet-model.ts` (append class), `claude-watcher.ts` (pass the class), tests                                                                                                                                                                                      | AC-17, 25                       | stacked on **U3a**                                                                                                | ~180       |
| **U4a** | Worktree tracker core     | new `src/main/worktree-tracker.ts`, `worktree-core.ts` (`parseWorktreeList` + `prunable`/`locked`), `worktree-ipc.ts` (export `listWorktrees`), tests. No hub files. PR carries the `no-user-docs` label (not wired, no user-reachable surface)                   | AC-9, 12, 13, 34, 35            | `feat/sidebar-liveness`, parallel                                                                                 | ~400       |
| **U4b** | Worktree wiring + sidebar | `index.ts`, `src/preload/index.ts`, `sessions.ts`, `merge-folders.ts`, `folder-zones.ts`, `design.md` §6 sidebar paragraph, `docs/user/folders-and-worktrees.md`, tests, CHANGELOG `### Added`                                                                    | AC-7, 8, 10, 11, 14, 32, 33, 36 | stacked on **U3b**; U4a must be merged into `feat/sidebar-liveness` and the stack rebased on it before U4b is cut | ~400       |
| **U5**  | Compositor-only pulse     | `src/renderer/src/styles/main.css`, `design.md` §6 "Pulse animation" + §7, the 13 call-site components (only `--pulse-from` vars), tests, CHANGELOG `### Changed`                                                                                                 | AC-23, 24, 37                   | `feat/sidebar-liveness`, parallel                                                                                 | ~250       |

`design.md` is written by U4b (§6 sidebar paragraph) and U5 (§6 pulse block, §7) —
disjoint hunks. AC-19, -23 and -30 are measured after the stack lands on the integration
branch.

**Contract files.** `docs/capy-features.md`: **untouched** by every unit — no MCP verb,
ACK, grant or confirm semantics change; `fleet:changed`/`worktrees:changed` are renderer
channels; `list_worktrees` keeps its shape (B5); the `get_fleet` append-field lag is
stated in C4 and is not a documented contract. i18n: **no unit adds keys**. User docs:
U1 (Rescan paragraph), U4b (new paragraph); U4a carries `no-user-docs`.

---

## 7. Out of scope

- T123 S2 (`utilityProcess` scanner + warm snapshot), S3 (visibility window), S5 (BUG-32) — §8.
- A delta protocol for `fleet:changed` (D2) and shrinking the 2.1 MB `foldersLoad` payload (SW-8).
- Removing, freezing, or focus-gating the pulse animation (D6) — product calls.
- Detached-PTY xterm write cost (SW-5) — needs its own measurement first.
- `git-probe` stale-while-revalidate (SW-6); `.git/HEAD` watching (BUG-34 D2 still stands); branch labels of sessionless worktrees after an in-worktree `git switch` (B1, accepted).
- Listing worktrees of repos the sidebar does not show (D3 gap).
- Restructuring the renderer's reactive tree (R9).
- Any MCP surface change (`get_fleet`, `list_worktrees` shapes stay as they are).

## 8. T123 reconciliation

T123 (READY, `substrate: internal`) is a five-slice epic. Status at `e06b84a7`:

| T123 slice                                            | State at `e06b84a7`                                                                         | This delivery                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S1 — central in-memory fleet model                    | **Landed** (`a5a24e8e`, `b09baee7`, `42f076f9`)                                             | Builds on it.                                                                                               |
| S1's "version counter + change events" (spec §5.1)    | Version counter landed (bumps unconditionally); **change events never wired**               | **Absorbed** — A1–A3: field-equality version bumps and membership-gated change events.                      |
| S2 — off-thread scanner + `fleet-index.json` snapshot | Not started                                                                                 | **Stays in T123.** Off-thread does not remove the I/O fan-out (§4.C). Cold boot (11.1 s, SW-7) is its job.  |
| S3 — session visibility window                        | Not started (the renderer's `sessionWindowMs` is a display window, not T123's index window) | **Stays in T123.** Orthogonal; C1/C2 make the deep index cheap enough that the window is about UX, not CPU. |
| S4 — MCP handler deadline                             | **Landed** (`TOOL_TIMEOUT`)                                                                 | Untouched.                                                                                                  |
| S5 — BUG-32 config race                               | Out of this delivery                                                                        | Untouched.                                                                                                  |

When this delivery lands, T123's card should say S1's change events are done here and
that S2's motivation is now cold boot, not steady-state CPU.

## 9. Risks

| Risk                                                                           | Mitigation                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Incremental header scrape diverges from a fresh scrape.                        | AC-16 equivalence test incl. > 2 MB and `/compact`; head fields freeze at the cap in both; inode/shrink → full re-scrape.         |
| Removing `newLines` breaks a consumer outside `sessions.ts`.                   | Grep at `e06b84a7` finds only `sessions.ts` (+ `session-autoname.ts` docs). U3a re-greps, including extension/mod hooks.          |
| `fleet:changed` reloads (2.1 MB `foldersLoad`) become a cost during a fan-out. | D1 gating, leading edge + 1 s max-wait; AC-4 bounds it; SW-8 is the follow-up if the bench shows it.                              |
| Duplicate or vanishing rows around synthetic collapse and in-place migration.  | A7 collapses before commit (AC-3); A8 keeps migrated rows until model evidence (AC-31).                                           |
| `fs.watch` on `.git` fires on every git operation.                             | Filter to the `worktrees` entry, 500 ms debounce, emit only on parsed-entry change (AC-9).                                        |
| Windows delete-pending `EPERM` / macOS null filenames.                         | B1 platform rules (AC-35); manual Windows/macOS check (AC-36, non-gating). The author's machine is Linux: AC-36 may be "not run". |
| Path spellings create duplicate rows.                                          | D9 matching in main (AC-34).                                                                                                      |
| Repos with many worktrees flood the sidebar.                                   | Existing repo-group collapse applies; operator chose "always list".                                                               |
| Compositor pulse still costs too much on some GPU/driver, or changes the look. | AC-23 measured GPU-on; per-size parity (AC-24); focus-gated fallback raised to the operator, not shipped silently.                |
| `get_fleet` append fields lag ~2.3 s under C4.                                 | Stated in C4; not a documented contract; membership changes keep 250 ms.                                                          |
| Bench numbers drift with the machine.                                          | D10: gating tests are deterministic; bench numbers are evidence compared on the same machine (AC-30).                             |

## 10. Review log (stage 2)

Independent review of `e2f9876c`: approve-with-changes; every R1–R8 file:line reference
confirmed. Each finding was re-checked against the code before applying.

| #   | Finding (severity)                                             | Disposition                                                                                                                                                                                    |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Duplicate row can flash (major)                                | **Applied** — A7 collapses on `merged` before `commitFolders`; AC-3 asserts at the commit point. Confirmed: `reloadModelOnce` re-injects synthetics then commits.                              |
| 2   | BUG-88 race widened (major)                                    | **Applied** — D8 + A8 (`awaitingConfirm`, gated on model coverage, 60 s backstop); new AC-31. `fleet:changed` carries `slugs`/`full` for it.                                                   |
| 3   | AC-4 contradicts A5 (major)                                    | **Applied** (preferred option) — the stale fallback `reloadModel()` is removed; AC-4 also asserts it.                                                                                          |
| 4   | Version bump can't use the membership signature (major)        | **Applied** — A2 field-equality via `sessionEntriesEqual`; AC-28 gains the converse; SW-4 re-estimated (~70 lines).                                                                            |
| 5   | T388 gap vs "always list" (major)                              | **Applied** — `gitListed` on every listed folder; pinned/user-project repos count as known; remaining gap recorded in D3; new AC-32, AC-33.                                                    |
| 6   | Cross-platform duplicate rows (major)                          | **Applied** — D9 matching in main with `normalizePath`; new AC-34.                                                                                                                             |
| 7   | Pulse rewrite regresses visuals (major)                        | **Applied** — `:where()` positioning, `inset:-4px` ring, per-size `--pulse-from`, call-site audit; AC-24 per-size parity; new AC-37.                                                           |
| 8   | C5 predicate wrong (minor)                                     | **Applied** — unconditional cap on `missedAdd`; 8 KB head read for classification; AC-22 updated.                                                                                              |
| 9   | Head fields stop at the cap (minor)                            | **Applied** — C2 states every head-derived field freezes at `MAX_SCAN_BYTES`; AC-16 updated.                                                                                                   |
| 10  | Subagent merge rule, first-prompt location, `aiTitle` (minor)  | **Applied with a variant** — no move needed: main already has the canonical `firstRealPrompt`; the renderer mirror is deleted in U3a. Merge rule and `aiTitle` added.                          |
| 11  | Parser location, `prunable`, `list_worktrees` shape (minor)    | **Applied** — `worktree-core.ts` in U4a; `toWorktreeListing` unchanged so no `capy-features` change; AC-12 asserts it.                                                                         |
| 12  | Branch label staleness (minor)                                 | **Applied as "accept explicitly"** — documented in B1 and §7; no recursive watch, no extra focus re-list.                                                                                      |
| 13  | Windows/macOS watch risks (minor)                              | **Applied** — B1 platform rules; new AC-35 (gating) and AC-36 (manual, non-gating).                                                                                                            |
| 14  | Machine-only ACs, GPU label, §1.3 vs AC-23 (minor)             | **Applied** — D10 split; GPU-process label explained in §1.1 and fixed in U0 via `app.getAppMetrics()`; §1.3 now matches AC-23 (≤ 8%).                                                         |
| 15  | Decomposition (minor)                                          | **Applied** — U4a/U4b and U3a/U3b; U0 moves the bench.                                                                                                                                         |
| 16  | Contract files (minor)                                         | **Applied** — U2 `### Fixed`; U1 updates the Rescan paragraph; "no new i18n keys"; C4 states the `get_fleet` lag and the no-`capy-features` decision.                                          |
| 17  | Leading-edge reload; signature from state (nit)                | **Applied** — A6 leading edge + max-wait; A1 signature from `state.sessions` + `gitByPath`.                                                                                                    |
| 18  | 64-repo cap "least-recently-tracked" is undefined (U4a verify) | **Applied** — `track` is a set replace, so every candidate is tracked "now" and recency always ties; B1 now admits repos in input order (as the plan already said), callers order by priority. |
