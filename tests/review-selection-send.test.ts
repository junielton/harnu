// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewSelectionBar from '../src/renderer/src/components/ReviewSelectionBar.vue'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useReviewSelectionStore } from '../src/renderer/src/stores/review-selection'
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
 * T257 U2b — Ask about this, Copy as text and the chip, driven through the real bar and store
 * against a fake IPC. The companion's presence is the one thing stubbed: the helpers store's
 * single getter, so a test can open and close "the companion" without a PTY.
 *
 * U2b-AC-1 (ask), -2 (copy), -3 (every outcome renders, nothing from main leaks),
 * -4 (answered only after asked), -5 (no count anywhere).
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
const ev = (
  state: DeliveryState,
  extra: Partial<SelectionStateEvent> = {}
): SelectionStateEvent => ({
  selectionId: selection().live?.id ?? selection().last!.selectionId,
  state,
  at: 1,
  ...extra
})

async function pushEvent(e: SelectionStateEvent): Promise<void> {
  emit(e)
  await nextTick()
}

async function clickAsk(): Promise<void> {
  await find('selection-ask').trigger('click')
  await flushPromises()
}

beforeEach(() => {
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
  document.body.innerHTML = ''
})

async function selectRange(): Promise<void> {
  selection().select(SPEECH, 0, 1)
  selection().extend(SPEECH, 0, 3)
  await nextTick()
}

describe('U2b-AC-1 — Ask about this', () => {
  it('is disabled, with the stated reason, when no companion is open — and sends nothing', async () => {
    sidBox.ref!.value = null
    await selectRange()
    const ask = find('selection-ask')
    expect((ask.element as HTMLButtonElement).disabled).toBe(true)
    expect(find('selection-ask-reason').text()).toBe(T('review.selection.outcome.no-companion'))
    expect(ask.attributes('aria-describedby')).toBe(find('selection-ask-reason').attributes('id'))
    await ask.trigger('click')
    expect(send).not.toHaveBeenCalled()
    expect(selection().last).toBeNull()
  })

  it('is enabled when a companion is open, and the reason is gone', async () => {
    await selectRange()
    expect((find('selection-ask').element as HTMLButtonElement).disabled).toBe(false)
    expect(find('selection-ask-reason').exists()).toBe(false)
  })

  it('follows the companion opening and closing', async () => {
    sidBox.ref!.value = null
    await selectRange()
    expect((find('selection-ask').element as HTMLButtonElement).disabled).toBe(true)
    sidBox.ref!.value = SID
    await nextTick()
    expect((find('selection-ask').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('sends the folder, refs, the companion id and the coordinates — no text', async () => {
    await selectRange()
    const live = selection().live!
    await clickAsk()
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
    selection().selectFile(SPEECH)
    await nextTick()
    await clickAsk()
    const sel = (send.mock.calls[0][0] as { selection: Record<string, unknown> }).selection
    expect(sel.subjectType).toBe('FILE')
    for (const k of ['line', 'side', 'startLine', 'startSide']) expect(k in sel).toBe(false)
  })

  it('never opens a companion: the stubbed helpers store has nothing to open one with', async () => {
    sidBox.ref!.value = null
    await selectRange()
    await selection().send()
    expect(selection().last).toMatchObject({ phase: 'refused', code: 'no-companion' })
    expect(send).not.toHaveBeenCalled()
  })

  it('shows "Sending…" at once, then follows the events', async () => {
    let release!: () => void
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, selectionId: 'x', cmd: 'c1', n: 1 })
        })
    )
    await selectRange()
    const pending = selection().send()
    await nextTick()
    expect(chipText()).toContain(T('review.selection.state.queued'))
    expect((find('selection-ask').element as HTMLButtonElement).disabled).toBe(true)
    release()
    await pending
    await pushEvent(ev('delivered'))
    expect(chipText()).toContain(T('review.selection.state.delivered'))
  })

  it('does not move back to "Sending…" when the result lands after the delivered event', async () => {
    send.mockImplementationOnce(async () => {
      emit(ev('queued'))
      emit(ev('delivered'))
      return { ok: true, selectionId: 'x', cmd: 'c1', n: 1 }
    })
    await selectRange()
    await clickAsk()
    expect(selection().last!.phase).toBe('delivered')
  })
})

