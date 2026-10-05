<script lang="ts">
/**
 * Module-scoped state shared across ALL `TerminalPane` instances. It MUST live in
 * a plain `<script>` block (evaluated once at module import), NOT `<script setup>`
 * (re-run per instance) — a `showSession` flip in App.vue unmounts + remounts this
 * pane, and the detach-not-dispose contract only holds if this cache is a genuine
 * module-level singleton: the terminal the leaving instance detaches is the SAME
 * one the returning instance re-attaches (no orphaned xterm, no duplicate PTY
 * subscription, no re-adopt). Mirrors the same pattern in HelperPane.vue.
 *
 * Single-instance assumption: only one TerminalPane is mounted at a time (the
 * main pane; helper cells are the separate HelperPane with its own cache).
 */
import { Terminal } from '@xterm/xterm'

/**
 * Per-session live state. The Terminal, its PTY, and IPC cleanups stay alive
 * even when the session is not currently mounted in the DOM — switching tabs
 * detaches/re-attaches `term.element` instead of dispose/recreate (findings/04
 * §11). The ResizeObserver is bound to the stable host `<div ref="termEl">`,
 * so we keep at most one RO at a time — the one for the currently-attached
 * session. Detached sessions don't observe; on re-attach we resize-on-attach
 * to pick up any host dimension changes that happened while detached.
 */
interface LiveTerminal {
  /** Logical session key this terminal is currently registered under. Kept on
   * the record so dispose paths (which only carry `live`) can unregister the
   * matching id from the store's `livePtySessionIds` set. Updated on migrate. */
  sessionId: string
  term: Terminal
  ptyId: string
  cleanups: Array<() => void>
  resizeObserver: ResizeObserver | null
  resizeTimer: ReturnType<typeof setTimeout> | null
  /**
   * Renderer-side backpressure (T-3.6 / findings/05 §6, findings/04 §6).
   * `pendingBytes` is the number of bytes that have been handed to
   * `term.write(data, cb)` but whose parser callback has not yet fired.
   * When it crosses `HIGH_WATERMARK` we ask main to pause the PTY (XOFF);
   * when it falls back under `LOW_WATERMARK` we resume.
   */
  pendingBytes: number
  paused: boolean
  /**
   * Disposer for the `focusin` / `focusout` DOM listeners that drive the
   * shared `terminalFocused` ref (T-4.5). `null` while detached — focus
   * listeners are only useful while the terminal is currently attached to
   * the DOM, since a detached terminal cannot receive keyboard input.
   * `attachLiveTerminal` installs them; `detachLiveTerminal` removes them
   * AND clears the shared ref to `false` to defend against the focused
   * terminal disappearing without ever firing `focusout`.
   */
  focusCleanup: (() => void) | null
  /**
   * Set during adoption (I4): while non-null, the live `onPtyData` handler
   * queues incoming chunks here instead of writing them, so the replayed
   * scrollback lands first and in order. Drained + nulled once replay completes.
   */
  adoptQueue: { data: string; seq: number }[] | null
  /**
   * Screen-detection (A2). `true` for a folder terminal (`isShellTerminal`) —
   * the only panes we screen-scrape. A hooked Claude pane is `false` and never
   * snapshots, so the common case pays nothing. Captured once at wire time.
   */
  screenMode: boolean
  /** Latest OSC title seen (`term.onTitleChange`) — the classifier's title signal. */
  lastTitle: string | null
  /** Debounce handle for the bottom-buffer snapshot (fires ~200ms after output settles). */
  snapshotTimer: ReturnType<typeof setTimeout> | null
  /**
   * Set by `onPtyExit` the instant the underlying process exits on its own
   * (BUG-24/zombie-synthetic). The map entry otherwise stays keyed by
   * `sessionId` forever — nothing else deletes it on a natural exit — so every
   * consumer that only checked "is this id present" (the `activate()` reuse
   * branch, `drainBgBoot`'s skip guard) silently reattached/skipped a corpse
   * instead of spawning a fresh PTY. `dead` lets those call sites tell "was
   * live" apart from "is live" without changing the detach-not-dispose
   * contract for terminals nobody has asked to reuse yet.
   */
  dead: boolean
}

/**
 * Module-level cache — survives component remounts (App.vue `v-if`/`showSession`
 * flips, HMR). Keyed by `sessionId`. See the block doc-comment above for why this
 * MUST be module-scoped, not per-instance.
 */
const liveTerminals = new Map<string, LiveTerminal>()

/**
 * In-flight `createLiveTerminal` promises, keyed by sessionId. `createLiveTerminal`
 * only writes into `liveTerminals` AFTER it awaits the font load + `ptyCreate`,
 * so two `activate(id)` calls for the same id before the first resolves would
 * both miss `liveTerminals` and each spawn a PTY. This map collapses concurrent
 * creates onto one promise (I1, renderer-side half of the dedup). The main-side
 * `PtySessionIndex` covers the cross-reload half.
 */
const creatingTerminals = new Map<string, Promise<LiveTerminal | undefined>>()

/** ID of the terminal currently attached to the DOM, or null if none. */
let attachedId: string | null = null

/**
 * One-shot re-adoption guard (I4/I5), module-scoped so a remount reuses the
 * shared cache instead of re-adopting a fresh xterm. Assigned by `ensureReadopted`;
 * only genuinely runs `doReadopt` on a real renderer reload (heap wiped).
 */
let readoptPromise: Promise<void> | null = null

/**
 * Background boot queue (BUG-23). Ids the store handed us via `agentBootQueue`
 * that must boot a PTY regardless of selection. Drained SERIALLY by `drainBgBoot`
 * (one `createLiveTerminal` at a time) so concurrent creates never race on the
 * shared host, and every dispatched boot actually starts. Module-scoped so an
 * in-flight drain survives a transient TerminalPane remount.
 */
const bgBootQueue: string[] = []
/** True while `drainBgBoot` is actively booting — serializes the queue. */
let bgBootRunning = false

/**
 * T215: ids in {@link bgBootQueue} that came from `session.wake` rather than
 * from an agent synthetic's boot. Two things follow, and both matter:
 *  - the drain's `entry.synthetic !== true` guard is bypassed for these (a
 *    parked session is a REAL, on-disk one — that guard exists to stop a
 *    vanished synthetic from booting, not to keep resumes out);
 *  - the spawn is stamped `wakeGesture: 'peer-message'`, so BUG-70's park
 *    ledger records that an AGENT un-parked the session, not a human. That
 *    ledger is the only place the distinction can ever be read back.
 */
const wakeIds = new Set<string>()

/**
 * The PTY id of a session's live terminal, or null when it has none (never opened,
 * or already closed). Exported so a NON-PTY pane can address a session's terminal
 * without reaching into the cache itself — the markdown pane delivering a lesson
 * result to the teacher session (T120) is the only caller today.
 */
export function livePtyIdFor(sessionKey: string): string | null {
  return liveTerminals.get(sessionKey)?.ptyId ?? null
}

/**
 * A park is a resource decision, not a lifecycle outcome (BUG-70 §3.3): only a
 * natural exit should paint `[session ended]` into the scrollback and flip the
 * task-state dot via `markSessionExited`. Absent `reason` still means natural
 * (wire back-compat). Exported as a pure predicate so the guard is
 * unit-testable without mounting the SFC.
 */
export function shouldMarkExited(reason?: 'natural' | 'park'): boolean {
  return reason !== 'park'
}
</script>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ImageAddon } from '@xterm/addon-image'
import { useSessionsStore } from '../stores/sessions'
import { getMcpApi } from '../stores/command-dispatch'
import { resolveSpawnSpec } from './spawn-spec'
import { useThemeStore } from '../stores/theme'
import { useUiStore } from '../stores/ui'
import { usePrStackStore } from '../stores/pr-stack'
import { parseGithubPrUrl } from '../../../main/github-remote'
import { displayAlias } from './folder-alias'
import { DEFAULT_TERMINAL_FONT_SIZE, useSettingsStore } from '../stores/settings'
import {
  registerFocusedPane,
  unregisterFocusedPane,
  MAIN_PANE_ID
} from '../composables/useTerminalFocus'
import { ensureTerminalFontLoaded, measureCells, measureXtermCells } from '../lib/terminalMetrics'
import { themeFromCss } from '../lib/terminalTheme'
import { dedupeAfterSeq } from '../lib/adoptDedupe'
import { installTerminalKeymap } from '../lib/terminalKeymap'
import { registerWriter, unregisterWriter } from '../lib/terminal-bus'
import { pasteAndSubmit } from './prompt-inject'
import {
  acquireInjectionTargetWithRetry,
  createInjectGate,
  isComposerReadyHook
} from './prompt-inject-gate'
import { injectionVerdict } from '../stores/injection-watchdog'
import { injectionLedger } from '../stores/injection-ledger'
import { registerFileLinkProvider } from '../lib/terminal-file-links'
import { useHelpersStore } from '../stores/helpers'

const sessions = useSessionsStore()
const theme = useThemeStore()
const ui = useUiStore()
const prStack = usePrStackStore()
const settings = useSettingsStore()
const helpers = useHelpersStore()
// Alias to `i18n` because the local Terminal variable in `createLiveTerminal`
// is named `t` (xterm convention) — shadowing collision otherwise.
const { t: i18n } = useI18n()
const termEl = ref<HTMLDivElement | null>(null)

// WebLinksAddon's default handler calls `window.open()` with no URL, which
// Electron's `setWindowOpenHandler` always denies (about:blank isn't
// http/https/mailto) — clicks silently no-op. Route through the main
// process instead, bypassing `window.open()` entirely.
function openTerminalLink(event: MouseEvent, uri: string): void {
  // xterm hands the raw mouse event through, so `altKey` is the real Option
  // state at click time. Plain click: straight to the browser, as ever.
  if (event.altKey) {
    void openPrLinkOrExternal(uri)
    return
  }
  void window.api.shellOpenExternal(uri)
}

