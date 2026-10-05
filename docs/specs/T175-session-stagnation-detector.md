# Decision spec: the stagnation detector — teaching `stuck` to see a busy session going nowhere

**Cards:** `T175` (core), `T176` (surface), `T177` (retire the pulse)
**Supersedes, in practice:** the live session pulse (`live-session-pulse` spec) as the
occupant of the Fleet card's line 2.

## Problem

The operator's question when scanning the Fleet board is **"is this session progressing
or did it get wedged?"**. Today the board cannot answer it, for two independent reasons.

### 1. `stuck` only detects silence

`src/renderer/src/stores/fleet-state.ts:153-163` (`workingOrStuck`):

```ts
// a session believed `working` becomes `stuck` iff:
nowMs - Math.max(modifiedMs, lastEventMs) >= STUCK_AFTER_MS // 3 * 60_000, line 52
```

That is **filesystem silence**, nothing else. No transcript content, no tool names, no
repetition. `FleetSignals` (`:55-110`) carries only liveness/freshness inputs.

The consequence is structural: a session that is wedged but **active** — retrying the
same failing command, re-reading the same files, burning context — touches the
transcript on every tool call, so `modifiedMs` keeps advancing and it is **never**
classified `stuck`. The board can only see _quiet_ stalls. The _noisy_ stall, which is
the expensive one (it consumes a live PTY slot out of `fleet-policy.ts`'s `maxLive: 5`
and burns context), is invisible by construction.

### 2. The pulse answers a different question, expensively

Line 2 of the card renders `session.pulse.text` — a Haiku-generated ≤8-word phrase
(`src/main/pulse-prompt.ts:18-26`). Its input is only the **last assistant turn**
(`derivePulseDelta`, `:29-45`), so:

- while the session works, it has substance to summarise — but that is when nobody is
  looking at the card;
- when the session stops, the delta is a closing message or empty, and the model emits
  `awaiting task`, `ready for task input`, `initializing session context` — a restatement
  of the fleet-state the dot already shows, one line to its left.

Its cost is paid in the app's scarcest resource. Each pulse is not an API call but a
full `execFile('claude', ['-p', …, '--model', 'haiku'])` process spawn
(`src/main/haiku.ts:60+`), fired per session on every turn end and on a 15 s work floor
(`PULSE_WORK_INTERVAL_MS`, `src/renderer/src/stores/pulse-core.ts:10`). At the
`maxLive: 5` ceiling that is **up to ~20 CLI process spawns per minute** to render text
the dot already carries. The token bill is negligible; the process bill is not, on a
machine already running N `claude` PTYs — the very pressure `fleet-policy.ts` exists to
ration.

## Decision — a second flavour of `stuck`, derived from transcript content, with no LLM

Add a **stagnation detector**: a pure fold over the transcript tail that flags a session
emitting tool calls whose targets it has already visited, with no mutation among them.
Merge its verdict into the existing `stuck` state; render its evidence in the line-2 slot
the pulse vacates.

Four decisions, each with its justification:

### D1 — Content-derived, not LLM-derived

The signal is repetition of concrete tool targets, which is directly observable in the
JSONL. An LLM judge (considered and rejected, see _Rejected alternatives_) is not needed
to notice that `Bash: npm test` ran twelve times with no `Edit` between.

This makes the whole feature cost **zero process spawns, zero tokens, zero network** —
strictly cheaper than what it replaces. It consumes the same `newLines` payload the
pulse already receives and the same tail the reader already parses.

### D2 — Measured in **transcript time**, not wall-clock time

The window is anchored to the timestamp of the **last entry in the tail**, not
`Date.now()`. Every entry carries a top-level ISO `timestamp` (verified against a live
transcript), so this is available.

Three things follow, and they are the reason to prefer it:

1. **The detector stays a pure function** — no clock, no timer, no injected `nowMs`. It
   drops into `deriveTranscriptTruth()` (`src/main/transcript-truth.ts:377`) beside the
   existing pure derivations, and unit tests are deterministic fixtures.
