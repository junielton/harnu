/**
 * The `taskState` parity rule (T389 P1W5 §13), hosted here; the ledger framework is
 * `parity-core.ts`. Pure.
 *
 * Input: one session's ledger rows. The adapter records each state TRANSITION of the two shadow
 * folds as `state:<s>` with `source` `legacy` or `companion` (`d.ev` is the hook event that
 * caused it, `d.m` its matcher), and a `hold:subagent` row when the companion holds a finished
 * turn for a running subagent. The hub's own `event:*` rows are not read.
 *
 * Per session the rule collapses repeats, then matches each LEGACY transition to a companion one
 * to the same state inside `[t - 10 000 ms, t + 2 000 ms]` (the legacy path is late: the bridge
 * adds about 3.5 s per tool call and `permission_prompt` arrives about 6 s after the request,
 * smoke A4). What is left is classified:
 *
 *   E1  companion `idle` after an aborted or declined turn; legacy has no stop edge
 *   E2  companion `working` held for a subagent while legacy is `idle`
 *   E3  a companion `needs-input`/`working` pair shorter than the window that legacy never saw
 *   E4  transitions before the family was proven for the session
 *   E5  legacy `idle` from `idle_prompt` when the companion was already `idle`
 *
 * Everything else is unexplained and fails the gate: a legacy `working` or `needs-input` with no
 * companion match, a legacy `Stop`-derived `idle` with no companion `idle` ("lost Stop"), a
 * `completed` mismatch, an order inversion, and a companion-only edge no class covers.
 */

import { registerParityRule, type Divergence, type ParityRecord } from './parity-core'

/** A companion transition may come up to this long before the legacy one it matches. */
export const MATCH_BEFORE_MS = 10_000
/** ... and at most this long after it. */
export const MATCH_AFTER_MS = 2_000

/** The gate to flip `taskState` to `active` (spec §13); the corpus mix is checked by hand from the export. */
export const TASK_STATE_GATE = { minSessions: 200, minFacts: 5000 } as const

interface Transition {
  state: string
  at: number
  ev: string | null
  m: string | null
  used: boolean
}

const at = (r: ParityRecord): number => r.ts ?? r.t

function transitions(rows: readonly ParityRecord[], source: 'legacy' | 'companion'): Transition[] {
  const out: Transition[] = []
  for (const r of rows) {
    if (r.source !== source || !r.k.startsWith('state:')) continue
    const state = r.k.slice('state:'.length)
    if (out.at(-1)?.state === state) continue // collapse repeats
    out.push({
      state,
      at: at(r),
      ev: typeof r.d?.ev === 'string' ? r.d.ev : null,
      m: typeof r.d?.m === 'string' ? r.d.m : null,
      used: false
    })
  }
  return out
}

export function compareTaskStateRows(rows: ParityRecord[]): Divergence[] {
  const sk = rows[0]?.sk ?? ''
  const legacy = transitions(rows, 'legacy')
  const companion = transitions(rows, 'companion')
  const holds = rows.filter((r) => r.source === 'companion' && r.k === 'hold:subagent').map(at)
  const out: Divergence[] = []
  const add = (
    when: number,
    l: Transition | null,
    c: Transition | null,
    cls: string | null
  ): void => {
    out.push({ sk, at: when, legacy: l?.state ?? null, companion: c?.state ?? null, class: cls })
  }

  // ---- matching, in legacy order ------------------------------------------------------------
  let lastMatched = -1
  const unmatchedLegacy: Transition[] = []
  for (const l of legacy) {
    const fits = (c: Transition): boolean =>
      !c.used &&
      c.state === l.state &&
      c.at >= l.at - MATCH_BEFORE_MS &&
      c.at <= l.at + MATCH_AFTER_MS
    // prefer a match that keeps the two timelines in the same order; an earlier one is an inversion
    let j = companion.findIndex((c, i) => i > lastMatched && fits(c))
    if (j < 0) j = companion.findIndex(fits)
    if (j < 0) {
      unmatchedLegacy.push(l)
      continue
    }
    const c = companion[j] as Transition
    c.used = true
    l.used = true
    if (j < lastMatched) add(l.at, l, c, null) // the two sources disagree on the order
    lastMatched = Math.max(lastMatched, j)
  }

  // ---- legacy leftovers ---------------------------------------------------------------------
  const firstCompanion = companion[0]?.at ?? null
  const companionStateAt = (when: number): string | null => {
    let s: string | null = null
    for (const c of companion) if (c.at <= when) s = c.state
    return s
  }
  for (const l of unmatchedLegacy) {
    if (firstCompanion !== null && l.at < firstCompanion) {
      add(l.at, l, null, 'E4')
    } else if (
      l.state === 'idle' &&
      holds.some((h) => h >= l.at - MATCH_BEFORE_MS && h <= l.at + MATCH_AFTER_MS)
    ) {
      add(l.at, l, null, 'E2')
    } else if (
      l.state === 'idle' &&
      l.ev === 'Notification' &&
      l.m === 'idle_prompt' &&
      companionStateAt(l.at) === 'idle'
    ) {
      add(l.at, l, null, 'E5')
    } else {
      add(l.at, l, null, null) // working, needs-input, a lost Stop, a completed mismatch
    }
  }

  // ---- companion leftovers ------------------------------------------------------------------
  for (let i = 0; i < companion.length; i++) {
    const c = companion[i] as Transition
    if (c.used) continue
    c.used = true
    const next = companion[i + 1]
    if (c.state === 'idle') {
      add(c.at, null, c, 'E1')
    } else if (
      c.state === 'needs-input' &&
      next !== undefined &&
      next.state === 'working' &&
      next.at - c.at <= MATCH_BEFORE_MS
    ) {
      add(c.at, null, c, 'E3')
      if (!next.used) {
        next.used = true
        add(next.at, null, next, 'E3')
      }
    } else {
      add(c.at, null, c, null)
    }
  }
  return out
}

export function registerTaskStateParityRule(): void {
  registerParityRule({ stream: 'taskState', compare: compareTaskStateRows })
}
registerTaskStateParityRule()
