import { ref, type Ref } from 'vue'

/**
 * Live-PTY registry (T25 wave 2) — extracted from the `sessions.ts` god-store as
 * a dependency-free composable. Tracks which session ids currently own a running
 * PTY; maintained by `TerminalPane` (register on PTY create/adopt, unregister on
 * dispose/pty exit) and read by the zone classifier + the context menu's
 * "Restart session" gate.
 *
 * The cleanest leaf of the decomposition: no `window.api`, no cross-cutting
 * readers, just a reassigned `Set` (so Vue tracks the change in zone computeds).
 * `reattachImage` stays in the store — it couples `selectedId` + the writer bus.
 */

/** The live-PTY registry surface {@link useLiveRegistry} returns. */
export interface LiveRegistry {
  /** Session ids that currently own a running PTY (reassigned on every mutation). */
  livePtySessionIds: Ref<Set<string>>
  /** Mark a session's PTY live (on create / adopt). Idempotent. */
  registerLiveSession: (id: string) => void
  /** Mark a session's PTY gone (on dispose / pty exit). Idempotent. */
  unregisterLiveSession: (id: string) => void
  /** Whether a session currently owns a running PTY (reactive). */
  isSessionLive: (id: string) => boolean
}

/** Build the live-PTY registry (dependency-free; owns its own Set). */
export function useLiveRegistry(): LiveRegistry {
  // Reassigned on every mutation so Vue picks up the change in the zone computeds.
  const livePtySessionIds = ref<Set<string>>(new Set())

  function registerLiveSession(id: string): void {
    if (livePtySessionIds.value.has(id)) return
    const next = new Set(livePtySessionIds.value)
    next.add(id)
    livePtySessionIds.value = next
  }

  function unregisterLiveSession(id: string): void {
    if (!livePtySessionIds.value.has(id)) return
    const next = new Set(livePtySessionIds.value)
    next.delete(id)
    livePtySessionIds.value = next
  }

  function isSessionLive(id: string): boolean {
    return livePtySessionIds.value.has(id)
  }

  return { livePtySessionIds, registerLiveSession, unregisterLiveSession, isSessionLive }
}
