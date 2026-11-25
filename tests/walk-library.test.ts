import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkStore, type WalkStore } from '../src/main/walk/walk-store'
import { done, endRun, startRun, type Run } from '../src/shared/walk-machine'
import type { WalkScript } from '../src/shared/walk-schema'
import type { WalkSource } from '../src/shared/walk-source'
import { deleteConfirm, libraryView } from '../src/renderer/src/lib/walk-library'
import type { T } from '../src/renderer/src/lib/walk-view'

// the walk-ipc module imports electron for its handlers; only its pure functions are exercised here
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
  app: { isPackaged: false, getPath: () => tmpdir() }
}))
import { deleteWalk, libraryList } from '../src/main/walk/walk-ipc'

// ---- words: the real en.json, so a missing key fails here --------------------------------------

const en = JSON.parse(
  readFileSync(join(__dirname, '../src/renderer/src/i18n/en.json'), 'utf8')
) as Record<string, unknown>
const t: T = (key, params) => {
  const v = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en)
  if (typeof v !== 'string') throw new Error(`missing i18n key ${key}`)
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
}

// ---- fixtures: neutral sample walks ---------------------------------------------------------------

const check = (id: string): Record<string, unknown> => ({
  id,
  title: `Check ${id}`,
  why: 'why',
  where: { text: 'the page' },
  do: [{ text: 'Do it.', see: 'It works.' }],
  passes: 'It works.',
  fails: 'It does not.',
  nothingFromHere: 'Only eyes can tell.'
})
const walkOf = (title: string, source: WalkSource, n: number): WalkScript =>
  ({
    title,
    purpose: 'check',
    source,
    checks: Array.from({ length: n }, (_, i) => check(`c${i + 1}`))
  }) as unknown as WalkScript

