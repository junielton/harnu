import { computed, ref, toRaw, watch } from 'vue'
import { defineStore } from 'pinia'
import { useSessionsStore } from './sessions'
import { useUiStore } from './ui'
import { i18n } from '../i18n'
import { paneRegistry } from '../lib/pane-registry'
import { displayAlias } from '../components/folder-alias'
import {
  createPaneAlertQueue,
  drainPaneAlert,
  enqueuePaneAlert,
  mostRecentlyActive
} from '../lib/pane-alert'
import type { WorktreeHelperState, HelperPane } from '../../../preload'
import { UNKNOWN_CORRECTIVE, type ReviewCorrective } from '../../../main/review-corrective'

/** Passed by the agent-dispatch shim (`command-dispatch.ts`) only — never by a
 * human call site. Drives the unseen-panes badge + coalesced OS alert
 * (2026-07-13 agent-pane-routing design §Origin/§Badge/§Alert); never
 * persisted on the pane itself. */
export interface AddHelperOpts {
  origin?: 'agent'
}

/**
 * In-memory transient pane state for forks that haven't yet been
 * reconciled to a real session uuid. Lives only in this store — NEVER
 * persisted to `helpers.json` (per spec §6.2 anti-goal). If the app
 * quits during the pending window, the helper simply does not appear
 * on next boot.
 */
export interface HelperPanePending {
  id: string
  type: 'claude-fork-pending'
  sourceSessionId: string
  /** Synthetic id from `sessions.createForkedSession`, used as the
   * matching key when the migrate handler fires. */
  pendingSynthId: string
  cwd: string
  ratio: number
}

/**
 * The review companion (T245 U1): a FRESH `claude` beside the Review takeover,
 * read-only, scoped to the review that opened it.
 *
 * Transient like {@link HelperPanePending} and for the same structural reason
 * — `toPersistShape` drops it, so it never reaches `helpers.json` and never
 * reopens on a later boot. That is the whole point: a companion that survived
 * a restart would be a permanent tab, and the review it belonged to is long
 * over. It is disposed when the review closes (`disposeReviewCompanions`).
 *
 * `sessionId` is minted HERE, before the PTY exists, and handed to main as
 * `--session-id` (a `claude-new` spawn). Two things depend on knowing the uuid
 * up front: nothing, until the operator promotes — and then everything, because
 * promotion is a `claude --resume <sessionId>` onto the same transcript, which
 * is what lets the conversation survive the change of posture.
 *
 * There is deliberately no field naming the review this companion belongs to
 * (BUG-94 AC-4): `ui.review` is a single object and `disposeReviewCompanions`
 * sweeps every worktree on close, so "which review is this?" is state no code
 * here can ever ask. `cwd` already carries the one thing that IS load-bearing —
 * the folder the diff and the launched session both point at.
 */
export interface HelperPaneReviewCompanion {
  id: string
  type: 'review-companion'
  /** Captured at creation — the worktree the session is launched in. */
  cwd: string
  /** 0..1; siblings sum to 1.0 */
  ratio: number
  /** Pre-minted session uuid, spawned as `--session-id` and resumed on promote. */
  sessionId: string
  /**
   * T247 — the orientation this session is given so it knows it is BLIND: the
   * base + head commit SHAs, the head's readability state, whether the folder is
   * a git work tree, and the PR number when there is one.
   *
   * A boot-time snapshot, captured here at creation exactly like {@link cwd},
   * and deliberately NOT re-injected when the review refreshes: re-injecting
   * means writing into a running session's stdin, which is a much larger door
   * than this unit opens. The corrective is composed from SHAs, so it stays
   * TRUE as it ages — it just stops being the whole story, which is why it tells
   * the session to ask rather than to assume.
   *
   * Five scalars, and that is the point: nothing on the spec's normative
   * exclusion list (CI state, PR/review state, commit or file counts, the
   * changed-file list, `±` counts, the diff body, anything from `evidence`) can
   * fit through this field. Widening it rebuilds the briefing that three
   * adversarial reviews rejected.
   */
  corrective: ReviewCorrective
}

/**
 * A file-backed markdown viewer pane (T74). Narrowed view of the persisted
 * `HelperPane` (`type: 'markdown'` guarantees `filePath` is present). Non-PTY:
 * it never enters `liveHelpers`, is reproducible from `filePath`, and persists
 * like an editor tab. `MarkdownPane.vue` renders it; the MCP `open_file` verb
 * (S4) and the manual Topbar open both land here via {@link addMarkdownHelper}.
 */
export type HelperPaneMarkdown = HelperPane & { type: 'markdown'; filePath: string }

/**
 * A folder-backed project-memory viewer pane (T79 S3). Narrowed view of the
 * persisted `HelperPane` (`type: 'memory'` guarantees `folder` is present).
 * Non-PTY like {@link HelperPaneMarkdown}: it never enters `liveHelpers`, is
 * reproducible from `folder` (the repo whose `.harnu/memory/` it shows), and
 * persists + reopens on boot. `MemoryPane.vue` renders it; the FolderMenu
 * "Project memory…" action opens it via {@link addMemoryHelper}.
 */
export type HelperPaneMemory = HelperPane & { type: 'memory'; folder: string }

/**
 * A root-backed project file-tree pane (Cluster D). Narrowed view of the
 * persisted `HelperPane` (`type: 'explorer'` guarantees `root` is present).
 * Non-PTY like {@link HelperPaneMarkdown}: it never enters `liveHelpers`, is
 * reproducible from `root` (the project root its lazy, gitignore-aware tree is
 * confined to), and persists + reopens on boot. `ExplorerPane.vue` renders it;
 * the Topbar "Browse files" button opens it via {@link addExplorerHelper}.
 */
export type HelperPaneExplorer = HelperPane & { type: 'explorer'; root: string }

/** A pending Explorer reveal (option+click on a transcript path). */
export interface ExplorerRevealRequest {
  paneId: string
  path: string
  /** Bumped per request so revealing the same path twice re-fires the watcher. */
  nonce: number
}

/**
 * A file-backed canvas viewer pane (T218 U2). Narrowed view of the persisted
 * `HelperPane` (`type: 'canvas'` guarantees `filePath` is present — a
 * `*.capycanvas.json` document). Non-PTY like {@link HelperPaneMarkdown}: it
 * never enters `liveHelpers`, is reproducible from `filePath`, and persists +
 * reopens on boot. `DiagramPane.vue` renders it; the Explorer's `eye` icon on a
 * canvas row opens it via {@link addCanvasHelper}, and U4 routes `open_file`
 * and the `draw_canvas` verb to the same factory.
 */
