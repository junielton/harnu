/**
 * The pins of every browser pane (T564 U6, spec §8.4), pure: main owns them, the guest draws them and the
 * renderer's composer edits them. No electron, no fs, no clock of its own (ADR-0001).
 *
 * A pin is numbered in the order it was made and keeps its number for the life of the pane, sent or not. A
 * pin is tied to the ORIGIN it was made on: after a navigation to another origin it is kept (it is the
 * operator's draft) but not shown, and it is shown again when the pane returns to that origin.
 *
 * Restart persistence belongs to U7. The seam is {@link PinPersistence}: every change hands the pane's
 * snapshot to `save`, and a pane's first use asks `load`. The default keeps nothing.
 */
import {
  MAX_PINS_PER_PANE,
  originOf,
  type CommentPaneState,
  type CommentPinView,
  type GuestPin,
  type OverlayRect,
  type PickedPayload
} from '../../shared/browser-comment'

export interface PinRecord {
  id: string
  n: number
  state: 'draft' | 'sent'
  /** The origin the pin was made on; the pin shows only while the page is on it. */
  origin: string
  /** Scrubbed page URL at pick time (page-authored). */
  url: string
  selector: string
  tag: string
  html: string
  component: string | null
  styles: Record<string, string>
  rect: OverlayRect
  /** Folder-relative crop path, once main wrote it. */
  cropPath: string | null
  /** The comment the operator saved as a draft (or sent). */
  comment: string
  /** The batch directory this pin's crop lives in. */
  batchId: string
  createdAt: number
}

/** Seam for U7: pins survive an app restart. */
export interface PinPersistence {
  load(paneId: string): PinRecord[] | null
  save(paneId: string, pins: PinRecord[]): void
}

export const NO_PERSISTENCE: PinPersistence = { load: () => null, save: () => undefined }

export interface PinStoreDeps {
  now(): number
  /** A fresh id: pin ids and batch ids (hex). */
  newId(): string
  persistence?: PinPersistence
}

export type AddPinResult = { ok: true; pin: PinRecord } | { ok: false; reason: 'PIN_LIMIT' }

export interface PinStore {
  add(paneId: string, picked: PickedPayload, pageUrl: string, scrubbedUrl: string): AddPinResult
  get(paneId: string, id: string): PinRecord | undefined
  list(paneId: string): PinRecord[]
  /** Keep the operator's text on a draft pin. */
  saveDraft(paneId: string, id: string, comment: string): boolean
  setCrop(paneId: string, id: string, cropPath: string | null): void
  /** Mark pins sent; when no draft remains the pane's batch id rotates. */
  markSent(paneId: string, ids: string[]): void
  remove(paneId: string, id: string): boolean
  /** The guest reported where pins sit now. */
  updateRects(paneId: string, rects: Record<string, OverlayRect>): void
  /** The pins to draw while the page is at `pageUrl`. */
  guestPins(paneId: string, pageUrl: string): GuestPin[]
  /** The batch directory a pin made now would write its crop to. */
  batchId(paneId: string): string
  /** The renderer's view of a pane (all pins, whatever the page). */
  views(paneId: string): CommentPinView[]
  /** A draft with saved text, in pin order. */
  drafts(paneId: string): PinRecord[]
  forget(paneId: string): void
}

function viewOf(p: PinRecord): CommentPinView {
  return {
    id: p.id,
    n: p.n,
    state: p.state,
    selector: p.selector,
    component: p.component,
    styleCount: Object.keys(p.styles).length,
    hasCrop: p.cropPath !== null,
    hasHtml: p.html !== '',
    comment: p.comment
  }
}

export function createPinStore(deps: PinStoreDeps): PinStore {
  const persistence = deps.persistence ?? NO_PERSISTENCE
  const panes = new Map<string, { pins: PinRecord[]; nextN: number; batchId: string }>()

  function pane(paneId: string): { pins: PinRecord[]; nextN: number; batchId: string } {
    let p = panes.get(paneId)
    if (!p) {
      const loaded = persistence.load(paneId) ?? []
      p = {
        pins: loaded,
        nextN: loaded.reduce((m, x) => Math.max(m, x.n), 0) + 1,
        batchId: loaded.find((x) => x.state === 'draft')?.batchId ?? deps.newId()
      }
      panes.set(paneId, p)
    }
    return p
  }

  const persist = (paneId: string): void => persistence.save(paneId, pane(paneId).pins.slice())

  return {
    add(paneId, picked, pageUrl, scrubbedUrl) {
      const p = pane(paneId)
      if (p.pins.length >= MAX_PINS_PER_PANE) return { ok: false, reason: 'PIN_LIMIT' }
      const pin: PinRecord = {
        id: deps.newId(),
        n: p.nextN++,
        state: 'draft',
        origin: originOf(pageUrl),
        url: scrubbedUrl,
        selector: picked.selector,
        tag: picked.tag,
        html: picked.outerHTML,
        component: picked.component,
        styles: picked.styles,
        rect: picked.rect,
        cropPath: null,
        comment: '',
        batchId: p.batchId,
        createdAt: deps.now()
      }
      p.pins.push(pin)
      persist(paneId)
      return { ok: true, pin }
    },
    get: (paneId, id) => pane(paneId).pins.find((x) => x.id === id),
    list: (paneId) => pane(paneId).pins.slice(),
    saveDraft(paneId, id, comment) {
      const pin = pane(paneId).pins.find((x) => x.id === id)
      if (!pin || pin.state === 'sent') return false
      pin.comment = comment
      persist(paneId)
      return true
    },
    setCrop(paneId, id, cropPath) {
      const pin = pane(paneId).pins.find((x) => x.id === id)
      if (!pin) return
      pin.cropPath = cropPath
      persist(paneId)
    },
    markSent(paneId, ids) {
      const p = pane(paneId)
      const set = new Set(ids)
      for (const pin of p.pins) if (set.has(pin.id)) pin.state = 'sent'
      // The next pin starts a new batch directory once nothing is waiting in the old one.
      if (!p.pins.some((x) => x.state === 'draft')) p.batchId = deps.newId()
      persist(paneId)
    },
    remove(paneId, id) {
      const p = pane(paneId)
      const before = p.pins.length
      p.pins = p.pins.filter((x) => x.id !== id)
      if (p.pins.length === before) return false
      persist(paneId)
      return true
    },
    updateRects(paneId, rects) {
      const p = pane(paneId)
      let changed = false
      for (const pin of p.pins) {
        const r = rects[pin.id]
        if (r) {
          pin.rect = r
          changed = true
        }
      }
      if (changed) persist(paneId)
    },
    guestPins(paneId, pageUrl) {
      const origin = originOf(pageUrl)
      return pane(paneId)
        .pins.filter((x) => x.origin === origin)
        .map((x) => ({
          id: x.id,
          n: x.n,
          state: x.state,
          selector: x.selector,
          rect: x.rect
        }))
    },
    batchId: (paneId) => pane(paneId).batchId,
    views: (paneId) => pane(paneId).pins.map(viewOf),
    drafts: (paneId) =>
      pane(paneId).pins.filter((x) => x.state === 'draft' && x.comment.trim() !== ''),
    forget: (paneId) => void panes.delete(paneId)
  }
}

/** The renderer-facing state of a pane (what `browser:commentState` carries). */
export function paneStateOf(
  paneId: string,
  views: CommentPinView[],
  overlayActive: boolean,
  openPinId: string | null
): CommentPaneState {
  return { paneId, overlayActive, pins: views, openPinId }
}
