# T447 — Security and permissions (§9 of the spec, AC-5)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T447 · **Status:** specified (not implemented)

This file is §9 of the spec, split out for length. Section references (§5.3, §7.3, …) point at
`00-spec.md`; `TC`, `TYPES`, `REF`, `T389/x` and `PROBE` are defined in its §2.

### 9.1 Reachable and excluded verbs

Of the 50 verbs in `TC` (`MCP_TOOLS`, TC:468-1706), the noun reaches **18** and never offers the
other 32. The test for "offered": the action is scoped to this session's own folder (or, for one
named exception, is a read that discloses no other session's transcript); it is not operator-only;
it cannot start, spend, steer or delete anything.

| Verb(s)                                                                                                                                      | In the noun        | Why                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_read`, `memory_query`, `mission_get`, `mission_list`                                                                                 | yes (read)         | Folder-scoped reads; mission reads limited to missions this session owns or builds (§5.4).                                                                                                                                                                                   |
| `get_session`                                                                                                                                | yes, own id only   | It discloses the session's last transcript line (TC:497-507); the noun only ever passes this session's id.                                                                                                                                                                   |
| `get_fleet`                                                                                                                                  | yes, **exception** | It has no folder argument (TC:470-495) and lists sessions across folders. Kept because a fleet view is half of ideas 56/117; the noun drops rows whose folder is blocked for agents and the `peer` socket address. **This breaks the own-folder rule, knowingly** (SDK-Q11). |
| `get_approval`                                                                                                                               | yes, own ids only  | Only ids this module received in a `PENDING` answer (§5.3).                                                                                                                                                                                                                  |
| `memory_append` (pages `decisions`, `sessions/<slug>`)                                                                                       | yes                | Append-only with server-stamped provenance.                                                                                                                                                                                                                                  |
| `create_card`, `update_card` (`set`, `appendBody`), `move_card`                                                                              | yes                | Backlog-born cards; `move_card` cannot reach `done` or `in-progress` by its own schema.                                                                                                                                                                                      |
| `mission_update_step` (`proof: 'claimed'`), `mission_log`, `mission_set_blocker`, `mission_clear_blocker`                                    | yes, scoped        | Own steps for a child, any step for the owner (§5.4); never verifies anything.                                                                                                                                                                                               |
| `notify`, `speak`, `open_file`                                                                                                               | yes                | Operator signals; `speak` has its own operator switch.                                                                                                                                                                                                                       |
| `memory_append` to `hot`/`roadmap/<slug>`; `update_card` `replaceBody`/`images`/`substrate`; `create_card` `images`/`substrate`              | **no**, `EXCLUDED` | `hot` is a full replace; a roadmap append voids an approval stamp; `replaceBody` drops content; `images` copies files from outside the repo; `substrate` decides where a dispatch runs.                                                                                      |
| `create_session`, `create_worktree`, `spawn_terminal`, `submit_manifest`, `message_session`, `orchestrator_arm`, `orchestrator_disarm`       | **no**             | Orchestration: starting work or steering another session is the orchestrator's job, not a mod's.                                                                                                                                                                             |
| `mission_create`, `mission_add_step`, `mission_link_child`, `mission_set_end`, `mission_import_legacy`, `mission_add_check`                  | **no**             | Shaping a mission is the owner session's act, agreed with the operator in chat.                                                                                                                                                                                              |
| `mission_verify_step`, `mission_request_close`                                                                                               | **no**             | Verification must come from an independent session; a mod inside an executor would launder self-verification.                                                                                                                                                                |
| `create_worker`, `update_worker`, `delete_worker`, `stop_containers`, `start_containers`, `remove_containers`, `plan_mission`, `delete_card` | **no**             | Unattended bodies, containers, grants and irreversible deletes.                                                                                                                                                                                                              |
| `adopt_folder`, `remove_folder`, `release_worktree`, `archive_card`, `draw_canvas`                                                           | **no** (v1)        | Not needed by the ideas that motivate the noun; candidates for a later minor (SDK-Q6).                                                                                                                                                                                       |
| `list_worktrees`, `list_workers`, `list_containers`, `list_cleanup`                                                                          | **no** (v1)        | Operator-facing views across folders; candidates for a read-only later minor.                                                                                                                                                                                                |

### 9.2 Direct `$.mcp.call`: the guard, and what it cannot do

A third-party mod does not need the noun to reach Harnu: it can call
`$.mcp.call('harnu', <any verb>, …)` itself (§3.6). **With "Ask before agent actions" off — the
default — Harnu's server does not stop that for most of the excluded verbs.** They are free
mutations (`silentAllowInAgentFolder`): `create_session`, `create_worktree`, `spawn_terminal`,
`submit_manifest`, `message_session`, `orchestrator_arm`/`orchestrator_disarm`, `adopt_folder`,
`remove_folder`, `release_worktree`, `archive_card`, `draw_canvas`, `start_containers`, every
`mission_*` write including `mission_verify_step` and `mission_request_close`, `memory_append` to
`hot`, `create_worker` in `observe` mode, `update_worker` for a non-risky edit, and
`stop_containers` without `force` (confirm rules at TC:1124, :1213, :1281-1295). Only
`plan_mission`, `delete_card`, `delete_worker` and `remove_containers` always confirm. So on those
verbs the server's gates do **not** protect the operator from a mod, and nothing that runs inside
`claude` can.

What the `harnu` mod adds, and its limits:

1. **The guard: one door into Harnu.** The `harnu` mod hooks the `mcp.call` op event and answers
   `{ deny }` for every call with `server ∈ { harnu, capy }` whose caller (`next.origin.plugin`) is
   neither `harnu` nor `engine`. A mod that wants Harnu goes through the noun, where §9.1's filters
   apply. It is written with a `.catch` that denies (`REF:79`), so a failing guard does not fail
   open. PROBE (guard-probe): a dependent's direct `$.mcp.call('harnu', 'spawn_terminal', …)` was
   refused with "harnu: spawn_terminal is not offered to mods (caller guard-probe/user)", with the
   guard at `user` and at `prepend`; the probe's guard covered four of the free verbs, the real
   one covers every call.
2. **It is a speed bump, not a boundary.** A hook of the caller's own placed above the guard can
   answer without reaching it, or skip past it with `next.to(e, tier)`; a mod can also spawn
   `claude`, `curl` the loopback port with the bearer from `harnu.mcp.json`, or run anything with
   `$.process`. ADR-0018 Decision 3 holds: mods of one tier are not isolated.
3. **So the real boundary is install-time trust, disclosed.** The Mods tab must show what a mod can
   do (§9.5), and "Ask before agent actions" is the operator's switch that turns every mutation
   into a confirm. The user docs for the noun say both plainly.

### 9.3 Existing gates, applied to noun calls

A noun call is an ordinary MCP call on the server, so nothing is relaxed:

- **`FOLDER_NOT_ALLOWED`.** Evaluated right after the kill switch, reads included
  (`src/main/mcp/permission-core.ts:206-242`, blocked folder at :216), and nothing overrides it
  (`explicitBlock`, `src/main/mcp/plan-tool-call.ts:241, :274`). Mapped, never retried.
- **"Ask before agent actions".** Every mutation becomes a confirm (`permission-core.ts:241`) and
  containment is re-armed: a folder outside every known root is `PATH_ESCAPE` (:223-229). The
  confirm is raced for 30 s, then returned as a pending handle that stays live for 30 min (§5.3).
  The noun never calls `plan_mission` to buy a grant; under an existing grant a dependent's write
  spends its budget like any agent's.
- **Per-verb confirms.** None of the 18 offered verbs confirms by itself; a noun call raises a
  confirm only through "Ask".
- **"Always allow this verb here".** Unchanged: a durable `mcp__harnu__<op>` rule in
  `settings.local.json` (`src/main/mcp/settings-local.ts:28-43`) applies to noun calls as to any.
- **Withheld MCP and ticks.** Respected by construction (§7).

### 9.4 Identifying the calling mod, and audit attribution

Today an `AuditRecord` carries `ts, tool, folder, verdict, disclosedPayloadSummary, result,
callId?` and no caller (`src/main/mcp/audit-log.ts:13-34`). T389/P2W5 (specified, **not shipped**)
adds `caller: { attributed, sessionId?, agentId?, stamp }` from a stamp the companion injects on
`tool.call` for `mcp__harnu__*` (T389/P2W5:86-99), and states that "Another mod's `$.mcp.call` …
→ unstamped" (T389/P2W5:271), because a plugin's `$.mcp.call` raises the `mcp.call` op event, not
`tool.call`.

This spec proposes, as an **amendment to P2W5** (not a parallel mechanism, contract §18):

1. **Stamp `mcp.call` too.** The companion hooks the `mcp.call` op event for
   `server ∈ {harnu, capy}` with the same stamp code it uses on `tool.call`. Hooking an event is not
   calling `$.mcp.call`, so SEC-9 (b) holds.
2. **Add `via`.** The stamp carries `via: { plugin, tier }`. For a noun call, the `harnu` mod's
   method hook reads the dependent from `next.origin` (verified, §3.5) and passes it down as the
   `via` the companion stamps; the server records it as `caller.via`.
3. **Attribution, not authentication.** As in P2W5 (:278-286), no gate reads `via`. The Approval
   Inbox and the audit pane show it as "via mod `<name>`". A record whose stamp did not come
   through the companion's hook says `declared`, as P2W5 already defines.

Until P2W5 ships, noun calls are audited like any other MCP call, with no caller. The noun keeps no
audit file of its own (SEC-6 puts audit on Harnu's side).

### 9.5 What Settings → Mods shows

The Mods tab reads each mod with `claude plugin validate <root> --json` (T389/P4W1:203-224) and
derives chips from a closed table (`deriveCapabilities`, `src/main/mods-audit-core.ts:368-385`):
`mcp` from **calling** `mcp.call`; `files` from calling `fs.*`; `env` from env reads; `gate`
**only** from hooking `plugin.register`; `other-mods` **only** from hooks on the `http`, `env`,
`store`, `state` or `fs` nouns (`OTHER_MODS_NOUNS`, :353). What that gives today:

| Mod                                        | Chips today                                                   | What it misses                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harnu` (the provider)                     | `mcp`, `files`, `env`; `other-mods` once v2 hooks `state.set` | Its `mcp.call` guard (§9.2) and its hooks on `harnu.*` produce **no chip**: a hook on `mcp.call` can read, rewrite or refuse every other mod's MCP call, invisibly. No `gate`: it does not hook `plugin.register`. |
| a dependent calling `$.harnu.*` only       | nothing for the noun                                          | Validate lists `$.harnu.memoryAppend` under `calls` (§14 output), but no row matches a plugin noun: **a mod that writes to the board shows nothing**.                                                              |
| a dependent that hooks `state.set` (§10.2) | `other-mods`                                                  | accurate                                                                                                                                                                                                           |
| any mod hooking `harnu.*` events           | nothing                                                       | It can rewrite or refuse other mods' Harnu calls, invisibly.                                                                                                                                                       |

