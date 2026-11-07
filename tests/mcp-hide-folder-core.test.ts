import { describe, it, expect } from 'vitest'
import { planHideFolder, summarizeHide, type HidePlanDeps } from '../src/main/mcp/hide-folder-core'

/**
 * T661 — the pure planner behind `hide_folder`: one outcome row per path, decided from plain
 * lookups so every branch is testable without electron or fs.
 */

const KNOWN = new Set(['/r/a', '/r/b', '/r/blocked', '/r/working', '/r/approval', '/r/hidden'])

function deps(over: Partial<HidePlanDeps> = {}): HidePlanDeps {
  return {
    hidden: new Set(['/r/hidden']),
    isKnown: (p) => KNOWN.has(p),
    isDenied: (p) => p === '/r/blocked',
    hasWorkingSession: (p) => p === '/r/working',
    hasPendingApproval: (p) => p === '/r/approval',
    ...over
  }
}

describe('planHideFolder', () => {
  it('outcomes: every outcome of a hide call, in input order', () => {
    const plan = planHideFolder(['/r/a', '/r/hidden', '/r/nope', '/r/blocked'], false, deps())
    expect(plan.rows).toEqual([
      { path: '/r/a', outcome: 'hidden' },
      { path: '/r/hidden', outcome: 'alreadyHidden' },
      { path: '/r/nope', outcome: 'notFound' },
      { path: '/r/blocked', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    expect(plan.toHide).toEqual(['/r/a'])
    expect(plan.toShow).toEqual([])
  })

  it('outcomes: every outcome of an unhide call', () => {
    const plan = planHideFolder(['/r/hidden', '/r/a', '/r/nope', '/r/blocked'], true, deps())
    expect(plan.rows).toEqual([
      { path: '/r/hidden', outcome: 'shown' },
      { path: '/r/a', outcome: 'alreadyVisible' },
      { path: '/r/nope', outcome: 'notFound' },
      { path: '/r/blocked', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    expect(plan.toHide).toEqual([])
    expect(plan.toShow).toEqual(['/r/hidden'])
  })

  it('refusals: a working session and a parked approval refuse a hide, never an unhide', () => {
    const hide = planHideFolder(['/r/working', '/r/approval'], false, deps())
    expect(hide.rows).toEqual([
      { path: '/r/working', outcome: 'refused', reason: 'SESSION_WORKING' },
      { path: '/r/approval', outcome: 'refused', reason: 'PENDING_APPROVAL' }
    ])
    expect(hide.toHide).toEqual([])

    const show = planHideFolder(['/r/working'], true, deps({ hidden: new Set(['/r/working']) }))
    expect(show.rows).toEqual([{ path: '/r/working', outcome: 'shown' }])
  })

  it('refusals: an already hidden folder with a busy session reads alreadyHidden (nothing changes)', () => {
    const plan = planHideFolder(['/r/working'], false, deps({ hidden: new Set(['/r/working']) }))
    expect(plan.rows).toEqual([{ path: '/r/working', outcome: 'alreadyHidden' }])
  })

  it('refusals: a blocked folder is refused first, even when it is unknown, busy or hidden', () => {
    const plan = planHideFolder(
      ['/r/blocked', '/r/blocked-unknown'],
      false,
      deps({
        isKnown: (p) => p === '/r/blocked',
        isDenied: (p) => p.startsWith('/r/blocked'),
        hasWorkingSession: () => true,
        hasPendingApproval: () => true
      })
    )
    expect(plan.rows).toEqual([
      { path: '/r/blocked', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' },
      { path: '/r/blocked-unknown', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    expect(plan.toHide).toEqual([])
  })

  it('refusals: a path Harnu does not know is notFound', () => {
    const plan = planHideFolder(['/r/nope'], false, deps())
    expect(plan.rows).toEqual([{ path: '/r/nope', outcome: 'notFound' }])
    const show = planHideFolder(['/r/nope'], true, deps())
    expect(show.rows).toEqual([{ path: '/r/nope', outcome: 'notFound' }])
  })

  it('a path that is already hidden counts as known even with no other record of it', () => {
    const plan = planHideFolder(['/r/ghost'], true, deps({ hidden: new Set(['/r/ghost']) }))
    expect(plan.rows).toEqual([{ path: '/r/ghost', outcome: 'shown' }])
  })

  it('a repeated path yields one row', () => {
    const plan = planHideFolder(['/r/a', '/r/a'], false, deps())
    expect(plan.rows).toEqual([{ path: '/r/a', outcome: 'hidden' }])
    expect(plan.toHide).toEqual(['/r/a'])
  })
})

describe('summarizeHide', () => {
  it('names the direction and the counts, never a path', () => {
    const plan = planHideFolder(['/r/a', '/r/b', '/r/nope'], false, deps())
    expect(summarizeHide(false, plan.rows)).toBe('hide 2 hidden, 1 notFound')
    expect(summarizeHide(true, plan.rows)).toMatch(/^unhide /)
    expect(summarizeHide(false, plan.rows)).not.toContain('/r/')
  })
})
