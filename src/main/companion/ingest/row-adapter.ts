/**
 * The row adapter (T455 spec §5.3 host-side, §5.5 rule 3, §7.3, §10.2), wave W2: the `row` family
 * in SHADOW. It ingests the mod's `session.row`, keeps the latest values in memory, and at each
 * main-loop `turn.completed` records one parity fact per group against what the legacy reader
 * shows. It applies nothing: no renderer channel, no fleet-model write, no hub event. Consumers of
 * the pushed facts are W3; with `row` = `active` the arbiter reports the family owned (ARB-3), and
 * still nothing here reads that answer.
 *
 * Rules that matter:
 *  - `session.row` is validated field by field (`wire-core.ts`). A malformed one is counted and
 *    dropped; the third in one binding revokes `sense.row` (the arbiter's sticky `revoked`), and
 *    legacy wins for the session from then on. Unknown fields are ignored, never counted.
 *  - Every field is a full value, so a lost or coalesced row costs nothing. A text field that is
 *    ABSENT keeps what the host had (the mod reloaded); `null` means none seen.
 *  - Texts never leave memory: nothing text-bearing is written, logged or put in the ledger; the
 *    diagnostics are counts. A binding's values die with its conversation (a rebound) or its end.
 *  - The comparison runs `MATCH_AFTER_MS` after the turn end (the `taskState` rule's +2 s side),
 *    so the reader has the CLI's trailing lines; the push it uses is the newest at that moment.
 */

import { dirname, join } from 'node:path'
import type { FeatureId, WireEvent } from '../contract'
import type { CompanionHostFacade } from '../host-core'
import type { Lineage } from '../identity-core'
import { familyMode } from '../mode'
import { MATCH_AFTER_MS } from '../parity-taskstate-rule'
import { registerFeaturePolicy } from '../feature-policy'
import type { DetailValue } from '../parity-core'
import type { BindingView } from '../session-table'
import { validateSessionRow, type SessionRowPayload } from '../wire-core'
import type { FirstRowFacts, RowLegacySource } from './row-legacy'
import {
  compareRowGroups,
  type RowBaseline,
  type RowCompareInput,
  type RowGroupRecord,
  type RowLegacyView
} from './row-parity-core'

/** Malformed `session.row`s in one binding before `sense.row` is revoked for it (§10.2). */
export const ROW_MALFORMED_REVOKE = 3
/** The push's tool-call window for the `tools` group (`stall-detect`'s 5 minutes). */
const TOOLS_WINDOW_MS = 5 * 60_000

const FEATURE: FeatureId = 'sense.row'
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

/**
 * `sense.row` is enabled while the `row` family is not `off` for the binding's folder (§5.3). An
 * outside session never gets it: it is not in the external profile's ceiling (Q3).
 */
export function registerRowFeaturePolicy(): void {
  registerFeaturePolicy(FEATURE, (b) => familyMode('row', b.cwd || null) !== 'off')
}

/** The latest values of one conversation, in memory only. */
export type RowSnapshot = Omit<SessionRowPayload, 'fold'>

export interface RowAdapterDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'markProven' | 'revokeProof' | 'registerEventTypes'>
  /** The validated transcript of the binding's current conversation (identity adapter). */
  transcriptPathOf(b: BindingView): string | null
  /** Where that conversation came from (identity adapter, from the PTY record). */
  lineageOf(b: BindingView): Lineage | null
  /** The legacy twin; null records no comparison (a host without a reader, tests). */
  legacy: RowLegacySource | null
  /** One `row` ledger fact. */
  recordFact(sid: string, k: string, d: Record<string, DetailValue>, ts?: number): void
  /** Runs `fn` after `ms`; default an unref'd `setTimeout`. Returns a cancel. */
  schedule?(fn: () => void, ms: number): () => void
  /** Epoch ms; default `Date.now()`. */
  now?(): number
}

export interface RowAdapterDiagnostics {
  conversations: number
  rows: number
  malformed: number
  revoked: number
  notEnabled: number
  /** Rows of a binding whose `sense.row` was revoked. */
  dropped: number
  comparisons: number
  noLegacy: number
}

export interface RowAdapter {
  /** The newest values for a live conversation (W3 reads them); null when none. */
  latest(sid: string): RowSnapshot | null
  diagnostics(): RowAdapterDiagnostics
  /** Resolves when every comparison in flight has been recorded (tests, quit). */
  idle(): Promise<void>
  dispose(): void
}

interface Conversation {
  sid: string
  view: BindingView
  row: RowSnapshot | null
  /** `{ at, tools, sub }` per received row, the last five minutes plus one older. */
  samples: { at: number; tools: number; sub: number }[]
  /** Undefined until the transcript path is known; then the frozen baseline (§6.2). */
  baseline: Promise<RowBaseline | null> | undefined
  /** Undefined until a first-prompt divergence asked for it. */
  firstRow: Promise<FirstRowFacts | null> | undefined
  cancels: Set<() => void>
}

