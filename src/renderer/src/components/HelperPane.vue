<script lang="ts">
/**
 * Module-scoped state shared across ALL `HelperPane` instances. This MUST live
 * in a plain `<script>` block (which runs once, at module import), NOT in
 * `<script setup>` (whose body re-runs on every component instance). A worktree
 * switch unmounts the leaving worktree's panes and mounts the next worktree's,
 * so a cache declared in `<script setup>` is empty on every remount — the
 * detach/reattach contract (issue #10) only holds if the cache is a genuine
 * module-level singleton shared between the unmounting and remounting instances.
 */
import { Terminal } from '@xterm/xterm'

/**
 * Live per-pane state that must outlive a component unmount. The xterm
 * `Terminal`, the PTY id, and the IPC data/exit disposers stay alive while
 * the pane is off-screen; only the `ResizeObserver` and focus listeners are
 * torn down on detach and re-installed on re-attach (they bind to the host /
 * `term.element`, which the next mount supplies fresh).
 */
interface LiveHelper {
  term: Terminal
  ptyId: string
  /** IPC `onPtyData` / `onPtyExit` disposers — kept across detach so the PTY
   * keeps streaming into the xterm buffer while the pane is hidden. */
  ioDisposers: Array<() => void>
  resizeObserver: ResizeObserver | null
  focusCleanup: (() => void) | null
}

/**
 * Cache keyed by `pane.id` — survives component remounts (HMR, or when
 * `HelperStack`'s `v-for` re-mounts a pane on worktree switch). Because it is
 * module-scoped, the terminal a leaving instance detaches is the SAME one the
 * returning instance re-attaches.
 */
const liveHelpers = new Map<string, LiveHelper>()

/**
 * In-flight `createLiveHelper` promises, keyed by `pane.id`. `createLiveHelper`
 * only writes into `liveHelpers` AFTER it awaits the font load + `ptyCreate`,
 * so two `onMounted`s for the same pane before the first resolves (rapid
 * worktree switch away-and-back while the spawn is in flight) would each miss
 * `liveHelpers` and spawn a second PTY. This map collapses concurrent creates
 * onto one promise — mirrors `TerminalPane.vue`'s `creatingTerminals` (I1).
 */
const creatingHelpers = new Map<string, Promise<LiveHelper | undefined>>()

/**
 * The store's remove handler is registered exactly once across all
 * `HelperPane` instances (the cache + dispose fn are module-level, the store
 * is an app-lifetime singleton). Guards against re-registering on every mount.
 */
let removeHandlerRegistered = false

/** Module-level guard so the `beforeunload` disposer is bound exactly once. */
let unloadHandlerRegistered = false
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { shellEscapePath } from '../lib/path-inject'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ImageAddon } from '@xterm/addon-image'
import {
  Bot,
  ChevronRight,
  GitFork,
  Maximize2,
  Minimize2,
  ScrollText,
  Terminal as TerminalIcon,
  Unlock,
  X,
  type LucideIcon
} from 'lucide-vue-next'
import { registerFocusedPane, unregisterFocusedPane } from '../composables/useTerminalFocus'
import { useUiStore } from '../stores/ui'
import { DEFAULT_TERMINAL_FONT_SIZE, useSettingsStore } from '../stores/settings'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { paneRegistry, type HelperPtyKind } from '../lib/pane-registry'
import { useThemeStore } from '../stores/theme'
import { ensureTerminalFontLoaded, measureCells, measureXtermCells } from '../lib/terminalMetrics'
import { themeFromCss } from '../lib/terminalTheme'
import { installTerminalKeymap } from '../lib/terminalKeymap'
import { composeReviewCorrective, type ReviewCorrective } from '../../../main/review-corrective'
import { registerFileLinkProvider } from '../lib/terminal-file-links'

