# T216 S1 — Per-AC schema, `set_ac_status` and `get_board`

**Status:** Design (no code)
**Date:** 2026-08-23
**Card:** `T216-delivery-assurance-layer-per-ac-evidence-integration-branch-per` (backlog, feature, complex, substrate `internal`) — stage **S1**
**ADR:** [`docs/adr/0010-per-ac-state-in-frontmatter-evidence-in-stamped-appends.md`](../adr/0010-per-ac-state-in-frontmatter-evidence-in-stamped-appends.md)
**Research:** [`docs/research/2026-08-22-delivery-assurance-north-star.md`](../research/2026-08-22-delivery-assurance-north-star.md) §6.A, §7 (S1 rows), §9
**Field evidence:** the card's "S1 go/no-go — GO, with one re-ranking (2026-08-22)" section — a real end-to-end S0 run, not a plan
**Depends on:** nothing in code. **Adjacent:** T215 (`message_session`) — see §12
**Blocks:** S2 (integration branch + PR harvest), S3 (verifier at Review), S4 (tracker sync + report)

---

## 0. What this spec is, in one paragraph

A card's acceptance criteria are free markdown. `set_ac_status` gives an agent a
typed, provenance-labelled way to record a per-AC verdict with evidence, and
`get_board` gives a coordinating session the whole board plus a per-AC rollup in
one call instead of one `memory_read` per card. Nothing here dispatches a
verifier, harvests a PR, touches a tracker, or changes a pixel of UI. The schema
is designed so that **all 254 cards on the operator's board today keep working
untouched** and no card has to be rewritten to become gradable.

---

## 1. What is actually true today (verified, with `file:line`)

Every row is marked ANSWERED with the evidence, or NOT ANSWERED. Two rows
**correct the research report**, which was written against the main process only.

| Claim                                                                              | Verdict                   | Evidence                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACs in the main process are only a heading regex feeding a non-blocking badge      | ANSWERED                  | `roadmap-core.ts:1267` `ACCEPTANCE_HEADING_RE = /^##\s+Acceptance criteria\b/im`, consumed only by `lintCardReadiness` (`:1282-1304`), which returns a `ReadinessGap[]` and "NEVER refuses a write"             |
| **Research §2 is wrong that checkbox items are "not parsed, counted or tickable"** | ANSWERED — **correction** | They are — **in the renderer**. `src/renderer/src/lib/card-detail.ts:146` `parseCardSections` extracts `CardAcItem { text, checked }` via `CHECKBOX_RE` (`:138`); `:309` `toggleAcceptanceCriterion` ticks them |
| The tick is written by index, through `replaceBody`                                | ANSWERED                  | `CardDetailModal.vue:181` `toggleAcceptanceCriterion(props.card.body, index)` → `roadmap.replaceBody(slug, next)`; the id of an AC today **is its ordinal position**                                            |
| `## Open questions` is already parsed and answerable                               | ANSWERED — **correction** | `card-detail.ts:333-507` (T130 S4): `splitQuestions`, `parseOpenQuestions`, `buildAnswerAppend`, `unansweredQuestionCount`. Renderer-only; the main process knows nothing about it                              |
| There is no `## Tech debt` convention anywhere                                     | ANSWERED                  | Heading histogram over all 254 cards: zero occurrences (§3.1)                                                                                                                                                   |
| `evidence` is a refused controlled field on `update_card`                          | ANSWERED                  | `roadmap-core.ts:791-799` `CARD_CONTROLLED_FIELDS`; refusal at `:844-845` (`CONTROLLED_FIELD`)                                                                                                                  |
| `evidence` is card-level `string[]`, written only by the human review move         | ANSWERED                  | Model `roadmap-core.ts:244`; sole writer `roadmap-ipc.ts:821-855` (`roadmap:moveToReview`, merges ≤5 short SHAs from `probeMergeEvidence`, `:169-203`)                                                          |
| Review→Done Close checks nothing                                                   | ANSWERED                  | `roadmap-ipc.ts:868-921`: writes `status: done`, appends `formatCardCloseEntry({date, evidence})`, appends a `decisions.md` entry when the card is an epic. No verdict, no gate                                 |
| `move_card` cannot express `done`/`in-progress`                                    | ANSWERED                  | `roadmap-core.ts:743` `CARD_MOVE_TARGETS = ['backlog','ready','review']` — structurally, not by runtime check                                                                                                   |
| `suggestReviewTransition` is a suggestion only                                     | ANSWERED                  | `roadmap-core.ts:1389-1398` — returns `{evidenceKind}` or `null`; "nothing here moves a card"                                                                                                                   |
| Frontmatter reading handles top-level scalars **plus one** nested block            | ANSWERED                  | `roadmap-core.ts:354-381` `readFields` — top-level `key: value` lines, and indented children collected only while `inProvenance`                                                                                |
| The frontmatter writer is single-line and would orphan a nested block              | ANSWERED                  | `roadmap-core.ts:646-687` `updateFrontmatterFields` matches `^key:[ \t]*.*$` and replaces **that one line**; indented children below it are untouched → orphaned. This is the decisive constraint (§4.1)        |
| `replaceBody` never touches frontmatter                                            | ANSWERED                  | `roadmap-core.ts:711-717` — carries the head through byte-for-byte, replaces only the text after the closing fence                                                                                              |
| `submit_manifest` stamps per card in a loop with a shared `now`                    | ANSWERED                  | `roadmap-ipc.ts:1521-1547` `stampManifestApprovals` — the natural and only place a `wave` can be stamped                                                                                                        |
| The approval fingerprint covers title + spec + body                                | ANSWERED                  | `roadmap-core.ts:1325-1332` `computeCardApprovalHash` — any body edit voids the stamp                                                                                                                           |
| **The MCP layer has no per-session identity**                                      | ANSWERED — load-bearing   | Three independent statements: `tool-handlers.ts:475` "the shared-loopback MCP transport has no per-session identity"; `roadmap-core.ts:1040` (A1); `tool-catalog.ts:601` (`create_card` description)            |
| Board writes are rate-capped per folder per UTC day                                | ANSWERED                  | `tool-handlers.ts:478` `BOARD_RATE_LIMIT_PER_DAY = 300`                                                                                                                                                         |
| Reading a card by verb returns raw markdown, not a parsed card                     | ANSWERED                  | `tool-handlers.ts:308-330` `memoryReadHandler` → `{ ok, page, content }`. No board-listing verb exists in `MCP_OPS` (`tool-catalog.ts:58-114`)                                                                  |
| Whether the MCP transport could gain per-session identity                          | **NOT ANSWERED**          | Not investigated. T215 (`message_session`) addresses a session as a _target_, which is not the same as authenticating a _caller_. See §11 Q1                                                                    |

