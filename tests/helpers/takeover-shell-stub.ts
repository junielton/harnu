import { DOMWrapper } from '@vue/test-utils'

/**
 * T300/U3: a takeover view (`ReviewPane`, `PrStackCanvas`, …) now renders its
 * icon and view-specific header content via `<Teleport>` into the two
 * landing zones `TakeoverShell.vue` owns — `#takeover-shell-icon` /
 * `#takeover-shell-actions`. A test that mounts the view standalone (without
 * `TakeoverHost`/`TakeoverShell` around it) leaves those Teleports with
 * nowhere to land: the content silently never renders, and Vue throws on a
 * later patch against a target it can never resolve. Call this before
 * `mount()` so the two targets exist in `document.body`.
 */
export function stubTakeoverShellTargets(): void {
  document.body.innerHTML =
    '<div id="takeover-shell-icon"></div><div id="takeover-shell-actions"></div>'
}

/**
 * A `find`/`get`/`trigger`-capable wrapper scoped to the Teleported actions
 * region — that content is no longer inside the mounted view's own subtree,
 * so `wrapper.get(...)` can't see it; query from here instead.
 */
export function takeoverShellActions(): DOMWrapper<Element> {
  return new DOMWrapper(document.body).get('#takeover-shell-actions')
}
