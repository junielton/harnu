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
 * One entry does not count (BUG-308): the launch prompt of a session Harnu spawned FOR AN AGENT
 * lands in the transcript as a human entry. Such a session needs a human entry after that first
 * one. A session whose origin is unknown keeps its first entry (recall over noise).
 *
 * The answer is remembered. A yes that rests on a second human message is final; one that rests
 * on the first alone is asked again, in case the origin is learned later. A scan remembers how
 * far it got, so the next ask reads only what was appended since: an agent session with a long transcript is read
 * once, not once per Stop. Memory only: after a restart the first ask scans from the top, and an
 * operator session answers at its first lines.
 */

import { createReadStream, promises as fs } from 'node:fs'
import type { TranscriptLookup } from './locate'
import { buildSegment, hasOperatorEntry } from './segment'
import type { YourMoveStore } from './store'

export interface OperatorGate {
  /** Does the transcript at `path` hold at least one operator entry? Unreadable counts as no. */
  has(sessionId: string, path: string): Promise<boolean>
  /** Like `has`, but tells a transcript read to the end with none (`no`) from one that could not be read. */
  status(sessionId: string, path: string): Promise<'yes' | 'no' | 'unknown'>
  /** When the operator last typed in the transcript; null when never, or it cannot be read. */
  lastReplyAt(path: string): Promise<number | null>
}

/** When an operator entry among `lines` was typed, newest first; null when none says. */
export function lastReplyIn(lines: readonly Record<string, unknown>[]): number | null {
  let last: number | null = null
  for (const line of lines) {
    if (!hasOperatorEntry(buildSegment([line]))) continue
    const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
    if (!Number.isNaN(at) && (last === null || at > last)) last = at
  }
  return last
}

/** Remembered sessions (yes and no, each): the oldest go first. */
const MAX_REMEMBERED = 5_000
const NEWLINE = 0x0a

/** What the scan of one transcript knows so far. */
interface Progress {
  /** Byte offset just past the last whole line looked at. */
  scannedTo: number
  /** The first human entry has been passed: it may be a launch prompt. */
  booted: boolean
  /** ...and it reads as the operator's (it is not a `[Harnu ·` injection). */
  bootIsOperator: boolean
}

interface Scan extends Progress {
  /** False when the file could not be opened or read: nothing is known. */
  ok: boolean
  /** An operator entry after the first human one: no launch prompt can explain it. */
  beyondBoot: boolean
  size: number
}

const NOTHING: Progress = { scannedTo: 0, booted: false, bootIsOperator: false }

/** A cheap pre-filter: only a line that says `human` can be an operator entry. */
const HUMAN = Buffer.from('human')

/** The line as a record, when it can be an operator entry at all. */
function humanRecord(line: Buffer): Record<string, unknown> | null {
  if (line.indexOf(HUMAN) === -1) return null
  try {
    const v: unknown = JSON.parse(line.toString('utf8'))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    return v as Record<string, unknown>
  } catch {
    return null // a malformed line is skipped, as the reader skips it
  }
}

/** What a transcript line is, as far as who typed it goes; null when no human entry. */
function humanLine(line: Buffer): { operator: boolean } | null {
  const record = humanRecord(line)
  if (!record) return null
  const entries = buildSegment([record])
  return entries.some((e) => e.from === 'human') ? { operator: hasOperatorEntry(entries) } : null
}

/** The whole lines of `path` from byte `from`, with the bytes each one takes in the file. */
async function* wholeLines(path: string, from: number): AsyncGenerator<[Buffer, number]> {
  let carry: Buffer = Buffer.alloc(0)
  const stream = createReadStream(path, { start: from })
  try {
    for await (const chunk of stream) {
      const buf = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer])
      let start = 0
      for (let nl = buf.indexOf(NEWLINE, start); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
        yield [buf.subarray(start, nl), nl + 1 - start]
        start = nl + 1
      }
      carry = buf.subarray(start)
    }
  } finally {
    stream.destroy()
  }
}

async function lastReplyAt(path: string): Promise<number | null> {
  let last: number | null = null
  try {
    for await (const [line] of wholeLines(path, 0)) {
      const record = humanRecord(line)
      const at = record ? lastReplyIn([record]) : null
      if (at !== null && (last === null || at > last)) last = at
    }
  } catch {
    return null // unreadable: nothing is known, so nothing is closed on it
  }
  return last
}

