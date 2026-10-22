/**
 * The browser pane's main-process service (T564 U1): the singletons (registry, access, view host) and the
 * seams the MCP handlers and the IPC layer share. Electron-bound glue; every decision it makes lives in the
 * pure modules next to it.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { readAgentBrowserWrites } from '../mcp/prefs'
import { scrubTerminalText } from '../scrub-terminal'
import { createBrowserAccess } from './access'
import { browserLeases } from './lease-singleton'
import { browserWriteQueue } from './write-queue'
import type { BrowserActDeps } from './act-verbs'
import {
  browserReadOptIns,
  browserTrustedHostsFor,
  readUserProjects,
  type UserProjectsFile
} from '../user-projects'
import { resolveGateInput, type GateResolution } from './gate-resolve'
import { createBrowserRegistry } from './registry'
import { BrowserViewHost, collectHarnuPorts } from './view-host'
import type { BrowserReadDeps } from './read-verbs'
import type { BrowserVerbDeps } from './verbs-core'
import type { BrowserPartition } from './guest-prefs'

export const browserRegistry = createBrowserRegistry(() => Date.now())
export const browserAccess = createBrowserAccess(() => Date.now())
export { browserLeases }

/**
 * The operator's trusted dev hosts per folder (spec §7.2), kept in memory because classification is synchronous
 * and the file read is not. Keyed by the folder exactly as a pane carries it. Filled whenever a verb resolves its
 * gate (the file is read there anyway) and refreshed when the operator edits the list.
 */
const trustedHostsCache = new Map<string, readonly string[]>()

function trustedHostsSync(folder: string): readonly string[] {
  return trustedHostsCache.get(folder) ?? []
}

/** Read `folder`'s trusted hosts from the projects file into the cache. */
async function loadTrustedHosts(
  folder: string,
  file: UserProjectsFile
): Promise<readonly string[]> {
  const hosts = await browserTrustedHostsFor(file, folder)
  trustedHostsCache.set(folder, hosts)
  return hosts
}

/**
 * The operator edited a folder's trusted hosts or its read opt-in: re-read every folder that has a pane and tell
 * the open panes, so their origin badge, their chip and the next verb see it at once (spec §7.2: "re-evaluated at
 * every call"). Turning the opt-in off already ended the folder's leases in the setter.
 */
export async function refreshBrowserTrustedHosts(file?: UserProjectsFile): Promise<void> {
  const current = file ?? (await readUserProjects())
  const folders = new Set([
    ...trustedHostsCache.keys(),
    ...browserRegistry.list().map((r) => r.folder)
  ])
  for (const folder of folders) {
    await loadTrustedHosts(folder, current)
    await readOptInFor(folder, current)
  }
  if (host) for (const rec of browserRegistry.list()) host.refresh(rec.paneId)
}

/** The folder's browser-read opt-in as last read, for the display-only chip (the gate always reads the file). */
const readOptInCache = new Map<string, boolean>()

/** Whether the folder's browser-read opt-in is on (exact folder). */
async function readOptInFor(folder: string, file?: UserProjectsFile): Promise<boolean> {
  const on = (await browserReadOptIns(file ?? (await readUserProjects()), [folder])).has(folder)
  readOptInCache.set(folder, on)
  return on
}

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let host: BrowserViewHost | null = null
let mcpPort = 0

/** `server.ts` reports the port it bound, so a page on that port classifies as `external` (spec §7.2). */
export function noteMcpPort(port: number): void {
  mcpPort = port
}

