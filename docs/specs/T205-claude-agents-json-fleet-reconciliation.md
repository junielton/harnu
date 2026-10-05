# T205 — Reconcile the fleet against `claude agents --json`

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T205-reconcile-the-fleet-against-claude-agents-json-all-instead-of.md`

> **Headline correction — the card's premise is half right.** `claude agents --json` exists and
> works (CLI 2.1.222, run 2026-08-05). But its **interactive** rows are a strict _subset_ of the
> `~/.claude/sessions/<pid>.json` files `session-registry-watch.ts` already watches — zero new
> fields, at the cost of a process spawn. The only thing the command adds is the **background**
> population (`kind: "background"`, no `pid`, therefore no registry file). Two further deviations
> from the card: the vocabulary is **split** (`status` on interactive rows, `state` on background
> rows — not one `state` field), and `--all` is the **wrong flag** for fleet truth (it adds
> _completed_ background sessions, which are by definition not live). §4 and §5 scope the card
> accordingly.

## 1. Goal

Give Capy a truth source for **background** Claude sessions — the one population it is blind to
today — without weakening the precedence that already governs hooks, the PID registry and
transcript truth, and without a hot poll.

## 2. What `claude agents --json` actually returns

**Installed:** `claude --version` → `2.1.222 (Claude Code)`; binary
`~/.local/share/claude/versions/2.1.222` (shim at `~/.local/bin/claude`).

`claude agents --help` documents exactly three relevant flags:

- `--json` — "Print active sessions (interactive and background) as a JSON array and exit (for
  scripting; does not require a TTY)"
- `--all` — "**With `--json`: also include completed background sessions**"
- `--cwd <path>` — "Show only background sessions started under `<path>`"

`claude agents --json --all`, verbatim (2026-08-05, 802 bytes, exit 0, empty stderr):

```json
[
  {
    "id": "a3f44442",
    "cwd": "/home/u/Workspace/org/acme/worktrees/ACME-10684-saved-search-release-fixes",
    "kind": "background",
    "startedAt": 1780958786550,
    "sessionId": "a3f44442-3172-4fdb-82e1-2e1ca6c881f2",
    "name": "Debug saved search showing incorrect results",
    "state": "blocked"
  },
  {
    "pid": 2348440,
    "cwd": "/home/u/Videos",
    "kind": "interactive",
    "startedAt": 1785860134752,
    "sessionId": "bcc52bb6-f0aa-4cf6-9ca7-5fcc0166415e",
    "name": "videos-6d",
    "status": "idle"
  },
  {
    "pid": 2768448,
    "cwd": "/home/u/Workspace/me/capy",
    "kind": "interactive",
    "startedAt": 1785932721658,
    "sessionId": "0971253f-6112-4029-916b-8d489565f0e1",
    "name": "capy-95",
    "status": "busy"
  }
]
```

Observed facts, each load-bearing:

- **`--all` changed nothing here.** `claude agents --json` without `--all` returned a byte-identical
  array. `--all` only adds _completed_ background sessions; there were none.
- **Two vocabularies, keyed by `kind`.** `interactive` rows carry `status` (`busy`|`idle`|`waiting`
  — the registry's own field); `background` rows carry `state`. No row carries both.
- **`waitingFor` never appeared** on any row, on a CLI well past the v2.1.162 that added it —
  presumably emitted only while a session is actually blocked on a prompt. Treated as optional
  throughout (§5.3, Q1).
- **`id` exists only on background rows** (8-char short id = the `~/.claude/jobs/<id>/` key).
  Interactive rows are identified by `pid` + `sessionId`.
- **`--cwd` filtered interactive rows too**, contradicting the help text ("background sessions
  started under `<path>`"). Rely on neither reading.
- **The background row is a ghost.** Its `cwd` no longer exists, its `~/.claude/projects/` dir no
  longer exists, and its transcript (`~/.claude/jobs/a3f44442/state.json` → `linkScanPath`) is gone
  from disk. `startedAt` 1780958786550 = 2026-06-09. Blind reconciliation would inject a two-month-old
  `blocked` → **needs-you** row into the Approval-Inbox count. Drives rule **P4** (§5.1).

Background state also has a richer on-disk mirror at `~/.claude/jobs/<id>/state.json` (`state`,
`tempo`, `detail`, `needs`, `inFlight`, `output`, `children`, `respawnFlags`, `cliVersion`,
`updatedAt`, …) plus a per-job `timeline.jsonl`. **Distinct `state` values across both job
timelines: `working` (2), `blocked` (17), `done` (11)** — the entire empirical vocabulary; assume
it is incomplete (§5.3).

## 3. Current sources of truth, verified

| #   | Source                   | Evidence (file:line)                                                                                                                                                                                                                                      | Mechanism                                                                              |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | **Hook FSM**             | `src/main/hook-state.ts:35` (`reduceTaskState`), `src/main/hook-bridge.ts:55-62` (loopback HTTP observer), applied `src/renderer/src/stores/sessions.ts:4398`                                                                                             | Event-driven, per-session, Capy-injected hooks only                                    |
| 2   | **PID registry**         | `src/main/session-registry-watch.ts:35-48` (`sessionsRegistryDir`, `RegistryEntry`), `:56-76` (`parseRegistryEntry`), `:84-95` (`registryStatusToTaskState`), `:124-219` (chokidar shell); applied `sessions.ts:4406` → `:1699-1709` (`setRegistryState`) | One chokidar on one directory, 60 ms debounce; unlink clears the override (`:193-203`) |
| 3   | **Transcript truth**     | `src/main/transcript-truth.ts:152-192` (`deriveTurnState`: the `stop_reason` FSM), `:158-165` (`system.subtype` `turn_duration`/`stop_hook_summary`/`away_summary` → idle), `:65` (`HUMAN_GATING_TOOLS`), `:173-181` (gating tool → `needs-input`)        | Pure fold over the JSONL tail                                                          |
| 4   | **Legacy 5 s heuristic** | `src/renderer/src/stores/fleet-state.ts:226-229`                                                                                                                                                                                                          | `status === 'active'`                                                                  |

The precedence that binds them is **already written and tested**:
`src/renderer/src/stores/fleet-state.ts:204-230` (`resolveActivity`) —
live sub-agents → hooks → registry → transcript → heuristic; and
`fleet-state.ts:243-258` (`isNeedsInput`) for the blocked-on-you axis.

Two invariants this card must not break:

- **Liveness proof (BUG-53).** `fleet-state.ts:116-124` (`isLive`) and
  `sessions.ts:1679-1685` (`isLiveSignal`): no "alive" state (`working`/`stuck`/`needs-you`) may be
  derived from a transcript tail without a live PTY ∪ a registry entry ∪ a this-run hook event.
  `fleet-state.ts:224` enforces it.
- **`--resume` replay hazard.** `src/main/fleet-policy.ts:88-105`: `claude --resume` replays the
  transcript's tool-call hooks with no `Stop` to follow, so `taskState: 'working'` latches
  permanently (measured: 108 s+ with zero PTY bytes). A `working` claim is therefore _corroborated,
  never trusted_ — `isEligible` gives it the strict `hardIdleMs` threshold rather than immunity
  (`fleet-policy.ts:105`), and `isParkable` (`:67-69`, read at `:167`) is kind-only.

## 4. What this adds over the PID registry — the honest delta

Side-by-side, same instant. `~/.claude/sessions/2768448.json`:

```json
{
  "pid": 2768448,
  "sessionId": "0971253f-…",
  "cwd": "/home/u/Workspace/me/capy",
  "startedAt": 1785932721658,
  "procStart": "23001181",
  "version": "2.1.222",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "capy-95",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1785934913136,
  "statusUpdatedAt": 1785934913136,
  "bridgeSessionId": "session_0129dSGP27Hx3AJxcEb4546P"
}
```

The matching `claude agents --json` row carries `pid, cwd, kind, startedAt, sessionId, name,
status` — **a strict subset**. The registry additionally gives `version` (free CLI-version
detection), `statusUpdatedAt` (the freshness anchor `parseRegistryEntry` already reads,
`session-registry-watch.ts:69-74`), `procStart`, `entrypoint`, `nameSource`, `bridgeSessionId`.

**Verdict, per the card's four candidate justifications:**

| Candidate                   | Verdict                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "sessions with no live PID" | **Real, and the only one.** Background sessions have no `pid` → no `~/.claude/sessions/<pid>.json` → invisible to Capy today.                                                          |
| "background sessions"       | **Same thing.** This is the delta, stated twice.                                                                                                                                       |
| "`id` stability"            | **No.** `id` is just `sessionId`'s first 8 chars (`a3f44442` ↔ `a3f44442-3172-…`) and exists only on background rows. `sessionId` is already the join key everywhere.                  |
| "the `--all` scope"         | **Negative value.** `--all` adds _completed_ background sessions. Completed ≠ live; feeding them to the fleet is how you manufacture the ghost row of §2. **Call it without `--all`.** |

**Therefore the card is scoped down.** Not "reconcile the fleet against `claude agents --json
--all` instead of inferring state from JSONL" — transcript truth stays exactly as it is, and the
registry stays the authority for every interactive session. What lands is narrower and cheaper:
**one new overlay that only ever speaks about `kind: "background"` rows.** Everything else in the
command is redundant with what Capy already reads for free.

## 5. Decision

### 5.1 Precedence — explicit, no last-writer-wins

`resolveActivity` (`fleet-state.ts:204-230`) gains one level between the registry and the
transcript. `FleetSignals` gains `bgState?: TaskState` beside `registryState`.

| Source                                 | Authoritative for                                                        | May never override                |
| -------------------------------------- | ------------------------------------------------------------------------ | --------------------------------- |
| Live sub-agents (`liveAgentCount > 0`) | "parent is working"                                                      | — (level 0, unchanged)            |
| Hook FSM (`taskState`)                 | any session Capy injected hooks into                                     | —                                 |
| PID registry (`registryState`)         | any session with a live `pid` — i.e. **every** `kind: "interactive"` row | hook `taskState`                  |
| **`claude agents` (`bgState`) — NEW**  | **only** `kind: "background"` rows (no `pid`)                            | hook `taskState`, `registryState` |
| Transcript truth (`transcriptState`)   | last-turn shape, gated on `isLive`                                       | all of the above                  |
| Legacy 5 s `status`                    | nothing else is available                                                | all of the above                  |

Four rules make this collision-free rather than merely ordered:

- **P1 — kind-partitioned, not priority-ordered.** The parser **discards every `kind !==
'background'` row** before anything is emitted, so a 60 s poll can never race the registry's
  60 ms chokidar event over the same session — disjoint populations by construction. The ordering
  above therefore never has to arbitrate.
- **P2 — the liveness proof survives unchanged.** A background row present in `claude agents
--json` (called **without** `--all`) is proof of life exactly like a registry file, so
  `isLiveSignal` (`sessions.ts:1679-1685`) gains `bgStates.value.has(sessionId)`. It is _not_ proof
  of freshness: `bgState === 'working'` still passes through `workingOrStuck`
  (`fleet-state.ts:169-180`) and ages to `stuck`. The `--resume` replay lesson (§3) holds verbatim —
  corroborated by the quiet timer, never trusted.
- **P3 — parked sessions are never resurrected.** `markHibernated` (`sessions.ts:1719-1725`) clears
  `bgState` alongside `taskState`/`registryState`, and the apply path skips `hibernated === true`.
  Structurally this cannot bite (T119 parks only `claude-resume` PTYs — `fleet-policy.ts:67-69` —
  never a daemon row), but the guard is explicit and asserted: "the poller resurrected a parked
  session as working" is exactly the silent override this spec exists to prevent.
- **P4 — the overlay may enrich a row, never create one.** A `sessionId` matching no session in the
  fleet model is **dropped**, not injected — evidence: the June ghost of §2. Session _existence_
  stays disk-derived (`claude-reader.ts` / `fleet-model.ts`); this card adds _state_. This is also
  what keeps T205 from contradicting T123's visibility window (T123 §3.2): an out-of-window session
  has no fleet row, so it gets no overlay.

### 5.2 Cost — one process per tick, and mostly not even that

Modeled directly on the plan-usage poller (`src/main/usage.ts`), which solves the identical problem:

- **Single-flight** — concurrent callers share one spawn (`usage.ts:70-82`). **Focus-gated** —
  `browser-window-focus`/`-blur` start and stop the timer (`usage.ts:107-113`); **zero spawns while
  backgrounded**. Registered from `src/main/index.ts` beside `registerSessionRegistryWatcher`
  (`:554`), closed in `before-quit` (`:903`, mirroring `closeUsagePoller` at `:933`).
- **Interval** — `AGENTS_POLL_INTERVAL_MS = 60_000`, a module constant in the new
  `src/main/claude-agents.ts`, deliberately **not** a user setting (§5.4). 60 s matches the
  hibernation sweep cadence and is an order of magnitude coarser than the registry's event path —
  the point being that this population changes on human timescales.
- **Event-triggered refresh instead of a hot poll.** A chokidar watcher on `~/.claude/jobs`
  (`depth: 1`, `state.json` only, 200 ms debounce) is used **purely as a change signal** — its
  contents are never parsed, so Capy takes on no dependency on that undocumented schema. A change
  schedules one debounced run of the supported command; the 60 s tick is the fallback heartbeat.
  Absent dir → the watcher no-ops exactly like `session-registry-watch.ts:129-132`.
- **Does not fight the existing watchers.** `~/.claude/jobs` is disjoint from `~/.claude/projects`
  (claude-watcher) and `~/.claude/sessions` (registry watcher) — no shared path or debounce.
- **Spawn hygiene** — `resolveClaudePath()` (`src/main/claude-cli.ts:108-118`) + `sanitizeSpawnEnv`
  - `timeout: 10_000` + `maxBuffer: 1 << 20`, identical to `usage.ts:37-60`. Never rejects; any
    failure keeps the last-good overlay and logs once.
- **Version gate (card AC4).** Requires T200 — **verified absent today** (a repo-wide grep for
  `cliVersion`/`claudeVersion`/`claude --version` under `src/` returns nothing). Gate at
  `>= 2.1.169`; below it, or when `resolveClaudePath()` returns null, the overlay never starts and
  behavior is exactly today's. Cheap interim source while T200 lands: the registry file's own
  `version` field (`"version":"2.1.222"`), three lines inside `parseRegistryEntry`.

### 5.3 State mapping — no parallel vocabulary

A new pure `bgStateToTaskState(state)` in `src/main/claude-agents.ts`, shaped exactly like
`registryStatusToTaskState` (`session-registry-watch.ts:84-95`):

| CLI `state`     | Capy `TaskState` | Then, via `classifyFleetState`                    | Why                                                                                                                                                                                                                                                   |
| --------------- | ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working`       | `working`        | `working` → `stuck` after `STUCK_AFTER_MS`        | Same aging as every other `working` claim (P2)                                                                                                                                                                                                        |
| `blocked`       | `needs-input`    | `needs-you` → `return-here` when forgotten        | `isNeedsInput` (`fleet-state.ts:243-258`) gains a `bgState === 'needs-input'` branch below `registryState`                                                                                                                                            |
| `done`          | `idle`           | `idle`                                            | **Not** `completed`. `completed` is a terminal hook state from `SessionEnd` (`hook-state.ts:61-62`); a `done` background job is respawnable (`respawnFlags` in `state.json`) and folding it into `idle` matches how the registry maps its own `idle`. |
| _anything else_ | `undefined`      | no override — the session keeps its other signals | See below                                                                                                                                                                                                                                             |

