# T202 — Hook subscription widening: subagent lifecycle, background-agent notifications, and the fleet fields already on `Stop`

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T202-subscribe-the-hooks-that-already-exist-subagentstop-background.md`

## 1. Goal

Replace guessing with events the CLI already emits, and repair one matcher regression the CLI
introduced under us:

| Heuristic today                                                      | Event that replaces it                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| subagent `running`/`done` from a 15 s mtime window                   | `SubagentStart` / `SubagentStop` (v1.0.41 / v2.0.43)               |
| background agents are invisible                                      | `Notification:agent_needs_input` / `agent_completed` (v2.1.198)    |
| a session's background tasks/crons are unknown                       | `background_tasks` / `session_crons`, already on `Stop` (v2.1.145) |
| `worker_permission_prompt` caught by substring on the global install | an explicit matcher entry (broken by v2.1.195 — §3)                |

Non-goal: `PreCompact` (owned by `docs/specs/2026-08-02-t195-precompact-consolidation-handoff.md`)
and `PostCompact` (rejected, §4.5).

## 2. Current behaviour, verified

**The subscribed set — 13 entries, 11 distinct events** (`hook-installer.ts:39-56`). The card's
"8 events" is wrong: it is 8 session-state events (`Notification` ×2 with matchers
`permission_prompt` / `idle_prompt`, `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`,
`SessionEnd`, `PreToolUse` matcher `*`, `PermissionRequest`) plus 3 team observers
(`TaskCreated`, `TaskCompleted`, `TeammateIdle`, kept in lockstep with `TEAM_HOOK_EVENTS`,
`:65-69`). `PostToolUse`/`PostToolBatch` are deliberately omitted as high-frequency (`:36-37`).

**Two install paths, different sets.**

- Global: `~/.claude/settings.json` via `installHooks` (`hook-installer.ts:265-278`). Handlers are
  `{type:'http', url:'http://127.0.0.1:<port>/hook/<token>/<event>/<tag>', timeout:5, _capy:'v1'}`
  (`:71-84`). Identity is the **URL shape** (`BRIDGE_URL`, `:115`; `isOurs`, `:125-129`) — never the
  `_capy` key, which CC strips (`docs/lessons/framework/002-claude-code-strips-settings-hook-keys.md`).
  `reconcileHooks` (`:181-211`) prunes dead peers + our own token and keeps live peers and foreign hooks.
- Per session: the inline `--settings` blob (`hook-settings-blob.ts:88-100`), a deliberately narrower
  set — `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, and **four** Notification matchers
  (`:45-53`: `permission_prompt`, `worker_permission_prompt`, `elicitation_dialog`, `idle_prompt`).
  No `PreToolUse`/`PermissionRequest` (`:18-24`). A user `--settings <file>` **skips our blob
  entirely** (`:182`) — such a session gets fleet state only from the global install.

**The bridge** (`hook-bridge.ts:100-233`) derives the matcher from the URL tag, falling back to
`reason`/`source` for `SessionEnd`/`SessionStart` (`:168-173`), reads `session_id` (`:167`), classifies
`StopFailure` (`:178-186`), and folds through `reduceTaskState` (`hook-state.ts:35-66`). Team events
short-circuit at `:160-165`. **`handleBridgeEvent` (`:439-478`) does not forward `matcher` to the
renderer** — the `claude:hook` wire is `{sessionId, taskState, event, ts, failureReason?, resetsAt?}`
(`src/preload/index.ts:561-572`), and `sessions.ts:4393` reads only a subset of that.

**The heuristic being replaced.** A subagent transcript lives at
`<slug>/<parent>/subagents/agent-<id>.jsonl` (`claude-reader.ts:50`); there is **no terminal marker
in the file** (`:31-36`), so status is `now - mtime < 15_000 ? 'running' : 'done'`
(`claude-reader.ts:44`, applied at `:1097`), mirrored renderer-side by a re-armed timer
(`sessions.ts:463`, `scheduleAgentDone` `:3843-3853`). Three concrete defects:

1. **False `done`.** A subagent inside a >15 s tool call (build, long `Bash`, `WebFetch`) writes
   nothing and flips to `done` while alive. `liveAgentCount` (`fleet-state.ts:98-103`) drops to 0,
   so rule 0 of `resolveActivity` (`:187`, `if (sig.liveAgentCount > 0) return 'working'`) stops
   protecting the parent, and after `STUCK_AFTER_MS` (3 min, `:52`) a quiet orchestrator reads
   `stuck` — exactly the BUG-15 false positive that rule exists to prevent.
