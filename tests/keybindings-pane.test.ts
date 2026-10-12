// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { parseKeybindingsFile } from '../src/main/keybindings-core'

/**
 * T1 P4 — the Settings pane's persistence seam. The pane itself is thin; the
 * logic worth pinning is the store's `setBinding` / `resetBinding` / `resetAll`:
 * each rebuilds the override set from the current resolved table, serializes it
 * back to a `keybindings.json` body, optimistically re-resolves, and hands the
 * body to `keybindings:save`. These assertions read BOTH the optimistic
 * `resolved` and the serialized body (round-tripped through `parseKeybindingsFile`
 * so a format regression can't pass).
 */

let saved: string[]

beforeEach(() => {
  setActivePinia(createPinia())
  saved = []
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: {
        keybindingsSave: vi.fn(async (body: string) => {
          saved.push(body)
        })
      }
    })
  )
})

/** The last body handed to `keybindings:save`, re-resolved. */
function lastSavedResolved() {
  return parseKeybindingsFile(saved[saved.length - 1])
}

describe('setBinding', () => {
  it('writes one override and applies it optimistically', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('app.search', 'Cmd+Shift+K')

    expect(store.resolved.byId['app.search'].keys).toBe('Cmd+Shift+K')
    expect(store.resolved.byId['app.search'].source).toBe('override')
    expect(lastSavedResolved().byId['app.search'].keys).toBe('Cmd+Shift+K')
  })

  it('preserves earlier overrides when a second row is rebound', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('app.search', 'Cmd+Shift+K')
    await store.setBinding('session.new', 'Cmd+Shift+N')

    const r = lastSavedResolved()
    expect(r.byId['app.search'].keys).toBe('Cmd+Shift+K')
    expect(r.byId['session.new'].keys).toBe('Cmd+Shift+N')
    expect(store.resolved.byId['session.new'].source).toBe('override')
  })

  it('unbinds a default when passed null', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('session.close', null)

    expect(store.resolved.byId['session.close'].keys).toBeNull()
    expect(store.resolved.byId['session.close'].source).toBe('unbound')
    expect(lastSavedResolved().byId['session.close'].source).toBe('unbound')
  })
})

describe('an action with no default chord', () => {
  it('starts with no chord, takes one, and resets back to none', async () => {
    const store = useKeybindingsStore()

    expect(store.resolved.byId['view.roadmap']?.keys).toBeNull()
    expect(store.resolved.byId['view.roadmap']?.source).toBe('default')

    await store.setBinding('view.roadmap', 'Cmd+Shift+M')
    expect(store.resolved.byId['view.roadmap']?.keys).toBe('Cmd+Shift+M')
    expect(lastSavedResolved().byId['view.roadmap']?.source).toBe('override')

    await store.resetBinding('view.roadmap')
    expect(store.resolved.byId['view.roadmap']?.keys).toBeNull()
    expect(store.resolved.byId['view.roadmap']?.source).toBe('default')
  })
})

describe('resetBinding', () => {
  it('drops one override and leaves the rest', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('app.search', 'Cmd+Shift+K')
    await store.setBinding('session.new', 'Cmd+Shift+N')
    await store.resetBinding('app.search')

    expect(store.resolved.byId['app.search'].source).toBe('default')
    expect(store.resolved.byId['app.search'].keys).toBe('Cmd+K')
    expect(store.resolved.byId['session.new'].keys).toBe('Cmd+Shift+N')
    expect(lastSavedResolved().byId['session.new'].keys).toBe('Cmd+Shift+N')
  })
})

describe('resetAll', () => {
  it('clears every override — the body is an empty array', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('app.search', 'Cmd+Shift+K')
    await store.setBinding('session.close', null)
    await store.resetAll()

    expect(store.resolved.list.every((b) => b.source === 'default')).toBe(true)
    expect(lastSavedResolved().list.every((b) => b.source === 'default')).toBe(true)
    expect(saved[saved.length - 1]).toContain('[]')
  })
})

describe('conflict detection surfaces through the optimistic resolve', () => {
  it('flags both participants when a rebind collides with a default', async () => {
    const store = useKeybindingsStore()

    // `view.review` defaults to Cmd+Shift+D; bind the Fleet rail onto it.
    await store.setBinding('view.fleetRail', 'Cmd+Shift+D')

    expect(store.resolved.byId['view.fleetRail'].conflictsWith).toContain('view.review')
    expect(store.resolved.byId['view.review'].conflictsWith).toContain('view.fleetRail')
  })
})

describe('a rejected bind never reaches disk', () => {
  it('binding onto a reserved chord leaves the file + table on the accepted set only', async () => {
    const store = useKeybindingsStore()

    await store.setBinding('app.search', 'Cmd+Shift+K') // accepted
    await store.setBinding('session.new', 'Cmd+Q') // reserved chord → rejected

    // Optimistic table: the rejected row stayed at its default, the good one held.
    expect(store.resolved.byId['session.new'].source).toBe('default')
    expect(store.resolved.byId['app.search'].keys).toBe('Cmd+Shift+K')

    // And the persisted body carries only the accepted override — no dead entry
    // to re-trigger the "some shortcuts were ignored" toast on every reconcile.
    const r = lastSavedResolved()
    expect(r.byId['session.new'].source).toBe('default')
    expect(r.byId['app.search'].keys).toBe('Cmd+Shift+K')
    expect(saved[saved.length - 1]).not.toContain('Cmd+Q')
  })
})
