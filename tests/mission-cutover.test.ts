// @vitest-environment jsdom
/**
 * Missions v4 · S-35 · AC-83 — the cut-over: every record opens in the pane.
 *
 * Until now a v3 record was served by the v3 stack (its pill opened the popover, `isV3Mission` chose) and
 * only a v4 record opened the pane. After this slice the pill, the sidebar chip, an Activity row, a Your
 * move card and the keyboard action all open the Mission pane for every record. The view reads a v3 record as
 * v4 without writing; the first door use on one creates its v4 copy and leaves the v3 file byte-identical; a
 * v3-shaped verb on it is refused with the way out. Nothing is lost on the upgrade: the cue keys and the Your
 * move keys of a v3 mission are the ones main filed (covered beside this file in `mission-activity.test.ts`
 * and `mission-readers-v4.test.ts`, which this slice keeps green).
 *
 * The renderer half mounts the real pill and stores with `window.api` faked; the main half runs the real
 * modules against a temporary repo that holds the v3 compatibility fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { classifyReply, v4MissionOf } from '../src/renderer/src/lib/mission-pane-view'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'
import { toolByName } from '../src/main/mcp/tool-catalog'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { parseToolInput } from '../src/main/mcp/validate'
import { runDoor } from '../src/main/missions/doors'
import { readMissionRecord } from '../src/main/missions/record-store'
import {
  SUMMARY_ROUTE_MAX,
  defaultSummaryRouteDeps,
  summaryRoute
} from '../src/main/missions/summary-route'
import { playNotificationSound } from '../src/renderer/src/lib/notification-sound'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

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

// The fleet scan reads the real ~/.claude/projects: keep the tests off it.
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const STRANGER = 'e0e0e0e0-0000-4000-8000-000000000001'
const V3_ID = 'mnt-5c0de001'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ===========================================================================================================
// Main: the view, the list, the summary and the door, on a repo that holds v3 files
// ===========================================================================================================

let root = ''
let ud = ''
const v3Dir = (): string => path.join(root, '.harnu', 'missions')
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')

function seedV3(): void {
  cpSync(path.join(FIXTURES, 'missions'), v3Dir(), { recursive: true })
  cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
    recursive: true
  })
}

/** Every file under the v3 directories, bytes and mtime. */
function v3Tree(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dir of [v3Dir(), path.join(root, '.harnu', 'campaigns')]) {
    if (!existsSync(dir)) continue
    for (const n of readdirSync(dir)) {
      const f = path.join(dir, n)
      out[`${path.basename(dir)}/${n}`] = `${sha(readFileSync(f))}@${statSync(f).mtimeMs}`
    }
  }
  return out
}

/** Every file and directory of the repo's `.harnu`, so "wrote nothing" means nothing. */
function repoTree(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (sub: string): void => {
    for (const e of readdirSync(path.join(root, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir'
        walk(rel)
      } else
        out[rel] =
          `${sha(readFileSync(path.join(root, rel)))}@${statSync(path.join(root, rel)).mtimeMs}`
    }
  }
  if (existsSync(path.join(root, '.harnu'))) walk('.harnu')
  return out
}

beforeAll(() => {
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'harnu-cutover-ud-'))
  ud = h.userDataDir
})
afterAll(() => rmSync(ud, { recursive: true, force: true }))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-cutover-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** One MCP call the way it arrives (catalog schema, gate, then the wired handler). */
type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
async function mcp(
  op: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string }> {
  const mod = await import('../src/main/mcp/tool-handlers')
  const handler = mod.WIRED_TOOLS.find((t) => t.op === op)?.handler as unknown as Handler
  const def = toolByName(op as never)!
  const parsed = def.inputSchema.safeParse({ folder: root, ...args })
  if (!parsed.success) return { isError: true, text: `SCHEMA: ${parsed.error.message}` }
  const input = parsed.data as Record<string, unknown>
  const gate = parseToolInput(op as never, buildPlanInput(op as never, input, root))
  if (!gate.ok) return { isError: true, text: `GATE: ${JSON.stringify(gate)}` }
  const res = await handler(input, {
    folder: root,
    folders: [],
    denyFolders: [],
    bridge: undefined
  })
  return { isError: res.isError === true, text: res.content[0]?.text ?? '' }
}

