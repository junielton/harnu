// @vitest-environment jsdom
/**
 * BUG-292 — the guided walk pane (and the Walks library) content can be selected and copied.
 *
 * `body { user-select: none }` makes the app chrome non-selectable; the walk pane never opted its content back in,
 * so a `do` step holding a command or a URL could not be copied. The fix is `select-text` on the content root
 * (`.wk-body`) of both panes, the way `MarkdownPane` does it, and the two traps that follow from a selectable
 * pane: a letter typed over a selection must not be an outcome (AC-6), and a drag that ends on a control must
 * not press it (AC-2, AC-7). jsdom applies no CSS, so what is pinned here is the class on the element, the rule
 * that keeps buttons non-selectable (written, as text) and the wiring of the two guards on a mounted pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { i18n } from '../src/renderer/src/i18n'
import GuidedWalkPane from '../src/renderer/src/components/GuidedWalkPane.vue'
import WalksPane from '../src/renderer/src/components/WalksPane.vue'
import { newRun, startRun } from '../src/shared/walk-machine'
import { toMachineChecks, type WalkScript } from '../src/shared/walk-schema'

const FOLDER = '/home/user/example-web'
const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

const script = {
  title: 'Search box on the notes list',
  purpose: 'check',
  source: { kind: 'feature', text: 'A search box on the notes list.' },
  checks: [
    {
      id: 'c1',
      title: 'Search narrows the list',
      why: 'The box is the whole feature.',
      where: { text: 'The notes list.', links: [{ label: 'PR 101', kind: 'pr', target: '101' }] },
      do: [
        {
          text: 'Run `curl http://localhost:3000/notes?q=standup` and look at the rows.',
          see: 'Two rows.'
        }
      ],
      passes: 'Only standup rows.',
      fails: 'Every row stays.',
      nothingFromHere: 'only eyes can tell'
    }
  ]
} as unknown as WalkScript

function loadFor(): Record<string, unknown> {
  const started = startRun(newRun(toMachineChecks(script), { n: 1 }), 100)
  if (!started.ok) throw new Error('run did not start')
  return {
    folder: FOLDER,
    walkDir: `${FOLDER}/.harnu/walks/wlk-5d2e91ab`,
    walkId: 'wlk-5d2e91ab',
    runId: 'run-81c0ffee',
    rev: 1,
    script,
    deepenings: [],
    simpler: [],
    added: [],
    run: started.run,
    closeOut: null,
    ownerSessionId: 'sess-owner',
    tick: { revealed: [], ticked: {} },
    held: false,
    waitMs: 30_000,
    saved: null,
    criteria: [],
    mission: null
  }
}

const api = {
  walkLoad: vi.fn(),
  walkWatch: vi.fn(async () => true),
  walkReplay: vi.fn(async () => ({ delivered: 0, pending: 0 })),
  walkOperate: vi.fn(),
  walkList: vi.fn(async () => ({ ok: true, walks: [] })),
  onWalkChanged: vi.fn(() => () => {})
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  api.walkLoad.mockResolvedValue(loadFor())
  api.walkOperate.mockResolvedValue({ ok: true, sent: [], load: loadFor() })
  ;(window as unknown as { api: unknown }).api = api
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function mountWalk(): Promise<VueWrapper> {
  wrapper = mount(GuidedWalkPane, {
    attachTo: document.body,
    props: {
      pane: {
        id: 'p-walk',
        type: 'walk',
        payload: { walkId: 'wlk-5d2e91ab', runId: 'run-81c0ffee' }
      } as never,
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return wrapper
}

/** A click with a real `detail` (1 = a pointer click, 0 = a keyboard or script click); `trigger` cannot set it. */
async function clickWith(el: Element, detail: number): Promise<void> {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))
  await flushPromises()
}

