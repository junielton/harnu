# T447 — `$.harnu`: an SDK noun third-party mods depend on

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T447 · **ADR:**
[`0019-harnu-sdk-noun-transport.md`](../../adr/0019-harnu-sdk-noun-transport.md) (proposed)

Files: this spec, [`01-contract.md`](01-contract.md) (the TypeScript contract, §5.1),
[`02-worked-example.md`](02-worked-example.md) (the worked example, §14, with its real
`claude plugin validate` and `claude plugin test` output) and [`03-security.md`](03-security.md)
(security and permissions, §9).

## 0. Summary

Harnu ships a second, small mod named **`harnu`** whose only job is to add one noun to Claude
Code's engine interface through `engine.create`: `$.harnu`. A third-party mod lists `harnu` under
`dependencies` in its `plugin.json`, gets the noun's types laid beside it by the engine, and calls
typed methods such as `$.harnu.missionCurrent()`, `$.harnu.memoryAppend({ page, entry })` or
`$.harnu.cardMove({ slug, to })` instead of hand-rolling `$.mcp.call` into Harnu's MCP verbs.

Five facts shape the design:

1. **A noun's methods are flat, take one argument, and are events.** `$.harnu.cardMove(x)` raises
   the event `harnu.cardMove`; a member that is not a function is no event (§3.2). So the surface
   is `$.harnu.cardMove(...)`, not the dotted `$.harnu.card.move(...)` of ideas 56 and 117.
2. **The noun is implemented by the provider hooking its own events.** The functions an
   `engine.create` step returns get no `$`, so they are stubs; the `harnu` mod's hooks on
   `harnu.<method>` do the work and read the calling mod from `next.origin` (§3.10, probed).
3. **The command channel only flows host → mod.** No route may let a mod enqueue work in Harnu
   (T389/P2W1:431-432; §8). Calls therefore go over the MCP server.
4. **The companion may not call `$.mcp.call`** (T389 SEC-9 (b)). The noun cannot live inside
   `harnu-companion`; it is a separate mod that _reads_ the companion's published state.
5. **Withheld stays withheld.** Sessions Harnu spawns for an MCP agent get no Harnu MCP; Scheduler
   ticks are fenced by lists `$.mcp.call` ignores. The noun answers `NO_MCP` in the first and is
   never loaded in the second (§7).

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
  I, fleet, memory, board cards, the mission this session owns or builds a step of, and operator
  signals (notify, speak, open file).