describe('U2b-AC-2 — Copy as text', () => {
  it('copies exactly what review:selection:compose returns', async () => {
    await selectRange()
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
    await selectRange()
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('stays available in every §7 failure state except a moved head or base', async () => {
    await selectRange()
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
    await selectRange()
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
    expect(chipText()).toContain(T('review.selection.outcome.head-moved'))
    expect((find('selection-copy').element as HTMLButtonElement).disabled).toBe(true)
    expect(find('step-reselect').exists()).toBe(true)
  })

  it('says so when the clipboard refuses, without a stack or an error message', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError: secret internals'))
    await selectRange()
    await find('selection-copy').trigger('click')
    await flushPromises()
    expect(find('copy-failed').text()).toBe(T('review.selection.copyFailed'))
    expect(wrapper.text()).not.toContain('secret internals')
  })
})

describe('U2b-AC-3 — every refusal and outcome renders, and nothing from main leaks', () => {
  const LEAK = 'LEAK-ME <b>from the mod</b> {{x}}'

  it('renders the closed sentence of every refusal returned by the send', async () => {
    await selectRange()
    for (const code of Object.keys(REFUSAL_NEXT)) {
      send.mockResolvedValueOnce({
        ok: false,
        refusal: code,
        next: REFUSAL_NEXT[code as never],
        ...(code === 'NO_BINDING' ? { reason: 'cli-too-old' } : {}),
        detail: LEAK,
        message: LEAK
      })
      // `no-companion` is the pre-send refusal of a missing companion; main also reports it.
      await clickAsk()
      expect(chipText(), code).toContain(T(`review.selection.outcome.${code}`))
      expect(wrapper.text(), code).not.toContain('LEAK-ME')
      expect(wrapper.html(), code).not.toContain('<b>from the mod')
    }
  })

  it('renders every NO_BINDING reason as its own sentence under the refusal', async () => {
    await selectRange()
    for (const reason of NO_BINDING_REASONS) {
      send.mockResolvedValueOnce({
        ok: false,
        refusal: 'NO_BINDING',
        reason,
        next: REFUSAL_NEXT.NO_BINDING
      })
      await clickAsk()
      expect(find('delivery-reason').text(), reason).toBe(T(`review.selection.noBinding.${reason}`))
    }
  })

  it('renders every outcome main reports after queueing, including every dropped reason', async () => {
    await selectRange()
    for (const code of Object.keys(OUTCOME_NEXT)) {
      await clickAsk()
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

  it('renders every delivery state', async () => {
    await selectRange()
    const expected: Array<[DeliveryState, string]> = [
      ['queued', 'review.selection.state.queued'],
      ['delivered', 'review.selection.state.delivered'],
      ['asked', 'review.selection.state.asked'],
      ['answered', 'review.selection.state.answered']
    ]
    await clickAsk()
    for (const [state, key] of expected) {
      if (state !== 'queued') await pushEvent(ev(state))
      expect(chipText(), state).toContain(T(key))
    }
    const finals: Array<[DeliveryState, string]> = [
      ['turn-stopped', 'review.selection.state.stopped.aborted'],
      ['turn-declined', 'review.selection.state.stopped.refusal'],
      ['turn-failed', 'review.selection.state.stopped.error'],
      ['cleared', 'review.selection.state.cleared'],
      ['ended', 'review.selection.state.ended']
    ]
    for (const [state, key] of finals) {
      await clickAsk()
      await pushEvent(ev('delivered'))
      if (state.startsWith('turn-')) await pushEvent(ev('asked'))
      await pushEvent(ev(state))
      expect(chipText(), state).toContain(T(key))
    }
  })

  it('shows one fixed sentence when main reports a code this build lacks', async () => {
    send.mockResolvedValueOnce({ ok: false, refusal: 'FROM_THE_FUTURE', next: [], message: LEAK })
    await selectRange()
    await clickAsk()
    expect(chipText()).toContain(T('review.selection.outcome.unknown'))
    expect(wrapper.text()).not.toContain('FROM_THE_FUTURE')
    expect(wrapper.text()).not.toContain('LEAK-ME')
  })

  it('shows the same fixed sentence when the call itself rejects', async () => {
    send.mockRejectedValueOnce(new Error('ipc exploded: /home/user/secret'))
    await selectRange()
    await clickAsk()
    expect(chipText()).toContain(T('review.selection.outcome.unknown'))
    expect(wrapper.text()).not.toContain('secret')
  })

  it('offers the next steps main named — and none it did not', async () => {
    await selectRange()
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
      send.mockResolvedValueOnce({ ok: false, refusal: code, next: REFUSAL_NEXT[code as never] })
      await clickAsk()
      for (const name of all) {
        expect(find(name).exists(), `${code} → ${name}`).toBe(
          buttons.includes(name) || guides.includes(name)
        )
      }
    }
  })

  it('Try again sends the same selection again; Open Mods settings opens that tab', async () => {
    await selectRange()
    send.mockResolvedValueOnce({ ok: false, refusal: 'QUEUE_FULL', next: REFUSAL_NEXT.QUEUE_FULL })
    await clickAsk()
    await find('step-try-again').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[1][0] as { selection: { id: string } }).selection.id).toBe(
      selection().live!.id
    )

    send.mockResolvedValueOnce({
      ok: false,
      refusal: 'FEATURE_OFF',
      next: REFUSAL_NEXT.FEATURE_OFF
    })
    await clickAsk()
    await find('step-open-mods').trigger('click')
    expect(useUiStore().settingsTab).toBe('mods')
  })

  it('does not offer Try again once the live selection is another one', async () => {
    await selectRange()
    send.mockResolvedValueOnce({ ok: false, refusal: 'QUEUE_FULL', next: REFUSAL_NEXT.QUEUE_FULL })
    await clickAsk()
    selection().select(SPEECH, 1, 1)
    await nextTick()
    expect(find('step-try-again').exists()).toBe(false)
    // The record names its own subject: the file and the range it was sent for.
    expect(find('delivery-subject').text()).toBe('speech.ts · old L11 – new L12')
  })
})

describe('U2b-AC-4 — answered only after asked', () => {
  it('does not show "Answered" for an answer that skipped "asked"', async () => {
    await selectRange()
    await clickAsk()
    await pushEvent(ev('answered'))
    expect(chipText()).not.toContain(T('review.selection.state.answered'))
    await pushEvent(ev('delivered'))
    await pushEvent(ev('answered'))
    expect(chipText()).toContain(T('review.selection.state.delivered'))
    await pushEvent(ev('asked'))
    await pushEvent(ev('answered'))
    expect(chipText()).toContain(T('review.selection.state.answered'))
  })

  it('stops at "Sent" when no turn event ever arrives', async () => {
    await selectRange()
    await clickAsk()
    await pushEvent(ev('delivered'))
    await flushPromises()
    expect(chipText()).toContain(T('review.selection.state.delivered'))
    expect(chipText()).not.toContain(T('review.selection.state.asked'))
  })

  it('never shows the "Sent" state for expired, lost or dropped', async () => {
    await selectRange()
    for (const code of Object.keys(OUTCOME_NEXT)) {
      await clickAsk()
      await pushEvent(ev('not-delivered', { code: code as never, next: [] }))
      expect(chipText(), code).not.toContain(T('review.selection.state.delivered'))
    }
  })

  it('ignores a state event for a selection that is no longer the record', async () => {
    await selectRange()
    await clickAsk()
    await pushEvent({ ...ev('delivered'), selectionId: 'sel_someone_else' })
    expect(chipText()).toContain(T('review.selection.state.queued'))
  })

  it('keeps the chip after the selection is cleared — and the takeover closing drops it', async () => {
    await selectRange()
    await clickAsk()
    await pushEvent(ev('delivered'))
    await pushEvent(ev('asked'))
    selection().clear('user')
    await nextTick()
    expect(find('selection-ask').exists()).toBe(false)
    expect(chipText()).toContain(T('review.selection.state.asked'))
    expect(find('delivery-subject').exists()).toBe(true)
    await pushEvent({ selectionId: selection().last!.selectionId, state: 'answered', at: 2 })
    expect(chipText()).toContain(T('review.selection.state.answered'))

    selection().reset()
    await nextTick()
    expect(selection().last).toBeNull()
    expect(find('review-selection-bar').exists()).toBe(false)
    // …and a late event after the reset has nothing to land on.
    await pushEvent({ selectionId: 'sel_late', state: 'answered', at: 3 })
    expect(selection().last).toBeNull()
  })

  it('Dismiss drops a finished record when nothing is selected', async () => {
    await selectRange()
    await clickAsk()
    await pushEvent(ev('delivered'))
    selection().clear('user')
    await nextTick()
    await find('selection-dismiss').trigger('click')
    expect(selection().last).toBeNull()
    expect(find('review-selection-bar').exists()).toBe(false)
  })
})

describe('U2b-AC-5 — no count, ratio or percentage', () => {
  const STATES: Array<[string, (rec: DeliveryRecord) => DeliveryRecord]> = [
    ['no delivery', () => null as never],
    ['queued', (r) => r],
    [
      'delivered',
      (r) => applyStateEvent(r, { selectionId: r.selectionId, state: 'delivered', at: 1 })
    ],
    ...(
      [
        'asked',
        'answered',
        'turn-stopped',
        'turn-declined',
        'turn-failed',
        'cleared',
        'ended'
      ] as const
    ).map((state): [string, (rec: DeliveryRecord) => DeliveryRecord] => [
      state,
      (r) => {
        let rec = applyStateEvent(r, { selectionId: r.selectionId, state: 'delivered', at: 1 })
        if (state !== 'cleared' && state !== 'ended') {
          rec = applyStateEvent(rec, { selectionId: r.selectionId, state: 'asked', at: 1 })
        }
        return state === 'asked'
          ? rec
          : applyStateEvent(rec, { selectionId: r.selectionId, state, at: 1 })
      }
    ]),
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

  it('holds across {no selection, line, file} × {every delivery state, outcome and refusal}', async () => {
    const shapes: Array<[string, () => void]> = [
      ['no selection', () => selection().clear('user')],
      ['line', () => selection().select(SPEECH, 0, 2)],
      [
        'range',
        () => {
          selection().select(SPEECH, 0, 1)
          selection().extend(SPEECH, 0, 3)
        }
      ],
      ['file', () => selection().selectFile(SPEECH)]
    ]
    let rendered = 0
    for (const [shapeName, shape] of shapes) {
      for (const [stateName, make] of STATES) {
        selection().reset()
        selection().select(SPEECH, 0, 1)
        const base = startDelivery(selection().live!)
        const record = stateName === 'no delivery' ? null : make(base)
        selection().last = record
        shape()
        await nextTick()
        const text = find('review-selection-bar').exists()
          ? find('review-selection-bar').text()
          : ''
        const own = new Set<number>()
        const live = selection().live
        if (live?.subjectType === 'LINE') {
          own.add(live.line!)
          own.add(live.startLine ?? live.line!)
        }
        if (record && record.range.kind !== 'file') {
          const r = record.range
          if (r.kind === 'line') own.add(r.line)
          else {
            own.add(r.start)
            own.add(r.end)
          }
        }
        expect(text, `${shapeName} × ${stateName}`).not.toMatch(/\d\s*\/\s*\d/)
        expect(text, `${shapeName} × ${stateName}`).not.toContain('%')
        for (const m of text.match(/\b\d+\b/g) ?? []) {
          expect(own.has(Number(m)), `${shapeName} × ${stateName}: "${m}" in "${text}"`).toBe(true)
        }
        if (text) rendered += 1
      }
    }
    // The matrix actually rendered the bar for most cells (the empty one is the control).
    expect(rendered).toBeGreaterThan(shapes.length * (STATES.length - 1))
  })

  it('uses the neutral tone for every state: no success or failure colour on the chip', async () => {
    await selectRange()
    await clickAsk()
    for (const state of ['delivered', 'asked', 'answered'] as const) {
      await pushEvent(ev(state))
      const cls = find('delivery-chip').classes().join(' ')
      expect(cls).toContain('text-text-2')
      expect(cls).not.toMatch(/green|red|warning|accent/)
      expect(find('delivery-chip').find('svg').exists()).toBe(false)
    }
  })
})
