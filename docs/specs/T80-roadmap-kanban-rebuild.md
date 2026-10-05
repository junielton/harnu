# Roadmap kanban rebuild — board + card dossier, end to end

**Status:** design (pending user review) · **Date:** 2026-07-11
**Supersedes/extends:** `docs/prds/card-detail-modal.md` (S1 shipped PR #85; this spec carries S2-S4 to completion and adds the board-side work that PRD's "locked decisions" line named but never specced)
**Canonical mocks:** `.capy/memory/mockups/card-modal/v1-dossier.html` (chosen), `v2-two-column.html` (rejected, mined for ideas — see §7)
**Design entry:** `design.md:2214` (Card detail modal) — needs a new **Roadmap board — filter bar & grouping** subsection (§1983 currently has none)

## 0. Why this exists

The operator opened the Roadmap board expecting the delivered UI to match the approved mock. It doesn't: the filter bar, grouping, the collapsed Done rail, live AC checkboxes, Edit, artifact badges (PRD/ADR), and the Open-questions answer flow are all in the mock and none of them work today. The gap looked like a view-layer bug at first ("open a spec doc and the whole board closes" — fixed separately, see §1) but turned out to be three separate gaps stacked on top of each other:

1. **A real coexistence bug** (Roadmap board vs. helper pane) — root-caused and fixed in this session, see §1.
2. **An engine gap** — two capabilities the mock assumes (full body-replace, an artifact/PRD/ADR model) were never built. `update_card` only supports appending, never replacing, and there is no `prd:`/`adr:` field anywhere in the schema.
3. **A data gap** — of 77 live cards, 0 have a `## Goal` section, 0 have `## Open questions`, only 2 have a recognized `## Acceptance criteria` heading, and only 18 have a `kind:` field. The mock's BUG-25 fixture is a fully-populated card; the real BUG-25 on disk is not. Rebuilding the view alone, even pixel-perfect, would render mostly-empty sections against the real corpus.

This spec plans all three end to end — no staged MVP. Corpus migration, engine additions, board rebuild, and modal rebuild are all in scope for one delivery, executed as a sequence of independently-revertable slices (each its own commit/PR) rather than one big-bang branch, per repo convention (the original card-detail-modal PRD: "each an independent PR, in order").

## 1. Slice 0 — Roadmap/helper-pane coexistence (DONE, this session)

Root cause (confirmed by direct investigation + an Explore subagent independently): `RoadmapBoard.vue`'s `openDetailSpec()` called `ui.closeRoadmap()` right after queuing the markdown pane — copy-pasted from `openSession()`'s pattern, where leaving the board to reveal the newly-bound session's terminal makes sense. For "open a doc", it doesn't. Compounding structural cause: `App.vue`'s main-content area was a single `v-if`/`v-else-if` chain, and `HelperStack` was nested exclusively inside the `showSession` branch — so it could never render while `RoadmapBoard` was showing, independent of the `closeRoadmap()` call.

**Already implemented (uncommitted in the working tree):**

- `RoadmapBoard.vue` `openDetailSpec()`: removed the `ui.closeRoadmap()` call.
- `App.vue`: hoisted the divider + `HelperStack` out of the `showSession`-only branch. Added `showTerminal` and `showHelperStack` computeds; the main-content view (whichever of Usage Dashboard / Roadmap / Onboarding / Empty / Cloud session / Terminal is active) now renders inside a sizing wrapper that composes with the helper stack instead of being mutually exclusive with it. Usage Dashboard / Onboarding / Empty stay pure takeovers (unchanged) — only Roadmap and the terminal ever show the helper stack alongside them, per design.md §6's existing "takeover" language for those three.

**Remaining gap found during this work (folds into Slice 1, §3):** `stores/helpers.ts`'s `currentWorktreePath` derives only from `sessions.selectedSession?.projectPath`, returning `null` with no session selected — a normal state while the Roadmap board is open. `openDetailSpec` anchors panes to `sessions.selectedSession?.projectPath || roadmap.folderPath`, so a pane opened from the board with no session selected is queued under a worktree key the helper-stack visibility computeds can never find. Fix: add the same `|| ui.roadmap.folderPath` fallback to `currentWorktreePath` (and gate it — only fall back when `ui.roadmap.open`, so the terminal-view behavior for a real session is untouched).

**design.md update:** §6 "Roadmap board" currently says only "selecting a session" closes it (reveals the terminal) (closing on session-select is correct and stays). Add one sentence: opening a card's doc keeps the board open, showing the pane alongside it via the same helper-stack region the terminal uses.

## 2. Corpus reality — the numbers driving every later slice

Verified against the 77 files in `.capy/memory/roadmap/*.md` (not the mock's fixture data):

| Field / section                          | Cards with it | Cards without               |
| ---------------------------------------- | ------------- | --------------------------- |
| `## Goal`                                | 0             | 77                          |
| `## Open questions`                      | 0             | 77                          |
| `## Acceptance criteria` (exact heading) | 2             | 75                          |
| `kind:`                                  | 18            | 59                          |
| `complexity:`                            | 25            | 52                          |
| `parent:`                                | 18            | 59                          |
| `prd:` / `adr:`                          | 0             | 77 (fields don't exist yet) |

Two concrete parse bugs found in real cards (not hypothetical):

- `bug-28-worktree-setup-seed-failure-is-opaque-same-error-for-no-n.md` uses `## Acceptance` (not `## Acceptance criteria`) — silently folds into Context today.
- The same card's wikilink is `[[roadmap/bug-27-…|BUG-27]]` — `linkedRefsOf` takes the pre-`|` ref verbatim, never strips the `roadmap/` prefix, so it never resolves and renders as a disabled/unknown chip.

## 3. Slice 1 — Schema v3 + engine additions (main process)

### 3.1 New frontmatter fields

`prd?: string`, `adr?: string` — identical shape/handling to the existing `spec?: string` (path-relative, no presence probe beyond the field itself in this pass). Added to `CARD_EDITABLE_FIELDS` in `roadmap-core.ts` (both human IPC and `update_card` can set them) — NOT added to `CARD_CONTROLLED_FIELDS`.

### 3.2 Requirement matrix (artifact model)

Extends `lintCardReadiness` (already exists, currently only checks AC presence for `standard`+). New matrix, keyed by the EXISTING `complexity` taxonomy (`trivial | simple | standard | complex` — the mock's `quick/standard/deep` labels were mock-only and are not being introduced as a second taxonomy):

| `complexity`        | Required                                                           |
| ------------------- | ------------------------------------------------------------------ |
| `trivial`, `simple` | nothing                                                            |
| `standard`          | `spec` + at least one checkbox item under `## Acceptance criteria` |
| `complex`           | `spec` + AC (as above) + `prd`                                     |

`adr` is never hard-required in this pass — there's no reliable signal for "this card is architectural" without a new field, and inventing one is out of scope (open question, see §9). The modal's ADR row renders the mock's third state verbatim: `not required for <tier>`, dashed, `--text-4`, no action.

Display note: the compact-card complexity chip renders the raw `complexity` field value verbatim (`trivial`/`simple`/`standard`/`complex`) — the mock's `quick`/`standard`/`deep` labels do not become a second, user-facing vocabulary.

This is a **single predicate** (`lintCardReadiness`, main + its renderer mirror in `stores/roadmap.ts`) consumed by both the compact-card badges and the modal Docs section, so they cannot disagree — matches the existing PRD's S3 AC.

### 3.3 Body-replace (the capability everything else in the modal depends on)

**New pure function**, `roadmap-core.ts`: `replaceCardBody(rawBody: string, newMain: string): string`. Splits the existing body into `{main, appendsTail}` using the SAME stamp-split rule `card-detail.ts`'s `splitStampedAppends` already implements client-side (`/^>\s*provenance:/`). **Correction from the brainstorm-round assumption:** this is NOT hoisted into a cross-imported shared module — `roadmap-core.ts` (main) imports `node:crypto`, and the renderer build (separate `electron.vite.config.ts` target, no `src/shared/` today) cannot import anything under `src/main/`. `card-detail.ts`'s own header comment already documents the codebase's actual convention for this exact situation: mirror the wire format in a small renderer-local reimplementation rather than cross-import a main-process module (same pattern `stores/roadmap.ts` already uses for other core mirrors). `replaceCardBody`'s split logic in `roadmap-core.ts` is therefore an intentional, documented mirror of `splitStampedAppends` — not a second consumer of one shared function. Replaces only `main`; appends are reattached untouched — the Trail and Open-questions answers are append-only and never touched by Edit, matching the mock's raw-textarea content (Goal/AC/Docs/Linked/Context only, no Trail).

**New human IPC:** `roadmap:replaceBody(folder, slug, newMain)` → `updateFrontmatterFields`-style atomic temp+rename write, frontmatter untouched, same single-writer serialization as every other roadmap write. **Does NOT enforce `CARD_CLOSED`** — a human fixing a typo or stale note on a `done` card should never be blocked; Close being human-only was never meant to imply "and then frozen forever."

**New `update_card` capability:** `replaceBody` joins `appendBody` as a second write mode. Still refuses every `CARD_CONTROLLED_FIELD`, and — unlike the human path — **does** refuse `CARD_CLOSED` (matches `update_card`'s existing immutable-once-`done` posture for every other agent write today; no reason for `replaceBody` to be the one exception). The ACK carries the existing stamp-void warning (no new logic — `approvedBodyHash` staleness is already detected by comparing against the live content; a body-replace just makes that comparison fail as a side effect of changing the content, exactly like any other edit today).

**AC checkbox toggle** does NOT get its own endpoint. The modal recomputes the new `main` text client-side (flip one `- [ ]`/`- [x]` line) and calls the same `replaceBody` door — "same door" per the original PRD's D3 decision.

**docs/capy-features.md:** bump required — new MCP-visible capability (`update_card` gains `replaceBody`; `prd`/`adr` join the editable-field list an agent can act on). Version marker `<!-- capy-features vN -->` increments.

### 3.4 Generate (S4) — DEFERRED, not in this spec's slices

**Correction from the brainstorm-round assumption:** this was framed as "not a new engine primitive — dispatched through the EXISTING dispatch gate." That's wrong. `planDispatchCore` (and the `roadmap:planDispatch`/`update_card`'s dispatch path generally) ALWAYS derives its boot prompt server-side from the card's own `title`/`body`/`spec` via `buildBootPrompt` — the `labels` parameter callers pass only customizes the wrapper text (heading/framing/closure), never the core content. There is no path today to gate-dispatch a DIFFERENT prompt (a generator instruction, not the card's own boot prompt) through the existing grant/manifest security gate. Building Generate for real needs a genuine new main-process capability (a gated way to dispatch an operator-approved custom prompt) that no slice in this spec currently plans.

Given that, Generate is explicitly OUT of Slice 3 (and every other slice this spec plans) — it is not a small addition riding on existing machinery, it is its own follow-up initiative once the prompt-customization gate exists. This matches the ORIGINAL `docs/prds/card-detail-modal.md`'s own posture (S4 was already its vaguest, most-open-question slice — "Generate dispatches a canned generator per D6's tiers" with three unresolved OQs). The Docs section's "missing + Generate button" row (§3.2's artifact model) still renders in Slice 3 — it shows the amber missing state and the button, but the button is DISABLED with a tooltip explaining Generate isn't wired up yet, rather than silently doing nothing or being omitted (the operator should see the feature exists and is coming, not wonder if it's broken).

### 3.5 Open-questions convention (new — no prior convention existed)

`## Open questions` becomes a **structured** sub-convention (today it's prose-only). Each question is a list item; an answered question carries a nested provenance line and answer text, mirroring exactly what the mock renders:

```markdown
## Open questions

- Should parked confirms re-signal before TTL expiry?
  > answered · human · 2026-07-11
  > Yes — re-raise at 50% and 90% of TTL.
- Does the fix cover ALL parked mutations or only plan_mission?
```

Parse rule (extends `card-detail.ts`'s section parser, main-list-item + optional-nested-blockquote): a top-level `-` line under `## Open questions` is a question. If followed by a `> answered · <author> · <date>` line and one or more further `>` lines, the question is answered (renders the mock's green-rule block with that provenance + text); otherwise it renders the mock's input+Send form. **Send** writes back through `replaceBody` (§3.3) — NOT through the append path — because the answer has to land INSIDE the `## Open questions` section at the right list item, which an append (which always lands at the end of the file) cannot do. This is a deliberate deviation from the original brainstorm-round assumption ("Open questions can use the existing append path") — the append path only works for the Trail's free-form notes, not for structured in-section answers. Flagging this as the highest-ambiguity design call in this spec; see §9.

The `{n} open` badge = count of unanswered top-level items in this section — single source read by both the compact-card chip and the modal section header.

## 4. Slice 2 — Board rebuild (`RoadmapBoard.vue`)

### 4.1 Extraction pass (before any new code)

**Correction from the brainstorm-round audit table:** three of the six items originally listed here (`WIP_LIMIT`/`wouldExceedWip`, `reviewSuggestion`, `formatDispatchedWith`) were framed as "duplicated main-process logic — extract and import the canonical version." That's the same cross-process mistake §3.3 already caught for `replaceCardBody`: `roadmap-core.ts` and `routing-policy.ts` are main-process files (`roadmap-core.ts` imports `node:crypto`), and the renderer cannot import from `src/main/` at all. `RoadmapBoard.vue`'s copies of these three are NOT bugs — they are the same intentional, documented "mirror the wire shape, don't cross-import main" convention `stores/roadmap.ts`'s own header comment names explicitly (`stores/teams.ts` is cited as precedent), already applied correctly to `stores/roadmap.ts`'s own `lintCardReadiness`/`sortManifestQueue`/`nextManifestDrainTarget` mirrors. Only three of the six items are genuine same-process (renderer-to-renderer) duplication and worth extracting:

| Trapped in `RoadmapBoard.vue`                                                                                                                                     | Fix                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleetStateOf`/`dotKindOf`/`dotClass`/`pulseOf`                                                                                                                   | Duplicated verbatim in `CardDetailModal.vue`. Genuine renderer-to-renderer duplication — promote to a shared composable `lib/card-fleet-state.ts`, both components import it.                                                                                              |
| `spawnAndBind`/`offerDispatch`/`confirmDispatch` orchestration                                                                                                    | Currently only in `RoadmapBoard.vue`. Becomes a `stores/roadmap.ts` action (`roadmap.dispatch(card, opts)`) so Generate (§3.4, Slice 3) can reuse it without re-deriving the flow — a real renderer-side move, not a cross-process one.                                    |
| `MODEL_OPTIONS`/`EFFORT_OPTIONS` hardcoded in `RoadmapBoard.vue`, and the same two arrays inlined again (not exported) inside `ClaudeBootForm.vue`'s field config | Neither file currently exports these as an importable constant — extract both into a new small shared module (`lib/claude-launch-options.ts`) and have both components import from it. Values are already byte-identical, so this is pure dedup with zero behavior change. |

`WIP_LIMIT = 5` / `wipWouldExceed()`, `reviewSuggestion()` + its merge-evidence fetch loop, and `formatDispatchedWith()` stay exactly where they are in `RoadmapBoard.vue` — correct, intentional mirrors of `roadmap-core.ts`'s `WIP_LIMIT`/`wouldExceedWip`/`suggestReviewTransition` and `routing-policy.ts`'s `formatDispatchedWith`, respectively. (`formatDispatchedWith` genuinely does have a same-process duplicate worth fixing — `manifest-drain.ts`, also in `src/main/`, has its own copy instead of importing `routing-policy.ts`'s — but that is a main-process-only cleanup, unrelated to this board rebuild; out of scope here, noted for a future small fix.)

This is prerequisite cleanup, not optional polish — without it, the rebuild re-introduces a 4th copy of `formatDispatchedWith` by construction.

### 4.2 Filter bar (new — not a re-skin, functionally new)

Row above the columns, height matching the mock's `38px`. Left to right:

- **Search** — substring match on `(id + ' ' + title).toLowerCase()`, live filter, hides non-matching cards (`display:none` equivalent — a computed `visible` per card, not a DOM removal, so drag targets stay stable).
- **Kind pills** (`bug feature chore scout review`) — real toggle state (not the mock's cosmetic one); empty selection = show all, matching the mock's fallback rule.
- **Group control** (`epic | kind | none`) — REAL regrouping (the mock never wired this; we do):
  - `epic`: bucket by resolved `parent` (group label = parent card's title); no parent → "Ungrouped" (i18n key, not the mock's fictional "FLEET"/"SHELL" labels).
  - `kind`: bucket by `kind`; no kind → "Uncategorized".
  - `none`: today's flat per-column list.
- **Hide done** — hides the Done rail (§4.3) entirely from the grid, freeing horizontal space.

State (search text, kind set, group mode, hide-done) persisted per repo folder path — same persistence tier as `layout.helperCollapsed` (localStorage-backed store), not a `.md` write. This restores the intent visible in the mock's own (fictional) "T111 Filter bar state persists per repo" card title — real fix, just not the real T111.

### 4.3 Done rail

5th grid column collapses to `36px`: vertical `Done · {n}` label (rotated, `writing-mode: vertical-rl`), chevron, click expands to the mock's normal-width column temporarily (a local `doneExpanded` ref — not persisted, resets on board reopen, matching a "peek" affordance rather than a 6th persistent state).

### 4.4 Card anatomy additions

Artifact badges (§3.2) and the `? {n}` open-questions chip (§3.5) added to the existing chip row, using the shared `lintCardReadiness` predicate. No changes to drag-and-drop, WIP soft-cap, or the dispatch/merge-evidence machinery — all of that is confirmed sound and stays as-is (engine audit §7 verdict).

## 5. Slice 3 — Card modal rebuild (`CardDetailModal.vue`)

Full rewrite of the component (not an incremental patch onto the S1 version — the S1 component's section-rendering logic gets superseded by edit-mode-aware rendering throughout). Carries forward everything S1 already does correctly (header chips, Linked chips with direction/blocking semantics, Context prose, Trail timeline, fleet-state dot reuse) and adds:

- **S2 — Edit.** Sections 3-8 (Goal→Context, per design.md's fixed anatomy) collapse into one raw-markdown textarea (mono, 12px, min-height 320px) with Save/Cancel, exactly per the mock. Save → `replaceBody` (§3.3). Dirty-editor Esc/backdrop asks before discarding (BUG-22 lesson, already referenced in the original PRD). AC checkboxes become clickable in read mode too (immediate toggle-and-save, not gated behind entering Edit — matches the mock's `.ac` click behavior, which is independent of the edit/read mode toggle).
- **S3 — Artifact badges.** Docs section becomes 3-state per row (present ✓ / required-and-missing + Generate / not-required, dashed) using §3.2's matrix.
- **S4 — Open questions.** Interactive answer form per §3.5; Generate button (§3.4) on missing-required Docs rows.
- **Footer bar** (currently absent — S1 explicitly deferred it): sticky, `Edit` left / `Backlog|Ready|Review` segmented Move (status write via the EXISTING `roadmap:setStatus`, no new IPC) / readiness hint (`lintCardReadiness`, green check or gap count) / `Dispatch` primary right. Never exposes `Done` or `In Progress` in the switcher — matches the existing golden rule (Done is human-Close-only, In Progress is session-bind-only).

## 6. Slice 4 — Corpus migration (77 cards)

No blind rewrite of card content. Three tiers, increasing in how much judgment they require:

1. **Mechanical, safe to script directly:** `## AC` → `## Acceptance criteria` heading rename where the section body is already a recognizable checkbox list (regex-verifiable, zero interpretation). Wikilink `roadmap/` prefix strip in `linkedRefsOf` (a parser fix, not a data migration — the anchor at `bug-28...md` is not unique, likely repeated elsewhere in the corpus; the fix is in code, applied to all cards at once by construction).
2. **Inferable, agent-assisted, written through the existing door:** `kind`/`complexity` for the 59/52 cards missing them — one agent per batch reads title+body and proposes a value, written via `update_card` `set` (already-permitted editable fields), not a direct file write. Every write goes through the same serialized, audited path as any other agent edit.
3. **Interpretive, proposal-only, human-gated:** Goal/AC/Open-questions extraction for cards that have neither — an agent drafts a proposed Goal + ACs from the existing free-form body and lands it as a **pending append** (visible in the Trail, provenance-stamped `agent`), not a body-replace. The operator reviews and promotes it into the structured sections via the new Edit (§5) at their own pace, card by card. Automating 77 silent body rewrites in one pass is the one thing this spec explicitly refuses to do unattended.

## 7. Design tokens (must land in `design.md` before/with the implementation, per the design contract)

Mock-vs-`themes.css` audit found 4 raw-color instances and 2 off-scale radii — but re-checking against the LIVE app (not just the standalone mock) changes the fix for the raw colors:

- **No new warning tokens needed.** The mock hard-codes `rgba(229,182,92,…)` (an amber tint) because it's a standalone static file with no access to Capy's token system. `RoadmapBoard.vue` already has an established, three-times-repeated combo for exactly this "amber badge" need — `bg-red-soft` + `text-warning` (the `blocked` badge, the readiness-gap count badge, and the WIP-exceeded chip all use this exact pairing today). The priority chip, the open-questions badge, and the missing-artifact row all reuse this SAME existing combo — zero new tokens, zero `themes.css` edits across the 12 theme blocks.
- **Repo identity color** — the mock's `--repo-capy` is byte-identical to the existing `--term-ansi-blue` in both themes. Reuse it directly (aliased, documented) rather than minting a new `--color-repo-*` scale for a single repo-badge use — avoids a token nobody else in the app uses yet. (Revisit if/when T110's meta-board needs multiple repo hues simultaneously.)
- **Off-scale radii** (`3px` chips/badges, `4px` AC checkbox) — neither matches `--radius-sm`(5)/`--radius`(7)/`--radius-lg`(10). Resolved by using the nearest existing token (`--radius-sm`) rather than inventing two more radii — a deliberate simplification versus the mock's pixel values, called out for your review.

design.md gets: the new "Roadmap board — filter bar & grouping" subsection under §6 (currently absent), plus the Card detail modal section (§2214) updated for the footer bar / edit mode / artifact badges this spec adds. No §9 token changes — see above.

## 8. Cross-cutting

- **i18n:** every new string (filter bar labels, group labels, Done rail, footer actions, Open-questions form, Generate hint, artifact badge tooltips) added to `en.json` AND `pt-BR.json` in the same change (schema-parity build gate).
- **Tests:** extend `tests/card-detail-parse.test.ts` for the Open-questions Q&A convention (§3.5) and the body-replace split/reattach round-trip (§3.3); new tests for `lintCardReadiness`'s extended matrix; a migration dry-run test (tier 1 mechanical rename) against a fixture corpus.
- **CHANGELOG.md:** dated entry covering the coexistence fix (already done) and, per slice as it lands, the board filter/group/rail, modal Edit/badges/Open-questions, and schema v3 fields.
- **capy-features.md:** version bump when `update_card`'s `replaceBody` + `prd`/`adr` fields land (§3.3).
- **Verification:** `npm run typecheck` + `npm run build` per slice; live-verify in the dev app (per CLAUDE.md's UI process) — especially the coexistence fix (already spot-checked via the two before/after screenshots in this conversation) and the filter bar's search-while-dragging edge case.

## 9. Open questions (this spec)

- **OQ1 (highest risk):** the Open-questions answer convention (§3.5) is new — no prior art in the corpus or the codebase to validate against. Confirm the nested-blockquote shape before implementation, or propose an alternative if the parsing ambiguity (e.g., a question's own text spanning multiple lines) turns out to be worse in practice than in the mock's single-line fixture.
- **OQ2:** ADR requirement — this spec keeps ADR permanently soft (§3.2). If a future card type needs a hard ADR gate, that's a new field (`architectural: true`?) and a matrix change, out of scope here.
- **OQ3 ("maximize" button):** the original PRD (OQ3) deferred this pending T110 (meta-board). Still deferred — icon renders disabled, per the original call.
- **OQ4:** migration tier 3 (§6) proposes Goal/AC as pending appends for human promotion — confirm that's the right friction level (vs., e.g., a dedicated "needs Goal/AC" board filter to surface them, which would be a natural pairing with §4.2's filter bar but isn't specced here).

## 10. Out of scope

T110 meta-board (separate initiative, same card visual language) · T83/T116 notification integration for open-questions signaling · a hard ADR gate (OQ2) · AC as a first-class schema field (stays a markdown convention) · any new theme beyond the 12 already in `themes.css` · multi-repo identity colors beyond reusing `--term-ansi-blue` for the single-repo case.

# Roadmap kanban rebuild — board + card dossier, end to end

**Status:** design (pending user review) · **Date:** 2026-07-11
**Supersedes/extends:** `docs/prds/card-detail-modal.md` (S1 shipped PR #85; this spec carries S2-S4 to completion and adds the board-side work that PRD's "locked decisions" line named but never specced)
**Canonical mocks:** `.capy/memory/mockups/card-modal/v1-dossier.html` (chosen), `v2-two-column.html` (rejected, mined for ideas — see §7)
**Design entry:** `design.md:2214` (Card detail modal) — needs a new **Roadmap board — filter bar & grouping** subsection (§1983 currently has none)

## 0. Why this exists

The operator opened the Roadmap board expecting the delivered UI to match the approved mock. It doesn't: the filter bar, grouping, the collapsed Done rail, live AC checkboxes, Edit, artifact badges (PRD/ADR), and the Open-questions answer flow are all in the mock and none of them work today. The gap looked like a view-layer bug at first ("open a spec doc and the whole board closes" — fixed separately, see §1) but turned out to be three separate gaps stacked on top of each other:

1. **A real coexistence bug** (Roadmap board vs. helper pane) — root-caused and fixed in this session, see §1.
2. **An engine gap** — two capabilities the mock assumes (full body-replace, an artifact/PRD/ADR model) were never built. `update_card` only supports appending, never replacing, and there is no `prd:`/`adr:` field anywhere in the schema.
3. **A data gap** — of 77 live cards, 0 have a `## Goal` section, 0 have `## Open questions`, only 2 have a recognized `## Acceptance criteria` heading, and only 18 have a `kind:` field. The mock's BUG-25 fixture is a fully-populated card; the real BUG-25 on disk is not. Rebuilding the view alone, even pixel-perfect, would render mostly-empty sections against the real corpus.

This spec plans all three end to end — no staged MVP. Corpus migration, engine additions, board rebuild, and modal rebuild are all in scope for one delivery, executed as a sequence of independently-revertable slices (each its own commit/PR) rather than one big-bang branch, per repo convention (the original card-detail-modal PRD: "each an independent PR, in order").

## 1. Slice 0 — Roadmap/helper-pane coexistence (DONE, this session)

Root cause (confirmed by direct investigation + an Explore subagent independently): `RoadmapBoard.vue`'s `openDetailSpec()` called `ui.closeRoadmap()` right after queuing the markdown pane — copy-pasted from `openSession()`'s pattern, where leaving the board to reveal the newly-bound session's terminal makes sense. For "open a doc", it doesn't. Compounding structural cause: `App.vue`'s main-content area was a single `v-if`/`v-else-if` chain, and `HelperStack` was nested exclusively inside the `showSession` branch — so it could never render while `RoadmapBoard` was showing, independent of the `closeRoadmap()` call.

**Already implemented (uncommitted in the working tree):**

- `RoadmapBoard.vue` `openDetailSpec()`: removed the `ui.closeRoadmap()` call.
- `App.vue`: hoisted the divider + `HelperStack` out of the `showSession`-only branch. Added `showTerminal` and `showHelperStack` computeds; the main-content view (whichever of Usage Dashboard / Roadmap / Onboarding / Empty / Cloud session / Terminal is active) now renders inside a sizing wrapper that composes with the helper stack instead of being mutually exclusive with it. Usage Dashboard / Onboarding / Empty stay pure takeovers (unchanged) — only Roadmap and the terminal ever show the helper stack alongside them, per design.md §6's existing "takeover" language for those three.

**Remaining gap found during this work (folds into Slice 1, §3):** `stores/helpers.ts`'s `currentWorktreePath` derives only from `sessions.selectedSession?.projectPath`, returning `null` with no session selected — a normal state while the Roadmap board is open. `openDetailSpec` anchors panes to `sessions.selectedSession?.projectPath || roadmap.folderPath`, so a pane opened from the board with no session selected is queued under a worktree key the helper-stack visibility computeds can never find. Fix: add the same `|| ui.roadmap.folderPath` fallback to `currentWorktreePath` (and gate it — only fall back when `ui.roadmap.open`, so the terminal-view behavior for a real session is untouched).

**design.md update:** §6 "Roadmap board" currently says only "selecting a session" closes it (reveals the terminal) (closing on session-select is correct and stays). Add one sentence: opening a card's doc keeps the board open, showing the pane alongside it via the same helper-stack region the terminal uses.

## 2. Corpus reality — the numbers driving every later slice

Verified against the 77 files in `.capy/memory/roadmap/*.md` (not the mock's fixture data):

| Field / section                          | Cards with it | Cards without               |
| ---------------------------------------- | ------------- | --------------------------- |
| `## Goal`                                | 0             | 77                          |
| `## Open questions`                      | 0             | 77                          |
| `## Acceptance criteria` (exact heading) | 2             | 75                          |
| `kind:`                                  | 18            | 59                          |
| `complexity:`                            | 25            | 52                          |
| `parent:`                                | 18            | 59                          |
| `prd:` / `adr:`                          | 0             | 77 (fields don't exist yet) |

Two concrete parse bugs found in real cards (not hypothetical):

- `bug-28-worktree-setup-seed-failure-is-opaque-same-error-for-no-n.md` uses `## Acceptance` (not `## Acceptance criteria`) — silently folds into Context today.
- The same card's wikilink is `[[roadmap/bug-27-…|BUG-27]]` — `linkedRefsOf` takes the pre-`|` ref verbatim, never strips the `roadmap/` prefix, so it never resolves and renders as a disabled/unknown chip.

## 3. Slice 1 — Schema v3 + engine additions (main process)

### 3.1 New frontmatter fields

`prd?: string`, `adr?: string` — identical shape/handling to the existing `spec?: string` (path-relative, no presence probe beyond the field itself in this pass). Added to `CARD_EDITABLE_FIELDS` in `roadmap-core.ts` (both human IPC and `update_card` can set them) — NOT added to `CARD_CONTROLLED_FIELDS`.

### 3.2 Requirement matrix (artifact model)

Extends `lintCardReadiness` (already exists, currently only checks AC presence for `standard`+). New matrix, keyed by the EXISTING `complexity` taxonomy (`trivial | simple | standard | complex` — the mock's `quick/standard/deep` labels were mock-only and are not being introduced as a second taxonomy):

| `complexity`        | Required                                                           |
| ------------------- | ------------------------------------------------------------------ |
| `trivial`, `simple` | nothing                                                            |
| `standard`          | `spec` + at least one checkbox item under `## Acceptance criteria` |
| `complex`           | `spec` + AC (as above) + `prd`                                     |

`adr` is never hard-required in this pass — there's no reliable signal for "this card is architectural" without a new field, and inventing one is out of scope (open question, see §9). The modal's ADR row renders the mock's third state verbatim: `not required for <tier>`, dashed, `--text-4`, no action.

Display note: the compact-card complexity chip renders the raw `complexity` field value verbatim (`trivial`/`simple`/`standard`/`complex`) — the mock's `quick`/`standard`/`deep` labels do not become a second, user-facing vocabulary.

This is a **single predicate** (`lintCardReadiness`, main + its renderer mirror in `stores/roadmap.ts`) consumed by both the compact-card badges and the modal Docs section, so they cannot disagree — matches the existing PRD's S3 AC.

### 3.3 Body-replace (the capability everything else in the modal depends on)

**New pure function**, `roadmap-core.ts`: `replaceCardBody(rawBody: string, newMain: string): string`. Splits the existing body into `{main, appendsTail}` using the SAME stamp-split rule `card-detail.ts`'s `splitStampedAppends` already implements client-side (`/^>\s*provenance:/`). **Correction from the brainstorm-round assumption:** this is NOT hoisted into a cross-imported shared module — `roadmap-core.ts` (main) imports `node:crypto`, and the renderer build (separate `electron.vite.config.ts` target, no `src/shared/` today) cannot import anything under `src/main/`. `card-detail.ts`'s own header comment already documents the codebase's actual convention for this exact situation: mirror the wire format in a small renderer-local reimplementation rather than cross-import a main-process module (same pattern `stores/roadmap.ts` already uses for other core mirrors). `replaceCardBody`'s split logic in `roadmap-core.ts` is therefore an intentional, documented mirror of `splitStampedAppends` — not a second consumer of one shared function. Replaces only `main`; appends are reattached untouched — the Trail and Open-questions answers are append-only and never touched by Edit, matching the mock's raw-textarea content (Goal/AC/Docs/Linked/Context only, no Trail).

**New human IPC:** `roadmap:replaceBody(folder, slug, newMain)` → `updateFrontmatterFields`-style atomic temp+rename write, frontmatter untouched, same single-writer serialization as every other roadmap write. **Does NOT enforce `CARD_CLOSED`** — a human fixing a typo or stale note on a `done` card should never be blocked; Close being human-only was never meant to imply "and then frozen forever."

**New `update_card` capability:** `replaceBody` joins `appendBody` as a second write mode. Still refuses every `CARD_CONTROLLED_FIELD`, and — unlike the human path — **does** refuse `CARD_CLOSED` (matches `update_card`'s existing immutable-once-`done` posture for every other agent write today; no reason for `replaceBody` to be the one exception). The ACK carries the existing stamp-void warning (no new logic — `approvedBodyHash` staleness is already detected by comparing against the live content; a body-replace just makes that comparison fail as a side effect of changing the content, exactly like any other edit today).

**AC checkbox toggle** does NOT get its own endpoint. The modal recomputes the new `main` text client-side (flip one `- [ ]`/`- [x]` line) and calls the same `replaceBody` door — "same door" per the original PRD's D3 decision.

**docs/capy-features.md:** bump required — new MCP-visible capability (`update_card` gains `replaceBody`; `prd`/`adr` join the editable-field list an agent can act on). Version marker `<!-- capy-features vN -->` increments.

### 3.4 Generate (S4) — DEFERRED, not in this spec's slices

**Correction from the brainstorm-round assumption:** this was framed as "not a new engine primitive — dispatched through the EXISTING dispatch gate." That's wrong. `planDispatchCore` (and the `roadmap:planDispatch`/`update_card`'s dispatch path generally) ALWAYS derives its boot prompt server-side from the card's own `title`/`body`/`spec` via `buildBootPrompt` — the `labels` parameter callers pass only customizes the wrapper text (heading/framing/closure), never the core content. There is no path today to gate-dispatch a DIFFERENT prompt (a generator instruction, not the card's own boot prompt) through the existing grant/manifest security gate. Building Generate for real needs a genuine new main-process capability (a gated way to dispatch an operator-approved custom prompt) that no slice in this spec currently plans.

Given that, Generate is explicitly OUT of Slice 3 (and every other slice this spec plans) — it is not a small addition riding on existing machinery, it is its own follow-up initiative once the prompt-customization gate exists. This matches the ORIGINAL `docs/prds/card-detail-modal.md`'s own posture (S4 was already its vaguest, most-open-question slice — "Generate dispatches a canned generator per D6's tiers" with three unresolved OQs). The Docs section's "missing + Generate button" row (§3.2's artifact model) still renders in Slice 3 — it shows the amber missing state and the button, but the button is DISABLED with a tooltip explaining Generate isn't wired up yet, rather than silently doing nothing or being omitted (the operator should see the feature exists and is coming, not wonder if it's broken).

### 3.5 Open-questions convention (new — no prior convention existed)

`## Open questions` becomes a **structured** sub-convention (today it's prose-only). Each question is a list item; an answered question carries a nested provenance line and answer text, mirroring exactly what the mock renders:

```markdown
## Open questions

- Should parked confirms re-signal before TTL expiry?
  > answered · human · 2026-07-11
  > Yes — re-raise at 50% and 90% of TTL.
- Does the fix cover ALL parked mutations or only plan_mission?
```

Parse rule (extends `card-detail.ts`'s section parser, main-list-item + optional-nested-blockquote): a top-level `-` line under `## Open questions` is a question. If followed by a `> answered · <author> · <date>` line and one or more further `>` lines, the question is answered (renders the mock's green-rule block with that provenance + text); otherwise it renders the mock's input+Send form. **Send** writes back through `replaceBody` (§3.3) — NOT through the append path — because the answer has to land INSIDE the `## Open questions` section at the right list item, which an append (which always lands at the end of the file) cannot do. This is a deliberate deviation from the original brainstorm-round assumption ("Open questions can use the existing append path") — the append path only works for the Trail's free-form notes, not for structured in-section answers. Flagging this as the highest-ambiguity design call in this spec; see §9.

The `{n} open` badge = count of unanswered top-level items in this section — single source read by both the compact-card chip and the modal section header.

## 4. Slice 2 — Board rebuild (`RoadmapBoard.vue`)

### 4.1 Extraction pass (before any new code)

**Correction from the brainstorm-round audit table:** three of the six items originally listed here (`WIP_LIMIT`/`wouldExceedWip`, `reviewSuggestion`, `formatDispatchedWith`) were framed as "duplicated main-process logic — extract and import the canonical version." That's the same cross-process mistake §3.3 already caught for `replaceCardBody`: `roadmap-core.ts` and `routing-policy.ts` are main-process files (`roadmap-core.ts` imports `node:crypto`), and the renderer cannot import from `src/main/` at all. `RoadmapBoard.vue`'s copies of these three are NOT bugs — they are the same intentional, documented "mirror the wire shape, don't cross-import main" convention `stores/roadmap.ts`'s own header comment names explicitly (`stores/teams.ts` is cited as precedent), already applied correctly to `stores/roadmap.ts`'s own `lintCardReadiness`/`sortManifestQueue`/`nextManifestDrainTarget` mirrors. Only three of the six items are genuine same-process (renderer-to-renderer) duplication and worth extracting:

| Trapped in `RoadmapBoard.vue`                                                                                                                                     | Fix                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleetStateOf`/`dotKindOf`/`dotClass`/`pulseOf`                                                                                                                   | Duplicated verbatim in `CardDetailModal.vue`. Genuine renderer-to-renderer duplication — promote to a shared composable `lib/card-fleet-state.ts`, both components import it.                                                                                              |
| `spawnAndBind`/`offerDispatch`/`confirmDispatch` orchestration                                                                                                    | Currently only in `RoadmapBoard.vue`. Becomes a `stores/roadmap.ts` action (`roadmap.dispatch(card, opts)`) so Generate (§3.4, Slice 3) can reuse it without re-deriving the flow — a real renderer-side move, not a cross-process one.                                    |
| `MODEL_OPTIONS`/`EFFORT_OPTIONS` hardcoded in `RoadmapBoard.vue`, and the same two arrays inlined again (not exported) inside `ClaudeBootForm.vue`'s field config | Neither file currently exports these as an importable constant — extract both into a new small shared module (`lib/claude-launch-options.ts`) and have both components import from it. Values are already byte-identical, so this is pure dedup with zero behavior change. |

`WIP_LIMIT = 5` / `wipWouldExceed()`, `reviewSuggestion()` + its merge-evidence fetch loop, and `formatDispatchedWith()` stay exactly where they are in `RoadmapBoard.vue` — correct, intentional mirrors of `roadmap-core.ts`'s `WIP_LIMIT`/`wouldExceedWip`/`suggestReviewTransition` and `routing-policy.ts`'s `formatDispatchedWith`, respectively. (`formatDispatchedWith` genuinely does have a same-process duplicate worth fixing — `manifest-drain.ts`, also in `src/main/`, has its own copy instead of importing `routing-policy.ts`'s — but that is a main-process-only cleanup, unrelated to this board rebuild; out of scope here, noted for a future small fix.)

This is prerequisite cleanup, not optional polish — without it, the rebuild re-introduces a 4th copy of `formatDispatchedWith` by construction.

### 4.2 Filter bar (new — not a re-skin, functionally new)

Row above the columns, height matching the mock's `38px`. Left to right:

- **Search** — substring match on `(id + ' ' + title).toLowerCase()`, live filter, hides non-matching cards (`display:none` equivalent — a computed `visible` per card, not a DOM removal, so drag targets stay stable).
- **Kind pills** (`bug feature chore scout review`) — real toggle state (not the mock's cosmetic one); empty selection = show all, matching the mock's fallback rule.
- **Group control** (`epic | kind | none`) — REAL regrouping (the mock never wired this; we do):
  - `epic`: bucket by resolved `parent` (group label = parent card's title); no parent → "Ungrouped" (i18n key, not the mock's fictional "FLEET"/"SHELL" labels).
  - `kind`: bucket by `kind`; no kind → "Uncategorized".
  - `none`: today's flat per-column list.
- **Hide done** — hides the Done rail (§4.3) entirely from the grid, freeing horizontal space.

State (search text, kind set, group mode, hide-done) persisted per repo folder path — same persistence tier as `layout.helperCollapsed` (localStorage-backed store), not a `.md` write. This restores the intent visible in the mock's own (fictional) "T111 Filter bar state persists per repo" card title — real fix, just not the real T111.

### 4.3 Done rail

5th grid column collapses to `36px`: vertical `Done · {n}` label (rotated, `writing-mode: vertical-rl`), chevron, click expands to the mock's normal-width column temporarily (a local `doneExpanded` ref — not persisted, resets on board reopen, matching a "peek" affordance rather than a 6th persistent state).

### 4.4 Card anatomy additions

Artifact badges (§3.2) and the `? {n}` open-questions chip (§3.5) added to the existing chip row, using the shared `lintCardReadiness` predicate. No changes to drag-and-drop, WIP soft-cap, or the dispatch/merge-evidence machinery — all of that is confirmed sound and stays as-is (engine audit §7 verdict).

## 5. Slice 3 — Card modal rebuild (`CardDetailModal.vue`)

Full rewrite of the component (not an incremental patch onto the S1 version — the S1 component's section-rendering logic gets superseded by edit-mode-aware rendering throughout). Carries forward everything S1 already does correctly (header chips, Linked chips with direction/blocking semantics, Context prose, Trail timeline, fleet-state dot reuse) and adds:

- **S2 — Edit.** Sections 3-8 (Goal→Context, per design.md's fixed anatomy) collapse into one raw-markdown textarea (mono, 12px, min-height 320px) with Save/Cancel, exactly per the mock. Save → `replaceBody` (§3.3). Dirty-editor Esc/backdrop asks before discarding (BUG-22 lesson, already referenced in the original PRD). AC checkboxes become clickable in read mode too (immediate toggle-and-save, not gated behind entering Edit — matches the mock's `.ac` click behavior, which is independent of the edit/read mode toggle).
- **S3 — Artifact badges.** Docs section becomes 3-state per row (present ✓ / required-and-missing + Generate / not-required, dashed) using §3.2's matrix.
- **S4 — Open questions.** Interactive answer form per §3.5; Generate button (§3.4) on missing-required Docs rows.
- **Footer bar** (currently absent — S1 explicitly deferred it): sticky, `Edit` left / `Backlog|Ready|Review` segmented Move (status write via the EXISTING `roadmap:setStatus`, no new IPC) / readiness hint (`lintCardReadiness`, green check or gap count) / `Dispatch` primary right. Never exposes `Done` or `In Progress` in the switcher — matches the existing golden rule (Done is human-Close-only, In Progress is session-bind-only).

## 6. Slice 4 — Corpus migration (77 cards)

No blind rewrite of card content. Three tiers, increasing in how much judgment they require:

1. **Mechanical, safe to script directly:** `## AC` → `## Acceptance criteria` heading rename where the section body is already a recognizable checkbox list (regex-verifiable, zero interpretation). Wikilink `roadmap/` prefix strip in `linkedRefsOf` (a parser fix, not a data migration — the anchor at `bug-28...md` is not unique, likely repeated elsewhere in the corpus; the fix is in code, applied to all cards at once by construction).
2. **Inferable, agent-assisted, written through the existing door:** `kind`/`complexity` for the 59/52 cards missing them — one agent per batch reads title+body and proposes a value, written via `update_card` `set` (already-permitted editable fields), not a direct file write. Every write goes through the same serialized, audited path as any other agent edit.
3. **Interpretive, proposal-only, human-gated:** Goal/AC/Open-questions extraction for cards that have neither — an agent drafts a proposed Goal + ACs from the existing free-form body and lands it as a **pending append** (visible in the Trail, provenance-stamped `agent`), not a body-replace. The operator reviews and promotes it into the structured sections via the new Edit (§5) at their own pace, card by card. Automating 77 silent body rewrites in one pass is the one thing this spec explicitly refuses to do unattended.

## 7. Design tokens (must land in `design.md` before/with the implementation, per the design contract)

Mock-vs-`themes.css` audit found 4 raw-color instances and 2 off-scale radii — but re-checking against the LIVE app (not just the standalone mock) changes the fix for the raw colors:

- **No new warning tokens needed.** The mock hard-codes `rgba(229,182,92,…)` (an amber tint) because it's a standalone static file with no access to Capy's token system. `RoadmapBoard.vue` already has an established, three-times-repeated combo for exactly this "amber badge" need — `bg-red-soft` + `text-warning` (the `blocked` badge, the readiness-gap count badge, and the WIP-exceeded chip all use this exact pairing today). The priority chip, the open-questions badge, and the missing-artifact row all reuse this SAME existing combo — zero new tokens, zero `themes.css` edits across the 12 theme blocks.
- **Repo identity color** — the mock's `--repo-capy` is byte-identical to the existing `--term-ansi-blue` in both themes. Reuse it directly (aliased, documented) rather than minting a new `--color-repo-*` scale for a single repo-badge use — avoids a token nobody else in the app uses yet. (Revisit if/when T110's meta-board needs multiple repo hues simultaneously.)
- **Off-scale radii** (`3px` chips/badges, `4px` AC checkbox) — neither matches `--radius-sm`(5)/`--radius`(7)/`--radius-lg`(10). Resolved by using the nearest existing token (`--radius-sm`) rather than inventing two more radii — a deliberate simplification versus the mock's pixel values, called out for your review.

design.md gets: the new "Roadmap board — filter bar & grouping" subsection under §6 (currently absent), plus the Card detail modal section (§2214) updated for the footer bar / edit mode / artifact badges this spec adds. No §9 token changes — see above.

## 8. Cross-cutting

- **i18n:** every new string (filter bar labels, group labels, Done rail, footer actions, Open-questions form, Generate hint, artifact badge tooltips) added to `en.json` AND `pt-BR.json` in the same change (schema-parity build gate).
- **Tests:** extend `tests/card-detail-parse.test.ts` for the Open-questions Q&A convention (§3.5) and the body-replace split/reattach round-trip (§3.3); new tests for `lintCardReadiness`'s extended matrix; a migration dry-run test (tier 1 mechanical rename) against a fixture corpus.
- **CHANGELOG.md:** dated entry covering the coexistence fix (already done) and, per slice as it lands, the board filter/group/rail, modal Edit/badges/Open-questions, and schema v3 fields.
- **capy-features.md:** version bump when `update_card`'s `replaceBody` + `prd`/`adr` fields land (§3.3).
- **Verification:** `npm run typecheck` + `npm run build` per slice; live-verify in the dev app (per CLAUDE.md's UI process) — especially the coexistence fix (already spot-checked via the two before/after screenshots in this conversation) and the filter bar's search-while-dragging edge case.

## 9. Open questions (this spec)

- **OQ1 (highest risk):** the Open-questions answer convention (§3.5) is new — no prior art in the corpus or the codebase to validate against. Confirm the nested-blockquote shape before implementation, or propose an alternative if the parsing ambiguity (e.g., a question's own text spanning multiple lines) turns out to be worse in practice than in the mock's single-line fixture.
- **OQ2:** ADR requirement — this spec keeps ADR permanently soft (§3.2). If a future card type needs a hard ADR gate, that's a new field (`architectural: true`?) and a matrix change, out of scope here.
- **OQ3 ("maximize" button):** the original PRD (OQ3) deferred this pending T110 (meta-board). Still deferred — icon renders disabled, per the original call.
- **OQ4:** migration tier 3 (§6) proposes Goal/AC as pending appends for human promotion — confirm that's the right friction level (vs., e.g., a dedicated "needs Goal/AC" board filter to surface them, which would be a natural pairing with §4.2's filter bar but isn't specced here).

## 10. Out of scope

T110 meta-board (separate initiative, same card visual language) · T83/T116 notification integration for open-questions signaling · a hard ADR gate (OQ2) · AC as a first-class schema field (stays a markdown convention) · any new theme beyond the 12 already in `themes.css` · multi-repo identity colors beyond reusing `--term-ansi-blue` for the single-repo case.
