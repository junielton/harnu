/**
 * The width levels of the Focus back row (design.md §6 "Sidebar tree → Focus"). The row stays on one
 * line: as it narrows it drops whole parts, and the counts that need the operator never go.
 *
 * 0 everything · 1 without "others" · 2 without the label · 3 with the short "needs you"
 */
export type BackRowLevel = 0 | 1 | 2 | 3

/** Natural widths of the row's parts, in px. A part that is not shown at all is 0 wide. */
export interface BackRowWidths {
  chevron: number
  gap: number
  label: number
  /** `others`, `needs` and `needsShort` include the "·" that trails them. */
  others: number
  needs: number
  needsShort: number
  failed: number
}

export function backRowLevel(available: number, w: BackRowWidths): BackRowLevel {
  // Not laid out yet (or no layout at all): nothing to respond to.
  if (available <= 0) return 0
  // The chevron, then each part present with the gap before it.
  const fits = (...parts: number[]): boolean =>
    parts.reduce((sum, part) => (part > 0 ? sum + w.gap + part : sum), w.chevron) <= available + 0.5
  const owed = w.needs + w.failed
  if (fits(w.label, w.others + owed)) return 0
  if (fits(w.label, owed)) return 1
  if (fits(owed) || w.needsShort >= w.needs) return 2
  return 3
}
