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

/**
 * A full-viewport fixed layer, however it is spelled: the Tailwind class list (`fixed` together
 * with `inset-0`, `inset-x-0` + `inset-y-0`, or all four of `top-0 right-0 bottom-0 left-0`, in any
 * order), or an inline/scoped style with `position: fixed` and `inset: 0` or all four sides at 0.
 */
export function hasFixedFullViewport(source: string): boolean {
  for (const m of source.matchAll(/class="([^"]*)"|:class="([^"]*)"|`([^`]*)`/g)) {
    const list = ` ${(m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ')} `
    if (!/\sfixed\s/.test(list)) continue
    if (/\sinset-0\s/.test(list)) return true
    if (/\sinset-x-0\s/.test(list) && /\sinset-y-0\s/.test(list)) return true
    if (['top-0', 'right-0', 'bottom-0', 'left-0'].every((c) => list.includes(` ${c} `)))
      return true
  }
  for (const m of source.matchAll(/position:\s*fixed([^"'`}]*)/g)) {
    const rest = m[1]
    if (/\binset:\s*0\b/.test(rest)) return true
    if (
      ['top', 'right', 'bottom', 'left'].every((side) =>
        new RegExp(`\\b${side}:\\s*0\\b`).test(rest)
      )
    ) {
      return true
    }
  }
  // The declaration may also come BEFORE `position: fixed` in the same style attribute.
  return /inset:\s*0[^"'`}]*position:\s*fixed/.test(source)
}

/**
 * A scrim colour: raw black (`rgba(0, 0, 0, …)`, `rgb(0 0 0 / …)`, `#000…` with alpha, Tailwind
 * `bg-black/N`), or a translucent TOKEN or arbitrary colour used as a backdrop (`bg-bg/80`,
 * `bg-surface/60`, `bg-[#1a1a1f]/50`). Any of them on a full-viewport fixed layer is a hand-rolled
 * scrim: the shared `--color-scrim` (`bg-scrim`) is the only sanctioned one.
 *
 * BLIND SPOTS, stated rather than hidden: a scrim whose colour comes from a CSS variable the file
 * does not spell (`background: var(--something)`), a shell built in a `.ts` render function, and a
 * dialog that paints no scrim at all (a bare fixed card). The characterization net's name-based
 * coverage test is what catches a new `*Dialog` / `*Modal` file in those cases.
 */
export function hasRawBlackScrim(source: string): boolean {
  if (/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(source)) return true
  if (/rgb\(\s*0\s+0\s+0\s*\/\s*[\d.%]+\s*\)/.test(source)) return true
  if (/#000(?:000)?[0-9a-f]{2}\b|#0000\b/i.test(source)) return true
  if (/\bbg-black\//.test(source)) return true
  // Translucent token / arbitrary-colour backdrop utilities (opacity suffix).
  return /\bbg-(?:bg|surface|surface-2|sidebar|text|\[#[0-9a-f]{3,8}\])\/\d+/i.test(source)
}

export function isHandRolledShell(source: string): boolean {
  return hasFixedFullViewport(source) && hasRawBlackScrim(source)
}
