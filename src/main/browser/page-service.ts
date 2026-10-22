/**
 * The `harnu-page://` service (T564 U2): the protocol handler, the folder index, the reload-on-change watchers,
 * the guest's private IPC (`getData`, `emit`) and the live-panel seam the verbs use. Electron-bound glue; every
 * decision it makes lives in a pure module next to it (`page-url`, `page-guard`, `page-state`, `page-watch`,
 * `page-patch`, `emit-gate`, `page-delivery`).
 */
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ipcMain, net, type IpcMainEvent, type Session } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { atomicWriteFile } from '../mcp/atomic-write'
import { appendAudit } from '../mcp/audit-log'
import { isFolderDenied } from '../mcp/permission-core'
import { readUserProjects } from '../user-projects'
import { waitForSessionReady } from '../pty'
import {
  createEmitRateLimiter,
  evaluateEmitGate,
  formatPageEvent,
  validateEmit,
  type ActivationKind
} from './emit-gate'
import { createHeldEvents, deliverUserTurn } from './page-delivery'
import {
  createDebouncer,
  createDependencySet,
  planWatchEvent,
  type DependencySet
} from './page-watch'
import { createPageStateStore, type PageState } from './page-state'
import {
  UNTICKETED_BODY,
  UNTICKETED_STATUS,
  createPageTickets,
  unticketedHeaders,
  type PageTickets
} from './page-ticket'
import type { PatchResult } from './page-patch'
import {
  PAGE_SCHEME,
  PAGE_SCHEME_PRIVILEGES,
  buildPageUrl,
  folderIdOf,
  jailResolve,
  mimeFor,
  pageCsp,
  pageResponseHeaders,
  parsePageUrl,
  type JailFs,
  type PageFolder
} from './page-url'
import type { BrowserAccess } from './access'
import type { BrowserRegistry } from './registry'
import type { BrowserViewHost, PageHooks } from './view-host'
import type { PageSeam } from './verbs-core'

/**
 * The privileged-scheme entry for `harnu-page:` (spec §4.1). It is NOT registered here: Electron keeps only the
 * privileges of the last `registerSchemesAsPrivileged` call (a second call strips `secure` from the first, measured
 * in the T569 probe), so `index.ts` passes this to the ONE call `registerKokoroScheme` makes, before ready.
 */
export function pageSchemeEntry(): Electron.CustomScheme {
  return { scheme: PAGE_SCHEME, privileges: { ...PAGE_SCHEME_PRIVILEGES } }
}

const realFs: JailFs = {
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p)
}

/** The private channels between the guest preload and main (spec §3.3). Never listed in the app preload. */
export const PAGE_CHANNEL = {
  getData: 'harnu:page:getData',
  emit: 'harnu:page:emit',
  data: 'harnu:page:data'
} as const

export interface PageServiceDeps {
  registry: BrowserRegistry
  access: BrowserAccess
  getHost(): BrowserViewHost
  now(): number
  /** The renderer command bridge; `undefined` until `registerMcpServer` hands it over. */
  getBridge(): { dispatch(command: string, payload: unknown): Promise<unknown> } | undefined
}

export interface PageService {
  hooks: PageHooks
  seam: PageSeam
  registerIpc(): void
  /** Test and live-proof hook. */
  watchCount(): number
}

interface Watch {
  paneId: string
  folder: string
  realFolder: string
  folderId: string
  relPath: string
  mainFile: string
  deps: DependencySet
  watcher: FSWatcher
  mainRemoved: boolean
  reload: { trigger(): void; cancel(): void }
}

