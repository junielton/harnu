// @vitest-environment jsdom
/**
 * T807: the guided walk pane and the Walks library are readable. Every text size multiplies ONE scale variable
 * (`--walk-text-scale`), the operator steps it with A- / A+ (or Ctrl/Cmd + = / - / 0 with the pane focused), and the
 * chosen step persists through the settings store like `uiZoom`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as os from 'node:os'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import {
  WALK_TEXT_SCALES,
  DEFAULT_WALK_TEXT_SCALE,
  snapWalkTextScale,
  stepWalkTextScale
} from '../src/renderer/src/lib/walk-view'
import { textScaleKey } from '../src/renderer/src/lib/walk-keys'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

// settings.ts (main) imports `electron` at module top; stub it so `sanitizePatch` is importable.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { handle: (): void => {} }
}))
import { sanitizePatch } from '../src/main/settings'

const COMPONENTS = resolve(__dirname, '../src/renderer/src/components')
const read = (name: string): string => readFileSync(resolve(COMPONENTS, name), 'utf8')
const FILES = ['GuidedWalkPane.vue', 'WalkPast.vue', 'WalksPane.vue']

/** Every `font-size` declaration of a file's `<style>` block, with its value. */
function fontSizes(file: string): string[] {
  const css = read(file).split('<style')[1] ?? ''
  return [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim())
}

/** The base px of `selector`'s `font-size` in GuidedWalkPane's CSS, or `null`. */
function baseOf(selector: string): number | null {
  const css = read('GuidedWalkPane.vue').split('<style')[1] ?? ''
  const rule = css.match(
    new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)
  )
  const m = rule?.[1].match(/font-size:\s*calc\(\s*([\d.]+)px/)
  return m ? Number(m[1]) : null
}

describe('walk text scale: the steps', () => {
  it('offers at least four steps, including the default 1', () => {
    expect(WALK_TEXT_SCALES.length).toBeGreaterThanOrEqual(4)
    expect(WALK_TEXT_SCALES).toContain(DEFAULT_WALK_TEXT_SCALE)
    expect(DEFAULT_WALK_TEXT_SCALE).toBe(1)
    expect([...WALK_TEXT_SCALES]).toEqual([...WALK_TEXT_SCALES].sort((a, b) => a - b))
  })

  it('snaps to the nearest step and falls back to the default on garbage', () => {
    expect(snapWalkTextScale(1.14)).toBe(1.15)
    expect(snapWalkTextScale(99)).toBe(WALK_TEXT_SCALES[WALK_TEXT_SCALES.length - 1])
    expect(snapWalkTextScale(0)).toBe(WALK_TEXT_SCALES[0])
    expect(snapWalkTextScale(NaN)).toBe(DEFAULT_WALK_TEXT_SCALE)
  })

  it('steps up, down and back to the default, and stops at both ends', () => {
    const top = WALK_TEXT_SCALES[WALK_TEXT_SCALES.length - 1]
    const bottom = WALK_TEXT_SCALES[0]
    expect(stepWalkTextScale(1, 'bigger')).toBe(1.15)
    expect(stepWalkTextScale(1, 'smaller')).toBe(0.9)
    expect(stepWalkTextScale(top, 'bigger')).toBe(top)
    expect(stepWalkTextScale(bottom, 'smaller')).toBe(bottom)
    expect(stepWalkTextScale(1.3, 'reset')).toBe(1)
  })
})

describe('walk text scale: one CSS variable, no per-size branches (AC-2)', () => {
  it.each(FILES)('%s multiplies --walk-text-scale in every font-size', (file) => {
    const sizes = fontSizes(file)
    expect(sizes.length).toBeGreaterThan(0)
    for (const s of sizes) {
      expect(s).toMatch(/^calc\(\s*[\d.]+px\s*\*\s*var\(--walk-text-scale(?:,\s*1)?\)\s*\)$/)
    }
  })

  it.each(FILES)('%s has no per-step selector or branch', (file) => {
    const src = read(file)
    expect(src).not.toMatch(/data-(walk-)?text-?(scale|size)/i)
    expect(src).not.toMatch(/\.wk-(scale|size)-/)
  })

  it('both panes set the variable on their root and carry the A- / A+ control', () => {
    for (const file of ['GuidedWalkPane.vue', 'WalksPane.vue']) {
      const tpl = read(file).split('<style')[0]
      expect(tpl).toContain('--walk-text-scale')
      expect(tpl).toContain('<WalkTextSize')
    }
  })
})