---

## 2. The friction S1 must remove (from the card, not from the plan)

The card's go/no-go section records what a real S0 run proved. Three items, in
its own order:

1. **"The per-AC table is prose."** It landed via `update_card appendBody` —
   unqueryable, uncountable, no rollup. → `set_ac_status`.
2. **"No board read verb."** Card state came from one `memory_read` per card. →
   `get_board`.
3. **"The report was hand-assembled."** Tolerable at 2 units, not at 10. → S4,
   but only possible once 1 and 2 exist.

And the finding that reorders the epic: **`needs-human` earned its place as a
first-class verdict.** The one AC the blind verifiers refused to pass was the one
flagged pre-dispatch as most likely to be faked. Every design choice below that
touches verdict states treats `needs-human` as load-bearing, never as a hedge.

---

## 3. The board as it actually is (the migration constraint, measured)

### 3.1 Census — `.capy/memory/roadmap/`, 2026-08-23

| Measure                                              | Count   |
| ---------------------------------------------------- | ------- |
| Active cards                                         | **254** |
| Archived cards (`roadmap-archive/`)                  | 12      |
| Cards with a `## Acceptance criteria` heading        | **57**  |
| Cards with a `## Acceptance` heading (no "criteria") | 10      |
| Cards with at least one `- [ ]`/`- [x]` item         | 55      |
| Cards carrying an explicit `AC-<n>` token            | **10**  |
| Checkbox lines in total                              | 322     |
| Checkbox lines actually **ticked** (`[x]`)           | **8**   |
| Cards with an `evidence:` frontmatter key            | 67      |
| Cards with a `## Open questions` heading             | 2       |
| Cards with any tech-debt heading                     | **0**   |

Read that table honestly:

- **77% of cards have no AC section at all.** Any design that requires an AC
  block to exist breaks three quarters of the board. (T80's spec recorded 2 of 77
  at the time; the ratio has improved, the shape of the problem has not.)
- **8 of 322 checkboxes are ticked — 2.5%.** Ticking, though mechanically
  possible since T130 S4, does not happen. A schema that assumes the checkbox is
  a maintained signal is assuming something the data denies.
- **Only 10 cards carry stable ids.** The address `AC-3` does not exist on 96% of
  the board; today an AC's address is its ordinal position in a hand-written list.

### 3.2 Item shapes actually in use

Sampled from the 57 cards with the heading:

```markdown
- [ ] A materialization timeout no longer leaves an unreachable, unattributed
      live process. ← multi-line continuation, very common
- [x] A spawn failure after worktree creation rolls the worktree back.
- Mute toggle in Settings silences sound but never the visual badge. ← plain bullet, no checkbox
```

Two consequences the parser must handle, or it will silently mangle real cards:

1. **Wrapped continuation lines are the norm, not the exception.** Today
   `parseCardSections` (`card-detail.ts:146-206`) drops every non-checkbox line
   into `acceptanceExtra`, so the second line of a wrapped AC is separated from
   its own text. The core parser must fold an indented continuation line into the
   preceding item.
2. **Plain bullets under the heading are legitimate ACs** that simply were not
   written as checkboxes. They must parse as ACs with no tick state, not vanish.

---

## 4. The schema

### 4.1 Where each fact lives, and why

The design rule is **one canonical home per fact, chosen by who writes it.** Four
writers exist and they must never contend for the same bytes.

| Fact                              | Canonical home                                | Sole writer                                   | Why not elsewhere                                                                                                                                   |
| --------------------------------- | --------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC id, text, `verify:`, `source:` | body — the `## Acceptance criteria` checklist | human (editor / modal), agent (`replaceBody`) | This is the human surface. Moving it to frontmatter would make the card unreadable as a document                                                    |
| Per-AC `status` + `by`            | **frontmatter**, nested `acceptance:` block   | **`set_ac_status` only**                      | Body-resident state is wiped by `replaceBody` and by the modal's edit-mode Save; frontmatter is never touched by either (`roadmap-core.ts:711-717`) |
| Per-AC typed evidence             | body — one provenance-stamped append per call | **`set_ac_status` only**                      | Evidence is an append-only audit trail, not a mutable claim. The stamped-append format already exists and the modal's Trail already renders it      |
| The checkbox `[ ]` / `[x]`        | body — **a projection of `status`**           | `set_ac_status` writes it; human may flip it  | Two surfaces, one fact: `met` ⇒ `[x]`, anything else ⇒ `[ ]`. A human flip is recorded as `operator-judgment` (§4.6)                                |
| `wave`                            | frontmatter scalar                            | `stampManifestApprovals` only                 | It is a dispatch fact, stamped where every other dispatch fact is stamped (`roadmap-ipc.ts:1521`)                                                   |
| `questions`, `debt`               | body sections                                 | anyone (free markdown)                        | They are prose; only their **counts** need to be machine-visible                                                                                    |
| Card-level `evidence: string[]`   | frontmatter (unchanged)                       | the human review move (unchanged)             | **Stays a refused controlled field.** See §5.2                                                                                                      |

**Why per-AC state is frontmatter and not a body block.** A body-resident machine
block has exactly one fatal flaw and it is not aesthetic: `update_card
{ replaceBody }` and the modal's edit-mode Save both replace the entire body
verbatim, so a verdict recorded in the body is destroyed by the next spec rewrite
— silently, with no error. Frontmatter is structurally immune: `replaceBody`
carries the head through byte-for-byte (`roadmap-core.ts:711-717`) and
`updateFrontmatterFields` never touches the body. That is the decision recorded in
[ADR-0010](../adr/0010-per-ac-state-in-frontmatter-evidence-in-stamped-appends.md).

**Why the frontmatter block needs a new writer.** `updateFrontmatterFields`
(`roadmap-core.ts:646-687`) locates `^acceptance:[ \t]*.*$` and replaces **that
single line**, leaving indented children orphaned below it — corrupting the card.
This is not hypothetical; it is what the current implementation does to any nested
key. S1 therefore adds:

- `readFields` learns a **second** named nested block, exactly the way it already
  collects `provenance:` (`:354-381`) — the machinery exists, it is parameterised,
  not rewritten;
- a new pure writer `upsertFrontmatterBlock(content, key, childLines)` alongside
  `updateFrontmatterFields`, replacing the header line **and its indented
  children** as one unit;
