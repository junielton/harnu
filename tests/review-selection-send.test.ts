// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewSelectionBar from '../src/renderer/src/components/ReviewSelectionBar.vue'
import { useReviewStore } from '../src/renderer/src/stores/review'
import {
  SEND_DEBOUNCE_MS,
  useReviewSelectionStore
} from '../src/renderer/src/stores/review-selection'
import { useUiStore } from '../src/renderer/src/stores/ui'
import {
  applyStateEvent,
  refuse,
  startDelivery,
  type DeliveryRecord
} from '../src/renderer/src/lib/review-selection-delivery'
import {
  NO_BINDING_REASONS,
  OUTCOME_NEXT,
  REFUSAL_NEXT,
  type DeliveryState,
  type SelectionStateEvent
} from '../src/main/companion/review-selection-core'
import en from '../src/renderer/src/i18n/en.json'
import { selectionSnapshot, stubReviewApi } from './helpers/review-selection-fixture'

/**
 * T257 U2b — the selection kept up to date for the open review companion, REACTIVELY and SILENTLY
 * (operator decision): every change is delivered after a 500 ms pause, latest wins, as a hidden
 * context row — never a turn, never a message. Driven through the real bar and store against a fake
 * IPC; the companion's presence is the one stubbed thing (the helpers store's single getter).
 *
 * U2b-AC-1 (send: reactive, debounced, latest-wins, held for a running turn, no companion = nothing
 * sent), -2 (copy), -3 (every outcome renders, nothing from main leaks), -4 (the chip describes
 * what the companion SEES — no question/answer words, nothing before delivery), -5 (no count).
 */

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const SPEECH = 'src/main/speech.ts'

const sidBox = vi.hoisted(() => ({ ref: null as { value: string | null } | null }))
vi.mock('../src/renderer/src/stores/helpers', async () => {
  const { ref } = await import('vue')
  sidBox.ref = ref<string | null>(null)
  return {
    useHelpersStore: () => ({
      get reviewCompanionSessionId() {
        return sidBox.ref!.value
      }
    })
  }
})

const T = (key: string): string => {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en)
  if (typeof v !== 'string') throw new Error(`no en string for ${key}`)
  return v
}

let wrapper: VueWrapper
let emit: (ev: SelectionStateEvent) => void
let send: ReturnType<typeof vi.fn>
let compose: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

const selection = () => useReviewSelectionStore()
const find = (name: string) => wrapper.find(`[data-test="${name}"]`)
const chipText = (): string => find('delivery-chip').text()
const lastId = (): string => selection().last!.selectionId
const ev = (
  state: DeliveryState,
  extra: Partial<SelectionStateEvent> = {}
): SelectionStateEvent => ({
  selectionId: lastId(),
  state,
  at: 1,
  ...extra
})

async function pushEvent(e: SelectionStateEvent): Promise<void> {
  emit(e)
  await nextTick()
}

/** Let the watcher run, wait out the pause, and let the send and its result settle. */
async function settle(ms = SEND_DEBOUNCE_MS): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** Change the live selection the way the pane does, then let the watcher react. */
async function choose(fn: () => void): Promise<void> {
  fn()
  await nextTick()
}

const mixedRange = (): void => {
  selection().select(SPEECH, 0, 1)
  selection().extend(SPEECH, 0, 3)
}
const sameSideRange = (): void => {
  selection().select(SPEECH, 0, 2)
  selection().extend(SPEECH, 0, 3)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  setActivePinia(createPinia())
  stubReviewApi()
  sidBox.ref!.value = SID
  send = vi.fn(async () => ({ ok: true, selectionId: 'x', cmd: 'c1', n: 1 }))
  compose = vi.fn(async () => ({ ok: true, text: 'EXACT TEXT\n```quoted\n 12 | b\n```\n' }))
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const api = (window as unknown as { api: Record<string, unknown> }).api
  api.reviewSelectionSend = send
  api.reviewSelectionCompose = compose
  api.onReviewSelectionState = (cb: (ev: SelectionStateEvent) => void) => {
    emit = cb
    return () => {}
  }
  const review = useReviewStore()
  review.snapshot = selectionSnapshot()
  review.expanded = Object.fromEntries(review.snapshot!.files.map((f) => [f.path, true]))
  wrapper = mount(ReviewSelectionBar, { global: { plugins: [i18n] } })
})

