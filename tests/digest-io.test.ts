import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gatherGitEvidence, LINE_MAX_BYTES, readTranscriptFacts } from '../src/main/mcp/digest-io'
import { emptyFacts } from '../src/main/mcp/digest-transcript'
import { buildMemoryU1Home, fixtureT, type MemoryU1Home } from './helpers/memory-u1-fixture'

const runFile = promisify(execFile)

/**
 * Memory U1 S-2: the Node-only reader and git probe the digest engine is given
 * (`src/main/mcp/digest-io.ts`). Spec `docs/specs/2026-11-04-memory-u1-capture/spec.md`,
 * "The reader and git".
 */

let tmp: string
let fx: MemoryU1Home

beforeAll(async () => {
  tmp = await mkdtemp(join(os.tmpdir(), 'memory-u1-'))
  fx = await buildMemoryU1Home(tmp)
}, 30_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** A user line whose operator text is `text`. */
function userLine(text: string, ts: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

/** A user line of exactly `bytes` UTF-8 bytes (the newline excluded). */
function userLineOfBytes(bytes: number, ts: string): string {
  const empty = userLine('', ts)
  const line = userLine('x'.repeat(bytes - Buffer.byteLength(empty)), ts)
  expect(Buffer.byteLength(line)).toBe(bytes)
  return line
}

describe('readTranscriptFacts', () => {
  it('counts fixture user turns', async () => {
    for (const s of fx.sessions) {
      const file = fx.transcriptOf(s.id)
      const raw = await fs.readFile(file, 'utf8')
      // The noise lines are really there: only their flag or shape keeps them from being turns.
      if (s.turns >= 1) {
        expect(raw).toContain('"isMeta":true')
        expect(raw).toContain('"isSidechain":true')
        expect(raw).toContain('"isCompactSummary":true')
        expect(raw).toContain('"type":"image"')
        expect(raw).toContain('<local-command-stdout>')
        expect(raw).toContain('"type":"tool_result"')
      }
      const { facts, offset } = await readTranscriptFacts(file)
      expect(facts.userTurns, s.id).toBe(s.turns)
      expect(offset).toBe(Buffer.byteLength(raw))
    }
  })

  it('reads a whole transcript within the line limit', async () => {
    const dir = await mkdtemp(join(tmp, 'reader-'))
    const file = join(dir, 'big.jsonl')
    const at = (i: number): string => new Date(fixtureT() + i * 1_000).toISOString()

    const lines: string[] = [userLine('the very first turn', at(0))]
    // About 400 KiB of assistant lines between the first turn and the rest, so a tail-only
    // read (the old 256 KiB window) would never see the first line.
    for (let i = 0; i < 400; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: at(1),
          message: { id: `m${i}`, content: [{ type: 'text', text: 'y'.repeat(1_000) }] }
        })
      )
    }
    lines.push(userLineOfBytes(LINE_MAX_BYTES, at(2))) // at the limit: kept
    lines.push(userLineOfBytes(LINE_MAX_BYTES + 1, at(3))) // over it: dropped, not counted
    lines.push(userLine('after the big line', at(4)))
    const body = lines.join('\n') + '\n'
    const tail = userLine('a trailing line still being written', at(5))
    await fs.writeFile(file, body + tail)
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024 + 2 * LINE_MAX_BYTES)

    const first = await readTranscriptFacts(file)
    expect(first.facts.firstAt).toBe(at(0))
    expect(first.facts.userTurns).toBe(3)
    expect(first.facts.lastAt).toBe(at(4))
    // The trailing line has no newline yet: the offset stops right before it.
    expect(first.offset).toBe(Buffer.byteLength(body))

    // Once its newline lands, the next read resumes there and counts it.
    await fs.appendFile(file, '\n')
    const next = await readTranscriptFacts(file, first)
    expect(next.facts.userTurns).toBe(4)
    expect(next.facts.lastAt).toBe(at(5))
    expect(next.offset).toBe(Buffer.byteLength(body + tail) + 1)

    // An unreadable file returns the input unchanged, never throws.
    const input = { offset: 42, facts: { ...emptyFacts(), userTurns: 9 } }
    expect(await readTranscriptFacts(join(dir, 'missing.jsonl'), input)).toEqual(input)
    expect(await readTranscriptFacts(dir, input)).toEqual(input)
    expect(await readTranscriptFacts(join(dir, 'missing.jsonl'))).toEqual({
      facts: emptyFacts(),
      offset: 0
    })
  })
})

describe('gatherGitEvidence', () => {
  it('selects commits on a repo and refuses a folder that is not one', async () => {
    const sinceT = Math.floor(fixtureT() / 1000)
    const all = await gatherGitEvidence(fx.repo, sinceT, null)
    expect(all.kind).toBe('repo')
    if (all.kind !== 'repo') return
    expect(all.head).toMatch(/^[0-9a-f]{40}$/)
    expect(all.commits.map((c) => c.subject)).toEqual(['c4', 'c3', 'c2', 'c1'])
    expect(all.fileStats.map((f) => f.file).sort()).toEqual([
      'c1.txt',
      'c2.txt',
      'c3.txt',
      'c4.txt'
    ])
    expect(all.dirtyCount).toBe(0)

    // With a baseline, only the commits after it.
    const c2 = all.commits.find((c) => c.subject === 'c2')!.hash
    const after = await gatherGitEvidence(fx.repo, sinceT, c2)
    expect(after.kind === 'repo' && after.commits.map((c) => c.subject)).toEqual(['c4', 'c3'])

    // A folder that is not a work tree, and one that does not exist.
    expect(await gatherGitEvidence(fx.plain, sinceT, null)).toEqual({ kind: 'not-a-repo' })
    expect(await gatherGitEvidence(fx.gone, sinceT, null)).toEqual({ kind: 'not-a-repo' })

    // A repo with no commit yet.
    const fresh = join(tmp, 'fresh')
    await fs.mkdir(fresh)
    await runFile('git', ['-C', fresh, 'init', '--template=', '-q'], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    })
    await fs.writeFile(join(fresh, 'a.txt'), 'a\n')
    expect(await gatherGitEvidence(fresh, sinceT, null)).toEqual({
      kind: 'repo',
      head: null,
      commits: [],
      fileStats: [],
      dirtyCount: 1
    })

    // Another rev (S-5's orphan branch): its head, no working-tree dirt (D-10).
    await fs.writeFile(join(fx.repo, 'dirt.txt'), 'dirt\n')
    try {
      const onRev = await gatherGitEvidence(fx.repo, sinceT, null, c2)
      expect(onRev.kind === 'repo' && onRev.head).toBe(c2)
      expect(onRev.kind === 'repo' && onRev.commits.map((c) => c.subject)).toEqual(['c2', 'c1'])
      expect(onRev.kind === 'repo' && onRev.dirtyCount).toBe(0)
      const onHead = await gatherGitEvidence(fx.repo, sinceT, null)
      expect(onHead.kind === 'repo' && onHead.dirtyCount).toBe(1)
    } finally {
      await fs.rm(join(fx.repo, 'dirt.txt'))
    }
  })
})