Interactive rows never reach this function (P1); if the partition is ever loosened, their `status`
maps through the **existing** `registryStatusToTaskState`, unchanged and re-exported — not a copy.

**Unknown values from a newer CLI.** The repo's convention is _tolerate, degrade to no-opinion,
never throw_, and it is already the default branch of the sibling mapper:
`session-registry-watch.ts:92-94` (`default: return undefined` — "absent field, unknown value →
no override"), `roadmap-core.ts:456` (unrecognized `substrate` → `undefined`),
`stores/helpers.ts:117` (unknown pane type → forward-compatible skip),
`stores/session-notify.ts:127` (unknown value → default). T205 follows it exactly: an unrecognized
`state` yields `undefined`, the session falls through to its next signal, and one `console.info` is
emitted per distinct unknown value per app run (never per tick). A row missing `state` entirely, a
non-array payload, or a `sessionId` that is not a non-empty string is dropped — same posture as
`parseRegistryEntry` (`session-registry-watch.ts:56-76`).

### 5.4 Alternatives rejected

- **Parse `~/.claude/jobs/<id>/state.json` directly.** Tempting — strictly more data, no process at
  all. Rejected as the _primary_ source: the card's premise is that a supported contract beats
  reverse-engineered files, and adopting a second undocumented schema the same day undercuts it.
  Used as a **change signal only** (§5.2) — "a file changed" is a fact no schema can invalidate.
- **Replace transcript truth.** Rejected. The command says nothing about the ~700 historical PTY
  sessions on disk; `transcript-truth.ts` stays the sole level-5 source, untouched.
- **Pass `--all`.** Rejected (§4): completed background sessions are not fleet state. Revisit only
  if a "background session history" surface is ever specified.
- **Make the interval a user setting.** Rejected for v1 — a Settings row costs `design.md` §6, both
  locale files and a pref migration, to tune a constant nobody has had a reason to tune.
- **Per-folder `--cwd` calls.** Rejected: N spawns instead of one, and its documented scope
  disagreed with observed behavior (§2).

### 5.5 Open questions

- **Q1 — `waitingFor` was never observed** on 2.1.222. If it only materializes while a session is
  actually blocked, the mapping is unaffected (`blocked` already → `needs-input`) and the string is
  a nice-to-have subtitle. If it is genuinely absent from this command's output, the card's third
  acceptance criterion is satisfiable for `state` only. **Flagged, not assumed** — verify by
  blocking a background session on a permission prompt and re-running.
- **Q2 — the full `state` enum.** Three values seen (`working`, `blocked`, `done`); `failed` /
  `queued` / `cancelled` plausible and unconfirmed. §5.3's tolerance makes this safe-but-under-mapped.
- **Q3 — should background sessions get a sidebar row at all?** P4 says no for now. If T206 (`--bg`
  dispatch substrate) lands, Capy will _own_ those sessions and they arrive through the normal
  folder/session path — P4 becomes moot rather than restrictive. Decide there.

## 6. Acceptance

- A background session running under a folder Capy already knows shows a live dot (`working` /
  `needs-you` / `idle`) that tracks the daemon, refreshed within 60 s of a change, and ages to
  `stuck` under the same timer as every other `working` claim.
- Zero behavioral change for interactive sessions: identical dots, identical Approval-Inbox counts,
  identical `stuck` timing, byte-for-byte the same `resolveActivity` verdicts.
- Zero `claude` spawns while the window is blurred; at most one in flight at any instant.
- A `sessionId` unknown to the fleet model produces no row (P4); a parked session is never
  resurrected (P3).
- An absent, older (`< 2.1.169`), failing, or unparseable CLI degrades to exactly today's behavior,
  silently, with one log line.
- An unrecognized `state` from a newer CLI yields no override and no crash.

## 7. Test plan

| Test                                                                                                                                                                                                | File                                                                                         | Asserts             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| Parse the **verbatim §2 array**; 3 rows in, 1 background row out; interactive rows discarded (P1)                                                                                                   | `tests/claude-agents-parse.test.ts` (new, for the new pure core `src/main/claude-agents.ts`) | §5.1 P1, §2 fixture |
| `bgStateToTaskState`: `working`→`working`, `blocked`→`needs-input`, `done`→`idle`; `queued`/`""`/`null`/`42`→`undefined`                                                                            | `tests/claude-agents-parse.test.ts`                                                          | §5.3                |
| Malformed payloads: non-array, `{}`, row without `sessionId`, row without `state`, invalid JSON → `[]`, never throws                                                                                | `tests/claude-agents-parse.test.ts`                                                          | §5.3                |
| A row whose `sessionId` is in no fleet row is dropped, not injected (the June-ghost case)                                                                                                           | `tests/claude-agents-parse.test.ts` + `tests/sessions-store.test.ts` (existing)              | §5.1 P4             |
| `resolveActivity` precedence: `bgState` set **and** `taskState` set → hooks win; `bgState` set **and** `registryState` set → registry wins; `bgState` alone → `bgState` wins over `transcriptState` | `tests/fleet-state.test.ts` (existing — extends the `resolveActivity` block)                 | §5.1 table          |
| `bgState: 'working'` with a stale anchor ages to `stuck`; `isLive` is satisfied by `bgState` presence alone                                                                                         | `tests/fleet-state.test.ts` (existing)                                                       | §5.1 P2             |
| `isNeedsInput`: `bgState: 'needs-input'` fires; a defined `registryState`/`taskState` that moved past the block suppresses it                                                                       | `tests/fleet-state.test.ts` (existing)                                                       | §5.3                |
| `markHibernated` clears `bgState`, and a subsequent poll result does not re-set it                                                                                                                  | `tests/sessions-store.test.ts` (existing)                                                    | §5.1 P3             |
| Regression — registry mapping and watcher behavior unchanged                                                                                                                                        | `tests/session-registry-watch.test.ts` (existing)                                            | §3, no drift        |
| Regression — `deriveTurnState` / `HUMAN_GATING_TOOLS` untouched                                                                                                                                     | `tests/transcript-truth.test.ts` (existing)                                                  | §5.4                |
| Regression — hibernation eligibility and the `working` strict-threshold rule unchanged                                                                                                              | `tests/fleet-policy.test.ts` (existing)                                                      | §3 replay hazard    |

**Honest gap.** The poller shell (spawn, focus gating, single-flight, chokidar-as-signal) is
env-bound glue — the exclusion class at `vitest.config.mts:42-48` (ADR-0001 pure-core/thin-shell),
same posture as `usage.ts`. Follow `tests/usage-poller.test.ts` for what is assertable
(single-flight sharing, focus/blur start-stop, kill on quit) and do **not** fake coverage of the
spawn itself; the mapping and precedence — where every real decision lives — are unit-tested above.

## 8. Contracts touched

- **`CHANGELOG.md` — YES.** A dated `### Added` bullet under `## 2026-08-05` ("Background Claude
  sessions now show a live state in the fleet…"). Newest existing entry is `## 2026-08-03`.
- **`docs/capy-features.md` — NO.** No new MCP verb, no changed ACK shape, no grant/confirm
  semantics, no affordance the agent should offer. This is fleet-state signal plumbing, which
  CLAUDE.md's litmus puts explicitly **out**. Marker stays at `v34`; use the **`no-awareness`**
  label if `scripts/ci/awareness-gate.mjs` trips on an unrelated file.
- **`docs/user/` — YES.** Two triggers: a new top-level `src/main/claude-agents.ts` fires
  `scripts/ci/user-docs-gate.mjs`, and background sessions becoming visible is user-reachable.
  Update `docs/user/sessions.md` — what a background session is, why its dot may lag up to 60 s,
  why one may not appear at all (P4).
- **`design.md` — NO.** No new visual state; background rows reuse the existing dot vocabulary. A
  dedicated "background" badge is out of scope — if ever wanted, `design.md` §6 is edited first.
- **i18n — NO new keys.** The interval is a module constant with no Settings row (§5.4). If that
  reverses, `en.json` **and** `pt-BR.json` land in the same change (schema parity, build gate).
- **T123 — no contradiction.** P4 keeps session _existence_ disk-derived, so the visibility window
  still governs the population and this overlay only annotates rows it already admitted (T123 §3.2).
  `get_fleet`'s schema and 50-row cap are untouched.
- **English-only — obeyed.** The source audit (`.capy/out/claude-code-sync-audit.md`) is in
  Portuguese; everything drawn from it here is translated.

## 9. Definition of done

- [ ] T200 (CLI version detection) landed, or the interim `version` read from the registry file (§5.2)
- [ ] `src/main/claude-agents.ts` — pure core (`parseAgentsJson`, `bgStateToTaskState`, `AgentRow`)
      **and** shell (version gate, `resolveClaudePath` + `sanitizeSpawnEnv` spawn, single-flight,
      focus-gated 60 s timer, `~/.claude/jobs` change-signal watcher, fail-open)
- [ ] Registered in `src/main/index.ts` beside `registerSessionRegistryWatcher` (`:554`), closed in
      `before-quit` (`:903`); IPC channel `claude:agentsState` in the preload, mirroring
      `claude:sessionRegistry` (`src/preload/index.ts:1625`)
- [ ] `sessions.ts`: `bgStates` map + `setBgState` wired in `init()` beside `onSessionRegistry`
      (`:4406`); `isLiveSignal` (`:1679-1685`) and `markHibernated` (`:1719-1725`) updated
- [ ] `fleet-state.ts`: `bgState` in `FleetSignals`/`ActivitySignals`; new level in `resolveActivity`,
      new branch in `isNeedsInput`; module doc carries the §5.1 precedence table
- [ ] All §7 tests green, including every existing-file regression
- [ ] `CHANGELOG.md` entry · `docs/user/sessions.md` updated
- [ ] `npm run typecheck` and `npm run build` pass
