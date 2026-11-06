// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import ContainersView from '../src/renderer/src/components/ContainersView.vue'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import {
  NOW,
  PAUSED_STACK,
  PAUSE_TOMB,
  STOP_TOMB,
  snapshotOf,
  specStacks
} from './helpers/containers-fixtures'
import { cloneGuardedApi } from './helpers/containers-api'
import type { ContainersSnapshot } from '../src/preload'
import {
  recentVerbKey,
  resolveSelection,
  tombstoneKey
} from '../src/renderer/src/components/containers-format'

/**
 * U3.4 — a stack Cleanup paused is remembered and shown as "Paused" (design.md "Paused row" and
 * "Paused detail"). It has no containers, so it is never a stack row and never a zombie.
 */

const REPO = join(import.meta.dirname, '..')

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function mountView(snap: ContainersSnapshot): Promise<VueWrapper> {
  const api = {
    containersSnapshot: vi.fn(async () => snap),
    containersScan: vi.fn(async () => snap),
    containersAct: vi.fn(),
    onContainersUpdate: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
  stubTakeoverShellTargets()
  const wrapper = mount(ContainersView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

describe('the Paused section (U3.4 AC-5)', () => {
  it('lists a paused stack under a Paused eyebrow with a Paused chip, not as a stack row', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [], [PAUSED_STACK]))
    const row = wrapper.get('[data-paused="proj-77"]')
    expect(row.text()).toContain('proj-77')
    expect(row.text()).toContain('Paused')
    expect(row.text()).toContain('3h ago')
    expect(wrapper.find('[data-stack="proj-77"]').exists()).toBe(false)
    expect(row.text().toLowerCase()).not.toMatch(/zombie|orphan/)
    // no quick-stop, no clean-up checkbox: nothing runs, nothing can be swept
    expect(row.find('[data-testid="containers-quick-stop"]').exists()).toBe(false)
    expect(row.find('input[type="checkbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('has no Paused eyebrow while nothing is paused', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    expect(wrapper.find('[data-paused]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="containers-paused-eyebrow"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('selecting it shows who paused it, the ports, the build flag and the restore command', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [], [PAUSED_STACK]))
    await wrapper.get('[data-paused="proj-77"]').trigger('click')
    await settle()
    const detail = wrapper.get('[data-dsqa="containers-detail--paused"]')
    expect(detail.text()).toContain('Cleanup')
    expect(detail.text()).toContain('8077')
    expect(detail.text()).toContain('3377')
    expect(detail.text()).toContain('Rebuilds on restore')
    expect(detail.text()).toContain('To bring it back')
    expect(detail.text()).toContain(PAUSED_STACK.restoreCommand)
    // the command is the restore: nothing to start, stop or remove
    expect(detail.find('[data-testid^="containers-tier-"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('copies the restore command', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = await mountView(snapshotOf(specStacks(), [], [PAUSED_STACK]))
    await wrapper.get('[data-paused="proj-77"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="containers-paused-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(PAUSED_STACK.restoreCommand)
    wrapper.unmount()
  })

  it('never says "parked" and never offers a verdict to a paused stack', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [PAUSE_TOMB], [PAUSED_STACK]))
    await wrapper.get('[data-paused="proj-77"]').trigger('click')
    await settle()
    expect(wrapper.text().toLowerCase()).not.toContain('parked')
    wrapper.unmount()
  })
})

describe('a pause in Recent (U3.4)', () => {
  it('reads "paused", shows the compose command and offers no Start', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [PAUSE_TOMB, STOP_TOMB]))
    const row = wrapper.findAll('[aria-pressed]').find((r) => r.text().includes('proj-77'))!
    expect(row.text()).toContain('paused')
    await row.trigger('click')
    await settle()
    const detail = wrapper.get('[data-dsqa="containers-detail--recent"]')
    expect(detail.text()).toContain('To bring it back')
    expect(detail.text()).toContain(PAUSE_TOMB.restoreHint as string)
    expect(wrapper.find('[data-testid="containers-tier-start-recent"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('an ordinary stop still offers Start stack', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [STOP_TOMB]))
    await wrapper
      .findAll('[aria-pressed]')
      .find((r) => r.text().includes('proj-54'))!
      .trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="containers-tier-start-recent"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('format helpers (U3.4)', () => {
  it('a tombstone whose stacks were all paused reads "paused"', () => {
    expect(recentVerbKey(PAUSE_TOMB)).toBe('paused')
    expect(recentVerbKey(STOP_TOMB)).toBe('stopped')
  })

  it('the selection keeps a paused stack while it is still paused, and falls back when it is not', () => {
    const snap = snapshotOf(specStacks(), [], [PAUSED_STACK])
    expect(resolveSelection({ kind: 'paused', id: 'proj-77' }, snap)).toEqual({
      kind: 'paused',
      id: 'proj-77'
    })
    const back = snapshotOf(specStacks(), [], [])
    expect(resolveSelection({ kind: 'paused', id: 'proj-77' }, back)?.kind).toBe('stack')
  })

  it('tombstoneKey is unchanged by a pause record', () => {
    expect(tombstoneKey(PAUSE_TOMB)).toBe(`${PAUSE_TOMB.at}:proj-77`)
  })
})

describe('i18n parity (U3.4)', () => {
  const read = (rel: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as Record<string, unknown>
  const pick = (o: Record<string, unknown>, path: string): unknown =>
    path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o)

  it.each([
    'containers.section.paused',
    'containers.paused.chip',
    'containers.paused.note',
    'containers.recent.paused',
    'containers.recent.whenPaused'
  ])('%s exists in both locales', (key) => {
    const en = pick(read('src/renderer/src/i18n/en.json'), key)
    const pt = pick(read('src/renderer/src/i18n/pt-BR.json'), key)
    expect(typeof en).toBe('string')
    expect(typeof pt).toBe('string')
  })

  it('pt-BR says Pausada', () => {
    expect(pick(read('src/renderer/src/i18n/pt-BR.json'), 'containers.paused.chip')).toBe('Pausada')
    expect(pick(read('src/renderer/src/i18n/en.json'), 'containers.paused.chip')).toBe('Paused')
  })
})
