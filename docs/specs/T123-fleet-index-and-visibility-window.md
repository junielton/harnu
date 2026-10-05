# PRD: Fleet index & session visibility window

> **Status:** Draft
> **Author:** junielton (product decisions) + Claude (investigation & drafting)
> **Created:** 2026-07-14
> **Last Updated:** 2026-07-14
> **Cards:** T123 (this spec), BUG-31 (tactical fix shipped), BUG-32 (in scope here)

---

## 1. Overview

### 1.1 Summary

Replace the "re-derive the whole fleet from disk on demand" design with one central,
watcher-fed, in-memory fleet model owned by the main process, populated off the main
thread, and filtered by a user-configurable **session visibility window** (12h…30d).
Also hardens the two failure modes uncovered in the 2026-07-14 incident: MCP tool
handlers that hang forever (retaining memory), and the `capy.mcp.json` delete/rewrite
race that kills session boots when the control server is toggled.

### 1.2 Problem Statement

On 2026-07-14 Capy's main process died with a V8 heap OOM (~4 GB live heap,
mark-compacts reclaiming nothing), taking every open session down. Investigation
(BUG-31) found that **every** MCP tool call ran its own full `scanFolders()` pass over
`~/.claude/projects/` — with a real-world history of **690 sessions across ~130
folders**, each call cost a readdir + JSONL header scrape + one git probe per folder.
Under concurrent agent traffic (amplified by the PR #113 free-by-default reversal,
which removed the human-confirm throttle), calls piled up: each stuck in-flight
handler retained its own private copy of the fleet model, there is **no server-side
timeout**, and the heap grew until V8 aborted. Secondary symptoms: multi-minute MCP
hangs across unrelated repos, and the sidebar's right-click stalling for seconds.

A single-flight + 2s TTL cache on `scanFolders()` (shipped, BUG-31) stops the acute
bleeding, but three structural problems remain:

1. The full scan still runs on the main thread and re-runs every TTL expiry under
   sustained traffic. Cost grows unbounded with history age.
2. MCP handlers still have no deadline — any future slowness re-opens the
   pile-up/retention loop.
3. Toggling the control server deletes `capy.mcp.json` in place; sessions spawned or
   resumed in the gap die at boot ("MCP config file not found") or come up without
   the capy connector (BUG-32).

---

## 2. User Stories

- As an operator running many agents, I want Capy to answer MCP calls without
  re-scanning my entire session history, so that agent fan-outs don't freeze the app
  or crash it with OOM.
- As an operator with months of accumulated sessions, I want the sidebar to show only
  recent sessions (configurable window), so the UI stays fast and relevant.
- As an operator, I want to see in Settings how many sessions exist in total vs. how
  many are shown, so the window setting is legible.
- As an operator, I want toggling the control server to never kill a session that is
  booting, so mitigation actions don't cause collateral damage.
- As an agent (MCP client), I want a slow tool call to fail fast with a clear error
  instead of hanging for minutes, so I can retry or escalate instead of stalling.

---

## 3. Functional Requirements

### 3.1 Acceptance Criteria

**W1 — Central fleet model**

- [ ] AC1: Given the app is past boot, when any consumer (MCP `handleToolCall`,
      `memory-digest`, `it2-bridge`, memory/markdown root resolution, `foldersLoad`)
      needs the fleet, then it reads the in-memory model — zero disk scans on those
      call paths (assertable via a test seam / scan counter).
- [ ] AC2: Given a burst of 20 concurrent MCP calls, when they resolve, then at most
      one model refresh ran and all calls shared the same model reference.
- [ ] AC3: Given a session JSONL is created/appended/removed on disk, when the
      chokidar watcher reports it, then the model reflects the change without a full
      rescan (incremental update, debounced).

**W2 — Scan off the main thread**

- [ ] AC4: Given a cold boot, when the initial full scan runs, then it executes in a
      `utilityProcess` (separate heap) and the main event loop's longest blocking
      interval during the scan stays under 50 ms.
- [ ] AC5: Given the scan process crashes, when the model needs (re)building, then
      the scan is retried with backoff, and after N failures Capy degrades to the
      last snapshot (or empty model) with a visible degraded notice — never a hang.

**W3 — Visibility window + counter**

