// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import InboxRail from '../src/renderer/src/components/InboxRail.vue'
import { useSettingsStore } from '../src/renderer/src/stores/settings'

/**
 * T626 (floating layout S-6) — the opt-in "Floating panels" layout.
 *
 *  - AC-17: the setting is off by default, persisted, applied as an attribute on `<html>`, and every
 *    floating rule is scoped to that attribute so that off renders today's layout untouched.
 *  - AC-19: the top band is three 42px islands on one line; the first island under each column
 *    starts at the same y. jsdom has no layout engine, so this asserts the two halves the layout is
 *    built from (the DOM that marks the band islands, and the CSS that sizes and spaces them); the
 *    measured pixels come from the capture run in the real app.
 */

// `src/main/settings.ts` imports `electron` at module top; stub it so its pure
// `sanitizePatch` is importable without an Electron runtime.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { handle: (): void => {} }
}))

import { sanitizePatch } from '../src/main/settings'

const none = (): (() => void) => () => {}

type SavedPatch = Record<string, unknown>
let saved: SavedPatch[] = []

function stubApi(persisted: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1, ...persisted }
      })),
      settingsSave: vi.fn(async (_path: string, data: SavedPatch) => {
        saved.push(data)
      }),
      uiZoomApply: vi.fn(),
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      })),
      mcpGrantsList: vi.fn(async () => []),
      foldersLoad: vi.fn(async () => []),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      helpersGet: vi.fn(async () => null)
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

const ROOT = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

/** The floating block of main.css, between its two marker comments. */
function floatingCss(): string {
  const css = read('src/renderer/src/styles/main.css')
  const start = css.indexOf('/* floating-panels:start */')
  const end = css.indexOf('/* floating-panels:end */')
  expect(start, 'main.css has the floating-panels:start marker').toBeGreaterThanOrEqual(0)
  expect(end, 'main.css has the floating-panels:end marker').toBeGreaterThan(start)
  return css.slice(start, end)
}

interface Rule {
  selectors: string[]
  decls: Record<string, string>
}

/** A flat CSS reader: no nested at-rules are used inside the floating block. */
function parseRules(css: string): Rule[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    rules.push({ selectors: m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim()), decls })
  }
  return rules
}

/** Declarations of every rule that has a selector containing `fragment`, merged in source order. */
function declsFor(rules: Rule[], fragment: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rules) {
    if (r.selectors.some((s) => s.includes(fragment))) Object.assign(out, r.decls)
  }
  return out
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  i18n.global.locale.value = 'en'
  localStorage.clear()
  document.documentElement.removeAttribute('data-floating')
  saved = []
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-floating')
  vi.useRealTimers()
})