/**
 * Option+click on a link to an OPEN pull request of this session's repo shows
 * that card on the PR Stack canvas (opt-in: Settings → PR Stack). Anything
 * else — setting off, not a PR URL, another repo, merged/closed, `gh` missing
 * or slow — falls back to the browser, so the click is never lost.
 */
async function openPrLinkOrExternal(uri: string): Promise<void> {
  try {
    const folderPath = sessions.activeFolderPath
    if (folderPath && parseGithubPrUrl(uri)) {
      const prefs = await prStack.ensurePrefs()
      if (prefs?.openPrLinksInCanvas === true) {
        const pr = parseGithubPrUrl(uri)!
        // Fast path: the canvas already holds this repo's snapshot with the PR.
        const known = prStack.holdsOpenPr(folderPath, pr.number)
        const resolved = known
          ? { prNumber: pr.number }
          : await window.api.prStackResolveLink(folderPath, uri)
        if (resolved) {
          const folder = sessions.findFolderByPath(folderPath)
          const label = folder
            ? displayAlias(folder, sessions.aliasFromBranchPaths.has(folder.path))
            : (folderPath.split('/').filter(Boolean).pop() ?? folderPath)
          prStack.focusPr(resolved.prNumber, folderPath)
          ui.openPrStack(folderPath, label)
          return
        }
      }
    }
  } catch {
    /* fall through to the browser */
  }
  void window.api.shellOpenExternal(uri)
}

/**
 * Option+click a path printed in the transcript → reveal it in the Explorer
 * pane (design.md § Explorer pane). The main pane always mirrors
 * `sessions.selectedId`, so the active folder is both the confinement root and
 * the cwd relative paths resolve against.
 */
function fileLinkContext(): Parameters<typeof registerFileLinkProvider>[1] {
  return {
    root: () => sessions.activeFolderPath ?? '',
    cwd: () => sessions.activeFolderPath ?? '',
    resolve: (root, cwd, candidates) => window.api.explorerResolve(root, cwd, candidates),
    onReveal: (path) => {
      const wt = sessions.activeFolderPath
      if (!wt) return
      helpers.revealInExplorer(wt, wt, path)
    }
  }
}

// ---- File drop → path injection (file-explorer Cluster B) ----
// Dragging a file/folder from the OS file manager onto the terminal injects its
// absolute path into the SELECTED session's live PTY the same way the footer
// image re-attach does (`injectPathIntoSession`). The main pane always mirrors
// `sessions.selectedId`, so the drop target IS that session. `dragOver` drives
// the drop affordance overlay (ring + hint) so the capability is discoverable.
const dragOver = ref(false)

function onDragOver(e: DragEvent): void {
  // Only react to OS file drags, not text/element drags inside the app.
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dragOver.value = true
}

function onDragLeave(e: DragEvent): void {
  // xterm's host has several nested canvas layers; moving between them fires
  // `dragleave` on the wrapper. Only clear when the pointer truly leaves the
  // pane, so the overlay doesn't flicker mid-drag.
  const related = e.relatedTarget as Node | null
  const host = e.currentTarget as HTMLElement
  if (related && host.contains(related)) return
  dragOver.value = false
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  const id = sessions.selectedId
  if (!id) return
  let anyInjected = false
  for (const file of Array.from(files)) {
    // `File.path` was removed in Electron 32+; resolve via the preload bridge.
    const p = window.api.getPathForFile(file)
    if (!p) continue
    if (sessions.injectPathIntoSession(id, p)) anyInjected = true
  }
  // No live PTY (a dormant/synthetic session) → nothing was written. Tell the
  // user why the drop did nothing instead of failing silently.
  if (!anyInjected) {
    ui.pushToast({
      kind: 'info',
      title: i18n('terminalDrop.notLiveTitle'),
      description: i18n('terminalDrop.notLiveBody')
    })
  }
}

// The `LiveTerminal` interface and the module-scoped caches (`liveTerminals`,
// `creatingTerminals`, `attachedId`, `readoptPromise`) live in the plain
// `<script>` block above — they must survive an unmount+remount (T14).

/** Bottom rows of the live screen to snapshot for screen detection (A2). */
const SCREEN_SNAPSHOT_LINES = 30
/** Debounce after output settles before snapshotting (matches the RO cadence band). */
const SCREEN_SNAPSHOT_DEBOUNCE_MS = 200

// `liveTerminals`, `creatingTerminals`, and `attachedId` are module-scoped in the
// plain `<script>` block above (T14 — they must survive an unmount+remount).

/**
 * Renderer backpressure watermarks (T-3.6). Static for v1 — no settings UI.
 * Values match the recommendation in `findings/04-pty-xterm-production.md` §6:
 * pause the PTY when >1 MiB is outstanding to the xterm parser, resume when
 * the backlog drains under 256 KiB. The wide gap avoids pause/resume flapping
 * on a sustained stream.
 */
const HIGH_WATERMARK = 1024 * 1024
const LOW_WATERMARK = 256 * 1024

/**
 * UTF-8 byte length of a string. The renderer runs in a sandboxed browser
 * context (Electron `contextIsolation: true`) so `Buffer` is unavailable —
 * use `TextEncoder().encode().length`, which is the standard browser API and
 * matches the byte count used by the main side's `Buffer.byteLength(data, 'utf8')`.
 * `TextEncoder` is allocated once at module scope; the spec guarantees it's
 * stateless and safe to share across invocations.
 */
const utf8Encoder = new TextEncoder()
function byteLength(s: string): number {
  return utf8Encoder.encode(s).length
}

function clearResizeTimer(live: LiveTerminal): void {
  if (live.resizeTimer) {
    clearTimeout(live.resizeTimer)
    live.resizeTimer = null
  }
}

/**
 * Read the bottom `n` rows of a terminal's LIVE screen (scroll-independent) as
 * trimmed strings — the input to the main-side screen detector (A2). Anchored at
 * the live viewport bottom (`baseY + rows - 1`), NOT the scrollback, so an old
 * prompt scrolled up can never be sampled. `translateToString(true)` trims
 * trailing whitespace per row; the main core re-normalizes + drops trailing
 * blank padding, so this stays the cheap, dumb extractor.
 */
function readBottomLines(t: Terminal, n: number): string[] {
  const buf = t.buffer.active
  const end = Math.min(buf.length - 1, buf.baseY + t.rows - 1)
  if (end < 0) return []
  const start = Math.max(0, end - n + 1)
  const out: string[] = []
  for (let i = start; i <= end; i++) {
    const line = buf.getLine(i)
    out.push(line ? line.translateToString(true) : '')
  }
  return out
}

/**
 * Schedule a debounced bottom-buffer snapshot for a screen-mode pane. Re-armed
 * on every PTY chunk so it only fires once the output settles (~200ms), keeping
 * the IPC tiny and off the byte-by-byte path. Fires even while the terminal is
 * detached (a background codex pane keeps updating its dot) — the Terminal and
 * its buffer stay alive; only the DOM attachment toggles.
 */
function scheduleScreenSnapshot(live: LiveTerminal): void {
  if (live.snapshotTimer) clearTimeout(live.snapshotTimer)
  live.snapshotTimer = setTimeout(() => {
    live.snapshotTimer = null
    try {
      window.api.paneScreenSnapshot({
        sessionId: live.sessionId,
        lines: readBottomLines(live.term, SCREEN_SNAPSHOT_LINES),
        title: live.lastTitle
      })
    } catch {
      /* IPC gone / terminal disposed mid-debounce — drop this snapshot */
    }
  }, SCREEN_SNAPSHOT_DEBOUNCE_MS)
}

/**
 * Bind `focusin` / `focusout` listeners on the xterm-managed host element
 * (`live.term.element`) so the shared `terminalFocused` ref reflects whether
 * the terminal currently owns DOM focus. Used by `useShortcuts(...)` in
 * `App.vue` to back off the `session.close` (⌘W / Ctrl+W) binding while the
 * terminal is focused — letting xterm forward the keystroke to the PTY so
 * programs like `nano` can react to `\u0017` (T-4.5).
 *
 * We listen to `focusin`/`focusout` (not `focus`/`blur`) because the actual
 * focused element is the `<textarea>` xterm injects inside `term.element`,
 * not the host element itself. `focusin`/`focusout` bubble; `focus`/`blur`
 * do not. Installing on the host means we get both the textarea focus AND
 * any future focusable child (e.g. a search overlay), with one handler pair.
 *
 * Returns a disposer that removes both listeners. Re-bind is safe: if a
 * prior cleanup exists on `live.focusCleanup`, the caller (typically
 * `attachLiveTerminal`) should call it first to avoid stacking handlers
 * across re-attach cycles.
 */
function installFocusListeners(live: LiveTerminal): (() => void) | null {
  const el = live.term.element
  if (!el) return null
  const onFocusIn = (): void => {
    registerFocusedPane(MAIN_PANE_ID)
  }
  const onFocusOut = (): void => {
    // `relatedTarget` would tell us whether focus is moving inside or outside
    // the host, but we conservatively unregister either way: any subsequent
    // `focusin` (from a nested element gaining focus) will re-register
    // synchronously in the same dispatch tick, so brief flicker is invisible
    // to the dispatcher in `useShortcuts`.
    unregisterFocusedPane(MAIN_PANE_ID)
  }
  el.addEventListener('focusin', onFocusIn)
  el.addEventListener('focusout', onFocusOut)
  return () => {
    el.removeEventListener('focusin', onFocusIn)
    el.removeEventListener('focusout', onFocusOut)
  }
}

/**
 * Attach a ResizeObserver to the host that drives the live terminal's grid.
 * Uses the trailing-edge 150ms debounce pattern from T-3.3 (findings/04 §3).
 */
