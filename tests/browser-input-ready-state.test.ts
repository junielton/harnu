/**
 * T571 Delta 2 — the measured rule for when CDP mouse/key events reach a pane's document, replayed against every
 * experiment row of `browser/input-ready.ts` (E1–E10), so the rule and the table cannot drift apart.
 */
import { describe, it, expect } from 'vitest'
import {
  initialInputReadyState,
  nextInputReadyState,
  type InputReadyState
} from '../src/main/browser/input-ready'

type Commit = { host: string; harnu: boolean }
const run = (commits: Commit[]): InputReadyState =>
  commits.reduce(
    (s, c) => nextInputReadyState(s, { host: c.host, initiatedByHarnu: c.harnu }),
    initialInputReadyState()
  )
const L = 'localhost:8765'
const IP = '127.0.0.1:8765'

describe('input readiness replays the measured experiments', () => {
  it.each<[string, Commit[], boolean]>([
    ['E1 first document', [{ host: L, harnu: true }], false],
    [
      'E2 about:blank first, then Harnu navigates to the site',
      [
        { host: '', harnu: true },
        { host: L, harnu: true }
      ],
      false
    ],
    [
      'E3b cross-site second navigation',
      [
        { host: L, harnu: true },
        { host: IP, harnu: true }
      ],
      false
    ],
    [
      'E3c same-site second navigation (another path)',
      [
        { host: L, harnu: true },
        { host: L, harnu: true }
      ],
      true
    ],
    [
      'E4 first document replaced by a script on the same host',
      [
        { host: L, harnu: true },
        { host: L, harnu: false }
      ],
      false
    ],
    [
      'E7 first document, then Harnu navigates to the same URL',
      [
        { host: L, harnu: true },
        { host: L, harnu: true }
      ],
      true
    ],
    [
      'E8 cross-site 2nd navigation, then a reload',
      [
        { host: L, harnu: true },
        { host: IP, harnu: true },
        { host: IP, harnu: true }
      ],
      true
    ],
    [
      'E9 A → B → A',
      [
        { host: L, harnu: true },
        { host: IP, harnu: true },
        { host: L, harnu: true }
      ],
      false
    ],
    [
      'E10 about:blank → site, then a reload',
      [
        { host: '', harnu: true },
        { host: L, harnu: true },
        { host: L, harnu: true }
      ],
      true
    ]
  ])('%s → ready=%s', (_name, commits, ready) => {
    expect(run(commits).ready).toBe(ready)
  })

  it('a pane with no commit yet is not ready', () => {
    expect(initialInputReadyState()).toEqual({ ready: false, lastHost: null })
  })

  it('once ready, a navigation the page starts on the same host (a link, location.replace) keeps it ready', () => {
    const ready = run([
      { host: L, harnu: true },
      { host: L, harnu: true }
    ])
    expect(nextInputReadyState(ready, { host: L, initiatedByHarnu: false }).ready).toBe(true)
  })

  it('once ready, any move to another host makes it not ready until Harnu navigates there again', () => {
    const ready = run([
      { host: L, harnu: true },
      { host: L, harnu: true }
    ])
    const moved = nextInputReadyState(ready, { host: IP, initiatedByHarnu: false })
    expect(moved.ready).toBe(false)
    expect(nextInputReadyState(moved, { host: IP, initiatedByHarnu: true }).ready).toBe(true)
  })

  it('treats a different port as a different host, and an empty host never counts as the same one', () => {
    expect(
      run([
        { host: 'a.test:3000', harnu: true },
        { host: 'a.test:3001', harnu: true }
      ]).ready
    ).toBe(false)
    expect(
      run([
        { host: '', harnu: true },
        { host: '', harnu: true }
      ]).ready
    ).toBe(false)
  })
})