2. **It cannot fight the existing `stuck`.** Wall-clock silence is _already_ owned by
   `workingOrStuck`; measuring stagnation on the wall clock would make a quiet session
   drift into "stagnant" too, duplicating that rule. In transcript time, a quiet session
   simply stops producing entries and the verdict freezes — silence stays the other
   rule's job. The two are orthogonal by construction.
3. No new re-evaluation loop is needed: a stagnant session is by definition still
   emitting entries, so the watcher already recomputes on every append.

### D3 — Stateless over the tail, not an accumulator

Novelty is judged against the fingerprints of entries **earlier in the same tail**, not
against a persisted per-session set.

The reader keeps a trailing ring of 800 entries / 512 KB (`TAIL_RING_MAX`,
`TAIL_WINDOW_BYTES` at `src/main/claude-reader.ts:431,439`). Judging novelty inside that
window means no new state to hold, invalidate, or grow — the memory cost of the feature
is zero beyond the transient fold.

The trade is a **false negative** at the boundary: a target first visited outside the
tail reads as novel today. That is the correct direction to be wrong — the detector
under-reports rather than crying wolf, and a missed stall is recovered on the next
window once the repetition re-enters the tail.

### D4 — Reuse the `stuck` bucket; do not add a seventh board state

`BoardState` (`src/renderer/src/components/fleet-board.ts:19`) has six members. A
stagnant session joins `stuck`.

The operator action is identical for both flavours — _go look at this one_ — and the
board's whole contract is that state is carried by the dot + ring with no state labels
(`docs/specs/2026-07-17-fleet-rail/`). A seventh state would demand a new dot, a new
ring treatment, a `design.md` §7 row, and an i18n pair, to encode a distinction the
operator does not act on differently. The distinction lives in **line 2's text**, which
is where evidence belongs.

Accepted wrinkle: for a stagnant session, line 3 renders `relativeTime(modified)` ≈
"now" beside a red `stuck` ring. That reads as contradictory at first glance but is
truthful and, on reflection, informative: _active, and going nowhere_. Line 2 states it
in words, so the card is not ambiguous. Revisit only if the operator reports confusion.

## Spec — the detector

New pure module `src/main/stall-detect.ts` (zero electron/fs deps, `node` vitest env —
mirroring `pulse-prompt.ts` / `haiku-autoname.ts`).

### Constants

```ts
export const STAGNATION_WINDOW_MS = 5 * 60_000 // transcript time
export const STAGNATION_MIN_CALLS = 8 // busy-ness floor
export const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
```

### Fingerprinting a tool call

A fingerprint identifies _what a call acted on_, so repetition is detectable across
turns. Salient input key by tool (fall back to the first string-valued key, else `''`):

| Tool                                 | Salient input                                     |
| ------------------------------------ | ------------------------------------------------- |
| `Read` `Edit` `Write` `NotebookEdit` | `file_path`                                       |
| `Bash`                               | `command`, whitespace-collapsed, capped at 200 ch |
| `Grep`                               | `pattern`, then a space, then `path ?? ''`        |
| `Glob`                               | `pattern`                                         |
| `Task` / `Agent`                     | `description`                                     |

Two derived strings, deliberately distinct:

- **fingerprint** (comparison key) — `name`, then a `U+0000` separator, then `salient`.
  NUL cannot occur in either part, so two different calls can never collide into one key.
- **label** (display only) — `name`, `": "`, `salient`; truncated by CSS at the render
  site. Never used for comparison.

### The verdict

```ts
export interface StagnationVerdict {
  stagnant: boolean
  /** Tool calls inside the window. */
  calls: number
  /** Distinct fingerprints inside the window (the tally's second number). */
  distinct: number
  /** Display label of the most-repeated fingerprint, e.g. `Bash: npm test`. */
  topTarget: string
  /** Repeat count of `topTarget` inside the window. */
  topCount: number
}
```

`calls` and `distinct` are populated whether or not `stagnant` is true — they are the
tally T176 renders in `SessionPreview`, and a non-stagnant session still has a
meaningful one.

### The rule

Let `last` = timestamp of the final entry in the tail; the window is
`(last - STAGNATION_WINDOW_MS, last]`. Partition tail tool calls into `windowCalls` and
`priorCalls` (everything earlier, still inside the tail).

