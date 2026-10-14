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
 * The handlers are plain functions over an injected registry and close function, so the
 * lifecycle is testable without electron; {@link registerTerminalIpc} only binds them.
 */
import { app, ipcMain, webContents, type WebContents } from 'electron'
import { closeTerminalPty } from './pty'
import { redispatchLiveTerminals, terminalStatus, type TerminalStatus } from './terminal-lifecycle'
import { terminalRegistry, type TerminalRegistry } from './terminal-registry'
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
  return { ...status, snapshot: await model.tombstoneText() }
}

const watched = new WeakSet<WebContents>()

/**
 * Reset on the two ways a renderer vanishes without saying so. The reload event is
 * `did-start-navigation` for the main frame, not same-document: `will-navigate` (the only
 * navigation hook `index.ts` has) does NOT fire on a reload. `terminal:xtermGone` from
 * `beforeunload` stays the primary path; this is the net under it.
 */
function watchRenderer(wc: WebContents): void {
  if (watched.has(wc) || wc.getType() !== 'window') return
  watched.add(wc)
  wc.on('render-process-gone', () => resetRendererAttached(terminalRegistry))
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) resetRendererAttached(terminalRegistry)
  })
}

/**
 * Bind the handlers. Call it AFTER `registerCommandBridge`: its `renderer:ready` listener is the
 * one that opens the dispatch gate, and ours must run once the gate is open.
 */
export function registerTerminalIpc(bridge: {
  dispatch: (command: string, payload: unknown) => Promise<unknown>
}): void {
  ipcMain.handle('terminal:status', (_e, terminalId: unknown) =>
    terminalStatusResolved(terminalRegistry, terminalId)
  )

  ipcMain.handle('terminal:close', (_e, terminalId: unknown): boolean =>
    typeof terminalId === 'string' ? closeTerminalPty(terminalId) : false
  )

  ipcMain.on('terminal:xtermGone', (_e, terminalId: unknown) => {
    if (typeof terminalId === 'string') terminalRegistry.setRendererAttached(terminalId, false)
  })

  for (const wc of webContents.getAllWebContents()) watchRenderer(wc)
  app.on('web-contents-created', (_e, wc) => watchRenderer(wc))

  ipcMain.on('renderer:ready', () => {
    void redispatchLiveTerminals(terminalRegistry, (c, p) => bridge.dispatch(c, p))
  })
}
