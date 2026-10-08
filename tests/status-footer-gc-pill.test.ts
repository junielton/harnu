// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import StatusFooter from '../src/renderer/src/components/StatusFooter.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { i18n } from '@renderer/i18n'
import { formatBytes } from '../src/renderer/src/components/system-monitor-format'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { Bucket } from '../src/main/gc/bundle-core'
import type { GcSnapshot } from '../src/main/gc/gc-wire'

/**
 * T443 — the single Cleanup footer pill. It replaces the old Cleanup and Containers pills and is
 * driven by the Workspace GC store. The StatusFooter is mounted whole over a quiet `window.api`; the
 * pill's state is set by seeding the store, exactly as the app does through `gc:snapshot`/`gc:progress`.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const MIB = 1024 ** 2

function wt(name: string, bucket: Bucket, bytes: number) {
  const b = bundle(`/ws/${name}`, bucket)
  b.item = reapItem(`/ws/${name}`, { diskBytes: bytes })
  return b
}

function snap(bundles = [wt('c1', 'ready', 500 * MIB)]): GcSnapshot {
  return {
    scannedAt: NOW,
    bundles,
    orphanVolumes: [],
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null
  }
}

/** Every `window.api` call the footer's stores make at mount, answered quietly. */
function stubApi(first: GcSnapshot): Record<string, (cb: unknown) => void> {
  const push: Record<string, (cb: unknown) => void> = {}
  const sub =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      push[name] = cb as (p: unknown) => void
      return () => {}
    }
  const none = (): (() => void) => () => {}
  const api = new Proxy(
    {
      gcSnapshot: vi.fn(async () => first),
      gcJobs: vi.fn(async () => []),
      onGcProgress: sub('progress'),
      onGcDone: sub('done'),
      onGcCycle: sub('cycle'),
      reaperSnapshot: vi.fn(async () => null),
      reaperJournal: vi.fn(async () => []),
      reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 })),
      containersSnapshot: vi.fn(async () => null)
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        // Any other `on*` subscription is a no-op; any other call resolves to nothing.
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
  ;(window as unknown as { api: unknown }).api = api
  return push
}

async function mountFooter(first: GcSnapshot = snap()): Promise<{
  wrapper: VueWrapper
  push: Record<string, (cb: unknown) => void>
}> {
  const push = stubApi(first)
  const wrapper = mount(StatusFooter, { global: { plugins: [i18n] } })
  await flushPromises()
  return { wrapper, push }
}

const pill = (w: VueWrapper) => w.find('[data-dsqa="cleanup-footer-pill"]')

/**
 * Until the shared locale files carry the footer strings (the parity test at the bottom guards
 * that), render with these so the pill's text and aria behaviour are testable on their own.
 */
const FALLBACK = {
  cleanup: {
    gc: {
      footer: {
        running: 'Cleaning {done}/{total}',
        attention: '{n} needs you | {n} need you',
        a11yRunning: 'Cleaning {done} of {total}',
        a11yAttention: '{n} item needs you | {n} items need you',
        a11yIdle: 'Open Cleanup — {size} reclaimable'
      }
    }
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  if (!i18n.global.te('cleanup.gc.footer.running')) i18n.global.mergeLocaleMessage('en', FALLBACK)
})