- [ ] AC6: Given the visibility window is W, when the sidebar and `get_fleet` render,
      then sessions whose transcript mtime is older than W are absent from both;
      pinned folders remain listed regardless; discovered (non-pinned) folders with
      zero in-window sessions are hidden from the sidebar but remain valid policy
      roots for agent verbs.
- [ ] AC7: Given a session has a live PTY (or is hibernated-but-live-registered),
      when the window filter is applied, then it is always visible regardless of
      mtime.
- [ ] AC8: Given the operator changes the window in Settings, when they confirm,
      then the sidebar re-filters from the model without an app restart; widening
      the window deep-indexes the newly included sessions in the background.
- [ ] AC9: Given Settings → (Sessions/Control) is open, then it shows
      "{total} sessions on disk · {shown} in window · {live} live", where {total}
      comes from cheap enumeration (no JSONL content reads).
- [ ] AC10: The window control offers exactly these steps: 12h, 24h, 2 days, 5 days,
      10 days, 15 days, 20 days, 30 days. Factory default: **30 days**. New i18n keys
      land in BOTH `en.json` and `pt-BR.json` (build enforces schema parity).

**W4 — Warm-start snapshot**

- [ ] AC11: Given a prior run persisted a model snapshot, when the app boots, then
      the sidebar renders from the snapshot immediately while the fresh scan runs in
      the background; a corrupt/missing snapshot silently falls back to a fresh scan.

**W5 — MCP handler deadline**

- [ ] AC12: Given a tool handler exceeds the server-side deadline (120 s), when it
      trips, then the call returns a structured `TOOL_TIMEOUT` error, the handler's
      retained scope is released, and the audit log records the timeout.
- [ ] AC13: Given the incident's failure pattern (handlers outliving a 300 s client
      timeout), when clients abandon calls, then server-side in-flight handler count
      is bounded (deadline guarantees release; no unbounded pile-up).

**W6 — BUG-32: `capy.mcp.json` lifecycle**

- [ ] AC14: Given the control server is off (or the config file is absent at spawn
      time), when a `claude-*` session spawns/resumes, then the `--mcp-config` argv
      is omitted entirely — the session boots normally, just without the capy
      connector. "MCP config file not found" can no longer occur from Capy's own
      argv.
- [ ] AC15: Given the server (re)starts, when `capy.mcp.json` is written, then the
      write is atomic (temp file + rename) — no reader can observe a partial file.
- [ ] AC16: Given sessions were running before a server restart, when the server
      comes back, then their bearer token still authenticates (token persisted
      per-install, rotated only explicitly — see Open Questions for the tradeoff).

### 3.2 Business Rules

- The visibility window governs **scan depth, sidebar, and `get_fleet`** alike — one
  truth. Deep metadata (first prompt, summary, subagents) is only parsed for
  in-window sessions; out-of-window sessions exist in the model as stat-level rows
  (id, mtime, folder) for counting and fast window-widening.
- Folder identity (paths, git meta, pinned state) is **never** window-filtered — only
  session rows are. Agent policy roots and `open_file` targets must not silently
  shrink because sessions aged out.
- `get_fleet`'s existing 50-row disclosure cap stays; the window bounds the
  population, the cap bounds the response.

---

## 4. User Experience

### 4.1 User Flow