- a **guard** in `updateFrontmatterFields`: a key naming a block-valued field
  (`provenance`, `acceptance`) is refused rather than written as a scalar. Without
  this guard the new field is one careless `set` away from corrupting a card, so
  the guard is an acceptance criterion (AC-9), not a nicety.

### 4.2 The body surface (human-owned)

```markdown
## Acceptance criteria

- [ ] AC-1 — Post list paginates 10 per page — verify: test — source: clickup:PROJ-231#3
- [x] AC-2 — Hero image respects the Figma spacing — verify: visual — source: figma:12:345
- [ ] AC-3 — Emails arrive within one minute — verify: manual
```

Grammar, deliberately forgiving:

| Token     | Shape                                                                                                | Required? | Absent ⇒                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| item      | `- [ ]` / `- [x]` / `* [ ]` / plain `- ` bullet, plus indented continuation lines                    | yes       | not an AC                                                                   |
| id        | leading `AC-<n>` followed by `—`, `-`, `:` or `. `                                                   | no        | id is **derived** by position for reading; backfilled on first write (§4.5) |
| `verify:` | ` — verify: test\|visual\|manual\|review` anywhere after the text                                    | no        | `verify: undefined` — never guessed                                         |
| `source:` | ` — source: <token>` — `clickup:<TICKET>#<n>`, `spec:<path>#<anchor>`, `figma:<node>`, or a bare URL | no        | `source: undefined`                                                         |

Recognized headings widen to `## Acceptance criteria` **and** `## Acceptance`
(case-insensitive) — the latter covers 10 real cards that both current parsers
miss (§3.1). `ACCEPTANCE_HEADING_RE` and the renderer's `SECTION_KEYS`
(`card-detail.ts:130-135`) must be widened **in the same change**, or the two
parsers disagree — precisely the failure `artifactRequirements`' own doc comment
(`roadmap-core.ts:1229-1234`) exists to prevent.

### 4.3 The frontmatter block (machine-owned)

```yaml
---
id: T216
title: …
status: review
wave: 2
acceptance:
  AC-1: met · by=verifier · at=2026-08-23T09:12:04Z
  AC-2: needs-human · by=verifier · at=2026-08-23T09:12:31Z
  AC-3: unmet · by=verifier · at=2026-08-23T09:13:02Z
evidence: [a1b2c3d, ea34321]
provenance:
  author: agent
  at: 2026-08-22T13:06:22.072Z
---
```

- **Flat child map, one line per AC** — the same shape `readFields` already
  handles for `provenance:`. No list-of-maps, no nested indentation levels, no new
  YAML surface area.
- **The value is a `·`-separated `k=v` record** — the house format, identical to
  the provenance stamp line parsed by `parseProvenanceLine` (main) and
  `parseStampLine` (`card-detail.ts:78-97`). It is not an invented encoding.
- **Only ACs a verb has touched appear.** An untouched AC has no line; its status
  is derived (§4.6). A 254-card board gains zero bytes until someone grades
  something.
- **`status` ∈ `pending | met | unmet | blocked | needs-human`.** `by` ∈
  `verifier | executor | human`. An unrecognized value in either position degrades
  to `pending` / `by` absent — the lenient-read discipline every other schema-v2
  field already follows (`roadmap-core.ts:447-462`).

### 4.4 Typed evidence — a stamped body append

`set_ac_status` appends exactly one entry per call, through the existing
provenance-stamped append door (`memory-core.ts`'s `buildMemoryWrite` format, the
same one `update_card appendBody` uses):

```markdown
**AC-1 → met** · by: verifier

- test · `tests/blog/pagination.spec.ts::paginates` · run `ci#1234`
- commit · `a1b2c3d`

> provenance: author=agent · at=2026-08-23T09:12:04Z · branch=feat/blog
```

An evidence item is `{ type, ref, run?, by }`:

| `type`              | `ref` is                                         | `run` is     |
| ------------------- | ------------------------------------------------ | ------------ |
| `test`              | a test id / file::name                           | a CI run ref |
| `commit`            | a short or full SHA                              | —            |
| `pr`                | a PR url or `#<n>`                               | —            |
| `ci`                | a check name                                     | a run ref    |
| `screenshot`        | a repo-relative path under the board's `assets/` | —            |
| `operator-judgment` | free text (what the human confirmed)             | —            |

Why appends rather than a frontmatter list: evidence is unbounded, multi-field,
and **append-only by nature**. Putting it in frontmatter would either blow up the
flat-child-map constraint or force a JSON blob nobody can hand-repair. Putting it
in the Trail means it is already rendered by `CardDetailModal`, already carries
provenance, and is already immutable-by-convention. It costs zero UI work.

**Known limitation, stated plainly:** the frontmatter carries the _verdict_ and
the body carries the _evidence for it_. A `replaceBody` wipes prior appends (this
is already documented behaviour of that verb) and would therefore orphan the
evidence while the verdict survives. `get_board` reports `evidenceCount` from the
appends, so an orphaned verdict is **visible** as `met` with zero evidence — which
is the correct thing for a human to be suspicious of, not a silent success.

### 4.5 Ids — derived for reading, backfilled on first write

| Situation                                | Behaviour                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Item carries an explicit `AC-<n>`        | that is the id, always; it wins over position                                                                           |
| Item carries none, card is only read     | id is **derived** as `AC-<ordinal>` in document order — back-compat, no write                                           |
| `set_ac_status` is called on such a card | the shell **backfills** explicit `AC-<n>` ids into every item in the section, in document order, then applies the write |

Backfill is one idempotent read-modify-write through the same serialized writer,
and the ACK reports `idsBackfilled: ["AC-1", …]`. It edits the body, so it **voids
a live manifest approval stamp** (`computeCardApprovalHash` covers the body,
`roadmap-core.ts:1325-1332`) — the ACK must say so, exactly as `update_card`
already warns. In practice this is harmless: a card being graded has already been
dispatched, so its stamp is spent.

**Rejected alternative:** refuse the write with `AC_IDS_MISSING` and make the
caller write ids first. It is safer against the race in §11 Q2, but it puts a
mandatory two-step in front of the single action this whole stage exists to make
cheap — and 96% of the board would hit it. Backfill wins; the race is named as a
residual risk rather than pretended away.

### 4.6 Deriving status when the schema says nothing

This is what makes migration free. For an AC with no `acceptance:` line:

