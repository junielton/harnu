// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

/**
 * "Browse files" (Topbar / Folder View) is a find-me-a-file gesture, so the
 * Explorer pane's search field must take focus when the pane opens. The pane
 * itself does the focusing; the store carries the REQUEST, and these are the
 * two properties `ExplorerPane` depends on:
 *
 *  1. a fresh open records the new pane's id (the pane reads it on mount);
 *  2. a RE-open dedups to the already-mounted pane — no second mount, so the
 *     request ref re-firing is the only thing that carries the gesture through.
 *
 * The request lives outside the persisted pane shape on purpose: a boot restore
 * re-mounts an Explorer pane with no request pending and never steals focus
 * from the terminal.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('explorer focus request', () => {
  it('records the new pane id when the explorer opens', () => {
    const helpers = useHelpersStore()
    const id = helpers.addExplorerHelper('/repo/a', '/repo/a')
    expect(helpers.explorerFocusRequest).toBe(id)
  })

  it('re-requests focus on the SAME pane when "Browse files" is clicked again', () => {
    const helpers = useHelpersStore()
    const id = helpers.addExplorerHelper('/repo/a', '/repo/a')
    helpers.consumeExplorerFocus(id)
    expect(helpers.explorerFocusRequest).toBeNull()

    // Dedup by root: one explorer pane per root, so this returns the same id.
    const again = helpers.addExplorerHelper('/repo/a', '/repo/a')
    expect(again).toBe(id)
    expect(helpers.explorerFocusRequest).toBe(id)
  })

  it('consuming another pane id leaves a pending request alone', () => {
    const helpers = useHelpersStore()
    const id = helpers.addExplorerHelper('/repo/a', '/repo/a')
    helpers.consumeExplorerFocus('h-someone-else')
    expect(helpers.explorerFocusRequest).toBe(id)
  })

  it('starts with no pending request (a boot restore never steals focus)', () => {
    const helpers = useHelpersStore()
    expect(helpers.explorerFocusRequest).toBeNull()
  })
})
