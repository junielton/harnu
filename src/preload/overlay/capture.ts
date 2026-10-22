/**
 * What the overlay reads off a node the operator picked (T564 U6, spec §8.3): outerHTML with the children past
 * depth 2 elided, the allowlisted computed styles, and the component source when the page tells us.
 *
 * Everything returned is PAGE-AUTHORED. Main caps and validates it again, and the message that carries it
 * fences it (spec §8.5); this module only keeps the guest from sending an obviously oversized payload.
 */
import {
  COMPONENT_MAX_CHARS,
  COMPUTED_STYLE_ALLOWLIST,
  HTML_MAX_CHARS,
  MAX_STYLES,
  STYLE_VALUE_MAX_CHARS
} from '../../shared/browser-comment'

const HTML_DEPTH = 2
/** Attributes whose value is typed-in data rather than markup. */
const VALUE_BEARING = new Set(['input', 'textarea', 'select', 'option'])

function elide(node: Element, depth: number): void {
  if (VALUE_BEARING.has(node.tagName.toLowerCase())) {
    node.removeAttribute('value')
    if (node.tagName.toLowerCase() === 'textarea') node.textContent = ''
  }
  if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
    node.textContent = ''
    return
  }
  if (depth >= HTML_DEPTH) {
    if (node.childNodes.length > 0) node.textContent = '…'
    return
  }
  for (const child of Array.from(node.children)) elide(child, depth + 1)
}

/** The node's outerHTML, children past depth 2 replaced by `…`, capped at ~2 KB. Never mutates the page. */
export function outerHtmlShallow(el: Element): string {
  const clone = el.cloneNode(true) as Element
  elide(clone, 0)
  const html = clone.outerHTML
  return html.length > HTML_MAX_CHARS ? `${html.slice(0, HTML_MAX_CHARS)}…` : html
}

/** The allowlisted computed styles with a value, at most 40, each value cut. */
export function computedStyles(el: Element, win: Window): Record<string, string> {
  const out: Record<string, string> = {}
  let cs: CSSStyleDeclaration
  try {
    cs = win.getComputedStyle(el)
  } catch {
    return out
  }
  for (const prop of COMPUTED_STYLE_ALLOWLIST) {
    if (Object.keys(out).length >= MAX_STYLES) break
    const v = cs.getPropertyValue(prop).trim()
    if (v !== '')
      out[prop] = v.length > STYLE_VALUE_MAX_CHARS ? `${v.slice(0, STYLE_VALUE_MAX_CHARS)}…` : v
  }
  return out
}

/** A source string from a page, reduced to a `file[:line]` of sane characters, or `null`. */
export function normalizeComponentSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (text === '' || text.length > COMPONENT_MAX_CHARS) return null
  // `file`, `file:line` or `file:line:column` (the column is dropped: `file:line` only).
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(text)
  const file = m?.[1] ?? ''
  if (file === '' || /\s{2,}/.test(file)) return null
  return m?.[2] ? `${file}:${m[2]}` : file
}

/**
 * The component from the DOM alone: Vue's dev inspector stamps `data-v-inspector="src/Pay.vue:42:7"` on the
 * elements it renders. An attribute is visible from the isolated world; the expandos frameworks put on DOM nodes
 * (`__vueParentComponent`, React fibers, `__svelte_meta`) are not, and need {@link probeSource}.
 */
export function componentFromAttributes(el: Element): string | null {
  const holder = el.closest('[data-v-inspector]')
  return normalizeComponentSource(holder?.getAttribute('data-v-inspector') ?? null)
}

/**
 * The page-world probe, run through `webFrame.executeJavaScript`. It finds the node the operator clicked by its
 * POINT (the first element under it that is not our own overlay host), so nothing is written onto the page's
 * node: no attribute for a page's MutationObserver to see. Best-effort and silent when absent: Vue 3
 * `__vueParentComponent.type.__file`, React `_debugSource` (walking up through `_debugOwner`), Svelte
 * `__svelte_meta.loc`. It returns a string or `null`; the result is normalised by
 * {@link normalizeComponentSource} and is page-authored like everything else.
 */
export function probeSource(x: number, y: number): string {
  const px = Math.round(Number.isFinite(x) ? x : 0)
  const py = Math.round(Number.isFinite(y) ? y : 0)
  return `(() => { try {
  const stack = document.elementsFromPoint(${px}, ${py});
  const el = stack.find((e) => !e.hasAttribute('data-harnu-overlay'));
  if (!el) return null;
  let n = el;
  for (let i = 0; n && i < 20; i++, n = n.parentElement) {
    const vc = n.__vueParentComponent;
    if (vc && vc.type && typeof vc.type.__file === 'string') return vc.type.__file;
    const sv = n.__svelte_meta;
    if (sv && sv.loc && typeof sv.loc.file === 'string') return sv.loc.file + (sv.loc.line ? ':' + sv.loc.line : '');
    const key = Object.keys(n).find((k) => k.startsWith('__reactFiber$'));
    if (key) {
      let f = n[key];
      for (let j = 0; f && j < 50; j++, f = f._debugOwner || f.return) {
        const s = f._debugSource;
        if (s && typeof s.fileName === 'string') return s.fileName + (s.lineNumber ? ':' + s.lineNumber : '');
      }
    }
  }
  return null;
} catch (e) { return null; } })()`
}

export interface MainWorld {
  executeJavaScript(code: string): Promise<unknown>
}

/** The component of a picked node: the DOM attribute first, then a bounded page-world probe by point. */
export async function discoverComponent(
  el: Element,
  world: MainWorld,
  point: { x: number; y: number },
  timeoutMs = 200
): Promise<string | null> {
  const fromDom = componentFromAttributes(el)
  if (fromDom) return fromDom
  try {
    const raw = await Promise.race([
      world.executeJavaScript(probeSource(point.x, point.y)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ])
    return normalizeComponentSource(raw)
  } catch {
    return null
  }
}
