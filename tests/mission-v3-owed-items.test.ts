// @vitest-environment node
/**
 * Missions v4 · S-40 (owner's delta 1) — an item the operator owes is never lost when the v3 view goes.
 *
 * Until S-40 an older (v3) mission's owed items came from the v3 view: a staged re-scope, an undecided
 * decision, unticked checks, a human step, a review of an imported end. That view is gone, so each kind
 * must still reach the operator from what a v3 file reads as now (the converted v4 record, worded once by
 * the waiting list), through every surface that reads that list: the pane's Next line (`detail.waiting`),
 * Your move (a card) and the Activity cue (`owedKeys`).
 *
 * One v3 fixture file per kind, read through the real record store. Reads write nothing.
 *
 * | v3-only kind   | where it reaches the operator after S-40                                   |
 * | -------------- | -------------------------------------------------------------------------- |
 * | rescope        | a `rescope` item: the same Your move key as before (`rescope:<target>`)     |
 * | decide         | an `unblock` item (the conversion's operator blocker, one per decision)     |
 * | checks         | one `settle` item per unticked check (an operator criterion)                |
 * | human-steps    | a `settle` item for the human step (an operator criterion)                  |
 * | review-import  | an `unblock` item (the conversion's operator blocker: "Done, continue")      |
 * | fixed-end check| an `unblock` item (the conversion's operator blocker, as before S-40)        |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { missionGet } from '../src/main/missions/verbs-read'
import { emptyState, type YourMoveState } from '../src/main/your-move/core'
import { readRecordViews, reconcileMissions } from '../src/main/your-move/source-mission'
import { owedKeys } from '../src/renderer/src/lib/mission-cue'
import { v3MissionObject, writeV3Mission } from './helpers/v3-mission-file'

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

const LEADER = '8f2c1e4a-1111-4222-8333-944455556666'
const AT = '2026-11-09T10:00:00.000Z'
const ID = 'mnt-0a1b2c3d'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

let repo = ''
beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harnu-s40d1-'))
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'harnu-s40d1-ud-'))
  mkdirSync(path.join(repo, '.git'), { recursive: true })
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(h.userDataDir, { recursive: true, force: true })
})

const step = (id: string, ordinal: number, over: Record<string, unknown> = {}): object => ({
  id,
  ordinal,
  kind: 'custom',
  title: `Step ${ordinal}`,
  verification: 'verifier',
  proof: 'unproven',
  links: [],
  blockers: [],
  ...over
})

const fixedEnd = (ordinal: number, over: Record<string, unknown> = {}): object =>
  step(`stp-${ordinal}`, ordinal, {
    kind: 'fixed-end',
    title: 'Delivered and verified',
    ...over
  })

/** A v3 file: `steps` and the top-level fields are the caller's. The owner leads it. */
function seed(over: Record<string, unknown>): string {
  return writeV3Mission(
    repo,
    v3MissionObject(repo, {
      id: ID,
      slug: 'legacy-rollout',
      owner: { sessionId: LEADER, folder: repo },
      ...over
    })
  )
}

const detailOf = async (): Promise<
  Extract<Awaited<ReturnType<typeof missionGet>>, { ok: true }>
> => {
  const d = await missionGet(repo, { kind: 'operator' }, { missionId: ID })
  if (!d.ok) throw new Error(d.error)
  return d
}
const kinds = (items: readonly { kind: string }[]): string[] => items.map((i) => i.kind)

const NEW_END = { kind: 'code', target: 'The slice is merged and live', evidence: 'green gates' }

