/**
 * `window.api` for the containers tests, with Electron's boundary in front of
 * it (BUG-141).
 *
 * Every `window.api.containers*` call is an `ipcRenderer.invoke`, so its
 * arguments are **structured-cloned** on the way to main. A bare `vi.fn()` is
 * not: it takes the object by reference, so a Vue reactive Proxy — or a
 * function, or a DOM node — passes a green test and then fails in the real app
 * with "An object could not be cloned". The first real clean-up sweep died
 * exactly that way, on code every test said was fine.
 *
 * So the mock clones what it is handed, the way Electron does, and passes the
 * CLONE down to the underlying stub. An uncloneable payload now throws in the
 * test at the same place it throws in the app.
 *
 * `on*` subscriptions are deliberately left unguarded: a preload listener is
 * registered inside the renderer and its callback crosses nothing.
 */

/** One call that went through the guarded api. */
export interface SentCall {
  /** The api method the renderer called, e.g. `containersAct`. */
  channel: string
  /** The arguments exactly as the caller built them — captured BEFORE the clone. */
  args: unknown[]
}

let sent: SentCall[] = []

/**
 * Every containers invoke made since the last {@link cloneGuardedApi}, with the
 * arguments as the caller built them. A test that wants to assert *sendability*
 * has to read the payload from here: what the stub itself received is already a
 * clone, so structured-cloning that again would prove nothing.
 */
export function sentThroughIpc(): SentCall[] {
  return sent
}

function cloneForIpc(channel: string, arg: unknown): unknown {
  try {
    return structuredClone(arg)
  } catch (err) {
    throw new TypeError(
      `window.api.${channel}: an argument could not be cloned, so Electron's IPC ` +
        `would reject it before it reached main (a Vue reactive Proxy, a function, ` +
        `a DOM node…). Send plain data. Cause: ${String(err)}`
    )
  }
}

/**
 * Wrap a `window.api` stub so the containers invokes cross the same boundary
 * they cross in Electron. Also answers an unknown key with a no-op
 * unsubscriber, which is what the containers components expect of the api
 * surfaces they touch but these tests do not stub.
 */
export function cloneGuardedApi<T extends object>(api: T): T {
  sent = []
  return new Proxy(api as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key)
      const value = key in target ? target[key] : undefined
      if (value === undefined) return () => () => {}
      if (typeof value !== 'function' || !key.startsWith('containers')) return value
      const fn = value as (...a: unknown[]) => unknown
      return (...args: unknown[]) => {
        sent.push({ channel: key, args })
        return fn(...args.map((a) => cloneForIpc(key, a)))
      }
    }
  }) as T
}
