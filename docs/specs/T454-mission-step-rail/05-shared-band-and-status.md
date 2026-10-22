# T454 amendment 1 — the shared band slot, the status line, the opt-in

**Status:** specified (not implemented) · **Date:** 2026-10-22 · **Card:** T454, "Amendment 1" ·
**Amends:** [`00-spec.md`](00-spec.md) §4, §6, §9, §10, §12–§15 and [`02-host.md`](02-host.md) §2–§3
in place; this file holds the new design and [`00-spec.md`](00-spec.md) §17 lists every claim it
corrected.

**Why.** T257 (the review-selection band) shipped on the same `AbovePrompt` slot on 2026-10-20,
after round 5. The spec said the slot was unshipped and built its payload on P4W2's `band` key.
Both statements are now false. This file re-derives the sharing, adds the status-line mirror the
operator asked for (mockup 04, `.harnu/out/tui-mods-mockups.html#m4`), and makes the opt-in
permanent.

**Tags.** `MAIN` is this branch after merging `origin/main` (`efd40d47`); a path without a tag is at
`MAIN`. `TYPES` is the `claude-code.d.ts` of Claude Code **2.1.308** written by the
`plugin-authoring` skill (line 1: "Written by Claude Code 2.1.308."); `REF` is that skill's
`reference.md`. [`00-spec.md`](00-spec.md) §2 keeps the 2.1.295 numbering for the rows this
amendment does not touch (§17.3). **Assumption** marks an inference; each is listed in [`00-spec.md`](00-spec.md) §13 (A-12 to A-16).

## 1. What shipped on the slot (D-1)

Read at `MAIN`; nothing here is argued from the old spec.

