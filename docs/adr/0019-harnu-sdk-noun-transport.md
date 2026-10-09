# ADR-0019 — The `$.harnu` SDK noun calls Harnu over its MCP server; the command channel only tells it what changed

**Status:** proposed · **Date:** 2026-10-09 · **Card:** T447

## Context

Ideas 56 and 117 of the mods ideation report propose `$.harnu`: a noun the Harnu mod adds to Claude
Code's engine interface through `engine.create`, so a third-party mod lists `harnu` under
`dependencies` and calls typed methods instead of `$.mcp.call` (spec:
[`docs/specs/T447-harnu-sdk-noun/00-spec.md`](../specs/T447-harnu-sdk-noun/00-spec.md)). The one
architectural question is how a call on the noun reaches Harnu. Two paths exist today, and a mix
of them is a third option:

- **Harnu's MCP server** (`harnu`, `src/main/mcp/config-file.ts:32`): 50 verbs, each gated by
  `evaluateToolCall` and `planToolCall` (blocked folders, "Ask before agent actions", per-verb
  confirms, grants) and audited per call (`src/main/mcp/audit-log.ts:13-34`). A mod reaches it with
  `$.mcp.call(server, tool, args)`, "with the engine's own connection and credentials … No
  permission prompt: the plugin's call, seen by the hooks above it, is the grant"
  (Claude Code 2.1.295 types, lines 2697-2718).
- **The Harnu mod's command channel** (T389 P2W1, shipped): HTTP over a Unix socket, a long poll
  the companion holds open, a closed origin-gated enum of commands, audited on Harnu's side.

Facts that constrain the choice:

1. **The channel flows host → mod only, by rule.** "`enqueue()` is the single entry point. No HTTP
   route, MCP verb or companion endpoint may add a command" (T389 P2W1:431-432); "Any MCP verb that
   enqueues a command" is a non-goal (P2W1:89). What flows mod → host is sensor traffic, which "no
   consumer trusts … as authority" (T389 P1W1:577-579).
2. **The companion may not call `$.mcp.call`** (T389 master SEC-9 (b), `00-master.md:502`;
   `docs/dev/companion-mod.md:60`).
3. **Some sessions get no Harnu MCP, on purpose.** An MCP-spawned (`agentControlled`) or read-only
   session has Harnu's `--mcp-config` withheld (the `agentControlled` branch,
   `src/main/pty.ts:811-818`; the flag is set at `src/renderer/src/stores/sessions.ts:3231`), and
   P2W5 states "No
   Harnu MCP for read-only or agent-controlled spawns, and no route around that (`$.mcp.call`,
   `$.tool.register`)" (T389 P2W5:72-74). Manifest/board-dispatched sessions are not in that set:
   they carry `spawnedBy: 'agent'`, not `agentControlled`, and get the full server
   (`src/renderer/src/stores/sessions.ts:333-341`).
4. **ADR-0002's hard boundary.** "Every extension capability reaches the app exclusively through
   an existing mediated registry (the MCP tool catalog, the pane registry, the mode registry) —
   never a bespoke new IPC channel per extension" (ADR-0002 §2.1).
5. **Mods of one tier are not isolated** (ADR-0018 Decision 3). Anything the noun does, a
   dependent could do itself; the noun is a convenience and a contract, not a boundary.
6. **Scheduler ticks are fenced by lists `$.mcp.call` ignores.** An `observe` tick keeps Harnu's
   write verbs away only through Claude Code's native allow and deny lists
   (`src/main/scheduler-core.ts:346-395`, passed at :491 and :498), yet it loads the companion
   (:462) and Harnu's MCP config (:468). A plugin's `$.mcp.call` has "No permission prompt: the
   plugin's call, seen by the hooks above it, is the grant" (2.1.295 types, lines 2697-2718).