```
stagnant  ⇔  windowCalls.length >= STAGNATION_MIN_CALLS
         AND novel == 0        // no fingerprint absent from priorCalls
         AND mutations == 0    // no MUTATION_TOOLS call in the window
```

`novel == 0` and `mutations == 0` are both required, and the conjunction is what keeps
the false-positive rate low. Worked cases:

| Situation                                    | Verdict      | Why                                      |
| -------------------------------------------- | ------------ | ---------------------------------------- |
| `npm test` × 12, no edits between            | **stagnant** | zero novel, zero mutations, calls ≥ 8    |
| One 10-minute build                          | not stagnant | `calls` = 1, below the floor             |
| Research reading many distinct files         | not stagnant | every fingerprint novel                  |
| Editing one file 8× with different content   | not stagnant | mutations > 0 — see the known blind spot |
| Short transcript, no prior calls in the tail | not stagnant | everything novel → conservative          |

**Known blind spot (deliberate):** semantic repetition — a session trying eight _different_
wrong fixes — registers as movement, because every `Edit` mutates. Detecting that needs a
judgement call about correctness, not a target comparison; it is what an LLM judge would
buy, and it is explicitly out of scope (see _Rejected alternatives_).

### Wiring

`deriveTranscriptTruth()` (`transcript-truth.ts:377`) gains a `stagnation:
StagnationVerdict` field on `TranscriptTruth` (`:364`). Both existing callers
(`claude-reader.ts:624`, `claude-watcher.ts:423`) pick it up with no signature change.

## Spec — the surface (T176)

1. **Plumb** `stagnation` from `TranscriptTruth` through `claude-reader.ts` /
   `claude-watcher.ts` onto the session payload, then onto `Session` in
   `src/renderer/src/stores/sessions.ts`, following the exact path `awaySummary` takes
   (`claude-reader.ts:139-143,382-383,626,853-855` → `sessions.ts:166-169,3816-3849`).
2. **Classify**: in `fleet-state.ts`, `workingOrStuck()` returns `stuck` when the
   existing silence rule fires **or** `signals.stagnation?.stagnant === true`. Add
   `stagnation` to `FleetSignals` (`:55-110`). No new state member, no ring change.
3. **Render**: `FleetBoardCard.vue` line 2 (`v-if="line2"`, mono 11 px, truncated) takes
   a new precedence — stagnation reason, else the last PTY line. The pulse branch is
   deleted here (its removal elsewhere is T177). Copy, via i18n
   (`board.spinningOn`, both `en.json` and `pt-BR.json` in the same change):
   `en`: `"repeating {target} ×{count}"`.
4. **Evidence on focus**: `SessionPreview.vue` — where the operator has stopped to read,
   not scan — shows the tally behind the verdict: calls in the window, distinct targets,
   and the top target. Reuses the block the pulse vacates.

## Scope boundary — files

| File                                             | Change                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `src/main/stall-detect.ts`                       | **new** — fingerprints, fold, verdict (pure)                |
| `src/main/transcript-truth.ts`                   | `stagnation` on `TranscriptTruth` + `deriveTranscriptTruth` |
| `src/main/claude-reader.ts`, `claude-watcher.ts` | carry the field onto the session payload                    |
| `src/renderer/src/stores/sessions.ts`            | `Session.stagnation`                                        |
| `src/renderer/src/stores/fleet-state.ts`         | `FleetSignals.stagnation`; `workingOrStuck` OR-branch       |
| `src/renderer/src/components/FleetBoardCard.vue` | line-2 precedence                                           |
| `src/renderer/src/components/SessionPreview.vue` | tally block                                                 |
| `src/renderer/src/i18n/{en,pt-BR}.json`          | `board.spinningOn`, `preview.stallTally` — **both files**   |
| `CHANGELOG.md`                                   | one bullet under `### Added`                                |
| `docs/user/`                                     | the Fleet board page — what a red card now means            |

Explicitly **not** touched: `design.md` (no new token, ring, dot, or state — that is the
point of D4); `fleet-policy.ts` (hibernation, unrelated); `InboxRail.vue`; the board
verbs. No `docs/capy-features.md` update — nothing here is agent-facing (no MCP verb, no
ACK field, no grant semantics).

