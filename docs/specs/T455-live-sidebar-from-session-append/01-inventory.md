# T455 — Inventory of today's live-session path (§3 of the spec, U-1)

Every fact the sidebar row, `SessionPreview`, the fleet rail (`InboxRail` / `FleetBoardCard`) and
the MCP `get_fleet` / `get_session` verbs derive today **for a running session** from its JSONL
transcript or from the chokidar watcher. Citations are to `cb7fb58` (this branch's base). Card
numbers are the board's; the line numbers a card quotes are older than the code.

## 3.1 The facts, field by field

"Delta" is the watcher's `claude:session:updated` payload, `SessionUpdatePayload`
(`src/main/claude-watcher.ts:528-541`). "Model" is the main-process fleet model, refreshed by slug
passes (`src/main/fleet-model.ts`).

| Field                         | Consumers                                                                                                                     | Derived at                                                                                                                                                                                                                                                                        | How and when                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                   | all four                                                                                                                      | `claude-reader.ts:581` (first line wins), `:1146` (file-name fallback); watcher `classify` `claude-watcher.ts:189`                                                                                                                                                                | Head fold on a scan or slug pass. A Harnu-spawned row is `synthetic-<uuid>` (`stores/sessions.ts:3038`, `:3117`, `:3385`) until migration (§4 of the spec).                                        |
| title (`summary`)             | sidebar label, rail card, `get_session` preview                                                                               | `summary: header.customTitle \|\| header.aiTitle` (`claude-reader.ts:1157`); head fold, latest wins (`:591-596`), frozen at the 2 MB head cap (`:433`); the 512 KB tail window overrides it (`:828-829`); entry kinds `custom-title` / `ai-title` (`transcript-truth.ts:223-232`) | Delta `renameTitle` / `aiTitle` (`claude-watcher.ts:610-619`), applied at `stores/sessions.ts:5506-5507` (a rename always wins; an ai-title fills an empty label only).                            |
| `aiSummary` (Haiku title)     | label cascade (`session-label.ts:49-51`)                                                                                      | `session-autoname.ts:55-79` → `haiku-autoname.ts:14-25`                                                                                                                                                                                                                           | Renderer only, from `onSessionUpdated` (`stores/sessions.ts:5524`), for born-synthetic rows with no title and a `firstPrompt`. Main and MCP never see it.                                          |
| `firstPrompt`                 | label and preview fallback, `get_session` preview, Haiku input                                                                | head fold, first real user prompt (`claude-reader.ts:601-612`); `firstRealPrompt` strips wrappers, caps at 120 chars (`claude-reader-derive.ts:6`, `:47-55`)                                                                                                                      | Delta `firstPromptCandidate` (`claude-watcher.ts:620-629`), applied only when empty (`stores/sessions.ts:5522`); on a missed `add`, an 8 KB head read (`claude-watcher.ts:1213`).                  |
| "what's happening" (subtitle) | preview body (`SessionPreview.vue:67-69`, `:268-282`)                                                                         | `pickWhatsHappening(taskSummary → lastPrompt → firstPrompt)` (`transcript-truth.ts:260-265`), from the `task-summary` and `last-prompt` metadata lines of the tail (`transcript-truth.ts:233-242`), applied at `claude-reader.ts:823-824`                                         | **Not in the delta**: stale in the renderer until a membership reload (finding F3 below). "Last prompt" is the CLI's own `last-prompt` metadata line, not a conversation row.                      |
| last assistant text           | none of the four surfaces                                                                                                     | not derived for live rows; `readSessionTail` (`claude-reader.ts:853-892`) runs only on demand for the T38 digest                                                                                                                                                                  | The rail's second line is the last PTY line, polled (`FleetBoardCard.vue:87-104`). The `Stop` hook body carries it (`last_assistant_message`), and the hook bridge drops it (F6).                  |
| tool-call count               | preview tally (`SessionPreview.vue:88-97`), rail "spinning on" (`FleetBoardCard.vue:82-86`), stuck dot (`fleet-state.ts:173`) | only `stagnation.calls`: `tool_use` blocks in a 5-minute window of transcript time (`STAGNATION_WINDOW_MS`, `stall-detect.ts:21`; `:76-103`, `:145-148`) over the tail window; no session total                                                                                   | Per delta, no accumulator, sent only when `calls > 0` (`claude-watcher.ts:484-491`, `:512-513`).                                                                                                   |
| `messageCount`                | preview footer (`SessionPreview.vue:289`)                                                                                     | `header.userMessageCount`: every non-sidechain `type: 'user'` line, tool results included (`claude-reader.ts:601-602`, `:1158`); frozen at the 2 MB head cap                                                                                                                      | Not in the delta; updated by a reload or the post-migration backfill (`stores/sessions.ts:4986`).                                                                                                  |
| `modified` / last activity    | session sort (`session-sort.ts:51`), stuck anchor (`fleet-state.ts:174-179`), preview and rail times, `get_fleet` `modified`  | main: `stat.mtime` (`claude-reader.ts:1160`)                                                                                                                                                                                                                                      | Two clocks (F4): the renderer overwrites it with its own receipt time on every delta (`stores/sessions.ts:5501`); main lags up to ~2.25 s (2000 ms append cadence plus the 250 ms window).         |
| `status` (active/idle)        | legacy dot fallback (`fleet-state.ts:229`), `get_fleet`                                                                       | renderer: `'active'` on each delta (`stores/sessions.ts:5502`), idle after 5000 ms (`:501`, `:4825-4835`)                                                                                                                                                                         | Main: always `'idle'` for a disk session (`claude-reader.ts:1164`), copied through by `toFleetInputs` (`mcp/tool-handlers.ts:323`) (F1).                                                           |
| `transcriptState`             | dot, board, rail (`fleet-state.ts:224-225`, `:255-257`)                                                                       | `deriveTurnState` on the tail's last chain participant (`transcript-truth.ts:150-190`), applied at `claude-reader.ts:820`                                                                                                                                                         | Delta (`claude-watcher.ts:506-507`), applied at `stores/sessions.ts:5513`. Not in `get_fleet`. Already shadowed by the T389 `taskState` family (P1W5).                                             |
| `ctxPct`                      | preview (`SessionPreview.vue:62-64`), rail (`FleetBoardCard.vue:60-62`)                                                       | `computeCtxPct`: last assistant `usage` over a 200k (or 1M) window (`transcript-truth.ts:295-298`, `:343-366`)                                                                                                                                                                    | Delta (`claude-watcher.ts:508-509`); falls back to the statusLine. Already shadowed by the T389 `telemetry` family (P1W6, `usage.measured`).                                                       |
| `awaySummary`                 | preview (`SessionPreview.vue:72`, `:200-224`)                                                                                 | `extractAwaySummary`: the latest `system` / `away_summary` row (`transcript-truth.ts:272-287`)                                                                                                                                                                                    | Delta, capped at 8 KB (`claude-watcher.ts:510-511`, `:564`).                                                                                                                                       |
| `gitBranch`, `cwd`            | session row, folder grouping, spawn cwd, `get_fleet` `folderAlias`                                                            | first line wins (`claude-reader.ts:582-583`, `:1161-1162`); folder branch by `probeGitMetaBatch`, 60 s TTL (`git-probe.ts:30`)                                                                                                                                                    | Scan only.                                                                                                                                                                                         |
| fork lineage                  | the fork placeholder's label                                                                                                  | not derived from JSONL (`parentUuid` / `leafUuid` are never parsed); `forkSourceId` lives in the renderer only (`stores/sessions.ts:3406`) and is cleared on migration (`:5058`)                                                                                                  | Verified on 2.1.296 (03-prototype.md §P.4): a fork's JSONL restamps every copied row with the new id, so the file holds no parent id at all.                                                       |
| subagents                     | chevron and count (`SidebarFolder.vue:829-839`), preview                                                                      | `attachSubagents` (`claude-reader.ts:1424-1500`): 64 KB head, cached, running/done from a 15 s mtime window (`:45`, `:1477`)                                                                                                                                                      | Delta `claude:subagent:updated` (`stores/sessions.ts:4872-4916`); dropped while the parent row is still synthetic (`:4885-4886`). Out of T455's scope: T202 and P1W5's `subagent.*` events own it. |

`get_fleet` returns per session only `sessionId`, `folderAlias`, `status`, `isSidechain`,
`modified`, `taskState`, `failureReason`, `orchestrator`, `hibernated`, `peer` and `inflight`
(`mcp/fleet-snapshot.ts:294-322`), although the comment at `fleet-model.ts:39-42` promises more
(F2). `get_session` adds `preview = firstPrompt + summary` (`mcp/tool-handlers.ts:568-570`).

## 3.2 Findings that shape the design

- **F1.** `get_fleet` reports every disk session as `idle`: `status: 'idle'` is hard-coded
  (`claude-reader.ts:1164`). An agent reading the fleet cannot tell a running session from a cold
  one except through `taskState`, which survives only while the session has a live PTY
  (`mcp/tool-handlers.ts:404-414`).
- **F3.** Most fields go stale in the renderer while a session runs. The fleet model reruns a slug
  pass on appends (`claude-watcher.ts:1238`), but `fleet:changed` is pushed only on a membership
  change (signature over (path, id) plus git meta, `fleet-model-core.ts:257-263`; gate at
  `fleet-model.ts:353-354`). "What's happening", `messageCount` and branch wait for an unrelated
  reload.
- **F4.** Two clocks feed `modified` (main: file mtime; renderer: receipt time).
- **F5.** A fork synthetic never gets the 120 s boot reaper: `createForkedSession`
  (`stores/sessions.ts:3378-3417`) does not call `armAgentBootDeadline`, while `createNewSession`
  (`:3074`), `dispatchCardSession` (`:3161`) and `insertAgentSession` (`:3279`) do.
- **F6.** Push data that already reaches main is thrown away: the hook bridge forwards only
  `{sessionId, event, matcher, ts, failureReason, resetsAt, agentId}` (`hook-bridge.ts:162-171`),
  dropping `last_assistant_message` (Stop) and `session_title` (SessionStart, UserPromptSubmit).
- **F7 (measured, 02-cost.md).** One append to a session in a large project directory makes Harnu
  main open ~2,800 _other_ transcripts of that directory within the minute.
- **F8 (measured, corpus of the 400 most recent transcripts on this machine, 2026-10-09).**
  `task-summary` appears in 0/400, `last-prompt` in 400/400, `ai-title` in 30/400, `custom-title`
  in 3/400, `away_summary` in 36/400. The `taskSummary` arm of "what's happening" is dead on this
  CLI; the subtitle is `lastPrompt` in practice.

## 3.3 The watcher (`src/main/claude-watcher.ts`)

`chokidar.watch(~/.claude/projects, …)` at `:1052-1066` (chokidar 5.0.0): `ignoreInitial: true`,
`persistent: true`, `atomic: true`, `followSymlinks: false`, `depth: 4`,
`ignorePermissionErrors: true`, `awaitWriteFinish: false`, no polling (native inotify on Linux).
It ignores dotfiles, `tool-results`, and every file that is not `.jsonl` or `sessions-index.json`
(`:1028-1050`). On this machine its inotify instance holds **13,902 watches** (counted from
`/proc/<harnu main>/fdinfo`, 2026-10-09).

| Trigger                                  | Read                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `add` of a new JSONL (`:1109-1156`)      | the whole file from offset 0, no cap (`:1115`, `:1133`), then classify by entrypoint |
| `change` on a known path (`:1181-1264`)  | only `[offset, size)` (`:418-432`)                                                   |
| `change` after a missed `add`            | last 256 KB plus an 8 KB head (`:330-332`, `:1199-1213`)                             |
| rewrite (`/compact` shrink or new inode) | re-baseline to EOF, emit nothing (`:398-407`)                                        |

| Debounce / throttle                    | Value                         | Where                                                      |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `session:updated` coalescer            | 150 ms trailing, 500 ms max   | `claude-watcher.ts:701-702`, `:776-838`                    |
| `session:added`                        | immediate                     | `claude-watcher.ts:825-827`                                |
| fleet-model membership window          | 250 ms fixed                  | `fleet-model.ts:63`, `:149-157`                            |
| fleet-model append cadence (slug pass) | ≤ 1 pass per 2000 ms per slug | `fleet-model.ts:66` (`APPEND_MIN_INTERVAL_MS`), `:173-192` |
| renderer reload                        | 250 ms debounce, 1000 ms max  | `stores/sessions.ts:4461-4482`                             |

A slug pass (`scanFoldersUncached({ slugsFilter })`, `claude-reader.ts:1572-1626`) readdirs the
slug, stats every JSONL, consults a header cache keyed on (mtime, size) (`:1008-1012`), keeps
incremental folds for only 16 transcripts (`FOLD_RETAIN_MAX`, `:954`) and re-scrapes past that (up
to 2 MB head plus 512 KB tail), readdirs every `<uuid>/subagents/`, and probes git. The watcher's
`TailState` and the reader's fold read the same appended bytes independently.

## 3.4 The synthetic → real migration today

**New session (`claude-new`).**

1. `createNewSession` (`stores/sessions.ts:3016`) dedupes against a live synthetic (`:3026`), mints
   `synthetic-<uuid>` (`:3038`) and arms the 120 s reaper (`:3074`; `AGENT_BOOT_TIMEOUT_MS`,
   `synthetic-reaper.ts:30`).
2. The PTY spawns `claude` (or `--session-id <uuid>` when pre-minted) in the folder
   (`spawn-spec.ts:125-133`, `pty.ts:707-733`).
3. The CLI writes the transcript only once the conversation has content (lesson
   `docs/lessons/synthetic-sessions/004-claim-not-rekey-before-transcript.md`). The watcher's
   `add` reads the whole file and fires `claude:session:added`.
4. `reconcileSessionAdded` (`stores/sessions.ts:5198-5225`) binds, in order: the companion claim
   (`bindByClaim`, `:5134-5169`, only when the claim acts); `findFolderBySlugOrPath`, whose route 2
   forward-encodes folder paths with `[^a-zA-Z0-9] → '-'` (`folder-slug.ts:39-41`, `:82-98`) — the
   **cwd → slug guess**; a cross-slug re-home; `tryBindAgentMigration` (10 s window,
   `AGENT_MIGRATE_WINDOW_MS`, `:516`); `collapseSyntheticInto`, the **newest synthetic of the
   folder by `created`** (`:5034-5044`), which renames in place, fires `fireMigrate` (PTY re-key)
   and backfills metadata with a full `foldersLoad` (`:4967-4989`).
5. Fallback: `pendingCollapse`, resolved on the next `fleet:changed`, expires after 5 minutes
   (`SYNTH_RESOLVE_WINDOW_MS`, `:4605-4636`).

Races it handles: a delta for an unknown id is dropped unless it carries a rename (`:5493-5497`);
subagent deltas for a still-synthetic parent are dropped (`:4885`); BUG-147 (`session:added`
outruns the 250 ms model refresh); concurrent `dispatchCardSession` calls into one folder rely on
the recency guess.

**Resume (`claude --resume <uuid>`).** A real row from the start (`spawn-spec.ts:134-147`), no
synthetic. Verified on 2.1.296: the CLI keeps the id and appends to the same `<uuid>.jsonl`
(03-prototype.md §P.4). In-session `/resume` and `/clear` move the PTY to another id; only the
companion's `session.rebound` handles that, and only while its claim acts.

**Fork (`--resume <src> --fork-session`).** `createForkedSession` (`stores/sessions.ts:3378-3417`)
— no dedupe, no boot reaper (F5), `projectPath = source.projectPath`. The new id's JSONL lands in
the source cwd's slug; it binds through route 1 (the source's `fullPath`) and then the same
recency pick as a new session.

