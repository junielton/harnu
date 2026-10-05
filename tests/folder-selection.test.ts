// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * T212 — the folder is a selectable entity. `selectedId` (a session) and
 * `selectedFolderPath` (a folder) are mutually exclusive BY CONSTRUCTION: the
 * invariant lives in the setters, not in every caller. `activeFolderPath` is the
 * single source every folder-scoped action reads, so those actions stop
 * depending on a session existing at all.
 */

function seedFolder(store: ReturnType<typeof useSessionsStore>): void {
  store.folders.push({
    path: '/repo/alpha',
    alias: 'alpha',
    expanded: false,
    sessions: [
      {
        sessionId: 's1',
        projectPath: '/repo/alpha',
        summary: 'First',
        firstPrompt: 'First',
        modified: new Date().toISOString()
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('folder selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('selecting a folder clears the session selection', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')
    expect(store.selectedId).toBe('s1')

    store.selectFolder('/repo/alpha')

    expect(store.selectedFolderPath).toBe('/repo/alpha')
    expect(store.selectedId).toBeNull()
  })

  it('selecting a session clears the folder selection', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')

    store.select('s1')

    expect(store.selectedId).toBe('s1')
    expect(store.selectedFolderPath).toBeNull()
  })

  it('clearSelection clears both', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')
    store.clearSelection()
    expect(store.selectedFolderPath).toBeNull()
    expect(store.selectedId).toBeNull()
  })

  it('activeFolderPath resolves from the folder selection first', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')
    expect(store.activeFolderPath).toBe('/repo/alpha')
  })

  it("activeFolderPath falls back to the selected session's folder", () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')
    expect(store.activeFolderPath).toBe('/repo/alpha')
  })

  it('activeFolderPath is null with nothing selected', () => {
    const store = useSessionsStore()
    seedFolder(store)
    expect(store.activeFolderPath).toBeNull()
  })

  it('closing the selected session falls back to its folder, not to nothing', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')

    store.closeSession('s1')

    expect(store.selectedId).toBeNull()
    expect(store.selectedFolderPath).toBe('/repo/alpha')
  })

  /**
   * BUG — "+ New session" from the Folder View left the folder selected, so the
   * `FolderView` branch (which sits ABOVE `TerminalPane` in App.vue's chain)
   * kept the main pane and the freshly-minted session never showed. Minting a
   * session is a focus intent: it must clear the folder selection, exactly like
   * `select()` does.
   */
  it('creating a new session clears the folder selection', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')

    const id = store.createNewSession('/repo/alpha')

    expect(id).toBeTruthy()
    expect(store.selectedId).toBe(id)
    expect(store.selectedFolderPath).toBeNull()
  })

  it('reusing the existing live synthetic also clears the folder selection', () => {
    const store = useSessionsStore()
    seedFolder(store)
    const first = store.createNewSession('/repo/alpha')
    store.selectFolder('/repo/alpha')

    // Dedupe path: a second "+ New session" surfaces the same synthetic.
    const again = store.createNewSession('/repo/alpha')

    expect(again).toBe(first)
    expect(store.selectedId).toBe(first)
    expect(store.selectedFolderPath).toBeNull()
  })

  it('forking a session clears the folder selection', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')

    const forkId = store.createForkedSession('s1')

    expect(forkId).toBeTruthy()
    expect(store.selectedId).toBe(forkId)
    expect(store.selectedFolderPath).toBeNull()
  })

  it('selecting a folder never destroys a running session', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')

    store.selectFolder('/repo/alpha')

    // The session row is still in the model — a folder selection detaches the
    // terminal (TerminalPane's `detachCurrent`), it never disposes the PTY.
    expect(store.folders[0].sessions.some((s) => s.sessionId === 's1')).toBe(true)
  })
})