/**
 * Per-helper xterm host. One instance per pane in the right-side split
 * stack — `HelperStack` renders one of these for each entry in
 * `helpers.panesForCurrentWorktree`.
 *
 * Spawns the correct PTY kind for its pane type:
 *  - `shell`               → `kind: 'shell'`
 *  - `claude`              → `kind: 'claude-resume'`, resuming `pane.sessionId`
 *  - `claude-fork-pending` → `kind: 'claude-fork'`, resuming `pane.sourceSessionId`
 *
 * Focus tracking via R2's per-pane Set so multiple panes can each
 * contribute to the shared `terminalFocused` predicate (used by ⌘W /
 * Ctrl+W in `useShortcuts`). We use `props.pane.id` as the registration
 * key — unique across the app.
 *
 * Exit handling (helpers store, `watchPaneForExit`): a deliberate exit
 * auto-closes the pane; an exit inside a 2 s window after spawn (the broken
 * `claude --resume` signature) keeps the pane and surfaces a stale-session toast.
 *
 * Detach-not-dispose (issue #10): mirroring `TerminalPane.vue`, each pane's
 * `Terminal` + PTY live in the module-level `liveHelpers` cache keyed by
 * `pane.id`. Switching worktree unmounts the whole `HelperStack` (it sits
 * under `v-if="hasHelpersForCurrentWorktree"`), but `onBeforeUnmount` only
 * DETACHES — the PTY keeps running and the xterm buffer keeps filling in the
 * background, so the process (e.g. `npm`) and scrollback survive. On remount
 * we re-attach the cached terminal instead of spawning a fresh one. Full
 * teardown (kill PTY + dispose xterm) happens only on explicit pane removal —
 * the store's remove handler (X button / stale-toast / worktree drop) — or on
 * window unload.
 */
interface Props {
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle for the boundary
   * above it. False for the first pane in the stack (nothing above to size). */
  resizable?: boolean
}
const props = defineProps<Props>()

/** Forwarded to `HelperStack`, which owns the inter-pane drag-resize state. */
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t: i18n } = useI18n()
const ui = useUiStore()
const settings = useSettingsStore()
const helpers = useHelpersStore()
const theme = useThemeStore()
const hostRef = useTemplateRef<HTMLDivElement>('host')

// WebLinksAddon's default handler calls `window.open()` with no URL, which
// Electron's `setWindowOpenHandler` always denies (about:blank isn't
// http/https/mailto) — clicks silently no-op. Route through the main
// process instead, bypassing `window.open()` entirely.
function openTerminalLink(_event: MouseEvent, uri: string): void {
  void window.api.shellOpenExternal(uri)
}

/**
 * T121: PTY kind is now looked up in `pane-registry.ts` instead of a local
 * switch. `HelperStack`'s `pane-components.ts` map only ever routes a
 * PTY-backed type (shell/claude/claude-fork-pending) to this
 * component — every registry entry for those types sets `ptyKind`, so the
 * `?? 'shell'` fallback is unreachable in practice; it exists only to keep
 * this function total without an explicit throw.
 */
function paneKindToPtyKind(pane: AnyHelperPane): HelperPtyKind {
  return paneRegistry[pane.type]?.ptyKind ?? 'shell'
}

function paneClaudeSessionId(pane: AnyHelperPane): string | undefined {
  if (pane.type === 'claude') return pane.sessionId
  if (pane.type === 'claude-fork-pending') return pane.sourceSessionId
  // T245: inverted meaning for a `claude-new` companion — not a uuid to resume,
  // a uuid we minted for main to spawn as `--session-id`. See
  // `HelperPaneReviewCompanion.sessionId`.
  if (pane.type === 'review-companion') return pane.sessionId
  return undefined
}

/**
 * T247 — the orientation a review companion is spawned with, snapshotted out of
 * Pinia's reactive Proxy.
 *
 * The JSON round-trip is not defensive tidiness: `ptyCreate` crosses Electron's
 * structured-clone IPC, which cannot clone a Proxy ("An object could not be
 * cloned"), and the failure surfaces as "Helper failed to start" with a blank
 * pane. Every other pane type is unaffected: this returns `undefined` for them,
 * and main composes no orientation without it.
 */
function paneReviewCorrective(pane: AnyHelperPane): ReviewCorrective | undefined {
  if (pane.type !== 'review-companion') return undefined
  return JSON.parse(JSON.stringify(pane.corrective)) as ReviewCorrective
}

/**
 * Bind `focusin` / `focusout` on the xterm-managed host (`term.element`) so
 * the pane contributes to the shared `terminalFocused` predicate (⌘W / Ctrl+W
 * in `useShortcuts`). The actual focused node is xterm's internal textarea;
 * `focusin`/`focusout` bubble so we capture them from the wrapper. Returns a
 * disposer that removes both listeners. Re-installed on every attach.
 */