describe('every record opens in the pane and the v3 file stays', () => {
  it('the first door use on a v3 mission creates its v4 copy and leaves every v3 byte alone; a v3-shaped verb is then refused with the way out', async () => {
    seedV3()
    const before = v3Tree()
    expect(existsSync(v4Dir())).toBe(false)

    // The view reads it as v4 and writes nothing.
    const ipc = await import('../src/main/mission-ipc')
    const viewed = await ipc.buildMissionV4View({
      folder: root,
      sessionId: LEADER,
      missionId: V3_ID
    })
    expect(viewed).toMatchObject({ state: 'mission', source: 'v3-mission' })
    expect(existsSync(v4Dir())).toBe(false)

    // The first door use converts it by copy.
    const door = await runDoor({
      folder: root,
      missionId: V3_ID,
      door: 'close',
      closedAs: 'discarded'
    })
    expect(door.ok, JSON.stringify(door)).toBe(true)
    const copy = await readMissionRecord(root, V3_ID)
    expect(copy.ok && copy.source).toBe('v4')
    expect(readdirSync(v4Dir()).some((n) => n.startsWith(V3_ID))).toBe(true)
    expect(v3Tree()).toEqual(before)

    // A v3-shaped verb on it is refused with the way out, and writes nothing in either format.
    const afterDoor = repoTree()
    const refused = await mcp('mission_set_end', {
      missionId: V3_ID,
      declaredEnd: { kind: 'code', target: 'a new end', evidence: 'something' },
      reason: 'it changed'
    })
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toMatch(/^MISSION_IS_V4:/)
    expect(refused.text).toContain('mission_set_done_when')
    expect(repoTree()).toEqual(afterDoor)
    expect(v3Tree()).toEqual(before)
  })

  it('a session that leads several v3 missions is shown one of them, the most recently written, never an error', async () => {
    seedV3()
    // Everything is old, except the delivered mission, which was written last.
    const old = new Date('2026-01-01T00:00:00Z')
    for (const dir of [v3Dir(), path.join(root, '.harnu', 'campaigns')]) {
      for (const n of readdirSync(dir)) utimesSync(path.join(dir, n), old, old)
    }
    const newest = path.join(v3Dir(), 'mnt-5c0de003-delivered-pending-close.md')
    utimesSync(newest, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))
    const before = repoTree()

    const ipc = await import('../src/main/mission-ipc')
    const reply = await ipc.buildMissionV4View({ folder: root, sessionId: LEADER })
    expect(reply).toMatchObject({ state: 'mission', missionId: 'mnt-5c0de003' })
    // It wrote nothing: no v4 record, no sidecar.
    expect(repoTree()).toEqual(before)
    expect(existsSync(v4Dir())).toBe(false)
  })

  it('the list names an unreadable v4 file instead of skipping it', async () => {
    mkdirSync(v4Dir(), { recursive: true })
    writeFileSync(path.join(v4Dir(), 'mnt-d0000009-broken.md'), 'not a mission record\n')
    const ipc = await import('../src/main/mission-ipc')
    const list = await ipc.listMissionViews([root])
    expect(list.unreadable).toContain('mnt-d0000009-broken.md')
  })

  it('the summary after a compaction reaches the leader of a v3 mission, and writes nothing', async () => {
    seedV3()
    const before = repoTree()
    const out = await summaryRoute(
      { session_id: LEADER, cwd: root, source: 'compact' },
      defaultSummaryRouteDeps()
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(SUMMARY_ROUTE_MAX)
    expect(repoTree()).toEqual(before)
    // A stranger still gets nothing.
    expect(
      await summaryRoute(
        { session_id: STRANGER, cwd: root, source: 'compact' },
        defaultSummaryRouteDeps()
      )
    ).toBe('')
  })
})

