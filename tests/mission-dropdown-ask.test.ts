// @vitest-environment jsdom
/**
 * Mission dropdown · S-3 · AC-16 (and the structure behind AC-11, card BUG-287) — "Ask" on the open
 * milestone: the button at the right end of the summary line with its own gap, and the box under that line
 * (textarea, hint, Cancel and Send, then "added to the prompt"), all as in the pane (design.md §6 "Mission
 * dropdown" → "What it draws" 3; mockup state `ask`).
 *
 * Mounted against the real stores with a fake PTY writer on the terminal bus, as `mission-pane-ask.test.ts`
 * does for the pane: Ask goes to the session that LEADS, into its prompt, with no Enter, and writes no record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdownTree from '../src/renderer/src/components/MissionDropdownTree.vue'
import { registerWriter, unregisterWriter } from '../src/renderer/src/lib/terminal-bus'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { sampleOf } from '../src/renderer/src/lib/mission-sample'
import type { MissionV4Reply } from '../src/renderer/src/lib/mission-pane-view'

const LEADER = '22222222-2222-4222-8222-222222222222'

type Detail = MissionV4Reply['detail']

let wrapper: VueWrapper | null = null
let writes: string[] = []

/** The sample mission: its current milestone is "A tool that scores a spec", with steps running and waiting. */
function detail(): Detail {
  return structuredClone((sampleOf('default').reply as MissionV4Reply).detail)
}

function liveLeader(): void {
  writes = []
  registerWriter(LEADER, (data) => writes.push(data))
  useSessionsStore().registerLiveSession(LEADER)
}