export function createPageService(deps: PageServiceDeps): PageService {
  const home = os.homedir()
  const state = createPageStateStore({
    now: deps.now,
    fs: {
      readFile: (f) => fsp.readFile(f, 'utf8'),
      readFileSync: (f) => fs.readFileSync(f, 'utf8'),
      writeAtomic: async (f, body) => {
        await fsp.mkdir(path.dirname(f), { recursive: true })
        await atomicWriteFile(f, body, 0o644)
      }
    }
  })
  const rate = createEmitRateLimiter(deps.now)
  const held = createHeldEvents()
  const watches = new Map<string, Watch>()
  /** Real paths of folders, cached: `realpath` is cheap but runs once per folder per request otherwise. */
  const realCache = new Map<string, { real: string; at: number }>()
  let lastIndex = new Map<string, PageFolder>()

  async function realOf(folder: string): Promise<string | null> {
    const hit = realCache.get(folder)
    if (hit && deps.now() - hit.at < 30_000) return hit.real
    try {
      const real = await fsp.realpath(folder)
      realCache.set(folder, { real, at: deps.now() })
      return real
    } catch {
      return null
    }
  }

  /**
   * Every folder a page may be served from: the pinned folders plus the folders panes live in. Rebuilt on every
   * call because the folder block must be re-read per request (spec §4.2 step 3).
   */
  async function loadIndex(): Promise<{ byId: Map<string, PageFolder>; deny: string[] }> {
    const projects = (await readUserProjects()).projects
    const deny = projects.filter((p) => p.agentDenied === true).map((p) => p.path)
    const folders = new Set<string>(projects.map((p) => p.path))
    for (const rec of deps.registry.list()) folders.add(rec.folder)
    const byId = new Map<string, PageFolder>()
    for (const folder of folders) {
      const real = await realOf(folder)
      if (real) byId.set(folderIdOf(real), { folder, realFolder: real })
    }
    lastIndex = byId
    return { byId, deny }
  }

  /** The synchronous lookup the guest's `getData` needs (it runs inside a sync IPC). */
  function folderByIdSync(folderId: string): PageFolder | null {
    const hit = lastIndex.get(folderId)
    if (hit) return hit
    for (const rec of deps.registry.list()) {
      try {
        const real = fs.realpathSync(rec.folder)
        if (folderIdOf(real) === folderId) return { folder: rec.folder, realFolder: real }
      } catch {
        /* a vanished folder */
      }
    }
    return null
  }

  /* ---- The protocol handler ----------------------------------------------------------------- */

  const refusalHeaders = {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': pageResponseHeaders('', false)['Content-Security-Policy']!,
    'Cache-Control': 'no-store'
  }
  const unticketed = unticketedHeaders(pageCsp(false))
  /** Tickets are per guest partition: a request is served only by the session whose check allowed it. */
  const ticketsByPartition = new Map<string, PageTickets>()
  const ticketsFor = (partition: string): PageTickets => {
    let t = ticketsByPartition.get(partition)
    if (!t) {
      t = createPageTickets(deps.now)
      ticketsByPartition.set(partition, t)
    }
    return t
  }

  async function handle(request: Request, tickets: PageTickets): Promise<Response> {
    // FIRST, before any I/O: a request that never passed the `onBeforeRequest` origin check (a worker's) has no
    // ticket and gets one identical refusal, so it learns nothing about what exists (F1).
    if (!tickets.redeem(request.url)) {
      return new Response(UNTICKETED_BODY, { status: UNTICKETED_STATUS, headers: unticketed })
    }
    const { byId, deny } = await loadIndex()
    const verdict = await jailResolve({
      url: request.url,
      folders: byId,
      isBlocked: (folder) => isFolderDenied(folder, deny, home),
      fs: realFs
    })
    if (!verdict.ok) {
      return new Response(`harnu-page: ${verdict.reason}`, {
        status: verdict.status,
        headers: refusalHeaders
      })
    }
    const range = request.headers.get('range')
    const upstream = await net.fetch(pathToFileURL(verdict.realPath).toString(), {
      ...(range ? { headers: { range } } : {})
    })
    // The offline policy is the default here; a pane the operator switched on gets the relaxed one in
    // `onHeadersReceived` (view-host.ts), which can see which pane asked.
    const headers = new Headers(pageResponseHeaders(mimeFor(verdict.realPath), false))
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(name)
      if (v) headers.set(name, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  /* ---- Watchers (spec §4.4) ------------------------------------------------------------------- */

  function dropWatch(paneId: string): void {
    const w = watches.get(paneId)
    if (!w) return
    watches.delete(paneId)
    w.reload.cancel()
    void w.watcher.close().catch(() => undefined)
    w.deps.clear()
  }

  async function ensureWatch(paneId: string, url: string): Promise<void> {
    const parsed = parsePageUrl(url)
    if (!parsed || parsed.segments.length === 0) {
      dropWatch(paneId)
      return
    }
    const existing = watches.get(paneId)
    if (existing && existing.folderId === parsed.folderId && existing.relPath === parsed.relPath) {
      return
    }
    dropWatch(paneId)
    const { byId } = await loadIndex()
    const folder = byId.get(parsed.folderId)
    if (!folder) return
    // The pane may have navigated or closed while the index loaded.
    if (!deps.registry.get(paneId)) return
    const mainFile = path.join(folder.realFolder, ...parsed.segments)
    const watcher = chokidar.watch(mainFile, { ignoreInitial: true, persistent: true })
    const w: Watch = {
      paneId,
      folder: folder.folder,
      realFolder: folder.realFolder,
      folderId: parsed.folderId,
      relPath: parsed.relPath,
      mainFile,
      deps: createDependencySet(),
      watcher,
      mainRemoved: false,
      reload: createDebouncer(
        () => {
          void deps.getHost().reloadPage(paneId)
        },
        { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as never) }
      )
    }
    watches.set(paneId, w)
    const onEvent =
      (kind: 'add' | 'change' | 'unlink') =>
      (file: string): void => {
        const action = planWatchEvent(kind, file, {
          mainFile: w.mainFile,
          deps: w.deps,
          mainRemoved: w.mainRemoved
        })
        if (action === 'ignore') return
        if (action === 'removed') {
          w.mainRemoved = true
          w.reload.cancel()
          deps.getHost().setFileRemoved(paneId, true)
          return
        }
        if (action === 'restored') {
          w.mainRemoved = false
          deps.getHost().setFileRemoved(paneId, false)
        }
        w.reload.trigger()
      }
    watcher.on('add', onEvent('add'))
    watcher.on('change', onEvent('change'))
    watcher.on('unlink', onEvent('unlink'))
    watcher.on('error', () => undefined)
  }

  function noteRequest(paneId: string, url: string): void {
    const w = watches.get(paneId)
    const parsed = parsePageUrl(url)
    if (!w || !parsed || parsed.folderId !== w.folderId || parsed.segments.length === 0) return
    const file = path.join(w.realFolder, ...parsed.segments)
    if (file === w.mainFile || w.deps.has(file)) return
    if (w.deps.add(file)) w.watcher.add(file)
  }

  /* ---- The hooks the view host calls ------------------------------------------------------------ */

  const hooks: PageHooks = {
    registerProtocol(ses: Session, partition: string): void {
      const tickets = ticketsFor(partition)
      ses.protocol.handle(PAGE_SCHEME, (request) => handle(request, tickets))
    },
    onNavigated(paneId, url) {
      void ensureWatch(paneId, url).catch(() => undefined)
    },
    onDestroyed(paneId) {
      dropWatch(paneId)
      rate.forget(paneId)
      held.forget(paneId)
    },
    onRequest(partition, paneId, url) {
      // The check allowed this request: let the handler serve it once, and watch the file for its pane.
      ticketsFor(partition).issue(url)
      if (paneId) noteRequest(paneId, url)
    },
    allowNetwork: (paneId) => deps.registry.get(paneId)?.allowNetwork === true
  }

  /* ---- The seam the verbs use --------------------------------------------------------------------- */

  async function locate(liveUrl: string): Promise<{ folder: string; relPath: string } | null> {
    const parsed = parsePageUrl(liveUrl)
    if (!parsed || parsed.segments.length === 0) return null
    const { byId } = await loadIndex()
    const folder = byId.get(parsed.folderId)
    return folder ? { folder: folder.folder, relPath: parsed.relPath } : null
  }

  const seam: PageSeam = {
    async folderFor(folder) {
      const real = await realOf(folder)
      return real ? { folder, realFolder: real } : null
    },
    fs: realFs,
    locate,
    state,
    pushData(folder, relPath, st: PageState) {
      let reached = 0
      for (const w of watches.values()) {
        if (w.folder !== folder || w.relPath !== relPath) continue
        const wc = deps.getHost().webContentsOf(w.paneId)
        if (!wc || wc.isLoading()) continue
        wc.send(PAGE_CHANNEL.data, { data: st.data, rev: st.rev })
        reached++
      }
      return reached
    },
    async runPatch(paneId, script) {
      return deps.getHost().runInPage<PatchResult>(paneId, script)
    },
    async writePanel(folder, slug, html) {
      const rel = `.harnu/out/panels/${slug}.html`
      const file = path.join(folder, '.harnu', 'out', 'panels', `${slug}.html`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await atomicWriteFile(file, html, 0o644)
      return rel
    },
    urlFor(folderReal, relPath) {
      return buildPageUrl(folderIdOf(folderReal), relPath)
    }
  }

  /* ---- The guest's private IPC (spec §3.3) -------------------------------------------------------- */

  /** Who is asking: the registered guest pane, from a top frame that is one of OUR pages. */
  function senderPane(event: IpcMainEvent): { paneId: string; url: string } | null {
    const paneId = deps.getHost().paneIdOfWebContents(event.sender.id)
    if (!paneId) return null
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return null
    if (!frame.url.startsWith(`${PAGE_SCHEME}:`)) return null
    return { paneId, url: frame.url }
  }

  function audit(paneId: string, verdict: string, result: string): void {
    const rec = deps.registry.get(paneId)
    appendAudit({
      ts: deps.now(),
      tool: 'browser_page_event',
      folder: rec?.folder ?? '',
      verdict,
      disclosedPayloadSummary: 'none',
      result: `${result}: pane ${paneId}`
    })
  }

  async function onEmit(event: IpcMainEvent, msg: unknown): Promise<void> {
    const who = senderPane(event)
    if (!who || typeof msg !== 'object' || msg === null) return
    const m = msg as {
      type?: unknown
      payload?: unknown
      tooLarge?: unknown
      active?: unknown
      by?: unknown
    }
    const rec = deps.registry.get(who.paneId)
    if (!rec) return
    const by: ActivationKind = m.by === 'key' || m.by === 'pointer' ? m.by : null
    const input = deps.registry.agentInput(who.paneId)
    const gate = evaluateEmitGate({
      now: deps.now(),
      userActivationActive: m.active === true,
      activatedBy: by,
      agentInputInFlight: input.inFlight,
      agentInputAt: input.at,
      paused: deps.access.isPaused(who.paneId),
      disconnected: deps.access.isDisconnected(who.paneId),
      lastRealKeyDownAt: deps.getHost().lastRealKeyDownAt(who.paneId)
    })
    if (!gate.ok) {
      audit(who.paneId, 'deny', `PAGE_EVENT_GATE_${gate.failed}`)
      return
    }
    const valid =
      m.tooLarge === true
        ? ({ ok: false, code: 'PAGE_EVENT_TOO_LARGE', detail: 'over the cap' } as const)
        : validateEmit(m.type, m.payload)
    if (!valid.ok) {
      audit(who.paneId, 'deny', valid.code)
      return
    }
    const slot = rate.take(who.paneId)
    if (!slot.deliver) {
      audit(who.paneId, 'deny', 'PAGE_EVENT_RATE_LIMIT')
      return
    }
    const text = formatPageEvent({
      paneName: rec.name,
      pagePath: rec.pagePath ?? parsePageUrl(who.url)?.relPath ?? null,
      type: valid.type,
      payloadJson: valid.payloadJson,
      dropped: slot.dropped
    })
    const bridge = deps.getBridge()
    if (!bridge) {
      held.hold(who.paneId, text)
      audit(who.paneId, 'allow', 'PAGE_EVENT_HELD_NO_BRIDGE')
      return
    }
    const outcome = await deliverUserTurn(
      { dispatch: (c, p) => bridge.dispatch(c, p), waitForSessionReady },
      { sessionId: rec.ownerSessionId, folder: rec.folder, text, source: 'page-event' }
    )
    if (outcome.status === 'held') held.hold(who.paneId, text)
    audit(
      who.paneId,
      outcome.status === 'failed' ? 'deny' : 'allow',
      outcome.status === 'delivered'
        ? `PAGE_EVENT_DELIVERED${outcome.woke ? '_AFTER_WAKE' : ''}`
        : outcome.status === 'held'
          ? 'PAGE_EVENT_HELD'
          : `PAGE_EVENT_FAILED: ${outcome.reason}`
    )
  }

  function registerIpc(): void {
    // Sync, because `harnu.getData()` must answer at DOMContentLoaded.
    ipcMain.on(PAGE_CHANNEL.getData, (event) => {
      const who = senderPane(event)
      const parsed = who ? parsePageUrl(who.url) : null
      const folder = parsed ? folderByIdSync(parsed.folderId) : null
      const rec = who ? deps.registry.get(who.paneId) : undefined
      if (!who || !parsed || !folder || !rec) {
        event.returnValue = null
        return
      }
      const st = state.readSync(folder.folder, parsed.relPath)
      event.returnValue = {
        data: st.data,
        rev: st.rev,
        pane: { id: who.paneId, name: rec.name }
      }
    })
    ipcMain.on(PAGE_CHANNEL.emit, (event, msg: unknown) => {
      void onEmit(event, msg).catch(() => undefined)
    })
  }

  return { hooks, seam, registerIpc, watchCount: () => watches.size }
}
