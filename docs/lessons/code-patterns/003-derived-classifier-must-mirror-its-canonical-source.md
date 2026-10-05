# 003-derived-classifier-must-mirror-its-canonical-source: a second projection of the same state must replicate the source classifier's precedence exactly

**Category:** code-patterns (duplicated classification logic)
**Discovered in:** Fleet board "live sessions show idle" investigation (Jun 2026, read-only analysis)
**Status:** active

## The bug

Live, actively-running Claude sessions showed the green **"running"** dot in the
folder view but landed in the **IDLE** bucket on the Fleet status board — with
occasional brief spikes to Working that fell straight back to Idle. Same store,
same session, two different answers. The board never reflected "this session is
alive" the way the sidebar dot did.

## Root cause

The board's `classifyBoardState` (`src/renderer/src/components/fleet-board.ts`)
was written to "mirror `dotFor`" (`src/renderer/src/components/session-dot.ts`)
but **paraphrased its precedence instead of replicating it**. `dotFor` applies
the activity heuristic to _every_ non-sticky taskState:

```ts
// dotFor — canonical
if (taskState === 'needs-input') return 'needs-input'
if (taskState === 'failed') return 'failed'
if (taskState === 'completed') return 'completed'
if (status === 'active') return 'working' // working/idle/stopped/UNDEFINED all reach here
return 'idle'
```

The board added a guard the source never had:

```ts
// classifyBoardState — diverged
if (taskState === 'working') return 'working'
if (taskState === undefined && status === 'active') return 'working' // ← only when undefined!
return 'idle'
```

A live session between turns rests at `taskState === 'idle'` (the `Stop` hook
sets it — `hook-state.ts`) while `status === 'active'` (PTY appended within the
5 s `ACTIVE_TO_IDLE_MS` window). `dotFor` → working (green). The board, because
`taskState` is `'idle'` and not `undefined`, skipped the activity heuristic →
idle. The "spike" was only the narrow window where a hook had set
`taskState === 'working'`.

## The fix (and why)

The derived classifier must apply the activity heuristic to the same set of
states the source does — drop the `=== undefined` guard so `status === 'active'`
wins for `working | idle | stopped | undefined` alike (sticky states still win
first). Better still: extract one shared classifier both surfaces call, so they
_cannot_ drift.

## How to detect in reviews

1. Any new function that claims (in code or comment) to "mirror"/"match" another
   classifier — **diff the branch order and conditions line-by-line**, not the
   intent. A paraphrase that adds/removes one guard is a silent divergence.
2. Two functions mapping the same domain state to a display state are a smell:
   prefer one canonical function with a thin adapter over two hand-kept copies.
3. When a view shows a different status than another view for the _same_ record,
   suspect classifier divergence before suspecting data/reactivity.

## Related

- `src/renderer/src/components/fleet-board.ts` (`classifyBoardState`)
- `src/renderer/src/components/session-dot.ts` (`dotFor` — the canonical source)
- `src/main/hook-state.ts` (`reduceTaskState`: `Stop` → `'idle'`), `src/renderer/src/stores/sessions.ts` (`ACTIVE_TO_IDLE_MS`, `status='active'`)
- `testing/003-assert-expected-from-requirement-not-implementation` — the test that codified this bug