function mountTree(askLeader: string | null = LEADER): VueWrapper {
  i18n.global.locale.value = 'en'
  wrapper = mount(MissionDropdownTree, {
    props: { detail: detail(), askLeader },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = { shellOpenExternal: vi.fn() }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  unregisterWriter(LEADER)
  document.body.innerHTML = ''
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const text = (sel: string): string => q(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

async function click(sel: string): Promise<void> {
  const el = q(sel)
  if (!el) throw new Error(`no element for ${sel}`)
  el.click()
  await flushPromises()
}

async function typeInto(sel: string, value: string): Promise<void> {
  const el = q(sel) as HTMLTextAreaElement | null
  if (!el) throw new Error(`no element for ${sel}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('AC-11 — the Ask button has its own gap', () => {
  it('sits at the right end of the open milestone summary line, with gap 4px 14px', () => {
    liveLeader()
    mountTree()

    const line = q('[data-test="milestone-summary"]') as HTMLElement
    expect(line).not.toBeNull()
    // One line: the count text, then Ask. The line wraps rather than let the two touch.
    expect(line.className).toMatch(/\bflex\b/)
    expect(line.className).toMatch(/flex-wrap/)
    expect(line.className).toMatch(/justify-between/)
    expect(line.getAttribute('style')).toMatch(/gap:\s*4px 14px/)
    const ask = q('[data-test="ask-open"]') as HTMLElement
    expect(line.lastElementChild).toBe(ask)
    expect(line.firstElementChild).not.toBe(ask)
    // The summary text is not pressed against it: it is a sibling, not a flex-1 box that eats the gap.
    expect(line.firstElementChild?.getAttribute('data-test')).toBe('milestone-summary-text')
    // The words are the milestone's counts (the server's), with the separator trailing its part.
    expect(text('[data-test="milestone-summary-text"]')).toMatch(/running|Nothing running/)
    // Ask is a ghost, compact button with the message glyph and a title.
    expect(ask.textContent?.trim()).toBe('Ask')
    expect(ask.getAttribute('title')).toBe('Ask the session about this milestone')
    expect(ask.className).toMatch(/h-5/)
    // A focus ring borrows its radius from the parent: the wrapper carries one.
    expect(ask.parentElement?.className).toMatch(/rounded/)
  })

  it('draws no Ask when nobody leads the mission', () => {
    mountTree(null)
    expect(q('[data-test="milestone-summary"]')).not.toBeNull()
    expect(q('[data-test="ask-open"]')).toBeNull()
  })

  it('only the open milestone has a summary line and an Ask', () => {
    liveLeader()
    mountTree()
    expect(document.body.querySelectorAll('[data-test="ask-open"]')).toHaveLength(1)
  })
})

describe('AC-16 — the Ask box', () => {
  it('ask box sends and confirms', async () => {
    liveLeader()
    mountTree()
    const record = vi.fn()
    ;(window as unknown as { api: Record<string, unknown> }).api.missionV4Door = record

    await click('[data-test="ask-open"]')
    // The box opens right under the summary line, in the milestone's body, before the first step.
    const box = q('[data-test="ask-box"]') as HTMLElement
    expect(box).not.toBeNull()
    const line = q('[data-test="milestone-summary"]') as HTMLElement
    expect(line.nextElementSibling).toBe(box)
    // The textarea with its label and placeholder, the hint naming where it goes, Cancel and Send.
    const input = q('[data-test="ask-input"]') as HTMLTextAreaElement
    expect(input.tagName).toBe('TEXTAREA')
    expect(input.getAttribute('placeholder')).toBe(
      'What is still missing to finish this milestone?'
    )
    expect(box.querySelector('label')?.textContent).toContain(
      'Question about “A tool that scores a spec”'
    )
    expect(text('[data-test="ask-hint"]')).toMatch(
      /^Goes to the prompt of .+\. The answer shows in that session\.$/
    )
    expect(text('[data-test="ask-cancel"]')).toBe('Cancel')
    expect(text('[data-test="ask-send"]')).toBe('Send')
    // Nothing to send yet.
    expect((q('[data-test="ask-send"]') as HTMLButtonElement).disabled).toBe(true)
    // The box takes focus, and the button that opened it is pressed.
    expect(document.activeElement).toBe(input)
    expect(q('[data-test="ask-open"]')?.getAttribute('aria-expanded')).toBe('true')

    await typeInto('[data-test="ask-input"]', 'What is still missing to finish this milestone?')
    await click('[data-test="ask-send"]')

    // It went to the session that LEADS, as the pane did: into its prompt, never submitted.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(
      'About the milestone “A tool that scores a spec”: What is still missing to finish this milestone?'
    )
    expect(writes[0]).not.toMatch(/\r$/)
    // It writes no record.
    expect(record).not.toHaveBeenCalled()
    // The result: where the answer will be, and a way to close.
    expect(text('[data-test="ask-done"]')).toMatch(
      /^Added to the prompt of .+\. Press Enter there to send it\. The answer shows in that session\.$/
    )
    expect(q('[data-test="ask-input"]')).toBeNull()
    await click('[data-test="ask-close"]')
    expect(q('[data-test="ask-box"]')).toBeNull()
  })

  it('says so, and writes nothing, when the leading session is not running; the question stays', async () => {
    writes = []
    mountTree()
    await click('[data-test="ask-open"]')
    await typeInto('[data-test="ask-input"]', 'Anything left?')
    await click('[data-test="ask-send"]')
    expect(writes).toEqual([])
    expect(text('[data-test="ask-error"]')).toMatch(
      /is not running\. Resume it, then send the question again\.$/
    )
    expect((q('[data-test="ask-input"]') as HTMLTextAreaElement).value).toBe('Anything left?')
  })

  it('Cancel closes the box and Ask again toggles it', async () => {
    liveLeader()
    mountTree()
    await click('[data-test="ask-open"]')
    await click('[data-test="ask-cancel"]')
    expect(q('[data-test="ask-box"]')).toBeNull()
    expect(writes).toEqual([])
    await click('[data-test="ask-open"]')
    expect(q('[data-test="ask-box"]')).not.toBeNull()
    await click('[data-test="ask-open"]')
    expect(q('[data-test="ask-box"]')).toBeNull()
  })

  it('the box is gone with the milestone it belongs to', async () => {
    liveLeader()
    mountTree()
    await click('[data-test="ask-open"]')
    const open = [
      ...document.body.querySelectorAll<HTMLElement>('[data-test="milestone-row"]')
    ].find((el) => el.getAttribute('aria-expanded') === 'true') as HTMLElement
    expect(open).toBeDefined()
    open.click()
    await flushPromises()
    expect(q('[data-test="ask-box"]')).toBeNull()
  })
})

describe('Ask box — one border, visible focus', () => {
  const cls = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/)

  it('draws a single border: the box has it, the textarea inside has none of its own', async () => {
    liveLeader()
    mountTree()
    await click('[data-test="ask-open"]')
    const input = q('[data-test="ask-input"]')
    const box = input?.parentElement ?? null
    expect(cls(box)).toContain('border')
    expect(cls(input)).not.toContain('border')
    expect(
      cls(input).filter((c) => /^(border-(?!0$)|bg-(?!transparent$)|focus:border)/.test(c))
    ).toEqual([])
  })

  it('shows focus on the box through the accent border when the field is focused', async () => {
    liveLeader()
    mountTree()
    await click('[data-test="ask-open"]')
    const box = q('[data-test="ask-input"]')?.parentElement ?? null
    expect(cls(box)).toContain('focus-within:border-accent')
    expect(cls(box)).toContain('border-border-2')
  })

  it('opts the textarea out of the global focus ring so only the box shows focus', async () => {
    liveLeader()
    mountTree()
    await click('[data-test="ask-open"]')
    const input = q('[data-test="ask-input"]')
    expect(cls(input)).toContain('no-default-ring')
    expect(cls(input)).toContain('outline-none')
  })
})