| Piece                               | Where                                                                                                                                                                 | What it is                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The one `AbovePrompt` hook          | `resources/companion/hooks/register.ts:1466-1479`                                                                                                                     | `const below = await next(e)` first; reads `band`; returns `below` for a non-terminal surface, `hasSurvey`, `maxRows < 1` or a dead line; else `bandView(...) ?? below`                     |
| The view                            | `resources/companion/hooks/surface.tsx:9-26`                                                                                                                          | a pure builder: one `Text dimColor wrap="truncate"` above `below`. No `Button`, no `Input`                                                                                                  |
| The state                           | `BAND` at `register.ts:90`; `BandState` at `lib/command-core.ts:242-249`                                                                                              | `{ v: 1; lead; detail?; hint?; n; expiresAt }`. No `href`, no `label`, no `rail`                                                                                                            |
| The command                         | `runBandSet` at `register.ts:1097-1116`; `parseBandSet` at `lib/command-core.ts:265-286`; `applyBand` at `:312-332`                                                   | keeps only `lead`/`detail`/`hint` (a `link` and any other field are dropped); `line: null` clears; a lower `n` than the highest seen is refused                                             |
| The sweep                           | `sweepBand`, `startBandTimer` at `register.ts:1078-1094`; `BAND_SWEEP_MS` 30 000 at `lib/command-core.ts:345`; `resetBand` at `register.ts:1065-1075`                 | a 30 s tick clears an expired line; `resetBand` zeroes the numbering on a new host boot. The timer stops when the band is empty                                                             |
| The redraw                          | `redrawBand` at `register.ts:1056-1062`                                                                                                                               | `$.ui.invalidate('ui.render')`, called after every state write                                                                                                                              |
| The fitting                         | `fitBand` at `lib/command-core.ts:385-393`; `fitCompact` at `:371-377`; `BAND_MIN_COLUMNS` 40 at `:348`                                                               | tiers 40/80/110/144 with the `◆ Harnu ` mark; **under 40 the compact range `⧉ L21`**, or nothing when even that does not fit (T257 U2d)                                                     |
| The features it declares            | `bandFeatures` at `lib/command-core.ts:339-342`; `register.ts:1488`                                                                                                   | `act.context` and `ui.band`, when `ui.render` registered                                                                                                                                    |
| The command is implemented          | `IMPLEMENTED_COMMANDS` at `lib/command-core.ts:102-111`; `TOKENLESS_OK` at `:114`; `runHandler` at `register.ts:1123-1144`                                            | `ui.band.set` has a `case`; a mod without a spawn token may apply it                                                                                                                        |
| Host gate                           | `reserved.set('ui.band.set', …)` at `src/main/companion/command-gate-core.ts:171-175`; `EXTERNAL_OK` at `:215`; observe-only at `:240-247`                            | origin: **only** the internal subsystem `reviewSelectionBand`; **`requireTrust: 'read-only'`**; a validator for the T257 limits; admitted in `shadow` and for an external profile           |
| Host feature rule                   | `registerReviewSelectionPolicies` at `src/main/companion/feature-policy.ts:84-92`; the reserved-rule merge at `:31-46`; `EXTERNAL_ALLOWED` at `:96-105`               | `ui.band` is enabled for an interactive **`read-only`** binding and nobody else; its comment says the rows "turn the orchestrator contract and every mission band on for nobody" (`:78-83`) |
| The producer                        | `createBandDriver` at `src/main/companion/review-selection-tracker.ts:272-374`; cause at `:258-265`                                                                   | enqueues `ui.band.set` with cause `{ kind: 'internal', subsystem: 'reviewSelectionBand' }`, debounced 500 ms, re-sent every 60 s while the row stands, `line: null` on `cleared`            |
| The numbering                       | `command-queue-core.ts:130` (`n: q.nextN`)                                                                                                                            | one counter per binding for **all** commands, so `n` orders the two producers' commands even though each handler tracks its own highest                                                     |
| The manifest and its drift test     | `resources/companion/api-surface.json` (lists `ui.render`, `$.ui.resolve`, `$.ui.status`, `$.ui.invalidate`, state key `band`); `tests/companion/api-surface.test.ts` | the audit chip `terminal` already follows from the companion's `ui.render` hook (`src/main/mods-audit-core.ts:389`)                                                                         |
| Tests that pin the shipped band     | `resources/companion/tests/context-band.test.tsx`; `tests/companion/review-band-handoff.test.ts`; `tests/companion/review-selection-policy.test.ts`                   | a change to the `band` shape or to the `ui.band` lock fails them                                                                                                                            |
| P4W2 itself, amended by T257 (#130) | `docs/specs/T389-companion-mod/P4W2-terminal-band-and-commands.md:40-41`, `:170-173`, `:182-183`, `:441-449`                                                          | row 1a (the review companion's selection line), "extend, do not replace" for the gate row, AC-P4W2-9 and AC-P4W2-9a                                                                         |

**What did not ship** (checked): `/harnu-link`, the open link and its server, the `surface` prefs
key (`registerPrefsKey` has three callers: `channel` at `command-channel.ts:78`, `external` at
`host.ts:366`, `modsLive` at `mods-observed.ts:58`), P4W2's row 4 (the owner line outside Harnu),
any `Button` in the band, and the `ui.action` emitter (`contract.ts:374` is still
`{ name: 'open' }`).

## 2. Decision: the rail has its own key and its own command (revises Δ1, Δ6, Δ7)

The round-5 spec carried the rail as an optional field of `ui.band.set` into the `band` key. On
`MAIN` that cannot work, for four reasons:

1. **The shipped parser drops it.** `parseBandSet` copies `lead`, `detail` and `hint` and nothing
   else (`lib/command-core.ts:265-286`), and `BandState` has no place for it (`:242-249`). A
   `rail` field would arrive and vanish without an error.
2. **One key, two writers, no priority.** `line: null` clears the whole `band` state
   (`lib/command-core.ts:267`, `:320`) and a lower `n` never overwrites a higher one (`:319`). If
   the rail rode `band`, a rail push would erase a live review selection, a selection clear would
   erase the rail, and whichever command had the higher `n` would win whatever its priority.
3. **The lock is shut on purpose.** `ui.band` is reserved for the `read-only` class by three locks:
   the gate row (`command-gate-core.ts:171-175`), the cause (`reviewSelectionBand` only) and the
   feature rule (`feature-policy.ts:84-92`). The rail's bindings are `agent` or `operator`. Opening
   `ui.band` to them would loosen a lock a shipped feature depends on, in a change that is not
   T257's.
4. **The shipped tests pin the shape.** `context-band.test.tsx` and the API-surface drift test fail
   on a changed `band` value.

**So, for W1:**

| #   | Round-5 spec (Δ)                                                 | Now                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Δ1′ | `ui.band.set` gains `rail?: BandRail`                            | a new command **`ui.rail.set { rail: BandRail \| null }`**, gate row `registerGateRow('ui.rail.set', { feature: 'ui.rail', internal: ['missionRail'], validate: validRail })`, listed in `EXTERNAL_OK`, the observe-only set and the mod's `TOKENLESS_OK` |
| Δ6′ | `ui.band` enabled by `surface` or `rail`; W1 registers `surface` | W1 registers **only `rail`** (`registerPrefsKey<boolean>`, default `false`, `observeCap: false`) and the new feature `ui.rail`. It does not touch `surface`, `ui.band` or their rules. `/harnu-link` and its key stay P4W2's                              |
| Δ7′ | the `band` value gains `rail?`; `railMode` is mod-local          | two new `$.state` keys, **`rail`** (the pushed value, with the mod's `expiresAt`) and **`railMode`** (confirm, field, saving, final). `band` is T257's and is read, never written, by the rail                                                            |
| Δ9  | (new)                                                            | the one hook reads both keys and chooses what to draw (§3)                                                                                                                                                                                                |
| Δ10 | (new)                                                            | the mod mirrors the mission's progress through `$.ui.status` (§4)                                                                                                                                                                                         |

What stays from the round-5 spec: one `ui.render` hook for the pair (MOD-4), the wrap-never-replace
composition, the rail's views and fitting (§6), the actions (§7), the press route, and the
host-resolved target. Only the carrier changes. The prototype ([`01-prototype.md`](01-prototype.md))
is a stand-alone mod with its own `rail` key and kit stand-in host, so its tests of the views and
the focus rules are unaffected; its comment "the proposed `ui.band.set` `rail` field"
(`03-prototype-source.md:35`) now reads "the `ui.rail.set` value".

**The W1 change list in the companion** (all at `MAIN` line numbers): `CommandArgs['ui.rail.set']`
and the `ui.rail` feature id (`contract.ts:435` neighbourhood; `FeatureId` is a plain `string` at
`:26`); the command-to-feature row next to `'ui.band.set': 'ui.band'` (`lib/command-core.ts:94`);
`IMPLEMENTED_COMMANDS` and `TOKENLESS_OK` (`:102-114`); a `case 'ui.rail.set'` in `runHandler`
(`register.ts:1123-1144`) backed by `runRailSet`, which has **its own** `railN` and write chain
(two commands never share a counter, `register.ts:149-153`); `railFeatures` beside `bandFeatures`
(`:339-342`), declared under the same `ui.render` condition (`register.ts:1488`); `sweepBand`
generalised to sweep both keys and to stop the timer only when both are empty (`register.ts:1078-1094`);
`resetBand` zeroing `railN` (`:1065-1075`); `api-surface.json` `stateKeys` gains `rail` and
`railMode`, and `plugin.json`'s `types` contract (`resources/companion/types/index.d.ts`) declares
them. The host side: `registerGateRow('ui.rail.set', …)` and a `ui.rail` rule in
`command-gate-core.ts` / `feature-policy.ts` (the rule of [`00-spec.md`](00-spec.md) §10.1), with
`ui.rail` added to `EXTERNAL_ALLOWED` (`feature-policy.ts:96-105`) for the display-only external
rows, and `isAttemptProven` gaining `ui.rail` (`command-channel.ts:176-178`: today `act.*`, `ui.band` and
`gate.guard`), so a successful result proves the feature. `ui.band` and `reviewSelectionBand` are
not edited.

## 3. One slot, two producers (D-1)

### 3.1 Who can meet in the slot today

| Binding                                                    | `ui.band` (the selection)                                             | `ui.rail`                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| spawned, interactive, trust `read-only` (review companion) | **yes**                                                               | display only, and only when the resolver matches it (§5) |
| spawned, interactive, trust `agent` or `operator`          | no                                                                    | yes, with actions for a child matched by a session link  |
| external, corroborated                                     | no: the rule needs an interactive binding (`feature-policy.ts:85-86`) | owner row, or display-only child row                     |
| headless                                                   | no                                                                    | no                                                       |

Two producers share one binding only in the first row, and there the rail has **no key and no
mode**: it is display only (`actions: []`), so it has nothing to focus. The priority rule below is
therefore a safeguard against the day T257's lock is widened, not a fix for a live conflict. That
is also why the rule can be strict about the person's input (§3.4): the strict case costs nothing
today and protects F-1 later.

### 3.2 The priority rule

A pure function `slotFor(sel, rail, mode, ctx)` in `lib/rail-core.ts`, table-tested. The hook
takes the **first candidate whose view is not `null`**:

| Order | Candidate                                                                              | Why                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | `next(e)` unchanged: non-terminal surface, `hasSurvey`, `maxRows < 1`                  | as shipped (`register.ts:1472`); a survey is the engine's (§3.4)                                                                                      |
| P1    | the rail, while `railMode` is anything but idle (confirm, field, saving, final)        | §7.5 rule 1 and 3 of [`00-spec.md`](00-spec.md): what the person is typing or answering is never removed by a push, an expiry or **another producer** |
| P2    | the review selection, while its `band` is live (`bandLive`, `lib/command-core.ts:305`) | **recommended by the operator**: a live selection wins and the rail returns when it clears. It is the thing the person is looking at right now        |
| P3    | the idle rail, while its `rail` is live                                                | the default content                                                                                                                                   |
| P4    | `next(e)` unchanged                                                                    | nothing to say                                                                                                                                        |

"First **non-null**" matters at the edges: a selection whose range does not fit the width
(`⧉ L85–92` is 8 cells; under 4 nothing fits, `lib/command-core.ts:367-377`) draws nothing, so the rail below it is drawn, not
a blank. Each candidate keeps its own width floor (the selection's compact line,
[`00-spec.md`](00-spec.md) §6.2 for the rail).

### 3.3 The handoff, both ways

| Event                                                                             | What happens                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A selection is set while the rail is idle                                         | `runBandSet` writes `band` and calls `redrawBand` (`register.ts:1105-1110`); the hook now returns the selection row. The `rail` and `railMode` keys are untouched. The status line (§4) keeps showing the progress             |
| A selection is set while the rail holds a field, confirm, saving row or final row | the selection is **stored and not drawn** (P1). The moment `railMode` returns to idle, that write redraws and the selection shows, unless its TTL lapsed (the host re-sends every 60 s, `review-selection-tracker.ts:323-325`) |
| The selection clears: `line: null` (`cleared`, `review-selection-tracker.ts:365`) | `band` is set to `null` and redrawn; the rail row returns at once if its `rail` is still live                                                                                                                                  |
| The selection lapses: no re-send for 90 s (`BAND_TTL_MS`, `contract.ts:68`)       | `sweepBand` clears it on its next 30 s tick (`register.ts:1078-1089`) and redraws, so the rail returns at most 30 s after the expiry                                                                                           |
| The rail is pushed or cleared while a selection stands                            | stored; no visible change. The host publishes the rail on its own clock whether or not the slot shows it, so it is live when the selection ends (one keep-alive a minute per binding, [`02-host.md`](02-host.md) §2.3)         |
| The rail's TTL lapses while the selection stands (Harnu gone)                     | `rail` and the status line are cleared by the same sweep; the selection is unaffected                                                                                                                                          |
| `/clear`, `/resume`, the companion ending                                         | each producer handles its own: the selection by its `cleared` transition, the rail by the host's re-resolution ([`02-host.md`](02-host.md) §1.2). Neither clears the other's key                                               |
| A new host boot                                                                   | `resetBand` zeroes `bandN`; the generalised reset also zeroes `railN` and clears both keys                                                                                                                                     |

### 3.4 Focus and hotkeys at the swap

- **Selection row → no focus target.** `bandView` draws only a `Text` (`surface.tsx:9-26`). A swap
  that puts it where the rail's keys were leaves the band with no `Button` and no `Input`; the
  engine then hands the keyboard back to the prompt (E14, [`00-spec.md`](00-spec.md) §3). That is
  harmless exactly when the person has nothing in flight, which is what P1 guarantees: every state
  in which the next keystroke matters (confirm, field, saving, a final row waiting for `x`) outranks
  the selection. An **idle** rail row loses its keys to a selection; today that row is display only
  (§3.1), so no key is lost.
- **Residual if T257's lock is ever widened to `agent` or `operator`.** An idle rail row that drew
  `c: Claim` and is swapped for a selection takes its keys away. A person who learned the keys and
  presses `c` types it into the prompt and the keyboard goes with it (E15): the K-10 class, named
  as **K-13**. W0 probes it (A-12). A stacked variant, both rows when `maxRows >= 2`, removes it at
  the cost of a second row; it is not adopted (OQ-E).
- **Selection → rail.** The rail's keys reappear but the keyboard is not in the band (E14) until the
  person retakes it with `ctrl+x tab`. No key is stolen.
- **A survey** (`hasSurvey`) returns `below` before any candidate (`register.ts:1472`; the
  prototype does the same, `03-prototype-source.md:641`), and `TYPES:10797-10799` says a hook
  "yields to it". For an **open rail field** that removes the `Input` while the person types: the
  F-1 class. The round-5 spec did not name this swap. It stays specified as yielding, because
  whether a hook may draw under a survey is not declared; it is named **K-14**, and W0 probes it
  (A-13): does a tree drawn under `hasSurvey` render, and what becomes of an open `Input`'s text?
- **The engine's collapse** (`[-]`, `ctrl+x ctrl+a`) hides whichever candidate won; it is not a
  swap and changes nothing here.

### 3.5 Tests this section owes (specified, not run)

In the style of `resources/companion/tests/context-band.test.tsx`: (a) selection only; (b) rail only;
(c) both idle: the selection is drawn and the rail key is intact; (d) both, with the claim confirm
open: the rail is drawn; (e) the selection clears: the rail returns with no push; (f) the selection
lapses: the sweep returns the rail within one tick on the mock clock; (g) a selection whose range
does not fit (`⧉ L85–92` at 6 columns) draws nothing and the rail is drawn; (h) `hasSurvey`: `next(e)`; (i) `ui.rail.set` never touches
`band` and `ui.band.set` never touches `rail`; (j) a `ui.rail.set` with a lower `n` than the highest
seen is refused and the status line is not rewritten. The kit's `ui` noun mounts on the `terminal`
surface (`TYPES:16072`, `:16603`), the way the prototype's tests do.

## 4. The status line (D-2)

### 4.1 The mechanism, cited

`$.ui.status(text)` "pins `text` as this plugin's status line under the prompt, beside the engine's
own pinned notices, until the next call replaces it. One per plugin; `undefined` removes it. … its
first 2000 characters drawn (10000 remotely)" (`TYPES:2502-2513`). It is not the `statusLine`
setting of `settings.json` (§4.5). The companion already calls it (`runStatus`, `register.ts:1019-1026`)
and lists it (`api-surface.json`), so the rail adds no capability and no audit chip.

### 4.2 Why the mod builds the text itself

The shipped `ui.status` **command** cannot carry progress. Its texts are a closed table of two
diagnostic strings (`UI_TEXTS`, `command-gate-core.ts:266-269`; the validator at `:316-319`; the
gate row is `debug: true`, `:155`), because an agent-visible line may say only what SEC-5 allows. The
rail follows the same rule in a different way: `ui.rail.set` carries numbers and closed words
(`BandRail.progress`, `state`), and the **mod** builds the string from them in `runRailSet`. No
host-supplied free text reaches the status line. (A step title never does; it appears only in the
band, §6.5.)

### 4.3 Wording and length

```
◆ Harnu {headline}                    ◆ Harnu Steps 3–4 of 7
◆ Harnu {headline} · {state}          ◆ Harnu Steps 3–4 of 7 · blocked
```

- `{headline}` is the pill's own string for `progressHeadline(derived.progress)`
  (`src/main/mission-progress.ts:130-145`): "Step {n} of {m}", "Steps {n}–{to} of {m}",
  "Step {m} of {m} ✓" (`en.json` `mission.headline`; `design.md:6264-6266`). Never a recount. An
  `empty` headline sets no line.
- `{state}` is the pill's primary state in the short words of [`00-spec.md`](00-spec.md) §6.3 S2
  (`blocked`, `needs you`, `stale`, `re-scope pending`, `delivered`), absent for `active` and
  `total-changed`. The pill's state comes from `missionState` (`src/renderer/src/lib/mission-view.ts`),
  moved to a shared pure module in W3 as before; until then the host computes it from the same inputs.
- The mark `◆ Harnu ` is P4W2's row 4 form, so the line names its source next to other plugins'
  pinned lines.
- It is the **mission's** progress, not the child's own step. A child's band says "Step 3 of 7" (its
  step); the status line can say "Steps 3–4 of 7" (the pill). That difference is deliberate and is K-6.
- **Length.** The longest string at two-digit counts is `◆ Harnu Steps 10–12 of 12 · re-scope pending`,
  44 characters (measured; 47 at three digits). The mod caps the line at `RAIL_STATUS_MAX` = 64 and,
  if it is ever over, drops the state suffix first and the `◆ Harnu ` mark second; it never cuts
  inside a number. The engine's own limit is 2000 characters (`TYPES:2508`), so the cap is the
  mod's, not the engine's. How the engine fits a line wider than a narrow terminal is not declared:
  A-14.

`BandRail` ([`00-spec.md`](00-spec.md) §6.5) gains `progress: { kind; n; to; m }` for both roles
(the pill's headline) and `state?` for both roles (it was owner only). The child's `headline` field
keeps meaning "this session's step".

### 4.4 When it is set and cleared

| Moment                                                                               | Call                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `runRailSet` applies a value whose text differs from the last one the rail set       | `$.ui.status(text)`; an identical text makes no call (the 60 s keep-alive is a no-op here)                   |
| `runRailSet` applies `rail: null` (mission closed, step unlinked, rail switched off) | `$.ui.status(undefined)`                                                                                     |
| The sweep clears an expired `rail` (Harnu unreachable for 90 s)                      | `$.ui.status(undefined)`, in the same sweep that clears the band row: stale progress is worse than none      |
| `headline.kind` is `empty`                                                           | `$.ui.status(undefined)`                                                                                     |
| A person-owned mode (confirm, field) is open                                         | unchanged: the status line carries no focus and is never part of §7.5                                        |
| The mod reloads (hot reload, `/reload-plugins`)                                      | module variables restart; the next push (at most 60 s) pins it again. `$.state` holds the value, not the pin |
| The shipped `ui.status` diagnostic command runs                                      | it replaces the pin (one slot per plugin); the next rail push puts the rail's text back                      |

The mod clears only a line the rail set (a module flag, `statusFromRail`, cleared by the diagnostic
command), so it never removes text another producer of the same plugin pinned.

### 4.5 Coexistence with the user's `statusLine` and Harnu's chain (BUG-196)

Three different things are called "status line":

| What                                                  | Owner                                              | Surface                                       |
| ----------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| the plugin's pinned line, `$.ui.status`               | each plugin, one line                              | under the prompt, beside the engine's notices |
| the `statusLine` setting of `~/.claude/settings.json` | the user, or Harnu's writer when the user has none | the CLI's status bar                          |
| Harnu's footer, fed by that setting's telemetry       | Harnu (BUG-196)                                    | Harnu's own window                            |

- **The rail never touches the second or third.** It reads and writes nothing in `settings.json`:
  not `statusLine`, not the backup key `statusLine_harnu`, not the writer script, not the heal
  (`src/main/statusline-install.ts:93-124` installs Harnu's writer only when no `statusLine` exists
  and otherwise preserves the user's own; `statusline-heal-core.ts` re-installs a removed one).
- **BUG-196's guarantee holds without help from the rail.** "The footer no longer goes silently
  blank when a session has no live statusLine telemetry" (`CHANGELOG.md:245`, under `## 2026-10-19`,
  Fixed) comes from the transcript fallback (`src/main/statusline-fallback-core.ts:1-5`) and the
  "Not reporting" hint (`CHANGELOG.md:246`). A plugin pin is not telemetry: it does not feed the
  footer, and its absence changes nothing there. The rail neither adds a source of footer data nor
  removes one.
- **A user's own `statusLine` command keeps working.** The two lines are different surfaces. That
  both are drawn at once, and in which order, is not declared in `TYPES` or `REF`: A-14, probed in W0
  with (a) no `statusLine`, (b) Harnu's writer, (c) a foreign command.
- **Visibility.** Smoke B2 ([`P4W2`](../T389-companion-mod/P4W2-terminal-band-and-commands.md):53) found
  that a pinned status line, like the band, is not visible while the engine's permission dialog is open.
- **P4W2's text is amended for this source only.** P4W2 §7.4 says the band and the status line
  "never show the same text" and that "this wave never calls `$.ui.status`"
  (`P4W2-terminal-band-and-commands.md:236-239`), with AC-P4W2-19 asserting it (`:479-481`). The rule was
  made for `ui.band.set`, whose line must not be applied as a status fallback. It is kept for
  `ui.band.set`. The rail is the one other caller, and its text is deliberately not the band's text
  (the mission's headline, not the step, the title or the keys). W1 annotates P4W2 §7.4 and
  AC-P4W2-19 (§17.2). For an **owner** row the band lead and the status line can be the same
  headline; the operator's mockup shows exactly that, and OQ-D asks whether to suppress it.

## 5. The opt-in (D-3)

Specified in [`00-spec.md`](00-spec.md) §10.1; the summary here.

- **Off by default, for good.** `registerPrefsKey<boolean>('rail', { default: false, … })` and **no
  wave flips it**. The round-5 sentences "W3 sets it to `true` once LV-T454-a and LV-T454-b pass" and
  "flips `rail` to default `true`" are removed. The live checks gate the waves' acceptance, not a
  default. A default-on idea is **OQ-C**, with the operator as decider.
- **Where it lives, re-checked against `MAIN`.** Settings → **Mods** is the tab `mods`
  (`SettingsDialog.vue:259-263`), which renders `ModsAuditPane` (`:1095`). That pane has the region
  for the Harnu mod's own switches: `<div id="mods-companion">` holding `HarnuModExternal`
  (`ModsAuditPane.vue:219-222`), the P4W3 switch whose key `external` is registered at `host.ts:366-370`
  and read and written over `companion:externalGet` / `companion:externalSet`
  (`companion-ipc.ts:198-199`). The rail's switch is a sibling there (`HarnuModRail.vue`, same
  pattern, `companion:railGet` / `companion:railSet`). The master kill switch is on the **General**
  tab (`SettingsDialog.vue:1582-1625`), not on Mods; the empty `#set-companion-keys` mount at `:1618`
  is the older, unused slot. The round-5 text "Settings → Mods, the Harnu mod's settings region
  (P4W1 part A)" was right about the tab and now names the region.
- **Applies to sessions started afterwards**, because features are fixed at the hello. It also
  needs the Harnu mod itself on (the General tab switch) and the companion mode not `off`
  (`feature-policy.ts:122`).

## 6. Mockup 04 against this spec (not a requirement)

The operator's mockup is the idea. Where it differs from what the card and the earlier rounds fixed,
the differences are listed for the operator, not silently adopted.

| Mockup 04                                                    | This spec                                                                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons `1: open PR`, `2: run tick`, `3: hide`               | letters only. §7.3 bans digits ("a bare digit in an empty [prompt] answers a band Button", `TYPES:1121-1122`); the actions are claim, block, clear block, log (§7.1); `hide` is the engine's `[-]`. OQ-F |
| progress bar, `2 verified`, the PR, `blocker waiting on you` | not drawn. The band carries one step; the blocker is (S4); a PR is a link of the step, not a field of `BandRail`. OQ-F                                                                                   |
| status line `mission 4/6`                                    | the pill's wording per D-2 ("Steps 3–4 of 7"); the sidebar chip form `4/6` (`mission.chip`) is only the narrow-width fallback of the band lead                                                           |
| an orchestrator's band inside Harnu                          | owner inside Harnu gets no row by default (OQ-1); the status line is the part that is available there when the rail is on                                                                                |
| built from `$.process.run`, polling `gh`                     | not used: the host resolves and pushes; the companion may not call `$.process` (SEC-9)                                                                                                                   |

## 7. Assumptions, open questions and risks this amendment adds

They are rows of the canonical tables in [`00-spec.md`](00-spec.md), so each lives in one place:

- assumptions **A-12 to A-16** (§13): a swap from a keyed rail row to a selection; a survey over an
  open field; the plugin status line beside the user's `statusLine`; `$.ui.status` from a command
  handler; the `statusFromRail` flag across a reload;
- open questions **OQ-C to OQ-F** (§14): default-on (the operator decides, default no); the owner
  row's duplicated headline; stacking both rows; which mockup-04 elements are wanted;
- risks **K-13 to K-15** (§15): a selection over a keyed rail row; a survey over an open field; the
  shared plugin status slot.
