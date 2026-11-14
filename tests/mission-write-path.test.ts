/**
 * Missions v4 · S-11 · AC-30 — one attachment guard and one v4 write path.
 *
 * Every v4 verb and door calls `guard.ts` (who may read, write, lead) and `write.ts` (the lock, the
 * caps and the copy on first write). The "never" clauses each have a test here that fails when the
 * guard is taken out: an unattached session never writes, a `worked` session never does what only the
 * leader may, and no session ever sets or moves who leads (the operator's decision of 2026-11-14,
 * spec amendment C3-32).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  type MissionV4
} from '../src/main/missions/model'
import {
  buildersOf,
  guardMission,
  isBuilderOf,
  listMissionRows,
  readMissionAs,
  type Actor,
  type Need
} from '../src/main/missions/guard'
import { createMission, newMissionId, writeMission } from '../src/main/missions/write'
import { clearRootCache } from '../src/main/data-dir'
import { readMissionRecord } from '../src/main/missions/record-store'

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

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

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
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: []
      }
    ],
    sessions: [
      { id: LEADER, role: 'leads', from: NOW, to: null },
      { id: WORKER, role: 'worked', from: NOW, to: null },
      { id: RELEASED, role: 'worked', from: NOW, to: '2026-11-14T11:00:00Z' }
    ],
    links: [],
    blockers: [],
    ...over
  }
}

let root = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')
const v4Files = (): string[] =>
  existsSync(v4Dir())
    ? readdirSync(v4Dir())
        .filter((n) => n.endsWith('.md'))
        .sort()
    : []
const fileOf = (id: string): string =>
  path.join(
    v4Dir(),
    v4Files().find((n) => n.startsWith(id))!
  )

function seed(record: MissionV4, log = ''): string {
  mkdirSync(v4Dir(), { recursive: true })
  const file = path.join(v4Dir(), `${record.id}-score-report.md`)
  writeFileSync(file, buildMissionRecordContent(record, log))
  return file
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-write-path-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The text of every file of the v4 directory, to prove a refusal wrote nothing. */
const v4Snapshot = (): Record<string, string> =>
  Object.fromEntries(v4Files().map((n) => [n, readFileSync(path.join(v4Dir(), n), 'utf8')]))

