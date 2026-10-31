---
name: one-by-one
description: "Drain a pile of open decisions one question at a time, and write every answer where it lasts. Reads the spec's Open decisions table (the `D-n` rows) or a wall of open questions, serves ONE decision per message with a recommendation, and after each answer marks that row `resolved` in the spec (chosen option, date), appends one structured line to project memory `decisions`, and — when the mission holds a decision node for it — points the operator at the Choose door (the skill never writes `chosen`). Use when the operator says '/one-by-one', 'one by one', 'one at a time', 'um por vez', 'vamos por partes', or reacts to a dense message with 'this is too much'; also when a spec has open D-n rows, or when you are about to send more than ~5 questions at once. Do NOT use to walk the operator through executing manual actions (step-by-step), to stress-test a plan with questions you generate (grill-me), or for a plain summary — this skill resolves decisions, it never decides them."
effort: medium
---

# One by One

Turns a pile of open decisions into a queue the operator can drain: the whole list
first, then **one decision per message**, each answer written down where the next
session will find it — not left in the transcript.

**Sister skills:** `harnu:step-by-step` drains manual _actions_; `harnu:grill-me`
generates the questions. This one resolves the decisions that already exist.

> Lessons: if a `LESSONS.md` exists in this skill's folder, read it first and apply its rules.

## The contract

1. **Facts you look up, decisions you ask.** Before an item reaches the operator,
   ask: can a search, a file read, `git log`, `memory_query` or a doc lookup settle
   it? If yes, do it and show the _result_. The operator's time goes to trade-offs,
   preferences and product calls only.
2. **You never answer a decision yourself.** Not on silence, not on "ok" to a
   non-question, not because the recommendation is obvious. You recommend; the
   operator decides. A row you could not put to them stays `open`.
3. **The whole queue exists before the first question.** Create every item in the
   task list (`TaskCreate` or the harness equivalent) in one go, numbered. A new
   item found mid-walk is appended at the end, and you say so.
4. **One item per message. Exactly one.** No preview of the next, no bundling.
5. **Every item ends in `AskUserQuestion`** with 2–4 real options, your
   recommendation first and marked. An item closes only on the operator's answer.
6. **Every closed item is written down** (see _Persistence_) before the next one is
   served. A decision that exists only in chat is not resolved.

## Phase 0 — Locate the pile

In order of precedence:

1. a spec path the operator gave, or the spec attached to the mission as scope
   (`mission_get` → `scope`);
2. a `docs/specs/**/spec.md` the conversation is about;
3. text the operator pasted, or the most recent message that holds the pile.

When the source is a spec, the pile is its **Open decisions** table:

```
| D-n | question | options | default | status |
```

Rows whose status is `open` are the queue. Read the whole spec, not just the table —
a decision may hide in prose, and an Amendments row may already have settled one.
When the source is a wall of text with no spec, run the same walk and write nothing
to a spec (there is none); the memory line and the closing report still apply.

## Phase 1 — Inventory (one message)

