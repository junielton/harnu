/**
 * The browser pane's main-process service (T564 U1): the singletons (registry, access, view host) and the
 * seams the MCP handlers and the IPC layer share. Electron-bound glue; every decision it makes lives in the
 * pure modules next to it.
 */
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { readAgentBrowserWrites } from '../mcp/prefs'
import { scrubTerminalText } from '../scrub-terminal'
import { createBrowserAccess } from './access'
import { resolveGateInput, type GateResolution } from './gate-resolve'
import { createBrowserRegistry } from './registry'
import { BrowserViewHost, collectHarnuPorts } from './view-host'
import type { BrowserVerbDeps } from './verbs-core'
import type { BrowserPartition } from './guest-prefs'

export const browserRegistry = createBrowserRegistry(() => Date.now())
export const browserAccess = createBrowserAccess(() => Date.now())

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
    trustedHosts: () => [],
    openPopupPane: ({ folder, partition, url }) =>
      openOperatorPane({ folder, partition, url, popup: true })
  })
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
}

/**
 * The plan-level gate state of a pane-addressed browser verb (spec §6.3): resolved BEFORE planning so a refused
 * call never raises a confirm first. An unknown id leaves `pane` undefined, which the gate answers
 * `PANE_NOT_FOUND`. `folder` is the pane's own folder, the gate anchor for the folder block.
 */
export async function resolveBrowserGate(paneId: string | undefined): Promise<GateResolution> {
  const writesEnabled = await readAgentBrowserWrites()
  const rec = paneId === undefined ? undefined : browserRegistry.get(paneId)
  return resolveGateInput({
    rec,
    liveUrl: rec ? (getBrowserHost().info(rec.paneId)?.url ?? '') : '',
    writesEnabled,
    disconnected: rec ? browserAccess.isDisconnected(rec.paneId) : false,
    paused: rec ? browserAccess.isPaused(rec.paneId) : false,
    harnuPorts: collectHarnuPorts(mcpPort),
    trustedHosts: []
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
    trustedHosts: () => [],
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
