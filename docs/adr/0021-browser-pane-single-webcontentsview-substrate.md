# ADR-0021 — The browser pane is one main-owned `WebContentsView` for every use case, and overlays are handled by freezing the view

**Status:** Accepted (substrate chosen and the spec's open questions resolved by the operator, 2026-10-21)
**Date:** 2026-10-21
**Author:** agent (T565, design card for T564)
**Technical context:** `docs/specs/2026-10-21-T564-browser-pane.md`, `docs/prds/T564-browser-pane.md`, `src/main/index.ts` (`createWindow`), `src/renderer/index.html` (CSP), `src/renderer/src/components/HelperStack.vue`, `HelperPane.vue`, `lib/pane-registry.ts`, ADR-0020

---

## 1. Context

Harnu needs a pane that renders web pages for four use cases: a static `.html` preview, a live panel an agent
keeps updating, the project's dev server, and arbitrary external sites. Agents and the operator both drive it.
Three facts of the current app constrain how.

1. **The renderer is the app.** It runs with the app preload (`window.api`) and a strict CSP
   (`default-src 'self'`, no `frame-src`). Anything rendered inside it shares its process tree and its trust.
2. **The app window itself is not sandboxed** (`sandbox: false` in `createWindow`), and its navigation guard
   exists precisely so foreign content never replaces the app.
3. **Agents must be able to read and act on the page,** by accessibility tree, screenshot, console, input and
   script. That needs the page's `webContents`, in main, not a DOM the renderer happens to hold.

Four substrates are real candidates:

| Option                                         | Isolation | Agent can drive it | Overlay with app UI  | Cost                           |
| ---------------------------------------------- | --------- | ------------------ | -------------------- | ------------------------------ |
| `<iframe>` in the renderer                     | weak      | no (cross-origin)  | works                | CSP loosened for the whole app |
| iframe for our pages, native view for the rest | mixed     | partly             | works for half       | two code paths, two bug sets   |
| `<webview>` tag                                | OK        | via main           | broken (also native) | Electron discourages it        |
| **`WebContentsView` owned by main**            | strong    | yes (CDP)          | broken, solvable     | bounds sync + freeze           |

## 2. Decision

**One substrate: a `WebContentsView` created and owned by the main process, for all four use cases.**

- **D-1 — Main owns the view; the pane owns geometry.** The view is created in main (at a verb or at the
  operator's open) and positioned with `setBounds` from a rect the renderer reports. The renderer owns the
  header and the chrome and never touches `webContents`. This is the same ownership split ADR-0020 chose for
  agent terminals (main spawns, the pane adopts), and it lets an agent-opened pane exist, load and answer
  reads while the operator is looking at another folder.
- **D-2 — A hardened guest.** Two dedicated persistent partitions, `persist:harnu-browser` for panes the
  operator opened and `persist:harnu-browser-agent` for panes an agent opened (the operator resolved spec Q1
  this way on 2026-10-21, amending the single partition of parent decision 7, so an agent pane never carries the
  operator's logins). `sandbox: true`, context isolation on, Node off, no app preload, a second preload for the
  overlay's outline and pins and for the `harnu` API of our own pages only. The comment composer is **docked in
  the app's pane chrome**, not in the guest (spec Q2), so the page cannot read what the operator types. The
  app's CSP is not touched.
- **D-3 — The overlay problem is solved once, by freezing.** A native view paints above all renderer DOM and
  cannot be clipped to a region. When any app layer (menu, dialog, palette, popover, toast) overlaps a
  visible pane, or a drag begins, main captures the view with `capturePage()`, the renderer paints that image
  as an `<img>` in the pane's host, and the view is hidden (`setVisible(false)`). When the layer closes the
  view returns and the image is removed. Layers register themselves through one composable
  (`useNativeOverlay`), so a new popover cannot forget to.
- **D-4 — Our own pages get no special substrate.** They are served by a custom protocol, `harnu-page://`,
  into the same guest. There is no iframe path for them.

## 3. Alternatives considered

| Option                                                      | Why not                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`<iframe>` for everything**                               | Loosening `frame-src` weakens the CSP of the whole app for the sake of one pane. Cross-origin frames cannot be driven or even read by agents; the page's cookies and storage are not isolated from the app's session. `X-Frame-Options` and frame-ancestors break many real sites, so UC3 and UC4 would fail on exactly the pages that matter.                                   |
| **Hybrid: iframe for `harnu-page://`, native for the rest** | Removes the overlay problem for half the cases and doubles everything else: two navigation policies, two ways to read the page, two ways to inject the overlay, two keyboard-focus models, two test suites. The overlay problem returns the first time anyone previews a page that embeds an external frame. "Works for our pages only" is the failure the card exists to avoid. |
| **`<webview>` tag**                                         | It is a native out-of-process surface too, so it **has** the overlay problem, plus Electron's own guidance to avoid it (the guest is a DOM element of the renderer and shares more of its lifecycle). It would gain nothing over `WebContentsView` and lose main-side ownership.                                                                                                 |
| **Shrink or clip the view instead of freezing**             | `WebContentsView` takes a rectangle. A menu that cuts a corner of the pane cannot be expressed as a smaller rectangle, and shrinking the pane every time a toast appears shifts the page's layout under the user.                                                                                                                                                                |
| **Hide the view with no replacement image**                 | A pane that goes blank whenever a popover opens reads as a crash. The frozen frame is a few tens of milliseconds of work for continuity.                                                                                                                                                                                                                                         |
| **Separate `BrowserWindow` for the browser**                | Leaves the helper stack; loses the split layout, maximize toggle, folder-scoped visibility and per-folder hide. It would also need its own focus, shortcut and lifecycle plumbing that the pane gets for free.                                                                                                                                                                   |

## 4. Consequences

- **A renderer-wide obligation.** Every layer that can overlap a pane must register with
  `useNativeOverlay`. A layer that does not is hidden under the view. A lint-style test enumerates the
  popover and dialog components and asserts they register; a new unregistered layer fails CI. Tooltips are
  deliberately exempt and may clip under a view.
- **A visible cost, accepted.** While a layer overlaps a pane the operator sees a still image, not the live
  page. The page keeps running; agent verbs keep working. If `capturePage()` is slow the pane will visibly
  flicker under menus; budget 100 ms at 1280×800 (spec assumption A12), proven in the spike. Toasts are the
  frequent case; the operator accepted it (spec Q13) rather than making toasts avoid pane rects.
- **Drags freeze every visible view.** Without that, the pointer enters the native view during a splitter
  drag and the renderer stops receiving `pointermove`.
- **Keystrokes need forwarding.** A focused view eats keys before the renderer's keybinding engine. Main
  forwards chords via `before-input-event`, with a small "page owns" list (copy, paste, undo, find, zoom).
  Every new action id follows the T486 contract.
- **Two processes parse and own page state.** The renderer holds geometry and chrome; main holds the view.
  A pane that is not mounted still has a live `webContents` until it is discarded, so memory is bounded by
  the 4-per-folder agent cap plus a hide-timeout discard (spec §10.1), not by what the operator is looking at.
- **`pane-registry.ts` gets a `browser` entry that cannot use `maxInstances`.** The registry's cap recycles the
  _oldest_ pane silently; an agent hitting the cap must be **refused** ("reuse one"), so the cap lives in the
  verb handler (spec §2.2).
- **Pixel verbs on a hidden view are an open dependency.** Screenshots of a pane that was never shown rely on
  `capturePage` or CDP `Page.captureScreenshot` working with throttling lifted (assumption A3). If that
  fails, the fallback is a briefly shown view or an off-screen window, which changes §2.3.
- **The window prefs the guest must not inherit are named.** `createWindow` has `sandbox: false` and
  `autoplayPolicy: 'no-user-gesture-required'`; the guest set differs on both (spec §3.1), so a future edit to
  the app window cannot loosen the guest by accident.
- **DevTools coexists with the debugger only if assumption A4 holds.** If it does not, the DevTools button
  detaches the CDP session and verbs refuse while it is open.
- **Reversibility.** The pane type, the verbs and the protocol do not depend on the substrate beyond
  `setBounds` and `capturePage`. If the freeze proves unacceptable in the spike, the decision to re-open is
  D-3 only, not D-1.

## 5. When to re-open

- The spike (U0) shows `capturePage()` over ~250 ms at 1280×800, or visible tearing on Linux Wayland that
  `setBounds` rounding cannot cure (A7, A12).
- Electron ships a supported way to clip or composite a `WebContentsView` beneath renderer DOM, which would
  replace D-3 with something better.
- A second app-wide overlay class appears that cannot register itself (for example, a native menu the app
  does not control), making "register every layer" unenforceable.
- Memory telemetry or operator reports show the per-view cost forces a global live-view cap, which would be a
  new ADR rather than an edit to this one.