2. **Late `done`.** A finished subagent still counts as running for up to 15 s.
3. **No start signal.** The seed scan can only classify by mtime, so a just-created agent file can
   read `done` from birth.

## 3. The exact-match hazard (v2.1.195)

v2.1.195 changed hook matchers from substring to **exact** match. Capy's own routing is unaffected
(the bridge recovers the matcher from the URL tag, not from CC's matching) — what changes is
**whether CC fires at all**, and a matcher that stopped firing is silent: blind fleet state, no error.

| Matcher                    | Installed in  | Under exact match                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_prompt`        | global + blob | **REGRESSION.** Under substring it also caught `worker_permission_prompt` (a superstring). It no longer does, and the global install has no `worker_permission_prompt` entry — so a session covered only by the global path (external session, or a user `--settings <file>`, `hook-settings-blob.ts:182`) silently stopped going `needs-input` on a sub-agent permission prompt. |
| `worker_permission_prompt` | blob only     | Safe (exact literal) — and now load-bearing, because it is no longer reachable via the line above.                                                                                                                                                                                                                                                                                |
| `elicitation_dialog`       | blob only     | Safe; same gap on the global path.                                                                                                                                                                                                                                                                                                                                                |
| `idle_prompt`              | global + blob | Safe. No known CC notification type contains it as a substring, so nothing was silently lost.                                                                                                                                                                                                                                                                                     |
| `*` (PreToolUse)           | global only   | **UNVERIFIED.** If `*` is still special-cased as "all tools" it is fine; if exact match made it a literal tool name, `PreToolUse` never fires. The FSM degrades quietly (`UserPromptSubmit` still sets `working`) but the activity refresh is lost. Fix if confirmed: omit the `matcher` key entirely, as `Stop` does.                                                            |
| (no matcher key)           | both          | Unaffected — `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `PermissionRequest`, and the three team events carry no matcher.                                                                                                                                                                                                                            |

**Verdict: one real, already-live regression** (the `permission_prompt` → `worker_permission_prompt`
collapse on the global path) plus **one must-verify** (`*`). The repair is structural: hoist the
blob's `NEEDS_YOU_NOTIFICATION_TYPES` (`hook-settings-blob.ts:45-49`) into a single exported constant
that **both** install paths consume, so the two sets can never diverge again, and make the golden
matcher list a test (§6). No unit test can prove CC fires — the golden list guards our side; the live
check in §5 is what proves theirs.

## 4. Decision

### 4.1 `SubagentStart` / `SubagentStop` — installed in both paths

Added to `EVENT_SPECS` and to the blob (its "narrow set" doc comment `:18-24` is amended: these are
once-per-`Task` events, not chatty). Both carry the **parent** `session_id`, plus `agent_id` and
`agent_transcript_path` (v2.0.42), so the bridge's existing `session_id` read routes them unchanged.

- `hook-state.ts`: both stay **state-neutral** (already the default branch, `:63-64`). A parent with a
  live subagent is `working` via `liveAgentCount`, not via the FSM.
- `hook-bridge.ts`: `BridgeEvent` and the `claude:hook` payload gain `agentId?`, read from
  `body.agent_id`. `matcher` starts being forwarded too (it is computed at `:168` and then dropped).
- `sessions.ts`: `SubagentStart` → `markAgentRunning(parent, agentId)` — clears any `agentDoneTimers`
  entry and records the id in a per-parent live set; `SubagentStop` → sets that `agents[]` row `done`
  immediately and drops the id. The first subagent hook for a session marks it **hook-authoritative**;
  from then on `liveAgentCount` for that session is resolved from the hook set and the 15 s timer is
  never armed for it. Sessions that never emit a subagent hook keep today's timer verbatim — the AC's
  "heuristic kept only as the fallback".
- `fleet-state.ts` is **not touched**: it already consumes `liveAgentCount` as an injected signal;
  only the store's resolver changes. **User-visible:** a session whose subagent is inside a long tool
  call stays green `working` instead of turning `stuck` after 3 minutes, and the preview's agent count
  (`SessionPreview.vue:269-277`) goes exact.
- `agent_transcript_path` is **not** used to create rows — the watcher already owns row creation
  (`claude:subagent:updated`); a hook-created row would duplicate it. An id seen by a hook before its
  row exists still counts toward `liveAgentCount` via the live set.

### 4.2 `Notification:agent_needs_input` → the same treatment as a foreground block

Added to the shared Notification-type list, so it installs in **both** paths.
`reduceTaskState` gains one case beside `permission_prompt` (`hook-state.ts:50-52`) → `needs-input`.
Everything downstream is free: the attention badge (`attention.ts#countNeedsInput`), the notify router
(`session-notify.ts` via `sessions.ts:3344`), the fleet dot, the Fleet rail. **User sees:** a
background agent waiting on them raises the same needs-you the foreground raises today.

### 4.3 `Notification:agent_completed` → the Activity bell, not the FSM

Also installed in both paths, but **state-neutral**: the session may still be working, and folding it
to `idle` would extinguish a live dot. It rides the now-forwarded `matcher` to `sessions.ts`, which
calls `notifications.notify({source:'session', kind:'success', sessionId, …})`. **User sees:** a row
in the Topbar Activity bell (`ActivityBell.vue`) that navigates to the session.

### 4.4 `background_tasks` / `session_crons` — parsed at the bridge, shown in the preview

No new subscription: `Stop` is already installed in both paths, and `SubagentStop` (§4.1) carries
them too. A new pure, total helper in `hook-state.ts` (`parseFleetExtras(body)`) returns
`{backgroundTasks: number, sessionCrons: number}` from tolerant array reads — never throws, unknown
shapes count as 0. Counts (not bodies) cross the wire, land on the session entry, and render in the
`SessionPreview` footer beside the existing messages/agents counts: `"12 messages · 2 agents ·
1 background task"`. New i18n keys in **both** `en.json` and `pt-BR.json`. Counts only, deliberately —
task names are session content, and the preview is a glance surface.

### 4.5 Rejected and deferred

- **`PostCompact` — rejected.** The hook says "a compaction happened"; it does not carry the new token
  baseline. `computeCtxPct` (`transcript-truth.ts:341-368`) already resets on the JSONL's
  `compact_boundary.postTokens`, which is the authoritative number the hook body lacks. Subscribing it
  would add an event with no consumer. The card's claim #3 is wrong on this point.
- **`PreCompact` — deferred to T195**, which owns it as the digest-consolidation trigger. Installing
  it here would collide.
- **`hookSpecificOutput.additionalContext` on `Stop`/`SubagentStop` (v2.1.163) — out of scope.** The
  bridge is a pure observer that always answers `200 {}` (`hook-bridge.ts:56-58`); using it would make
  Capy inject text into every session turn. That belongs to the responder-governance model, not here.
- **`WorktreeCreate` (audit §4.3) — out of scope.** Different card.
- **Hook timeout stays 5 s** (`hook-installer.ts:24`, `hook-settings-blob.ts:30`). CC's 10-minute
  allowance since v2.1.3 is a ceiling, not a target: 5 s bounds how long a wedged bridge can stall a
  real session, and the internal responder deadline is 3.5 s (`hook-bridge.ts:52`). Every event added
  here is observe-and-return. No change.

### 4.6 Open questions (verify before shipping, do not guess)

1. Which `session_id` do `agent_needs_input`/`agent_completed` carry — the background agent's, or the
   launching session's? If it is an id Capy has no row for, the event drops silently at
   `sessions.ts`. Ship §4.2/§4.3 only after a live check; if the id is unknown, the fallback is a
   session-less Activity row (no `sessionId`, hence not click-to-dismiss, per BUG-49).
2. Element shape of `background_tasks`/`session_crons` — unverified against a live CLI. Hence the
   tolerant count-only parser.
3. Whether `*` still means "all tools" for `PreToolUse` (§3).

## 5. Acceptance

- Both install paths subscribe the same Notification-type list, from one shared constant; the global
  path fires on `worker_permission_prompt` and `elicitation_dialog` again.
- `SubagentStart`/`SubagentStop` are installed in both paths and drive subagent liveness for
  hook-wired sessions; the 15 s window survives only as the fallback for sessions that emit no
  subagent hook.
- `agent_needs_input` reaches the fleet state machine, the attention badge, and the notify router
  exactly as a foreground `permission_prompt` does; `agent_completed` reaches the Activity bell and
  changes no task state.
- `background_tasks`/`session_crons` are visible in the session hover preview.
- Marker/prune behaviour is unchanged: the new entries are identified by URL shape, foreign hooks and
  live peers survive install/uninstall/exit.
- Live check (`docs/dev/live-verify-second-instance.md`): a real session with a `Task` subagent shows
  the subagent flipping `running → done` on the hook, not 15 s later.

## 6. Test plan

| Test                                                                                                                   | File                                                      | Asserts                                              |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `buildHookConfig` includes `SubagentStart`/`SubagentStop` with tag `_`, 5 s timeout, bridge URL                        | `tests/hook-installer.test.ts` (extends `:20`)            | §4.1                                                 |
| the global install carries all four Notification types, from the shared constant                                       | `tests/hook-installer.test.ts` (extends `:49`)            | §3 repair                                            |
| **golden matcher list**: the exact set of matcher strings emitted by both paths equals a frozen literal                | `tests/hook-installer.test.ts` (new describe)             | §3 regression guard — a silent drift fails the suite |
| the blob subscribes the new events and still omits `PreToolUse`/`PostToolUse`/`PermissionRequest`                      | `tests/hook-settings-blob.test.ts` (extends `:33`, `:56`) | §4.1/§4.2                                            |
| `agent_needs_input` → `needs-input`; `agent_completed`, `SubagentStart`, `SubagentStop` leave state as-is              | `tests/hook-state.test.ts` (extends `:75`)                | §4.1–4.3                                             |
| `parseFleetExtras`: counts arrays, tolerates missing/garbage/non-array, never throws                                   | `tests/hook-state.test.ts` (new describe)                 | §4.4                                                 |
| the bridge forwards `matcher` + `agentId` on `claude:hook`; a `SubagentStop` for a hibernated session is still dropped | `tests/hook-bridge.test.ts` (extends `:87`, `:151`)       | §4.1                                                 |
| team branch still short-circuits and none of the new events leak into it                                               | `tests/team-hook-bridge.test.ts` (extends `:105`)         | no regression                                        |
| reconcile/prune still find the new entries after CC strips `_capy`                                                     | `tests/hook-reconcile.test.ts` (`:151` describe)          | lesson `framework/002`                               |
| `SubagentStop` marks the row `done` and cancels the timer; a session with no subagent hooks still uses the 15 s timer  | `tests/sessions-store.test.ts`                            | §4.1 fallback                                        |
| `liveAgentCount` from the hook set keeps a parent `working` past `STUCK_AFTER_MS`                                      | `tests/fleet-state.test.ts` (existing signals harness)    | the §2 defect #1                                     |
| an `agent_completed` edge records exactly one Activity row with a `sessionId`                                          | `tests/notifications-store.test.ts`                       | §4.3                                                 |

## 7. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed` (sub-agent permission prompts stopped raising needs-you on
  externally-launched sessions; subagents no longer read as finished mid-tool-call) and `### Added`
  (background-agent notifications, background-task counts in the preview).