7. **With "Ask before agent actions" off — the default — most verbs run free.** Only
   `plan_mission`, `delete_card`, `delete_worker` and `remove_containers` always confirm; the
   orchestration and mission-shaping verbs are free mutations (`silentAllowInAgentFolder` in
   `src/main/mcp/tool-catalog.ts`). With Ask on, an unanswered confirm comes back after 30 s as a
   non-error `{ status: 'pending', approvalId }` and stays live for 30 min
   (`src/main/mcp/confirm-core.ts:37`, :45; `src/main/mcp/server.ts:1252-1287`).
8. **The MCP audit has no caller today.** `AuditRecord` carries no session or mod
   (`audit-log.ts:13-34`); P2W5 (specified, not shipped) adds a session stamp, but only on the
   `tool.call` path. "Another mod's `$.mcp.call` … → unstamped" (P2W5:271).

## Decision

The `$.harnu` noun is provided by a **new, separate mod named `harnu`** (`resources/harnu-sdk/`),
staged beside the companion, and uses a **mix with one owner per direction**:

1. **Every call on the noun that reaches Harnu goes over the MCP server**:
   `$.mcp.call('harnu', <verb>, args)`, from the `harnu` mod, to the verb the spec's mapping table
   names. Reads and writes alike.
2. **Identity is read locally.** The session id comes from the companion's `$.state`
   (`harnu-companion.sid`), which any plugin may read; whether the session was spawned by Harnu
   comes from the presence of `HARNU_SPAWN_TOKEN`. No wire.
3. **The command channel carries change notification only, in v2.** One new command,
   `sdk.invalidate { topic }`, enqueued by Harnu main through the existing `registerGateRow` path,
   carrying an enum and no data. The noun reacts by re-reading over MCP. v1 polls instead.
4. **Where Harnu withheld its MCP server, the noun answers `NO_MCP`.** It never routes around the
   withholding: the `harnu` mod lists no MCP server in its manifest and never calls
   `$.mcp.connect`.
5. **Outside Harnu**, the noun reads `.harnu/memory/` from disk for `memoryRead`/`memoryQuery` and
   refuses every other method with `OUTSIDE_HARNU`. Writes never fall back to disk.
6. **Never in a Scheduler tick, read-only when non-interactive.** Harnu never stages the `harnu`
   mod into a tick, and the noun refuses every write with `READ_ONLY` in a non-interactive session.
7. **One door.** The `harnu` mod denies any other mod's direct `$.mcp.call` into Harnu, so the noun's
   filters are the path a well-behaved mod takes; it is a speed bump, not a boundary (D9).

### Sub-decisions

