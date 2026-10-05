# ADR-0018 — A companion mod is Harnu's integration substrate; the legacy seams stay as permanent fallback

**Status:** accepted · **Date:** 2026-10-02 · **Card:** T389

## Context

Harnu learns what a `claude` session is doing by guessing from the outside. Each seam has a
known failure mode:

- **Approval Inbox** over HTTP hooks written into `~/.claude/settings.json`: a 3.5 s window
  (`RESPONDER_DEADLINE_MS`, `hook-bridge.ts:51`) and then the terminal prompt; a per-boot token
  (`hook-bridge.ts:451`) that orphans sessions across a restart.
- **statusLine telemetry**: a single slot Harnu has to own, wiped once for 13 hours.
- **Plan usage**: `claude -p "/usage"` every 90 s, parsed by regex over prose.
- **Fleet state**: hooks plus a JSONL tail plus a silence timer; "stuck" is a guess.
- **Starting prompt** pasted into the PTY: the most heuristic seam (BUG-9, BUG-17, BUG-64, BUG-85).
- **Cross-session messaging**: mirrors a private function of the minified binary.
- **Session identity**: synthetic → real id matched by time proximity (BUG-65).
- **MCP verbs**: every `sessionId` is self-declared (ADR-0013).

Mods left early access on 2026-10-01 in Claude Code CLI 2.1.287 and are on by default. A mod is a
plugin with a TypeScript hooks module (`on(event, ($, e, next) => …)`), running unsandboxed inside
the `claude` process, loadable per session through `--plugin-dir`. The API "may change between
releases without notice".

The study (`docs/studies/T389-claude-mods-x-harnu.md`) proposed a companion mod. Six specialist
papers reviewed it and four live smoke runs on CLI 2.1.287 tested it (a re-check on 2.1.289, smoke §11, confirmed the five load-bearing claims and sets the tested ceiling; the minimum CLI stays 2.1.287)
(`docs/studies/T389-smoke-evidence.md`, cited below as "smoke A2" and so on). Several of the
study's claims were refuted live; the deviations are decisions D1, D5, D7 and D11.

## Decision

Harnu ships **`harnu-companion`**, a small, readable mod, and treats it as the **sensor and
actuator substrate** for every session it spawns:

1. The companion reports typed facts to a host server in Harnu main and executes a closed set of
   commands from it, over the contract in
   [`docs/specs/T389-companion-mod/01-contract.md`](../specs/T389-companion-mod/01-contract.md).
2. **The legacy seams are a permanent fallback, not a migration step.** Both paths are injected
   into every session; Harnu main arbitrates per session and per fact family. CLI < 2.1.287,
   managed machines, the kill switch, an unloaded mod and sessions with no process all run on
   legacy.
3. **The companion is not a security boundary.** Mods of the same tier are not isolated from each
   other (smoke D6), so the companion can sense and can offer a hold, and can guarantee neither.
   The UI says so.

Precedence for everything below: live smoke evidence > these decisions > the study > panel
opinion. The wave map (D14) is in
[`00-master.md`](../specs/T389-companion-mod/00-master.md) §4.

### Sub-decisions

