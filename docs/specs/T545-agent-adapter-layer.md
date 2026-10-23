# T545 — Agent adapter layer: making Harnu agent-agnostic

**Status:** RFC — open for comment
**Date:** 2026-10-19
**Author:** agent (T545), for the maintainer
**Scope of this document:** design only. No code changes. Merging the PR that carries it records the design; it does not commit to building it.
**Related work:** golden corpus (T542), Codex spike (T543), demand probe (T544), the adapter layer itself (T545). See [§8 Plan](#8-plan).

---

## 1. Summary

1. **What.** Harnu today drives exactly one agent, Claude Code, and the two are fused. This RFC proposes a small seam: Harnu owns a vocabulary of events and commands, and one adapter per agent CLI translates into it.
2. **Why.** Claude Code changes its own file and hook formats between releases, and other agent CLIs (Codex, Copilot, Gemini, OpenCode) are in wide use. A seam makes both cheaper to handle: a format change breaks one adapter, not the app.
3. **How, in one line.** Draw the interface with two real adapters in hand (Claude Code and Codex CLI), never from Claude alone, and use each vendor's own control protocol where one exists instead of parsing its transcripts.
4. **What is committed.** Nothing beyond three cheap spikes (a test corpus, a Codex prototype, a demand probe). There is an explicit go/no-go gate after the Codex prototype.
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
- Add Codex CLI as the second adapter, behind a flag, to keep the interface honest.
- Make every feature above the line behave honestly when a provider lacks a capability: hide it, or show "unknown". Never show a confident wrong answer.
- Publish a capability checklist so someone outside the project can propose an adapter for another CLI.

### Non-goals

- **Porting Claude-only subsystems.** The companion mod (a plugin inside the `claude` process), the cross-session messaging socket, per-model usage history and plan cockpit, bundled skills and the mods audit stay Claude-only and are hidden for other providers.
- **An ACP chat pane.** Rendering the conversation ourselves is a different product surface. It is an open question ([§10](#10-open-questions)), not a proposal.
- **Renaming IPC channels.** The `claude:*` channels keep their names until a second consumer justifies the churn.
- **Replacing the slug.** It stays as the partition key; other adapters synthesize it from the working directory.
- **Committing to Copilot or Gemini support.** Both need a product decision first.

---

## 4. Landscape

Five CLIs, as a session manager sees them. Versions are the ones we checked; "checked on 2026-10-19" applies to every cell. Where we could, we probed the installed binary and its session store on a real machine; the rest comes from vendor docs (links in [§12](#12-references)). Cells marked "undocumented" describe formats we observed but the vendor does not promise.

| Capability                          | Claude Code 2.1.303                      | Codex CLI 0.163                                                     | Copilot CLI 1.0.98                                                                              | Gemini CLI 0.64.0                                                             | OpenCode 1.19                                                                  |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Open source                         | no                                       | yes (Rust)                                                          | **no** (npm binary)                                                                             | yes                                                                           | yes                                                                            |
| Release cadence                     | weekly-ish                               | 1–2 stable per week, daily alphas                                   | near-daily stable                                                                               | weekly stable plus nightly                                                    | several per week                                                               |
| Sessions on disk                    | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` plus SQLite, undocumented | `~/.copilot/session-state/<id>/events.jsonl` plus `workspace.yaml`, undocumented but plain JSON | `~/.gemini/tmp/<hash>/chats/session-*.jsonl`, location documented, schema not | SQLite `opencode.db`, readable via `opencode export`                           |
| Caller-minted session id            | `--session-id`                           | **no**                                                              | `--session-id`                                                                                  | `--session-id` (undocumented)                                                 | no (returned by `POST /session`)                                               |
| Resume / fork                       | `--resume` / `--fork-session`            | `resume` / `fork`                                                   | `--resume` / TUI only                                                                           | `--resume` / none                                                             | `-s` / `--fork`                                                                |
| Inject system-prompt text           | `--append-system-prompt`                 | `-c developer_instructions=…`                                       | env var pointing at an instructions directory                                                   | **replace-only** (`GEMINI_SYSTEM_MD`) or `SessionStart` hook context          | `instructions` config, `OPENCODE_CONFIG_CONTENT`                               |
| Hooks can answer permission prompts | yes (`http`, synchronous)                | yes (`command` and `mcp_tool`), **hash-pinned trust**               | yes (`http`; https only unless `COPILOT_HOOK_ALLOW_LOCALHOST=1`)                                | **no** (observe-only)                                                         | yes (JS plugin `permission.ask`)                                               |
| Per-launch MCP server               | `--mcp-config`                           | `-c mcp_servers.<name>.url=…`                                       | `--additional-mcp-config`                                                                       | settings file only                                                            | three ways                                                                     |
| Read-only / tool limits             | `--tools`                                | `--sandbox read-only`                                               | `--available-tools` and friends                                                                 | `--approval-mode plan`, policy engine                                         | `permission` config                                                            |
| Headless JSON                       | `-p --output-format json`                | `exec --json`                                                       | `-p --output-format json`                                                                       | `-p -o stream-json`                                                           | `run --format json`                                                            |
| **Control protocol**                | none (private socket)                    | **`app-server` JSON-RPC; `codex --remote` attaches the TUI to it**  | `--server` plus SDK, and `--acp`                                                                | `--acp` only                                                                  | **`serve` (HTTP, SSE, OpenAPI); `attach` runs the TUI against it**; also `acp` |
| Native ACP                          | adapter only                             | adapter only                                                        | yes                                                                                             | yes                                                                           | yes                                                                            |

ACP is the [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview): JSON-RPC over stdio between an editor (the client) and an agent. Under ACP the client renders the conversation; the agent runs headless.

### Three takeaways

1. **Codex and OpenCode can run their own terminal UI against a server Harnu controls.** Codex does it with `codex app-server` plus `codex --remote`; OpenCode with `opencode serve` plus `opencode attach`. The human keeps the real vendor TUI in Harnu's terminal pane, and Harnu gets thread ids, approval requests, turn events and usage over a documented protocol. No transcript parsing, no hook trust. This is the shape Harnu wants.
2. **Copilot and Gemini only offer ACP or an SDK.** There is no way to attach the real TUI to a controllable server. To get state and approvals, Harnu would have to render the chat itself. Otherwise those CLIs run in a terminal-only tier with no state. Which of the two is a product decision, not an engineering one.
3. **Gemini's hooks cannot grant a permission.** Gemini looks like the closest Claude Code clone on paper (per-project JSONL, settings hooks, `--session-id`, stream-json output), but its hooks are observe-only. An Approval Inbox for Gemini is impossible without ACP.

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
   ┌────┴───┐     ┌────┴───┐     ┌────┴────┐   ┌────┴─────────┐
   │ Claude │     │ Codex  │     │OpenCode │   │ Copilot,     │
   │ Code   │     │ CLI    │     │ (later) │   │ Gemini       │
   └────────┘     └────────┘     └─────────┘   │ (undecided)  │
   BELOW THE LINE: one adapter per provider    └──────────────┘
```

A format change in a vendor CLI should break that adapter's tests and nothing else.

### 5.2 Events in

Every adapter emits these, in Harnu's words, regardless of how it learns them:

| Event                | Payload                                                                       | Notes                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`    | `{ provider, nativeId, cwd, harnuSessionId? }`                                | The moment the adapter knows which native session this row is. Claude knows it at spawn (Harnu mints the id). Codex learns it from the protocol handshake. |
| `state.changed`      | `working \| needs-input \| idle \| completed \| failed \| stopped \| unknown` | `unknown` is new. See below.                                                                                                                               |
| `approval.requested` | `{ id, tool, input, options }`                                                | Feeds the Approval Inbox. `options` carries what the provider can actually answer (allow once, allow always, deny).                                        |
| `turn.completed`     | `{ usage? }`                                                                  | Usage is optional; many providers report it, some do not.                                                                                                  |
| `session.ended`      | `{ reason? }`                                                                 | Process gone or the provider said so.                                                                                                                      |

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

| Flag                     | Values                        | What reads it                                                                                                                                            |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mintsSessionId`         | bool                          | Whether the caller can choose the native id at launch. Decides how a fresh session is bound to its row ([§6](#6-what-we-found-in-our-own-code), item 3). |
| `fork`                   | bool                          | Fork menu item.                                                                                                                                          |
| `transcriptTruth`        | bool                          | Whether idle/working can be derived from durable records or only from live events.                                                                       |
| `usage`                  | none / live / history         | Usage panels. Per-model history stays Claude-only.                                                                                                       |
| `toolRestriction`        | none / allowlist / sandbox    | Read-only scheduled workers.                                                                                                                             |
| `instructionInjection`   | `append` / `replace` / `none` | How Harnu's environment doc is delivered. We propose treating `replace` as `none` by default, because it would drop the vendor's own prompt.             |
| `hooksAnswerPermissions` | bool                          | Whether an approval can be answered out of band.                                                                                                         |

The ADR that follows this RFC may add flags (resume, per-launch MCP registration, headless). The list is deliberately small: a flag earns its place when a feature above the line needs to branch on it.

### 5.5 Identity

A Harnu session id becomes `provider:nativeId`, for example `claude:3f2a…` or `codex:<thread id>`. The Claude **slug** stays as the partition key the renderer and IPC already use. Adapters with no per-directory folder on disk (Codex shards by date) synthesize a slug from the working directory. Encoding a path into a slug is deterministic (`encodePathToSlug` in `folder-slug.ts`); only decoding is lossy, and the folder model is keyed by the real working directory, so a synthesized slug is safe as a partition key.

The MCP verbs that take a session id (`orchestrator_arm`, `message_session`, mission `session` links, the `create_session` acknowledgement) must accept and round-trip the qualified form. The MCP transport has no per-session identity by design ([ADR-0013](../adr/0013-orchestrator-arm-addressing.md)), so this is naming, not authentication.

### 5.6 The degradation rule

> Every feature above the line must behave honestly when a capability is missing.

If `fork` is false the menu item is absent. If `transcriptTruth` is false and no live event has arrived, the state is `unknown`. If `usage` is `none`, the usage panel does not appear for that session. A feature may degrade; it may not lie.

### 5.7 The liveness rule

An adapter must emit `session.started` within N seconds of `launch`, or the row shows **"no signal"** instead of a silent `null`. This closes the gap in [§6](#6-what-we-found-in-our-own-code) item 2. N is for the ADR to decide, tuned per adapter.

### 5.8 Per-provider seam

The seam is not one mechanism. It is the cheapest honest mechanism per provider, behind one interface.

| Provider    | Seam                                                           | What Harnu keeps                                                                                 | Status                                        |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Claude Code | PTY + JSONL transcript + hooks + companion mod (as today)      | Everything                                                                                       | Moves behind the adapter, behaviour unchanged |
| Codex CLI   | PTY running `codex --remote`, plus `codex app-server` JSON-RPC | Terminal pane, inbox, missions, MCP verbs. Drops the transcript parser and the hook map entirely | First non-Claude adapter, behind a flag       |
| OpenCode    | PTY running `opencode attach`, plus `opencode serve` HTTP/SSE  | Same as Codex                                                                                    | Natural third adapter, same shape             |
| Copilot CLI | ACP in a chat pane, or terminal-only tier                      | Inbox over ACP, no vendor TUI in the pane                                                        | Undecided ([§10](#10-open-questions))         |
| Gemini CLI  | ACP in a chat pane, or terminal-only tier                      | Same; hooks cannot grant permissions                                                             | Undecided                                     |

### 5.9 The governing principle

> **The interface is drawn with two real adapters, Claude and Codex, never from Claude alone.**

An interface designed from Claude's shape would read "discover session files, watch them, derive state". The Codex adapter does not fit that: it learns the thread id from a handshake, gets approvals as protocol requests and never touches a transcript. Drawing the line with both in view keeps the vocabulary event-shaped instead of file-shaped. It is also why the adapter layer is gated on the Codex prototype ([§8](#8-plan)).

---

## 6. What we found in our own code

Reading the code against the proposed seam turned up six blockers. None are in the original effort estimate. Each was confirmed against source.

1. **Codex hook trust collides with Harnu's per-boot hook URL.** Codex records trust against a hash of the hook command. Harnu's command embeds an ephemeral port and a per-boot token: the token is minted with `randomUUID()` at `hook-bridge.ts:358`, and the command is built with port and token baked in at `hook-installer.ts:60` (the `curl` transport is at `hook-installer.ts:63`). A Codex user would re-approve the hook after every restart. The fix is a constant command that reads port and token from a file, a small change to the existing transport, not a signing problem. With the proposed `app-server` route, hooks are not needed for Codex at all.

2. **When hooks go dark, nothing notices.** Screen scraping runs only on folder shell panes; the code says "a hooked agent is never screen-scraped" (`detect/detect-orchestrate-core.ts:16–20`). A Codex pane with untrusted hooks would get no fleet dot and no inbox entry, and `get_fleet` would report nothing wrong. Hence the liveness rule ([§5.7](#57-the-liveness-rule)).

3. **Approval-to-session mapping has no provider-neutral key.** `hook-bridge.ts:139` keys on `body.session_id`, which for Claude is the id Harnu minted with `--session-id`. Codex cannot be handed an id, so the first approval of a fresh Codex session can arrive before Harnu knows which row owns it. Matching on directory plus time is what Claude does only _before_ its transcript appears, and Claude's critical paths (arming at spawn, the `create_session` correlation in ADR-0003) bypass it with the minted id. A mission fan-out puts several sessions in one directory, so directory-plus-time is not acceptable for dispatched sessions. The fix is `session.started` carrying `harnuSessionId`: the adapter binds the row to the native id at the handshake.

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
- Its assumptions fail for the providers it targets: Codex's hook trust breaks Harnu's design (§6.1), Codex cannot be minted a session id (§6.3), and the "silent fallback to screen scraping" does not happen today (§6.2).
- Codex and OpenCode steer integrators toward a protocol. The estimate mentioned `app-server` only as a footnote.
- Once documentation contracts, Windows, hook-trust UX and the large renderer-store regression were costed, two independent reviews put the plan at 25 to 35 weeks.

It remains the fallback if the Codex prototype fails. We do not think it is worth doing then either ([§8](#8-plan)).

### (b) ACP as the single seam, with a Harnu chat pane

**What it is.** Render every non-Claude agent in a Harnu-owned chat pane over [ACP](https://agentclientprotocol.com/protocol/v1/overview). One client covers Codex (via an adapter), Copilot, Gemini, OpenCode and dozens more in the [registry](https://agentclientprotocol.com/get-started/registry).

**What it gains.** One code path for many agents. A rich approval model: ACP permission requests carry options, tool-call detail and locations, which map directly to the Approval Inbox. Standard MCP registration, session listing and resume. And it is the only route to approvals for Copilot and Gemini.

**What it loses.**

- **The real terminal UI.** The agent runs headless and the client draws the chat.
- **Terminal verbs and detection.** `read_terminal` and `send_terminal` work on a PTY ([ADR-0020](../adr/0020-agent-terminals-headless-screen-model.md)), and screen-based detection needs a screen.
- **A system-prompt field.** ACP has none; a client-provided system prompt proposal moved to Draft on 2026-10-12. Delivering Harnu's environment doc stays best-effort per agent.
- **Per-model usage history.** ACP reports context fill and cost, not a per-model ledger.
- **Stability.** A v2 draft with breaking changes was published on 2026-07-20. We would pin to v1 and plan a migration.
- **A new product surface.** A conversation renderer is a large, permanent UI to design and maintain.

**Our position.** ACP suits the providers that offer nothing better (Copilot, Gemini), _if_ Harnu decides to have a chat pane at all. It is the wrong seam for Codex and OpenCode, where the real TUI plus a native protocol is strictly better. Hence a per-provider seam, not a single one.

### (c) A terminal-only tier for the long tail

For any CLI without an adapter, offer a plain terminal pane: no fleet state, no inbox, an honest "unmanaged" badge, optionally a table of resume arguments. It costs almost nothing, other terminal-first managers ship it, and it makes Harnu a launcher for any CLI on day one. The risk is that it looks like support. Under the degradation rule it must render `unknown`, never a calm idle dot. We lean yes, behind a clear badge, and ask in [§10](#10-open-questions) because it changes what the product promises.

### (d) Do nothing and stay Claude-only

Stated fairly, with the strongest counterpoints:

- **The vendors ship their own apps.** OpenAI's Codex desktop app already offers threads per project, worktree isolation and parallel agents; Copilot has agent management in an editor. Harnu's durable edge is depth on Claude Code, which is exactly the part that does not port.
- **There is no demand evidence.** The repository has two issues, none about other agents.
- **Opportunity cost.** Fifteen to twenty-one senior weeks solo, more with the repo's documentation contracts, is most of a year of calendar time for a feature nobody has asked for.
- **Second-class experience.** A Codex user would lack the companion mod, messaging, usage cockpit, skills and config editor. Shipping that without saying so would be dishonest.
- **Maintenance trap.** Several undocumented formats, one maintainer, vendors that rename fields between releases.

**What holds.** The first three hold for the plan as originally written. A protocol-first, flag-gated Codex adapter is a smaller bet, and the maintenance objection mostly dissolves for protocol adapters (`app-server` has a stable-versus-experimental split and powers OpenAI's own app; `opencode serve` publishes an OpenAPI spec). It stays strongest for Copilot. The seam also pays for itself with Claude alone, through the golden corpus.

**This is why nothing beyond the spikes is committed.** If the prototype fails or the demand probe shows nothing, doing nothing is a legitimate outcome.

---

## 8. Plan

Four pieces of work. The first three are small and cheap; the fourth is gated.

| Card                   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rough effort                                                                                                           | Depends on              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **T542** Golden corpus | Capture a scrubbed real Claude Code corpus (sidechains, subagents, resume, fork, a hook-event trace with a permission request, an idle notification and a session end) and snapshot three pure derivations: `scanFoldersUncached`, `deriveTranscriptTruth`, `reduceTaskState`.                                                                                                                                                                         | about 1 week                                                                                                           | none                    |
| **T543** Codex spike   | Behind a flag, no renderer refactor. One Codex session runs as two PTYs: `codex app-server` and `codex --remote`. Prove four signals: thread id known at spawn, an approval landing in the inbox and being answered, turn events driving the task-state fold, rate limits reaching the telemetry store. Try `resume` and `fork` through `--remote`. Write up the JSON-RPC methods used, which were experimental, and the measured approval round-trip. | 1 to 2 weeks                                                                                                           | none (parallel to T542) |
| **T544** Demand probe  | Show other agents Harnu already detects in folder terminals as read-only badges, behind a setting, with an opt-in local counter and a link to a public discussion. No telemetry is sent.                                                                                                                                                                                                                                                               | about 3 days                                                                                                           | none (parallel)         |
| **T545** Adapter layer | An ADR, the `AgentAdapter` interface and a fake adapter for tests, Claude moved behind it, the Codex spike promoted to a real adapter, provider fields on session records, `unknown` and "no signal" in the UI, provider-qualified ids in the MCP verbs.                                                                                                                                                                                               | roughly 2 weeks for the minimal seam, 3 to 4 for the Codex adapter, 1 to 2 for qualified ids, 1 for docs and contracts | T542, T543              |

### The gate

After T543 there is an explicit **go / no-go** decision, informed by T544:

- **Go.** The prototype shows the protocol delivers thread id, approvals, turn events and usage without transcripts or hooks, _and_ the demand probe shows at least some interest. Proceed to T545, shipping Codex as an experimental provider with a published capability matrix.
- **No-go.** The prototype fails, or the probe is silent. Stop. T542 is still worth having. We do not fall back to the per-CLI parser plan, because the analysis says that plan is not worth its cost.

**Nothing beyond the three spikes is committed.** Copilot, Gemini and OpenCode adapters are separate follow-up decisions. OpenCode is the natural third (same hybrid shape as Codex).

T545 lands as several PRs, each keeping the T542 snapshots green.

---

## 9. Risks

| Risk                                                    | Detail                                                                                                                                                                                                                          | Mitigation                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Format and protocol churn**                           | Claude Code releases roughly weekly; Codex 1 to 2 stable builds a week plus daily alphas; Copilot near-daily; Gemini weekly plus nightly; OpenCode several per week.                                                            | Protocol over transcript where a protocol exists. A per-adapter golden corpus run in CI. Record the version each adapter was tested against. |
| **Experimental protocol surface**                       | Codex `app-server` gates some methods (rate limits among them) behind `experimentalApi`.                                                                                                                                        | The spike records exactly which methods it used. An adapter declares `usage: none` when a method is unavailable.                             |
| **Copilot is closed source and its entry points churn** | `--headless --stdio` was removed without deprecation ([copilot-cli #1606](https://github.com/github/copilot-cli/issues/1606)); the current routes are `--server` and `--acp`. Everything we know of its formats is observation. | Treat Copilot as the riskiest provider. Promise nothing before the chat-pane decision.                                                       |
| **Hook trust and localhost rules**                      | Codex pins trust to a command hash. Copilot accepts `http` hooks only over https unless `COPILOT_HOOK_ALLOW_LOCALHOST=1`.                                                                                                       | Prefer the native protocol over hooks; otherwise use a constant command that reads dynamic values from a file.                               |
| **Windows**                                             | Named pipes and npm shim resolution are Claude-specific today. Server-plus-attach needs a local transport that works on Windows.                                                                                                | Linux and macOS are the bar for the first Codex adapter. Verify Windows before lifting the flag.                                             |
| **MCP session identity**                                | The transport has no per-session identity ([ADR-0013](../adr/0013-orchestrator-arm-addressing.md)). A caller can claim any `provider:nativeId`.                                                                                 | Provider-qualified ids are naming, not authentication, and the docs say so.                                                                  |
| **Documentation contracts**                             | The agent-facing features doc, user docs, changelog and i18n parity gates apply in the same PRs as the code.                                                                                                                    | Budgeted in T545 (about a week).                                                                                                             |
| **Second-class experience**                             | Other providers lack Claude-only features.                                                                                                                                                                                      | Publish the capability matrix, ship as "experimental", never list a provider as supported without it.                                        |

---

## 10. Open questions

The first five are also in the PR description as a checklist.

1. **Terminal-only tier: yes or no?** A plain terminal pane for any CLI, no state, no inbox, an honest badge. Almost free and useful as a launcher, but it can read as support. What would the badge have to say?
2. **Chat pane: yes or no?** Should Harnu ever render a conversation itself so it can offer approvals for CLIs that only speak ACP? It is the only route for Copilot and Gemini, and a large new product surface.
3. **First non-Claude adapter: Codex or OpenCode?** Codex has the largest user base and a strong protocol, but the caller cannot mint a session id. OpenCode is easier to integrate and proxies many models, but has a smaller base. The spike targets Codex; its harness is reusable.
4. **Is Gemini's consumer CLI supported long-term?** One third-party agent matrix says it was sunset on 2026-06-18. The ACP registry lists 0.64.0, released 2026-10-13, and the binary we probed reports 0.64.0, so the claim looks wrong, but we have not confirmed it with the vendor. We will not promise Gemini until then.
5. **What have we missed?** A CLI we did not list, a failure mode of attaching a TUI to a server, a reason the event vocabulary is too small.
6. **Which promises should read `unknown` for Codex?** The spike will list the Harnu promises (fork, usage history, state after a restart) that Codex cannot meet. What should the UI say for each?
7. **How should the `session.started` timeout be set?** One number for all adapters, or one per adapter? What is your CLI's cold-start time?
8. **Per-model usage history for non-Claude agents.** The design says no (Claude-only). Tell us if that is wrong for you.

---

## 11. How to contribute

**Comment on the PR.** Line comments on this file work best. Disagreement is welcome, and disagreement with a reason is more welcome.

### Send fixtures from your installed CLI

We test against real captures, and one machine is a small sample. If you run Claude Code, Codex, Copilot, Gemini or OpenCode, a short scrubbed capture from your version helps.

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
4. Is there a control protocol or server (JSON-RPC, HTTP, SSE, ACP)? Can the vendor's own terminal UI attach to it?
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

- Codex hooks: <https://developers.openai.com/codex/hooks> (hook types `command` and `mcp_tool`, trust model)
- Codex app-server: <https://developers.openai.com/codex/app-server> (JSON-RPC protocol, `experimentalApi`, `codex --remote`)
- Codex configuration reference, under <https://developers.openai.com/codex> (`developer_instructions`, `additional_developer_instructions`, `model_instructions_file`, `mcp_servers`)
- GitHub Copilot CLI reference and hooks reference, on <https://docs.github.com> (flags, `--server`, `--acp`, hook handler types and `COPILOT_HOOK_ALLOW_LOCALHOST`)
- Copilot CLI issue on removal of `--headless --stdio`: <https://github.com/github/copilot-cli/issues/1606>
- Copilot CLI ACP support in public preview: <https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/>
- OpenCode ACP: <https://opencode.ai/docs/acp/>

Gemini CLI and OpenCode `serve` facts in §4 come from probing the installed binaries and from vendor docs; if you spot a wrong cell, tell us in a comment and link the source.

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
