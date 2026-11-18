// @vitest-environment jsdom
/**
 * Missions v4 · S-37 · AC-86, AC-87 — the old surfaces are gone, and the pane is the only mission surface.
 *
 * Until S-35 a v3 record was served by the mission and campaign popovers, the step rail, the Missions
 * review and bulk-close dialogs, the steward pause dialog and the Scheduler's steward block. Since the
 * cut-over nothing reaches them: every record opens in the pane. This slice deletes them, so there is
 * nothing to keep unreachable code honest about.
 *
 * Every name this file greps for is built from parts, so the guard does not match itself. A fault planted
 * by restoring one deleted file, one i18n key or one store member turns the matching test red.
 *
 * The second half is the upgrade: what an operator with v3 missions on disk sees after the surfaces go.
 * The steward is retired (S-27), so "the steward is paused" is no longer something the operator owes: the
 * waiting list stops deriving it on read, without writing a mission file, and the Your move card filed
 * for it before the upgrade closes by itself instead of being stranded. No other item, card or chime
 * changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SchedulerView from '../src/renderer/src/components/SchedulerView.vue'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import type { Worker } from '../src/preload'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { V3Mission } from '../src/main/missions/v3-read'
import { missionGet } from '../src/main/missions/verbs-read'
import { emptyState, type YourMoveState } from '../src/main/your-move/core'
import { readRecordViews, reconcileMissions } from '../src/main/your-move/source-mission'
import { writeV3Mission } from './helpers/v3-mission-file'

type Mission = V3Mission

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')
const join = (...p: string[]): string => p.join('')

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

// ---- the names of what is removed, in parts -------------------------------------------------------------

/** The Vue components that are gone (under `src/renderer/src/components`). */
const REMOVED_COMPONENTS = [
  join('Mission', 'Popover'),
  join('Campaign', 'Popover'),
  join('MissionsReview', 'Dialog'),
  join('MissionBulkClose', 'ConfirmDialog'),
  join('StewardPause', 'Dialog'),
  join('Scheduler', 'Stewards'),
  join('MissionStep', 'Rail'),
  join('MissionStep', 'Glyph')
]

/** Every other file that is gone, repo-relative. */
const REMOVED_FILES = [
  ...REMOVED_COMPONENTS.map((n) => `src/renderer/src/components/${n}.vue`),
  join('src/renderer/src/lib/campaign', '-view.ts'),
  join('src/renderer/src/lib/steward', '-view.ts'),
  join('src/renderer/src/stores/', 'campaigns.ts'),
  join('src/main/campaign', '-ipc.ts'),
  join('tests/helpers/Legacy', 'MissionPill.vue')
]

/** What no source, test or script may still name: a module path or a symbol of a removed surface. */
const REMOVED_NAMES = [
  ...REMOVED_COMPONENTS,
  join('campaign', '-view'),
  join('steward', '-view'),
  join('stores/', 'campaigns'),
  join('campaign', '-ipc'),
  join('use', 'CampaignsStore'),
  join('campaign', 'List'),
  join('Legacy', 'MissionPill')
]

/** Store members that only the popover and the review dialog used. */
const REMOVED_STORE_MEMBERS = [
  join('request', 'Popover'),
  join('consume', 'PopoverRequest'),
  join('clear', 'PopoverRequest'),
  join('popover', 'Request'),
  join('Popover', 'Request'),
  join('POPOVER_REQUEST', '_TTL_MS'),
  join('missions.open', 'Review'),
  join('store.open', 'Review'),
  join('consume', 'ReviewRequest'),
  join('\\.review', 'Request'),
  join('Review', 'Request')
]

/**
 * i18n subtrees of the removed surfaces (every leaf under each prefix is gone from both locales). A key a
 * live surface still uses is not here: `mission.end.*` is the close dialog's, `mission.you.*` the waiting
 * sentences', `mission.cue.*` the Activity cue's, `missionPane.*` the pane's.
 */
