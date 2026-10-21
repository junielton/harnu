/**
 * T568 (browser pane U1, AC-5) — the guest webPreferences match spec §3.1 and the partition is fixed per class.
 */
import { describe, it, expect } from 'vitest'
import { guestWebPreferences, PARTITION_NAMES } from '../src/main/browser/guest-prefs'

describe('guestWebPreferences', () => {
  const prefs = guestWebPreferences('operator', '/app/out/preload/browser-guest.js')

  it('hardens the guest per the §3.1 table', () => {
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      autoplayPolicy: 'document-user-activation-required',
      backgroundThrottling: true,
      spellcheck: false,
      enableWebSQL: false,
      disableDialogs: false
    })
  })

  it('loads the guest preload, never the app preload', () => {
    expect(prefs.preload).toBe('/app/out/preload/browser-guest.js')
    expect(prefs.preload.endsWith('/index.js')).toBe(false)
  })

  it('uses persist:harnu-browser for operator panes and persist:harnu-browser-agent for agent panes', () => {
    expect(PARTITION_NAMES).toEqual({
      operator: 'persist:harnu-browser',
      agent: 'persist:harnu-browser-agent'
    })
    expect(guestWebPreferences('operator', '/p').partition).toBe('persist:harnu-browser')
    expect(guestWebPreferences('agent', '/p').partition).toBe('persist:harnu-browser-agent')
  })

  it('sets no key that would give the guest the app API', () => {
    const keys = Object.keys(prefs)
    for (const forbidden of [
      'nodeIntegrationInWorker',
      'additionalArguments',
      'enableRemoteModule'
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