/** The view host. Created on first use so a headless unit never builds electron views. */
export function getBrowserHost(): BrowserViewHost {
  if (host) return host
  const getWindow = mainWindowGetter ?? ((): BrowserWindow | null => null)
  host = new BrowserViewHost({
    getWindow,
    guestPreloadPath: join(__dirname, '../preload/browser-guest.js'),
    registry: browserRegistry,
    access: browserAccess,
    now: () => Date.now(),
    harnuPorts: () => collectHarnuPorts(mcpPort),
    trustedHosts: trustedHostsSync,
    readOptIn: (folder) => readOptInCache.get(folder) === true,
    leaseActive: (paneId, token) => browserLeases.isActive(paneId, token),
    scrub: (text) => scrubTerminalText(text, os.homedir()),
    openPopupPane: ({ folder, partition, url }) =>
      openOperatorPane({ folder, partition, url, popup: true })
  })
  // A lease that starts or ends repaints the pane's chip (display only).
  browserLeases.onChange((paneId) => host?.refresh(paneId))
  return host
}

export function bindBrowserWindow(getWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getWindow
}

/**
 * Create a pane the OPERATOR opened (the Split menu, a popup the operator clicked). Operator panes use the
 * operator partition (a popup inherits its opener's) and are never capped (spec §10.1).
 */
export function openOperatorPane(opts: {
  folder: string
  url: string
  partition?: BrowserPartition
  popup?: boolean
}): { paneId: string } {
  const paneId = `bp-${randomUUID().slice(0, 8)}`
  const now = Date.now()
  const partition = opts.partition ?? 'operator'
  browserRegistry.add({
    paneId,
    folder: opts.folder,
    name: 'browser',
    openedBy: 'operator',
    partition,
    ownerSessionId: null,
    createdAt: now,
    lastActiveAt: now,
    seenHosts: new Set<string>(),
    flagged: null
  })
  // The chip shows whether agents may read this pane: fetch the folder's opt-in once, then repaint.
  void readOptInFor(opts.folder).then(() => host?.refresh(paneId))
  try {
    getBrowserHost().create({ paneId, folder: opts.folder, partition, url: opts.url })
  } catch (err) {
    browserRegistry.remove(paneId)
    throw err
  }
  if (opts.popup) {
    mainWindowGetter?.()?.webContents.send('browser:popup', {
      paneId,
      worktreePath: opts.folder,
      url: opts.url,
      partition
    })
  }
  return { paneId }
}

/** Close a pane from the operator's side (X button, a removed helper): the view, the record, the access state. */
export function closePaneFromOperator(paneId: string): void {
  getBrowserHost().destroy(paneId)
  browserRegistry.remove(paneId)
  browserAccess.forget(paneId)
  browserLeases.forget(paneId)
}

/**
 * The plan-level gate state of a pane-addressed browser verb (spec §6.3): resolved BEFORE planning so a refused
 * call never raises a confirm first. An unknown id leaves `pane` undefined, which the gate answers
 * `PANE_NOT_FOUND`. `folder` is the pane's own folder, the gate anchor for the folder block.
 */
export async function resolveBrowserGate(
  paneId: string | undefined,
  file?: UserProjectsFile,
  /** `browser_open` / `browser_list` carry a folder of their own: its trusted hosts are loaded for them. */
  folder?: string
): Promise<GateResolution> {
  const writesEnabled = await readAgentBrowserWrites()
  // Switching agent browser control off ends every lease. The Settings toggle does that itself; doing it here too
  // covers a pref flipped some other way, and costs nothing while the switch is on.
  if (!writesEnabled) browserLeases.revokeAll()
  const rec = paneId === undefined ? undefined : browserRegistry.get(paneId)
  const projects = file ?? (await readUserProjects())
  if (rec) await loadTrustedHosts(rec.folder, projects)
  else if (folder !== undefined) await loadTrustedHosts(folder, projects)
  const readOptIn = rec ? await readOptInFor(rec.folder, projects) : false
  // A lease on an operator pane rides on the folder's opt-in: whenever the opt-in is seen OFF the lease ends,
  // whatever turned it off, so turning it back on can never revive an old approval.
  if (rec && rec.openedBy === 'operator' && !readOptIn) browserLeases.revoke(rec.paneId)
  const token = rec ? getBrowserHost().viewToken(rec.paneId) : undefined
  return resolveGateInput({
    rec,
    liveUrl: rec ? (getBrowserHost().info(rec.paneId)?.url ?? '') : '',
    writesEnabled,
    disconnected: rec ? browserAccess.isDisconnected(rec.paneId) : false,
    paused: rec ? browserAccess.isPaused(rec.paneId) : false,
    readOptIn,
    leaseActive:
      rec !== undefined && token !== undefined ? browserLeases.isActive(rec.paneId, token) : false,
    writeDenied: rec ? browserLeases.isDenied(rec.paneId) : false,
    inputReady: rec ? getBrowserHost().inputReady(rec.paneId) : true,
    harnuPorts: collectHarnuPorts(mcpPort),
    trustedHosts: rec ? trustedHostsSync(rec.folder) : []
  })
}