- **`docs/capy-features.md` — NO.** Not agent-facing by the CLAUDE.md litmus: no new MCP verb, no new
  ACK field, no grant/confirm change, no affordance the session should offer. The CI gate triggers only
  on `src/main/mcp/tool-catalog.ts` / `src/main/capy-features.ts`
  (`scripts/ci/awareness-gate-core.mjs:12`) — neither is touched, so the gate does not trip and
  **no `no-awareness` label is needed**.
- **`docs/user/` — YES.** `docs/user/sessions.md`: the subagent status is now event-driven, and the
  hover preview shows background tasks. The gate would not trip (no new top-level component, no new
  top-level `src/main/` file, `tool-catalog.ts` untouched) — the update is owed on the contract's own
  terms, not to satisfy the gate.
- **i18n — YES.** New preview keys in `en.json` **and** `pt-BR.json` (schema parity), plus the Activity
  row title/description for `agent_completed`.
- **`design.md` — NO.** No new token, component, or motion: the preview footer and the Activity row
  are existing entities gaining one more count/row.

## 8. Definition of done

- [ ] Shared Notification-type constant consumed by `hook-installer.ts` and `hook-settings-blob.ts`
- [ ] `SubagentStart`/`SubagentStop` + `agent_needs_input`/`agent_completed` in both install paths
- [ ] `*` matcher on `PreToolUse` verified against a current CLI; replaced with a matcher-less entry if it no longer means "all"
- [ ] `matcher` + `agentId` forwarded on the `claude:hook` wire; `HookEvent` extended in the preload
- [ ] `parseFleetExtras` in `hook-state.ts`, counts on the session entry, rendered in `SessionPreview.vue`
- [ ] Store: hook-authoritative subagent liveness, timer retained only as the fallback
- [ ] i18n keys in `en.json` + `pt-BR.json`
- [ ] Tests in §6 green, including the golden matcher list
- [ ] Live check of a real `Task` subagent (§5) and of the open questions in §4.6
- [ ] `CHANGELOG.md` entry + `docs/user/sessions.md` update
- [ ] `npm run typecheck` and `npm run build` pass
