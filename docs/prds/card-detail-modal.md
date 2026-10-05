# Card detail modal — the card's dossier (expand, edit, artifacts, interview)

**Status:** PRD v1 (2026-07-11) · **Card:** `card-detail-modal-expand-maximize-edit-as-markdown-link-spec-adr` · **Deps:** T74 (MarkdownRenderer), T105 (schema v2 + `lintCardReadiness`), T104 (stamp/void rules)
**Base:** operator mockup review 2026-07-11 (V1 locked) · canonical mockup `.capy/memory/mockups/card-modal/v1-dossier.html` · design entry: `design.md` §6 "Card detail modal (dossiê do card)"

---

## 0. Premise — what this protects

The card is the **shared object** between the operator and every agent: the T82 epic
made all the task history land ON the card (session bind, `dispatched-with`,
evidence, provenance-stamped appends, T103's close-append) — but the board renders
title + chips only. Everything agents write is invisible unless the operator opens
the raw `.md`. That inverts the tool's premise. This feature is **the window**, not a
new store: the `.md` file stays the single source of truth, every write goes through
the same serialized writer the board already uses, and no invariant moves — Done
stays human-only, controlled fields stay controlled, editing a stamped card still
voids the stamp (T104 §2.3) with a warning, never a block.

## 1. Locked decisions (operator, 2026-07-11)

| #   | Decision                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Surface = **centered modal** incrementing the current board (no board redesign). V1 single-column dossier layout; V2 two-column discarded.                                      |
| D2  | **"Go" = Goal** — an objective summary section rendered before the Acceptance criteria. Not a gate.                                                                             |
| D3  | **Editing = full replace, for everyone** (human and agent). Append trail remains as history but is not the only write path.                                                     |
| D4  | **Artifact badges on the compact card**, requirement-aware per T105 tier: present = green `spec ✓`; required-but-missing = warning; not required = hidden.                      |
| D5  | **Generate spec / Generate PRD** actions where an artifact is required-but-missing.                                                                                             |
| D6  | **Interview lives ON the card** (Open questions block), tiered: trivial/simple → never interview; standard → draft-first + ≤3 parked questions; complex → interview-first gate. |

## 2. Slices — each an independent PR, in order

### S1 — Read-only modal (existing engine only)

Click a card (anywhere except its action buttons) → modal opens. Renders:
header (status/id/kind/complexity/priority chips), title, **Goal** + **Acceptance
criteria** + **Open questions** + **Context** parsed from the body's markdown
sections (convention: `## Goal`, `## Acceptance criteria`, `## Open questions`;
anything else → Context), docs rows from `spec:` (state-aware display, no Generate
yet), linked cards from `deps`/`parent` (+ `[[slug]]` references found in the body),
and the **Trail** (session bind + `dispatched-with` + `evidence` + append entries
split on provenance stamps). Session dot reuses `classifyFleetState`; "Open session"
reuses the board's existing open path; `spec:` opens via the MarkdownPane flow.

**ACs:**

- Opening/closing (click, Esc, backdrop) never writes anything.
- A card with no structured sections renders its whole body as Context — no blank modal.
- AC checkboxes render checked/unchecked from `- [x]` / `- [ ]` markdown (read-only in S1).
- The trail shows every provenance-stamped append in order, plus evidence and the bound session when present.

### S2 — Edit (new engine: replace body)

**Edit** swaps sections Goal→Context for one raw-markdown textarea + Save/Cancel.
Human path: new IPC `roadmap:replaceBody` (atomic temp+rename via the same
single-writer as `updateFrontmatterFields`; frontmatter untouched). Agent path: add
`replaceBody` to `update_card` (controlled fields still refused; ACK carries the
stamp-void warning exactly like `appendBody` does today). AC checkbox clicks become
live in this slice (a targeted `- [ ]`→`- [x]` body write through the same door).

**ACs:**

- Save persists exactly the textarea content as the new body; frontmatter/controlled fields cannot be altered through this path.
- Saving a manifest-stamped card surfaces the "stamp will be voided" warning before writing (proceed allowed — zero friction, T104 posture).
- Esc/backdrop with a dirty editor asks before discarding (BUG-22 lesson).
- Answering an open question (inline input + Send) lands as a provenance-stamped append, not a body replace.

### S3 — Artifact badges + lint (new engine: artifact model)

Frontmatter gains optional `prd:` and `adr:` (same shape as `spec:`; path-relative).
Presence detection: explicit field first, else convention scan
(`docs/prds/<id>-*.md` / `docs/adr/<id>-*.md`) — scan result is shown but only the
explicit field makes it durable. Requirement matrix extends `lintCardReadiness`
(T105 tiers): standard requires spec+ACs; complex additionally PRD (ADR when the
card declares an architectural decision). Compact card renders the badges + the
`? {n}` open-questions chip; modal Docs rows become fully state-aware.

**ACs:**

- A complex card without `prd:` shows the warning badge on the board row AND the missing row in the modal; a simple card shows no artifact badges at all.
- `lintCardReadiness` gaps and the badges never disagree (single predicate, two renderers).

### S4 — Open questions + Generate (new engine: interview + generator recipe)

**Generate** dispatches a canned generator per D6's tiers: reads card + codebase +
project memory; writes the artifact to the conventional path; sets the card's
`spec:`/`prd:` field; for standard tier embeds mandatory **Assumptions** and parks
≤3 **Open questions** on the card; for complex tier runs the scout-questions-first
gate (generation resumes on answers). Generator dispatches are agent-authored work:
they flow through the normal dispatch gate (per-card confirm or manifest — no new
free path). Cross-session "card X has {n} questions" signal integrates with
T116/T83 when they exist; the modal block works without them.

**ACs:**

- Generate on a standard card yields a complete usable draft immediately (no waiting on answers); its open questions appear on the card with input fields.
- Generate on a complex card yields questions first and no artifact until they're answered.
- An answered question folds back: the next generator pass (or session) incorporates answers; answered blocks show provenance.

**Open-questions storage convention (E7, implemented).** Within `## Open questions`,
each question is a paragraph or list item. An answer is a provenance-stamped body
append whose FIRST line anchors it to the question: `> answers: <question text,
whitespace-normalized>` followed by the answer prose — the SAME append door the Trail
already uses, so a hand-edited `.md` and the modal's Send produce identical output.
The LAST matching append wins when a question is answered more than once. Full detail

- the render contract: `design.md` §6 "Open-questions convention" / "3-tier
  interview (Generate's contract)". The contract is the rendered result (answered/open
  blocks, the `{n} open`/`? {n}` counts), not this exact syntax — `parseOpenQuestions`
  (`lib/card-detail.ts`) is the one place that decides.

**Generate output convention (E8, implemented).** `docs/specs/<id>-<slug>.md` /
`docs/prds/<id>-<slug>.md` / `docs/adr/<id>-<slug>.md` (`ARTIFACT_CONVENTION_DIRS`,
`roadmap-core.ts`) — `prd`/`adr` share the same directories E6's presence scan
already checks. Generate reuses the identical auto-vs-confirm dispatch gate a card's
own Dispatch uses (`decideDispatchGate`); the only difference is the spawned session
is never bound to the card (`session:`/`in-progress` stay untouched — Generate is a
side-task, not the card's own dispatch).

## 3. Engine inventory

**Exists (wire-up only):** MarkdownRenderer/`lib/markdown.ts` (T74) · MarkdownPane +
`open_file` pane flow (T84) · schema v2 kind/complexity/`spec:` + `lintCardReadiness`
(T105) · session bind / `dispatched-with` / evidence / stamped appends (T80/T102/T97/
T103) · dispatch machinery incl. `internal` substrate + manifest gate (T104) ·
Teleport dialog pattern in `RoadmapBoard.vue`.

**Missing (built by slice):** the modal itself (S1) · body-replace write path, human
IPC + agent verb (S2) · `prd:`/`adr:` fields + requirement matrix + badges (S3) ·
`## Open questions` convention + answer wiring + generator recipes (S4).

## 4. Open questions (this PRD)

- OQ1: does `? {n}` on the compact card count only unanswered questions, or also unresolved AC gaps? (Current call: questions only.)
- OQ2: does answering a question void a manifest stamp? (Current call: yes by mechanism — it changes the body hash — and that's acceptable; a stamped card with open questions arguably shouldn't drain unmodified anyway.)
- OQ3: "maximize" button in v1 — the mockup shows it; a full takeover surface is deliberately NOT specced here (would collide with T110 meta-board decisions). Ship the icon disabled or drop it in S1.

## 5. Out of scope

T83/T116 notification surfaces (integration point only) · T110 meta-board · AC as a
first-class schema field (stays a markdown convention until proven insufficient) ·
any new theme token (design entry confirms zero new tokens).