1. **D1 — A separate mod, not a module of the companion.** The noun's writes need `$.mcp.call`,
   which SEC-9 (b) forbids in the companion; and dependents name the dependency by plugin name, so
   the provider is called `harnu`, not `harnu-companion`.
   _Evidence:_ `resources/companion/.claude-plugin/plugin.json` (`"name": "harnu-companion"`);
   2.1.295 types lines 78-84 and `reference.md` line 66 (a dependency's contract is laid at
   `.claude-plugin/types/<plugin>/index.d.ts`, keyed by plugin, **each time the engine loads the
   dependent from a folder it lays types in**; "a `--plugin-dir` under `claude -p` or an SDK host,
   an installed plugin's) is never written in", `reference.md` lines 50-53).

2. **D2 — The MCP server is the call transport.** It is the mediated registry ADR-0002 requires,
   and every gate an operator relies on is already enforced there: nothing new to build, nothing
   relaxed. The noun adds argument filtering on top (excluded verbs, pages and keys), never removes
   a check.
   _Evidence:_ `src/main/mcp/permission-core.ts:206-242` (kill switch, blocked folder, ask mode);
   `src/main/mcp/plan-tool-call.ts:189-324` (free vs forced confirm, grants);
   `src/main/mcp/server.ts:933-1181` (dispatch, confirm parking, always-allow).

3. **D3 — Withheld means withheld.** In an `agentControlled` or read-only spawn there is no `harnu`
   server connected, `$.mcp.call` cannot reach it, and the noun says `NO_MCP`. Giving those sessions
   a second door through the companion's socket would undo SEC-9 (g) and P2W5's non-goal.
   _Evidence:_ `src/main/pty.ts:811-818`; T389 P2W5:72-74; `docs/harnu-features.md` ("withheld
   every `mcp__harnu__*` verb").

4. **D4 — The channel only says "changed".** The noun's v2 subscription moves no data over the
   channel: a closed-enum `sdk.invalidate` fits SEC-5 (a) ("No command takes a path, shell string,
   code or file"), and borrows the debounce P4W2 specifies for `ui.band.set`. P4W2 has not
   shipped, so that debounce is new code, not reuse. External bindings never receive it: the host
   issues them only `flush`, `config.update` and `ui.band.set` (T389 P4W3 §7.6), so v1's poll stays
   their only path (moot for the noun, which has no MCP outside Harnu).
   _Evidence:_ T389 P2W1:283-287 (`registerGateRow`), :205-208 (causes); T389 P4W2:165-167
   (the specified band debounce); T389 P4W3:245-262.

5. **D5 — Attribution rides P2W5, amended.** The companion stamps the `mcp.call` op event as well
   as `tool.call`, and the stamp carries `via: { plugin, tier }` from `next.origin`, which the host
   sets and no plugin writes. Hooking `mcp.call` is not calling it, so SEC-9 (b) holds. Until P2W5
   ships, noun calls are audited like any MCP call, with no caller.
   _Evidence:_ 2.1.295 types lines 6576-6586 (the `origin` field of `Next`, "Set by the host
   alone"), 6825-6836 (calls on `$` are hookable op events); a `claude plugin test` probe on 2.1.295
   in which the provider's hook on its own noun event read the dependent's name and tier from
   `next.origin`; T389 P2W5:86-99, :271, :278-286.

6. **D6 — No escape hatch.** The noun has no `call(verb, args)` method and takes no `folder`: each
   method maps to one verb with fixed or filtered arguments. This keeps the surface reviewable and
   the Mods tab chips meaningful.
   _Evidence:_ ADR-0002 §2.1 ("`window.api` never grows a generic `invoke(channel, …)` escape
   hatch"), applied here by analogy.

7. **D7 — Stubs in `engine.create`, work in the provider's own hooks.** An `engine.create` step
   receives no usable `$`, so the functions it returns cannot call `$.mcp.call`. The `harnu` mod
   returns stubs and does the work in one hook per method (`on('harnu.<method>', …)`), which gets
   `$` and `next.origin`.
   _Evidence:_ 2.1.295 types lines 6676-6681 (`NoEngineInterface`: "Every property reads as
   `never`"); the same probe as D5, where the provider's hook answered over its stub.

8. **D8 — No noun in Scheduler ticks; read-only when non-interactive.** Context fact 6 means a noun
   loaded in an `observe` tick would hand every write verb to a "read-only" worker. Harnu passes the
   `harnu` mod to interactive spawns only, never to `tickArgv`, and a test pins that; the noun also
   refuses writes whenever `session.start` reported `isInteractive: false`, so a mistaken staging
   still writes nothing.
   _Evidence:_ `src/main/scheduler-core.ts:346-395`, :460-498.

9. **D9 — One door, honestly labelled.** Context fact 7 means Harnu's server does not stop a mod
   that calls an excluded free verb directly. The `harnu` mod hooks the `mcp.call` op event and
   denies any call into `harnu`/`capy` whose caller is not `harnu` itself, with a `.catch` that
   denies. It is a speed bump: a caller's own hook can answer above it or skip it with
   `next.to(e, tier)`, and a mod has `$.process` anyway (ADR-0018 Decision 3). The boundary is
   install-time trust, which the Mods tab must disclose.
   _Evidence:_ a `claude plugin test` probe on 2.1.295: a dependent's direct
   `$.mcp.call('harnu', 'spawn_terminal', …)` was refused by an inline `harnu` plugin's guard at
   `user` and at `prepend` tier; `src/main/mods-audit-core.ts:368-385` (a hook on `mcp.call`
   produces no chip today).

## Alternatives rejected

- **The command channel for calls.** It would need a mod → host request path that P2W1 forbids by
  rule (P2W1:431-432), it reaches exactly the sessions where Harnu withheld its verbs (D3), and it
  would duplicate, inside `src/main/companion/`, every gate the MCP server already runs. Its one
  advantage, latency (0–2 ms enqueue-to-mod on a held poll, P2W1:48), is measured in the opposite
  direction.
- **Put the noun inside `harnu-companion`.** Forbidden by SEC-9 (b) for the write path, and it would
  turn a small, sensor-only mod into a public API with its own versioning (ADR-0018 Decision).
- **A new HTTP route on the companion socket for SDK calls.** A bespoke channel per extension
  surface, which ADR-0002 §2.1 rules out, and a second implementation of the MCP gates.
- **Let dependents call `$.mcp.call` and ship only types.** Nothing would stop it, and nothing
  forbids it, but every dependent would re-implement result normalisation, environment detection
  and the outside-Harnu story, which is the cost the noun exists to remove (ideas 56/117).
- **Fall back to writing `.harnu/` files when MCP is absent.** Skips provenance stamping and the
  card gates (`docs/harnu-features.md`, "Never hand-write a card file"), and in a withheld session
  it is precisely the route around D3.
- **Queue writes made outside Harnu and replay them later.** They would act under a gate state the
  operator never saw.

## Consequences

- **The noun is only as available as Harnu's MCP server.** If the operator turns the server off,
  or a stored port is taken, every write answers `OUTSIDE_HARNU` or `NO_MCP`. Reads of memory keep
  working from disk. This is the same availability an agent already has.
- **Two mods to stage, one more `--plugin-dir`.** Staging, the `mod` CI step and the drift
  manifest are reused from T389 P1W2, not copied; the cost is a second folder and a second
  `api-surface.json`.
- **Latency is a loopback HTTP call per method**, unmeasured inside a session. Draw paths read the
  `$.state` cache, never a live call; the W0 spike measures the round trip before W3 sets the poll
  interval.
- **Attribution lags.** Until P2W5 and its amendment ship, the audit cannot say which mod made a
  call. The spec says so; the UI must not imply otherwise (SEC-7).
- **The exclusion list is enforced only as far as a mod lets it be.** The guard (D9) stops a mod
  that calls Harnu directly by mistake or by habit, not one that means to get around it. With Ask
  off, nothing inside `claude` stops a determined mod from reaching the free verbs; the operator's
  protection is what they install, what the Mods tab tells them, and the Ask switch.
- **Writes can come back `PENDING`.** Under Ask, a dependent must handle a pending approval as
  not-done (`approvalWait`), never as success.
- **The Mods tab needs work to be honest about this.** Today a dependent's noun calls and the
  guard's `mcp.call` hook produce no chip (spec §9.5); the fix is a P4W1 follow-up.
- **Manifest-dispatched sessions keep full write access through the noun**, because they keep the
  full server today. That is existing behaviour, raised as an open question in the spec (SDK-Q10),
  not changed here.

## Kill criteria

Evaluated after the W0 spike and again after W3. Any one of them re-opens this decision:

1. A `user`-tier plugin cannot add a noun in a live session on the CLI versions Harnu supports
   (spec A1, SDK-Q2). Two test-kit probes disagree on this; `--plugin-dir` only ever gives `user`.
2. `dependencies` does not resolve to a `--plugin-dir` plugin, so dependents cannot load inside
   Harnu without a marketplace install (spec A3).
3. The `$.mcp.call` round trip makes a 5 s fleet poll across a 20-session fleet measurably costly
   (CPU or audit volume), and v2 invalidation cannot ship first.
4. P2W5 is abandoned, leaving noun calls unattributable for good.

**Re-open this decision** if the CLI gains authenticated host channels or isolation between mods
(the companion could then carry authority, not just correlation), if Harnu's MCP server gains a
per-session identity (D5 would simplify), or if the command channel's host → mod rule is ever
relaxed by its own ADR.
