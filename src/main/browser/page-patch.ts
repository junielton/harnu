/**
 * `browser_patch` (T564 U2, spec §5.2): mutate the live DOM of a `page` pane by CSS selector. EPHEMERAL: a
 * reload discards it, the file and the sidecar are the durable state. This module builds the one script main
 * evaluates in the page; it takes every value as JSON, never by string splicing.
 */

export const PATCH_MODES = ['inner', 'outer', 'append', 'prepend', 'remove'] as const
export type PatchMode = (typeof PATCH_MODES)[number]
export const MAX_PATCH_HTML_BYTES = 64 * 1024

export interface PatchResult {
  matched: number
  applied: number
  /** Set when the selector could not be parsed. */
  badSelector?: string
}

export function isPatchMode(v: unknown): v is PatchMode {
  return typeof v === 'string' && (PATCH_MODES as readonly string[]).includes(v)
}

/** `html` is required for every mode except `remove`. */
export function patchNeedsHtml(mode: PatchMode): boolean {
  return mode !== 'remove'
}

/**
 * The expression main evaluates (in the page's main world, on the top frame). It returns a {@link PatchResult}.
 * Zero matches is NOT an error here: the verb turns it into `SELECTOR_NOT_FOUND`.
 */
export function buildPatchScript(args: {
  selector: string
  mode: PatchMode
  html?: string
}): string {
  const a = JSON.stringify({ selector: args.selector, mode: args.mode, html: args.html ?? '' })
  return `(() => {
  const a = ${a};
  let nodes;
  try { nodes = Array.from(document.querySelectorAll(a.selector)); }
  catch (e) { return { matched: 0, applied: 0, badSelector: String(e && e.message || e) }; }
  let applied = 0;
  for (const el of nodes) {
    try {
      if (a.mode === 'inner') el.innerHTML = a.html;
      else if (a.mode === 'outer') el.outerHTML = a.html;
      else if (a.mode === 'append') el.insertAdjacentHTML('beforeend', a.html);
      else if (a.mode === 'prepend') el.insertAdjacentHTML('afterbegin', a.html);
      else if (a.mode === 'remove') el.remove();
      applied++;
    } catch (e) { /* a node that rejects the change is simply not counted */ }
  }
  return { matched: nodes.length, applied };
})()`
}
