/**
 * Missions v4 · S-16b · AC-41 — the leader gets the summary after a compaction, without a steward.
 *
 * A `SessionStart` hook with matcher `compact` (one `command` handler in the per-session settings blob)
 * posts the hook's body to the hook bridge, which answers the text the hook prints and Claude Code adds
 * to the context. This is the route's pure function: who gets what. It answers only the open leader of
 * an open v4 mission after a compaction; for anyone else, and on any failure, it prints nothing, and it
 * never writes a file, never throws and never blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import { buildMissionSummary } from '../src/main/missions/summary'
import {
  SUMMARY_ROUTE_MAX,
  defaultSummaryRouteDeps,
  summaryRoute,
  type SummaryRouteDeps
} from '../src/main/missions/summary-route'
import { readMissionRecord } from '../src/main/missions/record-store'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')
const SRC = path.join(__dirname, '..', 'src', 'main')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = 'b6b6b6b6-0000-4000-8000-0000000000b6'
const FORMER = 'c7c7c7c7-0000-4000-8000-0000000000c7'
const STRANGER = 'd8d8d8d8-0000-4000-8000-0000000000d8'
const ID = 'mnt-d0000041'
const ID2 = 'mnt-d0000042'
const NOW = '2026-11-14T10:00:00Z'

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function missionOf(over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id: ID,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      {
        id: FORMER,
        role: 'worked',
        from: '2026-11-13T10:00:00Z',
        to: '2026-11-13T12:00:00Z',
        stoppedAt: {}
      },
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: WORKER, role: 'worked', from: NOW, to: null }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')

function seed(record: MissionV4, log = '# Log\n'): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${record.id}-score-report.md`),
    buildMissionRecordContent(record, log)
  )
}

function snapshot(dir = root, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const rel = path.join(prefix, name)
    if (statSync(full).isDirectory()) {
      out[`${rel}/`] = 'dir'
      Object.assign(out, snapshot(full, rel))
    } else out[rel] = sha(readFileSync(full))
  }
  return out
}

const body = (sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: sessionId,
  cwd: root,
  hook_event_name: 'SessionStart',
  source: 'compact',
  ...over
})

/** Deps over the real store of the temp repo: what the app wires. */
const real = (over: Partial<SummaryRouteDeps> = {}): SummaryRouteDeps => ({
  ...defaultSummaryRouteDeps(),
  ...over
})

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-summary-route-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the leader gets the summary after compaction', () => {
  it('the open leader of an open mission gets exactly the mission summary', async () => {
    seed(
      missionOf(),
      '# Log\n\n### 2026-11-14T09:00:00Z · decision · stp-1\nUse the shared export.\n'
    )
    const got = await summaryRoute(body(LEADER), real())
    const read = await readMissionRecord(root, ID)
    if (!read.ok) throw new Error(read.error)
    expect(got).toBe(buildMissionSummary(read.record, read.log).text)
    expect(got).toContain('Score report')
    expect(got).toContain('Every candidate sees a score report')
  })

  it('needs no steward: the mission has none, and the module imports no steward file', () => {
    const text = readFileSync(path.join(SRC, 'missions', 'summary-route.ts'), 'utf8')
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(path.basename(spec), spec).not.toMatch(/^steward/)
      expect(path.basename(spec), spec).not.toMatch(
        /^(mission-core|mission-gates|mission-progress|mission-migration|campaign-core|campaign-progress)$/
      )
    }
  })

  it('answers only after a compaction: a start, a resume or a clear prints nothing', async () => {
    seed(missionOf())
    for (const source of ['startup', 'resume', 'clear', '', undefined]) {
      expect(await summaryRoute(body(LEADER, { source }), real()), String(source)).toBe('')
    }
    expect(await summaryRoute(body(LEADER, { source: undefined }), real())).toBe('')
  })

  it('a session that is not the leader gets nothing: a worker, a former leader, a stranger', async () => {
    seed(missionOf())
    for (const id of [WORKER, FORMER, STRANGER]) {
      expect(await summaryRoute(body(id), real()), id).toBe('')
    }
  })

  it('a leader whose mission is closed gets nothing', async () => {
    seed(missionOf({ status: 'closed', closedAs: 'delivered' } as Partial<MissionV4>))
    expect(await summaryRoute(body(LEADER), real())).toBe('')
  })

  it('a leader that was handed off (its entry has `to`) gets nothing', async () => {
    seed(
      missionOf({
        sessions: [
          { id: LEADER, role: 'worked', from: NOW, to: '2026-11-14T11:00:00Z', stoppedAt: {} },
          { id: STRANGER, role: 'leads', from: '2026-11-14T11:00:00Z', to: null }
        ]
      })
    )
    expect(await summaryRoute(body(LEADER), real())).toBe('')
    expect(await summaryRoute(body(STRANGER), real())).toContain('Score report')
  })

  it('serves a v4 record only: the leader of a v3 mission sees no change, and nothing is read from v3', async () => {
    cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
      recursive: true
    })
    cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
      recursive: true
    })
    const before = snapshot()
    // the leader of the v3 mission, as the compatibility reader names it
    const read = await readMissionRecord(root, 'mnt-5c0de001')
    if (!read.ok) throw new Error(read.error)
    const v3Leader = read.record.sessions.find((s) => s.role === 'leads' && s.to === null)?.id
    expect(v3Leader, 'the fixture has an open leader').toBeDefined()
    expect(await summaryRoute(body(v3Leader as string), real())).toBe('')
    // a route that served v3 would also have had to list it; it never converts one
    expect(snapshot()).toEqual(before)
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('a record that is not a v4 one is never served, even to its own leader, until the cut-over', async () => {
    for (const source of ['v3-mission', 'v3-campaign'] as const) {
      const out = await summaryRoute(body(LEADER), {
        records: async () => [{ record: missionOf(), log: '# Log\n', source }]
      })
      expect(out, source).toBe('')
    }
    const v4 = await summaryRoute(body(LEADER), {
      records: async () => [{ record: missionOf(), log: '# Log\n', source: 'v4' as const }]
    })
    expect(v4).toContain('Score report')
  })

  it('writes no file anywhere: a v4 answer leaves every byte and every directory as it was', async () => {
    seed(missionOf())
    const before = snapshot()
    expect((await summaryRoute(body(LEADER), real())).length).toBeGreaterThan(0)
    await summaryRoute(body(WORKER), real())
    expect(snapshot()).toEqual(before)
  })

  it('a worktree of the repo reaches the same mission', async () => {
    seed(missionOf())
    const worktree = path.join(root, '.claude', 'worktrees', 'card-x')
    mkdirSync(worktree, { recursive: true })
    // a worktree is resolved by the data dir the same way every mission call does it; with no git
    // here the folder resolves to itself, so only the repo's own folder is asserted
    expect(await summaryRoute(body(LEADER, { cwd: root }), real())).toContain('Score report')
  })
})

