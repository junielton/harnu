/**
 * Renderer-side platform detection.
 *
 * The renderer is sandbox-isolated (`contextIsolation: true`) so it cannot read
 * `process.platform` directly, and `navigator.userAgentData` is not universally
 * available across the Chromium versions Electron ships with. `navigator.platform`
 * is deprecated but still the most reliable synchronous signal here — the same
 * detection `useShortcuts.ts` relied on before this was hoisted into a shared
 * module.
 */
export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

/**
 * Horizontal space the macOS window controls (the "traffic lights") occupy in
 * the top-left corner when the window uses `titleBarStyle: 'hiddenInset'`
 * (`src/main/index.ts`). The renderer paints the full window, including behind
 * those controls, so any element that reaches the top-left corner — the sidebar
 * header, or the topbar header when the sidebar is collapsed — must reserve this
 * much left padding on macOS to stay clear of them (design.md §4 — Layout
 * dimensions, "macOS window-controls inset"). Zero on every other platform.
 */
export const macWindowControlsInset = isMac ? 78 : 0
