import { app, shell, BrowserWindow, ipcMain, session, dialog } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Diagnostic boot log — confirms which path the URL load takes. Remove once
// the renderer URL is stable across all dev launches.
console.log(
  '[main:boot] isPackaged=',
  app.isPackaged,
  'is.dev=',
  is.dev,
  'NODE_ENV=',
  process.env.NODE_ENV,
  'ELECTRON_RENDERER_URL=',
  process.env.ELECTRON_RENDERER_URL,
  'argv=',
  process.argv.slice(-3)
)

/**
 * Dev-mode detection. `app.isPackaged` returned `true` in our electron-vite
 * dev runs (Electron 39 heuristic surprise), and `is.dev` mirrored that, so
 * neither was reliable. We use process.argv instead — the dev script appends
 * `--remote-debugging-port=9222`, which only ever runs in dev. Safe because
 * production cmdlines never include that flag.
 */
const IS_DEV = process.argv.some((a) => a.includes('--remote-debugging-port'))

/**
 * Disable GPU hardware acceleration in dev mode. Kubuntu + KDE Wayland +
 * webkit2gtk has a known race that crashes the GPU process on relaunch
 * (CLAUDE.md note + observed in /tmp/harnu-cdp.log). Production builds
 * keep GPU on — desktop installs run via the user's X11 session, not the
 * dev tooling chain.
 */
if (IS_DEV) {
  app.disableHardwareAcceleration()
}

/**
 * CDP remote-debugging-port is passed via the `dev` npm script's `--` args
 * (package.json: `electron-vite dev -- --remote-debugging-port=9222 ...`).
 * Programmatic `appendSwitch` here would be too late — Chromium parses
 * `--remote-debugging-port` extremely early. Keeping the canonical doc
 * placement so the next maintainer doesn't re-add `appendSwitch`.
 */
import icon from '../../resources/icon.png?asset'
import {
  registerPtyHandlers,
  killAllPtys,
  stopHibernationSweep,
  foregroundProcessForSession,
  setHarnuPreambleProvider,
  setHookSettingsProvider,
  setBundledSkillsArgsProvider
} from './pty'
import { registerMonitorHandlers, stopHeartbeat, stopFullSamplerForced } from './monitor/sampler'
import { registerHarnuFeaturesHandlers, harnuPreamble } from './harnu-features'
import {
  registerBundledSkillsHandlers,
  injectBundledSkillArgs,
  cleanStaleLegacyStaging
} from './bundled-skills'
import { registerAppLocaleHandlers } from './app-locale'
import { registerDialogHandlers } from './dialog'
import { scanFolders } from './claude-reader'
import {
  notifySlugChanged,
  notifyWatcherDegraded,
  notifyWatcherReady,
  onFleetChanged,
  requestFullRescan
} from './fleet-model'
import { probeGitMetaBatch } from './git-probe'
import { registerFolderOpsHandlers } from './folder-ops'
import { registerExplorerHandlers } from './explorer-ipc'
import { startClaudeWatcher, type WatcherHandle } from './claude-watcher'
import { registerWorktreeTracker } from './worktree-tracker-wiring'
import { registerAppMenu } from './menu'
import { registerUpdater } from './updater'
import {
  addUserProject,
  removeUserProject,
  readUserProjects,
  hideUserProject,
  unhideUserProject,
  setUserProjectAgentDenied,
  setUserProjectInterceptActive,
  setUserProjectAlias,
  setUserProjectAliasFromBranch,
  getUserProjectAutoOrganize,
  setUserProjectAutoOrganize,
  getUserProjectOrchestratorDefault,
  setUserProjectOrchestratorDefault,
  interceptActivePaths,
  setUserProjectBornFrom,
  listBornFromCandidates,
  type UserProject
} from './user-projects'
import { registerFolderGitStatusHandlers } from './folder-git-status'
import { setInterceptFolders } from './responder-registry'
import { registerSessionOpHandlers } from './session-ops'
import { registerMarkdownReadHandlers } from './markdown-read'
import { registerMarkdownWriteHandlers } from './markdown-write'
import { registerMarkdownWatchHandlers, closeAllMarkdownWatchers } from './markdown-watch'
import { registerCanvasAssetHandlers } from './canvas-assets'
import { registerCanvasReadHandlers } from './canvas-read'
import { registerCanvasWriteHandlers } from './canvas-write'
import { registerCanvasWatchHandlers, closeAllCanvasWatchers } from './canvas-watch'
import { registerWorktreeMdHandlers } from './worktree-md-ipc'
import { registerMemoryReadHandlers } from './memory-ipc'
import { registerMemoryLocationHandlers } from './memory-location-ipc'
import { registerRoadmapHandlers, closeRoadmapWatcher } from './roadmap-ipc'
import { registerHelpersHandlers } from './helpers-ipc'
import { registerSettingsHandlers, closeSettingsWatcher } from './settings'
import { registerClaudeConfigHandlers } from './claude-config'
import { registerPushHandlers } from './push'
import { registerClaudeSettingsHandlers } from './claude-settings-ipc'
import { registerUsageHandlers, closeUsagePoller } from './usage'
import {
  registerHookBridge,
  closeHookBridge,
  hookSettingsBlobJson,
  getTaskStates
} from './hook-bridge'
import {
  initTerminalLedger,
  startTerminalLedgerObserver,
  recordShutdownSnapshot,
  getRestorableTerminalEntries,
  getLastShutdown
} from './terminal-ledger'
import {
  registerSessionRegistryWatcher,
  type SessionRegistryWatcherHandle
} from './session-registry-watch'
import { registerDigestEngine, closeDigestEngine } from './memory-digest'
import {
  registerOrchestratorGuard,
  arm as armOrchestrator,
  disarm as disarmOrchestrator,
  listArmedSessionIds
} from './orchestrator-guard'
import { registerScreenDetect, closeScreenDetect } from './detect/screen-detect'
import { registerExtensionsHandlers, closeExtensionsWatcher } from './extensions/extensions-loader'
import {
  markInjectionEscalated,
  clearInjectionEscalation
} from './mcp/injection-escalation-registry'
import { registerStatusLineHandlers, closeStatusLine } from './statusline'
import { registerUsageHistoryHandlers, closeUsageHistory } from './usage-history'
import { registerUsageCostHandlers, closeUsageCost } from './usage-cost'
import { registerUsageBiHandlers } from './usage-bi'
import { registerHaikuHandlers, closeHaiku } from './haiku'
import { registerBadge } from './badge'
import { registerWindowAttention } from './window-attention'
import { registerNotifications } from './notifications'
import { registerSpeechHandlers, killAllSpeech } from './speech'
import {
  cancelKokoroInstall,
  registerKokoroHandlers,
  registerKokoroProtocol,
  registerKokoroScheme
} from './speech-kokoro'
import { registerClaudeChangelog, closeClaudeChangelog } from './claude-changelog'
import { registerClaudeStatus, closeClaudeStatus } from './claude-status'
import { registerExternal } from './external'
// Harnu MCP control server (agent-drives-Harnu, 2026-06-25). OFF by default.
// `command-bridge-ipc` + `confirm-resolver` are the actuation/confirm shells the
// server composes; `worktree-ipc` owns git worktree add + auto-adopt; `mcp/server`
// is the loopback HTTP MCP surface itself. Registration order matters — see below.
import { registerCommandBridge, closeCommandBridge } from './command-bridge-ipc'
import { registerManifestDrain } from './manifest-drain-shell'
import { registerMcpConfirm, closeMcpConfirm } from './mcp/confirm-resolver'
import { registerWorktreeHandlers, adoptExistingFolder } from './worktree-ipc'
import { registerReaperHandlers } from './reaper/reaper-ipc'
import { registerContainersHandlers } from './containers/containers-ipc'
import { registerScheduler } from './scheduler-shell'
import { registerPrStack } from './pr-stack'
import { registerMissionIpc } from './mission-ipc'
import { registerReviewHandlers } from './review-ipc'
import { resolveCliFolderArg } from './cli-folder-arg'
import { registerMcpServer, closeMcpServer } from './mcp/server'
import { registerImageCache } from './image-cache'
import { setDataDirAppVersion } from './data-dir'
import { migrateUserData } from './migrate-userdata'
import {
  migrateKnownFolderDataDirsForApp,
  flushDataDirConflictNotices,
  setDataDirNoticeSink
} from './migrations/data-dir-boot'

