# ADR-0010 — Per-AC state lives in frontmatter; per-AC evidence lives in stamped body appends

**Status:** Accepted (design) · **Date:** 2026-08-23
**Context card:** T216 stage S1 · **Spec:** [`docs/specs/T216-S1-ac-schema-and-verbs.md`](../specs/T216-S1-ac-schema-and-verbs.md)

> Numbering note: when this ADR was written, two files shared the number `0002`; the
> remove-folder record has since been renumbered to `0016`.

## Context

T216 S1 makes a card's acceptance criteria machine-addressable: each AC gains a
status (`pending | met | unmet | blocked | needs-human`), a declared author
(`verifier | executor | human`) and typed evidence. The question this ADR settles
is **where those bytes live in the card's `.md`**, given four existing writers that
must not contend:

| Writer                                                     | Touches                                        | Cite                      |
| ---------------------------------------------------------- | ---------------------------------------------- | ------------------------- |
| `updateFrontmatterFields`                                  | one frontmatter line per field, never the body | `roadmap-core.ts:646-687` |
| `replaceCardBody` / `update_card { replaceBody }`          | the whole body, never frontmatter              | `roadmap-core.ts:711-717` |
| the modal's edit-mode Save                                 | the whole body (same door)                     | `CardDetailModal.vue`     |
| provenance-stamped appends (`memory_append`, `appendBody`) | the body's tail                                | `memory-core.ts`          |

And two hard constraints:

1. **Markdown must remain the human surface.** A card is a document someone reads
   and hand-edits; the AC checklist is the part they read most.
2. **254 existing cards must keep working**, 187 of which have no AC section at
   all and 8 of whose 322 checkboxes are ticked.

The research report (§6.A) proposed a nested YAML `acceptance:` list in
frontmatter carrying text, source, verify, status **and** evidence together.

## Decision

Split the facts by writer, not by topic.

1. **AC text, id, `verify:` and `source:` stay in the body**, in the
   `## Acceptance criteria` checklist, in a forgiving markdown grammar. Humans own
   them.
2. **Per-AC `status` and `by` live in frontmatter**, in a new nested `acceptance:`
   block whose children are a flat `AC-<n>: <status> · by=… · at=…` map — the same
   shape `readFields` already collects for `provenance:`
   (`roadmap-core.ts:354-381`) and the same `·`-separated `k=v` record the
   provenance stamp line already uses. Written **only** by `set_ac_status`.
3. **Per-AC evidence lives in the body**, as one provenance-stamped append per
   `set_ac_status` call — the existing append format, already rendered by the
   modal's Trail.
4. **The checkbox is a projection of `status`**, not an independent fact:
   `set_ac_status` writes both; a human flip is recorded as an
   `operator-judgment`.
5. **`acceptance` and `wave` join `CARD_CONTROLLED_FIELDS`**, and the card-level
   `evidence: string[]` blob **stays refused** — it is not unlocked, restructured
   or reused.
6. **A new pure writer** `upsertFrontmatterBlock` handles the block, and
   `updateFrontmatterFields` gains a guard refusing block-valued keys.

## Why

**Against putting per-AC state in the body.** `update_card { replaceBody }` and
the modal's edit-mode Save both replace the entire body verbatim. A verdict
recorded in the body — in a fenced block, an HTML-comment region, or inline — is
destroyed by the next spec rewrite, silently, with no error. Frontmatter is
structurally immune: `replaceCardBody` carries the head through byte-for-byte
(`roadmap-core.ts:711-717`). Preserving a body region across `replaceBody` was
considered and rejected: it would make that verb non-verbatim, contradicting its
own documented contract and making a "full replace" quietly partial.

**Against putting per-AC evidence in frontmatter.** Evidence is unbounded,
multi-field and append-only. The flat-child-map shape cannot carry a list of
records without either a real YAML parser (new surface area in a module whose
whole point is being dependency-free and deterministic — `roadmap-core.ts:1-71`)
or a JSON blob on one line, which nobody can hand-repair. Stamped appends are
already immutable-by-convention, already carry provenance, and already render.

**Against unlocking `evidence`.** The lock exists because a card must not assert
its own delivery, and the human Close reads that blob back out verbatim
(`roadmap-ipc.ts:895`). Per-AC evidence is a different thing — scoped, typed,
authored, note-or-ref required — so it gets its own namespace rather than
inheriting the blob's. The protection is not merely preserved; it is extended to
the new field.

**Why the writer guard is not optional.** `updateFrontmatterFields` matches
`^acceptance:[ \t]*.*$` and replaces that single line, orphaning the indented
children below it. Without the guard, the new schema is one careless
`writeCardFields({ acceptance: … })` away from corrupting a card irrecoverably.

**Why this is not a departure from the research so much as a refinement of it.**
The research asked for structured, typed, per-AC, provenance-carrying state, and
that is exactly what ships. It guessed at a single YAML home before the writer
constraints had been read; those constraints are what split it in two.

## Consequences

**Good.** No migration script and none possible to need: an untouched card parses,
counts and renders exactly as before, and an AC's status is derived from its
checkbox when the schema says nothing. `replaceBody` and edit-mode Save keep their
existing contracts unchanged. Evidence gains an audit trail rather than a mutable
field. The `evidence` lock is strengthened, not traded away.

**Bad, and accepted.** The verdict and its evidence live in two places, so a
`replaceBody` that drops prior appends orphans the evidence while the verdict
survives. This is visible rather than silent — `get_board` reports
`evidenceCount`, so an orphaned verdict reads as `met` with zero evidence, which
is the correct thing for a reviewer to distrust.

**Bad, and accepted.** Two new pieces of pure machinery (a second nested-block
reader, a block writer) touch the most safety-critical function in the card model.
They are pure, deterministic and unit-testable, and the corpus regression over all
254 real cards (spec AC-1) is the check that they changed nothing.

**Unresolved and out of this ADR.** Whether `by` can ever be authenticated —
the MCP transport has no per-session identity (`tool-handlers.ts:475`), so in S1
`by` is a declaration recorded verbatim and the ACK says so. See the spec §11 Q1.

## Alternatives rejected

| Alternative                                                      | Rejected because                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Everything in a nested frontmatter YAML list (research §6.A)     | Needs a real YAML parser in a deliberately dependency-free pure core; evidence lists do not fit the flat-child-map shape        |
| Everything in a delimited body region (`<!-- capy:ac-state -->`) | Wiped by `replaceBody` and by edit-mode Save; defending it requires making "replace the whole body verbatim" untrue             |
| A single JSON-encoded frontmatter scalar                         | Mechanically safe and works with the existing writer, but unreadable and unrepairable by hand — the card stops being a document |
| Unlock `evidence` and structure it in place                      | Re-opens the exact channel the lock exists to close, on the field the human Close reads back verbatim                           |
| Ids assigned by `lintCardReadiness`                              | The lint is pure and returns a list; it cannot write. It reports the gap, `set_ac_status` closes it                             |
