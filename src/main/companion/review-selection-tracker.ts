/**
 * The delivery state of the review selection, and the band that goes with it (T257 §8, §9).
 * Electron-free: the host bus, the clock and the senders are injected, so the tests drive both
 * with a fake host.
 *
 * **The tracker** turns what the mod reports into the chip's closed vocabulary and nothing else:
 * `queued` when `enqueue` accepted, `delivered` on a `command.result` with `ok: true`, `asked` on
 * the first operator-typed turn after that, `answered` when that very turn completes with reason
 * `answer`. *Answered* means a turn completed, never that it was relevant: the tracker reads no
 * word the model wrote and infers nothing. With `sense.turn` off no turn event arrives and the
 * state stops at `delivered`.
 *
 * **The band driver** keeps the one-line band above the companion's prompt in step with it: set
 * when a selection is delivered, re-sent every `BAND_REFRESH_MS` so the mod's `BAND_TTL_MS` never
 * lapses a live line, cleared when the selection stops being the live one, and debounced.
 */

import { enqueue as channelEnqueue, type EnqueueResult } from './command-channel'
import type { CommandOutcome } from './command-types'
import { BAND_DEBOUNCE_MS, BAND_REFRESH_MS } from './contract'
import type { CompanionHostFacade } from './host-core'
import {
  OUTCOME_NEXT,
  REVIEW_BAND_SUBSYSTEM,
  bandFor,
  outcomeVerdict,
  type BandSelection,
  type DeliveryState,
  type SelectionStateEvent
} from './review-selection-core'

export type TrackerHost = Pick<CompanionHostFacade, 'bus'>

/** What the handler hands the tracker once `enqueue` accepted the row. */
export interface TrackedSelection {
  selectionId: string
  /** `BindingView.key`: it survives a re-key, a sid never does. */
  bindingKey: number
  sid: string
  cmd: string
  settled: Promise<CommandOutcome>
  selection: BandSelection
}

export interface TrackedRecord {
  selectionId: string
  bindingKey: number
  /** The binding's current sid; follows `session.rebound`. */
  sid: string
  cmd: string
  selection: BandSelection
  state: DeliveryState
  turnId?: string
}

export type Transition =
  | { type: 'state'; ev: SelectionStateEvent; rec: TrackedRecord }
  | { type: 'replaced'; rec: TrackedRecord }

export interface TrackerDeps {
  host: TrackerHost
  /** Sends `review:selection:state` to the renderer. */
  emit(ev: SelectionStateEvent): void
  now?(): number
}

export interface SelectionTracker {
  track(t: TrackedSelection): void
  onTransition(fn: (t: Transition) => void): () => void
  /** The live record of a binding, for tests and diagnostics. */
  current(bindingKey: number): TrackedRecord | null
  dispose(): void
}

const TERMINAL: ReadonlySet<DeliveryState> = new Set([
  'answered',
  'turn-stopped',
  'turn-declined',
  'turn-failed',
  'cleared',
  'ended',
  'not-delivered'
])