| Checkbox | Derived status | Derived `by` |
| -------- | -------------- | ------------ |
| `[x]`    | `met`          | `unknown`    |
| `[ ]`    | `pending`      | —            |
| none     | `pending`      | —            |

And the two surfaces are kept as one fact:

- **`set_ac_status` writes both** — the `acceptance:` line _and_ the checkbox
  (`met` ⇒ `[x]`, everything else ⇒ `[ ]`). They cannot drift.
- **A human flipping the checkbox in the modal** (`CardDetailModal.vue:181`)
  produces `status: met, by: human` with one `operator-judgment` evidence item.
  This is the DSQA tick, and it is the _right_ kind of tick — a human asserting a
  human judgment. It is counted.
- **`by: unknown`** (a pre-existing `[x]` from before this schema) is counted as
  met but reported separately in the rollup, so a report can say "8 of these were
  ticked before we had provenance" instead of quietly inflating a number.

### 4.7 `questions` and `debt`

Both become sections parsed **in `roadmap-core.ts`** so `get_board` can count them
without the renderer:

- **`## Open questions`** — the convention already exists and is already
  answerable (T130 S4, `card-detail.ts:333-507`). S1 moves the _counting_ into the
  core (`questions: { total, open }`) and changes nothing about the format or the
  answer flow. An optional `→ AC-2` suffix on a question line links it to the AC
  it blocks; absent, the question is card-level.
- **`## Tech debt`** — a new recognized heading with **zero existing adoption**
  (§3.1). Each `- ` item is one debt entry; a `[[slug]]` wikilink in it is picked
  up by the existing `extractWikilinks` so "debt raised → follow-up card created"
  is traceable with no new machinery.

Neither is validated, neither refuses anything. They exist so the S4 Delivery
Report can be **generated** rather than narrated.

### 4.8 `wave`

A plain integer frontmatter scalar, stamped inside the existing per-card loop in
`stampManifestApprovals` (`roadmap-ipc.ts:1532-1545`) alongside `approved` /
`approvedBodyHash`. The wave number is `max(existing wave on this board) + 1`,
computed once per `submit_manifest` call so every card in one manifest shares it.
It is a **controlled field**: `update_card` must refuse it, same as `approved`.

Note the ordering constraint: `approvedBodyHash` is computed from the body
(`roadmap-core.ts:1325-1332`), and `wave` is frontmatter, so the two do not
interact. But **id backfill does** — if a future stage ever backfills at manifest
time it must run _before_ the hash is computed. S1 backfills only in
`set_ac_status`, so this does not arise; it is flagged so it is not introduced
carelessly later.

### 4.9 The parsed card

`RoadmapCard` (`roadmap-core.ts:211-270`) gains three fields, all computed once in
`parseCard` and carried over the existing watcher wire (`roadmap-watcher.ts:50`,
`preload/index.ts:530-533`):

```ts
/** Parsed ACs in document order — the ONE parse; the renderer never re-parses. */
acceptance: ParsedAc[]
/** Wave stamped by submit_manifest, when present. */
wave?: number
/** Section counts the board rollup needs without re-reading the body. */
sections: { questions: number; questionsOpen: number; debt: number }

interface ParsedAc {
  id: string                    // explicit AC-<n>, else derived by position
  idExplicit: boolean           // false ⇒ derived; a write will backfill
  text: string                  // continuation lines folded in
  checked: boolean
  verify?: 'test' | 'visual' | 'manual' | 'review'
  source?: string
  status: 'pending' | 'met' | 'unmet' | 'blocked' | 'needs-human'
  by?: 'verifier' | 'executor' | 'human' | 'unknown'
  at?: string
  evidenceCount: number         // stamped appends anchored to this AC
}
```

This kills the duplicate-parser risk at the source: the renderer's
`parseCardSections` keeps producing `acceptanceExtra` for prose residue, but
`CardDetailModal` switches its checklist to `card.acceptance`. **One AC parser in
the codebase** is a falsifiable acceptance criterion (AC-10).

Wire cost: 254 cards × a handful of ACs each, on a watcher event that already
ships the full body. Negligible, and stated rather than assumed.

---

## 5. The verbs

Both follow the `tool-catalog.ts` house style: one entry in `MCP_TOOLS` (schema +
declarative gate fields), one handler in `tool-handlers.ts`, one member added to
`MCP_OPS`. Nothing else (`tool-catalog.ts:18-22`).

### 5.1 `set_ac_status` — agent-writable, provenance-labelled

```ts
{
  name: 'set_ac_status',
  description:
    "Record a verdict for ONE acceptance criterion on a board card, with typed evidence. " +
    "The verdict lands in the card's `acceptance:` frontmatter block and the evidence as a " +
    "provenance-stamped body append; the AC's checkbox is kept in sync (met ⇒ [x]). " +
    "`by` declares WHO is asserting this — `verifier` (an independent grader), `executor` " +
    "(the session that did the work), or `human`. An executor self-tick is RECORDED but " +
    "NEVER COUNTED as met by get_board's rollup. Grade ONE AC per call. If an AC cannot be " +
    "satisfied, say so with `unmet` (with a reason in `note`) or `blocked` — never drop it " +
    "silently. If it can only be proven by a person, use `needs-human`: that is a first-class " +
    "verdict, not a failure. On a card whose checklist has no explicit AC-<n> ids, the ids are " +
    "backfilled into the body on the first call (the ACK reports which) — which voids a live " +
    "manifest approval stamp, exactly as any other body edit does.",
  inputSchema: z.object({
    folder: z.string().min(1).describe('Absolute path of the folder/worktree whose board to write.'),
    slug:   z.string().min(1).describe('The card slug/id.'),
    ac:     z.string().min(1).describe('The AC id, e.g. "AC-3". Derived by position on a card with no explicit ids.'),
    status: z.enum(['pending','met','unmet','blocked','needs-human'])
              .describe('pending | met | unmet | blocked | needs-human. needs-human = only a person can prove it.'),
    by:     z.enum(['verifier','executor','human'])
              .describe('Who is asserting this. Declared by the caller and recorded verbatim — Capy cannot authenticate it (see the ACK\'s byAuthenticated).'),
    evidence: z.array(z.object({
      type: z.enum(['test','commit','pr','ci','screenshot','operator-judgment']),
      ref:  z.string().min(1).max(500),
      run:  z.string().min(1).max(200).optional()
    })).max(10).optional()
      .describe('Typed evidence for this verdict. Required for `met` — a met AC with no evidence is refused (EVIDENCE_REQUIRED).'),
    note: z.string().max(1_000).optional()
      .describe('Why, in one or two sentences. Required for unmet / blocked / needs-human.')
  }),
  mutates: true,
  op: 'set_ac_status',
  silentAllowInAgentFolder: true   // same risk class as update_card: a board write, no confirm
}
```