export type HelperPaneCanvas = HelperPane & { type: 'canvas'; filePath: string }

/** Union of persisted + transient pane shapes. */
export type AnyHelperPane = HelperPane | HelperPanePending | HelperPaneReviewCompanion

interface InMemoryWorktreeState {
  splitVisible: boolean
  splitRatio: number
  panes: AnyHelperPane[]
}

/**
 * Convert in-memory state to persisted shape. Persistability is driven by
 * `pane-registry.ts`'s `persistable` flag (T121) — every pane type Harnu
 * knows about today is registered, so this is exhaustive for the current
 * app. A pane type NOT in the registry (a newer build's forward-compatible
 * type read by an older one) defaults to persistable (`?? true`) rather than
 * being silently dropped — round-tripping unrecognized data untouched is the
 * fix for the exact silent-data-loss trap T121 exists to close; this build
 * simply can't render it.
 *
 * We `toRaw` + spread each pane so that the IPC structured-clone algorithm
 * doesn't choke on Vue's reactive Proxy wrappers. Without this, the renderer
 * raises `Error: An object could not be cloned.` when the proxy is passed
 * over `ipcRenderer.invoke`. The cost is one shallow copy per pane —
 * negligible at our sizes.
 */
function toPersistShape(state: InMemoryWorktreeState): WorktreeHelperState {
  const rawState = toRaw(state)
  return {
    splitVisible: rawState.splitVisible,
    splitRatio: rawState.splitRatio,
    panes: rawState.panes
      .filter((p) => paneRegistry[p.type]?.persistable ?? true)
      .map((p) => ({ ...toRaw(p) }) as HelperPane)
  }
}

/** Hydrate persisted shape into in-memory shape. */
function fromPersistShape(state: WorktreeHelperState): InMemoryWorktreeState {
  return {
    splitVisible: state.splitVisible,
    splitRatio: state.splitRatio,
    panes: state.panes as AnyHelperPane[]
  }
}

function rebalanceRatios<T extends { ratio: number }>(panes: T[]): T[] {
  if (panes.length === 0) return panes
  const equal = 1 / panes.length
  return panes.map((p) => ({ ...p, ratio: equal }))
}

/**
 * Per-worktree helper-pane store. The split layout's right-side stack
 * lives here — one `InMemoryWorktreeState` per worktree, keyed by
 * absolute path. Hydration is lazy (call `ensureLoaded` on worktree
 * visit) and writes are debounced 500 ms before flushing the full
 * state through `helpers:set` IPC.
 *
 * Fork-pending resolution: when the user spawns a Claude fork into a
 * helper pane, `createForkedSession` returns a `synthetic-<uuid>`
 * which we stash on a `HelperPanePending` entry. R1's multi-sub
 * migrate handler fires when the watcher sees the real JSONL — we
 * swap the pending pane for a persisted `HelperPane` carrying the
 * real `sessionId`. The PTY itself is owned by the pane component
 * and survives the swap.
 *
 * Exit handling (`watchPaneForExit`): a deliberate exit (`exit` / Ctrl-D /
 * quitting Claude) auto-closes the pane. The exception is the first 2 s after
 * spawn — `claude --resume <uuid>` on a uuid Claude has since forgotten exits
 * in well under a second, so an exit inside that window keeps the pane and
 * surfaces a sticky "stale session" toast offering to remove it instead.
 */
