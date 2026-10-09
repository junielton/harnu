import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useMissionsStore } from './missions'
import { useNotificationsStore } from './notifications'

/**
 * Identifier of the currently open dialog. `null` when no dialog is open.
 *
 * v1 only ships the "Add folder" dialog; additional IDs (e.g. `'confirmDelete'`,
 * `'settings'`) will be added here as new dialogs land. v1 forbids modal-over-
 * modal — only one dialog can be open at a time.
 */
export type DialogId =
  | 'addFolder'
  | 'settings'
  | 'claudeBoot'
  | 'newSession'
  | 'removeWorktree'
  | 'newWorktree'
  | 'newFolder'
  | 'openSubfolder'
  | 'renameFolder'
  | 'renameRepo'
  | 'memoryLocation'
  | null

/**
 * Identifier of a main-pane "takeover" view — the eight mutually-exclusive views
 * that cover the transcript, born from `VIEW_REGISTRY` below (T297/T299).
 * Adding a view is one entry in that registry plus `TakeoverHost.vue`'s
 * `VIEW_COMPONENTS`; there is no separate `ref`, `closeAllTakeovers()` line,
 * or `anyTakeoverOpen` clause left to remember.
 *
 * One branch is NOT yet folded in, though (T295): `App.vue`'s `showActiveView`
 * — the gate deciding whether `<TakeoverHost />` renders at all — is still a
 * hand-kept OR of one computed per view, so a new `ViewId` still needs a line
 * there too until the per-view onboarding gates it also carries
 * (`showRoadmap`/`showPrStack`/`showReview`) move into this registry.
 */
export type ViewId =
  | 'roadmap'
  | 'prStack'
  | 'cleanup'
  | 'usageDashboard'
  | 'systemMonitor'
  | 'review'
  | 'scheduler'
  | 'containers'

/**
 * The params each `ViewId` needs to render, keyed so that opening a view with
 * the wrong params shape is a compile error rather than an `any`-typed runtime
 * bug. `cleanup`/`usageDashboard`/`systemMonitor` take none: `cleanup`'s
 * optional scroll-to target keeps riding the separate `cleanupScrollTarget`
 * ref below, exactly as it always has — `CleanupView` reads that directly,
 * not a prop.
 */
export interface ViewParams {
  roadmap: { folderPath: string; repoLabel: string }
  prStack: { folderPath: string; repoLabel: string }
  review: { folderPath: string; cardSlug: string | null; prNumber: number | null }
  cleanup: Record<string, never>
  usageDashboard: Record<string, never>
  systemMonitor: Record<string, never>
  /** T295 — global, like `cleanup`/`usageDashboard`/`systemMonitor`: a worker
   * names its own folder, so the takeover itself has nothing to scope to. */
  scheduler: Record<string, never>
  /** T331 — global, like `cleanup`: every docker stack on the machine, not one folder's. */
  containers: Record<string, never>
}

/**
 * The `{ id, params }` shape `activeView` holds, correlated per `ViewId` via a
 * distributed mapped type — so `{ id: 'roadmap', params: { cardSlug: '' } }`
 * (review's shape on roadmap's id) is a compile error, not a silent `any`.
 */
export type ActiveView = { [K in ViewId]: { id: K; params: ViewParams[K] } }[ViewId]

/**
 * Identifier of a full-screen "takeover" view or Settings — the destinations a
 * `NotificationRecord.target` (T163) can point at. Deliberately scoped to
 * views that need no transient click-time context (a DOM rect, a per-session
 * menu) that a notification fired minutes ago couldn't supply — so this is
 * NOT every `DialogId`, just the ones a stored, serializable target can open.
 * Every main-pane view (`ViewId`) qualifies, plus `'settings'` — a dialog, not
 * a takeover, but the same deep-linkable shape.
 */
export type NavigableViewId = ViewId | 'settings' | 'mission'

/**
 * Params a `NavigableViewId` opener may need beyond the bare id, mirroring what
 * each underlying `open*` function actually takes. `folderPath`/`repoLabel`
 * are roadmap-only (a board is per-repo); `tab` is settings-only. Most views
 * (`cleanup`, `usageDashboard`, `systemMonitor`) take no params at all.
 */
export interface NavTargetParams {
  tab?: SettingsTabId
  folderPath?: string
  repoLabel?: string
  /** T164: the card whose intent the review pane renders, when one is bound. */
  cardSlug?: string
  /** BUG-173: the mission whose popover `'mission'` asks the pill to open. */
  missionId?: string
}

/** Which tab the Settings dialog should open to. Consumed by SettingsDialog. */
export type SettingsTabId =
  | 'general'
  | 'interceptor'
  | 'appearance'
  | 'startup'
  | 'claudeConfig'
  | 'endpoints'
  | 'push'
  | 'voice'
  | 'mcp'
  | 'skills'
  | 'mods'
  | 'memory'
  | 'hibernationPolicy'
  | 'usageHistory'
  | 'changelog'
  | 'claudeCode'
  | 'cleanup'
  | 'containers'
  | 'prStack'

/**
 * Right-click context menu state. The menu is anchored at viewport coordinates
 * `(x, y)` and targets a specific session. Only one menu can be open at a time.
 */
export interface MenuState {
  open: boolean
  /** Which session this menu targets. */
  sessionId: string | null
  /** Anchor coordinates (viewport). */
  x: number
  y: number
}

/**
 * Per-folder right-click context menu state. Mirrors `MenuState` but
 * targets a project by its absolute path (which is what
 * `userProjectsHide` / `userProjectsUnhide` IPC use for identification).
 * Only one folder menu open at a time; mutually exclusive with the
 * session menu via `closeAll`.
 */
