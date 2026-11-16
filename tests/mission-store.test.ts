/**
 * Missions v4 S-2 (AC-3) — one mission store. The verbs (`mission_list`, `mission_get`, which read a v3
 * file through the v4 record store), the renderer IPC (`listMissionViews`: no v3 view any more, S-40) and hibernation
 * (`missionOwnersWithLiveChildren`) all read mission files through `src/main/missions/store.ts`,
 * so one repo, with one fixture, gives the same answer to each of them: the shadow copy of a mission
 * in a second clone loses to the newer copy, and a delivered mission still has its leader.
 *
 * Driven against real temp repos; electron and the fleet scan are mocked the way the IPC suites do.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { V3Mission } from '../src/main/missions/v3-read'
import { v3MissionsDir, writeV3Mission } from './helpers/v3-mission-file'

type Mission = V3Mission

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

const STALE_LEADER = '11111111-2222-4333-8444-555555555555'
const LEADER = '8f2c1e4a-1111-4222-8333-944455556666'
const CHILD = '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff'
const STALE_CHILD = '5b6a7c8d-2222-4333-8444-a55566667777'
const LONE_LEADER = 'c0ffee00-3333-4444-8555-666677778888'
const LONE_CHILD = 'd00dfeed-4444-4555-8666-777788889999'

/** M_SHADOW: clone A holds an older active copy, clone B the newer delivered one. */
const M_SHADOW = 'mnt-00000a01'
/** M_CLOSED: clone A holds an older active copy, clone B the newer closed one. */
const M_CLOSED = 'mnt-00000a02'
/** M_LONE: only clone A has it; active, with a live child. */
const M_LONE = 'mnt-00000a03'

const OLD = '2026-10-01T10:00:00.000Z'
const NEW = '2026-11-01T10:00:00.000Z'