export function createRowAdapter(deps: RowAdapterDeps): RowAdapter {
  const now = deps.now ?? ((): number => Date.now())
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
  /** Per binding (the table's ordinal follows a re-key, never a sid). */
  const convs = new Map<number, Conversation>()
  const malformed = new Map<number, number>()
  const revoked = new Set<number>()
  const inFlight = new Set<Promise<void>>()
  const stats = { rows: 0, malformed: 0, notEnabled: 0, dropped: 0, comparisons: 0, noLegacy: 0 }

  registerRowFeaturePolicy()
  // `turn.completed` is also the task-state adapter's; registering a known type again is a no-op
  deps.host.registerEventTypes(['session.row', 'turn.completed'])

  function drop(key: number): void {
    const c = convs.get(key)
    if (!c) return
    for (const cancel of c.cancels) cancel()
    convs.delete(key)
  }

  /** The binding's current conversation; a new sid (a rebound) starts a fresh one. */
  function conversation(b: BindingView): Conversation {
    let c = convs.get(b.key)
    if (c && c.sid !== b.sid) {
      drop(b.key)
      c = undefined
    }
    if (!c) {
      c = {
        sid: b.sid,
        view: b,
        row: null,
        samples: [],
        baseline: undefined,
        firstRow: undefined,
        cancels: new Set()
      }
      convs.set(b.key, c)
    }
    c.view = b
    return c
  }

  /**
   * Freezes the cold baseline the first time the transcript path is known (§6.2): the reader's
   * view of the history this process loaded. A resume's is its own file minus the rows this
   * process already pushed; a fork's is its source's file; a new conversation has none.
   */
  function ensureBaseline(c: Conversation): void {
    if (c.baseline !== undefined || deps.legacy === null) return
    const path = deps.transcriptPathOf(c.view)
    if (path === null) return
    const lineage = deps.lineageOf(c.view)
    if (lineage === null || lineage.kind === 'new' || lineage.from === null) {
      c.baseline = Promise.resolve(null)
      return
    }
    let source = path
    let pushed = c.row?.userRows ?? 0
    if (lineage.kind === 'fork') {
      if (!SID_RE.test(lineage.from)) {
        c.baseline = Promise.resolve(null)
        return
      }
      source = join(dirname(path), `${lineage.from}.jsonl`)
      pushed = 0 // the source file is not this process's
    }
    const legacy = deps.legacy
    c.baseline = legacy.header(source).then((h) =>
      h
        ? {
            firstPrompt: h.firstPrompt,
            lastPrompt: h.lastPrompt,
            userMessageCount: Math.max(0, h.userMessageCount - pushed)
          }
        : null
    )
  }

  function onRow(b: BindingView, d: unknown): void {
    if (!b.enabled.includes(FEATURE)) {
      stats.notEnabled++
      return
    }
    if (revoked.has(b.key)) {
      stats.dropped++
      return
    }
    const v = validateSessionRow(d)
    if (!v.ok) {
      stats.malformed++
      const n = (malformed.get(b.key) ?? 0) + 1
      malformed.set(b.key, n)
      if (n >= ROW_MALFORMED_REVOKE) {
        revoked.add(b.key)
        drop(b.key)
        deps.host.revokeProof(b, FEATURE) // the arbiter makes `row` sticky-legacy for the binding
      }
      return
    }
    // proof first: the row that proves the feature may itself be recorded (arbiter contract)
    if (!b.proven.includes(FEATURE)) deps.host.markProven(b, FEATURE)
    const c = conversation(b)
    const { fold: _fold, ...fields } = v.value
    const prev = c.row
    const next: RowSnapshot = { ...fields }
    const at = now()
    // an ABSENT text keeps what the host had (the mod reloaded and lost its texts)
    for (const k of ['firstPrompt', 'lastPrompt', 'lastAssistant', 'title'] as const) {
      if (!(k in fields) && prev && k in prev) next[k] = prev[k]
    }
    c.row = next
    stats.rows++
    c.samples.push({ at, tools: next.toolCalls, sub: next.subagentToolCalls })
    const cut = at - TOOLS_WINDOW_MS
    while (c.samples.length > 1 && (c.samples[1]?.at ?? Infinity) <= cut) c.samples.shift()
    ensureBaseline(c)
  }

  /** Calls in the last five minutes from the pushed samples (§7.3). */
  function window5m(c: Conversation, at: number): { tools: number | null; sub: number } {
    const last = c.samples.at(-1)
    if (!last) return { tools: null, sub: 0 }
    const older = [...c.samples].reverse().find((s) => s.at <= at - TOOLS_WINDOW_MS)
    return { tools: last.tools - (older?.tools ?? 0), sub: last.sub - (older?.sub ?? 0) }
  }

  function record(sid: string, out: RowGroupRecord[], ts: number): void {
    for (const r of out) {
      deps.recordFact(
        sid,
        `group:${r.group}`,
        {
          group: r.group,
          verdict: r.verdict,
          cls: r.cls,
          lenPush: r.lenPush,
          lenLegacy: r.lenLegacy
        },
        ts
      )
    }
  }

  async function compare(c: Conversation, reason: string, ts: number): Promise<void> {
    const row = c.row
    if (!row) return
    const at = now()
    const w = window5m(c, at)
    const push: RowCompareInput['push'] = {
      ...(row.firstPrompt !== undefined ? { firstPrompt: row.firstPrompt } : {}),
      ...(row.lastPrompt !== undefined ? { lastPrompt: row.lastPrompt } : {}),
      ...(row.lastAssistant !== undefined ? { lastAssistant: row.lastAssistant } : {}),
      ...(row.title !== undefined ? { title: row.title } : {}),
      userRows: row.userRows,
      lastRowAt: row.lastRowAt,
      lastUuid: row.lastUuid,
      toolCalls5m: w.tools,
      subagentToolCalls5m: w.sub
    }
    const base = { push, headless: c.view.profile === 'headless', turnReason: reason }
    const path = deps.transcriptPathOf(c.view)
    const legacySrc = deps.legacy
    if (path === null || legacySrc === null) {
      stats.noLegacy++
      record(c.sid, compareRowGroups({ ...base, baseline: null, legacy: null }), ts)
      return
    }
    ensureBaseline(c)
    const [header, tail, baseline] = await Promise.all([
      legacySrc.header(path),
      legacySrc.tail(path, row.lastUuid),
      c.baseline ?? Promise.resolve(null)
    ])
    if (!header || !tail) {
      stats.noLegacy++
      record(c.sid, compareRowGroups({ ...base, baseline, legacy: null }), ts)
      return
    }
    const view: RowLegacyView = { ...header, ...tail, firstRow: null }
    let out = compareRowGroups({ ...base, baseline, legacy: view })
    // the first-prompt classes need the head's first row: read once per conversation, on demand
    if (out[0]?.cls.includes('first:')) {
      c.firstRow ??= legacySrc.firstRow(path)
      view.firstRow = await c.firstRow
      out = compareRowGroups({ ...base, baseline, legacy: view })
    }
    stats.comparisons++
    record(c.sid, out, ts)
  }

  function onTurnCompleted(b: BindingView, ev: WireEvent): void {
    if (ev.agentId !== undefined) return // a subagent's turn: the main loop's row did not end
    const c = convs.get(b.key)
    if (!c || c.sid !== b.sid || !c.row || revoked.has(b.key)) return
    c.view = b
    const d = (typeof ev.d === 'object' && ev.d !== null ? ev.d : {}) as Record<string, unknown>
    const reason = typeof d.reason === 'string' ? d.reason : 'answer'
    const cancel = schedule(() => {
      c.cancels.delete(cancel)
      const p = compare(c, reason, ev.ts)
        .catch(() => undefined) // a comparison is evidence, never a dependency
        .finally(() => inFlight.delete(p))
      inFlight.add(p)
    }, MATCH_AFTER_MS)
    c.cancels.add(cancel)
  }

  function onEvent(b: BindingView, ev: WireEvent): void {
    // a `bye` ends the binding before it delivers its events: `session.end` still drops the values
    if (ev.t === 'session.end') {
      drop(b.key)
      return
    }
    if (b.state !== 'bound') return
    switch (ev.t) {
      case 'session.row':
        onRow(b, ev.d)
        return
      case 'turn.completed':
        onTurnCompleted(b, ev)
        return
      case 'session.rebound':
        drop(b.key) // a new conversation: its rows start again under the new sid
        return
      case 'session.snapshot': {
        const c = convs.get(b.key)
        if (c && c.sid === b.sid) {
          c.view = b
          ensureBaseline(c)
        }
        return
      }
    }
  }

  const offs = [
    deps.host.bus.on('event', (b, ev) => {
      try {
        onEvent(b, ev)
      } catch {
        // an adapter fault reads as "the mod said nothing": legacy keeps driving
      }
    }),
    deps.host.bus.on('end', (b) => drop(b.key))
  ]

  return {
    latest(sid) {
      for (const c of convs.values()) if (c.sid === sid && c.row) return { ...c.row }
      return null
    },
    diagnostics: () => ({
      conversations: convs.size,
      revoked: revoked.size,
      ...stats
    }),
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    dispose() {
      for (const off of offs) off()
      for (const key of [...convs.keys()]) drop(key)
    }
  }
}
