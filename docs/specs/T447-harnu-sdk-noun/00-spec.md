# T447 — `$.harnu`: an SDK noun third-party mods depend on

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T447 · **ADR:**
[`0019-harnu-sdk-noun-transport.md`](../../adr/0019-harnu-sdk-noun-transport.md) (proposed)

Files: this spec, [`01-contract.md`](01-contract.md) (the TypeScript contract, §5.1) and
[`02-worked-example.md`](02-worked-example.md) (the worked example, §14).

## 0. Summary

Harnu ships a second, small mod named **`harnu`** whose only job is to add one noun to Claude
Code's engine interface through `engine.create`: `$.harnu`. A third-party mod lists `harnu` under
`dependencies` in its `plugin.json`, gets the noun's types laid beside it by the engine, and calls
typed methods such as `$.harnu.missionCurrent()`, `$.harnu.memoryAppend({ page, entry })` or
`$.harnu.cardMove({ slug, to })` instead of hand-rolling `$.mcp.call` into Harnu's MCP verbs.

Four facts from the engine and the repo shape the design:

1. **A noun's methods are flat and take one argument.** Each method of a plugin noun becomes an
   event `<noun>.<method>`; a member that is not a function is no event (§3.2). So the surface is
   `$.harnu.cardMove(...)`, not the dotted `$.harnu.card.move(...)` of ideas 56 and 117.
2. **The command channel only flows host → mod.** No route may let a mod enqueue work in Harnu
   (T389/P2W1:431-432; §8). Writes therefore go over the MCP server, where every gate already lives.
3. **The companion may not call `$.mcp.call`** (T389 SEC-9b). The noun cannot live inside
   `harnu-companion`; it is a separate mod that _reads_ the companion's published state.
4. **Sessions Harnu spawns for an MCP agent get no Harnu MCP at all**, by design. The noun does
   not route around that: there, every write answers a typed `NO_MCP` refusal.

Transport (ADR-0019): writes and authoritative reads use `$.mcp.call('harnu', <verb>, args)`;
identity comes from the companion's `$.state`; outside Harnu a small set of reads falls back to
`.harnu/memory/` on disk; change notification is a poll in v1 and an invalidation command over the
existing channel in v2.

## 1. Origin and scope

**Origin.** Ideas 56 and 117 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md`
in the main checkout, gitignored), which describe the same noun twice:

- Idea 56: "The Harnu mod exposes `$.harnu` (fleet, mission, memory, board, messaging, with cached
  reads and typed results) so third-party mods declare `dependencies: ['harnu']` and call
  `$.harnu.mission.current()` instead of hand-rolling `mcp.call`." Uses `engine.create`,
  `mcp.connect/mcp.call`, a `$.state` cache with `derive`, `plugin.register`.
- Idea 117: "`$.harnu.inside`, `$.harnu.fleet()`, `$.harnu.memory.append()`, `$.harnu.card.move()`,
  `$.harnu.mission.step()`, `$.harnu.on('fleet', cb)` — degrading to no-ops with `inside:false`
  outside the app."

The report ranks it first of its "Ten I would build first": "The platform seam: every other
Harnu-related idea gets 10× cheaper once third-party mods can `dependencies: ['harnu']`."

**Goals.**

- G1. A typed, documented surface for the Harnu actions a third-party mod reasonably needs: who am
  I, fleet, memory, board cards, the mission I own, and operator signals (notify, speak, open file).
- G2. Every call passes through the gates Harnu already enforces (blocked folders, "Ask before
  agent actions", per-verb confirms, audit). Nothing reachable through the noun is reachable that
  was not reachable before.
- G3. Defined behaviour in every environment: inside Harnu, inside Harnu without MCP, outside
  Harnu, Harnu not running.
- G4. A test story for the dependent mod and for the noun itself.

**Non-goals.**

- No new MCP verb is required for v1 (two are proposed as optional, §16).
- No authentication of the calling mod. The engine names the caller (`next.origin`), Harnu records
  it as declared, nothing is authorized by it (§9.4).
- No messaging (`message_session`) and no orchestration verbs in v1 (§9.1). Idea 56 lists
  "messaging"; it is deferred deliberately, not dropped (SDK-Q6).
- No change to `harnu-companion`'s security rules (SEC-1 to SEC-9 of the T389 master).
- No marketplace or mod store (idea 118).

## 2. Conventions

Every fact carries a source. Abbreviations:

| Tag      | Source                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TYPES`  | `claude-code.d.ts` written by Claude Code **2.1.295** (line 1: "Written by Claude Code 2.1.295."). The same file the engine lays beside a loaded mod as `.claude-plugin/types/claude-code/index.d.ts`. |
| `REF`    | The `plugin-authoring` skill's `reference.md` shipped with 2.1.295 (the long-form mods reference).                                                                                                     |
| `TC`     | `src/main/mcp/tool-catalog.ts` at this branch's base (`6b65873`).                                                                                                                                      |
| `T389/x` | `docs/specs/T389-companion-mod/<x>.md`.                                                                                                                                                                |

Line numbers in `TYPES` are those of the 2.1.295 file; a later build moves them (§11.3).

**Verified** means read in the cited file. **Assumption** marks anything inferred and not yet
observed; each one is listed again in §3.9 with the spike that settles it.

## 3. Feasibility: the engine contract (AC-1)

### 3.1 Adding a noun: the `engine.create` fold

`engine.create` is the event during which `$` is built, once per load of a plugin:

> "Runs while `$` is being built, once per load or reload of this plugin and before any other hook
> of it; `next(e)` resolves to `$` built so far. A step may ADD nouns and, outside `user`, WITHHOLD
> them (leave one out, or return without `next`). It fails, and its plugin unloads, when it
> REPLACES another's; in `user`, also past its own stub, or adding a seated name." — `TYPES:4465-4473`

A step is written in post-order:

> "`const built = await next(e)` is `$` as built so far; `return { ...built, voice: { say } }` adds
> this plugin's noun." — `TYPES:3901-3908` (`EngineCreateInput`)

What the step returns is `EngineCreateResult = Partial<EngineInterface> & { readonly [noun: string]: unknown }`
(`TYPES:3922-3930`). Inside the step `$` is `NoEngineInterface`: "Every property reads as `never`,
so `$.model` inside the hook is a compile error" (`TYPES:6676-6681`; the `Events` mapping at
`TYPES:4806`). A step therefore only wires functions; it calls nothing.

The noun is typed by declaration merging into `EngineInterface`:

> "`$`, the first parameter of every hook. Frozen; core's interface plus every noun the plugins'
> `engine.create` steps added. … An interface so a plugin types the noun it provides by declaration
> merging, the way a jQuery plugin types `$.fn`." — `TYPES:4476-4488`

