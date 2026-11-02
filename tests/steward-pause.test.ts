/**
 * Campaign ch.5b (T609, spec §3.4) — "Pause steward…" is a MISSION door, not a worker switch:
 *  - it takes a mandatory reason and writes a `steward` Log entry;
 *  - the You list carries `steward-paused` until the operator resumes;
 *  - a paused steward does not tick (the gate, the wake and the 20-minute beat);
 *  - it is an operator door: no MCP verb reaches it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyPauseSteward,
  applyResumeSteward,
  createMissionFile,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'
import { stewardBlockedReason } from '../src/main/steward-core'
import { youItems } from '../src/main/mcp/tool-handlers'
import { computeProgress } from '../src/main/mission-progress'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const AT = '2026-11-02T15:00:00.000Z'
const ID = 'mnt-00000609'

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: ID,
    slug: 'pause-it',
    folder: '/repo',
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Build it',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-11-02T10:00:00.000Z' },
    ...over
  }
}

describe('applyPauseSteward / applyResumeSteward (pure)', () => {
  it('pauses with a trimmed reason and the time, and resumes', () => {
    const paused = applyPauseSteward(mission(), '  CI is flaky today  ', { at: AT })
    expect(paused.stewardPause).toEqual({ at: AT, reason: 'CI is flaky today' })
    expect(paused.updatedAt).toBe(AT)
    const resumed = applyResumeSteward(paused, { at: AT })
    expect(resumed.stewardPause).toBeUndefined()
  })

  it('refuses a missing reason (BAD_ARGS), a second pause and a resume when not paused', () => {
    expect(() => applyPauseSteward(mission(), '   ', { at: AT })).toThrow(/^BAD_ARGS/)
    const paused = applyPauseSteward(mission(), 'why', { at: AT })
    expect(() => applyPauseSteward(paused, 'again', { at: AT })).toThrow(/^ALREADY_PAUSED/)
    expect(() => applyResumeSteward(mission(), { at: AT })).toThrow(/^NOT_PAUSED/)
  })

  it('refuses on a closed mission', () => {
    expect(() => applyPauseSteward(mission({ status: 'closed' }), 'r', { at: AT })).toThrow(
      /^MISSION_CLOSED/
    )
  })

  it('is pure: the input mission is untouched', () => {
    const m = mission()
    applyPauseSteward(m, 'r', { at: AT })
    expect(m.stewardPause).toBeUndefined()
  })
})

describe('the You list', () => {
  it('carries a steward-paused item (with the reason and time) until resumed', () => {
    const paused = applyPauseSteward(mission(), 'CI is flaky', { at: AT })
    const progress = computeProgress(paused, [], Date.parse(AT))
    const items = youItems(paused, [], progress)
    expect(items).toContainEqual({ kind: 'steward-paused', reason: 'CI is flaky', at: AT })
    const resumed = applyResumeSteward(paused, { at: AT })
    expect(
      youItems(resumed, [], computeProgress(resumed, [], Date.parse(AT))).map((i) => i.kind)
    ).not.toContain('steward-paused')
  })
})

describe('a paused steward does not tick', () => {
  const on = { serverEnabled: true, folderDenied: false }
  it('names STEWARD_PAUSED with the reason', () => {
    expect(stewardBlockedReason({ ...on, paused: { reason: 'CI is flaky' } })).toMatch(
      /STEWARD_PAUSED.*CI is flaky/
    )
  })
  it('the global kill-switches still win over a pause', () => {
    expect(
      stewardBlockedReason({ serverEnabled: false, folderDenied: false, paused: { reason: 'x' } })
    ).toMatch(/SERVER_DISABLED/)
  })
  it('not paused (or no pause argument) runs', () => {
    expect(stewardBlockedReason(on)).toBeNull()
    expect(stewardBlockedReason({ ...on, paused: null })).toBeNull()
  })
})

describe('the door through mission:operatorDoor', () => {
  let root: string
  let ipc: typeof import('../src/main/mission-ipc')
  const onDisk = async (): Promise<{ m: Mission; log: string }> => {
    const name = (await fs.readdir(missionsDir(root))).find((n) => n.startsWith(`${ID}-`))!
    const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
    return { m: parseMissionFile(raw) as Mission, log: readMissionLog(raw) }
  }

  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pause-ud-'))
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-pause-'))
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    vi.resetModules()
    ipc = await import('../src/main/mission-ipc')
    await createMissionFile(root, mission(), '# Pause it\n')
  })

  it('pause writes stewardPause and a `steward` Log entry carrying the reason', async () => {
    const res = await ipc.runOperatorDoor(
      { door: 'pauseSteward', root, missionId: ID, reason: 'CI is flaky today' },
      () => AT
    )
    expect(res.ok).toBe(true)
    const { m, log } = await onDisk()
    expect(m.stewardPause).toEqual({ at: AT, reason: 'CI is flaky today' })
    expect(log).toMatch(/### 2026-11-02T15:00:00\.000Z · steward · operator paused the steward/)
    expect(log).toContain('CI is flaky today')
  })

  it('pause without a reason is refused and writes nothing', async () => {
    for (const reason of [undefined, '', '   ']) {
      const res = await ipc.runOperatorDoor(
        { door: 'pauseSteward', root, missionId: ID, reason },
        () => AT
      )
      expect(res.ok).toBe(false)
    }
    expect((await onDisk()).m.stewardPause).toBeUndefined()
  })

  it('resume clears the pause and logs it as a `steward` entry', async () => {
    await ipc.runOperatorDoor({ door: 'pauseSteward', root, missionId: ID, reason: 'r' }, () => AT)
    const res = await ipc.runOperatorDoor({ door: 'resumeSteward', root, missionId: ID }, () => AT)
    expect(res.ok).toBe(true)
    const { m, log } = await onDisk()
    expect(m.stewardPause).toBeUndefined()
    expect(log).toMatch(/· steward · operator resumed the steward/)
  })

  it('a pause survives a read → write by another door (the schema keeps it)', async () => {
    await ipc.runOperatorDoor({ door: 'pauseSteward', root, missionId: ID, reason: 'r' }, () => AT)
    await ipc.runOperatorDoor(
      { door: 'addCheck', root, missionId: ID, stepId: 'stp-1', label: 'Looks right' },
      () => AT
    )
    expect((await onDisk()).m.stewardPause?.reason).toBe('r')
  })
})
