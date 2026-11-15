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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
import {
  buildMissionFileContent,
  missionFilePath,
  missionsDir,
  type Mission
} from '../src/main/mission-core'
import { computeProgress } from '../src/main/mission-progress'
import { waitingList } from '../src/main/missions/waiting'
import { emptyState, type YourMoveState } from '../src/main/your-move/core'
import { reconcileMissions } from '../src/main/your-move/source-mission'
import { owedKeys } from '../src/renderer/src/lib/mission-cue'
import { fixtureView } from './helpers/mission-v3-view'

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
  join('open', 'Review'),
  join('consume', 'ReviewRequest'),
  join('review', 'Request'),
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
  'mission.chip',
  'mission.close',
  'mission.cue.reviewAll',
  'mission.decision',
  'mission.end.open',
  'mission.endCaption',
  'mission.gates',
  'mission.header',
  'mission.headline',
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
  mkdirSync(missionsDir(repo), { recursive: true })
  const file = missionFilePath(repo, m.id, m.slug)
  writeFileSync(file, buildMissionFileContent(m))
  return file
}

const kinds = (items: readonly { kind: string }[]): string[] => items.map((i) => i.kind)

describe('a v3 mission paused with a steward: the pause is not owed any more', () => {
  it('the waiting list derives no steward item, and keeps every other item in its order', () => {
    const m = pausedV3()
    const list = waitingList(m, [], computeProgress(m, [], Date.parse(AT)))
    expect(kinds(list)).toEqual(['close', 'blocker'])
  })

  it('the list read of a v3 file shows no steward item, and reading wrote nothing', async () => {
    const file = seed(pausedV3())
    const before = `${sha(readFileSync(file))}@${statSync(file).mtimeMs}`
    const ipc = await import('../src/main/mission-ipc')
    const list = await ipc.listMissionViews([repo])
    const view = list.views.find((v) => v.mission.id === 'mnt-0a1b2c3d')
    expect(view).toBeDefined()
    expect(kinds(view!.you)).toEqual(['close', 'blocker'])
    expect(`${sha(readFileSync(file))}@${statSync(file).mtimeMs}`).toBe(before)
    // The stored pause is still in the file: it is never edited, only no longer read as owed.
    expect(readFileSync(file, 'utf8')).toContain('stewardPause')
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(false)
  })

  it('a Your move card filed for the pause before the upgrade closes, and no other card is lost or re-filed', async () => {
    const m = pausedV3()
    const ipc = await import('../src/main/mission-ipc')
    seed(m)
    const live = await ipc.listMissionViews([repo])
    const view = live.views.find((v) => v.mission.id === m.id)!
    // What main filed: one card per item it derived then, the steward's included.
    const owedBefore = [
      { kind: 'close' },
      { kind: 'steward-paused', reason: 'cost', at: AT },
      { kind: 'blocker', reason: 'Waiting on the vendor key', unblocks: 'a key' }
    ]
    let n = 0
    const mint = (): string => `card-${++n}`
    const asView = (you: unknown[]): never =>
      fixtureView('parallel', {
        mission: { id: m.id, owner: { sessionId: LEADER, folder: repo } } as never,
        view: { root: repo, you: you as never }
      }) as never
    const filed = reconcileMissions(
      emptyState(),
      { views: [asView(owedBefore)], unreadable: [] },
      [repo],
      'live',
      mint,
      1,
      new Map()
    )
    const keysOf = (s: YourMoveState): string[] =>
      s.cards
        .filter((c) => c.closedAt === undefined)
        .map((c) => c.sourceKey ?? '')
        .sort()
    expect(keysOf(filed)).toEqual([
      `${m.id}:blocker:Waiting on the vendor key`,
      `${m.id}:close`,
      `${m.id}:steward-paused`
    ])
    const idsBefore = new Map(filed.cards.map((c) => [c.sourceKey, c.id]))

    // After the upgrade main derives the list without the pause.
    const after = reconcileMissions(
      filed,
      { views: [asView(view.you as unknown[])], unreadable: [] },
      [repo],
      'live',
      mint,
      2,
      new Map()
    )
    expect(keysOf(after)).toEqual([`${m.id}:blocker:Waiting on the vendor key`, `${m.id}:close`])
    // The two that stay are the same cards, not closed and re-filed.
    for (const c of after.cards.filter((c) => c.closedAt === undefined)) {
      expect(c.id).toBe(idsBefore.get(c.sourceKey))
    }
  })

  it('the cue keys and the chime memory are those of main for every other item', () => {
    const view = (you: unknown[]): never =>
      fixtureView('parallel', {
        mission: { id: 'mnt-0a1b2c3d', owner: { sessionId: LEADER, folder: repo } } as never,
        view: { root: repo, you: you as never }
      }) as never
    const withPause = owedKeys(
      view([{ kind: 'close' }, { kind: 'steward-paused', reason: 'cost', at: AT }])
    )
    const without = owedKeys(view([{ kind: 'close' }]))
    // The pause was standing, never news: it never had a key, so no chime is lost by it leaving.
    expect(without).toEqual(withPause)
  })
})
