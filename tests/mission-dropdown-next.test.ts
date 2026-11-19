// @vitest-environment jsdom
/**
 * Mission dropdown · S-2 · AC-3a and AC-7 — the one card that holds what the operator owes next: the next
 * step, a staged Done when, or a request to join; its compact button right of the text when the body is
 * 380px wide or more and under it below that; "{n} more waiting on you" opening the rest in place; and
 * initial focus on the card's button (design.md §6 "Mission dropdown" → "What it draws" 2).
 *
 * jsdom has no layout engine, so the width rule is read off the classes: the body is a size container
 * (`@container`, in the shell), the card's layout switches on `@min-[380px]:`, and under that width the
 * button is simply the next row of a one-column grid. The real pixels are captured from the dev route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import MissionDropdownNext from '../src/renderer/src/components/MissionDropdownNext.vue'
import { NEXT_WIDE_MIN, OWED_RANK, nextCardOf } from '../src/renderer/src/lib/mission-pane-view'
import { WAITING_RANK } from '../src/main/missions/waiting'
import { sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

type Mission = Extract<MissionV4ViewReply, { state: 'mission' }>

const FOLDER = '/repo'
const SESSION = '99999999-9999-4999-8999-999999999999'

type Edit = (r: Mission & { detail: Record<string, unknown> }) => void

/** The sample reply of a state, made the reply of a REAL session. */
function replyOf(state: SampleState, edit?: Edit): Mission {
  const r = structuredClone(sampleOf(state).reply) as Mission
  r.sessions = r.sessions.map((s, i) => (i === 0 ? { ...s, id: SESSION } : s))
  edit?.(r as never)
  return r
}

const waitingOf = (r: Mission): { items: unknown[]; more: unknown[]; next: unknown } =>
  r.detail.waiting as never

/** A staged Done when: the card the sample has no state for. */
const stage: Edit = (r) => {
  r.pendingDoneWhen = {
    text: 'The spec skill is scored, and both fixes are proven by a fresh run.'
  }
  const w = waitingOf(r)
  const rescope = { kind: 'rescope', id: 'rescope', ask: 'x', why: 'y' }
  w.items = [rescope, ...w.items]
  w.next = rescope
  w.more = (w.items as unknown[]).slice(1)
}

/** A request to join the mission, ranked last by the server: with nothing else owed it is the next item. */
const request: Edit = (r) => {
  const w = waitingOf(r)
  const attach = {
    kind: 'attach',
    id: 'attach:atr-1',
    requestId: 'atr-1',
    sessionId: 'sess-worker-3',
    ask: 'x',
    why: 'y'
  }
  w.items = [attach]
  w.next = attach
  w.more = []
}

/** One more thing owed behind the next one, so the card has "more waiting on you". */
const andMore: Edit = (r) => {
  const w = waitingOf(r)
  expect((w.items as unknown[]).length).toBeGreaterThan(1)
}

let wrapper: VueWrapper | null = null

function mountNext(mission: Mission): VueWrapper {
  i18n.global.locale.value = 'en'
  wrapper = mount(MissionDropdownNext, {
    props: { mission },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]

let door: ReturnType<typeof vi.fn>

/** A dropdown over a real session's reply: the way the pane tests feed the store. */
async function mountDropdown(reply: Mission): Promise<VueWrapper> {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => reply),
    missionV4Door: door,
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER, summary: 'Leader' }] }
  ] as never
  sessions.select(SESSION)
  const missions = useMissionsStore()
  missions.ensureStarted()
  await flushPromises()
  await new Promise((r) => setTimeout(r, 30))
  await flushPromises()
  const w = mount(MissionDropdown, { global: { plugins: [i18n] }, attachTo: document.body })
  wrapper = w
  const ui = useUiStore()
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await flushPromises()
  await nextTick()
  await nextTick()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  door = vi.fn(async () => ({ ok: true, changed: true }))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { x: 0, y: 0, width: 10, height: 10 }
  ] as unknown as DOMRectList)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('nextCardOf — which one thing is owed next (pure)', () => {
  it('the next step is the card, the rest is "more"', () => {
    const r = replyOf('default')
    const card = nextCardOf(r)
    expect(card.primary?.kind).toBe('item')
    expect(card.more.length).toBe(waitingOf(r).more.length)
  })

  it('a staged Done when replaces its re-scope item and is never also a second card', () => {
    const r = replyOf('default', stage)
    const card = nextCardOf(r)
    expect(card.primary?.kind).toBe('staged')
    expect(card.more.every((e) => e.kind !== 'staged')).toBe(true)
  })

  it('a staged Done when the waiting list does not name still counts: it is placed by rank', () => {
    const r = replyOf('default', (m) => {
      m.pendingDoneWhen = { text: 'A new end.' }
    })
    const card = nextCardOf(r)
    const all = [card.primary, ...card.more]
    expect(all.filter((e) => e?.kind === 'staged')).toHaveLength(1)
    // The ranked list puts a re-scope before a check and a review, so it is not hidden behind a fold.
    const kinds = all.map((e) => (e?.kind === 'item' ? e.item.kind : 'staged'))
    expect(kinds.indexOf('staged')).toBeLessThan(kinds.indexOf('settle'))
    expect(kinds.indexOf('staged')).toBeLessThan(kinds.indexOf('review'))
  })

  it('a request to join is the card when it is the next item', () => {
    const card = nextCardOf(replyOf('default', request))
    expect(card.primary).toMatchObject({ kind: 'item', item: { kind: 'attach' } })
  })

  it('nothing owed is no card entry', () => {
    const card = nextCardOf(replyOf('clear'))
    expect(card.primary).toBeNull()
    expect(card.more).toEqual([])
  })
})

