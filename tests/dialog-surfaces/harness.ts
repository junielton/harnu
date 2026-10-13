/**
 * T460 batch 0 — shared harness for `dialog-surfaces.characterization.test.ts`.
 *
 * A `SurfaceSpec` describes how to MOUNT one dialog headlessly (jsdom) and how
 * to read back its observable behaviour. `probe()` then MEASURES that behaviour
 * on the real component (it never reads an expectation), and the test compares
 * the measurement to the table. Nothing here asserts anything by itself: every
 * value in a `Measured` is the result of dispatching a real event at the
 * mounted component, so a behaviour change moves the measurement and reddens
 * the table row.
 *
 * jsdom has no layout engine, so "is it capped" is read from the rendered
 * card's own `class` / inline `style` (see `SurfaceSpec.capEvidence`); real
 * geometry is pinned by `tests/e2e/ci/dialog-geometry.spec.ts`.
 */
import { flushPromises } from '@vue/test-utils'

/** Result of opening a surface. */
export interface OpenedSurface {
  /** The element carrying `role="dialog"` (the card, or the scrim when the component puts the role there). */
  card: () => HTMLElement | null
  /**
   * The element the component's backdrop handler is bound to — the one whose
   * `mousedown` / `click` with `target === currentTarget` dismisses it. `null`
   * when the surface has no backdrop dismissal at all.
   */
  scrim: () => HTMLElement | null
  /**
   * Whether the surface reports itself closed right now, by whichever idiom it
   * uses (an `emit`, a store flag, a local ref reflected in the DOM). Must
   * return `true` ONLY because the component asked to close.
   */
  isClosed: () => boolean
  /**
   * A stable text description of HOW the surface signalled closing — the emit
   * name + payload (`cancel[]`, `close[false]`), or the store flag
   * (`ui.dialog=null`). Called after a close was triggered.
   */
  closeSignal: () => string
  /**
   * Re-open (or reset) the surface so the next probe starts from a clean open
   * state. Each probe re-mounts via `SurfaceSpec.open`, so this is only used by
   * specs that must reset module-level state.
   */
  teardown: () => void
  /**
   * Named elements inside the card, used to say WHICH element holds initial
   * focus (`cancel`, `confirm`, `input`, `close`, …). Names are the vocabulary
   * of the `initialFocus` column of the table.
   */
  named: Record<string, () => HTMLElement | null>
  /**
   * The text the card's size cap lives in: the card's `class` + inline `style`
   * (and, for components that style the card through scoped CSS, a snippet the
   * spec extracted explicitly). `probe()` greps this for a height cap.
   */
  capEvidence: () => string
}

export interface SurfaceSpec {
  /** Component filename, e.g. `RenameFolderDialog.vue` — the table key. */
  file: string
  /** Mount the component in its OPEN state, attached to `document.body`, and wait for it to settle. */
  open: () => Promise<OpenedSurface>
}

export type EscMeasure =
  /** Esc dispatched with focus on `<body>` (outside the card) closes it. */
  | 'closes'
  /** Esc closes it only when the event originates inside the card. */
  | 'only-focus-inside'
  /** Esc does nothing. */
  | 'ignored'

export interface Measured {
  role: string | null
  ariaModal: string | null
  /** `labelledby` (resolves to an element with text) | `label` (aria-label) | `none`. */
  accessibleName: 'labelledby' | 'label' | 'none'
  esc: EscMeasure
  /** Does an Esc keydown propagate on to a bubbling `document` listener? (`false` = stopped). */
  escReachesDocument: boolean
  /** `mousedown` on the scrim itself closes it. */
  scrimMousedown: boolean
  /** A bare `click` on the scrim (no mousedown) closes it. */
  scrimClick: boolean
  /** `mousedown` inside the card does NOT close it. */
  insideMousedownStaysOpen: boolean
  /** Tab on the last focusable wraps to the first (and is prevented). */
  trap: boolean
  /** Name of the element holding focus right after open (key of `named`), or `none` / `other`. */
  initialFocus: string
  /** `ui.closeDialog()` flag, emit name + payload … as the component reports it. */
  closeSignal: string
  /** The card declares a max-height / fixed height cap. */
  cap: boolean
}

/** Make `getClientRects` non-empty so `useFocusTrap`'s visibility filter works in jsdom. */
export function installLayoutStubs(): () => void {
  const original = HTMLElement.prototype.getClientRects
  HTMLElement.prototype.getClientRects = function (): DOMRectList {
    return [{ x: 0, y: 0, width: 1, height: 1 } as DOMRect] as unknown as DOMRectList
  }
  return () => {
    HTMLElement.prototype.getClientRects = original
  }
}

