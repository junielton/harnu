/**
 * The pane focus ring and the four pane commands built on it (T486 U5b,
 * `docs/specs/T486-keybindings-coverage-pass.md` §8, `design.md` §6 "Pane focus").
 *
 * Pure: the ring is a function of app state, and every command acts through
 * {@link PaneCommandDeps}, which `App.vue` wires to the stores and the pane-focus
 * registry (`composables/useTerminalFocus.ts`).
 */

/** The main terminal's region id — the registry's `MAIN_PANE_ID`. */
export const MAIN_REGION = 'main'

export interface PaneRingState {
  /** The main terminal is the foreground layer (App.vue `showTerminalForeground`). */
  mainForeground: boolean
  /** The helper stack renders beside the current view (App.vue `showHelperStack`). */
  stackShown: boolean
  helperCollapsed: boolean
  /** The current folder's helper pane ids, in stack order. */
  paneIds: readonly string[]
  /** `helpers.maximizedPaneIdForCurrentWorktree`. */
  maximizedId: string | null
}

/**
 * The regions F6 / ⇧F6 walk, in order: the main terminal when it is not covered,
 * then the helper panes when the panel is shown and not collapsed — only the
 * maximized one while a pane is maximized (the others are 24px headers).
 */
export function paneRing(s: PaneRingState): string[] {
  const ring: string[] = []
  if (s.mainForeground) ring.push(MAIN_REGION)
  if (!s.stackShown || s.helperCollapsed) return ring
  const max = s.maximizedId && s.paneIds.includes(s.maximizedId) ? s.maximizedId : null
  if (max) ring.push(max)
  else ring.push(...s.paneIds)
  return ring
}

/**
 * The region after (`1`) or before (`-1`) `current`, wrapping. Focus outside the
 * ring (`current` null or not in it) goes to the first region (`1`) or the last
 * (`-1`). `null` for an empty ring.
 */
export function stepRing(
  ring: readonly string[],
  current: string | null,
  dir: 1 | -1
): string | null {
  if (ring.length === 0) return null
  const i = current === null ? -1 : ring.indexOf(current)
  if (i < 0) return dir === 1 ? ring[0] : ring[ring.length - 1]
  return ring[(i + dir + ring.length) % ring.length]
}

/** What the pane commands act through (App.vue wires the stores and the registry). */
export interface PaneCommandDeps {
  /** The ring as it stands now ({@link paneRing} over live state). */
  ring: () => string[]
  /** The focused region id (`focusedRegionId`), or null. */
  current: () => string | null
  focus: (id: string) => void
  /** The region's own close. False when it has none (the main terminal). */
  close: (id: string) => boolean
  /** `helpers.currentWorktreePath`. */
  worktree: () => string | null
  /**
   * The current folder's helper panes, in stack order. `agentOwned` marks an agent
   * terminal (T474): it stays in the ring, but the terminal toggle never takes it.
   */
  panes: () => ReadonlyArray<{ id: string; type: string; agentOwned?: boolean }>
  maximizedId: () => string | null
  toggleMaximize: (worktree: string, paneId: string) => void
  /** Append a shell pane to `worktree`'s stack, with `worktree` as its cwd. */
  addShell: (worktree: string) => void
  setHelperCollapsed: (collapsed: boolean) => void
  /** Close an open takeover that does not host the helper stack (§8.2). */
  closeCoveringTakeover: () => void
  /** Leave focus on `<body>`. */
  blur: () => void
  /** Run `fn` once the DOM reflects the state change (App.vue: `nextTick`). */
  afterRender: (fn: () => void) => void
}

/** `pane.focusNext` (`1`) / `pane.focusPrev` (`-1`). */
export function focusPaneStep(d: PaneCommandDeps, dir: 1 | -1): void {
  const target = stepRing(d.ring(), d.current(), dir)
  if (target) d.focus(target)
}

/** The focused region when it is one of the current folder's helper panes. */
function focusedHelperPane(d: PaneCommandDeps): string | null {
  const id = d.current()
  return id && d.panes().some((p) => p.id === id) ? id : null
}

/**
 * `pane.toggleMaximize`: toggle the focused helper pane (focus stays in it); with
 * none focused, restore a maximized pane; otherwise nothing.
 */
export function togglePaneMaximize(d: PaneCommandDeps): void {
  const wt = d.worktree()
  if (!wt) return
  const focused = focusedHelperPane(d)
  if (focused) {
    d.toggleMaximize(wt, focused)
    d.afterRender(() => d.focus(focused))
    return
  }
  const max = d.maximizedId()
  if (max) d.toggleMaximize(wt, max)
}

/**
 * `pane.close`: the focused pane's own close, then focus the region that took its
 * place in the ring (wrapping), else the main terminal. A pane whose discard guard
 * kept it open keeps focus.
 */
export function closeFocusedPane(d: PaneCommandDeps): void {
  const id = d.current()
  if (!id) return
  const ring = d.ring()
  const at = ring.indexOf(id)
  const rest = ring.filter((r) => r !== id)
  const target = rest.length === 0 ? MAIN_REGION : rest[at < 0 ? 0 : at % rest.length]
  if (!d.close(id)) return
  d.afterRender(() => {
    if (d.panes().some((p) => p.id === id)) return
    if (d.ring().includes(target)) d.focus(target)
  })
}

/**
 * `terminal.toggle` (§8.2), on the first operator `shell` pane of the current folder
 * (an agent terminal is never taken — with only agent terminals, a new shell is added):
 *  1. none → add one (the add reveals a collapsed panel; the new xterm focuses itself);
 *  2. it holds focus → collapse the helper panel, focus main (or leave focus on `<body>`);
 *  3. otherwise → reveal the panel, restore another maximized pane, focus it.
 * It never appends a second shell: that is Split ▸ New shell (`folder.newTerminal`).
 */
export function toggleTerminal(d: PaneCommandDeps): void {
  const wt = d.worktree()
  if (!wt) return
  const shell = d.panes().find((p) => p.type === 'shell' && !p.agentOwned)
  if (!shell) {
    d.closeCoveringTakeover()
    d.addShell(wt)
    return
  }
  if (d.current() === shell.id) {
    d.setHelperCollapsed(true)
    d.afterRender(() => {
      if (d.ring().includes(MAIN_REGION)) d.focus(MAIN_REGION)
      else d.blur()
    })
    return
  }
  d.closeCoveringTakeover()
  d.setHelperCollapsed(false)
  const max = d.maximizedId()
  if (max && max !== shell.id) d.toggleMaximize(wt, max)
  d.afterRender(() => d.focus(shell.id))
}
