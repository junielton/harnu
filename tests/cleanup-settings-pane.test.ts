// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import CleanupSettingsPane from '../src/renderer/src/components/CleanupSettingsPane.vue'
import { i18n } from '@renderer/i18n'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import { NOW } from './gc-fixtures'

const t = (key: string): string => i18n.global.t(key) as string
import { cloneGuardedApi } from './helpers/containers-api'

/**
 * T443 — Settings → Cleanup. One pane for every `GcPrefs` field plus the Reaper-only ones GC does
 * not cover. Mounted over a stubbed preload: every control must read the prefs and write the WHOLE
 * object back through `gcSetPrefs` (main fills a missing field with its default, so a partial would
 * silently reset the rest), and show what main answered.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const GC: GcPrefs = { ...defaultGcPrefs(), keep: { 'repo::worktree::/a': 'merged' } }
const REAPER = {
  version: 1,
  autoScan: true,
  intervalMs: 3_600_000,
  notifyOnHarvestable: true,
  neverDeleteRemote: false,
  protectedBranches: ['main'],
  minAgeDays: 0,
  dehydrateIdleDays: 7
}

let setGc: ReturnType<typeof vi.fn>
let setReaper: ReturnType<typeof vi.fn>

function stubApi(initial: GcPrefs): void {
  const snapshot: GcSnapshot = {
    scannedAt: NOW,
    bundles: [],
    orphanVolumes: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: initial,
    lastCycle: null,
    nextCycleAt: null
  }
  // Main clamps like `normalizeGcPrefs`; echo the object back the way it answers.
  setGc = vi.fn(async (p: GcPrefs) => ({
    ...p,
    graceDays: Math.min(30, Math.max(0, p.graceDays)),
    maxItemsPerCycle: Math.min(200, Math.max(1, p.maxItemsPerCycle)),
    cacheMaxAgeDays: Math.min(365, Math.max(1, p.cacheMaxAgeDays))
  }))
  setReaper = vi.fn(async (p: unknown) => p)
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi({
    gcPrefs: vi.fn(async () => initial),
    gcSetPrefs: setGc,
    gcSnapshot: vi.fn(async () => snapshot),
    gcJobs: vi.fn(async () => []),
    onGcProgress: () => () => {},
    onGcDone: () => () => {},
    onGcCycle: () => () => {},
    reaperPrefs: vi.fn(async () => REAPER),
    reaperSetPrefs: setReaper
  })
}

async function mountPane(initial: GcPrefs = GC): Promise<VueWrapper> {
  stubApi(initial)
  const wrapper = mount(CleanupSettingsPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const tid = (w: VueWrapper, id: string) => w.get(`[data-testid="${id}"]`)
const radio = (w: VueWrapper, text: string) =>
  w.findAll('[role="radio"]').find((b) => b.text() === text)!

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CleanupSettingsPane — every GcPrefs field has a control', () => {
  it('renders a control for each editable field, and none for the internal three', async () => {
    const w = await mountPane()
    for (const id of [
      'gc-autopilot',
      'gc-interval',
      'gc-grace',
      'gc-cap',
      'gc-cat-worktrees',
      'gc-cat-docker-cache',
      'gc-cache-age',
      'gc-never-input'
    ]) {
      expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
    // D1: there is no volumes switch and no removeVolumes switch — volumes are always kept.
    expect(w.find('[data-testid="gc-cat-volumes"]').exists()).toBe(false)
    expect(w.find('[data-testid="gc-remove-volumes"]').exists()).toBe(false)
    // The shape of the contract (S3 delta 2): GcPrefs minus version / keep / firstReportAcknowledged.
    // `removeVolumes` and `categories.volumes` are gone from the engine as well as from the pane.
    const editable = Object.keys(GC).filter(
      (k) => !['version', 'keep', 'firstReportAcknowledged'].includes(k)
    )
    expect(editable.sort()).toEqual(
      [
        'autopilot',
        'intervalMs',
        'graceDays',
        'maxItemsPerCycle',
        'categories',
        'cacheMaxAgeDays',
        'neverClean'
      ].sort()
    )
    w.unmount()
  })

  it('shows the current values', async () => {
    const w = await mountPane({ ...GC, autopilot: true, graceDays: 5, maxItemsPerCycle: 30 })
    expect(tid(w, 'gc-autopilot').attributes('aria-checked')).toBe('true')
    expect((tid(w, 'gc-grace').element as HTMLInputElement).value).toBe('5')
    expect((tid(w, 'gc-cap').element as HTMLInputElement).value).toBe('30')
    expect((tid(w, 'gc-cache-age').element as HTMLInputElement).value).toBe('7')
    expect(radio(w, '1h').attributes('aria-checked')).toBe('true')
    w.unmount()
  })

  it("has ONE interval control: the Reaper pane's duplicate is gone", async () => {
    const w = await mountPane()
    expect(w.findAll('[data-testid="gc-interval"]')).toHaveLength(1)
    expect(w.findAll('[role="radio"]').filter((b) => b.text() === '6h')).toHaveLength(1)
    w.unmount()
  })
})

describe('CleanupSettingsPane — writes the whole object', () => {
  it('a toggle sends every field, not just the one that changed', async () => {
    const w = await mountPane()
    await tid(w, 'gc-autopilot').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenCalledTimes(1)
    const sent = setGc.mock.calls[0][0]
    expect(sent).toEqual({ ...GC, autopilot: true })
    expect(Object.keys(sent).sort()).toEqual(Object.keys(defaultGcPrefs()).sort())
    w.unmount()
  })

  it('the interval control writes intervalMs', async () => {
    const w = await mountPane()
    await radio(w, '6h').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenLastCalledWith({ ...GC, intervalMs: 21_600_000 })
    w.unmount()
  })

  it('each category toggle writes its own flag and keeps the others as they were', async () => {
    const w = await mountPane()
    await tid(w, 'gc-cat-worktrees').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenLastCalledWith({
      ...GC,
      categories: { worktrees: false, dockerCache: true }
    })
    await tid(w, 'gc-cat-docker-cache').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenLastCalledWith({
      ...GC,
      categories: { worktrees: false, dockerCache: false }
    })
    w.unmount()
  })

  it('numeric inputs wait for the typing to settle (400ms), then clamp', async () => {
    vi.useFakeTimers()
    const w = await mountPane()
    await tid(w, 'gc-grace').setValue('4')
    expect(setGc).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(399)
    expect(setGc).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(setGc).toHaveBeenLastCalledWith({ ...GC, graceDays: 4 })

    // Out of range: clamped client-side to main's bounds.
    await tid(w, 'gc-grace').setValue('99')
    await vi.advanceTimersByTimeAsync(401)
    expect(setGc).toHaveBeenLastCalledWith({ ...GC, graceDays: 30 })
    await tid(w, 'gc-cap').setValue('0')
    await vi.advanceTimersByTimeAsync(401)
    expect(setGc.mock.calls.at(-1)![0].maxItemsPerCycle).toBe(1)
    await tid(w, 'gc-cache-age').setValue('9999')
    await vi.advanceTimersByTimeAsync(401)
    expect(setGc.mock.calls.at(-1)![0].cacheMaxAgeDays).toBe(365)
    w.unmount()
  })

  it('an unfinished edit ("") sends nothing', async () => {
    vi.useFakeTimers()
    const w = await mountPane()
    await tid(w, 'gc-cap').setValue('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(setGc).not.toHaveBeenCalled()
    w.unmount()
  })

  it('two quick edits are saved one after the other, the second on top of the first', async () => {
    vi.useFakeTimers()
    const w = await mountPane()
    await tid(w, 'gc-grace').setValue('3')
    await tid(w, 'gc-cap').setValue('50')
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    expect(setGc).toHaveBeenCalledTimes(2)
    const last = setGc.mock.calls[1][0]
    expect(last.graceDays).toBe(3)
    expect(last.maxItemsPerCycle).toBe(50)
    w.unmount()
  })

  it('shows what main kept, not what was typed', async () => {
    vi.useFakeTimers()
    const w = await mountPane()
    await tid(w, 'gc-grace').setValue('99')
    await vi.advanceTimersByTimeAsync(401)
    await flushPromises()
    expect((tid(w, 'gc-grace').element as HTMLInputElement).value).toBe('30')
    w.unmount()
  })
})

describe('CleanupSettingsPane — volumes are always kept', () => {
  it('states the rule and that a removed volume cannot be restored, as text, not as a switch', async () => {
    const w = await mountPane()
    const rule = tid(w, 'gc-volumes-rule')
    expect(rule.text()).toContain(t('cleanup.gc.settings.volumesRule.title'))
    expect(rule.text()).toContain(t('cleanup.gc.settings.volumesRule.body'))
    const warning = tid(w, 'gc-volumes-warning')
    expect(rule.element.contains(warning.element)).toBe(true)
    expect(warning.classes()).toContain('text-warning')
    expect(rule.find('input, [role="switch"]').exists()).toBe(false)
    w.unmount()
  })

  it('the copy says so, in both locales', () => {
    for (const locale of ['en', 'pt-BR']) {
      const msgs = JSON.parse(read(`src/renderer/src/i18n/${locale}.json`))
      const rule = msgs.cleanup?.gc?.settings?.volumesRule ?? {}
      for (const k of ['title', 'body', 'warning']) expect(rule[k], `${locale}:${k}`).toBeTruthy()
      if (locale === 'en') expect(rule.warning.toLowerCase()).toContain('cannot be restored')
      // The removed switches leave no dead strings behind.
      expect(msgs.cleanup.gc.settings.removeVolumes, locale).toBeUndefined()
      expect(msgs.cleanup.gc.settings.categories.volumes, locale).toBeUndefined()
    }
  })
})

describe('CleanupSettingsPane — never clean', () => {
  it('lists the paths, adds one, trims it, and writes the whole object', async () => {
    const w = await mountPane({ ...GC, neverClean: ['/work/keep-me'] })
    expect(w.text()).toContain('/work/keep-me')
    await tid(w, 'gc-never-input').setValue('  /work/other  ')
    await tid(w, 'gc-never-add').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenLastCalledWith({
      ...GC,
      neverClean: ['/work/keep-me', '/work/other']
    })
    expect((tid(w, 'gc-never-input').element as HTMLInputElement).value).toBe('')
    w.unmount()
  })

  it('Enter adds, too', async () => {
    const w = await mountPane()
    await tid(w, 'gc-never-input').setValue('/work/a')
    await tid(w, 'gc-never-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(setGc.mock.calls.at(-1)![0].neverClean).toEqual(['/work/a'])
    w.unmount()
  })

  it('refuses an empty, a relative and a duplicate path', async () => {
    const w = await mountPane({ ...GC, neverClean: ['/work/a'] })
    await tid(w, 'gc-never-add').trigger('click') // empty
    await tid(w, 'gc-never-input').setValue('relative/path')
    await tid(w, 'gc-never-add').trigger('click')
    expect(w.find('[role="alert"]').exists()).toBe(true)
    await tid(w, 'gc-never-input').setValue('/work/a') // already there
    await tid(w, 'gc-never-add').trigger('click')
    await flushPromises()
    expect(setGc).not.toHaveBeenCalled()
    w.unmount()
  })

  it('accepts a Windows drive path', async () => {
    const w = await mountPane()
    await tid(w, 'gc-never-input').setValue('C:\\work\\repo')
    await tid(w, 'gc-never-add').trigger('click')
    await flushPromises()
    expect(setGc.mock.calls.at(-1)![0].neverClean).toEqual(['C:\\work\\repo'])
    w.unmount()
  })

  it('removes a path', async () => {
    const w = await mountPane({ ...GC, neverClean: ['/a', '/b'] })
    await w.findAll('[data-testid="gc-never-remove"]')[0].trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenLastCalledWith({ ...GC, neverClean: ['/b'] })
    w.unmount()
  })
})

describe('CleanupSettingsPane — the Reaper-only fields stay, without a second interval', () => {
  it('writes the Reaper prefs through reaperSetPrefs, keeping the GC interval', async () => {
    const w = await mountPane({ ...GC, intervalMs: 21_600_000 })
    await tid(w, 'reaper-never-remote').trigger('click')
    await flushPromises()
    expect(setReaper).toHaveBeenLastCalledWith({
      ...REAPER,
      neverDeleteRemote: true,
      // The Reaper timer is the GC interval: a Reaper write must never put the old one back.
      intervalMs: 21_600_000
    })
    expect(setGc).not.toHaveBeenCalled()
    w.unmount()
  })

  it('has the background-scan switch, the notification, protected branches and minimum age', async () => {
    const w = await mountPane()
    for (const id of [
      'reaper-auto-scan',
      'reaper-notify',
      'reaper-never-remote',
      'reaper-protected',
      'reaper-min-age'
    ]) {
      expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
    w.unmount()
  })

  it('protected branches and minimum age are debounced like the other inputs', async () => {
    vi.useFakeTimers()
    const w = await mountPane()
    await tid(w, 'reaper-protected').setValue('main, release')
    await tid(w, 'reaper-min-age').setValue('3')
    expect(setReaper).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    const last = setReaper.mock.calls.at(-1)![0]
    expect(last.protectedBranches).toEqual(['main', 'release'])
    expect(last.minAgeDays).toBe(3)
    w.unmount()
  })
})

describe('CleanupSettingsPane — copy', () => {
  it('every pane string exists in both locales', () => {
    const keys = [
      'autopilot.eyebrow',
      'autopilot.intro',
      'autopilot.label',
      'autopilot.hint',
      'interval.label',
      'interval.hint',
      'grace.label',
      'grace.hint',
      'cap.label',
      'cap.hint',
      'cap.suffix',
      'daysSuffix',
      'clean.eyebrow',
      'clean.intro',
      'categories.worktrees.label',
      'categories.worktrees.hint',
      'categories.dockerCache.label',
      'categories.dockerCache.hint',
      'volumesRule.title',
      'volumesRule.body',
      'volumesRule.warning',
      'cacheMaxAge.label',
      'cacheMaxAge.hint',
      'never.eyebrow',
      'never.intro',
      'never.label',
      'never.empty',
      'never.placeholder',
      'never.add',
      'never.removeLabel',
      'never.remove',
      'never.invalid',
      'scan.eyebrow',
      'scan.intro',
      'scan.autoScanHint'
    ]
    for (const locale of ['en', 'pt-BR']) {
      const root = JSON.parse(read(`src/renderer/src/i18n/${locale}.json`)).cleanup?.gc?.settings
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>((o, k) => (o as never)?.[k], root)
        expect(typeof value, `${locale}:${key}`).toBe('string')
      }
    }
  })
})
