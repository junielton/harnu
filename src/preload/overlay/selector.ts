/**
 * Stable CSS selectors and node descriptions for the point-and-comment overlay (T564 U6, spec §8.3).
 *
 * Runs in the guest's isolated world, against the page's DOM. Pure over a `Document` (no globals besides an
 * optional `CSS.escape`), so it is unit-tested under jsdom.
 *
 * Preference order: a unique `data-testid` (or `data-test` / `data-cy`), a unique `id`, else the SHORTEST
 * unique `tag.class:nth-of-type` path found by walking up from the node until the selector matches only it.
 */
import { SELECTOR_MAX_CHARS } from '../../shared/browser-comment'

/** `CSS.escape`, with a small fallback for environments that lack it (jsdom). */
export function cssEscape(value: string): string {
  const native = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape
  if (typeof native === 'function') return native(value)
  return value.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (ch) => `\\${ch}`).replace(/^(\d)/, '\\3$1 ')
}

const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy']

/** Generated-looking class names are unstable across builds; they make poor anchors. */
function stableClass(name: string): boolean {
  if (name.length === 0 || name.length > 32) return false
  if (/^(css|sc|jsx|svelte|astro|_)-?[a-z0-9_-]{5,}$/i.test(name) && /\d/.test(name)) return false
  if (/^[a-z]{1,3}-?[A-Za-z0-9]{6,}$/.test(name) && /\d/.test(name) && /[A-Z]/.test(name))
    return false
  return true
}

function matchesOnly(doc: Document, selector: string, el: Element): boolean {
  try {
    const hits = doc.querySelectorAll(selector)
    return hits.length === 1 && hits[0] === el
  } catch {
    return false
  }
}

function attrSelector(el: Element): string | null {
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr)
    if (v && v.length <= 80) return `[${attr}="${v.replace(/["\\]/g, '\\$&')}"]`
  }
  return null
}

function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const classes = Array.from(el.classList).filter(stableClass).slice(0, 2)
  let seg = tag + classes.map((c) => `.${cssEscape(c)}`).join('')
  const parent = el.parentElement
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`
  }
  return seg
}

export function buildSelector(el: Element, doc: Document = el.ownerDocument): string {
  const cap = (s: string): string =>
    s.length > SELECTOR_MAX_CHARS ? s.slice(0, SELECTOR_MAX_CHARS) : s

  const own = attrSelector(el)
  if (own && matchesOnly(doc, own, el)) return cap(own)
  if (el.id) {
    const byId = `#${cssEscape(el.id)}`
    if (matchesOnly(doc, byId, el)) return cap(byId)
  }

  const segments: string[] = []
  let node: Element | null = el
  while (node) {
    const anchor = node === el ? null : uniqueAnchor(doc, node)
    segments.unshift(anchor ?? segmentFor(node))
    const candidate = segments.join(' > ')
    // Stop at the first prefix that is already unique, at an ancestor with a stable anchor, or at the root.
    if (anchor !== null || node === doc.documentElement || matchesOnly(doc, candidate, el)) {
      return cap(candidate)
    }
    node = node.parentElement
  }
  return cap(segments.join(' > '))
}

/** A unique `data-testid` / `id` selector for an ANCESTOR, or `null`. */
function uniqueAnchor(doc: Document, node: Element): string | null {
  const attr = attrSelector(node)
  if (attr && matchesOnly(doc, attr, node)) return attr
  if (node.id) {
    const byId = `#${cssEscape(node.id)}`
    if (matchesOnly(doc, byId, node)) return byId
  }
  return null
}

/** `button.btn.primary · 168×40`: the role or tag, up to two classes, and the size. Shown on the outline. */
export function describeNode(el: Element, rect: { width: number; height: number }): string {
  const role = el.getAttribute('role')
  const tag = role && /^[a-z-]{1,24}$/i.test(role) ? role : el.tagName.toLowerCase()
  const classes = Array.from(el.classList)
    .filter(stableClass)
    .slice(0, 2)
    .map((c) => `.${c.slice(0, 24)}`)
    .join('')
  return `${tag}${classes} · ${Math.round(rect.width)}×${Math.round(rect.height)}`
}