describe('folder selection from the keyboard cursor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * T212 follow-up. The spec says "Enter on a focused folder row does the same
   * as a click", but `cursorActivate` only called `toggleFolder`, so the whole
   * Folder View was unreachable from the arrow-key cursor — which IS the
   * sidebar's keyboard navigation (the visual focus ring is not DOM focus, so
   * the row's native <button> Enter never fires on that path).
   */
  it('Enter on a folder cursor selects the folder and expands it', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.folders[0].expanded = false

    store.cursorDown() // land the cursor on the first row (the folder)
    store.cursorActivate()

    expect(store.selectedFolderPath).toBe('/repo/alpha')
    expect(store.folders[0].expanded).toBe(true)
  })

  it('a second Enter collapses the folder but keeps it selected', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.folders[0].expanded = false

    store.cursorDown()
    store.cursorActivate()
    store.cursorActivate()

    expect(store.folders[0].expanded).toBe(false)
    expect(store.selectedFolderPath).toBe('/repo/alpha')
  })

  /**
   * The spec's §F regression, asserted at the seam that actually governs
   * disposal: `closeSession` fires the registered close handlers, and it is
   * TerminalPane's handler that calls `ptyDestroy`. A folder selection must
   * never reach that path.
   */
  it('selecting a folder fires no close handler, so no PTY teardown is triggered', () => {
    const store = useSessionsStore()
    seedFolder(store)
    const onClose = vi.fn()
    store.registerCloseHandler(onClose)
    store.select('s1')

    store.selectFolder('/repo/alpha')

    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * BUG-102 — minting a session is a focus intent. `closeAllTakeovers()` has
 * exactly ONE caller (`select()`), but the mint sites used to write
 * `selectedId.value` directly, so a freshly minted session stayed invisible
 * behind whichever of the six main-pane takeovers was open. Every human-intent
 * mint site now routes through `select()`, which closes all six in one place.
 *
 * `openerName` is the literal key `stores/ui.ts` exports for this opener —
 * typed as `keyof UiStore` so a rename fails `typecheck` here too, not just
 * silently rots. T298's tripwire tests (below) also key off this table: it is
 * the single canonical list of the seven main-pane view openers.
 */
type UiStore = ReturnType<typeof useUiStore>

const TAKEOVERS: { name: string; openerName: keyof UiStore; open: (ui: UiStore) => void }[] = [
  {
    name: 'roadmap board',
    openerName: 'openRoadmap',
    open: (ui) => ui.openRoadmap('/repo/alpha', 'alpha')
  },
  {
    name: 'PR Stack canvas',
    openerName: 'openPrStack',
    open: (ui) => ui.openPrStack('/repo/alpha', 'alpha')
  },
  { name: 'cleanup', openerName: 'openCleanup', open: (ui) => ui.openCleanup() },
  {
    name: 'usage dashboard',
    openerName: 'openUsageDashboard',
    open: (ui) => ui.openUsageDashboard()
  },
  {
    name: 'system monitor',
    openerName: 'openSystemMonitor',
    open: (ui) => ui.openSystemMonitor()
  },
  { name: 'review', openerName: 'openReview', open: (ui) => ui.openReview('/repo/alpha') },
  { name: 'scheduler', openerName: 'openScheduler', open: (ui) => ui.openScheduler() },
  { name: 'containers', openerName: 'openContainers', open: (ui) => ui.openContainers() }
]

describe('minting a session closes every open takeover (BUG-102 AC-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(TAKEOVERS)('creating a fresh session closes the $name', ({ open }) => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    open(ui)
    expect(ui.anyTakeoverOpen).toBe(true)

    const id = store.createNewSession('/repo/alpha')

    expect(id).toBeTruthy()
    expect(ui.anyTakeoverOpen).toBe(false)
  })
})

describe('forking / folder terminal / dedupe / dispatch also close takeovers (BUG-102 AC-4, AC-5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('forking a session closes an open takeover', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    ui.openRoadmap('/repo/alpha', 'alpha')

    const forkId = store.createForkedSession('s1')

    expect(forkId).toBeTruthy()
    expect(ui.anyTakeoverOpen).toBe(false)
    expect(store.selectedFolderPath).toBeNull()
  })

  it('opening a folder terminal closes an open takeover and the folder selection', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.selectFolder('/repo/alpha')
    ui.openRoadmap('/repo/alpha', 'alpha')

    const termId = store.createFolderTerminal('/repo/alpha')

    expect(termId).toBeTruthy()
    expect(store.selectedId).toBe(termId)
    expect(store.selectedFolderPath).toBeNull()
    expect(ui.anyTakeoverOpen).toBe(false)
  })

  it('the dedupe branch (a second "+ New session" on a live synthetic) focuses just as hard as a fresh mint', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    const first = store.createNewSession('/repo/alpha')

    // Re-open a takeover and re-select the folder to simulate the operator
    // having navigated away, then click "+ New session" again.
    store.selectFolder('/repo/alpha')
    ui.openRoadmap('/repo/alpha', 'alpha')
    expect(ui.anyTakeoverOpen).toBe(true)

    const again = store.createNewSession('/repo/alpha')

    expect(again).toBe(first)
    expect(store.selectedId).toBe(first)
    expect(store.selectedFolderPath).toBeNull()
    expect(ui.anyTakeoverOpen).toBe(false)
  })

  it('a manual card dispatch focuses the session and closes an open takeover', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    ui.openRoadmap('/repo/alpha', 'alpha')

    const result = store.dispatchCardSession('/repo/alpha', 'do the thing')

    expect(result.ok).toBe(true)
    if (result.ok) expect(store.selectedId).toBe(result.sessionId)
    expect(ui.anyTakeoverOpen).toBe(false)
  })

  it('the background drain (dispatchCardSession with select: false) changes nothing at all', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    ui.openRoadmap('/repo/alpha', 'alpha')

    const result = store.dispatchCardSession('/repo/alpha', 'do the thing', undefined, {
      select: false
    })

    expect(result.ok).toBe(true)
    expect(store.selectedId).toBe('s1')
    expect(store.selectedFolderPath).toBeNull()
    expect(ui.roadmap.open).toBe(true)
    expect(ui.anyTakeoverOpen).toBe(true)
  })
})

