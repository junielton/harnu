/**
 * Terminal IPC (T474 unit B2): the renderer's door onto the terminal registry.
 *
 * Main owns an agent terminal's PTY, so the renderer has to ask main — never assume — about
 * three things: whether the PTY already ended (`terminal:status`), tearing it down
 * (`terminal:close`), and what happened to its xterm (`terminal:xtermGone`). Main also tells the
 * renderer about every live agent terminal again each time it announces `renderer:ready`, so a
 * reload never strands a writable, invisible terminal that still counts against
 * `TERMINAL_LIMIT` (spec §8 case 11).
 *
 * T474 B7 adds the operator's Disconnect (`terminal:disconnect`, permanent, stops reads and writes;
 * the pane's button is U1's) and the `terminal:activity` stream the chip's live signal reads;
 * T474 U1 adds `terminal:chip`, the chip's read-only view of a terminal.
 *
 * The handlers are plain functions over an injected registry and close function, so the
 * lifecycle is testable without electron; {@link registerTerminalIpc} only binds them.
 */
import { app, ipcMain, webContents, type WebContents } from 'electron'
import { closeTerminalPty } from './pty'
import { TerminalActivityCoalescer, type TerminalActivityEvent } from './terminal-activity'
import { disconnectTerminal } from './terminal-gate'
import { redispatchLiveTerminals, terminalStatus, type TerminalStatus } from './terminal-lifecycle'
import { terminalLeases, type TerminalLeases } from './terminal-lease'
import {
  terminalChipState,
  terminalRegistry,
  type TerminalChipState,
  type TerminalRegistry
} from './terminal-registry'
import { screenModelFor } from './terminal-screen'

/**
 * The renderer's xterms are gone, so no pane answers terminal queries until a new one adopts
 * (spec §5.4). A reload or a crash sends no `terminal:xtermGone` of its own, so main resets
 * EVERY record: the screen model answers again from the next byte on.
 */
export function resetRendererAttached(registry: TerminalRegistry): void {
  for (const rec of registry.list()) rec.rendererAttached = false
}

/**
 * `terminal:status`, with the tombstone snapshot RESOLVED when a screen model exists: the
 * raw output tail the registry keeps is escape codes and `\r` overwrites, which paint as
 * garbage in a pane that mounts after the exit (spec §8 cases 4, 5).
 */
export async function terminalStatusResolved(
  registry: TerminalRegistry,
  terminalId: unknown
): Promise<TerminalStatus> {
  const status = terminalStatus(registry, terminalId)
  if (!status.known || status.state !== 'exited' || typeof terminalId !== 'string') return status
  const model = screenModelFor(terminalId)
  if (!model) return status
  // The pane writes this straight into an xterm without `convertEol`: a bare LF would not
  // return to column 0 and the text would paint as a staircase.
  return { ...status, snapshot: (await model.tombstoneText()).replace(/\r?\n/g, '\r\n') }
}

/**
 * Wire the registry's agent-activity notifications to `send`, coalesced to one event per
 * terminal per 250 ms (spec §7.3). Returns the disposer.
 */
export function wireTerminalActivity(
  registry: TerminalRegistry,
  send: (event: TerminalActivityEvent) => void,
  deps?: ConstructorParameters<typeof TerminalActivityCoalescer>[1]
): () => void {
  const coalescer = new TerminalActivityCoalescer(send, deps)
  const off = registry.onAgentActivity((terminalId, kind) => coalescer.note(terminalId, kind))
  return () => {
    off()
    coalescer.dispose()
  }
}

/**
 * Tell the renderer to re-read a terminal's chip whenever its write lease is granted or ends
 * (Disconnect, folder block, kill-switch, Deny, idle-out found on a check), so "An agent can type
 * here" never lingers after the lease is gone. Returns the disposer.
 */
export function wireTerminalChipChanged(
  leases: TerminalLeases,
  send: (event: { terminalId: string }) => void
): () => void {
  return leases.onChange((terminalId) => send({ terminalId }))
}

/**
 * `terminal:chip`: what the pane's connection chip renders for `terminalId` (spec §7.3), or null
 * for an unknown id. Read-only; the lease is asked live, so an idled-out lease reads false.
 */
export function terminalChipFor(
  registry: TerminalRegistry,
  leases: TerminalLeases,
  terminalId: unknown
): TerminalChipState | null {
  if (typeof terminalId !== 'string') return null
  const rec = registry.get(terminalId)
  return rec ? terminalChipState(rec, leases.isActive(terminalId, rec.ptyId)) : null
}

const watched = new WeakSet<WebContents>()

/**
 * Reset on the two ways a renderer vanishes without saying so. The reload event is
 * `did-start-navigation` for the main frame, not same-document: `will-navigate` (the only
 * navigation hook `index.ts` has) does NOT fire on a reload. `terminal:xtermGone` from
 * `beforeunload` stays the primary path; this is the net under it.
 *
 * `did-start-navigation` also fires for a navigation `index.ts` is about to BLOCK (a file
 * dropped on the window, a redirect): the xterms survive that, so resetting would leave every
 * query answered twice with nothing to restore the flag. Only a navigation to the renderer
 * document itself counts.
 */
function watchRenderer(wc: WebContents, isRendererUrl: (url: string) => boolean): void {
  if (watched.has(wc) || wc.getType() !== 'window') return
  watched.add(wc)
  wc.on('render-process-gone', () => resetRendererAttached(terminalRegistry))
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && isRendererUrl(details.url)) {
      resetRendererAttached(terminalRegistry)
    }
  })
}

/**
 * Bind the handlers. Call it AFTER `registerCommandBridge`: its `renderer:ready` listener is the
 * one that opens the dispatch gate, and ours must run once the gate is open.
 */
export function registerTerminalIpc(
  bridge: { dispatch: (command: string, payload: unknown) => Promise<unknown> },
  /** Whether a navigation target is the renderer document (`index.ts` owns the answer). */
  isRendererUrl: (url: string) => boolean = () => true
): void {
  ipcMain.handle('terminal:status', (_e, terminalId: unknown) =>
    terminalStatusResolved(terminalRegistry, terminalId)
  )

  ipcMain.handle('terminal:close', (_e, terminalId: unknown): boolean =>
    typeof terminalId === 'string' ? closeTerminalPty(terminalId) : false
  )

  ipcMain.handle('terminal:chip', (_e, terminalId: unknown) =>
    terminalChipFor(terminalRegistry, terminalLeases, terminalId)
  )

  // The operator's Disconnect (spec §6.4). Permanent: there is no reconnect handler on purpose.
  ipcMain.handle('terminal:disconnect', (_e, terminalId: unknown): boolean =>
    typeof terminalId === 'string' ? disconnectTerminal(terminalId) : false
  )

  wireTerminalChipChanged(terminalLeases, (event) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'window' && !wc.isDestroyed()) wc.send('terminal:chipChanged', event)
    }
  })

  wireTerminalActivity(terminalRegistry, (event) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'window' && !wc.isDestroyed()) wc.send('terminal:activity', event)
    }
  })

  ipcMain.on('terminal:xtermGone', (_e, terminalId: unknown) => {
    if (typeof terminalId === 'string') terminalRegistry.setRendererAttached(terminalId, false)
  })

  for (const wc of webContents.getAllWebContents()) watchRenderer(wc, isRendererUrl)
  app.on('web-contents-created', (_e, wc) => watchRenderer(wc, isRendererUrl))

  ipcMain.on('renderer:ready', () => {
    void redispatchLiveTerminals(terminalRegistry, (c, p) => bridge.dispatch(c, p))
  })
}
