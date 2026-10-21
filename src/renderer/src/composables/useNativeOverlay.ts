import { onBeforeUnmount, watch, type Ref } from 'vue'
import { registerOverlayElement } from '../lib/native-overlay'

/**
 * Register an in-app layer with the native-overlay freeze (T564 U1, spec §2.4): while `el` is mounted its
 * rectangle counts as an overlay, so a browser pane under it freezes instead of drawing over it. Layers
 * teleported to `<body>` are covered automatically (`lib/native-overlay.ts`); this is for the ones that
 * live inside `#app`, such as a dropdown anchored in the Topbar.
 */
export function useNativeOverlay(id: string, el: Ref<HTMLElement | null>): void {
  let unregister: (() => void) | null = null
  const stop = watch(
    el,
    (node) => {
      unregister?.()
      unregister = node ? registerOverlayElement(id, node) : null
    },
    { immediate: true, flush: 'post' }
  )
  onBeforeUnmount(() => {
    stop()
    unregister?.()
  })
}
