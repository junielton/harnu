/**
 * Missions v4 S-34 (AC-82, #d152) — the proactive hint. A session that leads no mission and has
 * started work (two sessions, or a worktree) is told, once, in the ACK of the verb it just called, to
 * start a mission. It is a backstop to the rule in the skills and the awareness doc: Harnu never
 * creates the mission itself, and never stops the call.
 *
 * The three ACKs are driven through the real handlers (`WIRED_TOOLS`), the way every other v4 verb
 * test is; only the electron and git edges are faked.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { promises as fs, readdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { toolByName } from '../src/main/mcp/tool-catalog'
import type { MissionV4 } from '../src/main/missions/model'

const h = vi.hoisted(() => ({ userDataDir: '', created: 0 }))

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
vi.mock('../src/main/worktree-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/worktree-ipc')>()),
  createWorktree: async (_folder: string, branch: string) => ({
    path: `/repo/.claude/worktrees/${branch.replace('/', '-')}`,
    base: 'main',
    branch,
    warnings: []
  })
}))
vi.mock('../src/main/roadmap-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/roadmap-ipc')>()),
  buildManifestDisclosure: async (_folder: string, cards: Array<{ slug: string }>) => ({
    ok: true,
    resolved: cards.map((c) => ({
      slug: c.slug,
      title: c.slug,
      kind: 'feature',
      complexity: 'standard',
      gaps: []
    }))
  }),
  stampManifestApprovals: async (_f: string, _r: unknown, selected: string[]) => ({
    stamped: [...selected],
    failed: []
  })
}))

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const WORKER_B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const WORKER_C = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const WORKER_D = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee'

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>

let repo = ''
let handlers: Record<string, Handler>

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-proactive-ud-'))
})

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-proactive-repo-'))
  h.created = 0
  // A fresh module graph per test: the per-session count lives in the module and resets at boot.
  vi.resetModules()
  const mod = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(mod.WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
})

function ctxOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    folder: repo,
    folders: [],
    denyFolders: [],
    bridge: {
      dispatch: async () => ({ syntheticId: `synthetic-${++h.created}` }),
      awaitMaterialization: async (syntheticId: string) => ({
        syntheticId,
        sessionId: `00000000-0000-4000-8000-${String(h.created).padStart(12, '0')}`,
        folder: repo
      })
    },
    ...extra
  }
}

/** One call the way it arrives: the catalog schema first (it strips what it does not declare). */
async function call(
  op: string,
  args: Record<string, unknown>,
  ctxExtra: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const parsed = toolByName(op as never)!.inputSchema.safeParse({ folder: repo, ...args })
  expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
  const res = await handlers[op](
    (parsed as { data: Record<string, unknown> }).data,
    ctxOf(ctxExtra)
  )
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

const startSession = (sessionId?: string, ctx?: Record<string, unknown>) =>
  call('create_session', sessionId ? { sessionId } : {}, ctx)
const cutWorktree = (sessionId?: string, branch = 'card/T1', ctx?: Record<string, unknown>) =>
  call('create_worktree', { branch, ...(sessionId ? { sessionId } : {}) }, ctx)
const submit = (slugs: string[], sessionId?: string, ctx?: Record<string, unknown>) =>
  call(
    'submit_manifest',
    { cards: slugs.map((slug) => ({ slug })), ...(sessionId ? { sessionId } : {}) },
    ctx
  )

/** The leader of a v4 mission in this repo. */
async function leadAMission(sessionId = LEADER): Promise<string> {
  const out = await call('mission_create', {
    title: 'Export the report as CSV',
    doneWhen: 'The CSV export is merged',
    sessionId,
    steps: [
      {
        title: 'Add the CSV exporter',
        criteria: [{ text: 'The pull request is merged', fact: 'pr-merged' }]
      }
    ]
  })
  return out.id as string
}

/** Change a mission record the way a write does, from outside the handlers. */
async function changeMission(id: string, change: (record: MissionV4) => MissionV4): Promise<void> {
  const { updateMissionRecord } = await import('../src/main/missions/record-store')
  const { repoRoot } = await import('../src/main/data-dir')
  const done = await updateMissionRecord(repoRoot(repo), id, (record, log) => ({
    record: change(record),
    log
  }))
  expect(done.ok, JSON.stringify(done)).toBe(true)
}

const hintOf = (ack: Record<string, unknown>): unknown => ack.missionHint

/** Every mission file under the repo, v3 and v4. */
function missionFiles(): string[] {
  const out: string[] = []
  for (const sub of ['missions', 'missions-v4']) {
    try {
      out.push(...readdirSync(path.join(repo, '.harnu', sub)))
    } catch {
      // no folder, no file
    }
  }
  return out
}

describe('the ack tells a session to start a mission', () => {
  it('a worktree cut by a session that leads no mission gets one short hint naming mission_create', async () => {
    const ack = await cutWorktree(WORKER_A)
    expect(ack.ok).toBe(true)
    const hint = hintOf(ack)
    expect(typeof hint).toBe('string')
    expect(hint as string).toContain('mission_create')
    // One sentence: short, and no explanation of what a mission is.
    expect((hint as string).length).toBeLessThan(220)
    expect((hint as string).match(/[.!?](\s|$)/g)?.length).toBe(1)
  })

  it('a second create_session gets the hint, the first does not', async () => {
    const first = await startSession(WORKER_A)
    expect(first.ok).toBe(true)
    expect(hintOf(first)).toBeUndefined()
    const second = await startSession(WORKER_A)
    expect(second.ok).toBe(true)
    expect(String(hintOf(second))).toContain('mission_create')
  })

  it('a manifest of two cards gets the hint at once; a manifest of one counts toward the two', async () => {
    expect(String(hintOf(await submit(['T1', 'T2'], WORKER_A)))).toContain('mission_create')
    expect(hintOf(await submit(['T3'], WORKER_B))).toBeUndefined()
    expect(String(hintOf(await startSession(WORKER_B)))).toContain('mission_create')
  })

  it('the hint is given once per session, not on every later call', async () => {
    expect(hintOf(await cutWorktree(WORKER_A, 'card/T1'))).toBeDefined()
    expect(hintOf(await cutWorktree(WORKER_A, 'card/T2'))).toBeUndefined()
    expect(hintOf(await startSession(WORKER_A))).toBeUndefined()
    expect(hintOf(await startSession(WORKER_A))).toBeUndefined()
    // Another session is counted on its own.
    expect(hintOf(await cutWorktree(WORKER_B, 'card/T3'))).toBeDefined()
  })

  it('a session that leads a mission never gets it', async () => {
    await leadAMission(LEADER)
    expect(hintOf(await cutWorktree(LEADER))).toBeUndefined()
    await startSession(LEADER)
    expect(hintOf(await startSession(LEADER))).toBeUndefined()
    expect(hintOf(await submit(['T1', 'T2'], LEADER))).toBeUndefined()
  })

  it('a session attached to a mission as a worker never gets it', async () => {
    const id = await leadAMission(LEADER)
    // The same open `worked` entry a step dispatch writes for the session it starts.
    await changeMission(id, (record) => ({
      ...record,
      sessions: [
        ...record.sessions,
        { id: WORKER_A, role: 'worked', from: new Date().toISOString(), to: null, stoppedAt: null }
      ]
    }))
    expect(hintOf(await cutWorktree(WORKER_A))).toBeUndefined()
  })

  it('a mission that is closed does not exempt its former leader', async () => {
    const id = await leadAMission(LEADER)
    await changeMission(id, (record) => ({ ...record, status: 'closed' }))
    expect(hintOf(await cutWorktree(LEADER))).toBeDefined()
  })

  it('a session Harnu spawned for a step (a scoped bearer) and a steward are never hinted', async () => {
    const scoped = {
      caller: {
        kind: 'scoped',
        scope: {
          role: 'worker',
          sessionId: WORKER_C,
          folder: repo,
          missionId: 'mnt-00000001',
          stepId: 'stp-1'
        }
      }
    }
    expect(hintOf(await cutWorktree(undefined, 'card/T1', scoped))).toBeUndefined()
    await startSession(undefined, scoped)
    expect(hintOf(await startSession(undefined, scoped))).toBeUndefined()
    const steward = { caller: { kind: 'steward', workerId: 'w-1', missionId: 'mnt-00000001' } }
    expect(hintOf(await cutWorktree(undefined, 'card/T2', steward))).toBeUndefined()
  })

  it('a caller that does not say who it is is counted as one anonymous caller of the repo', async () => {
    // Nobody leads a mission here: the first worktree is hinted.
    expect(hintOf(await cutWorktree(undefined, 'card/T1'))).toBeDefined()
    expect(hintOf(await cutWorktree(undefined, 'card/T2'))).toBeUndefined()
  })

  it('an anonymous caller is left alone in a repo where a mission is led (it may be that leader)', async () => {
    await leadAMission(LEADER)
    expect(hintOf(await cutWorktree(undefined, 'card/T1'))).toBeUndefined()
    await startSession()
    expect(hintOf(await startSession())).toBeUndefined()
  })

  it('a bad sessionId is refused, not silently counted', async () => {
    const parsed = toolByName('create_worktree' as never)!.inputSchema.safeParse({
      folder: repo,
      branch: 'card/T1',
      sessionId: 'not-a-uuid'
    })
    const res = parsed.success
      ? await handlers.create_worktree(parsed.data as Record<string, unknown>, ctxOf())
      : null
    // Either the schema or the handler refuses; neither may hint or cut on a made-up id.
    expect(res === null || res.isError === true).toBe(true)
  })

  it('it is a backstop only: Harnu writes no mission and the call still does what it was asked', async () => {
    const before = missionFiles()
    const ack = await cutWorktree(WORKER_D)
    expect(hintOf(ack)).toBeDefined()
    expect(ack.path).toBe('/repo/.claude/worktrees/card-T1')
    await startSession(WORKER_D)
    const second = await startSession(WORKER_D)
    expect((second.result as Record<string, unknown>).sessionId).toBeDefined()
    expect(missionFiles()).toEqual(before)
    expect(missionFiles()).toEqual([])
  })

  it('the hint field is one name, built in one place, on all three ACKs', async () => {
    const a = await cutWorktree(WORKER_A)
    const b = await submit(['T1', 'T2'], WORKER_B)
    await startSession(WORKER_C)
    const c = await startSession(WORKER_C)
    expect(hintOf(a)).toBe(hintOf(b))
    expect(hintOf(b)).toBe(hintOf(c))
  })
})