afterEach(() => {
  wrapper.unmount()
  // Stop this test's store watchers: they would otherwise react to the NEXT test flipping the
  // shared companion stub and send through its mock.
  const pinia = getActivePinia() as unknown as { _s: Map<string, { $dispose(): void }> }
  pinia._s.forEach((store) => store.$dispose())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('U2b-AC-1 — the companion keeps up with the selection, silently', () => {
  it('has no send button: the selection is the gesture', async () => {
    await choose(mixedRange)
    expect(find('selection-ask').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/ask about this/i)
    expect(find('selection-copy').exists()).toBe(true)
    expect(find('selection-clear').exists()).toBe(true)
  })

  it('sends the folder, refs, the companion id and the coordinates — no text — after the pause', async () => {
    await choose(mixedRange)
    const live = selection().live!
    await settle(SEND_DEBOUNCE_MS - 1)
    expect(send).not.toHaveBeenCalled() // the selection has not sat still yet
    await settle(1)
    expect(send).toHaveBeenCalledTimes(1)
    const req = send.mock.calls[0][0] as Record<string, unknown>
    const snap = useReviewStore().snapshot!
    expect(req).toEqual({
      folder: snap.folder,
      headRef: snap.head.ref,
      base: snap.base,
      companionSid: SID,
      selection: {
        id: live.id,
        subjectType: 'LINE',
        path: SPEECH,
        oldPath: null,
        line: live.line,
        side: live.side,
        startLine: live.startLine,
        startSide: live.startSide,
        baseSha: snap.baseSha,
        headSha: snap.head.sha,
        prNumber: null
      }
    })
    const json = JSON.stringify(req)
    for (const local of ['lineText', 'hunkIndex', 'rowFrom', 'rowTo', '"text"']) {
      expect(json).not.toContain(local)
    }
  })

  it('sends a whole file without line fields', async () => {
    await choose(() => selection().selectFile(SPEECH))
    await settle()
    const sel = (send.mock.calls[0][0] as { selection: Record<string, unknown> }).selection
    expect(sel.subjectType).toBe('FILE')
    for (const k of ['line', 'side', 'startLine', 'startSide']) expect(k in sel).toBe(false)
  })

  it('latest wins: a burst of changes inside the pause is ONE send, of the last selection', async () => {
    for (let row = 0; row < 6; row++) {
      await choose(() => selection().select(SPEECH, 0, row))
      await settle(100) // each change lands well inside the 500 ms pause
    }
    expect(send).not.toHaveBeenCalled()
    const final = selection().live!
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0][0] as { selection: { id: string } }).selection.id).toBe(final.id)
  })

  it('says "Updating…" while a change waits out the pause, then "Companion sees this"', async () => {
    await choose(mixedRange)
    expect(chipText()).toBe(T('review.selection.state.queued'))
    await settle()
    await pushEvent(ev('delivered'))
    expect(chipText()).toContain(T('review.selection.state.delivered'))
  })

  it('does not move back to "Updating…" when the result lands after the delivered event', async () => {
    send.mockImplementationOnce(async () => {
      emit(ev('queued'))
      emit(ev('delivered'))
      return { ok: true, selectionId: 'x', cmd: 'c1', n: 1 }
    })
    await choose(mixedRange)
    await settle()
    expect(selection().last!.phase).toBe('delivered')
  })

  it('a change while a send is crossing IPC is sent as soon as it lands — the latest, once', async () => {
    let release!: () => void
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, selectionId: 'x', cmd: 'c1', n: 1 })
        })
    )
    await choose(mixedRange)
    await settle() // the first send is now in flight
    await choose(() => selection().select(SPEECH, 0, 4))
    await choose(() => selection().select(SPEECH, 0, 5))
    const final = selection().live!
    await settle() // the pause is over, but the first send has not landed
    expect(send).toHaveBeenCalledTimes(1)
    release()
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[1][0] as { selection: { id: string } }).selection.id).toBe(final.id)
  })

  it('never has more than one send pending under fast changes', async () => {
    for (let i = 0; i < 30; i++) {
      await choose(() => selection().select(SPEECH, 0, i % 6))
      await settle(120)
    }
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
  })

  describe('with no companion open', () => {
    beforeEach(() => {
      sidBox.ref!.value = null
    })

    it('sends nothing, and says so quietly', async () => {
      await choose(mixedRange)
      await settle(SEND_DEBOUNCE_MS * 4)
      expect(send).not.toHaveBeenCalled()
      expect(selection().last).toBeNull()
      expect(find('selection-no-companion').text()).toBe(T('review.selection.outcome.no-companion'))
      // quiet: the neutral muted tone, no error styling, and nothing announced as a failure
      expect(find('selection-no-companion').classes()).toContain('text-text-3')
      expect(find('selection-no-companion').classes().join(' ')).not.toMatch(/red|warning/)
      expect(find('delivery-chip').text()).toBe('')
    })

    it('tells the companion the moment one opens', async () => {
      await choose(mixedRange)
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(send).not.toHaveBeenCalled()
      sidBox.ref!.value = SID
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
      expect(find('selection-no-companion').exists()).toBe(false)
    })
  })

  it('drops the record and the pending update when the companion closes', async () => {
    await choose(mixedRange)
    sidBox.ref!.value = null
    await settle(SEND_DEBOUNCE_MS * 2)
    expect(send).not.toHaveBeenCalled()
    expect(selection().last).toBeNull()
  })

  it('Clear selection cancels a pending update; with nothing delivered yet there is nothing to retract', async () => {
    await choose(mixedRange)
    await find('selection-clear').trigger('click')
    await settle(SEND_DEBOUNCE_MS * 2)
    expect(send).not.toHaveBeenCalled()
    expect(find('review-selection-bar').exists()).toBe(false)
  })

  describe('U2d-AC-1 — clearing tells the companion nothing is selected', () => {
    const clearCalls = (): Array<Record<string, unknown>> =>
      send.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((r) => r.selection === null)

    it('Clear after a delivery sends the cleared row: the sid and a fresh id, no coordinates', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      await find('selection-clear').trigger('click')
      await settle()
      expect(send).toHaveBeenCalledTimes(2)
      const [req] = clearCalls()
      expect(Object.keys(req).sort()).toEqual(['companionSid', 'id', 'selection'])
      expect(req.companionSid).toBe(SID)
      expect(String(req.id)).toMatch(/^sel_/)
      expect(req.id).not.toBe(lastId())
    })

    it('every way the selection goes away says so: Esc, a collapsed file, a toggle, a moved head', async () => {
      const ways: Array<[string, () => void]> = [
        ['esc', () => selection().clear('esc')],
        ['toggle', () => selection().toggleRow(SPEECH, 0, 1)],
        [
          'collapse',
          () => {
            const review = useReviewStore()
            review.expanded = { ...review.expanded, [SPEECH]: false }
          }
        ],
        [
          'snapshot',
          () => {
            useReviewStore().snapshot = selectionSnapshot({ baseSha: 'e'.repeat(40) })
          }
        ]
      ]
      for (const [name, how] of ways) {
        send.mockClear()
        selection().reset()
        const review = useReviewStore()
        review.snapshot = selectionSnapshot()
        review.expanded = Object.fromEntries(review.snapshot!.files.map((f) => [f.path, true]))
        await choose(() => selection().select(SPEECH, 0, 1))
        await settle()
        await pushEvent(ev('delivered'))
        send.mockClear()
        await choose(how)
        await settle()
        expect(clearCalls(), name).toHaveLength(1)
      }
    })

    it('says it once: a second clear with nothing selected sends nothing', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      await choose(() => selection().clear('esc'))
      await settle()
      selection().clear('esc')
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(clearCalls()).toHaveLength(1)
    })

    it('a selection made and cleared inside the pause never reaches the companion at all', async () => {
      await choose(mixedRange)
      await choose(() => selection().clear('esc'))
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(send).not.toHaveBeenCalled()
    })

    it('a new selection inside the pause after a clear replaces it: one send, the selection', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      send.mockClear()
      await choose(() => selection().clear('esc'))
      await choose(() => selection().select(SPEECH, 0, 5))
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
      expect((send.mock.calls[0][0] as { selection: unknown }).selection).not.toBeNull()
    })

    it('a refused selection left nothing in the companion, so clearing it says nothing', async () => {
      send.mockResolvedValueOnce({ ok: false, refusal: 'NO_BINDING', next: ['copy'] })
      await choose(mixedRange)
      await settle()
      send.mockClear()
      await choose(() => selection().clear('esc'))
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(send).not.toHaveBeenCalled()
    })

    it('with no companion open nothing is sent, and one that opens later is not told about a clear', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      send.mockClear()
      sidBox.ref!.value = null
      await choose(() => selection().clear('esc'))
      await settle(SEND_DEBOUNCE_MS * 2)
      sidBox.ref!.value = SID
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(send).not.toHaveBeenCalled()
    })

    it('after the conversation was cleared the row is gone, so clearing the selection says nothing', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      await pushEvent(ev('cleared'))
      send.mockClear()
      await choose(() => selection().clear('esc'))
      await settle(SEND_DEBOUNCE_MS * 2)
      expect(send).not.toHaveBeenCalled()
    })

    it('a clear that is refused is not a failure the operator sees: no chip, no record', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      send.mockResolvedValueOnce({ ok: false, refusal: 'NO_LEASE', next: ['try-again'] })
      const before = selection().last
      await choose(() => selection().clear('esc'))
      await settle()
      expect(selection().last).toBe(before)
      expect(find('review-selection-bar').exists()).toBe(false)
    })
  })

  describe('while a turn is running in the companion', () => {
    async function turnRunningOn(): Promise<void> {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered'))
      await pushEvent(ev('asked'))
    }

    it('holds the update, and sends only the latest when the turn completes', async () => {
      await turnRunningOn()
      const first = selection().last!.selectionId
      await choose(() => selection().select(SPEECH, 0, 4))
      await settle()
      await choose(() => selection().select(SPEECH, 0, 5))
      await settle()
      expect(send).toHaveBeenCalledTimes(1) // nothing new went out mid-turn
      expect(chipText()).toBe(T('review.selection.state.queued')) // "Updating…": held
      const latest = selection().live!
      // the running turn belongs to the FIRST selection; its end releases the hold
      await pushEvent({ selectionId: first, state: 'answered', at: 2 })
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(2)
      expect((send.mock.calls[1][0] as { selection: { id: string } }).selection.id).toBe(latest.id)
    })

    it('is released by a stopped, declined or failed turn just the same', async () => {
      for (const end of ['turn-stopped', 'turn-declined', 'turn-failed'] as const) {
        send.mockClear()
        selection().reset()
        await turnRunningOn()
        const first = selection().last!.selectionId
        await choose(() => selection().select(SPEECH, 0, 5))
        await settle()
        expect(send).toHaveBeenCalledTimes(1)
        await pushEvent({ selectionId: first, state: end, at: 2 })
        await flushPromises()
        expect(send, end).toHaveBeenCalledTimes(2)
      }
    })

    it('a selection cleared before the turn ends is held too: the cleared row goes when the turn does', async () => {
      await turnRunningOn()
      const first = selection().last!.selectionId
      await choose(() => selection().select(SPEECH, 0, 5))
      await settle()
      await find('selection-clear').trigger('click')
      await settle()
      expect(send).toHaveBeenCalledTimes(1) // the old row is still what the companion has
      await pushEvent({ selectionId: first, state: 'answered', at: 2 })
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(2)
      expect((send.mock.calls[1][0] as { selection: unknown }).selection).toBeNull()
    })

    it('does not hold for a delivery that is not mid-turn', async () => {
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('delivered')) // delivered, nobody has asked anything
      await choose(() => selection().select(SPEECH, 0, 5))
      await settle()
      expect(send).toHaveBeenCalledTimes(2)
    })
  })
})