1. Operator opens Settings → the sessions/scan section shows the window select
   (default "30 days") and the counter line ("690 sessions on disk · 143 in window ·
   4 live").
2. Operator picks "5 days" → sidebar immediately shrinks to recent sessions; the
   counter updates; no restart.
3. Months later, history has doubled; nothing gets slower, because out-of-window
   sessions were never deep-parsed.

### 4.2 UI/UX Considerations

- Counter lives in Settings only (operator decision) — no footer change.
- Copy follows `design.md` §8; keys in both locales; technical nouns untranslated.
- No new colors/sizes expected; if the Settings row needs a new component variant,
  `design.md` §6 is updated in the same change (design contract).

---

## 5. Technical Approach

### 5.1 Architecture

```
                    ┌────────────────────────────── main process ─┐
 chokidar watcher ──┤ fleet-model.ts (NEW)                        │
 (claude-watcher)   │  • Map<path, FolderRow>                     │
                    │  • sessions: stat rows (all) +              │
                    │    deep rows (in-window)                    │
                    │  • version counter + change events          │
                    │  • windowFilter(view) pure core             │
                    └───────┬──────────────┬──────────────────────┘
                            │ read         │ (re)build request
      MCP server / IPC /    │              ▼
      digest / bridge ──────┘        utilityProcess scanner (NEW)
                                     • full scan = today's scanFoldersUncached
                                     • per-folder git-probe concurrency limit
                                     • posts FolderEntry[] back
                            ▲
                            │ warm start
                     userData/fleet-index.json (snapshot, atomic write)
```

- `scanFolders()` keeps its signature but becomes a model read (the BUG-31
  single-flight cache dissolves into the model). Test-only `rootDir`/`slugsFilter`
  paths keep the direct uncached scan.
- Deep-index rule: parse JSONL headers / subagents only when `mtime >= now - window`.
  Widening the window enqueues deep-indexing for newly included stat rows.
- Deadline wrapper in `handleToolCall`: `Promise.race` with a 120 s timer returning
  `errorResult('TOOL_TIMEOUT')`; the audit record notes the timeout. (The underlying
  work is not forcibly cancelled — Node can't — but nothing retains the model copy,
  which is the leak that mattered.)
- BUG-32: `mcpArgsProvider` re-checks file existence at spawn time (it already
  returns `[]` when the pref is off); `writeMcpConfigFile` becomes write-temp+rename;
  bearer token read from a persisted secret (0600) instead of minted per boot.

### 5.2 Data Model

Snapshot file `userData/fleet-index.json` (version-stamped):

```jsonc
{
  "version": 1,
  "generatedAt": "2026-07-14T15:00:00Z",
  "folders": [/* FolderEntry, deep rows only for in-window sessions */],
  "shallow": [{ "sessionId": "…", "folderPath": "…", "mtimeMs": 0 }],
  "totals": { "onDisk": 690 }
}
```

### 5.3 Settings & IPC contracts

- New pref (global, `settings.json` or dedicated prefs file):
  `sessionVisibilityWindowHours: 12 | 24 | 48 | 120 | 240 | 360 | 480 | 720`
  (default 720 = 30 days).
- New/changed IPC: `fleet:counts` (or fold counts into the existing settings
  payload); `foldersLoad` result becomes window-filtered.
- MCP: no new verbs; `get_fleet`/`get_session` read the model. **Not** agent-facing
  per the litmus (no new verb/ACK semantics) → `docs/capy-features.md` untouched;
  re-evaluate only if `get_fleet` gains a counts field.

### 5.4 Dependencies

None external. `utilityProcess` is Electron built-in; snapshot is plain JSON.
Explicit non-goals: Redis (external daemon, wrong tool — cost is re-derivation, not
lookup), queue brokers, SQLite (revisit only if snapshot parse ever measures hot).

---

## 6. Edge Cases & Error Handling

| Scenario                                 | Expected Behavior                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| All sessions older than window           | Sidebar shows pinned folders + empty-state; counter explains ("690 on disk · 0 in window") |
| Session older than window has a live PTY | Always visible (AC7)                                                                       |
| Hibernated session ages past the window  | Drops from view; transcript intact on disk; reappears if window widened                    |
| Snapshot corrupt / version mismatch      | Ignore, fresh scan, overwrite                                                              |
| Scanner process crash loop               | Backoff retries → degrade to last snapshot + degraded notice (mirrors watcher-degraded UX) |
| Future mtimes (clock skew)               | Treated as in-window (recent)                                                              |
| Window widened 12h → 30d                 | Stat rows hydrate in background; sidebar fills progressively                               |
| Git probe hangs on a network mount       | Per-probe timeout inside scanner; folder degrades to no-git metadata                       |
| `capy.mcp.json` absent at spawn          | `--mcp-config` omitted; session boots without capy connector (AC14)                        |
| Tool call exceeds 120 s                  | `TOOL_TIMEOUT` structured error + audit record (AC12)                                      |

---

## 7. Testing Strategy

### 7.1 Unit (pure core — ADR-0001 surface)

Window filter (boundaries, live-PTY override, pinned-folder rule); model reducers
(watcher event → model delta); snapshot serialize/parse/version-reject; deadline
wrapper; spawn argv omission when config absent.

### 7.2 Integration

utilityProcess round-trip on a fixture tree; warm-start (snapshot then fresh scan
supersedes); concurrent-burst test asserting single refresh (extends BUG-31 tests);
atomic-write reader test.

### 7.3 Manual checklist

- [ ] 690-session real history: boot time, sidebar latency, right-click under a
      20-call MCP burst
- [ ] Change window live; watch counter + sidebar
- [ ] Toggle control server off/on while resuming a session — no boot failure
- [ ] Kill the scanner process mid-scan — degraded notice, no hang
- [ ] `npm run typecheck` + `npm run build` green

---

## 8. Out of Scope

- Browsing/searching out-of-window sessions (future "history browser").
- Redis / brokers / SQLite / any external service.
- Changing `get_fleet`'s 50-row disclosure cap or its schema.
- Renderer-side virtualization of the sidebar list.
- Retroactive cleanup/archival of old JSONL files (Capy never deletes transcripts).

---

## 9. Open Questions

1. **Bearer token stability (AC16):** persisting the token per-install fixes stale
   tokens in long-lived sessions across server restarts, at the cost of a long-lived
   credential (loopback-only, 0600). Alternative: keep per-boot rotation and accept
   that pre-restart sessions must be resumed. Decide at implementation review.
2. Should `memory-digest`'s session sweep also respect the window (it consumes the
   same model, so it inherits the filter unless given a bypass)? Default: inherit.
