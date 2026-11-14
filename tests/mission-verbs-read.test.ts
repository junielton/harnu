/**
 * Missions v4 · S-12 · AC-31, AC-32 — the read verbs: create, get, list.
 *
 * The handlers are written and tested through their module API (`verbs-read.ts`); S-24 registers them.
 * Who is calling is a plain argument (an `Actor`), exactly as `guard.ts` takes it. The "never" clauses
 * each have a test that fails when its check is taken out:
 *
 * - `get` never answers a session that is not attached (and a worker bound to another mission);
 * - `list` never carries a step, a criterion, a link or a session history to a session that cannot read
 *   the mission;
 * - a read never writes (a mission that exists only as a v3 file stays only a v3 file);
 * - `create` never needs an approval and never asks for a card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
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
  utimesSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMissionRecordContent, STATE_LABELS, type MissionV4 } from '../src/main/missions/model'
import type { Actor } from '../src/main/missions/guard'
import * as guardModule from '../src/main/missions/guard'
import { clearRootCache } from '../src/main/data-dir'
import { missionCreate, missionGet, missionList } from '../src/main/missions/verbs-read'
import * as recordStore from '../src/main/missions/record-store'
import * as progressModule from '../src/main/missions/progress'
import * as waitingModule from '../src/main/missions/waiting'

// Pass-through spies: they count calls and change nothing.
vi.mock('../src/main/missions/record-store', async (orig) => {
  const m = await orig<typeof import('../src/main/missions/record-store')>()
  return {
    ...m,
    readMissionRecord: vi.fn(m.readMissionRecord),
    listMissionRecords: vi.fn(m.listMissionRecords)
  }
})
vi.mock('../src/main/missions/guard', async (orig) => {
  const m = await orig<typeof import('../src/main/missions/guard')>()
  return { ...m, listMissionRows: vi.fn(m.listMissionRows) }
})
vi.mock('../src/main/missions/progress', async (orig) => {
  const m = await orig<typeof import('../src/main/missions/progress')>()
  return { ...m, deriveProgress: vi.fn(m.deriveProgress) }
})
vi.mock('../src/main/missions/waiting', async (orig) => {
  const m = await orig<typeof import('../src/main/missions/waiting')>()
  return { ...m, deriveStepResults: vi.fn(m.deriveStepResults) }
})

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const OUTSIDER = 'e0e0e0e0-0000-4000-8000-000000000001'
const RELEASED = 'e0e0e0e0-0000-4000-8000-000000000002'

const ID = 'mnt-aa000001'
const OTHER = 'mnt-aa000002'
const NOW = '2026-11-14T10:00:00Z'

const session = (sessionId: string): Actor => ({ kind: 'session', sessionId })
const operator: Actor = { kind: 'operator' }
const worker = (missionId?: string): Actor => ({ kind: 'worker', missionId })

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** A mission with an operator criterion on a started step: the S-8 one-line row would name it. */
function missionOf(id: string, over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        startedAt: NOW,
        acs: [
          { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
          { id: 'ac-2', text: 'Rosa signs off the wording', by: 'operator' }
        ],
        links: [{ kind: 'doc', ref: 'docs/specs/secret-plan/spec.md' }],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Render the report page',
        acs: [{ id: 'ac-1', text: 'The page shows every score', by: 'session' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: WORKER, role: 'worked', from: NOW, to: null },
      { id: RELEASED, role: 'worked', from: NOW, to: '2026-11-14T11:00:00Z' }
    ],
    links: [{ kind: 'url', ref: 'https://example.test/brief' }],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (r = root): string => path.join(r, '.harnu', 'missions-v4')
const v4Files = (r = root): string[] =>
  existsSync(v4Dir(r))
    ? readdirSync(v4Dir(r))
        .filter((n) => n.endsWith('.md'))
        .sort()
    : []

function seed(record: MissionV4, log = '', at = root): string {
  mkdirSync(v4Dir(at), { recursive: true })
  const file = path.join(v4Dir(at), `${record.id}-score-report.md`)
  writeFileSync(file, buildMissionRecordContent(record, log))
  return file
}

/** Every file under `dir`, relative, with a hash: a read must leave this exactly as it was. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        out[`${path.relative(dir, p)}/`] = 'dir'
        walk(p)
      } else out[path.relative(dir, p)] = sha(readFileSync(p))
    }
  }
  walk(dir)
  return out
}

beforeEach(() => {
  clearRootCache()
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-read-'))
  vi.mocked(recordStore.readMissionRecord).mockClear()
  vi.mocked(recordStore.listMissionRecords).mockClear()
  vi.mocked(guardModule.listMissionRows).mockClear()
  vi.mocked(progressModule.deriveProgress).mockClear()
  vi.mocked(waitingModule.deriveStepResults).mockClear()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ====================================================================================
// AC-31 — who may read
// ====================================================================================

describe('get answers for attached sessions and bound workers only', () => {
  beforeEach(() => {
    seed(missionOf(ID), '### 2026-11-14T10:30:00Z · decision\nWe score per candidate.\n')
  })

  it('an attached session reads the detail: plan, each step and its criteria, progress, next step, waiting list, summary', async () => {
    const r = await missionGet(root, session(LEADER), { missionId: ID })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe(ID)
    expect(r.title).toBe('Score report')
    expect(r.doneWhen).toBe('Every candidate sees a score report')
    expect(r.standing).toBe('leads')
    expect(r.leads).toBe(LEADER)
    expect(r.state).toBe('open')
    expect(r.stateLabel).toBe(STATE_LABELS.open)

    // progress, counted once, with the model's words
    expect(r.progress.unit).toBe('steps')
    expect(r.progress.total).toBe(2)
    expect(r.progress.done).toBe(0)
    expect(r.progress.headline).toBe('0 of 2 steps done')
    expect(r.progress.current).toEqual({ id: 'stp-1', ordinal: 1 })

    // each step: its state identifier AND its English words, and each criterion's settled or open
    const [one, two] = r.steps
    expect(one.id).toBe('stp-1')
    expect(one.state).toBe('running')
    expect(one.stateLabel).toBe(STATE_LABELS.running)
    expect(one.criteria.map((c) => [c.id, c.by, c.settled, c.via])).toEqual([
      ['ac-1', 'fact', false, null],
      ['ac-2', 'operator', false, null]
    ])
    expect(one.open).toEqual(['ac-1', 'ac-2'])
    expect(one.criteria[1].text).toBe('Rosa signs off the wording')
    expect(one.links).toEqual([{ kind: 'doc', ref: 'docs/specs/secret-plan/spec.md' }])
    expect(two.state).toBe('todo')
    expect(two.stateLabel).toBe(STATE_LABELS.todo)

    // the waiting list and the next step come from S-8's list, unchanged
    expect(r.next?.kind).toBe('settle')
    expect(r.next?.ask).toBe('Mark done: Rosa signs off the wording')
    expect(r.waiting.items).toHaveLength(1)
    expect(r.waiting.moreLine).toBeNull()

    // the summary comes from S-8's builder and carries the Log's decision
    expect(r.summary).toContain('# Mission mnt-aa000001')
    expect(r.summary).toContain('We score per candidate.')
    expect(r.links).toEqual([{ kind: 'url', ref: 'https://example.test/brief' }])
  })

  it('a session that worked a step reads the detail too', async () => {
    const r = await missionGet(root, session(WORKER), { missionId: ID })
    expect(r.ok && r.standing).toBe('worked')
  })

  it('a session that is not attached is refused NOT_ATTACHED with the way out, and learns nothing of the plan', async () => {
    for (const who of [OUTSIDER, RELEASED]) {
      const r = await missionGet(root, session(who), { missionId: ID })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('NOT_ATTACHED')
      expect(r.error.startsWith('NOT_ATTACHED: ')).toBe(true)
      expect(r.error).toContain('mission_attach')
      expect(r.error).toContain('mission_list')
      // the refusal carries no step, criterion, link or session of the mission
      for (const secret of ['Load the test files', 'Rosa', 'secret-plan', LEADER, WORKER]) {
        expect(JSON.stringify(r)).not.toContain(secret)
      }
    }
  })

  it('a Harnu system worker bound to the mission or to the folder reads it; one bound to another mission does not', async () => {
    expect((await missionGet(root, worker(ID), { missionId: ID })).ok).toBe(true)
    expect((await missionGet(root, worker(), { missionId: ID })).ok).toBe(true)
    const other = await missionGet(root, worker(OTHER), { missionId: ID })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.code).toBe('NOT_ATTACHED')
  })

  it('the app itself (the operator) reads everything', async () => {
    const r = await missionGet(root, operator, { missionId: ID })
    expect(r.ok && r.standing).toBe('operator')
  })

  it('a closed mission is still read by the sessions attached to it', async () => {
    seed(missionOf(OTHER, { status: 'closed', closedAs: 'delivered' }))
    const r = await missionGet(root, session(LEADER), { missionId: OTHER })
    expect(r.ok && r.state).toBe('closed')
  })

  it('an unknown or malformed mission id is a typed refusal', async () => {
    const none = await missionGet(root, session(LEADER), { missionId: 'mnt-ffffffff' })
    expect(!none.ok && none.code).toBe('MISSION_NOT_FOUND')
    const bad = await missionGet(root, session(LEADER), { missionId: 'nope' })
    expect(!bad.ok && bad.code).toBe('BAD_ARGS')
  })

  it('with no id it resolves the mission the session is attached to', async () => {
    seed(missionOf(OTHER, { sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }] }))
    const mine = await missionGet(root, session(LEADER), {})
    expect(mine.ok && mine.id).toBe(ID)
    const theirs = await missionGet(root, session(OUTSIDER), {})
    expect(theirs.ok && theirs.id).toBe(OTHER)
  })

  it('with no id and no attachment it is NOT_ATTACHED with the way out; a worker with no id is BAD_ARGS', async () => {
    const r = await missionGet(root, session('e0e0e0e0-0000-4000-8000-0000000000ff'), {})
    expect(!r.ok && r.code).toBe('NOT_ATTACHED')
    if (!r.ok) {
      expect(r.error).toContain('mission_attach')
      expect(r.error).toContain('mission_list')
    }
    const w = await missionGet(root, worker(), {})
    expect(!w.ok && w.code).toBe('BAD_ARGS')
  })

  it('with no id and two attached missions it prefers the one the session leads, else asks for an id', async () => {
    seed(
      missionOf(OTHER, {
        sessions: [
          { id: OUTSIDER, role: 'leads', from: NOW, to: null },
          { id: LEADER, role: 'worked', from: NOW, to: null }
        ]
      })
    )
    const leads = await missionGet(root, session(LEADER), {})
    expect(leads.ok && leads.id).toBe(ID)
    seed(
      missionOf('mnt-aa000003', {
        sessions: [{ id: WORKER, role: 'worked', from: NOW, to: null }]
      })
    )
    seed(
      missionOf('mnt-aa000004', {
        sessions: [{ id: WORKER, role: 'worked', from: NOW, to: null }]
      })
    )
    const two = await missionGet(root, session(WORKER), {})
    // WORKER is attached to mnt-aa000001 (worked), 03 and 04: three, none led
    expect(!two.ok && two.code).toBe('AMBIGUOUS_MISSION')
    if (!two.ok) expect(two.error).toContain('mnt-aa000003')
  })

  it('progress and results are derived once per call and shared by the waiting list and the summary', async () => {
    const r = await missionGet(root, session(LEADER), { missionId: ID })
    expect(r.ok).toBe(true)
    expect(vi.mocked(progressModule.deriveProgress)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(waitingModule.deriveStepResults)).toHaveBeenCalledTimes(1)
    // and one id lookup, not one per step
    expect(vi.mocked(recordStore.readMissionRecord)).toHaveBeenCalledTimes(1)
  })

  it('the caller-supplied facts drive the states (a merged pull request settles its fact criterion)', async () => {
    const r = await missionGet(
      root,
      session(LEADER),
      { missionId: ID },
      { inputs: { 'stp-1': { pr: 'merged' } } }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps[0].criteria[0]).toMatchObject({ id: 'ac-1', settled: true, via: 'fact' })
    expect(r.steps[0].open).toEqual(['ac-2'])
    expect(r.steps[0].state).toBe('waiting-review')
    expect(r.steps[0].stateLabel).toBe('waiting for review')
  })

  it('a refused read writes nothing', async () => {
    const before = tree(root)
    await missionGet(root, session(OUTSIDER), { missionId: ID })
    await missionGet(root, session(OUTSIDER), {})
    expect(tree(root)).toEqual(before)
  })

  describe('a read writes nothing: a mission that exists only as a v3 file stays one', () => {
    const V3_ID = 'mnt-5c0de001'
    const V3_LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
    let v3Root = ''
    beforeEach(() => {
      v3Root = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-read-v3-'))
      cpSync(path.join(FIXTURES, 'missions'), path.join(v3Root, '.harnu', 'missions'), {
        recursive: true
      })
      clearRootCache()
    })
    afterEach(() => rmSync(v3Root, { recursive: true, force: true }))

    it('get and list through the compatibility reader leave every byte and the directory listing as they were, and create no v4 record', async () => {
      const before = tree(v3Root)
      const got = await missionGet(v3Root, session(V3_LEADER), { missionId: V3_ID })
      expect(got.ok).toBe(true)
      const noId = await missionGet(v3Root, session(V3_LEADER), {})
      // the fixture's leader leads six missions: no id is ambiguous, and still a read
      expect(!noId.ok && noId.code).toBe('AMBIGUOUS_MISSION')
      const refused = await missionGet(v3Root, session(OUTSIDER), { missionId: V3_ID })
      expect(refused.ok).toBe(false)
      const listed = await missionList(v3Root, session(OUTSIDER))
      expect(listed.ok && listed.missions.length).toBeGreaterThan(0)
      expect(tree(v3Root)).toEqual(before)
      expect(existsSync(v4Dir(v3Root))).toBe(false)
    })
  })

  describe('it reads the store winner, not the one clone it was addressed at', () => {
    let clone = ''
    beforeEach(() => {
      clone = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-read-clone-'))
      clearRootCache()
    })
    afterEach(() => rmSync(clone, { recursive: true, force: true }))

    it('called from the stale clone, it answers the newer copy in the other clone', async () => {
      // `root` holds a stale copy (old Log entry); `clone` holds the newer one (a step was added).
      const stale = seed(missionOf(ID), '### 2026-11-14T10:00:00Z\nstarted\n')
      const newer = missionOf(ID, {
        title: 'Score report v2',
        steps: [
          ...missionOf(ID).steps,
          {
            id: 'stp-3',
            title: 'Email the report',
            acs: [{ id: 'ac-1', text: 'The email arrives', by: 'session' }],
            links: [],
            blockers: []
          }
        ]
      })
      const fresh = seed(
        newer,
        '### 2026-11-14T10:00:00Z\nstarted\n### 2026-11-14T12:00:00Z\nadded\n',
        clone
      )
      // make the stale copy the newer FILE: only the Log may decide, not a file's age
      utimesSync(stale, new Date('2026-11-14T13:00:00Z'), new Date('2026-11-14T13:00:00Z'))
      utimesSync(fresh, new Date('2026-11-14T11:00:00Z'), new Date('2026-11-14T11:00:00Z'))

      const alone = await missionGet(root, session(LEADER), { missionId: ID })
      expect(alone.ok && alone.title).toBe('Score report')
      const winner = await missionGet(
        root,
        session(LEADER),
        { missionId: ID },
        { siblingRoots: [clone] }
      )
      expect(winner.ok).toBe(true)
      if (!winner.ok) return
      expect(winner.title).toBe('Score report v2')
      expect(winner.steps).toHaveLength(3)
      // reading from either clone gives the same answer
      const fromOther = await missionGet(
        clone,
        session(LEADER),
        { missionId: ID },
        { siblingRoots: [root] }
      )
      expect(fromOther.ok && fromOther.title).toBe('Score report v2')
    })

    it('the guard is judged on the winner: a session attached only in the stale copy is refused', async () => {
      seed(missionOf(ID), '### 2026-11-14T10:00:00Z\nstarted\n')
      seed(
        missionOf(ID, { sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }] }),
        '### 2026-11-14T12:00:00Z\nhanded off\n',
        clone
      )
      const r = await missionGet(
        root,
        session(LEADER),
        { missionId: ID },
        { siblingRoots: [clone] }
      )
      expect(!r.ok && r.code).toBe('NOT_ATTACHED')
    })

    it('a mission found in no root keeps the home root refusal; a sibling that does not exist is ignored', async () => {
      const r = await missionGet(
        root,
        session(LEADER),
        { missionId: 'mnt-ffffffff' },
        { siblingRoots: [clone, path.join(clone, 'missing')] }
      )
      expect(!r.ok && r.code).toBe('MISSION_NOT_FOUND')
    })
  })
})

describe('list gives one-line rows and never steps, criteria, links or history', () => {
  const ROW_KEYS = ['headline', 'id', 'leads', 'title']
  const SECRETS = [
    'Load the test files',
    'Render the report page',
    'Rosa signs off the wording',
    'The page shows every score',
    'secret-plan',
    'example.test',
    WORKER,
    RELEASED,
    'We score per candidate.',
    'hand-off history'
  ]

  beforeEach(() => {
    seed(
      missionOf(ID, {
        sessions: [
          { id: LEADER, role: 'leads', from: NOW, to: null },
          { id: WORKER, role: 'worked', from: NOW, to: null },
          { id: RELEASED, role: 'worked', from: NOW, to: '2026-11-14T11:00:00Z' }
        ]
      }),
      '### 2026-11-14T10:30:00Z · decision\nWe score per candidate.\n### 2026-11-14T10:40:00Z\nhand-off history\n'
    )
  })

  it('any session in the folder gets the rows, an unattached one included: id, title, headline, who leads', async () => {
    for (const who of [session(OUTSIDER), session(LEADER), worker(), operator]) {
      const r = await missionList(root, who)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.missions).toHaveLength(1)
      expect(r.missions[0]).toMatchObject({
        id: ID,
        title: 'Score report',
        headline: '0 of 2 steps done',
        leads: LEADER
      })
    }
  })

  it('a session that cannot read the mission gets exactly the four fields and nothing of the plan', async () => {
    const r = await missionList(root, session(OUTSIDER))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const row of r.missions) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
      for (const key of ['steps', 'milestones', 'criteria', 'acs', 'links', 'sessions', 'log']) {
        expect(row).not.toHaveProperty(key)
      }
    }
    const text = JSON.stringify(r)
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret)
  })

  it('a row has the same four fields for a session that may read the mission: no one-line text, no step, criterion, link or history key', async () => {
    const r = await missionList(root, session(LEADER))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // the next-step line can quote a step or a criterion ("Mark done: ..."): it is not in a row for anyone
    expect(Object.keys(r.missions[0]).sort()).toEqual(ROW_KEYS)
    expect(JSON.stringify(r)).not.toContain('Mark done')
    for (const key of [
      'line',
      'steps',
      'milestones',
      'criteria',
      'acs',
      'links',
      'sessions',
      'log'
    ]) {
      expect(r.missions[0]).not.toHaveProperty(key)
    }
  })

  it("the rows are S-11's rows as they are: one construction, in the guard module", async () => {
    seed(missionOf('mnt-aa000003', { title: 'Second mission', sessions: [] }))
    for (const who of [session(OUTSIDER), session(LEADER), worker(), operator]) {
      const mine = await missionList(root, who)
      const theirs = await guardModule.listMissionRows(root, who)
      expect(mine).toEqual({ ok: true, missions: theirs })
    }
    // and it follows S-11's row when that changes shape: a field added there reaches the caller
    vi.mocked(guardModule.listMissionRows).mockImplementationOnce(async () => [
      { id: ID, title: 'T', headline: 'H', leads: null, marker: 'from-s11' } as never
    ])
    const changed = await missionList(root, session(OUTSIDER))
    expect(changed).toEqual({
      ok: true,
      missions: [{ id: ID, title: 'T', headline: 'H', leads: null, marker: 'from-s11' }]
    })
  })

  it('the caller-supplied facts reach the headline through the same rows', async () => {
    const inputs = {
      [ID]: { 'stp-1': { pr: 'merged' as const }, 'stp-2': { pr: 'merged' as const } }
    }
    await missionList(root, session(OUTSIDER), { inputs })
    expect(vi.mocked(guardModule.listMissionRows)).toHaveBeenCalledWith(
      root,
      session(OUTSIDER),
      inputs
    )
  })

  it('lists open missions only, in the order the store gives', async () => {
    seed(missionOf(OTHER, { status: 'closed', closedAs: 'discarded' }))
    seed(missionOf('mnt-aa000003', { title: 'Second mission' }))
    const r = await missionList(root, session(OUTSIDER))
    expect(r.ok && r.missions.map((m) => m.id)).toEqual([ID, 'mnt-aa000003'])
  })

  it('a mission nobody leads says so', async () => {
    seed(missionOf('mnt-aa000003', { sessions: [] }))
    const r = await missionList(root, session(OUTSIDER))
    expect(r.ok && r.missions.find((m) => m.id === 'mnt-aa000003')?.leads).toBeNull()
  })

  it('one list reads the folder once: N missions cost one directory pass, not one read per row', async () => {
    for (let n = 3; n <= 7; n++) seed(missionOf(`mnt-aa00000${n}`))
    const r = await missionList(root, session(OUTSIDER))
    expect(r.ok && r.missions).toHaveLength(6)
    expect(vi.mocked(recordStore.listMissionRecords)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordStore.readMissionRecord)).not.toHaveBeenCalled()
  })

  it('the same folder reached from a worktree lists the same missions', async () => {
    const main = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-main-'))
    const wt = `${main}-wt`
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
        cwd: main,
        stdio: 'ignore'
      })
    }
    try {
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'init')
      git('worktree', 'add', '-q', wt, '-b', 'feature')
      clearRootCache()
      seed(missionOf(ID), '', main)
      const r = await missionList(wt, session(OUTSIDER))
      expect(r.ok && r.missions.map((m) => m.id)).toEqual([ID])
      expect(existsSync(path.join(wt, '.harnu'))).toBe(false)
    } finally {
      rmSync(wt, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  })
})

// ====================================================================================
// AC-32 — create
// ====================================================================================

describe('create needs no approval and attaches the creator as leader', () => {
  const input = {
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    steps: [
      {
        title: 'Load the test files',
        criteria: ['The pull request is merged', 'The files parse without errors']
      }
    ]
  }

  it('creates an open mission the creating session leads, at once, with no attach request and no confirmation', async () => {
    const r = await missionCreate(root, session(OUTSIDER), input, { now: () => new Date(NOW) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toMatch(/^mnt-[0-9a-f]{8}$/)
    expect(r.state).toBe('open')
    expect(r.standing).toBe('leads')
    expect(r.leads).toBe(OUTSIDER)

    const files = v4Files()
    expect(files).toHaveLength(1)
    const text = readFileSync(path.join(v4Dir(), files[0]), 'utf8')
    expect(text).toContain('status: open')
    expect(text).not.toContain('attachRequests')
    const read = await recordStore.readMissionRecord(root, r.id)
    expect(read.ok && read.record.sessions).toEqual([
      { id: OUTSIDER, role: 'leads', from: NOW, to: null }
    ])

    // the creator reads it straight away, as the leader
    const got = await missionGet(root, session(OUTSIDER), { missionId: r.id })
    expect(got.ok && got.standing).toBe('leads')
    // and another session is still refused: leading is not shared
    const other = await missionGet(root, session(WORKER), { missionId: r.id })
    expect(!other.ok && other.code).toBe('NOT_ATTACHED')
  })

  it('numbers the steps and criteria, accepts a mission with no milestones, and answers with the summary and recall', async () => {
    const r = await missionCreate(root, session(OUTSIDER), input, {
      recall: [{ page: 'decisions', line: 12, text: 'Scores are per candidate.' }]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps).toEqual([{ id: 'stp-1', title: 'Load the test files', milestone: null }])
    expect(r.milestones).toEqual([])
    expect(r.summary).toContain(`# Mission ${r.id}`)
    expect(r.summary).toContain('## Goal')
    expect(r.recall).toEqual([{ page: 'decisions', line: 12, text: 'Scores are per candidate.' }])
    expect(r.headline).toBe('0 of 1 step done')
    const read = await recordStore.readMissionRecord(root, r.id)
    if (!read.ok) throw new Error('not stored')
    expect(read.record.steps[0].acs.map((c) => [c.id, c.text, c.by])).toEqual([
      ['ac-1', 'The pull request is merged', 'session'],
      ['ac-2', 'The files parse without errors', 'session']
    ])
  })

  it('takes milestones, a step in a milestone (by id or by title), criteria settled by a fact or a person, and links', async () => {
    const r = await missionCreate(root, session(OUTSIDER), {
      title: 'Score report',
      doneWhen: 'Every candidate sees a score report',
      milestones: [
        { title: 'Data is in' },
        { title: 'Page is live', waitsFor: 'Data is in' },
        { title: 'Polish', optional: true }
      ],
      steps: [
        {
          title: 'Load the test files',
          milestone: 'mls-1',
          criteria: [
            { text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
            { text: 'Rosa approves the wording', by: 'person', person: 'Rosa' }
          ],
          links: [{ kind: 'doc', ref: 'docs/specs/score/spec.md' }]
        },
        {
          title: 'Render the report page',
          milestone: 'Page is live',
          criteria: [{ text: 'The operator checks the page', by: 'operator' }]
        },
        { title: 'Tidy the labels', milestone: 'Polish', criteria: ['The labels are consistent'] }
      ],
      links: [{ kind: 'url', ref: 'https://example.test/brief' }]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.milestones.map((m) => m.id)).toEqual(['mls-1', 'mls-2', 'mls-3'])
    expect(r.steps.map((s) => [s.id, s.milestone])).toEqual([
      ['stp-1', 'mls-1'],
      ['stp-2', 'mls-2'],
      ['stp-3', 'mls-3']
    ])
    const read = await recordStore.readMissionRecord(root, r.id)
    if (!read.ok) throw new Error('not stored')
    expect(read.record.milestones).toEqual([
      { id: 'mls-1', title: 'Data is in', optional: false, waitsFor: null },
      { id: 'mls-2', title: 'Page is live', optional: false, waitsFor: 'mls-1' },
      { id: 'mls-3', title: 'Polish', optional: true, waitsFor: null }
    ])
    expect(read.record.steps[0].acs[1]).toMatchObject({ by: 'person', person: 'Rosa' })
    expect(read.record.steps[0].links).toEqual([{ kind: 'doc', ref: 'docs/specs/score/spec.md' }])
    expect(read.record.links).toEqual([{ kind: 'url', ref: 'https://example.test/brief' }])
    expect(r.headline).toBe('0 of 2 milestones done')
  })

  it('every step needs at least one criterion, and nothing is written when one has none', async () => {
    const r = await missionCreate(root, session(OUTSIDER), {
      ...input,
      steps: [...input.steps, { title: 'Render the report page', criteria: [] }]
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('STEP_WITHOUT_CRITERION')
      expect(r.error.startsWith('STEP_WITHOUT_CRITERION: ')).toBe(true)
      expect(r.error).toContain('Render the report page')
    }
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('refuses what v4 dropped (campaignId, chapterId, steward, a declared end) and a state it cannot read', async () => {
    for (const extra of [
      { campaignId: 'cmp-12345678' },
      { chapterId: 'chp-1' },
      { steward: false },
      { declaredEnd: { kind: 'code', target: 'x', evidence: 'y' } }
    ]) {
      const r = await missionCreate(root, session(OUTSIDER), { ...input, ...extra } as never)
      expect(r.ok, JSON.stringify(extra)).toBe(false)
      if (!r.ok) expect(r.code).toBe('BAD_ARGS')
    }
    const noTitle = await missionCreate(root, session(OUTSIDER), { ...input, title: '' })
    expect(!noTitle.ok && noTitle.code).toBe('BAD_ARGS')
    const badKind = await missionCreate(root, session(OUTSIDER), {
      ...input,
      links: [{ kind: 'card', ref: 'T1' }]
    } as never)
    expect(!badKind.ok && badKind.code).toBe('BAD_ARGS')
    const factless = await missionCreate(root, session(OUTSIDER), {
      ...input,
      steps: [
        {
          title: 'Load the test files',
          criteria: [{ text: 'The pull request is merged', by: 'fact' }]
        }
      ]
    } as never)
    expect(!factless.ok && factless.code).toBe('BAD_ARGS')
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('the writing contract is enforced by the write path: a title over 60 characters is refused', async () => {
    const r = await missionCreate(root, session(OUTSIDER), { ...input, title: 'x'.repeat(61) })
    expect(!r.ok && r.code).toBe('OVER_CAP')
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('a milestone a step names must exist, and a mission with milestones places every step in one', async () => {
    const unknown = await missionCreate(root, session(OUTSIDER), {
      ...input,
      milestones: [{ title: 'Data is in' }],
      steps: [{ ...input.steps[0], milestone: 'Page is live' }]
    })
    expect(!unknown.ok && unknown.code).toBe('UNKNOWN_MILESTONE')
    const none = await missionCreate(root, session(OUTSIDER), {
      ...input,
      milestones: [{ title: 'Data is in' }]
    })
    expect(!none.ok && none.code).toBe('STEP_WITHOUT_MILESTONE')
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('a worker never creates a mission; a session with no id cannot lead one; the operator may create one nobody leads', async () => {
    const w = await missionCreate(root, worker(), input)
    expect(!w.ok && w.code).toBe('READ_ONLY')
    const blank = await missionCreate(root, session(''), input)
    expect(!blank.ok && blank.code).toBe('BAD_ARGS')
    expect(existsSync(v4Dir())).toBe(false)
    const op = await missionCreate(root, operator, input)
    expect(op.ok && op.leads).toBeNull()
  })

  it('creates no card: a step is not dispatched here', async () => {
    const r = await missionCreate(root, session(OUTSIDER), input)
    expect(r.ok).toBe(true)
    expect(existsSync(path.join(root, '.harnu', 'memory'))).toBe(false)
    const read = await recordStore.readMissionRecord(root, r.ok ? r.id : '')
    expect(read.ok && read.record.steps[0].card).toBeUndefined()
  })

  it('the first Log entry is one heading the write path accepts, "### <time> · note", with the event in its body', async () => {
    const r = await missionCreate(
      root,
      session(OUTSIDER),
      {
        ...input,
        steps: [
          input.steps[0],
          { title: 'Render the report page', criteria: ['The page shows every score'] }
        ]
      },
      { now: () => new Date(NOW) }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const read = await recordStore.readMissionRecord(root, r.id)
    if (!read.ok) throw new Error('not stored')
    const headings = read.log.split('\n').filter((l) => l.startsWith('#'))
    expect(headings).toEqual([`### ${NOW} · note`])
    expect(read.log).toContain('Mission created: "Score report".')
    expect(read.log).toContain('"Load the test files"')
    expect(read.log).toContain('"Render the report page"')
    expect(read.log).toContain(OUTSIDER)
    expect(read.log).not.toMatch(/[\r\u0085\u2028\u2029\v\f]/)
  })

  it('a title with a line break cannot forge a second heading in the Log: the event line stays one line', async () => {
    const r = await missionCreate(
      root,
      session(OUTSIDER),
      { ...input, title: 'Score\n### 2026-11-14T10:00:00Z · decision\nreport' },
      { now: () => new Date(NOW) }
    )
    // either the contract refuses the title, or it is stored and the Log still has one heading
    if (r.ok) {
      const read = await recordStore.readMissionRecord(root, r.id)
      if (!read.ok) throw new Error('not stored')
      expect(read.log.split('\n').filter((l) => l.startsWith('#'))).toEqual([`### ${NOW} · note`])
    } else {
      expect(existsSync(v4Dir())).toBe(false)
    }
  })

  it('Harnu never creates a mission: a harnu actor is refused and nothing is written', async () => {
    const r = await missionCreate(root, { kind: 'harnu' }, input)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('OPERATOR_ONLY')
      expect(r.error.startsWith('OPERATOR_ONLY: ')).toBe(true)
      expect(r.error).toContain('Harnu never creates a mission')
    }
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('a criterion already settled on create is refused, and nothing is written', async () => {
    const settled = { at: NOW, by: WORKER, evidence: 'looked fine' }
    const viaInput = await missionCreate(root, session(OUTSIDER), {
      ...input,
      steps: [
        {
          title: 'Load the test files',
          criteria: [{ text: 'The files parse without errors', by: 'session', settled }]
        }
      ]
    } as never)
    expect(viaInput.ok).toBe(false)
    // the verb's input has no such field: it is refused before the write path is reached
    if (!viaInput.ok) {
      expect(viaInput.code).toBe('BAD_ARGS')
      expect(viaInput.error).toContain('settled')
    }
    expect(existsSync(v4Dir())).toBe(false)
    // and the write path refuses the same record by itself (S-11's code), whatever a caller builds
    const { createMission } = await import('../src/main/missions/write')
    const record = missionOf('mnt-bb000001', {
      sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }]
    })
    record.steps[0].acs[0].by = 'session'
    delete record.steps[0].acs[0].fact
    record.steps[0].acs[0].settled = settled
    const direct = await createMission(root, session(OUTSIDER), record, '')
    expect(!direct.ok && direct.code).toBe('SETTLE_NOT_ALLOWED')
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('a create from a worktree lands in the main checkout, and a v3 file next to it is not touched', async () => {
    const main = mkdtempSync(path.join(os.tmpdir(), 'harnu-verbs-create-main-'))
    const wt = `${main}-wt`
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
        cwd: main,
        stdio: 'ignore'
      })
    }
    try {
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'init')
      git('worktree', 'add', '-q', wt, '-b', 'feature')
      clearRootCache()
      cpSync(path.join(FIXTURES, 'missions'), path.join(main, '.harnu', 'missions'), {
        recursive: true
      })
      const before = tree(path.join(main, '.harnu', 'missions'))
      const r = await missionCreate(wt, session(OUTSIDER), input)
      expect(r.ok).toBe(true)
      expect(v4Files(main)).toHaveLength(1)
      expect(existsSync(path.join(wt, '.harnu'))).toBe(false)
      expect(tree(path.join(main, '.harnu', 'missions'))).toEqual(before)
      expect(statSync(path.join(main, '.harnu', 'missions')).isDirectory()).toBe(true)
    } finally {
      rmSync(wt, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  })
})
