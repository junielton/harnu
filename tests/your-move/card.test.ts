// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarReturnZone from '../../src/renderer/src/components/SidebarReturnZone.vue'

// The zone and its cards talk to the sessions store only through this narrow surface.
const sessionsFake = vi.hoisted(() => ({
  forgottenSessions: [] as unknown[],
  allSessions: [] as unknown[],
  activateSession: vi.fn((_id: string) => true),
  markSessionSeen: vi.fn(),
  folderAliasOf: vi.fn((_id: string) => 'www'),
  // The id index the card reads (BUG-261): the same sessions, each in the folder 'www'.
  get sessionIndex() {
    return new Map(
      (this.allSessions as { sessionId: string }[]).map((s) => [
        s.sessionId,
        { session: s, folderAlias: 'www' }
      ])
    )
  }
}))
const missionsFake = vi.hoisted(() => ({ requestPopover: vi.fn() }))
vi.mock('../../src/renderer/src/stores/sessions', () => ({ useSessionsStore: () => sessionsFake }))
vi.mock('../../src/renderer/src/stores/missions', () => ({ useMissionsStore: () => missionsFake }))

const NOW = 1_800_000_000_000

const card = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  sessionId: 'sess-0001',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Merge PROJ-231 now?',
  context: 'CI is green on api-gateway and the review is approved.',
  blocks: 'the release of web-api',
  options: ['Merge now', 'Wait for CI'],
  recommended: 'Wait for CI',
  source: 'judge',
  lane: 'live',
  openedAt: NOW - 123_000,
  updatedAt: NOW - 123_000,
  answerable: true,
  optionDeliverable: [true, true],
  ...over
})

let wrapper: VueWrapper | null = null
let cards: unknown[]
let mode: string
let exitCard: ReturnType<typeof vi.fn>
let openExternal: ReturnType<typeof vi.fn>