3. Exact Settings placement: existing Control server pane vs. a new "Sessions"
   section. Default: wherever the current UI display-limit config lives.

---

## 10. References

- BUG-31 card (crash-dump analysis, tactical fix) · BUG-32 card (toggle race,
  screenshots) · T123 card (direction)
- `docs/specs/T119-session-hibernation.md` (live-session cap — the sibling policy)
- CHANGELOG 2026-07-14 "Capy no longer re-scans your entire session history…"
- Incident evidence: `journalctl` V8 OOM dump (mark-compact reclaiming ~0 at 4 GB;
  mutator utilization 3–6%), 300 s client-side MCP timeouts, 690-session fleet.

---

## Delivery slices (suggested PRs)

1. **S1** — `fleet-model.ts` + consumers read the model (kills per-call scans).
2. **S2** — utilityProcess scanner + snapshot warm start.
3. **S3** — visibility window: pref, Settings UI + counter, sidebar/get_fleet filter,
   i18n (both locales).
4. **S4** — MCP handler deadline + audit record.
5. **S5** — BUG-32: spawn-time argv omission, atomic write, token decision.

---

## 11. Observability seams (System Monitor integration)

A separate feature under design (a "System Monitor" pane — per-session/process
CPU-memory view, à la Chrome's task manager) will want to display what this spec
builds. Each slice therefore exposes cheap read-only counters — no polling
consumer may ever trigger a scan or any other work; it reads state that updates
as a side effect of work that was happening anyway:

- **S1 (`fleet-model.ts`)**: `modelVersion`, `lastRefreshAt`, `lastRefreshMs`,
  `refreshCount`, `sharedHitCount` (callers served without a refresh).
- **S2 (scanner)**: `queueDepth` (pending refresh requests), `scanning` flag,
  `lastScanMs`, `snapshotAgeMs`.
- **S3 (window)**: `{ onDisk, inWindow, live }` counts — the same numbers the
  Settings counter shows.
- **S4 (deadline)**: `inFlightToolCalls`, `timeoutsFired`, per-verb last-latency.

Already available today, no T123 needed: `app.getAppMetrics()` (per-Electron-process
CPU/memory), node-pty child pids → per-session `claude` RSS/CPU (`/proc` on Linux),
`v8.getHeapStatistics()` on main (heap-used vs limit — the exact early-warning
signal for the 2026-07-14 OOM), and the T119 activity/hibernation stamps in
`pty.ts`.

Suggested transport for the monitor: one main-side sampler (1–2 s interval,
active only while the monitor pane is visible) pushing over a single IPC channel,
mirroring the `pty:data` pattern. The monitor feature owns its UI/UX spec; this
section only pins the data contract so the two features compose.