describe('a v3 mission with a staged re-scope still owes the operator exactly one item', () => {
  const file = (): string =>
    seed({
      pendingRescope: NEW_END,
      steps: [
        step('stp-1', 1, {
          proof: 'verified',
          verifiedBy: { sessionId: 'sess-checker', at: AT, verdict: 'met' }
        }),
        fixedEnd(2, {
          proof: 'verified',
          verifiedBy: { sessionId: 'sess-checker', at: AT, verdict: 'met' }
        })
      ]
    })

  it('the waiting list (the pane, the chip, the Activity cue) names it once, first, worded for the operator', async () => {
    file()
    const d = await detailOf()
    const items = d.waiting.items.filter((i) => (i.kind as string) === 'rescope')
    expect(items).toHaveLength(1)
    expect(d.waiting.next?.kind as string).toBe('rescope')
    expect(items[0].ask).toContain(NEW_END.target)
    expect(items[0].id).toBe(`rescope:${NEW_END.target}`)
  }, 60_000)

  it('Your move files one card under the key main used (`rescope:<target>`), and the Activity cue has a key for it', async () => {
    file()
    const records = await readRecordViews([repo], {
      readDetail: async (folder, id) => missionGet(folder, { kind: 'operator' }, { missionId: id })
    })
    const filed = reconcileMissions(
      emptyState(),
      { unreadable: [] },
      [repo],
      'live',
      () => 'card-1',
      1,
      records
    )
    const open = filed.cards.filter(
      (c) => c.closedAt === undefined && c.sourceKey?.includes('rescope')
    )
    expect(open.map((c) => c.sourceKey)).toEqual([`${ID}:rescope:${NEW_END.target}`])
    expect(open[0].kind).toBe('go_no_go')
    const d = await detailOf()
    const keys = [...owedKeys({ mission: { id: ID }, you: d.waiting.items } as never).keys()]
    expect(keys).toContain(`rescope:${NEW_END.target}`)
  }, 60_000)

  it('a re-scope the operator approved is no longer owed, and its card closes', async () => {
    file()
    const readDetail = async (folder: string, id: string) =>
      missionGet(folder, { kind: 'operator' }, { missionId: id })
    let state: YourMoveState = reconcileMissions(
      emptyState(),
      { unreadable: [] },
      [repo],
      'live',
      () => 'card-1',
      1,
      await readRecordViews([repo], { readDetail })
    )
    expect(
      state.cards.some((c) => c.closedAt === undefined && c.sourceKey?.includes('rescope'))
    ).toBe(true)
    const ipc = await import('../src/main/mission-ipc')
    expect(
      await ipc.runPaneDoor({ folder: repo, missionId: ID, door: 'approveDoneWhen' })
    ).toMatchObject({
      ok: true
    })
    state = reconcileMissions(
      state,
      { unreadable: [] },
      [repo],
      'live',
      () => 'card-2',
      2,
      await readRecordViews([repo], { readDetail })
    )
    expect(
      state.cards.filter((c) => c.closedAt === undefined && c.sourceKey?.includes('rescope'))
    ).toEqual([])
    expect(kinds((await detailOf()).waiting.items)).not.toContain('rescope')
  }, 60_000)

  it('reading it writes nothing', async () => {
    const f = file()
    const before = `${sha(readFileSync(f))}@${statSync(f).mtimeMs}`
    await detailOf()
    await readRecordViews([repo], {
      readDetail: async (folder, id) => missionGet(folder, { kind: 'operator' }, { missionId: id })
    })
    expect(`${sha(readFileSync(f))}@${statSync(f).mtimeMs}`).toBe(before)
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(false)
  }, 60_000)
})

