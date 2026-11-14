/**
 * Missions v4 · S-15 · AC-38 and AC-39 — attaching a session, and the mission's history of sessions.
 *
 * Attaching needs the operator's confirmation in exactly two cases: a session asks to join, and the
 * pane's picker attaches a session. Both attach it as `worked`; nothing attaches a session as the
 * leader (only the operator's hand-off changes who leads, spec amendment C3-32). It needs none when a
 * session creates the mission (it leads it) or for dispatched work, which is attached as a worker on its
 * step. The history keeps role, from, to and where each session stopped, and only grows.
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
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildMissionRecordContent,
  type AttachRequest,
  type MissionV4,
  type SessionEntry
} from '../src/main/missions/model'
import { decideAttachRequest } from '../src/main/missions/doors'
import {
  appendWorked,
  attachDispatchedWorker,
  attachFromPicker,
  endSession,
  releaseEntry,
  sessionHistory
} from '../src/main/missions/sessions'
import { createMission, newMissionId, writeMission } from '../src/main/missions/write'
import { readMissionRecord } from '../src/main/missions/record-store'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const ASKER = 'a5a5a5a5-0000-4000-8000-0000000000a5'
const PICKED = 'b6b6b6b6-0000-4000-8000-0000000000b6'
const DISPATCHED = 'c7c7c7c7-0000-4000-8000-0000000000c7'
const OUTSIDER = 'e0e0e0e0-0000-4000-8000-000000000001'

const ID = 'mnt-a7000001'
const NOW = '2026-11-14T10:00:00Z'
const AT = '2026-11-14T12:00:00.000Z'
const LATER = '2026-11-14T13:00:00.000Z'

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
      },
      {
        id: 'stp-2',
        title: 'Show the score',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: [],
        waitsFor: 'the sample export'
      }
    ],
    sessions: [{ id: LEADER, role: 'leads', from: NOW, to: null }],
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
const fileText = (): string => readFileSync(path.join(v4Dir(), v4Files()[0]), 'utf8')

function seed(record: MissionV4, log = '# Log\n'): void {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(
    path.join(v4Dir(), `${record.id}-score-report.md`),
    buildMissionRecordContent(record, log)
  )
}

async function reread(id = ID): Promise<{ record: MissionV4; log: string }> {
  const r = await readMissionRecord(root, id)
  if (!r.ok) throw new Error(r.error)
  return { record: r.record, log: r.log }
}

const pending = (id: string, sessionId: string): AttachRequest => ({
  id,
  missionId: ID,
  sessionId,
  at: NOW,
  decision: null
})

const leaders = (r: MissionV4): SessionEntry[] =>
  r.sessions.filter((s) => s.role === 'leads' && s.to === null)

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-attach-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('attach needs confirmation except for the creator and dispatched workers', () => {
  describe('a session asks to join', () => {
    it('the request alone attaches nothing: the session stays out until the operator allows it', async () => {
      seed(missionOf())
      const asked = await writeMission(
        root,
        ID,
        { kind: 'session', sessionId: ASKER },
        'ask-to-attach',
        (rec, log) => ({
          record: {
            ...rec,
            attachRequests: [...(rec.attachRequests ?? []), pending('atr-1', ASKER)]
          },
          log
        })
      )
      expect(asked.ok).toBe(true)
      const { record } = await reread()
      expect(record.sessions.map((s) => s.id)).toEqual([LEADER])
      expect(record.attachRequests).toHaveLength(1)
      // And still outside: it cannot write the mission.
      const write = await writeMission(
        root,
        ID,
        { kind: 'session', sessionId: ASKER },
        'write',
        (rec, log) => ({
          record: { ...rec, links: [{ kind: 'doc', ref: 'x.md' }] },
          log
        })
      )
      expect(write.ok).toBe(false)
      if (!write.ok) expect(write.code).toBe('NOT_ATTACHED')
    })

    it('a session cannot attach itself by writing its own entry', async () => {
      seed(missionOf())
      const r = await writeMission(
        root,
        ID,
        { kind: 'session', sessionId: ASKER },
        'ask-to-attach',
        (rec, log) => ({
          record: {
            ...rec,
            sessions: [...rec.sessions, { id: ASKER, role: 'worked', from: AT, to: null }]
          },
          log
        })
      )
      expect(r.ok).toBe(false)
      expect((await reread()).record.sessions.map((s) => s.id)).toEqual([LEADER])
    })

    it('allowed: the session joins as a worker, and can then write', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1', ASKER)] }))
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'allowed', at: AT })
      const { record } = await reread()
      expect(record.sessions.at(-1)).toEqual({
        id: ASKER,
        role: 'worked',
        from: AT,
        to: null,
        stoppedAt: null
      })
      const write = await writeMission(
        root,
        ID,
        { kind: 'session', sessionId: ASKER },
        'write',
        (rec, log) => ({
          record: { ...rec, links: [{ kind: 'doc', ref: 'x.md' }] },
          log
        })
      )
      expect(write.ok).toBe(true)
    })

    it('denied: the session stays out and still cannot write', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1', ASKER)] }))
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'denied', at: AT })
      const { record } = await reread()
      expect(record.sessions.map((s) => s.id)).toEqual([LEADER])
      const write = await writeMission(
        root,
        ID,
        { kind: 'session', sessionId: ASKER },
        'write',
        (rec, log) => ({
          record: rec,
          log
        })
      )
      expect(write.ok).toBe(false)
    })

    it('allowing a request never makes the session lead, even when nobody leads', async () => {
      seed(
        missionOf({
          sessions: [{ id: LEADER, role: 'leads', from: NOW, to: '2026-11-14T11:00:00Z' }],
          attachRequests: [pending('atr-1', ASKER)]
        })
      )
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'allowed', at: AT })
      const { record } = await reread()
      expect(record.sessions.find((s) => s.id === ASKER)?.role).toBe('worked')
      expect(leaders(record)).toEqual([])
    })

    it('a session that is already attached is not attached twice', async () => {
      seed(missionOf({ attachRequests: [pending('atr-1', LEADER)] }))
      await decideAttachRequest(root, ID, { requestId: 'atr-1', decision: 'allowed', at: AT })
      const { record } = await reread()
      expect(record.sessions).toHaveLength(1)
      expect(record.sessions[0].role).toBe('leads')
    })
  })

  describe('the pane’s picker attaches a session', () => {
    it('attaches it as a worker, with one Log entry', async () => {
      seed(missionOf())
      const r = await attachFromPicker(root, ID, { sessionId: PICKED, at: AT })
      expect(r.ok).toBe(true)
      const { record, log } = await reread()
      expect(record.sessions.at(-1)).toEqual({
        id: PICKED,
        role: 'worked',
        from: AT,
        to: null,
        stoppedAt: null
      })
      expect(log).toMatch(/### 2026-11-14T12:00:00\.000Z · operator attached/)
    })

    it('never makes it the leader, whether or not anyone leads', async () => {
      seed(missionOf({ sessions: [] }))
      await attachFromPicker(root, ID, { sessionId: PICKED, at: AT })
      const { record } = await reread()
      expect(record.sessions.map((s) => s.role)).toEqual(['worked'])
      expect(leaders(record)).toEqual([])
    })

    it('the sitting leader picked again stays the leader and is not duplicated', async () => {
      seed(missionOf())
      const r = await attachFromPicker(root, ID, { sessionId: LEADER, at: AT })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.changed).toBe(false)
      expect((await reread()).record.sessions).toEqual(missionOf().sessions)
    })
  })

  describe('a session that creates the mission leads it, with no confirmation', () => {
    it('it is attached as the leader at once, with no request', async () => {
      const id = newMissionId()
      const record = missionOf({
        id,
        sessions: [{ id: ASKER, role: 'leads', from: AT, to: null }]
      })
      const r = await createMission(root, { kind: 'session', sessionId: ASKER }, record, '# Log\n')
      expect(r.ok).toBe(true)
      const { record: stored } = await reread(id)
      expect(leaders(stored).map((s) => s.id)).toEqual([ASKER])
      expect(stored.attachRequests ?? []).toEqual([])
    })
  })

  describe('dispatched work is attached as a worker on its step, with no confirmation', () => {
    it('the leader’s dispatch attaches the session as a worker and links it to the step', async () => {
      seed(missionOf())
      const r = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-1',
        actor: { kind: 'session', sessionId: LEADER },
        at: AT
      })
      expect(r.ok).toBe(true)
      const { record } = await reread()
      expect(record.sessions.at(-1)).toEqual({
        id: DISPATCHED,
        role: 'worked',
        from: AT,
        to: null,
        stoppedAt: null
      })
      expect(record.steps[0].links).toContainEqual({ kind: 'session', ref: DISPATCHED })
      expect(record.attachRequests ?? []).toEqual([])
    })

    it('a dispatch by the app (a manifest or a board dispatch) attaches it the same way', async () => {
      seed(missionOf())
      const r = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-2',
        actor: { kind: 'operator' },
        at: AT
      })
      expect(r.ok).toBe(true)
      expect((await reread()).record.steps[1].links).toContainEqual({
        kind: 'session',
        ref: DISPATCHED
      })
    })

    it('a dispatched session is a worker and never the leader, with a leader or without one', async () => {
      seed(
        missionOf({
          sessions: [{ id: LEADER, role: 'leads', from: NOW, to: '2026-11-14T11:00:00Z' }]
        })
      )
      await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-1',
        actor: { kind: 'operator' },
        at: AT
      })
      const { record } = await reread()
      expect(record.sessions.find((s) => s.id === DISPATCHED)?.role).toBe('worked')
      expect(leaders(record)).toEqual([])
    })

    it('the sitting leader named as the dispatched session keeps its role and gets no second entry', async () => {
      seed(missionOf())
      await attachDispatchedWorker(root, ID, {
        sessionId: LEADER,
        stepId: 'stp-1',
        actor: { kind: 'operator' },
        at: AT
      })
      const { record } = await reread()
      expect(record.sessions).toHaveLength(1)
      expect(record.sessions[0].role).toBe('leads')
      expect(leaders(record)).toHaveLength(1)
    })

    it('only the leader dispatches: a worker is NOT_LEADER, an outsider NOT_ATTACHED, and nothing is written', async () => {
      seed(
        missionOf({
          sessions: [...missionOf().sessions, { id: WORKER, role: 'worked', from: NOW, to: null }]
        })
      )
      const before = fileText()
      const asWorker = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-1',
        actor: { kind: 'session', sessionId: WORKER },
        at: AT
      })
      expect(asWorker.ok).toBe(false)
      if (!asWorker.ok) expect(asWorker.code).toBe('NOT_LEADER')
      const asOutsider = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-1',
        actor: { kind: 'session', sessionId: OUTSIDER },
        at: AT
      })
      expect(asOutsider.ok).toBe(false)
      if (!asOutsider.ok) expect(asOutsider.code).toBe('NOT_ATTACHED')
      expect(fileText()).toBe(before)
    })

    it('an unknown step is NOT_FOUND and attaches nobody', async () => {
      seed(missionOf())
      const before = fileText()
      const r = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-9',
        actor: { kind: 'operator' },
        at: AT
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_FOUND')
      expect(fileText()).toBe(before)
    })

    it('an old step id of a converted record finds its step and the result names the new one', async () => {
      seed(missionOf({ legacyV3: { stepIds: { 'stp-5': 'stp-2' } } }))
      const r = await attachDispatchedWorker(root, ID, {
        sessionId: DISPATCHED,
        stepId: 'stp-5',
        actor: { kind: 'operator' },
        at: AT
      })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stepId).toBe('stp-2')
      expect((await reread()).record.steps[1].links).toContainEqual({
        kind: 'session',
        ref: DISPATCHED
      })
    })

    it('dispatching the same session twice to a step keeps one entry and one link', async () => {
      seed(missionOf())
      const args = {
        sessionId: DISPATCHED,
        stepId: 'stp-1',
        actor: { kind: 'operator' } as const,
        at: AT
      }
      await attachDispatchedWorker(root, ID, args)
      const again = await attachDispatchedWorker(root, ID, args)
      expect(again.ok).toBe(true)
      const { record } = await reread()
      expect(record.sessions.filter((s) => s.id === DISPATCHED)).toHaveLength(1)
      expect(record.steps[0].links.filter((l) => l.ref === DISPATCHED)).toHaveLength(1)
    })
  })

  describe('there is at most one leader', () => {
    it('a second open leader is refused by the one write path, whoever writes', async () => {
      seed(missionOf())
      for (const actor of [
        { kind: 'operator' } as const,
        { kind: 'session', sessionId: LEADER } as const
      ]) {
        const r = await writeMission(
          root,
          ID,
          actor,
          actor.kind === 'operator' ? 'operator' : 'lead',
          (rec, log) => ({
            record: {
              ...rec,
              sessions: [...rec.sessions, { id: PICKED, role: 'leads', from: AT, to: null }]
            },
            log
          })
        )
        expect(r.ok, actor.kind).toBe(false)
      }
      expect(leaders((await reread()).record)).toHaveLength(1)
    })
  })

  describe('a v3 file is never modified by an attach', () => {
    const V3_ID = 'mnt-5c0de001'
    const v3Dir = (): string => path.join(root, '.harnu', 'missions')
    const v3Hashes = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(v3Dir()).map((n) => [n, sha(readFileSync(path.join(v3Dir(), n)))])
      )

    it('the picker, a dispatch and an end each write the v4 record only', async () => {
      cpSync(path.join(FIXTURES, 'missions'), v3Dir(), { recursive: true })
      cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
        recursive: true
      })
      const before = v3Hashes()
      const read = await readMissionRecord(root, V3_ID)
      if (!read.ok) throw new Error(read.error)
      const stepId = read.record.steps[0].id
      expect((await attachFromPicker(root, V3_ID, { sessionId: PICKED, at: AT })).ok).toBe(true)
      expect(
        (
          await attachDispatchedWorker(root, V3_ID, {
            sessionId: DISPATCHED,
            stepId,
            actor: { kind: 'operator' },
            at: AT
          })
        ).ok
      ).toBe(true)
      expect((await endSession(root, V3_ID, { sessionId: PICKED, at: LATER })).ok).toBe(true)
      expect(v3Hashes()).toEqual(before)
      expect(v4Files().some((n) => n.startsWith(V3_ID))).toBe(true)
    })
  })
})

describe('the mission remembers its sessions', () => {
  it('each entry keeps role, from, to and where it stopped, and survives a re-read', async () => {
    seed(missionOf())
    await attachDispatchedWorker(root, ID, {
      sessionId: DISPATCHED,
      stepId: 'stp-2',
      actor: { kind: 'operator' },
      at: AT
    })
    await endSession(root, ID, { sessionId: DISPATCHED, at: LATER })
    const { record } = await reread()
    expect(sessionHistory(record)).toEqual([
      { id: LEADER, role: 'leads', from: NOW, to: null, stoppedAt: null, open: true },
      {
        id: DISPATCHED,
        role: 'worked',
        from: AT,
        to: LATER,
        // The step it was on comes from its link; what it was waiting for from the step.
        stoppedAt: { step: 'stp-2', waitingFor: 'the sample export' },
        open: false
      }
    ])
  })

  it('the caller may say where a session stopped, and that wins over what the record says', async () => {
    seed(missionOf())
    await endSession(root, ID, {
      sessionId: LEADER,
      at: AT,
      step: 'stp-1',
      waitingFor: 'the operator to merge the pull request'
    })
    const { record } = await reread()
    expect(record.sessions[0]).toMatchObject({
      to: AT,
      stoppedAt: { step: 'stp-1', waitingFor: 'the operator to merge the pull request' }
    })
  })

  it('a session that ends or is released gets its to and stoppedAt, a session with no step gets an empty one', async () => {
    seed(missionOf())
    await endSession(root, ID, { sessionId: LEADER, at: AT })
    const { record, log } = await reread()
    expect(record.sessions[0].to).toBe(AT)
    expect(record.sessions[0].stoppedAt).toEqual({})
    expect(log).toContain(`### ${AT} · session ${LEADER} ended`)
  })

  it('history only grows: ending twice keeps the first to, a re-attach is a new row, no row is removed', async () => {
    seed(missionOf())
    await attachFromPicker(root, ID, { sessionId: PICKED, at: AT })
    await endSession(root, ID, { sessionId: PICKED, at: LATER, step: 'stp-1' })
    const second = await endSession(root, ID, {
      sessionId: PICKED,
      at: '2026-11-14T14:00:00.000Z',
      step: 'stp-2'
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.changed).toBe(false)
    await attachFromPicker(root, ID, { sessionId: PICKED, at: '2026-11-14T15:00:00.000Z' })
    const { record } = await reread()
    const rows = record.sessions.filter((s) => s.id === PICKED)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ from: AT, to: LATER, stoppedAt: { step: 'stp-1' } })
    expect(rows[1]).toMatchObject({ from: '2026-11-14T15:00:00.000Z', to: null })
    expect(record.sessions[0].id).toBe(LEADER)
  })

  it('ending a session the mission does not hold changes nothing', async () => {
    seed(missionOf())
    const before = fileText()
    const r = await endSession(root, ID, { sessionId: OUTSIDER, at: AT })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.changed).toBe(false)
    expect(fileText()).toBe(before)
  })

  it('the pure helpers keep earlier rows byte for byte', () => {
    const rows: SessionEntry[] = [
      {
        id: LEADER,
        role: 'leads',
        from: NOW,
        to: '2026-11-14T09:00:00Z',
        stoppedAt: { step: 'stp-1' }
      },
      { id: LEADER, role: 'leads', from: '2026-11-14T09:00:00Z', to: null }
    ]
    const added = appendWorked(rows, WORKER, AT)
    expect(added.slice(0, 2)).toEqual(rows)
    expect(added[2]).toEqual({ id: WORKER, role: 'worked', from: AT, to: null, stoppedAt: null })
    const released = releaseEntry(added, WORKER, LATER, { step: 'stp-2' })
    expect(released.slice(0, 2)).toEqual(rows)
    expect(released[2]).toMatchObject({ to: LATER, stoppedAt: { step: 'stp-2' } })
    // Already closed: left as it is.
    expect(releaseEntry(released, WORKER, '2027-01-01T00:00:00Z')).toEqual(released)
    // Already open: not added again.
    expect(appendWorked(added, WORKER, LATER)).toEqual(added)
  })
})