describe('off by default and attribute', () => {
  it('is off by default and leaves <html> without the attribute', async () => {
    const settings = useSettingsStore()
    expect(settings.floatingPanels).toBe(false)
    await settings.init()
    expect(settings.floatingPanels).toBe(false)
    expect(document.documentElement.hasAttribute('data-floating')).toBe(false)
    settings.dispose()
  })

  it('turning it on sets data-floating="on" on <html>, turning it off removes it', async () => {
    const settings = useSettingsStore()
    await settings.init()
    expect(typeof settings.setFloatingPanels).toBe('function')
    settings.setFloatingPanels(true)
    expect(document.documentElement.getAttribute('data-floating')).toBe('on')
    settings.setFloatingPanels(false)
    expect(document.documentElement.hasAttribute('data-floating')).toBe(false)
    settings.dispose()
  })

  it('writes the choice to settings.json after the debounce and adopts a saved value on boot', async () => {
    const settings = useSettingsStore()
    await settings.init()
    expect(typeof settings.setFloatingPanels).toBe('function')
    settings.setFloatingPanels(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(saved).toEqual([{ floatingPanels: true }])
    settings.dispose()

    setActivePinia(createPinia())
    stubApi({ floatingPanels: true })
    const second = useSettingsStore()
    await second.init()
    expect(second.floatingPanels).toBe(true)
    expect(document.documentElement.getAttribute('data-floating')).toBe('on')
    second.dispose()
  })

  it('reads anything but a boolean true as off, on the main side too', () => {
    expect(sanitizePatch({ floatingPanels: true })).toEqual({ floatingPanels: true })
    expect(sanitizePatch({ floatingPanels: false })).toEqual({ floatingPanels: false })
    expect(sanitizePatch({ floatingPanels: 'yes' })).toEqual({})
    expect(sanitizePatch({ floatingPanels: 1 })).toEqual({})
  })

  it('scopes every floating rule to the attribute, so off changes no pixel', () => {
    const rules = parseRules(floatingCss())
    expect(rules.length).toBeGreaterThan(10)
    for (const r of rules) {
      for (const s of r.selectors) {
        expect(s.startsWith(":root[data-floating='on']"), `unscoped selector: ${s}`).toBe(true)
      }
    }
  })

  it('has a Settings → Appearance switch with copy in both locales', () => {
    const dialog = read('src/renderer/src/components/SettingsDialog.vue')
    expect(dialog).toContain('settings.floatingPanels')
    for (const file of ['en', 'pt-BR']) {
      const msgs = JSON.parse(read(`src/renderer/src/i18n/${file}.json`)) as {
        settings: { appearance: { floatingPanels?: { label?: string; hint?: string } } }
      }
      expect(msgs.settings.appearance.floatingPanels?.label, `${file} label`).toBeTruthy()
      expect(msgs.settings.appearance.floatingPanels?.hint, `${file} hint`).toBeTruthy()
    }
  })
})

describe('grid alignment', () => {
  it('defines the gap and band tokens, and a canvas for every theme family', () => {
    const themes = read('src/renderer/src/styles/themes.css')
    expect(themes).toMatch(/--float-gap:\s*4px/)
    expect(themes).toMatch(/--float-radius:\s*4px/)
    expect(themes).toMatch(/--float-band:\s*42px/)
    expect(themes).toMatch(/--color-canvas:\s*color-mix\(in oklab, var\(--color-bg\) 62%, black\)/)
    for (const light of ['light', 'github-light', 'catppuccin-latte', 'gruvbox-light']) {
      const block = themes.match(
        new RegExp(`:root\\[data-theme='${light}'\\]\\s*\\{[\\s\\S]*?\\n\\}`)
      )
      expect(block, `${light} block`).not.toBeNull()
      expect(block![0], `${light} hand-picked canvas`).toMatch(/--color-canvas:\s*#[0-9a-f]{6}/i)
    }
  })

  it('sizes every band island to the band token and spaces what follows by the gap', () => {
    const rules = parseRules(floatingCss())
    const band = declsFor(rules, "[data-floating='on'] [data-island-band]")
    expect(band.height).toBe('var(--float-band)')
    expect(band['box-sizing']).toBe('border-box')
    // The two side columns stack their islands with the gap; the Topbar island is followed by it.
    expect(declsFor(rules, 'aside[data-column]').gap).toBe('var(--float-gap)')
    expect(declsFor(rules, "[data-island='topbar']")['margin-bottom']).toBe('var(--float-gap)')
    // The row of columns carries the same gap to the window edge on every side.
    expect(declsFor(rules, '[data-columns]').padding).toBe('var(--float-gap)')
  })

  it('marks the sidebar toolbar, the Topbar and the Fleet rail header as the three band heads', async () => {
    wrapper = mount(Sidebar, { global: { plugins: [i18n] } })
    await flushPromises()
    const sidebarBand = wrapper.findAll('[data-island-band]')
    expect(sidebarBand).toHaveLength(1)
    // T659: the toolbar is the HEAD of the list island, not an island of its own.
    expect(sidebarBand[0].attributes('data-island')).toBeUndefined()
    expect(sidebarBand[0].attributes('data-island-head')).toBe('sidebar-toolbar')
    const list = wrapper.get('[data-island="sidebar-list"]')
    expect(list.element.firstElementChild).toBe(sidebarBand[0].element)
    expect(list.findAll('[data-island]')).toHaveLength(0)
    const islands = wrapper.findAll('[data-island]').map((n) => n.attributes('data-island'))
    expect(islands[0]).toBe('sidebar-list')
    expect(islands[islands.length - 1]).toBe('sidebar-dock')
    wrapper.unmount()

    wrapper = mount(Topbar, { global: { plugins: [i18n] } })
    await flushPromises()
    const topbarBand = wrapper.findAll('[data-island-band]')
    expect(topbarBand).toHaveLength(1)
    expect(topbarBand[0].attributes('data-island')).toBe('topbar')
    wrapper.unmount()

    wrapper = mount(InboxRail, { global: { plugins: [i18n] } })
    await flushPromises()
    const railBand = wrapper.findAll('[data-island-band]')
    expect(railBand).toHaveLength(1)
    expect(railBand[0].attributes('data-island')).toBeUndefined()
    expect(railBand[0].attributes('data-island-head')).toBe('rail-header')
    const railList = wrapper.get('[data-island="rail-list"]')
    expect(railList.element.firstElementChild).toBe(railBand[0].element)
    const railIslands = wrapper.findAll('[data-island]').map((n) => n.attributes('data-island'))
    expect(railIslands[0]).toBe('rail-list')
    expect(railIslands[railIslands.length - 1]).toBe('rail-would-have')
  })
})

describe('T658 gap, radius and joined heads', () => {
  it('takes every island corner from --float-radius and leaves the global radius alone', () => {
    const rules = parseRules(floatingCss())
    expect(declsFor(rules, '[data-island]')['border-radius']).toBe('var(--float-radius)')
    const themes = read('src/renderer/src/styles/themes.css')
    expect(themes).toMatch(/--radius:\s*7px/)
  })

  it('drives the five column dividers from --float-gap, and keeps the 6px hit area with the layout off', () => {
    const rules = parseRules(floatingCss())
    expect(declsFor(rules, "[data-float-divider][aria-orientation='vertical']").width).toBe(
      'var(--float-gap)'
    )
    expect(declsFor(rules, "[data-float-divider][aria-orientation='horizontal']").height).toBe(
      'var(--float-gap)'
    )
    const app = read('src/renderer/src/App.vue')
    const stack = read('src/renderer/src/components/HelperStack.vue')
    expect(app.match(/data-float-divider/g)).toHaveLength(4)
    expect(stack.match(/data-float-divider/g)).toHaveLength(1)
    // Off, the dividers keep their Tailwind hit area (the floating rules do not apply).
    expect(app.match(/shrink-0 cursor-(col|row)-resize[^"]*"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(app).not.toMatch(/class="group flex w-1 shrink-0/)
  })

  it('sizes a joined head one px under the band, so its inner rule lands on the Topbar edge', () => {
    const rules = parseRules(floatingCss())
    const head = declsFor(rules, '[data-island-head]')
    expect(head.height).toBe('calc(var(--float-band) - 1px) !important')
    // Neither head paints a background or border of its own island any more.
    const bg = rules.find((r) =>
      r.selectors.some((s) => s.includes("[data-island='sidebar-list']"))
    )
    expect(bg?.selectors.join(' ')).not.toContain('sidebar-toolbar')
    expect(bg?.selectors.join(' ')).not.toContain('rail-header')
  })

  it('renders the Return here zone between the list island and the dock, capped and scrolling', () => {
    const sidebar = read('src/renderer/src/components/Sidebar.vue')
    const list = sidebar.indexOf('data-island="sidebar-list"')
    const ret = sidebar.indexOf('<SidebarReturnZone />')
    const dock = sidebar.indexOf('data-island="sidebar-dock"')
    expect(list).toBeGreaterThan(-1)
    expect(ret).toBeGreaterThan(list)
    expect(dock).toBeGreaterThan(ret)
    const zone = read('src/renderer/src/components/SidebarReturnZone.vue')
    expect(zone).toMatch(/max-height:\s*min\(380px,\s*45vh\)/)
    expect(zone).toContain('overflow-y-auto')
  })
})