async function mountZone(list: unknown[], prefsMode = 'live'): Promise<VueWrapper> {
  cards = list
  mode = prefsMode
  exitCard = vi.fn(async (args: { cardId: string }) => {
    cards = cards.filter((c) => (c as { id: string }).id !== args.cardId)
    return { ok: true }
  })
  openExternal = vi.fn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = {
    yourMoveList: vi.fn(async () => cards),
    yourMovePrefsGet: vi.fn(async () => ({ mode })),
    onYourMoveChanged: vi.fn(() => () => undefined),
    yourMoveExit: exitCard,
    shellOpenExternal: openExternal
  }
  wrapper = mount(SidebarReturnZone, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const cardEls = (w: VueWrapper) => w.findAll('[data-testid="your-move-card"]')
async function expand(w: VueWrapper, at = 0): Promise<void> {
  await cardEls(w)[at].get('[data-testid="your-move-card-toggle"]').trigger('click')
}
const buttonTexts = (w: VueWrapper, at = 0): string[] =>
  cardEls(w)
    [at].findAll('button')
    .map((b) => b.text())

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  sessionsFake.forgottenSessions = []
  sessionsFake.allSessions = [{ sessionId: 'sess-0001', summary: 'Ship PROJ-231' }]
  sessionsFake.activateSession.mockClear()
  sessionsFake.markSessionSeen.mockClear()
  missionsFake.requestPopover.mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('YourMoveCard in the Return here zone', () => {
  it('shows kind, folder and session, clock and ask; expanded shows context and buttons', async () => {
    const w = await mountZone([card()])
    const el = cardEls(w)[0]
    expect(el.text()).toContain('Decide')
    expect(el.text()).toContain('www')
    expect(el.text()).toContain('Ship PROJ-231')
    expect(el.text()).toContain('02m')
    expect(el.text()).toContain('Merge PROJ-231 now?')
    // collapsed: no context, no buttons
    expect(el.text()).not.toContain('CI is green')
    expect(el.findAll('button').map((b) => b.text())).toEqual([
      expect.stringContaining('Merge PROJ-231 now?')
    ])

    await expand(w)
    expect(el.text()).toContain('CI is green on api-gateway')
    expect(el.text()).toContain('the release of web-api')
    // recommended first and marked, then the other option, then Open session, then the exits
    const texts = buttonTexts(w).slice(1)
    expect(texts[0]).toContain('Wait for CI')
    expect(texts[0]).toContain('Recommended')
    expect(texts[1]).toBe('Merge now')
    expect(texts.slice(2)).toEqual(['Open session', 'Not for me', 'Already handled'])
  })

  it('markup in ask, context and options renders as literal text', async () => {
    const ask = '<img src=x onerror="boom()"> Merge **now**'
    const context = '<script>boom()</script><b>bold</b> context'
    const w = await mountZone([
      card({
        ask,
        context,
        blocks: '<u>release</u>',
        options: ['<i>one</i>', 'two'],
        recommended: undefined
      })
    ])
    await expand(w)
    const el = cardEls(w)[0]
    expect(el.text()).toContain(ask)
    expect(el.text()).toContain(context)
    expect(el.text()).toContain('<u>release</u>')
    expect(el.text()).toContain('<i>one</i>')
    for (const tag of ['img', 'script', 'b', 'u', 'i']) {
      expect(el.find(tag).exists(), `<${tag}> must not be parsed`).toBe(false)
    }
  })

  it('every card has Not for me and Already handled; neither sends anything to the session', async () => {
    const w = await mountZone([card({ id: 'c1' }), card({ id: 'c2', ask: 'Second?' })])
    await expand(w, 0)
    const exits = cardEls(w)[0].findAll('button').slice(-2)
    expect(exits.map((b) => b.text())).toEqual(['Not for me', 'Already handled'])
    await exits[0].trigger('click')
    await flushPromises()
    expect(exitCard).toHaveBeenLastCalledWith({ cardId: 'c1', label: 'not-for-me' })

    // the second card, expanded, has both exits as well
    await expand(w, 0)
    expect(buttonTexts(w, 0).slice(-2)).toEqual(['Not for me', 'Already handled'])
    await cardEls(w)[0].findAll('button').at(-1)!.trigger('click')
    await flushPromises()
    expect(exitCard).toHaveBeenLastCalledWith({ cardId: 'c2', label: 'already-handled' })
    expect(cardEls(w)).toHaveLength(0)
    // an exit never reaches the session: it is not opened, answered or written to
    expect(sessionsFake.activateSession).not.toHaveBeenCalled()
  })

  it('renders no × and no dismiss control', async () => {
    const w = await mountZone([card(), card({ id: 'c2', kind: 'provide', options: undefined })])
    await expand(w, 0)
    await expand(w, 1)
    const zone = w.html()
    expect(zone).not.toContain('×')
    expect(zone).not.toContain('✕')
    expect(zone).not.toContain('lucide-x')
    expect(w.find('[aria-label="Mark as seen"]').exists()).toBe(false)
    expect(w.find('[role="button"]').exists()).toBe(false)
    // every control a card has is named by words
    // (the section's chevron is the one icon control; it is named by its aria-label)
    for (const b of w.findAll('button:not([data-section-toggle])')) {
      expect(b.text().trim().length).toBeGreaterThan(1)
    }
    expect(w.get('[data-section-toggle]').attributes('aria-label')).toBe('Collapse Return here')
  })

  it('the eyebrow shows the count and the oldest clock', async () => {
    const w = await mountZone([
      card({ id: 'young', openedAt: NOW - 123_000 }),
      card({ id: 'old', openedAt: NOW - 3_723_000, ask: 'Old one' })
    ])
    const eyebrow = w.get('[data-testid="your-move-eyebrow"]')
    expect(eyebrow.text()).toContain('Return here')
    expect(eyebrow.text()).toContain('2')
    expect(eyebrow.text()).toContain('1h 02m')
    // oldest first
    expect(cardEls(w)[0].text()).toContain('Old one')
  })

  it('in mode live the zone lists cards; in off and observe it keeps the legacy rows', async () => {
    sessionsFake.forgottenSessions = [{ sessionId: 'sess-9', summary: 'Legacy waiting session' }]
    const live = await mountZone([card()], 'live')
    expect(live.text()).toContain('Merge PROJ-231 now?')
    expect(live.text()).not.toContain('Legacy waiting session')
    live.unmount()
    wrapper = null

    for (const m of ['observe', 'off']) {
      setActivePinia(createPinia())
      const w = await mountZone([card()], m)
      expect(w.text()).toContain('Legacy waiting session')
      expect(w.text()).not.toContain('Merge PROJ-231 now?')
      expect(w.find('[data-testid="your-move-card"]').exists()).toBe(false)
      w.unmount()
      wrapper = null
    }
  })

  it('opening the session leaves the card in the queue', async () => {
    const w = await mountZone([card()])
    await expand(w)
    const open = cardEls(w)[0]
      .findAll('button')
      .find((b) => b.text() === 'Open session')!
    await open.trigger('click')
    await flushPromises()
    expect(sessionsFake.activateSession).toHaveBeenCalledWith('sess-0001')
    expect(exitCard).not.toHaveBeenCalled()
    expect(cardEls(w)).toHaveLength(1)
    expect(cardEls(w)[0].text()).toContain('Merge PROJ-231 now?')
  })

  it('until the answering unit an answer button opens the session and keeps the card', async () => {
    const w = await mountZone([card()])
    await expand(w)
    await cardEls(w)[0]
      .findAll('button')
      .find((b) => b.text() === 'Merge now')!
      .trigger('click')
    await flushPromises()
    expect(sessionsFake.activateSession).toHaveBeenCalledWith('sess-0001')
    expect(cardEls(w)).toHaveLength(1)
  })

  it('renders a system card from its askKey, and the English ask when the key is unknown', async () => {
    const w = await mountZone([
      card({
        id: 's1',
        kind: 'do',
        source: 'death',
        options: undefined,
        ask: 'Session stopped: English fallback',
        askKey: { key: 'yourMove.system.stopped', params: { reason: 'rate limit' } }
      }),
      card({
        id: 's2',
        kind: 'do',
        source: 'judge-failure',
        options: undefined,
        openedAt: NOW - 10_000,
        ask: 'Could not check this session: fallback text',
        askKey: { key: 'yourMove.system.nope', params: {} }
      })
    ])
    expect(cardEls(w)[0].text()).toContain('Session stopped: rate limit')
    expect(cardEls(w)[0].text()).not.toContain('English fallback')
    expect(cardEls(w)[1].text()).toContain('Could not check this session: fallback text')
    await expand(w, 0)
    // a system card has Open session only, besides the exits
    expect(buttonTexts(w, 0).slice(1)).toEqual(['Open session', 'Not for me', 'Already handled'])
  })

  it('follows a link only when it is http(s), and a mission card opens its mission', async () => {
    const w = await mountZone([
      card({ id: 'd1', kind: 'do', options: undefined, link: 'https://example.com/pull/231' }),
      card({
        id: 'd2',
        kind: 'do',
        options: undefined,
        link: 'javascript:alert(1)',
        openedAt: NOW - 50_000
      }),
      card({
        id: 'm1',
        kind: 'go_no_go',
        source: 'mission',
        options: undefined,
        openedAt: NOW - 40_000,
        mission: { missionId: 'mnt-1', root: '/org/proj/www', item: { kind: 'close' } }
      })
    ])
    await expand(w, 0)
    await cardEls(w)[0]
      .findAll('button')
      .find((b) => b.text() === 'Open link')!
      .trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/pull/231')

    await expand(w, 1)
    expect(buttonTexts(w, 1)).not.toContain('Open link')

    await expand(w, 2)
    expect(buttonTexts(w, 2).slice(1)).toEqual([
      'Open session',
      'Open mission',
      'Not for me',
      'Already handled'
    ])
    await cardEls(w)[2]
      .findAll('button')
      .find((b) => b.text() === 'Open mission')!
      .trigger('click')
    expect(sessionsFake.activateSession).toHaveBeenCalledWith('sess-0001')
    expect(missionsFake.requestPopover).toHaveBeenCalledWith('mnt-1')
  })

  it('a card whose answer was not delivered says so and stays', async () => {
    const w = await mountZone([
      card({ delivery: { state: 'failed', failure: 'wake-timeout', text: 'Merge now', at: NOW } })
    ])
    await expand(w)
    expect(cardEls(w)[0].get('[data-testid="your-move-delivery"]').text()).toContain(
      'did not wake up'
    )
  })

  it('the store starts quietly when the bridge is missing or partial', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { useYourMoveStore } = await import('../../src/renderer/src/stores/your-move')
    await expect(useYourMoveStore().init()).resolves.toBeUndefined()
    expect(useYourMoveStore().count).toBe(0)
  })

  it('a failed exit write shows an error and leaves the card open', async () => {
    const w = await mountZone([card()])
    await expand(w)
    const exitButton = (): ReturnType<VueWrapper['get']> =>
      cardEls(w)[0]
        .findAll('button')
        .find((b) => b.text() === 'Not for me')!
    exitCard.mockResolvedValueOnce({ ok: false, reason: 'write failed' })
    await exitButton().trigger('click')
    await flushPromises()
    const err = cardEls(w)[0].get('[data-testid="your-move-exit-error"]')
    expect(err.text()).toContain('still here')
    expect(cardEls(w)).toHaveLength(1)
    // an IPC rejection reads as a failure too, and the exits keep working
    exitCard.mockRejectedValueOnce(new Error('ipc closed'))
    await exitButton().trigger('click')
    await flushPromises()
    expect(cardEls(w)[0].find('[data-testid="your-move-exit-error"]').exists()).toBe(true)
    // the retry goes through: the card leaves and no error stays behind
    await exitButton().trigger('click')
    await flushPromises()
    expect(exitCard).toHaveBeenCalledTimes(3)
    expect(cardEls(w)).toHaveLength(0)
  })

  it('an exit for a card that is already gone shows no error', async () => {
    const w = await mountZone([card()])
    await expand(w)
    exitCard.mockResolvedValueOnce({ ok: false, reason: 'not found' })
    await cardEls(w)[0]
      .findAll('button')
      .find((b) => b.text() === 'Already handled')!
      .trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="your-move-exit-error"]').exists()).toBe(false)
  })
})