function attachResizeObserver(live: LiveTerminal, host: HTMLElement): void {
  // Detach any prior observer first — the host element is stable across
  // session switches but the live we re-attach to it may have left its old
  // RO bound to a now-detached element-ref.
  if (live.resizeObserver) {
    live.resizeObserver.disconnect()
    live.resizeObserver = null
  }
  clearResizeTimer(live)

  live.resizeObserver = new ResizeObserver(() => {
    if (!termEl.value) return
    clearResizeTimer(live)
    live.resizeTimer = setTimeout(() => {
      live.resizeTimer = null
      const liveEl = termEl.value
      if (!liveEl) return
      const fs = settings.terminalFontSize
      const next = measureXtermCells(liveEl, fs) ?? measureCells(liveEl, undefined, fs)
      if (next.cols === live.term.cols && next.rows === live.term.rows) return
      live.term.resize(next.cols, next.rows)
      window.api.ptyResize(live.ptyId, next.cols, next.rows)
    }, 150)
  })
  live.resizeObserver.observe(host)
}

/**
 * Create a brand-new live terminal for `sessionId`. Mirrors the pre-T-3.4
 * `mountTerminal()` flow: open into the host, measure, resize, spawn PTY,
 * wire data/exit/onData/onResize, install ResizeObserver.
 *
 * IMPORTANT: this must only be called when `termEl.value` is the host the
 * caller intends to display the new terminal in. `term.open()` is one-shot
 * per Terminal instance; subsequent attaches use direct `appendChild` on
 * `term.element`.
 */
async function createLiveTerminal(
  sessionId: string,
  wakeGesture?: 'select' | 'peer-message'
): Promise<LiveTerminal | undefined> {
  if (!termEl.value) return undefined
  const host = termEl.value

  const t = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: settings.terminalFontSize,
    lineHeight: 1.55,
    cursorBlink: true,
    allowTransparency: false,
    // Option+click is Harnu's "reveal this path in Browse files" gesture
    // (`terminal-file-links.ts`). xterm's default would ALSO emit cursor-move
    // escape sequences on that click, landing arrow keys in Claude's composer.
    altClickMovesCursor: false,
    // ...and when the TUI tracks the mouse, xterm would also REPORT that click
    // to it — Claude Code then opens a clicked URL itself, a second open on top
    // of ours (or of the PR Stack routing). Forcing selection on Option keeps
    // Option+click inside Harnu.
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    theme: themeFromCss()
    // NB: xterm.js has no `handleFlowControl` option (that lives on node-pty's
    // `spawn()` options on the main side — see `src/main/pty.ts`). The actual
    // renderer-side flow-control mechanism IS the `term.write(data, cb)`
    // callback pattern wired below: we count outstanding bytes and call
    // `ptyPauseFlow` / `ptyResumeFlow` over the high/low watermarks (T-3.6).
  })

  t.loadAddon(new WebLinksAddon(openTerminalLink))
  t.loadAddon(new ImageAddon())
  t.open(host)
  await nextTick()

  // Ensure the bundled Nerd Font is actually loaded before measuring. The
  // cell-width measurement (`measureCells`) renders 'M's in `--font-mono`; if
  // the font is still pending its async load, the browser measures the
  // fallback and we spawn the PTY at the wrong cols (the same class of bug as
  // the xterm cell-width fix in ed90503). `document.fonts.load` resolves once
  // the face is ready (or rejects silently if missing — we ignore and proceed
  // with whatever the system resolves).
  await ensureTerminalFontLoaded()

  // First pass: rough span-measure estimate so PTY spawns at a sane size.
  const fs = settings.terminalFontSize
  const initial = measureCells(host, undefined, fs)
  t.resize(initial.cols, initial.rows)
  await nextTick()

  // Second pass: re-measure against xterm's actually-rendered cell metrics
  // and resize again if the row count was off. See `measureXtermCells` for
  // why the span-based estimate is too generous on rows.
  const real = measureXtermCells(host, fs)
  if (real && (real.cols !== t.cols || real.rows !== t.rows)) {
    t.resize(real.cols, real.rows)
  }

  // Per-session preference for `CLAUDE_CODE_NO_FLICKER` (T-3.7).
  const prefs = sessions.getPrefs(sessionId)

  // Resolve the session entry so we can pick the right PTY kind (U-1.4 /
  // U-1.5 / fork-session). Four branches, ordered narrowest predicate first:
  //  - fork synthetic (`synthetic && forkSourceId`): spawn
  //    `claude --resume <forkSourceId> --fork-session` so Claude loads the
  //    source session's history and diverges to a fresh UUID on first
  //    write. See spec §3.4.
  //  - plain synthetic (`synthetic`, no `forkSourceId`): created by
  //    `createNewSession`; spawn `claude` with no args from the worktree
  //    path so Claude writes a fresh JSONL.
  //  - existing entry from disk: spawn `claude --resume <uuid>` in the
  //    session's recorded cwd.
  //  - unknown id (e.g. stale selection after a model reload): fall back to
  //    a plain shell. Mostly dead code today but keeps the pane robust.
  const sessionEntry = sessions.allSessions.find((s) => s.sessionId === sessionId)

  // Defense-in-depth: a cloud/bridge stub with no local transcript can't be
  // resumed (`claude --resume` → "No conversation found …" → dead PTY). App.vue
  // already routes these to `CloudSessionPanel` instead of mounting us, but if
  // some other path (e.g. open-in-new-tab) ever asks us to mount one, refuse to
  // spawn rather than thrash a doomed process. Dispose the xterm we just opened.
  if (sessionEntry && sessionEntry.resumable === false) {
    t.dispose()
    return undefined
  }

  // Pure spawn decision (kind + claudeSessionId + one-shot bootOverride). The
  // bootOverride is JSON-snapshotted to a plain object inside `resolveSpawnSpec`
  // so the Pinia reactive Proxy never reaches Electron's structured-clone IPC
  // ("An object could not be cloned"). See `spawn-spec.ts`.
  const spec = resolveSpawnSpec(sessionEntry, sessionId)
  const cwd = sessionEntry?.projectPath

  // BUG-59: start the MCP agent correlation window HERE — the actual moment
  // this synthetic's PTY begins spawning — not back at `insertAgentSession`
  // (enqueue). `agentBootQueue` drains serially, so arming at enqueue let the
  // window lapse before a queued boot even started under fan-out. No-op for a
  // user synthetic (nothing was recorded for its id).
  sessions.armAgentCorrelationForBoot(sessionId)

  let ptyId: string
  try {
    ptyId = await window.api.ptyCreate({
      cols: t.cols,
      rows: t.rows,
      kind: spec.kind,
      claudeSessionId: spec.claudeSessionId,
      cwd,
      noFlicker: prefs.noFlicker === true,
      sessionKey: sessionId,
      bootOverride: spec.bootOverride,
      // Agent-created sessions spawn with --mcp-config withheld + permissions
      // force-downgraded in main (BLOCKER-1). Undefined for user sessions.
      agentControlled: spec.agentControlled,
      // T123: the mode this session was born in — main resolves the mode's
      // contract and injects it into the spawn preamble. Undefined otherwise.
      mode: spec.mode,
      // T215: WHO caused this spawn. The entry's own recorded origin wins; with
      // none (a cold transcript that predates the marker) the GESTURE decides —
      // a selection is the operator's, a `session.wake` is an agent's. Main
      // fails closed to `'operator'` when neither says.
      spawnedBy: spec.spawnedBy ?? (wakeGesture === 'peer-message' ? 'agent' : 'operator'),
      // BUG-70 §4: stamp the park ledger with the real gesture instead of
      // `'unknown'` — an agent-driven wake must be legible as one.
      ...(wakeGesture ? { wakeGesture } : {})
    })
  } catch (e) {
    // Main-process spawn failures surface here: claude CLI not on PATH, the
    // claudeSessionId validation throw, an existsSync race on the cwd, etc.
    // Without this catch the rejection vaults out of `createLiveTerminal`
    // unhandled and the user sees a blank pane with no signal. Toast +
    // dispose the xterm we just constructed to avoid a leak.
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({
      kind: 'danger',
      title: i18n('terminalPane.spawnFailed'),
      description: message
    })
    t.dispose()
    return undefined
  }

  // Construct `live` BEFORE wiring `onPtyData` so the data handler can capture
  // it for the backpressure watermark math (T-3.6). The closure reads/writes
  // `live.pendingBytes` / `live.paused` on every chunk; xterm.js invokes the
  // `term.write(data, cb)` callback when its parser has processed the chunk,
  // at which point we decrement the in-flight byte count and — if we'd
  // previously asked main to pause — resume the PTY once we cross the low
  // watermark from above.
  const live = wireLiveTerminal(sessionId, t, ptyId, host)
  live.cleanups.push(registerFileLinkProvider(t, fileLinkContext()))
  return live
}

/**
 * Build the `LiveTerminal` record for an already-open xterm `t` and an
 * already-spawned (or adopted) `ptyId`: wire the data/exit/input/resize flow
 * with renderer backpressure (T-3.6), register it in `liveTerminals`, attach
 * the ResizeObserver, and install focus listeners. Shared by the create path
 * (`createLiveTerminal`, fresh spawn) and the adopt path (`adoptLiveTerminal`,
 * re-adopted PTY on reload). `host` is the DOM node `t` was opened into.
 */
