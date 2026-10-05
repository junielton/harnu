// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import TakeoverHost from '../src/renderer/src/components/TakeoverHost.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import en from '../src/renderer/src/i18n/en.json'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

/**
 * T300/U3 regression — the FIRST takeover a session opens mounts `TakeoverShell`
 * (the icon/actions Teleport targets) and the view's own Teleport source in the
 * SAME synchronous pass. Without `<Teleport defer>`, Vue resolves the target
 * before `TakeoverShell`'s own header span is connected to the document, so the
 * icon silently never renders — see the two "Failed to locate Teleport target"
 * warnings this reproduced before the fix. `defer` (Vue 3.5+) makes Teleport
 * resolve its target after the rest of the same-tick mount/update, which is
 * exactly this ordering.
 */
describe('TakeoverShell icon Teleport on a cold mount', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => () => {} })
  })

  it('lands the icon even when this is the very first TakeoverShell mount', async () => {
    const ui = useUiStore()
    ui.toggleSystemMonitor()

    const wrapper = mount(TakeoverHost, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()

    const icon = document.querySelector('#takeover-shell-icon')
    expect(icon?.querySelector('svg')).not.toBeNull()

    wrapper.unmount()
  })
})