Gate posture: identical to `create_card`/`update_card`/`move_card` —
`silentAllowInAgentFolder: true`, **not** `grantable`, **not** `alwaysAllowable`
(matching `tool-catalog.ts:646-718`). It joins the same
`BOARD_RATE_LIMIT_PER_DAY` counter (`tool-handlers.ts:478`).

**Refusals** (typed, steerable, first match wins):

| Code                | When                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `CARD_CLOSED`       | the card is `done` — immutable by verb, same as every board verb |
| `CARD_NOT_FOUND`    | no such slug                                                     |
| `NO_ACCEPTANCE`     | the card has no AC section at all — write one first              |
| `AC_NOT_FOUND`      | `ac` does not resolve to an item in that section                 |
| `EVIDENCE_REQUIRED` | `status: met` with an empty `evidence[]`                         |
| `NOTE_REQUIRED`     | `unmet` / `blocked` / `needs-human` with no `note`               |
| `RATE_LIMITED`      | the per-folder daily board-write cap                             |

`EVIDENCE_REQUIRED` and `NOTE_REQUIRED` are the schema-level expression of
research principle 1 ("done is a property of the environment") and principle 7
("give agents a cheap honest exit"). A `met` you cannot evidence is not a `met`;
an AC you cannot satisfy has two cheap, honest ways to say so.

**ACK:**

```json
{
  "ok": true,
  "slug": "T216",
  "ac": "AC-1",
  "status": "met",
  "by": "verifier",
  "byAuthenticated": false,
  "evidenceRecorded": 2,
  "idsBackfilled": ["AC-1", "AC-2", "AC-3"],
  "approvalStampVoided": true,
  "rollup": {
    "total": 5,
    "met": 3,
    "unmet": 1,
    "needsHuman": 1,
    "blocked": 0,
    "pending": 0,
    "metByExecutorOnly": 1,
    "metByUnknown": 0
  }
}
```

**`byAuthenticated: false` is the honest half of this verb.** Capy cannot verify
that a caller claiming `by: verifier` is not the executor: the MCP transport has
no per-session identity (`tool-handlers.ts:475`, `roadmap-core.ts:1040`,
`tool-catalog.ts:601` — three independent statements). In S1 `by` is a
**declaration, recorded verbatim**, and the ACK says so in a machine-readable
field so a report generator can qualify its own claims. The counting rule from
owner decision 4 ("executor self-ticks recorded, labelled, never counted") still
ships — the rollup splits `met` from `metByExecutorOnly` — but its _integrity_
depends on the caller being honest until S3, where Capy itself dispatches the
verifier and can stamp `by` server-side. Anyone reading a `by: verifier` on an S1
card is reading a claim, not a proof. Stating that is the point.

### 5.2 The `evidence` controlled-field question — resolved by not unlocking it

The research (§7, S1 row 2) says _"`evidence` stops being a refused field; it
becomes structured instead."_ **This spec deliberately departs from that.**
`evidence` stays fully refused by `update_card`, unchanged, at
`roadmap-core.ts:791-799`.

The reasoning:

- **The lock exists because a card must not be able to assert its own delivery.**
  Card-level `evidence: string[]` is an unstructured, unattributed, agent-editable
  blob that the human Close reads back out verbatim
  (`roadmap-ipc.ts:895` → `formatCardCloseEntry`). Unlocking it — even "as
  structure" — would let a card write the very claim the human is about to close
  against.
- **Per-AC typed evidence is a different thing and deserves a different door.** It
  is scoped to one criterion, typed, carries a declared author, requires a note or
  a ref, and is append-only. None of that is true of the blob.
- **So it gets its own namespace, not the blob's.** `acceptance:` (frontmatter,
  written only by `set_ac_status`) plus stamped appends (body, append-only). The
  blob keeps its single human writer and its lock.
- **`acceptance` and `wave` join `CARD_CONTROLLED_FIELDS`.** `update_card` must
  refuse both, so the only path to a verdict is the verb that enforces
  `EVIDENCE_REQUIRED`, `NOTE_REQUIRED` and the `by` label. Without this the whole
  design is bypassable with one `update_card { set: { acceptance: … } }`.

Net effect: the capability the research wanted ships, and the protection the lock
provides is not merely preserved — it is extended to the new field. Flagged here
as a **deliberate departure**, in the T217 style, so it reads as a decision rather
than a drift.

### 5.3 `get_board` — the board plus a rollup, in one call

```ts
{
  name: 'get_board',
  description:
    "Read a folder's roadmap board in ONE call: every card with its column, wave, dispatch " +
    "state and a per-AC rollup (met / unmet / blocked / needs-human / pending, plus how many " +
    "'met's came only from an executor self-tick). Replaces reading one memory_read " +
    "roadmap/<slug> per card. Narrow with `filter`; ask for per-AC detail with " +
    "`include: ['ac']` — the default is compact, because a board can hold hundreds of cards.",
  inputSchema: z.object({
    folder: z.string().min(1).describe('Absolute path of the folder/worktree whose board to read.'),
    filter: z.object({
      status:     z.array(z.enum(COLUMN_ORDER)).optional(),
      wave:       z.number().int().positive().optional(),
      kind:       z.array(z.enum(CARD_KINDS)).optional(),
      parent:     z.string().min(1).optional(),
      slug:       z.array(z.string().min(1)).max(50).optional(),
      hasUnmet:   z.boolean().optional().describe('Only cards with at least one unmet AC.'),
      needsHuman: z.boolean().optional().describe('Only cards with at least one needs-human AC — the manual-test list.'),
      blocked:    z.boolean().optional()
    }).optional(),
    include: z.array(z.enum(['ac','questions','debt','body'])).optional()
      .describe("Per-card detail to expand. Default: none — counts only. 'body' is capped and truncated."),
    limit: z.number().int().positive().max(200).optional().describe('Cap the cards returned (default 100).')
  }),
  mutates: false,
  op: 'get_board',
  alwaysLoad: true,        // an orchestrator needs this on turn 1, like get_fleet / memory_read
  disclosesTranscript: true // it discloses project content, gated like memory_read (tool-catalog.ts:236)
}
```

**What the rollup must contain to make per-card reads unnecessary.** This is the
concrete answer to the brief's question, derived from what the S0 run actually had
to go and fetch:

