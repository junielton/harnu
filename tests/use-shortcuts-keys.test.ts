import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'

/**
 * The two renderer-watcher behaviors added to `useShortcuts` in the T1 review
 * (PR #337), both driven off a mocked `useMagicKeys`:
 *
 *  1. A `-`-keyed chord (`Cmd+-`) is watched via the layout-stable `e.code`
 *     name `minus`, not the string proxy (`keys['Cmd+-']` is permanently
 *     `false`) and not `keys['-']` (which flips to `_` under Shift). Without
 *     this the binding is silently dead.
 *  2. Off macOS a hand-edited `Ctrl+B` and the default `Cmd+B` fold to ONE
 *     scope+chord claim, so only the first-registered binding gets a watcher
 *     and one physical press dispatches once, not twice.
 *
 * `isMac` is forced false so the fold is exercised. The mock's proxy folds
 * `cmd`/`ctrl`/`mod` onto `control` the same way our `ALIAS_MAP` does, so a
 * `Cmd+B` combo and a `Ctrl+B` combo resolve to the same ref.
 */

vi.mock('vue', async (orig) => ({
  ...(await orig<typeof import('vue')>()),
  // No component instance in a plain test — silence the lifecycle warning.
  onBeforeUnmount: () => {}
}))

vi.mock('../src/renderer/src/lib/platform', () => ({
  isMac: false,
  macWindowControlsInset: 0
}))

const MOD_ALIAS: Record<string, string> = {
  cmd: 'control',
  ctrl: 'control',
  mod: 'control',
  command: 'meta',
  option: 'alt'
}

/** Canonical ref name: fold modifier aliases, sort tokens — `Cmd+B` === `Ctrl+B`. */
function canon(name: string): string {
  return name
    .toLowerCase()
    .split('+')
    .map((t) => MOD_ALIAS[t] ?? t)
    .sort()
    .join('+')
}

const keyRefs = new Map<string, Ref<boolean>>()
function magicRef(name: string): Ref<boolean> {
  const k = canon(name)
  let r = keyRefs.get(k)
  if (!r) {
    r = ref(false)
    keyRefs.set(k, r)
  }
  return r
}

vi.mock('@vueuse/core', () => ({
  useMagicKeys: () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'current') return new Set<string>()
          return magicRef(String(prop))
        }
      }
    )
}))

import { useShortcuts, resetScopesForTests } from '../src/renderer/src/composables/useShortcuts'

/**
 * Hold `combo` (a canonical chord) + its modifiers down, let watchers flush,
 * release. A `-` primary key also toggles the `minus` code-name ref, the way
 * pressing the physical Minus key drives `setRefs('minus', ...)` in vueuse.
 */
async function press(combo: string): Promise<void> {
  const mods = combo
    .toLowerCase()
    .split('+')
    .map((t) => MOD_ALIAS[t])
    .filter(Boolean) as string[]
  const hostile = /(?:^|\+)-$/.test(combo)
  for (const m of mods) magicRef(m).value = true
  magicRef(combo).value = true
  if (hostile) magicRef('minus').value = true
  await nextTick()
  await nextTick()
  magicRef(combo).value = false
  if (hostile) magicRef('minus').value = false
  for (const m of mods) magicRef(m).value = false
  await nextTick()
}

beforeEach(() => {
  resetScopesForTests()
  for (const r of keyRefs.values()) r.value = false
})

describe('useShortcuts renderer watchers (T1 review, PR #337)', () => {
  it('dispatches a `-`-keyed chord (Cmd+-) via the `minus` code name', async () => {
    const zoom = vi.fn()
    useShortcuts([{ id: 'view.zoomReset.t1', scope: 'global', keys: 'Cmd+-', handler: zoom }])

    // `minus` alone, no Cmd — modifier mismatch, must not fire.
    magicRef('minus').value = true
    await nextTick()
    magicRef('minus').value = false
    await nextTick()
    expect(zoom).not.toHaveBeenCalled()

    await press('Cmd+-')
    expect(zoom).toHaveBeenCalledTimes(1)
  })

  it('folds Ctrl+B onto Cmd+B off macOS — one watcher, one dispatch', async () => {
    const sidebar = vi.fn()
    const inbox = vi.fn()
    useShortcuts([
      { id: 'view.toggleSidebar.t1', scope: 'global', keys: 'Cmd+B', handler: sidebar },
      // Hand-edited onto the same physical chord. First-registered wins.
      { id: 'inbox.toggle.t1', scope: 'global', keys: 'Ctrl+B', handler: inbox }
    ])

    await press('Cmd+B')
    expect(sidebar).toHaveBeenCalledTimes(1)
    expect(inbox).not.toHaveBeenCalled()
  })
})
