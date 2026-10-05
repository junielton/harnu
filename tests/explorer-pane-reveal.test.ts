// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import ExplorerPane from '../src/renderer/src/components/ExplorerPane.vue'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { i18n } from '@renderer/i18n'
import type { ExplorerListing } from '../src/preload'

/**
 * `revealPath` (option+click on a transcript path → Explorer pane) walks
 * `ancestorChain(root, target)` to expand every ancestor, then looks the
 * target up via `findEntry`, which needs the ROOT's own listing cached in
 * `childrenByDir`. For a target sitting directly in the root, the chain is
 * `[]` — nothing in the walk loop ever lists the root — so `findEntry` finds
 * nothing unless something ELSE already cached it (normally `onMounted`'s
 * `loadRoot()`). A reveal landing while that initial load is still in flight
 * must not be silently dropped.
 */

const ROOT = '/repo/alpha'
const TARGET = '/repo/alpha/README.md'
const PANE = { id: 'h-exp', type: 'explorer' as const, cwd: ROOT, ratio: 0, root: ROOT }

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
}

describe('ExplorerPane — revealPath lands when the root listing is not yet cached', () => {
  let resolveInitialLoad: ((listing: ExplorerListing) => void) | null = null
  let explorerListDir: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    resolveInitialLoad = null

    // First call (the pane's own `onMounted` → `loadRoot`) hangs until the
    // test resolves it — simulating a load still in flight. Every call after
    // that resolves immediately with the root's real listing, exactly like a
    // reveal's own `listDir(root)` retry would see.
    let callCount = 0
    explorerListDir = vi.fn(async (): Promise<ExplorerListing> => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<ExplorerListing>((resolve) => {
          resolveInitialLoad = resolve
        })
      }
      return { entries: [{ name: 'README.md', path: TARGET, isDir: false }] }
    })

    const api = { explorerListDir, markdownWrite: vi.fn() }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get(t: Record<string, unknown>, k: string) {
        return k in t ? t[k] : () => () => {}
      }
    })
  })

  it('still reveals a root-level target while the initial load is in flight', async () => {
    const helpers = useHelpersStore()
    const wrapper = mount(ExplorerPane, {
      props: { pane: { ...PANE }, worktreePath: ROOT },
      global: { plugins: [i18n] }
    })
    await settle()

    // The mount's own `loadRoot()` is still pending — `childrenByDir` has no
    // entry for the root yet. This is the race the fix closes.
    expect(explorerListDir).toHaveBeenCalledTimes(1)

    helpers.explorerRevealRequest = { paneId: PANE.id, path: TARGET, nonce: 1 }
    await settle()

    expect(wrapper.emitted('openFile')).toBeTruthy()
    expect(wrapper.emitted('openFile')?.[0]?.[0]).toMatchObject({ path: TARGET })

    // The retry must have re-listed the ROOT specifically (root, dir) — not
    // just "some" listing — since that is what makes `findEntry` see TARGET.
    expect(explorerListDir).toHaveBeenNthCalledWith(2, ROOT, ROOT)

    // Clean up the still-pending initial load so it doesn't leak into another test.
    resolveInitialLoad?.({ entries: [] })
    await settle()
  })
})
