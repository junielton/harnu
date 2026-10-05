# T96+T105 — API spec: direct board verbs + schema v2

**Status:** Spec v1 (2026-07-09) · **Cards:** [[T96]] (verbs) + [[T105]] (schema/templates) — same worktree, SEQUENTIAL (same files)
**Base:** epic `T82-agent-task-manager.md` §11 (pivot "the board belongs to the agent") + §12 (permanent principle) · T80 §0 (invariants untouched)
**Executor:** worktree `feat/t96-board-verbs` · sonnet·high · never in parallel with another card touching `roadmap-core/ipc/watcher` or `tool-catalog`.

---

## 0. Principle and doors (this spec's contract)

> **"Claude is the drift pilot; Harnu is the car."** The three verbs are DIRECT writes, no confirm, no Inbox — zero friction
> between the model and the board. Security lives in the doors, and this spec doesn't
> touch any of them: dispatch stays gated (T80/T104), `done` stays human, routing stays
> human. Server-side provenance on every write = total audit in place of friction.

Invariants this work mechanically PRESERVES:

1. No verb writes `done` — never, under no argument.
2. No verb writes `in-progress` — that column only exists via real dispatch/bind
   (columns tell the truth about what's running).
3. CONTROLLED fields (`status` outside the allowed enum, `session`, `evidence`,
   `provenance`, `approved`) are never written by a verb — `update_card` refuses them.
4. Path-jail: every write lands at `<memoryDir>/roadmap/<slug>.md` resolved by
   `resolveMemoryLocation` (T89) — never a path coming from the agent.

## 1. The three verbs (tool-catalog.ts)

### 1.1 `create_card` (mutates, auto-allowed in agent-enabled folder)

```
{ folder: string,            // folder/worktree — resolves to the repo's board (T89)
  title: string,             // required, 1..200 chars
  body?: string,             // free markdown (the card spec); cap 16 KiB
  kind?: 'scout'|'bug'|'feature'|'review'|'chore',
  complexity?: 'trivial'|'simple'|'standard'|'complex',
  parent?: string,           // slug/id of an existing card (1 level: a parent can't have a parent)
  deps?: string[],           // slugs/ids
  substrate?: 'session'|'worktree'|'teammate'|'internal',   // PROPOSED (Q20)
  priority?: 'high'|'medium'|'low' | string,
  spec?: string }            // relative path to spec (repo)
```

- **`status` is ALWAYS born `backlog`** (not an argument — doesn't even exist in the
  schema).
- **id minted server-side, filename derived from it:** the id now follows the
  SAME `T<n>`/`BUG-<n>` numbering the operator already uses by hand — `kind: 'bug'`
  gets `BUG-<n>`, everything else gets `T<n>`, where `<n>` is one more than the
  highest existing id of that shape on the board (`mintNextCardId`, scanning every
  card's frontmatter `id`, not just filenames). The mint-then-write is serialized
  per repo (`withCardIdMintLock`) so two racing calls can never mint the same
  number. The filename is `<ID>-<short-slug>.md`, where `<short-slug>` is
  `slugifyTitle(title)` — readable, cut on a word boundary (never mid-word), but no
  longer required to be unique on its own since the ID carries uniqueness; a
  collision on the full `<ID>-<short-slug>` base still falls back to `resolveUniqueSlug`'s
  `-2`, `-3`… suffix. Frontmatter `id:` is the minted ID, distinct from the filename
  slug — exactly like a human-authored card (`T77-mission-grant-discovery.md` with
  `id: T77`). Pre-T126 agent cards (long-slug ids, id === slug) are never renamed or
  renumbered — the scan simply ignores ids that don't match the `T<n>`/`BUG-<n>`
  shape.
- **Provenance stamped server-side** (author: agent, at ISO, real sessionId —
  resolving synthetic→real like memory_append already does —, branch). Fail-closed
  preserved.
- Template by kind (T105, §3): when `body` comes empty/short AND `kind` is present,
  the server seeds the delegation packet skeleton into the body.
- ACK: `{ ok, id, slug, path, column: 'backlog', seededTemplate: boolean }`.
- Steering errors: `BOARD_DISABLED` (folder without agent control) ·
  `PARENT_NOT_FOUND` · `PARENT_HAS_PARENT` (1 level, Q3) · `BODY_TOO_LARGE` ·
  `INVALID_KIND` etc. — always a steerable error with the fix in the text (BUG-10/T63
  pattern).

### 1.2 `update_card` (mutates, auto-allowed)

```
{ folder: string, slug: string,
  set?: { title?, kind?, complexity?, parent?, deps?, substrate?, priority?, spec? },
  appendBody?: string }      // dated append to the body (reuses the memory_append pipeline)
```

- `set` uses `updateFrontmatterFields` (surgical, preserves passthrough — already
  exists in `roadmap-core.ts`). `appendBody` gets a provenance stamp per entry
  (identical to today's memory_append — which keeps existing and valid for non-card
  pages).
- **Refuses controlled fields** with `CONTROLLED_FIELD` steering (lists the field and
  states the right channel: "status changes via move_card; done/session/evidence
  belong to Capy/the human").
- `substrate` is only editable while the card has NO linked `session` (Q20: immutable
  post-dispatch) — otherwise `SUBSTRATE_LOCKED`.
- Card in `done`: immutable by verb (`CARD_CLOSED`).
- ACK: `{ ok, slug, changed: string[] }`.

### 1.3 `move_card` (mutates, auto-allowed)

```
{ folder: string, slug: string, to: 'backlog'|'ready'|'review' }
```

- CLOSED enum in the schema — `done` and `in-progress` don't even parse; steering
  distinguishes: `DONE_IS_HUMAN` ("Review→Done is the operator's gesture on the
  board") and `IN_PROGRESS_IS_BOUND` ("in-progress only exists via real dispatch").
- Free origin (Q10: maximum flexibility), including exiting `in-progress`
  (abandonment → backlog; `internal` card completion → review). `done` card:
  `CARD_CLOSED`.
- Write via the SAME serialized IPC path as the human (internal `roadmap:setStatus`)
  — a single file writer, zero race with the view.
- **`move_card → ready` does NOT trigger any spawn.** Organizing ≠ starting the
  machine: the dispatch flow (offer/confirm/manifest T104) keeps being triggered by
  the watcher exactly as today — and `decideDispatchGate` already forces confirm for
  an agent card without a stamp. No change to `roadmap-ipc.planDispatch` in this
  work.
- ACK: `{ ok, slug, from, to }`.

## 2. Permission: why auto-allowed doesn't breach the doors

- The three verbs only mutate board files inside the memory dir (path-jail §0.4) —
  they don't execute, don't spend, don't approve. Same risk class as `memory_append`
  (which already runs without confirm when the folder is agent-enabled).
- Still BEHIND the http-guard + folder allowlist (folder not enabled = refusal with
  the hint to enable it in the menu — existing pattern).
- **Anti-runaway:** cap of 200 board writes per session/day (`BOARD_RATE_LIMIT`
  steering with the counter — deliberately high number: it's a runaway-loop brake,
  not friction). Shadow log (T30) records every write.
- `SAFE_GRANT_VERBS` doesn't change (these verbs don't even need a grant).

## 3. Schema v2 (T105 — after T96, same worktree)

1. **New frontmatter recognized by the core:** `kind`, `complexity`, `parent`,
   `substrate` — parsed in `parseCard` (today they'd be passthrough), exposed on
   `RoadmapCard`, with lenient validation on read (a strange value = undefined +
   `rawKind` preserved; verb writes are strict).
2. **Templates by kind (I1/Q24):** delegation packet skeleton seeded in the body —
   sections `## Objective` · `## Acceptance criteria` · `## Out of scope` ·
   `## Evidence to return` (the 4 mandatory ones) + per-kind: bug gets `## Repro`,
   review gets `## Verdict`, scout gets `## Findings`. Template content: files under
   `resources/board-templates/<kind>.md` (product asset, human-owned).
3. **Complexity → requirements (LINT only, never refusal):** pure function
   `lintCardReadiness(card)` in `roadmap-core.ts` → list of gaps ("standard without
   ## Acceptance criteria", "complex without spec/links"). Consumed by: (a) the
   board UI as a badge on the card in Ready, (b) the future T104 manifest. Blocks
   NOTHING in this work.
4. **Minimal board UI:** `kind` and `complexity` chips on the card (existing tokens;
   design.md §6 entry FIRST — one line in the Roadmap board section; no new color).
   `parent` does NOT get a swimlane yet (I5 is a future card) — just a "↑ <parent>"
   chip.
5. **i18n:** chip/lint labels in `en.json` + `pt-BR.json` (mandatory parity).

## 4. capy-features v8 (part of T96 — rewrites the S0 paragraph)

Replace the "Roadmap board — what you can and cannot do" paragraph with (doc voice,
2nd person): the board is YOURS to organize — `create_card` / `update_card` /
`move_card` direct, no confirm; born in backlog; move between backlog↔ready↔review
freely; you NEVER move to done (human) and in-progress only exists via real
dispatch; moving to ready does NOT start work — execution goes through the
operator's door (confirm/manifest); announce what you created/moved; organize with
restraint (task-smell: deferred change intent, not exploratory conversation — short
text here, the long version goes in capy-orchestrator T108). Bump marker v8 + green
awareness gate.

## 5. ACs (what the executor returns as evidence)

- **AC-1:** the 3 verbs in the catalog with the schemas above; direct write with no
  confirm in an agent-enabled folder; steerable refusal in a non-enabled folder.
- **AC-2:** `create_card` born backlog, server-side provenance, unique slug,
  template seeded when kind is present and body is empty; `id`/file never collide
  (proof: title-collision test).
- **AC-3:** `update_card` refuses ALL controlled fields (test enumerates each one);
  `substrate` locks with `session` present; `appendBody` stamps provenance.
- **AC-4:** `move_card` covers the origin×destination matrix (pure tests):
  any→{backlog,ready,review} ok except origin done; `done`/`in-progress` impossible
  by schema; write goes through the serialized path; watcher emits and the view
  updates.
- **AC-5:** moving to ready by verb does NOT spawn anything; the existing dispatch
  flow stays intact (test: agent card in ready → gate = confirm, as today).
- **AC-6:** `parseCard` exposes kind/complexity/parent/substrate;
  `lintCardReadiness` pure and tested; chips on the board with i18n en+pt-BR;
  design.md §6 updated BEFORE the UI.
- **AC-7:** capy-features v8 (§4) + `docs/capy-features.md` gate ✓ + CHANGELOG for
  the day + typecheck + build green. **Commits on the worktree branch; NEVER merge
  into main.**

## 6. Out of scope (this work)

Manifest/`approved` (T104) · any change to dispatch/planDispatch · guard (T109) ·
autonomy toggle (T106) · swimlanes (I5) · UI-editable templates · delete verb (v1:
agent doesn't delete a card; the operator deletes the file — reevaluate with usage).
