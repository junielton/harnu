# Browser tabs, a start page and a load error

**Status:** PRD v1 (2026-11-18) · **Spec:** `docs/specs/2026-11-18-browser-tabs/spec.md` · **ADR:** `docs/adr/0026-browser-pane-one-view-per-tab.md` · **Mockup:** `docs/design/browser-tabs/` (approved 2026-11-18, one screen, 10 states)

This PRD says what the operator and the agents see. The spec says what is built, in which slices, and how each criterion is proven.

## 1. Who is this for

The operator, who keeps a dev server, its docs and a signed-in tool open beside a session, and today gets one more pane in the split for each page. And the agents that drive browser panes, which today need a second pane to compare two pages.

## 2. The problem in one paragraph

A browser pane is one page. Every extra page, including every link a page opens in a new window, is another pane, so the split fills up. A pane opened from the Topbar is an empty dark rectangle, and a page that fails to load (a dev server that is not up yet) is a blank white rectangle that says nothing. The address field shows two borders on focus, and on a narrow pane the agent's "Connected to…" pill crowds the header.

## 3. What the operator sees

- **One tab:** the pane is exactly as today, plus a `+` in the header.
- **Several tabs:** the tabs take the title's place in the header; the active one opens into the address bar, with no accent line. Right-click a tab for New tab to the right, Reload, Duplicate, Move to a new pane, Close other tabs, Close tab. Ctrl+T, Ctrl+W, Ctrl+Tab work while the pane has focus.
- **Logins:** a login in one tab is there in every tab of the same pane, and in every pane the operator opened, as today. An agent's pane keeps its own login store.
- **The Topbar Browser button** adds a tab to the last browser pane the operator used in this folder (Shift+click: a new pane).
- **A link that opens a new window** becomes a tab next to its page.
- **Narrow pane:** inactive tabs shrink to their icon; what still does not fit sits behind a `+N` list.
- **Start page:** a pane or tab with no address lists the servers running in this folder (Docker stacks and dev servers started in its Harnu terminals) and the recent sites of this folder's operator panes (query strings and token-like path parts left out). The address field is focused. Agent panes never show it.
- **Load error:** "localhost:8000 refused to connect", a one-line hint, the error code, Reload, and on a local host "Reload when it is up", which loads the page by itself once the server answers.
- **Agents:** the agent's presence is one pulsing icon in the header (browser and terminal panes); hovering it says which session is connected and what it is doing. The tab the agent drives shows a small accent dot.
- **After a restart** every tab comes back; only the active one loads.

## 4. What the agents see

`browser_open({ paneId, url })` opens a tab in a pane the agent opened. Every tab verb takes an optional `tabId`, defaulting to the active tab. `browser_list` lists each pane's tabs. A pane holds at most 8 tabs; an agent cannot open a tab in an operator pane.

## 5. Edge cases

- **Closing the last tab** closes the pane.
- **Move to a new pane** keeps the page, its history and its partition; an agent's tab can only move within agent panes.
- **A popup storm** stays capped at one new tab per user activation.
- **A ninth tab** is refused; the `+` is disabled with a hint.
- **Aborted loads** (the operator navigating away mid-load) never show the error page.
- **"Reload when it is up"** stops after 10 minutes, on any navigation, and when the tab closes.
- **No servers and no history:** the start page shows nothing but the focused address field.
- **A discarded tab** revives when clicked, like a discarded pane today.
- **Device emulation and zoom** stay per pane and apply to every tab.

## 6. Alternatives considered

- **Tabs as a group of panes** (each tab a pane, the strip switching which one shows). Rejected: every pane-level rule (partition, access, lease, chip, network capture) would need a group concept, and the split's layout state would grow.
- **One view per pane, tabs as saved addresses** (switching a tab navigates the one view). Rejected: switching loses the page state, scroll and form input, and a background tab cannot keep loading.
- **The start and error pages as `harnu-page://` pages loaded in the view.** Rejected: they would run as untrusted page code with a ticket each, and could not read Harnu's server list without a new bridge. Drawn as renderer DOM over the hidden view, as the "Paused to save memory" placeholder already is, they cost no page and no protocol.
- **A second row for the tab strip.** Rejected by the operator's minimalism rule: a one-tab pane would pay for a row it does not use.