function wireLiveTerminal(
  sessionId: string,
  t: Terminal,
  ptyId: string,
  host: HTMLElement
): LiveTerminal {
  const cleanups: Array<() => void> = []
  // Screen-mode = a folder terminal (`isShellTerminal`). Captured once: it never
  // changes for a given session, and a shell terminal never migrates ids.
  const screenMode =
    sessions.allSessions.find((s) => s.sessionId === sessionId)?.isShellTerminal === true
  const live: LiveTerminal = {
    sessionId,
    term: t,
    ptyId,
    cleanups,
    resizeObserver: null,
    resizeTimer: null,
    pendingBytes: 0,
    paused: false,
    focusCleanup: null,
    adoptQueue: null,
    screenMode,
    lastTitle: null,
    snapshotTimer: null,
    dead: false
  }

  // Track the OSC title for the screen-detection classifier ("is this pane
  // codex?"). Only screen-mode panes care; a Claude pane never snapshots.
  if (screenMode) {
    const titleSub = t.onTitleChange((title) => {
      live.lastTitle = title
    })
    cleanups.push(() => titleSub.dispose())
  }

  cleanups.push(
    window.api.onPtyData(ptyId, (data, seq) => {
      // During adoption, hold live chunks until the replayed scrollback is
      // written, so history precedes live output (I4). We still tag with seq
      // for the post-replay dedup. Backpressure accounting is skipped while
      // queued — the queue is short-lived and bounded by adoption latency.
      if (live.adoptQueue) {
        live.adoptQueue.push({ data, seq })
        return
      }
      const n = byteLength(data)
      live.pendingBytes += n
      if (!live.paused && live.pendingBytes >= HIGH_WATERMARK) {
        live.paused = true
        window.api.ptyPauseFlow(live.ptyId)
      }
      t.write(data, () => {
        live.pendingBytes -= n
        if (live.pendingBytes < 0) live.pendingBytes = 0 // defensive — should never fire
        if (live.paused && live.pendingBytes <= LOW_WATERMARK) {
          live.paused = false
          window.api.ptyResumeFlow(live.ptyId)
        }
      })
      // Screen detection (A2): re-arm the debounced bottom-buffer snapshot. Cheap
      // — just (re)sets a timer; the actual grid read + IPC happen once output
      // settles. No-op for hooked Claude panes (screenMode false).
      if (live.screenMode) scheduleScreenSnapshot(live)
    }),
    window.api.onPtyExit(ptyId, (evt) => {
      // BUG-70 §3.3: a park is a resource decision, not a lifecycle outcome —
      // the terminal is about to be disposed anyway (`onPtyHibernated`), so
      // painting "[session ended]" here would lie into a scrollback the
      // operator may still scroll, and the task-state dot must not flip.
      if (shouldMarkExited(evt.reason)) {
        t.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
      }
      // Flag the cache entry dead (zombie-synthetic fix) so a later respawn
      // attempt — `activate()`'s reuse branch, or `drainBgBoot`'s Retry-boot
      // skip guard — disposes this corpse instead of reattaching/ignoring it.
      // The entry itself stays in `liveTerminals` (scrollback + the frozen
      // "[session ended]" text stay viewable on plain reselect, unchanged for
      // real sessions); only an actual respawn attempt disposes it.
      live.dead = true
      // The PTY is gone — drop it from the live set so the folder zone reflects
      // reality (a folder with no running PTY can fall back to age/status), and
      // drop its writer so the bus invariant holds (writer present iff PTY live).
      sessions.unregisterLiveSession(live.sessionId)
      unregisterWriter(live.sessionId)
      // Process-liveness overlay (session-state spec §3.3): a NATURAL exit —
      // user-close removes this listener before the kill, so this never fires
      // for an intentional close. Clean exit → completed, else → failed.
      if (shouldMarkExited(evt.reason)) {
        sessions.markSessionExited(sessionId, evt.exitCode)
      }
    })
  )

  t.onData((data) => window.api.ptyWrite(ptyId, data))
  t.onResize(({ cols, rows }) => window.api.ptyResize(ptyId, cols, rows))

  // Clipboard, word/char-delete, and font-size chords (design.md §6). Attached
  // once per terminal — survives detach/re-attach since the Terminal is cached.
  installTerminalKeymap(t, {
    write: (data) => window.api.ptyWrite(ptyId, data),
    fontStep: (delta) => settings.setFontSize(settings.terminalFontSize + delta),
    fontReset: () => settings.setFontSize(DEFAULT_TERMINAL_FONT_SIZE)
  })

  liveTerminals.set(sessionId, live)
  // Expose this PTY's writer so the footer Pasted-images popover can re-attach an
  // image by injecting its path (writer-bus decouples it from `liveTerminals`).
  registerWriter(sessionId, (data) => window.api.ptyWrite(ptyId, data))
  // Mark the session live so the folder-zone classifier surfaces its folder in
  // the Active-elsewhere zone regardless of age (spec §5.2 isLiveFolder).
  sessions.registerLiveSession(sessionId)
  // Injection watchdog (docs/specs/2026-07-15-preprompt-injection-watchdog.md):
  // catches a queued pre-prompt whose delivery never completes even though the
  // PTY came up live. No-op when nothing is queued.
  armInjectionWatchdog(sessionId)
  attachResizeObserver(live, host)
  live.focusCleanup = installFocusListeners(live)
  return live
}

/**
 * Re-adopt an already-running PTY (`livePty`) after a renderer reload (I4/I5).
 * Builds a fresh xterm at the PTY's current size, replays the main-side ring
 * buffer to repaint scrollback, then goes live — deduping the overlap between
 * the replay snapshot and any live chunks that arrived mid-adoption by `seq`.
 * Returns the wired `LiveTerminal`, or undefined if the host is gone.
 *
 * Unlike `createLiveTerminal`, this NEVER calls `ptyCreate` — the PTY already
 * exists in the main process; we attach to it by `ptyId`.
 */
async function adoptLiveTerminal(livePty: {
  sessionKey: string
  ptyId: string
  cols: number
  rows: number
}): Promise<LiveTerminal | undefined> {
  if (!termEl.value) return undefined
  const host = termEl.value

  const t = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: settings.terminalFontSize,
    lineHeight: 1.55,
    cursorBlink: true,
    allowTransparency: false,
    // Option+click is Harnu's "reveal this path in Browse files" gesture
    // (`terminal-file-links.ts`). xterm's default would ALSO emit cursor-move
    // escape sequences on that click, landing arrow keys in Claude's composer.
    altClickMovesCursor: false,
    // ...and when the TUI tracks the mouse, xterm would also REPORT that click
    // to it — Claude Code then opens a clicked URL itself, a second open on top
    // of ours (or of the PR Stack routing). Forcing selection on Option keeps
    // Option+click inside Harnu.
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    theme: themeFromCss()
  })
  t.loadAddon(new WebLinksAddon(openTerminalLink))
  t.loadAddon(new ImageAddon())
  t.open(host)
  await nextTick()
  await ensureTerminalFontLoaded()

  // Spawn-at-parity: open the grid at the PTY's last-known size so the replayed
  // scrollback lines up, then re-measure against this host and resize once.
  t.resize(livePty.cols, livePty.rows)
  await nextTick()
  const fs = settings.terminalFontSize
  const real = measureXtermCells(host, fs) ?? measureCells(host, undefined, fs)
  if (real.cols !== t.cols || real.rows !== t.rows) {
    t.resize(real.cols, real.rows)
    window.api.ptyResize(livePty.ptyId, real.cols, real.rows)
  }

  // Wire first, with the adopt gate engaged so live chunks queue rather than
  // racing ahead of the replayed history.
  const live = wireLiveTerminal(livePty.sessionKey, t, livePty.ptyId, host)
  live.cleanups.push(registerFileLinkProvider(t, fileLinkContext()))
  live.adoptQueue = []

  // Replay the ring buffer, then release the gate: write history, then the
  // deduped live chunks that arrived while we awaited, then go fully live.
  // A failing `ptyReplay` (transient IPC error, PTY died mid-adopt) must NOT
  // throw out of here — that would leave `adoptQueue` non-null forever (live
  // chunks queue unbounded, never paint) and reject `doReadopt`. Default to an
  // empty replay and always drain + release the gate.
  let replay: { data: string; seq: number } = { data: '', seq: 0 }
  try {
    replay = await window.api.ptyReplay(livePty.ptyId)
  } catch {
    // No history available — proceed with whatever live data we queued.
  }
  if (replay.data) t.write(replay.data)
  const queued = live.adoptQueue ?? []
  live.adoptQueue = null
  for (const chunk of dedupeAfterSeq(queued, replay.seq)) {
    t.write(chunk.data)
  }

  return live
}

/**
 * One-shot re-adoption of every live Claude PTY (I4/I5). Lazily kicked off the
 * first time a selection needs a terminal (and re-entrant-safe via the cached
 * promise). Adopts each live PTY into `liveTerminals` keyed by sessionKey —
 * WITH scrollback replay — then detaches them all; the `selectedId` watcher's
 * `activate()` re-attaches the one that's selected. Because this resolves
 * before `activate` runs, the selected session takes the reuse/attach branch
 * (adopted, scrollback restored) instead of the create branch (blank).
 *
 * Synthetic PTYs the reloaded store no longer knows about are still adopted
 * (kept alive, detached, orphaned) rather than killed — harmless; persisting
 * synthetics across reload is Phase 4 (G4).
 *
 * `readoptPromise` is module-scoped (plain `<script>` block above, T14): a
 * remount reuses the shared cache, so `doReadopt` only truly runs on a real
 * renderer reload (heap wiped), not on every `showSession` flip.
 */
function ensureReadopted(): Promise<void> {
  if (!readoptPromise) readoptPromise = doReadopt()
  return readoptPromise
}
async function doReadopt(): Promise<void> {
  if (!termEl.value) return
  let live: Awaited<ReturnType<typeof window.api.ptyListLive>>
  try {
    live = await window.api.ptyListLive()
  } catch {
    return // main not ready / no live PTYs — the normal create path handles it
  }
  for (const p of live) {
    if (liveTerminals.has(p.sessionKey)) continue // already created/adopted
    // Only adopt PTYs the store actually surfaces as a session. A reloaded
    // store rebuilds from disk, so a synthetic that never wrote a JSONL is
    // gone from the model — adopting its PTY would create a renderer terminal
    // that's detached forever (no sidebar row can ever re-attach it), leaking
    // an xterm + IPC listeners on every reload (review #3). Leave such PTYs in
    // the main process; they die on quit. Real sessions ARE in the model.
    if (!sessions.allSessions.some((s) => s.sessionId === p.sessionKey)) continue
    try {
      const adopted = await adoptLiveTerminal(p)
      // Adopt opened the xterm into the host; detach so only the selected
      // session ends up visibly attached (the watcher re-attaches it).
      if (adopted) detachLiveTerminal(adopted)
    } catch {
      // One PTY failing to adopt must not poison the rest or reject this
      // promise — a rejected `readoptPromise` is cached by `ensureReadopted`
      // and would brick `activate()` for every later selection (review #1).
      // The normal create path will `claude --resume` this session instead.
    }
  }
}

