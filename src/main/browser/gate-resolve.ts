/**
 * Resolving the plan-level gate state of a browser verb (T564 U1, spec §6.3), as a pure function of what the
 * shell read: the pane record, the live URL, the operator's Disconnect/Pause state and the kill-switch.
 * `browser-service.ts` reads those and calls this; the tests call it with fakes.
 */
import type { BrowserGateInput } from './access'
import { effectiveTouch } from '../../shared/browser-emulation'
import { classifyOrigin } from './origin-class'
import type { BrowserPaneRecord } from './registry'

export interface GateResolution {
  /** The pane's own folder (the gate anchor for the folder block), or `undefined` for an unknown pane. */
  folder: string | undefined
  input: BrowserGateInput
}

export function resolveGateInput(opts: {
  rec: BrowserPaneRecord | undefined
  /** The live top-frame URL; `''` before the first commit. */
  liveUrl: string
  writesEnabled: boolean
  disconnected: boolean
  paused: boolean
  /** The folder's browser-read opt-in (exact folder), the operator's lease on this pane and the Deny cooldown. */
  readOptIn?: boolean
  leaseActive?: boolean
  writeDenied?: boolean
  /** Mouse and key events reach the current document (`view-host.inputReady`). Absent = ready. */
  inputReady?: boolean
  harnuPorts: readonly number[]
  trustedHosts: readonly string[]
  /** The verb's own arguments, for the content refusals that come before the kill-switch. */
  args?: Record<string, unknown>
  /** `browser_open`: the agent panes the target folder already holds (the plan-level `PANE_LIMIT`). */
  agentPaneIds?: readonly string[]
}): GateResolution {
  const { rec, writesEnabled } = opts
  const args = {
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    ...(opts.agentPaneIds !== undefined ? { agentPaneIds: opts.agentPaneIds } : {})
  }
  const classify = { harnuPorts: opts.harnuPorts, extraTrustedHosts: opts.trustedHosts }
  if (!rec)
    return { folder: undefined, input: { pane: undefined, writesEnabled, classify, ...args } }
  return {
    folder: rec.folder,
    input: {
      writesEnabled,
      classify,
      pane: {
        openedBy: rec.openedBy,
        originClass: classifyOrigin(opts.liveUrl, classify),
        disconnected: opts.disconnected,
        paused: opts.paused,
        readOptIn: opts.readOptIn === true,
        leaseActive: opts.leaseActive === true,
        writeDenied: opts.writeDenied === true,
        inputReady: opts.inputReady !== false,
        deviceActive: rec.emulation?.device !== undefined,
        touchActive: effectiveTouch(rec.emulation),
        folder: rec.folder
      },
      ...args
    }
  }
}
