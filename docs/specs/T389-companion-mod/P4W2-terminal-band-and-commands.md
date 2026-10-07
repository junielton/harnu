# T389 P4W2 — Terminal band and `/harnu-link` commands

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Master: [`00-master.md`](00-master.md) ·
Contract: [`01-contract.md`](01-contract.md) · ADR-0018 · Verified against Claude Code CLI 2.1.287
and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on (hard):** P4W3 and P2W1. **Base branch: the P4W3 branch, with P2W1 in its base.**
  Everything the band shows needs an outside session (AC-P4W2-14, AC-P4W2-15, AC-P4W2-21 and
  LV-P4W2-a), and `ui.band.set` needs the command channel. Through them the wave also has P1W3
  (`ensureHello`, where the command is registered), P1W4 (prefs, Harnu mod state) and P4W1 part A
  (the settings region that hosts the switch).
- **Soft dependency:** P3W1 supplies the held-ask count and the coverage state
  (`askBroker.heldFor`, `askBroker.coverageOf`). Without it `held` is 0 and coverage is
  `not-gated`. The wave does **not** need P3W1's broker for its own ask.
- **Unblocks:** nothing.
- **Interfaces this wave conforms to** (master §12; the owner defines the signature):
  - P1W1 `companionHost.registerAskKind('status', fn)` for the `status` ask, and
    `setCommandSource` so that `ui.band.set` rides the `events` response of a binding that does
    not poll.
  - P2W1 `enqueue`, `registerGateRow('ui.band.set', row)` (profiles `interactive` and
    `external`, feature `ui.band`); P1W1 `appendAudit` (record kind `focus`).
  - P1W4 `registerPrefsKey('surface', …)`, `registerFeaturePolicy` for `ui.band` and
    `ui.command`, `companionStatus()`.
  - Mod helpers (master §12.2): `ensureHello($)`, `enabled(feature)`, `emit($, event)`,
    `registerCommandHandler('ui.band.set', fn)`, `reportModError`, and the ask client
    `ask($, req)`, which is first-lander with P3W1: whichever wave lands first creates it.

## 3. Summary

Two small surfaces inside the `claude` terminal, both served by the Harnu mod (the plugin
`harnu-companion`) with no model turn:

1. **`/harnu-link status`** and **`/harnu-link open`**, answered by a `command.run` hook. Status prints at most
   three lines of closed-vocabulary text; open focuses the session in Harnu.
2. **A one-line band** above the prompt (`AbovePrompt`). Inside Harnu it is absent in protocol 1.
   Outside Harnu it shows one mission line, and only while a mission is linked to that session.

The band always wraps what other mods drew, never replaces it. Everything fails to "no band, plain
text answer".

## 4. Evidence

| Id       | Verdict   | What this wave takes from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke C4 | CONFIRMED | A mod-registered command (`/capy` in the smoke run; the throwaway test mod was named before the rename) answers with no `turn.start` and no usage; the host fetch took 8–38 ms. Output is prefixed with the plugin name and stored as `type:"system", name:"local_command"`; the model quoted it exactly on its next turn.                                                                                                                                                                                                                                                                                                                                      |
| smoke C5 | CONFIRMED | The band renders at 80, 120 and 160 columns in 256-colour tmux; `bodyColumns` tracks the width; the engine adds its own `[-]`; an update during a streaming turn took 17 ms. `Link` emits an OSC 8 span. Clicking it, xterm.js and the fullscreen layout: **not tested**.                                                                                                                                                                                                                                                                                                                                                                                       |
| smoke B2 | CONFIRMED | Status line and toast render; **neither is visible while the engine's permission dialog is open**; `$.ui.notice` never rendered. A band needs a `.tsx` file and a declared `$.state` key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| smoke C2 | CONFIRMED | The poll loop delivers a command in 0–2 ms; `$.command.run` must not be awaited in the loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| smoke D6 | REFUTED   | Any plugin reads any `$.state` value and any `http.fetch`. Nothing in the band state or the status answer may be a secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| smoke A1 | CONFIRMED | Two **plugins** load side by side (`--plugin-dir A --plugin-dir B`). A plugin has exactly one hooks module: `claude plugin validate` on 2.1.287 refuses a second `modules` entry ("hooks.json `modules` names one hooks module per plugin; a second entry is refused", reproduced for this review, RB-1), while one module may import a `.tsx` view file (validate passes).                                                                                                                                                                                                                                                                                     |
| types    | —         | `LinkProps.href` accepts only an `https:` URL or `http://localhost` on 2.1.287 (L5307–5321); anything else refuses the whole tree. On 2.1.289 `href` accepts any scheme and host and is drawn as written (l.5456–5461, smoke §11.4). `AbovePrompt` is raised on terminal and desktop only (L9545) and carries `bodyColumns`, `maxRows`, `hasSurvey` (L9547–9588). `CommandSpec.immediate` runs a command mid-turn (L1725). `CommandRunResult.context` adds hidden model notes (L1668). `command.run` carries `origin` and `presentation {isFullscreen, columns}` (L1578–1592, L8208). A `$.state.get` inside a render hook subscribes it to later sets (L3155). |

## 5. Deviations from the study

