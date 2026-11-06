// @vitest-environment jsdom
/**
 * T599 AC-3 — a folded Activity row reads "already reported · ×N" in both
 * locales; a row that was never folded shows no marker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

let wrapper: VueWrapper | null = null

function post(unit: string): void {
  useNotificationsStore().notify({
    ts: Date.now(),
    source: 'app',
    kind: 'success',
    title: 'Session completed',
    description: 'proj · builder',
    sessionId: 's1',
    notificationType: 'completed',
    unit
  })
}

async function openBell(): Promise<VueWrapper> {
  wrapper = mount(ActivityBell, { attachTo: document.body, global: { plugins: [i18n] } })
  await wrapper.get('[data-dsqa="topbar-bell"]').trigger('click')
  await nextTick()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = { missionList: vi.fn(() => new Promise(() => {})) }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ActivityBell — folded repeats', () => {
  it('shows "already reported · ×3" on a row folded three times', async () => {
    post('step:mnt-1/stp-3')
    post('step:mnt-1/stp-3')
    post('step:mnt-1/stp-3')
    const w = await openBell()
    expect(w.findAll('[data-dsqa="activity-row"]')).toHaveLength(1)
    expect(w.get('[data-dsqa="activity-row-count"]').text()).toBe('already reported · ×3')
  })

  it('reads in Portuguese in the pt-BR locale', async () => {
    i18n.global.locale.value = 'pt-BR'
    post('card:T599')
    post('card:T599')
    const w = await openBell()
    expect(w.get('[data-dsqa="activity-row-count"]').text()).toBe('já informado · ×2')
  })

  it('shows no marker on a row that was never folded', async () => {
    post('step:mnt-1/stp-3')
    post('step:mnt-1/stp-4')
    const w = await openBell()
    expect(w.findAll('[data-dsqa="activity-row"]')).toHaveLength(2)
    expect(w.find('[data-dsqa="activity-row-count"]').exists()).toBe(false)
  })
})
