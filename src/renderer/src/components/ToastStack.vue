<script setup lang="ts">
import { useUiStore } from '../stores/ui'
import Toast from './Toast.vue'

/**
 * Bottom-right toast pile. Reads `useUiStore().toasts` and renders one
 * `<Toast>` per entry. The component is intentionally *not* teleported —
 * App.vue mounts `<ToastStack>` *inside* its existing `<Teleport to="body">`
 * block alongside `SessionPreview` / `SessionMenu` / `AddFolderDialog` /
 * `CommandPalette`, so the stack escapes any ancestor stacking context
 * exactly the same way the other floating surfaces do.
 *
 * Z-order: 80 — above the command palette (70). Toasts are non-modal but
 * should never be obscured by the palette overlay while they're still
 * counting down to auto-dismiss; if the user opens ⌘K the toast still
 * peeks out the bottom-right.
 *
 * Stack direction: `flex-direction: column-reverse`. The store appends new
 * toasts to the end of `toasts` (oldest first in DOM order), so reversing
 * the visual axis means the NEWEST toast renders at the BOTTOM of the
 * column — closest to the cursor in the bottom-right corner, matching
 * Linear / Raycast / macOS notification stacking. Screen-reader order is
 * still oldest→newest (DOM order) thanks to `aria-live="polite"` on the
 * region wrapper.
 *
 * Per-toast animation comes from `.anim-fade-in` on the Toast component
 * itself — see `main.css` keyframes (no new motion tokens introduced).
 */
const ui = useUiStore()

/**
 * Handle an action click bubbled up from a Toast. Looks the toast up by id,
 * invokes its `action.handler` (await if it's a promise — but don't block
 * the dismiss on a rejection), then dismisses. If the toast or action has
 * already been removed (race), silently no-ops.
 */
async function onAction(id: string): Promise<void> {
  const target = ui.toasts.find((t) => t.id === id)
  if (!target?.action) {
    ui.dismissToast(id)
    return
  }
  try {
    await target.action.handler()
  } catch {
    // The action handler is the caller's responsibility — failures are
    // intentionally swallowed here so a broken handler can't trap the
    // toast on screen forever. Callers wanting error reporting should
    // push a follow-up toast.
  }
  ui.dismissToast(id)
}
</script>

<template>
  <div
    v-if="ui.toasts.length > 0"
    style="
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 80;
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
    "
    role="region"
    aria-live="polite"
  >
    <Toast
      v-for="t in ui.toasts"
      :key="t.id"
      :toast="t"
      @dismiss="ui.dismissToast"
      @action="onAction"
    />
  </div>
</template>