Proposed fixes (a P4W1 follow-up, W4):

1. **`harnu-read` / `harnu-write` chips** — "can read your Harnu fleet, memory, board and
   missions" / "can write to your Harnu board, memory and missions" — from `calls` whose op starts
   with `harnu.`, classified by a method → chip table shipped in the `harnu` mod's
   `api-surface.json`, so the analyzer never hard-codes method names.
2. **Close the `mcp.call` gap.** A hook on `mcp.call` or `mcp.connect` sets `other-mods` (add `mcp`
   to `OTHER_MODS_NOUNS`), since it sees and can change other mods' MCP calls.
3. **Plugin-noun hooks.** A hook on any event whose namespace is not a core noun (a plugin noun
   such as `harnu.*`) sets `other-mods` too.
4. **"Depends on `harnu`"**, a plain label from the manifest's `dependencies`, beside the source
   label (T389/P4W1:134-140).

Wording follows SEC-7: "can", never "safe" or "verified".

### 9.6 Rules for the `harnu` mod (SDK-S1 … SDK-S9)

- **SDK-S1.** No method takes a raw verb name, a raw argument bag, a folder or a session id. There
  is no `$.harnu.call(verb, args)` (ADR-0002 §2.1's "no generic invoke" rule, applied here).
- **SDK-S2.** The manifest lists no MCP server; the mod never calls `$.mcp.connect`.
- **SDK-S3.** No `$.process`, no `$.http.fetch`, no `tool.call` hook, no `'*'` event. Its only
  outbound path is `$.mcp.call('harnu', …)` from its own method hooks.
- **SDK-S4.** Disk access is read-only and limited to `<root>/.harnu/memory/**`.
- **SDK-S5.** The spawn token's value is never stored, returned or logged; only its presence.
- **SDK-S6.** `$.state` keys hold only what the noun's reads return, already redacted by the server
  and filtered by §9.1. Any plugin can read them (§3.7).
- **SDK-S7.** Every hook returns `next(e)` (or its stub answer) on failure, except the `mcp.call`
  guard, which denies on failure.
- **SDK-S8.** `api-surface.json` lists every `$` call, hook and state key, and the method → chip
  table; a test fails on drift, as for the companion.
- **SDK-S9.** Never staged into a Scheduler tick; read-only in any non-interactive session (§7.3).
