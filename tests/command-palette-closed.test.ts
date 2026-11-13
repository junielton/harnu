// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import CommandPalette from '../src/renderer/src/components/CommandPalette.vue'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * BUG-265: the palette is always mounted, and its cursor watcher used to evaluate the whole item list
 * (every session sorted by mtime and titled) on every session event while the palette was CLOSED. It now
 * follows the list only while open. This pins the other half: a palette that stayed closed through a burst
 * of session events still opens on the CURRENT recents, never on a stale list.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => (key.startsWith('on') ? none : vi.fn(async () => null))
  })
}

function session(id: string, summary: string, modified: string): Session {
  return {
    sessionId: id,
    fullPath: `/repos/alpha/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary,
    messageCount: 1,
    created: '2026-01-01T00:00:00.000Z',
    modified,
    gitBranch: '',
    projectPath: '/repos/alpha',
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false
  } as Session
}

let wrapper: VueWrapper | null = null

describe('command palette stays correct after being closed through session events (BUG-265)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubApi()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('opens on the recents of NOW, not the ones from before it was closed', async () => {
    const store = useSessionsStore()
    store.folders.push({
      path: '/repos/alpha',
      alias: 'alpha',
      gitBranch: '',
      expanded: true,
      pinned: false,
      sessions: [
        session('s1', 'Alpha work', '2026-02-01T00:00:00.000Z'),
        session('s2', 'Beta work', '2026-02-02T00:00:00.000Z'),
        session('s3', 'Gamma work', '2026-02-03T00:00:00.000Z'),
        session('s4', 'Delta work', '2026-02-04T00:00:00.000Z')
      ]
    } as (typeof store.folders)[number])
    wrapper = mount(CommandPalette, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()

    // While closed: the oldest session gets a transcript append and becomes the newest.
    store.folders[0].sessions[0].modified = '2026-03-01T00:00:00.000Z'
    store.folders[0].sessions[1].summary = 'Beta renamed'
    await flushPromises()

    useUiStore().openPalette()
    await flushPromises()

    const text = document.body.textContent ?? ''
    const at = (label: string): number => text.indexOf(label)
    // Top 3 by mtime: s1 (just appended), s4, s3. s2 is not in the recents.
    expect(at('Alpha work')).toBeGreaterThan(-1)
    expect(at('Alpha work')).toBeLessThan(at('Delta work'))
    expect(at('Delta work')).toBeLessThan(at('Gamma work'))
  })
})