describe('one guard and one write path', () => {
  describe('the guard, in one place', () => {
    const record = missionOf(ID)
    const standing = (actor: Actor, need: Need) => {
      const r = guardMission(record, actor, need)
      return r.ok ? r.standing : r.code
    }

    it('an attached session reads and writes; only the leader leads; only the operator holds the doors', () => {
      expect(standing(session(LEADER), 'read')).toBe('leads')
      expect(standing(session(LEADER), 'write')).toBe('leads')
      expect(standing(session(LEADER), 'lead')).toBe('leads')
      expect(standing(session(WORKER), 'read')).toBe('worked')
      expect(standing(session(WORKER), 'write')).toBe('worked')
      expect(standing(session(WORKER), 'lead')).toBe('NOT_LEADER')
      expect(standing(session(LEADER), 'operator')).toBe('OPERATOR_ONLY')
      expect(standing(session(WORKER), 'operator')).toBe('OPERATOR_ONLY')
      for (const need of ['read', 'write', 'lead', 'operator', 'ask-to-attach'] as const) {
        expect(standing(operator, need), need).toBe('operator')
      }
    })

    it('an unattached session, and one the mission released, is refused NOT_ATTACHED with the way out', () => {
      for (const id of [OUTSIDER, RELEASED]) {
        for (const need of ['read', 'write', 'lead'] as const) {
          const r = guardMission(record, session(id), need)
          expect(r.ok, `${id} ${need}`).toBe(false)
          if (r.ok) continue
          expect(r.code).toBe('NOT_ATTACHED')
          expect(r.error).toMatch(/^NOT_ATTACHED:/)
          expect(r.error).toContain('mission_attach')
          expect(r.error).toContain('mission_list')
        }
        expect(standing(session(id), 'operator')).toBe('OPERATOR_ONLY')
      }
    })

    it('an unattached session may ask to attach, which is how it leaves NOT_ATTACHED', () => {
      expect(standing(session(OUTSIDER), 'ask-to-attach')).toBe('unattached')
    })

    it('a Harnu system worker reads the detail of the mission it is bound to, and of its folder, and writes nothing', () => {
      expect(standing({ kind: 'worker', missionId: ID }, 'read')).toBe('worker')
      expect(standing({ kind: 'worker' }, 'read')).toBe('worker')
      expect(standing({ kind: 'worker', missionId: OTHER }, 'read')).toBe('NOT_ATTACHED')
      for (const need of ['write', 'lead', 'operator', 'ask-to-attach'] as const) {
        expect(standing({ kind: 'worker', missionId: ID }, need), need).toBe('READ_ONLY')
      }
    })

    it('a closed mission refuses a session that writes, never the operator', () => {
      const closed = missionOf(ID, { status: 'closed', closedAs: 'delivered' })
      const r = guardMission(closed, session(LEADER), 'write')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('MISSION_CLOSED')
      expect(guardMission(closed, session(LEADER), 'read').ok).toBe(true)
      expect(guardMission(closed, operator, 'write').ok).toBe(true)
    })
  })

  describe('reading and listing', () => {
    beforeEach(() => {
      seed(missionOf(ID))
      seed(
        missionOf(OTHER, {
          title: 'Another mission',
          sessions: [{ id: WORKER, role: 'leads', from: NOW, to: null }]
        })
      )
      seed(missionOf('mnt-aa000003', { title: 'Old one', status: 'closed', closedAs: 'delivered' }))
    })

    it('the detail goes to an attached session, a bound worker and the app; any other session is refused', async () => {
      expect((await readMissionAs(root, ID, session(LEADER))).ok).toBe(true)
      expect((await readMissionAs(root, ID, session(WORKER))).ok).toBe(true)
      expect((await readMissionAs(root, ID, { kind: 'worker', missionId: ID })).ok).toBe(true)
      expect((await readMissionAs(root, ID, operator)).ok).toBe(true)
      const refused = await readMissionAs(root, ID, session(OUTSIDER))
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toMatch(/^NOT_ATTACHED:/)
      const missing = await readMissionAs(root, 'mnt-ffffffff', session(LEADER))
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error).toMatch(/^MISSION_NOT_FOUND:/)
    })

    it("an unattached session lists the folder's open missions as one-line rows and nothing more", async () => {
      const rows = await listMissionRows(root, session(OUTSIDER))
      expect(rows.map((r) => r.id)).toEqual([ID, OTHER])
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['headline', 'id', 'leads', 'title'])
      }
      expect(rows[0]).toEqual({
        id: ID,
        title: 'Score report',
        headline: '0 of 1 step done',
        leads: LEADER
      })
      expect(rows[1].leads).toBe(WORKER)
      expect(JSON.stringify(rows)).not.toContain('Load the test files')
    })
  })

  describe('an unattached session writes nothing but its request to attach', () => {
    beforeEach(() => {
      seed(missionOf(ID))
    })

    const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'atr-1',
      missionId: ID,
      sessionId: OUTSIDER,
      at: NOW,
      decision: null,
      ...over
    })

    it('records the request and changes nothing else', async () => {
      const r = await writeMission(root, ID, session(OUTSIDER), 'ask-to-attach', (rec, log) => ({
        record: { ...rec, attachRequests: [request()] } as MissionV4,
        log
      }))
      expect(r.ok).toBe(true)
      const stored = parseMissionRecordFile(readFileSync(fileOf(ID), 'utf8')) as MissionV4 & {
        attachRequests?: unknown[]
      }
      expect(stored.attachRequests).toEqual([request()])
      expect(stored.sessions.map((s) => s.id)).toEqual([LEADER, WORKER, RELEASED])
    })

    it('every other write is refused NOT_ATTACHED and no byte moves', async () => {
      const before = v4Snapshot()
      for (const need of ['write', 'lead'] as const) {
        const r = await writeMission(root, ID, session(OUTSIDER), need, (rec, log) => ({
          record: { ...rec, title: 'Hijacked' },
          log
        }))
        expect(r.ok, need).toBe(false)
        if (!r.ok) expect(r.code).toBe('NOT_ATTACHED')
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('a request that does anything beyond asking is refused: a title, a Log line, a decision, another session, the lead', async () => {
      const before = v4Snapshot()
      const attempts: Array<(rec: MissionV4, log: string) => { record: MissionV4; log: string }> = [
        (rec, log) => ({ record: { ...rec, title: 'Hijacked' }, log }),
        (rec, log) => ({
          record: { ...rec, attachRequests: [request()] } as MissionV4,
          log: `${log}x`
        }),
        (rec, log) => ({
          record: { ...rec, attachRequests: [request({ decision: 'allowed' })] } as MissionV4,
          log
        }),
        (rec, log) => ({
          record: { ...rec, attachRequests: [request({ sessionId: WORKER })] } as MissionV4,
          log
        }),
        (rec, log) => ({
          record: { ...rec, attachRequests: [request({ role: 'leads' })] } as MissionV4,
          log
        }),
        (rec, log) => ({
          record: {
            ...rec,
            sessions: [...rec.sessions, { id: OUTSIDER, role: 'worked', from: NOW, to: null }]
          },
          log
        })
      ]
      for (const [i, attempt] of attempts.entries()) {
        const r = await writeMission(root, ID, session(OUTSIDER), 'ask-to-attach', attempt)
        expect(r.ok, `attempt ${i}`).toBe(false)
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('a request cannot be a way to lead: a session asks to join as a worker, never to lead', async () => {
      const r = await writeMission(root, ID, session(OUTSIDER), 'ask-to-attach', (rec, log) => ({
        record: { ...rec, attachRequests: [request({ role: 'leads' })] } as MissionV4,
        log
      }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('LEADER_IS_OPERATORS')
    })
  })

  describe('only the operator changes who leads', () => {
    beforeEach(() => {
      seed(missionOf(ID))
    })

    const attempt = async (actor: Actor, need: Need, change: (r: MissionV4) => MissionV4) =>
      writeMission(root, ID, actor, need, (rec, log) => ({ record: change(rec), log }))

    it('a worked session never does what only the leader may', async () => {
      const before = v4Snapshot()
      const r = await attempt(session(WORKER), 'lead', (rec) => ({
        ...rec,
        title: 'Renamed by a worker'
      }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_LEADER')
      expect(v4Snapshot()).toEqual(before)
    })

    it('a session never takes the lead: not for itself, not from the leader, not by renaming a role', async () => {
      const before = v4Snapshot()
      const attempts: Array<(rec: MissionV4) => MissionV4> = [
        (rec) => ({
          ...rec,
          sessions: [...rec.sessions, { id: OUTSIDER, role: 'leads', from: NOW, to: null }]
        }),
        (rec) => ({
          ...rec,
          sessions: rec.sessions.map((s) => (s.id === WORKER ? { ...s, role: 'leads' } : s))
        }),
        (rec) => ({
          ...rec,
          sessions: rec.sessions.map((s) => (s.id === LEADER ? { ...s, role: 'worked' } : s))
        }),
        (rec) => ({
          ...rec,
          sessions: rec.sessions.map((s) => (s.id === LEADER ? { ...s, to: NOW } : s))
        }),
        (rec) => ({ ...rec, sessions: rec.sessions.filter((s) => s.id !== LEADER) })
      ]
      for (const actor of [session(WORKER), session(LEADER)]) {
        for (const [i, change] of attempts.entries()) {
          const r = await attempt(actor, 'write', change)
          expect(r.ok, `${actor.kind === 'session' ? actor.sessionId : ''} attempt ${i}`).toBe(
            false
          )
          if (!r.ok) expect(r.code).toBe('LEADER_IS_OPERATORS')
        }
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('a session never closes the mission, moves Done when or decides an attach request', async () => {
      const before = v4Snapshot()
      const attempts: Array<(rec: MissionV4) => MissionV4> = [
        (rec) => ({ ...rec, status: 'closed', closedAs: 'delivered' }),
        (rec) => ({ ...rec, doneWhen: 'Something easier' }),
        (rec) =>
          ({
            ...rec,
            attachRequests: [
              {
                id: 'atr-1',
                missionId: ID,
                sessionId: OUTSIDER,
                role: 'worked',
                at: NOW,
                decision: 'allowed'
              }
            ]
          }) as MissionV4
      ]
      for (const [i, change] of attempts.entries()) {
        const r = await attempt(session(LEADER), 'write', change)
        expect(r.ok, `attempt ${i}`).toBe(false)
        if (!r.ok) expect(r.code).toBe('OPERATOR_ONLY')
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('the leader adds a dispatched worker, as a worker', async () => {
      const added = { id: OUTSIDER, role: 'worked' as const, from: NOW, to: null }
      const r = await attempt(session(LEADER), 'lead', (rec) => ({
        ...rec,
        sessions: [...rec.sessions, added]
      }))
      expect(r.ok).toBe(true)
      const second = await attempt(session(LEADER), 'lead', (rec) => ({
        ...rec,
        sessions: [
          ...rec.sessions,
          { id: 'e0e0e0e0-0000-4000-8000-000000000003', role: 'leads', from: NOW, to: null }
        ]
      }))
      expect(second.ok).toBe(false)
    })

    it('the operator hands off: the old leader becomes a worker with where it stopped, the new one leads', async () => {
      const r = await attempt(operator, 'operator', (rec) => ({
        ...rec,
        sessions: [
          ...rec.sessions.map((s) =>
            s.id === LEADER
              ? {
                  ...s,
                  role: 'worked' as const,
                  to: NOW,
                  stoppedAt: { step: 'stp-1', waitingFor: 'the report' }
                }
              : s
          ),
          { id: OUTSIDER, role: 'leads' as const, from: NOW, to: null }
        ]
      }))
      expect(r.ok).toBe(true)
      const stored = parseMissionRecordFile(readFileSync(fileOf(ID), 'utf8')) as MissionV4
      expect(
        stored.sessions.filter((s) => s.role === 'leads' && s.to === null).map((s) => s.id)
      ).toEqual([OUTSIDER])
    })

    it('there is never more than one leader, whoever writes', async () => {
      const r = await attempt(operator, 'operator', (rec) => ({
        ...rec,
        sessions: [...rec.sessions, { id: OUTSIDER, role: 'leads', from: NOW, to: null }]
      }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('TWO_LEADERS')
    })
  })

  describe('every write goes through the caps', () => {
    const change = (fn: (r: MissionV4) => MissionV4) => (rec: MissionV4, log: string) => ({
      record: fn(rec),
      log
    })
    const step =
      (title: string) =>
      (rec: MissionV4): MissionV4 => ({
        ...rec,
        steps: rec.steps.map((s) => (s.id === 'stp-1' ? { ...s, title } : s))
      })

    it('a title over the cap, an id in a title, a short criterion and a vague blocker are refused and write nothing', async () => {
      seed(missionOf(ID))
      const before = v4Snapshot()
      const cases: Array<[string, (r: MissionV4) => MissionV4, string]> = [
        ['step over the cap', step('x'.repeat(51)), 'OVER_CAP'],
        ['id at the edge', step('Load the test files (#256)'), 'TITLE_EDGE_ID'],
        ['state word', step('Done'), 'STATE_WORD_TITLE'],
        ['mission title', (r) => ({ ...r, title: 'y'.repeat(61) }), 'OVER_CAP'],
        [
          'criterion',
          (r) => ({
            ...r,
            steps: r.steps.map((s) => ({
              ...s,
              acs: [...s.acs, { id: 'ac-2', text: 'Looks good', by: 'session' as const }]
            }))
          }),
          'CRITERION_TOO_SHORT'
        ],
        [
          'blocker',
          (r) => ({
            ...r,
            blockers: [{ id: 'blk-1', reason: 'Blocked on env', owner: 'operator' as const }]
          }),
          'BLOCKER_REASON_VAGUE'
        ]
      ]
      for (const [name, fn, code] of cases) {
        const r = await writeMission(root, ID, session(LEADER), 'write', change(fn))
        expect(r.ok, name).toBe(false)
        if (!r.ok) {
          expect(r.code, name).toBe(code)
          expect(r.error, name).toMatch(new RegExp(`^${code}:`))
        }
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('a refusal names where, and never carries the text', async () => {
      seed(missionOf(ID))
      const long = 'z'.repeat(51)
      const r = await writeMission(root, ID, session(LEADER), 'write', change(step(long)))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('stp-1')
        expect(r.error).not.toContain(long)
      }
    })

    it('the caps apply on write, never on read: an old over-long text opens and is written back by an unrelated change', async () => {
      const longTitle = 'An old step title that is much longer than fifty characters allow'
      expect(longTitle.length).toBeGreaterThan(50)
      seed(missionOf(ID, { steps: [{ ...missionOf(ID).steps[0], title: longTitle }] }))
      expect((await readMissionAs(root, ID, session(LEADER))).ok).toBe(true)
      const r = await writeMission(root, ID, session(LEADER), 'write', (rec, log) => ({
        record: { ...rec, links: [{ kind: 'doc', ref: 'docs/x.md' }] },
        log
      }))
      expect(r.ok).toBe(true)
      const stored = parseMissionRecordFile(readFileSync(fileOf(ID), 'utf8')) as MissionV4
      expect(stored.steps[0].title).toBe(longTitle)
      // …but touching the long field is refused: it is the changed field that is judged.
      const again = await writeMission(
        root,
        ID,
        session(LEADER),
        'write',
        change(step(`${longTitle}!`))
      )
      expect(again.ok).toBe(false)
    })

    it('the operator is bound by the caps too: a door cannot land text the contract refuses', async () => {
      seed(missionOf(ID))
      const r = await writeMission(
        root,
        ID,
        operator,
        'operator',
        change((rec) => ({ ...rec, title: 'q'.repeat(61) }))
      )
      expect(r.ok).toBe(false)
    })
  })

  describe('every write goes through the lock', () => {
    it('writers aimed at one mission run one after the other and every change lands', async () => {
      seed(missionOf(ID))
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          writeMission(root, ID, session(LEADER), 'write', async (rec, log) => {
            await new Promise((r) => setTimeout(r, 5))
            return {
              record: { ...rec, links: [...rec.links, { kind: 'doc', ref: `docs/n${i}.md` }] },
              log
            }
          })
        )
      )
      expect(results.every((r) => r.ok)).toBe(true)
      const stored = parseMissionRecordFile(readFileSync(fileOf(ID), 'utf8')) as MissionV4
      expect(stored.links.map((l) => l.ref).sort()).toEqual(
        Array.from({ length: 8 }, (_, i) => `docs/n${i}.md`).sort()
      )
    })

    it('a change that throws writes nothing', async () => {
      seed(missionOf(ID))
      const before = v4Snapshot()
      const r = await writeMission(root, ID, session(LEADER), 'write', () => {
        throw new Error('boom')
      })
      expect(r.ok).toBe(false)
      expect(v4Snapshot()).toEqual(before)
    })
  })

  describe('every write goes through the copy on first write, and a v3 file is never touched', () => {
    const V3_ID = 'mnt-5c0de001'
    const V3_LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'

    beforeEach(() => {
      cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
        recursive: true
      })
    })

    const v3Hashes = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(path.join(root, '.harnu', 'missions')).map((n) => [
          n,
          sha(readFileSync(path.join(root, '.harnu', 'missions', n)))
        ])
      )

    it('the first write by the attached leader creates the v4 record by copy; the v3 bytes are unchanged', async () => {
      const before = v3Hashes()
      const r = await writeMission(root, V3_ID, session(V3_LEADER), 'write', (rec, log) => ({
        record: { ...rec, links: [...rec.links, { kind: 'doc', ref: 'docs/specs/x/spec.md' }] },
        log
      }))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.created).toBe(true)
      expect(v4Files().some((n) => n.startsWith(V3_ID))).toBe(true)
      expect(v3Hashes()).toEqual(before)
      const second = await writeMission(root, V3_ID, session(V3_LEADER), 'write', (rec, log) => ({
        record: rec,
        log: `${log}note`
      }))
      expect(second.ok).toBe(true)
      if (second.ok) expect(second.created).toBe(false)
      expect(v3Hashes()).toEqual(before)
    })

    it('a refused write leaves a v3 mission as a v3 mission: no v4 record, no directory', async () => {
      const before = v3Hashes()
      const r = await writeMission(root, V3_ID, session(OUTSIDER), 'write', (rec, log) => ({
        record: { ...rec, title: 'No' },
        log
      }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_ATTACHED')
      expect(existsSync(v4Dir())).toBe(false)
      expect(v3Hashes()).toEqual(before)
    })
  })

  describe('a mission is created by the session that leads it', () => {
    const fresh = (over: Partial<MissionV4> = {}): MissionV4 =>
      missionOf(newMissionId(), {
        sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }],
        ...over
      })

    it('the creating session leads it, with no confirmation, and the record is read back', async () => {
      const record = fresh()
      const r = await createMission(root, session(OUTSIDER), record, '')
      expect(r.ok).toBe(true)
      expect(v4Files()).toHaveLength(1)
      const read = await readMissionRecord(root, record.id)
      expect(read.ok && read.record.sessions).toEqual(record.sessions)
      expect((await readMissionAs(root, record.id, session(OUTSIDER))).ok).toBe(true)
    })

    it('a session creates a mission it leads and no other shape: not for someone else, not with a worker, not closed', async () => {
      const bad: MissionV4[] = [
        fresh({ sessions: [{ id: LEADER, role: 'leads', from: NOW, to: null }] }),
        fresh({ sessions: [] }),
        fresh({
          sessions: [
            { id: OUTSIDER, role: 'leads', from: NOW, to: null },
            { id: WORKER, role: 'worked', from: NOW, to: null }
          ]
        }),
        fresh({ status: 'closed', closedAs: 'delivered' })
      ]
      for (const [i, record] of bad.entries()) {
        const r = await createMission(root, session(OUTSIDER), record, '')
        expect(r.ok, `case ${i}`).toBe(false)
      }
      expect(v4Files()).toEqual([])
    })

    it('a system worker creates nothing, and a created record meets the caps', async () => {
      expect((await createMission(root, { kind: 'worker' }, fresh(), '')).ok).toBe(false)
      const r = await createMission(root, session(OUTSIDER), fresh({ title: 'k'.repeat(61) }), '')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('OVER_CAP')
      expect(v4Files()).toEqual([])
    })

    it('an id already taken is never overwritten', async () => {
      const record = fresh()
      expect((await createMission(root, session(OUTSIDER), record, '')).ok).toBe(true)
      const before = v4Snapshot()
      const again = await createMission(root, session(OUTSIDER), { ...record, title: 'Other' }, '')
      expect(again.ok).toBe(false)
      expect(v4Snapshot()).toEqual(before)
    })
  })
})

describe('one guard and one write path: cross-references and the builder', () => {
  beforeEach(() => {
    seed(missionOf(ID))
  })
  const refused = async (change: (r: MissionV4) => MissionV4, actor: Actor = session(LEADER)) =>
    writeMission(root, ID, actor, 'write', (rec, log) => ({ record: change(rec), log }))
  const stepTwo = { id: 'stp-2', title: 'Write the report', acs: [], links: [], blockers: [] }

  it('step and milestone ids are unique', async () => {
    const before = v4Snapshot()
    const dupStep = await refused((r) => ({
      ...r,
      steps: [...r.steps, { ...stepTwo, id: 'stp-1' }]
    }))
    expect(dupStep.ok).toBe(false)
    if (!dupStep.ok) expect(dupStep.code).toBe('DUPLICATE_ID')
    const dupMilestone = await refused((r) => ({
      ...r,
      milestones: [
        { id: 'mls-1', title: 'First', optional: false, waitsFor: null },
        { id: 'mls-1', title: 'Second', optional: false, waitsFor: null }
      ]
    }))
    expect(dupMilestone.ok).toBe(false)
    if (!dupMilestone.ok) expect(dupMilestone.code).toBe('DUPLICATE_ID')
    expect(v4Snapshot()).toEqual(before)
  })

  it('a step names a milestone the mission has', async () => {
    const before = v4Snapshot()
    const r = await refused((rec) => ({ ...rec, steps: [{ ...rec.steps[0], milestone: 'mls-9' }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_MILESTONE')
    expect(v4Snapshot()).toEqual(before)
    const ok = await refused((rec) => ({
      ...rec,
      milestones: [{ id: 'mls-1', title: 'Load the data', optional: false, waitsFor: null }],
      steps: [
        { ...rec.steps[0], milestone: 'mls-1' },
        { ...stepTwo, milestone: 'mls-1' }
      ]
    }))
    expect(ok.ok).toBe(true)
  })

  it('a record that already breaks a reference is not refused for it by an unrelated change', async () => {
    seed(missionOf(ID, { steps: [{ ...missionOf(ID).steps[0], milestone: 'mls-9' }] }))
    const r = await refused((rec) => ({ ...rec, links: [{ kind: 'doc', ref: 'docs/x.md' }] }))
    expect(r.ok).toBe(true)
  })

  it('at most one open leader, whoever writes and however the second one arrives', async () => {
    const second = { id: OUTSIDER, role: 'leads' as const, from: NOW, to: null }
    const r = await refused((rec) => ({ ...rec, sessions: [...rec.sessions, second] }), operator)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TWO_LEADERS')
  })

  it('names the builders of a step, so a verb can tell a self-check from a second session', () => {
    const record = missionOf(ID, {
      steps: [
        {
          ...missionOf(ID).steps[0],
          links: [
            { kind: 'session', ref: WORKER },
            { kind: 'pr', ref: '256' }
          ]
        }
      ]
    })
    expect(buildersOf(record, 'stp-1')).toEqual([WORKER])
    expect(isBuilderOf(record, WORKER, 'stp-1')).toBe(true)
    expect(isBuilderOf(record, LEADER, 'stp-1')).toBe(false)
    expect(buildersOf(record, 'stp-9')).toEqual([])
  })

  it('an attach request that asks to lead is refused', async () => {
    const base = { id: 'atr-1', missionId: ID, sessionId: OUTSIDER, at: NOW, decision: null }
    const ask = (req: Record<string, unknown>) =>
      writeMission(root, ID, session(OUTSIDER), 'ask-to-attach', (rec, log) => ({
        record: { ...rec, attachRequests: [req] } as MissionV4,
        log
      }))
    // Round 5: a request carries no role at all, so even `worked` is refused (BAD_ARGS).
    expect((await ask({ ...base, role: 'worked' })).ok).toBe(false)
    const lead = await ask({ ...base, role: 'leads' })
    expect(lead.ok).toBe(false)
    if (!lead.ok) expect(lead.code).toBe('LEADER_IS_OPERATORS')
  })
})

describe('one guard and one write path: two more references', () => {
  beforeEach(() => {
    seed(missionOf(ID))
  })
  const milestone = { id: 'mls-1', title: 'Load the data', optional: false, waitsFor: null }
  const write = async (change: (r: MissionV4) => MissionV4) =>
    writeMission(root, ID, session(LEADER), 'write', (rec, log) => ({ record: change(rec), log }))

  it('in a mission that has milestones, every step names one', async () => {
    const before = v4Snapshot()
    const r = await write((rec) => ({ ...rec, milestones: [milestone] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('STEP_WITHOUT_MILESTONE')
    expect(v4Snapshot()).toEqual(before)
    const ok = await write((rec) => ({
      ...rec,
      milestones: [milestone],
      steps: rec.steps.map((s) => ({ ...s, milestone: 'mls-1' }))
    }))
    expect(ok.ok).toBe(true)
    const added = await write((rec) => ({
      ...rec,
      steps: [
        ...rec.steps,
        { id: 'stp-2', title: 'Write the report', acs: [], links: [], blockers: [] }
      ]
    }))
    expect(added.ok).toBe(false)
    if (!added.ok) expect(added.code).toBe('STEP_WITHOUT_MILESTONE')
  })

  it('a mission with no milestones keeps steps with none', async () => {
    const r = await write((rec) => ({ ...rec, links: [{ kind: 'doc', ref: 'docs/x.md' }] }))
    expect(r.ok).toBe(true)
  })

  it('a mission-level blocker carries no clearsWhen; a step blocker may', async () => {
    const blocker = {
      id: 'blk-1',
      reason: 'Waiting for the key HARNU_CORPUS_DIR to be set',
      owner: 'operator' as const,
      clearsWhen: 'pr-merged' as const
    }
    const before = v4Snapshot()
    const onMission = await write((rec) => ({ ...rec, blockers: [blocker] }))
    expect(onMission.ok).toBe(false)
    if (!onMission.ok) expect(onMission.code).toBe('MISSION_BLOCKER_FACT')
    expect(v4Snapshot()).toEqual(before)
    const onStep = await write((rec) => ({
      ...rec,
      steps: rec.steps.map((s) => ({ ...s, blockers: [blocker] }))
    }))
    expect(onStep.ok).toBe(true)
    const noFact = await write((rec) => ({
      ...rec,
      blockers: [{ ...blocker, id: 'blk-2', clearsWhen: undefined }]
    }))
    expect(noFact.ok).toBe(true)
  })

  it('a record that already breaks either is not refused for it by an unrelated change', async () => {
    seed(
      missionOf(ID, {
        milestones: [milestone],
        blockers: [{ id: 'blk-1', reason: 'Old reason', owner: 'operator', clearsWhen: 'ci-green' }]
      })
    )
    const r = await write((rec) => ({ ...rec, links: [{ kind: 'doc', ref: 'docs/x.md' }] }))
    expect(r.ok).toBe(true)
  })
})

describe('one guard and one write path: who settles a criterion', () => {
  const ac = { id: 'ac-1', text: 'Every reviewer question has an answer', by: 'session' as const }
  const stepWith = (criterion: Record<string, unknown>, by = 'session') => ({
    id: 'stp-1',
    title: 'Load the test files',
    acs: [{ ...ac, by, ...criterion }],
    links: [{ kind: 'session' as const, ref: WORKER }],
    blockers: []
  })
  beforeEach(() => {
    seed(missionOf(ID, { steps: [stepWith({}) as never] }))
  })
  const settle = (actor: Actor, stamp: Record<string, unknown>, by = 'session') =>
    writeMission(root, ID, actor, 'write', (rec, log) => ({
      record: { ...rec, steps: [stepWith({ settled: stamp }, by) as never] },
      log
    }))
  const stored = (): MissionV4 =>
    parseMissionRecordFile(readFileSync(fileOf(ID), 'utf8')) as MissionV4

  it('a session that built the step only self-checks it: its own settle is refused, its self-check lands and settles nothing', async () => {
    const before = v4Snapshot()
    const r = await settle(session(WORKER), { at: NOW, by: WORKER, evidence: 'I checked' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SETTLE_NOT_ALLOWED')
    expect(v4Snapshot()).toEqual(before)
    const check = await writeMission(root, ID, session(WORKER), 'write', (rec, log) => ({
      record: {
        ...rec,
        steps: [stepWith({ selfCheck: { at: NOW, by: WORKER, evidence: 'I checked' } }) as never]
      },
      log
    }))
    expect(check.ok).toBe(true)
    const criterion = stored().steps[0].acs[0]
    expect(criterion.selfCheck?.by).toBe(WORKER)
    expect(criterion.settled).toBeUndefined()
  })

  it('a second session settles a session criterion with evidence, in its own name', async () => {
    const r = await settle(session(LEADER), { at: NOW, by: LEADER, evidence: 'Read the replies' })
    expect(r.ok).toBe(true)
    expect(stored().steps[0].acs[0].settled?.by).toBe(LEADER)
  })

  it("a session never settles in another's name, as the operator, or a criterion that is not a second session's", async () => {
    const before = v4Snapshot()
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ at: NOW, by: OUTSIDER, evidence: 'x' }, 'session'],
      [{ at: NOW, by: 'operator' }, 'session'],
      [{ at: NOW, by: LEADER, evidence: 'x' }, 'operator'],
      [{ at: NOW, by: LEADER, evidence: 'x' }, 'person'],
      [{ at: NOW, by: LEADER, evidence: 'x' }, 'fact']
    ]
    for (const [stamp, by] of attempts) {
      const extra = by === 'fact' ? { fact: 'pr-merged' } : {}
      const r = await writeMission(root, ID, session(LEADER), 'write', (rec, log) => ({
        record: { ...rec, steps: [stepWith({ settled: stamp, ...extra }, by) as never] },
        log
      }))
      expect(r.ok, `${by} ${JSON.stringify(stamp)}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('SETTLE_NOT_ALLOWED')
    }
    expect(v4Snapshot()).toEqual(before)
  })

  it("a self-check carries its own author's id", async () => {
    const r = await writeMission(root, ID, session(WORKER), 'write', (rec, log) => ({
      record: {
        ...rec,
        steps: [stepWith({ selfCheck: { at: NOW, by: LEADER, evidence: 'x' } }) as never]
      },
      log
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SETTLE_NOT_ALLOWED')
  })

  it('the operator settles any criterion, and a settled criterion written back unchanged is not judged again', async () => {
    const r = await writeMission(root, ID, operator, 'operator', (rec, log) => ({
      record: { ...rec, steps: [stepWith({ settled: { at: NOW, by: 'operator' } }) as never] },
      log
    }))
    expect(r.ok).toBe(true)
    const again = await writeMission(root, ID, session(WORKER), 'write', (rec, log) => ({
      record: { ...rec, links: [{ kind: 'doc', ref: 'docs/x.md' }] },
      log
    }))
    expect(again.ok).toBe(true)
  })
})

describe('one guard and one write path: every worktree of a repo shares one record', () => {
  let main = ''
  let worktree = ''
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
      cwd,
      stdio: 'ignore'
    })
  }
  const mainV4 = (): string => path.join(main, '.harnu', 'missions-v4')
  const storedAt = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')) : []

  beforeEach(() => {
    clearRootCache()
    main = mkdtempSync(path.join(os.tmpdir(), 'harnu-main-'))
    worktree = `${main}-wt`
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature')
    mkdirSync(mainV4(), { recursive: true })
    writeFileSync(
      path.join(mainV4(), `${ID}-score-report.md`),
      buildMissionRecordContent(missionOf(ID))
    )
  })
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  })

  const link = (ref: string) => (rec: MissionV4, log: string) => ({
    record: { ...rec, links: [...rec.links, { kind: 'doc' as const, ref }] },
    log
  })

  it('a write from a worktree and a write from the main checkout land in the same record', async () => {
    const sub = path.join(worktree, 'src')
    mkdirSync(sub)
    expect((await writeMission(worktree, ID, session(LEADER), 'write', link('docs/a.md'))).ok).toBe(
      true
    )
    expect((await writeMission(main, ID, session(LEADER), 'write', link('docs/b.md'))).ok).toBe(
      true
    )
    expect((await writeMission(sub, ID, session(LEADER), 'write', link('docs/c.md'))).ok).toBe(true)
    const stored = parseMissionRecordFile(
      readFileSync(path.join(mainV4(), storedAt(mainV4())[0]), 'utf8')
    ) as MissionV4
    expect(stored.links.map((l) => l.ref)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
    expect(storedAt(mainV4())).toHaveLength(1)
    expect(existsSync(path.join(worktree, '.harnu', 'missions-v4'))).toBe(false)
  })

  it('a read and a list from either folder see the same mission, and a mission created in a worktree is in the main checkout', async () => {
    for (const folder of [main, worktree]) {
      expect((await readMissionAs(folder, ID, session(LEADER))).ok, folder).toBe(true)
      expect((await listMissionRows(folder, session(OUTSIDER))).map((r) => r.id)).toEqual([ID])
    }
    const fresh = missionOf(newMissionId(), {
      sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }]
    })
    expect((await createMission(worktree, session(OUTSIDER), fresh, '')).ok).toBe(true)
    expect(storedAt(mainV4())).toHaveLength(2)
    expect(existsSync(path.join(worktree, '.harnu', 'missions-v4'))).toBe(false)
    expect((await readMissionAs(main, fresh.id, session(OUTSIDER))).ok).toBe(true)
    expect((await listMissionRows(worktree, session(OUTSIDER))).map((r) => r.id).sort()).toEqual(
      [ID, fresh.id].sort()
    )
  })

  it('a refusal from a worktree writes nothing in either folder', async () => {
    const r = await writeMission(worktree, ID, session(OUTSIDER), 'write', link('docs/x.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_ATTACHED')
    expect(existsSync(path.join(worktree, '.harnu'))).toBe(false)
  })
})

describe('one guard and one write path: every refusal is typed, and a change may run twice', () => {
  const link = (ref: string) => (rec: MissionV4, log: string) => ({
    record: { ...rec, links: [...rec.links, { kind: 'doc' as const, ref }] },
    log
  })

  /** Every refusal carries its code both as `code` and at the front of `error`. */
  const expectCode = (r: { ok: boolean; code?: string; error?: string }, code: string): void => {
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(r.error).toMatch(new RegExp(`^${code}:`))
  }

  it('the codes the earlier tests do not pin: READ_ONLY, MISSION_CLOSED, INTERNAL_WORD, BAD_ARGS, WRITE_REFUSED, MISSION_NOT_FOUND, MISSION_UNREADABLE', async () => {
    seed(missionOf(ID))
    seed(missionOf(OTHER, { status: 'closed', closedAs: 'delivered' }))
    expectCode(
      await writeMission(root, ID, { kind: 'worker' }, 'write', link('docs/a.md')),
      'READ_ONLY'
    )
    expectCode(
      await writeMission(root, OTHER, session(LEADER), 'write', link('docs/a.md')),
      'MISSION_CLOSED'
    )
    expectCode(
      await writeMission(root, ID, session(LEADER), 'write', (rec, log) => ({
        record: { ...rec, steps: [{ ...rec.steps[0], title: 'Fix the self-verified step' }] },
        log
      })),
      'INTERNAL_WORD'
    )
    expectCode(
      await writeMission(root, ID, session(LEADER), 'write', (rec, log) => ({
        record: { ...rec, id: 'mnt-bb000009' },
        log
      })),
      'BAD_ARGS'
    )
    expectCode(
      await writeMission(root, ID, session(LEADER), 'write', () => {
        throw new Error('the verb gave up')
      }),
      'WRITE_REFUSED'
    )
    expectCode(
      await writeMission(root, 'mnt-ffffffff', session(LEADER), 'write', link('docs/a.md')),
      'MISSION_NOT_FOUND'
    )
    writeFileSync(path.join(v4Dir(), 'mnt-aa0000ff-broken.md'), 'not a mission')
    expectCode(
      await writeMission(root, 'mnt-aa0000ff', session(LEADER), 'write', link('docs/a.md')),
      'MISSION_UNREADABLE'
    )
  })

  it('create: LEADER_NOT_CALLER, MISSION_EXISTS and BAD_ARGS', async () => {
    const mine = missionOf(newMissionId(), {
      sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }]
    })
    expectCode(await createMission(root, session(LEADER), mine, ''), 'LEADER_NOT_CALLER')
    expectCode(
      await createMission(root, session(OUTSIDER), { ...mine, id: 'not-an-id' }, ''),
      'BAD_ARGS'
    )
    expect((await createMission(root, session(OUTSIDER), mine, '')).ok).toBe(true)
    expectCode(await createMission(root, session(OUTSIDER), mine, ''), 'MISSION_EXISTS')
  })

  it('a record that keeps changing under a write is WRITE_CONFLICT, and nothing is lost', async () => {
    const file = seed(missionOf(ID))
    let runs = 0
    const r = await writeMission(root, ID, session(LEADER), 'write', (rec, log) => {
      runs += 1
      // Another process rewrites the record while this change is being computed, every time.
      writeFileSync(
        file,
        buildMissionRecordContent(
          { ...rec, links: [{ kind: 'doc', ref: `docs/other-${runs}.md` }] },
          log
        )
      )
      return link('docs/mine.md')(rec, log)
    })
    expectCode(r, 'WRITE_CONFLICT')
    expect(runs).toBeGreaterThan(1)
  })

  it('a change is a pure function of the record it is given: it runs again on the fresh record and both writers land', async () => {
    const file = seed(missionOf(ID))
    let runs = 0
    const r = await writeMission(root, ID, session(LEADER), 'write', (rec, log) => {
      runs += 1
      if (runs === 1) {
        // The first run is overtaken by another writer.
        writeFileSync(
          file,
          buildMissionRecordContent(
            { ...rec, links: [{ kind: 'doc', ref: 'docs/theirs.md' }] },
            log
          )
        )
      }
      return link('docs/mine.md')(rec, log)
    })
    expect(r.ok).toBe(true)
    expect(runs).toBe(2)
    const stored = parseMissionRecordFile(readFileSync(file, 'utf8')) as MissionV4
    expect(stored.links.map((l) => l.ref)).toEqual(['docs/theirs.md', 'docs/mine.md'])
  })

  it('a refusal on one run does not leak into the next call (no state is kept between calls)', async () => {
    seed(missionOf(ID))
    const bad = await writeMission(root, ID, session(OUTSIDER), 'write', link('docs/a.md'))
    expectCode(bad, 'NOT_ATTACHED')
    const good = await writeMission(root, ID, session(LEADER), 'write', link('docs/a.md'))
    expect(good.ok).toBe(true)
  })
})

describe('one guard and one write path: round 5, the refusals the owner asked for', () => {
  const REPLIER = 'e0e0e0e0-0000-4000-8000-000000000009'
  const acOf = (over: Record<string, unknown> = {}) => ({
    id: 'ac-1',
    text: 'Every reviewer question has an answer',
    by: 'session' as const,
    ...over
  })
  const stepOf = (acs: unknown[], links: unknown[] = [{ kind: 'session', ref: WORKER }]) =>
    ({ id: 'stp-1', title: 'Load the test files', acs, links, blockers: [] }) as never
  const stamp = (by: string) => ({ at: NOW, by, evidence: 'Read the replies' })
  const code = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? 'ok' : r.code)
  const fresh = (over: Partial<MissionV4> = {}): MissionV4 =>
    missionOf(newMissionId(), {
      sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }],
      ...over
    })
  const stored = (id: string): MissionV4 =>
    parseMissionRecordFile(readFileSync(fileOf(id), 'utf8')) as MissionV4
  const write = (
    actor: Actor,
    change: (r: MissionV4) => MissionV4,
    need: 'write' | 'lead' | 'operator' | 'ask-to-attach' = 'write',
    id = ID
  ) => writeMission(root, id, actor, need, (rec, log) => ({ record: change(rec), log }))

  describe('1. a session creates no mission that is already settled or proven', () => {
    it('a stamp on any criterion, in any name, is refused SETTLE_NOT_ALLOWED', async () => {
      for (const by of [OUTSIDER, WORKER, 'operator']) {
        const record = fresh({ steps: [stepOf([acOf({ settled: stamp(by) })], [])] })
        const r = await createMission(root, session(OUTSIDER), record, '')
        expect(code(r), by).toBe('SETTLE_NOT_ALLOWED')
      }
      expect(v4Files()).toEqual([])
    })

    it('a mission that already carries doneWhenVerified is refused OPERATOR_ONLY', async () => {
      const r = await createMission(
        root,
        session(OUTSIDER),
        fresh({ doneWhenVerified: { by: OUTSIDER, at: NOW } }),
        ''
      )
      expect(code(r)).toBe('OPERATOR_ONLY')
      expect(v4Files()).toEqual([])
    })

    it('cross-references and preloaded attach requests are judged on create', async () => {
      const dup = fresh({ steps: [stepOf([acOf()], []), stepOf([acOf()], [])] })
      expect(code(await createMission(root, session(OUTSIDER), dup, ''))).toBe('DUPLICATE_ID')
      const ghost = fresh({
        steps: [{ ...(stepOf([acOf()], []) as object), milestone: 'mls-3' } as never]
      })
      expect(code(await createMission(root, session(OUTSIDER), ghost, ''))).toBe(
        'UNKNOWN_MILESTONE'
      )
      const preloaded = fresh({
        attachRequests: [
          {
            id: 'atr-1',
            missionId: 'mnt-bb000001',
            sessionId: OUTSIDER,
            at: NOW,
            decision: 'allowed'
          }
        ]
      })
      expect(code(await createMission(root, session(OUTSIDER), preloaded, ''))).toBe(
        'LEADER_NOT_CALLER'
      )
      expect(v4Files()).toEqual([])
    })
  })

  describe('2. a settled stamp is append-only for a session', () => {
    beforeEach(() => {
      seed(missionOf(ID, { steps: [stepOf([acOf({ settled: stamp(LEADER) })])] }))
    })
    const withAc = (over: Record<string, unknown> | null, links?: unknown[]) => (r: MissionV4) =>
      ({
        ...r,
        steps: [
          stepOf(
            over === null ? [] : [{ ...r.steps[0].acs[0], ...over }],
            links ?? r.steps[0].links
          )
        ]
      }) as MissionV4

    it('removing a stamp, or changing one, is refused for the one who wrote it and for any other session', async () => {
      const before = v4Snapshot()
      for (const actor of [session(LEADER), session(WORKER)]) {
        expect(code(await write(actor, withAc({ settled: undefined }))), 'removed').toBe(
          'SETTLE_NOT_ALLOWED'
        )
        expect(
          code(
            await write(
              actor,
              withAc({
                settled: {
                  ...stamp(actor.kind === 'session' ? actor.sessionId : ''),
                  evidence: 'Changed my mind'
                }
              })
            )
          ),
          'overwritten'
        ).toBe('SETTLE_NOT_ALLOWED')
        expect(code(await write(actor, withAc(null))), 'criterion dropped').toBe(
          'SETTLE_NOT_ALLOWED'
        )
        expect(code(await write(actor, (r) => ({ ...r, steps: [] }))), 'step dropped').toBe(
          'SETTLE_NOT_ALLOWED'
        )
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('only an operator write removes or changes one', async () => {
      expect(code(await write(operator, withAc({ settled: stamp('operator') }), 'operator'))).toBe(
        'ok'
      )
      expect(stored(ID).steps[0].acs[0].settled?.by).toBe('operator')
      expect(code(await write(operator, withAc({ settled: undefined }), 'operator'))).toBe('ok')
      expect(stored(ID).steps[0].acs[0].settled).toBeUndefined()
    })

    it('a builder cannot drop its own link and settle in one write', async () => {
      seed(missionOf(ID, { steps: [stepOf([acOf()])] }))
      const r = await write(session(WORKER), withAc({ settled: stamp(WORKER) }, []))
      expect(code(r)).toBe('SETTLE_NOT_ALLOWED')
    })

    it('a session never changes the by, fact or person of a criterion that exists', async () => {
      const before = v4Snapshot()
      for (const over of [
        { by: 'operator' },
        { by: 'person', person: 'the designer' },
        { by: 'fact', fact: 'pr-merged' },
        { fact: 'ci-green' },
        { person: 'someone' }
      ]) {
        const r = await write(session(LEADER), withAc(over))
        expect(code(r), JSON.stringify(over)).toBe('SETTLE_NOT_ALLOWED')
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('a session cannot turn an operator criterion into its own and settle it', async () => {
      seed(missionOf(ID, { steps: [stepOf([acOf({ by: 'operator' })])] }))
      const r = await write(session(LEADER), withAc({ by: 'session', settled: stamp(LEADER) }))
      expect(code(r)).toBe('SETTLE_NOT_ALLOWED')
    })

    it('a stamp written back unchanged by an unrelated write is not judged again', async () => {
      const r = await write(session(WORKER), (rec) => ({
        ...rec,
        links: [{ kind: 'doc', ref: 'docs/x.md' }]
      }))
      expect(code(r)).toBe('ok')
    })
  })

  describe('3. a session never writes doneWhenVerified', () => {
    it('is the operator’s field', async () => {
      seed(missionOf(ID))
      const r = await write(session(LEADER), (rec) => ({
        ...rec,
        doneWhenVerified: { by: LEADER, at: NOW }
      }))
      expect(code(r)).toBe('OPERATOR_ONLY')
      expect(
        code(
          await write(
            operator,
            (rec) => ({ ...rec, doneWhenVerified: { by: 'operator', at: NOW } }),
            'operator'
          )
        )
      ).toBe('ok')
    })
  })

  describe('4. an attach request carries no role', () => {
    beforeEach(() => {
      seed(missionOf(ID))
    })
    const ask = (req: Record<string, unknown>) =>
      write(
        session(OUTSIDER),
        (rec) => ({ ...rec, attachRequests: [req] }) as MissionV4,
        'ask-to-attach'
      )
    const base = { id: 'atr-1', missionId: ID, sessionId: OUTSIDER, at: NOW, decision: null }

    it('any role key is refused: leads as LEADER_IS_OPERATORS, anything else as BAD_ARGS', async () => {
      expect(code(await ask({ ...base, role: 'leads' }))).toBe('LEADER_IS_OPERATORS')
      expect(code(await ask({ ...base, role: 'worked' }))).toBe('BAD_ARGS')
      expect(code(await ask({ ...base, role: 'anything' }))).toBe('BAD_ARGS')
      expect(code(await ask(base))).toBe('ok')
      expect(stored(ID).attachRequests?.[0]).not.toHaveProperty('role')
    })

    it('an asker never drops or changes an earlier request, and never names another mission', async () => {
      const earlier = {
        id: 'atr-1',
        missionId: ID,
        sessionId: REPLIER,
        at: NOW,
        decision: null
      }
      seed(missionOf(ID, { attachRequests: [earlier] }))
      const before = v4Snapshot()
      const attempts: Array<[string, Record<string, unknown>[], string]> = [
        ['dropped', [], 'OPERATOR_ONLY'],
        ['changed', [{ ...earlier, at: '2026-11-15T00:00:00Z' }], 'OPERATOR_ONLY'],
        [
          'another mission',
          [
            earlier,
            { id: 'atr-2', missionId: OTHER, sessionId: OUTSIDER, at: NOW, decision: null }
          ],
          'NOT_ATTACHED'
        ]
      ]
      for (const [name, requests, want] of attempts) {
        const r = await write(
          session(OUTSIDER),
          (rec) => ({ ...rec, attachRequests: requests }) as MissionV4,
          'ask-to-attach'
        )
        expect(code(r), name).toBe(want)
      }
      expect(v4Snapshot()).toEqual(before)
    })

    it('asking to attach to a closed mission is MISSION_CLOSED', async () => {
      seed(missionOf(ID, { status: 'closed', closedAs: 'delivered' }))
      expect(code(await ask(base))).toBe('MISSION_CLOSED')
    })
  })

  describe('5. a worked session never dispatches', () => {
    it('appending a worked entry is NOT_LEADER for a worker, and fine for the leader', async () => {
      seed(missionOf(ID))
      const added = { id: OUTSIDER, role: 'worked' as const, from: NOW, to: null }
      const asWorker = await write(session(WORKER), (rec) => ({
        ...rec,
        sessions: [...rec.sessions, added]
      }))
      expect(code(asWorker)).toBe('NOT_LEADER')
      const asLeader = await write(session(LEADER), (rec) => ({
        ...rec,
        sessions: [...rec.sessions, added]
      }))
      expect(code(asLeader)).toBe('ok')
    })
  })

  describe('6. Harnu writes under its own name', () => {
    it('the guard treats it as the operator, and the result names it harnu, never the operator', async () => {
      seed(missionOf(ID))
      const harnu: Actor = { kind: 'harnu' }
      for (const need of ['read', 'write', 'lead', 'operator', 'ask-to-attach'] as const) {
        const r = guardMission(missionOf(ID), harnu, need)
        expect(r.ok && r.standing, need).toBe('harnu')
      }
      const change = (rec: MissionV4): MissionV4 => ({
        ...rec,
        sessions: [
          ...rec.sessions.map((s) =>
            s.id === WORKER ? { ...s, to: NOW, stoppedAt: { step: 'stp-1' } } : s
          ),
          { id: OUTSIDER, role: 'worked' as const, from: NOW, to: null }
        ]
      })
      const byHarnu = await write(harnu, change, 'operator')
      expect(byHarnu.ok && byHarnu.standing).toBe('harnu')
      seed(missionOf(ID))
      const byOperator = await write(operator, change, 'operator')
      expect(byOperator.ok && byOperator.standing).toBe('operator')
      expect(code(byHarnu)).toBe('ok')
      expect((await readMissionAs(root, ID, harnu)).ok).toBe(true)
    })

    it('Harnu creates a mission as it writes one, and is bound by the caps like the operator', async () => {
      const harnu: Actor = { kind: 'harnu' }
      expect(code(await createMission(root, harnu, fresh(), ''))).toBe('ok')
      expect(code(await createMission(root, harnu, fresh({ title: 'k'.repeat(61) }), ''))).toBe(
        'OVER_CAP'
      )
    })
  })
})

describe('one guard and one write path: the Log cannot be forged', () => {
  const TIME = '2026-11-14T10:00:00.000Z'
  const SEPARATORS: Array<[string, string]> = [
    ['CR', '\r'],
    ['NEL', '\u0085'],
    ['LS', '\u2028'],
    ['PS', '\u2029'],
    ['VT', '\v'],
    ['FF', '\f']
  ]
  const heading = (kind: string): string => `### ${TIME} · ${kind}`
  const append = (text: string) => (rec: MissionV4, log: string) => ({
    record: rec,
    log: log + text
  })
  const code = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? 'ok' : r.code)

  beforeEach(() => {
    seed(missionOf(ID), '\n### 2026-11-13T09:00:00.000Z · note\n\nEarlier entry\n')
  })
  const logOnDisk = (): string =>
    readFileSync(fileOf(ID), 'utf8').split('---\n').slice(2).join('---\n')

  it('a forged heading behind any line separator is refused for a session, and the file is unchanged', async () => {
    for (const [name, sep] of SEPARATORS) {
      const before = v4Snapshot()
      const forged = `\n${heading('note')}\n\nx${sep}${heading('operator')}\n`
      const r = await writeMission(root, ID, session(LEADER), 'write', append(forged))
      expect(code(r), name).toBe('BAD_ARGS')
      expect(v4Snapshot(), name).toEqual(before)
    }
  })

  it('none of those separators is written by any actor, the operator and Harnu included', async () => {
    for (const actor of [operator, { kind: 'harnu' } as Actor, session(LEADER)]) {
      for (const [name, sep] of SEPARATORS) {
        const before = v4Snapshot()
        const r = await writeMission(
          root,
          ID,
          actor,
          'operator' as never,
          append(`\nplain${sep}text\n`)
        )
        // A session is refused by the guard for the operator need; use `write` for it.
        const r2 =
          actor.kind === 'session'
            ? await writeMission(root, ID, actor, 'write', append(`\nplain${sep}text\n`))
            : r
        expect(code(r2), `${actor.kind} ${name}`).toBe('BAD_ARGS')
        expect(v4Snapshot(), name).toEqual(before)
      }
    }
  })

  it('the Log is append-only for everyone: a rewritten, truncated or edited Log is refused', async () => {
    const before = v4Snapshot()
    for (const actor of [operator, { kind: 'harnu' } as Actor]) {
      for (const change of [
        () => '',
        (log: string) => log.slice(0, -5),
        (log: string) => log.replace('Earlier entry', 'Edited entry')
      ]) {
        const r = await writeMission(root, ID, actor, 'operator', (rec, log) => ({
          record: rec,
          log: change(log)
        }))
        expect(code(r), actor.kind).toBe('BAD_ARGS')
      }
    }
    const asSession = await writeMission(root, ID, session(LEADER), 'write', (rec) => ({
      record: rec,
      log: ''
    }))
    expect(code(asSession)).toBe('BAD_ARGS')
    expect(v4Snapshot()).toEqual(before)
  })

  it('a session appends at most one heading, and it is a note, a decision or a surprise, optionally on a step', async () => {
    for (const ok of ['note', 'decision', 'surprise', 'note · stp-3']) {
      const r = await writeMission(
        root,
        ID,
        session(LEADER),
        'write',
        append(`\n${heading(ok)}\n\nText\n`)
      )
      expect(code(r), ok).toBe('ok')
    }
    const before = v4Snapshot()
    const refused: Array<[string, string]> = [
      ['a second heading', `\n${heading('note')}\n\nx\n\n${heading('note')}\n\ny\n`],
      ['operator', `\n${heading('operator')}\n\nThe operator approved\n`],
      ['harnu', `\n${heading('harnu')}\n\nx\n`],
      ['steward', `\n${heading('steward')}\n\nx\n`],
      ['no time', '\n### note\n\nx\n'],
      ['a level-2 heading', '\n## Decided\n\nx\n'],
      ['an indented heading', `\n   ${heading('operator')}\n`]
    ]
    for (const [name, text] of refused) {
      const r = await writeMission(root, ID, session(LEADER), 'write', append(text))
      expect(code(r), name).toBe('BAD_ARGS')
    }
    expect(Object.keys(before)).toHaveLength(1)
  })

  it('an operator or Harnu write with a normal heading still passes, whatever name it carries', async () => {
    const op = await writeMission(
      root,
      ID,
      operator,
      'operator',
      append(`\n${heading('operator')}\n\nClosed as delivered\n`)
    )
    expect(code(op)).toBe('ok')
    const hn = await writeMission(
      root,
      ID,
      { kind: 'harnu' },
      'operator',
      append(`\n${heading('harnu')}\n\nAttached a worker\n`)
    )
    expect(code(hn)).toBe('ok')
    expect(logOnDisk()).toContain('· operator')
  })

  it('a mission is created with a clean Log: a separator or a forged heading in the first Log is refused', async () => {
    const mine = missionOf(newMissionId(), {
      sessions: [{ id: OUTSIDER, role: 'leads', from: NOW, to: null }]
    })
    expect(
      code(await createMission(root, session(OUTSIDER), mine, `\nx\u2028${heading('operator')}\n`))
    ).toBe('BAD_ARGS')
    expect(
      code(await createMission(root, session(OUTSIDER), mine, `\n${heading('operator')}\n`))
    ).toBe('BAD_ARGS')
    expect(
      code(await createMission(root, session(OUTSIDER), mine, `\n${heading('note')}\n\nFirst\n`))
    ).toBe('ok')
  })
})
