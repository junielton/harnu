/**
 * T455 W0, A-S1: does the retained 256-call list of spec §6.7 reproduce the reader's window
 * verdict (`stagnant`, `calls`, `distinct`)?
 *
 * For each transcript, every line is replayed in order. At each cut point (the end of a
 * `system/turn_duration` line, the end of an assistant line holding a `tool_use`, and EOF):
 *
 * - reader: the real reader's incremental fold up to that byte (`__scrapeHeaderWithStatForTests`
 *   with a stat whose `size` is the cut), i.e. what a slug pass at that instant would derive;
 * - retained: the spec's list. Every `tool_use` seen so far, capped at 256 (oldest dropped),
 *   scored by the real `deriveStagnation` over synthetic entries that carry exactly those calls
 *   plus an anchor at the last-entry timestamp. Two readings of "the timestamp of the last entry":
 *     v1: the newest entry that has a timestamp;
 *     v2: the newest non-noise entry, and a zero verdict when it has none (what the reader does).
 *
 * Prints aggregates only. Usage (from the repo root):
 *   npx esbuild <this file> --bundle --platform=node --format=cjs --outfile=/tmp/s1.cjs
 *   node /tmp/s1.cjs <file-with-one-transcript-path-per-line>
 */
import { readFileSync, statSync, type Stats } from 'node:fs'
import {
  __resetHeaderCacheForTests,
  __scrapeHeaderWithStatForTests
} from '../../../../src/main/claude-reader'
import { deriveStagnation, type StagnationVerdict } from '../../../../src/main/stall-detect'
import { isNoiseEntry } from '../../../../src/main/transcript-truth'

const CAP = 256
const TWO_MIB = 2 * 1024 * 1024
/** The reader's own tail rule (claude-reader.ts): below the 2 MiB head cap, the last 800 non-noise
 *  entries; once a line crosses the cap, the entries whose line starts in the last 512 KB. */
const MAX_SCAN_BYTES = TWO_MIB
const TAIL_RING_MAX = 800
const TAIL_WINDOW_BYTES = 512 * 1024

interface Call {
  name: string
  input: Record<string, unknown>
  ts: number
  /** Byte offset of the line, and ordinal among non-noise entries (for the windowed variant). */
  off: number
  idx: number
}

type Cut = 'turn' | 'tool' | 'eof'

function verdictOf(calls: Call[], lastTs: number): StagnationVerdict {
  const entries: Record<string, unknown>[] = calls.map((c) => ({
    type: 'assistant',
    timestamp: new Date(c.ts).toISOString(),
    message: { content: [{ type: 'tool_use', name: c.name, input: c.input }] }
  }))
  entries.push({ type: 'anchor', timestamp: new Date(lastTs).toISOString() })
  return deriveStagnation(entries)
}

const ZERO: StagnationVerdict = {
  stagnant: false,
  calls: 0,
  distinct: 0,
  topTarget: '',
  topCount: 0
}

function same(a: StagnationVerdict, b: StagnationVerdict): boolean {
  return a.stagnant === b.stagnant && a.calls === b.calls && a.distinct === b.distinct
}

interface Tally {
  cuts: number
  readerStagnant: number
  mismatchV1: number
  mismatchV2: number
  v1Field: Record<string, number>
  v2Field: Record<string, number>
  readerZeroByTimestamplessTail: number
  filesWithMismatchV2: Set<string>
  /** v2 mismatches by direction: which side counts more in-window calls / says stagnant. */
  v2RetainedMoreCalls: number
  v2ReaderMoreCalls: number
  v2StagnantRetainedOnly: number
  v2StagnantReaderOnly: number
  /** Mismatches of an uncapped list (every call so far), v2 timestamp: isolates the cap. */
  mismatchUncapped: number
  /** Mismatches of the amendment: v2 timestamp, calls filtered by the reader's window rule. */
  mismatchWindowed: number
  maxWindowedCalls: number
}

function newTally(): Tally {
  return {
    cuts: 0,
    readerStagnant: 0,
    mismatchV1: 0,
    mismatchV2: 0,
    v1Field: {},
    v2Field: {},
    readerZeroByTimestamplessTail: 0,
    filesWithMismatchV2: new Set(),
    v2RetainedMoreCalls: 0,
    v2ReaderMoreCalls: 0,
    v2StagnantRetainedOnly: 0,
    v2StagnantReaderOnly: 0,
    mismatchUncapped: 0,
    mismatchWindowed: 0,
    maxWindowedCalls: 0
  }
}

function bump(rec: Record<string, number>, a: StagnationVerdict, b: StagnationVerdict): void {
  for (const k of ['stagnant', 'calls', 'distinct'] as const) {
    if (a[k] !== b[k]) rec[k] = (rec[k] ?? 0) + 1
  }
}