| Study claim (item "new 3")                                      | Deviation                                                                                                                                                 | Source                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| "A band above the prompt with Step 4 of 5 · 1 approval pending" | No band inside Harnu; outside Harnu only while a mission is linked. No persistent band anywhere.                                                          | R20; product paper §3            |
| "links that open Harnu"                                         | A custom scheme is impossible in a `Link` (types L5315). The link is `http://localhost:<port>/o/<ticket>`; `/harnu-link open` is the primary path.        | types; smoke C5 (untested click) |
| "remote approval" shown in the band                             | A held approval already has the engine dialog (D5); status and toast are hidden under it (smoke B2). The band carries no approval line in protocol 1.     | D5; smoke B2                     |
| "`/harnu status` … without spending a model turn"               | True for the turn. The output row is read by the model on its next turn (smoke C4), so it costs input tokens there and is written for that reader (§7.5). | smoke C4                         |

## 6. Scope / Non-goals

**In scope.** `/harnu-link status`, `/harnu-link open`, the `status` ask, `ui.band.set` and its
band (no `$.ui.status` fallback), the `$.state` key, the open link and its loopback route, OSC 8
activation in Harnu's xterm.js, behaviour by width and layout.

**Non-goals.**

- No pane (`$.ui.open`): an unasked pane needs 144 columns (types L2277) and Harnu's terminal is
  rarely that wide. `ui.open` is not in `api-surface.json`.
- No `Button` in the band: nothing in protocol 1 is answered from the band.
- No band on `desktop`, `vscode` or `mobile` surfaces (Q22, untested): the hook returns `next(e)`.
- No other `/harnu-link` subcommand. No command that submits a prompt (SEC-5).
- No redraw or decoration of the permission dialog (master §1).
- The dialog-suppressing `tool.check` hold and its band line are the alternative of operator
  decision OD-2 (master §13), reserved in contract §18. This wave only names the line (§7.3,
  row 3); nothing raises it in protocol 1.

**Ideas, not scope (CLI 2.1.289, smoke §11.4).** `$.ui.selection()` (types l.2484) reads the operator's current text
selection. A later version could attach the selected output to `/harnu-link`; no wave depends on it, it is not in
`api-surface.json`, and nothing here calls it.

## 7. Design

### 7.1 Modules