## 3.5 Push paths that already bypass the JSONL

| Source                                       | Facts                                                                      | Where                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| hook bridge                                  | task state, `failureReason`, `resetsAt`, `agentId`; bodies dropped (F6)    | `hook-bridge.ts:139-171`, `hook-state.ts:47-86`, `detect/task-state-hub.ts:181-242` |
| PID registry `~/.claude/sessions/<pid>.json` | busy / waiting / idle                                                      | `session-registry-watch.ts:56-95`                                                   |
| statusLine inbox                             | model, cost, lines, context %, rate limits, cwd                            | `statusline-parse.ts:95-153`                                                        |
| Harnu mod (T389)                             | identity claim, turn, attention, subagents, usage — no text, no tool count | see the spec §5.1                                                                   |

## 3.6 Board cards

| Card            | Status  | Symptom                                                                                                                     | Rows it hits                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **BUG-146**     | review  | Idle CPU: a slug rescan and one IPC per append; main ~13 % and renderer ~29 % (324 slugs, 9,345 JSONLs)                     | watcher, slug pass, `modified`; mitigations landed (coalescer, slim payload, fold) |
| **BUG-156**     | review  | Append cadence ≤ 0.5 passes/s per slug; main CPU 38.8 % → 10.9 %; accepted `get_fleet` lag ~2.3 s                           | `fleet-model.ts:66`, `modified`                                                    |
| **BUG-88**      | ready   | In-place migration leaves an "Untitled session" ghost frozen at the top of the rail                                         | migration, title, first prompt, `modified`; the backfill fix appears to be in code |
| **T123**        | ready   | Centralized fleet index; S2 (scan on a worker thread) not landed: the boot scan still runs on main (`fleet-model.ts:26-27`) | every `get_fleet` field                                                            |
| BUG-147         | review  | New sessions show late: `session:added` outruns the 250 ms model refresh                                                    | migration, backfill race                                                           |
| BUG-158/160/167 | backlog | Flaky chokidar end-to-end tests                                                                                             | watcher                                                                            |
| BUG-78          | review  | Rename label froze at the first name                                                                                        | title                                                                              |
| T202            | backlog | Subagent done-state is a 15 s mtime guess                                                                                   | subagents (out of scope here)                                                      |
| T204            | backlog | Drop the dead `sessions-index.json` path                                                                                    | title, count (index path)                                                          |
| T205            | backlog | Reconcile against `claude agents --json`; CLI drift (fork pointers, no-op resumes)                                          | fork, resume                                                                       |
