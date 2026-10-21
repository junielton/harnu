# PRD — T564: Browser pane

> Written 2026-10-21 alongside the spec (`docs/specs/2026-10-21-T564-browser-pane.md`) and ADR-0021 / ADR-0022.
> Requirements are the 31 decisions + 23b the operator approved on the parent card (T564); this PRD frames
> them and does not re-open them. House shape: problem / who / what this delivers / out of scope / how we
> know / cost & risk.

## 1. Problem

An agent working in Harnu is blind and mute on the one surface most software ends in: a page in a browser.

1. **It cannot show.** An agent that builds an `.html` report, a chart or a dashboard can only say "open
   `docs/x.html`". The operator leaves Harnu, opens a browser, finds the file, and reloads it by hand after
   every edit. A status panel an agent wants to keep fresh has nowhere to live.
2. **It cannot see.** To check a UI change on the dev server, an agent edits code, then guesses. The only
   browser tooling in reach is Playwright, which Harnu uses to verify **itself** (`docs/dev/live-verify-second-instance.md`)
   and which runs in a separate window the operator is not looking at.
3. **It cannot be told.** When the operator sees a problem on a page — "this corner is too rounded" — the
   words to describe _which_ element, in _which_ file, with _what_ styles, are the expensive part. They
   screenshot, annotate, paste, and still have to explain where the code lives.
4. **There is no safe door.** Pointing an agent at a browser today means an MCP server run outside Harnu,
   with no audit, no kill-switch, no folder rules and no way for the operator to see or cut it off.

The result is that visual work with an agent is slower and blinder than text work, and the operator is the
glue between the two.

## 2. Who it's for

- **The operator who builds UI with an agent** (primary): wants the agent to open the page it just changed,
  look at it, fix what is wrong, and wants to point at a thing and say "this".
- **The operator who wants a live status board:** an agent, a Claude Code mod or a Scheduler worker keeps a
  panel current (build state, PR queue, a running metric) beside the session.
- **The operator reading what an agent wrote:** a generated `.html` report, rendered, reloading as it is
  edited.
- **Agents, mods and Scheduler workers** as writers, through the same MCP door, under the same audit.

## 3. The four use cases (one delivery)

| #   | Use case                                   | What it needs                                                               | Example                                                                               |
| --- | ------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| UC1 | **Static preview** of a project `.html`    | `harnu-page://` file serving, path jail, reload on change                   | A generated coverage report opens and reloads as the agent rewrites it                |
| UC2 | **Live panel** an agent or mod keeps fresh | `setData(json)` + `patch`, a sidecar so state survives reload and restart   | A Scheduler `observe` worker updates a "PRs waiting on me" panel                      |
| UC3 | **The dev server on localhost**, verified  | snapshot, click/type/fill, screenshot, console, optional network, emulation | "Make the checkout button squarer, then open it at phone size and look"               |
| UC4 | **Any external site**                      | a hardened guest, tiered access, a visible connection chip                  | The operator reads docs beside the session; an agent may look, but acting needs a yes |

Delivered together because they are one substrate and one door (decisions 1, 2, 4); phasing would build the
overlay-under-native-view problem four times.

## 4. What this delivers

1. **A browser pane in the helper stack** — a real Chromium view, with address, back/forward/reload,
   zoom, device picker, DevTools, maximize-to-main-pane, a visible "connected to ‹session›" chip, and
   Disconnect.
2. **Nineteen `browser_*` MCP verbs** — open, navigate, list, snapshot, screenshot, console, network,
   set-data, patch, eval, click, type, fill, press, wait-for, emulate, upload, download, close — the same
   verbs for sessions, mods and workers (decision 4).
3. **`harnu-page://`** — our own files, served inside a path jail, reloading on change, with a JSON sidecar
   for live state and a small `harnu` API (`getData`, `onData`, `emit`).
4. **Point-and-comment** — pick any node on any page, type a request, and it arrives in the session as the
   operator's own turn, carrying selector, source component when discoverable, HTML, styles and a crop.
5. **Safe by default** — a dedicated hardened partition, a tier table (free vs confirm + lease), a global
   kill-switch, per-pane Disconnect, a 10-minute pause, blocked-folder respect, and "opened by agent" flags.
6. **Zoom and real device emulation** — phone and tablet classes with touch, media queries and
   `<meta viewport>` behaving as on a device.

## 5. Non-goals

- **Replacing Playwright for Harnu's own verification.** Harnu is verified with Playwright over CDP against a
  second isolated instance (decision 30). The browser pane is for the _user's_ projects and pages; it is not
  how Harnu tests itself, and nothing here changes that recipe.