function installFocusListeners(live: LiveHelper, paneId: string): () => void {
  const el = live.term.element ?? hostRef.value
  const onFocusIn = (): void => registerFocusedPane(paneId)
  const onFocusOut = (): void => unregisterFocusedPane(paneId)
  el?.addEventListener('focusin', onFocusIn)
  el?.addEventListener('focusout', onFocusOut)
  return () => {
    el?.removeEventListener('focusin', onFocusIn)
    el?.removeEventListener('focusout', onFocusOut)
  }
}

/**
 * Attach a `ResizeObserver` to the host that keeps the live terminal sized to
 * it. Prefer the xterm-derived cell metrics (accurate row pixel height) and
 * fall back to the span-based estimate when xterm hasn't rendered yet. No
 * FitAddon — its `parentNode.clientWidth` bug (findings/04 §5) makes it
 * unreliable in nested flex columns like the helper stack.
 */
function attachResizeObserver(live: LiveHelper, host: HTMLElement): void {
  if (live.resizeObserver) {
    live.resizeObserver.disconnect()
    live.resizeObserver = null
  }
  const ro = new ResizeObserver(() => {
    const fs = settings.terminalFontSize
    const next = measureXtermCells(host, fs) ?? measureCells(host, undefined, fs)
    if (next.cols === live.term.cols && next.rows === live.term.rows) return
    live.term.resize(next.cols, next.rows)
    window.api.ptyResize(live.ptyId, next.cols, next.rows)
  })
  ro.observe(host)
  live.resizeObserver = ro
}

/**
 * Re-attach an existing live terminal to `host`: move its xterm-managed DOM
 * node back in, resize-on-attach to pick up any dimension changes that
 * happened while detached, then re-bind the ResizeObserver + focus listeners.
 */
function attachLiveHelper(live: LiveHelper, host: HTMLElement, paneId: string): void {
  if (!live.term.element) return
  host.appendChild(live.term.element)
  // Sync the font size on attach in case it changed while this pane was
  // detached (worktree switch) — no broadcast watch is mounted for a hidden
  // pane, so the option may be stale. Measure against the same size.
  const fs = settings.terminalFontSize
  if (live.term.options.fontSize !== fs) live.term.options.fontSize = fs
  const next = measureXtermCells(host, fs) ?? measureCells(host, undefined, fs)
  if (next.cols !== live.term.cols || next.rows !== live.term.rows) {
    live.term.resize(next.cols, next.rows)
    window.api.ptyResize(live.ptyId, next.cols, next.rows)
  }
  attachResizeObserver(live, host)
  if (live.focusCleanup) {
    live.focusCleanup()
    live.focusCleanup = null
  }
  live.focusCleanup = installFocusListeners(live, paneId)
  live.term.focus()
  // Reapply the theme on (re)attach (BUG-7 / T60): the per-instance theme watch
  // only runs while a `HelperPane` is mounted, so a pane that was detached AND
  // whose component was unmounted (worktree switched away) misses any theme
  // switch that happened meanwhile. `themeFromCss()` is a `getComputedStyle`
  // already paid on this path, so this makes the attach self-healing at no cost.
  live.term.options.theme = themeFromCss()
  // Force a repaint on (re)attach. Moving `term.element` between hosts via
  // `appendChild` does NOT make the canvas/WebGL renderer repaint, so a pane
  // re-attached after a worktree switch — whose hosted `claude` printed its TUI
  // before the host had painted — shows blank/stale glyphs until something
  // forces a redraw (the documented "renders blank on attach" bug; mirrors the
  // main TerminalPane's theme-watch `refresh`).
  live.term.refresh(0, Math.max(0, live.term.rows - 1))
}

/**
 * Detach `live` from the DOM without disposing. Stops observing resizes, tears
 * down focus listeners (a detached terminal can't receive keyboard input, so
 * its "focused" state is meaningless), unregisters from the shared focus Set,
 * and removes the element from its host. The Terminal + PTY keep running — the
 * PTY keeps streaming into the xterm buffer in the background (issue #10).
 */
function detachLiveHelper(live: LiveHelper, paneId: string): void {
  if (live.resizeObserver) {
    live.resizeObserver.disconnect()
    live.resizeObserver = null
  }
  if (live.focusCleanup) {
    live.focusCleanup()
    live.focusCleanup = null
  }
  unregisterFocusedPane(paneId)
  const el = live.term.element
  if (el && el.parentNode) el.parentNode.removeChild(el)
}

/**
 * Dispose `live` entirely — detach, tear down IPC subscriptions, kill the PTY,
 * dispose the xterm. Used only on explicit pane removal (store remove handler)
 * and window unload. NOT called on worktree navigation.
 */