1. **D1 — Staging: a second, dedicated `--plugin-dir`** (deviation: the study said "reuse the
   skills plugin dir"). Immutable and versioned at
   `<userData>/companion/<modVersion>/harnu-companion/`, shared by all folders and sessions, passed
   before the skills dir, unconditional whenever the companion mode is not `off`. Dev builds point
   at the repo folder. Live sessions keep their version; the host serves protocol N and N-1. Not
   injected into the `usage.ts` / `haiku.ts` probes.
   _Evidence:_ from Harnu's code, not a smoke test (C8): the skills dir is absent when no skill is
   enabled (`insertPluginDirArg` returns the argv untouched, `bundled-skills-core.ts:188`; the
   staged tree is removed, `bundled-skills.ts:445-450`) and is replaced by rm-plus-rename on every
   toggle (`bundled-skills.ts:475-477`), which would hot-reload live mods. Smoke A1: a repeated
   `--plugin-dir` loads both, no consent prompt in a trusted folder; the untrusted case is untested.

2. **D2 — Transport and identity.** A dedicated HTTP server in main on a Unix socket at a stable
   `<userData>/companion/` path, a rendezvous file `endpoint.json` the mod re-reads on every
   connect failure, a TCP loopback variant for Windows and long socket paths. Coordinates are
   baked into a generated file at staging, never read from env or cwd. Per-spawn identity is one
   env var, `HARNU_SPAWN_TOKEN`, a one-time nonce redeemed at hello for a per-connection `conn`.
   The pid is not exposed to mods and is not needed.
   **The hello, the spawn token and `conn` are correlation, not authentication (C4):** they bind
   a PTY to a session, survive restarts and keep the model from guessing; they are not a defence
   against a hostile in-process mod. The host never grants a capability because a request carries
   them.
   _Evidence:_ smoke A2 (`socketPath` works; hello lands 657–827 ms after spawn and before the
   first prompt); smoke D6 (a sibling reads and forges `$.env.get` and `$.http.fetch`).

3. **D3 — Protocol.** Endpoints `hello`, `events`, `poll`, `ask`, `bye`; a Harnu-owned
   vocabulary, never raw CLI event names. Every hold is ≤25 s (poll) or ≤20 s (ask tranche) and
   re-issued; a 30 s abort is a normal reconnect. No long-poll when `isInteractive === false`:
   headless sessions are sensor-only. Hello is lazy and idempotent (`ensureHello` at the head of
   every hook). Re-key from the `classic.SessionStart {source: clear|resume}` payload's
   `session_id` (C10). State lives in `$.state` or is re-fetched at hello. The mod buffers and
   re-sends. Authoring rules are validate-enforced. `bye` is designed for a 1.5 s bound (C13).
   _Evidence:_ smoke B1.1 and C2 (`$.http.fetch` hard-aborts at 30 000 ms); C2 and ADR C6 (a pending
   poll added about 24–46 s to `-p` wall time); A2 and A5 (`session.start` re-fires on hot reload
   and does not fire after `/clear` or in-session `/resume`; inside that hook `$.session.id()` is
   stale for `/resume`); A4 (`$` calls in flight are aborted with a denied turn).

4. **D4 — Arbitration, rollout, fallback.** Harnu main arbitrates per (session, fact family) by
   lease: a feature is declared, then enabled, then proven, and the lease is fresh under 20 s.
   Families: `identity`, `taskState`, `telemetry`, `planUsage`, `approval`, `guard`,
   `startPrompt`, `message`. Lease loss → legacy wins, sticky for the session. `BridgeEvent`
   gains `source`; mod events enter through a neutral task-state hub extracted from
   `hook-bridge.ts`, so the four in-main observers and the `isHibernated` guard keep working.
   Rollout reuses `off | shadow | active` plus the per-folder ramp, per family, and ships
   **shadow by default** for sensor families with a one-time disclosure and a global kill switch;
   a family goes active only on evidence from a persisted parity ledger. Default-on is an operator
   confirmation point. A CLI version gate is new work. Managed orgs, the kill switch and a
   mid-session unload are detected by lease absence and the proven set.
   _Evidence:_ code: `BridgeEvent` has no `source` (`hook-bridge.ts:64-73`); the shadow ring is
   in memory, 200 entries (`responder-registry.ts:163`); no CLI version detection exists in
   `src/main` (the design in `docs/specs/T200-cli-version-detection.md` is not implemented).
   Smoke B6 and A5 refute "three crashes unload all mods" (C9): throws unload nothing, a worker
   wedge unloads only the culprit but skips the whole hook chain for that call.

5. **D5 — Approval hold in `classic.PermissionRequest`** (deviation: the study said "hold in
   `tool.check`"). The native dialog stays open and usable, a remote answer closes it, the first
   answer wins natively, and it works in `-p` and for subagents. `tool.check` is pass-through and
   only records `tool_use_id`. Tickets retire on `classic.PostToolUse`, on `next.signal` abort
   and on `turn.complete`; nothing depends on `classic.PostToolUseFailure`, which was never
   observed (C3). Any failure returns the engine's own verdict, never an allow. While the
   companion owns `approval` for a session the legacy bridge answers its hook POSTs at once (no
   double park). Only renderer IPC resolves a held approval. The Inbox shows a per-session
   coverage state and never claims a guarantee. A dialog-suppressing `tool.check` hold plus band
   is a deferred option. `$.ui.notice` is not relied on.
   _Evidence:_ smoke B1.7 (held 15 min); B1.3 (a `tool.check` hold shows only a spinner); B6 and
   D6 (fail-open on a sibling's wedge; forgeable at the same tier); B2 (`$.ui.notice` never
   rendered). The bridge added about 3.5 s per tool call in runs A, B and D (C2).

6. **D6 — Guard.** `tool.call` deny restricted to `Edit|Write|NotebookEdit`, exempting subagents
   (`e.agentId`) and `.harnu/` by `realPath`. A static test forbids any Bash `tool.call` matcher in
   the companion. While the companion owns `guard`, Harnu does not arm `armed.json` for that
   session.
   _Evidence:_ smoke B3 (deny, subagent exemption, live toggle; it used a path regex, so the
   `realPath` rule is a requirement, not a confirmed fact, C1); smoke B4 (#92533 reproduced: a
   pass-through Bash `tool.call` hook breaks `Agent(isolation: "worktree")`).

7. **D7 — Live contract through a hidden user-role row** (deviation: the study said
   "`prompt.compose` live"). Mid-session contract injection uses `$.session.append`;
   `--append-system-prompt` stays the spawn-time carrier; re-injection after compaction goes
   through the compaction result `messages` or a deferred append.
   _Evidence:_ smoke C3 (the system prompt is snapshotted on the first request until compaction;
   the appended row is read on the next request with the cache intact); smoke D5 (a synchronous
   append inside the `session.compact` hook is lost).

8. **D8 — MCP caller attribution.** `tool.call` on `mcp__harnu__*` (and the legacy alias `mcp__capy__*`) stamps a per-connection token
   plus `agentId`; the server resolves it to the session. It is **attribution, not
   authentication**: target-side checks stay, and agent-controlled spawns still get no Harnu MCP.
   _Evidence:_ smoke B5 (the stamp overwrites a model-supplied value and is invisible to the model
   and the transcript). `auto` permission mode is untested.

9. **D9 — Start prompt.** `$.prompt.submit` from `session.start`, a one-shot claim in main keyed
   by the spawn token, idempotent across hot reload, interactive only. Text beginning with `/`
   goes through `$.command.run`; `@file` prompts stay legacy or are inlined. The argv positional
   remains the default for operator prompts; the companion replaces the PTY paste path.
   _Evidence:_ smoke C1 (turn starts 857–906 ms after spawn; 30 000 chars intact; slash text
   rejected; `@file` not expanded; plugin prompts are `type:"user"` rows with
   `origin.kind:"plugin"`).

10. **D10 — Messaging.** Harnu main has no session to call `$.session.send` from, so a
    `message.deliver` command makes the recipient's companion submit a framed, non-`asUser`
    prompt with an explicit peer envelope. The legacy socket stays for sessions without a lease.
    The legacy bridge answers `SendMessage` `PreToolUse` at once for any session with a live
    lease (C7). `isDelivered` means "written", never "read".
    _Evidence:_ smoke D1 (native SendMessage is auditable through `session.send` /
    `session.receive`; every `$.session.send` runs settings `PreToolUse` hooks; a failed
    `{sessionId}` lookup never reaches the sender's hook).

11. **D11 — Telemetry: the statusLine is demoted, not replaced** (deviation: the study said
    "replaced"). `session.measure` carries context, limits and cost; lines ±, thinking, output
    style and PR have no mod source. Plan limits come from any leased session; the `/usage` poll
    runs only when no lease reported within 90 s. Tokens per turn from `turn.complete.usage`, USD
    from `session.measure.cost.usd` deltas; fork, complete and compaction spend is separate.
    _Evidence:_ smoke A3 (`session.measure` fires and equals the statusLine figures; issue #94424
    refuted; a rate-limit-only trigger was never isolated, C5); smoke D7 (summed turn usage
    matches the CLI total exactly).

12. **D12 — Fleet state.** There is no "dialog answered" event: `waiting-permission` ends on
    `classic.PostToolUse`, on the companion's own ask resolution, or on `turn.complete`. A
    main-loop `turn.complete` is not idle while background subagents run. A user "No" ends the
    turn with `reason:"answer"` and no `classic.Stop`. `turn.step` is not hooked in phase 1.
    _Evidence:_ smoke A4. Smoke A's own mapping used `tool.call.end`, which would need a Bash
    `tool.call` hook; D6 forbids it (C11). Whether `classic.*` fires with no settings hook
    configured must be re-verified in isolation (C14).

13. **D13 — Security floor.** A closed command enum, server-side origin gating, a Harnu-side audit
    of every command. No remote "approve", no generic run command, no `$.process.run` in the
    companion, no Bash `tool.call`, no policy evasion. The audit pane says "can", never "safe" or
    "verified".
    _Evidence:_ smoke D6 (no isolation at the same tier); the security panel paper; ADR-0004 and
    ADR-0013.

### Corrections after the evidence consolidation

These override the sub-decisions above where they differ. Specs cite them as C1–C28. C1–C15 came
from the evidence consolidation; C16–C28 from the reconciliation of the nineteen wave specs
(2026-10-02), where reading Harnu's code and the CLI types showed a decision could not be
implemented as worded.

- **C1 (D6):** the `.harnu/` exemption by `realPath` is a requirement; smoke B3 used a path regex.
  Symlink and `..` bypass and `NotebookEdit` are untested.
- **C2 (D5):** the ~3.5 s bridge tax was observed in runs A, B and D (in D only on
  `$.session.send`), not in C.
- **C3 (D5, D12):** `classic.PostToolUseFailure` was never observed firing. After a user "No"
  there is no `PostToolUse`; the exit is `turn.complete`. Designs must not depend on it.
- **C4 (D2):** the hello is not authentication. The spawn token and `conn` are correlation and
  anti-accident measures. The host never grants a capability because a request carries them; the
  mod does not trust a response for anything the engine would not allow anyway.
- **C5 (D11):** a `session.measure` triggered by a rate-limit move alone was never isolated; the
  model display name is untested; `effortLevel` is partial.
- **C6 (D3):** a pending long-poll added about 24–46 s to `-p` wall time.
- **C7 (D10):** a failed `{sessionId}` lookup never reaches the sender's `session.send` hook.
  Every `$.session.send` runs settings `PreToolUse` hooks as tool `SendMessage`, so the legacy
  bridge answers `SendMessage` at once for any session with a live lease, whoever owns `approval`.
- **C8 (D1):** "no consent prompt" holds for trusted folders only. D1 derives from Harnu's code,
  not from a smoke test.
- **C9 (D4):** "three crashes unload all mods" is refuted as tested. Throws never unload; a worker
  wedge unloads only the culprit, but skips the whole hook chain for that call.
- **C10 (D3):** after an in-session `/resume`, `$.session.id()` is stale inside the
  `classic.SessionStart` hook. The payload's `session_id` is the source of truth.
- **C11 (D12):** smoke A's exit from `waiting-permission` on `tool.call.end` needs a Bash
  `tool.call` hook, which D6 forbids. D12's exits are the binding ones.
- **C12 (positioning):** answering the permission dialog from another client is within a mod's
  reach (smoke B1.7); only redrawing it is not.
- **C13:** `session.end` bound: the types say 1.5 s, smoke C read 5 000 ms. Unresolved; `bye` is
  designed for 1.5 s.
- **C14:** "`classic.*` fire with no settings hook configured" is partial: the runs had global
  hooks installed. It must be re-verified with `--setting-sources` isolation.
- **C15 (docs hygiene):** names shaped like a tracker key are written with `_` instead of `-`, and
  the patterns of `tests/no-client-identifiers.test.ts` are run over every new doc.
- **C16 (D6):** "Harnu does not arm `armed.json`" cannot hold: `armed.json` is also the role
  record (the spawn-time contract, the renderer badge and `get_fleet` read it). The entry stays
  and gains `enforcer: 'script' | 'companion'`; the rule reads "no entry the script enforces".
- **C17 (D10):** a `$.prompt.submit` row is plugin-origin, so the recipient engine's hold on a
  peer message for a bypass-mode recipient does not run on the companion transport. The mod
  refuses `message.deliver` when the last `permission_mode` it saw is `bypassPermissions` or it
  has seen none, and the broker falls back to the socket, where the engine's own gate decides.
- **C18 (C7, D10):** the bridge's immediate answer to `SendMessage` is conditioned on the
  session's `message` family being `active`, not on any live lease: "any live lease" would make
  the bridge stand down in `shadow`. It only helps native sends, and it removes `SendMessage`
  from the Inbox window for those sessions (a stated user-visible change).
- **C19 (D2, D3, D4):** a hello gives an identity **claim**, not a re-key. Hello lands before the
  transcript exists; a row re-keyed then would be dropped by the next reload and would be
  parkable with nothing to resume. The row migrates at the existing `session:added` event,
  resolved by the claim instead of the heuristics.
- **C20 (D4):** `shadow` means no actuation and no authority **for a family that has a legacy
  rival**. The poll loop, observe-only commands (`flush`, `config.update`,
  `guard.set {enforce: false}`, `sentinel.set`), the stamp level `observe`, parity recording and
  the `status` ask run in `shadow`. A feature with no fact family has its own key in
  `companion-prefs.json` and needs the key on, the companion mode not `off` and a live lease.
- **C21 (the study's "micro-plan before parking"):** a parked session's prompt cache has usually
  lapsed (the park thresholds are 15 and 60 minutes idle), and a cold fork re-bills the whole
  context; smoke D4 measured only a warm fork. The default mode is `idle`: capture about three
  minutes after a turn ends and reuse the plan at park. Capture-at-park stays as the mode `park`,
  under a context ceiling. The feature is off by default.
- **C22 (D5):** the coverage change is larger than D5 states. The legacy Inbox parks on
  `PreToolUse` with matcher `*`, so today every tool call gets the 3.5 s window. With the
  companion a hold happens only when the engine would ask: sessions in `acceptEdits` or
  `bypassPermissions` lose that window. The Sentinel deny is preserved (the legacy hook, or the
  `tool.check` query of P3W2). Whether to also hold in `tool.check` for those modes is operator
  decision point OD-2 in the master spec.
- **C23 (D1):** "dev builds point at the repo folder" is unsafe as a default: a second unpackaged
  instance (the live-verify one) would rewrite the same generated coordinates and hot-reload the
  other instance's sessions onto the wrong endpoint. It is an opt-in flag with a single-owner
  lock.
- **C24 (D8, D2):** the engine exposes `crypto.subtle.digest` and nothing else, so no native HMAC
  exists. The stamp proof is a truncated digest over `conn`; the reserved `hello.proof` is not
  implemented in protocol 1. Stamping is skipped in `auto` permission mode until the rewrite's
  behaviour there is settled.
- **C25 (D4):** the kill switch turned off takes effect at once for every session: the host
  revokes each `conn` and answers the re-hello with no feature enabled. Turning it off never
  stops a running listener. Turned back on, it reaches new sessions only: protocol 1 has no
  signal that re-enables an inert mod. An inert binding reads as `off`, never as a lease loss.
- **C26 (D9):** the start-prompt claim is keyed by the spawn (its owner), never by a copy of the
  spawn token, which stays inside the host's ledger. Scope, stated honestly: only prompts over
  24 000 characters take the paste path today and a resume carries no starting prompt.
- **C27 (D13, positioning):** the UI already uses "companion" for the T245 review companion.
  Every user-visible string of this epic says "Harnu mod"; the plugin name, file names and these
  documents keep "companion". The mod's command is `/harnu-link` (`status`, `open`), because
  `/harnu status` is one character from the bundled skill `/harnu:status`.
- **C28 (scope):** four narrowings the wave specs found necessary. P4W1: the user-tier allowlist
  gate is out of scope. P4W3: a new switch, not the bundled-skills "Also outside Harnu" switch,
  which cannot carry a hooks module. P4W5: no instruction is added to the compaction summarizer
  in protocol 1. P5W1: nothing is deleted in that wave, and the never-delete list grows by the
  hook-bridge server, statusLine ingest and the settings read-modify-write helpers.

## Alternatives rejected

- **Reuse the skills `--plugin-dir`.** The study's plan. That dir does not exist when no skill is
  enabled, which is the default, and every skill toggle swaps the tree and would hot-reload the
  mod in every live session of the folder (D1).
- **The MCP loopback server as the channel.** It is withheld from `agentControlled` and read-only
  spawns (`pty.ts:758-766`), the operator can turn it off, it has no caller identity (ADR-0013),
  and a stored port that is taken orphans older sessions (`mcp/server.ts:1467-1477`).
- **The hook-bridge server as the channel.** Per-boot token, ephemeral port, a 3.5 s deadline. It
  is the seam being demoted.
- **A helper process started with `$.process.spawn`.** One process per session, and it is the
  pattern security vendors flag in mods. It also puts `$.process` in the companion (D13).
- **A file inbox, statusLine style.** No command channel and no backpressure.
- **Holding the approval in `tool.check`.** While it holds, the terminal shows only a spinner and
  no dialog (smoke B1.3), so the person at the terminal is blind and loses "always allow". Kept
  only as a deferred option for a true remote-only mode.
- **`prompt.compose` for a live contract.** The system prompt is snapshotted until compaction
  (smoke C3). `--system-prompt-snapshot off` works at the cost of a cache rewrite per change.
- **One held fetch per approval or per command wait.** `$.http.fetch` aborts at 30 000 ms
  (smoke B1.1, C2); the hold would fail open at 30 s.
- **A minimal subset only** (handshake, a turn beacon, the guard), from the devil's-advocate
  paper. Not taken as the scope, because scope is not cut; taken as the **order**: P1 is that
  subset plus arbitration, and the kill criteria below stop the epic there if it does not pay.

## Consequences

- **Two stacks coexist for good.** Every family has a companion path and a legacy path, an
  arbiter between them, and a parity ledger. That is more code than today, not less, until P5
  retires what the evidence allows. The fallback set that is never deleted is listed in the
  master spec (ARB-8).
- **API-drift cost is permanent.** Every CLI release needs the drift contract (a checked-in API
  surface manifest, `claude plugin validate`, `claude plugin test`, a live smoke) before the
  tested ceiling moves; above the ceiling the companion is forced to `shadow`.
- **What gets better.** Identity is bound at spawn instead of guessed. Turn state comes from
  typed edges. Usage is pushed, and the statusLine slot is no longer Harnu's to own. The starting
  prompt stops depending on terminal timing. An approval can be held for minutes with the native
  dialog still usable, and the 3.5 s bridge tax leaves the tool-call path for owned sessions.
  The stale-port orphaning disappears by construction.
- **What does not get better.** Parked sessions, sessions outside Harnu, managed machines and old
  CLIs gain nothing. The Inbox is still not a gate. ADR-0013 stays open: a stamp is attribution.
- **Positioning.** Answering the permission dialog from another client is no longer outside a
  mod's reach (smoke B1.7, C12); only redrawing it is. Single-session widgets are a commodity;
  Harnu's ground is coordination, policy and governance across sessions.
- **The companion is itself unsandboxed code on the user's machine.** It ships with a one-time
  disclosure and a global kill switch, and it is row 1 of the Mods audit tab, under the same
  wording as any other mod.
- **A new shared artifact.** `resources/companion/hooks/contract.ts` is imported by both the mod
  and main; a wire change is a change to it, to the contract document and to the golden fixtures
  in one commit.

## Kill criteria

Evaluated at the end of P1, before any actuator wave is built. Any one of them stops the epic at
"keep what is additive, build no more":

1. The handshake fails to bind more than a few percent of spawns across new, resume, `/clear`
   and fresh-worktree sessions.
2. Two CLI releases inside the P1 window break the mod.
3. The companion is implicated in a worker unload or a skipped hook chain in real use, or cannot
   rule itself out.
4. P1 ships and no bug class is closed and no legacy code path can be demoted.
5. The parity ledger shows the companion disagreeing with legacy on fleet state or usage in ways
   that cannot be classified.

The study's own gate, the long approval hold, is already settled by smoke B1.7 and no longer a
kill criterion. A hold that drops on hot reload without a recoverable signal would cancel P3
alone, not the epic.

**Re-open this decision** if the CLI gains isolation between mods or an authenticated host
channel (the "not a security boundary" clause would change), if the mods API is declared stable
(the drift budget would shrink), or if an org policy channel appears that lets a managed machine
allow the companion by name.