Board level:

```json
{
  "ok": true,
  "folder": "…",
  "cardCount": 254,
  "returned": 100,
  "truncated": true,
  "columns": { "backlog": 180, "ready": 12, "in-progress": 3, "review": 5, "done": 54 },
  "wip": { "count": 3, "limit": 5, "atCeiling": false, "over": false },
  "waves": [
    { "wave": 2, "cards": 4, "acTotal": 18, "acMet": 11, "needsHuman": 3, "unmet": 1, "open": 2 }
  ],
  "totals": {
    "acTotal": 322,
    "acMet": 8,
    "needsHuman": 0,
    "unmet": 0,
    "blocked": 0,
    "metByExecutorOnly": 0,
    "metByUnknown": 8,
    "questionsOpen": 2,
    "debt": 0
  }
}
```

Per card (compact — the default):

```json
{
  "slug": "T216-…",
  "id": "T216",
  "title": "…",
  "status": "review",
  "column": "review",
  "blocked": false,
  "kind": "feature",
  "complexity": "complex",
  "priority": "high",
  "substrate": "internal",
  "parent": null,
  "deps": ["T217-…"],
  "session": "c26f72e1",
  "executedIn": "spec/t216-s1-ac-schema",
  "wave": 2,
  "approved": true,
  "approvalStampValid": true,
  "spec": "docs/…",
  "prd": null,
  "adr": null,
  "readiness": [{ "code": "missing-prd", "message": "prd required by the complex tier — missing" }],
  "ac": {
    "total": 5,
    "met": 3,
    "unmet": 1,
    "blocked": 0,
    "needsHuman": 1,
    "pending": 0,
    "metByExecutorOnly": 1,
    "metByUnknown": 0,
    "withoutExplicitId": 0,
    "evidenceItems": 7
  },
  "questions": { "total": 3, "open": 1 },
  "debt": { "total": 2 },
  "pr": null
}
```

Four fields earn their place by having been _manually reconstructed_ during the S0
run:

- **`ac.needsHuman`** — this is the manual-test checklist. Without it the Delivery
  Report's most valuable section has to be assembled by reading every card.
- **`ac.metByExecutorOnly`** — owner decision 4 made operational. A rollup that
  merged this into `met` would make the decision unenforceable at the reporting
  layer, which is the only layer where it bites.
- **`ac.withoutExplicitId`** — tells a coordinator which cards are not yet
  addressable, i.e. which will trigger a backfill.
- **`approvalStampValid`** — recomputed via `approvalHashMatches`
  (`roadmap-core.ts:1339-1346`), so a coordinator can see a stale stamp without
  attempting a dispatch to find out.

**`pr` is declared and always `null` in S1.** It is filled by S2's PR harvest.
Declaring the field now means S2 fills a hole rather than changing the ACK shape —
a shape change an already-running orchestrator would have to be re-taught. Stated
as a deliberate choice; the alternative (omit it, add it in S2) is also defensible
and was rejected only on that ground.

**Response size.** 254 cards × the compact row ≈ 300–400 tokens per card if
expanded; the default therefore returns at most 100 cards, compact, with
`truncated: true` and no bodies. `include: ['ac']` expands `ParsedAc[]` per card
and should be used with a `filter`. This mirrors `get_fleet`'s existing
limit/cap discipline (`tool-catalog.ts:284-309`).

**Not a `capy://` resource.** The URI codec (`tool-catalog.ts:823-860`) addresses
`fleet`, `worktrees`, `session/<id>` — all folder-agnostic or id-addressed. A
board is folder-scoped and filtered; a verb with a `filter` argument is the right
shape. Adding `capy://board/<folder>` is possible later and is not blocked.

---

## 6. What `lintCardReadiness` becomes

It stays **pure, non-blocking, badge-only** (`roadmap-core.ts:1275-1304`). Its job
does not change; its vocabulary grows by two codes:

| Code                                | Fires when                                                                      | Tier              |
| ----------------------------------- | ------------------------------------------------------------------------------- | ----------------- |
| `missing-acceptance-criteria`       | _(unchanged)_ no AC heading                                                     | standard, complex |
| `unnumbered-acceptance-criteria`    | **new** — heading + items present, no item carries an explicit `AC-<n>`         | standard, complex |
| `acceptance-criteria-not-checkable` | **new** — heading present, ≥1 item, **zero** checkbox items (all plain bullets) | standard, complex |
| `missing-spec` / `-prd` / `-adr`    | _(unchanged)_ `artifactRequirements`                                            | per tier          |

Deliberately **not** added, and why:

- **No gap for "AC without `verify:`".** 57 cards would badge on day one for a
  token the operator has never written. Noise, not signal.
- **No gap for "AC in review with no evidence".** That is a _verification_
  judgment, and the lint runs on every card on every parse. It belongs to S3's
  verifier, not to a badge.
- **The lint still assigns nothing.** Research §6.A says the lint "becomes the
  thing that assigns ids". It cannot: it is pure, and it returns a list, not a
  write. It _reports_ the gap; `set_ac_status` closes it (§4.5). Flagged as a
  second deliberate departure from the research.

**i18n cost, easy to miss:** the two new codes need
`roadmap.card.readiness.unnumbered-acceptance-criteria` and
`…acceptance-criteria-not-checkable` in **both** `en.json` and `pt-BR.json` — the
existing block is `en.json:1610-1615`. Missing either breaks `vue-tsc`
(`MessageSchema = typeof en`). This is a real contract even though S1 ships no new
UI, because the codes surface in an existing badge.

---

## 7. Review → Done: no check, disclosure deferred

**Close stays a human gesture and gains nothing in S1.** This is a locked owner
decision, and the schema must not erode it by the back door.

- **No gate.** Not a refusal, not a warning-with-override, not a "confirm twice".
  `roadmap:closeCard` (`roadmap-ipc.ts:868-921`) keeps checking nothing.
- **No disclosure yet either — and this is the non-obvious call.** Showing the AC
  rollup at Close is the natural payoff of the schema, and it is tempting to ship
  it here. It should wait for **S3**. Until a verifier actually fills the table,
  every card's rollup reads `0 met / 5 pending`, so a Close-time disclosure would
  train the operator to dismiss an empty panel — and a signal people learn to
  ignore is worse than no signal. Ship it when it has content.