/**
 * Re-attach an existing `LiveTerminal` to the host. Pulls its xterm-managed
 * DOM node and appends it inside `termEl`, then resizes-on-attach to pick up
 * any host dimension changes that happened while detached (window resize
 * with this terminal hidden, sidebar collapse, etc.) and rebinds the
 * ResizeObserver to the host.
 */
function attachLiveTerminal(live: LiveTerminal): void {
  if (!termEl.value) return
  const host = termEl.value
  if (!live.term.element) return

  // `term.element` is the canonical xterm-managed DOM node — `term.open()`
  // created it on first mount and never replaces it. Just appendChild moves
  // it across hosts; the DOM event handlers and accessibility tree follow.
  host.appendChild(live.term.element)

  // Resize-on-attach: while detached the host may have changed dimensions
  // (window resize, layout change) or the terminal font size may have changed
  // while this terminal was detached. Re-measure (using the current font size)
  // and forward to xterm + PTY so the redraw and SIGWINCH happen exactly once
  // on becoming visible.
  const fs = settings.terminalFontSize
  const next = measureXtermCells(host, fs) ?? measureCells(host, undefined, fs)
  if (next.cols !== live.term.cols || next.rows !== live.term.rows) {
    live.term.resize(next.cols, next.rows)
    window.api.ptyResize(live.ptyId, next.cols, next.rows)
  }

  attachResizeObserver(live, host)
  // Re-bind focus listeners on every attach: while detached we tear them
  // down to keep the shared `terminalFocused` ref accurate (a detached
  // terminal cannot receive keyboard input, so its "focused" state is
  // meaningless). Tear down any stale handler first to keep the
  // install→cleanup pairing 1:1.
  if (live.focusCleanup) {
    live.focusCleanup()
    live.focusCleanup = null
  }
  live.focusCleanup = installFocusListeners(live)
  live.term.focus()

  // Force a full repaint on re-attach. Re-appending a cached `term.element`
  // into a fresh host does not, by itself, make xterm's canvas/WebGL renderer
  // redraw — on the dims-UNCHANGED path above the `resize()` (which repaints as
  // a side effect) is skipped, so the renderer can keep stale/blank glyphs
  // until the next `write` triggers a repaint (the "blank/half terminal until
  // you type" bug). Mirror the theme-watch refresh: defer one frame so the
  // element is laid out (non-zero size) before refreshing, then repaint every
  // row. Cheap and harmless on the resize path; the actual fix is the no-resize
  // path.
  requestAnimationFrame(() => {
    try {
      // Reapply the theme on re-attach (BUG-7 / T60): symmetric with HelperPane.
      // The per-instance theme watch only runs while mounted, so blind the attach
      // to a theme switch that happened while this terminal was detached and
      // self-heal here. `themeFromCss()` is a `getComputedStyle` already on the
      // path (measure above), so this is effectively free.
      live.term.options.theme = themeFromCss()
      live.term.refresh(0, live.term.rows - 1)
    } catch {
      // ignore — detached or disposed between attach and the next frame
    }
  })
}

/**
 * Detach `live` from the DOM without disposing. Removes its element from the
 * host and stops observing the host for resizes (the host belongs to whoever
 * attaches next). The Terminal + PTY keep running in the background — Claude
 * keeps streaming, the xterm buffer keeps filling, conversation context is
 * preserved.
 */
function detachLiveTerminal(live: LiveTerminal): void {
  if (live.resizeObserver) {
    live.resizeObserver.disconnect()
    live.resizeObserver = null
  }
  clearResizeTimer(live)
  // Remove focus listeners and unregister this pane from the shared Set.
  // Without the explicit unregister, a `focusin` that fired on this terminal
  // moments before detach would leave `'main'` in the focused-panes Set
  // forever — ⌘W would then never close a session again until a different
  // terminal grabbed focus.
  if (live.focusCleanup) {
    live.focusCleanup()
    live.focusCleanup = null
  }
  unregisterFocusedPane(MAIN_PANE_ID)
  if (live.term.element && live.term.element.parentNode) {
    live.term.element.parentNode.removeChild(live.term.element)
  }
}

/**
 * Dispose `live` entirely — kills the PTY, tears down IPC subscriptions, and
 * disposes the Terminal. Used on app unmount and for explicit
 * `closeSession()` calls. NOT called on tab switch (that's just detach).
 */
function disposeLiveTerminal(live: LiveTerminal): void {
  detachLiveTerminal(live)
  // Screen detection (A2): stop snapshotting and drop the pane's detector memory
  // in main so a reused id never inherits a stale state. Detach (tab switch)
  // deliberately does NOT do this — a backgrounded codex pane keeps updating.
  if (live.snapshotTimer) {
    clearTimeout(live.snapshotTimer)
    live.snapshotTimer = null
  }
  if (live.screenMode) {
    try {
      window.api.paneScreenDetach(live.sessionId)
    } catch {
      /* main gone — nothing to clean up */
    }
  }
  sessions.unregisterLiveSession(live.sessionId)
  unregisterWriter(live.sessionId)
  disarmInjectionWatchdog(live.sessionId)
  for (const fn of live.cleanups) {
    try {
      fn()
    } catch {
      /* swallow */
    }
  }
  live.cleanups = []
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
  // Reset backpressure bookkeeping. Not strictly required (the object is gone)
  // but defends against lingering closures still holding a reference and
  // attempting to read these fields after dispose (T-3.6).
  live.pendingBytes = 0
  live.paused = false
}

/**
 * Expose the close action on the sessions store so the rest of the app
 * (future X-on-tab button, future cmd-W shortcut) can ask us to dispose a
 * specific session. Installed on first mount; the closure captures the
 * module-level `liveTerminals` map.
 */
const offClose = sessions.registerCloseHandler((sessionId: string) => {
  const live = liveTerminals.get(sessionId)
  if (live) {
    if (attachedId === sessionId) attachedId = null
    disposeLiveTerminal(live)
    liveTerminals.delete(sessionId)
  }
})

/**
 * Restart a session's `claude` process (sessions store `reloadSession`).
 * Kills the running PTY (if any) and respawns it so the relaunch re-reads
 * everything `claude` only loads at startup — a freshly-installed skill, an
 * edited `settings.json`, a new MCP server. The conversation is preserved on
 * disk, so the respawned `claude --resume <uuid>` restores it. This is also
 * the mechanism the "Restart session" menu item uses to bring an ENDED real
 * session back (`SessionMenu.vue`'s `shouldShowRestart`): its `LiveTerminal`
 * is cached but marked `dead` (`onPtyExit` never deletes the cache entry on
 * a natural exit), so disposing it here is what actually clears the way for
 * a fresh spawn — reselecting the row alone would just reattach the same
 * dead terminal.
 *
 * Two paths, mirroring how `activate`/the selection watcher treat attached vs
 * backgrounded terminals:
 *  - **Attached** (this session is the visible main pane): dispose (if a
 *    cached entry exists) + immediately re-`activate`, so the restart is
 *    visible right away. `disposeLiveTerminal` runs `ptyDestroy` (which
 *    clears the main-side session-index entry) well before
 *    `activate`→`createLiveTerminal`→`ptyCreate` (gated behind the font load
 *    + a tick), so the I1 dedup sees the slot freed and spawns fresh instead
 *    of returning the just-killed ptyId.
 *  - **Backgrounded** (live but not the visible pane): dispose only. Recreating
 *    eagerly would `term.open()` into the shared host and steal the view; instead
 *    we let the next `activate(id)` (when the user switches back) respawn it.
 *
 * No cached entry at all (another pane may own it, or this session was never
 * opened this app run) is not treated as a no-op: if the session is
 * currently attached+selected, we still call `activate()` so an ended
 * session that was never cached still gets a fresh spawn instead of silently
 * doing nothing behind a success toast.
 */
const offReload = sessions.registerReloadHandler(async (sessionId: string) => {
  const live = liveTerminals.get(sessionId)
  const wasAttached = attachedId === sessionId
  if (live) {
    if (wasAttached) attachedId = null
    disposeLiveTerminal(live)
    liveTerminals.delete(sessionId)
  }
  if (wasAttached && sessions.selectedId === sessionId) {
    await activate(sessionId)
  }
})

/**
 * Main parked this session to reclaim memory (T119). Tear down the xterm + IPC subs and
 * drop it from the cache — the sidebar row stays.
 *
 * Modeled on the reload handler above (dispose, then let the next `activate` respawn), with
 * ONE deliberate difference: we never re-activate. Reclaiming the memory IS the point, and
 * the policy already refuses to park the selected session, so there is nothing on screen to
 * restore. The next click takes the normal create path (`claude-resume`), which is why
 * waking needs no code of its own.
 *
 * `disposeLiveTerminal` will call `ptyDestroy` on an id main has already killed — a no-op
 * there (unknown id → early return), and it still cleans the renderer's listener maps. Left
 * as-is rather than special-cased.
 */
const offHibernated = window.api.onPtyHibernated(({ sessionKey }) => {
  const live = liveTerminals.get(sessionKey)
  if (!live) return
  if (attachedId === sessionKey) attachedId = null
  disposeLiveTerminal(live)
  liveTerminals.delete(sessionKey)
  sessions.markHibernated(sessionKey)
})

