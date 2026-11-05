// @vitest-environment jsdom
// U3.7 AC-4/AC-5: the Containers store words the stale-volume push into Activity rows: one row for
// one project, ONE grouped entry when several projects are affected, both with "Open Containers".
import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useContainersStore } from '../src/renderer/src/stores/containers'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import type { ContainersStaleVolumesAlert } from '../src/preload'

function install(): (a: ContainersStaleVolumesAlert) => void {
  let handler: ((a: ContainersStaleVolumesAlert) => void) | null = null
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      containersSnapshot: async () => null,
      onContainersUpdate: () => () => undefined,
      onContainersNewZombies: () => () => undefined,
      onContainersStaleVolumes: (cb: (a: ContainersStaleVolumesAlert) => void) => {
        handler = cb
        return () => (handler = null)
      }
    }
  }
  return (a) => handler?.(a)
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('the stale-volume Activity row', () => {
  it('one project, one volume: the approved sentence and the Open Containers action', async () => {
    const fire = install()
    await useContainersStore().init()
    fire({ warnings: [{ volume: 'ext-12_mysql', project: 'ext-12', worktree: 'feat-old' }] })
    const rows = useNotificationsStore().list
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'app',
      kind: 'warning',
      title: 'Data in this volume may be stale',
      description:
        'Project ext-12 mounts volume ext-12_mysql that belonged to a removed worktree (feat-old). Its data may be stale.',
      action: { label: 'Open Containers' },
      target: { view: 'containers' }
    })
    expect(rows[0]!.items).toBeUndefined()
  })

  it('one project with two volumes stays one row naming both', async () => {
    const fire = install()
    await useContainersStore().init()
    fire({
      warnings: [
        { volume: 'ext-12_mysql', project: 'ext-12', worktree: 'feat-old' },
        { volume: 'ext-12_redis', project: 'ext-12', worktree: 'feat-old' }
      ]
    })
    const rows = useNotificationsStore().list
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Data in these volumes may be stale')
    expect(rows[0]!.description).toContain('ext-12_mysql, ext-12_redis')
    expect(rows[0]!.description).toContain('feat-old')
  })

  it('several projects fold into ONE grouped entry with one item per project', async () => {
    const fire = install()
    await useContainersStore().init()
    fire({
      warnings: [
        { volume: 'ext-12_mysql', project: 'ext-12', worktree: 'feat-old' },
        { volume: 'proj-34_redis', project: 'proj-34', worktree: 'feat-old-2' },
        { volume: 'ext-12_redis', project: 'ext-12', worktree: 'feat-old' }
      ]
    })
    const rows = useNotificationsStore().list
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'warning',
      title: '2 projects mount volumes that may be stale',
      action: { label: 'Open Containers' },
      target: { view: 'containers' }
    })
    expect(rows[0]!.items).toEqual([
      {
        id: 'ext-12',
        title: 'ext-12_mysql, ext-12_redis',
        description: 'Used by ext-12 · from removed feat-old',
        target: { view: 'containers' }
      },
      {
        id: 'proj-34',
        title: 'proj-34_redis',
        description: 'Used by proj-34 · from removed feat-old-2',
        target: { view: 'containers' }
      }
    ])
  })

  it('an empty alert records nothing', async () => {
    const fire = install()
    await useContainersStore().init()
    fire({ warnings: [] })
    expect(useNotificationsStore().list).toHaveLength(0)
  })

  it('pt-BR has every containers.staleVolume key the English copy has', () => {
    const keys = (o: Record<string, unknown>): string[] => Object.keys(o).sort()
    const en = (enMessages as { containers: { staleVolume: Record<string, unknown> } }).containers
      .staleVolume
    const pt = (ptMessages as { containers: { staleVolume: Record<string, unknown> } }).containers
      .staleVolume
    expect(keys(pt)).toEqual(keys(en))
    expect(i18n.global.locale).toBeDefined()
  })
})