| File                                                             | Side       | Owns                                                                                                                                                              |
| ---------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/companion/hooks/register.ts`                          | mod        | `$.command.register`, the `command.run{command=harnu-link}` hook, applying `ui.band.set`, the band TTL timer                                                      |
| `resources/companion/hooks/surface.tsx`                          | mod        | the band's view: a pure builder `bandRow(els, band, columns)` that `register.ts` imports. It receives the resolved elements, never `$`, and reads no state itself |
| `resources/companion/hooks/hooks.json`                           | mod        | `modules: ["./register.ts"]`: one module only (P1W2); the `ui.render` hook is registered there                                                                    |
| `resources/companion/.claude-plugin/plugin.json`                 | mod        | the `types` contract gains the `band` key (§7.4)                                                                                                                  |
| `src/main/companion/surface-core.ts`                             | host, pure | `bandFor(binding, facts): BandLine \| null`, `statusFor(binding, facts): StatusReport`, text limits                                                               |
| `src/main/companion/surface.ts`                                  | host       | subscribes to mission and Inbox changes, debounces, queues `ui.band.set`, answers `status` asks, handles `ui.action`                                              |
| `src/main/companion/open-link-server.ts`                         | host       | the loopback route of §7.6                                                                                                                                        |
| `src/renderer/src/components/TerminalPane.vue`, `HelperPane.vue` | renderer   | `linkHandler` for OSC 8 (§7.6)                                                                                                                                    |
| `src/preload/index.ts`                                           | preload    | `companionOpenTicket(ticket)`, `onCompanionFocusSession`                                                                                                          |

### 7.2 `/harnu-link` commands

Registered once per load from `ensureHello` (idempotent, MOD-4; contract §11.4, the
`session.start` row), **only when `ui.command` is enabled**. So a mod that never completed a hello,
a headless session (which gets `sense.*` only, contract §16) and a tokenless headless run (dormant
by rule, contract §21 item 1) have no command at all: the engine answers "unknown command".

```ts
$.command.register({
  name: 'harnu-link',
  description: 'Harnu status and open (answered by the Harnu mod, no model turn).',
  argumentHint: 'status | open',
  immediate: true
})
```

`immediate` lets `/harnu-link status` answer while a turn is streaming; the hook therefore reads nothing
about the turn (types L1717–1724).

`command.run{command=harnu-link}` hook, by `e.args.trim()`:

| Args           | Algorithm                                                                                                                                                                                                                                                                                                                                         | Output (`text`)                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `status`       | The mod went dormant or inert after registering (a failed re-hello, `enable: []`) → the "off" line, no request. Otherwise one `ask($, { askId: 'ask_q<counter>', kind: 'status', d })` (contract §4, §10.3); `decided` → render the report with the fixed templates of §10; anything else (`null`, a failure, `released`) → the unreachable line. | §10                                             |
| `open`         | If `e.origin.kind !== 'composer'` → refusal line, nothing sent. Otherwise queue `ui.action {name: 'open'}` as an edge event and await that one flush (it is not on a turn's path). Ack → "Opened in Harnu."; failure → unreachable line.                                                                                                          | §10                                             |
| empty or other | usage line                                                                                                                                                                                                                                                                                                                                        | `Usage: /harnu-link status \| /harnu-link open` |

The hook never calls `next(e)` for its own command (there is no core command of that name), never
sets `context` (no hidden notes for the model) and never sets `exitCode`. It is wrapped like every
hook: a throw prints the unreachable line.

**Host, `status` ask.** `surface.ts` registers the kind with
`companionHost.registerAskKind('status', …)`; P3W1's broker is not involved. It answers
`decided` at once, within `STATUS_SLA_MS`, in every rollout mode (conformance row 28), for the
`interactive` profile and for a **corroborated** `external` binding. An external binding that is
not yet corroborated is answered `released` with reason `abstain` (contract §21 item 6), and the
mod prints the unreachable line. No audit record (nothing changes); one counter.

`StatusReport.companion` is `'shadow'` when no fact family of the binding is in `active`
(contract §10); an external binding reports `shadow` until P4W3's ten-session gate. The printed
word for it is "observing" (§10).

**Host, `ui.action {name: 'open'}`.** `surface.ts` focuses the main window and sends
`companion:focusSession` with the binding's `sessionKey` (spawned) or `sid` (external); the
renderer calls `sessions.select(id)` (`stores/sessions.ts:2592`) when that row exists. At most one
focus per binding per `OPEN_MIN_INTERVAL_MS`; extra events are dropped and counted. One audit
record per focus, of kind `focus`, written through P1W1's `appendAudit` (SEC-6). An external
binding is focused only once it is corroborated. The focus runs in every rollout mode, `shadow`
included: the operator's own command focusing Harnu is not an actuation of the session.

### 7.3 Band policy (host)

```ts
/** What `bandFor` returns; `surface.ts` maps it onto `CommandArgs['ui.band.set']` (contract §9). */
interface BandLine {
  line: string // the full fallback text: lead, detail and hint joined with " · "
  parts: BandParts
  link?: BandLink
}
```

`bandFor` returns `null` or a `BandLine`. The host enqueues `ui.band.set` (P2W1 `enqueue`, cause
`surface`) only when the result changes (after `BAND_DEBOUNCE_MS`), plus a keep-alive re-send
every `BAND_REFRESH_MS` while a line stands. The command's gate row is registered with
`registerGateRow`: profiles `interactive` and `external`, feature `ui.band` (never `act.ui`: an
external binding gets no `act.*`). **The band needs no `channel: active`.** The band is display-only and has
no legacy rival, so `ui.band.set` is in the observe-only (housekeeping) set (contract §9, §11.5,
P2W1 §7.4 step 3): `enqueue` admits it while `channel` is `shadow` (the default), also for an
external binding. Only `channel: off` refuses it. The `status` ask and `ui.action` are not
commands and need no channel. For a binding that does not poll, the command reaches the mod in an
`events` response through `setCommandSource`.

| #   | Binding                    | Condition                                                                                                                                                                        | Band                                                                                                                                                                                                                |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | spawned (inside Harnu)     | anything, protocol 1                                                                                                                                                             | **none.** The Topbar mission pill, the Fleet rail and the footer already say it (§7.7)                                                                                                                              |
| 2   | spawned or external        | an approval of this session is held and the engine dialog is open                                                                                                                | **none.** The dialog is the terminal's surface; a line under it is not visible (smoke B2)                                                                                                                           |
| 3   | spawned or external        | an approval is held with **no** dialog                                                                                                                                           | reserved (contract §18): `Held in Harnu · {tool}`. Raised only by the alternative of OD-2                                                                                                                           |
| 4   | external, **corroborated** | the session owns a mission that is not closed: `owner.sessionId === sid` (`mission-core.ts:115`), the rule the Topbar pill uses (`missionForSession`, `lib/mission-view.ts:271`) | lead = the headline of `progressHeadline` (`mission-progress.ts:130`), e.g. `Step 4 of 5`; detail = `{n} held in Harnu` when the Inbox holds asks for sessions linked to that mission's steps; link = Open in Harnu |
| 5   | external                   | no mission                                                                                                                                                                       | none                                                                                                                                                                                                                |
| 6   | any                        | `surface` key off, lease lost, feature not enabled, headless, an external binding not yet corroborated                                                                           | none                                                                                                                                                                                                                |

"Event-only inside Harnu" therefore means row 3 alone, which no shipped wave raises. AC-P4W2-9
pins the absence.

### 7.4 Band rendering (mod) and the `$.state` contract

`plugin.json` `types` declares the `band` key (MOD-1). Its shape is in the contract's `$.state`
registry (§22), which this wave owns the row of:
`{ v: 1; lead; detail?; hint?; href?; label?; n; expiresAt } | null`, with the length caps of
`BandParts` and `BandLink` (contract §9). `n` is the `Command.n` that set it (a lower `n` never
overwrites a higher one); `expiresAt` is the mod's clock plus `BAND_TTL_MS` at apply time.

Any plugin can read this key (types L3157, smoke D6). It holds display text and a focus ticket,
nothing else (SEC-8).

`register.ts`, in the handler registered with `registerCommandHandler('ui.band.set', …)`: validate lengths and `href` (regex of §7.6; a bad `href` is
dropped, the line is kept); `$.state.set` the key, or `null` when `line` is `null`; answer
`command.result`. A `$.clock.every(30 000)` tick sets the key to `null` once `expiresAt` has
passed, so a dead host cannot leave a stale mission line on screen.

`register.ts` registers `ui.render{component=AbovePrompt}` (the one `on()` for that pair, MOD-4) and draws with `bandRow` from `surface.tsx`; the hook:

1. `const below = await next(e)` first, always (MOD-8).
2. Return `below` unchanged when: `e.surface !== 'terminal'`; `hasSurvey`; `maxRows < 1`; the
   `band` key is `null` or expired; `bodyColumns < 40`; any throw.
3. Otherwise `const els = $.ui.resolve(e)` in `register.ts`, and return a column: one row built by `bandRow(els, …)`, then `below`. `$` is never passed to the imported file (MOD-1). The read of `$.state` inside the
   hook subscribes it, so a later `set` redraws with no `$.ui.invalidate` (types L3155).

The row is fitted to `bodyColumns` (the transcript column, which shrinks when another mod's pane
is docked), minus 4 cells for the engine's `[-]`:

| `bodyColumns` | Row                                          | Dropped            |
| ------------- | -------------------------------------------- | ------------------ |
| < 40          | no row                                       | everything         |
| 40–79         | `◆ Harnu {lead}`                             | detail, hint, link |
| 80–109        | `◆ Harnu {lead}  {link}`                     | detail, hint       |
| 110–143       | `◆ Harnu {lead} · {detail}  {link}`          | hint               |
| ≥ 144         | `◆ Harnu {lead} · {detail} · {hint}  {link}` | nothing            |

The 110 and 144 boundaries are the widths at which a pane docks (types L1574, L2277), the points
where `bodyColumns` stops tracking the terminal width. Styling uses `dimColor` and bold only, no
fixed colour, so the line follows whatever theme the terminal maps.

If the engine refuses JSX in a file that a `.ts` module imports (the `h` factory; `validate` passes
it on 2.1.287 and AC-P4W2-7 and AC-P4W2-8 exercise the real load path), the fix is to name the
module `register.tsx` in `hooks.json`; the one-module rule does not change.

**`$.ui.status`.** The band and the status line never show the same text (smoke C5 shows the
duplicate). `ui.band.set` is drawn only by the band hook and is never applied as
`$.ui.status` (contract §9): when `ui.band` could not be declared, the session has no line. This
wave never calls `$.ui.status`.

**Layouts.** One row fits both. On the main screen (the layout tmux gets, types L1580) the band is
inline above the prompt at any width. In the fullscreen layout it sits in the bottom slot, capped
at half the rows, and reports clicks (types L9557–9562, L5385). Harnu sets
`CLAUDE_CODE_NO_FLICKER=1` only when the session's `noFlicker` pref is on (`pty.ts:810`); which
layout the CLI picks otherwise inside xterm.js is unverified → AC-P4W2-14.

### 7.5 What the model reads

The output row of `/harnu-link status` is in the transcript, so the next model turn reads it (smoke C4).
Consequences, all binding:

1. **Closed vocabulary.** The text is built in the mod from enums and integers of `StatusReport`.
   No mission title, step title, tool input, path, peer text or session name: those are written by
   other sessions and would be a cross-session injection channel.
2. **Declarative, never imperative.** No sentence addressed to a reader.
3. **Bounded.** At most `STATUS_TEXT_MAX` characters, three lines.
4. **No secret, no ticket, no URL.**
5. **No `context`.** The command leaves no hidden note.
6. Copy says "no model turn", never "free" or "zero tokens": the row is input on the next turn.

### 7.6 Open link

On the minimum CLI (2.1.287) `LinkProps.href` must be `https:` or `http://localhost` (types L5315), so `harnu://` cannot be
used in the band. The 2.1.289 types accept any scheme and host (l.5456–5461, smoke §11.4), so a `harnu://` deep link
becomes possible; it stays unused until an OS protocol handler for `harnu://` exists (the `harnu://` addresses today
are MCP resource addresses, not an OS handler), and the loopback link stays the default and the only link on 2.1.287.
The scheme is:

```
http://localhost:<openPort>/o/<ticket>        ticket = "o_" + 22 base64url chars (128 random bits)
```

- `open-link-server.ts` listens on `127.0.0.1` and `::1`, on a port persisted in
  `<userData>/companion/open-port.json`, **only while at least one band line carries a link**.
- `GET /o/<ticket>`: the `Host` header must be `localhost:<port>` (rebinding guard, same checks as
  `mcp/http-guard.ts`). A known ticket focuses the window and selects the session, exactly as
  `ui.action` does (same rate limit, same audit record). The answer is a static page ("Opened in
  Harnu. You can close this tab."), `Cache-Control: no-store`. An unknown ticket gets the same page
  and no action. No other route, no body, no CORS header.
- A ticket is minted per binding when its first linked line is built and dies with the lease.
- The mod accepts `href` only if it matches
  `^http://localhost:[0-9]{2,5}/o/o_[A-Za-z0-9_-]{22}$`. A `Link` with a refused `href` would
  refuse the whole band tree (types L5315), so a failed match drops the link and keeps the row.

**Inside Harnu's xterm.js.** Neither `Terminal` constructor sets a `linkHandler`
(`TerminalPane.vue:494`, `:791`), so OSC 8 activation falls to xterm's default, which is expected
to be denied like the WebLinksAddon default was (`TerminalPane.vue:201-204`). This wave adds
`linkHandler: { activate: openTerminalLink }` to both constructors and to `HelperPane.vue`, and
teaches `openTerminalLink` (`TerminalPane.vue:205`) one rule before the browser hand-off: a URL of
the open-link shape goes to `window.api.companionOpenTicket(ticket)` (in-app focus, no browser, no
network). Every other OSC 8 link takes the existing `shell:openExternal` path and its protocol
allowlist (`isAllowedExternalProtocol`, `index.ts:242`). This also makes other mods' `Link`s clickable in Harnu.

### 7.7 Redundancy with Harnu's chrome

| Fact             | Harnu chrome (already there)                     | In the terminal, inside Harnu | In the terminal, outside Harnu         |
| ---------------- | ------------------------------------------------ | ----------------------------- | -------------------------------------- |
| Mission position | Topbar mission pill and popover                  | nothing                       | band lead                              |
| Held approvals   | Fleet rail, Approval row, sound and OS attention | the engine dialog             | the engine dialog; band detail (count) |
| Session state    | sidebar dot, Topbar status pill                  | nothing                       | nothing                                |
| Harnu mod state  | hover preview, System Monitor row (P1W4)         | `/harnu-link status`          | `/harnu-link status`                   |
| Usage            | footer                                           | nothing                       | nothing                                |

Noise rules: one row at most; no row without a linked mission; a new line only when the headline
or the held count changes, never per tool call; debounce; TTL; the person's `[-]` collapse is the
engine's and is respected; no toast on a band change.

### 7.8 Contract additions

None — merged into `01-contract.md`:

| Item                                                                                                             | Contract                         |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| ask kind `status`, `AskPayloads.status`, `StatusReport`                                                          | §10, §10.3; `AskId` in §4        |
| `status` answered in every mode                                                                                  | §10.3, §11.5; conformance row 28 |
| `BandParts`, `BandLink` and their length caps on `ui.band.set`                                                   | §9                               |
| `ui.action` as an edge event                                                                                     | §6                               |
| `Ticket`                                                                                                         | §4                               |
| `STATUS_SLA_MS`, `STATUS_TEXT_MAX`, `BAND_TTL_MS`, `BAND_REFRESH_MS`, `BAND_DEBOUNCE_MS`, `OPEN_MIN_INTERVAL_MS` | §7.2                             |
| the `band` state key                                                                                             | §22                              |
| `ui.band`, `ui.command` and the `surface` key                                                                    | §11.1, §11.5                     |
| the reserved "hold with no dialog" line                                                                          | §18                              |

Not in the contract, and local to this wave: the host type `BandLine` (§7.3).

## 8. Arbitration & fallback

No fact family: `ui.band` and `ui.command` have no legacy rival, so no family's `shadow` governs
them (contract §11.5). They need three things: the `surface` key on, the companion mode not
`off`, and a live lease; `ui.band.set` is an observe-only command, so the `channel` key does not need to be `active`
(only `off` refuses it, §7.3). `ui.command` is proven by the first `status` ask the host answers;
`ui.band` is attempt-proven by the first successful `command.result` for `ui.band.set` (contract
§11.2).

| Condition                                                                  | `/harnu-link status`                                                                                                                       | `/harnu-link open`       | Band                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| Mod absent (CLI too old, mode `off`, policy)                               | the command does not exist                                                                                                                 | does not exist           | none                                                                                 |
| `command.register` refused or pinned                                       | `ui.command` not declared; command absent                                                                                                  | absent                   | unaffected                                                                           |
| The mod never completed a hello                                            | the command does not exist (it is registered from `ensureHello`)                                                                           | does not exist           | none                                                                                 |
| Dormant or inert **after** registering                                     | "Harnu mod is off for this session."                                                                                                       | same line                | cleared by TTL                                                                       |
| Kill switch turned off mid-session                                         | the `conn` is revoked and the re-hello is answered `enable: []` (contract §3 item 9): the "off" line, at once                              | same line                | the mod clears the `band` key when it turns inert; no TTL wait                       |
| Host down or restarting                                                    | unreachable line, within one failed fetch                                                                                                  | unreachable line         | cleared by TTL (≤ 90 s + 30 s tick); re-sent after re-hello                          |
| Lease lost mid-session                                                     | unreachable line                                                                                                                           | unreachable line         | cleared by TTL; the host can no longer send                                          |
| Hot reload                                                                 | command re-registered once; state re-read                                                                                                  | same                     | redrawn from `$.state` with no host round trip                                       |
| `/clear`, in-session `/resume`                                             | works on the same `conn` (whether `$.command.register` survives `/clear`, with no `session.start` after it, is untested: LV-P4W2-a step 7) | focuses the re-keyed row | host re-sends the line after `session.rebound` (CQ3: `$.state` may reset)            |
| Headless (`-p "/harnu-link status"`)                                       | the command does not exist: `ui.command` is never enabled headless                                                                         | does not exist           | none (`ui.render` is not raised)                                                     |
| Mid-turn                                                                   | answers at once (`immediate`)                                                                                                              | answers at once          | updates while streaming (smoke C5: 17 ms)                                            |
| Engine permission dialog open                                              | cannot be typed                                                                                                                            | cannot be typed          | not relied on (smoke B2)                                                             |
| Another mod owns the band                                                  | —                                                                                                                                          | —                        | Harnu's row is added above its tree, never instead of it                             |
| A sibling mod wedges the worker                                            | the engine skips the hook: "unknown command"-class failure for that run                                                                    | same                     | the band misses one draw; the next state set redraws                                 |
| `surface` key off, or a CLI above the tested ceiling (key capped at `off`) | features not enabled; command absent on the next spawn                                                                                     | absent                   | none                                                                                 |
| Every family in `shadow`                                                   | answers; line 1 says "observing"                                                                                                           | focuses Harnu            | drawn (row 4): a family's `shadow` does not govern a surface feature                 |
| Key `channel` at `off`                                                     | answers                                                                                                                                    | focuses Harnu            | none: `enqueue` refuses `ui.band.set` (`FEATURE_OFF`); at `shadow` the band is drawn |
| External binding (P4W3), corroborated                                      | `ask` allowed for `status`; `decided`                                                                                                      | selects the row by `sid` | row 4; the command rides on an `events` response                                     |
| External binding, not yet corroborated                                     | `released` (`abstain`) → the unreachable line                                                                                              | no focus                 | none                                                                                 |
| `desktop` / `vscode` / `mobile` surface                                    | text answer (not verified, Q22)                                                                                                            | focuses Harnu            | none                                                                                 |

## 9. Security requirements

Cites SEC-1, SEC-2, SEC-3, SEC-5, SEC-6, SEC-7, SEC-8 and MOD-8. Wave-specific:

- **P4W2-S1.** `/harnu-link` takes two literal arguments and nothing else. No argument reaches the host
  as text; the `status` ask carries two numbers.
- **P4W2-S2.** The status text obeys §7.5. A static test fails if a template interpolates any
  string field of the report.
- **P4W2-S3.** Neither command, the band nor the open link resolves, answers or dismisses an
  approval (SEC-2). The band has no `Button`.
- **P4W2-S4.** The open ticket grants one thing: focus Harnu on that session. It is visible to
  sibling mods and to anything reading the terminal stream (smoke D6), which is why it grants
  nothing else and is rate-limited.
- **P4W2-S5.** `/harnu-link open` acts only for `origin.kind === 'composer'` (the person's Enter, types
  L8217). A plugin's `$.command.run`, the SDK or a bridge gets the refusal line.
- **P4W2-S6.** The loopback route answers one path, checks `Host`, changes no state and returns
  the same page for a known and an unknown ticket.
- **P4W2-S7.** Coverage wording in the status text is the P3W1 enum, never a guarantee (SEC-7).

## 10. UX & copy

**Terminal text** lives in `resources/companion/` as English literals. It is CLI output that the
model also reads, so it is not translated and not routed through i18n (the repo's language policy
covers it). The engine prefixes each output with the plugin name (smoke C4).

| Case                         | Text                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| status, line 1               | `Harnu mod {live\|observing} · approvals {gated\|contested\|not gated}`   |
| status, line 2 (mission)     | `Mission: Step {from} of {of} · {verified} verified · {n} waiting on you` |
| status, line 3 (held > 0)    | `Held in Harnu: {held}`                                                   |
| status, outside Harnu suffix | line 1 ends with ` · outside Harnu`                                       |
| unreachable                  | `Harnu is not reachable. This session runs on hooks.`                     |
| off (dormant or inert)       | `Harnu mod is off for this session.`                                      |
| open, done                   | `Opened in Harnu.`                                                        |
| open, not from the prompt    | `Type /harnu-link open at the prompt to focus Harnu.`                     |
| usage                        | `Usage: /harnu-link status \| /harnu-link open`                           |
| band, mission                | `◆ Harnu Step 4 of 5 · 1 held in Harnu  Open in Harnu`                    |

Mission wording follows `design.md` §8 "Mission progress": a position, never a count as headline.

`observing` is the printed word for `StatusReport.companion === 'shadow'`: "shadow" is jargon to
the operator and to the model.

**Renderer.** One switch in the settings region of the Mods tab (`#mods-companion`, P4W1), a
`ToggleSwitch` plus `SettingHint`. `design.md` gains §6 "Terminal surface (Harnu mod band and
`/harnu-link`, T389)" with the tables of §7.4 and §10, and one §8 line.

