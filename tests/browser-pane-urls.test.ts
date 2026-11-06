// The read-only list of addresses the open Harnu browser panes show (autonomous cleanup U3.5): a
// pane on a stack's port means someone is looking at it.

import { describe, expect, it } from 'vitest'
import { openPaneUrls } from '../src/main/browser/pane-urls'

describe('openPaneUrls', () => {
  const live = new Map([['p1', 'http://localhost:8080/']])

  it('lists the live address of a live pane and the remembered one of a discarded pane', () => {
    expect(
      openPaneUrls(
        [
          { paneId: 'p1', discarded: null },
          { paneId: 'p2', discarded: { url: 'http://127.0.0.1:3000/app' } }
        ],
        (id) => live.get(id)
      )
    ).toEqual(['http://localhost:8080/', 'http://127.0.0.1:3000/app'])
  })

  it('skips a pane that shows nothing yet', () => {
    expect(openPaneUrls([{ paneId: 'p9' }], () => undefined)).toEqual([])
    expect(openPaneUrls([{ paneId: 'p9' }], () => '')).toEqual([])
  })
})