const REMOVED_KEY_PREFIXES = [
  'campaign',
  'scheduler.stewards',
  'mission.added',
  'mission.addedCaption',
  'mission.approveRescope',
  'mission.back',
  'mission.blocked',
  'mission.blockedBody',
  'mission.blockerOwner',
  'mission.bulk',
  'mission.checks',
  'mission.child',
  'mission.close',
  'mission.cue.reviewAll',
  'mission.decision',
  'mission.end.open',
  'mission.endCaption',
  'mission.gates',
  'mission.header',
  'mission.ledger',
  'mission.markVerified',
  'mission.now',
  'mission.openQuestions',
  'mission.pillTitle',
  'mission.pillTitleWithPulse',
  'mission.pr',
  'mission.progress',
  'mission.proof',
  'mission.pulse',
  'mission.rescopeBadge',
  'mission.rescopeTitle',
  'mission.review',
  'mission.side',
  'mission.stale',
  'mission.staleBody',
  'mission.state',
  'mission.steward',
  'mission.sub',
  'mission.unmark',
  'mission.verification',
  'mission.verifiedByYou',
  'mission.verifiedCaption',
  'mission.visual',
  'mission.was',
  'mission.you.clear',
  'mission.you.stewardPaused',
  'mission.you.label'
]

function gitGrep(pattern: string, pathspec: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-nE', pattern, '--', ...pathspec], {
      cwd: ROOT,
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] // git grep exits 1 when nothing matches
  }
}

function leafKeys(o: unknown, prefix = '', out: string[] = []): string[] {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) leafKeys(v, prefix ? `${prefix}.${k}` : k, out)
  } else out.push(prefix)
  return out
}

const SELF = 'tests/mission-old-surfaces-removed.test.ts'
const notSelf = (hit: string): boolean => !hit.startsWith(`${SELF}:`)

// ==========================================================================================================
// AC-86
// ==========================================================================================================

describe('nothing of the old surfaces is left', () => {
  it('no file of a removed surface exists', () => {
    expect(REMOVED_FILES.filter((f) => existsSync(path.join(ROOT, f)))).toEqual([])
  })

  it('nothing in the sources, the tests or the dev scripts names a removed module or symbol', () => {
    const hits = gitGrep(`\\b(${REMOVED_NAMES.join('|')})\\b`, ['src', 'tests', 'scripts']).filter(
      notSelf
    )
    expect(hits).toEqual([])
  })

  it('no store member of the popover request or the review request is left', () => {
    const hits = gitGrep(`\\b(${REMOVED_STORE_MEMBERS.join('|')})\\b`, ['src/renderer/src']).filter(
      notSelf
    )
    expect(hits).toEqual([])
  })

  it('the main process registers no campaign channel and the preload exposes none', () => {
    const channel = join('campaign', ':list')
    expect(gitGrep(channel, ['src']).filter(notSelf)).toEqual([])
  })

  it('no i18n key of a removed surface is in either locale file', () => {
    for (const file of ['en.json', 'pt-BR.json']) {
      const keys = leafKeys(JSON.parse(read(`src/renderer/src/i18n/${file}`)))
      const left = keys.filter((k) =>
        REMOVED_KEY_PREFIXES.some((p) => k === p || k.startsWith(`${p}.`))
      )
      expect({ file, left }).toEqual({ file, left: [] })
    }
  })

  it('the keys a live surface builds at run time are still in both locale files', () => {
    // `headlineText` (the sidebar chip), the end dialog's warnings and its record panel assemble these keys
    // from a template, so no literal in a source file names them: the removal must not take them.
    const live = [
      ...['single', 'range', 'done'].map((k) => `mission.chip.${k}`),
      ...['single', 'range', 'done'].map((k) => `mission.headline.${k}`),
      ...['endUnverified', 'leftBehind', 'checksOpen', 'blockersOpen', 'rescopeStaged'].map(
        (k) => `mission.end.warnings.${k}`
      ),
      'mission.cue.ownerMissingTitle',
      'mission.cue.ownerMissingBody',
      'mission.cue.itemAria'
    ]
    for (const file of ['en.json', 'pt-BR.json']) {
      const keys = new Set(leafKeys(JSON.parse(read(`src/renderer/src/i18n/${file}`))))
      expect({ file, missing: live.filter((k) => !keys.has(k)) }).toEqual({ file, missing: [] })
    }
  })

  it('design.md and the design-entity map in CLAUDE.md name no removed component', () => {
    for (const doc of ['design.md', 'CLAUDE.md']) {
      const text = read(doc)
      const named = REMOVED_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(text))
      expect({ doc, named }).toEqual({ doc, named: [] })
    }
  })

  it('the design-entity map names only components that exist, and every mission component on disk', () => {
    const dir = path.join(ROOT, 'src/renderer/src/components')
    // `App.vue` (the layout shell) sits beside the components folder.
    const onDisk = new Set<string>(['App.vue'])
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else if (e.name.endsWith('.vue')) onDisk.add(e.name)
      }
    }
    walk(dir)
    const map = read('CLAUDE.md')
    const mapped = [...new Set([...map.matchAll(/`?([A-Z][A-Za-z0-9]+\.vue)`?/g)].map((m) => m[1]))]
    expect(mapped.filter((n) => !onDisk.has(n))).toEqual([])
    const missionOnDisk = [...onDisk].filter((n) => /^Mission/.test(n))
    expect(missionOnDisk.filter((n) => !map.includes(n))).toEqual([])
  })
})