export const useHelpersStore = defineStore('helpers', () => {
  const sessions = useSessionsStore()
  const ui = useUiStore()

  /**
   * Per-worktree layout state. Map keyed by absolute worktree path.
   * Map mutations MUST replace the ref (`byWorktree.value = new Map(...)`)
   * to trigger Vue 3 reactivity — `Map.set` on the .value Map is invisible
   * to templates. Mirrors the `prefsBySession` pattern in sessions.ts.
   * See `docs/lessons/reactivity/001-stale-comment-rot.md`.
   */
  const byWorktree = ref<Map<string, InMemoryWorktreeState>>(new Map())

  /**
   * Handlers notified when a helper pane is genuinely removed — the X button
   * (`removeHelper`), the stale-session toast's "Remove helper" action (also
   * `removeHelper`), or a worktree-removal cascade (`dropWorktreeFromMemory`).
   * `HelperPane.vue` registers one here to dispose the matching live terminal
   * (kill PTY + dispose xterm), since its own `onBeforeUnmount` now only
   * detaches (worktree navigation must NOT destroy the PTY — issue #10).
   * Argument is the pane id. Pinia stores are app-lifetime singletons so the
   * returned unregister fn is mostly a formality.
   */
  const removeHandlers = new Set<(paneId: string) => void>()

  function registerRemoveHandler(fn: (paneId: string) => void): () => void {
    removeHandlers.add(fn)
    return () => {
      removeHandlers.delete(fn)
    }
  }

  function notifyPaneRemoved(paneId: string): void {
    for (const fn of removeHandlers) {
      try {
        fn(paneId)
      } catch {
        /* swallow — a failing handler must not block the others */
      }
    }
  }

  // ── Reactive accessors ────────────────────────────────────────────────

  /**
   * Worktree path the visible helper stack belongs to.
   *
   * `sessions.activeFolderPath` (T212) rather than `selectedSession.projectPath`:
   * a session's `projectPath` IS its worktree path (sessions.ts:37), and the two
   * selections are mutually exclusive (`select` clears `selectedFolderPath`,
   * `selectFolder` clears `selectedId`), so with a session selected this is the
   * same value it always was. What it ADDS is the folder-selected case — which
   * T212 put into `App.vue`'s `showHelperStack` OR list but could never actually
   * reach, because a folder with no session left this `null` and the stack's
   * `showHelper` term false. T245 depends on it: the Review takeover is opened
   * from a FOLDER, so its companion pane needs a stack to land in.
   *
   * Returns `null` when nothing is selected at all (Onboarding, empty state).
   */
  const currentWorktreePath = computed<string | null>(() => sessions.activeFolderPath || null)

  const stateForCurrentWorktree = computed<InMemoryWorktreeState | null>(() => {
    const p = currentWorktreePath.value
    if (!p) return null
    return byWorktree.value.get(p) ?? null
  })

  const hasHelpersForCurrentWorktree = computed<boolean>(() => {
    const s = stateForCurrentWorktree.value
    return s !== null && s.splitVisible && s.panes.length > 0
  })

  const panesForCurrentWorktree = computed<AnyHelperPane[]>(() => {
    return stateForCurrentWorktree.value?.panes ?? []
  })

  const splitRatioForCurrentWorktree = computed<number>(() => {
    return stateForCurrentWorktree.value?.splitRatio ?? 0.65
  })

  /** Maximized pane id (if any) for the currently selected worktree. */
  const maximizedPaneIdForCurrentWorktree = computed<string | null>(() => {
    const p = currentWorktreePath.value
    if (!p) return null
    return maximizedByWorktree.value.get(p) ?? null
  })

  // ── Agent-pane badge + alert (2026-07-13 agent-pane-routing design) ────

  /**
   * Per-folder "unseen agent panes" counter (design §Badge). Bumped when
   * `addHelper` lands a genuinely new pane with `origin: 'agent'` in a
   * folder that ISN'T the one currently visible; cleared the moment the
   * operator selects any session in that folder (see the `currentWorktreePath`
   * watcher below). Deliberately NOT persisted — the panes themselves persist
   * (`helpers.json`), the "you haven't looked yet" flag is ephemeral by
   * design, so a fresh boot never resurrects a stale badge.
   */
  const unseenAgentPanes = ref<Map<string, number>>(new Map())

  /**
   * Per-worktree "which pane is maximized" state (helper-pane maximize/restore
   * toggle). Ephemeral — NEVER added to `InMemoryWorktreeState`/`toPersistShape`,
   * so it must never reach `helpers.json`: resets on worktree switch away-and-back
   * or app restart, mirroring `unseenAgentPanes`.
   */
  const maximizedByWorktree = ref<Map<string, string>>(new Map())

  /** Which pane (if any) is maximized in `worktreePath`'s stack. */
  function maximizedPaneId(worktreePath: string): string | null {
    return maximizedByWorktree.value.get(worktreePath) ?? null
  }

  /**
   * Toggle maximize for `paneId` in `worktreePath`'s stack: un-maximize if it's
   * already the maximized one, otherwise set/switch the maximized target to it —
   * so clicking a different pane's button re-targets directly without needing to
   * restore first.
   */
  function toggleMaximizePane(worktreePath: string, paneId: string): void {
    const current = maximizedByWorktree.value.get(worktreePath)
    const next = new Map(maximizedByWorktree.value)
    if (current === paneId) next.delete(worktreePath)
    else next.set(worktreePath, paneId)
    maximizedByWorktree.value = next
  }

  /**
   * Set `paneId` as the maximized pane in `worktreePath`'s stack — idempotent,
   * unlike {@link toggleMaximizePane}. Used to bring a pane into focus without
   * risking un-maximizing it on a repeat call (BUG-94 AC-1): the review
   * companion's "Ask a fresh session" button calls this on every activation, so
   * a second click while the companion already exists reveals/focuses it
   * instead of being a silent no-op.
   */
  function maximizePane(worktreePath: string, paneId: string): void {
    const next = new Map(maximizedByWorktree.value)
    next.set(worktreePath, paneId)
    maximizedByWorktree.value = next
  }

  /**
   * Bumped every time an agent-origin pane lands in the folder the operator is
   * CURRENTLY looking at (BUG-29). `App.vue`'s reveal watcher normally clears
   * `helperCollapsed` on the `hasHelpersForCurrentWorktree` false→true edge,
   * but that edge never fires when the stack already has panes — a collapsed
   * panel with existing panes would otherwise stay collapsed forever with no
   * signal at all. App.vue watches this tick instead for that one case.
   */
  const agentPaneRevealTick = ref(0)

  /**
   * Id of the explorer pane whose search field should take focus, or `null`.
   * Set by {@link addExplorerHelper} — the only two entry points are the Topbar
   * "Browse files" button and the Folder View's, both deliberate operator
   * gestures, so focusing the finder is what they actually meant. Transient by
   * construction: it lives outside the pane shape, so a boot restore never
   * carries it and never steals focus from the terminal. `ExplorerPane` clears
   * it via {@link consumeExplorerFocus} once it has focused the field. Set even
   * on a dedup hit (an already-open pane), so clicking the button again
   * re-focuses the search rather than doing nothing visible.
   */
  const explorerFocusRequest = ref<string | null>(null)

  /** Clear a pending focus request once `paneId`'s search field has taken it. */
  function consumeExplorerFocus(paneId: string): void {
    if (explorerFocusRequest.value === paneId) explorerFocusRequest.value = null
  }

  /**
   * A pending "reveal this path in the Explorer pane" request (option+click on
   * a path in a transcript). `paneId` names the pane that should act; `nonce`
   * makes a repeat reveal of the SAME path re-fire the pane's watcher, which a
   * plain value comparison would swallow. Transient by construction — it lives
   * outside the persisted pane shape, so a boot restore never replays a reveal.
   */
  const explorerRevealRequest = ref<ExplorerRevealRequest | null>(null)
  let explorerRevealNonce = 0

  /** Clear a pending reveal once `paneId` has expanded and selected the row. */
  function consumeExplorerReveal(paneId: string): void {
    if (explorerRevealRequest.value?.paneId === paneId) explorerRevealRequest.value = null
  }

  /**
   * Open (or reuse) the Explorer pane for `projectRoot` and ask it to reveal
   * `path`. Returns the pane id.
   *
   * Unlike the Topbar's "Browse files", this must NOT focus the search field:
   * `addExplorerHelper` sets `explorerFocusRequest` because a button click is a
   * find-me-a-file gesture, but a reveal is a look-at-the-tree gesture and the
   * finder would cover what we just revealed. So we clear it.
   */
  function revealInExplorer(worktreePath: string, projectRoot: string, path: string): string {
    const paneId = addExplorerHelper(worktreePath, projectRoot)
    // Only cancel a focus request addressed to THIS pane — a different pane's
    // pending "Browse files" focus must not be collateral damage.
    if (explorerFocusRequest.value === paneId) explorerFocusRequest.value = null
    explorerRevealRequest.value = { paneId, path, nonce: ++explorerRevealNonce }
    return paneId
  }

  /** How many unseen agent panes `worktreePath` currently holds (0 if none). */
  function unseenAgentPaneCount(worktreePath: string): number {
    return unseenAgentPanes.value.get(worktreePath) ?? 0
  }

  function bumpUnseenAgentPanes(worktreePath: string): void {
    const next = new Map(unseenAgentPanes.value)
    next.set(worktreePath, (next.get(worktreePath) ?? 0) + 1)
    unseenAgentPanes.value = next
  }

  function clearUnseenAgentPanes(worktreePath: string): void {
    if (!unseenAgentPanes.value.has(worktreePath)) return
    const next = new Map(unseenAgentPanes.value)
    next.delete(worktreePath)
    unseenAgentPanes.value = next
  }

  /** Coalescing window (design §Alert): a burst of agent panes into one
   * folder raises ONE native notification, not one per pane. */
  const PANE_ALERT_COALESCE_MS = 1500
  const paneAlertQueue = createPaneAlertQueue()
  const paneAlertTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function queuePaneAlert(worktreePath: string): void {
    enqueuePaneAlert(paneAlertQueue, worktreePath)
    const existing = paneAlertTimers.get(worktreePath)
    if (existing) clearTimeout(existing)
    paneAlertTimers.set(
      worktreePath,
      setTimeout(() => {
        paneAlertTimers.delete(worktreePath)
        fireAgentPaneAlert(worktreePath)
      }, PANE_ALERT_COALESCE_MS)
    )
  }

  /**
   * Drop any pane alert still pending for `worktreePath` — its pending count
   * AND its scheduled timer. Called alongside `clearUnseenAgentPanes` the
   * moment the operator looks at the folder: without this, a pane counted
   * BEFORE the visit could still fire a native "N new panes" notification
   * AFTER the visit for panes the operator already saw (the badge cleared,
   * but the alert queue is a separate counter with its own timer — "the
   * operator looked" must reset both signals together, not just the badge).
   */
  function cancelPendingPaneAlert(worktreePath: string): void {
    const timer = paneAlertTimers.get(worktreePath)
    if (timer) {
      clearTimeout(timer)
      paneAlertTimers.delete(worktreePath)
    }
    drainPaneAlert(paneAlertQueue, worktreePath)
  }

  // Selecting ANY session in a folder is "the operator looked" — clears that
  // folder's badge AND cancels any alert still pending for it, regardless of
  // which session inside it got selected. `flush: 'sync'` so both land in the
  // SAME tick as the selection — neither should visibly linger a frame after
  // the operator clicked.
  watch(
    currentWorktreePath,
    (path) => {
      if (!path) return
      clearUnseenAgentPanes(path)
      cancelPendingPaneAlert(path)
    },
    { flush: 'sync' }
  )

  /**
   * Fire the coalesced native OS notification (design §Alert): reused end to
   * end via `window.api.notify` → `src/main/notifications.ts` → native
   * toast, sound included for free (the native `Notification` isn't
   * `silent`), no new sound plumbing. Re-checks visibility at fire time —
   * the operator may have already switched to this folder during the
   * coalescing window, in which case `cancelPendingPaneAlert` already drained
   * the queue above and this is a no-op. Clicking activates the folder's most
   * recently active session (`notify:activate` → `sessions.activateSession`,
   * already wired — no new channel).
   */
  function fireAgentPaneAlert(worktreePath: string): void {
    const count = drainPaneAlert(paneAlertQueue, worktreePath)
    if (count === 0) return
    if (worktreePath === currentWorktreePath.value) return
    const folder = sessions.findFolderByPath(worktreePath)
    const target = mostRecentlyActive(folder?.sessions ?? [])
    if (!folder || !target) return
    const t = i18n.global.t
    const alias = displayAlias(folder, sessions.aliasFromBranchPaths.has(folder.path))
    window.api.notify({
      title: t('helperPane.agentAlert.title', { n: count }),
      body: t('helperPane.agentAlert.body', { folder: alias }),
      sessionId: target.sessionId
    })
  }

  /** The one call site `addHelper` uses for `origin: 'agent'`. When the target
   * folder is the one already visible there's nothing to badge or alert about,
   * but the panel may still be collapsed (BUG-29) — bump the reveal tick
   * instead so App.vue can un-collapse it. Off-screen folders keep the
   * existing badge + coalesced-alert path. */
  function notifyAgentPaneAdded(worktreePath: string): void {
    if (worktreePath === currentWorktreePath.value) {
      agentPaneRevealTick.value++
      return
    }
    bumpUnseenAgentPanes(worktreePath)
    queuePaneAlert(worktreePath)
  }

  // ── Hydration ─────────────────────────────────────────────────────────

  /**
   * Load persisted state for the given worktree if not already in memory.
   * Idempotent — repeated calls for the same path are no-ops. Call this
   * on worktree-switch (typically from a watcher on `currentWorktreePath`
   * inside the App shell).
   */
  async function ensureLoaded(worktreePath: string): Promise<void> {
    if (byWorktree.value.has(worktreePath)) return
    const persisted = await window.api.helpersGet({ worktreePath })
    if (!persisted) return
    // Re-check AFTER the await (T20): a pane added for this worktree during the
    // IPC round-trip (an MCP pane.split, addForkHelper, a New
    // terminal) already populated it — overwriting with the persisted shape would
    // silently drop that live pane.
    if (byWorktree.value.has(worktreePath)) return
    const next = new Map(byWorktree.value)
    next.set(worktreePath, fromPersistShape(persisted))
    byWorktree.value = next
  }

  // ── Persistence (debounced) ───────────────────────────────────────────

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFlushPath: string | null = null

  /**
   * Schedule a debounced flush of one worktree's state. A second call
   * within the 500 ms window resets the timer — so a drag with hundreds
   * of intermediate `setSplitRatio`/`setPaneRatios` mutations issues one
   * IPC write at the end, not one per pixel.
   *
   * Only one worktree can be pending at a time; if the user switches
   * worktrees mid-drag the previous flush is dropped on the floor. That's
   * intentional — the next mutation on the new worktree re-arms the timer
   * and the old worktree's state is already in memory, so the worst case
   * is a tiny window where the unsaved drag is lost on quit. Acceptable.
   */
  function scheduleFlush(worktreePath: string): void {
    pendingFlushPath = worktreePath
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      const p = pendingFlushPath
      pendingFlushPath = null
      if (p) void flush(p)
    }, 500)
  }

  async function flush(worktreePath: string): Promise<void> {
    const state = byWorktree.value.get(worktreePath)
    if (!state) return
    const persisted = toPersistShape(state)
    try {
      await window.api.helpersSet({ worktreePath, state: persisted })
    } catch (err) {
      console.warn('[helpers] flush failed for', worktreePath, err)
    }
  }

  /**
   * Best-effort flush of every dirty worktree NOW. Called from the App-
   * level `beforeunload` / Electron `before-quit` chain so a quit that
   * lands inside the 500 ms debounce window does not lose the drag.
   * Errors are swallowed — there's no UI surface left to report them on.
   */
  async function flushNow(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    pendingFlushPath = null
    for (const [path, state] of byWorktree.value) {
      const persisted = toPersistShape(state)
      try {
        await window.api.helpersSet({ worktreePath: path, state: persisted })
      } catch {
        /* swallow — best effort */
      }
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────

  /**
   * Apply a pure mutator to one worktree's state. Creates the default
   * empty state on first touch, replaces the Map ref (required for Vue
   * reactivity — see byWorktree's comment), and schedules a flush.
   */
  function mutateWorktree(
    worktreePath: string,
    mutator: (s: InMemoryWorktreeState) => InMemoryWorktreeState
  ): void {
    const current = byWorktree.value.get(worktreePath) ?? {
      splitVisible: false,
      splitRatio: 0.65,
      panes: [] as AnyHelperPane[]
    }
    const next = mutator(current)
    const map = new Map(byWorktree.value)
    map.set(worktreePath, next)
    byWorktree.value = map
    scheduleFlush(worktreePath)
  }

  /**
   * T121 — the ONE place dedup + cap-recycle + append + rebalance is
   * implemented. Every `add*Helper` below is a thin wrapper that builds its
   * type-specific pane object and hands it here.
   *
   * Dedup and the max-instances cap are both driven by `pane-registry.ts`,
   * read off the PRE-mutation snapshot (mirrors the original per-type
   * functions this replaced): a registered `dedupKey` that returns a match
   * on an existing same-type pane short-circuits with that pane's id instead
   * of appending; otherwise, if the type is at its `maxInstances` cap, the
   * OLDEST same-type pane is recycled (dropped) to make room. Forces
   * `splitVisible` true and equalizes vertical ratios like every original
   * did. Returns the new (or deduped) pane's id.
   */
  function addHelper(worktreePath: string, pane: AnyHelperPane, opts?: AddHelperOpts): string {
    const entry = paneRegistry[pane.type]
    const existing = byWorktree.value.get(worktreePath)

    if (entry?.dedupKey) {
      const key = entry.dedupKey(pane)
      if (key !== undefined) {
        const dup = existing?.panes.find((p) => p.type === pane.type && entry.dedupKey!(p) === key)
        if (dup) return dup.id
      }
    }

    let recycleId: string | null = null
    if (entry?.maxInstances !== undefined) {
      const sameType = (existing?.panes ?? []).filter((p) => p.type === pane.type)
      if (sameType.length >= entry.maxInstances) recycleId = sameType[0].id
    }

    mutateWorktree(worktreePath, (s) => {
      const kept = recycleId ? s.panes.filter((p) => p.id !== recycleId) : [...s.panes]
      const updated = rebalanceRatios([...kept, pane]) as AnyHelperPane[]
      return {
        ...s,
        splitVisible: true,
        panes: updated
      }
    })
    // 2026-07-13 agent-pane-routing design §Badge/§Alert: a genuine append
    // (fresh or cap-recycled — never the dedup short-circuit above, which
    // means nothing NEW landed) from the agent path bumps the unseen counter
    // + queues the coalesced OS alert, but only when the target folder isn't
    // the one the operator is currently looking at.
    if (opts?.origin === 'agent') notifyAgentPaneAdded(worktreePath)
    return pane.id
  }

  /**
   * Append a shell helper to a worktree's stack. Returns the new
   * pane id (also used as the PTY identifier).
   */
  function addShellHelper(worktreePath: string, cwd: string, opts?: AddHelperOpts): string {
    const id = `h-${crypto.randomUUID()}`
    return addHelper(worktreePath, { id, type: 'shell', cwd, ratio: 0 }, opts)
  }

  /**
   * Append a `claude` helper that resumes an EXISTING on-disk session
   * (`claude --resume <sessionId>`) to a worktree's stack — the context-menu
   * "Open in new tab" path. Unlike `addForkHelper` there is no synthetic /
   * pending step: the uuid already exists on disk, so we add a resolved
   * `claude` pane directly (which `HelperPane` spawns as `kind: 'claude-resume'`).
   *
   * Duplicate guard (registry `dedupKey`): a second `claude --resume` on the
   * same uuid would fight the first over the JSONL, so if this stack already
   * hosts a `claude` pane for `sessionId` we return that pane's id instead of
   * adding another.
   */
  function addResumeHelper(
    worktreePath: string,
    sessionId: string,
    cwd: string,
    opts?: AddHelperOpts
  ): string {
    const id = `h-${crypto.randomUUID()}`
    return addHelper(worktreePath, { id, type: 'claude', cwd, ratio: 0, sessionId }, opts)
  }

  /**
   * Open a file-backed markdown viewer pane (T74) in a worktree's stack. Unlike
   * the terminal panes it has NO PTY — it's cheap and reproducible from
   * `filePath` — so it never enters `liveHelpers`.
   *
   * Two anti-accumulation guards, both registry-driven (shared by the manual
   * open and the MCP `open_file` grant path, §5):
   *  - **dedup by `filePath`** — re-opening a file already in this stack returns
   *    the existing pane's id instead of stacking a duplicate;
   *  - **cap of `MAX_MARKDOWN_PANES` per worktree** — past the cap the OLDEST
   *    markdown pane is recycled (dropped) rather than piling on another.
   */
  function addMarkdownHelper(
    worktreePath: string,
    filePath: string,
    cwd: string,
    opts?: { initialMode?: 'edit' } & AddHelperOpts
  ): string {
    const id = `h-${crypto.randomUUID()}`
    const pane: HelperPane = { id, type: 'markdown', cwd, ratio: 0, filePath }
    if (opts?.initialMode) pane.initialMode = opts.initialMode
    return addHelper(worktreePath, pane, opts)
  }

  /**
   * Open a file-backed canvas viewer pane (T218 U2) in a worktree's stack.
   * Non-PTY like {@link addMarkdownHelper} — cheap, reproducible from
   * `filePath` — so it never enters `liveHelpers`.
   *
   * Same two registry-driven anti-accumulation guards as the markdown pane, for
   * the same reason: **dedup by `filePath`** (re-opening a board already in this
   * stack reveals it instead of stacking a second copy of the same document)
   * and a **cap of `MAX_CANVAS_PANES` per worktree** (past it the OLDEST canvas
   * pane is recycled).
   *
   * `opts.origin` is the agent-dispatch stamp (T218 U4): `open_file` on a
   * `*.capycanvas.json` routes here through `command-dispatch.ts`, and the
   * stamp is what drives the unseen-panes badge instead of a focus steal —
   * exactly as it does for {@link addMarkdownHelper}.
   */
  function addCanvasHelper(
    worktreePath: string,
    filePath: string,
    cwd: string,
    opts?: AddHelperOpts
  ): string {
    const id = `h-${crypto.randomUUID()}`
    const pane: HelperPane = { id, type: 'canvas', cwd, ratio: 0, filePath }
    return addHelper(worktreePath, pane, opts)
  }

  /**
   * Open a folder-backed project-memory viewer pane (T79 S3) in a worktree's
   * stack. Non-PTY like {@link addMarkdownHelper} — cheap, reproducible from
   * `folder`, so it never enters `liveHelpers`.
   *
   * `worktreePath` is the stack the pane attaches to (typically the selected
   * session's worktree, so the pane shows in the visible split); `folder` is the
   * repo whose memory to render (the FolderMenu target — resolved to the repo's
   * shared `.harnu/memory/` in main). Dedup by `folder` (registry `dedupKey`):
   * re-opening the same repo's memory returns the existing pane instead of
   * stacking a duplicate.
   */
  function addMemoryHelper(worktreePath: string, folder: string): string {
    const id = `h-${crypto.randomUUID()}`
    return addHelper(worktreePath, { id, type: 'memory', cwd: worktreePath, ratio: 0, folder })
  }

  /**
   * Open a root-backed project file-tree pane (Cluster D) in a worktree's stack.
   * Non-PTY like {@link addMemoryHelper} — cheap, reproducible from `root`, so it
   * never enters `liveHelpers`.
   *
   * `worktreePath` is the stack the pane attaches to (the selected session's
   * worktree, so it shows in the visible split); `projectRoot` is the folder the
   * lazy, gitignore-aware tree is confined to (today the same worktree path).
   * Dedup by `root` (registry `dedupKey`): exactly ONE explorer pane per root —
   * re-opening returns the existing pane's id instead of stacking a duplicate.
   */
  function addExplorerHelper(worktreePath: string, projectRoot: string): string {
    const id = `h-${crypto.randomUUID()}`
    const paneId = addHelper(worktreePath, {
      id,
      type: 'explorer',
      cwd: worktreePath,
      ratio: 0,
      root: projectRoot
    })
    explorerFocusRequest.value = paneId
    return paneId
  }

  /**
   * Open the review companion (T245 U1) in a worktree's stack: a FRESH `claude`
   * beside the Review takeover, read-only, disposed when the review closes.
   *
   * Deliberately NOT built on {@link addResumeHelper} or {@link addForkHelper}.
   * Both need an existing session — and the PRD's first decision (§1) is that
   * the interlocutor is a STRANGER, never the session that wrote the branch:
   * partly because a session reviewing its own code finds fewer bugs, but mostly
   * because reviewing a teammate's PR is a first-class case where an author
   * session does not exist at all. There is no picker and no fallback here on
   * purpose.
   *
   * The `claude-new` PTY spawns with a uuid we mint, so the transcript's
   * filename is known before Claude writes it — see
   * {@link HelperPaneReviewCompanion.sessionId}.
   *
   * Registry `dedupKey` is a constant, so a second invocation reveals the
   * companion already running rather than stacking another stranger.
   *
   * `corrective` defaults to {@link UNKNOWN_CORRECTIVE} — which names no ref and
   * tells the session to ask — so a caller that forgets it gets a session that
   * knows it is blind rather than one that quietly goes back to guessing.
   * `ReviewPane` always passes the real thing; the button is disabled while
   * there is no snapshot to pass (BUG-94 AC-2/AC-3).
   */
  function addReviewCompanionHelper(
    worktreePath: string,
    reviewFolderPath: string,
    corrective: ReviewCorrective = UNKNOWN_CORRECTIVE
  ): string {
    const id = `h-${crypto.randomUUID()}`
    const pane: HelperPaneReviewCompanion = {
      id,
      type: 'review-companion',
      cwd: reviewFolderPath,
      ratio: 0,
      sessionId: crypto.randomUUID(),
      corrective
    }
    return addHelper(worktreePath, pane)
  }

  /**
   * Promote a review companion to an ordinary working session (T245 AC-2b).
   *
   * The ONE door out of read-only, and it costs the review: the caller closes
   * the takeover, because a reviewer that edits IS the author, and keeping the
   * diff on screen while its reader gains a pen is precisely the collapse the
   * fresh-session decision was made to prevent. Promoting is allowed; drifting
   * into it is not.
   *
   * Mechanically it is a REPLACEMENT, not a mutation: `--permission-mode plan`
   * and the tool denials are argv, fixed for the life of a process, so the
   * read-only PTY is disposed and a `claude --resume <sessionId>` takes its
   * place. The conversation survives — same transcript, new posture — and the
   * pane it lands in is an ordinary `claude` pane: persistable, no longer bound
   * to the review, and no longer read-only.
   *
   * Refuses while the companion has **no transcript on disk yet**
   * ({@link canPromoteReviewCompanion}) — `--session-id` reserves the uuid at
   * spawn, but Claude only writes the JSONL on the first turn, so promoting a
   * session nobody has spoken to would `claude --resume` a conversation that
   * does not exist ("No conversation found with session ID", observed live) and
   * land the operator on a dead pane. There is also nothing to carry over at
   * that point: promotion exists to keep a conversation, and a session with no
   * turns has none.
   *
   * Returns the new pane's id, or `null` when `paneId` is not a promotable
   * companion in this stack (already promoted, already disposed, or not yet
   * resumable).
   */
  function promoteReviewCompanion(worktreePath: string, paneId: string): string | null {
    const stack = byWorktree.value.get(worktreePath)
    const pane = stack?.panes.find((p) => p.id === paneId)
    if (!pane || pane.type !== 'review-companion') return null
    if (!canPromoteReviewCompanion(pane)) return null
    const { sessionId, cwd } = pane
    removeHelper(worktreePath, paneId)
    return addResumeHelper(worktreePath, sessionId, cwd)
  }

  /**
   * Whether a companion's conversation exists on disk and can therefore be
   * resumed. Reads the sessions model rather than the filesystem: the JSONL
   * watcher is what puts a session in there, so the uuid appearing is the
   * renderer's own proof that the transcript landed.
   */
  function canPromoteReviewCompanion(pane: HelperPaneReviewCompanion): boolean {
    return sessions.findSessionById(pane.sessionId) !== null
  }

  /**
   * Dispose every review companion, in every worktree (T245 AC-6).
   *
   * Registered against `ui.registerReviewClosedHandler` below, so closing the
   * Review takeover — by the X, by Esc, by opening another takeover, by
   * selecting a session — actually kills the PTY.
   *
   * It has to be a DISPOSE and it has to be driven from the close: `HelperPane`
   * detaches rather than disposes on unmount (issue #10), and
   * `showHelperStack` stays true straight through a review → terminal
   * transition whenever the same worktree also has a session selected — the
   * common case. Left alone, the companion would simply keep running as an
   * ordinary helper tab: not disposed, and no longer scoped to anything.
   *
   * Sweeps every worktree rather than just the current one because a companion
   * outlives a folder switch, and only one review is ever open.
   */
  function disposeReviewCompanions(): void {
    for (const [path, state] of byWorktree.value) {
      for (const pane of state.panes) {
        if (pane.type === 'review-companion') removeHelper(path, pane.id)
      }
    }
  }

  ui.registerReviewClosedHandler(disposeReviewCompanions)

  /**
   * Append a fork-pending Claude helper to a worktree's stack. The
   * underlying synthetic session is registered in the sessions store
   * via `createForkedSession`; we stash its id on the pending pane so
   * the migrate handler can find us when the real uuid lands. Returns
   * the helper pane id, or `null` if the source session has vanished.
   */
  function addForkHelper(
    worktreePath: string,
    sourceSessionId: string,
    cwd: string
  ): string | null {
    const synthId = sessions.createForkedSession(sourceSessionId)
    if (!synthId) return null
    const id = `h-${crypto.randomUUID()}`
    const pane: HelperPanePending = {
      id,
      type: 'claude-fork-pending',
      sourceSessionId,
      pendingSynthId: synthId,
      cwd,
      ratio: 0
    }
    return addHelper(worktreePath, pane)
  }

  /**
   * Remove one helper from a worktree's stack. Rebalances remaining
   * ratios equally and flips `splitVisible` false when the last pane
   * goes — the split UI hides itself, persisted state on disk stays
   * (its `panes: []` is harmless) until the user explicitly drops the
   * worktree via the user-projects cascade.
   */
  function removeHelper(worktreePath: string, helperId: string): void {
    mutateWorktree(worktreePath, (s) => {
      const remaining = s.panes.filter((p) => p.id !== helperId)
      const updated = rebalanceRatios(remaining) as AnyHelperPane[]
      return {
        ...s,
        splitVisible: updated.length > 0,
        panes: updated
      }
    })
    // Genuine removal — tear down the live terminal (PTY + xterm). Navigation
    // never reaches here, so background panes keep running (issue #10).
    notifyPaneRemoved(helperId)
    // Closing the maximized pane must clear the maximize state too, or the
    // stack is left with every remaining pane collapsed and nothing shown large.
    if (maximizedByWorktree.value.get(worktreePath) === helperId) {
      const next = new Map(maximizedByWorktree.value)
      next.delete(worktreePath)
      maximizedByWorktree.value = next
    }
  }

  /**
   * T171 `close_file`: find the non-PTY, file/folder-backed pane (markdown /
   * memory / explorer) whose identity field matches `path`, and close it —
   * the read-only lookup `addHelper`'s inline dedup check never needed to
   * expose. Never matches `shell`/`claude` (those have no path-like
   * identity to match against). Returns the closed pane's id, or `undefined`
   * if nothing matched (a no-op, not an error).
   */
  function closeHelperByPath(worktreePath: string, path: string): string | undefined {
    const stack = byWorktree.value.get(worktreePath)
    const match = stack?.panes.find((p) => {
      if (p.type === 'markdown') return (p as HelperPane).filePath === path
      // T218 U4: the canvas pane is file-backed on the same key as the markdown
      // pane, so it belongs in this match for consistency. NOTE this arm is
      // PRE-WIRING, not a shipped capability: `pane.closeFile` is a dormant T171
      // router op with no main-process caller, there is no `close_file` verb in
      // `mcp/tool-catalog.ts`, and no human path reaches here (the operator
      // closes any pane with its X). Whenever a close surface is actually wired,
      // the canvas will already be covered instead of being the one type that
      // silently no-ops.
      if (p.type === 'canvas') return (p as HelperPane).filePath === path
      if (p.type === 'memory') return (p as HelperPane).folder === path
      if (p.type === 'explorer') return (p as HelperPane).root === path
      return false
    })
    if (!match) return undefined
    removeHelper(worktreePath, match.id)
    return match.id
  }

  /**
   * T171 `close_pane`: close ANY pane by id, including PTY-backed ones — the
   * higher-blast-radius sibling of {@link closeHelperByPath}, gated separately
   * at the MCP layer (always confirms). Returns whether a pane was actually
   * found, so the caller can distinguish "closed" from "already gone".
   */
  function closeHelperById(worktreePath: string, paneId: string): boolean {
    const stack = byWorktree.value.get(worktreePath)
    const exists = stack?.panes.some((p) => p.id === paneId) ?? false
    if (!exists) return false
    removeHelper(worktreePath, paneId)
    return true
  }

  /**
   * Set the main-pane / helper-stack horizontal split ratio. Clamped to
   * the [0.4, 0.8] user contract — the helper side stays at least 20%
   * wide and never grows past 60% (so the main pane is always visible).
   */
  function setSplitRatio(worktreePath: string, ratio: number): void {
    const clamped = Math.max(0.4, Math.min(0.8, ratio))
    mutateWorktree(worktreePath, (s) => ({ ...s, splitRatio: clamped }))
  }

  /**
   * Set the vertical ratios for every pane in the stack. Length must
   * match `panes.length` (silent no-op if not — the caller passed an
   * inconsistent snapshot). Sum is normalized to 1 so callers can
   * forward raw pixel-deltas without doing the arithmetic themselves.
   */
  function setPaneRatios(worktreePath: string, ratios: number[]): void {
    mutateWorktree(worktreePath, (s) => {
      if (ratios.length !== s.panes.length) return s
      const sum = ratios.reduce((a, b) => a + b, 0)
      if (sum <= 0) return s
      const normalized = ratios.map((r) => r / sum)
      const panes = s.panes.map((p, i) => ({ ...p, ratio: normalized[i] }))
      return { ...s, panes }
    })
  }

  // ── Worktree removal (cascade target) ─────────────────────────────────

  /**
   * Drop a worktree's in-memory state without touching disk. Called by
   * the user-projects cascade — main has already wiped the worktree's
   * entry from `helpers.json` via `helpers:removeWorktree`, so the
   * renderer just needs to forget about it.
   */
  function dropWorktreeFromMemory(worktreePath: string): void {
    const state = byWorktree.value.get(worktreePath)
    if (!state) return
    // The worktree is gone — dispose every live terminal it owned so their
    // PTYs don't linger in the background (issue #10's detach-not-dispose
    // means unmount alone no longer kills them).
    for (const pane of state.panes) notifyPaneRemoved(pane.id)
    const map = new Map(byWorktree.value)
    map.delete(worktreePath)
    byWorktree.value = map
    if (maximizedByWorktree.value.has(worktreePath)) {
      const nextMax = new Map(maximizedByWorktree.value)
      nextMax.delete(worktreePath)
      maximizedByWorktree.value = nextMax
    }
  }

  // ── Fork-pending resolution via R1's multi-sub migrate handler ────────

  // Register a migrate handler. R1 made this multi-sub-safe so we coexist
  // with TerminalPane's own registration. The returned unregister fn is
  // not used here (Pinia stores are app-lifetime singletons).
  sessions.registerMigrateHandler((oldId, newId) => {
    for (const [path, state] of byWorktree.value) {
      const idx = state.panes.findIndex(
        (p) => p.type === 'claude-fork-pending' && (p as HelperPanePending).pendingSynthId === oldId
      )
      if (idx === -1) continue
      const pending = state.panes[idx] as HelperPanePending
      const resolved: HelperPane = {
        id: pending.id,
        type: 'claude',
        cwd: pending.cwd,
        ratio: pending.ratio,
        sessionId: newId
      }
      const nextPanes = state.panes.map((p, i) => (i === idx ? (resolved as AnyHelperPane) : p))
      const map = new Map(byWorktree.value)
      map.set(path, { ...state, panes: nextPanes })
      byWorktree.value = map
      scheduleFlush(path)
      break
    }
  })

  // ── Stale-session detection (best-effort toast) ──────────────────────

  /**
   * Active early-exit watchers keyed by helper PANE id (stable across the
   * PTY's lifetime — the ptyId is a throwaway uuid from `pty:create`). The
   * setTimeout id self-clears after 2 s; any pty:exit that lands outside the
   * window is treated as a normal close (user typed `exit`) and auto-closes
   * the pane instead of toasting. The Map lets the cleanup path be idempotent.
   */
  const stalePaneTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Watch a freshly-spawned helper's PTY for exit. Two outcomes:
   *
   *  - **Early exit (< 2 s)** — surface a sticky `danger` "stale session"
   *    toast with a "Remove helper" action and KEEP the pane open so the user
   *    can read whatever it printed. `claude --resume <uuid>` exiting that
   *    fast almost always means the uuid is unknown to Claude (the JSONL was
   *    deleted, the project re-slugged, etc.), so we don't silently vanish it.
   *
   *  - **Normal exit (≥ 2 s)** — the process ended on purpose (the user typed
   *    `exit`, `Ctrl-D`, or quit Claude), so we AUTO-CLOSE the pane instead of
   *    leaving it parked on a dead `[session ended]` line.
   *
   * `ptyId` is the channel to subscribe on; `paneId`/`worktreePath` identify
   * which pane to remove. Returns the unsubscribe disposer so the caller can
   * tear the watch down on explicit pane removal (X button) before the PTY
   * even exits. Localized at the store boundary via `i18n.global.t` because
   * pinia store callbacks are not inside a `useI18n()` reactive context.
   */
  function watchPaneForExit(worktreePath: string, paneId: string, ptyId: string): () => void {
    const timer = setTimeout(() => {
      stalePaneTimers.delete(paneId)
    }, 2000)
    stalePaneTimers.set(paneId, timer)

    const t = i18n.global.t
    const off = window.api.onPtyExit(ptyId, () => {
      const armed = stalePaneTimers.get(paneId)
      if (!armed) {
        // Outside the 2 s window — a deliberate close. Drop the pane.
        removeHelper(worktreePath, paneId)
        off()
        return
      }
      clearTimeout(armed)
      stalePaneTimers.delete(paneId)
      ui.pushToast({
        title: t('helperPane.staleSession.title'),
        kind: 'danger',
        timeoutMs: 0,
        action: {
          label: t('helperPane.staleSession.remove'),
          handler: () => removeHelper(worktreePath, paneId)
        }
      })
      off()
    })
    return off
  }

  return {
    byWorktree,
    currentWorktreePath,
    stateForCurrentWorktree,
    hasHelpersForCurrentWorktree,
    panesForCurrentWorktree,
    splitRatioForCurrentWorktree,
    maximizedByWorktree,
    maximizedPaneId,
    maximizedPaneIdForCurrentWorktree,
    toggleMaximizePane,
    maximizePane,
    unseenAgentPanes,
    unseenAgentPaneCount,
    agentPaneRevealTick,
    explorerFocusRequest,
    consumeExplorerFocus,
    explorerRevealRequest,
    consumeExplorerReveal,
    revealInExplorer,
    ensureLoaded,
    addShellHelper,
    addResumeHelper,
    addMarkdownHelper,
    addCanvasHelper,
    addMemoryHelper,
    addExplorerHelper,
    addReviewCompanionHelper,
    promoteReviewCompanion,
    canPromoteReviewCompanion,
    disposeReviewCompanions,
    addForkHelper,
    removeHelper,
    closeHelperByPath,
    closeHelperById,
    setSplitRatio,
    setPaneRatios,
    flushNow,
    dropWorktreeFromMemory,
    watchPaneForExit,
    registerRemoveHandler
  }
})