- **One thing S1 _can_ do for free:** `formatCardCloseEntry` already receives the
  card's `evidence`. Extending its input to carry the AC rollup means the closed
  card's own record says `3/5 met · 1 needs-human · 1 unmet` in perpetuity, with
  no UI, no gate and no new decision surface. Listed as **optional and droppable**
  (AC-11) — it is a two-line change to a pure formatter, but it is not what this
  stage is for.

---

## 8. Migration — 254 cards, zero rewrites

| Tier                                     | Cards | What happens                                                                                                         | What is required of anyone |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **0** — no AC section                    | 187   | Parses exactly as today. `acceptance: []`, `ac.total: 0`. Lint unchanged.                                            | nothing                    |
| **0b** — `## Acceptance` (no "criteria") | 10    | **Starts** parsing, because the heading match widens (§4.2). Their items become ACs                                  | nothing                    |
| **1** — AC section, no ids               | 47    | Parsed, counted; `[x]` reads as `met, by: unknown`; ids derived by position; badged `unnumbered-acceptance-criteria` | nothing until graded       |
| **1b** — AC section with `AC-<n>`        | 10    | Fully addressable immediately                                                                                        | nothing                    |
| **2** — new cards                        | —     | The S0 skill convention already writes `AC-n — text — verify: … — source: …`                                         | nothing new to learn       |

**There is no migration script and there must not be one.** A batch rewrite of 254
hand-written cards is precisely the "destroying hand-written cards" failure this
schema is designed around, and it is unnecessary: derived ids plus checkbox-derived
status mean an untouched card is _already_ a valid, readable, countable card. A
card only changes when someone deliberately grades it, and then only its own
checklist gains ids.

**What is knowingly imperfect after migration:**

- The 8 pre-existing `[x]` ticks report `by: unknown` forever. They are counted as
  met but broken out as `metByUnknown` so a report can qualify them. No attempt is
  made to guess who ticked them.
- Cards whose ACs are plain bullets (no checkbox) get `pending` for everything
  until someone grades or ticks them. Correct, and badged.
- The `## Acceptance` widening changes what the modal renders for 10 cards
  (their items move from Context into the AC checklist). This is an improvement,
  but it is a visible change to existing cards and should be called out in the
  CHANGELOG entry rather than slipped in.

---

## 9. Acceptance criteria, restated falsifiably

| #     | Criterion                                                                                                                                                                                                                                              | How it fails                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `parseCard` on **every one of the 254 real cards** produces the same `id/title/status/column/blocked/spec/prd/adr/session/executedIn/evidence/deps/priority/kind/complexity/parent/substrate/approved/provenance/body/malformed` as before the change  | Any field differs on any card — run the old and new parser over the real board and diff; a single delta is a failure                                                    |
| AC-2  | An AC written `- [ ] AC-3 — text — verify: test — source: clickup:PROJ-9#2`, with a wrapped continuation line, parses to one `ParsedAc` with `id: "AC-3"`, `idExplicit: true`, `verify: "test"`, `source` set, and the continuation folded into `text` | The continuation becomes a separate item or lands in `acceptanceExtra`; `verify`/`source` are guessed when absent rather than left `undefined`                          |
| AC-3  | `set_ac_status { ac: "AC-1", status: "met", by: "verifier", evidence: [test, commit] }` writes `AC-1: met · by=verifier · at=…` into the `acceptance:` frontmatter block, flips that AC's checkbox to `[x]`, and appends one stamped evidence entry    | Any of the three writes is missing; the checkbox and the frontmatter disagree after the call; a second identical call duplicates the append instead of adding one entry |
| AC-4  | `set_ac_status { status: "met", evidence: [] }` is refused `EVIDENCE_REQUIRED`; `{ status: "needs-human" }` with no `note` is refused `NOTE_REQUIRED`; both refusals write **nothing**                                                                 | Either is accepted; or a refusal still mutates the card                                                                                                                 |
| AC-5  | `update_card { set: { acceptance: … } }` and `{ set: { wave: 2 } }` are both refused `CONTROLLED_FIELD`; `update_card { set: { evidence: … } }` stays refused exactly as today                                                                         | Any of the three is writable by `update_card` — the whole provenance design is then bypassable in one call                                                              |
| AC-6  | On a card whose checklist carries no explicit ids, the first `set_ac_status` backfills `AC-<n>` into every item in document order, reports `idsBackfilled`, and a second call reports `idsBackfilled: []`                                              | Ids are renumbered on the second call; items outside the AC section are touched; the backfill is not reported                                                           |
| AC-7  | A `met` recorded with `by: "executor"` appears in `get_board` as `met: 0, metByExecutorOnly: 1` — it is **recorded and not counted**                                                                                                                   | It lands in `met`; or it is dropped entirely instead of recorded                                                                                                        |
| AC-8  | `get_board { folder }` returns every card with its column, wave, dispatch state and `ac` rollup **in one call**, and `get_board { filter: { needsHuman: true } }` returns exactly the cards with ≥1 `needs-human` AC                                   | A coordinator still has to call `memory_read roadmap/<slug>` to learn any of: column, wave, AC counts, needs-human, open questions, readiness gaps                      |
| AC-9  | `updateFrontmatterFields(content, { acceptance: 'x' })` **refuses** rather than replacing the block header and orphaning its children; a round-trip `parseCard → upsertFrontmatterBlock → parseCard` on a card with 5 graded ACs is lossless           | The guard is absent — one careless `set` then corrupts a card's frontmatter irrecoverably                                                                               |
| AC-10 | There is exactly **one** AC parser in the repo: `CardDetailModal` renders `card.acceptance` from the core parse, and no renderer module re-derives checked/text from the body                                                                          | Two parsers exist and can disagree — the exact failure `roadmap-core.ts:1229-1234` documents for the artifact matrix                                                    |
| AC-11 | _(optional, droppable)_ A closed card's own `formatCardCloseEntry` record includes the AC rollup at Close time                                                                                                                                         | Not a failure of the stage if absent — listed so dropping it is a decision                                                                                              |
| AC-12 | `docs/capy-features.md` documents both verbs with the marker bumped; `docs/user/agent-control.md` + `roadmap-board.md` updated; a dated `CHANGELOG.md` entry exists; both new lint codes exist in `en.json` **and** `pt-BR.json`                       | Any one missing. The awareness gate catches the first (the diff touches `tool-catalog.ts`); the user-docs gate catches the second; nothing catches i18n but `vue-tsc`   |

**Test plan, by layer** (per ADR-0001, pure-core work is vitest; anything
`app`/fs-bound is integration):