// ==========================================================================================================
// AC-87
// ==========================================================================================================

describe('no second mission surface', () => {
  it('the mission components are the pane, the pill and the two dialogs it opens, and nothing else', () => {
    const dir = path.join(ROOT, 'src/renderer/src/components')
    const names = readdirSync(dir)
      .filter((n) => /^Mission.*\.vue$/.test(n))
      .sort()
    expect(names).toEqual([
      'MissionCloseConfirmDialog.vue',
      'MissionDropdown.vue',
      'MissionHandoffDialog.vue',
      'MissionPane.vue',
      'MissionPaneAsk.vue',
      'MissionPaneAttach.vue',
      'MissionPaneNext.vue',
      'MissionPaneSessions.vue',
      'MissionPaneStep.vue',
      'MissionPaneTree.vue',
      'MissionPill.vue'
    ])
  })

  it('no component renders a list of missions across the repo except the attach picker', () => {
    // A list across the repo is a `v-for` over the missions store's views or its attach rows.
    const hits = gitGrep('v-for="[^"]* in [^"]*(\\.views|attachAsks|missionList)', [
      'src/renderer/src/components'
    ]).filter((l) => !l.startsWith('src/renderer/src/components/MissionPaneAttach.vue:'))
    expect(hits).toEqual([])
  })

  it('there is no kanban view of a mission and no cross-mission queue', () => {
    const files = gitGrep('(Mission|mission)(Board|Kanban|Queue|MyWork)', ['src/renderer/src'])
    expect(files).toEqual([])
  })

  it('the Activity cue has no "review all" rail and no review request', () => {
    const bell = read('src/renderer/src/components/ActivityBell.vue')
    expect(bell).not.toMatch(/reviewAll|openReview|MISSION_ROWS_MAX/)
  })
})

// ==========================================================================================================
// The upgrade loses nothing: a v3 mission paused with a steward
// ==========================================================================================================

const LEADER = '8f2c1e4a-1111-4222-8333-944455556666'
const AT = '2026-11-09T10:00:00.000Z'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

let repo = ''
let userData = ''

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harnu-s37-'))
  userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-s37-ud-'))
  h.userDataDir = userData
  mkdirSync(path.join(repo, '.git'), { recursive: true })
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

/** A v3 mission that is waiting on the operator three ways: a close, a steward pause and a blocker. */
function pausedV3(over: Partial<Mission> = {}): Mission {
  return {
    id: 'mnt-0a1b2c3d',
    slug: 'legacy-rollout',
    folder: repo,
    owner: { sessionId: LEADER, folder: repo },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Load the files',
        verification: 'verifier',
        proof: 'verified',
        verifiedBy: { sessionId: 'sess-checker', at: AT, verdict: 'met' },
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'verified',
        verifiedBy: { sessionId: 'sess-checker', at: AT, verdict: 'met' },
        links: [],
        blockers: []
      }
    ],
    blockers: [
      { reason: 'Waiting on the vendor key', unblocks: 'a key', owner: 'operator', raisedAt: AT }
    ],
    openQuestions: [],
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: AT,
    pendingClose: { at: AT, requestedBy: LEADER },
    provenance: { author: 'agent', at: AT },
    stewardPause: { at: AT, reason: 'cost' },
    ...over
  } as Mission
}

function seed(m: Mission): string {
  return writeV3Mission(repo, m)
}

const kinds = (items: readonly { kind: string }[]): string[] => items.map((i) => i.kind)

const readDetail = async (folder: string, missionId: string) =>
  missionGet(folder, { kind: 'operator' }, { missionId })

