// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ipcFn } from './helpers/ipc-clone'
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
let ackShelve: ReturnType<typeof vi.fn>
let ackDocker: ReturnType<typeof vi.fn>
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
  setGc = ipcFn(async (p: GcPrefs) => ({
    ...p,
    graceDays: Math.min(30, Math.max(0, p.graceDays)),
    maxItemsPerCycle: Math.min(200, Math.max(1, p.maxItemsPerCycle)),
    cacheMaxAgeDays: Math.min(365, Math.max(1, p.cacheMaxAgeDays))
  }))
  setReaper = ipcFn(async (p: unknown) => p)
  ackShelve = vi.fn(async () => ({
    ...initial,
    shelve: { ...initial.shelve, firstReportAcknowledged: true }
  }))
  ackDocker = vi.fn(async () => ({
    ...initial,
    docker: { ...initial.docker, firstReportAcknowledged: true }
  }))
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi({
    gcPrefs: vi.fn(async () => initial),
    gcSetPrefs: setGc,
    gcAckShelveReport: ackShelve,
    gcAckDockerReport: ackDocker,
    gcSnapshot: vi.fn(async () => snapshot),
    gcJobs: vi.fn(async () => []),
    onGcProgress: () => () => {},
    onGcDone: () => () => {},
    onGcCycle: () => () => {},
    onGcDockerWatch: () => () => {},
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
  it('renders a control for each editable field, and none for the internal five', async () => {
    const w = await mountPane()
    for (const id of [
      'gc-autopilot',
      'gc-interval',
      'gc-grace',
      'gc-cap',
      'gc-cat-worktrees',
      'gc-cat-docker-cache',
      'gc-cache-age',
      'gc-archive-keep',
      'gc-archive-expire',
      'gc-never-input',
      'gc-pause-all'
    ]) {
      expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
    // D1: there is no volumes switch and no removeVolumes switch — volumes are always kept.
    expect(w.find('[data-testid="gc-cat-volumes"]').exists()).toBe(false)
    expect(w.find('[data-testid="gc-remove-volumes"]').exists()).toBe(false)
    // The shape of the contract (S3 delta 2): GcPrefs minus version / keep / firstReportAcknowledged
    // and the release marks (released / releasedFrom, written by release_worktree, never edited here).
    // `removeVolumes` and `categories.volumes` are gone from the engine as well as from the pane.
    // `shelve` and `docker` are nested blocks with their own sections (switch and acknowledge), pinned
    // below; they are not among the flat fields counted here. `pauseAutonomous` is a flat field.
    const editable = Object.keys(GC).filter(
      (k) =>
        ![
          'version',
          'keep',
          'firstReportAcknowledged',
          'released',
          'releasedFrom',
          'shelve',
          'docker'
        ].includes(k)
    )
    expect(editable.sort()).toEqual(
      [
        'autopilot',
        'intervalMs',
        'graceDays',
        'maxItemsPerCycle',
        'categories',
        'cacheMaxAgeDays',
        'archiveKeepDays',
        'archiveAutoExpire',
        'neverClean',
        'pauseAutonomous'
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

describe('CleanupSettingsPane — shelving (U2.3a AC-6)', () => {
  const withShelve = (over: Partial<GcPrefs['shelve']>): GcPrefs => ({
    ...GC,
    shelve: { ...GC.shelve, ...over }
  })

  it('has a switch that shows the stored value', async () => {
    const on = await mountPane(withShelve({ enabled: true }))
    expect(tid(on, 'gc-shelve').attributes('aria-checked')).toBe('true')
    on.unmount()
    const off = await mountPane(withShelve({ enabled: false }))
    expect(tid(off, 'gc-shelve').attributes('aria-checked')).toBe('false')
    off.unmount()
  })

  it('the switch writes the whole prefs object with only shelve.enabled changed', async () => {
    const w = await mountPane(withShelve({ enabled: true }))
    await tid(w, 'gc-shelve').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenCalledTimes(1)
    const sent = setGc.mock.calls[0][0]
    expect(sent).toEqual({
      ...withShelve({ enabled: true }),
      shelve: { ...GC.shelve, enabled: false }
    })
    expect(Object.keys(sent).sort()).toEqual(Object.keys(defaultGcPrefs()).sort())
    w.unmount()
  })

  it('on and not yet acknowledged: says the first pass only reports, and offers the acknowledge action', async () => {
    const w = await mountPane(withShelve({ enabled: true, firstReportAcknowledged: false }))
    const status = tid(w, 'gc-shelve-status').text().toLowerCase()
    expect(status).toContain('only reports')
    expect(w.find('[data-testid="gc-shelve-ack"]').exists()).toBe(true)
    w.unmount()
  })

  it('acknowledging calls the dedicated channel (never a settings write) and the action goes away', async () => {
    const w = await mountPane(withShelve({ enabled: true, firstReportAcknowledged: false }))
    await tid(w, 'gc-shelve-ack').trigger('click')
    await flushPromises()
    expect(ackShelve).toHaveBeenCalledTimes(1)
    expect(setGc).not.toHaveBeenCalled()
    expect(w.find('[data-testid="gc-shelve-ack"]').exists()).toBe(false)
    expect(tid(w, 'gc-shelve-status').text().toLowerCase()).toContain('active')
    w.unmount()
  })

  it('on and acknowledged: says it is active, with no action', async () => {
    const w = await mountPane(withShelve({ enabled: true, firstReportAcknowledged: true }))
    expect(tid(w, 'gc-shelve-status').text().toLowerCase()).toContain('active')
    expect(w.find('[data-testid="gc-shelve-ack"]').exists()).toBe(false)
    w.unmount()
  })

  it('off: no status line and no acknowledge action, just what the switch would do', async () => {
    const w = await mountPane(withShelve({ enabled: false }))
    expect(w.find('[data-testid="gc-shelve-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="gc-shelve-ack"]').exists()).toBe(false)
    expect(tid(w, 'cleanup-settings-shelve').text().toLowerCase()).toContain('comes back by itself')
    w.unmount()
  })
})

describe('CleanupSettingsPane — Docker autonomy and the global pause (U3.1 AC-6)', () => {
  const withDocker = (over: Partial<GcPrefs['docker']>): GcPrefs => ({
    ...GC,
    docker: { ...GC.docker, ...over }
  })

  it('has a Docker section whose switch shows the stored value', async () => {
    const on = await mountPane(withDocker({ enabled: true }))
    expect(on.find('[data-testid="cleanup-settings-docker"]').exists()).toBe(true)
    expect(tid(on, 'gc-docker').attributes('aria-checked')).toBe('true')
    on.unmount()
    const off = await mountPane(withDocker({ enabled: false }))
    expect(tid(off, 'gc-docker').attributes('aria-checked')).toBe('false')
    off.unmount()
  })

  it('the switch writes the whole prefs object with only docker.enabled changed', async () => {
    const w = await mountPane(withDocker({ enabled: true }))
    await tid(w, 'gc-docker').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenCalledTimes(1)
    const sent = setGc.mock.calls[0][0]
    expect(sent).toEqual({
      ...withDocker({ enabled: true }),
      docker: { ...GC.docker, enabled: false }
    })
    expect(Object.keys(sent).sort()).toEqual(Object.keys(defaultGcPrefs()).sort())
    w.unmount()
  })

  it('on and not yet acknowledged: says the first pass only records, and offers the acknowledge action', async () => {
    const w = await mountPane(withDocker({ enabled: true, firstReportAcknowledged: false }))
    expect(tid(w, 'gc-docker-status').text().toLowerCase()).toContain('only records')
    expect(w.find('[data-testid="gc-docker-ack"]').exists()).toBe(true)
    w.unmount()
  })

  it('acknowledging calls the dedicated Docker channel, never a settings write or the shelve one', async () => {
    const w = await mountPane(withDocker({ enabled: true, firstReportAcknowledged: false }))
    await tid(w, 'gc-docker-ack').trigger('click')
    await flushPromises()
    expect(ackDocker).toHaveBeenCalledTimes(1)
    expect(ackShelve).not.toHaveBeenCalled()
    expect(setGc).not.toHaveBeenCalled()
    expect(w.find('[data-testid="gc-docker-ack"]').exists()).toBe(false)
    expect(tid(w, 'gc-docker-status').text().toLowerCase()).toContain('active')
    w.unmount()
  })

  it('on and acknowledged: says it is active, with no action', async () => {
    const w = await mountPane(withDocker({ enabled: true, firstReportAcknowledged: true }))
    expect(tid(w, 'gc-docker-status').text().toLowerCase()).toContain('active')
    expect(w.find('[data-testid="gc-docker-ack"]').exists()).toBe(false)
    w.unmount()
  })

  it('off: no status line and no acknowledge action, just what the switch covers — in the word "Paused"', async () => {
    const w = await mountPane(withDocker({ enabled: false }))
    expect(w.find('[data-testid="gc-docker-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="gc-docker-ack"]').exists()).toBe(false)
    const text = tid(w, 'cleanup-settings-docker').text()
    expect(text).toContain('Paused')
    expect(text.toLowerCase()).not.toContain('parked')
    w.unmount()
  })

  it('the global pause shows its stored value and writes the whole object with only pauseAutonomous changed', async () => {
    const w = await mountPane({ ...GC, pauseAutonomous: false })
    expect(tid(w, 'gc-pause-all').attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="gc-pause-all-note"]').exists()).toBe(false)
    await tid(w, 'gc-pause-all').trigger('click')
    await flushPromises()
    expect(setGc).toHaveBeenCalledTimes(1)
    expect(setGc.mock.calls[0][0]).toEqual({ ...GC, pauseAutonomous: true })
    w.unmount()
    const paused = await mountPane({ ...GC, pauseAutonomous: true })
    expect(tid(paused, 'gc-pause-all').attributes('aria-checked')).toBe('true')
    expect(tid(paused, 'gc-pause-all-note').text().toLowerCase()).toContain('paused')
    paused.unmount()
  })

  it('every Docker string exists in both locales, and pt-BR says Pausada', () => {
    const keys = [
      'eyebrow',
      'intro',
      'label',
      'hint',
      'reportOnly',
      'ack',
      'active',
      'pauseAll.label',
      'pauseAll.hint',
      'pauseAll.note'
    ]
    for (const locale of ['en', 'pt-BR']) {
      const root = JSON.parse(read(`src/renderer/src/i18n/${locale}.json`)).cleanup?.gc?.settings
        ?.docker
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>((o, k) => (o as never)?.[k], root)
        expect(typeof value, `${locale}:${key}`).toBe('string')
      }
    }
    const pt = JSON.stringify(
      JSON.parse(read('src/renderer/src/i18n/pt-BR.json')).cleanup.gc.settings.docker
    )
    expect(pt).toContain('Pausada')
    expect(pt.toLowerCase()).not.toContain('estacionad')
  })
})

describe('CleanupSettingsPane — the Docker first-report list (U3.6 AC-5)', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    kind: (['network', 'orphan', 'pause'] as const)[i % 3]!,
    target: `target-${i}`,
    reason: `reason ${i}`
  }))
  const docker = (over: Partial<GcPrefs['docker']>): GcPrefs => ({
    ...GC,
    docker: { ...GC.docker, ...over }
  })
  const withReport = async (prefs: GcPrefs): Promise<VueWrapper> => {
    const w = await mountPane(prefs)
    const { useGcStore } = await import('../src/renderer/src/stores/gc')
    const store = useGcStore()
    ;(store as unknown as { snapshot: unknown }).snapshot = {
      ...(store.snapshot as object),
      prefs,
      dockerReport: { at: NOW, source: 'cycle', found: items.length, items }
    }
    await flushPromises()
    return w
  }

  it('shows what the first pass would do, with the names, before the acknowledgement', async () => {
    const w = await withReport(docker({ enabled: true, firstReportAcknowledged: false }))
    const list = w.get('[data-testid="gc-docker-report-list"]')
    const rows = list.findAll('[data-testid="gc-docker-report-item"]')
    expect(rows).toHaveLength(8)
    expect(rows[0]!.text()).toContain('target-0')
    expect(rows[0]!.text()).toContain('reason 0')
    expect(rows[0]!.text()).toContain(t('cleanup.gc.settings.docker.report.kind.network'))
    expect(rows[1]!.text()).toContain(t('cleanup.gc.settings.docker.report.kind.orphan'))
    expect(rows[2]!.text()).toContain(t('cleanup.gc.settings.docker.report.kind.pause'))
    expect(list.text()).toContain(i18n.global.t('cleanup.gc.settings.docker.report.more', { n: 2 }))
  })

  it('shows no list once the first report is acknowledged, or when the switch is off', async () => {
    const acked = await withReport(docker({ enabled: true, firstReportAcknowledged: true }))
    expect(acked.find('[data-testid="gc-docker-report-list"]').exists()).toBe(false)
    const off = await withReport(docker({ enabled: false, firstReportAcknowledged: false }))
    expect(off.find('[data-testid="gc-docker-report-list"]').exists()).toBe(false)
  })
})
