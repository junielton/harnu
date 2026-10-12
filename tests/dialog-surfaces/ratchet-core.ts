/**
 * T460 batch 0 — the detection rule behind `tests/dialog-shell-ratchet.test.ts`.
 *
 * "Hand-rolled dialog shell" = a component that paints its OWN full-viewport
 * fixed scrim with a RAW black colour (`rgba(0, 0, 0, …)` / `bg-black/…`)
 * instead of the shared `Dialog` + `--color-scrim` token (spec §4.2
 * "Enforcement"). Both halves are required: a `fixed inset-0` overlay that
 * paints no black (a drop-zone, a chart tooltip) is not a dialog, and a raw
 * black used for a shadow or a gradient is not a scrim.
 *
 * Pure string logic, no fs, so the test can prove the rule against synthetic
 * sources that are known-dirty / known-clean.
 */

/** `fixed inset-0` in either word order inside one class list, or `position: fixed` + `inset: 0` in one style. */
export function hasFixedFullViewport(source: string): boolean {
  if (/\bfixed\b[^"'`<>]*\binset-0\b/.test(source)) return true
  if (/\binset-0\b[^"'`<>]*\bfixed\b/.test(source)) return true
  return /position:\s*fixed[^"'`]*?\binset:\s*0\b/.test(source)
}

/** A raw black colour used as a scrim: `rgba(0, 0, 0, …)` or Tailwind `bg-black/…`. */
export function hasRawBlackScrim(source: string): boolean {
  return /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(source) || /\bbg-black\//.test(source)
}

export function isHandRolledShell(source: string): boolean {
  return hasFixedFullViewport(source) && hasRawBlackScrim(source)
}
