# Copy affordance in the Markdown viewer

**Date:** 2026-07-13
**Card:** `t121-copy-affordance-in-the-markdown-viewer-per-code-block-copy`
**Status:** design approved, not implemented

## Problem

Getting text **out** of Capy is a manual, lossy operation.

The terminal is the wrong tool for it: xterm selection over a wrapped line copies the
visual rows, so a long boot prompt or a multi-line command comes out of the clipboard
with hard breaks the author never wrote. The operator either pastes something broken or
re-types it.

The Markdown viewer — the surface that renders that content _correctly_ — has **zero**
clipboard affordances. Verified by grep over `MarkdownRenderer.vue`, `MarkdownPane.vue`
and `lib/markdown.ts`: not one match for `copy` or `clipboard`. `MarkdownPane`'s header
toolbar carries view/edit, save, reload and close; nothing that moves content to the
clipboard. Fenced blocks render as bare `<pre><code>` (`MarkdownRenderer.vue` §Inline
code + code blocks) with no per-block control. The human hand-selects, exactly as in the
terminal, just with better line breaks.

This is now the hot path, not a nicety. The agent→human handoff pattern that has emerged
is: the session writes copy-me content — a boot prompt for a sibling session, a command
to run outside Capy, a snippet — to an ephemeral gitignored file (`.capy/handoff/*.md`)
and calls `open_file`. The pane renders it beautifully **and the human still drags a
mouse across it**. The last 10cm of an otherwise clean handoff is manual text selection.

## Design

Two affordances, at two altitudes. Both are pure renderer work — no IPC, no main-process
surface, no new MCP verb.

### 1. Per-code-block copy button (`MarkdownRenderer.vue`)

Every fenced code block rendered by the seam gets a copy control:

- **Placement:** icon button, top-right, inside the `<pre>` box; revealed on hover of the
  block (and reachable by keyboard focus — it must not be hover-_only_, or it is
  inaccessible).
- **Action:** `navigator.clipboard.writeText(<raw block content>)`. The **raw** content —
  the exact text of the fence as the author wrote it — not `innerText` of the rendered
  node, not the sanitized HTML, no syntax-highlight spans, no leading prompt characters.
- **Feedback:** a transient "copied" state on the button, reverting to idle after a short
  timeout.

`MarkdownRenderer` takes a markdown **string** and `v-html`s the sanitized output of the
pure `renderMarkdown` seam. It has no per-block Vue components to hang a button on. Two
viable implementations, decided at build time:

- **(a) In the seam** — a `markdown-it` `fence` renderer rule that emits the button markup
  and stashes the raw fence content (e.g. as a `data-` attribute on the wrapper), with the
  click handled by delegation in `MarkdownRenderer`'s existing root `@click`. Note the
  sanitizer: `renderMarkdown` is the ONE audited sink (`html: false` + DOMPurify), so any
  attribute the button relies on must survive DOMPurify's allowlist — the seam's config is
  part of this change, and the sanitize contract must not be loosened to make it work.
- **(b) Post-render in the component** — walk the injected `<pre>` nodes after `v-html`
  and attach the buttons imperatively, reading the raw text from the DOM.

**(a) is preferred**: the raw fence content is available losslessly at parse time, whereas
(b) must reconstruct it from rendered DOM — precisely the `innerText`-vs-source drift the
test below exists to catch.

The button lives in the **renderer**, not the pane, so every surface that consumes it
inherits the affordance for free: `MarkdownPane` (T74), `MemoryPane` (T79), roadmap cards
(T80), and the future lessons viewer (T120).

Clipboard access is `navigator.clipboard` from the renderer under `contextIsolation` —
it does not need a preload/IPC hop. Confirm this at implementation time in the packaged
build, not just in `npm run dev`; if the API is unavailable in that context, the fallback
is a preload-exposed `clipboard.writeText` over the existing `window.api` seam. Either way
the component's contract is the same.

### 2. "Copy file contents" toolbar action (`MarkdownPane.vue`)

A new icon button in the pane's header toolbar, alongside view/edit · save · reload ·
close. It copies the **current buffer** — the raw markdown text (`draft`), including
unsaved edits — never the rendered HTML. A markdown file copied out of Capy must paste
back into any editor as markdown.

### 3. Blocking prerequisite — `design.md`

The button is a new component with three visual states (**idle / hover / copied**) and a
state transition. Per the repo's UI contract, **`design.md` §6 (Components) must spec those
states, and §7 (Motion) the transition, BEFORE any Vue file is touched — in the same
change.** No raw colors, no ad-hoc keyframes, no off-system sizes in the component; the
token values are `design.md`'s to define, and this spec deliberately does **not** invent
them. Implementation that lands ahead of the `design.md` entry is a contract violation,
not a shortcut.

### 4. Deferred: a `present_snippet` MCP verb

The obvious alternative is a verb that hands the agent a way to _show_ ephemeral content
in a pane without writing to disk. **Deferred, not rejected.** The file-based flow
(`.capy/handoff/*.md` + `open_file`) already covers the need and buys auditability for
free: the content exists as a file the operator can re-open, diff, and delete, rather than
as a message that lives only in a pane's memory. Adding a verb also enlarges the agent API
surface — with its awareness-doc, ACK-shape and confirm-semantics obligations — to solve a
problem a copy button solves in the renderer. Revisit only if file creation proves annoying
in practice.

## Testing

Component tests, no new integration surface:

- **Raw content, not rendered HTML.** Clicking a block's copy button calls
  `clipboard.writeText` with the **exact** raw fence content. Cover a block that renders
  differently from its source — e.g. one containing markup-ish text (`<div>`), entities, or
  trailing whitespace — so an implementation that copies `innerText` of the rendered node
  fails the test.
- **Transient state reverts.** The "copied" state appears on click and returns to idle
  after the timeout (fake timers; assert both edges — appearing and reverting).
- **Multiple blocks are independent.** Copying block B copies B's content and does not
  leave block A stuck in the "copied" state.
- **Toolbar action copies the whole file.** `MarkdownPane`'s copy-file button calls
  `clipboard.writeText` with the full raw markdown buffer — and in edit mode with unsaved
  changes, with the _edited_ buffer, not the last-saved file text.
- **Clipboard is stubbed**, never a real system write.

## Contract obligations

- **`design.md` §6 + §7 — PREREQUISITE, same commit.** The idle/hover/copied states and
  the transition are specced in `design.md` **before** the component is written. This is a
  blocker, not a follow-up.
- **`CHANGELOG.md` — mandatory.** A user-visible affordance ("copy button on every code
  block in the Markdown viewer; copy-file action in the pane toolbar").
- **`docs/capy-features.md` + version marker bump — mandatory.** This is agent-facing under
  the _"UI affordance the agent should proactively offer the user"_ trigger: the handoff
  pattern becomes first-class, and the session should know to use it — write copy-me content
  (boot prompts, commands, snippets) to a gitignored `.md` and `open_file` it; code blocks
  carry copy buttons, so the human never hand-selects. One terse line, per `/capy-awareness`.
- **i18n — both locales, same change.** New strings (block copy label/tooltip, "Copied",
  the toolbar action) land in **both** `en.json` and `pt-BR.json`. The schema is
  `typeof en`; a key missing from `pt-BR.json` breaks the `vue-tsc` build.
- **`docs/user/`** — not triggered by the letter of the gate (no new top-level component, no
  new `src/main/` file, no `tool-catalog.ts` change), but the Markdown-viewer page should
  gain a line: code blocks are copyable, and the pane can copy the whole file.