1. Extract every atomic open thread (one item = one answer). Split bundles.
2. Classify: **Decision** (the operator's call), **Question** (look first), **Check**
   (you verify), **Read** (you read and summarize in two lines), **FYI** (drop).
3. Dedupe. Self-resolve what rule 1 allows; a plain fact goes into the inventory
   already ✔ with its evidence, a finding that still needs judgment stays as a
   Decision with the fact as context.
4. Order: blockers and decisions that unlock the most first, cheap confirmations last.
5. Create the task list, then show the inventory and stop with an `AskUserQuestion`
   ("Start with 1?" / reorder / drop):

```
## One by one — 7 items (4 decisions · 1 question · 2 checks)
Dropped 3 FYI lines, merged 1 duplicate, resolved 2 myself (✔).

1. [Decision] D-3 Where does the retry live?
2. [Decision] D-1 …
✔ 6. [Check] `lib/http/retry.ts` already handles 429 (line 14)
```

## Phase 2 — Walk the queue

One item per message:

```
## 2/7 — D-1 <short title>   ([Decision] · blocks D-4)

<2–4 lines: what this is about, what you found, why it matters>

**Recommendation:** <one line, with the reason>
```

then `AskUserQuestion` with the real alternatives (options mirror the row's
`options` cell when it has one) and their practical consequence in one line each.

After the operator answers, in this order:

1. **Say it:** one line, "Resolved: <decision> — <chosen option>".
2. **Spec row** — rewrite that `D-n` row in place (see _Persistence_).
3. **Decision node** — if the mission has a decision node for it, hand the choice to
   the operator's door (see _Persistence_).
4. **Memory line** — one `memory_append` to `decisions`.
5. **Close the task**, then serve the next item. No recap in between.

### Controls the operator can use

**skip / later / pula** (deferred, resurfaces at the end; the row stays `open`) ·
**back / volta** (reopen the previous item) · **list / resumo** (show what is left) ·
**stop / para** (end the walk, jump to the close-out). Anything else is a follow-up on
the current item.

## Persistence

### The spec row

The resolved row keeps its `D-n`, question and options cells, and its status cell
becomes exactly:

```
resolved · <chosen option> · <YYYY-MM-DD>
```

If the table has separate `chosen` / `date` columns, fill those and write plain
`resolved` in the status column instead. Touch nothing else in the spec: not the
default cell, not neighbouring rows, not the prose. When the answer _changes_ what
the spec says (a requirement, a slice, an AC), do not edit that text here — add a row
to the spec's `## Amendments` table naming the `D-n` and the section it affects, and
tell the operator the section now disagrees with the decision.

An answer that is none of the listed options is still a resolution: write what the
operator said, verbatim and short, as the chosen option.

### The mission decision node

`mission_get` lists the mission's steps; a step with a `decision` is a decision node.
When one matches the `D-n` (same question, or its title names the `D-n`):

- **You never write `chosen`.** `mission_update_step` refuses it (`CONTROLLED_FIELD`)
  and a decision node the operator already chose cannot be rewritten
  (`DECISION_CHOSEN`). The choice is the operator's door.
- Tell them exactly where: "click the Step N of M pill → on the decision step press
  **Choose…** → pick <option>". That click writes `chosen`, one Log line, and unlocks
  the steps the decision held back.
- Do not wait on it before serving the next item, but list it on the close-out as
  **owed by you** until the node reads decided (`mission_get` → the step's `decision.chosen`).
- If there is no matching node, say nothing about nodes. Never create a decision node
  just to have one.

### The memory line

One call per resolved `D-n`, no prose around it:

```
memory_append({ folder, page: "decisions", entry:
  "D-3 resolved · <chosen option> · <YYYY-MM-DD> · spec: <repo-relative spec path> · why: <the operator's reason, one clause>" })
```

Written in English whatever language you chat in. No secrets. A deferred or skipped
row writes nothing.

## Phase 3 — Close out

End with a `harnu:report-back` style checklist, one line per item with its resolution
and where it landed, then what is deferred and what the operator still owes:

```
✅ D-3 Retry location — keep in client · spec row ✓ · memory ✓ · node: operator to Choose…
✅ D-1 Rate-limit config — 429 already handled (verified, no question asked)
⏭️ D-5 Naming of the env var — deferred, row still open
Owed by you: Choose… on D-3's node. Deferred: D-5. Want cards for the deferred ones?
```

Offer a board card (`create_card`) for each deferred item; only offer.

## Red flags

| Thought                                              | Reality                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| "They'd obviously pick the default"                  | Then recommend it and ask. Resolved means they said so.                        |
| "I'll write all the rows at the end"                 | Row, memory line, then the next question — a crash mid-walk must lose nothing. |
| "I'll set `chosen` on the node to save them a click" | It is refused, and it is their door. Point at the click.                       |
| "I'll fix the spec section the answer changes"       | That is an Amendments row plus a note, not a silent edit.                      |
| "These two are tiny, ask both"                       | Two items, two messages.                                                       |
| "They said ok"                                       | To what? If it was not a yes/no, ask again or defer.                           |
