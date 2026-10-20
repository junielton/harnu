// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { useUiStore, SETTINGS_TAB_IDS } from '../src/renderer/src/stores/ui'
import { DESCRIPTOR_BY_ID, labelKeyFor, type ShortcutActionId } from '../src/main/keybindings-core'

/**
 * T486 §3.5 / AC-49 — every Settings tab has a `view.settings.<tab>` id.
 *
 * `SETTINGS_TAB_IDS` is built from a `Record<SettingsTabId, true>`, so the
 * compiler already refuses a list that misses a member of the union or adds one
 * outside it. These tests pin the list to the tabs the dialog actually renders
 * and to the table rows and labels generated from it.
 */

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SETTINGS_TAB_IDS equals the SettingsTabId union', () => {
  it('has no duplicates', () => {
    expect(new Set(SETTINGS_TAB_IDS).size).toBe(SETTINGS_TAB_IDS.length)
  })

  it('lists exactly the tabs SettingsDialog renders', () => {
    const dialog = read('src/renderer/src/components/SettingsDialog.vue')
    const rendered = [...dialog.matchAll(/id: '([a-zA-Z]+)',\s*labelKey: 'settings\.tabs\./g)].map(
      (m) => m[1]
    )
    expect(rendered.length).toBeGreaterThan(0)
    expect([...SETTINGS_TAB_IDS].sort()).toEqual(rendered.sort())
  })

  it('lists exactly the tab labels the locale has', () => {
    expect([...SETTINGS_TAB_IDS].sort()).toEqual(Object.keys(en.settings.tabs).sort())
  })

  it('is exported next to the SettingsTabId type, built from a Record over the union', () => {
    const ui = read('src/renderer/src/stores/ui.ts')
    expect(ui).toMatch(/Record<SettingsTabId, true>/)
    expect(ui).toMatch(/export const SETTINGS_TAB_IDS/)
  })
})

describe('AC-49 — one view.settings.<tab> id per tab', () => {
  for (const tab of SETTINGS_TAB_IDS) {
    const id = `view.settings.${tab}` as ShortcutActionId

    it(id, () => {
      const d = DESCRIPTOR_BY_ID[id]
      expect(d, `${id} is missing from KEYBINDINGS`).toBeDefined()
      expect(d.group).toBe('views')
      expect(d.defaultKeys).toBe(tab === 'keybindings' ? 'Cmd+Alt+S' : null)
      expect(d.menu).toBe(tab === 'keybindings')

      // "Open Settings: <the tab's own name>" in each locale.
      const tabs = { en: en.settings.tabs, 'pt-BR': ptBR.settings.tabs } as const
      for (const locale of ['en', 'pt-BR'] as const) {
        const label = i18n.global.t(labelKeyFor(id), {}, { locale }) as string
        expect(label, `${locale}: ${id}`).toContain(
          tabs[locale][tab as keyof typeof en.settings.tabs]
        )
      }
      expect(i18n.global.t(labelKeyFor(id), {}, { locale: 'en' })).toBe(
        `Open Settings: ${en.settings.tabs[tab as keyof typeof en.settings.tabs]}`
      )
    })

    it(`${id} opens Settings on that tab through ui.openSettings`, () => {
      const ui = useUiStore()
      ui.openSettings(tab)
      expect(ui.dialog).toBe('settings')
      expect(ui.settingsTab).toBe(tab)
    })
  }
})

describe('AC-36 — the raw-file action reads "Open keybindings.json"', () => {
  it('en and pt-BR', () => {
    expect(en.keybindings.actions.app_openKeybindings).toBe('Open keybindings.json')
    expect(ptBR.keybindings.actions.app_openKeybindings).toBe('Abrir o keybindings.json')
  })
})
