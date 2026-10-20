// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import KeybindingsPane from '../src/renderer/src/components/KeybindingsPane.vue'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { i18n } from '@renderer/i18n'
import { KEYBINDINGS, labelKeyFor, resolveKeybindings } from '../src/main/keybindings-core'

/**
 * T486 §4 — the Keyboard Shortcuts pane rendered raw i18n keys
 * (`keybindings.actions.session.new`) because the ids contain dots and
 * vue-i18n resolves a key as a dotted path. Every label now comes from
 * `labelKeyFor(id)` (dots → underscores). These tests load the REAL catalog —
 * the earlier pane test never rendered the component, which is how the bug
 * shipped.
 */

const LOCALES = ['en', 'pt-BR'] as const

describe('labelKeyFor + the descriptor table', () => {
  it('derives every labelKey from labelKeyFor', () => {
    for (const d of KEYBINDINGS) expect(d.labelKey).toBe(labelKeyFor(d.id))
  })

  it('encodes dots as underscores under keybindings.actions', () => {
    expect(labelKeyFor('session.new')).toBe('keybindings.actions.session_new')
    expect(labelKeyFor('view.settings.keybindings')).toBe(
      'keybindings.actions.view_settings_keybindings'
    )
  })

  it('resolves every labelKey to a real string in both locales (no fallback)', () => {
    for (const locale of LOCALES) {
      for (const d of KEYBINDINGS) {
        // `te` checks THIS locale only — `t` would hide a pt-BR gap behind the en fallback.
        expect(i18n.global.te(d.labelKey, locale), `${locale}: ${d.labelKey}`).toBe(true)
        const text = i18n.global.t(d.labelKey, {}, { locale })
        expect(text).not.toBe(d.labelKey)
        expect(text.startsWith('keybindings.')).toBe(false)
      }
    }
  })

  it('has unique labelKeys (the _ encoding cannot fold two ids)', () => {
    const keys = KEYBINDINGS.map((d) => d.labelKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('KeybindingsPane renders human labels', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { api: unknown }).api = {
      keybindingsSave: vi.fn(async () => {})
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    i18n.global.locale.value = 'en'
  })

  for (const locale of LOCALES) {
    it(`shows no raw keybindings.actions.* text or aria-label (${locale})`, async () => {
      i18n.global.locale.value = locale
      const store = useKeybindingsStore()
      // A conflict so the conflict badge (which names the other action) renders too.
      store.resolved = resolveKeybindings([{ command: 'view.review', key: 'Cmd+Shift+B' }], {
        mac: false
      })
      wrapper = mount(KeybindingsPane, { global: { plugins: [i18n] }, attachTo: document.body })
      await flushPromises()

      const text = wrapper.text()
      expect(text).not.toContain('keybindings.actions.')
      expect(text).toContain(i18n.global.t(labelKeyFor('session.new'), {}, { locale }) as string)
      expect(wrapper.findAll('[data-kb-conflict]').length).toBeGreaterThan(0)

      const labelled = wrapper.findAll('[aria-label]')
      expect(labelled.length).toBeGreaterThan(0)
      for (const el of labelled) {
        expect(el.attributes('aria-label')).not.toContain('keybindings.actions.')
      }
    })
  }
})