/**
 * Content-Security-Policy mirrored from `src/renderer/index.html`'s `<meta>`
 * tag. We also send it as an HTTP response header (see `onHeadersReceived`
 * below) so a navigation can't land on a document that lacks the `<meta>` and
 * thereby drop the policy. Keep this string in sync with the renderer's meta.
 */
// `capy-voice:` is the legacy alias of `harnu-voice:` (offline voice installs from before the rename).
const CSP_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' harnu-voice: capy-voice:; connect-src 'self' harnu-voice: capy-voice:; style-src 'self' 'unsafe-inline'; img-src 'self' data:"

/**
 * The single source of truth for the renderer's expected location: the Vite
 * dev-server URL in dev, the built `index.html` `file://` URL in prod. Both
 * the window load and the navigation guards derive from this so they can never
 * disagree.
 */
function getRendererUrl(): string {
  if (IS_DEV) {
    return process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5174'
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

/**
 * Whether a navigation target is the renderer itself. In dev we allow anything
 * on the dev-server origin (HMR rewrites the path/query); in prod we require
 * the exact built `index.html` file path. Anything else (an external link, a
 * `file://` traversal, a foreign origin) is blocked by the navigation guards.
 */
function isRendererUrl(target: string): boolean {
  try {
    const url = new URL(target)
    const expected = new URL(getRendererUrl())
    if (IS_DEV) {
      return url.origin === expected.origin
    }
    return url.protocol === 'file:' && url.pathname === expected.pathname
  } catch {
    return false
  }
}

/**
 * Shared protocol allowlist for anything that hands a renderer-supplied URL
 * to the OS (`setWindowOpenHandler` below, `shell:openExternal` IPC). Only
 * http(s)/mailto ever reach `shell.openExternal` — file:, javascript:, and
 * custom schemes are denied without opening anything.
 */
function isAllowedExternalProtocol(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | null = null

/**
 * Singleton watcher handle, lazily started on the first `folders:load` call.
 * Re-using the same watcher across renderer reloads keeps the inotify
 * registration cheap (finding 02 §3) and lets us share the per-file byte
 * offsets so we don't replay history on hot reload.
 */
let watcherHandle: WatcherHandle | null = null
/** Unsubscribe for the `fleet:changed` push, registered once on the first `folders:load`. */
let fleetChangeOff: (() => void) | null = null
/** T388 worktree tracker close (closes its `fs.watch` handles on quit). */
let closeWorktreeTracker: (() => void) | null = null
/** T92 PID session-registry watcher handle (closed on quit). */
let sessionRegistryWatcher: SessionRegistryWatcherHandle | null = null

/**
 * BUG-54 terminal ledger: the disk load (`initTerminalLedger`) races the
 * window's first paint, so the boot restore awaits this promise rather than
 * assuming the load already finished by `did-finish-load`.
 */
const terminalLedgerReady = initTerminalLedger().catch((err) => {
  console.error('[terminal-ledger] init failed', err)
})
/** Guards the one-time restore broadcast against a dev-mode renderer reload. */
let terminalLedgerRestored = false

/**
 * Boot restore + rebroadcast (D8): re-emit each surviving ledger entry on the
 * existing `claude:hook` channel with `event: 'LedgerRestore'` so the
 * renderer's existing handler populates `taskState` — no new IPC channel, no
 * new reducer. Freshness is empty at boot (nothing has happened yet this run).
 */
async function restoreTerminalLedgerToRenderer(win: BrowserWindow | null): Promise<void> {
  await terminalLedgerReady
  if (!win || win.isDestroyed()) return
  for (const entry of getRestorableTerminalEntries({})) {
    win.webContents.send('claude:hook', {
      sessionId: entry.sessionId,
      taskState: entry.state,
      event: 'LedgerRestore',
      ts: entry.at,
      ...(entry.state === 'failed'
        ? { failureReason: entry.failureReason ?? 'unknown', resetsAt: entry.resetsAt }
        : {})
    })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Let the notification sound play without a prior user gesture in the page
      // (notification-sound spec §4.5). The app uses no other autoplay audio.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Window-open allowlist: only hand http(s)/mailto URLs to the OS handler;
  // deny every other scheme (file:, javascript:, custom schemes) without
  // opening anything. We never let the renderer spawn a new BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalProtocol(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Navigation guards: the renderer is a single-page app, so the only
  // legitimate top-level navigation is (re)loading the renderer document
  // itself. Block any attempt to navigate (or be redirected) elsewhere — a
  // stray `<a href>`, a `window.location` assignment, an injected redirect —
  // which would otherwise replace the app with arbitrary (possibly remote)
  // content. Genuine outbound links go through `setWindowOpenHandler` above.
  const blockForeignNavigation = (event: Electron.Event, target: string): void => {
    if (!isRendererUrl(target)) {
      event.preventDefault()
      console.warn('[main:nav] blocked navigation to', target)
    }
  }
  mainWindow.webContents.on('will-navigate', blockForeignNavigation)
  mainWindow.webContents.on('will-redirect', blockForeignNavigation)

  // BUG-54: rebroadcast surviving terminal-ledger entries once the renderer's
  // `claude:hook` listener is live. Guarded so a dev-mode HMR reload (which
  // re-fires `did-finish-load`) doesn't replay the same restore repeatedly.
  mainWindow.webContents.on('did-finish-load', () => {
    if (terminalLedgerRestored) return
    terminalLedgerRestored = true
    void restoreTerminalLedgerToRenderer(mainWindow)
  })

  if (IS_DEV) {
    const url = getRendererUrl()
    console.log('[main] loading renderer from', url)
    mainWindow.loadURL(url)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Single-instance lock. Without this, two `npm run dev` runs (or a packaged
 * launch on top of dev) both write to `<userData>/projects.json` AND
 * `<userData>/helpers.json`, racing each other and silently corrupting state
 * via last-write-wins. Pre-requisite for split-helpers because `helpers.json`
 * auto-saves on every layout change, vastly increasing collision frequency
 * compared to the user-driven projects.json.
 *
 * Linux + Wayland note: when the second instance triggers `second-instance`
 * on the first, we restore + focus the existing window. macOS already does
 * this via `app.on('activate')`, so the second-instance handler is mainly
 * for Linux + Windows ergonomics.
 */
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
  // Return early so `app.whenReady()` and all subsequent handlers never
  // attach in the duplicate process. Without this, the duplicate would
  // keep running until `app.quit()` is processed, briefly racing.
  process.exit(0)
}
// T45: `harnu .` / `harnu <path>` opens a folder like `code .`. The folder this
// process launched with is resolved once here; the renderer pulls it via
// `cli:openPending` after it has subscribed to `folders:adopted` (avoids a
// startup race). When Harnu is already running, the SECOND instance's argv is
// resolved in the handler below and pinned into the existing window instead of
// spawning another one.
let pendingCliFolder = resolveCliFolderArg(process.argv, process.cwd(), app.isPackaged ? 1 : 2)

app.on('second-instance', (_event, argv, workingDirectory) => {
  const win = mainWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  const folder = resolveCliFolderArg(argv, workingDirectory, app.isPackaged ? 1 : 2)
  // CLI origin → reveal + focus the pinned folder in the existing window (T69 fix).
  if (folder) void adoptExistingFolder(folder, { select: true }).catch(() => {})
})

// One-time config migration from the pre-rebrand userData (Capy/capy/om2tab → current).
// Runs here — after the single-instance lock (only the primary process reaches
// this) and BEFORE `app.whenReady`/`createWindow` — so nothing has written to
// userData yet and Chromium hasn't opened its Local Storage db. It self-guards:
// no-op for a custom `--user-data-dir`, into a non-fresh dir, or after the first
// run, and it never throws (T41).
migrateUserData({
  appData: app.getPath('appData'),
  userData: app.getPath('userData'),
  argv: process.argv
})

// T241: the `harnu-voice://` scheme (and the legacy `capy-voice://` alias baked into pre-rename installs) that serves the downloaded offline voice out
// of userData. Must be declared BEFORE `app.whenReady()` — Chromium reads the
// privileged-scheme table once at startup, and the mirrored ES modules need
// `standard` (root-relative imports) + `secure` (module/WASM loading) + CORS
// (the page itself is on file://). The handler is installed in `whenReady`.
registerKokoroScheme()

/**
 * Last-resort crash handlers. The whole point of Harnu is to keep many live
 * `claude` PTY sessions running; a single unhandled async throw anywhere in the
 * main process must NOT tear those down. Node's default behaviour is to print
 * the error and exit on `uncaughtException` — we override that to log and keep
 * running. We deliberately do not call `app.quit()` / `process.exit()` here.
 *
 * A dialog is only shown once the app is ready (otherwise `showErrorBox` is
 * unsafe/no-op on some platforms) and only for `uncaughtException`, where the
 * error object is reliable; unhandled rejections are logged silently to avoid
 * spamming dialogs for benign promise races.
 */
process.on('uncaughtException', (err) => {
  console.error('[main:uncaughtException]', err)
  if (app.isReady()) {
    try {
      dialog.showErrorBox(
        `${app.name} hit an unexpected error`,
        'An internal error occurred but your sessions are still running.\n\n' +
          (err?.stack ?? String(err))
      )
    } catch {
      /* never let the handler itself throw */
    }
  }
})
process.on('unhandledRejection', (reason) => {
  console.error('[main:unhandledRejection]', reason)
})

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.harnu.app')

  // Per-repo data dir copy (legacy `.capy/` → `.harnu/`), AFTER the userData migration
  // above and BEFORE any memory/roadmap/mission watcher below binds. Capped by a time
  // ceiling: past it boot carries on and the copy finishes in the background.
  setDataDirAppVersion(app.getVersion())
  const dataDirMigration = await migrateKnownFolderDataDirsForApp({
    appVersion: app.getVersion()
  })

  // Send the CSP as an HTTP response header too, mirroring the renderer's
  // `<meta http-equiv="Content-Security-Policy">`. The header survives a
  // navigation that lands on a document without the meta tag, so the policy
  // can't be silently dropped. Keep `CSP_POLICY` in sync with the meta.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_POLICY]
      }
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerPtyHandlers(() => mainWindow)
  // T127: System Monitor main core. `monitor:heap` heartbeat starts immediately
  // (always-on, negligible cost); `monitor:sample` only runs between a
  // `monitor:start`/`monitor:stop` pair (refcounted, driven by the takeover pane).
  registerMonitorHandlers(() => mainWindow)
  registerDialogHandlers(() => mainWindow)
  // T69: FolderMenu "New folder…" (mkdir a subfolder + pin) and "Open
  // subfolder…" (recursive bounded subfolder listing → picker → pin).
  registerFolderOpsHandlers()
  // Explorer tree (Cluster C): lazy one-level `explorer:listDir` — lists a
  // directory's immediate children (files + folders), CONFINED to a project
  // root and respecting `.gitignore`. Read-only; feeds the Explorer pane.
  registerExplorerHandlers()
  // T388 (sidebar-liveness U4b): one worktree tracker for the repos the sidebar
  // shows — `worktrees:track` sets the repo set, `worktrees:changed` pushes each
  // repo's `git worktree list` whenever `<common-dir>/worktrees` changes.
  closeWorktreeTracker = registerWorktreeTracker(() => mainWindow)
  // T52: hover-triggered per-folder git status (dirty count + ahead/behind) for
  // the FolderPreview card. Throttled + cached, outside the folder-scan hot path.
  registerFolderGitStatusHandlers()
  // Open-in-external-app channels (Topbar "Open folder" / "Open in VS Code").
  // `external:openPath` reveals a folder in the OS file manager; `external:openInVSCode`
  // spawns the `code` CLI detached and never crashes if it's absent from PATH.
  registerExternal()
  // Pasted-images gallery: read-only list/read/copy over ~/.claude/image-cache.
  // Stateless (no watcher, no teardown); every handler validates uuid + name.
  registerImageCache()
  registerSessionOpHandlers()
  // T74: confined markdown reader for the viewer pane. Reads `.md`/`.markdown`/
  // `.txt` UTF-8 (size-capped) only from the known Harnu folders (pinned +
  // scanned roots), reusing the `settings.ts` containment helpers.
  registerMarkdownReadHandlers()
  // T74 phase 2: confined markdown WRITER for the editor + "New markdown" flow.
  // Same known-folder containment + extension allowlist + size cap as the reader
  // (atomic tmp+rename); never writes outside the known roots.
  registerMarkdownWriteHandlers()
  // T171: ref-counted live-reload watcher for markdown panes. Only watches
  // files a mounted MarkdownPane has registered; broadcasts a path-only
  // `markdown:changed` signal the renderer re-reads via `markdown:read`.
  registerMarkdownWatchHandlers(() => mainWindow)
  // T218 U1: the canvas file seam — a confined reader/writer/watcher for
  // `*.capycanvas.json` documents (the two-author contract between the operator
  // and the agent). Same known-folder containment, size cap and atomic
  // tmp+rename discipline as the markdown quartet, plus schema validation in the
  // pure `canvas-core.ts` so the pane, the reader and the MCP verb can never
  // disagree about what a canvas document is.
  registerCanvasReadHandlers()
  registerCanvasWriteHandlers()
  // T218 U6: the pane's paste/drop path externalises image bytes into the
  // canvas's `assets/` dir through the SAME server-side pipeline the verb uses.
  registerCanvasAssetHandlers()
  registerCanvasWatchHandlers(() => mainWindow)
  // T87: WORKTREE.md creator. Probes a repo (lockfiles/.env/node_modules/default
  // branch) and writes a heuristic, human-reviewable manifest PROPOSAL at the repo
  // root — never executes it (the create-worktree confirm stays the runtime guard).
  registerWorktreeMdHandlers()
  // T79 S3: confined project-memory reader for the memory UI (folder-hover cue +
  // Memory pane). Resolves a folder to the repo's shared `.harnu/memory/` and
  // returns hot/decisions/timeline, gated by the same known-folder containment.
  registerMemoryReadHandlers()
  // T198: PR Stack Canvas — the merge-chain graph of a repo's open PRs. Read
  // only: it shells `gh pr list` (adding `baseRefName`, the field the whole DAG
  // hangs on) plus a `git rev-list --count` per branch, and never writes to
  // GitHub. Worktree verdicts are passed IN from the Reaper snapshot rather
  // than recomputed, so the canvas and the Cleanup view can never disagree
  // about whether a worktree is done with.
  registerPrStack()
  // T370 (T358 S9): mission progress read + the operator doors.
  registerMissionIpc()
  // T164 U2: branch-vs-base diff + the evidence header's receipts, plus the
  // per-repo blast-radius list (operator-owned, never reachable from an MCP verb).
  registerReviewHandlers(() => mainWindow)
  // T89: configurable memory location — the global default (Settings → Memory) +
  // per-project override (folder menu) + the assisted "move existing memory now"
  // migration. Folder-scoped verbs share the same known-folder gate.
  registerMemoryLocationHandlers()
  // T80 S1: Roadmap Kanban board over `<repo>/.harnu/memory/roadmap/`. Owns the
  // per-repo roadmap watcher + the serialized, atomic frontmatter writes
  // (`roadmap:setStatus`/`bindSession`) that move a card between columns or bind
  // it to a dispatched session. `status`/`session` are controlled fields written
  // ONLY here (human IPC) — no MCP verb path — which is what keeps the
  // "agent never moves a card" invariant (T80 §0) mechanically true.
  registerRoadmapHandlers(() => mainWindow)
  registerHelpersHandlers()
  registerSettingsHandlers(() => mainWindow)
  // "Claude Boot" launch-options config (global + per-folder). Read by the PTY
  // spawn path to build the `claude` argv.
  registerClaudeConfigHandlers()
  // Remote push notifications (remote-push spec): the notification funnel fans
  // out to user-configured ntfy/webhook channels; HTTP leaves from main only.
  registerPushHandlers()
  // App-locale sync (T85): cache + persist the renderer's effective Settings
  // locale so the self-awareness preamble can tell every session which language to
  // write project memory in. Registered BEFORE harnu-features so its cache is
  // hydrating by the time the preamble provider is wired.
  registerAppLocaleHandlers()
  // "Harnu self-awareness" (T55): register the toggle IPC + hydrate its cache, then
  // wire the preamble provider so every `claude-*` spawn prepends the environment
  // doc to --append-system-prompt when the feature is on (default ON).
  registerHarnuFeaturesHandlers()
  setHarnuPreambleProvider(() => harnuPreamble())
  // "Claude config" Settings tab: read/patch the global ~/.claude/settings.json
  // through the hardened atomic + locked write layer (issue #16).
  registerClaudeSettingsHandlers()
  // Plan-usage poller (plan-usage-widget spec). Focus-gated; spawns
  // `claude -p "/usage"` to feed the sidebar panel. Safe to register before the
  // window exists — it hangs off app-level focus/blur events.
  registerUsageHandlers(() => mainWindow)
  // Hook Bridge (session-state real-state spec). Loopback HTTP server that
  // receives Claude Code hook events → real per-session task-state. Opt-out
  // (installs observer hooks into ~/.claude/settings.json unless disabled);
  // async + best-effort, degrades to the activity heuristic if it can't install.
  void registerHookBridge(() => mainWindow).catch((err) =>
    console.error('[hook-bridge] register failed', err)
  )
  // BUG-54: the terminal ledger subscribes to the same in-main observer seam
  // the digest engine below uses (`hook-bridge.addTaskEventObserver`), so
  // `errored`/`done` survive a restart. Started once the disk load
  // (`terminalLedgerReady`, kicked off at module-init above) resolves so an
  // early hook edge never races an in-flight load with a last-write-wins clobber.
  void terminalLedgerReady.then(() => startTerminalLedgerObserver())
  // T92: hand the PTY spawn path the per-session hook `--settings` blob provider so
  // every Harnu-spawned `claude` POSTs its lifecycle to the bridge above (event-driven
  // fleet state, zero user-config edits). Returns null until the bridge is listening
  // or when injection is opted out — a safe no-op for early spawns.
  setHookSettingsProvider(() => hookSettingsBlobJson())
  // T217 (bundled skills): register the Settings → Skills IPC, then hand the PTY
  // spawn path the provider that stages this FOLDER's enabled bundled skills and
  // appends `--plugin-dir <staged>`. Nothing is enabled on a fresh install, so the
  // provider is a pass-through until the operator turns a skill on in the panel.
  registerBundledSkillsHandlers()
  // Drop the dead pre-rename `<hash>/capy/` staging dirs the userData migration carried over.
  void cleanStaleLegacyStaging().catch(() => {})
  setBundledSkillsArgsProvider((args, cwd) => injectBundledSkillArgs(args, cwd))
  // T92: PID session-registry watcher (`~/.claude/sessions/<pid>.json`). A cheap
  // third fleet signal for EXTERNAL sessions Harnu never injected hooks into;
  // fail-open + feature-gated (skips silently if the dir/status field is absent).
  sessionRegistryWatcher = registerSessionRegistryWatcher(() => mainWindow)
  // T79 S2: auto-digest engine. Subscribes to the in-main hook task-state edge
  // (via `hook-bridge.addTaskEventObserver`, wired just above) so a session that
  // ENDS or goes long-idle after committing real work gets an evidence-linked
  // `sessions/<date>-<id8>.md` digest + an immediately-APPLIED hot.md snapshot
  // (BUG-26: no more Approval Inbox gate), with the outcome recorded in the
  // shadow log for after-the-fact audit via the Inbox's "Would-have" tab.
  // Fully main-side → survives renderer reloads.
  registerDigestEngine()
  // T109: Harnu-managed orchestrator guard — install/refresh the hook script into
  // userData, sweep armed.json entries orphaned by a crashed prior boot, and
  // disarm a session on the same in-main `SessionEnd` edge the digest engine
  // above subscribes to (no user setup: zero writes to the operator's own
  // ~/.claude/settings.json, only into an armed session's folder).
  void registerOrchestratorGuard().catch((err) =>
    console.error('[orchestrator-guard] register failed', err)
  )
  // Screen-detection (A2 two-tier state). Folds renderer screen snapshots from
  // non-hook panes (folder terminals running codex/aider/…) into the same
  // per-session task-state → same sidebar dots. Claude panes are hook-driven and
  // never scraped, so this adds zero cost to the common case.
  registerScreenDetect(() => mainWindow, foregroundProcessForSession)
  // T137: Extension SDK Phase 1 — the shared loader for `~/.claude/capy-extensions/`,
  // generalizing the detector triad above one level: one chokidar watch, folded
  // into `contributes.themes` (theme store) + `contributes.boardTemplates`
  // (`loadBoardTemplate` in `roadmap-ipc.ts`). Pure data only — zero code execution.
  registerExtensionsHandlers(() => mainWindow)
  // Harnu MCP control server (OFF by default). Wire the actuation shells first so
  // `registerMcpServer` receives live deps: the CommandBridge actuates session/
  // pane creation against the renderer (gated by the `renderer:ready` handshake
  // the sessions store emits), the confirm resolver holds every agent mutation
  // for a fail-closed Allow/Deny. `registerMcpServer` is async (dynamic-imports
  // the MCP SDK) and only starts its loopback listener when the pref is enabled;
  // it overrides pty's `--mcp-config` provider, so it must run AFTER
  // `registerPtyHandlers` set the default (order satisfied above).
  const cmdBridge = registerCommandBridge(() => mainWindow)
  const dataDirNotices = { dispatch: (c: string, p: unknown) => cmdBridge.bridge.dispatch(c, p) }
  setDataDirNoticeSink(dataDirNotices)
  void flushDataDirConflictNotices(dataDirNotices)
  // A copy still running past the boot ceiling: report how it ended once it settles.
  void dataDirMigration.settled?.then((final) => {
    if (final.errors.length > 0) console.warn('[data-dir] background copy errors:', final.errors)
    return flushDataDirConflictNotices(dataDirNotices)
  })
  const mcpConfirm = registerMcpConfirm(() => mainWindow)
  registerWorktreeHandlers(() => mainWindow)
  registerReaperHandlers(() => mainWindow)
  registerContainersHandlers(() => mainWindow)
  // T113: the background manifest drain — stamped Ready cards dispatch without
  // the Roadmap board open. Shares the SAME CommandBridge (spawns are
  // renderer-owned); pokes arrive from the card write paths in roadmap-ipc.
  registerManifestDrain(cmdBridge.bridge, () => mainWindow)
  // T294 (T291 U4): the scheduler's tick runner. Shares the SAME CommandBridge
  // so a worker's own self-disable notice (streak or vanished folder) goes
  // through the ordinary notify.push path — no new transport.
  registerScheduler(() => mainWindow, cmdBridge.bridge)

  // T45: the renderer pulls the launch folder (`harnu .`) once it's mounted and
  // subscribed to `folders:adopted`, so the pin lands instead of racing startup.
  ipcMain.handle('cli:openPending', async () => {
    if (!pendingCliFolder) return
    const folder = pendingCliFolder
    pendingCliFolder = null
    try {
      // CLI origin → reveal + focus the freshly-pinned folder (T69 fix).
      await adoptExistingFolder(folder, { select: true })
    } catch {
      /* not a real directory — ignore the CLI arg */
    }
  })
  void registerMcpServer(() => mainWindow, {
    bridge: cmdBridge.bridge,
    confirm: mcpConfirm.confirm
  }).catch((err) => console.error('[mcp] register failed', err))
  // statusLine telemetry bridge (statusline-telemetry spec). Installs a
  // statusLine command into ~/.claude/settings.json that dumps per-turn JSON to
  // <userData>/statusline/inbox/; we tail it for zero-token per-tab cost/context/
  // rate-limit telemetry. Opt-out, async, best-effort (degrades to the /usage poll).
  void registerStatusLineHandlers(() => mainWindow).catch((err) =>
    console.error('[statusline] register failed', err)
  )
  // Usage-history + BI (issue #19). Persists the per-turn statusLine telemetry
  // (otherwise discarded) to daily-rotated JSONL; serves rollups, a deterministic
  // plan-fit projection, and an on-demand chat over the aggregated data. Capture
  // is fire-and-forget from statusline.ts; these handlers back the Settings tab.
  registerUsageHistoryHandlers()
  // Real cost engine (T47 P5). Scans ~/.claude/projects/**/*.jsonl (dedupe +
  // price per request), incrementally cached to ~/.claude/om2tab/usage-history/
  // cost-cache.json. Request/response only — no capture hook, no timer.
  registerUsageCostHandlers()
  // Usage BI dashboard snapshot (T47 P6 S1). One IPC call joins the P5/P6 cost
  // + anatomy engine, the usage-history rollups/windows/heatmap, and live
  // fleet telemetry into the full dashboard payload. Request/response only.
  registerUsageBiHandlers()
  // Haiku service (cheap-AI substrate). Headless `claude -p --model haiku` for
  // auto-naming synthetic sessions (and future watchers). Request/response only.
  registerHaikuHandlers(() => mainWindow)
  // OS notifications (os-notifications spec §5). Renders native toasts the
  // renderer store asks for on meaningful task-state edges; click focuses the
  // window + selects the session. The app icon is injected here (this module
  // owns the `?asset` import) so the notifier stays node-loadable for tests.
  registerNotifications(() => mainWindow, icon)
  // Voice engine (T237). The renderer owns the queue, the mute and the state;
  // main only spawns the operator's TTS command, because the renderer cannot
  // start a process. Never through a shell — see `speech-command.ts`.
  registerSpeechHandlers()
  // T241 (ADR-0012 option C): the offline Kokoro voice. Its code AND its weights
  // are downloaded at runtime into userData — nothing ships in the installer,
  // because `phonemizer` inlines a GPLv3 espeak-ng. `registerKokoroProtocol`
  // serves that mirror; the handlers expose status/plan/install/cancel/remove.
  registerKokoroProtocol()
  registerKokoroHandlers(() => mainWindow)
  // OS dock/taskbar attention badge (attention-badge spec). Renderer sends the
  // needs-input count over badge:set; main picks the per-OS path, no-ops gracefully.
  registerBadge(() => mainWindow)
  // OS window-attention (T44 S4): flash taskbar / bounce dock when a confirm parks
  // while Harnu is unfocused. Renderer sends window:requestAttention; no-ops gracefully.
  registerWindowAttention(() => mainWindow)
  // Claude Code changelog watcher (spec 2026-06-18). Polls the CLI's CHANGELOG.md
  // from GitHub; lights the Settings-gear dot + fires one OS notification per new
  // version. Reuses the same app icon as the notifier. Runs in dev too.
  registerClaudeChangelog(() => mainWindow, icon)
  // Claude service-status poller (issue #17). Polls the Statuspage summary for
  // status.claude.com → footer health dot + incident panel + native alerts on
  // state transitions. Background-polls (60s focused / 5min blurred) so the
  // alert fires even when the app isn't focused. Reuses the same app icon.
  registerClaudeStatus(() => mainWindow, icon)
  // Application menu — installs OS-level accelerators that xterm.js cannot
  // intercept. On macOS this is the visible menubar; on Linux/Windows the
  // bar stays hidden via the window's `autoHideMenuBar: true` setting but
  // the accelerators still fire. See `findings/07-shortcuts-palette.md` §3.
  registerAppMenu(() => mainWindow)
  // Auto-update via GitHub Releases. No-op in dev (the function itself
  // guards on `app.isPackaged`); in packaged builds it polls 5s after ready
  // and then hourly. Per finding 06 §8: AppImage updates in place, the
  // .deb does not — that asymmetry is documented in README + CLAUDE.md.
  registerUpdater(() => mainWindow)

  // Topbar Maximize button (B-3) — IPC because the renderer can't reach
  // `BrowserWindow#setFullScreen` directly. The application menu also has F11
  // wired to the same action; this handler is the click-path alongside the
  // accelerator.
  ipcMain.handle('window:toggleFullscreen', () => {
    if (!mainWindow) return
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })

  // Terminal links (xterm.js WebLinksAddon): the addon's default handler calls
  // `window.open()` with no URL, which `setWindowOpenHandler` above always
  // denies (details.url resolves to about:blank), so clicks silently no-op.
  // TerminalPane/HelperPane instead pass a custom handler that calls this IPC
  // directly with the real URL, bypassing `window.open()` entirely — same
  // allowlist as `setWindowOpenHandler` so non-http(s)/mailto schemes are
  // still denied.
  ipcMain.handle('shell:openExternal', (_e, url: unknown) => {
    if (typeof url === 'string' && isAllowedExternalProtocol(url)) {
      void shell.openExternal(url)
    }
  })

  // Folder-first model (spec 2026-06-11). Initial scan + lazy watcher boot.
  // The renderer calls this once at startup; subsequent calls (e.g. on a
  // renderer hot reload) reuse the same watcher and just return a fresh scan —
  // chokidar keeps its inotify registration. Returns the per-cwd `FolderEntry[]`
  // the sidebar consumes; live diffs flow via the `claude:*` subscriptions.
  ipcMain.handle('folders:load', async () => {
    const folders = await scanFolders()
    if (!watcherHandle) {
      // T123 §5.1 W1: feed the watcher's typed per-slug events into the
      // central fleet model so it can incrementally refresh (AC3) instead of
      // relying on a full rescan — on top of (not instead of) the existing
      // `claude:*` sends the renderer subscribes to. `onReady` closes the
      // boot-scan→watch-registration gap with one full rescan; `onDegraded`
      // switches the model to poll-rescans while the watcher is unreliable.
      watcherHandle = await startClaudeWatcher(() => mainWindow, {
        skipSeed: true,
        onSlugChanged: notifySlugChanged,
        onDegraded: notifyWatcherDegraded,
        onReady: notifyWatcherReady
      })
    }
    // Sidebar liveness (spec §4.A A4): every model refresh that moved its
    // membership — whatever triggered it — is pushed so the renderer reloads
    // instead of waiting for an unrelated event. Registered once; the
    // listener reads `mainWindow` at send time so a recreated window is served.
    if (!fleetChangeOff) {
      fleetChangeOff = onFleetChanged((change) => {
        const win = mainWindow
        if (win && !win.isDestroyed()) win.webContents.send('fleet:changed', change)
      })
    }
    return folders
  })

  // Manual rescan (BUG-55 spec §3.2): the escape hatch for any watcher gap —
  // a session move the watcher missed, a burst it dropped — without a full
  // app restart. Runs ONE full rescan of the shared fleet model (spec §4.D
  // SW-1) and returns the refreshed folders, so the sidebar and MCP
  // `get_fleet` read the same fresh state.
  ipcMain.handle('claude:rescan', async () => requestFullRescan())

  // Probe additive git metadata (branch / repoId / isMainWorktree) for a batch
  // of folder paths, reusing the same bounded, 60 s-cached probe as the folder
  // scan (`git-probe.ts`). Powers folder-first repo grouping for pinned
  // *placeholder* folders (T70A): a folder pinned before Claude wrote a
  // `sessions-index.json` under it has no disk-side git meta, so `groupByRepo`
  // (which keys on `repoId`) never collapses it under its repo. The renderer
  // calls this at pin time (persist meta onto the record) and on reload
  // (backfill records saved before pin-time probing existed). Returns a flat
  // `Array<{ path, ...GitMeta }>` — the `folders:adopted` wire shape — keyed by
  // the INPUT path so the caller can match results 1:1.
  ipcMain.handle('git:probe', async (_e, paths: string[]) => {
    const map = await probeGitMetaBatch(Array.isArray(paths) ? paths : [])
    return [...map].map(([path, meta]) => ({ path, ...meta }))
  })

  // ---- User-intent folder persistence (U-2.2) -------------------------------
  // Backed by `src/main/user-projects.ts`, which owns `<userData>/projects.json`.
  // The renderer calls `userProjects:list` at store-init alongside `folders:load`
  // and merges the two streams (see `src/renderer/src/stores/sessions.ts`
  // `reloadModel()`) so a user-added project appears in the sidebar even
  // before Claude itself writes a `sessions-index.json` for it. All five
  // handlers return `{ projects, hiddenPaths }` straight from disk so the
  // renderer never has to guess at the post-write state.
  //
  // `hiddenPaths` is the list of normalized paths the user explicitly hid
  // via the per-folder right-click menu — see `hideUserProject` /
  // `unhideUserProject` in `user-projects.ts`. It is independent of
  // `projects[]`: a user can hide an auto-discovered project they never
  // added explicitly, and a hidden user-added project still belongs to
  // `projects[]` (so its alias survives until they truly remove it).
  function toUserProjectsPayload(file: { projects: UserProject[]; hiddenPaths?: string[] }): {
    projects: UserProject[]
    hiddenPaths: string[]
  } {
    return { projects: file.projects, hiddenPaths: file.hiddenPaths ?? [] }
  }
  ipcMain.handle('userProjects:list', async () => {
    return toUserProjectsPayload(await readUserProjects())
  })
  ipcMain.handle('userProjects:add', async (_e, entry: UserProject) => {
    return toUserProjectsPayload(await addUserProject(entry))
  })
  ipcMain.handle('userProjects:remove', async (_e, targetPath: string) => {
    return toUserProjectsPayload(await removeUserProject(targetPath))
  })
  ipcMain.handle('userProjects:hide', async (_e, targetPath: string) => {
    return toUserProjectsPayload(await hideUserProject(targetPath))
  })
  ipcMain.handle('userProjects:unhide', async (_e, targetPath: string) => {
    return toUserProjectsPayload(await unhideUserProject(targetPath))
  })
  // Per-folder agent-control OPT-OUT (MCP). Agents may act in every folder by
  // default; this blocks them in one (and everything under it) — see
  // `mcp/policy-assemble.ts`. Toggled from the folder context menu or Settings →
  // Control server; persisted in projects.json next to the alias.
  ipcMain.handle(
    'userProjects:setAgentDenied',
    async (_e, { targetPath, denied }: { targetPath: string; denied: boolean }) => {
      return toUserProjectsPayload(await setUserProjectAgentDenied(targetPath, denied))
    }
  )

  // T30: the per-folder Approval Inbox intercept ramp. Persists like agentDenied,
  // then re-hydrates the responder registry's synchronous ramp scope so the gate
  // sees the change immediately.
  ipcMain.handle(
    'userProjects:setInterceptActive',
    async (_e, { targetPath, allowed }: { targetPath: string; allowed: boolean }) => {
      const file = await setUserProjectInterceptActive(targetPath, allowed)
      setInterceptFolders(await interceptActivePaths())
      return toUserProjectsPayload(file)
    }
  )
  // T52: rename a folder's sidebar label (creates a pinned record for an
  // auto-discovered folder so the alias survives a restart; blank resets to the
  // basename). Companion toggle persists the "use branch name" auto-alias opt-in.
  ipcMain.handle(
    'userProjects:setAlias',
    async (_e, { targetPath, alias }: { targetPath: string; alias: string }) => {
      return toUserProjectsPayload(await setUserProjectAlias(targetPath, alias))
    }
  )
  ipcMain.handle(
    'userProjects:setAliasFromBranch',
    async (_e, { targetPath, enabled }: { targetPath: string; enabled: boolean }) => {
      return toUserProjectsPayload(await setUserProjectAliasFromBranch(targetPath, enabled))
    }
  )
  // T106 (D6): per-repo opt-out for auto-organizing conversation into draft
  // cards. `getAutoOrganize` resolves the effective value (own, else inherited
  // from the parent repo for a canonical worktree, else default ON) — used by
  // the folder menu toggle's on/off reflection.
  ipcMain.handle('userProjects:getAutoOrganize', async (_e, targetPath: string) => {
    return getUserProjectAutoOrganize(targetPath)
  })
  // T191: the folder menu's "Set parent folder" / "Clear parent folder" — the
  // manual override for the `bornFrom` lineage edge (write-time guards apply
  // only to the birth-time path; this is an explicit human choice).
  ipcMain.handle(
    'userProjects:setBornFrom',
    async (_e, { targetPath, bornFrom }: { targetPath: string; bornFrom: string | null }) => {
      return toUserProjectsPayload(await setUserProjectBornFrom(targetPath, bornFrom))
    }
  )
  // T191: sibling worktrees of the same repo — the "Set parent folder" submenu's
  // candidate list.
  ipcMain.handle(
    'userProjects:listBornFromCandidates',
    async (_e, { repoId, excludePath }: { repoId: string; excludePath: string }) => {
      return listBornFromCandidates(repoId, excludePath)
    }
  )
  ipcMain.handle(
    'userProjects:setAutoOrganize',
    async (_e, { targetPath, enabled }: { targetPath: string; enabled: boolean }) => {
      return toUserProjectsPayload(await setUserProjectAutoOrganize(targetPath, enabled))
    }
  )

  // T344: "new sessions start as Orchestrator" per-folder default (FolderMenu
  // toggle). EXACT-PATH ONLY (AC-5) — see `getUserProjectOrchestratorDefault`'s
  // own doc comment for why this does NOT mirror `autoOrganize`'s worktree
  // inheritance. The actual arm-at-spawn decision lives in `pty.ts`
  // (`shouldArmAtSpawn`); these two handlers only read/write the flag.
  ipcMain.handle('userProjects:getOrchestratorDefault', async (_e, targetPath: string) => {
    return getUserProjectOrchestratorDefault(targetPath)
  })
  ipcMain.handle(
    'userProjects:setOrchestratorDefault',
    async (_e, { targetPath, enabled }: { targetPath: string; enabled: boolean }) => {
      return toUserProjectsPayload(await setUserProjectOrchestratorDefault(targetPath, enabled))
    }
  )

  // T98: the orchestrator role toggle (SessionMenu "Promote to orchestrator").
  // `arm`/`disarm` delegate straight to `orchestrator-guard.ts` (T109's guard +
  // hook registration); `list` hydrates the renderer's `orchestratorSessionIds`
  // mirror at store init (mirrors `userProjects:list` seeding `agentAllowedPaths`).
  ipcMain.handle(
    'orchestratorGuard:arm',
    async (_e, { sessionId, folder }: { sessionId: string; folder: string }) => {
      await armOrchestrator(sessionId, folder)
    }
  )
  // T344 AC-4: an explicit renderer-driven disarm is always the operator's own
  // gesture (SessionMenu toggle-off) — pass `'demote'` explicitly so a
  // folder-default-armed session is removed here too, never just left alone
  // the way a `'sessionEnd'` hook leaves it (see `orchestrator-guard.ts`'s
  // `shouldDisarmEntry`).
  ipcMain.handle('orchestratorGuard:disarm', async (_e, sessionId: string) => {
    await disarmOrchestrator(sessionId, 'demote')
  })
  ipcMain.handle('orchestratorGuard:list', async () => {
    return listArmedSessionIds()
  })

  // BUG-54 (D8): the last-shutdown record (sessions still `working` at the
  // previous quit). Written in `before-quit`, below; this spec only exposes it
  // — rendering an `interrupted` state is T167's follow-up.
  ipcMain.handle('fleet:lastShutdown', async () => {
    await terminalLedgerReady
    return getLastShutdown()
  })

  // BUG-64 C: the renderer's own "this agent session's pre-prompt was never
  // delivered" verdict (`sessions.ts`'s `markPromptUndelivered`) pushed to
  // main so `get_session`/`get_fleet` stop reporting a stuck session as
  // `active` — see `injection-escalation-registry.ts`. `clearUndelivered`
  // mirrors the renderer's own recovery path (`retryPromptInjection`).
  ipcMain.on('injection:markUndelivered', (_e, sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId) {
      markInjectionEscalated(sessionId, 'prompt_undelivered')
    }
  })
  ipcMain.on('injection:clearUndelivered', (_e, sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId) clearInjectionEscalation(sessionId)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async (event) => {
  // We always synchronously kill PTYs; the watcher close is async but
  // best-effort. Defer Electron's actual quit until the watcher is closed
  // so chokidar's file descriptors are released cleanly.
  stopHibernationSweep()
  killAllPtys()
  killAllSpeech()
  cancelKokoroInstall()
  // BUG-54 (D7): record the sessions that were still `working` at this instant
  // as the new `lastShutdown` set — the ledger is the only component present
  // here, so it's the only place that can distinguish "interrupted by THIS
  // quit" from a transcript's dirty tail 71 hours old. Best-effort: a hard
  // crash records nothing, and the safe fallback is BUG-53's `idle`.
  try {
    const workingSessionIds = [...getTaskStates()]
      .filter(([, state]) => state === 'working')
      .map(([sessionId]) => sessionId)
    await recordShutdownSnapshot(workingSessionIds, Date.now())
  } catch (err) {
    console.error('[terminal-ledger] shutdown snapshot failed', err)
  }
  stopHeartbeat()
  stopFullSamplerForced()
  // MCP teardown (fail-closed): deny every parked agent confirm + reject every
  // in-flight CommandBridge dispatch synchronously, so nothing actuates during
  // shutdown. The server's async close (stop listener + SSE connections + delete
  // harnu.mcp.json) is awaited in the watcher branch below.
  closeMcpConfirm()
  closeCommandBridge()
  await closeAllMarkdownWatchers()
  await closeAllCanvasWatchers()
  closeUsagePoller()
  closeClaudeChangelog()
  closeClaudeStatus()
  void closeHookBridge()
  closeDigestEngine()
  void sessionRegistryWatcher?.close()
  void closeRoadmapWatcher()
  closeScreenDetect()
  closeExtensionsWatcher()
  void closeStatusLine()
  void closeUsageHistory()
  void closeUsageCost()
  closeHaiku()
  closeWorktreeTracker?.()
  closeWorktreeTracker = null
  if (watcherHandle) {
    event.preventDefault()
    const handle = watcherHandle
    watcherHandle = null
    try {
      await closeMcpServer() // closeAllConnections + delete harnu.mcp.json (SSE-safe)
    } catch {
      /* swallow — best effort */
    }
    try {
      await handle.close()
    } catch {
      /* swallow — best effort */
    }
    await closeSettingsWatcher()
    app.quit()
  } else {
    // No claude watcher running (e.g. renderer never called `folders:load`),
    // but the settings watcher / MCP server may still hold an fd. Close both
    // best-effort (the config file is force-rewritten on next boot regardless).
    void closeMcpServer()
    void closeSettingsWatcher()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
