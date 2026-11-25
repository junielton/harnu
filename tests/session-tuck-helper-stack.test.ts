// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * T790 delta 1 — while the session is tucked the helper stack lays its panes out side by side (a
 * row), in either orientation (D-1). The unit under test is HelperStack's own layout switch.
 */

// Every pane type renders a probe: the layout around the panes is the job under test.
vi.mock('../src/renderer/src/lib/pane-components', async () => {
  const { defineComponent, h } = await import('vue')
  const Probe = defineComponent({
    props: { pane: { type: Object, required: true }, worktreePath: String, resizable: Boolean },
    emits: ['header-mouse-down', 'open-file'],
    setup(props) {
      return () =>
        h('div', { class: 'probe-pane', 'data-pane-id': (props.pane as { id: string }).id })
    }
  })
  return { paneComponents: new Proxy({}, { get: () => Probe }) }
})

import { i18n } from '@renderer/i18n'
import HelperStack from '../src/renderer/src/components/HelperStack.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

const none = (): (() => void) => () => {}
const FOLDER = '/repo/alpha'
let wrapper: VueWrapper | null = null

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { helpersGet: vi.fn(async () => null), helpersSet: vi.fn(async () => undefined) } as Record<
      string,
      unknown
    >,
    {
      get: (t, k: string) => (k in t ? t[k] : k.startsWith('on') ? none : vi.fn(async () => null))
    }
  )
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function mountStack(): Promise<VueWrapper> {
  useSessionsStore().folders.push({
    path: FOLDER,
    alias: 'alpha',
    expanded: true,
    sessions: [
      {
        sessionId: 's1',
        projectPath: FOLDER,
        summary: '',
        firstPrompt: '',
        modified: new Date().toISOString(),
        resumable: true
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  useSessionsStore().select('s1')
  const helpers = useHelpersStore()
  helpers.addShellHelper(FOLDER, FOLDER)
  helpers.addShellHelper(FOLDER, FOLDER)
  wrapper = mount(HelperStack, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('HelperStack while the session is tucked', () => {
  it('stacks the panes top to bottom when the session is shown, side by side', async () => {
    const w = await mountStack()
    const aside = w.get('#helper-stack-host')
    expect(aside.attributes('data-orientation')).toBe('side-by-side')
    expect(aside.classes()).toContain('flex-col')
    expect(aside.classes()).not.toContain('flex-row')
  })

  it('lays the panes out in a row once the session is tucked, and back when it returns', async () => {
    const w = await mountStack()
    const helpers = useHelpersStore()
    helpers.tuckSession(FOLDER)
    await nextTick()
    const aside = w.get('#helper-stack-host')
    expect(aside.classes()).toContain('flex-row')
    expect(aside.classes()).not.toContain('flex-col')
    expect(aside.classes()).toContain('helper-stack--stacked')
    // A width splitter sits between the two panes, as in the stacked layout.
    expect(w.findAll('[role="separator"][aria-orientation="vertical"]')).toHaveLength(1)
    helpers.showSession(FOLDER)
    await nextTick()
    expect(w.get('#helper-stack-host').classes()).toContain('flex-col')
    expect(w.findAll('[role="separator"]')).toHaveLength(0)
  })

  it('stays a row when the layout is already stacked', async () => {
    useSettingsStore().setSplitLayout('stacked')
    const w = await mountStack()
    expect(w.get('#helper-stack-host').classes()).toContain('flex-row')
    useHelpersStore().tuckSession(FOLDER)
    await nextTick()
    expect(w.get('#helper-stack-host').classes()).toContain('flex-row')
  })

  it("does not carry another worktree's tucked state", async () => {
    const w = await mountStack()
    useHelpersStore().tuckSession('/repo/beta') // no panes there: a no-op, and never this folder's
    await nextTick()
    expect(w.get('#helper-stack-host').classes()).toContain('flex-col')
  })
})
