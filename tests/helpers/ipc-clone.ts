import { vi } from 'vitest'

/**
 * A `vi.fn` that crosses the same boundary an Electron `ipcRenderer.invoke` does: every argument
 * is **structured-cloned** before the stub sees it. A Vue reactive Proxy (or a function, or a DOM
 * node) throws `DataCloneError` here exactly as it does in the app ("An object could not be
 * cloned"), instead of passing because a bare `vi.fn()` takes the object by reference.
 *
 * The clone happens in front of the spy, so a payload that cannot be cloned never reaches it
 * (`not.toHaveBeenCalled()`, as with main) and `mock.calls` holds what main would receive.
 */
export function ipcFn<A extends unknown[], R>(impl: (...args: A) => R) {
  const spy = vi.fn(impl)
  return new Proxy(spy, {
    apply: (target, thisArg, args: A) =>
      Reflect.apply(
        target,
        thisArg,
        args.map((a) => structuredClone(a))
      )
  })
}