describe('a v3 mission paused with a steward: the pause is not owed any more', () => {
  it('the waiting list derives no steward item, and keeps every other item in its order', async () => {
    seed(pausedV3())
    const detail = await missionGet(repo, { kind: 'operator' }, { missionId: 'mnt-0a1b2c3d' })
    if (!detail.ok) throw new Error(detail.error)
    // The blocker the operator owes, then the close the agent asked for: nothing about a steward.
    expect(kinds(detail.waiting.items)).toEqual(['unblock', 'close'])
  })

  it('the read of a v3 file shows no steward item, and reading wrote nothing', async () => {
    const file = seed(pausedV3())
    const before = `${sha(readFileSync(file))}@${statSync(file).mtimeMs}`
    const ipc = await import('../src/main/mission-ipc')
    const list = await ipc.listMissionViews([repo])
    expect(list.views).toEqual([])
    const detail = await missionGet(repo, { kind: 'operator' }, { missionId: 'mnt-0a1b2c3d' })
    if (!detail.ok) throw new Error(detail.error)
    expect(JSON.stringify(detail)).not.toMatch(/steward/i)
    expect(`${sha(readFileSync(file))}@${statSync(file).mtimeMs}`).toBe(before)
    // The stored pause is still in the file: it is never edited, only no longer read as owed.
    expect(readFileSync(file, 'utf8')).toContain('stewardPause')
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(false)
  }, 60_000)

  it('a Your move card filed for the pause before the upgrade closes, and no other card is lost or re-filed', async () => {
    const m = pausedV3()
    seed(m)
    let n = 0
    const mint = (): string => `card-${++n}`
    const none = { unreadable: [] }
    const keysOf = (s: YourMoveState): string[] =>
      s.cards
        .filter((c) => c.closedAt === undefined)
        .map((c) => c.sourceKey ?? '')
        .sort()
    const records = await readRecordViews([repo], { readDetail })
    // What the upgraded build files for the mission: the blocker and the close, from the one waiting list.
    const filed = reconcileMissions(emptyState(), none, [repo], 'live', mint, 1, records)
    expect(keysOf(filed)).toEqual([`${m.id}:blocker:Waiting on the vendor key`, `${m.id}:close`])
    // What main filed before the upgrade also held a card for the steward's pause (its key is main's).
    const close = filed.cards.find((c) => c.sourceKey === `${m.id}:close`)!
    const before: YourMoveState = {
      ...filed,
      cards: [
        ...filed.cards,
        { ...close, id: 'card-pause', sourceKey: `${m.id}:steward-paused`, kind: 'do' }
      ]
    }
    expect(keysOf(before)).toHaveLength(3)
    const idsBefore = new Map(before.cards.map((c) => [c.sourceKey, c.id]))

    // After the upgrade the list has no pause: that card closes by itself, instead of being stranded.
    const after = reconcileMissions(before, none, [repo], 'live', mint, 2, records)
    expect(keysOf(after)).toEqual([`${m.id}:blocker:Waiting on the vendor key`, `${m.id}:close`])
    expect(after.cards.find((c) => c.id === 'card-pause')!.closedAt).toBeDefined()
    // The two that stay are the same cards, not closed and re-filed.
    for (const c of after.cards.filter((c) => c.closedAt === undefined)) {
      expect(c.id).toBe(idsBefore.get(c.sourceKey))
    }
    expect(after.cards).toHaveLength(before.cards.length)
  }, 60_000)
})

// ==========================================================================================================
// The Scheduler: no steward block, and a steward an older build left behind is not one of the operator's workers
// ==========================================================================================================