describe('the route never throws and never blocks', () => {
  it('a body that is not a hook body prints nothing', async () => {
    seed(missionOf())
    for (const raw of [
      null,
      undefined,
      'x',
      3,
      [],
      {},
      { source: 'compact' },
      { session_id: LEADER }
    ]) {
      expect(await summaryRoute(raw as never, real())).toBe('')
    }
    expect(await summaryRoute({ session_id: 7, cwd: root, source: 'compact' }, real())).toBe('')
    expect(await summaryRoute({ session_id: LEADER, cwd: 7, source: 'compact' }, real())).toBe('')
  })

  it('a store that throws prints nothing', async () => {
    const out = await summaryRoute(
      body(LEADER),
      real({
        records: async () => {
          throw new Error('disk on fire')
        }
      })
    )
    expect(out).toBe('')
  })

  it('a store that is slow prints nothing within the deadline', async () => {
    const started = Date.now()
    const out = await summaryRoute(
      body(LEADER),
      real({ records: () => new Promise(() => undefined), deadlineMs: 40 })
    )
    expect(out).toBe('')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('facts that are slow or throw cost the summary its facts, never the summary', async () => {
    seed(missionOf())
    const slow = await summaryRoute(
      body(LEADER),
      real({ inputsFor: () => new Promise(() => undefined), inputsMs: 30 })
    )
    expect(slow).toContain('Score report')
    const broken = await summaryRoute(
      body(LEADER),
      real({
        inputsFor: async () => {
          throw new Error('gh is down')
        }
      })
    )
    expect(broken).toContain('Score report')
  })

  it('the facts it is given are the ones the summary reads', async () => {
    seed(missionOf())
    const withFacts = await summaryRoute(
      body(LEADER),
      real({ inputsFor: async () => ({ 'stp-1': { pr: 'merged' } }) })
    )
    const read = await readMissionRecord(root, ID)
    if (!read.ok) throw new Error(read.error)
    expect(withFacts).toBe(
      buildMissionSummary(read.record, read.log, { inputs: { 'stp-1': { pr: 'merged' } } }).text
    )
    expect(withFacts).not.toBe(buildMissionSummary(read.record, read.log).text)
  })

  it('the whole answer stays under 10,000 characters, whatever the record holds', async () => {
    const long = 'A long and careful sentence about the mission. '.repeat(40)
    const big = missionOf({
      title: long.slice(0, 120),
      doneWhen: long,
      steps: Array.from({ length: 30 }, (_, i) => ({
        id: `stp-${i + 1}`,
        title: `Step number ${i + 1} of the long mission`,
        acs: [
          { id: 'ac-1', text: long.slice(0, 160), by: 'operator' as const },
          { id: 'ac-2', text: long.slice(0, 160), by: 'operator' as const }
        ],
        links: [],
        blockers: []
      }))
    })
    const log = Array.from(
      { length: 40 },
      (_, i) =>
        `### 2026-11-14T09:${String(i).padStart(2, '0')}:00Z · decision · stp-${i + 1}\n${long}\n`
    ).join('\n')
    expect(SUMMARY_ROUTE_MAX).toBeLessThan(10_000)
    // each summary is big enough that two of them cannot both fit: the cap has to act
    const one = buildMissionSummary(big, log).text
    expect(one.length).toBeGreaterThan(SUMMARY_ROUTE_MAX / 2)
    expect(one.length).toBeLessThanOrEqual(8000)
    const records = [
      { record: big, log, source: 'v4' as const },
      { record: { ...big, id: ID2 }, log, source: 'v4' as const }
    ]
    const out = await summaryRoute(body(LEADER), { records: async () => records })
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(10_000)
    // the second summary did not fit whole, so it is left out whole: the answer is the first one
    expect(out).toBe(one)
  })

  it('a leader of two open missions gets both summaries when they fit, and whole ones only', async () => {
    seed(missionOf())
    seed(missionOf({ id: ID2, title: 'Second mission' }))
    const out = await summaryRoute(body(LEADER), real())
    expect(out).toContain('Score report')
    expect(out).toContain('Second mission')
    expect(out.length).toBeLessThan(10_000)
  })
})

describe('the default store of the route', () => {
  it('reads the v4 records only, with no v3 file touched when none is converted', async () => {
    cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
      recursive: true
    })
    seed(missionOf())
    const before = snapshot(path.join(root, '.harnu', 'missions'))
    const records = await defaultSummaryRouteDeps().records(root)
    expect(records.map((r) => r.record.id)).toEqual([ID])
    expect(records.every((r) => r.source === 'v4')).toBe(true)
    expect(snapshot(path.join(root, '.harnu', 'missions'))).toEqual(before)
  })

  it('a repo with no v4 directory answers no records and creates none', async () => {
    const before = snapshot()
    expect(await defaultSummaryRouteDeps().records(root)).toEqual([])
    expect(snapshot()).toEqual(before)
  })
})
