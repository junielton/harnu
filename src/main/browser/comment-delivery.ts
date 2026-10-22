/**
 * Sending comments to a session (T564 U6, spec §8.7), pure over injected seams (ADR-0001).
 *
 * `comment:submit` arrives from the docked composer. This module runs the gate, picks the pins, builds the
 * `[harnu-comment]` text and hands it to the user-turn path (`deliverUserTurn`, the one `[harnu-page-event]`
 * uses): the renderer queues it between turns, a parked session is woken headlessly first, and a turn with no
 * session at all is copied to the clipboard instead. It never goes through `message_session`.
 *
 * The audit line carries the batch size, the destination and `source: 'overlay'` — never the comment text.
 */
import type { CommentSubmitResult } from '../../shared/browser-comment'
import { formatComment } from './comment-format'
import { evaluateSubmitGate, resolveDestination, selectPins } from './comment-plan'
import type { PinStore } from './comment-pins'
import { deliverUserTurn, type DeliveryDeps } from './page-delivery'

export interface CommentPaneFacts {
  folder: string
  name: string
  ownerSessionId: string | null
  disconnected: boolean
}

export interface CommentDeliveryDeps {
  now(): number
  pins: PinStore
  /** The pane's facts, or `undefined` for an unknown pane. */
  pane(paneId: string): CommentPaneFacts | undefined
  delivery: DeliveryDeps
  /** Put text on the system clipboard (the "no session at all" fallback). */
  copyToClipboard(text: string): void
  /** One audit line: never the comment text. */
  audit(entry: { paneId: string; folder: string; verdict: 'allow' | 'deny'; result: string }): void
}

export interface SubmitInput {
  paneId: string
  /** Pin ids to send, or every saved draft. */
  which: string[] | 'drafts'
  /** The composer's picker choice, or `null` for "the pane's owner, else the folder's selected session". */
  sessionId: string | null
}

export interface CommentDelivery {
  submit(input: SubmitInput): Promise<CommentSubmitResult>
}

export function createCommentDelivery(deps: CommentDeliveryDeps): CommentDelivery {
  /** Pin ids a submit is delivering right now: a second, overlapping submit cannot send them twice. */
  const inFlight = new Set<string>()

  return {
    async submit(input) {
      const pane = deps.pane(input.paneId)
      if (!pane) return { ok: false, error: 'PANE_NOT_FOUND' }
      const gate = evaluateSubmitGate({ disconnected: pane.disconnected })
      if (!gate.ok) {
        deps.audit({
          paneId: input.paneId,
          folder: pane.folder,
          verdict: 'deny',
          result: `COMMENT_REFUSED: ${gate.error}`
        })
        return { ok: false, error: gate.error }
      }
      const pins = selectPins(deps.pins.list(input.paneId), input.which).filter(
        (p) => !inFlight.has(p.id)
      )
      if (pins.length === 0) return { ok: false, error: 'NOTHING_TO_SEND' }
      for (const p of pins) inFlight.add(p.id)
      try {
        const text = formatComment({
          paneName: pane.name,
          url: pins[0]!.url,
          comments: pins.map((p) => ({
            n: p.n,
            comment: p.comment,
            selector: p.selector,
            component: p.component,
            cropPath: p.cropPath,
            html: p.html,
            styles: p.styles,
            url: p.url
          }))
        })
        const destination = resolveDestination(input.sessionId, pane.ownerSessionId)
        const outcome = await deliverUserTurn(deps.delivery, {
          sessionId: destination,
          folder: pane.folder,
          text,
          source: 'overlay'
        })
        const ids = pins.map((p) => p.id)
        if (outcome.status === 'delivered') {
          deps.pins.markSent(input.paneId, ids)
          deps.audit({
            paneId: input.paneId,
            folder: pane.folder,
            verdict: 'allow',
            result: `COMMENT_DELIVERED${outcome.woke ? '_AFTER_WAKE' : ''}: batch=${pins.length} destination=${outcome.sessionId} source=overlay`
          })
          return {
            ok: true,
            delivered: true,
            count: pins.length,
            sessionId: outcome.sessionId,
            woke: outcome.woke
          }
        }
        if (outcome.status === 'held') {
          // Nowhere to send it: the text is the operator's own words plus the page data, so it goes to the
          // clipboard rather than being lost. The pins leave the composer as sent.
          let copied = true
          try {
            deps.copyToClipboard(text)
          } catch {
            copied = false
          }
          if (copied) deps.pins.markSent(input.paneId, ids)
          deps.audit({
            paneId: input.paneId,
            folder: pane.folder,
            verdict: 'allow',
            result: `COMMENT_HELD_${copied ? 'CLIPBOARD' : 'LOST'}: batch=${pins.length} destination=none source=overlay`
          })
          return { ok: true, delivered: false, held: true, count: pins.length, copied }
        }
        deps.audit({
          paneId: input.paneId,
          folder: pane.folder,
          verdict: 'deny',
          result: `COMMENT_FAILED: batch=${pins.length} destination=${destination ?? 'selected'} source=overlay`
        })
        return { ok: false, error: 'DELIVERY_FAILED', detail: outcome.reason }
      } finally {
        for (const p of pins) inFlight.delete(p.id)
      }
    }
  }
}