export interface FolderMenuState {
  open: boolean
  /** Absolute path of the project this menu targets. */
  projectPath: string | null
  /** Anchor coordinates (viewport). */
  x: number
  y: number
}

/**
 * Sidebar Hidden-folders popover state. Anchors to the toolbar's Hidden
 * button's bounding rect (left-aligned, below) — same anchoring idiom the
 * old combined `⋯` menu used, now scoped to just this one disclosure
 * (2026-07-19 — the Expand/Collapse-all action moved to its own toolbar
 * button, `SidebarSectionMenu.vue` is gone).
 */
export interface SidebarHiddenPopoverState {
  open: boolean
  anchorRect: { left: number; top: number; right: number; bottom: number } | null
}

/**
 * Sidebar jump-palette state (T288). Unlike the Hidden popover it carries no
 * anchor rect: the palette is positioned INSIDE the sidebar `<aside>` (absolute,
 * `top: 46px`, 8px insets), so it tracks the sidebar's width and clipping for
 * free instead of being pinned to a snapshot of a button's viewport rect.
 */
export interface SidebarJumpPaletteState {
  open: boolean
}

/**
 * Hover preview state. The preview is anchored to the trigger row's bounding
 * rectangle and shows after a 400 ms delay (see `useHoverPreview`).
 */
export interface PreviewState {
  open: boolean
  /** The session this preview describes (mutually exclusive with `folderPath`). */
  sessionId: string | null
  /** The folder this preview describes (T52 — mutually exclusive with `sessionId`). */
  folderPath: string | null
  /** Anchor rect of the trigger row (viewport). */
  rect: { top: number; left: number; right: number; bottom: number } | null
}

/**
 * Command palette state — Cmd+K spotlight overlay. Mutually exclusive with
 * every other floating surface (it sits at the very top of the z-order; see
 * `design.md` §6 floating-surface table). v1 only needs `open`; future
 * variants (e.g. pre-filtered "switch project" mode) can extend this shape.
 */
export interface PaletteState {
  open: boolean
}

/**
 * Optional action button rendered on the trailing edge of a toast. The
 * `label` is either a translation key under `toast.actions.*` (resolved by
 * the component via `$t`) or a literal label string — both are accepted so
 * call sites can choose between localized standard actions and one-off
 * inline copy.
 *
 * `handler` runs when the user clicks the action. After the handler resolves
 * (or rejects — failures are swallowed; the caller is responsible for its
 * own error reporting) the toast is dismissed automatically by
 * `ToastStack.vue`'s `onAction` wrapper.
 */
export interface ToastAction {
  /** Localization key under `toast.actions.*` OR a literal label string. */
  label: string
  handler: () => void | Promise<void>
}

/**
 * A single toast notification. Toasts are visual, non-modal, bottom-right
 * pile; they live outside the four-floating-surface mutex (palette, dialog,
 * menu, preview) on purpose — a toast announcing "update ready" should not
 * be dismissed by opening the command palette, and vice versa.
 *
 * `title` and `description` are free text — callers are expected to
 * localize via `$t()` before pushing. The store does not interpret them.
 *
 * `kind` selects the 2px left-border accent (see `Toast.vue`): info →
 * accent, success → green, warning → warning, danger → red. The body of
 * the toast stays neutral (`bg-surface`) regardless of kind so the color
 * cue is consistent with the rest of the surface system.
 *
 * `action` is optional; when present the toast renders a small ghost-style
 * button on the right. `timeoutMs` is the auto-dismiss delay; 0 disables
 * auto-dismiss (used for sticky toasts that require an explicit action or
 * X click). Default is 6000 ms — see `pushToast` below.
 */
export interface Toast {
  id: string
  title: string
  description?: string
  kind: 'info' | 'success' | 'warning' | 'danger'
  action?: ToastAction
  /** Auto-dismiss after this many ms. 0 disables auto-dismiss. Default 6000. */
  timeoutMs?: number
  /**
   * The session this toast is about, if any (BUG-49). Threaded through to the
   * persisted `NotificationRecord` by `pushToast` so the Activity bell can
   * navigate on row click — without this, a persisted row has no way to know
   * what "go to session" even means, since `ToastAction.handler` is dropped
   * at persist time (see `NotificationAction` in `stores/notifications.ts`).
   */
  sessionId?: string
  /**
   * The view this toast should open on click, if any (T163) — the
   * view-targeted twin of `sessionId` above. Threaded through to the
   * persisted `NotificationRecord` the same way, so a notification with no
   * session to navigate to (e.g. the Reaper harvestable alert, or the
   * manifest "needs a per-card confirm" toast) still has a real destination
   * the Activity bell can open.
   */
  target?: { view: NavigableViewId } & NavTargetParams
}

/**
 * Pinia store coordinating the four floating surfaces — palette, dialog,
 * context menu, and hover preview — with strict **mutex semantics** (only
 * one is visible at a time). See `design.md` §6 (floating-surface z-order table) for
 * the layering contract.
 *
 * Mutex rules (highest priority first; opening a surface closes lower ones):
 * - Opening the palette closes everything else. It is the topmost surface.
 * - Opening the dialog closes the menu and the preview.
 * - Opening the menu closes the preview and the dialog (v1: no menu inside
 *   modal; revisit in v2).
 * - Opening the preview is silently no-op when a palette, dialog, or menu is
 *   already open — previews are decorative and must never overlay an
 *   interactive surface.
 * - `closeAll()` closes all four. Wired to the App-level Esc handler.
 *
 * The store is intentionally leaf-level: no IPC. The one exception is
 * `notifications.ts` (T83 S1) — `pushToast` funnels every persisted toast through
 * `useNotificationsStore().notify()`. That store imports nothing back, so this
 * stays a one-directional DAG edge, not a cycle.
 */
