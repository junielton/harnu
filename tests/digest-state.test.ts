import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  CATCH_UP_LIMIT,
  DIGEST_STATE_TTL_MS,
  emptyDigestState,
  hasDigestFile,
  parseDigestState,
  pruneDigestState,
  selectCatchUp,
  serializeDigestState,
  type CatchUpCandidate,
  type DigestState
} from '../src/main/mcp/digest-state'
import { createDigestEngine, LONG_IDLE_MS } from '../src/main/mcp/digest-engine'
import { readTranscriptFacts } from '../src/main/mcp/digest-io'
import { emptyFacts, type TranscriptFacts } from '../src/main/mcp/digest-transcript'
import { deriveTranscriptTruth } from '../src/main/transcript-truth'
import { fixtureSession, transcriptLines } from './helpers/memory-u1-fixture'

/**
 * Memory U1 S-4: the digest engine's persisted state (spec "The persisted state") and the
 * catch-up selection (D-9).
 */

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const DAY = 86_400_000
const HEAD = 'b'.repeat(40)

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(os.tmpdir(), 'digest-state-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function facts(over: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return {
    ...emptyFacts(),
    userTurns: 4,
    firstAt: '2026-11-05T10:00:00.000Z',
    lastAt: '2026-11-05T11:00:00.000Z',
    ...over
  }
}