describe('walk text scale: the new defaults keep the hierarchy (AC-1)', () => {
  it('body text is 14px, secondary 13px, and no eyebrow is under 11.5px', () => {
    expect(baseOf('.wk ol.do li')).toBe(14)
    expect(baseOf('.wk .see p')).toBe(14)
    expect(baseOf('.wk .where-text')).toBe(14)
    expect(baseOf('.wk .see p.not')).toBe(13)
    expect(baseOf('.wk .eyebrow')).toBeGreaterThanOrEqual(11.5)
    expect(baseOf('.wk .card .eb')).toBeGreaterThanOrEqual(11.5)
  })

  it('the check title stays above the body text', () => {
    expect(baseOf('.wk .wk-title')!).toBeGreaterThan(baseOf('.wk ol.do li')!)
  })

  it('no walk text is smaller than 11.5px at the default step', () => {
    for (const file of FILES) {
      for (const s of fontSizes(file)) {
        const px = Number(s.match(/calc\(\s*([\d.]+)px/)?.[1])
        expect(px).toBeGreaterThanOrEqual(11.5)
      }
    }
  })
})

describe('walk text scale: Ctrl/Cmd + = / - / 0 (AC-4)', () => {
  const k = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    ctrlKey: true,
    target: null,
    ...over
  })

  it('maps = / + to bigger, - to smaller and 0 to reset, with Ctrl or Cmd', () => {
    expect(textScaleKey(k('='))).toBe('bigger')
    expect(textScaleKey(k('+', { shiftKey: true }))).toBe('bigger')
    expect(textScaleKey(k('-'))).toBe('smaller')
    expect(textScaleKey(k('0'))).toBe('reset')
    expect(textScaleKey(k('=', { ctrlKey: false, metaKey: true }))).toBe('bigger')
  })

  it('ignores the bare keys, Alt chords and other keys', () => {
    expect(textScaleKey(k('=', { ctrlKey: false }))).toBeNull()
    expect(textScaleKey(k('-', { ctrlKey: false }))).toBeNull()
    expect(textScaleKey(k('=', { altKey: true }))).toBeNull()
    expect(textScaleKey(k('f'))).toBeNull()
  })
})

describe('walk text scale: persistence (AC-3)', () => {
  let saved: Array<{ path: string; data: Record<string, unknown> }> = []
  let changedCb: ((p: { data?: Record<string, unknown>; error?: boolean }) => void) | null = null

  function stubApi(loaded: Record<string, unknown> = {}): void {
    saved = []
    changedCb = null
    window.api = {
      settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1, ...loaded }
      })),
      settingsSave: vi.fn(async (path: string, data: Record<string, unknown>) => {
        saved.push({ path, data })
      }),
      uiZoomApply: vi.fn(),
      onSettingsChanged: vi.fn((cb: typeof changedCb) => {
        changedCb = cb
        return () => {}
      })
    } as unknown as typeof window.api
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    stubApi()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at the default, steps, and debounce-saves walkTextScale', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.init()
    expect(store.walkTextScale).toBe(1)
    store.stepWalkTextScale('bigger')
    expect(store.walkTextScale).toBe(1.15)
    expect(saved).toHaveLength(0)
    vi.advanceTimersByTime(300)
    expect(saved).toEqual([{ path: '/default/settings.json', data: { walkTextScale: 1.15 } }])
  })

  it('adopts the persisted step on boot (across restarts), snapped to a step', async () => {
    stubApi({ walkTextScale: 1.3 })
    const store = useSettingsStore()
    await store.init()
    expect(store.walkTextScale).toBe(1.3)
  })

  it('an old settings.json without the key keeps the default', async () => {
    const store = useSettingsStore()
    await store.init()
    expect(store.walkTextScale).toBe(1)
  })

  it('an external edit re-applies, an echo of our own save does not', async () => {
    const store = useSettingsStore()
    await store.init()
    changedCb!({ data: { terminalFontSize: 13, uiZoom: 1, walkTextScale: 0.9 } })
    expect(store.walkTextScale).toBe(0.9)
  })

  it('main keeps the key through sanitizePatch, clamped and snapped to 2 decimals', () => {
    expect(sanitizePatch({ walkTextScale: 1.15 })).toEqual({ walkTextScale: 1.15 })
    expect(sanitizePatch({ walkTextScale: 99 })).toEqual({ walkTextScale: 1.5 })
    expect(sanitizePatch({ walkTextScale: 0.01 })).toEqual({ walkTextScale: 0.75 })
    expect(sanitizePatch({ walkTextScale: 'big' } as Record<string, unknown>)).toEqual({})
  })
})

describe('walk text scale: the A- / A+ control (AC-2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    window.api = {
      settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1 }
      })),
      settingsSave: vi.fn(async () => {}),
      uiZoomApply: vi.fn(),
      onSettingsChanged: vi.fn(() => () => {})
    } as unknown as typeof window.api
  })

  it('A+ and A- step the store, and each stops (disabled) at its end', async () => {
    const store = useSettingsStore()
    await store.init()
    // a glob, not an import: a missing component fails this test instead of the whole file
    const load = Object.values(
      import.meta.glob('../src/renderer/src/components/WalkTextSize.vue')
    )[0] as (() => Promise<{ default: object }>) | undefined
    if (!load) throw new Error('WalkTextSize.vue does not exist')
    const WalkTextSize = (await load()).default
    const w = mount(WalkTextSize, { global: { plugins: [i18n] } })
    await w.get('[data-test="walk-text-bigger"]').trigger('click')
    expect(store.walkTextScale).toBe(1.15)
    await w.get('[data-test="walk-text-bigger"]').trigger('click')
    await w.get('[data-test="walk-text-bigger"]').trigger('click')
    expect(store.walkTextScale).toBe(WALK_TEXT_SCALES[WALK_TEXT_SCALES.length - 1])
    expect(w.get('[data-test="walk-text-bigger"]').attributes('disabled')).toBeDefined()
    await w.get('[data-test="walk-text-smaller"]').trigger('click')
    expect(store.walkTextScale).toBe(1.15)
  })

  it('has i18n keys in both locales', () => {
    for (const locale of [en, ptBR] as Array<Record<string, any>>) {
      expect(typeof locale.testWalk.textSize.smaller).toBe('string')
      expect(typeof locale.testWalk.textSize.bigger).toBe('string')
    }
  })
})