export const useUiStore = defineStore('ui', () => {
  const dialog = ref<DialogId>(null)

  // Target tab for the next Settings open. `null` = default (general). Read +
  // cleared by SettingsDialog on open; lets the notification-activate path deep-
  // link to the Claude Code tab without changing the generic openDialog mutex.
  const settingsTab = ref<SettingsTabId | null>(null)
  // Absolute path the per-folder "Claude Boot" dialog targets. Read by
  // `ClaudeBootDialog.vue` when `dialog === 'claudeBoot'`. Paired with the
  // generic `dialog` mutex the same way `settingsTab` pairs with `'settings'`.
  const claudeBootPath = ref<string | null>(null)
  // Folder path the New session dialog targets (launch-options before spawn).
  const newSessionPath = ref<string | null>(null)
  // Worktree the "Remove worktree" confirm dialog targets. Read by
  // `RemoveWorktreeDialog.vue` when `dialog === 'removeWorktree'`. Paired with
  // the generic `dialog` mutex the same way `newSessionPath` pairs with
  // `'newSession'`. `{ path, branch }` — the linked worktree's own path + branch.
  const removeWorktreeTarget = ref<{ path: string; branch: string } | null>(null)
  // Repo/folder path the "New worktree" dialog targets (dry-run plan + create).
  // Read by `NewWorktreeDialog.vue` when `dialog === 'newWorktree'`. Paired with
  // the generic `dialog` mutex the same way `newSessionPath` pairs with
  // `'newSession'`.
  const newWorktreePath = ref<string | null>(null)
  // Parent/root folder the "New folder" and "Open subfolder" dialogs target
  // (T69). Read by `NewFolderDialog.vue` / `OpenSubfolderDialog.vue` — both peer
  // the generic `dialog` mutex via `'newFolder'` / `'openSubfolder'`. Shared
  // because the two dialogs are mutually exclusive (one dialog open at a time).
  const folderActionPath = ref<string | null>(null)
  // Repo-group the "Rename repo" dialog targets (T88). Read by `RenameRepoDialog.vue`
  // when `dialog === 'renameRepo'`, paired with the generic `dialog` mutex like
  // `removeWorktreeTarget`. `repoId` keys the persisted per-repo alias; `derivedLabel`
  // is the basename-derived fallback shown as the subtitle + used on reset.
  const renameRepoTarget = ref<{ groupKey: string; derivedLabel: string } | null>(null)
  const menu = ref<MenuState>({ open: false, sessionId: null, x: 0, y: 0 })
  const folderMenu = ref<FolderMenuState>({ open: false, projectPath: null, x: 0, y: 0 })
  const preview = ref<PreviewState>({ open: false, sessionId: null, folderPath: null, rect: null })
  const palette = ref<PaletteState>({ open: false })
  const sidebarHiddenPopover = ref<SidebarHiddenPopoverState>({ open: false, anchorRect: null })
  const sidebarJumpPalette = ref<SidebarJumpPaletteState>({ open: false })

  // NOTE (T83 S0): the Approval Inbox used to be a first-level floating surface
  // here (`inbox: { open }`). It is now the Inbox rail — a persistent fourth
  // COLUMN, so its state is layout, not mutex (`stores/layout.ts`
  // `inboxRailState`). Nothing in this store may close, suppress, or otherwise
  // "own" it: it is always on screen, so putting it back in the mutex would mean
  // every dialog/palette/menu open silently hides the approval queue.

  // Main-pane "takeover" views (T80 S1 §4, T47 P6 S2, T127 S2, Reaper PR3, T198,
  // T164, T295) — seven views that replace the transcript area, mutually exclusive with
  // each other and OUTSIDE the floating-surface mutex above. Before T297/T299
  // these were six independent refs (`roadmap`, `usageDashboardOpen`,
  // `systemMonitorOpen`, `cleanupOpen`, `prStack`, `review`), each closed by
  // hand inside `closeAllTakeovers()` — a list that silently rotted the moment
  // a sixth view landed (it did: T198 had to touch all four). `activeView` is
  // now the ONE piece of state; `VIEW_REGISTRY` is the one place a view's
  // scope (drives the per-repo/per-folder toggle rule below) and close-edge
  // hook are declared. A view absent from this registry has no way to reach
  // the screen — see `App.vue`'s `<TakeoverHost />` and design.md §6 "Takeover
  // dismissal".
  //
  // Deliberately holds no Vue `Component` reference: every one of the six
  // components already imports `useUiStore` (they read their own params
  // straight off the backward-compat computed getters below, e.g.
  // `ui.roadmap.folderPath`), so importing them back here would open a
  // store↔component import cycle — exactly what `lib/pane-components.ts`'s own
  // header comment calls out avoiding. `TakeoverHost.vue` (a leaf — nothing
  // imports it) owns the `ViewId → Component` map instead.
  const activeView = ref<ActiveView | null>(null)

  interface ViewRegistryEntry {
    /**
     * `'repo'`/`'folder'` entries compare `params.folderPath` in `toggleView`
     * (below): clicking the entry-point button while ANOTHER repo's/folder's
     * view is open switches instead of closing. `'global'` entries have no
     * folder to compare — their toggle is a plain open/close flip.
     */
    scope: 'global' | 'repo' | 'folder'
    /** i18n key for the view's header title (consumed by a future shared shell — T300/U3). */
    titleKey: string
    /**
     * Fired on the CLOSE edge only — via `closeAllTakeovers()`, never from
     * `openView` — so opening this view does not immediately dispose
     * whatever the previous close edge was about to tear down.
     */
    onClose?: () => void
  }

  const VIEW_REGISTRY: Record<ViewId, ViewRegistryEntry> = {
    roadmap: { scope: 'repo', titleKey: 'roadmap.title' },
    prStack: { scope: 'repo', titleKey: 'prStack.title' },
    cleanup: { scope: 'global', titleKey: 'cleanup.title' },
    usageDashboard: { scope: 'global', titleKey: 'usageDashboard.title' },
    systemMonitor: { scope: 'global', titleKey: 'systemMonitor.title' },
    scheduler: { scope: 'global', titleKey: 'scheduler.title' },
    containers: { scope: 'global', titleKey: 'containers.title' },
    // T245 AC-6: the review companion is scoped to the review, so the review
    // ending is what disposes it — see `fireReviewClosed` below.
    review: { scope: 'folder', titleKey: 'review.title', onClose: () => fireReviewClosed() }
  }

  /**
   * Closes whichever main-pane takeover is open. One assignment plus the
   * leaving entry's `onClose` — there is no per-view list left to rot.
   */
  function closeAllTakeovers(): void {
    const leaving = activeView.value ? VIEW_REGISTRY[activeView.value.id] : null
    activeView.value = null
    leaving?.onClose?.()
  }

  /**
   * Subscribers notified when the Review takeover closes (T245 AC-6).
   *
   * A registration seam rather than a direct `useHelpersStore()` call: the
   * helpers store already imports THIS one, so reaching back the other way at
   * module scope would close an import cycle. Same shape as
   * `helpers.registerRemoveHandler` / `sessions.registerMigrateHandler`.
   *
   * Deliberately fired on the CLOSE edge only, via `VIEW_REGISTRY.review.onClose`
   * inside `closeAllTakeovers()` — so opening the review, which routes through
   * `closeAllTakeovers` like every other opener, does not immediately dispose
   * the pane it is about to host.
   */
  const reviewClosedHandlers = new Set<() => void>()

  function registerReviewClosedHandler(fn: () => void): () => void {
    reviewClosedHandlers.add(fn)
    return () => reviewClosedHandlers.delete(fn)
  }

  function fireReviewClosed(): void {
    for (const fn of reviewClosedHandlers) fn()
  }

  /**
   * Opens `id`, closing whatever else is open (mutex) — including this same
   * view, so re-opening it fires its own close edge first (see
   * `fireReviewClosed` above). Private: the seven named `open*` wrappers below
   * are the public surface, so the ~47 call sites outside this store never
   * see the generic form (and so this identifier never collides with the
   * `open[A-Z]` view-opener tripwire in `tests/folder-selection.test.ts`).
   */
  function openView<K extends ViewId>(id: K, params: ViewParams[K]): void {
    // Mutex: a main-pane view supersedes every floating surface too.
    closeDialog()
    closeMenu()
    closeFolderMenu()
    closePreview()
    closeSidebarHiddenPopover()
    closeSidebarJumpPalette()
    closePalette()
    closeAllTakeovers()
    activeView.value = { id, params } as ActiveView
  }

  /** Closes `id` only if it is the one currently open — a no-op otherwise. */
  function closeView(id: ViewId): void {
    if (activeView.value?.id === id) closeAllTakeovers()
  }

  /**
   * Toggle semantics for a view's entry-point button (design.md §6 "Takeover
   * dismissal"). `'repo'`/`'folder'`-scoped views compare `params.folderPath`:
   * the same folder closes, a different one switches. `'global'`-scoped views
   * have nothing to compare — already-open always closes.
   */
  function toggleView<K extends ViewId>(id: K, params: ViewParams[K]): void {
    const current = activeView.value
    if (current?.id === id) {
      const entry = VIEW_REGISTRY[id]
      const samePath =
        entry.scope === 'global' ||
        (params as { folderPath?: string }).folderPath ===
          (current.params as { folderPath?: string }).folderPath
      if (samePath) {
        closeAllTakeovers()
        return
      }
    }
    openView(id, params)
  }

  /** True while ANY main-pane takeover covers the transcript. */
  const anyTakeoverOpen = computed<boolean>(() => activeView.value !== null)

  /**
   * The active takeover's i18n title key, straight off `VIEW_REGISTRY` — the
   * one thing `TakeoverShell` (T300/U3) needs from the registry that isn't
   * already on `activeView` itself. `null` when nothing is open.
   */
  const activeViewTitleKey = computed<string | null>(() =>
    activeView.value ? VIEW_REGISTRY[activeView.value.id].titleKey : null
  )

  /**
   * Backward-compatible view onto `activeView` for the Roadmap board's own
   * reads (`ui.roadmap.folderPath`) and the pre-T299 test suite. Computed, not
   * a ref: `activeView` is the only writable takeover state now (AC-1) — this
   * is a read-only projection of it, not a second source of truth.
   */
  const roadmap = computed<{ open: boolean; folderPath: string | null; repoLabel: string | null }>(
    () => {
      const v = activeView.value
      if (v?.id === 'roadmap')
        return { open: true, folderPath: v.params.folderPath, repoLabel: v.params.repoLabel }
      return { open: false, folderPath: null, repoLabel: null }
    }
  )

  /** Same projection as `roadmap` above, for the PR Stack Canvas. */
  const prStack = computed<{ open: boolean; folderPath: string | null; repoLabel: string | null }>(
    () => {
      const v = activeView.value
      if (v?.id === 'prStack')
        return { open: true, folderPath: v.params.folderPath, repoLabel: v.params.repoLabel }
      return { open: false, folderPath: null, repoLabel: null }
    }
  )

  /** Same projection as `roadmap` above, for the Review pane. */
  const review = computed<{
    open: boolean
    folderPath: string | null
    cardSlug: string | null
    prNumber: number | null
  }>(() => {
    const v = activeView.value
    if (v?.id === 'review') {
      return {
        open: true,
        folderPath: v.params.folderPath,
        cardSlug: v.params.cardSlug,
        prNumber: v.params.prNumber
      }
    }
    return { open: false, folderPath: null, cardSlug: null, prNumber: null }
  })

  /** Same projection as `roadmap` above, for the three params-less global views. */
  const usageDashboardOpen = computed(() => activeView.value?.id === 'usageDashboard')
  const systemMonitorOpen = computed(() => activeView.value?.id === 'systemMonitor')
  const cleanupOpen = computed(() => activeView.value?.id === 'cleanup')
  const schedulerOpen = computed(() => activeView.value?.id === 'scheduler')
  const containersOpen = computed(() => activeView.value?.id === 'containers')

  /**
   * Repo path to scroll `CleanupView` to on open (Reaper PR4, repo-group
   * context-menu entry). Cosmetic scroll-to-group only — no filter prop
   * (YAGNI per plan T11). `CleanupView` reads and clears it once consumed.
   */
  const cleanupScrollTarget = ref<string | null>(null)

  /**
   * Active toast stack. Bottom-right pile rendered by `ToastStack.vue`. Order
   * is insertion-order: oldest first; `ToastStack` uses `flex-direction:
   * column-reverse` so the newest entry visually piles at the top of the
   * stack while accessibility order (DOM order) stays oldest→newest.
   *
   * Toasts are NOT modal — `closeAll()` (the App-level Esc handler) leaves
   * them alone on purpose. They're cleared individually via `dismissToast`
   * (X button, action click, or auto-timeout).
   */
  const toasts = ref<Toast[]>([])

  /**
   * Cross-component signal asking the Topbar to focus its inline-rename
   * contenteditable. Flipped to `true` by `triggerRenameFocus()` (which the
   * `session.rename` shortcut calls in `App.vue`), the Topbar watches it,
   * focuses its title element, and resets the flag back to `false` to keep
   * the signal one-shot.
   *
   * This is the lightest possible "request" channel between two components
   * that have no parent/child relationship — a Pinia ref + watcher beats
   * threading callbacks through props or emit chains.
   */
  const requestRenameFocus = ref(false)

  function triggerRenameFocus(): void {
    requestRenameFocus.value = true
  }

  function openDialog(id: DialogId): void {
    // Mutex: a dialog supersedes menu, preview, palette, and sidebar menu.
    menu.value = { open: false, sessionId: null, x: 0, y: 0 }
    preview.value = { open: false, sessionId: null, folderPath: null, rect: null }
    palette.value = { open: false }
    sidebarHiddenPopover.value = { open: false, anchorRect: null }
    sidebarJumpPalette.value = { open: false }
    dialog.value = id
  }

  function closeDialog(): void {
    dialog.value = null
  }

  function openSettings(tab?: SettingsTabId): void {
    settingsTab.value = tab ?? null
    openDialog('settings')
  }

  /** Open the per-folder Claude Boot dialog for `folderPath`. */
  function openClaudeBoot(folderPath: string): void {
    claudeBootPath.value = folderPath
    openDialog('claudeBoot')
  }

  /** Open the New session launch dialog for `folderPath`. */
  function openNewSession(folderPath: string): void {
    newSessionPath.value = folderPath
    openDialog('newSession')
  }

  /** Open the destructive "Remove worktree" confirm dialog for a linked worktree. */
  function openRemoveWorktree(path: string, branch: string): void {
    removeWorktreeTarget.value = { path, branch }
    openDialog('removeWorktree')
  }

  /** Open the "New worktree" plan/create dialog for a git repo folder. */
  function openNewWorktree(path: string): void {
    newWorktreePath.value = path
    openDialog('newWorktree')
  }

  /** Open the "New folder" dialog (create + pin a subfolder inside `path`). */
  function openNewFolder(path: string): void {
    folderActionPath.value = path
    openDialog('newFolder')
  }

  /** Open the "Open subfolder" picker (list subfolders of `path` → pin one). */
  function openOpenSubfolder(path: string): void {
    folderActionPath.value = path
    openDialog('openSubfolder')
  }

  /** Open the "Rename folder" dialog for `path` (T52). */
  function openRenameFolder(path: string): void {
    folderActionPath.value = path
    openDialog('renameFolder')
  }

  /** Open the "Rename group" dialog for a sidebar group, by namespaced key (T88). */
  function openRenameRepo(groupKey: string, derivedLabel: string): void {
    renameRepoTarget.value = { groupKey, derivedLabel }
    openDialog('renameRepo')
  }

  /** Open the "Store this project's memory in…" override dialog for `path` (T89). */
  function openMemoryLocation(path: string): void {
    folderActionPath.value = path
    openDialog('memoryLocation')
  }

  function openMenu(opts: { sessionId: string; x: number; y: number }): void {
    // Mutex: a menu supersedes preview, dialog, palette, sidebar menu, and
    // the folder menu (v1 forbids menu inside modal).
    preview.value = { open: false, sessionId: null, folderPath: null, rect: null }
    dialog.value = null
    palette.value = { open: false }
    sidebarHiddenPopover.value = { open: false, anchorRect: null }
    sidebarJumpPalette.value = { open: false }
    folderMenu.value = { open: false, projectPath: null, x: 0, y: 0 }
    menu.value = { open: true, sessionId: opts.sessionId, x: opts.x, y: opts.y }
  }

  function closeMenu(): void {
    menu.value = { open: false, sessionId: null, x: 0, y: 0 }
  }

  /**
   * Open the per-folder context menu (right-click on a project row in the
   * sidebar). Mutex: closes everything else first to maintain the
   * single-menu-open contract. The session menu, sidebar section menu,
   * and folder menu are all mutually exclusive — only one can be visible
   * at a time.
   */
  function openFolderMenu(opts: { projectPath: string; x: number; y: number }): void {
    preview.value = { open: false, sessionId: null, folderPath: null, rect: null }
    dialog.value = null
    palette.value = { open: false }
    sidebarHiddenPopover.value = { open: false, anchorRect: null }
    sidebarJumpPalette.value = { open: false }
    menu.value = { open: false, sessionId: null, x: 0, y: 0 }
    folderMenu.value = { open: true, projectPath: opts.projectPath, x: opts.x, y: opts.y }
  }

  function closeFolderMenu(): void {
    folderMenu.value = { open: false, projectPath: null, x: 0, y: 0 }
  }

  function openPreview(opts: { sessionId: string; rect: PreviewState['rect'] }): void {
    // Mutex: preview is lowest priority — never overlay a palette, dialog,
    // menu, or sidebar menu.
    if (palette.value.open) return
    if (dialog.value !== null) return
    if (menu.value.open) return
    if (sidebarHiddenPopover.value.open) return
    preview.value = { open: true, sessionId: opts.sessionId, folderPath: null, rect: opts.rect }
  }

  /** Folder-preview twin of {@link openPreview} (T52). Same lowest-priority mutex. */
  function openFolderPreview(opts: { folderPath: string; rect: PreviewState['rect'] }): void {
    if (palette.value.open) return
    if (dialog.value !== null) return
    if (menu.value.open) return
    if (sidebarHiddenPopover.value.open) return
    preview.value = { open: true, sessionId: null, folderPath: opts.folderPath, rect: opts.rect }
  }

  function closePreview(): void {
    preview.value = { open: false, sessionId: null, folderPath: null, rect: null }
  }

  /**
   * Open the command palette. The palette is the topmost floating surface
   * (above dialogs) — opening it closes every other surface so the user
   * always sees a clean overlay over the bare app shell.
   */
  function openPalette(): void {
    closeDialog()
    closeMenu()
    closePreview()
    closeSidebarHiddenPopover()
    closeSidebarJumpPalette()
    palette.value = { open: true }
  }

  function closePalette(): void {
    palette.value = { open: false }
  }

  /**
   * Open the sidebar Hidden-folders popover. Closes every other floating
   * surface first per the existing mutex contract (palette, dialog, session
   * menu, preview). Anchor rect comes from the trigger button's
   * `getBoundingClientRect()`.
   */
  function openSidebarHiddenPopover(
    anchorRect: NonNullable<SidebarHiddenPopoverState['anchorRect']>
  ): void {
    closeDialog()
    closeMenu()
    closePreview()
    closePalette()
    sidebarJumpPalette.value = { open: false }
    sidebarHiddenPopover.value = { open: true, anchorRect }
  }

  function closeSidebarHiddenPopover(): void {
    sidebarHiddenPopover.value = { open: false, anchorRect: null }
  }

  /**
   * Open the sidebar jump palette (T288) — the search button's surface, anchored
   * under the one-line header. Peer of the Hidden popover in the floating mutex:
   * opening it closes every other surface, including that one.
   */
  function openSidebarJumpPalette(): void {
    closeDialog()
    closeMenu()
    closeFolderMenu()
    closePreview()
    closePalette()
    closeSidebarHiddenPopover()
    sidebarJumpPalette.value = { open: true }
  }

  function closeSidebarJumpPalette(): void {
    sidebarJumpPalette.value = { open: false }
  }

  /**
   * Open the Roadmap Kanban board for a folder (T80 §4). Not part of the floating
   * mutex — it is a main-pane view. Thin wrapper over `openView` (T297/T299):
   * kept as its own named export so the ~47 call sites outside this store never
   * change, and so the per-view JSDoc a caller hovers stays where it always was.
   */
  function openRoadmap(folderPath: string, repoLabel: string): void {
    openView('roadmap', { folderPath, repoLabel })
  }

  function closeRoadmap(): void {
    closeView('roadmap')
  }

  function openUsageDashboard(): void {
    openView('usageDashboard', {})
  }

  function closeUsageDashboard(): void {
    closeView('usageDashboard')
  }

  /** Open the System Monitor takeover (T127 S2). Mutually exclusive with the board and the Usage Dashboard. */
  function openSystemMonitor(): void {
    openView('systemMonitor', {})
  }

  function closeSystemMonitor(): void {
    closeView('systemMonitor')
  }

  /** Open the Scheduler takeover (T291/T295). Mutually exclusive with the other main-pane views. */
  function openScheduler(): void {
    openView('scheduler', {})
  }

  function closeScheduler(): void {
    closeView('scheduler')
  }

  /**
   * Open the Cleanup takeover (Reaper PR3). Mutually exclusive with the other
   * main-pane views. `scrollToRepoPath` (Reaper PR4, repo-group context-menu
   * entry) asks `CleanupView` to scroll to that repo's group once mounted —
   * via the separate `cleanupScrollTarget` ref (not a registered param: it's
   * consumed once and cleared by `CleanupView` itself, not held for the life
   * of the view).
   */
  function openCleanup(scrollToRepoPath?: string): void {
    cleanupScrollTarget.value = scrollToRepoPath ?? null
    openView('cleanup', {})
  }

  function closeCleanup(): void {
    closeView('cleanup')
  }

  /** Open the Containers takeover (T331). Global, like Cleanup: no params. */
  function openContainers(): void {
    openView('containers', {})
  }

  function closeContainers(): void {
    closeView('containers')
  }

  /**
   * Open the PR Stack Canvas for a folder (T198). Per repo, like `openRoadmap`
   * — `folderPath` anchors it to a folder whose repo owns the PRs, `repoLabel`
   * is the header title. Any worktree of the repo opens the same canvas.
   */
  function openPrStack(folderPath: string, repoLabel: string): void {
    openView('prStack', { folderPath, repoLabel })
  }

  function closePrStack(): void {
    closeView('prStack')
  }

  /**
   * Open the Review takeover for a folder (T164). `cardSlug` is optional: with
   * one the intent rail renders that card's body and the header offers Close /
   * Bounce back; without one the pane still shows the full branch-vs-base diff
   * and its evidence, which is the point of anchoring on the branch (PRD D2).
   */
  function openReview(
    folderPath: string,
    cardSlug?: string | null,
    prNumber?: number | null
  ): void {
    openView('review', { folderPath, cardSlug: cardSlug ?? null, prNumber: prNumber ?? null })
  }

  function closeReview(): void {
    closeView('review')
  }

  /**
   * Toolbar/footer twins of the `open*` takeover functions: the button that
   * opened a view also closes it, so a persistent affordance behaves like the
   * toggle it visually is (the Topbar's own sidebar/helper buttons already do).
   *
   * Deliberately NOT used by the menu entries (`FolderMenu`, `SessionMenu`,
   * `RepoGroupHeader`) or by `openNavigableView` — a menu item labelled
   * "Roadmap board" and a notification that navigates to a view must OPEN it,
   * never close whatever happens to be on screen.
   *
   * Each is a thin wrapper over `toggleView` (T297/T299), which owns the
   * shared per-repo/per-folder switch-vs-close rule via the registry's
   * `scope` — see `toggleView`'s own doc comment.
   */
  function toggleRoadmap(folderPath: string, repoLabel: string): void {
    toggleView('roadmap', { folderPath, repoLabel })
  }

  function togglePrStack(folderPath: string, repoLabel: string): void {
    toggleView('prStack', { folderPath, repoLabel })
  }

  function toggleReview(folderPath: string, cardSlug?: string | null): void {
    toggleView('review', { folderPath, cardSlug: cardSlug ?? null, prNumber: null })
  }

  function toggleUsageDashboard(): void {
    toggleView('usageDashboard', {})
  }

  function toggleSystemMonitor(): void {
    toggleView('systemMonitor', {})
  }

  function toggleScheduler(): void {
    toggleView('scheduler', {})
  }

  function toggleContainers(): void {
    toggleView('containers', {})
  }

  /**
   * Not a plain `toggleView` call: `openCleanup`'s `scrollToRepoPath` side
   * effect (the `cleanupScrollTarget` ref) only makes sense on the OPEN edge,
   * so this stays hand-written rather than folding into the generic toggle.
   */
  function toggleCleanup(scrollToRepoPath?: string): void {
    if (activeView.value?.id === 'cleanup') {
      closeAllTakeovers()
      return
    }
    openCleanup(scrollToRepoPath)
  }

  /**
   * Central dispatch for `NavigableViewId` → the concrete `open*` call
   * (T163). Reuses the existing openers so their sibling-close/mutex logic
   * never gets duplicated — this is the ONLY place that maps a stored,
   * serializable `target` back to app state. `viewOpeners`, the hand-kept
   * id → opener Record this used to hold, is gone (T297/T299 "one registry,
   * not two") — this now switches directly on `NavigableViewId`, one arm per
   * id, each still just resolving the notification's loosely-typed
   * `NavTargetParams` into the concrete `open*` call.
   */
  function openNavigableView(view: NavigableViewId, params?: NavTargetParams): void {
    switch (view) {
      case 'cleanup':
        openCleanup()
        return
      case 'roadmap': {
        if (!params?.folderPath) return
        const label =
          params.repoLabel ??
          params.folderPath.replace(/\/+$/, '').split('/').pop() ??
          params.folderPath
        openRoadmap(params.folderPath, label)
        return
      }
      case 'settings':
        openSettings(params?.tab)
        return
      case 'usageDashboard':
        openUsageDashboard()
        return
      case 'systemMonitor':
        openSystemMonitor()
        return
      case 'scheduler':
        openScheduler()
        return
      case 'containers':
        openContainers()
        return
      case 'prStack': {
        if (!params?.folderPath) return
        openPrStack(
          params.folderPath,
          params.repoLabel ?? params.folderPath.split('/').pop() ?? params.folderPath
        )
        return
      }
      case 'review': {
        if (!params?.folderPath) return
        openReview(params.folderPath, params.cardSlug ?? null)
        return
      }
      case 'mission': {
        // Not a takeover: select the owner first (the caller's job), then ask
        // the missions store to have the pill open this mission's popover.
        if (!params?.missionId) return
        useMissionsStore().requestPopover(params.missionId)
        return
      }
    }
  }

  /**
   * Close every floating surface. Used by the App-level Esc handler.
   *
   * Note: this does NOT clear `toasts` — toasts are non-modal and Esc should
   * not wipe a "Restart now" prompt the user hasn't seen yet. Toasts time
   * out on their own (default 6 s) or are dismissed via the X / action
   * button.
   *
   * It also does NOT touch the Inbox rail (T83 S0). Esc means "dismiss what's
   * covering the app", and the rail covers nothing — it's a column. Closing the
   * approval queue on Esc would hide a blocked session from the operator.
   */
  function closeAll(): void {
    dialog.value = null
    menu.value = { open: false, sessionId: null, x: 0, y: 0 }
    folderMenu.value = { open: false, projectPath: null, x: 0, y: 0 }
    preview.value = { open: false, sessionId: null, folderPath: null, rect: null }
    palette.value = { open: false }
    sidebarHiddenPopover.value = { open: false, anchorRect: null }
    sidebarJumpPalette.value = { open: false }
    // The takeovers are main-pane views (not floating surfaces), but Esc should
    // still dismiss them back to the transcript — closeAll is the App-level Esc
    // handler. Via the shared helper, not a hand-kept list: the hand-kept one
    // had already rotted (it never learned about the PR Stack, T198).
    closeAllTakeovers()
  }

  /**
   * Push a new toast onto the stack. Returns the assigned id so the caller
   * can dismiss it programmatically (e.g. when the underlying condition
   * disappears before the user acted on it).
   *
   * Auto-dismiss: the store schedules its own `setTimeout` per toast based
   * on `timeoutMs` (default 6000). `Toast.vue` is intentionally stateless
   * about timing — keeping the timer here means HMR-induced re-renders of
   * the component don't reset visible toasts back to "fresh", and the
   * store remains the single source of truth for lifecycle.
   *
   * `timeoutMs: 0` disables auto-dismiss; use it for toasts that MUST be
   * dismissed explicitly (action toasts where missing the action defeats
   * the purpose, e.g. "Restart now to install update").
   *
   * `persist` (default `true`) also funnels the toast into the notification
   * history (T83 S1, `stores/notifications.ts`) — the durable log that survives
   * past the toast's own auto-dismiss. Pass `persist: false` for trivia that
   * isn't worth a history row (e.g. "copied to clipboard").
   */
  function pushToast(t: Omit<Toast, 'id'> & { persist?: boolean }): string {
    const { persist, ...toast } = t
    const id = crypto.randomUUID()
    toasts.value.push({ id, ...toast })
    const ttl = toast.timeoutMs ?? 6000
    if (ttl > 0) setTimeout(() => dismissToast(id), ttl)
    if (persist !== false) {
      useNotificationsStore().notify({
        ts: Date.now(),
        source: 'app',
        kind: toast.kind,
        title: toast.title,
        description: toast.description,
        sessionId: toast.sessionId,
        target: toast.target,
        action: toast.action ? { label: toast.action.label } : undefined
      })
    }
    return id
  }

  /**
   * Remove a toast by id. No-op if the id is not in the stack (already
   * dismissed, or never existed). Called by the auto-dismiss timer, the X
   * button, and `ToastStack.vue`'s action wrapper after the handler runs.
   */
  function dismissToast(id: string): void {
    const idx = toasts.value.findIndex((t) => t.id === id)
    if (idx >= 0) toasts.value.splice(idx, 1)
  }

  return {
    dialog,
    settingsTab,
    claudeBootPath,
    newSessionPath,
    removeWorktreeTarget,
    newWorktreePath,
    folderActionPath,
    renameRepoTarget,
    menu,
    folderMenu,
    preview,
    palette,
    sidebarHiddenPopover,
    sidebarJumpPalette,
    activeView,
    activeViewTitleKey,
    roadmap,
    usageDashboardOpen,
    systemMonitorOpen,
    cleanupOpen,
    schedulerOpen,
    containersOpen,
    prStack,
    review,
    anyTakeoverOpen,
    cleanupScrollTarget,
    toasts,
    requestRenameFocus,
    openDialog,
    openSettings,
    openClaudeBoot,
    openNewSession,
    openRemoveWorktree,
    openNewWorktree,
    openNewFolder,
    openOpenSubfolder,
    openRenameFolder,
    openRenameRepo,
    openMemoryLocation,
    closeDialog,
    openMenu,
    closeMenu,
    openFolderMenu,
    closeFolderMenu,
    openPreview,
    openFolderPreview,
    closePreview,
    openPalette,
    closePalette,
    openSidebarHiddenPopover,
    closeSidebarHiddenPopover,
    openSidebarJumpPalette,
    closeSidebarJumpPalette,
    openRoadmap,
    closeRoadmap,
    openUsageDashboard,
    closeUsageDashboard,
    openSystemMonitor,
    closeSystemMonitor,
    openScheduler,
    closeScheduler,
    openCleanup,
    closeCleanup,
    openContainers,
    closeContainers,
    openPrStack,
    closePrStack,
    openReview,
    closeReview,
    registerReviewClosedHandler,
    closeAllTakeovers,
    toggleRoadmap,
    togglePrStack,
    toggleReview,
    toggleUsageDashboard,
    toggleSystemMonitor,
    toggleScheduler,
    toggleCleanup,
    toggleContainers,
    openNavigableView,
    closeAll,
    pushToast,
    dismissToast,
    triggerRenameFocus
  }
})
