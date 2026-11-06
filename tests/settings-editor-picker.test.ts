// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog.vue'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'

/**
 * T581 — Settings → General → Editor: the preset picker, and the Custom command
 * field + "Runs in a terminal" switch that appear only for Custom.
 */

beforeEach(() => {
  setActivePinia(createPinia())
  // Any `window.api.*` the big dialog touches on mount resolves to nothing.
  const api = new Proxy({}, { get: () => vi.fn(async () => undefined) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
  useUiStore().openDialog('settings')
})

function mountDialog() {
  return mount(SettingsDialog, { global: { plugins: [i18n], stubs: { teleport: true } } })
}

describe('Settings → Editor', () => {
  it('lists every preset plus Custom, defaulting to VS Code', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const select = wrapper.get('[data-test="settings-editor-select"]')
    const labels = select.findAll('option').map((o) => o.text())
    expect(labels).toEqual([
      'VS Code',
      'Cursor',
      'Zed',
      'Sublime Text',
      'JetBrains',
      'Neovim',
      'Helix',
      'Custom…'
    ])
    expect((select.element as HTMLSelectElement).value).toBe('vscode')
    expect(wrapper.find('[data-test="settings-editor-command"]').exists()).toBe(false)
  })

  it('picking a preset updates the setting, and names the command it runs', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('[data-test="settings-editor-select"]').setValue('neovim')
    expect(useSettingsStore().editor).toEqual({ id: 'neovim' })
    expect(wrapper.get('#set-editor').text()).toContain('Runs `nvim` in a terminal pane.')
  })

  it('Custom reveals the command field and the terminal switch', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('[data-test="settings-editor-select"]').setValue('custom')
    const input = wrapper.get('[data-test="settings-editor-command"]')
    expect(input.attributes('placeholder')).toBe('nvim {path}')
    await input.setValue('foo --bar {path}')
    await wrapper.get('[data-test="settings-editor-terminal"]').trigger('click')
    expect(useSettingsStore().editor).toEqual({
      id: 'custom',
      customCommand: 'foo --bar {path}',
      customTerminal: true
    })
  })
})