/** What the handlers pass in: the bits of the MCP call context the verbs need. */
export interface BrowserHandlerEnv {
  bridge: { dispatch(command: string, payload: unknown): Promise<unknown> } | undefined
  sessionKnown(sessionId: string): boolean
  folderBlocked(folder: string): boolean
}

function dispatchOk(result: unknown): boolean {
  return !(
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { error?: unknown }).error === 'string'
  )
}

/** The real dependencies of the verb logic, over the singletons above. */
export function makeBrowserVerbDeps(env: BrowserHandlerEnv): BrowserVerbDeps {
  const home = os.homedir()
  return {
    now: () => Date.now(),
    newPaneId: () => `bp-${randomUUID().slice(0, 8)}`,
    registry: browserRegistry,
    access: browserAccess,
    host: getBrowserHost(),
    writesEnabled: () => readAgentBrowserWrites(),
    leases: browserLeases,
    readOptIn: (folder) => readOptInFor(folder),
    trustedHosts: trustedHostsSync,
    harnuPorts: () => collectHarnuPorts(mcpPort),
    sessionKnown: (id) => env.sessionKnown(id),
    showPane: async (payload) => {
      if (!env.bridge) return false
      return dispatchOk(await env.bridge.dispatch('pane.browser', payload))
    },
    hidePane: async (folder, paneId) => {
      if (!env.bridge) return false
      return dispatchOk(
        await env.bridge.dispatch('pane.closePane', { worktreePath: folder, paneId })
      )
    },
    scrub: (text) => scrubTerminalText(text, home),
    alias: (folder) => path.basename(folder) || folder,
    folderBlocked: (folder) => env.folderBlocked(folder)
  }
}

/** Where a pane's saved screenshots go, relative to its folder (spec §6.2). */
export const SHOTS_DIR = '.harnu/out/browser/shots'

/** The dependencies of the reading verbs: the U1 set plus the clock, the screenshot writer and the panel data seam. */
export function makeBrowserReadDeps(env: BrowserHandlerEnv): BrowserReadDeps {
  return {
    ...makeBrowserVerbDeps(env),
    host: getBrowserHost(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    saveShot: async (folder, data, ext) => {
      const dir = join(folder, SHOTS_DIR)
      await mkdir(dir, { recursive: true })
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}.${ext === 'jpeg' ? 'jpg' : 'png'}`
      await writeFile(join(dir, name), data, { mode: 0o644 })
      return `${SHOTS_DIR}/${name}`
    }
    // `pageData` (browser_snapshot's `include: ['data']`) is wired by the live-panel unit (U2): one seam.
  }
}

/** The dependencies of the acting verbs: the reading set plus the per-pane write queue. */
export function makeBrowserActDeps(env: BrowserHandlerEnv): BrowserActDeps {
  return { ...makeBrowserReadDeps(env), host: getBrowserHost(), queue: browserWriteQueue }
}

/** The kill-switch went off: every pane's network capture ends at once (spec §7.4). */
export function stopAllBrowserCaptures(): void {
  if (host) host.stopAllCaptures('kill-switch')
  browserLeases.revokeAll()
}