## Acceptance criteria

- [ ] A session running the **same failing command ≥ 8 times with no edits** is
      classified `stuck` while its transcript is still being written — i.e. while
      `modifiedMs` is advancing and the existing silence rule does **not** fire. This is
      the criterion that proves the gap is closed; demonstrate it explicitly.
- [ ] A session doing genuinely novel work at the same call volume is **not** flagged.
- [ ] A single long-running command is **not** flagged.
- [ ] The detector performs **no** process spawn, LLM call, or network request; it adds
      no timer and no persisted per-session state. State this in the PR body.
- [ ] Line 2 of a flagged card names the repeated target and its count.
- [ ] `en.json` and `pt-BR.json` are at key parity (`vue-tsc` gate).
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] `CHANGELOG.md` + `docs/user/` updated in the same PR.
- [ ] Verified **live** against a running instance with a genuinely wedged session — not
      read from the diff.

## TDD plan

The core is a pure function over fixture entries, so it is a strong TDD fit — unlike the
adjacent ring/styling work. Write `tests/stall-detect.test.ts` (vitest, `node` env,
alongside `tests/pulse-prompt.test.ts`) **first**. Build entries with a helper
`entry(name, input, tsMs)` emitting the real shape (`type: 'assistant'`,
`message.content[]` with a `tool_use` block, top-level ISO `timestamp`).

The first red, and the one that encodes the whole point of the feature:

```ts
it('flags a busy session repeating one command with no mutations', () => {
  const t0 = Date.parse('2026-07-22T12:00:00Z')
  const entries = [
    entry('Bash', { command: 'npm test' }, t0), // prior — establishes the target
    ...Array.from({ length: 10 }, (_, i) =>
      entry('Bash', { command: 'npm test' }, t0 + 60_000 + i * 10_000)
    )
  ]
  const v = deriveTranscriptTruth(entries).stagnation
  expect(v.stagnant).toBe(true)
  expect(v.topTarget).toBe('Bash: npm test')
  expect(v.topCount).toBe(10)
})
```

Then the negatives, each pinning one clause of the conjunction so a future loosening
fails loudly: novel targets → not stagnant; one `Edit` among the repeats → not stagnant;
fewer than `STAGNATION_MIN_CALLS` → not stagnant; empty array → not stagnant, no throw;
entries older than the window excluded from `calls`.

For T176, assert the classifier seam rather than pixels (the shape used by
`tests/fleet-board-card-width.test.ts`): a `FleetSignals` fixture with fresh
`modifiedMs` (silence rule would say `working`) plus `stagnation.stagnant = true`
resolves to `stuck`. That test fails today because the field does not exist, which is
the correct first red for the surface card.

## Rejected alternatives

**An LLM judge over the tool sequence (Haiku, every ~5 min, `working` sessions only).**
This would catch the blind spot in D3/the rule — semantic repetition. It was rejected on
reliability, not cost: at one spawn per session per five minutes it is in fact _cheaper_
than the pulse it would replace. The problem is the failure mode. A deterministic alarm
that misfires can be calibrated by tightening a threshold; a judge that misfires teaches
the operator to disregard the board, which destroys the credibility this whole change
exists to build. Revisit only once the deterministic signal is trusted, and then as an
opt-in layer on top of it — never as the primary.

**A seventh board state (`spinning`).** Rejected per D4: it multiplies visual contracts
to encode a distinction with no distinct operator action.

**Per-session git/diff progress (commits ahead, files changed).** A genuinely good
progress signal and a natural follow-up, but it does not exist today at session
granularity — `folder-git-status.ts:26` is **per folder**, and multiple sessions share a
folder, so attribution is real work rather than a by-product of this change. Out of
scope; worth its own card.

**Counting the task list (`TaskCreate` / `TaskUpdate`).** The most legible progress
signal there is (`3/7`), and the transcript does carry the blocks. Rejected for v1 on
correctness, not cost: the reader's 800-entry / 512 KB tail means early `TaskCreate`
blocks fall out of the window on any long session, so the denominator silently goes
wrong — and a confidently wrong `4/7` is worse than no counter. It needs either a
full-file scan at session open or a persisted fold; both are their own card.