describe('the staged re-scope survives the first v4 write', () => {
  it('after a write converts the file by copy, the box and the item are still there, and Approve is the v4 door', async () => {
    seed({
      pendingRescope: NEW_END,
      steps: [step('stp-1', 1, { verification: 'human' }), fixedEnd(2)]
    })
    const before = await detailOf()
    const { markCriterion } = await import('../src/main/missions/doors')
    const stepId = before.waiting.items.find((i) => i.kind === 'settle')!
    expect(stepId).toBeDefined()
    const marked = await markCriterion(repo, ID, {
      stepId: (stepId as { stepId: string }).stepId,
      criterionId: (stepId as { criterionId: string }).criterionId
    })
    expect(marked.ok).toBe(true)
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(true)

    const ipc = await import('../src/main/mission-ipc')
    const view = await ipc.buildMissionV4View({ folder: repo, sessionId: LEADER, missionId: ID })
    if (view.state !== 'mission') throw new Error(JSON.stringify(view))
    expect(view.source).toBe('v4')
    expect(view.pendingDoneWhen?.text).toContain(NEW_END.target)
    expect(kinds(view.detail.waiting.items)).toContain('rescope')

    const res = await ipc.runPaneDoor({ folder: repo, missionId: ID, door: 'approveDoneWhen' })
    expect(res).toMatchObject({ ok: true })
    const after = await ipc.buildMissionV4View({ folder: repo, sessionId: LEADER, missionId: ID })
    if (after.state !== 'mission') throw new Error(JSON.stringify(after))
    expect(after.pendingDoneWhen).toBeNull()
    expect(kinds(after.detail.waiting.items)).not.toContain('rescope')
  }, 60_000)
})

describe('every other v3-only kind still reaches the operator from the converted record', () => {
  it('an undecided decision node is an operator blocker (`unblock`)', async () => {
    seed({
      steps: [
        step('stp-1', 1, {
          verification: 'human',
          decision: { title: 'Ship behind a flag?', options: ['Yes', 'No'], blocks: ['stp-2'] }
        }),
        step('stp-2', 2),
        fixedEnd(3)
      ]
    })
    const d = await detailOf()
    expect(kinds(d.waiting.items)).toContain('unblock')
    expect(JSON.stringify(d.waiting.items)).toContain('Ship behind a flag?')
  }, 60_000)

  it('an unticked check on a reached step is a `settle` item', async () => {
    seed({
      steps: [
        step('stp-1', 1, {
          proof: 'verified',
          verifiedBy: { sessionId: 'sess-checker', at: AT, verdict: 'needs-human' },
          checks: [{ id: 'chk-1', label: 'Validated visually', source: 'operator', createdAt: AT }]
        }),
        fixedEnd(2)
      ]
    })
    const d = await detailOf()
    const settle = d.waiting.items.filter((i) => i.kind === 'settle')
    expect(settle).toHaveLength(1)
    expect(JSON.stringify(settle)).toContain('Validated visually')
  }, 60_000)

  it('a human step that was reached is a `settle` item', async () => {
    seed({
      steps: [step('stp-1', 1, { verification: 'human' }), fixedEnd(2)]
    })
    const d = await detailOf()
    expect(kinds(d.waiting.items)).toContain('settle')
  }, 60_000)

  it('an imported mission whose end nobody reviewed owes an operator blocker (`unblock`)', async () => {
    seed({
      legacy: {
        source: '.harnu/goals/rollout.md',
        sha256: 'a'.repeat(64),
        needsReview: ['declaredEnd']
      },
      steps: [step('stp-1', 1), fixedEnd(2)]
    })
    const items = (await detailOf()).waiting.items.filter((i) => i.kind === 'unblock')
    expect(items).toHaveLength(1)
    expect(items[0].ask).toMatch(/imported/i)
  }, 60_000)

  it('an unticked check on the fixed end is an operator blocker (`unblock`)', async () => {
    seed({
      steps: [
        step('stp-1', 1),
        fixedEnd(2, {
          checks: [{ id: 'chk-1', label: 'DSQA signed off', source: 'operator', createdAt: AT }]
        })
      ]
    })
    const items = (await detailOf()).waiting.items.filter((i) => i.kind === 'unblock')
    expect(items.map((i) => i.ask)).toEqual(['DSQA signed off'])
  }, 60_000)

  it('a v3 file with nothing owed lists nothing', async () => {
    seed({ steps: [step('stp-1', 1), fixedEnd(2)] })
    expect((await detailOf()).waiting.items).toEqual([])
  }, 60_000)
})
