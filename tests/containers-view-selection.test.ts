// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ContainersView from '../src/renderer/src/components/ContainersView.vue'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import { NOW, snapshotOf, specStacks, stack } from './helpers/containers-fixtures'
import { cloneGuardedApi, sentThroughIpc } from './helpers/containers-api'
import type { ContainersActResult, ContainersSnapshot, StackRow } from '../src/preload'

/**
 * T342 — the clean-up selection, on screen.
 *
 * The operator asked for a checkbox per stack and got one, all ticked, so one
 * click still cleans everything. What is pinned here: the box exists exactly
 * where a sweep can act and nowhere else, toggling it never moves the detail
 * pane, the header control's three states, the count on the hero button, and the
 * payload the confirm sends — `only` beside `disclosed`, both plain enough to
 * cross Electron's structured clone (BUG-141).
 */

let containersAct: ReturnType<typeof vi.fn>
let pushSnapshot: (snap: ContainersSnapshot) => void

function stubApi(snap: ContainersSnapshot): void {
  containersAct = vi.fn(
    async (req: { verb: ContainersActResult['verb'] }): Promise<ContainersActResult> => ({
      ok: true,
      verb: req.verb,
      results: [],
      tombstone: null
    })
  )
  const api = {
    containersSnapshot: vi.fn(async () => snap),
    containersScan: vi.fn(async () => snap),
    containersAct,
    onContainersUpdate: (cb: (s: ContainersSnapshot) => void) => {
      pushSnapshot = cb
      return () => {}
    }
  }
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function mountView(stacks: StackRow[]): Promise<VueWrapper> {
  stubApi(snapshotOf(stacks))
  stubTakeoverShellTargets()
  const wrapper = mount(ContainersView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  return wrapper
}

function body(): DOMWrapper<Element> {
  return new DOMWrapper(document.body)
}

function box(wrapper: VueWrapper, id: string): DOMWrapper<HTMLInputElement> {
  return wrapper.get(`[data-stack-pick="${id}"]`) as DOMWrapper<HTMLInputElement>
}

function picked(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll<HTMLInputElement>('[data-stack-pick]')
    .filter((b) => b.element.checked)
    .map((b) => b.attributes('data-stack-pick')!)
}

async function untick(wrapper: VueWrapper, id: string): Promise<void> {
  await box(wrapper, id).trigger('click')
  await settle()
}

/** The clean-up button's text, or null when it is not rendered at all. */
function sweepButton(wrapper: VueWrapper): { text: string; disabled: boolean } | null {
  const b = wrapper.find('[data-testid="containers-sweep"]')
  if (!b.exists()) return null
  return { text: b.text(), disabled: (b.element as HTMLButtonElement).disabled }
}

function header(wrapper: VueWrapper): DOMWrapper<HTMLInputElement> {
  return wrapper.get('[data-testid="containers-select-all"]') as DOMWrapper<HTMLInputElement>
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  document.body.innerHTML = ''
})

describe('T342 AC-3: a checkbox on every stack a clean-up can take, and nowhere else', () => {
  it('gives each "Needs you" row a ticked box and leaves the others alone', async () => {
    const wrapper = await mountView(specStacks())
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27'])
    // active, protected, pending and unknown can never be swept: no box at all.
    for (const id of ['proj-71', 'proj-20', 'proj-44', 'postgres-scratch']) {
      expect(wrapper.find(`[data-stack="${id}"] [data-stack-pick]`).exists(), id).toBe(false)
    }
    wrapper.unmount()
  })

  it('puts the box FIRST in the row, ahead of the name', async () => {
    const wrapper = await mountView(specStacks())
    const row = wrapper.get('[data-stack="proj-82"]')
    const first = row.element.firstElementChild!
    expect(first.querySelector('[data-stack-pick="proj-82"]')).not.toBeNull()
    // And the row makes room for it: five tracks, not the four a "Leave alone" row has.
    expect(row.classes()).toContain('grid-cols-[14px_1fr_auto_56px_22px]')
    expect(wrapper.get('[data-stack="proj-20"]').classes()).toContain(
      'grid-cols-[1fr_auto_56px_22px]'
    )
    wrapper.unmount()
  })

  it('names its stack in an i18n aria-label and carries a focus ring', async () => {
    const wrapper = await mountView(specStacks())
    const b = box(wrapper, 'proj-82')
    expect(b.attributes('aria-label')).toBe('Include proj-82 in the clean-up')
    expect(b.classes().join(' ')).toContain('focus-visible:ring-accent')
    wrapper.unmount()
  })

  it('toggling it never selects the row: the detail pane stays where it was', async () => {
    const wrapper = await mountView(specStacks())
    // Park the selection on a row that is not the one being unticked.
    await wrapper.get('[data-stack="proj-20"]').trigger('click')
    await settle()
    await untick(wrapper, 'proj-82')

    expect(picked(wrapper)).toEqual(['proj-11', 'proj-27'])
    expect(wrapper.get('[data-stack="proj-20"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-stack="proj-82"]').attributes('aria-pressed')).toBe('false')
    // Nothing was sent: a selection is not an action.
    expect(containersAct).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Space on a focused box stays with the box and never selects the row', async () => {
    const wrapper = await mountView(specStacks())
    await wrapper.get('[data-stack="proj-20"]').trigger('click')
    await settle()
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    box(wrapper, 'proj-82').element.dispatchEvent(ev)
    await settle()
    // The row's handler must not cancel the box's own activation.
    expect(ev.defaultPrevented).toBe(false)
    expect(wrapper.get('[data-stack="proj-20"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-stack="proj-82"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('re-ticking a stack puts it back', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-27'])
    await untick(wrapper, 'proj-11')
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27'])
    wrapper.unmount()
  })
})

describe('T342 AC-4: select all / none, with a mixed state', () => {
  it('reads "all" on open, "mixed" once one is unticked, "none" when cleared', async () => {
    const wrapper = await mountView(specStacks())
    expect(header(wrapper).attributes('data-state')).toBe('all')
    expect(header(wrapper).element.checked).toBe(true)
    expect(header(wrapper).element.indeterminate).toBe(false)

    await untick(wrapper, 'proj-11')
    expect(header(wrapper).attributes('data-state')).toBe('mixed')
    expect(header(wrapper).element.indeterminate).toBe(true)
    expect(header(wrapper).element.checked).toBe(false)

    await untick(wrapper, 'proj-82')
    await untick(wrapper, 'proj-27')
    expect(header(wrapper).attributes('data-state')).toBe('none')
    expect(header(wrapper).element.indeterminate).toBe(false)
    wrapper.unmount()
  })

  it('clears everything when all are ticked, and ticks everything otherwise', async () => {
    const wrapper = await mountView(specStacks())
    await header(wrapper).trigger('click')
    await settle()
    expect(picked(wrapper)).toEqual([])

    await header(wrapper).trigger('click')
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27'])

    // From mixed, one click ticks everything rather than clearing the rest.
    await untick(wrapper, 'proj-27')
    await header(wrapper).trigger('click')
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27'])
    wrapper.unmount()
  })

  it('names what the click will do, in both states', async () => {
    const wrapper = await mountView(specStacks())
    expect(header(wrapper).attributes('aria-label')).toBe('Clear the selection')
    await untick(wrapper, 'proj-11')
    expect(header(wrapper).attributes('aria-label')).toBe('Select every stack')
    wrapper.unmount()
  })

  it('is absent when nothing needs the operator', async () => {
    const wrapper = await mountView(
      specStacks().filter((s) => s.verdict !== 'zombie' && s.verdict !== 'orphan')
    )
    expect(wrapper.find('[data-testid="containers-select-all"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('T342 AC-5: the selection is keyed by stack id', () => {
  it('survives a rescan that changes nothing', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    pushSnapshot(snapshotOf(specStacks()))
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-27'])
    wrapper.unmount()
  })

  it('drops an id that vanishes, and forgets it: the same id returning arrives unticked', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    pushSnapshot(snapshotOf(specStacks().filter((s) => s.id !== 'proj-82')))
    await settle()
    expect(picked(wrapper)).toEqual(['proj-27'])

    pushSnapshot(snapshotOf(specStacks()))
    await settle()
    // proj-82 is new to this selection now — a destructive action fails safe.
    expect(picked(wrapper)).toEqual(['proj-27'])
    wrapper.unmount()
  })

  it('a stack arriving AFTER an explicit partial selection arrives unticked', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    pushSnapshot(snapshotOf([...specStacks(), stack({ id: 'z-new', verdict: 'zombie' })]))
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-27'])
    expect(box(wrapper, 'z-new').element.checked).toBe(false)
    wrapper.unmount()
  })

  it('a stack arriving while nothing was unticked arrives ticked', async () => {
    const wrapper = await mountView(specStacks())
    pushSnapshot(snapshotOf([...specStacks(), stack({ id: 'z-new', verdict: 'zombie' })]))
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27', 'z-new'])
    wrapper.unmount()
  })

  it('"select all" restores that, so later arrivals are ticked again', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    await header(wrapper).trigger('click')
    await settle()
    pushSnapshot(snapshotOf([...specStacks(), stack({ id: 'z-new', verdict: 'zombie' })]))
    await settle()
    expect(picked(wrapper)).toEqual(['proj-82', 'proj-11', 'proj-27', 'z-new'])
    wrapper.unmount()
  })
})

describe('T342 AC-6: the button and the dialog count what is ticked', () => {
  it('drops the count as stacks are unticked, and disables at zero without hiding', async () => {
    const wrapper = await mountView(specStacks())
    expect(sweepButton(wrapper)).toEqual({ text: 'Clean up 3 stacks', disabled: false })

    await untick(wrapper, 'proj-11')
    expect(sweepButton(wrapper)).toEqual({ text: 'Clean up 2 stacks', disabled: false })

    await untick(wrapper, 'proj-82')
    await untick(wrapper, 'proj-27')
    // Still there, where the operator left it — disabled, not gone.
    expect(sweepButton(wrapper)).toEqual({ text: 'Clean up 0 stacks', disabled: true })
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    expect(body().find('[data-dsqa="containers-sweep-dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('leaves "Stop N running" alone: stopping is reversible and still one click', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-82')
    const stop = wrapper.get('[data-testid="containers-stop-running"]')
    expect(stop.text()).toBe('Stop 1 running')
    expect((stop.element as HTMLButtonElement).disabled).toBe(false)
    await stop.trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', bulk: true })
    wrapper.unmount()
  })

  it('lists only the ticked stacks, with their counts and total', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()

    const dialog = body().get('[data-dsqa="containers-sweep-dialog"]')
    expect(
      body()
        .findAll('[data-sweep-stack]')
        .map((r) => r.attributes('data-sweep-stack'))
    ).toEqual(['proj-82', 'proj-27'])
    expect(dialog.text()).toContain('Clean up 2 stacks?')
    // proj-82 has two containers, proj-27 one; proj-11's is left out.
    expect(dialog.text()).toContain('3 containers will be removed.')
    expect(body().get('[data-testid="containers-sweep-confirm"]').text()).toBe(
      'Remove 3 containers'
    )
    wrapper.unmount()
  })

  it('an unticked stack is a survivor: the volume it shares is kept and named', async () => {
    const both = { name: 'both_zombies', sizeBytes: 50_000_000, shared: true }
    const own = { name: 'z1_data', sizeBytes: 20_000_000, shared: false }
    const wrapper = await mountView([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [both, own] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [both] })
    ])
    await untick(wrapper, 'z-2')
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()

    const text = body().get('[data-dsqa="containers-sweep-dialog"]').text()
    // With z-2 left out, `both_zombies` outlives the clean-up exactly like a
    // volume an `active` stack still mounts.
    expect(text).toContain('Also remove 1 volume · 20.0 MB')
    expect(text).toContain('both_zombies is shared with another stack, so it is kept.')
    wrapper.unmount()
  })

  it('offers that same volume once every owner is ticked', async () => {
    const both = { name: 'both_zombies', sizeBytes: 50_000_000, shared: true }
    const own = { name: 'z1_data', sizeBytes: 20_000_000, shared: false }
    const wrapper = await mountView([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [both, own] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [both] })
    ])
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    const text = body().get('[data-dsqa="containers-sweep-dialog"]').text()
    expect(text).toContain('Also remove 2 volumes · 70.0 MB')
    expect(text).not.toContain('is shared with another stack')
    wrapper.unmount()
  })
})

