/**
 * The guest `webPreferences` of a browser pane (T564 U1, spec §3.1) and its partition names (§3.4). Distinct
 * from `createWindow`'s prefs in `src/main/index.ts`: the guest is untrusted code and must never reach Node,
 * the app preload, the renderer's session or another partition's data.
 */

/** Which of the two guest partitions a pane uses; fixed at creation and never changes (spec §3.4, Q1). */
export type BrowserPartition = 'operator' | 'agent'

export const PARTITION_NAMES: Record<BrowserPartition, string> = {
  operator: 'persist:harnu-browser',
  agent: 'persist:harnu-browser-agent'
}

export interface GuestWebPreferences {
  partition: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  nodeIntegrationInSubFrames: false
  webSecurity: true
  allowRunningInsecureContent: false
  webviewTag: false
  preload: string
  autoplayPolicy: 'document-user-activation-required'
  backgroundThrottling: true
  spellcheck: false
  enableWebSQL: false
  disableDialogs: true
}

/**
 * The §3.1 table as one object, with ONE measured deviation: `disableDialogs` is `true` (spec §3.1 said `false`
 * and "intercept"). In the U1 live run a page's `alert()` with `false` plus a CDP `handleJavaScriptDialog`
 * released the page's script but left Electron's own native dialog window up, modal over the app, until someone
 * clicked it. A hostile page must not be able to do that, so dialogs are switched off in the guest; the pane
 * still raises its "dialog dismissed" notice (`view-host.ts`).
 *
 * `preloadPath` is the absolute path of `out/preload/browser-guest.js`.
 */
export function guestWebPreferences(
  partition: BrowserPartition,
  preloadPath: string
): GuestWebPreferences {
  return {
    partition: PARTITION_NAMES[partition],
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    preload: preloadPath,
    autoplayPolicy: 'document-user-activation-required',
    backgroundThrottling: true,
    spellcheck: false,
    enableWebSQL: false,
    disableDialogs: true
  }
}