| Key                         | `en`                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `harnuMod.surface.label`    | `/harnu-link` commands in sessions                                                                                             |
| `harnuMod.surface.hint`     | Adds `/harnu-link status` and `/harnu-link open` to sessions that load the Harnu mod. Applies to sessions started from now on. |
| `harnuMod.openLink.expired` | That link no longer points at a running session.                                                                               |

All three keys go to `en.json` and `pt-BR.json`. `harnuMod.openLink.expired` is an info toast for
an in-app click on a dead ticket; a browser click gets the neutral page instead.

## 11. Acceptance criteria

```
AC-P4W2-1 [mod-test] Given a decided `status` ask, When `/harnu-link status` runs, Then the hook returns
  text built only from the report's enums and integers and no `turn.start` is raised.
  Evidence: resources/companion/tests/harnu-link-command.test.ts › "status renders the report"
AC-P4W2-2 [mod-test] Given the host stub throws, returns garbage, or answers `released`,
  When `/harnu-link status` runs, Then the text is the unreachable line.
  Evidence: resources/companion/tests/harnu-link-command.test.ts › "status degrades to a local line"
AC-P4W2-3 [mod-test] Given a hello that did not enable `ui.command` (headless, `surface` off, or
  no hello at all), When the module finishes loading, Then `$.command.register` was never called.
  Evidence: resources/companion/tests/harnu-link-command.test.ts › "no command without ui.command"
AC-P4W2-4 [unit] Given the status templates, When scanned, Then no template interpolates a string
  field and no rendered text exceeds STATUS_TEXT_MAX.
  Evidence: tests/companion/surface-text.test.ts › "status text is closed vocabulary"
AC-P4W2-5 [mod-test] Given `origin.kind` other than `composer`, When `/harnu-link open` runs, Then no
  event is queued and the refusal line is returned.
  Evidence: resources/companion/tests/harnu-link-command.test.ts › "open needs the person's Enter"
AC-P4W2-6 [unit] Given two `ui.action` events within OPEN_MIN_INTERVAL_MS, When handled, Then the
  window is focused once and one audit record of kind `focus` is written.
  Evidence: tests/companion/surface.test.ts › "open is rate limited and audited"
AC-P4W2-7 [mod-test] Given band state and `bodyColumns` of 39, 60, 80, 110 and 144, When the
  `AbovePrompt` hook is mounted, Then the row matches the fitting table and the lead is whole.
  Evidence: resources/companion/tests/band.test.tsx › "fits by bodyColumns"
AC-P4W2-8 [mod-test] Given another plugin's `AbovePrompt` tree, When the band draws, Then that
  tree is present below Harnu's row; and with no band state the result equals `next(e)`.
  Evidence: resources/companion/tests/band.test.tsx › "wraps, never replaces"
AC-P4W2-9 [unit] Given a spawned binding with a mission and held asks, When `bandFor` runs,
  Then it returns null.
  Evidence: tests/companion/surface-core.test.ts › "no band inside Harnu"
  Guards: R20
AC-P4W2-10 [mod-test] Given a band whose `expiresAt` has passed, When the TTL tick runs,
  Then the key is null and the hook returns `next(e)`.
  Evidence: resources/companion/tests/band.test.tsx › "a stale line clears itself"
AC-P4W2-11 [mod-test] Given an `href` that does not match the open-link pattern, When
  `ui.band.set` is applied, Then the row renders without a link and the command result is ok.
  Evidence: resources/companion/tests/band.test.tsx › "a bad href never refuses the band"
AC-P4W2-12 [mod-test] Given `http://localhost:<port>/o/<ticket>`, When a `Link` with it is mounted
  on the terminal surface, Then the tree is accepted.
  Evidence: resources/companion/tests/band.test.tsx › "the engine accepts the open link"