describe('the Scheduler after the steward block is gone', () => {
  const worker = (id: string, over: Partial<Worker> = {}): Worker =>
    ({
      id,
      name: `worker-${id}`,
      enabled: true,
      prompt: 'p',
      folder: '/org/alpha',
      everyMinutes: 30,
      runOnBoot: false,
      model: 'haiku',
      effort: 'low',
      mode: 'observe',
      timeoutSeconds: 300,
      carryLastResult: false,
      failureStreak: 0,
      ...over
    }) as Worker

  it('draws no Stewards block, and a leftover steward worker is not a row of the list', async () => {
    const state = [
      worker('u1'),
      worker('s1', { category: 'steward', mode: 'steward', missionId: 'mnt-00000001' } as never),
      worker('s2', { category: 'steward', mode: 'steward', missionId: 'mnt-00000002' } as never)
    ]
    const api = {
      schedulerList: vi.fn(async () => state),
      schedulerRuns: vi.fn(async () => []),
      bundledSkillsGet: vi.fn(async () => ({})),
      bundledSkillsGetFolder: vi.fn(async () => ({})),
      claudeConfigGetGlobal: vi.fn(async () => ({})),
      claudeConfigListEndpoints: vi.fn(async () => [])
    }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
    })
    setActivePinia(createPinia())
    localStorage.clear()
    stubTakeoverShellTargets()
    const w = mount(SchedulerView, { global: { plugins: [i18n] }, attachTo: document.body })
    for (let i = 0; i < 4; i++) await flushPromises()
    const names = w.findAll('[data-worker-name]').map((n) => n.text())
    expect(names).toEqual(['worker-u1'])
    expect(w.find('[data-test="scheduler-stewards-toggle"]').exists()).toBe(false)
    expect(w.find('[data-test="scheduler-steward-row"]').exists()).toBe(false)
    w.unmount()
  })
})

// ==========================================================================================================
// A door with a home: an older (v3) mission's staged re-scope is approved or declined in the pane (S-37, delta 1)
// ==========================================================================================================

