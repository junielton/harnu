# T451 — Mission-aware compaction: the mission and its acceptance criteria survive compaction

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T451 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files: this spec, [`01-evidence.md`](01-evidence.md) (the measurements and the live runs, with
their methods and real output), [`02-prototype.md`](02-prototype.md) (the mod half: hooks module,
tests, and the real output of `claude plugin validate`, `claude plugin test` and `tsc`) and
[`ADR-draft.md`](ADR-draft.md).

## 0. Summary

When a dispatched executor's conversation compacts, Harnu hands it back a **mission brief**: the
mission and step it builds, the step's acceptance criteria from its card, the open blockers, the
step's recent Log notes and the files changed on its branch, at most 6 000 characters, framed as
context written by Harnu.

1. **Delta.** T389 P4W5 (specified, not shipped) already re-injects two _durable rows_ after a
   compaction, through the `session.compact` result: the orchestrator contract and a **pointer**
   to the mission a session _owns_. T451 adds a third row, `harnu.brief`, with **content**, for a
   session _linked to a step as a child_. It reuses P4W5's paths and adds no hook registration
   (§4).
2. **Mechanism.** The `session.compact` result's `messages`, P4W5's path. In runs on Claude Code
   2.1.296 all four candidate paths survived two compactions and a `--resume`; the row path is the
   one that does not reach subagents, is not pinned by an organization's `sec-default` policy, and
   does not give dispatcher-written text system-prompt authority (§5).
3. **Facts.** Harnu main builds the brief from disk (mission file, card file, `git`), never through
   MCP: an executor spawned through MCP `create_session` has no Harnu MCP, and one that has it
   (a board or manifest dispatch) cannot find its mission by owner. Mission and step are found
   by the binding's session ids (its rebound chain and the synthetic id its PTY was spawned
   under), then by the step's worktree link: T447's proposed D-A rule, implemented host-side, so
   this feature does not wait on D-A (§6).
4. **Budget and freshness.** 6 000 characters, a fixed cut order that never drops the card path.
   The brief is re-delivered with `retainOnly` (stored, nothing appended) when its mission or card
   changes, and refreshed before each compaction (a new `compact.started` event, or the host's
   own `session.compact` command). The mod reads it from an in-memory twin, so a refresh that
   lands mid-compaction is used (§8).
5. **Packaging and control.** Inside the companion plus Harnu main. A new prefs key `brief`
   (default `true`), effective only with P4W5's `context` on and P2W1's channel `active`.
   Fail-open everywhere. No new Settings → Mods chip (§9, §10). **It cannot run today:** T389
   P2W4 and P4W5, which it rides, are not shipped, and the installed CLI (2.1.296) is above the
   companion's tested ceiling (2.1.292), which caps `context` to off.
6. **Proof.** The real T451 brief, injected by the prototype, let the model quote acceptance
   criterion U-4 word for word after two manual and after two automatic compactions. The deciding
   evidence is the summaries: none held U-4's text, so the quote came from the re-injected row.
   With the brief pasted inline and no re-injection (the fair control), the model kept at best a
   paraphrase of U-4 (§5.2; RUN-5, RUN-5f, RUN-6).

## 1. Origin and scope

**Origin.** Ideas 45 and 75 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md`
in the main checkout, gitignored):

- Idea 45, "Mission-aware compaction": "On compaction, the mod injects the current Mission (goal,
  step, acceptance criteria, blockers) and the dispatch packet into the summary so the
  post-compaction session still knows what it was dispatched to do." Uses `session.compact`,
  `mcp.call(mission_get)`, a `$.store` cache of the boot packet.
- Idea 75, "Compaction with a conscience": a pinned "do not lose" block (task statement, decisions
  made, failing test names, files touched), plus writing the pre-compaction digest to project
  memory with provenance.

The report files both under the cluster "Compaction digest to memory (planned wave) extensions:
45, 75, 102, 121" and calls 45 an extension of P4W5 "from _write-out_ to _read-back_".

**Goals.** G1: a linked child session keeps its step and acceptance criteria across any number of
compactions, verbatim where it matters. G2: nothing new is written to disk or memory. G3: no new
cost between compactions. G4: no behaviour change for a session with no mission.

**Non-goals.** Writing anything to project memory (P4W5's recap, §4.1). Changing what the
summarizer is told (P4W5 §7.7). Owners and orchestrators (they keep P4W5's pointer and have
`mission_get`). Subagents' and forks' compactions. Mid-session notices to the model (§8.6 and
OQ7). Any mission write by the executor (an MCP-spawned one has no MCP; T447 is that surface).

## 2. Conventions

| Tag      | Source                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES`  | `claude-code.d.ts` written by Claude Code **2.1.295** (line 1) as the `plugin-authoring` skill loaded. Line numbers are that file's.               |
| `REF`    | That skill's `reference.md` (2.1.295).                                                                                                             |
| `T389/x` | `docs/specs/T389-companion-mod/<x>.md`. `master` is `00-master.md`, `contract` is `01-contract.md`, `P4W5` is `P4W5-compaction-digest.md`.         |
| `T447`   | `docs/specs/T447-harnu-sdk-noun/00-spec.md` (merged as docs in `9142876`; the noun itself is not implemented: there is no `resources/harnu-sdk/`). |
| `RUN-n`  | A live run in [`01-evidence.md`](01-evidence.md) §2: `claude -p --model haiku`, Claude Code **2.1.296**, 2026-10-09.                               |
| `MEAS-n` | A measurement on this machine in [`01-evidence.md`](01-evidence.md) §1, with its method.                                                           |
| `KIT`    | The prototype's `claude plugin test` suite ([`02-prototype.md`](02-prototype.md)), 8 tests, 2.1.296.                                               |

Repository paths are at this branch's base, `cb7fb58`. The CLI updated itself from 2.1.295 to
2.1.296 during the work: the `TYPES` citations are 2.1.295's, every run and the final
`validate`/`test` are 2.1.296's. **Verified** means read in the cited file or observed in a run;
**assumption** marks anything inferred, and each one is listed in §15 with what settles it.

## 3. The problem, measured

- **Compactions are routine, and half are automatic.** 37 compactions in 27 transcripts over about
  30 days: 19 `auto`, 18 `manual`; 7 sessions compacted two or three times. 27 of the 194 main
  transcripts with at least 1 000 rows compacted. 8 of the 27 were dispatched sessions (MEAS-1).
- **The summary drops acceptance criteria that live in a card.** In the three dispatched sessions
  whose packet pointed at a card file, the summary kept 2 of 7, 2 of 10 and 2 of 10 of the card's
  AC ids, and in one of them the card's path too. Where the packet held the criteria inline
  (3 sessions, 4 ids each), all 4 survived (MEAS-2). T451's own packet is of the first kind.
- **The model then does not know them.** With T451's brief pasted inline as a user message and two
  compactions with no re-injection, the model answered UNKNOWN to "which step", "quote U-4" and
  "which file holds the card" in RUN-5f (the second summary had shrunk to 1 062 characters). In
  the verifier's run of the same shape it kept the step and a paraphrase of U-4, not its words.

## 4. Delta against T389 and T447 (U-1, C-2)

### 4.1 What P4W5 covers, and its status

P4W5 is "Specified, not implemented" (`P4W5:5`). It specifies two things (`P4W5:35-44`):

1. **Digest (write-out).** The mod reports `compact.done` with token counts, usage and, with the
   `recap` key on (default `false`), the summary text; the host classifies it and appends a
   bounded "Compaction recap" to the session's digest page in project memory (`P4W5:242-272`).