describe('background/agent selection paths never steal focus or close a takeover (BUG-102 AC-7)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('insertAgentSession leaves an already-selected session and an open takeover untouched', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    ui.openRoadmap('/repo/alpha', 'alpha')

    store.insertAgentSession({
      syntheticId: 'synthetic-agent-1',
      correlationId: 'corr-1',
      folderPath: '/repo/alpha'
    })

    expect(store.selectedId).toBe('s1')
    expect(ui.roadmap.open).toBe(true)
  })

  it('retrySyntheticBoot leaves an already-selected session and an open takeover untouched', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    const folder = store.folders[0]
    folder.sessions.push({
      sessionId: 'synthetic-retry-1',
      projectPath: '/repo/alpha',
      summary: '',
      firstPrompt: '',
      modified: new Date().toISOString(),
      synthetic: true,
      status: 'active',
      taskState: 'failed',
      failureReason: 'prompt_undelivered'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    store.select('s1')
    ui.openRoadmap('/repo/alpha', 'alpha')

    store.retrySyntheticBoot('synthetic-retry-1')

    expect(store.selectedId).toBe('s1')
    expect(ui.roadmap.open).toBe(true)
  })

  /**
   * BUG-102 AC-8. "Retry boot" (SessionMenu) is a human gesture, not a
   * background event: when nothing is selected, `retrySyntheticBoot` grabs
   * selection so `TerminalPane` mounts and drains the boot queue. That grab
   * must close any open takeover too — otherwise the takeover keeps winning
   * the main pane, `TerminalPane` never mounts, and the retried boot silently
   * never runs (it only drains from inside `TerminalPane`'s watcher).
   */
  it('retrySyntheticBoot closes an open takeover when nothing was selected', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    const folder = store.folders[0]
    folder.sessions.push({
      sessionId: 'synthetic-retry-1',
      projectPath: '/repo/alpha',
      summary: '',
      firstPrompt: '',
      modified: new Date().toISOString(),
      synthetic: true,
      status: 'active',
      taskState: 'failed',
      failureReason: 'prompt_undelivered'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    ui.openRoadmap('/repo/alpha', 'alpha')
    expect(store.selectedId).toBeNull()

    store.retrySyntheticBoot('synthetic-retry-1')

    expect(store.selectedId).toBe('synthetic-retry-1')
    expect(ui.anyTakeoverOpen).toBe(false)
  })
})

