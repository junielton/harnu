// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

/**
 * Option+clicking a path in a transcript opens (or reuses) the Explorer pane
 * and asks it to reveal that path. The store carries the REQUEST; the pane does
 * the expanding. Mirrors the `explorerFocusRequest` seam, with two differences
 * that matter:
 *
 *  1. a reveal must NOT steal focus into the search field the way "Browse
 *     files" does — the whole point is to look at the tree;
 *  2. revealing the SAME path twice must re-fire, so the request carries a
 *     nonce instead of relying on a value change.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('explorer reveal request', () => {
  it('opens an explorer pane and records the path', () => {
    const helpers = useHelpersStore()
    const id = helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/src/main/pty.ts')
    expect(helpers.explorerRevealRequest).toMatchObject({
      paneId: id,
      path: '/repo/a/src/main/pty.ts'
    })
  })

  it('reuses the already-open explorer pane for that root', () => {
    const helpers = useHelpersStore()
    const first = helpers.addExplorerHelper('/repo/a', '/repo/a')
    const id = helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/README.md')
    expect(id).toBe(first)
  })

  it('does not steal focus into the search field', () => {
    const helpers = useHelpersStore()
    helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/README.md')
    expect(helpers.explorerFocusRequest).toBeNull()
  })

  it('re-fires when the same path is revealed twice', () => {
    const helpers = useHelpersStore()
    const id = helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/README.md')
    const first = helpers.explorerRevealRequest?.nonce
    helpers.consumeExplorerReveal(id)
    expect(helpers.explorerRevealRequest).toBeNull()

    helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/README.md')
    expect(helpers.explorerRevealRequest?.nonce).not.toBe(first)
  })

  it('consuming another pane id leaves a pending request alone', () => {
    const helpers = useHelpersStore()
    helpers.revealInExplorer('/repo/a', '/repo/a', '/repo/a/README.md')
    helpers.consumeExplorerReveal('h-someone-else')
    expect(helpers.explorerRevealRequest).not.toBeNull()
  })

  it('starts with no pending request', () => {
    const helpers = useHelpersStore()
    expect(helpers.explorerRevealRequest).toBeNull()
  })
})