- **Mods subscribing to page events.** Page events go to the owning session only; mods cannot listen
  directly. Deferred, with the conditions to revisit, in ADR-0022 (decision 31).
- **A general-purpose browser.** No tabs strip, bookmarks, history UI, extensions, password manager,
  sync, print, or media-permission prompts. One pane is one page.
- **Popup-opener flows.** OAuth sign-ins that need `window.opener` or `postMessage` back to the opener do
  not work in v1.
- **Acting without the operator's knowledge on a site they are logged in to.** This is a constraint, not a
  feature; the tier table exists to enforce it.
- **Recording and replay, network mocking, cross-browser testing, visual regression.** A test framework is a
  different product.
- **Anything for the System Monitor, the PR canvas or the Scheduler UI** beyond the observe-worker allowlist
  entries. Attribution of guest processes in the System Monitor is a follow-up.

## 6. How we know it worked

Harnu ships no product analytics, so success is verifiable by construction and by live check.

**Deciding signals**

- **The loop closes without the operator moving.** From a session: `browser_open` a localhost page,
  `browser_snapshot`, `browser_click`, `browser_screenshot`, `browser_console` — and the answer to "did my
  change work?" is in the transcript with no window switch. Proven live in a second isolated instance for
  each unit (spec §12).
- **A comment reaches the session in one gesture.** Pick a node on a localhost page, press Enter, and a
  `[harnu-comment]` turn lands in a busy operator-owned session between turns, and in a parked one after a
  headless wake, with the selector and (when the page exposes it) the component path.
- **A live panel survives.** `setData` from a Scheduler `observe` worker updates a panel; reload and an app
  restart show the same state with no write.
- **The gates hold.** Every cell of the tier table (spec §7.1, §7.3) has a unit test; no write verb runs
  with the kill-switch off, with the pane disconnected or paused, or in a blocked folder; no refusal fires
  after a confirm.

**Wrong signals (we would have failed even if the demo worked)**

- An agent acted on a logged-in external site without the operator ever seeing a confirm or a chip.
- A hostile page's text appeared inside a `[harnu-comment]` outside the fenced untrusted-data block.
- A page's `<img src>` carried folder data off the machine from a `harnu-page://` panel.
- A guest got `window.api`, the app preload, or Node.
- Opening a menu over the pane left the menu hidden under the native view.

## 7. Cost & risk

- **Cost:** eight stacked PRs (spec §11.1, U0–U7), each ≤ ~500 lines, one of them a spike with no product
  code. The expensive parts are the overlay-under-native-view freeze (renderer-wide, touches every popover),
  the access layer (a second copy of the `send_terminal` model, for panes), and the live proof, which unit
  tests cannot give.
- **Risk — the page is untrusted and the partition remembers the operator.** One persistent partition means
  an external pane can be logged in as the operator. Mitigated by the tier table (acting on `external` needs a
  lease), the visible chip and flag, the kill-switch and Disconnect. Unresolved: whether an agent may _read_
  such a page without a prompt (spec OQ-1; recommendation: split partitions).
- **Risk — a hostile page talks into the session.** Two channels carry page-derived data into user turns:
  `[harnu-comment]` and `[harnu-page-event]`. Mitigated by an authority split (only the operator's typed
  words are outside the fence), a pure formatter tested against hostile input, and the user-gesture gate with
  an agent-input window. Residual: a page can watch the operator's keystrokes in the composer (spec OQ-2).
- **Risk — the overlay under a native view.** A native view paints above every renderer layer. The freeze
  strategy (spec §2.4) trades a brief still image for correctness; if the capture is slow, panes will flicker
  under menus. Proven or reopened in U0 (A3, A7, A12).
- **Risk — assumptions about Electron.** Twelve are listed in spec §13 and none is proven yet. U0 exists so a
  false one costs a paragraph, not a rewrite.
- **Risk — memory.** A live view is roughly 100–300 MB. Hidden panes are discarded after a timeout and the
  agent cap is 4 per folder, but operator panes are unlimited by decision.
- **Risk — scope.** Nineteen verbs, a protocol, an overlay, emulation, restore, in one delivery. The units
  are ordered so each is usable and each is a stop point; the delivery is "one delivery" for the operator,
  not "one PR".
- **Risk — contract load.** New component, new verbs and new top-level files trigger the awareness, user-docs,
  i18n, keybindings and changelog contracts. They are listed in spec §11 so no unit forgets one.