- G2. Every noun call passes through the gates Harnu already enforces (blocked folders, "Ask
  before agent actions", per-verb confirms, audit), and **no environment gains a Harnu write it
  did not already have**: the noun is absent from Scheduler ticks and read-only in every
  non-interactive session (§7). G2 is about Harnu's gates only: a mod is unsandboxed code with
  `$.process` and `$.mcp.call` of its own (ADR-0018 Decision 3), and the noun does not change that.
- G3. Defined behaviour in every environment: inside Harnu, inside Harnu without MCP, outside
  Harnu, Harnu not running, a Scheduler tick.
- G4. A test story for the dependent mod and for the noun itself, run on a real build (§12, §14).

**Non-goals.**

- No new MCP verb is _required_ for v1. Two verb changes make v1 better and are listed as
  dependencies (§5.4, §10.2).
- No authentication of the calling mod. The engine names the caller (`next.origin`), Harnu records
  it as declared, nothing is authorized by it (§9.4).
- No messaging (`message_session`) and no orchestration verbs in v1 (§9.1). Idea 56 lists
  "messaging"; it is deferred deliberately, not dropped (SDK-Q6).
- No change to `harnu-companion`'s security rules (SEC-1 to SEC-9 of the T389 master).
- No marketplace or mod store (idea 118).

## 2. Conventions

Every fact carries a source. Abbreviations:

| Tag      | Source                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TYPES`  | `claude-code.d.ts` written by Claude Code **2.1.295** (line 1: "Written by Claude Code 2.1.295."). The same file the engine lays beside a loaded mod as `.claude-plugin/types/claude-code/index.d.ts`.             |
| `REF`    | The `plugin-authoring` skill's `reference.md` shipped with 2.1.295 (the long-form mods reference).                                                                                                                 |
| `TC`     | `src/main/mcp/tool-catalog.ts` at this branch's base (`6b65873`).                                                                                                                                                  |
| `T389/x` | `docs/specs/T389-companion-mod/<x>.md`.                                                                                                                                                                            |
| `PROBE`  | A `claude plugin test` or `claude plugin validate` run on 2.1.295 made for this spec (2026-10-09); output quoted where used. The kit is not a `--plugin-dir` session: a probe settles the API, not a live session. |

Line numbers in `TYPES` are those of the 2.1.295 file; a later build moves them (§11.2).

**Verified** means read in the cited file or observed in a probe. **Assumption** marks anything
inferred and not yet observed; each one is listed in §3.9 with the spike that settles it.

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
`TYPES:4806`). A step therefore only wires functions; it calls nothing, and the functions it
returns have no `$` to call with (§3.10).

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

Consequences, verified from those declarations:

- **Flat names.** `$.harnu.card.move` would make `card` a non-function member, which is "no event":
  not hookable, not typed as an event, not visible to an org's guard. The surface is one level:
  `$.harnu.cardMove`. This is a deliberate deviation from the dotted spelling in ideas 56 and 117.
- **One object argument.** Only the first parameter becomes the event's `e`. Every method takes a
  single object (or nothing).
- **Every call is hookable.** `$.harnu.cardMove(x)` raises the event `harnu.cardMove`; any plugin
  may pass it on, rewrite it, answer it, or refuse it with `{ deny }`.

### 3.3 The contract file a noun ships

> "A plugin that adds a noun to `$` ships its own contract: a .d.ts its plugin.json names as
> "types", exporting the noun's types at its top level and declaring the noun on the engine's
> interface, `export type Topo = { ... }` / `declare module 'claude-code' { interface
EngineInterface { topo: Topo } }` with no import or reference, its exported names led by the
> noun's PascalCase name; the plugin's own hooks module imports them from it." — `TYPES:91-99`
> (repeated in `REF:66`)

So the `harnu` mod ships `types/index.d.ts`, self-contained, every exported name starting with
`Harnu`, named in its manifest as `"types": "./types/index.d.ts"`. The same file declares the mod's
`$.state` keys under `interface PluginState { harnu: { … } }`, as the companion does in
`resources/companion/types/index.d.ts:3-61`.

### 3.4 How a dependent mod gets the types

> "… and one entry per plugin the mod's plugin.json lists under "dependencies" (that plugin's own
> contract): what it adds to `$` in engine.create, so a plugin you depend on is typed with nothing
> copied." — `TYPES:78-84`

> "A plugin that depends on it never copies the file: it lists that plugin under `dependencies` in
> its own `plugin.json`, and each time the engine loads it from a folder it lays types in (above)
> it lays that plugin's contract into `.claude-plugin/types/<plugin>/index.d.ts`, so the noun is
> typed on the dependent's `$`; `claude plugin validate` checks the contract." — `REF:66`

**Only folders the engine lays types in.** "A folder the session loads from and does not
hot-reload (a `--plugin-dir` under `claude -p` or an SDK host, an installed plugin's) is never
written in" (`REF:50-53`). A dependent gets the laid contract while its author runs it from the
mods folder or a hot-reloaded `--plugin-dir`; an installed copy does not, and needs none at run
time. The dependency is keyed by **plugin name**, which is why the new mod's name is `harnu` (§4).

### 3.5 Who is calling: `next.origin`

> "Who raised this dispatch: the calling plugin's name and the tier it sits in (Origin) … Set by
> the host alone, from the environment the call came from (its own MessagePort) and that plugin's
> seat; nothing a plugin writes reaches it." — `TYPES:6576-6586`, the `origin` field of `Next`
> (`TYPES:6535`); `Origin = { plugin, tier }` at `TYPES:7323-7334`.

PROBE (tier-probe): a dependent named `dep` calling `$.harnu.ping()`, answered by the provider's
own hook on `harnu.ping`, received `{"ok":true,"via":"dep","tier":"user"}`. The provider reads the
caller from `next.origin` on its own noun events; this is what lets the noun name the mod that
called it (§9.4).

### 3.6 `$.mcp.call`

> "Calls `tool` on one of the engine's connected MCP servers with the engine's own connection and
> credentials. A `cached` server is dialed on first use. No permission prompt: the plugin's call,
> seen by the hooks above it, is the grant." — `TYPES:2697-2718`

Three facts follow: the call only reaches a server **connected in that session** (none is
connected where Harnu withheld its `--mcp-config`); Claude Code's own allow and deny lists for
`mcp__harnu__*` do **not** apply to it, which matters for Scheduler ticks (§7.3); and Harnu's
server-side gates do apply (§9.3). `$.mcp.connect` connects only "one of the MCP servers this
plugin's own manifest lists" (`TYPES:2719-2732`); the `harnu` mod lists none, on purpose (SDK-S2).

### 3.7 `$.state`: any plugin reads, the owner writes

> "A `get` made while a `ui.render` hook draws subscribes that instance: a later `set` draws it
> again … Any plugin reads any value; its owner alone writes it. Persist through `$.store`."
> — `TYPES:3376-3383`

This is the subscription primitive of §10 and the reason the noun can read the companion's `sid`
without a wire.

### 3.8 Minimum Claude Code version

- **Verified floor for this design: 2.1.295.** Every declaration above was read in the 2.1.295
  file, and every PROBE ran on it.
- The companion's window is `minCli` 2.1.287, `lastVerifiedCli` 2.1.292
  (`resources/companion/api-surface.json`; `docs/dev/companion-mod.md:95-97`). Whether plugin nouns
  and `dependencies` type-laying exist between 2.1.287 and 2.1.294 is **not verified** (SDK-Q1).
  Until W0 answers it, the `harnu` mod's `minCli` is **2.1.295**, and below it Harnu does not stage
  the mod.

### 3.9 Engine behaviours: verified and assumed

| #   | Claim                                                                                                                                                                                                                                                                                                                                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | A `user`-tier plugin may add a noun. `TYPES:4471` fails a `user` step "past its own stub, or adding a seated name". A stub is "a withheld noun … (a step inside withheld it, or the last fold did and this is a reload)" (`TYPES:4494-4496`), so a fresh noun nobody withheld passes no stub. "Seated name" is not defined in the file. | **Conflicting evidence, open (SDK-Q2).** Verifier (round 1): an inline plugin adding `harnu` at the default `user` tier "never produced the noun; at `prepend` it did". This spec's PROBE (tier-probe, tier-probe3): the same shape at `user`, `prepend` and `append` all produced it (`USER {"ok":true,"via":"dep3","tier":"user"}`), with and without `"dependencies": ["harnu"]` on the caller. Neither ran in a `--plugin-dir` session; W0 does. |
| A2  | The providing plugin can hook its own noun's events and read `next.origin` there.                                                                                                                                                                                                                                                       | **Verified in PROBE** (§3.5). Load-bearing: the noun is built on it (§3.10).                                                                                                                                                                                                                                                                                                                                                                         |
| A3  | `dependencies` resolves to a plugin loaded through `--plugin-dir` (`harnu@inline`) in a live session, and the contract is laid.                                                                                                                                                                                                         | Assumption; W0. Validation with `"dependencies": ["harnu"]` and no `harnu` present passes (§14).                                                                                                                                                                                                                                                                                                                                                     |
| A4  | A dependent whose dependency is absent still loads, with `$.harnu` undefined.                                                                                                                                                                                                                                                           | **Verified in PROBE**: with no provider, the dependent loaded and `$.harnu.ping()` threw `undefined is not an object (evaluating '$.harnu.ping')`. Live session: W0.                                                                                                                                                                                                                                                                                 |
| A5  | _(round 1: "a test's bottom hook on `harnu.<method>` answers when no plugin provides the noun")_                                                                                                                                                                                                                                        | **False on 2.1.295.** Verifier: "registered harnu.memoryAppend, but no loaded plugin provides $.harnu". Replaced by an inline stand-in provider loaded with `test(name, { plugins: [...] }, body)`, beneath which bottom hooks on `harnu.<method>` answer. Verified (§12.1, §14).                                                                                                                                                                    |
| A6  | A Harnu MCP refusal reaches `$.mcp.call` as `{ isError: true, content: [{ type: 'text', text }] }`, `text` a bare reason or JSON `{ error, message, nextActions }`; a parked confirm reaches it as a **non-error** result whose JSON is `{ status: 'pending', approvalId, … }`.                                                         | Verified on the server side (`src/main/mcp/tool-result.ts:36-38`; `src/main/mcp/server.ts:335-353`, `:1252-1287`). The client side is W0.                                                                                                                                                                                                                                                                                                            |
| A7  | The companion's bound `sid` is the same id an orchestrator links to a mission step with `mission_link_child` (`kind: 'session'`).                                                                                                                                                                                                       | Assumption: `sid` is "the id the host has for this binding" (`resources/companion/types/index.d.ts:10`), and missions link transcript UUIDs (`docs/harnu-features.md`). W0 checks one dispatched executor.                                                                                                                                                                                                                                           |

### 3.10 How the noun is implemented

The functions an `engine.create` step returns run with no `$` (§3.1), so they cannot call
`$.mcp.call`. The noun is therefore two layers, both in the `harnu` mod:

1. **The `engine.create` step adds stubs.** Each method of `$.harnu` resolves
   `{ ok: false, error: 'UNSUPPORTED' }`. A stub only answers if the hook above it is missing.
2. **One hook per method does the work.** `on('harnu.cardMove', async ($, e, next) => …)` gets `$`,
   validates `e`, reads the caller from `next.origin`, calls `$.mcp.call('harnu', 'move_card', …)`
   and answers `{ value }` without calling `next`. Its own `$.mcp.call` carries
   `origin.plugin === 'harnu'`, which is how the guard of §9.2 tells it apart.

PROBE (tier-probe) shows both layers: a provider whose stub answered `{ ok: false, error: 'STUB' }`
and whose hook on `harnu.ping` answered `{ ok: true, via: next.origin.plugin }` returned the hook's
answer to the dependent at every tier tried.

## 4. Where the noun lives

**A new mod, `resources/harnu-sdk/`, whose manifest name is `harnu`.** Not inside
`resources/companion/`:

- The companion is forbidden `$.mcp.call` (T389/00-master.md SEC-9 (b); `docs/dev/companion-mod.md:60`
  "no `$.process`, no `$.mcp.call`"). The noun's calls need it (ADR-0019).
- The companion is a sensor that must stay small and readable (ADR-0018 Decision); a public API
  surface with its own versioning is a different product.
- Dependents name the dependency by plugin name. The companion is `harnu-companion`
  (`resources/companion/.claude-plugin/plugin.json`); ideas 56/117 and every dependent say `harnu`.

```
resources/harnu-sdk/
  .claude-plugin/plugin.json   # { "name": "harnu", "version": "1.0.0", "types": "./types/index.d.ts", … }
  hooks/hooks.json             # { "modules": ["./register.ts"] }
  hooks/register.ts            # engine.create stubs + one hook per method + the mcp.call guard + poll loop
  hooks/lib/*-core.ts          # $-free: verb mapping, argument filters, result normaliser, diffing
  types/index.d.ts             # THE contract (01-contract.md)
  api-surface.json             # drift manifest + the method → chip table (§9.5)
  tests/*.test.ts              # claude plugin test suites (§12.2)
```

**Staging and tier.** Harnu stages it exactly like the companion (T389 D1: immutable, versioned, a
dedicated `--plugin-dir`), as a sibling `<userData>/companion/<stageKey>/harnu/`, and passes it as
one more `--plugin-dir` to every **interactive** session where the companion is passed. A
`--plugin-dir` plugin loads at the **`user`** tier (provenance `<name>@inline`, `TYPES`
`PluginRegisterInput`; `prepend` and `append` "are the managed plugins an administrator lists",
`TYPES:12590-12600`). There is no other tier Harnu can stage at without a managed policy. If W0
shows that a `user` plugin cannot add a noun in a live session (A1), T447 is blocked as designed
(ADR-0019 kill criterion 1). A third-party author who loads `harnu` themselves, by `--plugin-dir`
or `/plugin install`, is at `user` too and hits the same wall; only an administrator listing
`harnu` as a managed `prepend` plugin would get around it.

**Never staged into Scheduler ticks.** `tickArgv` passes only the companion's and the skills'
plugin dirs (`src/main/scheduler-core.ts:462-463`); the `harnu` mod is added to neither, and W1
adds a test that `tickArgv` never carries it (§7.3).

Outside Harnu (P4W3's opt-in switch), the same folder is appended to `CLAUDE_CODE_PLUGIN_DIRS`
next to the companion's. When the companion mode is `off`, the `harnu` mod is still staged: its
reads over MCP do not need the companion (§7).

## 5. API surface (AC-2)

### 5.1 The contract

The full TypeScript declarations are in [`01-contract.md`](01-contract.md), the proposed
`resources/harnu-sdk/types/index.d.ts`. They type-check with `tsc` against the 2.1.295 types and are
the contract the worked example of §14 validates and tests against. In short:

- `HarnuNoun`: 23 methods, flat, each taking one object argument or none (§3.2): `identity`,
  `capabilities`, `fleetGet`, `sessionGet`, `memoryRead`, `memoryQuery`, `memoryAppend`, `boardGet`,
  `cardCreate`, `cardUpdate`, `cardMove`, `missionCurrent`, `missionGet`, `missionStepClaim`,
  `missionLog`, `missionBlockerSet`, `missionBlockerClear`, `notify`, `speak`, `openFile`,
  `approvalWait`, `watch`, `unwatch`.
- `HarnuResult<T> = ({ ok: true } & T) | HarnuError`: no method rejects for a refusal. The error
  codes are `OUTSIDE_HARNU`, `NO_MCP`, `NO_IDENTITY`, `NOT_LINKED`, `READ_ONLY`, `UNSUPPORTED`,
  `EXCLUDED`, `BAD_ARGS`, `FOLDER_NOT_ALLOWED`, `PATH_ESCAPE`, `PENDING`, `CONFIRM_DENIED`,
  `TIMEOUT` and `REFUSED`, with Harnu's own code in `serverCode`.
- **`PENDING` is an error, on purpose.** A write the operator has not answered yet is
  `{ ok: false, error: 'PENDING', approvalId }`, so `if (res.ok)` can never mistake it for done.
- `HarnuIdentity` (`env`, `inside`, `sessionId?`, `sessionVerified`, `interactive`, `folder`,
  `companion`, `mcp`, `sdk`) and `HarnuEnv = inside | inside-no-mcp | outside | no-harnu` (§7).
- `HarnuFreshness` (`source`, `fetchedAt`, `stale`) on every value a read or cache returns (§10).
- `declare module 'claude-code'`: `EngineInterface { harnu: HarnuNoun }` and
  `PluginState { harnu: { identity, fleet, mission, memory, board, writes } }`.

Notes on the shape:

- `identity` and `capabilities` never fail: they describe the environment.
- No method takes `folder`. The noun pins `identity.folder` (`$.session.root()` at `session.start`)
  and passes it to every folder-scoped verb.
- No method takes a `sessionId`. `sessionGet` reads **this** session; `notify`, `speak` and the
  mission methods fill this session's id from `identity.sessionId`.
- `missionStepClaim` is `mission_update_step` with `set.proof: 'claimed'` fixed. Retitling a step
  and every other `set` key are out (§9.1).

### 5.2 Method → verb mapping

Every verb name below is the exact `name` in `TC` (line of its definition in parentheses).

| Method                                     | Transport (ADR-0019)                       | Verb / source                                                                                                                                         | Fixed, filled or filtered arguments                                                                                                   |
| ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                                 | local                                      | `$.state` `harnu-companion.sid` (`resources/companion/types/index.d.ts:10`), `HARNU_SPAWN_TOKEN` presence, `session.start`'s `isInteractive`, a probe | none                                                                                                                                  |
| `capabilities`                             | local + MCP probe                          | the noun's own method list; the verbs probed once per session                                                                                         | none                                                                                                                                  |
| `fleetGet`                                 | MCP                                        | `get_fleet` (TC:470)                                                                                                                                  | `limit: 50`; drops rows with `agentControllable: false` and the `peer` field (§9.1)                                                   |
| `sessionGet`                               | MCP                                        | `get_session` (TC:497)                                                                                                                                | `sessionId = identity.sessionId`, never another id                                                                                    |
| `memoryRead`                               | MCP; disk outside (§7)                     | `memory_read` (TC:669)                                                                                                                                | `folder`                                                                                                                              |
| `memoryQuery`                              | MCP; disk outside (§7)                     | `memory_query` (TC:719)                                                                                                                               | `folder`                                                                                                                              |
| `memoryAppend`                             | MCP                                        | `memory_append` (TC:691)                                                                                                                              | `folder`; `page` limited to `decisions`, `sessions/<slug>`                                                                            |
| `boardGet`                                 | MCP                                        | `memory_read` (TC:669) page list in v1; `list_cards` once D-B lands (§10.2)                                                                           | `folder`                                                                                                                              |
| `cardCreate`                               | MCP                                        | `create_card` (TC:856)                                                                                                                                | `folder`; `title`, `body`, `kind`, `complexity`, `parent`, `deps`, `priority`, `spec`; no `images`, no `substrate`                    |
| `cardUpdate`                               | MCP                                        | `update_card` (TC:908)                                                                                                                                | `folder`; `set` keys `title/kind/complexity/parent/deps/priority/spec/prd/adr`, `appendBody`; no `replaceBody`, `images`, `substrate` |
| `cardMove`                                 | MCP                                        | `move_card` (TC:959)                                                                                                                                  | `folder`; `to` ∈ `backlog`/`ready`/`review` (the verb's own enum)                                                                     |
| `missionCurrent`                           | MCP                                        | `mission_get` (TC:1384), `mission_list` (TC:1409)                                                                                                     | the resolution of §5.4                                                                                                                |
| `missionGet`                               | MCP                                        | `mission_get` (TC:1384)                                                                                                                               | `folder`, `missionId`; `NOT_LINKED` unless this session owns it or is linked to a step                                                |
| `missionStepClaim`                         | MCP                                        | `mission_update_step` (TC:1464)                                                                                                                       | `folder`, `set: { proof: 'claimed' }`; only a step in `mySteps`                                                                       |
| `missionLog`                               | MCP                                        | `mission_log` (TC:1513)                                                                                                                               | `folder`; a mission this session owns or builds; `stepId` only from `mySteps`                                                         |
| `missionBlockerSet`, `missionBlockerClear` | MCP                                        | `mission_set_blocker` (TC:1531), `mission_clear_blocker` (TC:1553)                                                                                    | `folder`; mission-level for the owner only, step-level for a step in `mySteps`; clear by `reason` only (never `index`)                |
| `notify`                                   | MCP                                        | `notify` (TC:799)                                                                                                                                     | `folder`, `sessionId = identity.sessionId`                                                                                            |
| `speak`                                    | MCP                                        | `speak` (TC:826)                                                                                                                                      | `folder`, `sessionId = identity.sessionId`                                                                                            |
| `openFile`                                 | MCP                                        | `open_file` (TC:735)                                                                                                                                  | `folder`                                                                                                                              |
| `approvalWait`                             | MCP                                        | `get_approval` (TC:519)                                                                                                                               | only an `approvalId` this module received in a `PENDING` answer (§5.3)                                                                |
| `watch` / `unwatch`                        | local poll (v1); channel invalidation (v2) | the read verbs above on a timer (§10)                                                                                                                 | none                                                                                                                                  |

No method uses the Harnu mod command channel for a call: it carries host → mod commands only (§8).
The channel appears once, in v2, as the source of a change notification (§10.3).

### 5.3 Result normalisation

The noun turns every `$.mcp.call` outcome into `HarnuResult`, never a rejection:

1. **No server.** `$.mcp.call` rejects because no `harnu` server is connected → `NO_MCP` when
   `env` is `inside-no-mcp`, `OUTSIDE_HARNU` otherwise.
2. **A parked confirm is checked before anything else.** With "Ask before agent actions" on, the
   server races the operator's answer for `CONFIRM_WINDOW_MS` = 30 s
   (`src/main/mcp/confirm-core.ts:37`). An answer inside the window returns the real result or a
   denial. Past it, the server returns a **non-error** text result `{ status: 'pending',
approvalId, message, nextActions }` while the confirm stays live for up to `PARK_TTL_MS` = 30 min
   (`confirm-core.ts:45`; `server.ts:1252-1287`). The noun maps any success payload whose
   `status === 'pending'` to `{ ok: false, error: 'PENDING', approvalId }`. It is never `ok: true`.
3. **Learning the outcome.** `approvalWait({ approvalId, timeoutMs? })` polls `get_approval`
   (TC:519) every 2 s up to `timeoutMs` (default 25 s; a hook's budget stands still during `$`
   calls, `TYPES:6600`). `get_approval` answers `pending | allowed | denied | unknown`
   (`src/main/mcp/approval-status.ts:15-24`): `allowed` → `{ ok: true, approval: { status:
'allowed', result } }`; `denied` → `CONFIRM_DENIED` with `serverCode = reason`; still
   `pending` → `PENDING` again with the same id; `unknown` → `TIMEOUT`. The noun only polls ids it
   handed out itself (kept in module memory), so it never reads another caller's approval.
4. **`isError: true`** → parse the first text block as JSON, else take it as a bare string:

   | Text the caller receives                                        | Source                                       | `HarnuErrorCode`                         |
   | --------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
   | `{"error":"FOLDER_NOT_ALLOWED",…}` or bare `FOLDER_NOT_ALLOWED` | `permission-core.ts:216-217`, `deny-hint.ts` | `FOLDER_NOT_ALLOWED`                     |
   | `{"error":"PATH_ESCAPE",…}` or bare `PATH_ESCAPE`               | `permission-core.ts:223-229` (Ask mode only) | `PATH_ESCAPE`                            |
   | `denied by operator (<reason>)`                                 | `server.ts:1256`, answered inside the window | `CONFIRM_DENIED`, `serverCode: <reason>` |
   | `denied (<reason>)`, e.g. `DENY_BUSY`, `NO_WINDOW`              | `server.ts:1190`, no confirm could be parked | `CONFIRM_DENIED`, `serverCode: <reason>` |
   | `TOOL_TIMEOUT`                                                  | the server's 120 s per-call deadline         | `TIMEOUT`                                |
   | an unknown-tool reply                                           | an older Harnu                               | `UNSUPPORTED`                            |
   | any other JSON `error`, or any other string                     | a verb's own refusal                         | `REFUSED`, `serverCode` verbatim         |

5. **Success** → parse the JSON ACK. An ACK with `ok: false` is a refusal, not a success
   (`docs/lessons/code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md`, applied in
   `ackIsSuccess`, `src/main/mcp/tool-result.ts:49-62`).
6. `CALL_IN_FLIGHT` (a retry while the first call still runs) is retried once after 1 s, then
   reported as `TIMEOUT`.

### 5.4 Which mission is "mine": owners and executors

An orchestrator **owns** a mission (`mission_create` with its `sessionId`); an executor it
dispatches is **linked** to a step as a child (`mission_link_child`, `kind: 'session'`).
`mission_get` looks a mission up by `missionId` or `ownerSessionId` only (TC:1384), so an executor
cannot find its mission by owner. `missionCurrent` resolves in this order, and needs
`identity.sessionId` (else `NO_IDENTITY`):

1. **Owner.** `mission_get({ folder, ownerSessionId: sessionId })`. Found → `role: 'owner'`,
   `mySteps` = every step.
2. **Child, v1 (no verb change).** `mission_list({ folder })` (TC:1409), newest first, `active` and
   `delivered` only, at most 10; for each, `mission_get({ folder, missionId })` until one has a step
   whose `links` include `{ kind: 'session', ref: sessionId }`. Found → `role: 'child'`, `mySteps`
   = those steps. More than 10 candidates → stop and answer `mission: null` with
   `serverCode: 'TOO_MANY_MISSIONS'` rather than read every mission in the repo.
3. **Child, v1.1 (verb change, dependency D-A).** `mission_get({ folder, childSessionId })`: the
   server returns the mission whose step links that session, plus `mySteps`. It replaces step 2's
   scan. It is an agent-facing catalog change (a new optional selector on `mission_get`), so it
   ships with its own `docs/harnu-features.md` update; the noun's API does not change.

The resolved `missionId` is cached in `harnu.mission` for the session and re-resolved when a step
write answers `MISSION_CLOSED` or the link disappears. An executor dispatched with a packet that
names its mission (as T447's own packet does) can call `missionGet({ missionId })` directly; the
noun still checks the link. Linking happens at dispatch, so a child resolved in its first seconds
may see `mission: null` once and find it on the next `watch` tick. All of this depends on A7.

The step methods are scoped by role: a child may claim, log on and block **its own steps only**
(`mySteps`); mission-level blockers and logs without a `stepId` are the owner's. A request outside
that is `NOT_LINKED`. Verification (`mission_verify_step`) is never offered (§9.1).

## 6. Hook budget and latency

A hook's budget "stands still while a `next` or `$` call of the hook's is in flight"
(`TYPES:6600`), so a dependent awaiting `$.harnu.cardMove` in its own hook does not burn its budget
while Harnu races a confirm. The server's own deadline is 120 s per call (`TOOL_TIMEOUT`). The MCP
round trip is a loopback HTTP request whose latency inside a session is **not measured** (SDK-Q7,
measured in W0). Reads that a draw path needs go through the `$.state` cache (§10), never through a
live call while drawing.

## 7. Environments and degradation (AC-3)

### 7.1 The environments and how the noun detects them

| Env             | Detection (at `session.start`, re-checked on failure)                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inside`        | `$.env.get('HARNU_SPAWN_TOKEN')` is set (the one env var the companion reads, T389/P1W3:474) **and** a probe `get_fleet({ limit: 1 })` over `$.mcp.call('harnu', …)` answers.                                                                |
| `inside-no-mcp` | Token set, and the probe rejects because no `harnu` server is connected: the `agentControlled` spawn (`src/main/pty.ts:811-818`, flag set at `src/renderer/src/stores/sessions.ts:3231`) and the `readOnly` review spawn (`pty.ts:269-278`). |
| `outside`       | No token: a session started from a terminal, with or without P4W3's switch; a nested `claude` that inherited a spent token (T389/P4W3:186-187).                                                                                              |
| `no-harnu`      | The probe fails with a connection error (Harnu quit or restarting).                                                                                                                                                                          |

Orthogonal to `env`, the noun records **`interactive`** from `session.start`'s `isInteractive`, the
same fact the companion keeps (`boot.isInteractive`, `resources/companion/types/index.d.ts`).

The token's value is never read into the noun's state, logged or returned; only its presence
(SDK-S5).

**The session id.** The only thing the noun takes from the companion is its bound `sid`:

- companion `live`, spawned session → `sid` from a spawn-token binding → `sessionVerified: true`.
- `outside` with P4W3 on → the companion persists a `sid` for its tokenless binding too
  (`resources/companion/hooks/register.ts:458-461`). The host has not verified it against a spawn
  (T389/P4W3:214-231: nothing is shown until Harnu's own watchers corroborate it), so the noun
  reports it with `sessionVerified: false` and never fills it into a call. An outside session has
  no MCP anyway (§7.2).
- companion `legacy` (loaded but not authoritative: shadow, above the tested CLI ceiling, inert
  after a kill switch) → `sid` may be present; used only when its binding came from a token.
- companion `off` (not loaded) → no `sid` → methods that need it answer `NO_IDENTITY`; every
  other method works unchanged over MCP.

The user sees the companion as `live`, `legacy` or `off` (T389/P1W3:482; internal modes
`off | shadow | active`, T389/00-master.md:57).

### 7.2 Per-method behaviour

`NI` = `NO_IDENTITY` when `sessionId` is unknown. "Disk" reads `.harnu/memory/` under the session
root through `$.fs.read`, read-only; the legacy `.capy/` is never read. The last column overrides
the others whenever `interactive` is false.

| Method                                                                                               | `inside`   | `inside-no-mcp`                      | `outside`                                   | `no-harnu`                                  | non-interactive, any env |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------ | ------------------------------------------- | ------------------------------------------- | ------------------------ |
| `identity`, `capabilities`                                                                           | full       | `mcp: false`, `verbs: []`            | `inside: false`, `verbs: []`                | `mcp: false`, `verbs: []`                   | as its env               |
| `fleetGet`, `boardGet`                                                                               | MCP        | `NO_MCP`                             | `OUTSIDE_HARNU`                             | cached, `stale: true`; else `OUTSIDE_HARNU` | as its env               |
| `sessionGet`, `missionCurrent`, `missionGet`                                                         | MCP (`NI`) | `NO_MCP`                             | `OUTSIDE_HARNU`                             | cached, `stale: true`; else `OUTSIDE_HARNU` | as its env               |
| `memoryRead`, `memoryQuery`                                                                          | MCP        | **disk**, `source: 'disk'`           | **disk**                                    | **disk**                                    | as its env               |
| every write (`memoryAppend`, `card*`, mission writes, `notify`, `speak`, `openFile`), `approvalWait` | MCP        | `NO_MCP`                             | `OUTSIDE_HARNU`                             | `OUTSIDE_HARNU`                             | **`READ_ONLY`**          |
| `watch`                                                                                              | polls      | `memory` polls disk; others `NO_MCP` | `memory` polls disk; others `OUTSIDE_HARNU` | keeps polling with backoff                  | as its env               |

Rules behind the table:

- **Writes never fall back to disk.** Writing `.harnu/memory/` or a card file directly skips
  provenance stamping and the `done`/`approved` gates (`docs/harnu-features.md`, "Never hand-write
  a card file"). A dependent that must keep something keeps it in its own `$.store`.
- **No write is queued for later.** A queued write replayed when Harnu comes back would act under
  a gate state the operator never saw. A refusal is final; the dependent decides.
- **Mission, fleet and board are never read from disk.** A mission's progress is derived live by
  the server (`derived.progress`); a disk read would show a number the operator does not see.
- **`inside-no-mcp` is a deliberate refusal, not an outage.** The disk read of memory is allowed
  there because a read-only spawn can already `Read` those files with its own tools.
- **A write that never reached Harnu says so.** `OUTSIDE_HARNU` and `NO_MCP` are distinct so a
  dependent can tell "Harnu said no" from "Harnu never heard".

### 7.3 Scheduler ticks

A Scheduler `observe` tick is fenced from Harnu's write verbs **only** by Claude Code's native
allow and deny lists (`OBSERVE_MCP_ALLOW` / `OBSERVE_MCP_DENY`, `src/main/scheduler-core.ts:346-395`,
passed at :491 and :498), while the tick still loads the companion (`--plugin-dir`, :462) and
Harnu's MCP config (:468). `$.mcp.call` ignores those lists (§3.6). A noun loaded in a tick would
let any mod in it reach every write verb from a "read-only" worker, which G2 forbids. So:

1. **The `harnu` mod is never staged into a tick**, `observe` or `act`. `tickArgv` gains no third
   `--plugin-dir`, and a W1 test fails if it ever does. An `act` tick already runs with
   `bypassPermissions` and the whole server (:478-480); it gains nothing from the noun.
2. **Defence in depth: the noun is read-only in every non-interactive session.** A tick is `-p`
   (:460), so if a later change staged the mod there by mistake, every write answers `READ_ONLY`
   and only reads go through. Harnu spawns its own sessions interactive; a headless `claude -p`
   outside Harnu has no MCP anyway.
3. **No third-party mod reaches an observe tick through the skills dir either**: observe workers
   refuse a skill that declares hooks (`docs/harnu-features.md`, "rejected skill: /name (declares
   hooks)"), and `--setting-sources ''` drops the user's `env`, so P4W3's
   `CLAUDE_CODE_PLUGIN_DIRS` does not apply (T389/P4W3 §8, "Scheduler tick" row).

**G2, re-checked:** in every environment above, the Harnu writes reachable with the noun are the
same as without it: `inside` (a subset of what an agent there already has), `inside-no-mcp` (none),
`outside` and `no-harnu` (none), non-interactive sessions and ticks (none through the noun). What
the noun cannot change is that a mod already holds `$.mcp.call` and `$.process`; that is §9.2.

## 8. Transport (AC-4)

Decided in [ADR-0019](../../adr/0019-harnu-sdk-noun-transport.md). In one table:

| Concern                   | `$.mcp.call('harnu', …)` (chosen for calls)                                                    | Companion command channel (T389/P2W1)                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Direction                 | mod → Harnu, request/response                                                                  | host → mod only; "No HTTP route, MCP verb or companion endpoint may add a command" (T389/P2W1:431-432) |
| Gates                     | every existing gate (§9.3)                                                                     | origin-gated closed enum (SEC-5); none of the verbs exist as commands                                  |
| Agent-dispatched sessions | absent where Harnu withheld MCP, as intended (SEC-9 (g))                                       | present, which is exactly why it must not carry verbs                                                  |
| Audit                     | `AuditRecord` per call (`src/main/mcp/audit-log.ts:13-34`)                                     | `<userData>/companion/audit.ndjson` per command (SEC-6)                                                |
| Latency                   | one loopback HTTP round trip, unmeasured (SDK-Q7); a parked confirm returns after at most 30 s | 0–2 ms enqueue-to-mod on a held poll (T389/P2W1:48), but in the wrong direction                        |
| Failure modes             | server off, port changed, `PENDING` while the operator is away, `TOOL_TIMEOUT` at 120 s        | `NO_BINDING`, `resync`, lost commands (T389/P2W1:154, :413, :420)                                      |

The channel is used in v2 for one host → mod notification only: "topic changed, re-read it"
(§10.3), carrying no data, which fits SEC-5's closed enum.

## 9. Security and permissions (AC-5)

The full section is [`03-security.md`](03-security.md), split out for length. In short:

- **§9.1 Reachable and excluded verbs.** The noun reaches 18 of the 50 verbs, scoped to this
  session's folder, its own session and the missions it owns or builds; `get_fleet` is the one
  named exception to the own-folder rule (SDK-Q11). The other 32 are never offered.
- **§9.2 Direct `$.mcp.call`.** With "Ask before agent actions" off (the default), most excluded
  verbs are free mutations on the server, so its gates do not stop a mod that calls them directly.
  The `harnu` mod's guard denies every direct call into Harnu from another mod (probed), but it is
  a speed bump: the real boundary is install-time trust, disclosed in the Mods tab.
- **§9.3 Existing gates.** `FOLDER_NOT_ALLOWED`, Ask mode (`PATH_ESCAPE`, the 30 s race and the
  pending handle of §5.3), grants and always-allow rules apply to noun calls unchanged.
- **§9.4 Attribution.** An amendment to P2W5: the companion stamps the `mcp.call` op event too, and
  the stamp carries `via` (the calling mod, from `next.origin`).
- **§9.5 Mods tab.** Against `deriveCapabilities` (`src/main/mods-audit-core.ts:368-385`): a
  dependent's noun calls and any hook on `mcp.call` or `harnu.*` produce no chip today; four fixes.
- **§9.6 Rules SDK-S1 to SDK-S9** for the `harnu` mod.

## 10. Reads, caching and subscriptions (AC-6)

### 10.1 Cache

- A method call always goes to the source (MCP or disk) and, on success, writes the matching
  `$.state` key (`fleet`, `mission`, `memory` for `hot`, `board`) with `HarnuFreshness`. It never
  answers from cache while the source is reachable.
- When the source fails with a transport error (`no-harnu`), read methods answer the last cached
  value with `stale: true` (§7.2). A refusal (`FOLDER_NOT_ALLOWED`, `NO_MCP`) clears the key to
  `null`: a value the operator has since blocked is not served from cache.
- `$.state` survives a hot reload (`TYPES:3376-3383`); whether it survives `/clear` or a restart is
  the companion's open CQ3 (T389/01-contract.md:1318-1322). The noun rewrites every key on
  `session.start`, so the answer does not change correctness.

### 10.2 Subscribing, v1: a watched poll

`watch({ topic })` starts one `$.clock.every` loop per topic in the `harnu` mod, reference-counted
across callers; `unwatch` decrements. Defaults, configurable through the mod's `userConfig`:

| Topic     | Read                                                                                                              | Interval | Write rule                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `fleet`   | `get_fleet` (filtered, §9.1)                                                                                      | 5 s      | Write `harnu.fleet` only when the normalised value differs (hash compare). |
| `mission` | §5.4 resolution, then `mission_get` by id                                                                         | 10 s     | Same.                                                                      |
| `memory`  | `memory_read` (`hot`)                                                                                             | 30 s     | Same.                                                                      |
| `board`   | v1: `memory_read` with no page, whose page list names every `roadmap/<slug>` (TC:669-671); with D-B: `list_cards` | 15 s     | Same; `partial: true` while only membership is known.                      |

**The board needs one read the catalog lacks.** No verb lists cards with their status: `memory_read`
without a page returns `hot.md`, the index catalog and the page list, so v1 knows which cards exist
(added, removed) but not their columns. The minimum read that makes the board topic whole is
**dependency D-B: a `list_cards({ folder, status? })` read verb** returning
`{ slug, id, title, status, kind, complexity, priority, updatedAt }` per card, from the same board
store `move_card` writes. It is a read (no confirm; a candidate for the observe allowlist like
`mission_list`), and an agent-facing catalog change with its own `docs/harnu-features.md` update.
Until it lands, `boardGet` and the `board` topic answer `partial: true`.

On consecutive failures the interval doubles up to 60 s and resets on success. A topic with no
watcher polls nothing. A hot reload cancels the loop with the old environment (`TYPES:3418-3425`);
`session.start` restarts the topics recorded in `$.state`.

A dependent consumes it two ways, both engine primitives:

- **While drawing.** `read($, atom({ plugin: 'harnu', key: 'mission' }, null))` inside a
  `ui.render` hook subscribes the drawing; the next write redraws it (`TYPES:3376-3383`).
  `derive([missionAtom], m => …)` computes from it, cached by version (`TYPES:14703-14709`). §14
  does exactly this, validated.
- **Outside drawing.** Hook the `state.set` op event (`TYPES:7122`) and filter on the `harnu`
  plugin's keys: every write the `harnu` mod makes is a dispatch any plugin can observe. This
  replaces idea 117's `$.harnu.on('fleet', cb)`, which a noun cannot offer (a callback is not plain
  data; §3.2). It earns the dependent the `other-mods` chip, accurately (§9.5).

### 10.3 Subscribing, v2: invalidation over the command channel

The poll costs a loopback call per topic per interval per session. v2 removes it without moving
data over the channel:

- A new command `sdk.invalidate { topic: 'fleet' | 'mission' | 'memory' | 'board' }` is registered
  through `registerGateRow` with cause `internal` (T389/P2W1:283-287, :205-208). It carries an enum
  and nothing else (SEC-5 (a)).
- Harnu main enqueues it when its own stores change: the fleet reducer, a mission write, a memory
  write, a card write or move (the roadmap watcher). Debounced per binding the way P4W2 specifies
  for `ui.band.set` (T389/P4W2:165-167); P4W2 has not shipped, so the debounce is new code here.
- The **companion** runs it by bumping `harnu-companion.invalidate[topic]` in its own `$.state`.
  The `harnu` mod observes that key (`state.set`) and re-reads the topic once over MCP.
- **External bindings get no invalidation.** For a `profile: 'external'` binding the host issues
  only `flush`, `config.update` and `ui.band.set`, and the mod answers anything else
  `CMD_UNSUPPORTED` (T389/P4W3 §7.6, :245-262). That is moot for the noun (an outside session has
  no MCP to re-read with), but it means v2 never replaces v1 outside Harnu.
- Where the companion is not `live`, or a binding does not poll (headless), v1's poll stays the
  fallback, at a slower interval (fleet 15 s, mission 30 s, board 30 s).

### 10.4 Staleness rules for dependents

- Every value carries `fetchedAt` and `stale`. A dependent that acts on a cached value re-reads
  through the method first; the cache is for drawing.
- `harnu.writes` increments on every successful write through the noun, so a dependent can
  `derive` "something changed through the SDK" without polling.

## 11. Versioning and capability detection (AC-7)

### 11.1 Where the contract lives

`resources/harnu-sdk/types/index.d.ts` is the contract ([`01-contract.md`](01-contract.md)). The
engine copies it into a dependent at `.claude-plugin/types/harnu/index.d.ts` **only when it loads
the dependent from a folder it lays types in** — the mods folder or a hot-reloaded `--plugin-dir`;
an installed copy or a `-p` run is never written in (`REF:50-53`, §3.4). So a dependent's author
types against the version actually loaded while developing; an author without Harnu needs another
way to get the file (SDK-Q3). User docs link to it; it is the one place the shapes are written
(`TYPES:91-99`).

### 11.2 Versions

- **SDK version:** SemVer in the mod's `plugin.json` `version`, returned by `identity().sdk` and
  `capabilities().sdk`.
  - **Minor:** a new method, a new optional argument, a new error code, a new `$.state` key, a new
    optional result field. Dependents ignore what they do not know.
  - **Major:** removing or renaming a method, retyping a field, narrowing an argument, changing a
    meaning. Two majors cannot be staged side by side, since dependents name one plugin, `harnu`.
    So a major keeps the previous major's method names as deprecated aliases for one Harnu
    release, and `capabilities().methods` lists both until the aliases are removed.
- **Server side:** the noun depends only on verb names and fields `docs/harnu-features.md`
  promises. A verb's removal or rename is an agent-facing change there and must bump the SDK major
  or keep a mapping. D-A and D-B (§5.4, §10.2) are additive: the noun probes for them and falls
  back to v1.
- **Claude Code side:** `api-surface.json` holds `minCli` and `lastVerifiedCli`, enforced like the
  companion's (`docs/dev/companion-mod.md:95-97`). Above `lastVerifiedCli` Harnu still stages the
  mod (it carries no sensor that could disagree with legacy) but the Mods tab shows "not yet
  checked on this Claude Code".

### 11.3 Detecting what is present

`claude plugin validate` refuses any use of `$` other than a call spelled `$.noun.event(...)`.
PROBE (in-probe, 2.1.295):

```
✘ Found 1 error:
  ❯ modules../register.ts: in-probe: …/hooks/register.ts, compiled line 3 `if ("harnu" in $)`:
    $ itself is used in a BinaryExpression (bound, passed, spread, returned or read); $ is always
    spelled $.noun.event(...) at the call site, …
✘ Validation failed
```

The verifier saw the same refusal for `$.harnu !== undefined`. With no `harnu` mod loaded,
`$.harnu` is `undefined` at run time, so **a call throws synchronously**
(`undefined is not an object (evaluating '$.harnu.memoryAppend')`, PROBE). A promise `.catch()`
does not catch that (the first run of §14 failed exactly there); a `try/catch` does. A dependent
decides, in this order:

1. **Is the noun there?** `try { await $.harnu.capabilities() } catch { /* no harnu mod */ }`, or
   wrap the real call the same way (§14 does the latter, validated). The contract declares `harnu`
   as a required member of `EngineInterface`, because an optional one would not map to events
   (`NounEvent`, `TYPES:6710-6718`); the `try` is what makes it true at run time.
2. **Which methods?** `(await $.harnu.capabilities()).methods.includes('approvalWait')`.
3. **Which verbs does this Harnu serve?** `capabilities().verbs`, probed once per session. A method
   whose verb is missing answers `UNSUPPORTED` without a call.
4. **Where am I?** `identity().env` and `identity().interactive`.

## 12. Testing (AC-8)

### 12.1 A third-party mod testing against the noun

`claude plugin test <folder>` runs the mod's `*.test.ts` against the engine. A test's `on` "hooks
sit beneath every plugin; `plugins` load inline plugins beside the one under test"
(`TYPES:15921-15931`; `TestOptions.plugins` at :15939-15940). An inline plugin is "written
`register(on) { ... }` and is self-contained … it closes over nothing of the test file"
(`TYPES:15848-15859`).

A bottom hook alone cannot stand for the noun: with no plugin providing `$.harnu`, the kit refuses
to build `$` ("registered harnu.memoryAppend, but no loaded plugin provides $.harnu", verifier,
2.1.295). What works, and what §14 runs (4 pass):

1. **An inline stand-in provider.**
   `test(name, { plugins: [{ name: 'harnu', tier: 'prepend', register: fakeHarnu }] }, body)`,
   where `fakeHarnu`'s `engine.create` hook does
   `const built = await next(e); return { ...built, harnu: { … } } as never`, each method
   answering success. `prepend` follows the verifier's working probe; this spec's probe found `user`
   works in the kit too (§3.9 A1). The tier does not matter for a test.
2. **Per-test answers from bottom hooks.** Because the stand-in cannot close over a fixture, a test
   that needs another answer hooks the method's event beneath it, e.g.
   `on('harnu.memoryAppend', () => ({ value: { ok: false, error: 'PENDING', approvalId: 'appr-1', message: 'Parked.' } }))`.
   A hook that only observes calls `next(e)` to reach the stand-in.
3. **The "no Harnu" path** is a test with no `plugins` option: the dependent's `try/catch` takes
   over. Stub everything else the dependent touches (`mock.clock(on)`, `mock.store(on)`, or a
   `store.set` hook to assert what was kept): a test's `$` has no `store` noun to read back.

**The kit Harnu ships (W5).** A copyable `tests/support/fake-harnu.ts` exporting
`fakeHarnu: Register` (every method of the contract, each answering a typical success) and
`HARNU = { plugins: [{ name: 'harnu', tier: 'prepend', register: fakeHarnu }] }`, plus a table of
per-environment answers to paste into bottom hooks (`NO_MCP`, `OUTSIDE_HARNU`, `PENDING`,
`FOLDER_NOT_ALLOWED`, `READ_ONLY`). It is copied, not imported across plugins: a plugin imports
only its own files (`docs/dev/companion-mod.md:57`). It fixes the API's shapes, not Harnu's
behaviour: it does not reproduce gates, so a dependent's real-Harnu behaviour is still an L4 check.

### 12.2 Harnu testing the noun

Consistent with the companion's layers (`resources/companion/tests/`, `tests/support/rig.ts`
`installRig(on)`, `tests/companion/*.test.ts`, `tests/cli/*.cli.test.ts`):

- **L1, pure (vitest).** `hooks/lib/*-core.ts`: the method → verb table, argument filters
  (`EXCLUDED` pages and keys, `NOT_LINKED` scoping), the result normaliser (every row of §5.3,
  pending included, with recorded server replies as golden fixtures), the environment classifier,
  the §5.4 resolver, hash-compare for watch writes.
- **L2, drift (vitest).** `api-surface.json` against the module source and against `TC`: every verb
  in §5.2 exists with the argument names the noun sends. A catalog rename fails here first. Plus:
  `tickArgv` never carries the `harnu` dir (§7.3).
- **L3, mod (`claude plugin test`).** The `harnu` mod is the plugin under test, so its own
  `engine.create` stubs and method hooks load for real. A rig like the companion's: `mock.env` for
  the token, `mock.clock` for polls and `approvalWait`, an `on('mcp.call')` bottom hook as a
  scripted Harnu server (answers, refusals, pending handles, rejections, hangs), `fs.read` for the
  disk fallback. One suite per environment row of §7.2, plus the guard: an inline third-party
  plugin's direct `$.mcp.call('harnu', …)` is denied and the provider's own is not (the guard-probe
  shape). The `mod` CI step (`scripts/ci/mod-step.mjs`) validates and tests the new folder like the
  companion's.
- **L4, real CLI (gated by `HARNU_WITH_CLI=1`).** A real `claude` with the staged `harnu` mod and a
  fixture dependent: the noun exists at `user` tier in a live session (A1), the dependent's types
  are laid (A3), a `cardMove` lands on a throwaway board, Ask mode returns `PENDING` after 30 s and
  `approvalWait` resolves it, an `agentControlled` spawn answers `NO_MCP`.

## 13. Relation to T389 (AC-9)

The noun adds a consumer-facing layer; it re-specifies nothing T389 owns.

| T389 wave                                              | Relation                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1W1** host server (shipped)                         | Not used for calls. The noun does not talk to `c.sock`.                                                                                                                                                                                  |
| **P1W2** skeleton, staging, version gate (shipped)     | **Reused.** The `harnu` mod is staged by the same machinery, has its own `api-surface.json` and joins the `mod` CI step. W1 extends staging; it does not copy it.                                                                        |
| **P1W3** handshake and identity (shipped)              | **Read-only consumer.** `identity.sessionId` is the companion's bound `sid`. The noun never hellos, never holds `conn`, never sees the token's value.                                                                                    |
| **P1W5** fleet state (shipped)                         | Independent. `fleetGet` reads the host's fleet over `get_fleet`; the companion's `$.state.fleet` is per-session sensor state and is not re-exported.                                                                                     |
| **P2W1** command channel (shipped)                     | **Overlap resolved by ADR-0019:** not a call transport (host → mod only, P2W1:431-432). v2 adds one command, `sdk.invalidate`, through its existing `registerGateRow` path (§10.3).                                                      |
| **P2W5** MCP caller attribution (not shipped)          | **Builds on, with an amendment:** stamp the `mcp.call` op event as well as `tool.call`, and carry `via` from the noun's `next.origin` (§9.4). Format, `verifyStamp`, `CallerAttribution` and audit wording stay P2W5's.                  |
| **P4W1** Mods audit tab (shipped)                      | **Extends:** `harnu-read`/`harnu-write` chips, the `mcp.call`-hook and plugin-noun-hook gaps closed, a "depends on" label (§9.5).                                                                                                        |
| **P4W2** terminal band and `/harnu-link` (not shipped) | **Overlap, kept apart:** the band is the companion's (`$.state.band`, pushed by `ui.band.set`). The noun does not draw. A third-party band on `harnu.mission` (§14) is a different mod. v2 borrows P4W2's debounce design, not its code. |
| **P4W3** Harnu mod outside Harnu (shipped)             | **Reused:** the same switch appends the `harnu` folder to `CLAUDE_CODE_PLUGIN_DIRS`, same undo record. The `outside` row of §7 is what that session sees; its `sid` is unverified (§7.1) and it gets no v2 invalidation (§10.3).         |
| P2W2, P2W3, P2W4, P3W1, P3W2, P4W4, P4W5, P5W1         | No relation in v1. P2W3 (messaging) is why `message_session` is not in the noun yet (SDK-Q6).                                                                                                                                            |

What lives where:

- `resources/companion/` (`harnu-companion`): unchanged in v1. In v2 it gains the `sdk.invalidate`
  command and an `invalidate` state key; with P2W5 it gains the `mcp.call` stamp hook.
- `resources/harnu-sdk/` (`harnu`): new. The noun, its contract, its guard, its tests.
- `src/main/companion/`: staging of the second folder for interactive spawns only; `sdk.invalidate`
  enqueue (v2).
- `src/main/mcp/`: D-A (`mission_get` `childSessionId`) and D-B (`list_cards`), both optional;
  `caller.via` with P2W5.
- `src/main/mods-audit-core.ts`: the chip changes of §9.5.

## 14. Worked example: `decision-log` (AC-10)

The complete example (the three files, the hooks module and a test file) is in
[`02-worked-example.md`](02-worked-example.md), split out for length. It records decisions to Harnu
memory with `/decide`, reports a pending approval as pending, keeps decisions locally when Harnu is
not there, and draws the session's mission step above the prompt from the `harnu.mission` atom. It
was extracted and run on 2.1.295: `claude plugin validate` passed, `claude plugin test` passed 4 of
4, and `tsc -p` reported no error. The output is in that file.

## 15. Implementation outline (AC-11)

Sizes: S ≤ 1 day, M 2–4 days, L a week or more. An outline only; no cards are created.

| Wave | Content                                                                                                                                                                                                                                                                                                                                    | Size | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------- |
| W0   | **Spike, in a live session.** A throwaway `harnu` mod via `--plugin-dir` and a dependent: settles A1 (the tier conflict), A3, A4, A6, A7 and SDK-Q1/2/7, measures the `$.mcp.call` round trip. Output: an evidence note under `docs/specs/T447-harnu-sdk-noun/`.                                                                           | S    | —          |
| W1   | **The mod and its staging.** `resources/harnu-sdk/` with the contract, stubs and method hooks, `identity`, `capabilities`, the read methods, the normaliser (pending included), the §5.4 resolver (v1 scan), L1–L3 tests, `api-surface.json`, the `mod` CI step, staging beside the companion for interactive spawns, the `tickArgv` test. | M    | W0         |
| W2   | **Writes and the guard.** Memory, card and mission writes with their scoping, `notify`/`speak`/`openFile`, `approvalWait`, the `EXCLUDED`/`NOT_LINKED`/`READ_ONLY` rules, the `mcp.call` guard, the L4 suite. Agent-facing: `docs/harnu-features.md` + marker bump; `docs/user/` page; CHANGELOG.                                          | M    | W1         |
| W3   | **Subscriptions v1.** `watch`/`unwatch` for four topics, the poll loop, hash-compare writes, staleness, backoff; `board` partial.                                                                                                                                                                                                          | S    | W1         |
| W4   | **Mods tab.** `harnu-read`/`harnu-write`, `mcp` into `OTHER_MODS_NOUNS`, plugin-noun hooks → `other-mods`, the "depends on" label (P4W1 follow-up).                                                                                                                                                                                        | S    | W2         |
| W5   | **Dependent kit.** `fake-harnu.ts`, per-environment answers, the `decision-log` example as a CI fixture (validate + test + tsc), user docs for mod authors.                                                                                                                                                                                | S    | W2, W3     |
| D-A  | **`mission_get({ childSessionId })`.** Server-side child lookup; replaces the §5.4 scan. Agent-facing.                                                                                                                                                                                                                                     | S    | —          |
| D-B  | **`list_cards({ folder, status? })`.** Read verb; makes the `board` topic whole. Agent-facing.                                                                                                                                                                                                                                             | S    | —          |
| W6   | **Attribution.** The P2W5 amendment (§9.4): `mcp.call` stamp + `via`. Ships with or after P2W5, owned there.                                                                                                                                                                                                                               | M    | P2W5, W2   |
| W7   | **Subscriptions v2.** `sdk.invalidate` command, companion `invalidate` key, enqueue on store changes including card writes, poll fallback kept.                                                                                                                                                                                            | M    | W3, P2W1   |
| W8   | **Outside Harnu.** P4W3's switch stages the `harnu` folder too; disk fallback for memory; `outside`/`no-harnu` suites.                                                                                                                                                                                                                     | S    | W1, P4W3   |

Order: W0 → W1 → {W2, W3, W8, D-A, D-B} → {W4, W5} → W6 → W7. W1–W3 is a usable v1; D-A and D-B
make executors and the board cheap and whole; W6 and W7 are improvements a dependent never has to
code against (the API does not change).

## 16. Open questions (AC-12)

| #       | Question                                                                                                                                                                                                                                      | Who decides                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| SDK-Q1  | Do plugin nouns and `dependencies` type-laying exist on 2.1.287–2.1.294? If not, is a `minCli` of 2.1.295 for the `harnu` mod acceptable while the companion stays at 2.1.287?                                                                | W0 evidence; then the operator                 |
| SDK-Q2  | Can a `user`-tier plugin add a noun in a live session? The two probes disagree (§3.9 A1). Harnu can only stage at `user`; if the answer is no, T447 is blocked until the CLI allows it or an administrator lists `harnu` as a managed plugin. | W0 evidence; then the operator                 |
| SDK-Q3  | How does a mod author without Harnu get the `harnu` contract for their editor and tests: a published marketplace entry (`/plugin install harnu --marketplace …`), or the copyable kit only?                                                   | Operator (distribution)                        |
| SDK-Q4  | Should a write from a third-party mod need a per-mod opt-in by the operator (a first-write confirm, or a switch on the mod's row in Settings → Mods), beyond today's agent gates? This spec says no for v1.                                   | Operator (security posture)                    |
| SDK-Q6  | Which excluded-for-now verbs join a later minor: `message_session` (needs P2W3's audit), `archive_card`, `list_cleanup`, `draw_canvas`?                                                                                                       | Operator, per dependent demand                 |
| SDK-Q7  | Is the `$.mcp.call` loopback round trip fast enough for the 5 s fleet poll across a 20-session fleet, or must W7 come before W3 ships?                                                                                                        | W0 measurement                                 |
| SDK-Q9  | The guard (§9.2) denies **every** direct `$.mcp.call` into Harnu from another mod. Should a mod be allowed direct read verbs (`get_fleet`, `memory_read`) for compatibility, or is "one door" right from day one?                             | Operator (security posture)                    |
| SDK-Q10 | Manifest/board-dispatched sessions get the full Harnu server (they carry `spawnedBy: 'agent'`, not `agentControlled`; `src/renderer/src/stores/sessions.ts:333-341`). The noun inherits that: writes work there. Intended?                    | Operator (existing behaviour, not this spec's) |
| SDK-Q11 | `fleetGet` is a cross-folder read (§9.1). Keep it with the filters, narrow it to this repo's sessions (needs a repo id on `get_fleet` rows, which carry only `folderAlias`), or drop it?                                                      | Operator                                       |

SDK-Q5 (round 1: how an executor finds its mission) and SDK-Q8 (round 1: no verb lists cards) are
no longer open questions: §5.4 specifies the executor path, with D-A as a dependency, and §10.2
specifies the board read, with D-B as a dependency.

## 17. Acceptance-criteria traceability

| AC    | Where                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| AC-1  | §3 (quotes with `TYPES`/`REF` lines), §3.8 (minimum version), §3.9 (verified and assumed), §3.10              |
| AC-2  | §5.1 and [`01-contract.md`](01-contract.md) (declarations), §5.2 (mapping to `TC` verb names and lines), §5.4 |
| AC-3  | §7, including §7.3 (Scheduler ticks)                                                                          |
| AC-4  | §8 and ADR-0019                                                                                               |
| AC-5  | §9 and [`03-security.md`](03-security.md); §5.3 (pending, denials, `PATH_ESCAPE`)                             |
| AC-6  | §10, including the `board` topic and D-B                                                                      |
| AC-7  | §11                                                                                                           |
| AC-8  | §12                                                                                                           |
| AC-9  | §13                                                                                                           |
| AC-10 | §14 and [`02-worked-example.md`](02-worked-example.md), with real validate/test/tsc output                    |
| AC-11 | §15                                                                                                           |
| AC-12 | §16                                                                                                           |
| AC-13 | English only; neutral vocabulary; `npx prettier --check` passes on the spec files and the ADR                 |
