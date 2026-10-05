# T208 — Verify four CLI assumptions against the installed Claude Code

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T208-verify-four-cli-assumptions-against-the-installed-claude-code.md`
**Kind:** scout — findings only, no production code change. **Source:** `.capy/out/claude-code-sync-audit.md` §1.3, §2, §4.4.

## 1. Why these four

Each assumption is load-bearing and **fails quietly** — never as a stack trace Capy can see:

| #   | Assumption                                 | Failure mode                                                                                                                                                      |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `--session-id` only works with fork/resume | **Dead path.** A whole synth→real migration subsystem stays alive covering a gap that may not exist. Cost is complexity + a live race, not an error.              |
| 2   | A fork continues in the same folder        | **Wrong data.** The transcript lands under an unexpected slug; the fork shows in the wrong folder or vanishes. Nothing errors.                                    |
| 3   | Hook matchers still match                  | **Blind fleet.** A dead matcher means the session silently never reaches `needs-input`/`idle` — the bridge just never receives the POST.                          |
| 4   | `--effort` accepts five levels             | **Hard launch failure attributed to the wrong cause** — same class as `bypassPermissions`→`manual`: an invalid enum kills `claude` before the PTY shows anything. |

Q1 and Q4 are answerable from `claude --help` and **are answered below**. Q2 and Q3 need a live session and stay pending.

## 2. Installed CLI

```
$ which claude
/home/u/.local/bin/claude

$ claude --version
2.1.222 (Claude Code)
```

Native install (`~/.local/bin`), not the deprecated npm layout. `~/.claude/projects/` holds **323 slugs**, 170+ of them `…-capy--claude-worktrees-<branch>` — every git worktree already gets its own slug, the mechanism Q2 turns on.

---

## 3. Q1 — Does `--session-id` work on a plain spawn?

**Assumption:** `--session-id` is valid only alongside `--resume`/`--fork-session`, so a fresh session can't be given a uuid up front.

**Code that depends on it**

- `src/main/claude-args.ts:153` — `--session-id` is in `DENY_VALUE`; flag + value stripped from user argv.
- `src/main/pty.ts:630` — `kind === 'claude-new'` → `base = []`. New sessions spawn bare, idless.
- Consequence: the renderer invents `synthetic-<uuid>` (`sessions.ts:2459`, `:2533`, `:2745`) and must later reconcile it with whatever uuid Claude picks.

**What `--help` already tells us — verbatim**

```
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
```

Contrast the flag that _is_ resume-scoped:

```
  --fork-session                        When resuming, create a new session ID
                                        instead of reusing the original (use
                                        with --resume or --continue)
```

**ANSWER (partial):** v2.1.222 documents **no resume/fork constraint** on `--session-id` — only "must be a valid UUID". `--fork-session` proves the help _does_ spell out resume-only coupling when it exists. The audit §4.4 phrasing ("documented for fork/resume") does not match the installed help.

**Runtime experiment — STILL PENDING.** Help text is not acceptance:

1. Throwaway cwd `/tmp/t208-sid` (never a Capy-managed repo); fixed uuid `d4c1f0a2-0000-4000-8000-000000000001`.
2. Argv acceptance: `claude --session-id <uuid> -p "say ok"` — record exit code + stderr.
3. The real case (Capy spawns interactive): `claude --session-id <uuid>`, one prompt, exit.
4. **The observable:** does `~/.claude/projects/-tmp-t208-sid/<uuid>.jsonl` exist under _that_ uuid?
5. Collision control: repeat step 3 with the same uuid in the same cwd — reject, append, or overwrite?

**Expected vs actual** — holds-is-stale: exit 0 and a JSONL named exactly `<uuid>.jsonl`. Assumption-holds: a usage error naming `--resume`, **or** a JSONL under a different uuid (flag silently ignored — the worst outcome, and why step 4 checks the filename, not the exit code).

**Decision unblocked:** whether the synth→real subsystem (§7) can be deleted.

**Follow-up:** separate card. If it works — drop `'--session-id'` from `DENY_VALUE` (`claude-args.ts:153`), have `claude-new` emit `['--session-id', <uuid>]` (`pty.ts:630`), then §7. If not — "assumption holds, no action", with the verbatim rejection recorded here so the next audit doesn't reopen it.

---

## 4. Q2 — What does `/fork` do now?

**Assumption:** a fork is a same-folder continuation; its transcript appears under the source session's slug.

**Code that depends on it**

- `src/main/pty.ts:650` — `claude-fork` → `base = ['--resume', <src>, '--fork-session']`.
- `stores/sessions.ts:2745` — `createForkedSession` mints a `synthetic-<uuid>` **in the source folder** and waits for a real id **in that same folder**.
- `stores/sessions.ts:4027` — `collapseSyntheticInto(realId, folderHint)` resolves the folder from the real row or `folderHint`. A transcript under a different slug never reaches this synthetic at all.

**What `--help` tells us — verbatim.** `--fork-session` (quoted in §3) still exists and still means what Capy assumes, so **Capy's argv is not broken**. Two adjacent flags are new context:

```
  -w, --worktree [name]                 Create a new git worktree for this
                                        session (optionally specify a name)
  --bg, --background                    Start the session as a background agent
                                        and return immediately (manage with
                                        `claude agents`)
