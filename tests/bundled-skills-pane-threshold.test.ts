// @vitest-environment jsdom
/**
 * T2 review (PR #194): the doc-reader threshold field in Settings → Skills. Its save is
 * debounced, so a pending save must land on the folder it was typed for — even when the
 * selection moves to another folder, or the pane closes, before the timer fires. And the
 * field belongs to doc-reader only, not to every catalog entry of `kind: 'feature'`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import BundledSkillsPane from '../src/renderer/src/components/BundledSkillsPane.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

const FOLDER_A = '/repo/a'
const FOLDER_B = '/repo/b'

let setMinLines: ReturnType<typeof vi.fn>
let stored: Record<string, number | null>
let wrapper: VueWrapper | null = null

function selectFolder(folderPath: string): void {
  const sessions = useSessionsStore()
  sessions.selectedId = folderPath === FOLDER_A ? 'sess-a' : 'sess-b'
}

async function mountPane(
  catalog = [{ name: 'doc-reader', description: 'reads docs', kind: 'feature' }]
): Promise<VueWrapper> {
  ;(window as unknown as { api: unknown }).api = {
    bundledSkillsGet: vi.fn(async () => ({
      version: 'v1',
      catalog,
      enabled: {},
      userLevelInstall: {},
      collisions: []
    })),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    bundledSkillsGetDocReaderMinLines: vi.fn(async (f: string) => stored[f] ?? null),
    bundledSkillsSetDocReaderMinLines: setMinLines
  }
  wrapper = mount(BundledSkillsPane, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  // Switch to the project scope (the second radio of the scope control).
  await wrapper.findAll('[role="radio"]')[1].trigger('click')
  await flushPromises()
  return wrapper
}

const input = (w: VueWrapper) => w.get<HTMLInputElement>('[data-testid="doc-reader-threshold"]')

beforeEach(() => {
  vi.useFakeTimers()
  i18n.global.locale.value = 'en'
  setActivePinia(createPinia())
  stored = { [FOLDER_A]: null, [FOLDER_B]: 800 }
  setMinLines = vi.fn(async (f: string, n: number | null) => {
    stored[f] = n
    return n
  })
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER_A, alias: 'a', sessions: [{ sessionId: 'sess-a' }] },
    { path: FOLDER_B, alias: 'b', sessions: [{ sessionId: 'sess-b' }] }
  ] as unknown as typeof sessions.folders
  selectFolder(FOLDER_A)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('doc-reader threshold field', () => {
  it('saves a pending value to the folder it was typed for when the selection moves', async () => {
    const w = await mountPane()
    await input(w).setValue('500')
    selectFolder(FOLDER_B) // before the 400 ms debounce fires
    await flushPromises()
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(setMinLines).toHaveBeenCalledTimes(1)
    expect(setMinLines).toHaveBeenCalledWith(FOLDER_A, 500)
    expect(stored[FOLDER_B]).toBe(800)
    // The field shows B's own value, not A's echo.
    expect(input(w).element.value).toBe('800')
  })

  it('saves a pending value when the pane closes before the debounce fires', async () => {
    const w = await mountPane()
    await input(w).setValue('600')
    w.unmount()
    wrapper = null
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(setMinLines).toHaveBeenCalledTimes(1)
    expect(setMinLines).toHaveBeenCalledWith(FOLDER_A, 600)
  })

  it('still debounces a normal edit to one save', async () => {
    const w = await mountPane()
    await input(w).setValue('4')
    await input(w).setValue('45')
    await input(w).setValue('450')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(setMinLines).toHaveBeenCalledTimes(1)
    expect(setMinLines).toHaveBeenCalledWith(FOLDER_A, 450)
  })

  it('belongs to doc-reader only, not to every feature', async () => {
    const w = await mountPane([{ name: 'other-feature', description: 'x', kind: 'feature' }])
    expect(w.find('[data-testid="doc-reader-threshold"]').exists()).toBe(false)
  })
})