// ===========================================================================================================
// Renderer: the pill, the chip, the popover that is no longer reachable
// ===========================================================================================================

const FOLDER = '/repo'
const SESSION = 'sess-1'

function reply(
  over: { source?: 'v4' | 'v3-mission' | 'v3-campaign'; id?: string; title?: string } = {}
): MissionV4ViewReply {
  const id = over.id ?? 'mnt-0a1b2c3d'
  return {
    state: 'mission',
    missionId: id,
    source: over.source ?? 'v3-mission',
    detail: {
      ok: true,
      id,
      title: over.title ?? 'Legacy rollout',
      doneWhen: '',
      status: 'open',
      state: 'open',
      stateLabel: 'Open',
      standing: 'operator',
      leads: SESSION,
      source: over.source ?? 'v3-mission',
      progress: {
        unit: 'steps',
        total: 5,
        done: 2,
        headline: 'unused',
        current: null,
        allDone: false,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [],
      steps: [],
      next: null,
      waiting: {
        items: [{ id: 'w0' }],
        next: null,
        more: [],
        moreLine: null,
        people: [],
        peopleLine: null,
        peopleLines: []
      },
      summary: '',
      links: [],
      blockers: [],
      sessions: []
    },
    closeWarnings: [],
    pendingDoneWhen: null,
    sessions: [
      {
        id: SESSION,
        role: 'leads',
        from: '2026-11-14T10:00:00.000Z',
        to: null,
        stoppedAt: null,
        open: true
      }
    ],
    handoff: { offer: false }
  } as unknown as MissionV4ViewReply
}

let viewReply: MissionV4ViewReply
let unreadable: string[]
let wrapper: VueWrapper | null = null

function install(): void {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable, shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: vi.fn(async (a: { missionId?: string }) =>
      a.missionId || viewReply.state !== 'none'
        ? viewReply
        : {
            state: 'none',
            missions: [
              { id: 'mnt-0a1b2c3d', title: 'Legacy rollout', headline: '', leads: SESSION }
            ]
          }
    ),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
}

function selectSession(): void {
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER }] }
  ] as never
  sessions.select(SESSION)
}