/** Scan whole lines from where `at` stopped, up to the first operator entry after the boot one. */
async function scanFrom(path: string, at: Progress): Promise<Scan> {
  const out: Scan = { ...at, ok: true, beyondBoot: false, size: 0 }
  try {
    out.size = (await fs.stat(path)).size
  } catch {
    return { ...out, ok: false }
  }
  for await (const [line, bytes] of wholeLines(path, at.scannedTo)) {
    const entry = humanLine(line)
    out.scannedTo += bytes
    if (!entry) continue
    if (!out.booted) {
      out.booted = true
      out.bootIsOperator = entry.operator
    } else if (entry.operator) {
      return { ...out, beyondBoot: true }
    }
  }
  return out
}

export function createOperatorGate(
  deps: {
    /** Whether Harnu spawned the session for an agent. Only a sure answer is `true`. */
    agentSpawned?(sessionId: string): Promise<boolean>
  } = {}
): OperatorGate {
  /** Sessions with a human message after their first one: nothing can change that. */
  const yes = new Set<string>()
  /** id → how far the others were scanned, and what their first human entry was. */
  const progress = new Map<string, Progress>()
  /** One scan per session at a time: a burst of hooks shares it. */
  const running = new Map<string, Promise<'yes' | 'no' | 'unknown'>>()

  const remember = <V>(map: Map<string, V>, id: string, value: V): void => {
    map.delete(id)
    map.set(id, value)
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string)
  }

  const isAgent = async (sessionId: string): Promise<boolean> => {
    try {
      return (await deps.agentSpawned?.(sessionId)) ?? false
    } catch {
      return false // unknown: the entry counts
    }
  }

  async function check(sessionId: string, path: string): Promise<'yes' | 'no' | 'unknown'> {
    const at = progress.get(sessionId) ?? NOTHING
    let scan: Scan
    try {
      scan = await scanFrom(path, at)
      if (scan.ok && scan.size < at.scannedTo) {
        // a rewritten file: what was said before is not there any more
        scan = await scanFrom(path, NOTHING)
      }
    } catch (e) {
      console.error(`[your-move] operator check failed for ${sessionId}: ${(e as Error).message}`)
      return 'unknown'
    }
    // Unreadable now: nothing remembered, asked again at the next trigger.
    if (!scan.ok) return 'unknown'
    if (scan.beyondBoot) {
      progress.delete(sessionId)
      yes.add(sessionId)
      if (yes.size > MAX_REMEMBERED) yes.delete(yes.values().next().value as string)
      return 'yes'
    }
    const { scannedTo, booted, bootIsOperator } = scan
    remember(progress, sessionId, { scannedTo, booted, bootIsOperator })
    if (!bootIsOperator) return 'no'
    return (await isAgent(sessionId)) ? 'no' : 'yes'
  }

  const status = (sessionId: string, path: string): Promise<'yes' | 'no' | 'unknown'> => {
    if (yes.has(sessionId)) return Promise.resolve('yes')
    const live = running.get(sessionId)
    if (live) return live
    const run = check(sessionId, path).finally(() => running.delete(sessionId))
    running.set(sessionId, run)
    return run
  }

  return {
    status,
    has: async (sessionId, path) => (await status(sessionId, path)) === 'yes',
    lastReplyAt
  }
}

export interface CleanupDeps {
  store: YourMoveStore
  gate: OperatorGate
  lookup(sessionId: string): Promise<TranscriptLookup>
  now(): number
}

/**
 * Closes the open judge cards of sessions the operator never typed in, through the store's own
 * `transact`: the queue drops to operator sessions only. A card closes only when the session's
 * transcript is known to be absent (the whole projects tree was listed) or was read to the end
 * with no operator entry. A lookup that failed, threw or could not read the file keeps the
 * card: a false alarm beats a lost question. Death, mission and human-gate cards point at
 * items the operator owns and are left alone; a verb card is an agent handing the ball over
 * on purpose.
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
      const found = await deps.lookup(id)
      if (found.state === 'missing') ineligible.push(id)
      else if (found.state === 'found' && (await deps.gate.status(id, found.path)) === 'no') {
        ineligible.push(id)
      }
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
