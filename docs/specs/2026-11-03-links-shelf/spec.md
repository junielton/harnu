---
status: approved
tier: complex
mockup: docs/design/links-shelf/
---

# Links shelf — a footer gallery for the links of a session

## Problem

Pasted screenshots already have a home: the footer's Pasted-images pill and popover. Links do
not. In a long session the task link, the PR link, the Figma frame and the doc the operator pasted
scroll away inside the transcript, and the PR the agent opened is just as hard to find again. There
is no place to see them, copy them, or hand one back to the session.

Request atoms (operator, 2026-11-03):

- R-1 Links and important references posted in a session should land somewhere, like images do.
- R-2 The operator wants to look them up later and reference them again.
- R-3 It should feel like the existing image gallery in the footer.
- R-4 Keep it basic: no page titles, no network — just the link, made readable from the URL itself.

## Goals

- G-1 A `🔗 N` pill next to the `🖼 N` pill opens a popover listing every link of the active
  session, newest first, readable at a glance without any network call.
- G-2 Each link can be opened, copied, or referenced back into the session composer.
- G-3 The same list can be widened to every session of the folder.

**Non-goals:** resolving page titles, PR state (open/merged), favicons, or any other network
lookup (deferred to a v2 if the URL-derived label proves too thin); persisting links anywhere
Harnu owns — the transcript stays the only source; a keyboard shortcut; an MCP verb.

**Anti-goals:** a list that leaks secrets in URLs to new places (the shelf only shows what the
transcript already holds, on this machine); a list cluttered by URLs from tool output (fetched
pages, logs, `npm` output); any extra process, hook or file written into the user's session.

## Slices

### S-1 · Links shelf: transcript link index + footer pill and popover

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/session-links.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/StatusFooter.vue`, `src/renderer/src/components/FooterLinksPopover.vue`, `src/renderer/src/composables/useSessionLinks.ts`, `src/renderer/src/stores/ui.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/user/sessions.md`, `docs/harnu-features.md`, `tests/session-links.test.ts`, `tests/footer-links*.test.ts`, `docs/specs/2026-11-03-links-shelf/`, `docs/design/links-shelf/`
- produces: links-shelf
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12

## Acceptance criteria

| id    | statement | proof | refines/inherits | covers |
| ----- | --------- | ----- | ---------------- | ------ |
| AC-1  | The main process extracts every `http(s)` URL from a session transcript's **user text** and **assistant text** blocks only (never `tool_use` input or `tool_result` content), deduplicated by URL, keeping the latest occurrence, ordered newest first. Each entry carries `url`, `kind`, `label`, `detail`, `source` (`user` for user text, `agent` for assistant text), `at` (ISO time of the latest occurrence) and `excerpt` (the surrounding sentence of that occurrence, trimmed to ~120 chars). | test:tests/session-links.test.ts::extracts user and assistant links only | — | R-1, R-2 |
| AC-2  | Classification and label come from the URL alone, with no network call anywhere in the module: GitHub `/<owner>/<repo>/pull/<n>` → kind `pr`, label `owner/repo #n`, detail `GitHub PR`; GitHub `/issues/<n>` → kind `issue`, label `owner/repo #n`; ClickUp `app.clickup.com/t/<id>` → kind `task`, label `Task <id>`; Figma `/design|file/<key>/<name>` → kind `figma`, label = the decoded file name, detail `node <id>` when `node-id` is present; `docs.google.com` / `notion.so` → kind `doc`; anything else → kind `web`, label = host + path without query or hash. | test:tests/session-links.test.ts::classifies and labels from the URL | AC-1 | R-4 |
| AC-3  | URL boundaries are clean: trailing `.` `,` `;` `:` `)` `]` `>` `'` `"` and a closing backtick are stripped, a markdown link `[text](url)` yields only `url`, and a URL wrapped in `<…>` is unwrapped. | test:tests/session-links.test.ts::strips trailing punctuation and markdown | AC-1 | R-1 |
| AC-4  | IPC exposes two reads on `window.api`: links of one session (by session uuid) and links of a folder (every session of that folder, grouped by session with its title, link count and latest activity, newest session first). Both resolve transcripts only through the sessions Harnu already knows — no caller-supplied file path is ever read. | test:tests/session-links.test.ts::folder scope groups by session | AC-1 | R-2, G-3 |
| AC-5  | The `🔗 N` pill sits immediately right of the `🖼 N` pill, uses the same tokens (closed `bg-surface-2 text-text-2`, open `bg-accent-soft text-accent border-accent-line`), hides when N is 0, the session is synthetic, or nothing is selected, and joins the footer's popover mutex (opening it closes the images, usage and GitHub popovers and vice versa); Esc and an outside click close it. | capture:footer@fechado | — | R-3, G-1 |
| AC-6  | The popover matches the approved mockup `footer--links`: header `Links` + `<folder alias> · N` + a `Session · Folder` toggle; one row per link with a kind icon, the label (mono for kind `web`/`doc`), a detail line with the source chip (`you` / `agent`), and the time; on hover the time gives way to Open · Copy · Reference and the excerpt appears under the row; a footer note says where the list is read from. | capture:footer@hover | AC-1, AC-2 | R-3, G-1 |
| AC-7  | The `Folder` toggle switches the list to every session of the folder, grouped under each session's title with its count, newest session first; `Session` switches back. | capture:footer@pasta | AC-4 | G-3 |
| AC-8  | Open hands the URL to the OS browser (http/https only); Copy writes it to the clipboard and shows a `Link copied` success toast; Reference writes the URL into the selected session's PTY **without a newline** through the same path the images popover's Re-attach uses. Reference is disabled — with an inline reason line — when the session has no live PTY. | capture:footer@sem-pty | — | R-2, G-2 |
| AC-9  | A URL pasted into the active session appears in the pill count within a few seconds, without switching sessions or reopening the popover. | capture:footer@aberto | AC-5 | R-1 |
| AC-10 | Every visible string goes through i18n with keys present in both `en.json` and `pt-BR.json`; `design.md` §6 documents the Links pill + popover next to the Pasted-images section; `CLAUDE.md`'s design-entity map lists `FooterLinksPopover.vue`; `CHANGELOG.md` has a dated `Added` entry; `docs/user/sessions.md` explains the shelf; `docs/harnu-features.md` tells the agent it can point the operator at the footer Links popover (version marker bumped). | script:node scripts/ci/i18n-parity.mjs && node scripts/ci/changelog-gate.mjs && node scripts/ci/user-docs-gate.mjs | — | R-3 |
| AC-11 | This spec lands at `docs/specs/2026-11-03-links-shelf/spec.md` and the approved mockup at `docs/design/links-shelf/`, unchanged in content, and the spec gate passes. | script:node scripts/ci/spec-gate.mjs | — | R-1 |
| AC-12 | Typecheck, lint and the full test suite are green. | script:npm run typecheck && npm run lint && npm test | — | R-1 |

## Amendments · Deviations

| date | kind | what changed | by |
| ---- | ---- | ------------ | -- |