2. **Re-injection (read-back of Harnu's own rows).** Context rows Harnu appended mid-session are
   kept in `$.state` (`durableRows`) and handed back through the compaction result's `messages`,
   or appended 1 500 ms after a compaction the hook did not see (`P4W5:110-177`). Two documents
   exist: `harnu.orchestrator` (P2W4's contract) and `harnu.mission`, whose text is a fixed
   pointer, "You own the Harnu mission <id> … read it with mission_get" (`P4W5:198-206`). Its
   OQ6 asks "Should the mission row carry the current step?" and defaults to "pointer only"
   (`P4W5:567`).

**Shipped today** (`resources/companion/`): the P1 sensor, P2W1's command channel (commands
`flush`, `config.update`, `turn.abort`, `session.compact`, `ui.toast`, `ui.status`,
`register.ts:1012-1028`), P4W1's mods audit (`src/main/mods-audit-core.ts`) and P4W3's external
profile (`src/main/companion/external-*.ts`). **Not shipped:** P2W4 (no `context-registry.ts` or
`context-injector.ts` under `src/main/companion/`; `context.append` reaches the mod's `default:`
branch and answers `CMD_UNSUPPORTED`, `register.ts:1026-1027`) and P4W5 (no `session.compact`
hook: the registrations are `register.ts:1141-1378`, none on `session.compact`). The wire types
for both are already merged into `resources/companion/hooks/contract.ts` (`ContextKey` `:27`,
`compact.done` `:357`, `context.append` / `context.drop` `:413-414`).

### 4.2 Wave by wave

| Wave / spec                                | Relation                  | What T451 takes or changes                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1W3 handshake, binding, `session.rebound` | builds on (shipped)       | the bound `sid` and the rebound chain `{ prevSid, sid, cause }` (`contract.ts:281`) identify the session (§6.1)                                                                                                                           |
| P1W4 prefs, kill switch, ceiling           | builds on (shipped)       | one new prefs key, `brief` (§10); the ceiling caps it like `context`                                                                                                                                                                      |
| P2W1 command channel                       | builds on (shipped)       | delivery rides `context.append`, a non-observe command: it needs `channel: active` (`contract:1037`)                                                                                                                                      |
| P2W4 context registry and injector         | **extends** (not shipped) | a third `ContextKey`, `harnu.brief`, built by a new builder instead of the registry's fixed templates; `deliver(sid, key, …)` unchanged                                                                                                   |
| P4W5 compaction digest                     | **extends** (not shipped) | rides its re-injection paths unchanged; adds one step to its `session.compact` body (emit `compact.started`, §8.3); widens its notifier from ownership to every mission write (§8.3); answers its OQ6 for children (§4.3)                 |
| P4W5 recap to memory                       | untouched                 | T451 writes nothing to memory; idea 75's "digest to project memory" half is P4W5's recap and is not repeated here                                                                                                                         |
| P4W4 resume micro-plan                     | untouched                 | a different row and trigger (`act.plan`); no shared key                                                                                                                                                                                   |
| P4W2 band and `/harnu-link`                | untouched                 | the brief is model-facing; nothing is drawn (T454's step rail is the visible twin)                                                                                                                                                        |
| P4W3 external profile                      | constrains                | a tokenless binding's `sid` is uncorroborated: no brief (§9.3)                                                                                                                                                                            |
| T447 `$.harnu` noun                        | adjacent                  | proposed, not implemented; unusable for MCP-spawned executors (`inside-no-mcp`, `T447:469`), and a board-dispatched one that has MCP still has no child lookup. Its D-A matcher is implemented host-side by T451 and can be shared (§6.2) |
| T216 per-AC state                          | adjacent                  | design only (`docs/specs/T216-S1-ac-schema-and-verbs.md:3`); cards' criteria are free markdown, so T451 parses them (§6.3)                                                                                                                |

### 4.3 What T451 adds, exactly

1. **The `harnu.brief` document**: who gets one (§6.6), its template and framing (§7), its budget
   (§8.1). P4W5's `harnu.mission` pointer stays for owners; T451 is P4W5's OQ6 answered "for a
   linked child, yes, and more than the step".
2. **The host builder** `src/main/companion/mission-brief-core.ts` (pure) and its shell
   `mission-brief.ts`: resolve the session's mission step, read the card, build, sanitise, cap,
   deliver.
3. **Freshness**: a `missionChanged(missionId)` notifier after every mission write, a card-change
   hook, the `compact.started` sensor event, a rebuild before the host's own `session.compact`
   command, and an in-memory twin of the durable rows in the mod (§8.3).
4. **A synthetic-id alias table** in the host, so a card bound to `synthetic-<uuid>` at dispatch is
   found from the binding's real session id (§6.1).
5. **A marker filter in Harnu's transcript reader**, so the brief never shows as the session's
   "what's happening now" (§8.5).
6. **A scoped exception to SEC-5a / R29** for this one key, and the matching amendment to P4W5
   §9.4 (§11, §12, ADR-draft).

### 4.4 What T451 does not duplicate

The `session.compact` registration, its pass-through rules, the marker check, the deferred append
and its delay, the classic `PostCompact` fallback, `compact.done`, the `durableRows` key, the
re-issue rules on hello, rebound and resume, `context.append`/`context.drop` and the hash-idempotent
`deliver` are all P4W5's or P2W4's and are used as specified there. If P4W5 changes one of them,
the brief follows with no change here.

## 5. Injection mechanism (U-2)

### 5.1 The candidates, from the engine

| Path                     | What the engine says                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.compact` result | "Rewrite `instructions` or `messages` on the way down, the messages on the way up, or answer `{ messages }` of your own" (TYPES:4372-4383). The result's `messages` is "What the transcript becomes … one without [a `handle`] is built from its `role`, `text` and tool blocks" (TYPES:10761-10763). A `precompute` "installs nothing" (TYPES:10853). |
| `prompt.compose`         | "Append (as `session`), replace, reorder or drop" sections of the system prompt (TYPES:4176-4184); a section added at the end is `session` scope, after the cache boundary (TYPES:8369-8373, :8401).                                                                                                                                                   |
| `prompt.context`         | Fires "once per conversation, when the engine computes the context blocks its first user message carries … until `$.ui.invalidate("prompt.context")` or a re-read (compaction, `/clear`)" (TYPES:4164-4175).                                                                                                                                           |
| `$.session.append`       | "REALLY appends: a user-role row the person does not see as typed (`type: "user"`, stored `isMeta`, the model reads it) … under `origin: { kind: 'plugin', name }`" (REF:145); an append inside the `session.compact` hook lands before the boundary and is dropped (`P4W5:54`), so it is made 1 500 ms later (`P4W5:55`).                             |

### 5.2 What the runs showed

The probe stamped each path with the number of compactions the process had seen (RUN-1..4); the
prototype then carried T451's real 3 581-character brief through the chosen path (RUN-5, RUN-6).

| Criterion                                                                       | `prompt.compose`                                                                                | `prompt.context`                                                       | `session.compact` `messages`                                                                                                                    | deferred `$.session.append`                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Survives compaction 1 and 2, one process                                        | yes, re-rendered each time (RUN-1)                                                              | yes, re-rendered each time (RUN-1)                                     | yes (RUN-1, RUN-5 manual, RUN-6 auto)                                                                                                           | yes (RUN-1)                                                                                   |
| Survives `--resume` in a new process                                            | yes, **frozen**: replayed from a stored `prompt_snapshot` row, even with the mod absent (RUN-3) | yes, **frozen**: replayed from a stored `context_sections` row (RUN-3) | yes: a stored row (RUN-3)                                                                                                                       | yes: a stored row (RUN-3)                                                                     |
| In the first request after the compaction                                       | yes                                                                                             | yes                                                                    | yes                                                                                                                                             | no: lands 1 500 ms later, at the loop's next top (argued from REF:145 and `P4W5:55`, not run) |
| Refresh between compactions                                                     | no: snapshotted until compaction (T389 smoke C3, `P2W4-live-contract-and-guard.md:60`)          | no: invalidation re-ran the hook, nothing new was sent (RUN-1)         | not needed                                                                                                                                      | possible, cache-safe (smoke C3, `P2W4…:61`)                                                   |
| Reaches Agent-tool subagents                                                    | no (RUN-4)                                                                                      | **yes** (RUN-4)                                                        | no                                                                                                                                              | no                                                                                            |
| How the model reads it                                                          | system prompt                                                                                   | a `# <name>` system-reminder block in the first user turn              | a user message, stored with no `isMeta` and no `origin` (RUN-3)                                                                                 | a user message, `isMeta`, `origin: plugin` (RUN-3)                                            |
| Under an org `sec-default` policy (argued from `contract:944-947`, not run; A6) | pinned against the user tier                                                                    | pinned (same)                                                          | works (`session.*` passes, same lines)                                                                                                          | works                                                                                         |
| Cache cost                                                                      | none beyond its size: the session side is rewritten at every compaction anyway (MEAS-6)         | same                                                                   | same: +1 650 and +2 337 tokens written on the first post-compaction turn, summaries included, the compaction call's own spend excluded (MEAS-6) | same, plus a tail write                                                                       |
| Composes with P4W5                                                              | a new registration                                                                              | a new registration                                                     | the same body (`contract:1006`)                                                                                                                 | P4W5's `appendDurable`                                                                        |
| Settings → Mods chip it adds to the companion                                   | `system-prompt` (`mods-audit-core.ts:380`)                                                      | `system-prompt` (same)                                                 | none                                                                                                                                            | none                                                                                          |

The deciding evidence is the summary grep. RUN-5 and RUN-6 asked for the first twelve words of
U-4 after two manual and two `auto` compactions; both answered "Size and staleness: a hard budget
for the reinjected block, what gets", and none of the four summaries held U-4's text, so the words
came from the re-injected row. The controls only bound the alternative. RUN-5c (no delivery at
all) answering UNKNOWN proves nothing. The fair control pastes the same brief inline as a user
message and compacts twice with no re-injection: RUN-5f answered UNKNOWN to all three questions;
the verifier's run of that shape (round 1, `vD`) kept the step and a paraphrase of U-4 ("Size and
staleness. Set a hard budget for the reinject…"), not its words. Summaries are not stable enough to
carry criteria verbatim; the row is.

### 5.3 Decision

**The `session.compact` result's `messages`**, through P4W5's paths: in-hook for a compaction the
hook sees, P4W5's deferred append for the session's own `session.compact` command and the classic
fallback (`P4W5:144-177`). The reasons, in order of weight:

1. It is the only path of the four that is in the first request after a compaction, refreshable at
   the next one, invisible to subagents and not pinned by `sec-default`.
2. It gives the brief the authority the dispatch packet had: a user message. `prompt.compose` would
   promote dispatcher-written text into the system prompt; `prompt.context` would hand it to every
   subagent (RUN-4) at about 900 tokens each.
3. It is already the companion's path (P4W5), so the feature adds a document, not a mechanism, and
   no capability chip.

The two prompt paths freeze their text until the next compaction, even across a resume (RUN-3):
that rules them out for anything that must change, and makes them a poor home for a brief whose
mission moves under it.

### 5.4 Findings for P4W5 (recorded here, owned there)

- **Hook results survive `--resume` on 2.1.296.** Rows added through `messages` are ordinary stored
  rows (RUN-3). P4W5 assumes the opposite from upstream #95328/#96485 (`P4W5:63`, OQ3) and adds a
  `spawn` re-issue rule for it; AC-P4W5-19 should find the rule unnecessary on this version.
- **An `auto` compaction dispatches the hook** with the same result shape (RUN-6, two boundaries
  `trigger: 'auto'`; debug: "session.compact (auto): a hook's 4 messages stand"). This answers
  P4W5 OQ1 for a compaction at prompt submission; a compaction inside a running tool loop is
  still unobserved (§15 A2).
- **The `messages` row is stored with no `isMeta` and no `origin`** (RUN-3), unlike an appended row.
  Whether the terminal then shows it as a prompt the operator typed is unobserved (OQ6).
- **The engine writes a `last-prompt` row holding the re-injected text** after each compaction
  (RUN-5 and RUN-6 transcripts: `last-prompt` = "[Harnu mission brief rev 1 · …" right after each
  boundary). Harnu's transcript reader takes the latest `last-prompt` as the session's "what's
  happening now" (`src/main/transcript-truth.ts:238-240`, `src/main/claude-reader.ts:156`, `:824`),
  so any P4W5 row re-injected this way would become the sidebar's subtitle. §8.5 filters it.
- **A `$.state` read inside the `session.compact` dispatch is one moment** (TYPES:3389-3390): once
  the body has read `$.state` (P4W5's `ensureHello` does, `register.ts:480-503`), a row delivered
  while the summarizer runs is invisible to a later read in that dispatch. KIT reproduced it (no
  twin: 7 pass, 1 fail). P4W5's rows need the same in-memory twin (§6.5).
- **A built-in plugin hooks the same events.** `cc-plugin-agents-md@builtin` hooks
  `session.compact` and `prompt.context`; both chains composed (RUN-6 debug lines).
- **No `precompute` dispatch** appeared in any run's debug file (RUN-1, RUN-5, RUN-6).

## 6. Where the facts come from (U-3)

### 6.1 Identity

The session is the companion's binding, and its **ids** are every name Harnu's records may use for
it:

1. its bound `sid` ("the id the host has for this binding",
   `resources/companion/types/index.d.ts:10`), the transcript uuid;
2. every earlier `sid` it re-keyed from through `session.rebound { prevSid, sid, cause }`
   (`contract.ts:281`). T451 has the host keep that chain per binding (`chain: Sid[]`, newest
   first, capped at `SID_CHAIN_MAX` 8; new in slice S2);
3. the **synthetic id its PTY was spawned under**. A board or manifest dispatch creates the session
   as `synthetic-<uuid>` (`dispatchCardSession`, `src/renderer/src/stores/sessions.ts:3117`) and
   binds the card to that id (`bindSessionCore`, `src/main/roadmap-ipc.ts:1385`; the card's
   `session` field, `roadmap-core.ts:234`). Nothing rewrites the field when the session
   materializes: 44 of the 53 cards with a filled `session:` hold a synthetic id (MEAS-7). The
   companion binding knows its PTY's current key (`BindingView.sessionKey`,
   `src/main/companion/session-table.ts:80`, resolved through the PTY index, `src/main/pty.ts:541-545`),
   which is the synthetic id until the renderer's `pty:rekey(synthetic, real)` moves it
   (`pty.ts:1140-1143`; `PtySessionIndex.rekey` keeps no history, `pty-session-index.ts:54-60`).
   T451 records each re-key in a host **alias table** `syntheticId → realId` at that IPC, persisted
   to `<userData>/companion/session-aliases.json` (a Harnu restart re-spawns the session as a plain
   `--resume` of the real id), capped at 2 000 entries and 30 days.

Nothing the model or another plugin says names the session: a brief is built only for a binding
the host minted a spawn token for (§9.3).

### 6.2 Mission and step: no MCP, no D-A dependency

T447 found that `mission_get` looks a mission up by `missionId` or `ownerSessionId` only
(`src/main/mcp/tool-catalog.ts:1384`, the refine at `:1402-1403`), so a linked child finds
nothing by owner (`T447:404-421`), and proposed D-A, `mission_get({ childSessionId })`, matching
"by binding first … by worktree second" (`T447:425-431`). T451 does not call `mission_get` at all.
An executor spawned through MCP `create_session` has no Harnu MCP at all
(`src/main/pty.ts:811-818`; the flag is set at `src/renderer/src/stores/sessions.ts:3231`). A board
or manifest dispatch keeps it (`dispatchCardSession` sets no `agentControlled`,
`sessions.ts:3108-3141`), but it still cannot find its mission by owner, and a pointer would only
help if the model chose to follow it after a compaction. So the brief is built in Harnu main, which
reads missions straight from disk, as hibernation already does ("Missions are read straight from
disk with S1's `parseMissionFile` (no `mission_*` verb …)", `src/main/hibernation.ts:141`).

The resolver is one pure function, which D-A can call when it lands:

```ts
/** T451 §6.2. Pure: the shell reads the missions of the session's repo (main checkout). */
export function resolveChildStep(
  missions: readonly { mission: Mission; log: string }[],
  who: { ids: readonly string[]; cwd: string } // ids: the binding's ids of §6.1, newest first
): { mission: Mission; step: MissionStep; log: string; by: 'session' | 'worktree' } | null
```

1. Candidates: missions whose status is `active`, `stale` or `delivered` (a legacy `draft` reads as
   `active`, `src/main/mission-core.ts:115-121`); never `closed`.
2. **By session**: a `custom` step with a `{ kind: 'session', ref }` link whose `ref` is in `ids`.
3. **By worktree**, only if step 2 found nothing: a `custom` step with a `{ kind: 'worktree', ref }`
   link whose resolved path equals the session's `cwd` or contains it (one worktree per card is the
   dispatch convention).
4. Several matches: the newest `updatedAt` wins; the brief's header says "(also linked to N other
   steps)" so the model knows to ask. A session that **owns** a mission and is also a child of
   another gets the child's brief only.

The repo is the session `cwd`'s main checkout, the root `missionRoot` resolves for the verbs
(`src/main/mcp/tool-handlers.ts:2524`); the reader is `readAllMissions` (`:3895`).

T451's own record is the worked example: mission `mnt-f92b3961`, step `stp-3`, links
`{ session: <this executor's uuid> }`, `{ worktree: <its worktree> }` and
`{ card: T451-spec-mission-aware-compaction-the-mission-and-its-acs-survive }`. Resolution is by
session.

### 6.3 Acceptance criteria

Sources, first that yields wins:

1. The step's `card` link: `.harnu/memory/roadmap/<ref>.md` in the main checkout.
2. A card whose `session` field (`src/main/roadmap-core.ts:234`, stamped at board dispatch) is one
   of the binding's ids (§6.1), the synthetic one included: a board-dispatched session with no
   mission still gets a brief, card part only. Without item 3 of §6.1 this source would match 9 of
   the 53 bound cards on this machine (the ones holding a real uuid, MEAS-7).
3. The mission's own card, `Mission.linkedCard` (`src/main/mission-core.ts:116`), when the session
   resolved to a mission step whose links name no card. It is the whole mission's card, not the
   step's, and the brief says so: "Criteria of the mission's card (not your step's own)". 10 of the
   17 missions here carry one (MEAS-7).
4. None: the brief says "Acceptance criteria: none on record; the card or your dispatch prompt
   holds them".

Extraction: list items (`- `, `* `, `1. `, checkboxes stripped) under every heading of level 2+
that matches `/^#{2,}\s+(?:[\w-]+\s+)?acceptance criteria\b/im`, each up to the next `## `. The
board's readiness lint (`ACCEPTANCE_HEADING_RE`, `roadmap-core.ts:1276`) matches only
`## Acceptance criteria` and would miss T451's own card ("Unit acceptance criteria", "Common
acceptance criteria"); the wider pattern finds 259 of 578 cards (MEAS-3).

The dispatch prompt itself is **not** a source: Harnu passes it in argv and keeps no copy
(`buildBootPrompt`, `roadmap-core.ts:1500`, returns the string to the spawn site), and the mod must
not derive a row from the conversation (`P4W5:337-340`). OQ3 asks whether to persist it.

### 6.4 The other facts

| Fact                                         | Source                                                                                                                                                  | In v1        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| mission id, status, declared end target      | the mission record (`mission-core.ts:111-157`)                                                                                                          | yes          |
| step id, ordinal, title, verification, proof | the step (`mission-core.ts:76-95`)                                                                                                                      | yes          |
| open blockers                                | mission-level plus the step's own (`mission-core.ts:41-46`)                                                                                             | yes          |
| decisions made                               | the step's Log entries, headings `### <ts> · <stepId>` (223 such headings across the 17 missions here); the newest 3                                    | yes (OQ2)    |
| files touched                                | `git diff --name-only <origin default>...HEAD` plus `git status --porcelain` in the step's worktree, at build time                                      | yes          |
| failing test names                           | no structured source: the companion may not hook `tool.call` on Bash (T389 MOD-3, `master:524`), and parsing transcripts is the regex path T389 retires | **no** (OQ4) |
| the dispatch packet                          | not kept (§6.3)                                                                                                                                         | **no** (OQ3) |

### 6.5 What the mod holds, and what is re-read

- **The mod holds** the framed brief text in `durableRows.rows['harnu.brief']` (`contract:1337`),
  because its hook may await nothing but `next(e)` (`P4W5:123`, MOD-6), **and in an in-memory twin**
  of `durableRows` that the `context.append` handler writes beside `$.state`. The body reads the
  twin after `next(e)`, never `$.state`: every `$.state.get` of one dispatch reads one moment
  (TYPES:3389-3390), and P4W5's body reads state before `next(e)` (`ensureHello` → `doHello`,
  `register.ts:480-503`), so a delivery that lands while the summarizer runs would be invisible to
  a later `$.state` read in the same dispatch (KIT mutation, 02-prototype §4). `$.state` is read
  once per load, to fill the twin after a hot reload, the same pattern the companion already uses
  for `channel` (`register.ts:135`). This keeps P4W5's body as it is (state reads before `next(e)`
  stay allowed) and is a change to P2W4's durable store that P4W5's own rows need too. It
  holds no revision. Commands are numbered and delivered at least once against a cursor
  (`contract:375-385`), so the host keeps at most one `harnu.brief` delivery in flight per binding:
  a newer brief replaces a queued, unstarted one before it is enqueued, and the last delivery
  wins. The prototype's `rev` check models this ordering in the mod, where the kit has no channel. `$.state` survives a hot reload; whether it survives a process restart is T389
  CQ3, and P4W5's resume-hello rule re-primes it either way (`P4W5:222-226`).