describe('AC-7 — one card, compact button, wide and narrow', () => {
  it('one card, compact button, wide and narrow', async () => {
    expect(NEXT_WIDE_MIN).toBe(380)
    // The next step: one card, the "you" look, one compact button.
    mountNext(replyOf('default'))
    expect(qa('[data-test="next-card"]')).toHaveLength(1)
    const card = q('[data-test="next-card"]') as HTMLElement
    expect(card.getAttribute('data-look')).toBe('you')
    expect(card.className).toMatch(/\brounded\b/)
    expect(card.className).toMatch(/\bborder\b/)
    expect(card.className).toMatch(/\bborder-warning-line\b/)
    expect(card.className).toMatch(/\bbg-warning-soft\b/)
    const btn = q('[data-test="next-button"]') as HTMLElement
    // The compact size: h-5, px-2, 11px — never the large button.
    expect(btn.className).toMatch(/\bh-5\b/)
    expect(btn.className).toMatch(/\bpx-2\b/)
    expect(btn.className).toMatch(/text-\[11px\]/)
    expect(btn.textContent?.trim()).toBe('Open step')
    expect(btn.querySelector('svg.lucide-arrow-right')).not.toBeNull()

    // Wide (container ≥ 380px): the button is at the right of the text; narrow: under it. Both are the one
    // layout element's classes, switched by the container query, and the button follows the text in the DOM.
    const layout = q('[data-test="next-layout"]') as HTMLElement
    expect(layout.className).toContain('@min-[380px]:grid-cols-[minmax(0,1fr)_auto]')
    const acts = q('[data-test="next-actions"]') as HTMLElement
    expect(acts.className).toContain('@min-[380px]:col-start-2')
    expect(acts.className).toContain('@min-[380px]:row-start-1')
    const body = q('[data-test="next-body"]') as HTMLElement
    expect(body.compareDocumentPosition(acts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // No window-width breakpoint decides it.
    expect(card.outerHTML).not.toMatch(/\b(?:sm|md|lg|xl):/)
  })

  it('a close is the "ok" look with the Close mission… button, and asks the dropdown to close', () => {
    const w = mountNext(replyOf('done'))
    const card = q('[data-test="next-card"]') as HTMLElement
    expect(card.getAttribute('data-look')).toBe('ok')
    const btn = q('[data-test="next-button"]') as HTMLElement
    expect(btn.textContent?.trim()).toBe('Close mission…')
    expect(btn.querySelector('svg.lucide-flag')).not.toBeNull()
    btn.click()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('nothing owed is the calm look and says what runs, with no button', () => {
    mountNext(replyOf('clear'))
    const card = q('[data-test="next-card"]') as HTMLElement
    expect(card.getAttribute('data-look')).toBe('calm')
    expect(q('[data-test="next-button"]')).toBeNull()
    expect(card.textContent).toMatch(/Nothing for you right now/)
  })

  it('the next step opens its step', () => {
    const w = mountNext(replyOf('default'))
    ;(q('[data-test="next-button"]') as HTMLElement).click()
    expect(w.emitted('openStep')?.[0]?.[0]).toMatch(/^stp-/)
  })

  it('a staged Done when is ONE card with Approve and Decline, and no "Review it" hop or second ask', async () => {
    mountNext(replyOf('default', stage))
    expect(qa('[data-test="next-card"]')).toHaveLength(1)
    const card = q('[data-test="next-card"]') as HTMLElement
    expect(card.getAttribute('data-card')).toBe('staged')
    expect(card.getAttribute('data-look')).toBe('accent')
    expect(card.className).toMatch(/\bborder-accent-line\b/)
    expect(card.className).toMatch(/\bbg-accent-soft\b/)
    expect(card.textContent).toContain('The spec skill is scored, and both fixes are proven')
    expect(card.textContent).not.toMatch(/Review it/)
    expect(card.textContent).not.toMatch(/Approve or decline the new Done when/)
    const approve = q('[data-test="next-staged-approve"]') as HTMLElement
    const decline = q('[data-test="next-staged-decline"]') as HTMLElement
    expect(approve.className).toMatch(/\bh-5\b/)
    expect(decline.className).toMatch(/\bh-5\b/)
    expect(approve.querySelector('svg.lucide-check')).not.toBeNull()
    expect(decline.querySelector('svg.lucide-x')).not.toBeNull()
    expect(q('[data-test="done-when-staged"]')).toBeNull()
  })

  it('Approve and Decline go through the doors', async () => {
    door = vi.fn(async () => ({ ok: true, changed: true }))
    await mountDropdown(replyOf('default', stage))
    ;(q('[data-test="next-staged-approve"]') as HTMLElement).click()
    await flushPromises()
    expect(door).toHaveBeenCalledWith(expect.objectContaining({ door: 'approveDoneWhen' }))
    ;(q('[data-test="next-staged-decline"]') as HTMLElement).click()
    await flushPromises()
    expect(door).toHaveBeenCalledWith(expect.objectContaining({ door: 'declineDoneWhen' }))
  })

  it('a request to join is ONE card with Allow and Deny, and Allow and Deny decide it', async () => {
    await mountDropdown(replyOf('default', request))
    expect(qa('[data-test="next-card"]')).toHaveLength(1)
    const card = q('[data-test="next-card"]') as HTMLElement
    expect(card.getAttribute('data-card')).toBe('request')
    expect(card.className).toMatch(/\bborder-accent-line\b/)
    expect(card.textContent).toMatch(/asks to join/i)
    const allow = q('[data-test="next-request-allow"]') as HTMLElement
    const deny = q('[data-test="next-request-deny"]') as HTMLElement
    expect(allow.className).toMatch(/\bh-5\b/)
    expect(allow.textContent?.trim()).toBe('Allow')
    expect(deny.textContent?.trim()).toBe('Deny')
    allow.click()
    await flushPromises()
    expect(door).toHaveBeenCalledWith(
      expect.objectContaining({ door: 'decideAttach', requestId: 'atr-1', decision: 'allowed' })
    )
    ;(q('[data-test="next-request-deny"]') as HTMLElement).click()
    await flushPromises()
    expect(door).toHaveBeenCalledWith(
      expect.objectContaining({ door: 'decideAttach', requestId: 'atr-1', decision: 'denied' })
    )
  })

  it('"{n} more waiting on you" is a link under the why that opens the rest in place, a row each', async () => {
    const r = replyOf('default')
    andMore(r as never)
    mountNext(r)
    const more = q('[data-test="next-more"]') as HTMLElement
    const n = waitingOf(r).more.length
    expect(more.textContent?.trim()).toBe(`${n} more waiting on you`)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(qa('[data-test="next-rest-row"]')).toHaveLength(0)
    // Under the why, inside the card's text column.
    const body = q('[data-test="next-body"]') as HTMLElement
    expect(body.contains(more)).toBe(true)

    more.click()
    await nextTick()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.textContent?.trim()).toBe('Show less')
    const rows = qa('[data-test="next-rest-row"]')
    expect(rows).toHaveLength(n)
    // Same rule as the card: the button right when wide, below when narrow, and the compact size.
    for (const row of rows) {
      expect(row.className).toContain('@min-[380px]:grid-cols-[minmax(0,1fr)_auto]')
      const b = row.querySelector<HTMLElement>('button')
      if (b) {
        expect(b.className).toMatch(/\bh-5\b/)
        expect((b.parentElement as HTMLElement).className).toContain('@min-[380px]:col-start-2')
      }
    }
    expect(qa('[data-test="next-card"]')).toHaveLength(1)

    more.click()
    await nextTick()
    expect(qa('[data-test="next-rest-row"]')).toHaveLength(0)
  })

  it('an owed item behind the next one is never hidden without a count', () => {
    const r = replyOf('default')
    mountNext(r)
    const more = q('[data-test="next-more"]')
    expect(more?.textContent).toMatch(/^\s*\d+ more waiting on you\s*$/)
  })
})

describe('AC-3a — initial focus is on the card’s button', () => {
  it('initial focus is on the card’s button', async () => {
    // The next step: its button.
    await mountDropdown(replyOf('default'))
    expect(document.activeElement).toBe(q('[data-test="next-button"]'))
    wrapper?.unmount()
    document.body.innerHTML = ''
    useUiStore().closePopover('missionProgress')

    // A staged Done when: Approve.
    setActivePinia(createPinia())
    await mountDropdown(replyOf('default', stage))
    expect(document.activeElement).toBe(q('[data-test="next-staged-approve"]'))
    wrapper?.unmount()
    document.body.innerHTML = ''

    // A request to join: Allow.
    setActivePinia(createPinia())
    await mountDropdown(replyOf('default', request))
    expect(document.activeElement).toBe(q('[data-test="next-request-allow"]'))
  })

  it('with nothing owed, focus is on the dropdown itself', async () => {
    await mountDropdown(replyOf('clear'))
    expect(document.activeElement).toBe(q('[data-test="mission-dropdown"]'))
  })
})

describe('the renderer rank of what is owed', () => {
  it('is the server rank, kind for kind (it places a staged Done when among the waiting items)', () => {
    expect([...OWED_RANK]).toEqual([...WAITING_RANK])
  })
})