AC-P4W2-13 [integration] Given the loopback route, When it receives a wrong `Host`, an unknown
  ticket and a known ticket, Then only the last focuses, and the first two bodies are identical.
  Evidence: tests/companion/open-link-server.test.ts › "one path, one effect"
AC-P4W2-14 [live-verify] Given an external session at 80, 110 and 144 columns in Harnu's xterm.js
  helper pane and in tmux, in both layouts, When a mission line is set, Then one row renders per
  the fitting table and `presentation.isFullscreen` is recorded for each.
  Evidence: LV-P4W2-a (settles Q21)
AC-P4W2-15 [live-verify] Given a band link inside Harnu's xterm.js, When it is clicked, Then the
  session is selected in-app and no browser opens; and an ordinary OSC 8 link opens the browser.
  Evidence: LV-P4W2-b (settles Q21)
AC-P4W2-16 [integration] Given a real `claude --plugin-dir` session against a fake host, When
  `/harnu-link status` is typed, Then the debug file shows no model request and the transcript holds one
  `local_command` row.
  Evidence: tests/cli/harnu-link-command.cli.test.ts › "status spends no model turn" (--with-cli)
AC-P4W2-17 [integration] Given a hot reload, When the module loads again, Then `/harnu-link` is listed
  once and the band redraws from `$.state` without a host request.
  Evidence: tests/cli/harnu-link-command.cli.test.ts › "idempotent across reload"