/**
 * Re-key a live terminal in place (U-1.6). Called by the store's reconciliation
 * step when a synthetic session's local id is replaced by the real uuid Claude
 * wrote to disk. We move the same `LiveTerminal` instance under the new key —
 * the PTY process, xterm.js Terminal, IPC subscriptions, and ResizeObserver
 * all keep running. Only the Map key changes (plus `attachedId` if it pointed
 * at the synthetic).
 *
 * The `watch(sessions.selectedId)` handler that fires when the store updates
 * `selectedId` from `synthetic-X` → `<real-uuid>` will then see the new id
 * already present in `liveTerminals` and take the "reuse" branch in
 * `activate()` — re-attaching the same DOM node instead of spawning a fresh
 * PTY. That preserves Claude's running process and the entire xterm buffer.
 */
const offMigrate = sessions.registerMigrateHandler((fromId: string, toId: string) => {
  const live = liveTerminals.get(fromId)
  if (!live) return
  liveTerminals.delete(fromId)
  liveTerminals.set(toId, live)
  // Re-key the live record + the store's live-PTY set so the folder zone keeps
  // tracking the same running process under its now-real uuid.
  live.sessionId = toId
  sessions.unregisterLiveSession(fromId)
  sessions.registerLiveSession(toId)
  // Carry an armed injection watchdog across the id change too (preserves its
  // attempt budget instead of restarting it, or dropping it entirely).
  rekeyInjectionWatchdog(fromId, toId)
  // Re-key the PTY writer too (same process, new id) so Re-attach keeps working
  // after a synthetic session migrates to its real uuid.
  unregisterWriter(fromId)
  registerWriter(toId, (data) => window.api.ptyWrite(live.ptyId, data))
  if (attachedId === fromId) attachedId = toId
  // Keep the main-side session index in lockstep so the dedup (I1) recognizes
  // the now-real uuid instead of cloning it on a later resume.
  window.api.ptyRekey(fromId, toId)
})

// BUG-17/T75 readiness-gate timings for the PASTE (a phase BEFORE the submit,
// which now lives in `prompt-inject.ts`): hold the bracketed paste until the
// composer is ready. A CC
// composer-ready hook injects at once; otherwise wait ~500 ms of output silence
// for the `claude` banner to finish printing (so the paste can't interleave its
// `^[[200~` escapes into the banner), capped at ~2.5 s so a hooks-off launch
// with an endless banner still proceeds.
const INJECT_BANNER_QUIET_MS = 500
const INJECT_READY_CAP_MS = 2500
/**
 * BUG-85: the hard cap when `requireComposerReadyHook` is on. `INJECT_READY_CAP_MS`
 * (2.5 s) is the best-effort mode's "paste anyway" deadline and stays as it is —
 * but in hook-required mode the cap is not a paste, it is how long Harnu waits for
 * a composer-ready hook before giving the prompt back. 2.5 s is far shorter than a
 * cold `claude` takes to reach SessionStart (MCP servers, settings load, the trust
 * check), so every fallback-path dispatch escalated. 30 s is a realistic boot
 * window and still well under the 120 s dead-synthetic reaper.
 *
 * Aggregate worst case: the watchdog re-arms a fresh gate on each retry
 * (`INJECTION_WATCHDOG_MAX_ATTEMPTS`, currently 4), so a session that never
 * gets its hook can take roughly the initial gate plus four retry gates —
 * about 5 * 30 s = 150 s — before `markPromptUndelivered` fires, up from the
 * pre-fix ~3 s worst case. If 150 s to a visible failure badge is ever judged
 * too long, `INJECTION_WATCHDOG_MAX_ATTEMPTS` (not this constant) is the
 * lever to pull.
 */
const INJECT_HOOK_WAIT_MS = 30_000

/**
 * BUG-85: session ids with an inject gate currently armed and waiting. The
 * watchdog reads this (`gateArmed`) so it neither retries into a guaranteed
 * no-op nor escalates a session whose gate is still legitimately waiting.
 */
const armedInjectGates = new Set<string>()

// A failed target resolve almost always means "mid-MCP-reconnect" — a
// transient blip, not a dead session. Retrying a handful of times a beat
// apart carries that case without turning a truly unreachable session into a
// multi-second hang before the prompt is (correctly) left queued for later.
const INJECT_TARGET_RETRY_MS = 400
const INJECT_TARGET_MAX_ATTEMPTS = 5

/**
 * BUG-64: whether this app instance's per-session hook `--settings` injection
 * (T92, `pty.ts`) is expected to wire a composer-ready hook for an agent
 * session — read once from `window.api.hooksStatus()`'s `injectPerSession`
 * and cached for the process lifetime (the Settings toggle it mirrors changes
 * rarely, and a stale read only ever costs "the gate keeps today's best-effort
 * behavior until restart", never a correctness issue). A rejected/unavailable
 * call degrades to `false` — the pre-BUG-64 behavior — so a broken IPC call
 * can never make the injection gate hang instead of pasting.
 */
const hooksInjectPerSessionEnabled: Promise<boolean> = window.api
  .hooksStatus()
  .then((s) => s.injectPerSession)
  .catch(() => false)

/**
 * MCP agent-created sessions (T25): inject the agent's queued pre-prompt, gated
 * on COMPOSER readiness (T75/BUG-17). `pty:sessionReady` fires right after
 * `spawn()`, before the `claude` TUI has printed its banner — pasting then
 * leaked `^[[200~` escapes into the banner and let the submit race a mid-banner
 * lull (1/3 fan-out failures). So instead of pasting on ready, we arm a
 * `createInjectGate` that holds the paste until a real composer-ready signal:
 *  - a CC composer-ready HOOK for this session (`onHook`, filtered by
 *    {@link isComposerReadyHook}; re-keyed on the synth→real migration so a hook
 *    keyed to the real uuid still matches), OR
 *  - output QUIESCENCE — the banner stopped printing (`onPtyData`), the
 *    order-independent fallback that carries the common fresh-session case and a
 *    hooks-off launch, OR
 *  - a hard cap, so a launch never hangs.
 *
 * BUG-64: when this app's per-session hook injection is wired
 * (`hooksInjectPerSessionEnabled`), quiescence/cap stop being trusted to
 * inject on their own — they only prove the PTY went quiet, not that the
 * COMPOSER specifically is up, and T174's live validation caught exactly that
 * gap (a ready, empty composer, prompt never delivered). Only the hook may
 * paste in that case; quiescence/cap settle without pasting and the existing
 * watchdog escalates to `prompt_undelivered`. Sessions whose hooks aren't
 * wired at all keep the old best-effort behavior — see `createInjectGate`'s
 * `requireComposerReadyHook`.
 *
 * Normal (non-agent) sessions queue no prompt, so `takeAgentPrompt` returns
 * `undefined` and this is a no-op for them. The PTY is resolved from the local
 * live-terminal cache first (the agent session is selected, so it is attached),
 * falling back to the main-side lookup for robustness.
 */
async function armInjectGate(sessionKey: string): Promise<void> {
  // Resolve the paste target BEFORE consuming the one-shot pre-prompt: peek →
  // resolve PTY → consume-only-on-success (`acquireInjectionTarget`). A
  // sessionReady that can't yet reach a PTY — the live terminal isn't attached
  // AND the main-side lookup is momentarily down (e.g. mid-MCP-reconnect) — must
  // leave the prompt QUEUED, never drop it, or the session boots blank. Once a
  // target is resolved, the PTY id is stable across the synth→real migration
  // (same process, re-keyed), so we inject against `resolvedPtyId` directly and
  // never need to re-resolve post-migrate.
  const target = await acquireInjectionTargetWithRetry(
    {
      hasPrompt: () => sessions.hasAgentPrompt(sessionKey),
      resolvePtyId: async () =>
        liveTerminals.get(sessionKey)?.ptyId ?? (await mcp.ptyIdForSession?.(sessionKey)) ?? null,
      takePrompt: () => sessions.takeAgentPrompt(sessionKey),
      setTimer: (cb, ms) => setTimeout(cb, ms),
      record: (event) => injectionLedger.record(sessionKey, event)
    },
    { retryMs: INJECT_TARGET_RETRY_MS, maxAttempts: INJECT_TARGET_MAX_ATTEMPTS }
  )
  if (!target) return
  const { ptyId: resolvedPtyId, prompt } = target

  // The session id whose composer-ready hooks count. Starts synthetic; the hook
  // stream is keyed by the real uuid, so we follow the synth→real migration.
  let watchedId = sessionKey
  const disposers: Array<() => void> = []
  const teardown = (): void => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* a dead subscription must never break the gate teardown */
      }
    }
  }

  // BUG-64: for an agent session whose hook injection is wired, only the
  // composer-ready hook may paste — quiescence/cap withhold instead of
  // blind-pasting into an unknown idling prompt (see this file's module doc).
  const requireComposerReadyHook = await hooksInjectPerSessionEnabled

  armedInjectGates.add(sessionKey)
  const gate = createInjectGate({
    inject: () =>
      pasteAndSubmit(resolvedPtyId, prompt, (event) => injectionLedger.record(watchedId, event)),
    requeue: () => sessions.requeueAgentPrompt(watchedId, prompt),
    onSettled: () => {
      // BUG-85 fix round 1: delete by the CURRENT `watchedId`, not the captured
      // `sessionKey` — after a synth→real migration the entry lives under the
      // real uuid (re-keyed by the migrate handler below), and deleting the
      // stale synthetic key here would leave a phantom entry that was never
      // actually in the Set post-migration while missing the real one.
      armedInjectGates.delete(watchedId)
      teardown()
    },
    quietMs: INJECT_BANNER_QUIET_MS,
    // BUG-85: hook-required mode waits a realistic cold-boot window for the hook;
    // best-effort mode keeps its original 2.5 s "paste anyway" deadline.
    capMs: requireComposerReadyHook ? INJECT_HOOK_WAIT_MS : INJECT_READY_CAP_MS,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h),
    record: (event) => injectionLedger.record(watchedId, event),
    requireComposerReadyHook
  })

  const offHook = window.api.onHook?.(({ sessionId, taskState, event }) => {
    if (sessionId === watchedId && isComposerReadyHook(event, taskState)) gate.signalReady()
  })
  if (offHook) disposers.push(offHook)
  disposers.push(
    sessions.registerMigrateHandler((fromId, toId) => {
      if (fromId !== watchedId) return
      // BUG-85 fix round 1: re-key the armed-gate entry BEFORE reassigning
      // `watchedId` — the watchdog is re-keyed to `toId` by
      // `rekeyInjectionWatchdog` around this same migration, so if this Set
      // stays keyed by the old (synthetic) id, `tickInjectionWatchdog(toId)`
      // reads `gateArmed` as false for a gate that is still legitimately
      // waiting and escalates to `prompt_undelivered` within a few ticks.
      armedInjectGates.delete(fromId)
      armedInjectGates.add(toId)
      watchedId = toId
      // BUG-64: a hook that fired for the real uuid BEFORE this migrate ran
      // was dropped by the `onHook` filter above (it was still keyed to the
      // synthetic id) — pull main's already-folded state for the new id
      // (mirrors `sessions.ts`'s `fireMigrate` resync) so a composer that's
      // genuinely already ready doesn't get escalated on a lost race.
      if (requireComposerReadyHook) {
        void window.api
          .hooksStateFor?.(toId)
          ?.then((st) => {
            if (st === 'idle') gate.signalReady()
          })
          .catch(() => {})
      }
    })
  )
  disposers.push(window.api.onPtyData(resolvedPtyId, () => gate.onData()))
  disposers.push(window.api.onPtyExit(resolvedPtyId, () => gate.cancel()))
}