```

**Cannot be answered from `--help`.** `/fork` is an **in-session slash command**, not a CLI flag; v2.1.212/v2.1.222 changed the slash command, which is invisible to argv inspection.

Corroborating read-only evidence: `grep -rl '"source":"fork"' ~/.claude/projects/ | wc -l` → **0** across all 323 slugs. Either the new `/fork` was never used here, or `--fork-session` doesn't set that source. The experiment must distinguish the two.

**Runtime experiment — PENDING (needs a live interactive session)**

1. `ls ~/.claude/projects > /tmp/t208-slugs-before.txt`.
2. In a throwaway git repo: start `claude`, send one prompt, run `/fork`.
3. Diff the slug set. **The observable:** a _new_ slug (fork got its own worktree) vs the fork's JSONL landing in the existing slug.
4. Grep the fork's transcript for `"source"` near `SessionStart` — record the literal value.
5. Separately exercise Capy's own path — `--resume <src> --fork-session` — and check whether it behaves like step 3 or stays put. **This is the case that actually matters**; Capy never issues `/fork`.

**Expected vs actual** — holds: no new slug, forks sit beside the source, `SessionStart` reports something other than `"fork"`. Broke: a new slug appears; Capy's synthetic sits in folder A forever while the transcript materializes in folder B, and `synthetic-reaper.ts` eventually removes it — so the visible symptom is "my fork vanished", not an error.

**Decision unblocked:** whether `createForkedSession` needs a cross-slug adoption path, and whether Capy should surface `SessionStart.source` (the bridge already reads it — `src/main/hook-bridge.ts:171-172` sets `matcher = body.source` for `SessionStart`).

**Follow-up:** new slug → card against `sessions.ts:2745` + `collapseSyntheticInto` (`sessions.ts:4027`) for cross-folder adoption. Otherwise "assumption holds, no action", but still record `SessionStart.source`'s literal value.

---

## 5. Q3 — Do Capy's hook matchers still fire?

**Assumption:** every matcher Capy installs still matches. v2.1.195 changed matchers from **substring** to **exact**.

**The complete matcher inventory, verbatim.** `src/main/hook-installer.ts:39-56` (global `~/.claude/settings.json` install):

```ts
const EVENT_SPECS: Array<{ event: string; settingsMatcher?: string; tag: string }> = [
  { event: 'Notification', settingsMatcher: 'permission_prompt', tag: 'permission_prompt' },
  { event: 'Notification', settingsMatcher: 'idle_prompt', tag: 'idle_prompt' },
  { event: 'Stop', tag: '_' },
  { event: 'StopFailure', tag: '_' },
  { event: 'UserPromptSubmit', tag: '_' },
  { event: 'SessionStart', tag: '_' },
  { event: 'SessionEnd', tag: '_' },
  { event: 'PreToolUse', settingsMatcher: '*', tag: '_' },
  { event: 'PermissionRequest', tag: '_' },
  { event: 'TaskCreated', tag: '_' },
  { event: 'TaskCompleted', tag: '_' },
  { event: 'TeammateIdle', tag: '_' }
]
```

`src/main/hook-settings-blob.ts:44-53` (inline `--settings` blob, per spawn):

```ts
export const NEEDS_YOU_NOTIFICATION_TYPES: readonly string[] = [
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog'
]
const NOTIFICATION_TYPES: readonly string[] = [...NEEDS_YOU_NOTIFICATION_TYPES, 'idle_prompt']
```

The blob subscribes to `UserPromptSubmit`/`Stop`/`SessionStart`/`SessionEnd` (`:90-93`) plus one `Notification` entry per `NOTIFICATION_TYPES` (`:94`). So only **four strings plus a wildcard** are exposed to the substring→exact change; everything else is matcher-less:

| Matcher                    | Event          | Installed by     |
| -------------------------- | -------------- | ---------------- |
| `permission_prompt`        | `Notification` | installer + blob |
| `idle_prompt`              | `Notification` | installer + blob |
| `worker_permission_prompt` | `Notification` | **blob only**    |
| `elicitation_dialog`       | `Notification` | **blob only**    |
| `*`                        | `PreToolUse`   | installer only   |

> **Discrepancy found while enumerating (not a T208 finding, but real):** the global installer subscribes to **2** Notification types, the blob to **4**. A session whose hooks come only from the global install (user-supplied `--settings` file — `hook-settings-blob.ts:118-127`) never receives `worker_permission_prompt` or `elicitation_dialog`. Own card, regardless of this experiment.

**Cannot be answered from `--help`** — hook matcher semantics aren't part of the argv surface.

**Runtime experiment — PENDING (one live session per matcher).** Harness: run the Hook Bridge (or a standalone listener on `127.0.0.1:<port>`), spawn `claude --settings '<blob>'` with the real blob shape, assert an inbound POST to `/hook/<token>/Notification/<tag>`. Triggers:

1. `permission_prompt` — a tool needing approval under `--permission-mode manual`.
2. `idle_prompt` — start a session, leave it past the 60s nudge.
3. `worker_permission_prompt` — a subagent/teammate hitting a permission gate. **Hardest to stage**; if it can't be provoked, mark it unprovable rather than verified.
4. `elicitation_dialog` — an MCP server issuing an elicitation request.
5. `PreToolUse` `*` — any tool call. **Highest-value single check in Q3**: under exact matching `*` either is special-cased as "all" or matches literally nothing, and Capy's "writing" signal rides on it.

Assert the negative too: with `-d hooks`, confirm the CLI logs a match attempt per event, so "no POST" is distinguishable from "no event".

**Expected vs actual** — holds: one POST per trigger, tag intact. Broke: the trigger fires in the session, the bridge sees nothing, no error anywhere; fleet state silently freezes on its last value.

**Decision unblocked:** whether the matchers need rewriting (e.g. `*` → an explicit tool list), and whether fleet-state regressions currently blamed on the classifier are actually missing hooks.

**Follow-up:** per failing matcher, a card against its declaring file (`hook-installer.ts:39-56` or `hook-settings-blob.ts:44-53`). All five fire → "assumption holds, no action" + a regression test that replays the blob.

---

## 6. Q4 — Are effort `xhigh` / `max` still accepted?

**Assumption:** `--effort` accepts `low | medium | high | xhigh | max`. Audit §2 claims v2.1.72 cut this to `low | medium | high`.

**Code that depends on it:** `src/main/claude-args.ts:28-29` (doc comment) and `:373` (`push('--effort', cfg.effort.trim())`, unvalidated); `ClaudeBootForm.vue:66`, `ClaudeBootDialog.vue:50` (`ROUTING_EFFORT_OPTIONS`), `RoadmapBoard.vue:67` (`EFFORT_OPTIONS`) — all three list the same five.

**What `--help` already tells us — verbatim**

```
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
```

**ANSWER: the assumption HOLDS.** v2.1.222 documents all five, `xhigh` and `max` included. The audit §2 row is **wrong for the installed version**. For contrast, an _enforced_ enum in the same output — note it lists `manual`, confirming the shipped `bypassPermissions`→`manual` fix, and note `--effort` has no such `choices:` list:

```
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
```

**Residual runtime check — cheap, optional.** Since `--effort` prints no `choices:`, the runtime parser may be stricter than the help:

```
claude --effort max -p "ok"     # exit 0 ⇒ accepted
claude --effort bogus -p "ok"   # expect a usage error ⇒ proves the parser validates at all
```

The second line is the control: if `bogus` is also accepted, `--effort` isn't validated and Q4 is moot either way.

**Decision unblocked:** whether the three renderer option lists and the `claude-args.ts` doc comment must shrink to three levels.

**Follow-up: assumption holds, no action.** Correct the audit's §2 row instead; re-check on the next CLI minor bump.

---

## 7. What could be deleted if Q1 holds

If a bare `claude --session-id <uuid>` is accepted, the renderer pre-assigns the real uuid at create time and the whole synthetic layer collapses. Sized against `main` @ v0.3.19:

| Machinery                           | Location                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic id minting (3 call sites) | `stores/sessions.ts:2459` (`createNewSession`), `:2533` (dispatch), `:2745` (`createForkedSession`)                                                                              |
| The synth→real collapse             | `stores/sessions.ts:4027` `collapseSyntheticInto()` + its contract comment `:4002-4026`                                                                                          |
| Migrate fan-out                     | `stores/sessions.ts:1122-1130` (`migrateHandlers`), `:1462` `fireMigrate()` — subscribers in `TerminalPane.vue`, `usage.ts`, `memory.ts`, `helpers.ts`, `command-router.ts`      |
| Agent correlation window            | `stores/sessions.ts:1161-1213` (`agentCorrelations`, `armAgentCorrelation`, `armAgentCorrelationForBoot`), `:439-448` (`AGENT_MIGRATE_WINDOW_MS`)                                |
| Agent boot queue                    | `stores/sessions.ts:1231-1256`                                                                                                                                                   |
| Agent synthetic factory             | `stores/agent-create-core.ts:35-90`                                                                                                                                              |
| Orphan reaper                       | `stores/synthetic-reaper.ts` — 109 lines, whole file                                                                                                                             |
| Main-side materialization wait      | `main/command-bridge.ts:82-224` (`Materialization`, `awaitMaterialization`, `reportMaterialized`) + `main/command-bridge-ipc.ts`                                                 |
| Tests                               | `tests/agent-correlation-window.test.ts` (244), `tests/mcp-create-session-ack.test.ts` (254), plus synthetic cases in `session-autoname`, `session-presence`, `injection-ledger` |

Order of magnitude: **~600–800 lines of production code and ~500 of test**, plus the race class in the _"Capy fan-out post-mortem 2026-07-10"_ memory — the lying `ok:true` ACK (`mcp/server.ts:553`) is a direct consequence of not knowing the session id at ACK time. This is **not a deletion plan**; it's the prize that justifies running Q1 carefully. Removal is a separate, staged card.

## 8. Deliverable

1. **This spec is the findings home.** §3–§6 each get their answer written back in place under a `**RESULT (<date>, CLI <version>):**` line, with real output pasted verbatim. §6 is already answered.
2. **Project memory** gets one decision entry per answer that _changes_ a decision — Q1 (if it unblocks §7) and Q2 (if fork changes folder). Q4 only as a correction to the audit; Q3 only if a matcher is dead.
3. **The audit is corrected, not rewritten:** §2's `--effort` row is factually wrong for v2.1.222 (§6), and §4.4's "documented for fork/resume" is not what the installed help says (§3).
4. **No production code changes under T208.** Every fix is a separate card linking back to a §-number here. This card's diff is limited to this spec, the audit correction, and the roadmap card's status.
5. **No CHANGELOG / `docs/capy-features.md` / `docs/user/` entry required** — nothing user-visible or agent-facing ships. The follow-up cards carry those.

## 9. Definition of done

- [x] Installed CLI version recorded verbatim (§2) — `2.1.222 (Claude Code)`
- [x] Q4 answered from `--help`, verbatim (§6) — five levels still documented, assumption holds
- [x] Q1 answered from `--help`, verbatim (§3) — no resume/fork constraint documented
- [x] Q3 matcher inventory enumerated verbatim (§5) — 4 strings + `*`
- [ ] Q1 runtime experiment run; the JSONL **filename** checked, not just the exit code
- [ ] Q1 collision control run (same uuid twice in one cwd)
- [ ] Q2 slug-diff run for `/fork` **and** for `--resume … --fork-session`
- [ ] Q2 `SessionStart.source` literal value recorded
- [ ] Q3 `PreToolUse` `*` proven to fire (highest-value single check)
- [ ] Q3 each `Notification` matcher proven to fire or **explicitly marked unprovable**
- [ ] Q4 residual `--effort bogus` control run
- [ ] Every answer names its follow-up: a file:line to change, or "assumption holds, no action"
- [ ] Audit §2 `--effort` row and §4.4 `--session-id` phrasing corrected
- [ ] Project-memory decision entry written for every answer that changes a decision
- [ ] Confirmed: zero files under `src/` changed by this card
