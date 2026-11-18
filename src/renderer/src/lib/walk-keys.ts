/**
 * Guided walks: the keyboard map of the walk pane (design.md §6 "Guided test walk" → Keyboard, spec AC-14).
 *
 * Pure and DOM-free: it reads a key event's shape and the pane's context and says which action the key means,
 * or `null` when the key is not the pane's. The pane applies the action; nothing here touches a run.
 *
 *  - `Enter` is the pane's PRIMARY action (Done; Start with 1 on the roadmap; Try again on a retry; Send in the
 *    failure form) on the pane or the Done button, keeps its own meaning on a chip, another button or a link,
 *    and sends in the failure form's field. Anywhere else in a field it is the field's.
 *  - `F`, `B` / `Left`, `S`, `E` and `L` are the shortcuts of Failed, Back, Skip, Explain more and the roadmap.
 *    An outcome's key acts only while that outcome is on screen, and every key is off while a field has focus.
 *  - `Esc` closes what is open, innermost first: the lightbox, the roadmap, the failure form (also from its
 *    field, which is how a field is left).
 *  - A held key never repeats an outcome, and a modifier hands the key back to the app and the browser.
 */

/** Ignore a second Done this soon after a new check was served: an Enter held or double-tapped. */
export const DONE_DEBOUNCE_MS = 400

export type TargetKind = 'pane' | 'done' | 'button' | 'chip' | 'link' | 'field'

/** The slice of a DOM node this module reads, so it runs (and is tested) without a DOM. */
export interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest(selector: string): unknown
}

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  /** A DOM event's `target` (an `EventTarget`) or anything shaped like {@link TargetLike}. */
  target: EventTarget | TargetLike | null
}

export type WalkKeyAction =
  | 'done'
  | 'start'
  | 'try-again'
  | 'send'
  | 'failed'
  | 'back'
  | 'skip'
  | 'explain'
  | 'roadmap'
  | 'close-lightbox'
  | 'close-roadmap'
  | 'close-form'

export type PaneMode =
  'check' | 'roadmap' | 'failed-form' | 'skipped' | 'closeout' | 'empty' | 'error'

export interface KeyContext {
  mode: PaneMode
  /** What Enter means on this screen, or `null` when no outcome is on offer. */
  primary: 'done' | 'start' | 'try-again' | 'send' | 'close-out' | 'pick-skipped' | null
  /** The outcomes on screen right now (the view's `outcomes` ids). A shortcut acts only for one of these. */
  available: ReadonlySet<string>
  lightbox: boolean
  roadmapOpen: boolean
  formOpen: boolean
}

const DONE_SELECTOR = '[data-walk-done]'
const BUTTON_SELECTOR = 'button, [role="button"]'
const CHIP_SELECTOR = '[data-walk-chip]'
const LINK_SELECTOR = 'a[href], [data-walk-link]'

/** What the event's target is, for the rules above. */
export function classifyTarget(raw: EventTarget | TargetLike | null): TargetKind {
  if (!raw) return 'pane'
  const target = raw as TargetLike
  if (typeof target.closest !== 'function') return 'pane' // a window or a document: not an element
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)
    return 'field'
  if (target.closest(CHIP_SELECTOR)) return 'chip'
  if (target.closest(LINK_SELECTOR)) return 'link'
  if (target.closest(DONE_SELECTOR)) return 'done'
  if (target.closest(BUTTON_SELECTOR)) return 'button'
  return 'pane'
}

/** `true` while a Done pressed at `now` falls inside the debounce window of a check served at `servedAt`. */
export function isDoneDebounced(servedAt: number | null, now: number): boolean {
  if (servedAt === null) return false
  return now - servedAt < DONE_DEBOUNCE_MS
}

/**
 * A pointer press on a chip (a copy button, a link chip) or a link must not move focus off the pane: the click
 * still fires, but the next Enter is still Done. A field must take focus, so it is left alone.
 */
export function keepPaneFocusOnPointer(ev: {
  target: EventTarget | TargetLike | null
  preventDefault(): void
}): void {
  const kind = classifyTarget(ev.target)
  if (kind === 'chip' || kind === 'link') ev.preventDefault()
}

const SHORTCUTS: Record<string, { action: WalkKeyAction; outcome: string | null }> = {
  f: { action: 'failed', outcome: 'failed' },
  b: { action: 'back', outcome: 'back' },
  arrowleft: { action: 'back', outcome: 'back' },
  s: { action: 'skip', outcome: 'skip' },
  e: { action: 'explain', outcome: 'explain' },
  // the roadmap is a way to look, never an outcome: always available while a check is served
  l: { action: 'roadmap', outcome: null }
}

/** The action a key means in this context, or `null` when it is not the pane's. */
export function mapWalkKey(ev: KeyLike, ctx: KeyContext): { action: WalkKeyAction } | null {
  const kind = classifyTarget(ev.target)
  const k = ev.key

  if (k === 'Escape') {
    // Esc leaves the failure form even from its field; everywhere else a field keeps it
    if (ctx.lightbox) return { action: 'close-lightbox' }
    if (ctx.roadmapOpen) return { action: 'close-roadmap' }
    if (ctx.formOpen) return { action: 'close-form' }
    return null
  }

  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null
  if (ev.repeat) return null

  if (kind === 'field') {
    // a field's keys are its own; only Enter in the failure form sends
    if (k === 'Enter' && ctx.formOpen && ctx.primary === 'send') return { action: 'send' }
    return null
  }

  if (k === 'Enter') {
    if (kind !== 'pane' && kind !== 'done') return null // a chip, a link or another button keeps Enter
    if (ctx.lightbox) return null
    switch (ctx.primary) {
      case 'done':
      case 'start':
      case 'try-again':
      case 'send':
        return ctx.primary === 'done' && !ctx.available.has('done') ? null : { action: ctx.primary }
      default:
        return null
    }
  }

  if (ctx.lightbox) return null
  const hit = SHORTCUTS[k.toLowerCase()]
  if (!hit) return null
  // the shortcuts belong to a served check; the roadmap, the skipped list, the failure form and the close-out
  // have their own controls
  if (ctx.mode !== 'check') return null
  if (hit.outcome !== null && !ctx.available.has(hit.outcome)) return null
  return { action: hit.action }
}