describe('U2d-AC-4 — the hold covers every turn in the companion, not only the first', () => {
  async function delivered(): Promise<string> {
    await choose(mixedRange)
    await settle()
    const id = lastId()
    await pushEvent(ev('delivered'))
    return id
  }

  it('a second question on the same selection holds an update just like the first', async () => {
    const id = await delivered()
    await pushEvent({ selectionId: id, state: 'asked', at: 2 })
    await pushEvent({ selectionId: id, state: 'answered', at: 3 })
    await pushEvent({ selectionId: id, state: 'asked', at: 4 }) // the second question
    send.mockClear()
    await choose(() => selection().select(SPEECH, 0, 5))
    await settle()
    expect(send).not.toHaveBeenCalled() // mid-answer: held
    await choose(() => selection().select(SPEECH, 0, 4))
    await settle()
    expect(send).not.toHaveBeenCalled()
    await pushEvent({ selectionId: id, state: 'answered', at: 5 })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1) // the latest, once
    expect((send.mock.calls[0][0] as { selection: { id: string } }).selection.id).toBe(
      selection().live!.id
    )
  })

  it('after an answer and before the next question nothing is held', async () => {
    const id = await delivered()
    await pushEvent({ selectionId: id, state: 'asked', at: 2 })
    await pushEvent({ selectionId: id, state: 'answered', at: 3 })
    send.mockClear()
    await choose(() => selection().select(SPEECH, 0, 5))
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('every kind of ended turn releases a later one just the same', async () => {
    for (const end of ['turn-stopped', 'turn-declined', 'turn-failed'] as const) {
      selection().reset()
      send.mockClear()
      const id = await delivered()
      await pushEvent({ selectionId: id, state: 'asked', at: 2 })
      await pushEvent({ selectionId: id, state: end, at: 3 })
      await pushEvent({ selectionId: id, state: 'asked', at: 4 })
      await choose(() => selection().select(SPEECH, 0, 5))
      await settle()
      expect(send, end).toHaveBeenCalledTimes(1) // only the first send: the update is held
      await pushEvent({ selectionId: id, state: end, at: 5 })
      await flushPromises()
      expect(send, end).toHaveBeenCalledTimes(2)
    }
  })

  it('the chip reads the same through every turn', async () => {
    const id = await delivered()
    const sees = T('review.selection.state.delivered')
    for (const state of ['asked', 'answered', 'asked', 'turn-stopped'] as const) {
      await pushEvent({ selectionId: id, state, at: 2 })
      expect(chipText(), state).toContain(sees)
    }
  })
})

describe('U2d-AC-5 — with no companion the store sends nothing, by any door', () => {
  beforeEach(() => {
    sidBox.ref!.value = null
  })

  it('send() and retry() are no-ops: no IPC, no record, no subscription needed', async () => {
    await choose(mixedRange)
    await selection().send()
    await selection().retry()
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
    expect(selection().last).toBeNull()
    expect(selection().sending).toBe(false)
  })

  it('a clear sends nothing either, however the row got there', async () => {
    sidBox.ref!.value = SID
    await choose(mixedRange)
    await settle()
    await pushEvent(ev('delivered'))
    send.mockClear()
    sidBox.ref!.value = null
    await choose(() => selection().clear('esc'))
    await selection().send()
    await settle(SEND_DEBOUNCE_MS * 2)
    expect(send).not.toHaveBeenCalled()
  })

  it('Copy as text still works, which is the point of the guard', async () => {
    await choose(mixedRange)
    expect(await selection().copy()).toBe('copied')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('U2b-AC-2 — Copy as text', () => {
  it('copies exactly what review:selection:compose returns', async () => {
    await choose(mixedRange)
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(compose).toHaveBeenCalledTimes(1)
    const req = compose.mock.calls[0][0] as Record<string, unknown>
    expect('companionSid' in req).toBe(false)
    expect(writeText).toHaveBeenCalledWith('EXACT TEXT\n```quoted\n 12 | b\n```\n')
    expect(find('selection-copy').text()).toBe(T('review.selection.copied'))
  })

  it('works with no companion open, and sends nothing', async () => {
    sidBox.ref!.value = null
    await choose(mixedRange)
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('stays available in every §7 failure state except a moved head or base', async () => {
    await choose(mixedRange)
    await settle()
    const sel = selection().live!
    const disabled = (): boolean => (find('selection-copy').element as HTMLButtonElement).disabled
    for (const code of Object.keys(REFUSAL_NEXT)) {
      selection().last = refuse(startDelivery(sel), {
        refusal: code,
        next: REFUSAL_NEXT[code as never]
      })
      await nextTick()
      expect(disabled(), `refusal ${code}`).toBe(code === 'head-moved' || code === 'base-mismatch')
    }
    for (const code of Object.keys(OUTCOME_NEXT)) {
      selection().last = applyStateEvent(
        startDelivery(sel),
        ev('not-delivered', { code: code as never, next: [] })
      )
      await nextTick()
      expect(disabled(), `outcome ${code}`).toBe(false)
    }
  })

  it('a refused compose writes nothing and the chip says why', async () => {
    compose.mockResolvedValueOnce({
      ok: false,
      refusal: 'head-moved',
      next: REFUSAL_NEXT['head-moved'],
      detail: 'a1b2c3d e4f5a6b'
    })
    await choose(mixedRange)
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
    expect(chipText()).toContain(T('review.selection.outcome.head-moved'))
    expect((find('selection-copy').element as HTMLButtonElement).disabled).toBe(true)
    expect(find('step-reselect').exists()).toBe(true)
  })

  it('says so when the clipboard refuses, without a stack or an error message', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError: secret internals'))
    await choose(mixedRange)
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(find('copy-failed').text()).toBe(T('review.selection.copyFailed'))
    expect(wrapper.text()).not.toContain('secret internals')
  })
})

describe('U2b-AC-3 — every refusal and outcome renders, and nothing from main leaks', () => {
  const LEAK = 'LEAK-ME <b>from the mod</b> {{x}}'

  /** Select, wait out the pause: the send happens and its result decides the chip. */
  async function sendOnce(): Promise<void> {
    await choose(mixedRange)
    await settle()
  }

  it('renders the closed sentence of every refusal returned by the send', async () => {
    for (const code of Object.keys(REFUSAL_NEXT)) {
      selection().reset()
      send.mockResolvedValueOnce({
        ok: false,
        refusal: code,
        next: REFUSAL_NEXT[code as never],
        ...(code === 'NO_BINDING' ? { reason: 'cli-too-old' } : {}),
        detail: LEAK,
        message: LEAK
      })
      await sendOnce()
      expect(chipText(), code).toContain(T(`review.selection.outcome.${code}`))
      expect(wrapper.text(), code).not.toContain('LEAK-ME')
      expect(wrapper.html(), code).not.toContain('<b>from the mod')
    }
  })

  it('renders every NO_BINDING reason as its own sentence under the refusal', async () => {
    for (const reason of NO_BINDING_REASONS) {
      selection().reset()
      send.mockResolvedValueOnce({
        ok: false,
        refusal: 'NO_BINDING',
        reason,
        next: REFUSAL_NEXT.NO_BINDING
      })
      await sendOnce()
      expect(find('delivery-reason').text(), reason).toBe(T(`review.selection.noBinding.${reason}`))
    }
  })

  it('renders every outcome main reports after queueing, including every dropped reason', async () => {
    for (const code of Object.keys(OUTCOME_NEXT)) {
      selection().reset()
      await sendOnce()
      await pushEvent(
        ev('not-delivered', {
          code: code as never,
          next: OUTCOME_NEXT[code as never],
          message: LEAK
        } as never)
      )
      const key = code.startsWith('dropped-')
        ? `review.selection.outcome.dropped.${code.slice('dropped-'.length)}`
        : `review.selection.outcome.${code}`
      expect(chipText(), code).toContain(T(key))
      expect(wrapper.text(), code).not.toContain('LEAK-ME')
    }
  })

  it('renders every delivery state through the closed vocabulary', async () => {
    const sees = T('review.selection.state.delivered')
    // delivered, and everything the conversation does after it, reads the same
    for (const chain of [
      ['delivered'],
      ['delivered', 'asked'],
      ['delivered', 'asked', 'answered'],
      ['delivered', 'asked', 'turn-stopped'],
      ['delivered', 'asked', 'turn-declined'],
      ['delivered', 'asked', 'turn-failed']
    ] as DeliveryState[][]) {
      selection().reset()
      await sendOnce()
      for (const state of chain) await pushEvent(ev(state))
      expect(chipText(), chain.join('>')).toContain(sees)
    }
    for (const [state, key] of [
      ['cleared', 'review.selection.state.cleared'],
      ['ended', 'review.selection.state.ended']
    ] as Array<[DeliveryState, string]>) {
      selection().reset()
      await sendOnce()
      await pushEvent(ev('delivered'))
      await pushEvent(ev(state))
      expect(chipText(), state).toContain(T(key))
    }
  })

  it('a cleared conversation offers a re-send, which sends the live selection again', async () => {
    await sendOnce()
    await pushEvent(ev('delivered'))
    await pushEvent(ev('cleared'))
    expect(find('step-try-again').exists()).toBe(true)
    await find('step-try-again').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('shows one fixed sentence when main reports a code this build lacks', async () => {
    send.mockResolvedValueOnce({ ok: false, refusal: 'FROM_THE_FUTURE', next: [], message: LEAK })
    await sendOnce()
    expect(chipText()).toContain(T('review.selection.outcome.unknown'))
    expect(wrapper.text()).not.toContain('FROM_THE_FUTURE')
    expect(wrapper.text()).not.toContain('LEAK-ME')
  })

  it('shows the same fixed sentence when the call itself rejects', async () => {
    send.mockRejectedValueOnce(new Error('ipc exploded: /home/user/secret'))
    await sendOnce()
    expect(chipText()).toContain(T('review.selection.outcome.unknown'))
    expect(wrapper.text()).not.toContain('secret')
  })

  it('offers the next steps main named — and none it did not', async () => {
    const cases: Array<[string, string[], string[]]> = [
      // [refusal, buttons expected, guidance expected]
      ['QUEUE_FULL', ['step-try-again'], []],
      ['FEATURE_OFF', ['step-open-mods'], []],
      ['head-moved', ['step-reselect'], []],
      ['head-unreadable', [], ['guide-refresh']],
      ['BAD_ARGS', [], ['guide-narrow']],
      ['STICKY_LEGACY', [], ['guide-reopen']],
      ['HEADLESS', [], []]
    ]
    const all = [
      'step-try-again',
      'step-open-mods',
      'step-reselect',
      'guide-refresh',
      'guide-narrow',
      'guide-reopen'
    ]
    for (const [code, buttons, guides] of cases) {
      selection().reset()
      send.mockResolvedValueOnce({ ok: false, refusal: code, next: REFUSAL_NEXT[code as never] })
      await sendOnce()
      for (const name of all) {
        expect(find(name).exists(), `${code} → ${name}`).toBe(
          buttons.includes(name) || guides.includes(name)
        )
      }
    }
  })

  it('NO_BINDING: Open Mods settings only when the mod is off; a fresh companion otherwise', async () => {
    const cases: Array<[string, boolean, boolean]> = [
      // [reason, shows Open Mods settings, shows the fresh-companion guidance]
      ['off', true, false],
      ['not-claude', false, true],
      ['unknown', false, true],
      ['pre-disclosure', false, true],
      ['cli-too-old', false, false],
      ['cli-unknown', false, false]
    ]
    for (const [reason, mods, fresh] of cases) {
      selection().reset()
      // main answers with its single list for NO_BINDING every time, Mods settings included.
      send.mockResolvedValueOnce({
        ok: false,
        refusal: 'NO_BINDING',
        reason,
        next: REFUSAL_NEXT.NO_BINDING
      })
      await sendOnce()
      expect(find('step-open-mods').exists(), `${reason}: mods`).toBe(mods)
      expect(find('guide-reopen').exists(), `${reason}: fresh companion`).toBe(fresh)
      if (fresh) {
        expect(find('guide-reopen').text()).toBe(
          T('review.selection.guide.freshCompanion').replace('{action}', T('review.companion'))
        )
      }
      expect(find('selection-copy').exists()).toBe(true)
    }
  })

  it('Try again sends the selection again at once; Open Mods settings opens that tab', async () => {
    send.mockResolvedValueOnce({ ok: false, refusal: 'QUEUE_FULL', next: REFUSAL_NEXT.QUEUE_FULL })
    await sendOnce()
    await find('step-try-again').trigger('click')
    await flushPromises() // no pause: it is the operator's explicit retry
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[1][0] as { selection: { id: string } }).selection.id).toBe(
      selection().live!.id
    )

    selection().reset()
    send.mockResolvedValueOnce({
      ok: false,
      refusal: 'FEATURE_OFF',
      next: REFUSAL_NEXT.FEATURE_OFF
    })
    await sendOnce()
    await find('step-open-mods').trigger('click')
    expect(useUiStore().settingsTab).toBe('mods')
  })
})

describe('U2b-AC-4 — the chip says what the companion sees, and only that', () => {
  async function delivered(): Promise<void> {
    await choose(mixedRange)
    await settle()
    await pushEvent(ev('delivered'))
  }

  it('says nothing about a question or an answer, however the conversation goes', async () => {
    await delivered()
    const words = /ask|answer|declin|stopp|reviewed|done|ok\b/i
    expect(chipText()).not.toMatch(words)
    await pushEvent(ev('asked'))
    expect(chipText()).not.toMatch(words)
    await pushEvent(ev('answered'))
    expect(chipText()).not.toMatch(words)
    expect(chipText()).toContain(T('review.selection.state.delivered'))
  })

  it('claims delivery only once the mod confirmed it', async () => {
    await choose(mixedRange)
    expect(chipText()).not.toContain(T('review.selection.state.delivered'))
    await settle()
    expect(chipText()).not.toContain(T('review.selection.state.delivered')) // queued, not confirmed
    await pushEvent(ev('delivered'))
    expect(chipText()).toContain(T('review.selection.state.delivered'))
  })

  it('never claims delivery for expired, lost or dropped', async () => {
    for (const code of Object.keys(OUTCOME_NEXT)) {
      selection().reset()
      await choose(mixedRange)
      await settle()
      await pushEvent(ev('not-delivered', { code: code as never, next: [] }))
      expect(chipText(), code).not.toContain(T('review.selection.state.delivered'))
    }
  })

  it('ignores a state event for a selection that is no longer the record', async () => {
    await choose(mixedRange)
    await settle()
    await pushEvent({ ...ev('delivered'), selectionId: 'sel_someone_else' })
    expect(chipText()).toContain(T('review.selection.state.queued'))
  })

  it('shows the chip only with a selection, and the takeover closing drops everything', async () => {
    await delivered()
    selection().clear('user')
    await nextTick()
    expect(find('review-selection-bar').exists()).toBe(false)
    await choose(mixedRange)
    selection().reset()
    await nextTick()
    expect(selection().last).toBeNull()
    expect(find('review-selection-bar').exists()).toBe(false)
    // a late event after the reset has nothing to land on
    await pushEvent({ selectionId: 'sel_late', state: 'delivered', at: 3 })
    expect(selection().last).toBeNull()
    // …and nothing is sent after a reset, even if the pause was running
    await choose(mixedRange)
    selection().reset()
    send.mockClear()
    await settle(SEND_DEBOUNCE_MS * 2)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('mixed-side ranges — one range format, and honesty about the lines', () => {
  it('writes a range the same way in the bar everywhere it appears', async () => {
    for (const [pick, expected] of [
      [mixedRange, 'old L11 – new L12'],
      [sameSideRange, 'L11–12'],
      [() => selection().selectFile(SPEECH), 'whole file']
    ] as Array<[() => void, string]>) {
      selection().reset()
      await choose(pick)
      expect(find('selection-range').text()).toBe(expected)
    }
  })

  it('says plainly that a mixed-side range quotes no lines — live and once the companion has it', async () => {
    const note = T('review.selection.mixedNote')
    await choose(sameSideRange)
    expect(find('selection-mixed').exists()).toBe(false)
    await settle()
    await pushEvent(ev('delivered'))
    expect(find('delivery-mixed').exists()).toBe(false)

    selection().reset()
    await choose(mixedRange)
    expect(find('selection-mixed').text()).toBe(note)
    expect(find('delivery-mixed').exists()).toBe(false) // nothing has been sent yet
    await settle()
    expect(find('delivery-mixed').exists()).toBe(false) // queued, not confirmed
    await pushEvent(ev('delivered'))
    expect(find('delivery-mixed').text()).toBe(note)
    await pushEvent(ev('asked'))
    await pushEvent(ev('answered'))
    expect(find('delivery-mixed').text()).toBe(note)

    // …and it never claims lines for a send that failed
    selection().reset()
    send.mockResolvedValueOnce({ ok: false, refusal: 'QUEUE_FULL', next: REFUSAL_NEXT.QUEUE_FULL })
    await choose(mixedRange)
    await settle()
    expect(find('delivery-mixed').exists()).toBe(false)
  })
})

describe('U2b-AC-10 — the narrow layout keeps every action and the chip in the column', () => {
  it('takes a full row by basis only in the row layout; in the column layout 100% would be a height', async () => {
    await choose(mixedRange)
    await settle()
    await pushEvent(ev('delivered'))
    const classes = (name: string): string[] => find(name).classes()
    expect(classes('delivery-chip')).toContain('basis-full')
    expect(classes('selection-hint')).toContain('basis-full')

    // Column layout: the bar is `flex-col flex-wrap`, where `basis-full` is 100% of the HEIGHT and
    // pushed the chip into a second, clipped column (seen live at a ~400px pane).
    await wrapper.setProps({ narrow: true })
    expect(find('review-selection-bar').classes()).toContain('flex-col')
    expect(classes('delivery-chip')).not.toContain('basis-full')
    expect(classes('selection-hint')).not.toContain('basis-full')
    for (const name of ['selection-copy', 'selection-clear']) {
      expect(find(name).exists(), name).toBe(true)
      expect(find(name).classes().join(' '), name).not.toMatch(/\bhidden\b|sr-only/)
    }
  })
})

describe('U2b-AC-5 — no count, ratio or percentage', () => {
  const FROM_QUEUED = (state: DeliveryState): ((r: DeliveryRecord) => DeliveryRecord) => {
    return (r) => {
      let rec = applyStateEvent(r, { selectionId: r.selectionId, state: 'delivered', at: 1 })
      if (state === 'delivered') return rec
      if (state !== 'cleared' && state !== 'ended') {
        rec = applyStateEvent(rec, { selectionId: r.selectionId, state: 'asked', at: 1 })
      }
      return state === 'asked'
        ? rec
        : applyStateEvent(rec, { selectionId: r.selectionId, state, at: 1 })
    }
  }
  const STATES: Array<[string, (rec: DeliveryRecord) => DeliveryRecord]> = [
    ['no delivery', () => null as never],
    ['queued', (r) => r],
    ...(
      [
        'delivered',
        'asked',
        'answered',
        'turn-stopped',
        'turn-declined',
        'turn-failed',
        'cleared',
        'ended'
      ] as DeliveryState[]
    ).map((s): [string, (rec: DeliveryRecord) => DeliveryRecord] => [s, FROM_QUEUED(s)]),
    ...Object.keys(OUTCOME_NEXT).map((code): [string, (rec: DeliveryRecord) => DeliveryRecord] => [
      `outcome ${code}`,
      (r) =>
        applyStateEvent(r, {
          selectionId: r.selectionId,
          state: 'not-delivered',
          at: 1,
          code: code as never
        })
    ]),
    ...Object.keys(REFUSAL_NEXT).map((code): [string, (rec: DeliveryRecord) => DeliveryRecord] => [
      `refusal ${code}`,
      (r) => refuse(r, { refusal: code, next: REFUSAL_NEXT[code as never], reason: 'cli-too-old' })
    ])
  ]

  it('holds across {no selection, line, range, mixed range, file} × {every delivery state, outcome and refusal}', async () => {
    const shapes: Array<[string, () => void]> = [
      ['no selection', () => selection().clear('user')],
      ['line', () => selection().select(SPEECH, 0, 2)],
      ['range', sameSideRange],
      ['mixed range', mixedRange],
      ['file', () => selection().selectFile(SPEECH)]
    ]
    let rendered = 0
    for (const [shapeName, shape] of shapes) {
      for (const [stateName, make] of STATES) {
        selection().reset()
        await choose(shape)
        const live = selection().live
        const record = live && stateName !== 'no delivery' ? make(startDelivery(live)) : null
        // the watcher has run (it set "Updating…"); now put the state under test in its place
        if (live) selection().last = record
        await nextTick()
        const text = find('review-selection-bar').exists()
          ? find('review-selection-bar').text()
          : ''
        const own = new Set<number>()
        if (live?.subjectType === 'LINE') {
          own.add(live.line!)
          own.add(live.startLine ?? live.line!)
        }
        expect(text, `${shapeName} × ${stateName}`).not.toMatch(/\d\s*\/\s*\d/)
        expect(text, `${shapeName} × ${stateName}`).not.toContain('%')
        for (const m of text.match(/\b\d+\b/g) ?? []) {
          expect(own.has(Number(m)), `${shapeName} × ${stateName}: "${m}" in "${text}"`).toBe(true)
        }
        if (text) rendered += 1
      }
    }
    // every shape but "no selection" renders the bar, for every state
    expect(rendered).toBe((shapes.length - 1) * STATES.length)
  })

  it('uses the neutral tone for every state: no success or failure colour on the chip', async () => {
    await choose(mixedRange)
    await settle()
    for (const state of ['delivered', 'asked', 'answered'] as const) {
      await pushEvent(ev(state))
      const cls = find('delivery-chip').classes().join(' ')
      expect(cls).toContain('text-text-2')
      expect(cls).not.toMatch(/green|red|warning|accent/)
      expect(find('delivery-chip').find('svg').exists()).toBe(false)
    }
  })
})
