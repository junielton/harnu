import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createDigestEngine } from '../src/main/mcp/digest-engine'
import {
  gatherGitEvidence,
  readTranscriptFacts,
  readTranscriptTruth
} from '../src/main/mcp/digest-io'
import { isUserTurn } from '../src/main/mcp/digest-transcript'
import { memoryDirFor } from '../src/main/mcp/memory-core'
import { appendMemoryEntry } from '../src/main/mcp/memory-store'
import {
  atMinute,
  buildMemoryU1Home,
  transcriptLines,
  type FixtureSession,
  type MemoryU1Home
} from './helpers/memory-u1-fixture'

/**
 * Memory U1 S-2: the replay. The real engine, with the real reader and git probe, digests every
 * `repo` and `plain` fixture session as it ends; the merged benchmark then scores the temp home.
 * Key paths: the spec's Amendments row of 2026-11-05 (the CLI is the only way to the gather,
 * git coverage is the repo folder's `detail.capture_by_folder` row).
 */

const run = promisify(execFile)
const BENCH = join(__dirname, '..', 'scripts', 'memory-bench.mjs')
/** The replay clock: T + 2 days. */
const REPLAY = atMinute(2 * 24 * 60)

interface Scorecard {
  metrics: Record<string, number>
  detail: { capture_by_folder: { folder: string; sessions: number; captured: number }[] }
}

let tmp: string
let fx: MemoryU1Home
let git: Scorecard
let nonGit: Scorecard

async function score(folder: string): Promise<Scorecard> {
  const { stdout } = await run(process.execPath, [
    BENCH,
    '--repo',
    folder,
    '--home',
    join(fx.home, '.claude'),
    '--json'
  ])
  return JSON.parse(stdout) as Scorecard
}

/** Sessions with at least three user turns by U1's rule, among those in `folder`. */
function expectedSet(folder: FixtureSession['folder']): string[] {
  const paths = { repo: fx.repo, plain: fx.plain, gone: fx.gone }
  return fx.sessions
    .filter((s) => s.folder === folder)
    .filter((s) => {
      const turns = transcriptLines(s, paths)
        .main.map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter(isUserTurn).length
      return turns >= 3
    })
    .map((s) => s.id)
}

/** The ids of `ids` that have a digest in `memoryDir` (spec "Has a digest"). */
async function digested(memoryDir: string, ids: string[]): Promise<string[]> {
  const names = await fs.readdir(join(memoryDir, 'sessions')).catch(() => [] as string[])
  return ids.filter((id) =>
    names.some((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id.slice(0, 8)}\\.md$`).test(n))
  )
}

beforeAll(async () => {
  tmp = await mkdtemp(join(os.tmpdir(), 'memory-u1-'))
  fx = await buildMemoryU1Home(tmp)
  const folderOf = (s: FixtureSession): string =>
    s.folder === 'repo' ? fx.repo : s.folder === 'plain' ? fx.plain : fx.gone

  const engine = createDigestEngine({
    resolveSession: async (id) => {
      const s = fx.sessions.find((x) => x.id === id)
      if (!s) return null
      return {
        transcriptPath: fx.transcriptOf(id),
        folder: folderOf(s),
        ...(s.folder === 'repo' ? { branch: 'main' } : {})
      }
    },
    readFacts: readTranscriptFacts,
    readTruth: readTranscriptTruth,
    gatherGit: gatherGitEvidence,
    writeDigest: (folder, page, entry, sessionId) =>
      appendMemoryEntry({
        memoryDir: memoryDirFor(folder),
        page,
        entry,
        author: 'agent',
        sessionId,
        now: REPLAY
      }),
    writeHot: async () => undefined,
    now: () => REPLAY,
    setTimer: () => {
      throw new Error('the replay uses no timer')
    },
    clearTimer: () => undefined
  })
  // In order of end time; a tie keeps table order (Array#sort is stable).
  const replayed = fx.sessions
    .filter((s) => s.folder !== 'gone')
    .sort((a, b) => a.endMin - b.endMin)
  for (const s of replayed) await engine.digestNow(s.id, 'ended')
  engine.close()

  git = await score(fx.repo)
  nonGit = await score(fx.plain)
}, 60_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('memory U1 capture, scored by the benchmark', () => {
  it('git capture_coverage is at least 0.95', () => {
    const row = git.detail.capture_by_folder.find((r) => r.folder === '.')
    expect(row).toBeDefined()
    expect(row!.sessions).toBeGreaterThan(0)
    expect(row!.captured / row!.sessions).toBeGreaterThanOrEqual(0.95)
  })

  it('user-turn and digest rules agree with the benchmark', async () => {
    const gitSet = expectedSet('repo')
    const nonGitSet = expectedSet('plain')
    expect(gitSet.map((id) => id.slice(0, 8))).toEqual([
      'a1000001',
      'a1000002',
      'a1000003',
      'a1000005',
      'a1000006'
    ])
    expect(nonGitSet.map((id) => id.slice(0, 8))).toEqual(['a1000007'])

    const row = git.detail.capture_by_folder.find((r) => r.folder === '.')!
    expect(row.sessions).toBe(gitSet.length)
    expect(row.captured).toBe((await digested(memoryDirFor(fx.repo), gitSet)).length)
    expect(nonGit.metrics.capture_sessions).toBe(nonGitSet.length)
    expect(nonGit.metrics.captured_sessions).toBe(
      (await digested(memoryDirFor(fx.plain), nonGitSet)).length
    )
  })
})
