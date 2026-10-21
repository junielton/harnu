/**
 * T257 U2d — the host → mod handoff of the band, end to end: what the real band driver sends is
 * parsed, ordered and fitted by the mod's own pure functions, and a line comes out the other end.
 * Each half is tested alone elsewhere; this is the seam, where a line can be sent and still never
 * drawn (a stale high-water `n`, a part the mod refuses, a width that fits nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBand,
  bandLive,
  fitBand,
  parseBandSet,
  type BandState
} from '../../resources/companion/hooks/lib/command-core'
import {
  createBandDriver,
  createSelectionTracker
} from '../../src/main/companion/review-selection-tracker'
import type { BindingView } from '../../src/main/companion/session-table'

type L = (...a: unknown[]) => void
function fakeHost() {
  const handlers = new Map<string, Set<L>>()
  return {
    bus: {
      on(t: string, fn: L) {
        if (!handlers.has(t)) handlers.set(t, new Set())
        handlers.get(t)!.add(fn)
        return () => void handlers.get(t)!.delete(fn)
      }
    } as never,
    fire(t: string, ...a: unknown[]) {
      for (const fn of [...(handlers.get(t) ?? [])]) fn(...a)
    }
  }
}

const B = {
  key: 7,
  sid: 'sid-1',
  enabled: ['sense.turn', 'ui.band', 'act.context']
} as unknown as BindingView
const SEL = {
  subjectType: 'LINE',
  path: 'src/main/speech.ts',
  line: 92,
  side: 'RIGHT',
  startLine: 85,
  startSide: 'RIGHT'
} as const

describe('the band driver’s output, through the mod’s own functions', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** The mod's half, as `runBandSet` and the `ui.render` hook run it, minus the engine. */
  function modRig() {
    let stored: BandState | null = null
    let known = 0
    let n = 0 // the host's per-binding counter: it restarts at 1 on a new boot
    const refused: number[] = []
    const apply = (args: unknown): void => {
      const req = parseBandSet(args)
      expect(req, 'the mod must accept what the driver sends').not.toBeNull()
      const c = ++n
      const d = applyBand(req!, c, Date.now(), stored, known)
      if (!d.apply) return void refused.push(c)
      known = c
      stored = d.next
    }
    const newBoot = (): void => {
      n = 0
      known = 0
      stored = null
    }
    const row = (columns: number): string | null =>
      bandLive(stored, Date.now()) ? fitBand(stored!, columns) : null
    return { apply, newBoot, row, refused }
  }

  function hostRig(apply: (args: unknown) => void) {
    const host = fakeHost()
    const tracker = createSelectionTracker({ host, emit: () => undefined, now: () => 1 })
    createBandDriver({
      send: ({ args }) => {
        apply(args)
        return { ok: true }
      },
      log: () => undefined
    }).attach(tracker)
    let cmd = 0
    const track = (selectionId: string, selection: unknown = SEL) => {
      const id = `cmd_${++cmd}`
      tracker.track({
        selectionId,
        bindingKey: 7,
        sid: 'sid-1',
        cmd: id,
        settled: new Promise(() => undefined),
        selection: selection as never
      })
      return () => host.fire('event', B, { t: 'command.result', d: { cmd: id, ok: true } })
    }
    return { host, track }
  }

  it('a delivered selection is drawn at every width, follows each change and goes when the row says nothing', () => {
    const mod = modRig()
    const host = hostRig(mod.apply)

    host.track('sel_a')()
    vi.advanceTimersByTime(500)
    expect(mod.row(80)).toBe('◆ Harnu ⧉ speech.ts L85–92')
    expect(mod.row(110)).toBe('◆ Harnu ⧉ speech.ts L85–92 · src/main')
    expect(mod.row(144)).toBe('◆ Harnu ⧉ speech.ts L85–92 · src/main · ask your question below')
    expect(mod.row(39)).toBeNull()

    // a turn that answered does not take it away
    host.host.fire('event', B, { t: 'turn.started', turnId: 't1', d: { origin: 'human' } })
    host.host.fire('event', B, {
      t: 'turn.completed',
      turnId: 't1',
      d: { reason: 'answer' }
    })
    vi.advanceTimersByTime(1_000)
    expect(mod.row(80)).toBe('◆ Harnu ⧉ speech.ts L85–92')

    // a changed selection, re-sent inside the debounce and delivered late, is drawn when it lands
    const deliverB = host.track('sel_b', {
      ...SEL,
      path: 'src/other/voice.ts',
      startLine: 3,
      line: 4
    })
    vi.advanceTimersByTime(2_000)
    expect(mod.row(80)).toBe('◆ Harnu ⧉ speech.ts L85–92') // still what the companion holds
    deliverB()
    vi.advanceTimersByTime(500)
    expect(mod.row(80)).toBe('◆ Harnu ⧉ voice.ts L3–4')

    // the row that says nothing is selected removes it
    host.track('sel_c', null)()
    vi.advanceTimersByTime(500)
    expect(mod.row(80)).toBeNull()
    expect(mod.refused).toEqual([])
  })

  it('after the host restarts its numbering, the mod draws the first line of the new boot', () => {
    const mod = modRig()
    const host = hostRig(mod.apply)
    for (let i = 0; i < 5; i++) {
      host.track(`sel_${i}`, { ...SEL, line: 90 + i })()
      vi.advanceTimersByTime(500)
    }
    expect(mod.row(80)).toBe('◆ Harnu ⧉ speech.ts L85–94')
    mod.newBoot() // the mod resets on a hello under a new bootId; the host's counter restarts
    host.track('sel_after', { ...SEL, line: 99 })()
    vi.advanceTimersByTime(500)
    expect(mod.row(80)).toBe('◆ Harnu ⧉ speech.ts L85–99')
    expect(mod.refused).toEqual([])
  })
})