AC-P4W2-18 [contract] Given the `status` ask fixtures, When host and mod run conformance row 28,
  Then both accept the request and the `StatusReport` in `shadow` and `active`.
  Evidence: resources/companion/tests/fixtures/ask-status.ts; tests/companion/contract.test.ts › "status ask"
AC-P4W2-19 [mod-test] Given a spawned and a tokenless mod, When `ui.band.set` arrives with
  `ui.band` declared and again with it undeclared, Then `$.ui.status` is never called.
  Evidence: resources/companion/tests/band.test.tsx › "no status-line fallback"
AC-P4W2-20 [unit] Given a host restart with a line standing, When the binding re-hellos,
  Then `ui.band.set` is queued again with a new ordinal.
  Evidence: tests/companion/surface.test.ts › "re-sends after re-hello and rebound"
AC-P4W2-22 [unit] Given an external binding that is not corroborated, When a `status` ask and a
  `ui.action` arrive and `bandFor` runs, Then the ask is `released` (abstain), the window is not
  focused and no band line is produced.
  Evidence: tests/companion/surface.test.ts › "nothing for an uncorroborated binding"
AC-P4W2-23 [mod-test] Given a registered command and a re-hello answered `enable: []` (the kill
  switch), When `/harnu-link status` runs, Then no request is sent, the "off" line is returned and
  the `band` key is null.
  Evidence: resources/companion/tests/harnu-link-command.test.ts › "inert after the kill switch"
AC-P4W2-24 [unit] Given every family in `shadow` and the `surface` key on, When a `status` ask
  and a `ui.action` arrive, Then the ask is `decided` and the window is focused.
  Evidence: tests/companion/surface.test.ts › "surface features ignore a family's shadow"