describe('the single Cleanup footer pill', () => {
  it('shows what is reclaimable when idle, with the Recycle icon', async () => {
    const { wrapper } = await mountFooter()
    const p = pill(wrapper)
    expect(p.exists()).toBe(true)
    expect(p.attributes('data-state')).toBe('idle')
    expect(p.text()).toContain(formatBytes(500 * MIB))
    expect(p.find('svg.lucide-recycle').exists()).toBe(true)
    expect(p.attributes('aria-label')).toBeTruthy()
    wrapper.unmount()
  })

  it('is hidden when there is nothing to reclaim, nothing running and nothing failed', async () => {
    const { wrapper } = await mountFooter(snap([wt('a1', 'in-use', 900 * MIB)]))
    expect(pill(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('mirrors a running clean as "Cleaning n/N" in accent ink', async () => {
    const { wrapper, push } = await mountFooter()
    push.progress({
      jobId: 'j1',
      done: 3,
      total: 12,
      freedBytes: 1,
      current: null,
      results: []
    })
    await flushPromises()
    const p = pill(wrapper)
    expect(p.attributes('data-state')).toBe('running')
    expect(p.text()).toContain('3')
    expect(p.text()).toContain('12')
    expect(p.classes()).toContain('text-accent')
    // The accent dot, not the green pulse ring: a static 6px dot with a 3px accent-soft halo.
    expect(p.find('.bg-accent').exists()).toBe(true)
    wrapper.unmount()
  })

  it('turns warning when a clean left items that need the operator', async () => {
    const { wrapper, push } = await mountFooter()
    const gc = useGcStore()
    const id = gc.model!.ready[0].id
    push.done({
      jobId: 'j1',
      kind: 'manual',
      done: 0,
      total: 1,
      freedBytes: 0,
      results: [{ id, ok: false, haltedAt: 'rm-volumes', error: 'volume in use', freedBytes: 0 }],
      error: null
    })
    await flushPromises()
    const p = pill(wrapper)
    expect(p.attributes('data-state')).toBe('attention')
    expect(p.classes()).toContain('text-warning')
    wrapper.unmount()
  })

  it('click toggles the Cleanup takeover and carries aria-pressed', async () => {
    const { wrapper } = await mountFooter()
    const ui = useUiStore()
    expect(pill(wrapper).attributes('aria-pressed')).toBe('false')
    await pill(wrapper).trigger('click')
    expect(ui.cleanupOpen).toBe(true)
    await flushPromises()
    expect(pill(wrapper).attributes('aria-pressed')).toBe('true')
    expect(pill(wrapper).classes()).toContain('text-accent')
    await pill(wrapper).trigger('click')
    expect(ui.cleanupOpen).toBe(false)
    wrapper.unmount()
  })

  it('announces a change of state once, in a polite live region', async () => {
    const { wrapper, push } = await mountFooter()
    const live = wrapper.get('[data-testid="cleanup-footer-live"]')
    expect(live.attributes('aria-live')).toBe('polite')
    expect(live.text()).toBe('')
    push.progress({ jobId: 'j1', done: 1, total: 12, freedBytes: 1, current: null, results: [] })
    await flushPromises()
    const first = live.text()
    expect(first).not.toBe('')
    // The same state again (a size refresh) does not re-announce; the next item does.
    push.progress({ jobId: 'j1', done: 1, total: 12, freedBytes: 2, current: null, results: [] })
    await flushPromises()
    expect(live.text()).toBe(first)
    push.progress({ jobId: 'j1', done: 2, total: 12, freedBytes: 3, current: null, results: [] })
    await flushPromises()
    expect(live.text()).not.toBe(first)
    wrapper.unmount()
  })

  it('replaces the two old pills: no Trash2 Cleanup pill and no Containers pill remain', async () => {
    const { wrapper } = await mountFooter()
    expect(wrapper.find('[data-dsqa="containers-footer-pill"]').exists()).toBe(false)
    const src = read('src/renderer/src/components/StatusFooter.vue')
    expect(src).not.toContain('cleanupCount')
    expect(src).not.toContain('containersCount')
    // Their stores stay initialised for the quiet Activity alerts, not for a pill.
    expect(src).toContain('reaper.init()')
    expect(src).toContain('void containers.init()')
    wrapper.unmount()
  })

  it('its strings exist in both locales', () => {
    for (const locale of ['en', 'pt-BR']) {
      const f = JSON.parse(read(`src/renderer/src/i18n/${locale}.json`)).cleanup?.gc?.footer
      for (const key of ['running', 'attention', 'a11yRunning', 'a11yAttention', 'a11yIdle']) {
        expect(typeof f?.[key], `${locale}:${key}`).toBe('string')
      }
    }
  })
})
