/**
 * Who a session belongs to (BUG-300): only a session whose transcript holds an operator entry is
 * worth a judge call. Sessions Claude or Harnu created to orchestrate work (dispatched
 * executors, verifiers, ticks, the judge's own runs) never carry one until the operator types
 * in them, and a card about such a session is a question nobody at the keyboard can answer.
 *
 * "An operator entry" is exactly what `segment.ts` tags `OPERATOR`: `origin.kind === 'human'`
 * that is not a `[Harnu ·` injection. The check is on the whole transcript, not the segment
 * since the cursor: the operator's one message may be many turns old.
 *
 * The answer is remembered. A yes is final. A no remembers how far the file was scanned, so the
 * next ask reads only what was appended since: an agent session with a long transcript is read
 * once, not once per Stop. Memory only: after a restart the first ask scans from the top, and an
 * operator session answers at its first lines.
 */

import { createReadStream, promises as fs } from 'node:fs'
import { buildSegment, hasOperatorEntry } from './segment'
import type { YourMoveStore } from './store'

export interface OperatorGate {
  /** Does the transcript at `path` hold at least one operator entry? */
  has(sessionId: string, path: string): Promise<boolean>
}

/** Remembered sessions (yes and no, each): the oldest go first. */
const MAX_REMEMBERED = 5_000
const NEWLINE = 0x0a

interface Scan {
  found: boolean
  /** Byte offset just past the last whole line looked at. */
  scannedTo: number
  size: number
}

/** A cheap pre-filter: only a line that says `human` can be an operator entry. */
const HUMAN = Buffer.from('human')

function isOperatorLine(line: Buffer): boolean {
  if (line.indexOf(HUMAN) === -1) return false
  try {
    const v: unknown = JSON.parse(line.toString('utf8'))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    return hasOperatorEntry(buildSegment([v as Record<string, unknown>]))
  } catch {
    return false // a malformed line is skipped, as the reader skips it
  }
}

/** Scan whole lines from `from`, stopping at the first operator entry. */
async function scanFrom(path: string, from: number): Promise<Scan> {
  let size: number
  try {
    size = (await fs.stat(path)).size
  } catch {
    return { found: false, scannedTo: 0, size: 0 }
  }
  let offset = from
  let carry: Buffer = Buffer.alloc(0)
  const stream = createReadStream(path, { start: from })
  try {
    for await (const chunk of stream) {
      const buf = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer])
      let start = 0
      for (let nl = buf.indexOf(NEWLINE, start); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
        if (isOperatorLine(buf.subarray(start, nl))) {
          return { found: true, scannedTo: offset + (nl + 1 - start), size }
        }
        offset += nl + 1 - start
        start = nl + 1
      }
      carry = buf.subarray(start)
    }
  } finally {
    stream.destroy()
  }
  return { found: false, scannedTo: offset, size }
}

export function createOperatorGate(): OperatorGate {
  /** Sessions known to hold an operator entry. */
  const yes = new Set<string>()
  /** id → how far the transcript was scanned without finding one. */
  const no = new Map<string, number>()
  /** One scan per session at a time: a burst of hooks shares it. */
  const running = new Map<string, Promise<boolean>>()

  const remember = <V>(map: Map<string, V>, id: string, value: V): void => {
    map.delete(id)
    map.set(id, value)
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string)
  }

  async function check(sessionId: string, path: string): Promise<boolean> {
    const from = no.get(sessionId) ?? 0
    let scan: Scan
    try {
      scan = await scanFrom(path, from)
      if (scan.size < from) {
        // a rewritten file: what was said before is not there any more
        scan = await scanFrom(path, 0)
      }
    } catch (e) {
      // Unreadable now: not eligible now, nothing remembered, asked again at the next trigger.
      console.error(`[your-move] operator check failed for ${sessionId}: ${(e as Error).message}`)
      return false
    }
    if (scan.found) {
      no.delete(sessionId)
      yes.add(sessionId)
      if (yes.size > MAX_REMEMBERED) yes.delete(yes.values().next().value as string)
      return true
    }
    remember(no, sessionId, scan.scannedTo)
    return false
  }

  return {
    has(sessionId, path) {
      if (yes.has(sessionId)) return Promise.resolve(true)
      const live = running.get(sessionId)
      if (live) return live
      const run = check(sessionId, path).finally(() => running.delete(sessionId))
      running.set(sessionId, run)
      return run
    }
  }
}

export interface CleanupDeps {
  store: YourMoveStore
  gate: OperatorGate
  locate(sessionId: string): Promise<string | null>
  now(): number
}

/**
 * Closes the open judge cards of sessions the operator never typed in, through the store's own
 * `transact`: the queue drops to operator sessions only. A session with no transcript on disk
 * has no operator entry. Death, mission and human-gate cards point at items the operator owns
 * and are left alone; a verb card is an agent handing the ball over on purpose.
 */
export async function closeIneligibleCards(deps: CleanupDeps): Promise<number> {
  const ids = new Set<string>()
  for (const c of deps.store.state().cards) {
    if (c.closedAt === undefined && (c.source === 'judge' || c.source === 'judge-failure')) {
      ids.add(c.sessionId)
    }
  }
  const ineligible: string[] = []
  for (const id of ids) {
    try {
      const path = await deps.locate(id)
      if (path === null || !(await deps.gate.has(id, path))) ineligible.push(id)
    } catch {
      /* could not tell: the card stays (a false alarm beats a lost question) */
    }
  }
  if (ineligible.length === 0) return 0
  const set = new Set(ineligible)
  return deps.store.transact((s) => {
    const now = deps.now()
    let closed = 0
    const cards = s.cards.map((c) => {
      if (
        c.closedAt !== undefined ||
        !set.has(c.sessionId) ||
        (c.source !== 'judge' && c.source !== 'judge-failure')
      ) {
        return c
      }
      closed++
      return { ...c, closedAt: now, closedBy: 'source-resolved' as const }
    })
    return { next: closed > 0 ? { ...s, cards } : s, result: closed }
  })
}
