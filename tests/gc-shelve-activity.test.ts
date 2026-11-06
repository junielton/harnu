// Each shelve leaves one Activity line with its reason (U2.2 AC-7): "Shelved `feat/x` — idle 9 d,
// branch kept". The cycle record carries the structured facts; the store words them in the app's
// language and pushes one row per shelve, once per cycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { CycleRecord, GcSnapshot } from '../src/main/gc/gc-wire'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { i18n } from '../src/renderer/src/i18n'
import { NOW } from './gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

function install(): { push: Record<string, (p: unknown) => void> } {
  const push: Record<string, (p: unknown) => void> = {}
  const sub =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      push[name] = cb
      return () => delete push[name]
    }
  const snap = {
    scannedAt: NOW,
    bundles: [],
    orphanVolumes: [],
    orphanTranscripts: [],
    stackLeftovers: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    shelved: []
  } as unknown as GcSnapshot
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      gcSnapshot: vi.fn(async () => snap),
      gcJobs: vi.fn(async () => []),
      gcRecoveryList: vi.fn(async () => []),
      gcRecoveryAck: vi.fn(async () => undefined),
      onGcRecoveryChanged: sub('recovery'),
      onGcProgress: sub('progress'),
      onGcDone: sub('done'),
      onGcCycle: sub('cycle'),
      onGcOpinionResult: sub('opinion'),
      onGcOpinionDone: sub('opinionDone')
    }
  }
  ;(globalThis as unknown as { document: unknown }).document = { hasFocus: () => true }
  return { push }
}

const cycle = (
  at: number,
  shelved: CycleRecord['shelve'] extends infer S ? S : never
): CycleRecord =>
  ({
    at,
    trigger: 'timer',
    mode: 'off',
    found: 0,
    foundBytes: 0,
    cleaned: [],
    freedBytes: 0,
    trashedBytes: 0,
    archivesExpired: 0,
    deferred: 0,
    housekeeping: null,
    notified: false,
    jobId: null,
    shelve: shelved
  }) as CycleRecord

const record = (shelved: NonNullable<CycleRecord['shelve']>['shelved']): CycleRecord['shelve'] => ({
  mode: 'shelve',
  found: shelved.length,
  foundBytes: 0,
  shelved,
  refused: 0,
  failed: 0,
  deferred: 0,
  paused: false,
  locked: 0,
  journalFailed: 0
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('the Activity line of a shelve', () => {
  it('words the reason from the facts: branch, days idle, "branch kept"', () => {
    expect(t('cleanup.gc.shelved.activity', { branch: 'feat/x', days: 9 })).toBe(
      'Shelved `feat/x` — idle 9 d, branch kept'
    )
    expect(t('cleanup.gc.shelved.activityDetached', { days: 4 })).toContain('detached HEAD')
  })

  it('pushes one Activity row per shelved worktree when a cycle ends', async () => {
    const api = install()
    const notify = vi.spyOn(useNotificationsStore(), 'notify')
    await useGcStore().init()
    api.push.cycle!(
      cycle(
        NOW,
        record([
          {
            id: 'a',
            branch: 'feat/x',
            folderAlias: 'x',
            folderPath: '/w/x',
            idleDays: 9,
            freedBytes: 1
          },
          {
            id: 'b',
            branch: null,
            folderAlias: 'y',
            folderPath: '/w/y',
            idleDays: 4,
            freedBytes: null
          }
        ])
      )
    )
    const rows = notify.mock.calls.map((c) => c[0])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      source: 'app',
      title: 'Shelved `feat/x` — idle 9 d, branch kept',
      folderPath: '/w/x',
      target: { view: 'cleanup' }
    })
    expect(rows[1]!.title).toBe(t('cleanup.gc.shelved.activityDetached', { days: 4 }))
  })

  it('the same cycle record twice is one set of rows, a later cycle adds its own', async () => {
    const api = install()
    const notify = vi.spyOn(useNotificationsStore(), 'notify')
    await useGcStore().init()
    const one = cycle(
      NOW,
      record([
        {
          id: 'a',
          branch: 'feat/x',
          folderAlias: 'x',
          folderPath: '/w/x',
          idleDays: 9,
          freedBytes: 1
        }
      ])
    )
    api.push.cycle!(one)
    api.push.cycle!(one)
    expect(notify).toHaveBeenCalledTimes(1)
    api.push.cycle!({
      ...one,
      at: NOW + 3_600_000,
      shelve: record([
        {
          id: 'c',
          branch: 'feat/z',
          folderAlias: 'z',
          folderPath: '/w/z',
          idleDays: 5,
          freedBytes: 1
        }
      ])
    })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a cycle that shelved nothing, or has no shelve record, adds no row', async () => {
    const api = install()
    const notify = vi.spyOn(useNotificationsStore(), 'notify')
    await useGcStore().init()
    api.push.cycle!(cycle(NOW, record([])))
    api.push.cycle!({ ...cycle(NOW + 1, record([])), shelve: undefined })
    expect(notify).not.toHaveBeenCalled()
  })
})