describe('newSessionInCurrentContext resolves the active folder first (BUG-102 AC-9)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('mints into the selected folder, not folders[0]', () => {
    const store = useSessionsStore()
    store.folders.push({
      path: '/repo/beta',
      alias: 'beta',
      expanded: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    seedFolder(store) // pushes alpha as folders[1] — NOT the first folder
    store.selectFolder('/repo/alpha')

    const id = store.newSessionInCurrentContext()

    const alpha = store.folders.find((f) => f.path === '/repo/alpha')
    const beta = store.folders.find((f) => f.path === '/repo/beta')
    expect(id).toBeTruthy()
    expect(alpha?.sessions.some((s) => s.sessionId === id)).toBe(true)
    expect(beta?.sessions.length).toBe(0)
  })

  it("falls back to the selected session's folder when no folder is explicitly selected", () => {
    const store = useSessionsStore()
    store.folders.push({
      path: '/repo/beta',
      alias: 'beta',
      expanded: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    seedFolder(store) // alpha has session 's1'
    store.select('s1')

    const id = store.newSessionInCurrentContext()

    const alpha = store.folders.find((f) => f.path === '/repo/alpha')
    expect(id).toBeTruthy()
    expect(alpha?.sessions.some((s) => s.sessionId === id)).toBe(true)
  })

  it('falls back to the first folder when nothing is selected', () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.folders.push({
      path: '/repo/beta',
      alias: 'beta',
      expanded: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const id = store.newSessionInCurrentContext()

    const alpha = store.folders.find((f) => f.path === '/repo/alpha')
    expect(id).toBeTruthy()
    expect(alpha?.sessions.some((s) => s.sessionId === id)).toBe(true)
  })
})

/**
 * T298 (T297 U1) — tripwires for the hand-kept view registry.
 *
 * BUG-102 established the invariant: a main-pane view may cover a session,
 * but any act of focusing a session dismisses every view. That invariant
 * holds today only by discipline — `closeAllTakeovers()` is six hand-written
 * assignments, `anyTakeoverOpen` is six hand-written clauses, and `App.vue`
 * is a `v-else-if` chain. Nothing stops a seventh view from being wired
 * incompletely: the `ref` and the `open*` land, but a line in
 * `closeAllTakeovers()` or `anyTakeoverOpen` gets forgotten, and BUG-102
 * comes back for that one view alone, silently (it already has, twice: T198,
 * and the Esc list "never learned about the PR Stack" per `design.md` §6).
 *
 * These tests are that tripwire: they turn "a view wired incompletely" into
 * a red CI run instead of a silent regression. They do NOT fix the
 * underlying hand-kept design — T297's U2 (`activeView` + a real registry)
 * is the structural fix that makes forgetting a step impossible. Whoever
 * deletes these tests after U2 lands should know that's what they're
 * deleting insurance for.
 */
describe('T298 AC-1: the exported open* view functions match the canonical registry (TAKEOVERS)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * Every OTHER `open*` export on `stores/ui.ts` as of this writing — dialogs,
   * menus, popovers, and the notification-navigation dispatcher. None of these
   * are main-pane views: they don't participate in `closeAllTakeovers()` /
   * `anyTakeoverOpen`. Listed explicitly (not inferred) so that adding ANY new
   * `open*` export — view or not — forces a conscious edit to this file: add
   * it here if it's a floating surface, or add it to `TAKEOVERS` above if it's
   * a seventh main-pane view.
   */
  const KNOWN_NON_VIEW_OPENERS = new Set<string>([
    'openDialog',
    'openSettings',
    'openClaudeBoot',
    'openNewSession',
    'openRemoveWorktree',
    'openNewWorktree',
    'openNewFolder',
    'openOpenSubfolder',
    'openRenameFolder',
    'openRenameRepo',
    'openMemoryLocation',
    'openMenu',
    'openFolderMenu',
    'openPreview',
    'openFolderPreview',
    'openPalette',
    'openSidebarHiddenPopover',
    'openSidebarJumpPalette',
    'openNavigableView'
  ])

  it('has exactly seven main-pane view openers, and they are the ones TAKEOVERS tracks', () => {
    const ui = useUiStore()
    const expected = TAKEOVERS.map((t) => t.openerName).sort()

    const actual = Object.keys(ui)
      .filter((key) => /^open[A-Z]/.test(key))
      .filter((key) => !KNOWN_NON_VIEW_OPENERS.has(key))
      .sort()

    if (actual.join(',') !== expected.join(',')) {
      throw new Error(
        [
          'stores/ui.ts now exports a different set of main-pane-view open* functions than tests/folder-selection.test.ts tracks.',
          `  expected (TAKEOVERS): ${JSON.stringify(expected)}`,
          `  actual (ui.ts, minus KNOWN_NON_VIEW_OPENERS): ${JSON.stringify(actual)}`,
          '',
          'If you added a SEVENTH main-pane view: wire it into closeAllTakeovers(), into the',
          'anyTakeoverOpen computed, and into the App.vue v-else-if chain — THEN add it to the',
          'TAKEOVERS table in this file (name + openerName + open()).',
          '',
          'If you added a new open* export that is NOT a main-pane view (a dialog, menu, or',
          'popover): add its name to KNOWN_NON_VIEW_OPENERS in this test instead.'
        ].join('\n')
      )
    }
    expect(actual).toEqual(expected)
  })
})

describe('T298 AC-2: closeAllTakeovers() clears every opener (per view)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(TAKEOVERS)('$name: open, then closeAllTakeovers() closes it', ({ open }) => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)

    open(ui)
    expect(ui.anyTakeoverOpen).toBe(true)

    ui.closeAllTakeovers()

    expect(ui.anyTakeoverOpen).toBe(false)
  })
})