describe('an older mission with a staged re-scope has Approve and Decline in the pane', () => {
  const NEW_END = { kind: 'code', target: 'The slice is merged and live', evidence: 'green gates' }

  /** A v3 mission whose owner staged a re-scope: nothing else is owed, so the re-scope is the one item. */
  function rescopeV3(): Mission {
    const m = pausedV3({ pendingRescope: NEW_END as never })
    delete (m as Partial<Mission>).pendingClose
    delete (m as Partial<Mission>).stewardPause
    m.blockers = []
    return m
  }

  const view = async (): Promise<
    Awaited<ReturnType<typeof import('../src/main/mission-ipc').buildMissionV4View>>
  > => {
    const ipc = await import('../src/main/mission-ipc')
    return ipc.buildMissionV4View({ folder: repo, sessionId: LEADER, missionId: 'mnt-0a1b2c3d' })
  }

  it('the pane view carries the staged re-scope as the box a v4 mission shows, and writes nothing', async () => {
    const file = seed(rescopeV3())
    const before = `${sha(readFileSync(file))}@${statSync(file).mtimeMs}`
    const reply = await view()
    expect(reply.state).toBe('mission')
    if (reply.state !== 'mission') return
    expect(reply.pendingDoneWhen?.text).toContain(NEW_END.target)
    expect(reply.pendingDoneWhen?.text).toContain(NEW_END.evidence)
    expect(`${sha(readFileSync(file))}@${statSync(file).mtimeMs}`).toBe(before)
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(false)
  }, 60_000)

  /** The one v4 copy of the mission in the throwaway repo (its text), or null before any write. */
  const v4Copy = (): string | null => {
    const dir = path.join(repo, '.harnu', 'missions-v4')
    if (!existsSync(dir)) return null
    const f = readdirSync(dir).find((n) => n.startsWith('mnt-0a1b2c3d-') && n.endsWith('.md'))
    return f ? readFileSync(path.join(dir, f), 'utf8') : null
  }
  const fingerprint = (file: string): string =>
    `${sha(readFileSync(file))}@${statSync(file).mtimeMs}`

  it('Approve converts by copy: the v3 file stays byte- and mtime-identical, the v4 copy takes the new end', async () => {
    const file = seed(rescopeV3())
    const before = fingerprint(file)
    const ipc = await import('../src/main/mission-ipc')
    const res = await ipc.runPaneDoor({
      folder: repo,
      missionId: 'mnt-0a1b2c3d',
      door: 'approveDoneWhen'
    })
    expect(res).toMatchObject({ ok: true })
    // NG-8 / AC-22: no v4 code writes a v3 file.
    expect(fingerprint(file)).toBe(before)
    expect(readFileSync(file, 'utf8')).toContain('pendingRescope')
    // The v4 copy carries the approved end, no staging, and the operator's Log line as before.
    const copy = v4Copy()
    expect(copy).not.toBeNull()
    expect(copy).not.toMatch(/pendingDoneWhen/)
    expect(copy).toContain(NEW_END.target)
    expect(copy).toMatch(/### \S+ · operator approved the re-scope/)
    // The box is gone from the pane afterwards, and the pane now reads the v4 copy.
    const reply = await view()
    expect(reply.state === 'mission' && reply.pendingDoneWhen).toBeNull()
    expect(reply.state === 'mission' && reply.source).toBe('v4')
  }, 60_000)

  it('Decline converts by copy: the v3 file stays byte- and mtime-identical, the v4 copy keeps the end', async () => {
    const file = seed(rescopeV3())
    const before = fingerprint(file)
    const ipc = await import('../src/main/mission-ipc')
    const res = await ipc.runPaneDoor({
      folder: repo,
      missionId: 'mnt-0a1b2c3d',
      door: 'declineDoneWhen'
    })
    expect(res).toMatchObject({ ok: true })
    expect(fingerprint(file)).toBe(before)
    expect(readFileSync(file, 'utf8')).toContain('pendingRescope')
    const copy = v4Copy()
    expect(copy).not.toBeNull()
    expect(copy).not.toMatch(/pendingDoneWhen/)
    expect(copy).toContain('PR merging the slice')
    // The frozen v3 snapshot keeps what was staged; the live Done when is the old one.
    expect(copy).toMatch(/doneWhen: .*PR merging the slice/)
    expect(copy).toMatch(/### \S+ · operator declined the re-scope/)
    const reply = await view()
    expect(reply.state === 'mission' && reply.pendingDoneWhen).toBeNull()
  }, 60_000)

  it('the Your move card for the re-scope closes when it is approved, and the blocker card is not touched', async () => {
    const m = rescopeV3()
    m.blockers = [
      { reason: 'Waiting on the vendor key', unblocks: 'a key', owner: 'operator', raisedAt: AT }
    ]
    seed(m)
    const ipc = await import('../src/main/mission-ipc')
    let n = 0
    const mint = (): string => `card-${++n}`
    const open = (s: YourMoveState): string[] =>
      s.cards
        .filter((c) => c.closedAt === undefined)
        .map((c) => c.sourceKey ?? '')
        .sort()
    // S-40: the list poll serves no v3 view; Your move reads the records, a v3 file converted in memory.
    const records = (): ReturnType<typeof readRecordViews> =>
      readRecordViews([repo], { readDetail })
    const filed = reconcileMissions(
      emptyState(),
      { unreadable: [] },
      [repo],
      'live',
      mint,
      1,
      await records()
    )
    // Every step is verified, so the converted record also derives a close: it is owed beside the re-scope.
    expect(open(filed)).toEqual(
      [
        `${m.id}:blocker:Waiting on the vendor key`,
        `${m.id}:close`,
        `${m.id}:rescope:${NEW_END.target}`
      ].sort()
    )

    const res = await ipc.runPaneDoor({ folder: repo, missionId: m.id, door: 'approveDoneWhen' })
    expect(res).toMatchObject({ ok: true })
    const next = reconcileMissions(
      filed,
      { unreadable: [] },
      [repo],
      'live',
      mint,
      2,
      await records()
    )
    // Only the re-scope card closes; the close and the blocker cards are the same cards, not re-filed.
    expect(open(next)).toEqual(
      [`${m.id}:blocker:Waiting on the vendor key`, `${m.id}:close`].sort()
    )
    for (const key of ['blocker', 'close']) {
      const before = filed.cards.find((c) => c.sourceKey?.includes(`:${key}`))!
      expect(next.cards.find((c) => c.id === before.id)?.closedAt).toBeUndefined()
    }
    const blockerCard = filed.cards.find((c) => c.sourceKey?.includes(':blocker:'))!
    expect(next.cards.find((c) => c.id === blockerCard.id)?.closedAt).toBeUndefined()
  }, 60_000)

  it('a v4 mission is untouched by the new route: its Approve is still the v4 door', async () => {
    const ipc = await import('../src/main/mission-ipc')
    const res = await ipc.runPaneDoor({
      folder: repo,
      missionId: 'mnt-a7230001',
      door: 'approveDoneWhen'
    })
    // No such record here: the v4 door answers its own refusal; the v3 door is never tried.
    expect(res).toMatchObject({ ok: false })
    expect(JSON.stringify(res)).not.toContain('re-scope')
  }, 60_000)
})