async function main(): Promise<void> {
  const paths = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
  const tallies: Record<Cut, Tally> = { turn: newTally(), tool: newTally(), eof: newTally() }
  const bigTallies: Record<Cut, Tally> = { turn: newTally(), tool: newTally(), eof: newTally() }
  let files = 0
  let bigFiles = 0
  let maxRetained = 0
  let filesOverCap = 0
  const sizes: number[] = []
  for (const path of paths) {
    let buf: Buffer
    let st: Stats
    try {
      buf = readFileSync(path)
      st = statSync(path)
    } catch {
      continue
    }
    files++
    sizes.push(buf.length)
    const big = buf.length > TWO_MIB
    if (big) bigFiles++
    __resetHeaderCacheForTests()
    const calls: Call[] = []
    const allCalls: Call[] = []
    let seen = 0
    let lastTsV1 = NaN
    let lastTsV2 = NaN
    let nonNoise = 0
    let hitCap = false
    let start = 0
    let nl = buf.indexOf(0x0a, start)
    while (nl !== -1) {
      const end = nl + 1
      const lineOff = start
      let obj: Record<string, unknown> | null = null
      try {
        const o = JSON.parse(buf.toString('utf8', start, nl))
        if (o && typeof o === 'object') obj = o as Record<string, unknown>
      } catch {
        obj = null
      }
      start = end
      nl = buf.indexOf(0x0a, start)
      if (!obj) continue
      if (!hitCap && end >= MAX_SCAN_BYTES) hitCap = true
      const idx = isNoiseEntry(obj) ? -1 : nonNoise++
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
      if (!Number.isNaN(ts)) lastTsV1 = ts
      if (!isNoiseEntry(obj)) lastTsV2 = ts
      let cut: Cut | null = null
      if (obj.type === 'system' && obj.subtype === 'turn_duration') cut = 'turn'
      if (obj.type === 'assistant' && !Number.isNaN(ts)) {
        const content = (obj.message as Record<string, unknown> | undefined)?.content
        if (Array.isArray(content)) {
          for (const b of content as Record<string, unknown>[]) {
            if (b && b.type === 'tool_use' && typeof b.name === 'string') {
              const input =
                b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
              calls.push({ name: b.name, input, ts, off: lineOff, idx })
              allCalls.push({ name: b.name, input, ts, off: lineOff, idx })
              seen++
              if (calls.length > CAP) calls.shift()
              cut = 'tool'
            }
          }
        }
      }
      if (nl === -1) cut = 'eof'
      if (!cut) continue
      maxRetained = Math.max(maxRetained, calls.length)
      const fake = { ...st, size: end, mtimeMs: end } as Stats
      const header = await __scrapeHeaderWithStatForTests(path, fake)
      const reader = header?.stagnation ?? ZERO
      const v1 = Number.isNaN(lastTsV1) || calls.length === 0 ? ZERO : verdictOf(calls, lastTsV1)
      const v2 = Number.isNaN(lastTsV2) || calls.length === 0 ? ZERO : verdictOf(calls, lastTsV2)
      const windowed = allCalls.filter((c) =>
        hitCap ? c.off > end - TAIL_WINDOW_BYTES : c.idx >= nonNoise - TAIL_RING_MAX
      )
      const vWin =
        Number.isNaN(lastTsV2) || windowed.length === 0 ? ZERO : verdictOf(windowed, lastTsV2)
      const vAll =
        Number.isNaN(lastTsV2) || allCalls.length === 0 ? ZERO : verdictOf(allCalls, lastTsV2)
      for (const t of big ? [tallies[cut], bigTallies[cut]] : [tallies[cut]]) {
        t.cuts++
        if (reader.stagnant) t.readerStagnant++
        if (Number.isNaN(lastTsV2) && !Number.isNaN(lastTsV1)) t.readerZeroByTimestamplessTail++
        if (!same(reader, v1)) {
          t.mismatchV1++
          bump(t.v1Field, reader, v1)
        }
        if (!same(reader, v2)) {
          t.mismatchV2++
          bump(t.v2Field, reader, v2)
          t.filesWithMismatchV2.add(path)
          if (v2.calls > reader.calls) t.v2RetainedMoreCalls++
          if (v2.calls < reader.calls) t.v2ReaderMoreCalls++
          if (v2.stagnant && !reader.stagnant) t.v2StagnantRetainedOnly++
          if (!v2.stagnant && reader.stagnant) t.v2StagnantReaderOnly++
        }
        if (!same(reader, vAll)) t.mismatchUncapped++
        if (!same(reader, vWin)) t.mismatchWindowed++
        t.maxWindowedCalls = Math.max(t.maxWindowedCalls, windowed.length)
      }
    }
    if (seen > CAP) filesOverCap++
  }
  sizes.sort((a, b) => a - b)
  const q = (f: number): number => sizes[Math.min(sizes.length - 1, Math.floor(f * sizes.length))]
  const show = (t: Record<Cut, Tally>): unknown =>
    Object.fromEntries(
      Object.entries(t).map(([k, v]) => [
        k,
        {
          cuts: v.cuts,
          readerStagnant: v.readerStagnant,
          mismatchV1: v.mismatchV1,
          mismatchV1Pct: v.cuts ? +((100 * v.mismatchV1) / v.cuts).toFixed(2) : null,
          v1Field: v.v1Field,
          mismatchV2: v.mismatchV2,
          mismatchV2Pct: v.cuts ? +((100 * v.mismatchV2) / v.cuts).toFixed(2) : null,
          v2Field: v.v2Field,
          cutsWhereNewestEntryHasNoTimestamp: v.readerZeroByTimestamplessTail,
          filesWithAnyV2Mismatch: v.filesWithMismatchV2.size,
          v2RetainedMoreCalls: v.v2RetainedMoreCalls,
          v2ReaderMoreCalls: v.v2ReaderMoreCalls,
          v2StagnantRetainedOnly: v.v2StagnantRetainedOnly,
          v2StagnantReaderOnly: v.v2StagnantReaderOnly,
          mismatchUncapped: v.mismatchUncapped,
          mismatchWindowed: v.mismatchWindowed,
          maxWindowedCalls: v.maxWindowedCalls
        }
      ])
    )
  console.log(
    JSON.stringify(
      {
        files,
        filesOver2MiB: bigFiles,
        filesWithMoreThan256Calls: filesOverCap,
        maxRetained,
        sizeBytes: { p50: q(0.5), p90: q(0.9), max: sizes[sizes.length - 1] },
        all: show(tallies),
        over2MiB: show(bigTallies)
      },
      null,
      1
    )
  )
}

void main()