/**
 * Injection watchdog (docs/specs/2026-07-15-preprompt-injection-watchdog.md): the
 * sibling gap the drop-fix above leaves open. `armInjectGate` fires once per
 * `pty:sessionReady` / `registerLiveSession` call; if that single attempt can't
 * resolve a PTY, the prompt stays queued (no longer dropped) but nothing
 * re-attempts delivery — a session can boot a perfectly live REPL and sit blank
 * forever, invisible to the boot reaper (`bootVerdict` already returns `booted`
 * the moment a PTY is live, blind to whether the prompt was ever acquired). This
 * watchdog re-arms `armInjectGate` on a backoff and escalates to a visible
 * failure (`markPromptUndelivered`) once the retry budget is spent.
 */
const INJECTION_WATCHDOG_TICK_MS = 250
const INJECTION_WATCHDOG_RETRY_MS = 750
const INJECTION_WATCHDOG_MAX_ATTEMPTS = 4

interface InjectionWatchdogEntry {
  timer: ReturnType<typeof setInterval>
  armedAt: number
  attempts: number
}
const injectionWatchdogs = new Map<string, InjectionWatchdogEntry>()

function disarmInjectionWatchdog(sessionId: string): void {
  const w = injectionWatchdogs.get(sessionId)
  if (!w) return
  clearInterval(w.timer)
  injectionWatchdogs.delete(sessionId)
}

function tickInjectionWatchdog(sessionId: string): void {
  const w = injectionWatchdogs.get(sessionId)
  if (!w) return
  const live = liveTerminals.get(sessionId)
  const verdict = injectionVerdict({
    promptQueued: sessions.hasAgentPrompt(sessionId),
    injected: injectionLedger.wasInjected(sessionId),
    gateArmed: armedInjectGates.has(sessionId),
    ptyLive: !!live && !live.dead,
    elapsedMs: Date.now() - w.armedAt,
    attempts: w.attempts,
    retryEveryMs: INJECTION_WATCHDOG_RETRY_MS,
    maxAttempts: INJECTION_WATCHDOG_MAX_ATTEMPTS
  })
  if (verdict === 'delivered') {
    disarmInjectionWatchdog(sessionId)
    return
  }
  if (verdict === 'undelivered') {
    disarmInjectionWatchdog(sessionId)
    sessions.markPromptUndelivered(sessionId)
    return
  }
  if (verdict === 'retry') {
    w.attempts++
    void armInjectGate(sessionId)
  }
  // 'pending' — keep ticking.
}

/**
 * Arm the watchdog for a session whose PTY just went live. Hooked at both
 * `registerLiveSession` call sites (fresh boot in `wireLiveTerminal` + the
 * synth→real migrate re-key below) so a missed or never-subscribed
 * `pty:sessionReady` (failure modes B/C in the spec) still gets serviced — this
 * is an independent signal from `armInjectGate`'s own trigger. No-op when
 * nothing is queued (the common, promptless session pays nothing) or when
 * already armed for this id.
 */
function armInjectionWatchdog(sessionId: string): void {
  if (injectionWatchdogs.has(sessionId)) return
  if (!sessions.hasAgentPrompt(sessionId)) return
  injectionWatchdogs.set(sessionId, {
    timer: setInterval(() => tickInjectionWatchdog(sessionId), INJECTION_WATCHDOG_TICK_MS),
    armedAt: Date.now(),
    attempts: 0
  })
}

/** Carry an armed watchdog across the synth→real id migration, preserving its budget. */
function rekeyInjectionWatchdog(fromId: string, toId: string): void {
  const w = injectionWatchdogs.get(fromId)
  if (!w) return
  injectionWatchdogs.delete(fromId)
  injectionWatchdogs.set(toId, w)
}

const mcp = getMcpApi()
const offSessionReady =
  typeof mcp.onSessionReady === 'function'
    ? mcp.onSessionReady(({ sessionKey }) => void armInjectGate(sessionKey))
    : null

/**
 * Retry an undelivered pre-prompt (spec §5.5): NOT `retrySyntheticBoot` (that
 * path no-ops on an already-live PTY, see `sessions.ts`'s `retryPromptInjection`
 * doc comment for why). Re-arms the watchdog with a fresh budget — the prompt is
 * still queued, `retryPromptInjection` only ever fires for that reason — and
 * fires an immediate `armInjectGate` attempt rather than waiting for the first
 * tick.
 */
const offPromptRetry = sessions.registerPromptRetryHandler((sessionId: string) => {
  disarmInjectionWatchdog(sessionId)
  armInjectionWatchdog(sessionId)
  void armInjectGate(sessionId)
})

/**
 * Activate the live terminal for `id`. Creates it on first request, reuses
 * thereafter. Detaches the previously-attached one (does NOT dispose).
 */
async function activate(id: string): Promise<void> {
  if (!termEl.value) return

  // T119: main owns the hibernation LRU but has no idea what the operator is looking at.
  // Push it here — this stamps the focus axis AND marks `id` as the one session the policy
  // may never park. Sent before the create below, so a session can never be parked by the
  // very cap check that its own spawn triggers.
  window.api.ptyTouchFocus(id)

  // Detach the previously-attached terminal, if any.
  if (attachedId && attachedId !== id) {
    const prev = liveTerminals.get(attachedId)
    if (prev) detachLiveTerminal(prev)
  }

  let live = liveTerminals.get(id)
  // Zombie-synthetic fix: a dead entry for a synthetic session is a corpse, not
  // something worth reattaching to — the synthetic never got a JSONL twin, so
  // there's nothing to resume and no reason to keep staring at a frozen
  // "[session ended]" pane. Dispose it and fall into the create path below so
  // selecting it again spawns a genuinely fresh `claude`. Real (disk-backed)
  // sessions are untouched — reselecting one after its PTY exits still just
  // reattaches the frozen scrollback (documented detach-not-dispose contract);
  // only an explicit Restart respawns those.
  if (live?.dead && sessions.findSessionById(id)?.synthetic === true) {
    disposeLiveTerminal(live)
    liveTerminals.delete(id)
    live = undefined
  }
  if (live) {
    // Reuse path — already alive, just re-attach to DOM and re-focus.
    attachLiveTerminal(live)
  } else {
    // Create path. Collapse concurrent creates of the same id onto one
    // promise so we never spawn two PTYs for one session (I1).
    let pending = creatingTerminals.get(id)
    if (!pending) {
      // BUG-70 §4: a selection IS the operator's wake gesture — record it as
      // one instead of letting it land in the ledger as `'unknown'`.
      pending = createLiveTerminal(id, 'select')
      creatingTerminals.set(id, pending)
      void pending.finally(() => creatingTerminals.delete(id))
    }
    live = await pending
    if (!live) return
    // Staleness guard (T17): a newer selection may have superseded this create
    // during the await. `createLiveTerminal` already `term.open()`'d this terminal
    // into the shared host, so if we're stale we must detach it — otherwise two
    // terminals stack in the host and the loser's RO/focus/IPC never tear down.
    // The winning activation (current `selectedId`) attaches its own.
    if (sessions.selectedId !== id) {
      detachLiveTerminal(live)
      return
    }
    // createLiveTerminal already attached during `term.open()` and bound the RO.
    live.term.focus()
  }
  attachedId = id
  // T119: it has a live PTY again, so it is no longer parked. (Main clears its own flag in
  // `pty:create`; this clears the renderer's, so the sidebar badge goes away.)
  sessions.clearHibernated(id)
}

/**
 * Detach whatever is currently attached without activating anything else.
 * Used when `selectedId` flips to `null` (the user closed selection via the
 * topbar X button — that's an unselect, not a close).
 */
function detachCurrent(): void {
  if (!attachedId) return
  const live = liveTerminals.get(attachedId)
  if (live) detachLiveTerminal(live)
  attachedId = null
}