```

**Human**

```
AC-P4W2-21 [human] Given a session running outside Harnu with a linked mission, When the operator
  reads the band at a normal terminal width, Then it is one calm line and does not move while
  tools run.
  Evidence: screen recording docs/specs/T389-companion-mod/evidence/P4W2-band.webm
```

**LV-P4W2-a.** 1. Start a second isolated Harnu with P4W3's outside install on and `channel` at its default. 2. In a Harnu helper
shell and in tmux, start `claude` in a folder that owns a running mission. 3. Resize to 80, 110,
144 columns; capture the last rows (`tmux capture-pane`, xterm buffer over CDP). 4. Repeat with
`CLAUDE_CODE_NO_FLICKER=1` and `=0`. 5. Run `/harnu-link status`; read `isFullscreen` from the host log. 6. Record `claude --version`. 7. Run `/clear`, then `/harnu-link status` again: record whether the command still exists.
**LV-P4W2-b.** 1. With the band up in a Harnu helper pane, dispatch a click on the link cell over
CDP. 2. Assert the selected session id and that `shell:openExternal` was not invoked. 3. Print an
OSC 8 link with `printf` in the same pane, click it, assert `shell:openExternal` was invoked once.

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | `### Added` — `/harnu-link status` and `/harnu-link open` in sessions; a mission line for sessions outside Harnu. `### Fixed` — links printed by a program (OSC 8) are clickable in Harnu's terminals.                                                            |
| `docs/harnu-features.md` | **yes**; bump the marker. One paragraph: the operator may run `/harnu-link status`; its output appears to you as a local-command row and is a snapshot, not an instruction; you cannot run `/harnu-link open`.                                                    |
| `docs/user/`             | `sessions.md` § "Harnu inside the terminal" (both commands, what the band shows and when it does not, that the output is English, that the prefix `harnu-companion` the engine prints is the Harnu mod); `troubleshooting.md` (the unreachable and dormant lines) |
| `design.md`              | new §6 "Terminal surface (Harnu mod band and `/harnu-link`, T389)"; §8 Do line for the band and status text                                                                                                                                                       |
| i18n                     | the three keys of §10 in both locales                                                                                                                                                                                                                             |
| Contract                 | already in `01-contract.md` (§7.8); the wave lands `contract.ts`, fixtures and `api-surface.json` with the code (DOC-7)                                                                                                                                           |

## 13. Rollout & parity gate

No fact family, so no shadow comparison and no parity ledger entry. Gate: the boolean key
`surface`, registered with P1W4's `registerPrefsKey` (default `false`, `observeCap: false`;
contract §11.5). It is turned on by default once AC-P4W2-14 and AC-P4W2-15 pass; off removes both
features from `enable` for sessions started afterwards. The features need the key on, the
companion mode not `off` and a live lease; no family mode governs them. The band needs P4W3 to be visible at all. Nothing legacy is demoted. Merge
bar: QA-4 with `--with-cli` and `--with-e2e`.

## 14. Open questions

| Id       | Question                                                                                                                                                              | Default until settled                                                         | Owner |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| Q-P4W2-a | Master Q21: xterm.js rendering, the OSC 8 click, the fullscreen layout                                                                                                | AC-P4W2-14, AC-P4W2-15; `surface` stays off until green                       | P4W2  |
| Q-P4W2-b | Contract CQ17: does the engine accept `http://localhost` **with a port** in `Link.href`?                                                                              | AC-P4W2-12; on failure the band shows the hint `/harnu-link open` and no link | P4W2  |
| Q-P4W2-c | Master Q26: is the band visible while the engine dialog is open? (smoke B2 covered status and toast only)                                                             | assume not; row 2 stays "none"                                                | P3W1  |
| Q-P4W2-d | Can the model invoke a `$.command.register` command itself, and with which `origin`?                                                                                  | P4W2-S5 refuses every origin but `composer`                                   | P4W2  |
| Q-P4W2-f | Master Q8: is `$.command.register` pinned by `sec-default`? (its README lists `command.register` among the events it passes: read from source, not run, 2.1.277 copy) | registration is probed; the feature is simply absent                          | P1W4  |

## 15. Risks

| Risk                                                                                           | Sev    | Mitigation                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R20: the band competes with Harnu's chrome                                                     | Low    | no band inside Harnu (AC-P4W2-9)                                                                                                                     |
| R29: status output becomes a cross-session prompt-injection channel                            | High   | closed vocabulary, static test (P4W2-S2, AC-P4W2-4)                                                                                                  |
| A refused `Link` removes the whole band, including other mods' rows under it                   | Medium | `href` validated before use; AC-P4W2-11, AC-P4W2-12                                                                                                  |
| The engine reports a band failure through the new `ui.fault` event (CLI 2.1.289, observe-only) | Low    | note only: not hooked (MOD-3, not in `api-surface.json`); the engine now isolates a failing `Client` and falls back to its own drawing (smoke §11.4) |
| A stale mission line outlives Harnu                                                            | Medium | TTL in the mod, keep-alive from the host (AC-P4W2-10)                                                                                                |
| A sibling mod or a web page focuses Harnu through the ticket                                   | Low    | focus only; rate limit; `Host` check; ticket dies with the lease                                                                                     |
| Terminal text is English for a pt-BR operator                                                  | Low    | stated in user docs; the model is the second reader                                                                                                  |
