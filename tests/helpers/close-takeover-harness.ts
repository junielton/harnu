import { defineComponent, h, type PropType } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { useShortcuts, type ShortcutBinding } from '../../src/renderer/src/composables/useShortcuts'
import { closeTakeoverBinding, installKeyOrigin } from '../../src/renderer/src/lib/takeover-esc'
import { useUiStore } from '../../src/renderer/src/stores/ui'

/** Registers `bindings` for as long as it is mounted, as `App.vue` does. */
const Shortcuts = defineComponent({
  props: { bindings: { type: Array as PropType<ShortcutBinding[]>, required: true } },
  setup(props) {
    useShortcuts(props.bindings)
    return () => h('div')
  }
})

let primed = false

/**
 * `useShortcuts` creates ONE `useMagicKeys` instance, inside the effect scope of
 * the first component that installs it, and its window listeners die with that
 * scope. In the app that component is `App.vue`, which never unmounts; here a
 * primer that is never unmounted plays that part, so each test's harness can
 * mount and unmount freely.
 */
function primeMagicKeys(): void {
  if (primed) return
  primed = true
  mount(Shortcuts, { props: { bindings: [] } })
}

/**
 * T486 §6.1 — `App.vue`'s `view.closeTakeover` registration on its own, wired
 * through the REAL `useShortcuts` and `useMagicKeys` (a window bubble
 * listener), with the same `closeTakeoverBinding` parts and the same key-origin
 * recorder the app installs. Mount it before the component under test, as
 * `App.vue` registers before its children do.
 */
export function mountCloseTakeover(): { unmount: () => void } {
  primeMagicKeys()
  const stopOrigin = installKeyOrigin()
  const harness = mount(Shortcuts, {
    props: {
      bindings: [
        {
          id: 'view.closeTakeover',
          scope: 'global',
          keys: 'Escape',
          ...closeTakeoverBinding(useUiStore())
        }
      ]
    }
  })
  return {
    unmount: () => {
      harness.unmount()
      stopOrigin()
    }
  }
}

/**
 * One real Esc press on `target` (the focused element by default): a bubbling
 * keydown, then the keyup that re-arms `useMagicKeys`' rising edge.
 */
export async function pressEsc(target?: EventTarget): Promise<void> {
  const at = target ?? document.activeElement ?? document.body
  at.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await flushPromises()
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
  await flushPromises()
}
