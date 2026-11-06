/**
 * Split orientation (T627, design.md §6 "Split orientation").
 *
 * The session area and the helper stack sit side by side or stacked (session
 * area on top). Everything here is pure so the rules are unit-testable without
 * a DOM: the setting's value set, the `auto` resolver with its hysteresis, the
 * cycle order, and the per-orientation ratio contract.
 */

/** The setting: what the operator chose. `auto` follows the window's shape. */
export type SplitLayoutSetting = 'auto' | 'side-by-side' | 'stacked'

/** What is actually laid out. */
export type SplitOrientation = 'side-by-side' | 'stacked'

export const SPLIT_LAYOUTS: readonly SplitLayoutSetting[] = ['auto', 'side-by-side', 'stacked']
export const DEFAULT_SPLIT_LAYOUT: SplitLayoutSetting = 'auto'

/**
 * `auto` turns stacked once the main area is taller than wide by 5%
 * (`height / width` above this) …
 */
export const SPLIT_AUTO_ENTER_RATIO = 1.05
/** … and turns back once it is wider than tall by 5% (`height / width` below this). */
export const SPLIT_AUTO_EXIT_RATIO = 0.95

/** Defaults and clamp for the session area's share, per orientation (design.md §6). */
export const SPLIT_RATIO_DEFAULT = 0.65
export const SPLIT_RATIO_MIN = 0.4
export const SPLIT_RATIO_MAX = 0.8

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT
  return Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, ratio))
}

/** Parse an untrusted value (settings.json, a hand edit) into the setting; unknown → `auto`. */
export function sanitizeSplitLayout(value: unknown): SplitLayoutSetting {
  return typeof value === 'string' && (SPLIT_LAYOUTS as readonly string[]).includes(value)
    ? (value as SplitLayoutSetting)
    : DEFAULT_SPLIT_LAYOUT
}

/** The Topbar button and the shortcut: auto → side-by-side → stacked → auto. */
export function nextSplitLayout(setting: SplitLayoutSetting): SplitLayoutSetting {
  const i = SPLIT_LAYOUTS.indexOf(setting)
  return SPLIT_LAYOUTS[(i + 1) % SPLIT_LAYOUTS.length]
}

export interface AreaSize {
  width: number
  height: number
}

/**
 * Resolve the setting to a layout. An explicit setting wins outright. `auto`
 * looks at the main area's `height / width`: above {@link SPLIT_AUTO_ENTER_RATIO}
 * it is stacked, below {@link SPLIT_AUTO_EXIT_RATIO} side by side, and in between
 * (a near-square window) the `previous` result holds, so resizing across the
 * diagonal never flickers. An unmeasured or degenerate area also holds `previous`.
 */
export function resolveSplitOrientation(
  setting: SplitLayoutSetting,
  size: AreaSize,
  previous: SplitOrientation = 'side-by-side'
): SplitOrientation {
  if (setting !== 'auto') return setting
  const { width, height } = size
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return previous
  }
  const ratio = height / width
  if (ratio > SPLIT_AUTO_ENTER_RATIO) return 'stacked'
  if (ratio < SPLIT_AUTO_EXIT_RATIO) return 'side-by-side'
  return previous
}