- **Pure (`tests/roadmap-core.test.ts`)** — the AC grammar (all four item shapes,
  wrapped continuations, both headings, explicit vs derived ids, absent
  `verify`/`source`); `acceptance:` block read/write round-trip;
  `updateFrontmatterFields`' new guard; status derivation from the checkbox;
  the rollup arithmetic including `metByExecutorOnly`; `questions`/`debt` counts.
- **Corpus regression** — AC-1 run as a real test: parse the 254-card fixture
  snapshot with the old and new parser and assert field-for-field equality on
  everything except the three new fields.
- **Handler (`tests/mcp-*.test.ts`)** — every refusal code; the three-writes
  atomicity of a successful `set_ac_status`; idempotent backfill; the
  controlled-field refusals; `get_board` filters, `limit`, `truncated`.
- **Catalog** — the existing `tests/mcp-tool-catalog.test.ts` invariants
  (`mutates` correctness, `op ∈ MCP_OPS`, gate-field fail-closed) automatically
  cover the two new entries.

---

## 10. Contracts the implementation owes

**This spec is docs-only:** no CHANGELOG entry, no `docs/user/` update, no
`capy-features` bump for the spec itself. The **implementation** owes all of them.

| Contract                              | Owed?   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md` dated entry            | **Yes** | Two new agent verbs + a visible parsing change for the 10 `## Acceptance` cards (§8)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/capy-features.md` + marker bump | **Yes** | Two new MCP verbs and a new ACK field agents must read (`byAuthenticated`) — squarely agent-facing. **Which number:** the marker on disk is `v35 (2026-08-22)` (`docs/capy-features.md:1`), so this takes **v36**. T206 (§8.1) and T213 (§11.1) _both_ still claim v35 in their specs and neither has landed (`CARD_SUBSTRATES` has no `bg`) — whichever of the three lands first takes v36 and the others take the next free number. Do not ship two v36s. Enforced by `scripts/ci/awareness-gate.mjs` (the diff touches `tool-catalog.ts`) |
| `docs/user/` pages                    | **Yes** | `agent-control.md` (the verbs in human prose — the doc's stated job for every `tool-catalog.ts` verb) and `roadmap-board.md` (what the AC checklist now means). Enforced by `scripts/ci/user-docs-gate.mjs`                                                                                                                                                                                                                                                                                                                                  |
| i18n parity                           | **Yes** | Two new readiness codes in `en.json` **and** `pt-BR.json` (§6). Not gated by CI beyond `vue-tsc`, which will break the build                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `design.md`                           | **No**  | No new component, token, radius or easing. If implementation finds it needs one, the rule stands: edit `design.md` first, same change                                                                                                                                                                                                                                                                                                                                                                                                        |
| ADR                                   | **Yes** | [ADR-0010](../adr/0010-per-ac-state-in-frontmatter-evidence-in-stamped-appends.md), written with this spec. Note `docs/adr/` already has **two** files numbered 0002; 0010 is the next genuinely free number                                                                                                                                                                                                                                                                                                                                 |
| English-only                          | **Yes** | Everything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run typecheck` + `npm run build` | **Yes** | Both before reporting done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 11. Open questions — what this spec could not settle

1. **Can the MCP transport ever authenticate `by`?** **NOT ANSWERED.** Three code
   comments say there is no per-session identity today
   (`tool-handlers.ts:475`, `roadmap-core.ts:1040`, `tool-catalog.ts:601`); none
   says whether that is a protocol limit or an implementation choice. Until it is
   answered, `by: verifier` is a claim. This is the single biggest gap between
   what S1 ships and what the delivery-assurance layer promises, and it is why
   `byAuthenticated: false` is in the ACK rather than hidden.
2. **Backfill race.** A verifier reads a card, an editor inserts an AC, the
   verifier's `set_ac_status` backfills by document order — the id now binds to
   different text. The window is small (one serialized read-modify-write) and the
   usual failure is a loud `AC_NOT_FOUND`, but a silent mis-bind is possible.
   Unresolved. A `textPrefix` confirmation parameter would close it at the cost of
   making the common call clumsier; not proposed, flagged.
3. **Should `evidence` (the card-level blob) eventually be derived rather than
   stored?** Once per-AC evidence exists, the flat list is redundant with it. A
   later stage could compute it. Out of scope, and deliberately untouched here.
4. **Wave numbering across worktrees.** `max(wave) + 1` is computed per board, and
   the board is the repo's single `.capy/memory/roadmap/` shared by every
   worktree — so two concurrent `submit_manifest` calls from two worktrees could
   mint the same wave. The manifest path is already serialized through
   `writeCardFields`, but "serialized writes" is not "serialized numbering".
   **NOT ANSWERED** — not traced through `pokeManifestDrain`.
5. **`get_board` response size at 254 cards with `include: ['ac']`.** The compact
   default is safe; the expanded form is bounded only by `limit`. No measurement
   was taken. A token budget per response (truncate ACs before cards) may be
   needed; unresolved.
6. **Does the T130 S4 answer-append flow need to learn AC linkage?** §4.7 proposes
   an optional `→ AC-2` suffix so a question can name the AC it blocks. Whether
   `parseOpenQuestions` (`card-detail.ts:481`) should also surface it, and whether
   the modal should render it, was not designed. Unresolved; the count works
   without it.

---

## 12. Out of scope, explicitly

- **The integration branch** (`integration:` on epic cards, drain basing children
  on it) — S2.
- **PR / CI harvest.** `pr` is declared in the `get_board` ACK and is always
  `null` — S2 fills it.
- **Verifier dispatch.** No `verify_card`, no auto-dispatch on `move_card review`,
  no Stop-hook gate — S3.
- **Tracker sync and the Delivery Report generator** — S4.
- **All UI work.** No board badge, no modal panel, no Close disclosure. The one
  renderer change permitted is switching `CardDetailModal`'s existing checklist to
  consume `card.acceptance` (AC-10), which is a de-duplication, not a feature.
- **T215 (`message_session`).** The card's re-ranking argues it should be promoted
  into S1 because a verdict that cannot be routed back is half a loop — and that
  argument is correct. It is nonetheless **not in this spec**: T215 is a session
  verb with no overlap with the card schema or these two verbs, it is separately
  specced (`docs/specs/T215-*`), and folding it in here would couple two
  independent units for no delivery benefit. **Recommendation: dispatch T215 as
  S1's sibling in the same wave, not as a later stage.** Nothing in this spec
  blocks it or is blocked by it.
- **Authenticating `by`.** §11 Q1 — an S3 concern.
