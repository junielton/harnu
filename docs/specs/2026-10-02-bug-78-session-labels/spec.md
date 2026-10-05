# BUG-78 — A renamed session's sidebar label freezes at its first name

|        |                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| Card   | `BUG-78` (board, `kind: bug`, `priority: high`)                                                                     |
| Status | Spec — reviewed (§11), planned                                                                                      |
| Date   | 2026-10-02                                                                                                          |
| Plan   | [`plan.md`](plan.md)                                                                                                |
| Scope  | Session title/label pipeline only: `claude-reader` scrape → renderer `Session` → every surface that names a session |

## 1. Problem

The operator runs `/rename <new name>` in a session that has already been
renamed once. Claude Code confirms the rename, the **topbar** shows the new
name, but the **sidebar row** keeps showing the session's **first** name —
forever, across reloads, rescans and app restarts. Any session renamed two or
more times is affected; a session renamed once looks fine, which is why the
bug reads as "older sessions don't update".

## 2. Root cause (proven 2026-10-02)

Two defects compound. Neither one alone produces the symptom.

### 2.1 The reader mistakes the CLI's `agent-name` metadata line for teammate identity

Current Claude Code (measured on `2.1.287`) appends **two** lines on every
`/rename`:

```jsonl
{"type":"custom-title","customTitle":"<name>","sessionId":"<uuid>"}
{"type":"agent-name","agentName":"<name>","sessionId":"<uuid>"}
```

`scrapeJsonlHeader` (`src/main/claude-reader.ts:548`) reads `agentName`
**first-wins from any line** that has a string `agentName`:

```ts
if (!header.agentName && typeof obj.agentName === 'string') header.agentName = obj.agentName
```

That field exists for T99 agent-teams **teammates**, whose transcript lines carry
`teamName` + `agentName` top-level. The CLI's `agent-name` line matches the same
test, so a plain renamed session gets `agentName = <first rename>` and keeps it
for the life of the transcript. `customTitle` is correctly latest-wins
(`claude-reader.ts:551`, plus `deriveTitles` in the tail pass), so `summary`
is right — only `agentName` is frozen.

### 2.2 The sidebar label prefers `agentName` over `summary`, unconditionally

`labelFor` in `src/renderer/src/components/SidebarFolder.vue:161`:

```ts
if (s.agentName) return s.agentName          // T99: a teammate shows its agent name
...
return s.summary || s.aiSummary?.title || s.firstPrompt || t('session.unnamed')
```

It never checks `teamName`, so the stale `agentName` from 2.1 wins over the
correct `summary`. `Topbar.vue` `displayTitle` (`:103`, cascade at `:113`) has no `agentName`
branch, which is exactly the observed divergence: topbar correct, sidebar
stale.

### 2.3 Evidence

Measured read-only on one client project (`~/Workspace/org/…`, 62 transcripts,
2026-10-02). No transcript content is reproduced here.

| Measurement                                                  | Result                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcripts with a `/rename` (`custom-title` lines)          | 11 of 15 non-teammate transcripts                                                                                                                 |
| …of those, also carrying `agent-name` lines                  | 11 of 11; keys are exactly `{type, agentName, sessionId}` — never `teamName`                                                                      |
| Real T99 teammates                                           | 47; each carries `teamName` **on the same line** as its first `agentName` (an `attachment` line near byte 370); **none** has an `agent-name` line |
| Transcripts whose first `agent-name` ≠ latest `custom-title` | 4 (call them A–D; sizes 3.5–10.3 MB)                                                                                                              |
| …of those, stale in the sidebar                              | 3 — A, B, C; every one except D                                                                                                                   |
| Why D escapes                                                | its first `agent-name` sits at byte 2 302 092, past the 2 MB head-scan cap (`MAX_SCAN_BYTES`), so `agentName` is never set                        |
| Main-process model (`get_session` preview) for all four      | correct (latest name)                                                                                                                             |

Every session whose first `agent-name` differs from its latest title is stale,
and only those. That is the bug, end to end.

