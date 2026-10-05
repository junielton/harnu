/**
 * Bidirectional index mapping a logical session key — the renderer's
 * `liveTerminals` key (a real session uuid for resumes, a `synthetic-<uuid>`
 * id for new/fork sessions) — to the ptyId of its live node-pty process.
 *
 * This is the main-process source of truth for the "1 session = 1 process"
 * invariant (I1/I5 in the 2026-06-01 session-lifecycle spec). `pty.ts`
 * consults it on `pty:create` to dedup duplicate `--resume` spawns; the
 * renderer drives `rekey` through the `pty:rekey` IPC when a synthetic session
 * migrates to its real uuid.
 *
 * Pure data structure — no node-pty / electron deps — so it is unit-testable
 * in isolation (vitest, node env).
 */
export class PtySessionIndex {
  private byKey = new Map<string, string>()
  private byPty = new Map<string, string>()

  /** ptyId for a live session key, or undefined if none is registered. */
  getPtyId(sessionKey: string): string | undefined {
    return this.byKey.get(sessionKey)
  }

  /** The logical session key currently bound to this ptyId, or undefined. */
  getSessionKey(ptyId: string): string | undefined {
    return this.byPty.get(ptyId)
  }

  /** Every live logical session key (for the MCP task-state liveness filter). */
  liveKeys(): ReadonlySet<string> {
    return new Set(this.byKey.keys())
  }

  has(sessionKey: string): boolean {
    return this.byKey.has(sessionKey)
  }

  /**
   * Bind sessionKey -> ptyId. If the key was already bound to a different
   * ptyId, drop the stale reverse entry first so `byPty` never points at a
   * replaced ptyId.
   */
  register(sessionKey: string, ptyId: string): void {
    const prev = this.byKey.get(sessionKey)
    if (prev && prev !== ptyId) this.byPty.delete(prev)
    this.byKey.set(sessionKey, ptyId)
    this.byPty.set(ptyId, sessionKey)
  }

  /**
   * Move the binding from one session key to another (synthetic -> real uuid)
   * without disturbing the ptyId. No-op when `fromKey` is not registered.
   */
  rekey(fromKey: string, toKey: string): void {
    const ptyId = this.byKey.get(fromKey)
    if (ptyId === undefined) return
    this.byKey.delete(fromKey)
    this.byKey.set(toKey, ptyId)
    this.byPty.set(ptyId, toKey)
  }

  /** Drop whatever session key (if any) is bound to this ptyId. */
  removeByPtyId(ptyId: string): void {
    const key = this.byPty.get(ptyId)
    if (key !== undefined) this.byKey.delete(key)
    this.byPty.delete(ptyId)
  }
}