/**
 * Boot the queued background synthetics (BUG-23), one at a time. This is the
 * decoupling of PTY boot from selection: `insertAgentSession` enqueues every
 * agent synthetic here (via the store's `agentBootQueue`), so a burst of MCP
 * `create_session` calls can no longer lose trailing boots to the single
 * `selectedId` scalar's coalescing.
 *
 * SERIAL by design (`bgBootRunning` gate): only one `createLiveTerminal` runs at a
 * time, so two boots never race on the shared host mid-measure. Each id:
 *  - is skipped if it already has a live terminal (it won selection and `activate`
 *    booted it, or a prior drain did) or is no longer a synthetic in the model
 *    (dismissed / already migrated);
 *  - otherwise boots via the SAME `creatingTerminals` dedup `activate` uses, so a
 *    concurrent selection of the same id shares the one promise;
 *  - lands DETACHED (background) unless it is the currently-selected session, in
 *    which case it attaches — mirroring `activate`'s staleness handling.
 */
async function drainBgBoot(): Promise<void> {
  if (bgBootRunning) return
  bgBootRunning = true
  try {
    while (bgBootQueue.length > 0) {
      const id = bgBootQueue.shift()
      if (!id) continue
      // T215: claim the wake tag up front and clear it on EVERY exit path below,
      // so a skipped id (already booted, dismissed, no host yet) can't leave a
      // stale tag behind that would mislabel some later boot of the same id as
      // agent-driven. The one path that must put it back is the requeue.
      const viaWake = wakeIds.delete(id)
      const stale = liveTerminals.get(id)
      if (stale) {
        // Zombie fix: a dead entry here means a prior PTY for this id already
        // exited — a Retry-boot after the user dismissed a Ctrl+C'd synthetic,
        // or (T215) a REAL session whose process Harnu killed to park it.
        // Dispose the corpse instead of skipping, so the boot actually spawns a
        // fresh PTY instead of silently dropping the id off the queue.
        if (stale.dead) {
          disposeLiveTerminal(stale)
          liveTerminals.delete(id)
        } else {
          continue // already booted (selection / prior drain)
        }
      }
      // The row may have been dismissed or already migrated between enqueue and
      // now — only boot a still-present synthetic (never a shell fallback for a
      // vanished id).
      const entry = sessions.allSessions.find((s) => s.sessionId === id)
      if (!entry) continue
      // T215: a wake resumes a REAL session, so it is exempt from the
      // synthetic guard (which exists to stop a dismissed/migrated synthetic
      // from booting, not to keep resumes out).
      if (entry.synthetic !== true && !viaWake) continue
      if (!termEl.value) {
        // No host to open into yet; requeue and stop — the watcher re-drains once
        // the pane mounts (TerminalPane is v-if'd on a non-null selection).
        bgBootQueue.unshift(id)
        if (viaWake) wakeIds.add(id)
        break
      }
      // Share the create dedup with `activate` so a selection racing this boot
      // can't double-spawn (I1).
      let pending = creatingTerminals.get(id)
      if (!pending) {
        pending = createLiveTerminal(id, viaWake ? 'peer-message' : undefined)
        creatingTerminals.set(id, pending)
        void pending.finally(() => creatingTerminals.delete(id))
      }
      const live = await pending
      if (!live) continue // spawn failed (toasted) — the reaper surfaces it as FAILED
      // Keep a BACKGROUND boot detached (persistent-detached, T14). If this id is
      // the selection the operator is looking at, the `selectedId` watcher's
      // `activate()` owns attaching it (its reuse branch) — we never touch the
      // attached terminal here, so the two paths can't fight over `attachedId`.
      if (sessions.selectedId !== id) detachLiveTerminal(live)
    }
  } finally {
    bgBootRunning = false
  }
}

// Claim the store's pending background-boot ids into our serial runner. `immediate`
// so ids enqueued BEFORE this pane mounted (the common burst case — the first
// create both selects and enqueues) are claimed at setup. Watching `.length` is
// enough: `takeAgentBoots` clears the ref, so a drained→empty transition just
// re-fires into a no-op. The actual drain waits for a host (see `onMounted`):
// during setup `termEl` is still null, so a same-tick drain would requeue-and-stop.
watch(
  () => sessions.agentBootQueue.length,
  () => {
    const ids = sessions.takeAgentBoots()
    for (const id of ids) if (!bgBootQueue.includes(id)) bgBootQueue.push(id)
    void drainBgBoot()
  },
  { immediate: true }
)

// T215: claim the store's pending WAKE ids into the same serial runner. They
// ride `bgBootQueue` (one `createLiveTerminal` at a time, shared host) but are
// tagged in `wakeIds` so the drain exempts them from the synthetic guard and
// stamps the spawn as agent-driven. `immediate` for the same reason as above:
// a wake enqueued before this pane mounted must survive to the first drain.
watch(
  () => sessions.sessionWakeQueue.length,
  () => {
    const ids = sessions.takeSessionWakes()
    for (const id of ids) {
      wakeIds.add(id)
      if (!bgBootQueue.includes(id)) bgBootQueue.push(id)
    }
    void drainBgBoot()
  },
  { immediate: true }
)

// Kick the drain once the host exists — covers the cold-start case where the
// first agent synthetic both selected (mounting this pane) and enqueued its boot
// while `termEl` was still null during setup.
onMounted(() => {
  void drainBgBoot()
})

watch(
  () => sessions.selectedId,
  async (id) => {
    if (!id) {
      detachCurrent()
      return
    }
    // The host div lands in the DOM via `v-if="showSession"` in App.vue, so
    // on the first selection it may not exist until the next tick.
    if (!termEl.value) await nextTick()
    // Re-adopt any live PTYs first so a reload reconnects (with scrollback)
    // instead of cloning. No-op after the first call.
    await ensureReadopted()
    await activate(id)
  },
  { immediate: true }
)

/**
 * Theme reapply (T-3.5). When the user toggles themes, push the new CSS-var
 * resolved palette to EVERY live terminal — attached or detached — and force
 * a full repaint via `term.refresh(0, rows-1)`. Without the refresh xterm
 * doesn't repaint already-rendered cells (only newly-written ones pick up the
 * new colors).
 */
watch(
  () => theme.current,
  async () => {
    // Wait one tick so the `data-theme` attribute on <html> has been applied
    // and getComputedStyle reflects the new palette.
    await nextTick()
    const next = themeFromCss()
    for (const live of liveTerminals.values()) {
      live.term.options.theme = next
      try {
        live.term.refresh(0, live.term.rows - 1)
      } catch {
        // ignore — detached or already disposed
      }
    }
  }
)

/**
 * Terminal font-size broadcast (terminal-font-settings spec §7). Mirrors the
 * theme watch above: when the user changes the font size in Settings, push it
 * to EVERY live terminal — attached or detached — so the split/helper panes
 * and any backgrounded session pick it up without losing scrollback or killing
 * the PTY. A bigger font means fewer cols/rows, so the currently-attached
 * terminal must re-measure its cell geometry and resize; detached terminals
 * have no host to measure against — setting the option is enough, and
 * `attachLiveTerminal` re-measures with the new size when they re-attach.
 */
watch(
  () => settings.terminalFontSize,
  async (size) => {
    await nextTick()
    for (const live of liveTerminals.values()) {
      live.term.options.fontSize = size
    }
    // Re-measure + resize the currently-attached terminal, reusing the exact
    // routine the ResizeObserver uses. The `term.resize()` fires the already-
    // wired `term.onResize → pty.resize`, so the PTY follows.
    if (attachedId && termEl.value) {
      const live = liveTerminals.get(attachedId)
      const host = termEl.value
      if (live) {
        // Let xterm repaint its rows at the new font size before measuring.
        // Setting `options.fontSize` updates cell metrics on xterm's next
        // render frame, so a Vue tick isn't enough to read the new
        // `.xterm-rows` height — one rAF gives the renderer a frame to flush.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const next = measureXtermCells(host, size) ?? measureCells(host, undefined, size)
        if (next.cols !== live.term.cols || next.rows !== live.term.rows) {
          live.term.resize(next.cols, next.rows)
          window.api.ptyResize(live.ptyId, next.cols, next.rows)
        }
      }
    }
  }
)

/**
 * On reload/navigation the renderer heap is wiped but the main-process PTYs
 * keep running — they are re-adopted on the next mount via `ensureReadopted`
 * / `doReadopt` (I4). So we must NOT `ptyDestroy` here (that was the old dispose-on-unload
 * behavior, which killed sessions on reload). We only detach DOM nodes; the
 * authoritative teardown is the main process `before-quit` → `killAllPtys`.
 */
const onBeforeUnload = (): void => {
  for (const live of liveTerminals.values()) detachLiveTerminal(live)
}
window.addEventListener('beforeunload', onBeforeUnload)

onBeforeUnmount(() => {
  offClose()
  offMigrate()
  offReload()
  offHibernated()
  offSessionReady?.()
  offPromptRetry()
  // Remove the per-instance beforeunload listener added above (1:1 with the
  // addEventListener) so remounts don't accumulate dangling listeners each
  // closing over a now-orphaned instance (T14).
  window.removeEventListener('beforeunload', onBeforeUnload)
  // Component unmount (HMR / App-level v-if flip). We don't dispose here —
  // the live terminals should outlive a transient parent unmount (the cache is
  // module-scoped, T14). But we DO detach the currently-attached one so its DOM
  // node doesn't dangle on the soon-to-be-removed host.
  detachCurrent()
})
</script>

<template>
  <div
    class="relative h-full w-full"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div ref="termEl" class="h-full w-full bg-bg" style="padding: 14px 24px 0" />
    <!-- Drop affordance (file-explorer Cluster B): ring + centered hint so the
         drag-a-file-onto-a-session capability is discoverable. `pointer-events-none`
         keeps the overlay out of the drag hit-testing so it never triggers a
         spurious dragleave. -->
    <div
      v-if="dragOver"
      class="anim-overlay-fade pointer-events-none absolute inset-0 z-20 flex items-center justify-center ring-1 ring-inset ring-accent-line"
    >
      <span class="rounded-md bg-surface px-3 py-1.5 text-sm text-text-2 shadow-pop">
        {{ $t('terminalDrop.hint') }}
      </span>
    </div>
  </div>
</template>