function disposeLiveHelper(live: LiveHelper, paneId: string): void {
  detachLiveHelper(live, paneId)
  for (const d of live.ioDisposers) {
    try {
      d()
    } catch {
      /* swallow */
    }
  }
  live.ioDisposers = []
  try {
    window.api.ptyDestroy(live.ptyId)
  } catch {
    /* already dead */
  }
  try {
    live.term.dispose()
  } catch {
    /* already disposed */
  }
}

/**
 * Window-unload disposer: kill every live helper PTY and dispose its xterm.
 * Unlike `TerminalPane` there is no re-adoption path for helper PTYs across a
 * renderer reload, so leaving them running would orphan them. Bound once (see
 * `unloadHandlerRegistered`) and covers every cached pane.
 */
function onBeforeUnload(): void {
  for (const [paneId, live] of liveHelpers) {
    disposeLiveHelper(live, paneId)
  }
  liveHelpers.clear()
}

/**
 * Build a brand-new live terminal for `paneId`: open into the host, measure,
 * spawn the PTY, wire data/exit/input/resize, register in `liveHelpers`, and
 * bind the ResizeObserver + focus listeners. Returns the wired record, or
 * `undefined` if the PTY spawn failed (a toast is surfaced and the xterm is
 * disposed so it doesn't leak).
 */