const DAY = 24 * 3600 * 1000
const at = (day: number): number => Date.parse(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`)

let root: string
let clock = at(1)
let store: WalkStore
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-library-')))
  store = createWalkStore(root, { now: () => clock })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A walk and its first run: `closed` checks done, then the walk ended (or left live). */
async function seed(
  title: string,
  source: WalkSource,
  n: number,
  closed: number,
  day: number,
  how: 'ended' | 'live' | 'unstarted'
): Promise<{ walkId: string; runId: string }> {
  clock = at(day)
  const made = await store.createWalk(walkOf(title, source, n))
  if (how === 'unstarted') return made
  const step = (fn: (r: Run) => ReturnType<typeof done>): Promise<unknown> =>
    store.updateRun(made.walkId, made.runId, (r) => fn(r))
  await step((r) => startRun(r, clock))
  for (let i = 0; i < closed; i++) await step((r) => done(r, clock))
  if (how === 'ended') {
    clock = at(day) + 1000
    await step((r) => endRun(r, clock))
  }
  return made
}

const fmt = { now: at(18) }

describe('walks library', () => {
  it('lists walks, outcomes and the empty state', async () => {
    // five walks: a mission walk in progress, a PR walk that ended 4 of 6, a feature walk that passed, a
    // branch walk never started, and a card walk
    const pr: WalkSource = {
      kind: 'pr',
      number: 48,
      title: 'Add CSV export',
      author: 'alex',
      url: 'https://github.com/example-org/example-web/pull/48'
    }
    await seed('Release smoke checks', { kind: 'card', slug: 'release-0-14' }, 14, 14, 2, 'ended')
    await seed(
      'Dark theme pass',
      { kind: 'branch', branch: 'card/dark-theme', base: 'main' },
      3,
      0,
      9,
      'unstarted'
    )
    await seed(
      'CSV export, end to end',
      { kind: 'feature', text: 'CSV export.' },
      6,
      6,
      15,
      'ended'
    )
    await seed('Add CSV export', pr, 6, 4, 16, 'ended')
    await seed(
      'Mission dropdown',
      { kind: 'mission', missionId: 'mnt-12345678', scope: 'mission' },
      9,
      3,
      17,
      'live'
    )

    const entries = await libraryList(store)
    // newest run first: the live run, then by when each walk last ran (or was written, if never walked)
    expect(entries.map((e) => e.title)).toEqual([
      'Mission dropdown',
      'Add CSV export',
      'CSV export, end to end',
      'Dark theme pass',
      'Release smoke checks'
    ])
    // a live run says where it is: check 4 of 9 (three are closed)
    expect(entries[0]).toMatchObject({ status: 'live', live: { n: 1, check: 4, total: 9 } })

    const view = libraryView(entries, t, fmt)
    expect(view.mode).toBe('list')
    expect(view.title).toBe('Walks')
    expect(view.sub).toBe('5 walks · saved on this machine')
    expect(view.empty).toBeNull()
    expect(view.rows.map((r) => r.title)).toEqual(entries.map((e) => e.title))

    // each row: a source icon, the title, the source, the last run date and the outcome
    const row = (title: string) => view.rows.find((r) => r.title === title)!
    expect(row('Mission dropdown')).toMatchObject({
      icon: 'target',
      source: 'Mission',
      outcome: { kind: 'in-progress', text: 'in progress, check 4 of 9', warn: false }
    })
    expect(row('Add CSV export')).toMatchObject({
      icon: 'git-pull-request',
      source: 'PR #48 · alex',
      date: 'Nov 16',
      outcome: { kind: 'walked', text: '4 of 6 passed', warn: true }
    })
    expect(row('CSV export, end to end')).toMatchObject({
      icon: 'lightbulb',
      source: 'Feature',
      date: 'Nov 15',
      outcome: { kind: 'walked', text: '6 of 6 passed', warn: false }
    })
    expect(row('Dark theme pass')).toMatchObject({
      icon: 'git-branch',
      source: 'Branch card/dark-theme',
      outcome: { kind: 'not-walked', text: 'not walked yet', warn: false }
    })
    expect(row('Release smoke checks')).toMatchObject({
      icon: 'bookmark',
      source: 'Card · release-0-14',
      date: 'Nov 2',
      outcome: { kind: 'walked', text: '14 of 14 passed', warn: false }
    })
    // every row has Re-run and Open, and Delete lives in its menu
    for (const r of view.rows) {
      expect(r.actions).toEqual({ rerun: true, open: true, menu: ['delete'] })
    }
    // Open on a live run continues it; on an ended walk it shows the last run read-only; on one never started
    // it starts the first run
    expect(row('Mission dropdown').openAs).toBe('continue')
    expect(row('Add CSV export').openAs).toBe('past')
    expect(row('Dark theme pass').openAs).toBe('start')
    // a year is added to a date that is not this year's
    expect(
      libraryView(entries, t, { now: at(18) + 400 * DAY }).rows.find(
        (r) => r.title === 'Add CSV export'
      )?.date
    ).toBe('Nov 16, 2026')

    // one walk reads "1 walk", not "1 walks"
    expect(libraryView([entries[0]], t, fmt).sub).toBe('1 walk · saved on this machine')

    // no walks: the empty state and nothing else (no title, no count, no rows)
    const empty = libraryView([], t, fmt)
    expect(empty).toMatchObject({ mode: 'empty', title: null, sub: null, rows: [] })
    expect(empty.empty).toEqual({
      title: 'No walks yet',
      body: 'A walk is saved here after you run one. Ask a session to start one, or use Test it in the Mission.',
      command: '/step-by-step PR #48',
      hint: 'Or just say: “walk me through what we just built”.'
    })
  })

  it('deletes a walk after a confirmation that says when a run is live', async () => {
    const live = await seed('Mission dropdown', { kind: 'feature', text: 'x' }, 9, 3, 17, 'live')
    const old = await seed('Release smoke checks', { kind: 'feature', text: 'y' }, 3, 3, 2, 'ended')
    const entries = await libraryList(store)
    const view = libraryView(entries, t, fmt)
    const liveRow = view.rows.find((r) => r.walkId === live.walkId)!
    const oldRow = view.rows.find((r) => r.walkId === old.walkId)!
    expect(deleteConfirm(oldRow, t)).toBe(
      'Delete “Release smoke checks” and its 1 run? This cannot be undone.'
    )
    expect(deleteConfirm(liveRow, t)).toBe(
      'Delete “Mission dropdown” and its 1 run? A run is in progress and goes with it. This cannot be undone.'
    )

    const gone = await deleteWalk(store, old.walkId)
    expect(gone).toEqual({ ok: true, wasLive: false, runs: 1 })
    expect(existsSync(store.walkDir(old.walkId))).toBe(false)
    expect((await libraryList(store)).map((e) => e.walkId)).toEqual([live.walkId])

    // deleting a walk with a live run is allowed once confirmed, and says so
    expect(await deleteWalk(store, live.walkId)).toEqual({ ok: true, wasLive: true, runs: 1 })
    expect(await libraryList(store)).toEqual([])
    // there is nothing left to delete twice, and nothing outside a walk is ever touched
    expect(await deleteWalk(store, live.walkId)).toMatchObject({
      ok: false,
      error: { code: 'WALK_NOT_FOUND' }
    })
    expect(await deleteWalk(store, '../../etc')).toMatchObject({
      ok: false,
      error: { code: 'BAD_ARGS' }
    })
  })
})
