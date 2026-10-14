/**
 * Terminal write leases and deny cooldowns (T474 unit B6, spec §6.3).
 *
 * Typing into a terminal the operator opened (or any terminal, in `ask` mode) needs the
 * operator's confirm. An Allow does not type the call that asked: it grants a LEASE on that one
 * terminal, and the agent sends again. While the lease is active every later send to that
 * terminal runs without a prompt. A Deny starts a cooldown during which sends are refused
 * outright, so an agent cannot badger the operator with a new prompt per call.
 *
 * A lease ends at whichever comes first: {@link LEASE_IDLE_MS} after the last write, terminal
 * exit, Disconnect, the folder being blocked, the control server stopping or app quit. The
 * registry-state endings (exit, Disconnect) are re-checked by the shell when it resolves the gate
 * state; the block and quit endings are explicit calls into this table.
 *
 * Pure (ADR-0001): no electron, no fs, the clock is injected. Memory only — a lease never
 * survives the process.
 */
import * as path from 'node:path'

/** A lease ends this long after the last write (spec §6.3). */
export const LEASE_IDLE_MS = 10 * 60_000

/** A Deny refuses further sends to the terminal for this long (spec §6.3). */
export const DENY_COOLDOWN_MS = 5 * 60_000

interface Lease {
  /** The terminal's folder, so a block of that folder can end the lease. */
  folder: string
  /**
   * The PTY the operator approved. A lease counts only while the terminal id still names THAT
   * process: a pane restored under the same id is a new shell the operator never saw.
   */
  ptyId: string
  /** Epoch ms of the grant or of the last write, whichever is later. */
  lastWriteAt: number
}

/** Whether `target` is `root` itself or lies under it. */
function within(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

export class TerminalLeases {
  private readonly leases = new Map<string, Lease>()
  private readonly denied = new Map<string, number>()
  private readonly listeners = new Set<(terminalId: string) => void>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Call `cb` with the terminal id whenever a lease is granted or ends (revoke, folder block,
   * kill-switch, Deny, a stale or idled-out lease dropped on a check). The pane chip re-reads its
   * state on it. Display only: a throwing listener never changes what the table decides.
   */
  onChange(cb: (terminalId: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(terminalId: string): void {
    for (const cb of this.listeners) {
      try {
        cb(terminalId)
      } catch {
        // A display listener must never fail the gate.
      }
    }
  }

  /** Start (or restart) the lease on `terminalId`, bound to the PTY `ptyId` that runs it now. */
  grant(terminalId: string, folder: string, ptyId: string): void {
    this.leases.set(terminalId, { folder, ptyId, lastWriteAt: this.now() })
    // An Allow overrides an earlier Deny: the operator changed their mind.
    this.denied.delete(terminalId)
    this.changed(terminalId)
  }

  /**
   * Whether `terminalId` holds a lease that has not idled out and was granted for the PTY
   * `ptyId` that runs it now. Drops an expired or stale one.
   */
  isActive(terminalId: string, ptyId: string): boolean {
    const lease = this.leases.get(terminalId)
    if (!lease) return false
    if (lease.ptyId !== ptyId || this.now() - lease.lastWriteAt >= LEASE_IDLE_MS) {
      this.leases.delete(terminalId)
      this.changed(terminalId)
      return false
    }
    return true
  }

  /** A write went out under the lease: the 10 minutes start over. No lease, no effect. */
  noteWrite(terminalId: string): void {
    const lease = this.leases.get(terminalId)
    if (lease) lease.lastWriteAt = this.now()
  }

  /** End the lease on one terminal (exit, Disconnect). */
  revoke(terminalId: string): void {
    if (this.leases.delete(terminalId)) this.changed(terminalId)
  }

  /** End every lease on a terminal in `folder` or below it (the folder was blocked). */
  revokeUnder(folder: string): void {
    for (const [id, lease] of this.leases) {
      if (within(lease.folder, folder)) {
        this.leases.delete(id)
        this.changed(id)
      }
    }
  }

  /** End the leases on terminals whose folder is exactly `folder` (the read opt-in turned off). */
  revokeFolder(folder: string): void {
    for (const [id, lease] of this.leases) {
      if (lease.folder !== folder) continue
      this.leases.delete(id)
      this.changed(id)
    }
  }

  /** End every lease (the control server stopped, or the app is quitting). */
  revokeAll(): void {
    const ids = [...this.leases.keys()]
    this.leases.clear()
    for (const id of ids) this.changed(id)
  }

  /** The operator declined: refuse sends to `terminalId` for {@link DENY_COOLDOWN_MS}. */
  deny(terminalId: string): void {
    const had = this.leases.delete(terminalId)
    this.denied.set(terminalId, this.now() + DENY_COOLDOWN_MS)
    if (had) this.changed(terminalId)
  }

  /** Whether `terminalId` is inside a Deny cooldown. Drops an elapsed one. */
  isDenied(terminalId: string): boolean {
    const until = this.denied.get(terminalId)
    if (until === undefined) return false
    if (this.now() >= until) {
      this.denied.delete(terminalId)
      return false
    }
    return true
  }

  /** Forget everything about terminals the registry no longer holds. */
  prune(known: (terminalId: string) => boolean): void {
    for (const id of [...this.leases.keys()]) {
      if (known(id)) continue
      this.leases.delete(id)
      this.changed(id)
    }
    for (const id of [...this.denied.keys()]) if (!known(id)) this.denied.delete(id)
  }

  /** Terminals that currently hold a lease (for tests and diagnostics). */
  activeIds(): string[] {
    return [...this.leases.entries()]
      .filter(([, lease]) => this.now() - lease.lastWriteAt < LEASE_IDLE_MS)
      .map(([id]) => id)
  }
}

/** The one live table. */
export const terminalLeases = new TerminalLeases()
