/**
 * Bottom-buffer extraction + normalization core (A2 two-tier state detection —
 * T5).
 *
 * The renderer reads xterm's rendered grid (`term.buffer.active`, one string per
 * row) and must hand the main process a SMALL, STABLE slice of the bottom of the
 * screen to match manifests against. This module is that reduction, kept pure so
 * the normalization (which decides whether the screen "changed") is unit-tested
 * independently of xterm and IPC — ADR-0001 pure-core / thin-shell.
 *
 * Two jobs, in order:
 *
 *  1. NORMALIZE each row — right-trim trailing whitespace. A spinner repaint
 *     that only rewrites trailing spaces must not read as a different screen, or
 *     the change-detection (and stickiness) would flap every frame.
 *  2. CLIP to the meaningful bottom-N — drop the run of blank rows the emulator
 *     pads the grid with below the cursor, then take the last `n` of what
 *     remains. We never scan scrollback, so an OLD prompt that scrolled up can
 *     never be matched (design technique §1).
 *
 * The result is deterministic for a given logical screen, which is what makes a
 * cheap `linesChanged()` equality the basis for the dirty-flag/debounce in the
 * snapshot shell (plan T6) and the blocked-stickiness in `stickiness-core`.
 */

/** Right-trim trailing whitespace (spaces, tabs) from one rendered row. */
function rtrim(line: string): string {
  return line.replace(/\s+$/, '')
}

/**
 * Reduce a full rendered grid to its normalized bottom `n` lines.
 *
 * Trailing blank rows (the emulator's below-cursor padding) are dropped before
 * the last-`n` slice so `extractBottomLines(grid, 30)` is stable whether the
 * grid is 24 or 120 rows tall and however much blank padding sits under the
 * content. Each kept line is right-trimmed so trailing-space-only repaints don't
 * register as a change. Leading/interior blank lines WITHIN the window are
 * preserved (they can be meaningful spacing between a prompt and its options).
 *
 * @param grid - rendered rows, top-to-bottom (xterm `translateToString` output).
 * @param n - how many bottom lines to keep (clamped at 0 → empty).
 * @returns up to `n` normalized lines, top-to-bottom.
 */
export function extractBottomLines(grid: string[], n: number): string[] {
  if (n <= 0) return []
  const trimmed = grid.map(rtrim)
  // Find the last non-blank row; everything after it is padding to discard.
  let lastContent = trimmed.length - 1
  while (lastContent >= 0 && trimmed[lastContent] === '') lastContent--
  if (lastContent < 0) return [] // an all-blank grid has no bottom buffer
  const start = Math.max(0, lastContent - n + 1)
  return trimmed.slice(start, lastContent + 1)
}

/**
 * Equality over two extracted bottom-line slices — the change signal that feeds
 * the snapshot dirty-flag and `applyStickiness(prev, next, screenChanged)`.
 * Order-sensitive, exact per line (both sides are already normalized by
 * {@link extractBottomLines}). Pure.
 */
export function linesChanged(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return true
  }
  return false
}
