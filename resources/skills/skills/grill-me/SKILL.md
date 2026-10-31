---
name: grill-me
description: "The operator's stress test of a spec or plan, between draft and approval. Interviews the operator relentlessly, one question at a time with a recommended answer, walking the design tree branch by branch — and every question that survives lands somewhere visible in the spec: a `D-n` row in Open decisions, an `## Amendments` row, or a non-goal. Ends with a list of what it wrote and what it could not place. Use when the operator says '/grill-me', 'grill me', 'stress-test this plan', 'poke holes in this spec', 'me questiona', or wants a plan challenged before anything is built. Do NOT use to resolve decisions that already exist in a spec (one-by-one), to walk through manual actions (step-by-step), or to start implementing — the plan is not enacted until the operator says the understanding is shared."
effort: medium
---

# Grill Me

Interview the operator about a plan or spec until you reach a shared understanding —
and leave the _residue_ in the document, not in the chat. A grilling that ends with
"good session" and nothing written is a grilling the next session has to repeat.

> Lessons: if a `LESSONS.md` exists in this skill's folder, read it first and apply its rules.

## The contract

1. **One question at a time.** Wait for the answer before the next. Several questions
   at once is bewildering and gets skimmed.
2. **Every question carries your recommended answer.** The operator can say "yes" to
   it, change it, or reject it — either way they are reacting, not composing.
3. **Facts you look up, decisions you ask.** If the code, the memory (`memory_query`),
   a doc or `git log` can answer it, look it up and report what you found. Only
   decisions, trade-offs and intent are put to the operator.
4. **Walk the tree, in dependency order.** Settle the question other questions depend
   on first (what the thing _is_, who it is for, what must not break), then its
   branches. A question whose answer is implied by an earlier one is dropped, not asked.
5. **Nothing is enacted.** You do not implement, dispatch, or start a delivery from a
   grilling. The output is the document and the list below.
6. **Every raised item is placed or listed as unplaced.** Nothing the operator said
   during the grilling may vanish.

## Phase 0 — Load the plan

The target, in order: a spec or plan path the operator gave, the spec attached to the
mission as scope (`mission_get` → `scope`), a `docs/specs/**/spec.md` the conversation
is about, or the plan in the conversation. Read it whole, plus what it cites (PRD,
ADR, mockup). Then run `memory_query` on its main nouns: "why did we choose X?" is
often already recorded, and asking the operator a question they answered last month
is the worst kind of grilling.

If the target is only in the conversation (there is no spec file yet), the placement
rules below still apply to a spec that gets written later: keep the placed items in a
list and hand them to whoever writes it; report that no file existed.

Show a one-message map before the first question: the design tree as you see it, in
5–10 lines, and which branches you will probe first. Then ask question 1.

## Phase 1 — The grilling

Per message: the question, one short paragraph of why it matters (what breaks if it is
answered wrong), your recommended answer, then `AskUserQuestion` with real options
(recommendation first). Probe in this order and stop a branch when it is settled:

- **Intent** — what problem, for whom, what does "done" look like in one sentence.
- **Boundaries** — what is explicitly not part of this; what must not regress.
- **Contradictions** — two sections that cannot both be true (a feature in one slice,
  its prerequisite in a later one; an AC no slice can satisfy).
- **Unowned things** — an AC with no proof, a slice with no files, a decision nobody
  owns, a number nobody measured.
- **Failure and scale** — the empty state, the failure path, the 10× case.
- **Order and cost** — what has to land first; what is the smallest slice that proves
  the idea.

When the operator answers with a _new fact or constraint_ instead of a choice, that is
not a question you asked — it is still an item; place it like any other.

## Phase 2 — Place every item (as you go, not at the end)

After each answer, decide where it lives and write it before the next question:

| The item is…                                                              | Where it goes             | Form                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A choice still open, or one the operator wants to revisit                 | **Open decisions** table  | New row `D-n` (next free number): question, options, default (your recommendation), status `open`                                                                  |
| A choice the operator just made                                           | **Open decisions** table  | New row, already `resolved · <chosen option> · <YYYY-MM-DD>` — then one `memory_append` line to `decisions`                                                        |
| A change to what the spec already says (a requirement, slice, AC, number) | **`## Amendments`** table | New row: date · section affected · what changed · why (the operator's words, short). The original text is not rewritten silently — the amendment row is the record |
| Something the operator rules out                                          | **Goals / non-goals**     | New line under non-goals (or anti-goals when it is a thing to actively avoid), phrased as the thing excluded                                                       |
| A contradiction you found                                                 | **Open decisions**        | A `D-n` row naming both sections, until the operator resolves it                                                                                                   |
| A fact you looked up                                                      | nowhere                   | Report it in the message; do not spend a row on a fact                                                                                                             |
| None of the above fits                                                    | **unplaced**              | Keep it for the closing list                                                                                                                                       |

Rules for the writes:

- **Append-only on the spec.** New rows and new lines; never reword or delete an
  existing row. Touch no section outside the three above.
- Rows go in the tables the spec already has. If the spec has no Open decisions or
  Amendments table, add the table at the end with the standard header and say so; do
  not invent another layout.
- If the mission has a decision node for a `D-n` you wrote as resolved, you still never
  write `chosen`: tell the operator to press **Choose…** on that step in the Mission
  popover. Do not create nodes.
- If the target is not a file (no spec), nothing is written; every item goes on the
  closing list instead, with the exact row it would have been.

## Phase 3 — Close

The grilling ends when the operator says the understanding is shared, runs out of
branches, or says stop. Then, in one message:

```
## Grilled <spec path or "the plan in chat"> — 9 questions · 2 looked up myself

Written to the spec:
- D-6 (open)      · cache invalidation on logout — options A/B, default A
- D-4 (resolved)  · retry lives in the client · 2026-10-31
- Amendments +1   · §3 Slices: S-2 now depends on S-1 · why: needs the shared type
- Non-goals +1    · no offline mode

Could not place:
- "Support for the old export format" — a constraint with no home in this spec; belongs in a PRD or a card.

Owed by you: Choose… on D-6's decision node (if one exists). Nothing is enacted.
```

"Written" lists only what the file now contains — re-read the spec before sending, so
the list matches the rows. "Could not place" is never omitted; when empty, say `none`.
Offer a board card for any unplaced item; only offer.

## Red flags

| Thought                                           | Reality                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| "Let me ask these four together, they're related" | Four questions, four messages.                               |
| "I'll batch the spec edits at the end"            | A crash or a compaction loses them. Place after each answer. |
| "I'll tidy the spec while I'm in there"           | Append-only. A tidy-up is a separate, requested change.      |
| "This answer changes the AC, I'll just edit it"   | Amendments row; the operator sees the history.               |
| "They agreed, so let's start building"            | A grilling enacts nothing.                                   |
| "I'll just look at the final list in my head"     | Re-read the file; list what is actually there.               |
