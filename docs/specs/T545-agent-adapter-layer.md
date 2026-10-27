# T545 — Agent adapter layer: making Harnu agent-agnostic

**Status:** RFC — open for comment
**Date:** 2026-10-19, revised 2026-10-27 after the first review round
**Author:** agent (T545), for the maintainer
**Scope of this document:** design only. No code changes. Merging the PR that carries it records the design; it does not commit to building it.
**Related work:** golden corpus (T542), OpenCode 2 spike (T543), demand probe and terminal-only tier (T544), the adapter layer itself (T545). See [§8 Plan](#8-plan).

---

## 1. Summary

1. **What.** Harnu today drives exactly one agent, Claude Code, and the two are fused. This RFC proposes a small seam: Harnu owns a vocabulary of events and commands, and one adapter per agent CLI translates into it.
2. **Why.** Claude Code changes its own file and hook formats between releases, and other agent CLIs (Copilot, Codex, OpenCode) are in wide use. A seam makes both cheaper to handle: a format change breaks one adapter, not the app.
3. **How, in one line.** Draw the interface with two real _shapes_ in hand, never from Claude alone: Claude Code (PTY plus hooks plus transcript) and OpenCode 2 (one shared server that any client can drive). Ship Copilot CLI first, because it fits the machinery Harnu already has (PTY, hooks, a caller-chosen session id).
4. **What is committed.** Nothing beyond three cheap spikes (a test corpus, an OpenCode 2 prototype, a demand probe that doubles as a terminal-only tier). There is an explicit go/no-go gate after the OpenCode 2 prototype.
5. **What we ask of you.** Poke holes in the design, tell us which CLI you would run in Harnu and why, and send scrubbed session captures from your installed CLI version so we can test against more than one machine. See [§11](#11-how-to-contribute).

---

## 2. Problem

Harnu is a desktop session manager for Claude Code. It shows every session in a sidebar, tracks whether each is working, waiting for you or idle, parks and resumes them, routes approval prompts into one inbox, and exposes an MCP server so an agent can open worktrees, sessions and terminals. All of that knowledge currently comes from Claude Code's own files, hooks and command line.

The coupling is measured, not guessed:

| Fact                                                                                | Where                                                                                                                                                                                                                                                  | Number                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| The `~/.claude/projects` root is built independently                                | `fleet-model.ts:60`, `claude-watcher.ts:51`, `claude-reader.ts:1573`, `session-ops.ts:45`, `usage-cost.ts:57`, `companion/host.ts:401`, `orchestrator-guard.ts:413`, `gc/gc-orphan-transcripts.ts:292`, `gc/gc-transcripts.ts:187`, `gc/gc-ipc.ts:269` | 10 places                                       |
| The "slug" rule (cwd with every non-alphanumeric turned into `-`) is re-implemented | `renderer/src/lib/folder-slug.ts:40`, `companion/external-corroboration.ts:27`, `gc/gc-transcripts.ts:62`                                                                                                                                              | 3 places                                        |
| Session records carry no provider field                                             | `SessionEntry` at `claude-reader.ts:95`, renderer `Session` at `stores/sessions.ts:168`                                                                                                                                                                | 0 fields                                        |
| The spawn kind is Claude-only                                                       | `PtyKind = 'shell' \| 'claude-new' \| 'claude-resume' \| 'claude-fork'` at `pty.ts:217`, mirrored at `preload/index.ts:481` and `fleet-policy.ts:12`                                                                                                   | 3 copies                                        |
| Source files that mention Claude                                                    | `src/`                                                                                                                                                                                                                                                 | about 230 of 691 (from the 2026-10-19 analysis) |

There is no place to put a second agent without touching a hundred files.

**Why this matters even if Harnu only ever supports Claude Code.** Claude Code is not a stable API. Hook event names, transcript line shapes and CLI flags have moved between releases, and Harnu reads all three. Today a change shows up as a bug report. With a seam, it shows up as a failing adapter test against a captured corpus, in one directory. The seam, plus a golden corpus to test it, is worth having for Claude alone.

---

## 3. Goals and non-goals

### Goals

- Define a Harnu-owned vocabulary (events in, commands out) that everything above the line depends on: fleet model, Approval Inbox, missions, the roadmap board, memory, cleanup, hibernation, the MCP verbs and the UI.
- Move Claude Code behind that vocabulary with **byte-identical user-visible behaviour**, proven by a golden corpus captured before the refactor.
- Add Copilot CLI as the first non-Claude adapter, behind a flag, on the existing hook bridge.
- Prove the interface against a server-shaped provider (OpenCode 2) in a spike, so the vocabulary is not drawn from Claude's shape alone.
- Make every feature above the line behave honestly when a provider lacks a capability: hide it, or show "unknown". Never show a confident wrong answer.
- Publish a capability checklist so someone outside the project can propose an adapter for another CLI.

### Non-goals

- **Porting Claude-only subsystems.** The companion mod (a plugin inside the `claude` process), the cross-session messaging socket, per-model usage history and plan cockpit, bundled skills and the mods audit stay Claude-only and are hidden for other providers.
- **An ACP chat pane.** Rendering the conversation ourselves is a different product surface. Decided: not now ([§10](#10-open-questions)). No provider in the plan needs it.
- **Renaming IPC channels.** The `claude:*` channels keep their names until a second consumer justifies the churn.
- **Replacing the slug.** It stays as the partition key; other adapters synthesize it from the working directory.
- **Gemini CLI.** Out of plan; see [Out of plan: Gemini CLI](#out-of-plan-gemini-cli).
- **Codex and OpenCode adapters.** Follow-up decisions after the gate, not part of this plan.

---

## 4. Landscape

Four CLIs, as a session manager sees them. Versions are the ones we checked; "checked on 2026-10-19" applies to every cell unless it says otherwise, and the Copilot and OpenCode cells were re-checked on 2026-10-27 after review. Where we could, we probed the installed binary and its session store on a real machine; the rest comes from vendor docs, changelogs and source (links in [§12](#12-references)). Cells marked "undocumented" describe formats we observed but the vendor does not promise; cells marked "unverified" are reported by a reviewer and not yet checked by us.

| Capability                          | Claude Code 2.1.303                      | Copilot CLI 1.0.98                                                                                                                                                                | Codex CLI 0.163                                                     | OpenCode (1.19 probed, 2.x from migration notes)                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open source                         | no                                       | **no** (npm binary)                                                                                                                                                               | yes (Rust)                                                          | yes                                                                                                                                                                                                                                                       |
| Release cadence                     | weekly-ish                               | near-daily stable                                                                                                                                                                 | 1–2 stable per week, daily alphas                                   | several per week; v2 is about six weeks old                                                                                                                                                                                                               |
| Sessions on disk                    | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.copilot/session-state/<id>/events.jsonl` plus `workspace.yaml`, undocumented but plain JSON                                                                                   | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` plus SQLite, undocumented | v1: SQLite `opencode.db`, readable via `opencode export`; v2: not checked                                                                                                                                                                                 |
| Caller-minted session id            | `--session-id`                           | `--session-id=<uuid>` (changelog: "starts new sessions with a specific UUID")                                                                                                     | **no**                                                              | no (returned by the server)                                                                                                                                                                                                                               |
| Resume / fork                       | `--resume` / `--fork-session`            | `--resume` / TUI only                                                                                                                                                             | `resume` / `fork`                                                   | `-s` / `--fork` (v1)                                                                                                                                                                                                                                      |
| Inject system-prompt text           | `--append-system-prompt`                 | env var pointing at an instructions directory                                                                                                                                     | `-c developer_instructions=…`                                       | `instructions` config, `OPENCODE_CONFIG_CONTENT` (v1)                                                                                                                                                                                                     |
| Hooks can answer permission prompts | yes (`http`, synchronous)                | yes: `preToolUse` can allow, deny or modify; `permissionRequest` can allow or deny. `command` and `http` handlers; `http` rules in [§9](#9-risks)                                 | yes (`command` and `mcp_tool`), **hash-pinned trust**               | v1: **no**, the `permission.ask` plugin hook has no call sites in v1.19.4, so it never fires; v2: replaced by `ctx.permission.hook("evaluate")`, not yet tested                                                                                           |
| Per-launch MCP server               | `--mcp-config`                           | `--additional-mcp-config` (inline JSON or `@file`)                                                                                                                                | `-c mcp_servers.<name>.url=…`                                       | three ways (v1)                                                                                                                                                                                                                                           |
| Read-only / tool limits             | `--tools`                                | `--available-tools` / `--excluded-tools`                                                                                                                                          | `--sandbox read-only`                                               | `permission` config (v1); v2 uses one ordered `permissions` array                                                                                                                                                                                         |
| Headless JSON                       | `-p --output-format json`                | `-p --output-format json`                                                                                                                                                         | `exec --json`                                                       | `run --format json` (v1)                                                                                                                                                                                                                                  |
| **Control protocol**                | none (private socket)                    | a `--server` / `--headless` session for the SDK, and `--acp`. The exact server-mode spelling is not in the reference table (a reviewer reports `--headless --port N`, unverified) | **`app-server` JSON-RPC; `codex --remote` attaches the TUI to it**  | **`opencode serve` (HTTP, SSE)**. v2: one shared server per user, any client answers `permission.asked`, the TUI drops its prompt on `permission.replied`; `attach` is gone (unverified beyond the `permission.asked` event, which we found in v2 source) |
| Native ACP                          | adapter only                             | yes                                                                                                                                                                               | adapter only                                                        | yes                                                                                                                                                                                                                                                       |

ACP is the [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview): JSON-RPC over stdio between an editor (the client) and an agent. Under ACP the client renders the conversation; the agent runs headless.

### Three takeaways

1. **There are two shapes, not one.** Claude Code and Copilot CLI are _hook-shaped_: a real TUI in a PTY, hooks that can answer permission prompts, a session id the caller chooses, a session file on disk. Codex and OpenCode are _server-shaped_: the agent lives behind a server, and the TUI is one client of it. An interface drawn from one shape will not fit the other.
2. **Copilot fits the machinery Harnu already has.** Hooks that answer permission prompts, a caller-chosen `--session-id`, per-launch MCP (`--additional-mcp-config`) and a tool allowlist (`--available-tools`), none of it behind an experimental flag. Its seam is PTY plus hooks plus `events.jsonl`, the shape [Superset](https://docs.superset.sh/add-agent-support) and Emdash already ship, and it reuses Harnu's hook bridge. ACP is not needed. The open check is whether an `http` hook to `127.0.0.1` works for the two permission events ([§9](#9-risks)).
3. **OpenCode 2 is the honest second shape.** One shared server per user, and any client, not only the TUI, can answer a permission request. That is exactly the property a server-shaped adapter needs and the one the earlier Codex plan still had to prove. v2 is young and some endpoints live under `/experimental/`, so it is a spike now and an adapter later. (OpenCode 1 was a weaker candidate than this RFC first said: its `permission.ask` plugin hook never fires.)

### Out of plan: Gemini CLI

Gemini CLI was in the first draft. It leaves the plan, for three reasons:

- **The consumer CLI is gone.** On 2026-06-18 Gemini CLI stopped serving Google AI Pro and Ultra and free individual users, who moved to Antigravity CLI ([Google's announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)). It stays only for Gemini Code Assist Standard and Enterprise licences and paid API keys. This also answers the first draft's open question about a "sunset": the claim was right.
- **Usage fell with it.** npm downloads of `@google/gemini-cli` averaged about 720k a week in May 2026 (3.19M in the month; the reviewer measured 831k for one May week) and were 289k for the week of 2026-10-20.
- **It would need a chat pane just for Gemini.** Its hooks are not observe-only, as the first draft said: a `BeforeTool` hook can deny a tool call (`decision: "deny"`, or exit code 2). But it cannot grant one, so an Approval Inbox that answers "allow" would need ACP and a Harnu-rendered conversation, which we decided not to build ([§10](#10-open-questions)).

**Antigravity CLI** is a candidate to evaluate later. Google says it keeps Gemini CLI's hooks, skills, subagents and extensions, without 1:1 parity at launch. We have not checked its session store, flags or whether hooks can answer permissions.

---

## 5. Design: the seam

### 5.1 The line

```
 ABOVE THE LINE (provider-agnostic, speaks only Harnu's vocabulary)
 ┌─────────────────────────────────────────────────────────────────┐
 │  Fleet model · Approval Inbox · Missions · Board · Memory       │
 │  Cleanup · Hibernation · MCP verbs · Sidebar · Folder view      │
 └───────────────▲───────────────────────────────┬─────────────────┘
                 │ events in                     │ commands out
                 │ session.started               │ launch · resume · fork
                 │ state.changed                 │ answerApproval
                 │ approval.requested            │ injectInstructions
                 │ turn.completed                │ registerMcpServer
                 │ session.ended                 │ runHeadless · listSessions
                 │                               │ restrictTools
 ┌───────────────┴───────────────────────────────▼─────────────────┐
 │  AgentAdapter interface  +  capability manifest per adapter     │
 └──────┬──────────────┬──────────────┬─────────────┬──────────────┘
        │              │              │             │
   ┌────┴───┐     ┌────┴────┐    ┌────┴─────┐  ┌────┴─────────┐
   │ Claude │     │ Copilot │    │OpenCode 2│  │ Codex        │
   │ Code   │     │ CLI     │    │ (spike)  │  │ (follow-up)  │
   └────────┘     └─────────┘    └──────────┘  └──────────────┘
   BELOW THE LINE: one adapter per provider
```

A format change in a vendor CLI should break that adapter's tests and nothing else.

### 5.2 Events in

Every adapter emits these, in Harnu's words, regardless of how it learns them:

| Event                | Payload                                                                       | Notes                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.started`    | `{ provider, nativeId, cwd, harnuSessionId? }`                                | The moment the adapter knows which native session this row is. Claude and Copilot know it at spawn (Harnu mints the id). A server-shaped provider learns it from the protocol. |
| `state.changed`      | `working \| needs-input \| idle \| completed \| failed \| stopped \| unknown` | `unknown` is new. See below.                                                                                                                                                   |
| `approval.requested` | `{ id, tool, input, options }`                                                | Feeds the Approval Inbox. `options` carries what the provider can actually answer (allow once, allow always, deny).                                                            |
| `turn.completed`     | `{ usage? }`                                                                  | Usage is optional; many providers report it, some do not.                                                                                                                      |
| `session.ended`      | `{ reason? }`                                                                 | Process gone or the provider said so.                                                                                                                                          |

**`unknown` is a first-class state.** Today a session with no hook yet has a task state of `null` (`fleet-policy.ts:15–16`), which the UI cannot tell apart from "nothing to report". A provider with no transcript truth must be able to say "I do not know", and the sidebar must render that honestly instead of guessing.

### 5.3 Commands out

Harnu calls these on an adapter. An adapter implements the ones it can and declares the rest absent:

| Command              | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `launch`             | Start a new session in a directory with Harnu's options (model, effort, permission posture). |
| `resume`             | Re-open a session by native id.                                                              |
| `fork`               | Start a new session from an existing one.                                                    |
| `answerApproval`     | Reply to an `approval.requested`.                                                            |
| `injectInstructions` | Deliver Harnu's environment text (the doc that tells the agent what Harnu can do).           |
| `registerMcpServer`  | Make Harnu's MCP server available to this session.                                           |
| `runHeadless`        | One-shot, non-interactive run returning structured output (scheduled ticks, auto-naming).    |
| `listSessions`       | Enumerate past sessions for a directory.                                                     |
| `restrictTools`      | Limit the session to a read-only or allow-listed tool set.                                   |

### 5.4 The capability manifest

Each adapter ships a manifest. Everything above the line reads it; nothing above the line asks "is this Claude?".

| Flag                        | Values                        | What reads it                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mintsSessionId`            | bool                          | Whether the caller can choose the native id at launch. Decides how a fresh session is bound to its row ([§6](#6-what-we-found-in-our-own-code), item 3).                                                                                                                                                       |
| `fork`                      | bool                          | Fork menu item.                                                                                                                                                                                                                                                                                                |
| `transcriptTruth`           | bool                          | Whether idle/working can be derived from durable records or only from live events.                                                                                                                                                                                                                             |
| `usage`                     | none / live / history         | Usage panels. Per-model history stays Claude-only.                                                                                                                                                                                                                                                             |
| `toolRestriction`           | none / allowlist / sandbox    | Read-only scheduled workers.                                                                                                                                                                                                                                                                                   |
| `instructionInjection`      | `append` / `replace` / `none` | How Harnu's environment doc is delivered. We propose treating `replace` as `none` by default, because it would drop the vendor's own prompt.                                                                                                                                                                   |
| `hooksAnswerPermissions`    | bool                          | Whether an approval can be answered out of band.                                                                                                                                                                                                                                                               |
| `denyBeforeExecution`       | bool                          | Whether Harnu can block a tool call before it runs. The orchestrator guard (`guard.mjs`, a `PreToolUse` deny) and Sentinel's auto-deny need it; when false, `orchestrator_arm` and Sentinel are hidden for that provider.                                                                                      |
| `discoversExternalSessions` | bool                          | Whether sessions started outside Harnu show up in "Active elsewhere". Claude does today (any session under `~/.claude/projects`), and Copilot can (`~/.copilot/session-state`). A protocol-only adapter sees only the sessions on the server Harnu spawned, so a run in the user's own terminal never appears. |

The ADR that follows this RFC may add flags (resume, per-launch MCP registration, headless). The list is deliberately small: a flag earns its place when a feature above the line needs to branch on it.

### 5.5 Identity

A Harnu session id becomes `provider:nativeId`, for example `claude:3f2a…` or `copilot:<uuid>`. The Claude **slug** stays as the partition key the renderer and IPC already use. Adapters with no per-directory folder on disk (Copilot keeps one folder per session, Codex shards by date) synthesize a slug from the working directory. Encoding a path into a slug is deterministic (`encodePathToSlug` in `folder-slug.ts`); only decoding is lossy, and the folder model is keyed by the real working directory, so a synthesized slug is safe as a partition key in the renderer.

**The main process is not there yet.** `mergeSlugSessions` derives a session's slug from where its transcript file sits (`slugOfPath(rootDir, fullPath)`, `fleet-model-core.ts:82`, used at :135). A file outside `~/.claude/projects`, such as a Copilot `events.jsonl` or a date-sharded Codex rollout, resolves to the wrong slug or to `''`, so the incremental refresh would drop or misfile it. The fleet model needs a provider-aware key (provider plus the adapter's synthesized slug) before a second adapter lands.

The MCP verbs that take a session id (`orchestrator_arm`, `message_session`, mission `session` links, the `create_session` acknowledgement) must accept and round-trip the qualified form. Today `SESSION_UUID_RE` in `mcp/tool-handlers.ts` rejects anything but a bare UUID at six call sites (mission owner, `session` links, `mission_import_legacy` and others), and existing mission files store bare ids. So **a bare UUID keeps meaning `claude:`**: the check widens to accept `provider:nativeId` as well, and no mission file is migrated. The MCP transport has no per-session identity by design ([ADR-0013](../adr/0013-orchestrator-arm-addressing.md)), so this is naming, not authentication.

### 5.6 The degradation rule

> Every feature above the line must behave honestly when a capability is missing.

If `fork` is false the menu item is absent. If `transcriptTruth` is false and no live event has arrived, the state is `unknown`. If `usage` is `none`, the usage panel does not appear for that session. A feature may degrade; it may not lie.

### 5.7 The liveness rule

An adapter must emit `session.started` within N seconds of `launch`, or the row shows **"no signal"** instead of a silent `null`. This closes the gap in [§6](#6-what-we-found-in-our-own-code) item 2. N is for the ADR to decide, tuned per adapter.

### 5.8 Per-provider seam

The seam is not one mechanism. It is the cheapest honest mechanism per provider, behind one interface.

| Provider        | Seam                                                                                                                                    | What Harnu keeps                                                                                                                                                        | Status                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code     | PTY + JSONL transcript + hooks + companion mod (as today)                                                                               | Everything                                                                                                                                                              | Moves behind the adapter, behaviour unchanged   |
| Copilot CLI     | PTY running `copilot --session-id <uuid>`, hooks (`preToolUse`, `permissionRequest`) on the existing bridge, `events.jsonl` for listing | Terminal pane, inbox, missions, MCP verbs, the orchestrator guard and Sentinel (hooks deny before execution), external sessions. Not the companion mod or usage history | First non-Claude adapter, behind a flag         |
| OpenCode 2      | PTY running the TUI as one client of a shared `opencode serve`; Harnu is a second client over HTTP/SSE                                  | Terminal pane, inbox, missions, MCP verbs. Guard, Sentinel and external sessions depend on what the spike finds                                                         | Spike now (T543), adapter later when v2 settles |
| Codex CLI       | PTY running `codex --remote`, plus `codex app-server` JSON-RPC                                                                          | Same as OpenCode 2. Drops hooks entirely, so the guard and Sentinel need `app-server` to deny before execution, which is unverified                                     | Follow-up decision after the gate               |
| Antigravity CLI | Not evaluated                                                                                                                           |                                                                                                                                                                         | Candidate to evaluate later                     |
| Gemini CLI      | None                                                                                                                                    |                                                                                                                                                                         | Out of plan ([§4](#out-of-plan-gemini-cli))     |
| Any other CLI   | Terminal-only tier: a PTY, no adapter                                                                                                   | A terminal pane with an "Unmanaged: no state, no approvals" badge and an `unknown` dot, never idle                                                                      | Ships with T544                                 |

### 5.9 The governing principle

> **The interface is drawn with two real shapes, Claude and OpenCode 2, never from Claude alone.**

An interface designed from Claude's shape would read "discover session files, watch them, derive state". Copilot fits that shape too, so shipping it alone would not test the interface. A server-shaped provider does not fit: it learns the session id from the server, gets approvals as events that any client may answer, and may never touch a transcript. Drawing the line with OpenCode 2 in view keeps the vocabulary event-shaped instead of file-shaped. It is also why the adapter layer is gated on the OpenCode 2 prototype ([§8](#8-plan)).

---

## 6. What we found in our own code

Reading the code against the proposed seam turned up six blockers. None are in the original effort estimate. Each was confirmed against source.

1. **Codex hook trust collides with Harnu's per-boot hook URL.** Codex records trust against a hash of the hook command. Harnu's command embeds an ephemeral port and a per-boot token: the token is minted with `randomUUID()` at `hook-bridge.ts:358`, and the command is built with port and token baked in at `hook-installer.ts:60` (the `curl` transport is at `hook-installer.ts:63`). A Codex user would re-approve the hook after every restart. The fix is a constant command that reads port and token from a file, a small change to the existing transport, not a signing problem. Codex is now a follow-up ([§8](#8-plan)), but the same constant command is the fallback if Copilot's `http` hooks cannot reach `127.0.0.1` ([§9](#9-risks)).

2. **When hooks go dark, nothing notices.** Screen scraping runs only on folder shell panes; the code says "a hooked agent is never screen-scraped" (`detect/detect-orchestrate-core.ts:16–20`). A Copilot pane whose hooks never fire (a missing environment variable, a rejected URL) would get no fleet dot and no inbox entry, and `get_fleet` would report nothing wrong. Hence the liveness rule ([§5.7](#57-the-liveness-rule)).

3. **Approval-to-session mapping has no provider-neutral key.** `hook-bridge.ts:139` keys on `body.session_id`, which for Claude is the id Harnu minted with `--session-id`. Copilot can be handed one (`--session-id`), so it keys the same way. A server-shaped provider (OpenCode, Codex) cannot, so the first approval of a fresh session can arrive before Harnu knows which row owns it. Matching on directory plus time is what Claude does only _before_ its transcript appears, and Claude's critical paths (arming at spawn, the `create_session` correlation in ADR-0003) bypass it with the minted id. A mission fan-out puts several sessions in one directory, so directory-plus-time is not acceptable for dispatched sessions. The fix is `session.started` carrying `harnuSessionId`: the adapter binds the row to the native id at the handshake.

4. **No `unknown` fleet state.** `FleetTaskState` is `working | needs-input | idle | completed | failed | stopped | null` (`fleet-policy.ts:15–16`). `null` means "no hook yet", not "I cannot know".

5. **The orchestrator-guard boot sweep assumes Claude's layout.** `sweepOnBoot` (`orchestrator-guard.ts:412`) scans `~/.claude/projects` (default at line 413) for `<id>.jsonl` files (`listExistingSessionIds`, line 388) and drops armed entries it does not find. A non-Claude id is never found there, so its arm would be dropped at every boot. The sweep must ask the owning adapter whether a session still exists.

6. **No golden fixtures.** `tests/fixtures/` holds companion-parity, mission-migration, mission-v3 and mods-audit material, and no session transcripts. About 40 tests build JSONL lines inline (from the 2026-10-19 analysis; not re-counted here). "Claude behaves identically after the refactor" cannot be verified without a captured corpus first.

---

## 7. Alternatives considered

### (a) Per-CLI transcript parsers and hook maps

**What it is.** An internal effort estimate priced making Harnu run Codex and Copilot as 5 to 7 months of one senior engineer: a provider-neutral refactor first (6 to 8 weeks), then a transcript reader, hook map and launcher per CLI (5 to 7 weeks for Codex, 4 to 6 for Copilot), with 15 to 21 weeks for core parity before optional work.

**Why we rejected it.**

- It builds the Claude shape N times: every provider gets "discover files, tail them, derive state".
- The formats it depends on are undocumented and churn, and Codex and Copilot ship every one to seven days. Each parser is a permanent maintenance line for one maintainer.
- Its assumptions fail for Codex: hook trust breaks Harnu's design (§6.1), Codex cannot be minted a session id (§6.3), and the "silent fallback to screen scraping" does not happen today (§6.2).
- Codex and OpenCode steer integrators toward a protocol. The estimate mentioned `app-server` only as a footnote.

What survives from it is the Copilot half, in a smaller form: Copilot gets hooks and a launcher, but its state comes from hooks, and its session files are read only to list sessions.

- Once documentation contracts, Windows, hook-trust UX and the large renderer-store regression were costed, two independent reviews put the plan at 25 to 35 weeks.

We do not fall back to it if the OpenCode 2 prototype fails ([§8](#8-plan)).

### (b) ACP as the single seam, with a Harnu chat pane

**What it is.** Render every non-Claude agent in a Harnu-owned chat pane over [ACP](https://agentclientprotocol.com/protocol/v1/overview). One client covers Codex (via an adapter), Copilot, OpenCode and dozens more in the [registry](https://agentclientprotocol.com/get-started/registry).

**What it gains.** One code path for many agents. A rich approval model: ACP permission requests carry options, tool-call detail and locations, which map directly to the Approval Inbox. Standard MCP registration, session listing and resume. And it is the only route to granting approvals for CLIs whose hooks cannot grant, such as Gemini.

**What it loses.**

- **The real terminal UI.** The agent runs headless and the client draws the chat.
- **Terminal verbs and detection.** `read_terminal` and `send_terminal` work on a PTY ([ADR-0020](../adr/0020-agent-terminals-headless-screen-model.md)), and screen-based detection needs a screen.
- **A system-prompt field.** ACP has none; a client-provided system prompt proposal moved to Draft on 2026-10-12. Delivering Harnu's environment doc stays best-effort per agent.
- **Per-model usage history.** ACP reports context fill and cost, not a per-model ledger.
- **Stability.** A v2 draft with breaking changes was published on 2026-07-20. We would pin to v1 and plan a migration.
- **A new product surface.** A conversation renderer is a large, permanent UI to design and maintain.

**Our position.** ACP suits only providers that offer nothing better, and only if Harnu has a chat pane, which we decided against for now. It is the wrong seam for Copilot (hooks grant approvals while the real TUI runs) and for Codex and OpenCode (the real TUI plus a native protocol). Hence a per-provider seam, not a single one.

### (c) A terminal-only tier for the long tail

For any CLI without an adapter, offer a plain terminal pane: no fleet state, no inbox, an honest badge, optionally a table of resume arguments. It costs almost nothing, other terminal-first managers ship it, and it makes Harnu a launcher for any CLI on day one. The screen manifests for `codex` and `aider` already exist in `src/main/detect/`, so the same work doubles as the T544 demand probe. The risk is that it looks like support. **Decided: yes.** The badge reads "Unmanaged: no state, no approvals", and under the degradation rule the dot renders `unknown`, never idle.

### (d) Do nothing and stay Claude-only

Stated fairly, with the strongest counterpoints:

- **The vendors ship their own apps.** OpenAI's Codex desktop app already offers threads per project, worktree isolation and parallel agents; Copilot has agent management in an editor. Harnu's durable edge is depth on Claude Code, which is exactly the part that does not port.
- **There is no demand evidence.** The repository has two issues, none about other agents.
- **Opportunity cost.** Fifteen to twenty-one senior weeks solo, more with the repo's documentation contracts, is most of a year of calendar time for a feature nobody has asked for.
- **Second-class experience.** A Copilot user would lack the companion mod, messaging, usage cockpit, skills and config editor. Shipping that without saying so would be dishonest.
- **Maintenance trap.** Several undocumented formats, one maintainer, vendors that rename fields between releases.

**What holds.** The first three hold for the plan as originally written. A flag-gated Copilot adapter on the existing hook bridge is a smaller bet: no new transport, no experimental flags. The maintenance objection stays strongest for Copilot, which is closed source and ships near-daily; it is limited because state comes from documented hooks and the undocumented `events.jsonl` is read only to list sessions. For server-shaped adapters it mostly dissolves (`app-server` has a stable-versus-experimental split; `opencode serve` publishes a generated API). The seam also pays for itself with Claude alone, through the golden corpus.

**This is why nothing beyond the spikes is committed.** If the prototype fails or the demand probe shows nothing, doing nothing is a legitimate outcome.

---

## 8. Plan

Four pieces of work. The first three are small and cheap; the fourth is gated.

| Card                                       | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rough effort                                                                                                                                                                    | Depends on              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **T542** Golden corpus                     | Capture a scrubbed real Claude Code corpus (sidechains, subagents, resume, fork, a hook-event trace with a permission request, an idle notification and a session end) and snapshot three pure derivations: `scanFoldersUncached`, `deriveTranscriptTruth`, `reduceTaskState`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | about 1 week                                                                                                                                                                    | none                    |
| **T543** OpenCode 2 spike                  | Behind a flag, no renderer refactor. Run one shared `opencode serve`, the vendor TUI as one client in a Harnu PTY, and Harnu as a second client. Pass/fail on each: (1) the session id is bound to its row at spawn; (2) **a permission request raised while the TUI is attached reaches Harnu, Harnu answers it, and the TUI drops its prompt**; (3) turn events drive the task-state fold; (4) usage reaches the telemetry store; (5) **park and resume**: hibernation kills the PTY and, if Harnu owns it, the server, and the resumed TUI must land on the same session with its history; (6) a session started outside Harnu on the same server shows up (`discoversExternalSessions`); (7) a tool call can be denied before it runs (`denyBeforeExecution`). Write up the endpoints used, which live under `/experimental/`, and the measured approval round-trip. | 1 to 2 weeks                                                                                                                                                                    | none (parallel to T542) |
| **T544** Demand probe + terminal-only tier | Ship the terminal-only tier ([§7c](#c-a-terminal-only-tier-for-the-long-tail)) for the CLIs Harnu already detects in folder terminals (`codex` and `aider` have screen manifests in `src/main/detect/`), behind a setting, with the "Unmanaged: no state, no approvals" badge, and link a public discussion. No telemetry is sent, so **activity on that public discussion is the metric**; nothing local is read by us.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | about 3 days                                                                                                                                                                    | none (parallel)         |
| **T545** Adapter layer                     | An ADR, the `AgentAdapter` interface and a fake adapter for tests, Claude moved behind it, a provider-aware fleet key ([§5.5](#55-identity)), the Copilot adapter behind a flag (PTY, hooks on the existing bridge, `events.jsonl` for listing), provider fields on session records, `unknown` and "no signal" in the UI, provider-qualified ids in the MCP verbs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | roughly 2 weeks for the minimal seam, 2 to 3 for the Copilot adapter (it reuses the hook bridge; an estimate, not measured), 1 to 2 for qualified ids, 1 for docs and contracts | T542, T543              |

### The gate

After T543 there is an explicit **go / no-go** decision, informed by T544:

- **Go.** The spike shows the vocabulary holds a server-shaped provider: in particular that a second client sees and answers approvals while the vendor TUI is attached, and that park and resume work. _And_ the demand probe shows at least some interest. Proceed to T545, shipping Copilot as an experimental provider with a published capability matrix.
- **No-go.** The probe is silent: stop. Or the spike shows the vocabulary cannot hold a server-shaped provider without a redesign: redraw the interface before any second adapter ships, because shipping Copilot alone would freeze a Claude-shaped interface. T542 is worth having either way. We do not fall back to the per-CLI parser plan.

**Nothing beyond the three spikes is committed.** Follow-up decisions, each separate: an OpenCode 2 adapter once v2 settles, a Codex adapter (`app-server` plus `--remote`), and an evaluation of Antigravity CLI.

T545 lands as several PRs, each keeping the T542 snapshots green.

---

## 9. Risks

| Risk                                                                    | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Format and protocol churn**                                           | Claude Code releases roughly weekly; Copilot near-daily; Codex 1 to 2 stable builds a week plus daily alphas; OpenCode several per week, and v2 is a new major.                                                                                                                                                                                                                                                                                                                         | Protocol or documented hooks over transcripts. A per-adapter golden corpus run in CI. Record the version each adapter was tested against.                                                                                                 |
| **Experimental protocol surface**                                       | Some OpenCode 2 endpoints live under `/experimental/`; Codex `app-server` gates some methods (rate limits among them) behind `experimentalApi`.                                                                                                                                                                                                                                                                                                                                         | The spike records exactly which endpoints it used. An adapter declares a capability absent (for example `usage: none`) when its endpoint is experimental or missing.                                                                      |
| **Copilot is closed source and its entry points are thinly documented** | Everything we know of `events.jsonl` is observation. The server-mode spelling is not in the CLI reference table: the changelog mentions `--server` and `--headless` sessions, and a reviewer reports `copilot --headless --port N` (unverified). [copilot-cli #1606](https://github.com/github/copilot-cli/issues/1606) first reported `--headless --stdio` removed without notice, then the reporter retracted it: auto-update had silently run a newer binary than the one installed. | The Copilot adapter does not need server mode: it is PTY plus hooks. Pin the tested version and disable auto-update for Harnu's launches (`COPILOT_AUTO_UPDATE=false`). Read `events.jsonl` only to list sessions, never to derive state. |
| **Hook trust and localhost rules**                                      | Codex pins trust to a command hash. Copilot's `http` hooks are https-only; `http://localhost`, `http://127.*` and `http://[::1]` are allowed only with `COPILOT_HOOK_ALLOW_LOCALHOST=1`, and the docs also say the URL for `preToolUse` and `permissionRequest` "must use `https://`" because the response can grant permissions. Whether the environment variable lifts that for the two permission events is **unverified**.                                                          | Check it first in T545. If it does not, use a `command` hook running a constant command that reads port and token from a file ([§6](#6-what-we-found-in-our-own-code) item 1), which also keeps Codex viable later.                       |
| **Windows**                                                             | Named pipes and npm shim resolution are Claude-specific today. A shared server needs a local transport that works on Windows.                                                                                                                                                                                                                                                                                                                                                           | Linux and macOS are the bar for the first Copilot adapter. Verify Windows before lifting the flag.                                                                                                                                        |
| **MCP session identity**                                                | The transport has no per-session identity ([ADR-0013](../adr/0013-orchestrator-arm-addressing.md)). A caller can claim any `provider:nativeId`.                                                                                                                                                                                                                                                                                                                                         | Provider-qualified ids are naming, not authentication, and the docs say so.                                                                                                                                                               |
| **Documentation contracts**                                             | The agent-facing features doc, user docs, changelog and i18n parity gates apply in the same PRs as the code.                                                                                                                                                                                                                                                                                                                                                                            | Budgeted in T545 (about a week).                                                                                                                                                                                                          |
| **Second-class experience**                                             | Other providers lack Claude-only features.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Publish the capability matrix, ship as "experimental", never list a provider as supported without it.                                                                                                                                     |

---

## 10. Open questions

### Decided in review (2026-10-27)

1. **Terminal-only tier: yes.** It ships with T544. Badge: "Unmanaged: no state, no approvals"; the dot renders `unknown`, never idle.
2. **Chat pane: not now.** Copilot does not need it (its hooks answer approvals while the real TUI runs), and Gemini, the only provider that would, is out of plan.
3. **First non-Claude adapter: Copilot CLI.** It is the only candidate with a caller-chosen id, approvals from hooks, per-launch MCP and a tool allowlist, none of it experimental, and it reuses the hook bridge. Because it is Claude-shaped, the T543 spike moves from Codex to OpenCode 2 to keep the interface honest.
4. **Gemini CLI: out of plan** ([§4](#out-of-plan-gemini-cli)). The consumer tiers moved to Antigravity CLI on 2026-06-18.

### Still open

5. **Do Copilot `http` hooks to `127.0.0.1` work for `preToolUse` and `permissionRequest`** with `COPILOT_HOOK_ALLOW_LOCALHOST=1`, or does the https rule for those two events win? ([§9](#9-risks)).
6. **Can a server-shaped provider deny a tool call before it runs?** If OpenCode 2 or Codex cannot, `orchestrator_arm` and Sentinel's auto-deny are hidden for that provider (`denyBeforeExecution: false`). T543 answers it for OpenCode 2.
7. **Which promises should read `unknown` for Copilot and OpenCode 2?** The spike and the Copilot adapter will list the Harnu promises (fork, usage history, state after a restart) each cannot meet. What should the UI say for each?
8. **How should the `session.started` timeout be set?** One number for all adapters, or one per adapter? What is your CLI's cold-start time?
9. **Per-model usage history for non-Claude agents.** The design says no (Claude-only). Tell us if that is wrong for you.
10. **Antigravity CLI.** Worth an adapter? We have not checked its session store, flags or hooks.
11. **What have we missed?** A CLI we did not list, a failure mode of a shared server with several clients, a reason the event vocabulary is too small.

---

## 11. How to contribute

**Comment on the PR.** Line comments on this file work best. Disagreement is welcome, and disagreement with a reason is more welcome.

### Send fixtures from your installed CLI

We test against real captures, and one machine is a small sample. If you run Claude Code, Copilot, OpenCode or Codex, a short scrubbed capture from your version helps.

1. **Record the version** (`claude --version`, `codex --version`, and so on).
2. **Use a throwaway session.** A new empty directory, a trivial prompt, one tool call, one permission prompt answered, then exit. Never capture a real work session, and never one from a client or employer repository.
3. **Copy the smallest session file** that shows the behaviour, from the locations in [§4](#4-landscape).
4. **Scrub it.** Replace your home directory with `/home/user`, real repo and organization names with `org/proj/www`, ticket keys with `PROJ-231`, and your name, email and hostname with `user`, `user@example.com`, `host`. Search for `Bearer`, `token`, `key`, `secret`, `password` and long base64-looking strings, and delete the whole value.
5. **Read the scrubbed file once, by eye.** A scrub is a net, not a guarantee. If unsure about a line, delete it.
6. **Attach it** to a PR comment or discussion reply with the version string and one sentence on what the session did. If you would rather not post publicly, say so.

### Tell us which CLI you would use with Harnu, and why

One line is enough. "Codex, because my team standardises on it" is useful. "None, I only use Claude Code" is also useful.

### Propose an adapter for another CLI

Fill in this checklist. If you can answer all of it from documentation or experiment, an adapter is feasible; if you cannot, the unanswered lines are the work.

1. Can the caller choose the session id at launch? Where do sessions live on disk, in what format, and is that format documented?
2. Can past sessions be listed without reading files (a command or protocol call)?
3. What are the commands for new, resume and fork? Which exist? How do you set model, effort and directory?
4. Is there a control protocol or server (JSON-RPC, HTTP, SSE, ACP)? Can the vendor's own terminal UI attach to it, and can a second client answer approvals while it is attached?
5. If it has hooks: which events and handler types, and can a hook answer a permission request?
6. How is a tool-call approval surfaced and answered? How do you know a turn ended, or the session ended?
7. Does it report token usage or rate limits, and how?
8. How can Harnu add instructions (append, replace, none), and does that replace the vendor's own prompt?
9. How can a per-launch MCP server be registered, and does it need a settings file? Can the tool set be restricted for a read-only run?
10. Is there a non-interactive mode with structured output?
11. Is the CLI open source? What is its release cadence? Has it removed a flag or changed a format without notice in the last six months?
12. Does it pin hook trust in a way that Harnu's per-boot hook URL would collide with?
13. Does all of this hold on Windows?

Answer in a PR comment or a discussion and we will turn it into a capability manifest entry.

---

## 12. References

### Vendor documentation

- Copilot CLI hooks configuration: <https://docs.github.com/en/copilot/reference/hooks-configuration> (`http` handlers, `preToolUse` and `permissionRequest` decisions, `COPILOT_HOOK_ALLOW_LOCALHOST`)
- Copilot CLI command reference: <https://docs.github.com/en/copilot/reference/cli-command-reference>, programmatic reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference> (`--available-tools`, `--excluded-tools`, `COPILOT_AUTO_UPDATE`)
- Copilot CLI changelog: <https://github.com/github/copilot-cli/blob/main/changelog.md> (`--session-id=<id>`, `--additional-mcp-config`, `--server` / `--headless` sessions, `--acp`)
- Copilot CLI issue on `--headless --stdio`, reported removed and later retracted: <https://github.com/github/copilot-cli/issues/1606>
- Copilot CLI ACP support in public preview: <https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/>
- OpenCode 2 migration guide: <https://opencode.ai/v2/docs/migrate-v1>; plugin hook mapping (`permission.ask` to `ctx.permission.hook("evaluate")`) in the OpenCode repository at `services/www/src/docs/content/build/plugins/migrate-v1.mdx`
- OpenCode ACP: <https://opencode.ai/docs/acp/>
- Codex hooks: <https://developers.openai.com/codex/hooks> (hook types `command` and `mcp_tool`, trust model)
- Codex app-server: <https://developers.openai.com/codex/app-server> (JSON-RPC protocol, `experimentalApi`, `codex --remote`)
- Codex configuration reference, under <https://developers.openai.com/codex> (`developer_instructions`, `additional_developer_instructions`, `model_instructions_file`, `mcp_servers`)
- Gemini CLI to Antigravity CLI transition: <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>
- Gemini CLI hooks reference: <https://geminicli.com/docs/hooks/reference/> (`BeforeTool` `decision: "deny"`, exit code 2)
- npm download counts: <https://api.npmjs.org/downloads/range/2026-05-01:2026-05-31/@google/gemini-cli>

The OpenCode 1 facts in §4 come from probing the installed binary and reading the v1.19.4 source. The OpenCode 2 server, client and permission-event behaviour comes from a reviewer and the migration guide; only the `permission.asked` event was confirmed in v2 source. T543 verifies the rest. If you spot a wrong cell, tell us in a comment and link the source.

### Agent Client Protocol

- v1 overview: <https://agentclientprotocol.com/protocol/v1/overview>
- v1 schema: <https://agentclientprotocol.com/protocol/v1/schema>
- Session setup: <https://agentclientprotocol.com/protocol/v1/session-setup>
- Prompt turn: <https://agentclientprotocol.com/protocol/v1/prompt-turn>
- Tool calls and permission requests: <https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission>
- Session config options: <https://agentclientprotocol.com/protocol/v1/session-config-options>
- v2 draft: <https://agentclientprotocol.com/protocol/v2/overview> and migration notes <https://agentclientprotocol.com/protocol/v2/migration>
- v2 draft announcement: <https://agentclientprotocol.com/announcements/acp-v2-draft>
- Client-provided system prompt proposal (Draft): <https://agentclientprotocol.com/rfds/client-system-prompt>
- Agent registry: <https://agentclientprotocol.com/get-started/registry> and <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
- Agents and clients lists: <https://agentclientprotocol.com/get-started/agents>, <https://agentclientprotocol.com/get-started/clients>
- Codex adapter (spawns `codex app-server`): <https://github.com/agentclientprotocol/codex-acp>
- Claude adapter (wraps the Agent SDK, not the TUI): <https://github.com/agentclientprotocol/claude-agent-acp>

### Prior art in multi-agent session managers

- Vibe Kanban (Codex via `app-server`, Copilot via ACP): <https://github.com/BloopAI/vibe-kanban>
- HAPI (mixed per agent; matrix at <https://github.com/tiann/hapi/blob/main/docs/guide/agents.md>): <https://github.com/tiann/hapi>
- Superset (PTY plus hooks): <https://github.com/superset-sh/superset>, <https://docs.superset.sh/add-agent-support>
- Emdash (PTY plus marker-tagged hooks): <https://github.com/generalaction/emdash>

### In this repository

- [ADR-0003](../adr/0003-create-session-ack-means-materialized.md): `create_session` acknowledgement means the session materialized.
- [ADR-0013](../adr/0013-orchestrator-arm-addressing.md): `orchestrator_arm` addressing and the lack of per-session identity in the MCP transport.
- [ADR-0020](../adr/0020-agent-terminals-headless-screen-model.md): agent terminals and the headless screen model.
- [T474 agent terminals spec](T474-agent-terminals/spec.md): house style for specs.