`CoreEngineInterface` (`TYPES:2309-2331`) holds core's nouns and the plugin's identity
(`$.plugin.name`, `$.plugin.root`). A plugin noun may never be one of core's: `PluginNoun =
Exclude<keyof EngineInterface & string, keyof CoreEngineInterface | Namespace<CoreEventName>>`
(`TYPES:7641-7644`). `harnu` is not a core noun.

### 3.2 What a noun method is: an event, flat, one argument

> "The declared plugin nouns' methods as event rows (NounEventRow), one per `<noun>.<method>` that
> is a function; a member that is not is no event." — `TYPES:6710-6718`

> "One method of a declared plugin noun as an event row: its event's name, argument (the method's
> first parameter) and value (its awaited result)." — `TYPES:6743-6750`

> "The result of a declared plugin noun's event as its hooks see it: `{ value }` (the method's
> answer) or `{ deny }`." — `TYPES:6736-6740`

Consequences, all **verified** from those declarations:

- **Flat names.** `$.harnu.card.move` would make `card` a non-function member, which is "no event":
  not hookable, not typed as an event, not visible to an org's guard. The surface is one level:
  `$.harnu.cardMove`. This is a deliberate deviation from the dotted spelling in ideas 56 and 117.
- **One object argument.** Only the first parameter becomes the event's `e`. Every method takes a
  single object (or nothing).
- **Every call is hookable.** `$.harnu.cardMove(x)` raises the event `harnu.cardMove`; any plugin
  above may pass it on, rewrite it, answer it, or refuse it with `{ deny }`. An organization's
  managed plugin can therefore forbid `harnu.*` without Harnu's help.

Whether a nested object would even survive the chain ("Between hooks it crosses the chain as
interface descriptors", `TYPES:3925-3927`) is untested and irrelevant once the surface is flat.

### 3.3 The contract file a noun ships

> "A plugin that adds a noun to `$` ships its own contract: a .d.ts its plugin.json names as
> "types", exporting the noun's types at its top level and declaring the noun on the engine's
> interface, `export type Topo = { ... }` / `declare module 'claude-code' { interface
EngineInterface { topo: Topo } }` with no import or reference, its exported names led by the
> noun's PascalCase name; the plugin's own hooks module imports them from it." — `TYPES:91-99`
> (repeated in `REF:66`)

So the `harnu` mod ships `types/index.d.ts`, self-contained, every exported name starting with
`Harnu`, named in its manifest as `"types": "./types/index.d.ts"`. The same file also declares the
mod's `$.state` keys under `interface PluginState { harnu: { … } }`, as the companion does in
`resources/companion/types/index.d.ts:3-61`.

### 3.4 How a dependent mod gets the types

> "… and one entry per plugin the mod's plugin.json lists under "dependencies" (that plugin's own
> contract): what it adds to `$` in engine.create, so a plugin you depend on is typed with nothing
> copied." — `TYPES:78-84`

> "A plugin that depends on it never copies the file: it lists that plugin under `dependencies` in
> its own `plugin.json`, and each time the engine loads it from a folder it lays types in (above)
> it lays that plugin's contract into `.claude-plugin/types/<plugin>/index.d.ts`, so the noun is
> typed on the dependent's `$`; `claude plugin validate` checks the contract." — `REF:66`

The dependency is keyed by **plugin name**, which is why the new mod's manifest name is exactly
`harnu` (§4).

### 3.5 Who is calling: `next.origin`

> "Who raised this dispatch: the calling plugin's name and the tier it sits in (Origin) … Set by
> the host alone, from the environment the call came from (its own MessagePort) and that plugin's
> seat; nothing a plugin writes reaches it." — `TYPES:6576-6586`; `Origin = { plugin, tier }`
> at `TYPES:7323-7334`

Calls on `$` the host serves are events too: "A hook above the caller passes it on, rewrites it,
refuses it with `{ deny }` or answers with `{ value }`; core is the host's implementation. The
calling hook alone is skipped, and `next.origin` names the caller." (`TYPES:6825-6836`,
`OpEventOf`). This is what lets the noun name the mod that called it (§9.4).

### 3.6 `$.mcp.call`

> "Calls `tool` on one of the engine's connected MCP servers with the engine's own connection and
> credentials. A `cached` server is dialed on first use. No permission prompt: the plugin's call,
> seen by the hooks above it, is the grant." — `TYPES:2697-2718`

Two facts follow: the call only reaches a server **connected in that session** (none is connected
where Harnu withheld its `--mcp-config`), and Claude Code's own `mcp__harnu__*` allow rules do not
apply; Harnu's server-side gates do (§9.3). `$.mcp.connect` connects only "one of the MCP servers
this plugin's own manifest lists" (`TYPES:2719-2732`); the `harnu` mod lists none, on purpose
(SDK-S2, §9.6).

### 3.7 `$.state`: any plugin reads, the owner writes

> "A `get` made while a `ui.render` hook draws subscribes that instance: a later `set` draws it
> again … Any plugin reads any value; its owner alone writes it. Persist through `$.store`."
> — `TYPES:3376-3383`

This is the subscription primitive of §10 and the reason the noun can read the companion's
`sid` without a wire.

### 3.8 Minimum Claude Code version

- **Verified floor for this design: 2.1.295.** Every declaration quoted above was read in the
  2.1.295 file.
- The companion's window is `minCli` 2.1.287, `lastVerifiedCli` 2.1.292
  (`resources/companion/api-surface.json`). Whether `engine.create`, plugin nouns and `dependencies`
  type-laying exist between 2.1.287 and 2.1.294 is **not verified** (SDK-Q1). Until W0 answers it,
  the `harnu` mod's own `minCli` is **2.1.295**, and below it Harnu does not stage the mod at all.

### 3.9 Engine behaviours this design assumes (settled by the W0 spike)

| #   | Assumption                                                                                                                                                                                                                                                                   | Why it matters                                                                      | If false                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A1  | A `user`-tier plugin may add a noun. `TYPES:4471` says a `user` step fails when it goes "past its own stub, or adding a seated name"; what a "stub" and a "seated name" are for a fresh noun is not stated.                                                                  | The `harnu` mod is staged at `user` tier like the companion (T389/00-master.md:44). | The noun needs another tier, or Harnu stages the mod differently (SDK-Q2).                                     |
| A2  | The providing plugin can hook its own noun's events (`on('harnu.cardMove', …)`) and reads `next.origin` there.                                                                                                                                                               | Caller attribution (§9.4).                                                          | Attribution falls back to "unknown mod"; nothing else changes.                                                 |
| A3  | `dependencies` in `plugin.json` is a list of plugin names (`["harnu"]`), and resolves to a plugin loaded through `--plugin-dir` (`harnu@inline`).                                                                                                                            | Dependents load and are typed.                                                      | The `harnu` mod must be installed through a marketplace instead (SDK-Q3).                                      |
| A4  | A dependent whose dependency is absent still loads, with no `harnu` key on `$`.                                                                                                                                                                                              | The "no Harnu at all" row of §7.                                                    | If the engine refuses to load it, a third-party mod cannot run outside Harnu unless the user installs `harnu`. |
| A5  | In `claude plugin test`, a test's bottom hook on `harnu.<method>` answers a noun call when the providing plugin is not loaded.                                                                                                                                               | The dependent's test story (§12.1).                                                 | Dependents fake one level lower, at `mcp.call` (§12.1, fallback).                                              |
| A6  | A Harnu MCP refusal reaches `$.mcp.call` as `{ isError: true, content: [{ type: 'text', text }] }` with `text` a bare reason or JSON `{ error, message, nextActions }` (verified on the server side: `src/main/mcp/tool-result.ts:36-38`, `src/main/mcp/server.ts:335-353`). | Error mapping (§5.3).                                                               | The normaliser reads `isError` alone and reports `REFUSED` with no code.                                       |

## 4. Where the noun lives

**A new mod, `resources/harnu-sdk/`, whose manifest name is `harnu`.** Not inside
`resources/companion/`:

- The companion is forbidden `$.mcp.call` (T389/00-master.md SEC-9 (b); `docs/dev/companion-mod.md:59-60`
  "no `$.process`, no `$.mcp.call`"). The noun's writes need it (ADR-0019).
- The companion is a sensor that must stay small and readable (ADR-0018 Decision); a public API
  surface with its own versioning is a different product.
- Dependents name the dependency by plugin name. The companion's name is `harnu-companion`
  (`resources/companion/.claude-plugin/plugin.json`); ideas 56/117 and every future dependent say
  `harnu`.

```
resources/harnu-sdk/
  .claude-plugin/plugin.json   # { "name": "harnu", "version": "1.0.0", "types": "./types/index.d.ts", … }
  hooks/hooks.json             # { "modules": ["./register.ts"] }
  hooks/register.ts            # engine.create step + its own noun-event hooks + poll loop
  hooks/lib/*-core.ts          # $-free: verb mapping, result normaliser, diffing
  types/index.d.ts             # THE contract (§5): HarnuNoun, Harnu* types, PluginState['harnu']
  api-surface.json             # drift manifest, same role as the companion's
  tests/*.test.ts              # claude plugin test suites (§12.2)
```

**Staging.** Harnu stages it exactly like the companion (T389 D1: immutable, versioned, a dedicated
`--plugin-dir`), as a sibling `<userData>/companion/<stageKey>/harnu/`, and passes it as one more
`--plugin-dir` to every session where the companion is passed. Outside Harnu (P4W3's opt-in
switch), the same folder is appended to `CLAUDE_CODE_PLUGIN_DIRS` next to the companion's. When the
companion mode is `off`, the `harnu` mod is still staged (§7: its reads over MCP do not need the
companion).

## 5. API surface (AC-2)

### 5.1 The contract: `resources/harnu-sdk/types/index.d.ts`

The full TypeScript declarations are in [`01-contract.md`](01-contract.md), split out for length.
They are the proposed `resources/harnu-sdk/types/index.d.ts`. In short:

- `HarnuNoun`: 20 methods, flat, each taking one object argument (§3.2): `identity`,
  `capabilities`, `fleetGet`, `sessionGet`, `memoryRead`, `memoryQuery`, `memoryAppend`,
  `cardCreate`, `cardUpdate`, `cardMove`, `missionCurrent`, `missionStepClaim`, `missionLog`,
  `missionBlockerSet`, `missionBlockerClear`, `notify`, `speak`, `openFile`, `watch`, `unwatch`.
- `HarnuResult<T> = ({ ok: true } & T) | HarnuError`: no method rejects for a refusal. The error
  codes are `OUTSIDE_HARNU`, `NO_MCP`, `NO_IDENTITY`, `UNSUPPORTED`, `EXCLUDED`, `BAD_ARGS`,
  `FOLDER_NOT_ALLOWED`, `CONFIRM_DENIED`, `TIMEOUT` and `REFUSED`, with Harnu's own code in
  `serverCode`.
- `HarnuIdentity` (`env`, `inside`, `sessionId?`, `folder`, `companion`, `mcp`, `sdk`) and
  `HarnuEnv = inside | inside-no-mcp | outside | no-harnu` (§7).
- `HarnuFreshness` (`source`, `fetchedAt`, `stale`) on every value a read or cache returns (§10).
- `declare module 'claude-code'`: `EngineInterface { harnu: HarnuNoun }` and
  `PluginState { harnu: { identity, fleet, mission, memory, writes } }`.

Notes on the shape:

- `identity` and `capabilities` never fail: they describe the environment.
- No method takes `folder`. The noun pins `identity.folder` at `session.start` and passes it to
  every folder-scoped verb. A mod that wants another folder is asking for a cross-folder actor,
  which is what the orchestration verbs are for, and those are excluded (§9.1).
- No method takes `sessionId` for itself: `notify`, `speak` and `missionCurrent` fill this
  session's id from `identity.sessionId`.
- `missionStepClaim` is `mission_update_step` with `set.proof: 'claimed'` fixed. Retitling a step
  and every other `set` key are out (§9.1).

### 5.2 Method → verb mapping

Every verb name below is the exact `name` in `TC` (line of its definition in parentheses).

| Method                | Transport (ADR-0019)                       | Verb / source                                                                                                                    | Fixed or filled arguments                                                                |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `identity`            | local                                      | `$.state` `harnu-companion.sid` (companion contract `types/index.d.ts:10`), `$.env.get('HARNU_SPAWN_TOKEN')` presence, MCP probe | none                                                                                     |
| `capabilities`        | local + MCP probe                          | the noun's own method list; the verbs probed once per session                                                                    | none                                                                                     |
| `fleetGet`            | MCP                                        | `get_fleet` (TC:470)                                                                                                             | none                                                                                     |
| `sessionGet`          | MCP                                        | `get_session` (TC:497)                                                                                                           | `sessionId` defaults to `identity.sessionId`                                             |
| `memoryRead`          | MCP; disk outside (§7)                     | `memory_read` (TC:669)                                                                                                           | `folder`                                                                                 |
| `memoryQuery`         | MCP; disk outside (§7)                     | `memory_query` (TC:719)                                                                                                          | `folder`                                                                                 |
| `memoryAppend`        | MCP                                        | `memory_append` (TC:691)                                                                                                         | `folder`; `page` limited to `decisions`, `sessions/<slug>`                               |
| `cardCreate`          | MCP                                        | `create_card` (TC:856)                                                                                                           | `folder`; no `images`, no `substrate`                                                    |
| `cardUpdate`          | MCP                                        | `update_card` (TC:908)                                                                                                           | `folder`; `set` keys of `HarnuCardFields`; no `replaceBody`, no `images`, no `substrate` |
| `cardMove`            | MCP                                        | `move_card` (TC:959)                                                                                                             | `folder`; `to` ∈ `backlog`/`ready`/`review` (the verb's own enum)                        |
| `missionCurrent`      | MCP                                        | `mission_get` (TC:1384)                                                                                                          | `folder`, `ownerSessionId = identity.sessionId`                                          |
| `missionStepClaim`    | MCP                                        | `mission_update_step` (TC:1464)                                                                                                  | `folder`, `set: { proof: 'claimed' }`                                                    |
| `missionLog`          | MCP                                        | `mission_log` (TC:1513)                                                                                                          | `folder`                                                                                 |
| `missionBlockerSet`   | MCP                                        | `mission_set_blocker` (TC:1531)                                                                                                  | `folder`                                                                                 |
| `missionBlockerClear` | MCP                                        | `mission_clear_blocker` (TC:1553)                                                                                                | `folder`; by `reason` only (never `index`, which races)                                  |
| `notify`              | MCP                                        | `notify` (TC:799)                                                                                                                | `folder`, `sessionId = identity.sessionId`                                               |
| `speak`               | MCP                                        | `speak` (TC:826)                                                                                                                 | `folder`, `sessionId = identity.sessionId`                                               |
| `openFile`            | MCP                                        | `open_file` (TC:735)                                                                                                             | `folder`                                                                                 |
| `watch` / `unwatch`   | local poll (v1); channel invalidation (v2) | the same read verbs on a timer (§10)                                                                                             | none                                                                                     |

No method uses the Harnu mod command channel for a call: that channel carries host → mod commands
only (§8). The channel appears once, in v2, as the source of a change notification (§10.3).

### 5.3 Result normalisation

The noun turns every `$.mcp.call` outcome into `HarnuResult`, never a rejection:

1. `$.mcp.call` rejects because no `harnu` server is connected → `NO_MCP` when `env` is
   `inside-no-mcp`, `OUTSIDE_HARNU` otherwise.
2. `isError: true` → parse the first text block as JSON. `error === 'FOLDER_NOT_ALLOWED'` →
   `FOLDER_NOT_ALLOWED`; a confirm denial (`CONFIRM_<reason>`, `src/main/mcp/server.ts:198-208`) →
   `CONFIRM_DENIED`; `TOOL_TIMEOUT` → `TIMEOUT`; an unknown-tool reply → `UNSUPPORTED`; anything
   else → `REFUSED` with `serverCode`. A bare-string reason is treated as `serverCode` with the same
   table.
3. Success → parse the JSON ACK. An ACK with `ok: false` is a refusal, not a success (the rule of
   `docs/lessons/code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md`, applied in
   `ackIsSuccess`, `src/main/mcp/tool-result.ts:49-62`).
4. `CALL_IN_FLIGHT` (a retry while the first call still runs, `docs/harnu-features.md`) is retried
   once after 1 s by the noun, then reported as `TIMEOUT`.

## 6. Hook budget and latency

A hook's budget "stands still while a `next` or `$` call of the hook's is in flight"
(`TYPES:6600`), so a dependent awaiting `$.harnu.cardMove` inside its own hook does not burn its
budget while Harnu holds a confirm. The server's own deadline is 120 s per call (`TOOL_TIMEOUT`,
`docs/harnu-features.md`). The MCP round trip is a loopback HTTP request; its latency inside a
session is **not measured** (SDK-Q7, measured in W0). Reads that a render path needs go through
the `$.state` cache (§10), never through a live call while drawing.

## 7. Environments and degradation (AC-3)

### 7.1 The environments and how the noun detects them

| Env             | Detection (in order, at `session.start`, re-checked on failure)                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inside`        | `$.env.get('HARNU_SPAWN_TOKEN')` is set (the one env var the companion reads, T389/P1W3:474) **and** a probe `get_fleet` over `$.mcp.call('harnu', …)` answers.                                           |
| `inside-no-mcp` | Token set, the probe rejects because no `harnu` server is connected. This is the `agentControlled` and read-only spawn: Harnu withholds `--mcp-config` (`src/main/pty.ts:252-261`, T389 SEC-9 (g)).       |
| `outside`       | No token. Includes a session started from a terminal with P4W3's switch on, and a nested `claude` that inherited a spent token (T389/P4W3:186-187; the companion goes dormant there, so `sid` is absent). |
| `no-harnu`      | Token or not, the probe fails with a connection error (Harnu quit or restarting).                                                                                                                         |

The token's value is never read into the noun's state, logged or returned; only its presence
(SEC-8 of the T389 master applies to the noun too, SDK-S5).

**The companion state is orthogonal.** The user sees the companion as `live`, `legacy` or `off`
(T389/P1W3:482; the internal modes are `off | shadow | active`, T389/00-master.md:57, :713). The
only thing the noun takes from the companion is `sessionId` (its bound `sid`):

- companion `live` → `sid` present → `sessionId` known.
- companion `legacy` (loaded but not authoritative: shadow, above the tested CLI ceiling, inert
  after a kill switch) → `sid` may or may not be present; the noun uses it when present.
- companion `off` (not loaded) → no `sid` → `sessionId` absent → methods that need it answer
  `NO_IDENTITY`; every other method works unchanged over MCP.

### 7.2 Per-method behaviour

`NI` = `NO_IDENTITY` when `sessionId` is unknown. "Disk" reads `.harnu/memory/` under the session
root through `$.fs.read`, read-only; the legacy `.capy/` is never read.

| Method                                  | `inside`                   | `inside-no-mcp`                                                  | `outside`                                                                    | `no-harnu`                                             |
| --------------------------------------- | -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `identity`                              | full                       | full, `mcp: false`                                               | `inside: false`, no `sessionId`                                              | `inside` per token, `mcp: false`                       |
| `capabilities`                          | full                       | `verbs: []`                                                      | `verbs: []`                                                                  | `verbs: []`                                            |
| `fleetGet`                              | MCP                        | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | last cached value, `stale: true`; else `OUTSIDE_HARNU` |
| `sessionGet`                            | MCP (`NI` without an arg)  | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | cached, `stale: true`, or `OUTSIDE_HARNU`              |
| `memoryRead`                            | MCP                        | **disk**, `source: 'disk'`                                       | **disk**                                                                     | **disk**                                               |
| `memoryQuery`                           | MCP                        | **disk** (case-insensitive substring, same contract as the verb) | **disk**                                                                     | **disk**                                               |
| `memoryAppend`                          | MCP                        | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | `OUTSIDE_HARNU`                                        |
| `cardCreate/Update/Move`                | MCP                        | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | `OUTSIDE_HARNU`                                        |
| `missionCurrent`                        | MCP (`NI`)                 | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | cached, `stale: true`, or `OUTSIDE_HARNU`              |
| `missionStepClaim/Log/BlockerSet/Clear` | MCP                        | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | `OUTSIDE_HARNU`                                        |
| `notify`, `speak`                       | MCP (`sessionId` optional) | `NO_MCP`                                                         | `OUTSIDE_HARNU` (a dependent may use `$.ui.notify` / `$.audio.speak` itself) | `OUTSIDE_HARNU`                                        |
| `openFile`                              | MCP                        | `NO_MCP`                                                         | `OUTSIDE_HARNU`                                                              | `OUTSIDE_HARNU`                                        |
| `watch`                                 | polls                      | `memory` topic polls disk; others `NO_MCP`                       | `memory` polls disk; others `OUTSIDE_HARNU`                                  | keeps polling with backoff                             |

Rules behind the table:

- **Writes never fall back to disk.** Writing `.harnu/memory/` or a card file directly skips
  provenance stamping and the `done`/`approved` gates (`docs/harnu-features.md`, "Never hand-write
  a card file"). A dependent that must keep something while outside keeps it in its own `$.store`.
- **No write is queued for later.** A queued write replayed when Harnu comes back would act under
  a gate state the operator never saw. A refusal is final; the dependent decides.
- **Mission and fleet are never read from disk.** A mission's progress is derived live by the
  server (`derived.progress`); a disk read would show a number the operator does not see.
- **`inside-no-mcp` is a deliberate refusal, not an outage.** The disk read of memory is allowed
  there because a read-only spawn can already `Read` those files with its own tools; nothing new
  is disclosed.
- **A write that never reached Harnu says so.** `OUTSIDE_HARNU` and `NO_MCP` are distinct so a
  dependent can tell "Harnu said no" from "Harnu never heard".

## 8. Transport (AC-4)

Decided in [ADR-0019](../../adr/0019-harnu-sdk-noun-transport.md). In one table:

| Concern                   | `$.mcp.call('harnu', …)` (chosen for calls)                | Companion command channel (T389/P2W1)                                                                  |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Direction                 | mod → Harnu, request/response                              | host → mod only; "No HTTP route, MCP verb or companion endpoint may add a command" (T389/P2W1:431-432) |
| Gates                     | every existing gate (§9.3)                                 | origin-gated closed enum (SEC-5); none of the verbs exist as commands                                  |
| Agent-dispatched sessions | absent where Harnu withheld MCP, as intended (SEC-9 (g))   | present, which is exactly why it must not carry verbs                                                  |
| Audit                     | `AuditRecord` per call (`src/main/mcp/audit-log.ts:13-34`) | `<userData>/companion/audit.ndjson` per command (SEC-6)                                                |
| Latency                   | one loopback HTTP round trip, unmeasured (SDK-Q7)          | 0–2 ms enqueue-to-mod on a held poll (T389/P2W1:48), but in the wrong direction                        |
| Failure modes             | server off, port changed, confirm pending up to 120 s      | `NO_BINDING`, `resync`, lost commands (T389/P2W1:154, :413, :420)                                      |

The channel is used in v2 for one host → mod notification only: "topic changed, re-read it"
(§10.3), carrying no data, which fits SEC-5's closed enum.

## 9. Security and permissions (AC-5)

### 9.1 Reachable and excluded verbs

Of the 50 verbs in `TC` (`MCP_TOOLS`, TC:468-1706), the noun reaches **16** in v1 and never offers
the other 34. The test for "offered": the action is scoped to this session's own folder, it is not
operator-only, and it cannot start, spend or delete anything.

| Verb(s)                                                                                                                                | In the noun         | Why                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `get_fleet`, `get_session`, `memory_read`, `memory_query`, `mission_get`                                                               | yes (read)          | Reads; `get_fleet`/`get_session` already redact paths to aliases.                                                    |
| `memory_append` (pages `decisions`, `sessions/<slug>`)                                                                                 | yes                 | Append-only with server-stamped provenance.                                                                          |
| `memory_append` to `hot` or `roadmap/<slug>`                                                                                           | **no** (`EXCLUDED`) | `hot` is a full replace; a roadmap append voids an approval stamp.                                                   |
| `create_card`, `update_card` (`set`, `appendBody`), `move_card`                                                                        | yes                 | Backlog-born cards; `move_card` cannot reach `done` or `in-progress` by its own schema.                              |
| `update_card` `replaceBody`, `images`; `create_card` `images`; `substrate` on either                                                   | **no**              | `replaceBody` drops content; `images` copies files from outside the repo; `substrate` decides where a dispatch runs. |
| `mission_update_step` (`proof: 'claimed'` only), `mission_log`, `mission_set_blocker`, `mission_clear_blocker`                         | yes                 | The record of the mission this session works on; never verifies anything.                                            |
| `notify`, `speak`, `open_file`                                                                                                         | yes                 | Operator signals; `speak` has its own operator switch.                                                               |
| `delete_card`, `delete_worker`, `remove_containers`, `plan_mission`                                                                    | **no**              | Always confirm, irreversible or mint a grant (TC:992, :1298, :1232, :644).                                           |
| `create_worker`, `update_worker`, `stop_containers`                                                                                    | **no**              | Confirm on risky input; a worker is an unattended second body.                                                       |
| `create_session`, `create_worktree`, `spawn_terminal`, `submit_manifest`, `message_session`, `orchestrator_arm`, `orchestrator_disarm` | **no**              | Orchestration: starting work or steering another session is the orchestrator's job, not a mod's.                     |
| `adopt_folder`, `remove_folder`, `release_worktree`, `archive_card`, `start_containers`, `draw_canvas`                                 | **no** (v1)         | Not needed by the ideas that motivate the noun; candidates for a later minor (SDK-Q6).                               |
| `mission_create`, `mission_add_step`, `mission_link_child`, `mission_set_end`, `mission_import_legacy`, `mission_add_check`            | **no**              | Shaping a mission is the owner session's act, agreed with the operator in chat.                                      |
| `mission_verify_step`, `mission_request_close`                                                                                         | **no**              | Verification must come from an independent session; a mod in the executor would launder self-verification.           |
| `get_approval`, `list_worktrees`, `mission_list`, `list_workers`, `list_containers`, `list_cleanup`                                    | **no** (v1)         | Operator-facing views; candidates for a read-only later minor.                                                       |

### 9.2 The exclusion is an API choice, not a boundary

A third-party mod can always call `$.mcp.call('harnu', 'delete_card', …)` itself: mods of one tier
are not isolated (ADR-0018 Decision 3), and `$.mcp.call` needs no permission (§3.6). What protects
the operator is what protected them before the noun existed: Harnu's server-side gates. The noun
adds two things on top, both defence in depth:

1. **A guard on `mcp.call`.** The `harnu` mod hooks the `mcp.call` op event for `server ∈ {harnu,
capy}` and answers `{ deny }` when the caller (`next.origin.plugin`) is neither `harnu` nor
   `engine` and the tool is one of the "always confirm" verbs (`delete_card`, `delete_worker`,
   `remove_containers`, `plan_mission`). It sits at the same tier as the caller, so it is a speed
   bump: a mod that loads above it, or a `prepend` org plugin, passes. Written with a `.catch` that
   denies (REF:79), so a failing guard does not fail open.
2. **Honest surfacing.** Settings → Mods shows a mod that calls `$.mcp.call` directly with the
   existing `mcp` chip ("can call MCP tools"), and one that only uses the noun with the new chips
   of §9.5, so the operator sees the difference.

### 9.3 Existing gates, applied to noun calls

A call through the noun is an ordinary MCP call on the server, so nothing new is needed and
nothing is relaxed:

- **`FOLDER_NOT_ALLOWED`.** Evaluated by `evaluateToolCall` before anything else after the kill
  switch (`src/main/mcp/permission-core.ts:206-242`, blocked folder at :216), reads included, and
  nothing overrides it (`explicitBlock`, `src/main/mcp/plan-tool-call.ts:241, :274`). The noun maps
  it to `FOLDER_NOT_ALLOWED` and never retries.
- **"Ask before agent actions".** When on, every mutation becomes a confirm
  (`permission-core.ts:241`) and parks in the Approval Inbox (`src/main/mcp/server.ts:1148`). The
  dependent's `await` waits for the operator; the server's 120 s deadline ends it as `TIMEOUT`. The
  noun never calls `plan_mission` to buy a grant; under a grant a dependent's write spends the
  grant's budget like any agent's.
- **Per-verb confirms.** All four always-confirm verbs are excluded (§9.1), and none of the three
  confirm-on-risky-input verbs is offered, so a noun call never raises a confirm except through
  "Ask".
- **"Always allow this verb here".** Unchanged: a durable `mcp__harnu__<op>` rule in
  `settings.local.json` (`src/main/mcp/settings-local.ts:28-43`) applies to noun calls as to any.
- **Withheld MCP.** Respected by construction (§7.1, SDK-S2).

### 9.4 Identifying the calling mod, and audit attribution

Today an `AuditRecord` carries `ts, tool, folder, verdict, disclosedPayloadSummary, result,
callId?` and no caller (`src/main/mcp/audit-log.ts:13-34`). T389/P2W5 (specified, **not shipped**)
adds `caller: { attributed, sessionId?, agentId?, stamp }` from a stamp the companion injects on
`tool.call` for `mcp__harnu__*` (T389/P2W5:86-99), and states that "Another mod's `$.mcp.call` …
→ unstamped" (T389/P2W5:271), because a plugin's `$.mcp.call` raises the `mcp.call` op event, not
`tool.call`.

This spec proposes, as an **amendment to P2W5** (not a parallel mechanism, contract §18):

1. **Stamp `mcp.call` too.** The companion hooks the `mcp.call` op event for `server ∈ {harnu,
capy}` with the same stamp code it uses on `tool.call`. Hooking an event is not calling
   `$.mcp.call`, so SEC-9 (b) holds. Every plugin's call into Harnu, through the noun or not, then
   carries the session stamp.
2. **Add `via`.** The stamp carries `via: { plugin, tier }` copied from `next.origin` (`TYPES:6576-6586`),
   which the host sets and no plugin writes. The server records it as `caller.via` in the
   `AuditRecord`. The `harnu` mod's own hooks on `harnu.<method>` (assumption A2) pass the
   dependent's name down, so a noun call is recorded as `via: { plugin: '<dependent>' }` rather than
   `via: { plugin: 'harnu' }`.
3. **Attribution, not authentication.** As in P2W5 (:278-286), no gate reads `via`. The Approval
   Inbox and the audit pane show it as "via mod `<name>`". A mod at the same tier can forge the
   stamp argument of a direct `$.mcp.call`; it cannot forge `next.origin`, but the record of a call
   whose stamp did not come through the companion's hook says `declared`, as P2W5 already defines.

Until P2W5 ships, noun calls are recorded like any other MCP call, with no caller. The noun does
not invent its own audit file (SEC-6 puts audit on Harnu's side).

### 9.5 What Settings → Mods shows

The Mods tab reads each mod with `claude plugin validate <root> --json` and turns what it hooks and
calls into chips (T389/P4W1:203-224, chips at :244-260; `docs/user/mods.md:35-51`). Proposed
additions (a P4W1 follow-up, W4 below):

- **`harnu-read`** — "can read your Harnu fleet, memory and missions", when the scan lists any call
  to a read method of `$.harnu`.
- **`harnu-write`** — "can write to your Harnu board, memory and missions", when it lists any write
  method. The method → chip table lives in `api-surface.json` of the `harnu` mod, so the analyzer
  never hard-codes method names.
- **Depends on `harnu`** — a plain label from the manifest's `dependencies`, beside the source
  label (T389/P4W1:134-140).
- The `harnu` mod's own row: chips `mcp` ("can call MCP tools"), `files` (the disk fallback),
  `gate` (the guard of §9.2), `env` (the token presence), `other-mods` (it reads the companion's
  state). Its source label is `harnu`, like the companion's.

Wording follows SEC-7: "can", never "safe" or "verified". A dependent never shows a "trusted"
mark because it uses the noun.

### 9.6 Rules for the `harnu` mod (SDK-S1 … SDK-S8)

- **SDK-S1.** No method takes a raw verb name, a raw argument bag or a folder. There is no
  `$.harnu.call(verb, args)` escape hatch (ADR-0002 §2.1's "no generic invoke" rule, applied here).
- **SDK-S2.** The manifest lists no MCP server; the mod never calls `$.mcp.connect`. Where Harnu
  withheld its server, the noun has no route to it.
- **SDK-S3.** No `$.process`, no `$.http.fetch`, no `tool.call` hook, no `'*'` event. Its only
  outbound path is `$.mcp.call('harnu', …)`.
- **SDK-S4.** Disk access is read-only and limited to `<root>/.harnu/memory/**`.
- **SDK-S5.** The spawn token's value is never stored, returned or logged; only its presence.
- **SDK-S6.** `$.state` keys hold only what the noun's reads return (already redacted by the
  server: aliases, no absolute paths). Any plugin can read them (§3.7).
- **SDK-S7.** Every hook returns `next(e)` on failure; the guard of §9.2 is the one gating hook and
  denies on failure.
- **SDK-S8.** `api-surface.json` lists every `$` call, hook and state key; a test fails on drift, as
  for the companion (`tests/companion/api-surface.test.ts`).

## 10. Reads, caching and subscriptions (AC-6)

### 10.1 Cache

- A method call always goes to the source (MCP or disk) and, on success, writes the matching
  `$.state` key (`fleet`, `mission`, `memory` for `hot`) with `HarnuFreshness`. It never answers
  from cache while the source is reachable.
- When the source fails with a transport error (`no-harnu`), read methods answer the last cached
  value with `stale: true` (§7.2). A refusal (`FOLDER_NOT_ALLOWED`, `NO_MCP`) clears the key to
  `null`: a value the operator has since blocked is not served from cache.
- `identity` is written once at `session.start` and again whenever detection changes.
- `$.state` survives a hot reload of the mod (`TYPES:3376-3383`); whether it survives `/clear` or
  a process restart is the companion's open CQ3 (T389/01-contract.md:1318-1322). The noun rewrites
  every key on `session.start`, so the answer does not change correctness.

### 10.2 Subscribing, v1: a watched poll

`watch({ topic })` starts one `$.clock.every` loop per topic in the `harnu` mod (reference-counted
across callers; `unwatch` decrements). Defaults, configurable through the mod's `userConfig`:

| Topic     | Verb                        | Interval | Write rule                                                                 |
| --------- | --------------------------- | -------- | -------------------------------------------------------------------------- |
| `fleet`   | `get_fleet`                 | 5 s      | Write `harnu.fleet` only when the normalised value differs (hash compare). |
| `mission` | `mission_get` (own mission) | 10 s     | Same.                                                                      |
| `memory`  | `memory_read` (`hot`)       | 30 s     | Same.                                                                      |

On consecutive failures the interval doubles up to 60 s and resets on success. A topic with no
watcher polls nothing. The loop dies with the module on reload (`TYPES` `clock` noun doc,
`TYPES:3418-3425`); `session.start` restarts the topics recorded in `$.state`.

A dependent consumes it two ways, both engine primitives:

- **While drawing.** `read($, atom({ plugin: 'harnu', key: 'mission' }, null))` or
  `$.state.get(...)` inside a `ui.render` hook subscribes the drawing; the next write redraws it
  (`TYPES:3376-3383`). `derive([missionAtom], m => …)` computes from it, cached by version
  (`TYPES:14703-14709`).
- **Outside drawing.** Hook the `state.set` op event (`TYPES:7122`) and filter on the `harnu`
  plugin's keys: every write the `harnu` mod makes is a dispatch any plugin can observe. This
  replaces idea 117's `$.harnu.on('fleet', cb)`, which a noun cannot offer (a callback argument is
  not plain data; §3.2).

### 10.3 Subscribing, v2: invalidation over the command channel

The poll costs a loopback call per topic per interval per session. v2 removes it without moving
data over the channel:

- A new command `sdk.invalidate { topic: 'fleet' | 'mission' | 'memory' }` is registered through
  `registerGateRow` with cause `internal` (T389/P2W1:283-287, :205-208). It carries an enum and
  nothing else (SEC-5 (a)).
- Harnu main enqueues it when its own stores change: the fleet reducer, a mission write, a memory
  write. Debounced per binding, like `ui.band.set` (T389/P4W2:165-167).
- The **companion** runs it by bumping `harnu-companion.invalidate[topic]` in its own `$.state`.
  The `harnu` mod observes that key (`state.set`) and re-reads the topic once over MCP.
- Where the companion is not `live`, or a binding does not poll (headless), v1's poll stays the
  fallback, at a slower interval (fleet 15 s, mission 30 s).

### 10.4 Staleness rules for dependents

- Every value carries `fetchedAt` and `stale`. A dependent that acts on a cached value re-reads
  through the method first; the cache is for drawing.
- `harnu.writes` increments on every successful write through the noun, so a dependent can
  `derive` "something changed through the SDK" without polling.

## 11. Versioning and capability detection (AC-7)

### 11.1 Where the contract lives

`resources/harnu-sdk/types/index.d.ts` is the contract (§5.1). The engine copies it into every
dependent at `.claude-plugin/types/harnu/index.d.ts` (§3.4), so dependents always type against the
version actually loaded, never a vendored copy. User-facing docs (`docs/user/`) link to it; it is
the one place the shapes are written (`TYPES:91-99`).

### 11.2 Versions

- **SDK version:** SemVer in the mod's `plugin.json` `version`, mirrored as `HARNU_SDK_VERSION` in
  the module and returned by `identity().sdk` and `capabilities().sdk`.
  - **Minor:** a new method, a new optional argument, a new error code, a new `$.state` key, a new
    optional result field. Dependents ignore what they do not know.
  - **Major:** removing or renaming a method, retyping a field, narrowing an argument, changing a
    meaning. Two majors cannot be staged side by side, since dependents name one plugin, `harnu`.
    So a major keeps the previous major's method names as deprecated aliases for one Harnu
    release, and `capabilities().methods` lists both until the aliases are removed.
- **Server side:** the noun depends only on verb names and fields that `docs/harnu-features.md`
  already promises. A verb's removal or rename is an agent-facing change there (CLAUDE.md
  "Self-awareness doc is mandatory") and must bump the SDK major or keep a mapping.
- **Claude Code side:** `api-surface.json` holds `minCli` and `lastVerifiedCli`, enforced like the
  companion's (`docs/dev/companion-mod.md:95-97`). Above `lastVerifiedCli` Harnu still stages the
  mod (unlike the companion, it carries no sensor that could disagree with legacy) but the Mods tab
  shows "not yet checked on this Claude Code".

### 11.3 Detecting what is present

A dependent decides at run time, in this order:

1. **Is the noun there?** `'harnu' in $` (assumption A4: the dependent loads without it). The
   contract declares `harnu` as a required member of `EngineInterface`, because an optional one
   would not map to events (`NounEvent`, `TYPES:6710-6718`). The type says "present"; this check
   is what makes it true at run time.
2. **Which methods?** `(await $.harnu.capabilities()).methods.includes('missionStepClaim')`.
   Calling a method the loaded build lacks is a type error at author time against an older
   contract, and at run time the property is `undefined`; `capabilities()` avoids both.
3. **Which verbs does this Harnu serve?** `capabilities().verbs`, probed once per session. A
   method whose verb is missing answers `UNSUPPORTED` without a call.
4. **Where am I?** `identity().env`.

## 12. Testing (AC-8)

### 12.1 A third-party mod testing against the noun

`claude plugin test <folder>` runs the mod's `*.test.ts` against the engine; "a test holds the
engine's `$` and an `on` whose hooks sit beneath the plugin" (`REF:81`), imported from
`claude-code/testing` (`TYPES:14874`; `test` at `TYPES:15921`, `TestBody = ($, on) => unknown` at
`TYPES:15931`). Two ways to fake the noun:

- **Primary: answer the noun's events.** Each method is an event (§3.2), so the test's bottom hook
  stands for it: `on('harnu.memoryAppend', () => ({ value: { ok: true, page: 'decisions' } }))`.
  `{ deny }` simulates an org guard. Depends on A5.
- **Fallback: answer `mcp.call`.** If A5 fails, the test loads the real `harnu` mod beside the
  dependent and fakes one level lower: `on('mcp.call', (_$, e) => …)` answering by `e.tool`, which
  is how the noun itself is tested (§12.2).

Harnu ships `fake-harnu.ts` as a copyable file in `docs/user/` (W5): a function
`fakeHarnu(on, fixture)` that registers one bottom hook per method from a fixture object
(`{ env, identity, fleet, mission, memory, refuse: { cardMove: 'FOLDER_NOT_ALLOWED' } }`), plus the
fixtures for each environment of §7. It is copied, not imported: a plugin imports only its own
files (`docs/dev/companion-mod.md:57`).

### 12.2 Harnu testing the noun

Consistent with the companion's layers (`resources/companion/tests/`, `tests/support/rig.ts`
`installRig(on)`, `tests/companion/*.test.ts`, `tests/cli/*.cli.test.ts`):

- **L1, pure (vitest).** `hooks/lib/*-core.ts`: the method → verb table, argument filtering
  (`EXCLUDED` pages and keys), the result normaliser (every row of §5.3, with recorded server
  replies as golden fixtures), the environment classifier, hash-compare for watch writes.
- **L2, drift (vitest).** `api-surface.json` against the module source and against `TC`: every
  verb in §5.2 exists with the argument names the noun sends. A catalog rename fails here first.
- **L3, mod (`claude plugin test`).** A rig like the companion's: `mock.env` for the token,
  `mock.clock` for the poll, an `on('mcp.call')` bottom hook as a scripted Harnu server (answers,
  refusals, rejections, hangs), `fs.read` for the disk fallback, in-memory `state`. One suite per
  environment row of §7.2, plus the guard of §9.2 (a fake plugin calling `delete_card` directly is
  denied; `harnu` itself is not). The `mod` CI step (`scripts/ci/mod-step.mjs`) validates and
  tests the new folder like the companion's.
- **L4, real CLI (gated by `HARNU_WITH_CLI=1`).** A real `claude` with the staged `harnu` mod and a
  fixture dependent: the dependent's types are laid (A3), a `cardMove` lands on a throwaway board,
  `FOLDER_NOT_ALLOWED` maps, an `agentControlled` spawn answers `NO_MCP`.

## 13. Relation to T389 (AC-9)

The noun adds a consumer-facing layer; it re-specifies nothing T389 owns.

| T389 wave                                              | Relation                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1W1** host server (shipped)                         | Not used for calls. The noun does not talk to `c.sock`.                                                                                                                                                                                                                      |
| **P1W2** skeleton, staging, version gate (shipped)     | **Reused.** The `harnu` mod is staged by the same machinery (immutable `<stageKey>` dirs, `--plugin-dir`), has its own `api-surface.json` and joins the `mod` CI step. W1 extends staging; it does not copy it.                                                              |
| **P1W3** handshake and identity (shipped)              | **Read-only consumer.** `identity.sessionId` is the companion's bound `sid` (`harnu-companion` state). The noun never hellos, never holds `conn`, never sees the token's value.                                                                                              |
| **P1W5** fleet state (shipped)                         | Independent. `fleetGet` reads the host's fleet over `get_fleet`; the companion's `$.state.fleet` is per-session sensor state, not the fleet, and the noun does not re-export it.                                                                                             |
| **P2W1** command channel (shipped)                     | **Overlap resolved by ADR-0019:** not a call transport (host → mod only, P2W1:431-432). v2 adds one command, `sdk.invalidate`, through its existing `registerGateRow` path (§10.3).                                                                                          |
| **P2W5** MCP caller attribution (not shipped)          | **Builds on, with an amendment:** stamp the `mcp.call` op event as well as `tool.call`, and carry `via: { plugin, tier }` from `next.origin` (§9.4). The stamp format, `verifyStamp`, `CallerAttribution` and audit wording stay P2W5's.                                     |
| **P4W1** Mods audit tab (shipped)                      | **Extends:** two chips and a "depends on" label (§9.5); the analyzer reads the method → chip table from the `harnu` mod's `api-surface.json`.                                                                                                                                |
| **P4W2** terminal band and `/harnu-link` (not shipped) | **Overlap, kept apart:** the band is the companion's (`$.state.band`, pushed by `ui.band.set`). The noun does not draw. A third-party band built on `harnu.mission` (§14) is a different mod; P4W2's band stays the first-party one and never shows inside Harnu (P4W2:178). |
| **P4W3** Harnu mod outside Harnu (shipped)             | **Reused:** the same switch appends the `harnu` folder to `CLAUDE_CODE_PLUGIN_DIRS` next to the companion's, same undo record. The `outside` row of §7 is what that session sees.                                                                                            |
| P2W2, P2W3, P2W4, P3W1, P3W2, P4W4, P4W5, P5W1         | No relation in v1. P2W3 (messaging) is why `message_session` is not in the noun yet (SDK-Q6).                                                                                                                                                                                |

What lives where:

- `resources/companion/` (`harnu-companion`): unchanged in v1. In v2 it gains the `sdk.invalidate`
  command and an `invalidate` state key; with P2W5 it gains the `mcp.call` stamp hook.
- `resources/harnu-sdk/` (`harnu`): new. The noun, its contract, its tests.
- `src/main/companion/`: staging of the second folder, `sdk.invalidate` enqueue (v2).
- `src/main/mcp/`: nothing for v1; `caller.via` on `AuditRecord` with P2W5.

## 14. Worked example: `decision-log` (AC-10)

The complete example (the three files, the hooks module and a test) is in
[`02-worked-example.md`](02-worked-example.md), split out for length. It is a third-party mod that
records decisions to Harnu memory with `/decide`, keeps them locally when Harnu is not there, and
draws the session's mission step above the prompt: a command, a write, a typed refusal, the
outside fallback and a subscription.

## 15. Implementation outline (AC-11)

Sizes: S ≤ 1 day, M 2–4 days, L a week or more. An outline only; no cards are created.

| Wave | Content                                                                                                                                                                                                                                          | Size | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------- |
| W0   | **Spike.** A throwaway `harnu` mod with one method and a throwaway dependent, on 2.1.295 and on 2.1.287: settles A1–A6 and SDK-Q1/2/3/7, measures the `$.mcp.call` round trip. Output: an evidence note under `docs/specs/T447-harnu-sdk-noun/`. | S    | —          |
| W1   | **The mod and its staging.** `resources/harnu-sdk/` with the contract, `identity`, `capabilities`, the read methods, the result normaliser, L1–L3 tests, `api-surface.json`, the `mod` CI step, staging beside the companion.                    | M    | W0         |
| W2   | **Writes.** Memory, card and mission writes, `notify`/`speak`/`openFile`, the `EXCLUDED` filters, the `mcp.call` guard of §9.2, L4 suite. Agent-facing: `docs/harnu-features.md` + marker bump; `docs/user/` page; CHANGELOG.                    | M    | W1         |
| W3   | **Subscriptions v1.** `watch`/`unwatch`, the poll loop, hash-compare writes, staleness, backoff.                                                                                                                                                 | S    | W1         |
| W4   | **Mods tab.** `harnu-read`/`harnu-write` chips and the "depends on" label (P4W1 follow-up).                                                                                                                                                      | S    | W2         |
| W5   | **Dependent kit.** `fake-harnu.ts`, environment fixtures, the `decision-log` example validated and tested, user docs for mod authors.                                                                                                            | S    | W2, W3     |
| W6   | **Attribution.** The P2W5 amendment (§9.4): `mcp.call` stamp + `via`. Ships with or after P2W5, owned there.                                                                                                                                     | M    | P2W5, W2   |
| W7   | **Subscriptions v2.** `sdk.invalidate` command, companion `invalidate` key, enqueue on store changes, poll fallback kept.                                                                                                                        | M    | W3, P2W1   |
| W8   | **Outside Harnu.** P4W3 switch stages the `harnu` folder too; disk fallback for memory; `outside`/`no-harnu` suites.                                                                                                                             | S    | W1, P4W3   |

Order: W0 → W1 → {W2, W3, W8} → {W4, W5} → W6 → W7. W1–W3 is a usable v1; W6 and W7 are
improvements a dependent never has to code against (the API does not change).

## 16. Open questions (AC-12)

| #       | Question                                                                                                                                                                                                                   | Who decides                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| SDK-Q1  | Do `engine.create` plugin nouns and `dependencies` type-laying exist on 2.1.287–2.1.294? If not, is a `minCli` of 2.1.295 for the `harnu` mod acceptable while the companion stays at 2.1.287?                             | W0 evidence; then the operator                 |
| SDK-Q2  | Can a `user`-tier plugin add a noun ("past its own stub, or adding a seated name", `TYPES:4471`)? If not, what tier does Harnu stage the `harnu` mod at?                                                                   | W0 evidence; then the operator                 |
| SDK-Q3  | How does a mod author on a machine without Harnu get the `harnu` contract for their editor and tests: a published marketplace entry (`/plugin install harnu --marketplace …`), or the copyable kit only?                   | Operator (distribution)                        |
| SDK-Q4  | Should a write from a third-party mod require a per-mod opt-in by the operator (a first-write confirm, or a switch on the mod's row in Settings → Mods), beyond today's agent gates? This spec says no for v1.             | Operator (security posture)                    |
| SDK-Q5  | `missionCurrent` returns the mission this session **owns**. An executor is a linked child, not an owner, and `mission_get` has no child lookup. Add `mission_get({ childSessionId })`, or a `mission_for_session` verb?    | Operator; a catalog change (agent-facing)      |
| SDK-Q6  | Which excluded-for-now verbs join a later minor: `message_session` (needs P2W3's audit), `archive_card`, `list_cleanup`, `draw_canvas`?                                                                                    | Operator, per dependent demand                 |
| SDK-Q7  | Is the `$.mcp.call` loopback round trip fast enough for the 5 s fleet poll across a 20-session fleet, or does W7 have to come before W3 ships?                                                                             | W0 measurement                                 |
| SDK-Q8  | Board listing: no verb lists cards (`memory_read` with no page returns the index). Is `memory_read`'s index enough for a "board" topic, or is a `list_cards` read verb needed?                                             | Operator; a catalog change                     |
| SDK-Q9  | Should the `mcp.call` guard of §9.2 also deny direct calls to the orchestration verbs (`create_session`, `submit_manifest`, …) from third-party mods, or only the always-confirm four?                                     | Operator (security posture)                    |
| SDK-Q10 | Manifest/board-dispatched sessions get the full Harnu server (they carry `spawnedBy: 'agent'`, not `agentControlled`; `src/renderer/src/stores/sessions.ts:333-341`). The noun inherits that: writes work there. Intended? | Operator (existing behaviour, not this spec's) |

## 17. Acceptance-criteria traceability

| AC    | Where                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------- |
| AC-1  | §3 (quotes with `TYPES`/`REF` lines), §3.8 (minimum version), §3.9 (assumptions)                        |
| AC-2  | §5.1 and [`01-contract.md`](01-contract.md) (declarations), §5.2 (mapping to `TC` verb names and lines) |
| AC-3  | §7                                                                                                      |
| AC-4  | §8 and ADR-0019                                                                                         |
| AC-5  | §9                                                                                                      |
| AC-6  | §10                                                                                                     |
| AC-7  | §11                                                                                                     |
| AC-8  | §12                                                                                                     |
| AC-9  | §13                                                                                                     |
| AC-10 | §14 and [`02-worked-example.md`](02-worked-example.md)                                                  |
| AC-11 | §15                                                                                                     |
| AC-12 | §16                                                                                                     |
| AC-13 | English only; neutral vocabulary; `npx prettier --check` passes on this file and the ADR                |
