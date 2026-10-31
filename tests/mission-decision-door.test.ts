/**
 * Campaign spec §3.2 / §4 — the verbs that declare side steps, typed edges and
 * decision nodes (`mission_add_step`, `mission_update_step`), and the operator's
 * Choose door (`applyChooseDecision` → `mission:choose`). No verb can write `chosen`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyChooseDecision,
  createMissionFile,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'

const h = vi.hoisted(() => ({ userDataDir: '', channels: new Map<string, unknown>() }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: unknown): void => {
      h.channels.set(channel, fn)
    },
    on: (): void => {}
  }
}))

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const AT = '2026-10-30T15:00:00.000Z'

function textOf(res: ToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('expected text content')
  return first.text
}
const payloadOf = (res: ToolResult): Record<string, unknown> => {
  expect(res.isError).not.toBe(true)
  return JSON.parse(textOf(res)) as Record<string, unknown>
}
const errText = (res: ToolResult): string => {
  expect(res.isError).toBe(true)
  return textOf(res)
}

function mission(over: Partial<Mission> = {}): Mission {
  const step = (
    id: string,
    n: number,
    extra: Record<string, unknown> = {}
  ): Mission['steps'][0] => ({
    id,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  })
  return {
    id: 'mnt-00000594',
    slug: 'side-quests',
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      step('stp-1', 1),
      step('stp-2', 2, {
        verification: 'human',
        decision: { title: 'Which store?', options: ['SQLite', 'Files'], blocks: ['stp-3'] }
      }),
      step('stp-3', 3),
      { ...step('stp-4', 4, { title: 'Delivered and verified' }), kind: 'fixed-end' }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' },
    ...over
  }
}

async function onDisk(root: string): Promise<{ m: Mission; log: string }> {
  const name = (await fs.readdir(missionsDir(root))).find((n) => n.startsWith('mnt-00000594-'))!
  const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
  return { m: parseMissionFile(raw) as Mission, log: readMissionLog(raw) }
}

let root: string
let handlers: Record<string, Handler>
let ipc: typeof import('../src/main/mission-ipc')

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-decision-ud-'))
  h.channels.clear()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-decision-'))
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = {}
  for (const t of WIRED_TOOLS) handlers[t.op] = t.handler as unknown as Handler
  ipc = await import('../src/main/mission-ipc')
  await createMissionFile(root, mission(), '# Side quests\n')
})

const ctx = (): Record<string, unknown> => ({ folder: root, folders: [], denyFolders: [] })
const add = (extra: Record<string, unknown>): Promise<ToolResult> =>
  handlers.mission_add_step(
    {
      folder: root,
      missionId: 'mnt-00000594',
      title: 'Fix the flaky fixture',
      verification: 'verifier',
      ...extra
    },
    ctx()
  )
const update = (stepId: string, set: Record<string, unknown>): Promise<ToolResult> =>
  handlers.mission_update_step({ folder: root, missionId: 'mnt-00000594', stepId, set }, ctx())

describe('mission_add_step — side step, edges, decision (§3.2)', () => {
  it('stores required, discoveredFrom, edges and decision on the new step', async () => {
    const p = payloadOf(
      await add({
        reason: 'found while wiring stp-1',
        required: false,
        discoveredFrom: 'stp-1',
        edges: [{ kind: 'blocks', to: 'stp-3' }],
        decision: { title: 'Retry or skip?', options: ['Retry', 'Skip'], blocks: ['stp-3'] }
      })
    )
    const step = (await onDisk(root)).m.steps.find((s) => s.id === p.stepId)!
    expect(step.required).toBe(false)
    expect(step.discoveredFrom).toBe('stp-1')
    expect(step.edges).toEqual([{ kind: 'blocks', to: 'stp-3' }])
    expect(step.decision).toEqual({
      title: 'Retry or skip?',
      options: ['Retry', 'Skip'],
      blocks: ['stp-3']
    })
  })

  it('refuses a discoveredFrom, edge target or decision.blocks that is not a step', async () => {
    expect(errText(await add({ reason: 'r', discoveredFrom: 'stp-99' }))).toMatch(/^STEP_NOT_FOUND/)
    expect(errText(await add({ reason: 'r', edges: [{ kind: 'blocks', to: 'stp-99' }] }))).toMatch(
      /^STEP_NOT_FOUND/
    )
    expect(
      errText(
        await add({
          reason: 'r',
          decision: { title: 'T', options: ['a', 'b'], blocks: ['stp-99'] }
        })
      )
    ).toMatch(/^STEP_NOT_FOUND/)
  })

  it('refuses a decision that arrives already chosen (CONTROLLED_FIELD)', async () => {
    const res = await add({
      reason: 'r',
      decision: { title: 'T', options: ['a', 'b'], blocks: [], chosen: 0 }
    })
    expect(errText(res)).toMatch(/^CONTROLLED_FIELD/)
  })

  it('refuses a decision with fewer than two options or an unknown edge kind', async () => {
    expect(
      errText(await add({ reason: 'r', decision: { title: 'T', options: ['only'], blocks: [] } }))
    ).toMatch(/^BAD_ARGS/)
    expect(errText(await add({ reason: 'r', edges: [{ kind: 'depends', to: 'stp-1' }] }))).toMatch(
      /^BAD_ARGS/
    )
  })
})

describe('mission_update_step — the new fields, and chosen is controlled (AC-2c)', () => {
  it('sets required, discoveredFrom and edges', async () => {
    const p = payloadOf(
      await update('stp-3', {
        required: false,
        discoveredFrom: 'stp-1',
        edges: [{ kind: 'validates', to: 'stp-1' }]
      })
    )
    expect(p).toMatchObject({ ok: true, stepId: 'stp-3' })
    expect(p.changed).toEqual(['required', 'discoveredFrom', 'edges'])
    const step = (await onDisk(root)).m.steps.find((s) => s.id === 'stp-3')!
    expect(step).toMatchObject({
      required: false,
      discoveredFrom: 'stp-1',
      edges: [{ kind: 'validates', to: 'stp-1' }]
    })
  })

  it('sets a decision without chosen', async () => {
    payloadOf(
      await update('stp-1', {
        decision: { title: 'Ship it?', options: ['Yes', 'No'], blocks: ['stp-3'] }
      })
    )
    expect((await onDisk(root)).m.steps[0].decision).toEqual({
      title: 'Ship it?',
      options: ['Yes', 'No'],
      blocks: ['stp-3']
    })
  })

  it('{ set: { chosen } } is refused CONTROLLED_FIELD and writes nothing', async () => {
    const before = await onDisk(root)
    expect(errText(await update('stp-2', { chosen: 0 }))).toMatch(/^CONTROLLED_FIELD/)
    expect(
      errText(
        await update('stp-2', {
          decision: { title: 'T', options: ['a', 'b'], blocks: [], chosen: 1 }
        })
      )
    ).toMatch(/^CONTROLLED_FIELD/)
    expect((await onDisk(root)).m).toEqual(before.m)
  })

  it('refuses to make the fixed end a side step, and an edge into the step itself', async () => {
    expect(errText(await update('stp-4', { required: false }))).toMatch(/^FIXED_STEP/)
    expect(errText(await update('stp-3', { edges: [{ kind: 'blocks', to: 'stp-3' }] }))).toMatch(
      /^BAD_ARGS/
    )
  })

  it('refuses to rewrite a decision the operator already made', async () => {
    await ipc.runOperatorDoor(
      { door: 'chooseDecision', root, missionId: 'mnt-00000594', stepId: 'stp-2', index: 0 },
      () => AT
    )
    expect(
      errText(
        await update('stp-2', { decision: { title: 'T', options: ['x', 'y'], blocks: ['stp-3'] } })
      )
    ).toMatch(/^DECISION_CHOSEN/)
  })
})

describe('applyChooseDecision — the operator door (AC-2c)', () => {
  it('writes chosen and bumps updatedAt, leaving the input untouched', () => {
    const m = mission()
    const next = applyChooseDecision(m, 'stp-2', 1, { at: AT })
    expect(next.steps[1].decision?.chosen).toBe(1)
    expect(next.updatedAt).toBe(AT)
    expect(m.steps[1].decision?.chosen).toBeUndefined()
  })

  it('refuses an unknown step, a step with no decision, a bad index, a second choice, a closed mission', () => {
    const m = mission()
    expect(() => applyChooseDecision(m, 'stp-99', 0, { at: AT })).toThrow(/^STEP_NOT_FOUND/)
    expect(() => applyChooseDecision(m, 'stp-1', 0, { at: AT })).toThrow(/^NOT_A_DECISION/)
    expect(() => applyChooseDecision(m, 'stp-2', 2, { at: AT })).toThrow(/^BAD_ARGS/)
    expect(() => applyChooseDecision(m, 'stp-2', -1, { at: AT })).toThrow(/^BAD_ARGS/)
    const chosen = applyChooseDecision(m, 'stp-2', 0, { at: AT })
    expect(() => applyChooseDecision(chosen, 'stp-2', 1, { at: AT })).toThrow(/^ALREADY_CHOSEN/)
    expect(() =>
      applyChooseDecision(mission({ status: 'closed' }), 'stp-2', 0, { at: AT })
    ).toThrow(/^MISSION_CLOSED/)
  })
})

describe('the Choose door through mission-ipc (AC-2c)', () => {
  it('writes chosen, exactly one decision Log entry, and unlocks the blocked step', async () => {
    const res = await ipc.runOperatorDoor(
      { door: 'chooseDecision', root, missionId: 'mnt-00000594', stepId: 'stp-2', index: 1 },
      () => AT
    )
    expect(res).toMatchObject({ ok: true })
    const { m, log } = await onDisk(root)
    expect(m.steps[1].decision?.chosen).toBe(1)
    const entries = log.split('\n').filter((l) => l.startsWith('### '))
    expect(entries).toEqual([`### ${AT} · operator chose "Files"`])
    expect(log).toMatch(/kind: decision/)
    if (res.ok && res.view) {
      expect(res.view.progress.states['stp-3']).toBe('todo')
      expect(res.view.progress.states['stp-2']).toBe('done')
    }
  })

  it('before the choice the blocked step reads locked in the view', async () => {
    const { views } = await ipc.listMissionViews([root])
    expect(views[0].progress.states).toMatchObject({ 'stp-2': 'todo', 'stp-3': 'locked' })
  })

  it('answers a bad index as { ok: false } and writes nothing', async () => {
    const before = await onDisk(root)
    const res = await ipc.runOperatorDoor(
      { door: 'chooseDecision', root, missionId: 'mnt-00000594', stepId: 'stp-2', index: 7 },
      () => AT
    )
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/^BAD_ARGS.*index/) })
    expect(await onDisk(root)).toEqual(before)
  })

  it('registers the mission:choose channel, which runs the same door', async () => {
    ipc.registerMissionIpc()
    const choose = h.channels.get('mission:choose') as (
      e: unknown,
      a: unknown
    ) => Promise<{ ok: boolean }>
    expect(typeof choose).toBe('function')
    const res = await choose(null, { root, missionId: 'mnt-00000594', stepId: 'stp-2', index: 0 })
    expect(res.ok).toBe(true)
    expect((await onDisk(root)).m.steps[1].decision?.chosen).toBe(0)
  })
})