### 2.4 Why the earlier hypotheses failed

The card's rounds 1–4 measured `summary` at every layer and found it correct
everywhere — which it is. Nobody measured `agentName`, because the label
cascade looked like `summary`-first (`SidebarFolder.vue:134` at the time). The
`agentName` short-circuit sits above that line.

## 3. Goals

- **G1** — A renamed session's sidebar label is its **latest** name, after any
  number of renames, live and after reload/restart.
- **G2** — A CLI metadata line can never again be taken as T99 teammate
  identity: `agentName` is set only for a real teammate.
- **G3** — Defense in depth: a label uses `agentName` only for a real
  teammate (`teamName` set), so a future stray `agentName` cannot freeze a label.
- **G4** — One shared title function, so surfaces naming the same session
  cannot diverge again (the topbar/sidebar split is what hid this bug), and a
  test that fails when a new surface hand-rolls its own cascade.
- **G5** — Existing installs heal with no user action: the first scan after
  upgrade drops the stale value.

**BUG-78 is fixed by slice 1 alone (G1–G3, G5).** Slice 2 (G4) is the
hardening the delivery was asked for; it also changes what several surfaces
show (§5.2), so it is reviewed on its own merits and can be split onto its own
card without blocking the bug's close.

## 4. Non-goals

- Fork/resume duplicate rows (card's "Second finding") — deferred, §7.
- Persisting the topbar's inline title edit — deferred, §7.
- Live refresh of `ai-title` — deferred, §7.
- Reading the CLI's `custom-title.json` sidecar — deferred, §7.
- Any change to teammate grouping (`teammate-grouping.ts`), which keys on
  `teamName` only and is unaffected (§7).
- Changing _which_ title wins (`custom-title` > `ai-title` > Haiku
  `aiSummary.title` > first prompt). The order stays as the sidebar and topbar
  use it today; slice 2 extends that order to the surfaces that lack it.
- A teammate's own `/rename` (OQ1).

## 5. Design

### 5.1 Reader — `agentName` only from a teammate line (slice 1, fixes 2.1)

In `scrapeJsonlHeader`, read `agentName` only from a line that **also carries a
string `teamName`**:

```ts
if (!header.agentName && typeof obj.agentName === 'string' && typeof obj.teamName === 'string')
  header.agentName = obj.agentName
```

Why "same line carries `teamName`" rather than "skip `type: 'agent-name'`":
it encodes what a teammate _is_ (the T99 contract: both fields top-level on
teammate lines, §2.3) instead of blacklisting the one line type seen today, so
a future CLI metadata line that grows an `agentName` is also ignored. The two
rules agree on all 62 measured transcripts.

`teamName` stays first-wins from any line, unchanged. The sessions-index fast
path (`toSessionEntry`) already returns `agentName: ''` and needs no change.

**Healing (G5).** The scrape cache (`headerCache`, `claude-reader.ts:751`) is
in-memory only, and there is no persisted fleet snapshot, so the first scan in
an upgraded process re-scrapes every transcript. The renderer's
`reconcileSessions` (`sessions.ts:4053`) copies every disk key and `agentName`
is not in `RENDERER_ONLY_SESSION_KEYS` (`:4046`) nor among the runtime overlays
re-applied after a reload, so the disk row's `agentName: ''` overwrites a stale
in-memory value on the next `reloadModel`.

### 5.2 Sidebar guard (slice 1, fixes 2.2)

`labelFor` (`SidebarFolder.vue:161`): `if (s.agentName)` →
`if (s.teamName && s.agentName)`. `design.md:2255-2258` ("the label cascade
for any session with `agentName` filled in uses that name") is amended in the
same slice to "any **teammate** (`teamName` set) uses its `agentName`".

### 5.3 One shared session title (slice 2, G4)

Today ~20 call sites build a session's name with at least six different
cascades. Only three include the Haiku `aiSummary.title`, only one includes the
teammate rule, and three resolve the fork placeholder independently.

New pure module `src/renderer/src/lib/session-label.ts`:

```ts
type Translate = (key: string, params?: Record<string, unknown>) => string

export interface SessionLike {
  sessionId: string
  summary?: string
  firstPrompt?: string
  aiSummary?: { title: string }
  teamName?: string
  agentName?: string
  synthetic?: boolean
  forkSourceId?: string
}

/** Fork-synthetic predicate; generic so the store's wrapper keeps its narrowing. */
export function isForkSyntheticLike<T extends SessionLike>(
  s: T
): s is T & { synthetic: true; forkSourceId: string }

/** The name a session shows everywhere, or '' when it has none yet. */
export function sessionTitle(s: SessionLike, sessions: readonly SessionLike[], t: Translate): string
```

Resolution order (each candidate is `trim()`med and a whitespace-only value
counts as empty):

1. **Teammate** — `teamName && agentName` → `agentName`.
2. **Fork synthetic** → `t('session.forkPlaceholder', { summary })`, where
   `summary` is the **source's** name resolved by steps 1 and 4 only (depth 1 —
   no recursion into the source's own fork branch), else `t('session.unnamed')`.
   This intentionally adds the Haiku title and teammate name to the source
   label, which today is `summary || firstPrompt`.
3. **Plain synthetic** (`synthetic === true`) → `t('session.newPlaceholder')`.
   Returning the placeholder from the helper (not `''`) is what lets the
   sidebar and fleet card keep "New session" for a synthetic and "Untitled"
   for a real but nameless session through a single `|| fallback`.
4. `summary || aiSummary.title || firstPrompt`, else `''`.

`t` is injected (components pass `useI18n().t`, the store passes
`i18n.global.t`), matching the other `lib/` modules, none of which import i18n.
The module imports nothing from `stores/` — the store imports it, so that would
be a cycle. `stores/sessions.ts#isForkSynthetic` becomes a thin wrapper over
`isForkSyntheticLike` and keeps its exact exported signature
(`s is Session & { synthetic: true; forkSourceId: string }`), which
`spawn-spec.ts:116` and `Topbar.vue:108` rely on.

Each surface keeps **its own empty fallback** (a real per-surface choice — the
sidebar says "Untitled", the notification body uses the session id), so call
sites become `sessionTitle(s, sessions.allSessions, t) || <surface fallback>`.
Non-session branches that precede the call stay where they are: the topbar's
and sidebar's **shell-terminal** labels (a folder terminal has `summary: ''`
and gets each surface's fallback everywhere else, exactly as today).

Call sites migrated:

| Call site                                                               | Today                                             | Fallback kept                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `SidebarFolder.vue:156` `labelFor`                                      | teammate† → fork → synth → summary/ai/firstPrompt | `session.unnamed`                                                        |
| `Topbar.vue:103` `displayTitle`                                         | terminal → fork → summary/ai/firstPrompt          | `''`; terminal branch stays first                                        |
| `FleetBoardCard.vue:52` `labelFor`                                      | fork → synth → summary/ai/firstPrompt             | `session.unnamed`                                                        |
| `InboxRail.vue:179`                                                     | summary/firstPrompt                               | `session.unnamed`                                                        |
| `InboxRail.vue:214` + `stores/session-approvals.ts:85` `sessionSummary` | `summary ?? ''`                                   | `''`                                                                     |
| `TriageQueue.vue:34`                                                    | summary/firstPrompt                               | `session.newPlaceholder`                                                 |
| `SidebarReturnZone.vue:29`                                              | summary/firstPrompt                               | `session.newPlaceholder`                                                 |
| `StatusFooter.vue:132`                                                  | summary/firstPrompt                               | `session.newPlaceholder`                                                 |
| `FolderViewSessions.vue:36`                                             | summary/firstPrompt/id                            | `sessionId`                                                              |
| `FolderViewOwnedCard.vue:198`                                           | summary/firstPrompt/id                            | `sessionId`                                                              |
| `EmptyState.vue:37`                                                     | summary/firstPrompt                               | as today                                                                 |
| `CloudSessionPanel.vue:16`                                              | summary/firstPrompt                               | as today                                                                 |
| `CommandPalette.vue:126` `sessionLabel`                                 | trimmed summary/firstPrompt                       | as today (trim now in the helper)                                        |
| `composables/useJumpSearch.ts:144` `sessionJumpLabel`                   | trimmed summary/firstPrompt/id                    | `sessionId`                                                              |
| `SessionMenu.vue:307` digest `summary:`                                 | raw `summary`                                     | digest's own `folderAlias` fallback                                      |
| `stores/sessions.ts:3823` `maybeNotify` body                            | summary/id                                        | `sessionId`                                                              |
| `stores/sessions.ts:3847` `speakNotification`                           | raw `summary`                                     | **none** — BUG-129: never speak the id                                   |
| `stores/sessions.ts:2186`, `:2284` sidebar filter                       | matches `summary`, `firstPrompt`                  | also matches `sessionTitle(…)`, so every label a user sees is searchable |
| `MissionPopover.vue:56`                                                 | summary/id-prefix                                 | id prefix                                                                |
| `MissionStepRail.vue:74`                                                | summary/folderAlias/id-prefix                     | as today                                                                 |

† After slice 1.

Not migrated, on purpose (allowlisted in §5.4 with these reasons):
`components/session-sort.ts:39` (a sort key; changing it reorders rows),
`lib/context-digest.ts` (operates on a DTO, fed by `SessionMenu`),
`session-autoname` code and other store internals that read `summary` to decide
_whether_ a session is named, not to display it.

**`design.md` edits in slice 2:** the cascades it specifies as
`summary → firstPrompt` — `:1916` (triage/return rows), `:6390` (palette
label), `:6402` (cloud panel title) — point at one new subsection "Session
name" that states §5.3's order and the per-surface fallbacks.

### 5.4 Regression guard (slice 2)

A pure matcher `findLabelCascades(src: string): Finding[]` in the test file
(exported for its own self-test), applied to every
`src/renderer/src/**/*.{vue,ts}`:

- strip `//` and `/* */` comments and `<!-- -->` first;
- flag `\.summary\b` followed by `||`, `??` or `?.trim()`/`.trim()`;
- flag any `\.(firstPrompt|aiSummary|agentName)\b` read used to build a label
  (i.e. any read at all, minus the allowlist);
- flag `\.summary\b` passed bare as a call argument or in `{{ … }}`;
- anchored on `\.summary\b`, so `awaySummary`, `aiSummary?.summary` and
  `taskSummary` never match.

A per-file allowlist with a one-line reason per entry covers: `lib/session-label.ts`,
`lib/context-digest.ts`, `components/session-sort.ts`, the `Session` type
declarations and reconcile/autoname internals in `stores/sessions.ts`, the
`matchesFilter` calls, and any non-Session `.summary` (cards, missions, usage)
the first run surfaces. The failure message names file:line and says
"use sessionTitle() from lib/session-label.ts". The allowlist is the
deliberate escape hatch — adding to it needs a reason in the diff.

## 6. Acceptance criteria

Reader (slice 1):

- **AC1** — A transcript renamed twice (`custom-title` + `agent-name` pairs for
  name A, then for name B, no `teamName` anywhere) scans to `summary === 'B'`
  and `agentName === ''`.
- **AC2** — Same as AC1 with the file larger than `MAX_SCAN_BYTES` (2 MB), the
  A pair inside the first 2 MB and the final B pair in the last 512 KB.
- **AC3** — A teammate transcript in the **real** shape — an `agent-name` line
  with a different name first, then an `attachment` line carrying `teamName`
  and `agentName` — scans to that line's `teamName`/`agentName`. The existing
  T99 reader tests pass unchanged.
- **AC4** — A line carrying `agentName` without `teamName` never sets
  `agentName`, whatever its `type` and position (line 1 included).
- **AC5** — A transcript where `teamName` and `agentName` exist but **never on
  the same line** scans to `agentName === ''` (`teamName` still set) — the §9
  risk, pinned so a CLI shape change shows up as a test failure, not a silent
  label change.

Label (slice 1):

- **AC6** — A mounted `SidebarFolder` row for
  `{ agentName: 'A', teamName: '', summary: 'B' }` renders `B`.
- **AC7** — A mounted teammate row (`teamName` + `agentName: 'spec-ui'`, lead
  present) renders `spec-ui`.
- **AC8** — Live rename: given a store row **starting** with
  `{ agentName: 'A', teamName: '', summary: 'A' }`, a `session:updated` whose
  `newLines` are the B `custom-title` + `agent-name` pair leaves
  `summary === 'B'`; a `SidebarFolder` mount of that row renders `B`.
- **AC9** — Healing: a committed row with `agentName: 'A'`, `teamName: ''`;
  `reloadModel()` with a stubbed `window.api.foldersLoad` returning the same
  session with `agentName: ''` leaves the row with `agentName === ''`.
- **AC10** — Sidebar placeholders unchanged: a plain synthetic row renders
  `session.newPlaceholder`, a real row with no name renders `session.unnamed`.
- **AC11** — `design.md`'s teammate-label rule (§5.2) is amended.

Shared title (slice 2):

- **AC12** — `sessionTitle` unit tests cover every branch of §5.3: teammate;
  teammate fields without `teamName`; fork with a named source (incl. a source
  named only by `aiSummary.title`); fork with an unknown source; fork whose
  source is itself a fork (depth 1, no recursion); plain synthetic; `summary`;
  `aiSummary.title` only; `firstPrompt` only; whitespace-only `summary`
  falling through to `firstPrompt`; nothing (`''`).
- **AC13** — Every call site in §5.3's table resolves the name through
  `sessionTitle`, keeping its listed fallback and any preceding non-session
  branch; `speakNotification` still never receives the session id.
- **AC14** — Consistency: for an `aiSummary`-only session, `sessionTitle`
  returns the Haiku title, and mounted `SidebarFolder` and `Topbar` both render
  it. The other surfaces are covered by AC13 + AC15 (they cannot diverge
  without bypassing the helper, which the guard catches) — no per-surface mount.
- **AC15** — The guard's self-test: `findLabelCascades` flags
  `s.summary || s.firstPrompt`, `x?.summary ?? ''`, `s.summary?.trim()`, and
  `{{ s.summary }}`; it does not flag `awaySummary || x`,
  `aiSummary?.summary`, or the same cascade inside a comment. On the migrated
  tree it reports nothing outside the allowlist.
- **AC16** — The sidebar filter matches a session by its `sessionTitle`
  (e.g. an `aiSummary`-only session is found by its Haiku title).
- **AC17** — `design.md` "Session name" subsection exists and `:1916`, `:6390`,
  `:6402` reference it.

Contracts (both slices):

- **AC18** — `CHANGELOG.md` gains a `### Fixed` entry (slice 1) and a
  `### Changed` entry (slice 2) under the delivery date; `format:check`, `lint`,
  `typecheck`, the full test suite and `build` pass on each slice.

## 7. Small wins — verdicts

| Candidate                                                  | Verdict                                                                   | Reason                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label uses `agentName` only when `teamName` is set         | **Include** (slice 1)                                                     | One line; G3 defense in depth, and protects a stale in-memory row until the next reload.                                                                                                                                                                                                                                   |
| Shared `sessionTitle()` used by every surface + guard test | **Include** (slice 2)                                                     | Mechanical, one PR, and it is the hardening that would have prevented this bug: the topbar/sidebar split hid it for two months. Also makes the Haiku title, fork label and teammate name consistent across ~20 surfaces.                                                                                                   |
| Sidebar filter can't find a session by the label it shows  | **Include** (slice 2)                                                     | Two lines in the same store; without it slice 2 widens the gap.                                                                                                                                                                                                                                                            |
| Live path (`onSessionUpdated`) ignores `agent-name`        | **Reject — no change**                                                    | It already ignores every type but `custom-title` (`sessions.ts:4969`); after 5.1 `agentName` has no live meaning for a non-teammate. Covered by AC8.                                                                                                                                                                       |
| Live path ignores `ai-title`                               | **Defer** — suggested card "Live `ai-title` refresh"                      | A session with only an AI title keeps the previous one until the next reload. Fixing it needs the renderer to know whether `summary` came from `custom-title` or `ai-title` (else a re-appended `ai-title` clobbers a `/rename`) — a new reader→store field. Not a frozen label: any reload heals it.                      |
| T99 mis-classification by a stray `agentName`              | **Reject — no other consumer**                                            | Grouping and lead detection key on `teamName` only (`teammate-grouping.ts:77-87`, `sessions.ts:3739`); MCP fleet DTOs and notifications never read `agentName`. The label was the only victim.                                                                                                                             |
| Titles past the 2 MB head cap                              | **Reject — covered**                                                      | The tail pass (`readTailEntries`, last 512 KB) re-applies `deriveTitles`, and the CLI re-appends `custom-title` near EOF: the latest title sat in the final 512 KB in 11/11 renamed transcripts (0.86–10.3 MB). AC2 pins it.                                                                                               |
| CLI sidecar `<sessionId>/custom-title.json`                | **Defer** — note on the "Live `ai-title` refresh" card                    | Authoritative in practice (58/58 sidecars equal the transcript's latest `custom-title`; one orphan without a transcript), but undocumented, an extra read per session per scan, and custom-title only. Worth it only if a title gap is ever observed.                                                                      |
| Fork/resume duplicate rows (card "Second finding")         | **Defer** — suggested card "Collapse a resume-fork onto its parent row"   | Needs a supersession model (two transcripts, same first-entry timestamp, overlapping writers); not small and not a label fix.                                                                                                                                                                                              |
| Topbar inline title edit (`commitTitle`, `Topbar.vue:126`) | **Defer — finding** — suggested card "Topbar title edit is not persisted" | It writes `selectedSession.summary` in renderer memory only; the next reload reverts it and the CLI never learns the name. The honest fix is a read-only title or sending `/rename <text>` to the PTY — a product decision. `Topbar.vue:90-93` already admits it ("for now editing in place mutates the local `summary`"). |

## 8. Test strategy

- **Reader (slice 1)** — `tests/claude-reader.test.ts`, new
  `describe('scanFolders — repeated /rename (BUG-78)')`: AC1, AC2, AC4, AC5,
  plus the real-shape teammate fixture for AC3. Build lines with the CLI's
  two-line rename shape, each pair re-appended a few times as the CLI does.
- **Sidebar (slice 1)** — new `tests/sidebar-folder-label.test.ts`, mount
  pattern from `tests/sidebar-folder-click.test.ts`: AC6, AC7, AC10, and the
  render half of AC8.
- **Store (slice 1)** — `tests/sessions-store.test.ts`: AC8 (live delta) and
  AC9 (`reloadModel()` with stubbed `foldersLoad`; `reconcileSessions` is a
  store closure, not exported).
- **Helper (slice 2)** — new `tests/session-label.test.ts`, table-driven: AC12;
  AC14 via the helper plus the existing sidebar mount and one `Topbar` mount;
  AC16 via the store filter.
- **Guard (slice 2)** — new `tests/session-label-guard.test.ts`: AC15.

Fixtures use neutral names only (`A`/`B`, `first-name`/`latest-name`,
`spec-ui`, `/work/Demo`, generated UUIDs) — never a client title, path, ticket
key or session id.

## 9. Risks

| Risk                                                                                            | Mitigation                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A future CLI writes a teammate's `agentName` only on lines without `teamName`                   | The label then falls back to `summary`/first prompt — never a wrong name — and AC5 fails loudly so the reader is updated deliberately. |
| Slice 2 touches ~20 files — conflicts with in-flight UI work                                    | Each call-site change is a one-line swap, stacked on slice 1, reviewable per file.                                                     |
| Slice 2 changes visible labels (Haiku title, fork label, teammate name appear on more surfaces) | Intended (G4), stated in its CHANGELOG entry and `design.md`; snapshots updated in the same slice. Slice 1 closes the bug without it.  |
| Guard false positives on non-Session `.summary`                                                 | Anchored matcher + per-file allowlist with reasons (§5.4); AC15's self-test pins both directions.                                      |
| Fork source resolution recursion                                                                | Depth 1 by construction (§5.3 step 2), AC12 covers fork-of-fork.                                                                       |

## 10. Open questions

None block implementation.

- **OQ1 (non-blocking)** — Should a teammate that is itself `/rename`d show the
  new title instead of its agent name? Today it always shows its agent name
  (T99 intent); this spec keeps that.

## 11. Review log

Independent adversarial review (fresh-context subagent, 2026-10-02) confirmed
the root cause, found no other stale path (reconcile copies every key; no
overlay re-applies `agentName`; live path reads `custom-title` only; the index
fast path returns `''`), and judged the reader fix T99-safe. Findings and
disposition:

| #   | Sev.  | Finding                                                                                                         | Disposition                                                                                                                                                                                                              |
| --- | ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | major | §5.2 inventory missed `useJumpSearch` label, approval `sessionSummary` (×2), `speakNotification`, digest header | **Accepted** — added to §5.3 table; `speakNotification` keeps BUG-129's no-id rule                                                                                                                                       |
| 2   | major | Guard regex missed `?? ''`, bare args, templates; false-fired on comments and `awaySummary`                     | **Accepted** — §5.4 rewritten: pure matcher, comment stripping, `\.summary\b` anchor, allowlist with reasons, AC15 self-test                                                                                             |
| 3   | major | One empty fallback can't keep sidebar/fleet card's two placeholders                                             | **Accepted** — helper returns `newPlaceholder` for a plain synthetic; AC10                                                                                                                                               |
| 4   | major | `design.md` contract ignored (`:2256` teammate rule; `:1916/:6390/:6402` cascades)                              | **Accepted** — AC11 (slice 1), AC17 (slice 2)                                                                                                                                                                            |
| 5   | minor | AC7 (now AC8) lacked the stale precondition and mixed store/render                                              | **Accepted**                                                                                                                                                                                                             |
| 6   | minor | AC10 vs §8 surface counts disagreed                                                                             | **Accepted** — AC14 states exactly which mounts                                                                                                                                                                          |
| 7   | minor | `reconcileSessions` not exported                                                                                | **Accepted** — AC9 drives `reloadModel()` with stubbed `foldersLoad`                                                                                                                                                     |
| 8   | minor | Fork source label order changes                                                                                 | **Accepted** — stated as intended; depth-1 rule                                                                                                                                                                          |
| 9   | minor | Trimming changes fallback behaviour                                                                             | **Accepted** — helper trims each candidate; AC12 case                                                                                                                                                                    |
| 10  | minor | Shell terminals uncovered                                                                                       | **Accepted** — recorded as per-surface branch that stays first (§5.3)                                                                                                                                                    |
| 11  | minor | T99 fixture not in real shape; no "never same line" test                                                        | **Accepted** — AC3 real shape, new AC5                                                                                                                                                                                   |
| 12  | minor | Slice 2 is product-visible scope; filter gap                                                                    | **Partially accepted** — §3 states slice 1 alone closes BUG-78 and slice 2 may move to its own card; filter gap **included** (AC16). Slice 2 stays in this plan because the brief asks for hardening against recurrence. |
| 13  | nit   | `isForkSyntheticLike` must stay a type guard                                                                    | **Accepted** — generic signature in §5.3                                                                                                                                                                                 |
| 14  | nit   | Line numbers / unnecessary exemptions                                                                           | **Accepted** — fixed (`Topbar.vue:103`, FleetBoardCard synth branch, dropped `teammate-grouping`/`SessionPreview` exemptions)                                                                                            |
| 15  | nit   | Real session-id prefixes contradict §8                                                                          | **Accepted** — replaced with A–D                                                                                                                                                                                         |