async function mountPill(): Promise<VueWrapper> {
  selectSession()
  const w = mount(MissionPill, {
    props: { sessionId: SESSION },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await flushPromises()
  await flushPromises()
  return w
}

const panes = (): string[] => useHelpersStore().panesForCurrentWorktree.map((p) => p.type)

describe('the pill opens the pane for a v3 record', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
    localStorage.clear()
    unreadable = []
    viewReply = reply()
    install()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('classifies a v3 record as a mission the pane draws', () => {
    for (const source of ['v3-mission', 'v3-campaign'] as const) {
      const r = reply({ source })
      expect(classifyReply(r, SESSION), source).toBe('mission')
      expect(v4MissionOf(r, SESSION), source).not.toBeNull()
    }
  })

  it('reads the v4 numbers, toggles the pane on click, and never opens a popover', async () => {
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('2/5 · 1 for you')
    const ui = useUiStore()
    const button = w.get('button')
    await button.trigger('click')
    expect(panes()).toEqual(['mission'])
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(ui.popovers.missionProgress).toBe(false)
    await button.trigger('click')
    expect(panes()).toEqual([])
    expect(ui.popovers.missionProgress).toBe(false)
  })

  it('the keyboard action toggles the pane for a v3 record too', async () => {
    await mountPill()
    const ui = useUiStore()
    ui.togglePopover('missionProgress')
    await flushPromises()
    expect(panes()).toEqual(['mission'])
    expect(ui.popovers.missionProgress).toBe(false)
  })

  it('an Activity row names the mission and opens its pane, not a popover', async () => {
    await mountPill()
    const ui = useUiStore()
    ui.openNavigableView('mission', { missionId: 'mnt-0a1b2c3d' })
    await flushPromises()
    expect(panes()).toEqual(['mission'])
    expect(ui.popovers.missionProgress).toBe(false)
    expect(useMissionsStore().popoverRequest).toBeNull()
  })

  it('no live path reaches a popover any more', () => {
    const src = (p: string): string => readFileSync(path.join(__dirname, '..', p), 'utf8')
    const pill = src('src/renderer/src/components/MissionPill.vue')
    expect(pill).not.toMatch(/import\s+\w*Popover\w*\s+from/)
    expect(pill).not.toMatch(/consumePopoverRequest|popoverRequest/)
    const card = src('src/renderer/src/components/YourMoveCard.vue')
    expect(card).not.toMatch(/isV3Mission|requestPopover/)
    expect('isV3Mission' in useMissionsStore()).toBe(false)
  })
})

describe('the chip, the pane choice and the unreadable-file notice read every record', () => {
  const OWNER = SESSION
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
    localStorage.clear()
    localStorage.setItem('om2tab.missionCues', JSON.stringify({ v: 1, owed: {} }))
    vi.mocked(playNotificationSound).mockClear()
    unreadable = []
    viewReply = reply()
    install()
    selectSession()
  })

  it('the chip of a v3 mission is the pill text, not the v3 headline', async () => {
    const store = useMissionsStore()
    await store.refresh()
    expect(store.chipFor(OWNER)?.text).toBe('2/5 · 1 for you')
    expect(store.chipFor(OWNER)?.compact).toBe('2/5 · 1 for you')
  })

  it('a session that leads several missions can choose which one the pane follows', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api.missionV4View = vi.fn(
      async (a: { missionId?: string }) => {
        if (a.missionId) return reply({ id: a.missionId, title: `Mission ${a.missionId}` })
        return {
          state: 'none',
          missions: [
            { id: 'mnt-0a1b2c3d', title: 'Legacy rollout', headline: '', leads: OWNER },
            { id: 'mnt-0e0e0e0e', title: 'Older rollout', headline: '', leads: OWNER }
          ]
        }
      }
    )
    const store = useMissionsStore()
    await store.refresh()
    expect(store.ledMissionsFor(OWNER).map((m) => m.id)).toEqual(['mnt-0a1b2c3d', 'mnt-0e0e0e0e'])
    await store.chooseMission(OWNER, 'mnt-0e0e0e0e')
    const asked = (window.api as unknown as { missionV4View: ReturnType<typeof vi.fn> })
      .missionV4View
    expect(asked).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: OWNER, missionId: 'mnt-0e0e0e0e' })
    )
    expect(store.v4MissionForSession(OWNER)?.missionId).toBe('mnt-0e0e0e0e')
  })

  it('an unreadable mission file raises one Activity notice that names it, once, and clears when it is fixed', async () => {
    const store = useMissionsStore()
    const notes = useNotificationsStore()
    unreadable = ['mnt-d0000009-broken.md']
    await store.refresh()
    const records = (): typeof notes.records =>
      notes.records.filter((r) => r.group === 'mission-unreadable')
    expect(records()).toHaveLength(1)
    expect(`${records()[0].title} ${records()[0].description ?? ''}`).toContain(
      'mnt-d0000009-broken.md'
    )
    const ts = records()[0].ts
    // The same file on the next poll is not news: still one entry, same time.
    await store.refresh()
    expect(records()).toHaveLength(1)
    expect(records()[0].ts).toBe(ts)
    // Fixed: the entry goes.
    unreadable = []
    await store.refresh()
    expect(records()).toHaveLength(0)
  })

  it('the upgrade chimes nothing: a v3 mission already owed is not news on the first read', async () => {
    const store = useMissionsStore()
    await store.refresh()
    await store.refresh()
    expect(playNotificationSound).not.toHaveBeenCalled()
  })
})
