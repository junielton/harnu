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
import { ipcMain } from 'electron'
import { closeTerminalPty } from './pty'
import { redispatchLiveTerminals, terminalStatus } from './terminal-lifecycle'
import { terminalRegistry } from './terminal-registry'

/**
 * Bind the handlers. Call it AFTER `registerCommandBridge`: its `renderer:ready` listener is the
 * one that opens the dispatch gate, and ours must run once the gate is open.
 */
export function registerTerminalIpc(bridge: {
  dispatch: (command: string, payload: unknown) => Promise<unknown>
}): void {
  ipcMain.handle('terminal:status', (_e, terminalId: unknown) =>
    terminalStatus(terminalRegistry, terminalId)
  )

  ipcMain.handle('terminal:close', (_e, terminalId: unknown): boolean =>
    typeof terminalId === 'string' ? closeTerminalPty(terminalId) : false
  )

  ipcMain.on('terminal:xtermGone', (_e, terminalId: unknown) => {
    if (typeof terminalId === 'string') terminalRegistry.setRendererAttached(terminalId, false)
  })

  ipcMain.on('renderer:ready', () => {
    void redispatchLiveTerminals(terminalRegistry, (c, p) => bridge.dispatch(c, p))
  })
}
