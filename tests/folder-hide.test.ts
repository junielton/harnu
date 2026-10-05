import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * Covers the dismiss/unhide state that backs the folder context-menu toggle
 * (`FolderMenu.vue`) and the dimmed "dismissed" marker (`SidebarFolder.vue`).
 * Both read `manuallyHiddenPaths` membership; `dismissedFolders` mirrors the
 * set against the current folders. A "dismiss" only hides (`userProjectsHide`)
 * — it does NOT unpin (BUG-39 fix; see `tests/sidebar-flat-list.test.ts` for
 * the pin → hide → unhide round-trip this fixed). `hidden` always wins at
 * render time regardless of `pinned` (`classifyFolder`'s branch order).
 */

function diskFolder(path: string, alias = path): FolderEntry {
  return { path, alias, sessions: [] }
}

describe('manual dismiss / unhide (folder model)', () => {
  let hidden: string[]
  let disk: FolderEntry[]

  beforeEach(() => {
    setActivePinia(createPinia())
    hidden = []
    disk = [diskFolder('/repos/alpha', 'alpha'), diskFolder('/repos/beta', 'beta')]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => disk),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [...hidden] })),
        orchestratorListArmed: vi.fn(async () => []),
        userProjectsAdd: vi.fn(async () => ({ projects: [], hiddenPaths: [...hidden] })),
        userProjectsRemove: vi.fn(async () => ({ projects: [], hiddenPaths: [...hidden] })),
        userProjectsHide: vi.fn(async (p: string) => {
          if (!hidden.includes(p)) hidden.push(p)
          return { projects: [], hiddenPaths: [...hidden] }
        }),
        userProjectsUnhide: vi.fn(async (p: string) => {
          hidden = hidden.filter((x) => x !== p)
          return { projects: [], hiddenPaths: [...hidden] }
        })
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('exposes manuallyHiddenPaths and toggles membership across dismiss/unhide', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(false)

    await store.dismissFolder('/repos/alpha')
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(true)

    await store.unhideFolder('/repos/alpha')
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(false)
  })

  it('dismissedFolders reflects dismiss/unhide round-trips', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    await store.dismissFolder('/repos/alpha')
    await store.reloadModel()
    expect(store.dismissedFolders.map((f) => f.path)).toEqual(['/repos/alpha'])

    await store.unhideFolder('/repos/alpha')
    await store.reloadModel()
    expect(store.dismissedFolders).toHaveLength(0)
  })

  it('pinning a dismissed folder clears it from hidden (pin surfaces a hidden folder)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    await store.dismissFolder('/repos/alpha')
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(true)

    // Pinning surfaces a hidden folder — not an invariant (pinned + hidden CAN
    // coexist, e.g. right after `dismissFolder`; see BUG-39), just this one
    // call site's explicit "pinning something you're hiding should show it".
    await store.pinFolder('/repos/alpha')
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(false)
  })

  it('dismissedFolders mirrors the hidden set against current folders', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    expect(store.dismissedFolders).toHaveLength(0)
    await store.dismissFolder('/repos/alpha')
    await store.reloadModel()
    expect(store.dismissedFolders.map((f) => f.alias)).toEqual(['alpha'])
  })
})