function mission(
  id: string,
  root: string,
  over: Partial<Mission> = {},
  childRef?: string
): Mission {
  return {
    id,
    slug: `m-${id.slice(4)}`,
    folder: root,
    owner: { sessionId: STALE_LEADER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'a slice shipped', evidence: 'merged PRs' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Build the slice',
        verification: 'verifier',
        proof: 'unproven',
        links: childRef ? [{ kind: 'session', ref: childRef }] : [],
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
    createdAt: OLD,
    updatedAt: OLD,
    provenance: { author: 'agent', at: OLD },
    ...over
  }
}

async function writeMission(root: string, m: Mission): Promise<void> {
  writeV3Mission(root, m, `# ${m.slug}\n`)
}

async function fakeClone(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-store-'))
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  return root
}

/**
 * A v3 campaign file naming both missions, as a record on disk. The campaign code is gone (S-39), so it
 * is plain text; the store's readers must keep working with such a file beside the missions.
 */
async function seedCampaign(id: string, root: string): Promise<void> {
  const dir = path.join(root, '.harnu', 'campaigns')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${id}-two-chapters.md`),
    [
      '---',
      `id: ${id}`,
      'slug: two-chapters',
      `folder: ${root}`,
      'owner:',
      `  sessionId: ${LEADER}`,
      `  folder: ${root}`,
      'title: Two chapters',
      'declaredEnd:',
      '  kind: code',
      '  target: both chapters live',
      '  evidence: merged PRs',
      'chapters:',
      '  - id: chp-1',
      '    ordinal: 1',
      '    title: Shadowed',
      '    required: true',
      `    missionId: ${M_SHADOW}`,
      '  - id: chp-2',
      '    ordinal: 2',
      '    title: Closed elsewhere',
      '    required: true',
      `    missionId: ${M_CLOSED}`,
      'status: active',
      `createdAt: ${OLD}`,
      `updatedAt: ${OLD}`,
      'provenance:',
      '  author: agent',
      `  at: ${OLD}`,
      '---',
      '# Two chapters',
      ''
    ].join('\n')
  )
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  const first = res.content[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

let cloneA: string
let cloneB: string

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-store-ud-'))
  cloneA = await fakeClone()
  cloneB = await fakeClone()
  // M_SHADOW: A is stale and active under STALE_LEADER; B is newer, delivered, led by LEADER.
  await writeMission(cloneA, mission(M_SHADOW, cloneA, {}, STALE_CHILD))
  await writeMission(
    cloneB,
    mission(
      M_SHADOW,
      cloneB,
      { status: 'delivered', owner: { sessionId: LEADER, folder: cloneB }, updatedAt: NEW },
      CHILD
    )
  )
  // M_CLOSED: A still says active; B closed it as delivered later.
  await writeMission(cloneA, mission(M_CLOSED, cloneA))
  await writeMission(
    cloneB,
    mission(M_CLOSED, cloneB, { status: 'closed', closedAs: 'delivered', updatedAt: NEW })
  )
  // M_LONE: one copy, active, a live child.
  await writeMission(
    cloneA,
    mission(M_LONE, cloneA, { owner: { sessionId: LONE_LEADER, folder: cloneA } }, LONE_CHILD)
  )
  await seedCampaign('cmp-0000000a', cloneA)
})

describe('one reader for every caller', () => {
  it('one reader for every caller', async () => {
    vi.resetModules()
    const store = await import('../src/main/missions/store')
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const { listMissionViews } = await import('../src/main/mission-ipc')
    const { missionOwnersWithLiveChildren } = await import('../src/main/hibernation')
    const verbs: Record<string, Handler> = {}
    for (const t of WIRED_TOOLS) verbs[t.op] = t.handler as unknown as Handler

    // The store's own answer for the repo (both clones), closed missions included.
    const read = await store.readMissionsDeduped([cloneA, cloneB], { includeClosed: true })
    const byId = Object.fromEntries(read.missions.map((m) => [m.mission.id, m]))
    expect(Object.keys(byId).sort()).toEqual([M_SHADOW, M_CLOSED, M_LONE].sort())
    // The newer copy wins; the older one is reported as shadowed, never deleted.
    expect(byId[M_SHADOW].root).toBe(cloneB)
    expect(byId[M_SHADOW].mission.status).toBe('delivered')
    expect(byId[M_CLOSED].mission.status).toBe('closed')
    expect(read.shadowed.map((s) => s.missionId).sort()).toEqual([M_SHADOW, M_CLOSED].sort())
    // A delivered mission still has its leader, and it is the winner's.
    expect(store.leaderOf(byId[M_SHADOW].mission)).toBe(LEADER)

    // Verbs: mission_list reads the same files, per repo, through the v4 reader: a v3 file is listed as the
    // open mission it is, led by its owner, and a closed one is not listed.
    const listFor = async (folder: string): Promise<Array<Record<string, unknown>>> =>
      payloadOf(
        await verbs.mission_list(
          { folder },
          { folder, folders: [{ path: folder }], denyFolders: [], bridge: undefined }
        )
      ).missions as Array<Record<string, unknown>>
    const inA = await listFor(cloneA)
    const inB = await listFor(cloneB)
    // Clone A lists its lone active mission and the campaign file beside the missions, and neither of the
    // two ids that clone B holds a newer copy of: the stale copies lost, and the older reader's rule holds.
    expect(inA.map((r) => r.id)).toContain(M_LONE)
    expect(inA.map((r) => r.id)).not.toContain(M_SHADOW)
    expect(inA.map((r) => r.id)).not.toContain(M_CLOSED)
    expect(inA.find((r) => r.id === M_LONE)).toMatchObject({ leads: LONE_LEADER, format: 'v3' })
    expect(inA.find((r) => r.title === 'Two chapters')).toMatchObject({
      leads: LEADER,
      format: 'v3'
    })
    // Clone B lists the delivered mission under the leader of the newer copy, and not the closed one.
    expect(inB.map((r) => r.id)).toEqual([M_SHADOW])
    expect(inB[0]).toMatchObject({ leads: LEADER, format: 'v3' })
    // Verbs: the leader of a delivered mission is found by its session id.
    const got = payloadOf(
      await verbs.mission_get(
        { folder: cloneB, sessionId: LEADER },
        { folder: cloneB, folders: [], denyFolders: [], bridge: undefined }
      )
    )
    expect(got).toMatchObject({ id: M_SHADOW, source: 'v3-mission', leads: LEADER })

    // IPC: the poll answers no v3 view any more (S-40); it still names the shadowed copies, and a file
    // it could not read would be named in `unreadable`.
    const { views, unreadable, shadowed } = await listMissionViews([cloneA, cloneB])
    expect(views).toEqual([])
    expect(unreadable).toEqual([])
    expect(shadowed.map((s) => s.missionId).sort()).toEqual([M_SHADOW, M_CLOSED].sort())

    // Hibernation: only the winner of an id counts. The winner of M_SHADOW is delivered, which v4 reads
    // as ready to close, so its leader is pinned (S-23, AC-62: "ready to close included"; it was not
    // before). Its stale active twin in clone A lost, so STALE_LEADER pins nobody; the lone active
    // mission still pins its leader.
    const cold = (sessionKey: string, cwd: string): { sessionKey: string; cwd: string } => ({
      sessionKey,
      cwd
    })
    const owners = missionOwnersWithLiveChildren([
      cold(STALE_LEADER, cloneA),
      cold(STALE_CHILD, cloneA),
      cold(LEADER, cloneB),
      cold(CHILD, cloneB),
      cold(LONE_LEADER, cloneA),
      cold(LONE_CHILD, cloneA)
    ])
    expect([...owners].sort()).toEqual([LEADER, LONE_LEADER].sort())
  }, 30_000)
})

describe('the store', () => {
  it('the synchronous read gives the same missions as the asynchronous one', async () => {
    vi.resetModules()
    const store = await import('../src/main/missions/store')
    const a = await store.readMissionsDeduped([cloneA, cloneB], { includeClosed: true })
    const s = store.readMissionsDedupedSync([cloneA, cloneB], { includeClosed: true })
    const key = (r: typeof a): unknown =>
      r.missions.map((m) => [m.mission.id, m.root, m.file]).sort()
    expect(key(s)).toEqual(key(a))
    expect(s.shadowed).toEqual(a.shadowed)
  })

  it('an unreadable file is reported and the rest are still read', async () => {
    vi.resetModules()
    const store = await import('../src/main/missions/store')
    await fs.writeFile(
      path.join(v3MissionsDir(cloneA), 'mnt-deadbeef-broken.md'),
      '---\nstatus: [\n---\n'
    )
    const read = await store.readMissionsDeduped([cloneA], { includeClosed: true })
    expect(read.unreadable).toEqual([{ root: cloneA, name: 'mnt-deadbeef-broken.md' }])
    expect(read.missions.map((m) => m.mission.id).sort()).toEqual(
      [M_SHADOW, M_CLOSED, M_LONE].sort()
    )
    expect(store.readMissionsDedupedSync([cloneA], { includeClosed: true }).unreadable).toEqual(
      read.unreadable
    )
  })

  it('a closed mission has no leader', async () => {
    vi.resetModules()
    const store = await import('../src/main/missions/store')
    const read = await store.readMissionsDeduped([cloneA, cloneB], { includeClosed: true })
    const closed = read.missions.find((m) => m.mission.id === M_CLOSED)!.mission
    expect(store.leaderOf(closed)).toBeNull()
  })
})
