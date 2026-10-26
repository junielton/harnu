/**
 * The docked composer's view model (T564 U6, design.md "Point-and-comment overlay"): which key does what, how
 * many drafts and sent comments the batch bar counts, what the context line says is attached, and where a
 * comment goes. Pure — `BrowserPane.vue` renders the answer and owns no logic of its own.
 */
import type { CommentPinView } from '../../../shared/browser-comment'

export type ComposerKeyAction = 'send' | 'draft' | 'close' | null

export interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

/**
 * What a key press in the composer's textarea means: `Enter` sends, `Shift+Enter` keeps a draft, `Esc` closes.
 * A key press that belongs to an IME composition never submits (`isComposing`, or the legacy keyCode 229).
 */
export function composerKeyAction(e: ComposerKeyEvent): ComposerKeyAction {
  if (e.isComposing || e.keyCode === 229) return null
  if (e.key === 'Escape') return 'close'
  if (e.key !== 'Enter') return null
  if (e.altKey) return null
  if (e.shiftKey) return 'draft'
  return 'send'
}

export interface BatchSummary {
  /** Pins with saved text waiting to be sent (an open composer with no text yet is not a draft). */
  drafts: number
  sent: number
}

export function batchSummary(pins: readonly CommentPinView[]): BatchSummary {
  let drafts = 0
  let sent = 0
  for (const p of pins) {
    if (p.state === 'sent') sent++
    else if (p.comment.trim() !== '') drafts++
  }
  return { drafts, sent }
}

/** The bar shows whenever the pane has any draft or sent pin, composer open or not. */
export function batchBarVisible(pins: readonly CommentPinView[]): boolean {
  const s = batchSummary(pins)
  return s.drafts + s.sent > 0
}

export interface AttachedSummary {
  crop: boolean
  html: boolean
  styles: number
}

export function attachedSummary(pin: CommentPinView): AttachedSummary {
  return { crop: pin.hasCrop, html: pin.hasHtml, styles: pin.styleCount }
}

export interface DestinationOption {
  id: string
  title: string
  isOwner: boolean
}

/**
 * Where a comment goes, as the picker shows it: the remembered choice for this pane if that session is still
 * in the folder, else the pane's owner, else the folder's selected session, else nowhere (→ clipboard).
 */
export function effectiveDestination(i: {
  remembered: string | null
  owner: string | null
  selectedId: string | null
  folderSessionIds: readonly string[]
}): string | null {
  const here = new Set(i.folderSessionIds)
  if (i.remembered !== null && here.has(i.remembered)) return i.remembered
  if (i.owner !== null && here.has(i.owner)) return i.owner
  if (i.selectedId !== null && here.has(i.selectedId)) return i.selectedId
  return null
}

/** The picker's list: the folder's sessions, the owner first. */
export function destinationOptions(
  sessions: ReadonlyArray<{ id: string; title: string }>,
  owner: string | null
): DestinationOption[] {
  const all = sessions.map((s) => ({ id: s.id, title: s.title, isOwner: s.id === owner }))
  return [...all.filter((s) => s.isOwner), ...all.filter((s) => !s.isOwner)]
}

/** The pin the composer is open on, or `null`. */
export function openPin(
  pins: readonly CommentPinView[],
  openPinId: string | null
): CommentPinView | null {
  return openPinId === null ? null : (pins.find((p) => p.id === openPinId) ?? null)
}