- **The host re-reads** the mission file, the card file and `git` on every build. It caches
  nothing but the last delivered hash per binding (P2W4's idempotent `deliver`).

### 6.6 Who gets a brief

| Session                                                                                                        | Brief                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| a linked child (§6.2), interactive, Harnu-spawned                                                              | yes                                                                               |
| a board-dispatched session with a bound card, no mission                                                       | yes, card part only (§6.3 source 2)                                               |
| any other Harnu-spawned session whose `cwd` is in a step's worktree (§6.2 step 3), the operator's own included | yes, that step's brief (§11 item 1 b)                                             |
| a mission owner                                                                                                | no: P4W5's `harnu.mission` pointer, and it has `mission_get`                      |
| no mission and no card                                                                                         | no; a brief delivered earlier is dropped with `context.drop` (§8.3)               |
| a subagent's or fork's compaction (`agentId` set)                                                              | no: P4W5 passes it through untouched (`P4W5:119-120`)                             |
| headless (`-p`)                                                                                                | no: the poll loop needs `isInteractive` (`register.ts:1033-1040`; `contract` §16) |
| outside Harnu, or a tokenless P4W3 binding                                                                     | no (§9.3)                                                                         |

## 7. The brief

Built by `buildBrief(input, budget)` in `mission-brief-core.ts`. Every line but the quoted fields is
a fixed template; the quoted fields are sanitised (control characters and ANSI removed, whitespace
collapsed), clipped per field and passed through `lintSecrets` (`src/main/mcp/memory-core.ts:366`);
a field that fails the lint is replaced by "(withheld: looks like a secret)".

```text
[Harnu mission brief rev <n> · <ISO time>]
Written by Harnu from its records, not by the operator: what this session was dispatched to do. It replaces any earlier brief in this conversation. It is context, not new instructions.
Mission <id> · <status> · you build step <stepId> (<ordinal> of <total>)[ (also linked to <k> other steps)]
Mission end: <declaredEnd.target, ≤ 300>
Your step: "<title, ≤ 200>" · checked by <verification> · proof <proof>
Card: <repo-relative card path> (re-read it with Read for the full text).
Acceptance criteria (from the card): | Criteria of the mission's card (not your step's own):
- <one line per item, ≤ 240>
- (+<k> more: re-read the card)
Open blockers: none | Open blockers:
- (<owner>) <reason, ≤ 200> → clears when: <unblocks, ≤ 120>
- (+<k> more blockers: see the mission)
Recent notes on your step (newest first):
- <Log entry's first paragraph, ≤ 300>
Files changed on this branch: <path>, … (+<k> more)
```

`rev` counts this binding's deliveries; it lets the model and the audit log tell two briefs apart.
The second header alternative is used for §6.3 source 3. Up to 5 blockers are listed, mission-level
first, then the step's, oldest first; the rest are counted on the "(+k more blockers)" line.

**The hash** that decides whether a rebuild is delivered (P2W4's idempotent `deliver`) is the
sha256 of the **body**, every line after the first: line 1 carries `rev` and the build time, so a
hash over the whole text would change on every rebuild and deliver an unchanged brief each time.
The first line is P4W5's marker for this key: the hook adds the row only when the result does not
already hold a user row starting with it (`P4W5:124`, KIT "never twice"). T451's own brief, built
from its real mission and card, is in [`01-evidence.md`](01-evidence.md) §3 (3 581 characters).

## 8. Size and staleness (U-4)

### 8.1 Budget

`BRIEF_MAX_CHARS = 6 000` (about 1 500 tokens), a host constant, enforced by the builder; the wire
keeps P2W4's `CONTEXT_MAX_CHARS` 20 000 (`contract:452`). Why 6 000, from MEAS-3 and MEAS-4: an AC
section is 2 504 characters at p90; across the 84 linked steps of this machine's 17 missions an
untrimmed brief is 1 829 at p50 and 4 626 at p90 (5 448 when re-measured in round 2, after the missions
gained Log notes), and at 6 000 only 5 needed trimming, none of them losing an AC line. The real summaries it rides beside were 17 600 to 42 025 characters (MEAS-2),
so the brief is a fraction of one.

### 8.2 What is cut first

Never cut: the header, the mission and step lines, the card path, and the blocker lines (at most 5
listed, each clipped, then a "(+k more blockers: see the mission)" line, §7). Then, until the text
fits:

1. file names, one at a time, from the end ("(+k more)");
2. Log notes, oldest first;
3. AC line width, 240 down to 120 characters in steps of 20;
4. AC lines, from the end, with "(+k more: re-read the card)".

The card path is the reason every cut is safe: the session keeps the way back to the full text.

### 8.3 Freshness

The model sees the brief only right after a compaction, so it must be fresh **at that moment**.
Between compactions nothing it can see changes (G3).

| Trigger                                                                                                                                                                       | Host action                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| binding hello (spawn or resume), or `session.rebound`                                                                                                                         | resolve, build, `deliver(sid, 'harnu.brief', text)` as `context.append { durable: true, retainOnly: true }`                                                                                                                                          |
| `missionChanged(missionId)`: after every successful mission write, by a verb handler or `runOperatorDoor` (`src/main/mission-ipc.ts:300`)                                     | rebuild for every live binding resolved to that mission; deliver if the hash changed. This widens P4W5's `missionOwnershipChanged` (`P4W5:208-214`) to every write: a new blocker, a re-scope approved, a step verified, a Log note                  |
| the linked card's file changes (the board watcher's card event)                                                                                                               | rebuild for the bindings whose brief names that card                                                                                                                                                                                                 |
| **`compact.started`** (new mod event, §12)                                                                                                                                    | rebuild, re-reading `git` for the files list, and deliver                                                                                                                                                                                            |
| the host is about to enqueue a `session.compact` command for the binding (P2W1). The mod's own hook does not run for it (`P4W5:146`, smoke D5), so no `compact.started` comes | rebuild and enqueue the `context.append` **before** the `session.compact` command; commands start in `n` order (`contract:375-385`), and P4W5's deferred `appendDurable` for this path reads the twin 1 500 ms after the compaction (`P4W5:152-158`) |
| the session no longer resolves (mission closed, link removed, card unbound)                                                                                                   | `context.drop { key: 'harnu.brief' }`                                                                                                                                                                                                                |

`compact.started` is emitted, un-awaited, by a step added before `next(e)` in P4W5's body, for a
main-loop compaction that is not `precompute`. The host then has the whole compaction to answer: 8
to 12 s measured, 14 to 37 s in T389 smoke C2 (MEAS-5). The delivery's handler writes the mod's
in-memory twin (§6.5), and the body reads the twin, not `$.state`, after `next(e)` resolves. That
is what makes a mid-compaction delivery usable: `$.state` reads inside one dispatch are pinned to
one moment (TYPES:3389-3390), and P4W5's body reads `$.state` before `next(e)`. KIT shows both
halves: with a `$.state` read before `next(e)` and the twin, the refreshed brief is handed back
(8 pass); the same suite with the twin removed fails that test, receiving the older brief (7 pass,
1 fail), which is the verifier's round-1 finding reproduced (02-prototype §4; live: §15 A1). If the
delivery lands after the summary, that compaction uses the previous one: staleness is bounded to
one compaction and to whatever changed in its last seconds. A compaction whose hook does not run
(P4W5's classic fallback, `P4W5:166-177`) sends no `compact.started` and uses the last delivery.

The examples U-4 names:

- **A new blocker** on the step or the mission → `missionChanged` → the next compaction shows it.
- **A re-scope**: staged by `mission_set_end`, it changes nothing until the operator approves it;
  the approval writes the mission → `missionChanged` → the next brief has the new declared end.
- **A step verified**: `mission_verify_step` writes `proof` → the next brief says `proof verified`.

### 8.4 Stale copies in later summaries

A brief row is a transcript row, so the next summary may paraphrase it. In RUN-2 and RUN-5 no
summary copied a sentinel or U-4's text, but a summary may keep an old status ("proof unproven").
The fresh brief is the last user row after the summary and says it "replaces any earlier brief";
the card stays the source of truth.

### 8.5 Harnu's own readers must not mistake the brief for a prompt

After each compaction the engine writes a `last-prompt` row whose `lastPrompt` is the re-injected
brief (RUN-5 and RUN-6 transcripts, 01-evidence RUN-5). Harnu's transcript reader keeps the latest
`last-prompt` (`src/main/transcript-truth.ts:238-240`) and uses it, after `task-summary`, as the
session's "what's happening now" (`:257-264`; `src/main/claude-reader.ts:156`, `:404`, `:824`), the
subtitle the sidebar, the session preview and the fleet read. Without a fix the executor's row would
read "[Harnu mission brief rev 1 · …" after every compaction.

The fix, in slice S2: `transcript-truth.ts` skips a `last-prompt` entry whose text starts with
`BRIEF_MARK` (`[Harnu mission brief`, exported once from the companion's contract), keeping the
previous value. The same filter applies to P4W5's two rows through their frame marker, and to any
other reader of user rows that would take the brief for the operator's words (OQ6).

### 8.6 Not in v1: telling the model mid-session

A change that should alter what the executor does now (its step verified `unmet`, the mission
closed, a re-scope approved) could be one short appended row, which is cache-safe (smoke C3). That
is a notice, not compaction survival; it overlaps T452 (verification gate) and T454 (step rail),
and is OQ7.

## 9. Packaging (C-3)

### 9.1 Where it lives

| Part                              | Home                                                                                                                                   | Why                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brief builder, resolver, notifier | **Harnu main**: `src/main/companion/mission-brief-core.ts` (pure), `mission-brief.ts` (shell), a change to P4W5's `mission-context.ts` | the records are on Harnu's disk; an MCP-spawned executor has no MCP to fetch them, and no executor can look itself up as a child; one pure resolver can also serve T447's D-A                                       |
| re-injection                      | **the companion**, `resources/companion/`: one more `ContextKey`, one step in P4W5's `session.compact` body                            | only the companion holds the binding, the lease and the command channel; P4W5 owns the single `session.compact` registration (MOD-4, `master:525`); the companion may not call `$.mcp.call` (SEC-9 b, `master:502`) |
| not a new mod                     | —                                                                                                                                      | a second plugin on `session.compact` would duplicate P4W5's paths, marker and fallbacks, and would need the brief from somewhere: it has no binding                                                                 |
| not T447's noun                   | —                                                                                                                                      | not implemented; `inside-no-mcp` in MCP-spawned executors (`T447:469`), and needing D-A in a board-dispatched one                                                                                                   |

### 9.2 What the companion change is

The `ContextKey` union gains `'harnu.brief'` (`contract.ts:27`; `contract:150`); `DURABLE_MAX_ROWS`
(4, `contract:455`) holds the three keys. The `session.compact` body gains step 1b, "brief:
`emit($, { t: 'compact.started', d: { trigger } })`, un-awaited". The `durableRows` path does the
rest: the mod does not know what a brief says.

The prototype in [`02-prototype.md`](02-prototype.md) is this mod half, standalone: deliveries in
`$.state` and an in-memory twin, a `$.state` read before `next(e)` standing in for P4W5's
`ensureHello`, the brief added after the summary, never twice, untouched for `precompute` and
subagents, fail-open.

### 9.3 Outside Harnu

- **A session started outside Harnu with P4W3's switch on**: its binding is tokenless and its `sid`
  is not verified against a spawn (`T389/P4W3-companion-outside-harnu.md`, external profile,
  `contract` §21); the host builds no brief for it, so text from Harnu's records never reaches a
  process Harnu did not start.
- **Harnu not running, or the companion not loaded**: the engine's own compaction, unchanged. The
  dispatch packet's card path, if the summary kept it, is the only way back.

## 10. Control, failure and audit (C-4)

**Switch.** A new prefs key in `companion-prefs.json`, registered with `registerPrefsKey('brief', …)`
(P1W4), shown as one row in the Harnu mod settings region:

| Key     | Values  | Default | Gates                                                     |
| ------- | ------- | ------- | --------------------------------------------------------- |
| `brief` | boolean | `true`  | building and delivering `harnu.brief`; needs `context` on |

It is effective only when all of these hold: `brief` on, `context` on (`contract:1039`, default
`true`), `channel` `active` (`contract:1037`, default `shadow`), the companion mode not `off`,
a live lease, and the CLI inside the tested window. Above the ceiling every key is capped, `context`
to off (`contract:1047-1049`); the installed CLI here is 2.1.296 and the tested ceiling is 2.1.292
(`resources/companion/api-surface.json`), so today the feature would be inert until the ceiling
moves (`docs/dev/companion-mod.md:95-101`). Turning `brief` off sends `context.drop` to every
binding holding one; the kill switch makes the mod inert at once (`P4W5:308`). The default is OQ1.

**Failure: fail-open everywhere.** The compaction always stands as the engine made it; at worst the
brief is missing or one compaction old.

| Where it fails                                        | What happens                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the hook throws after `next(e)`                       | P4W5's MOD-2 wrapper returns `r` unchanged (`P4W5:132-134`). In the prototype `.catch(($, e, next) => next(e))` replays `next`'s result; a mutation run without it still passed, because a failed hook is skipped (REF:78-79): the `.catch` makes the choice explicit and `validate` lists it as "gating hook with .catch" (02-prototype §4) |
| the hook throws before `next(e)`                      | the wrapper returns `next(e)` (KIT "a failure in the hook fails open"); in the mod, the existing `reportModError('compact', err)` (`register.ts:219`, `P4W5:133`) reports either arm                                                                                                                                                         |
| the builder throws, a file is unreadable, `git` fails | no delivery; the previous brief stays; one main-process log line `mission-brief: <code>` with the binding key and mission id, never text (the companion audit log holds bindings and commands only, `src/main/companion/audit-core.ts:71`); a missing `git` drops only the files line                                                        |
| the delivery fails (channel down, lease lost)         | the command waits or expires per P2W1; the next trigger re-delivers                                                                                                                                                                                                                                                                          |
| `compact.started` is lost                             | the compaction uses the last delivery                                                                                                                                                                                                                                                                                                        |

Fail-closed is never right here: the hook cannot veto or delay a compaction (`P4W5:342-343`).

**Settings → Mods chips.** None new. The chips derive from hooked events and `$` calls
(`src/main/mods-audit-core.ts:369-392`); T451 adds no hook (it shares P4W5's `session.compact`,
which maps to no chip) and no `$` call (`emit` is the existing `$.http.fetch`). Had the brief used
`prompt.compose` or `prompt.context`, the companion would gain `system-prompt` (`:380`).

## 11. Security

1. **A scoped exception to SEC-5a / R29** (ADR-draft). SEC-5a: "text a command carries comes from a
   closed registry or constant table in main unless the command's row says otherwise"
   (`master:498`); R29: text written by one session must not reach another's model through a
   context row (`master:626`). The brief carries card criteria, titles, blocker reasons and Log
   notes. It is allowed because: (a) the text comes from Harnu's records on disk, never from a
   conversation: the half of `P4W5:337-340` that bans deriving a row from the conversation, a file
   or a response stands; its "closed registry is the only source" and "no row carries
   user-controlled text" are amended for this one key (§12); (b) the recipient is one of: the
   session a mission step links (by session id, §6.2 step 2); **any Harnu-spawned session whose
   `cwd` is in that step's worktree** (§6.2 step 3), the operator's own session there included; or
   a session a card is bound to with no mission (§6.3 source 2). The text it gets is that step's,
   that mission's (`linkedCard`, §6.3 source 3) or that card's; (c) every field is sanitised,
   clipped, secret-linted, and the whole is capped; (d) it is framed as context, never
   instructions, and never placed in a system prompt; (e) only a token-backed binding receives it.
2. **Laundering** (SEC-5d): the row is user-role, as the dispatch packet was, and its first line
   names Harnu as the author. The stored row carries no `origin` (RUN-3, OQ6).
3. **Who else can read it.** "Any plugin reads any value" of `$.state` (TYPES:3381-3382): every
   plugin of the session can read the brief, as it can already read the transcript the packet is in.
4. **Audit.** Each delivery is a `context.append` command, so P2W1's command audit already records
   it with its arguments digested, "12 hex chars; never the text" (`audit-core.ts:50`, `argsDigest`
   `:112`). T451 adds `meta` (`audit-core.ts:51`): mission and step ids, `rev`, `by: session |
worktree | card | linkedCard`. Never the text (SEC-8).
5. **The worktree match** (§6.2 step 3) gives a brief to any Harnu-spawned session working in a
   step's worktree, an operator's own included; that is the same work and the same repo.

## 12. Contract additions

To merge into `T389/01-contract.md` and `resources/companion/hooks/contract.ts` with the code
(DOC-7):

| Item                    | Addition                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4 `ContextKey`         | `'harnu.orchestrator' \| 'harnu.mission' \| 'harnu.brief'`                                                                                                                                                           |
| §8 events               | `compact.started { trigger: 'manual' \| 'auto' \| 'plugin' }`: sensor, no authority, `sense.compact`; emitted before `next(e)`, never awaited                                                                        |
| §9 `context.append` row | for key `harnu.brief` only, the text is built by `buildBrief` from the records of §6, not the closed registry (SEC-5a exception, §11)                                                                                |
| §11.4 `session.compact` | step 1b after the pass-through rules: `sense.compact` → emit `compact.started`                                                                                                                                       |
| §11.5 keys              | `brief`: boolean, default `true`, gates the `harnu.brief` document, needs `context`; capped to off above the ceiling                                                                                                 |
| §22 `durableRows`       | the mod keeps an in-memory twin, written by the `context.append` / `context.drop` handler beside `$.state` and read by the `session.compact` body after `next(e)`; `$.state` is read once per load to fill it (§6.5) |
| constant `BRIEF_MARK`   | `'[Harnu mission brief'`, exported from `contract.ts`, read by the mod's marker check and by `transcript-truth.ts` (§8.5)                                                                                            |
| host constants          | `BRIEF_MAX_CHARS` 6 000; per-field clips 300 / 200 / 240 / 120 / 300; `BRIEF_FILES_MAX` 10; `BRIEF_LOG_MAX` 3; `BRIEF_BLOCKERS_MAX` 5; `SID_CHAIN_MAX` 8; alias table cap 2 000 entries, 30 days                     |

**Amendment to T389 P4W5 §9.4** (`P4W5:337-340`), to land with this spec. Today: "Durable rows are
Harnu-authored. The host's closed registry is their only source; the mod never derives a row from
the conversation, a file or a response (SEC-3d). … No row carries user-controlled text: the mission
row holds an id, never a title (SEC-5a, R29)." Amended: the `harnu.brief` row is built by
`buildBrief` from Harnu's records (mission file, card file, `git`) and carries their text, under
§11 item 1; the other rows keep the rule as written. "The mod never derives a row from the
conversation, a file or a response" is unchanged: the mod derives nothing, the host builds it.

## 13. Acceptance criteria for the implementation

```
AC-T451-1 [unit] Given the fixtures (session link, worktree link only, both, closed mission,
  two missions, owner and child at once, a sid from the rebound chain, a card bound to a
  `synthetic-<uuid>` the alias table maps to the binding's sid, a step with no card link in a
  mission with `linkedCard`), When the resolver and the criteria source chain run, Then each
  yields its expected mission, step, card and `by`.
  Evidence: tests/companion/mission-brief-core.test.ts › "resolver table"

AC-T451-2 [unit] Given cards with "## Acceptance criteria", "## Unit acceptance criteria",
  checkboxes, numbered items and none, When the criteria are extracted, Then the item lists match.
  Evidence: tests/companion/mission-brief-core.test.ts › "criteria extraction"

AC-T451-3 [unit] Given a brief input over BRIEF_MAX_CHARS, When buildBrief runs, Then the result
  fits, the cut order of §8.2 holds, the header, step, card path and blocker lines are intact,
  and 7 blockers render as 5 lines plus "(+2 more blockers: see the mission)".
  Evidence: tests/companion/mission-brief-core.test.ts › "budget and cut order"

AC-T451-4 [unit] Given a field holding an API key, ANSI codes or a 5 000-character title, When
  buildBrief runs, Then the key is withheld, the codes are gone and the field is clipped.
  Evidence: tests/companion/mission-brief-core.test.ts › "sanitise, lint, clip"

AC-T451-5 [unit] Given a live binding resolved to a mission, When a blocker is set, the end is
  re-scoped and approved, or the step is verified, Then one retainOnly delivery with a new body
  hash follows each; and When the mission is rewritten with no change to what the brief shows,
  or an unrelated mission is written, Then nothing is delivered (the hash excludes line 1).
  Evidence: tests/companion/mission-brief.test.ts › "missionChanged rebuilds"

AC-T451-6 [unit] Given the mission closes or the step link is removed, When missionChanged runs,
  Then context.drop { key: 'harnu.brief' } is queued.
  Evidence: tests/companion/mission-brief.test.ts › "drop when it no longer resolves"

AC-T451-7 [unit] Given `brief` off, or `channel` at `shadow`, When any trigger fires, Then no
  context.append for harnu.brief is queued.
  Evidence: tests/companion/mission-brief.test.ts › "gated by keys"

AC-T451-8 [mod-test] Given a durable harnu.brief row, When a manual or auto compaction resolves,
  Then the result's messages end with the row, once, and precompute or agentId pass through.
  Evidence: resources/companion/tests/compact.test.ts › "brief rides the durable rows"

AC-T451-9 [mod-test] Given a compaction, When the body runs, Then compact.started is queued before
  next(e) is called and is not awaited.
  Evidence: resources/companion/tests/compact.test.ts › "compact.started before next"

AC-T451-10 [mod-test] Given a body that reads $.state before next(e) (P4W5's ensureHello) and a
  harnu.brief delivery that lands while next(e) is pending, When the hook returns, Then the
  returned row is the new one; and the same suite with the in-memory twin removed fails this test
  (the fixture of 02-prototype §4).
  Evidence: resources/companion/tests/compact.test.ts › "refresh during the summary"

AC-T451-11 [unit] Given a delivery, When the audit log is read, Then its command record holds the
  args digest and the meta of §11 item 4, and no text of the brief.
  Evidence: tests/companion/mission-brief.test.ts › "audit without text"

AC-T451-15 [unit] Given a pty:rekey from a synthetic id to a real one, then a host restart, When a
  binding with that real sid is resolved, Then a card whose session field is the synthetic id is
  found through the persisted alias table.
  Evidence: tests/companion/mission-brief.test.ts › "synthetic card binding"

AC-T451-16 [unit] Given a transcript tail whose latest last-prompt starts with BRIEF_MARK, When
  the transcript truth is derived, Then lastPrompt is the previous last-prompt and
  pickWhatsHappening never returns the brief.
  Evidence: tests/transcript-truth.test.ts › "a re-injected brief is not the last prompt"

AC-T451-17 [unit] Given a binding with a brief, When the host enqueues session.compact for it, Then
  a context.append for harnu.brief with a fresh build is enqueued first.
  Evidence: tests/companion/mission-brief.test.ts › "rebuild before an own compaction"

AC-T451-12 [live-verify] Given a Harnu-dispatched executor linked to a step, with channel active,
  When it compacts manually, then automatically during a tool loop, Then after each it quotes an
  acceptance criterion only its card holds, and the debug file shows the companion's hook.
  Evidence: LV-T451-a

AC-T451-13 [live-verify] Given that executor, When the orchestrator sets a blocker on its step and
  the executor then compacts, Then the next brief lists the blocker.
  Evidence: LV-T451-a step 4

AC-T451-14 [live-verify] Given the same, When the executor's terminal and Harnu's sidebar row,
  session preview and fleet entry are looked at after the compaction, Then how the brief row is
  displayed is recorded, and no Harnu surface shows it as the session's latest prompt (OQ6).
  Evidence: LV-T451-a step 5
```

**LV-T451-a** (second isolated Harnu, `channel` and `context` active, `brief` on): (1) create a
mission with one step and dispatch an executor into a worktree for a card with six criteria;
(2) `/compact`, then ask the executor to quote criterion 4 and name its step; (3) drive it past
the compaction window during a long tool loop (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) and ask again;
(4) `mission_set_blocker` from the orchestrator, `/compact`, ask for its blockers; (5) screenshot
the terminal, the sidebar row and the session preview after a compaction; (6) grep the app log and `<userData>/companion/` for a criterion's
text: no hit.

## 14. Implementation outline (C-6)

Depends on T389 P2W4 (registry, injector, `context.append`, `durableRows`) and P4W5 slice S2
(re-injection through `messages`, `retainOnly`, `context.drop`, the notifier). Nothing here can
ship before them; S1 and S2 can be built in parallel with them.

| Slice | Content                                                                                                                                                                                                                                                                                                                                                    | Size | Depends on        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------- |
| S0    | **Spike** on the CLI the ceiling names: A1–A7 of §15 in a live interactive session; evidence note in this directory                                                                                                                                                                                                                                        | S    | —                 |
| S1    | `mission-brief-core.ts`: `resolveChildStep`, `extractAcceptanceCriteria`, `buildBrief` with sanitise, lint, clip and cut order; AC-T451-1..4                                                                                                                                                                                                               | M    | —                 |
| S2    | `mission-brief.ts`: the binding ids and the persisted alias table at `pty:rekey`, triggers of §8.3 except `compact.started` (the rebuild before an own `session.compact` included), `missionChanged` over every mission write, card-change hook, drop rule, audit meta; the `brief` key; the `transcript-truth.ts` marker filter; AC-T451-5..7, 11, 15..17 | M    | S1, P2W4, P4W5 S2 |
| S3    | companion: `ContextKey`, `BRIEF_MARK`, the `durableRows` twin, step 1b and `compact.started`, `api-surface.json`, contract updates and the P4W5 §9.4 amendment; host handler for `compact.started`; AC-T451-8..10                                                                                                                                          | S    | S2, P4W5 S2       |
| S4    | the settings row; LV-T451-a; docs; AC-T451-12..14                                                                                                                                                                                                                                                                                                          | S    | S3                |

Order: S0 → S1 → S2 → S3 → S4. S1 is useful alone: T447's D-A can call `resolveChildStep`.

**Contracts the implementation owes**

- `CHANGELOG.md`: `Added`: "A dispatched session keeps its mission step and acceptance criteria
  after its conversation compacts" (S4).
- `docs/harnu-features.md` and its marker bump: agent-facing, since the session must know how to
  read the row: "After a compaction a `[Harnu mission brief …]` row may follow the summary: it is
  Harnu's record of your step, criteria and blockers, newer than the summary; the card it names is
  the full text." Also the T389 P4W5 line it extends. Follow `/harnu-awareness` (S4).
- `docs/user/`: `sessions.md` (what survives a compaction, with and without the Harnu mod) and the
  page that documents the Harnu mod's settings region (the `brief` switch) (S4).
- `design.md` and both locales (`en.json`, `pt-BR.json`): the switch's label and hint in the Harnu
  mod settings region, `harnuMod.brief.label` "Mission brief after compaction" and
  `harnuMod.brief.hint` "When a session working on a mission step compacts, give it back its step,
  acceptance criteria and open blockers." No new component (S4).
- `T389/01-contract.md` and `contract.ts`: §12 (S3).
- No new MCP verb, so no `tool-catalog.ts` change; if D-A lands, it reuses S1 and owes its own
  `harnu-features.md` update.

## 15. Assumptions an implementation spike must check first

| #   | Assumption                                                                                                                                                         | Basis so far                                                                      | Settled by                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------- |
| A1  | The companion's poll loop applies a `context.append` while a compaction runs, and the twin read after `next(e)` sees it (a `$.state` read would not: KIT mutation) | KIT last test and its mutation (the kit, not a live session); MEAS-5 gives 8–37 s | S0, AC-T451-10, -12                   |
| A2  | An `auto` compaction **inside a running tool loop** dispatches the hook and installs its `messages` before the loop's next request                                 | RUN-6 compacted at prompt submission only                                         | S0, AC-T451-12                        |
| A3  | The companion's bound `sid` is the transcript uuid an orchestrator links, and the rebound chain covers `/clear` and an in-session `/resume` (T447's A7)            | `types/index.d.ts:10`; T447:236                                                   | S0                                    |
| A4  | Rows survive `--resume`, and prompt snapshots replay, on the CLI the ceiling will name                                                                             | RUN-3, on 2.1.296 only                                                            | S0, AC-P4W5-19                        |
| A5  | An interactive session behaves as `-p` did for these paths                                                                                                         | all runs were `-p`                                                                | LV-T451-a                             |
| A6  | `sec-default` still pins `prompt.compose` and `prompt.context` and passes `session.*`                                                                              | `contract:944-947`, read from a 2.1.277 copy                                      | S0 (only matters for §5's comparison) |
| A7  | The executor's worktree path, as Harnu resolves the session's `cwd`, equals the mission's `worktree` link ref                                                      | the links are absolute paths written at dispatch (mission `mnt-f92b3961` stp-3)   | AC-T451-1, S0                         |

## 16. Open questions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Default until settled                                                                    | Who decides         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| OQ1 | `brief` default: `true` (it rides `context`, writes nothing to disk) or `false` until LV-T451-a passes?                                                                                                                                                                                                                                                                                                                                                                                                        | `true`, inert until `channel` is `active`                                                | operator            |
| OQ2 | Free-text Log notes in the brief, or only closed-vocabulary verdict lines (`verified (met) by …`)? Notes are the "decisions made"; they are also the field most open to injected text                                                                                                                                                                                                                                                                                                                          | notes, ≤ 3, ≤ 300 characters each                                                        | operator            |
| OQ3 | Persist the dispatch prompt host-side (hash-checked, per binding) so a session with no card still gets its packet back?                                                                                                                                                                                                                                                                                                                                                                                        | no                                                                                       | operator, product   |
| OQ4 | Failing test names: a later source (a companion `session.append` hook on the `tool-result` door, a host transcript scan, or P4W5 §7.7's content request)?                                                                                                                                                                                                                                                                                                                                                      | not in the brief                                                                         | product, P4W5 owner |
| OQ5 | Extend a smaller brief to mission owners, which have `mission_get` but also compact?                                                                                                                                                                                                                                                                                                                                                                                                                           | no                                                                                       | product             |
| OQ6 | A row added through `messages` is stored with no `isMeta` and no `origin` (RUN-3), and the engine then records it as the `last-prompt` (RUN-5, RUN-6). Where else does it pass for the operator's words: the terminal transcript, Harnu's sidebar subtitle, session preview and fleet `whatsHappening` (filtered by §8.5), the first-prompt and title fallbacks, a Remote Control or desktop surface? And should P4W5 prefer the deferred append, which is stored `isMeta` with a plugin origin, for all rows? | keep P4W5's path; filter Harnu's readers by marker (§8.5); record the rest in AC-T451-14 | P4W5 owner, product |
| OQ7 | A one-line mid-session notice for changes that alter the work now (step verified `unmet`, mission closed, re-scope approved)? Overlaps T452 and T454                                                                                                                                                                                                                                                                                                                                                           | none in v1                                                                               | product             |
| OQ8 | A session linked to several steps: newest mission wins plus a count, or one brief per step?                                                                                                                                                                                                                                                                                                                                                                                                                    | newest, with "(also linked to N other steps)"                                            | product             |
| OQ9 | Rewrite a card's `session` field to the real uuid when its synthetic session materializes, which would retire the alias table of §6.1?                                                                                                                                                                                                                                                                                                                                                                         | no: keep the field as dispatched; alias table                                            | product             |

## 17. Risks

| Risk                                                                           | Sev    | Mitigation                                                                                                    |
| ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| Injected text in a card or Log note steers the executor after every compaction | Medium | §11 (a)–(e); OQ2; audit per delivery                                                                          |
| The brief is stale and contradicts the operator's latest word                  | Medium | refreshed on every mission write and at `compact.started`; "context, not new instructions"; card is the truth |
| The feature never runs because P2W4/P4W5 slip or the ceiling lags the CLI      | High   | stated in §0, §10 and §14; S1 is useful alone (D-A)                                                           |
| The brief shows up as the session's activity in Harnu's own UI                 | Medium | the `last-prompt` marker filter (§8.5, AC-T451-16); OQ6                                                       |
| A later CLI changes the result shape or stops storing hook rows                | Medium | P4W5's drift checks (QA-6) cover all three rows; AC-T451-12 on each ceiling move                              |
| Wrong mission matched through a shared worktree                                | Low    | session links win over worktree links; OQ8                                                                    |
| Cost: ~1 500 tokens written once per compaction                                | Low    | measured (MEAS-6); nothing between compactions                                                                |

## 18. Acceptance criteria of this card, and where each is met

| AC  | Where                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-1 | §4 (P4W5's two halves and status, wave table, the exact delta, what is not duplicated)                                                                                                        |
| U-2 | §5 (candidates cited, comparison on survival, cache cost, size, what the model sees; decision; RUN-1..6 in 01-evidence)                                                                       |
| U-3 | §6 (identity with the synthetic-id alias, mission and step without MCP and without D-A, criteria sources including `linkedCard`, other facts, `$.state` vs re-read with the twin, no mission) |
| U-4 | §8 (budget from MEAS-3/4, cut order, body hash, freshness for a blocker, a re-scope and a verified step, the own-compaction path)                                                             |
| C-1 | `TYPES`/`REF` citations in §5, §6.5, §10, §11 and 02-prototype; mechanisms run in RUN-1..6 and KIT                                                                                            |
| C-2 | §4.1–4.4, with shipped status read from the code                                                                                                                                              |
| C-3 | §9                                                                                                                                                                                            |
| C-4 | §10                                                                                                                                                                                           |
| C-5 | [`02-prototype.md`](02-prototype.md)                                                                                                                                                          |
| C-6 | §14                                                                                                                                                                                           |
| C-7 | §16                                                                                                                                                                                           |
| C-8 | English only, neutral vocabulary; `prettier --check` and `tests/no-client-identifiers.test.ts` (report)                                                                                       |