describe('T298 AC-3: sessions.select() dismisses every opener (BUG-102 invariant, per view)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(TAKEOVERS)('$name: open, then select() closes it', ({ open }) => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)

    open(ui)
    expect(ui.anyTakeoverOpen).toBe(true)

    store.select('s1')

    expect(ui.anyTakeoverOpen).toBe(false)
  })
})

/**
 * T298 AC-4 — the cartesian product BUG-102 verified by hand (one mint site
 * at a time, against whichever takeover happened to be open in that test).
 * Generated rather than hand-written: 6 openers × 5 human-intent mint paths
 * = 30 cases, each asserting the SAME thing — open a takeover, mint via a
 * human-intent path, the takeover is gone.
 */
type SessionsStore = ReturnType<typeof useSessionsStore>

const MINT_PATHS: {
  name: string
  setup?: (store: SessionsStore) => void
  mint: (store: SessionsStore) => void
}[] = [
  { name: 'createNewSession (fresh)', mint: (store) => void store.createNewSession('/repo/alpha') },
  {
    name: 'createNewSession (dedupe)',
    setup: (store) => void store.createNewSession('/repo/alpha'),
    mint: (store) => void store.createNewSession('/repo/alpha')
  },
  { name: 'createForkedSession', mint: (store) => void store.createForkedSession('s1') },
  { name: 'createFolderTerminal', mint: (store) => void store.createFolderTerminal('/repo/alpha') },
  {
    name: 'dispatchCardSession (default)',
    mint: (store) => void store.dispatchCardSession('/repo/alpha', 'do the thing')
  }
]

describe('T298 AC-4: every opener x every human-intent mint path dismisses it (cartesian)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const combos = TAKEOVERS.flatMap((takeover) =>
    MINT_PATHS.map((mint) => ({ comboName: `${takeover.name} x ${mint.name}`, takeover, mint }))
  )

  it.each(combos)('$comboName', ({ takeover, mint }) => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    mint.setup?.(store)

    takeover.open(ui)
    expect(ui.anyTakeoverOpen).toBe(true)

    mint.mint(store)

    expect(ui.anyTakeoverOpen).toBe(false)
  })
})

/**
 * T298 AC-5 — the negative space of AC-4. These three paths are background /
 * already-focused events, not human focus intent (T78), and must NOT close a
 * takeover. Asserted per opener so a future "fix" that makes one of these
 * route through `select()` (turning the dismissal rule into focus theft)
 * fails immediately for every view, not just the one a hand-written test
 * happened to cover.
 */
describe('T298 AC-5: background paths never dismiss an open takeover (per view)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(TAKEOVERS)('$name: dispatchCardSession({ select: false }) leaves it open', ({ open }) => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    open(ui)
    expect(ui.anyTakeoverOpen).toBe(true)

    const result = store.dispatchCardSession('/repo/alpha', 'do the thing', undefined, {
      select: false
    })

    expect(result.ok).toBe(true)
    expect(store.selectedId).toBe('s1')
    expect(ui.anyTakeoverOpen).toBe(true)
  })

  it.each(TAKEOVERS)(
    '$name: insertAgentSession with a session already selected leaves it open',
    ({ open, openerName }) => {
      const store = useSessionsStore()
      const ui = useUiStore()
      seedFolder(store)
      store.select('s1')
      open(ui)
      expect(ui.anyTakeoverOpen).toBe(true)

      store.insertAgentSession({
        syntheticId: `synthetic-agent-${openerName}`,
        correlationId: 'corr-1',
        folderPath: '/repo/alpha'
      })

      expect(store.selectedId).toBe('s1')
      expect(ui.anyTakeoverOpen).toBe(true)
    }
  )

  it.each(TAKEOVERS)(
    '$name: retrySyntheticBoot with a session already selected leaves it open',
    ({ open, openerName }) => {
      const store = useSessionsStore()
      const ui = useUiStore()
      seedFolder(store)
      const folder = store.folders[0]
      const syntheticId = `synthetic-retry-${openerName}`
      folder.sessions.push({
        sessionId: syntheticId,
        projectPath: '/repo/alpha',
        summary: '',
        firstPrompt: '',
        modified: new Date().toISOString(),
        synthetic: true,
        status: 'active',
        taskState: 'failed',
        failureReason: 'prompt_undelivered'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      store.select('s1')
      open(ui)
      expect(ui.anyTakeoverOpen).toBe(true)

      store.retrySyntheticBoot(syntheticId)

      expect(store.selectedId).toBe('s1')
      expect(ui.anyTakeoverOpen).toBe(true)
    }
  )
})