describe('digest state', () => {
  it('dedup and scan offset survive a reload', async () => {
    // Round trip.
    const state: DigestState = {
      version: 1,
      sessions: {
        s1: {
          lastDigestAt: NOW - DAY,
          last: { head: HEAD, userTurns: 7 },
          scan: { offset: 81_234, facts: facts({ openQuestions: ['Why?'], asked: [] }) }
        },
        s2: {
          lastDigestAt: NOW - 2 * DAY,
          last: { head: null, userTurns: 3 },
          scan: { offset: 10, facts: facts() }
        }
      }
    }
    const reread = parseDigestState(serializeDigestState(state), NOW)
    expect(reread.problem).toBeNull()
    expect(reread.state).toEqual(state)

    // After a reload, a session whose head and user-turn count match its record plans unchanged.
    const saved: DigestState[] = []
    const deps = {
      resolveSession: vi.fn(async (id: string) => ({
        transcriptPath: `/t/${id}.jsonl`,
        folder: '/repo'
      })),
      readFacts: vi.fn(async () => ({ facts: facts(), offset: 500 })),
      readTruth: vi.fn(async () => deriveTranscriptTruth([])),
      gatherGit: vi.fn(async () => ({
        kind: 'repo' as const,
        head: HEAD,
        commits: [],
        fileStats: [],
        dirtyCount: 0
      })),
      writeDigest: vi.fn(async () => ({ ok: true })),
      writeHot: vi.fn(async () => undefined),
      memoryCheckout: vi.fn(async (folder: string) => folder),
      saveState: vi.fn((s: DigestState) => {
        saved.push(JSON.parse(serializeDigestState(s)) as DigestState)
      }),
      now: () => NOW,
      setTimer: () => 0,
      clearTimer: () => undefined
    }
    const first = createDigestEngine(deps)
    await first.digestNow('s9', 'ended')
    first.close()
    expect(deps.writeDigest).toHaveBeenCalledTimes(1)
    expect(deps.saveState).toHaveBeenCalledTimes(1)
    expect(saved[0].sessions.s9).toEqual({
      lastDigestAt: NOW,
      last: { head: HEAD, userTurns: 4 },
      scan: { offset: 500, facts: facts() }
    })

    const loaded = parseDigestState(serializeDigestState(saved[0]), NOW + 60_000).state
    const second = createDigestEngine(deps, { state: loaded })
    await second.digestNow('s9', 'ended')
    second.close()
    expect(deps.writeDigest).toHaveBeenCalledTimes(1) // the second plans unchanged
    expect(deps.saveState).toHaveBeenCalledTimes(1)
    // The reloaded engine resumed the read from the stored offset and facts.
    expect(deps.readFacts.mock.calls[1][1]).toEqual({ offset: 500, facts: facts() })
    // ...and probed git from the stored head.
    expect(deps.gatherGit.mock.calls[1][2]).toBe(HEAD)

    // A scan resumed from the stored offset and facts deep-equals a full scan.
    const s = fixtureSession('a1000003')
    const lines = transcriptLines(s, { repo: '/r', plain: '/p', gone: '/g' }).main
    const file = join(tmp, 'resume.jsonl')
    const cut = Math.floor(lines.length / 2)
    await fs.writeFile(file, lines.slice(0, cut).join('\n') + '\n')
    const part = await readTranscriptFacts(file)
    const persisted = parseDigestState(
      serializeDigestState({
        version: 1,
        sessions: { s: { lastDigestAt: NOW, last: { head: null, userTurns: 1 }, scan: part } }
      }),
      NOW
    ).state.sessions.s.scan
    await fs.appendFile(file, lines.slice(cut).join('\n') + '\n')
    const resumed = await readTranscriptFacts(file, persisted)
    const full = await readTranscriptFacts(file)
    expect(resumed).toEqual(full)
    expect(full.facts.userTurns).toBe(7)

    // A corrupt or wrong-version file reads as empty, with a problem to log, and never throws.
    for (const raw of [
      '{nope',
      '',
      '[]',
      'null',
      JSON.stringify({ version: 2, sessions: {} }),
      JSON.stringify({ version: 1, sessions: [] }),
      JSON.stringify({ version: 1 })
    ]) {
      const r = parseDigestState(raw, NOW)
      expect(r.state).toEqual(emptyDigestState())
      expect(r.problem).toEqual(expect.any(String))
    }
    // A malformed entry is dropped; the rest of the file is kept.
    const mixed = parseDigestState(
      JSON.stringify({
        version: 1,
        sessions: {
          good: state.sessions.s1,
          noLast: { lastDigestAt: NOW, scan: state.sessions.s1.scan },
          badHead: { ...state.sessions.s1, last: { head: 7, userTurns: 1 } },
          badFacts: { ...state.sessions.s1, scan: { offset: 1, facts: { userTurns: 'x' } } },
          badOffset: { ...state.sessions.s1, scan: { offset: -1, facts: facts() } }
        }
      }),
      NOW
    )
    expect(Object.keys(mixed.state.sessions)).toEqual(['good'])

    // Entries older than 30 days are pruned, on load and by pruneDigestState.
    const aged: DigestState = {
      version: 1,
      sessions: {
        old: { ...state.sessions.s1, lastDigestAt: NOW - DIGEST_STATE_TTL_MS - 1 },
        edge: { ...state.sessions.s1, lastDigestAt: NOW - DIGEST_STATE_TTL_MS },
        fresh: { ...state.sessions.s1, lastDigestAt: NOW - 29 * DAY }
      }
    }
    expect(Object.keys(parseDigestState(serializeDigestState(aged), NOW).state.sessions)).toEqual([
      'edge',
      'fresh'
    ])
    expect(Object.keys(pruneDigestState(aged, NOW).sessions)).toEqual(['edge', 'fresh'])
    expect(Object.keys(aged.sessions)).toHaveLength(3) // pruning returns a copy
  })

  it('catch-up selects quiet undigested sessions', async () => {
    interface C extends CatchUpCandidate {
      turns: number
      digested?: boolean
    }
    const c = (sessionId: string, ageMs: number, turns = 3, digested = false): C => ({
      sessionId,
      mtimeMs: NOW - ageMs,
      turns,
      digested
    })
    const MIN = 60_000
    const candidates: C[] = [
      c('too-old', 7 * DAY + 1),
      c('oldest-ok', 7 * DAY), // exactly 7 days: still in the window
      c('too-fresh', LONG_IDLE_MS - 1),
      c('just-quiet', LONG_IDLE_MS), // exactly 5 minutes: quiet enough
      c('two-turns', 2 * DAY, 2),
      c('has-digest', 2 * DAY, 9, true),
      c('has-state', 2 * DAY),
      c('future', -MIN)
    ]
    for (let i = 0; i < 12; i++)
      candidates.push(c(`ok-${String(i).padStart(2, '0')}`, ((i + 1) * DAY) / 4))
    const state: DigestState = {
      version: 1,
      sessions: {
        'has-state': {
          lastDigestAt: NOW - DAY,
          last: { head: null, userTurns: 3 },
          scan: { offset: 1, facts: emptyFacts() }
        }
      }
    }
    const probed: string[] = []
    const probe = {
      hasDigest: vi.fn(async (x: C) => {
        probed.push(x.sessionId)
        return x.digested === true
      }),
      userTurns: vi.fn(async (x: C) => x.turns)
    }
    const picked = await selectCatchUp(candidates, state, NOW, probe, {
      minQuietMs: LONG_IDLE_MS,
      minUserTurns: 3
    })
    const ids = picked.map((p) => p.sessionId)
    expect(ids).toHaveLength(CATCH_UP_LIMIT)
    expect(CATCH_UP_LIMIT).toBe(10)
    // Oldest mtime first.
    expect(ids).toEqual([
      'oldest-ok',
      'ok-11',
      'ok-10',
      'ok-09',
      'ok-08',
      'ok-07',
      'ok-06',
      'ok-05',
      'ok-04',
      'ok-03'
    ])
    for (const out of ['too-old', 'too-fresh', 'two-turns', 'has-digest', 'has-state', 'future']) {
      expect(ids).not.toContain(out)
    }
    // The cheap checks run first: no probe for a session outside the window or with a state entry.
    for (const unprobed of ['too-old', 'too-fresh', 'has-state', 'future']) {
      expect(probed).not.toContain(unprobed)
    }
    // The probes stop once the limit is reached.
    expect(probed).not.toContain('just-quiet')

    // Without the limit pressure, the 5-minute boundary session is selected, last.
    const few = await selectCatchUp(
      candidates.filter((x) => !x.sessionId.startsWith('ok-')),
      state,
      NOW,
      probe,
      { minQuietMs: LONG_IDLE_MS, minUserTurns: 3 }
    )
    expect(few.map((p) => p.sessionId)).toEqual(['oldest-ok', 'just-quiet'])

    // "Has a digest": a dated file named after the session's first 8 characters.
    const sid = 'a1000003-0000-4000-8000-000000000000'
    expect(hasDigestFile(['2026-11-03-a1000003.md'], sid)).toBe(true)
    expect(hasDigestFile(['hot.md', '2026-11-03-a1000004.md'], sid)).toBe(false)
    expect(hasDigestFile(['2026-11-03-a1000003.md.tmp', 'x2026-11-03-a1000003.md'], sid)).toBe(
      false
    )
    expect(hasDigestFile(['26-11-03-a1000003.md'], sid)).toBe(false)
  })
})