function selectText(el: Element): void {
  const text = el.firstChild as Text
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, Math.min(8, text.length))
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('BUG-292 — the walk pane content is selectable', () => {
  it('AC-1 / AC-5: the walk pane content root opts in with select-text', async () => {
    const w = await mountWalk()
    const body = w.get('[data-test="walk-body"]')
    expect(body.classes()).toContain('select-text')
  })

  it('AC-1: the check text the operator copies is inside that root, the buttons and header are not', async () => {
    const w = await mountWalk()
    const body = w.get('[data-test="walk-body"]').element
    expect(body.textContent).toContain('curl http://localhost:3000/notes?q=standup')
    expect(body.contains(w.get('[data-test="walk-close"]').element)).toBe(false) // header controls stay chrome
    expect(body.contains(w.get('[data-test="walk-progress"]').element)).toBe(false) // so does the progress bar
  })

  it('AC-4: the Walks library content root opts in with select-text', async () => {
    wrapper = mount(WalksPane, {
      attachTo: document.body,
      props: { pane: { id: 'p-lib', type: 'walks', payload: {} } as never, worktreePath: FOLDER },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    expect(wrapper.get('[data-test="walks-body"]').classes()).toContain('select-text')
  })

  it('AC-1: buttons, chips and key hints stay non-selectable inside the selectable root', () => {
    const css = read('src/renderer/src/components/GuidedWalkPane.vue')
    const rule = css.match(/\.wk \.wk-body button[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/user-select:\s*none/)
    expect(rule).toContain('[data-walk-chip]')
    expect(rule).toContain('kbd')
    expect(rule).toContain('[role="option"]')
  })
})

describe('BUG-292 — selecting does not act', () => {
  it('AC-6: with text selected, a bare letter does not fire an outcome', async () => {
    const w = await mountWalk()
    const root = w.get('[data-dsqa="walk"]')
    // `s` is Skip (a step sent to main) when nothing is selected; see the AC-3 test below
    selectText(w.get('[data-test="walk-body"] .wk-title, [data-test="walk-body"] h2').element)
    await root.trigger('keydown', { key: 's' })
    await flushPromises()
    expect(api.walkOperate).not.toHaveBeenCalled()
  })

  it('AC-3: with nothing selected the same letter still fires (Skip is sent to main)', async () => {
    const w = await mountWalk()
    await w.get('[data-dsqa="walk"]').trigger('keydown', { key: 's' })
    await flushPromises()
    expect(api.walkOperate).toHaveBeenCalledTimes(1)
    expect(api.walkOperate.mock.calls[0][0]).toMatchObject({ op: 'skip' })
  })

  it('AC-6: Esc clears the selection and does nothing else', async () => {
    const w = await mountWalk()
    selectText(w.get('[data-test="walk-body"] h2').element)
    expect(window.getSelection()!.isCollapsed).toBe(false)
    await w.get('[data-dsqa="walk"]').trigger('keydown', { key: 'Escape' })
    expect(window.getSelection()!.isCollapsed).toBe(true)
  })

  it('AC-2 / AC-7: a drag that began on text and ended on a button does not press it', async () => {
    const w = await mountWalk()
    const skip = w.get('[data-outcome="skip"]') // not Done: Done has its own 400 ms debounce
    const text = w.get('[data-test="walk-body"] h2')
    await text.trigger('pointerdown')
    await clickWith(skip.element, 1)
    expect(api.walkOperate).not.toHaveBeenCalled()
  })

  it('AC-2: a plain click on a button still presses it', async () => {
    const w = await mountWalk()
    const skip = w.get('[data-outcome="skip"]')
    await skip.trigger('pointerdown')
    await clickWith(skip.element, 1)
    expect(api.walkOperate).toHaveBeenCalledTimes(1)
  })

  it('AC-2: a keyboard click (no press, detail 0) still presses it', async () => {
    const w = await mountWalk()
    await clickWith(w.get('[data-outcome="skip"]').element, 0)
    expect(api.walkOperate).toHaveBeenCalledTimes(1)
  })
})