async function createLiveHelper(
  host: HTMLElement,
  paneId: string
): Promise<LiveHelper | undefined> {
  const term = new Terminal({
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      'JetBrains Mono, Menlo, Consolas, monospace',
    fontSize: settings.terminalFontSize,
    lineHeight: 1.55,
    cursorBlink: true,
    allowTransparency: false,
    // Option+click is Harnu's "reveal this path in Browse files" gesture
    // (`terminal-file-links.ts`). xterm's default would ALSO emit cursor-move
    // escape sequences on that click, landing arrow keys in Claude's composer.
    altClickMovesCursor: false,
    scrollback: 10000,
    theme: themeFromCss()
  })
  term.loadAddon(new WebLinksAddon(openTerminalLink))
  term.loadAddon(new ImageAddon())
  term.open(host)
  await nextTick()

  // Wait for the bundled Nerd Font before measuring so the cell width comes
  // from its metrics, not the fallback's (mirrors `TerminalPane.vue`).
  await ensureTerminalFontLoaded()

  // First pass: span-based estimate so PTY spawns at a sane size.
  const fs = settings.terminalFontSize
  const initial = measureCells(host, undefined, fs)
  term.resize(initial.cols, initial.rows)
  await nextTick()

  // Second pass: re-measure against xterm's truly-rendered cell metrics and
  // resize again if the row count was off. The span estimate runs hot on
  // rows (xterm pads rows ~6 px taller than `fontSize * lineHeight`), and
  // without this correction the bottom of the helper grid overflows the
  // host's `overflow: hidden` wrapper — clipping Claude TUI's status line,
  // the input row, and the lower portion of xterm's scrollbar.
  const real = measureXtermCells(host, fs)
  if (real && (real.cols !== term.cols || real.rows !== term.rows)) {
    term.resize(real.cols, real.rows)
  }

  const kind = paneKindToPtyKind(props.pane)
  const claudeSessionId = paneClaudeSessionId(props.pane)

  let ptyId: string
  try {
    ptyId = await window.api.ptyCreate({
      kind,
      cwd: props.pane.cwd,
      cols: term.cols,
      rows: term.rows,
      claudeSessionId,
      // T245: read from the REGISTRY, not from a `type === 'review-companion'`
      // literal here — the pane type is what knows it is read-only, and a
      // future read-only type must not have to remember this call site.
      readOnly: paneRegistry[props.pane.type]?.readOnly === true,
      // T247: what the read-only stranger is told about the review it is sitting
      // beside. Pane DATA, so it is read off the pane rather than the registry —
      // a registry entry describes a type, and this differs per companion.
      reviewCorrective: paneReviewCorrective(props.pane)
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({
      kind: 'danger',
      title: i18n('helperPane.spawnFailed'),
      description: message
    })
    term.dispose()
    return undefined
  }

  const live: LiveHelper = {
    term,
    ptyId,
    ioDisposers: [],
    resizeObserver: null,
    focusCleanup: null
  }

  // Option+click a path in this helper's output → reveal it in the Explorer
  // pane for the stack's worktree. The pane's OWN cwd is what relative paths
  // resolve against, but the reveal always targets the worktree's explorer,
  // which is the only one this stack has. Registered here, after `ptyCreate`
  // succeeded, so the failure paths above never leak the shared Alt tracker's
  // refcount.
  live.ioDisposers.push(
    registerFileLinkProvider(term, {
      root: () => props.worktreePath,
      cwd: () => props.pane.cwd || props.worktreePath,
      resolve: (root, cwd, candidates) => window.api.explorerResolve(root, cwd, candidates),
      onReveal: (path) => helpers.revealInExplorer(props.worktreePath, props.worktreePath, path)
    })
  )

  // Data wiring — single-channel pty:data multiplexer is in preload; the
  // returned disposer removes our callback from the per-id Set. Kept on
  // `ioDisposers` so it survives detach (the PTY keeps filling the buffer).
  live.ioDisposers.push(
    window.api.onPtyData(ptyId, (data) => {
      term.write(data)
    })
  )
  // Exit handling lives in the store: a deliberate exit (the user typed
  // `exit` / Ctrl-D / quit Claude) auto-closes the pane instead of parking it
  // on a dead `[session ended]` line; an exit inside the first 2 s surfaces the
  // stale-session toast and keeps the pane. The returned disposer is kept on
  // `ioDisposers` so an explicit close (X button) tears the watch down too.
  live.ioDisposers.push(helpers.watchPaneForExit(props.worktreePath, paneId, ptyId))

  // Match TerminalPane's call style: positional args, not an object payload.
  term.onData((data) => window.api.ptyWrite(ptyId, data))
  term.onResize(({ cols, rows }) => window.api.ptyResize(ptyId, cols, rows))

  // Clipboard, word/char-delete, and font-size chords (design.md §6) — same
  // keymap the main pane uses, so the split behaves identically.
  installTerminalKeymap(term, {
    write: (data) => window.api.ptyWrite(ptyId, data),
    fontStep: (delta) => settings.setFontSize(settings.terminalFontSize + delta),
    fontReset: () => settings.setFontSize(DEFAULT_TERMINAL_FONT_SIZE)
  })

  liveHelpers.set(paneId, live)
  attachResizeObserver(live, host)
  live.focusCleanup = installFocusListeners(live, paneId)
  term.focus()
  return live
}

onMounted(async () => {
  // Register the store's remove handler once. It disposes the live terminal
  // when a pane is genuinely removed (X / stale-toast / worktree drop), even
  // if that pane's component is not currently mounted (removal can fire from
  // another worktree). Navigation never calls `removeHelper`, so this path is
  // distinct from the detach-on-unmount path below.
  if (!removeHandlerRegistered) {
    removeHandlerRegistered = true
    helpers.registerRemoveHandler((paneId) => {
      const live = liveHelpers.get(paneId)
      if (!live) return
      disposeLiveHelper(live, paneId)
      liveHelpers.delete(paneId)
    })
  }

  // Bind the window-unload disposer once across all instances. It iterates the
  // whole module-level cache, so a single listener covers every pane; we never
  // remove it (it lives for the page lifetime, like the cache itself).
  if (!unloadHandlerRegistered) {
    unloadHandlerRegistered = true
    window.addEventListener('beforeunload', onBeforeUnload)
  }

  const host = hostRef.value
  if (!host) return

  const paneId = props.pane.id
  const existing = liveHelpers.get(paneId)
  if (existing) {
    // Reuse path — the PTY + xterm survived a previous unmount (worktree
    // switch). Re-attach the cached terminal; scrollback and the running
    // process are intact.
    attachLiveHelper(existing, host, paneId)
    return
  }

  // Create path. Collapse concurrent creates of the same pane onto one promise
  // so a rapid unmount/remount while the spawn is still in flight never starts
  // a second PTY (I1, mirrors TerminalPane's `creatingTerminals`).
  let pending = creatingHelpers.get(paneId)
  const initiating = !pending
  if (!pending) {
    pending = createLiveHelper(host, paneId)
    creatingHelpers.set(paneId, pending)
    void pending.finally(() => creatingHelpers.delete(paneId))
  }
  const live = await pending
  if (!live) return
  // The initiating mount's `createLiveHelper` already attached into its host.
  // A mount that merely awaited an in-flight create started by an earlier
  // (now-unmounted) mount must re-attach the terminal into ITS own host — and
  // only if this component is still mounted (`hostRef.value` non-null).
  if (!initiating) {
    const currentHost = hostRef.value
    if (currentHost) attachLiveHelper(live, currentHost, paneId)
  }
})

onBeforeUnmount(() => {
  // Detach only — never dispose. The component unmounts on worktree switch
  // (HelperStack's `v-if`), but the PTY + xterm must keep running so the
  // process and scrollback survive (issue #10). Explicit removal disposes via
  // the store's remove handler; window unload disposes via `beforeunload`.
  const live = liveHelpers.get(props.pane.id)
  if (live) detachLiveHelper(live, props.pane.id)
})

/**
 * Terminal font-size broadcast (terminal-font-settings spec §7). Mirrors the
 * theme/font-size watch in `TerminalPane.vue`: push the new size to every live
 * helper terminal — attached or detached — so split panes track the global
 * preference without losing scrollback or killing the PTY. Each mounted
 * `HelperPane` re-measures + resizes its own pane (it owns the matching host);
 * detached panes whose component is unmounted pick the new size up on
 * re-attach via `attachLiveHelper`.
 */
watch(
  () => settings.terminalFontSize,
  async (size) => {
    for (const live of liveHelpers.values()) {
      if (live.term.options.fontSize !== size) live.term.options.fontSize = size
    }
    const live = liveHelpers.get(props.pane.id)
    const host = hostRef.value
    if (!live || !host) return
    // Let xterm repaint its rows at the new font size before measuring — a Vue
    // tick isn't enough since xterm updates cell metrics on its next render
    // frame, so one rAF gives the renderer a frame to flush.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const next = measureXtermCells(host, size) ?? measureCells(host, undefined, size)
    if (next.cols !== live.term.cols || next.rows !== live.term.rows) {
      live.term.resize(next.cols, next.rows)
      window.api.ptyResize(live.ptyId, next.cols, next.rows)
    }
  }
)

/**
 * Terminal theme broadcast (BUG-7 / T60). Mirrors the font-size watch above and
 * `TerminalPane.vue`'s T-3.5 watch: on a theme switch, reapply the new CSS-var
 * palette to EVERY live helper terminal — attached or detached — and force a
 * full repaint, so split/helper terminals that were already open recolour on the
 * spot instead of keeping the palette they read once at construction. The loop
 * scans all of `liveHelpers` (not just this pane), so any mounted `HelperPane`
 * repaints them all — exactly like the font-size broadcast. `nextTick` is
 * required: the theme store's `applyDom` writes `data-theme` on `<html>` in the
 * same flush, so we must wait for it before `themeFromCss()` reads the palette.
 */
watch(
  () => theme.current,
  async () => {
    await nextTick()
    const next = themeFromCss()
    for (const live of liveHelpers.values()) {
      live.term.options.theme = next
      try {
        live.term.refresh(0, Math.max(0, live.term.rows - 1))
      } catch {
        /* refresh can throw if the renderer isn't ready; harmless to skip */
      }
    }
  }
)

function onClose(): void {
  helpers.removeHelper(props.worktreePath, props.pane.id)
}

/** Whether THIS pane is the one currently maximized in its worktree's stack. */
const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
function onToggleMaximize(): void {
  helpers.toggleMaximizePane(props.worktreePath, props.pane.id)
}

// ---- File drop → path injection (file-explorer Cluster B) ----
// Dragging a file/folder from the OS file manager onto a helper pane injects its
// absolute path straight into THIS pane's own PTY. Helper panes each own their
// PTY (`liveHelpers` keyed by `pane.id`) and are NOT wired into the sessions
// store writer bus, so we escape + write to that PTY directly with the same
// util the store's `injectPathIntoSession` composes — covering every pane type
// (shell, claude, fork) uniformly. `dragOver` drives the affordance.
const dragOver = ref(false)

function onDragOver(e: DragEvent): void {
  // Only react to OS file drags, not text/element drags inside the app.
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dragOver.value = true
}

function onDragLeave(e: DragEvent): void {
  // Moving between xterm's nested canvas layers fires `dragleave` on the
  // wrapper; only clear when the pointer truly leaves the pane.
  const related = e.relatedTarget as Node | null
  const host = e.currentTarget as HTMLElement
  if (related && host.contains(related)) return
  dragOver.value = false
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  const live = liveHelpers.get(props.pane.id)
  if (!live) {
    // No live PTY yet (spawn still in flight or failed) → nothing to write.
    ui.pushToast({
      kind: 'info',
      title: i18n('terminalDrop.notLiveTitle'),
      description: i18n('terminalDrop.notLiveBody')
    })
    return
  }
  for (const file of Array.from(files)) {
    // `File.path` was removed in Electron 32+; resolve via the preload bridge.
    const p = window.api.getPathForFile(file)
    if (!p) continue
    // Mirror the store's injection: backslash-escaped path + one trailing space.
    window.api.ptyWrite(live.ptyId, shellEscapePath(p) + ' ')
  }
}

/** Begin an inter-pane resize drag when the header (not the close button) is
 * pressed. No-op on the first pane, which has no boundary above it. */
function onHeaderMouseDown(ev: MouseEvent): void {
  if (!props.resizable) return
  emit('headerMouseDown', ev)
}

/** Cross-platform basename of the pane's cwd — the visible pane name. */
const paneName = computed<string>(() => {
  const cwd = props.pane.cwd
  return (
    cwd
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || cwd
  )
})

/** Type icon shown left of the name in the header bar. */
const paneIcon = computed<LucideIcon>(() => {
  if (props.pane.type === 'shell') return TerminalIcon
  if (props.pane.type === 'claude-fork-pending') return GitFork
  if (props.pane.type === 'review-companion') return ChevronRight
  return Bot
})

/**
 * T245 — the review companion's own header. It replaces the generic
 * icon + cwd-basename title with what actually matters about this pane: that
 * the session is a stranger to the branch, and that it cannot write.
 *
 * The read-only state is shown as a WORD, never a bare lock glyph — the same
 * rule the review pane itself follows (PRD R2, "every status dot is rendered
 * together with the word it encodes"). A reader who cannot tell at a glance
 * whether the thing beside the diff can change the diff is exactly the
 * uncertainty this feature exists to remove.
 */
const isReviewCompanion = computed<boolean>(() => props.pane.type === 'review-companion')

/**
 * Whether there is a conversation to promote yet. `--session-id` reserves the
 * uuid at spawn, but Claude writes the transcript on the FIRST turn — so until
 * the operator has actually asked something there is nothing to carry over, and
 * a `--resume` would land on "No conversation found with session ID".
 *
 * The button is disabled rather than hidden: a control that appears once you
 * type is a control you cannot find when you go looking for it, and the
 * disabled tooltip is where the rule gets explained.
 */
const canPromote = computed<boolean>(() =>
  props.pane.type === 'review-companion' ? helpers.canPromoteReviewCompanion(props.pane) : false
)

/**
 * T247 AC-26 — "what this session was told", collapsed by default.
 *
 * The corrective is delivered as `--append-system-prompt`, which means it is
 * invisible: it never appears as a turn in the transcript, which is exactly why
 * it is safe to send (no unrequested first response, no ventriloquism) and
 * exactly why it needs a surface. A reviewer who cannot audit what its reader
 * was primed with is back to trusting a black box — the auditability the
 * rejected `prePrompt` design bought by putting a wall of text at the top of
 * every companion. The channel and the disclosure do not have to be the same
 * surface, and treating them as one was that document's false binary.
 *
 * It renders the SAME string main composed, from the SAME pure function over the
 * SAME five scalars — not a re-description of it, which is the shape that goes
 * quietly out of date.
 */
const disclosureOpen = ref(false)

const correctiveText = computed<string>(() =>
  props.pane.type === 'review-companion' ? composeReviewCorrective(props.pane.corrective) : ''
)

/** Promote out of read-only (AC-2b). Ends the review, then re-hosts the same
 * transcript as an ordinary writable session — the single door, taken
 * deliberately, never drifted into. */
function onPromote(): void {
  if (props.pane.type !== 'review-companion') return
  if (!helpers.promoteReviewCompanion(props.worktreePath, props.pane.id)) return
  ui.closeReview()
}
</script>

<template>
  <!--
    HelperPane sizing: the host element directly carries `h-full w-full`,
    mirroring TerminalPane.vue:670's pattern. The parent wrapper in
    HelperStack provides the explicit pixel height via flex track sizing
    + `overflow-hidden`, and xterm.js's internal canvas is bounded by
    `h-full`.

    The title bar (design.md §6 — "Header da pane") sits as an ABSOLUTE
    overlay at the top, and the host carries `padding-top: 24px` to make
    room. Keeping the bar out of xterm's flex/layout flow preserves the
    detach/reattach + focus-capture contract that a `flex flex-col` wrapper
    previously broke; `measureCells` already subtracts the host padding, so
    the grid still sizes correctly below the bar.
  -->
  <div
    class="relative h-full w-full overflow-hidden bg-bg"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      ref="host"
      class="h-full w-full"
      style="padding-top: 24px"
      :aria-label="$t('helperStack.paneLabel')"
    />
    <!-- Drop affordance (file-explorer Cluster B): ring + centered hint, mirroring
         the main TerminalPane. `pointer-events-none` + z-20 so it sits above the
         header without disturbing drag hit-testing. -->
    <div
      v-if="dragOver"
      class="anim-overlay-fade pointer-events-none absolute inset-0 z-20 flex items-center justify-center ring-1 ring-inset ring-accent-line"
    >
      <span class="rounded-md bg-surface px-2.5 py-1 text-xs text-text-2 shadow-pop">
        {{ $t('terminalDrop.hint') }}
      </span>
    </div>
    <header
      class="absolute inset-x-0 top-0 z-10 flex h-6 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <!-- Review companion header (T245): what it is, that it cannot write, and
           the one gesture that changes that. -->
      <template v-if="isReviewCompanion">
        <component :is="paneIcon" :size="12" :stroke-width="1.6" class="shrink-0 text-accent" />
        <span class="shrink-0 text-text-2">{{ $t('reviewCompanion.title') }}</span>
        <span class="min-w-0 flex-1 truncate text-text-4">{{
          $t('reviewCompanion.subtitle')
        }}</span>
        <span
          class="shrink-0 rounded-full border border-border bg-surface text-text-3"
          style="padding: 1px 7px; font-size: 10px"
          :title="$t('reviewCompanion.readOnlyHint')"
          >{{ $t('reviewCompanion.readOnly') }}</span
        >
        <!-- T247 AC-26 — "what this session was told". The LABEL is UI copy and
             goes through $t(); the corrective itself is model-facing prose and
             deliberately does not (AC-31), so it renders verbatim below. -->
        <button
          class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
          :class="disclosureOpen ? 'bg-surface-2 text-text-2' : ''"
          :title="$t('reviewCompanion.disclosure')"
          :aria-label="$t('reviewCompanion.disclosure')"
          :aria-expanded="disclosureOpen"
          @mousedown.stop
          @click="disclosureOpen = !disclosureOpen"
        >
          <ScrollText :size="11" :stroke-width="1.6" />
        </button>
        <button
          class="flex shrink-0 items-center gap-1 rounded border border-border-2 bg-surface-2 text-text-3 transition-colors hover:border-text-4 hover:text-text disabled:cursor-default disabled:opacity-45 disabled:hover:border-border-2 disabled:hover:text-text-3"
          style="padding: 1px 7px; font-size: 10px; height: 18px"
          :disabled="!canPromote"
          :title="
            canPromote ? $t('reviewCompanion.promoteHint') : $t('reviewCompanion.promoteNotYet')
          "
          :aria-label="$t('reviewCompanion.promote')"
          @mousedown.stop
          @click="onPromote"
        >
          <Unlock :size="10" :stroke-width="1.6" />
          <span class="truncate">{{ $t('reviewCompanion.promote') }}</span>
        </button>
      </template>
      <!-- Default header: type icon + cwd basename -->
      <template v-else>
        <component :is="paneIcon" :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
        <span class="min-w-0 flex-1 truncate" :title="pane.cwd">{{ paneName }}</span>
      </template>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('helperPane.close')"
        :aria-label="$t('helperPane.close')"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>
    <!-- T247 AC-26 — the disclosure body. An absolute overlay under the header
         rather than an inline block: the header is a fixed 24px strip that the
         xterm host is padded around, so growing it would resize the PTY grid
         every time the operator opened the panel. -->
    <div
      v-if="isReviewCompanion && disclosureOpen"
      class="anim-fade-in absolute inset-x-0 top-6 z-20 max-h-[45%] overflow-y-auto border-b border-border bg-surface px-2.5 py-2 shadow-pop"
    >
      <div class="mb-1.5 text-[10px] uppercase tracking-wide text-text-4">
        {{ $t('reviewCompanion.disclosure') }}
      </div>
      <pre
        class="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-text-3"
        >{{ correctiveText }}</pre>
    </div>
  </div>
</template>
