/**
 * `harnu/mockup-card` — the one registered HTML component v1 ships (T218 U7,
 * spec §5.2, design.md §6 — "Registered component nodes").
 *
 * ## What a registered shape is, and why the file can only hold a name
 *
 * The agent writes `shape: "harnu/mockup-card"` plus plain-JSON `props`. It
 * never writes markup, and there is no field in which it could: an inline
 * `html` payload on a node makes `graph.toJSON()` throw
 * (`Can only serialize node with plain-object props`, spike README trap 2), and
 * since the canvas FILE is the contract (§4), a node that cannot be serialized
 * is a node that cannot exist. The renderer owns the drawing; the document owns
 * the data. That is what retires the security concern the card originally
 * flagged rather than mitigating it — arbitrary agent-authored HTML has no path
 * to the DOM at all.
 *
 * This module holds that contract's RENDERER half and deliberately imports
 * NOTHING from `@antv/x6`. The X6 glue — `Shape.HTML.register` — lives in
 * `canvas-graph.ts`, which is already the only module allowed to touch the
 * library. Two consequences worth the split: `canvas-cells.ts` (which must stay
 * X6-free, see its header) can import the shape NAME and its default size from
 * here, and everything below is testable by building an element in jsdom
 * without constructing a graph.
 *
 * ## Every string reaches the DOM through `textContent`
 *
 * `props.body` is an agent-written string and may legitimately contain
 * `<` — "wrap it in a <div>" is prose, not an attack. It is set with
 * `textContent`, so it renders as the characters it is and creates no element.
 * `innerHTML` is never used here, and X6's own HTML view only takes the
 * `innerHTML` path when the registered `html` is a STRING — which is why this
 * module returns an `HTMLElement` and `canvas-graph.ts` registers the function
 * form. Both halves of that are load-bearing; changing either one re-opens the
 * hole.
 */

/** The document `shape` value. Namespaced `harnu/` so it can never collide with
 *  a built-in kind (§5.2). */
export const MOCKUP_CARD_SHAPE = 'harnu/mockup-card'

/** The name boards carried before the rename; still registered so those documents render and round-trip. */
export const LEGACY_MOCKUP_CARD_SHAPE = 'capy/mockup-card'

/**
 * Footprint for a card whose document omits `width`/`height`.
 *
 * MIRRORS the manifest entry in `src/main/mcp/canvas-shapes.ts` — which lives
 * in main because the MCP verb needs a value import at runtime — exactly as
 * `DEFAULT_NODE_SIZE` / `DEFAULT_TEXT_SIZE` do. The duplication is pinned by
 * the drift test in `tests/mcp-canvas-ops.test.ts`, so the size the verb writes
 * and the size the pane falls back to cannot disagree.
 */
export const MOCKUP_CARD_DEFAULT_SIZE = { width: 260, height: 160 } as const

/** The four props the manifest declares this shape reads. */
export interface MockupCardFields {
  title: string
  subtitle: string
  status: string
  body: string
}

/** The tone a status pill is drawn in. `neutral` is the default and the only
 *  one an unrecognized word can land in. */
export type MockupCardTone = 'neutral' | 'green' | 'warning' | 'red'

/**
 * Status text → tone (design.md §6). The manifest declares the KEY, not a
 * vocabulary, so this table is the renderer's own reading of the word and an
 * unrecognized status must still render — refusing or dropping it would make
 * the pane lie about what the file says.
 *
 * Matching is on the trimmed, lowercased, whitespace-collapsed text, so
 * `"In Progress"` and `"in-progress"` land in the same row.
 */
const TONE_BY_STATUS: ReadonlyMap<string, MockupCardTone> = new Map([
  ['done', 'green'],
  ['ready', 'green'],
  ['shipped', 'green'],
  ['ok', 'green'],
  ['passed', 'green'],
  ['wip', 'warning'],
  ['in progress', 'warning'],
  ['in-progress', 'warning'],
  ['review', 'warning'],
  ['pending', 'warning'],
  ['blocked', 'red'],
  ['failed', 'red'],
  ['error', 'red']
])

export function mockupCardTone(status: string): MockupCardTone {
  const key = status.trim().toLowerCase().replace(/\s+/g, ' ')
  return TONE_BY_STATUS.get(key) ?? 'neutral'
}

/** A prop that is not a string is not text — it is rendered as nothing rather
 *  than as `[object Object]`. §4.3 already guarantees `props` is plain JSON, so
 *  this is about a number or an array, not about a DOM node sneaking in. */
function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * `node.props` + the node's own label → the four fields the card draws.
 *
 * **`label` is the title's fallback** (design.md §6): a card written with only
 * a label still reads as a card, and X6's SVG `<text>` label is hidden for
 * exactly this reason — the component already shows that name, and drawing both
 * would print it twice.
 */
export function mockupCardFields(props: unknown, label?: unknown): MockupCardFields {
  const bag = props && typeof props === 'object' && !Array.isArray(props) ? props : {}
  const record = bag as Record<string, unknown>
  const title = text(record.title)
  return {
    title: title || text(label),
    subtitle: text(record.subtitle),
    status: text(record.status),
    body: text(record.body)
  }
}

function part(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  // NEVER `innerHTML`. See this module's header: `body` is agent-written prose
  // and may contain `<`; as text it is characters, as markup it is a hole.
  el.textContent = value
  return el
}

/**
 * The card's DOM subtree — a real element in THIS document, which is the
 * property that makes it pick up Harnu's CSS custom properties for free
 * (spec §3, §5.2). An iframe would be an isolated CSS context and would need
 * the whole token sheet injected into it on every theme switch.
 *
 * Colours and sizes come from `.canvas-mockup-card*` in `main.css`, which is
 * written in §9 tokens. Nothing here carries a raw colour — the same rule the
 * rest of the pane follows, honoured through a class rather than a Tailwind
 * utility because this element is built in JavaScript, outside a template
 * (`.fleet-ring` is the existing precedent).
 *
 * An absent prop yields NO element rather than an empty one, so a card with
 * only a title is a title, not a title over three blank rows.
 */
export function buildMockupCardElement(fields: MockupCardFields): HTMLElement {
  const root = document.createElement('div')
  root.className = 'canvas-mockup-card'

  if (fields.title || fields.status) {
    const head = document.createElement('div')
    head.className = 'canvas-mockup-card__head'
    if (fields.title) head.appendChild(part('span', 'canvas-mockup-card__title', fields.title))
    if (fields.status) {
      head.appendChild(
        part(
          'span',
          `canvas-mockup-card__status canvas-mockup-card__status--${mockupCardTone(fields.status)}`,
          fields.status
        )
      )
    }
    root.appendChild(head)
  }
  if (fields.subtitle) {
    root.appendChild(part('span', 'canvas-mockup-card__subtitle', fields.subtitle))
  }
  if (fields.body) {
    root.appendChild(part('p', 'canvas-mockup-card__body', fields.body))
  }
  return root
}
