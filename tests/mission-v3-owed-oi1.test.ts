// @vitest-environment node
/**
 * BUG-283 · OI-1 (G1) — an unticked operator check, or an unproven human step, on an old (v3) step reaches
 * the operator whatever the step's derived state and whether or not its pull request facts were read.
 *
 * The compat re-run found it hidden when the step read `todo`: its pull request link's facts unread
 * (offline, gh down), or no pull request, card or start time with another criterion still open. Recall over
 * noise: a false alarm beats a missed item. Every surface reads the one waiting list, so this proves the
 * list, the pane's Next line, the pill count, Your move and the Activity cue keys, on neutral v3 files
 * read through the real record store. Reading writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { missionGet } from '../src/main/missions/verbs-read'
import { deriveStepState } from '../src/main/missions/state'
import { waitingListV4 } from '../src/main/missions/waiting'
import { readMissionRecord } from '../src/main/missions/record-store'
import { emptyState } from '../src/main/your-move/core'
import { readRecordViews, reconcileMissions } from '../src/main/your-move/source-mission'
import { owedKeys } from '../src/renderer/src/lib/mission-cue'
import { writeOwedStandalone, type OwedShape } from './fixtures/missions-v4-owed-standalone/build'
import type { MissionV4 } from '../src/main/missions/model'

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

let repo = ''
let shapes: OwedShape[] = []
beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harnu-oi1-'))
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'harnu-oi1-ud-'))
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  shapes = writeOwedStandalone(repo)
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(h.userDataDir, { recursive: true, force: true })
})

const detailOf = async (
  id: string
): Promise<Extract<Awaited<ReturnType<typeof missionGet>>, { ok: true }>> => {
  const d = await missionGet(repo, { kind: 'operator' }, { missionId: id })
  if (!d.ok) throw new Error(d.error)
  return d
}

describe('every shape of an old step with an unticked check or an unproven human step is raised', () => {
  for (const shape of [
    'owing-pr-unread',
    'owing-no-links',
    'owing-self-checked',
    'owing-human-pr',
    'owing-human-plain'
  ]) {
    it(`${shape}: a settle item names it, first, and the pill counts it`, async () => {
      const s = shapes.find((x) => x.slug === shape) as OwedShape
      const d = await detailOf(s.id)
      const settle = d.waiting.items.filter((i) => i.kind === 'settle')
      expect(JSON.stringify(settle)).toContain(s.owed)
      expect(d.waiting.next?.kind).toBe('settle')
      expect(d.waiting.items.length).toBeGreaterThan(0)
    }, 60_000)
  }

  it('the fixture really holds steps that read `todo` (the shapes are the ones that were hidden)', async () => {
    const read = await readMissionRecord(repo, 'mnt-0b000002')
    const rec = (read as { ok: true; record: MissionV4 }).record
    expect(deriveStepState(rec.steps[0], {}).state).toBe('todo')
  })
})

describe('the other surfaces read the same list', () => {
  it('Your move files a card for each, and the Activity cue has a key for each', async () => {
    const records = await readRecordViews([repo], {
      readDetail: async (folder, id) => missionGet(folder, { kind: 'operator' }, { missionId: id })
    })
    const filed = reconcileMissions(
      emptyState(),
      { unreadable: [] },
      [repo],
      'live',
      (() => {
        let n = 0
        return () => `card-${++n}`
      })(),
      1,
      records
    )
    const open = filed.cards.filter((c) => c.closedAt === undefined)
    for (const s of shapes) {
      expect(
        open.some((c) => c.sourceKey?.startsWith(`${s.id}:settle`)),
        `${s.slug} has a Your move card`
      ).toBe(true)
      const d = await detailOf(s.id)
      const keys = [...owedKeys({ mission: { id: s.id }, you: d.waiting.items } as never).keys()]
      expect(keys.length, `${s.slug} has a cue key`).toBeGreaterThan(0)
    }
  }, 120_000)
})

describe('a native v4 step that has not started still owes nothing (the v4 rule is unchanged)', () => {
  const native = (): MissionV4 =>
    ({
      schemaVersion: 4,
      id: 'mnt-0d000001',
      title: 'Acme copy',
      doneWhen: 'Acme copy is live',
      status: 'open',
      milestones: [],
      steps: [
        {
          id: 'stp-1',
          title: 'Sign off',
          acs: [
            { id: 'ac-1', text: 'The copy is merged', by: 'fact', fact: 'pr-merged' },
            { id: 'ac-2', text: 'Design looked', by: 'operator' }
          ],
          links: [],
          blockers: []
        }
      ],
      sessions: [],
      links: [],
      blockers: []
    }) as MissionV4

  it('no settle item for a todo step of a record that is not an old one', () => {
    expect(waitingListV4(native()).items.filter((i) => i.kind === 'settle')).toEqual([])
  })
})

describe('reading it writes nothing', () => {
  it('no v4 copy appears', async () => {
    for (const s of shapes) await detailOf(s.id)
    expect(existsSync(path.join(repo, '.harnu', 'missions-v4'))).toBe(false)
    expect(readdirSync(path.join(repo, '.harnu', 'missions'))).toHaveLength(shapes.length)
  }, 60_000)
})
