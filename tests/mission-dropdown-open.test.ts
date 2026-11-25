// @vitest-environment jsdom
/**
 * Mission dropdown · S-7 · AC-21 — every door that opened the Mission pane opens the dropdown instead, on the
 * mission it names, through ONE store action: `openMissionDropdown(missionId?)`. The doors are the Activity row
 * (`openNavigableView('mission', { missionId })`) and the Your move card ("Open mission"); the pill and the
 * `view.missionProgress` chord (AC-20) are the only other openers.
 *
 * Planted faults (each makes the named assertion red): call `toggleMissionHelper` again from the store action;
 * let the Activity door skip the named read; leave `openMissionPane` exported; open the dropdown without waiting
 * for the pill to be drawn.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

const OWNER = 'sess-1'
const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

let missionV4View: ReturnType<typeof vi.fn>

function select(): void {
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: '/repo', sessions: [{ sessionId: OWNER, projectPath: '/repo' }] }
  ] as never
  sessions.select(OWNER)
}

beforeEach(() => {
  setActivePinia(createPinia())
  missionV4View = vi.fn(async () => ({ state: 'none', missions: [] }))
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View,
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

const panes = (): string[] => useHelpersStore().panesForCurrentWorktree.map((p) => p.type)

describe('AC-21 — every door that opened the pane opens the dropdown', () => {
  it('every old door opens the dropdown', async () => {
    select()
    const ui = useUiStore()
    // The pill is drawn for the selected session: its anchor is registered.
    ui.setPopoverAnchor('missionProgress', true)

    // Door 1 — the Activity row: `openNavigableView('mission', { missionId })`.
    ui.openNavigableView('mission', { missionId: 'mnt-1' })
    expect(ui.popovers.missionProgress).toBe(true)
    expect(panes()).toEqual([])

    // The named mission is what the dropdown reads next, even when the session does not lead it.
    await flushPromises()
    expect(missionV4View).toHaveBeenCalled()
    expect(JSON.stringify(missionV4View.mock.calls)).toContain('mnt-1')

    // Door 2 — the Your move card, which calls the one store action; it opens the same dropdown.
    ui.closePopover('missionProgress')
    useMissionsStore().openMissionDropdown('mnt-2')
    expect(ui.popovers.missionProgress).toBe(true)
    expect(panes()).toEqual([])
    await flushPromises()
    expect(JSON.stringify(missionV4View.mock.calls)).toContain('mnt-2')
  })

  it('leaves an open dropdown open, and opens none without a drawn pill or a selected session', async () => {
    select()
    const ui = useUiStore()
    ui.setPopoverAnchor('missionProgress', true)
    const missions = useMissionsStore()
    missions.openMissionDropdown('mnt-1')
    missions.openMissionDropdown('mnt-1')
    expect(ui.popovers.missionProgress).toBe(true)
    ui.closePopover('missionProgress')

    // No selected session: the Topbar draws no pill, so there is nothing to hang the dropdown on.
    setActivePinia(createPinia())
    useUiStore().setPopoverAnchor('missionProgress', false)
    useMissionsStore().openMissionDropdown('mnt-1')
    await flushPromises()
    expect(useUiStore().popovers.missionProgress).toBe(false)
  })

  it('opens as soon as the pill has been drawn for the session the door selected', async () => {
    select()
    const ui = useUiStore()
    // The door selected the owner in the same tick: the pill mounts one tick later.
    useMissionsStore().openMissionDropdown('mnt-1')
    expect(ui.popovers.missionProgress).toBe(false)
    ui.setPopoverAnchor('missionProgress', true)
    await flushPromises()
    expect(ui.popovers.missionProgress).toBe(true)
  })

  it('the pane openers are gone from the doors', () => {
    const store = read('src/renderer/src/stores/missions.ts')
    expect(store).not.toMatch(/openMissionPane/)
    expect(store).not.toMatch(/toggleMissionHelper/)
    const ui = read('src/renderer/src/stores/ui.ts')
    expect(ui).toContain('openMissionDropdown(params.missionId)')
    expect(ui).not.toMatch(/openMissionPane/)
    const card = read('src/renderer/src/components/YourMoveCard.vue')
    expect(card).toContain('openMissionDropdown(action.missionId)')
    expect(card).not.toMatch(/toggleMissionHelper|useHelpersStore/)
    const pill = read('src/renderer/src/components/MissionPill.vue')
    expect(pill).not.toMatch(/toggleMissionHelper|useHelpersStore|aria-pressed/)
  })
})