describe('T342 AC-6/AC-7: what the confirm sends', () => {
  async function confirmWith(untickIds: string[]): Promise<Record<string, unknown>> {
    const wrapper = await mountView(specStacks())
    for (const id of untickIds) await untick(wrapper, id)
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    await body().get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    const [call] = containersAct.mock.calls
    wrapper.unmount()
    return call[0] as Record<string, unknown>
  }

  it('sends `only` and `disclosed`, both naming the ticked set', async () => {
    expect(await confirmWith(['proj-11'])).toEqual({
      verb: 'sweep',
      removeVolumes: false,
      only: ['proj-82', 'proj-27'],
      disclosed: {
        stacks: ['proj-82', 'proj-27'],
        volumes: ['proj-82_mysql', 'proj-27_mysql']
      }
    })
  })

  it('sends no `only` at all when nothing was unticked', async () => {
    // The untouched one-click clean-up reaches main byte-identical to before.
    expect(await confirmWith([])).toEqual({
      verb: 'sweep',
      removeVolumes: false,
      disclosed: {
        stacks: ['proj-82', 'proj-11', 'proj-27'],
        volumes: ['proj-82_mysql', 'proj-11_mysql', 'proj-27_mysql']
      }
    })
  })

  it('leaves out the volume the unticked stack keeps', async () => {
    const both = { name: 'both_zombies', sizeBytes: 50_000_000, shared: true }
    const own = { name: 'z1_data', sizeBytes: 20_000_000, shared: false }
    const wrapper = await mountView([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [both, own] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [both] })
    ])
    await untick(wrapper, 'z-2')
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    await body().get('[data-testid="containers-sweep-volumes"]').setValue(true)
    await body().get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(containersAct.mock.calls).toEqual([
      [
        {
          verb: 'sweep',
          removeVolumes: true,
          only: ['z-1'],
          disclosed: { stacks: ['z-1'], volumes: ['z1_data'] }
        }
      ]
    ])
    wrapper.unmount()
  })

  it('AC-7: the narrowed payload survives the real IPC, not just a mock', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    await body().get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()

    const calls = sentThroughIpc().filter((c) => c.channel === 'containersAct')
    expect(calls, 'the confirm sent nothing').toHaveLength(1)
    // Exactly what Electron's structured clone does with it: a reactive Proxy
    // throws here, plain data does not (BUG-141).
    expect(() => structuredClone(calls[0].args[0])).not.toThrow()
    const req = calls[0].args[0] as { only: string[] }
    expect(() => structuredClone(req.only)).not.toThrow()
    expect(req.only).toEqual(['proj-82', 'proj-27'])
    wrapper.unmount()
  })

  it('counts the progress over the ticked stacks only', async () => {
    const wrapper = await mountView(specStacks())
    await untick(wrapper, 'proj-11')
    containersAct.mockImplementation(() => new Promise(() => {}))
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    await body().get('[data-testid="containers-sweep-confirm"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="containers-sweep"]').text()).toBe('Cleaning… 0 of 2')
    wrapper.unmount()
  })
})

describe('T342 AC-9: the selection copy is a key in both locales', () => {
  it.each(['containers.select.stack', 'containers.select.all', 'containers.select.none'])(
    '%s',
    (key) => {
      for (const locale of ['en', 'pt-BR'] as const) {
        expect(i18n.global.te(key, locale), `${key} @ ${locale}`).toBe(true)
      }
    }
  )
})