/**
 * A height cap in a card's class list / inline style / extracted CSS: a Tailwind `max-h-…` or fixed
 * `h-[…]` / `h-(…)` utility, or a CSS `max-height:` / `height:` declaration. The lookbehind keeps
 * `min-h-[…]` (a floor, not a cap) and `line-height:` from counting.
 */
const CAP_RE = /(?<![\w-])(?:max-h-|h-\[|h-\()|(?<![\w-])(?:max-height|height)\s*:/

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

function whichNamed(s: OpenedSurface): string {
  const active = document.activeElement
  if (!active || active === document.body) return 'none'
  for (const [name, get] of Object.entries(s.named)) if (get() === active) return name
  return 'other'
}

async function settle(): Promise<void> {
  await flushPromises()
  await flushPromises()
}

function esc(target: EventTarget): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(ev)
  return ev
}

/** Measure one surface. Re-mounts the surface for every destructive probe. */
export async function probe(spec: SurfaceSpec): Promise<Measured> {
  // ---- 1. static + focus facts on a fresh open ------------------------------
  let s = await spec.open()
  await settle()
  const card = s.card()
  if (!card) throw new Error(`${spec.file}: no [role=dialog] after open()`)
  const role = card.getAttribute('role')
  const ariaModal = card.getAttribute('aria-modal')
  const labelledby = card.getAttribute('aria-labelledby')
  const labelEl = labelledby ? document.getElementById(labelledby) : null
  const accessibleName: Measured['accessibleName'] =
    labelEl && (labelEl.textContent ?? '').trim()
      ? 'labelledby'
      : (card.getAttribute('aria-label') ?? '').trim()
        ? 'label'
        : 'none'
  const initialFocus = whichNamed(s)
  const cap = CAP_RE.test(s.capEvidence())

  // ---- 2. Tab trap (focus last focusable, press Tab) ------------------------
  let trap = false
  {
    const items = focusables(card)
    if (items.length > 1) {
      const last = items[items.length - 1]
      const first = items[0]
      last.focus()
      const tab = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true
      })
      last.dispatchEvent(tab)
      trap = tab.defaultPrevented && document.activeElement === first
    }
  }
  s.teardown()
  document.body.innerHTML = ''

  // ---- 3. Esc from body (focus outside) -------------------------------------
  s = await spec.open()
  await settle()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  let docSaw = false
  const docListener = (): void => {
    docSaw = true
  }
  document.addEventListener('keydown', docListener)
  const evBody = esc(document.body)
  await settle()
  document.removeEventListener('keydown', docListener)
  const closedFromBody = s.isClosed()
  const escReachesDocument = docSaw && !evBody.cancelBubble
  let closeSignal = closedFromBody ? s.closeSignal() : ''
  s.teardown()
  document.body.innerHTML = ''

  // ---- 4. Esc from inside the card ------------------------------------------
  s = await spec.open()
  await settle()
  const inner = s.card()
  const target =
    (document.activeElement && inner?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null) ??
    focusables(inner as HTMLElement)[0] ??
    (inner as HTMLElement)
  target.focus?.()
  esc(target)
  await settle()
  const closedFromInside = s.isClosed()
  if (!closeSignal && closedFromInside) closeSignal = s.closeSignal()
  s.teardown()
  document.body.innerHTML = ''
  const escMeasure: EscMeasure = closedFromBody
    ? 'closes'
    : closedFromInside
      ? 'only-focus-inside'
      : 'ignored'

  // ---- 5. scrim mousedown -----------------------------------------------------
  s = await spec.open()
  await settle()
  let scrimMousedown = false
  const sc1 = s.scrim()
  if (sc1) {
    sc1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await settle()
    scrimMousedown = s.isClosed()
    if (!closeSignal && scrimMousedown) closeSignal = s.closeSignal()
  }
  s.teardown()
  document.body.innerHTML = ''

  // ---- 6. bare click on scrim ---------------------------------------------------
  s = await spec.open()
  await settle()
  let scrimClick = false
  const sc2 = s.scrim()
  if (sc2) {
    sc2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    scrimClick = s.isClosed()
    if (!closeSignal && scrimClick) closeSignal = s.closeSignal()
  }
  s.teardown()
  document.body.innerHTML = ''

  // ---- 7. mousedown inside the card stays open ------------------------------------
  s = await spec.open()
  await settle()
  const c3 = s.card() as HTMLElement
  c3.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await settle()
  const insideMousedownStaysOpen = !s.isClosed()
  s.teardown()
  document.body.innerHTML = ''

  return {
    role,
    ariaModal,
    accessibleName,
    esc: escMeasure,
    escReachesDocument,
    scrimMousedown,
    scrimClick,
    insideMousedownStaysOpen,
    trap,
    initialFocus,
    closeSignal,
    cap
  }
}