export function createSelectionTracker(deps: TrackerDeps): SelectionTracker {
  const now = deps.now ?? ((): number => Date.now())
  const recs = new Map<number, TrackedRecord>()
  const listeners = new Set<(t: Transition) => void>()

  function notify(t: Transition): void {
    for (const fn of [...listeners]) {
      try {
        fn(t)
      } catch {
        // one listener's failure never stops the others or the chip
      }
    }
  }

  function move(
    rec: TrackedRecord,
    state: DeliveryState,
    extra: Partial<SelectionStateEvent> = {}
  ): void {
    rec.state = state
    const ev: SelectionStateEvent = { selectionId: rec.selectionId, state, at: now(), ...extra }
    try {
      deps.emit(ev)
    } catch {
      // the renderer being gone is not the tracker's problem
    }
    notify({ type: 'state', ev, rec })
    if (TERMINAL.has(state) && recs.get(rec.bindingKey) === rec) recs.delete(rec.bindingKey)
  }

  function delivered(rec: TrackedRecord): void {
    if (rec.state === 'queued') move(rec, 'delivered')
  }

  /** True while `rec` is the binding's live selection and has not moved past `queued`. */
  const awaiting = (rec: TrackedRecord): boolean =>
    recs.get(rec.bindingKey) === rec && rec.state === 'queued'

  function onSettled(rec: TrackedRecord, outcome: CommandOutcome): void {
    // A newer selection took the slot (its result must not move the chip or the band), or the row
    // already reached `delivered` through its own `command.result`.
    if (!awaiting(rec)) return
    const v = outcomeVerdict(outcome)
    if (v.delivered) return delivered(rec)
    move(rec, 'not-delivered', { code: v.code, next: OUTCOME_NEXT[v.code] })
  }

  const offs = [
    deps.host.bus.on('event', (b, ev) => {
      const rec = recs.get(b.key)
      if (!rec) return
      rec.sid = b.sid
      const d = ev.d as unknown as Record<string, unknown>
      switch (ev.t) {
        case 'command.result':
          // Synchronous, in event order: a turn in the same batch must see `delivered` first.
          if (d.cmd === rec.cmd && d.ok === true) delivered(rec)
          return
        case 'session.rebound':
          if (typeof d.sid === 'string') rec.sid = d.sid
          // `clear`, `resume` and `unknown` alike: the conversation the row lived in is gone.
          if (rec.state === 'delivered' || rec.state === 'asked') move(rec, 'cleared')
          return
        case 'turn.started':
          if (!b.enabled.includes('sense.turn')) return
          // The first operator-typed turn after delivery. A peer's, a plugin's or an unknown
          // origin is not the operator asking, and a turn that started earlier is not counted.
          if (rec.state === 'delivered' && d.origin === 'human' && typeof ev.turnId === 'string') {
            rec.turnId = ev.turnId
            move(rec, 'asked')
          }
          return
        case 'turn.completed':
          if (!b.enabled.includes('sense.turn')) return
          if (rec.state !== 'asked' || rec.turnId === undefined || ev.turnId !== rec.turnId) return
          move(
            rec,
            d.reason === 'answer'
              ? 'answered'
              : d.reason === 'aborted'
                ? 'turn-stopped'
                : d.reason === 'refusal'
                  ? 'turn-declined'
                  : 'turn-failed'
          )
          return
        default:
          return
      }
    }),
    deps.host.bus.on('end', (b) => {
      const rec = recs.get(b.key)
      // A row still queued ends as `dropped-session-end` through its own outcome, not here.
      if (rec && (rec.state === 'delivered' || rec.state === 'asked')) move(rec, 'ended')
    })
  ]

  return {
    track(t) {
      const old = recs.get(t.bindingKey)
      if (old) notify({ type: 'replaced', rec: old })
      const rec: TrackedRecord = {
        selectionId: t.selectionId,
        bindingKey: t.bindingKey,
        sid: t.sid,
        cmd: t.cmd,
        selection: t.selection,
        state: 'queued'
      }
      recs.set(t.bindingKey, rec)
      move(rec, 'queued')
      void t.settled.then(
        (o) => onSettled(rec, o),
        // A `settled` that rejects is a failure with a defined state, never a chip stuck on queued.
        () => {
          if (awaiting(rec))
            move(rec, 'not-delivered', { code: 'CMD_FAILED', next: OUTCOME_NEXT.CMD_FAILED })
        }
      )
    },
    onTransition(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    current: (key) => recs.get(key) ?? null,
    dispose() {
      for (const off of offs) off()
      listeners.clear()
      recs.clear()
    }
  }
}

// ---- the band driver -----------------------------------------------------------------------------

export type BandSender = (req: {
  sid: string
  args: { line: string; parts: { lead: string; detail?: string; hint?: string } } | { line: null }
}) => EnqueueResult | { ok: boolean }

export interface BandDriverDeps {
  /** Enqueues a `ui.band.set` for a sid. The default is the app's one channel. */
  send?: BandSender
  debounceMs?: number
  refreshMs?: number
  log?(message: string): void
}

interface BandState {
  sid: string
  /** The line the companion should be showing: `null` for none. */
  desired: ReturnType<typeof bandFor>
  /** The line last sent, as the string the mod holds. */
  sent: string | null
  debounce: ReturnType<typeof setTimeout> | null
  refresh: ReturnType<typeof setInterval> | null
}

const defaultSend: BandSender = ({ sid, args }) =>
  channelEnqueue({
    sessionKey: null,
    sid,
    name: 'ui.band.set',
    args,
    cause: { kind: 'internal', subsystem: REVIEW_BAND_SUBSYSTEM }
  })

export interface BandDriver {
  attach(tracker: SelectionTracker): () => void
  dispose(): void
}

export function createBandDriver(deps: BandDriverDeps = {}): BandDriver {
  const send = deps.send ?? defaultSend
  const debounceMs = deps.debounceMs ?? BAND_DEBOUNCE_MS
  const refreshMs = deps.refreshMs ?? BAND_REFRESH_MS
  const log = deps.log ?? ((m: string): void => console.warn(`[companion] ${m}`))
  const states = new Map<number, BandState>()

  const stateOf = (key: number, sid: string): BandState => {
    let st = states.get(key)
    if (!st)
      states.set(key, (st = { sid, desired: null, sent: null, debounce: null, refresh: null }))
    st.sid = sid
    return st
  }

  function push(st: BandState): void {
    try {
      const r = send({
        sid: st.sid,
        args: st.desired ? { line: st.desired.line, parts: st.desired.parts } : { line: null }
      })
      if (!r.ok)
        log(`review selection band not sent: ${'reason' in r ? String(r.reason) : 'refused'}`)
    } catch {
      log('review selection band send failed')
    }
  }

  function stopTimers(st: BandState): void {
    if (st.debounce) clearTimeout(st.debounce)
    if (st.refresh) clearInterval(st.refresh)
    st.debounce = null
    st.refresh = null
  }

  /** Records what the companion should show and sends it once the debounce has settled. */
  function want(key: number, sid: string, line: BandState['desired']): void {
    const st = stateOf(key, sid)
    st.desired = line
    if (st.debounce) clearTimeout(st.debounce)
    if ((line?.line ?? null) === st.sent) {
      st.debounce = null
      return
    }
    st.debounce = setTimeout(() => {
      st.debounce = null
      push(st)
      st.sent = st.desired?.line ?? null
      if (st.refresh) clearInterval(st.refresh)
      st.refresh = null
      if (st.desired) {
        // The mod drops a line after `BAND_TTL_MS`; a live selection is re-sent before that.
        st.refresh = setInterval(() => push(st), refreshMs)
        st.refresh.unref?.()
      }
    }, debounceMs)
    st.debounce.unref?.()
  }

  return {
    attach(tracker) {
      return tracker.onTransition((t) => {
        const rec = t.rec
        if (t.type === 'replaced') return want(rec.bindingKey, rec.sid, null)
        switch (t.ev.state) {
          case 'delivered':
          case 'asked':
            return want(
              rec.bindingKey,
              rec.sid,
              bandFor({ state: t.ev.state, selection: rec.selection })
            )
          case 'ended': {
            // The binding is gone: there is nothing to send to, only timers to stop.
            const st = states.get(rec.bindingKey)
            if (st) stopTimers(st)
            states.delete(rec.bindingKey)
            return
          }
          case 'queued':
          case 'not-delivered':
            return
          default:
            // answered, stopped, declined, failed, cleared: the selection is no longer the live one.
            return want(rec.bindingKey, rec.sid, null)
        }
      })
    },
    dispose() {
      for (const st of states.values()) stopTimers(st)
      states.clear()
    }
  }
}
