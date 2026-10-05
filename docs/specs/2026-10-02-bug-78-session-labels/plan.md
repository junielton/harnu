# BUG-78 — Implementation plan

Spec: [`spec.md`](spec.md). Read §2 (root cause), §5 (design) and §6 (ACs)
before starting; this plan does not repeat them.

Two stacked slices. Slice 1 is the bug fix and ships on its own; slice 2 is the
hardening that keeps surfaces from diverging again. Each slice is one PR, and
slice 2's base is slice 1's branch (stack, don't wait for a merge).

```
main
 └─ fix/bug-78-s1-agent-name-label        (PR → main)
     └─ fix/bug-78-s2-session-title-helper (PR → fix/bug-78-s1-agent-name-label)
```

When slice 1 merges, retarget slice 2's PR to `main` (`gh pr edit <n> --base main`)
and rebase it with `git rebase --onto main <slice-1 tip> fix/bug-78-s2-session-title-helper`.

## Rules for both slices

- Every command needs node from mise on `PATH`
  (`export PATH="$(mise where node)/bin:$PATH"`). A fresh worktree has no
  `node_modules` — run `npm ci` first.
- Gates before pushing, in this order: `npm run format:check`, `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`. The `local-ci` skill runs
  the same set as the CI `verify` job; CI on GitHub may not run (billing block),
  so the local gates are the merge bar.
- Test fixtures use neutral names only (`first-name`, `latest-name`, `spec-ui`,
  `/work/Demo`) — never a client title, path, ticket key or session id
  (`CLAUDE.md` → "Client confidentiality"; `tests/no-client-identifiers.test.ts`
  is the gate).
- Repo contracts:
  - `CHANGELOG.md` — mandatory on both slices (user-visible fix / change).
  - `docs/capy-features.md` — **not** touched: nothing agent-facing changes
    (no MCP verb, ACK shape or grant semantics).
  - `docs/user/` — **not** touched: no new component, main-process file or MCP
    verb; the CI user-docs gate does not fire. If it does, apply the
    `no-user-docs` label with a one-line reason in the PR body.
  - i18n — no new strings. If one becomes necessary, add it to **both**
    `en.json` and `pt-BR.json`.
  - `design.md` — **touched in both slices** (the design contract in `CLAUDE.md`):
    slice 1 amends the teammate-label rule (`design.md:2255-2258`); slice 2 adds
    a "Session name" subsection and points `:1916`, `:6390`, `:6402` at it.
- Commit messages: Conventional Commits, English, scope `sessions` (e.g.
  `fix(sessions): …`). PR body links BUG-78 and this plan.
- Do not edit `.capy/memory/roadmap/*.md` by hand; card moves go through the
  board verbs.

---

## Slice 1 — the fix

|           |                                  |
| --------- | -------------------------------- |
| Branch    | `fix/bug-78-s1-agent-name-label` |
| Base      | `main`                           |
| PR target | `main`                           |
| ACs       | AC1–AC11, AC18 (`### Fixed`)     |

**This slice alone closes BUG-78.**

### Files it may touch

- `src/main/claude-reader.ts` — the `agentName` line in `scrapeJsonlHeader`
  (§5.1) and the doc comments on `ScrapedHeader.agentName` /
  `SessionEntry.agentName` (say: "set only from a line that also carries
  `teamName`; the CLI's `agent-name` rename line is ignored").
- `src/renderer/src/components/SidebarFolder.vue` — `labelFor`: change
  `if (s.agentName)` to `if (s.teamName && s.agentName)`; update its comment.
- `src/renderer/src/components/teammate-grouping.ts` — comment at `:112` only,
  if it no longer describes `labelFor` accurately.
- `design.md` — the teammate-label paragraph at `:2255-2258` → "any teammate
  (`teamName` set) uses its `agentName`" (AC11).
- `tests/claude-reader.test.ts` — new `describe('scanFolders — repeated /rename (BUG-78)')`.
- `tests/sidebar-folder-label.test.ts` — new (mount pattern from
  `tests/sidebar-folder-click.test.ts`).
- `tests/sessions-store.test.ts` — live-rename and reconcile-healing cases.
- `CHANGELOG.md`.

### Steps (TDD — write each test first, watch it fail on `main`)

1. **Reader regression (AC1, AC2, AC4, AC5, AC3).** In
   `tests/claude-reader.test.ts`, new `describe('scanFolders — repeated /rename (BUG-78)')`,
   building lines with the CLI's real two-line rename shape:
   ```ts
   const rename = (sessionId: string, name: string) => [
     JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }),
     JSON.stringify({ type: 'agent-name', agentName: name, sessionId })
   ]
   ```
   - AC1: a user turn, `rename(A)` ×3, more turns, `rename(B)` ×3 →
     `summary === 'B'`, `agentName === ''`, `teamName === ''`.
   - AC2: same, padded with filler lines past 2 MB (`MAX_SCAN_BYTES`): the A
     pair inside the first 2 MB, the final B pair inside the last 512 KB.
   - AC4: an `agent-name` line as line 1, no `teamName` anywhere →
     `agentName === ''`.
   - AC5: `teamName` on one line, `agentName` (non-`agent-name` type) on a
     different line, never together → `agentName === ''`, `teamName` set.
   - AC3: real teammate shape — an `agent-name` line with name `other` first,
     then an `{ type: 'attachment', teamName: 'session-7399191c', agentName: 'spec-ui', … }`
     line, then a user turn → `teamName === 'session-7399191c'`,
     `agentName === 'spec-ui'`.
     AC1/AC2/AC4 must fail on the unmodified reader (`agentName === 'A'`).
2. **Reader fix (§5.1).** Re-run: new tests and the whole existing T99 suite pass.
3. **Sidebar mount tests (AC6, AC7, AC10).** New
   `tests/sidebar-folder-label.test.ts` (mount pattern of
   `tests/sidebar-folder-click.test.ts`): (a) `{ agentName: 'A', teamName: '', summary: 'B' }`
   → row text `B`; (b) teammate `{ teamName: 'session-7399191c', agentName: 'spec-ui' }`
   with its lead present → nested row `spec-ui`; (c) plain synthetic → "New
   session" placeholder; (d) real row, no name → "Untitled". (a) fails before
   the fix.
4. **Label fix (§5.2).** `labelFor`: `if (s.teamName && s.agentName)`; update
   its comment. Amend `design.md:2255-2258` (AC11).
5. **Live rename (AC8).** In `tests/sessions-store.test.ts`: seed a row with
   `{ agentName: 'A', teamName: '', summary: 'A' }`, emit a `session:updated`
   whose `newLines` are the B pair → `summary === 'B'`; mount that row in
   `SidebarFolder` (reuse step 3's helper) → renders `B`.
6. **Healing (AC9).** Store test: commit a row with `agentName: 'A'`,
   `teamName: ''`; stub `window.api.foldersLoad` to return the same session
   with `agentName: ''`; call `reloadModel()` → row `agentName === ''`.
   (`reconcileSessions` is a store closure — drive it through `reloadModel`.)
7. **CHANGELOG (AC18).** Under today's `## YYYY-MM-DD`, `### Fixed`:
   > Renaming a session more than once now updates its sidebar name — before,
   > the sidebar kept showing the session's first name while the top bar showed
   > the new one.
8. Gates, commit (`fix(sessions): a renamed session's sidebar label no longer freezes at its first name`),
   push, open the PR against `main`.

### Done when

All slice-1 ACs pass in tests, gates are green, PR open. Manual check
(optional, recommended): launch an isolated instance
(`docs/dev/live-verify-second-instance.md`), rename a session twice, confirm
sidebar and topbar agree.

---

## Slice 2 — one shared session title

|           |                                                                            |
| --------- | -------------------------------------------------------------------------- |
| Branch    | `fix/bug-78-s2-session-title-helper`                                       |
| Base      | `fix/bug-78-s1-agent-name-label`                                           |
| PR target | `fix/bug-78-s1-agent-name-label` (retarget to `main` after slice 1 merges) |
| ACs       | AC12–AC17, AC18 (`### Changed`)                                            |

Product-visible: more surfaces start showing the Haiku title, fork label and
teammate name. If the operator would rather track it separately, this slice
moves to its own card unchanged — it does not block BUG-78's close.

### Files it may touch

- `src/renderer/src/lib/session-label.ts` — **new**: `SessionLike`,
  `Translate`, `isForkSyntheticLike` (generic type guard), `sessionTitle`
  (spec §5.3). Imports nothing from `stores/`.
- `src/renderer/src/stores/sessions.ts` — `isForkSynthetic` delegates to
  `isForkSyntheticLike`, keeping its exact exported signature; `maybeNotify`
  body (`:3823`), `speakNotification` argument (`:3847`, **no** id fallback —
  BUG-129), sidebar filter (`:2186`, `:2284` — add a `matchesFilter(sessionTitle(…), q)`).
- `src/renderer/src/stores/session-approvals.ts:85` — `sessionSummary`.
- `src/renderer/src/composables/useJumpSearch.ts:144` — `sessionJumpLabel`.
- The components in spec §5.3's table, and nothing else:
  `SidebarFolder.vue`, `Topbar.vue`, `FleetBoardCard.vue`, `InboxRail.vue`
  (`:179`, `:214`), `TriageQueue.vue`, `SidebarReturnZone.vue`,
  `StatusFooter.vue`, `FolderViewSessions.vue`, `FolderViewOwnedCard.vue`,
  `EmptyState.vue`, `CloudSessionPanel.vue`, `CommandPalette.vue`,
  `SessionMenu.vue` (digest `summary:` at `:307`), `MissionPopover.vue`,
  `MissionStepRail.vue`.
- `design.md` — new "Session name" subsection; `:1916`, `:6390`, `:6402` point
  at it (AC17).
- `tests/session-label.test.ts`, `tests/session-label-guard.test.ts` — **new**.
- Existing tests/snapshots asserting the old label of an `aiSummary`-only
  session, a fork label, or a jump/approval label — update, don't delete.
- `CHANGELOG.md`.

### Steps

1. **Helper + unit tests (AC12).** Write `tests/session-label.test.ts`
   table-driven over spec §5.3: teammate; teammate fields without `teamName`
   (the BUG-78 case); fork with a named source, with a source named only by
   `aiSummary.title`, with an unknown source (→ `forkPlaceholder` +
   `session.unnamed`), fork-of-fork (depth 1); plain synthetic
   (→ `session.newPlaceholder`); `summary`; `aiSummary.title` only;
   `firstPrompt` only; whitespace-only `summary` → `firstPrompt`; nothing →
   `''`. Stub `t` echoes `key` + params. Then implement the module.
2. **Store predicate.** `isForkSynthetic` → wrapper over
   `isForkSyntheticLike`; `npm run typecheck` proves the narrowing at
   `spawn-spec.ts:116` and `Topbar.vue:108` still holds.
3. **Migrate call sites (AC13).** One at a time; each becomes
   `sessionTitle(s, sessions.allSessions, t) || <fallback from spec §5.3 table>`.
   Keep each surface's preceding non-session branch (topbar and sidebar
   shell-terminal labels). Do **not** migrate `session-sort.ts` or
   `lib/context-digest.ts`.
4. **Filter (AC16).** Store test: an `aiSummary`-only session is returned by
   the sidebar filter for a query matching its Haiku title.
5. **Consistency (AC14).** Helper returns the Haiku title for an
   `aiSummary`-only session; mounted `SidebarFolder` and `Topbar` render it.
6. **Guard (AC15).** `tests/session-label-guard.test.ts`: export a pure
   `findLabelCascades(src)`; self-test it first (flags
   `s.summary || s.firstPrompt`, `x?.summary ?? ''`, `s.summary?.trim()`,
   `{{ s.summary }}`; ignores `awaySummary || x`, `aiSummary?.summary`, and a
   commented-out cascade); then walk `src/renderer/src/**/*.{vue,ts}` with the
   per-file allowlist from spec §5.4 (one-line reason per entry). Run it before
   step 3 to get the list of offenders, after step 3 to confirm zero.
7. **`design.md` (AC17).** Add "Session name" (the §5.3 order + per-surface
   fallbacks) and re-point the three cascades.
8. **CHANGELOG (AC18).** `### Changed`:
   > A session's name now reads the same everywhere — sidebar, top bar,
   > approval inbox, triage queue, jump palette, footer and notifications all
   > use the auto-generated title when a session has not been renamed, instead
   > of some of them falling back to the first prompt. The sidebar filter finds
   > a session by the name it shows.
9. Gates, commit (`refactor(sessions): one sessionTitle() for every surface that names a session`),
   push, open the PR against `fix/bug-78-s1-agent-name-label`.

### Done when

All slice-2 ACs pass, the guard reports nothing outside its allowlist, gates
green, PR open and stacked on slice 1.

---

## Deferred — suggested cards (not part of this delivery)

Create these as `backlog` cards when the delivery closes (spec §7):

1. **Live `ai-title` refresh** — the live path ignores `ai-title`; needs a
   reader→store `titleSource` so a re-appended `ai-title` can't clobber a
   `/rename`. Note the CLI sidecar `<sessionId>/custom-title.json` as a
   possible authoritative source.
2. **Collapse a resume-fork onto its parent row** — BUG-78 "Second finding".
3. **Topbar title edit is not persisted** — `commitTitle` mutates renderer
   memory only; decide read-only vs. sending `/rename` to the PTY.
