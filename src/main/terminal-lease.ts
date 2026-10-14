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

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Start (or restart) the lease on `terminalId`. */
  grant(terminalId: string, folder: string): void {
    this.leases.set(terminalId, { folder, lastWriteAt: this.now() })
    // An Allow overrides an earlier Deny: the operator changed their mind.
    this.denied.delete(terminalId)
  }

  /** Whether `terminalId` holds a lease that has not idled out. Drops an expired one. */
  isActive(terminalId: string): boolean {
    const lease = this.leases.get(terminalId)
    if (!lease) return false
    if (this.now() - lease.lastWriteAt >= LEASE_IDLE_MS) {
      this.leases.delete(terminalId)
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
    this.leases.delete(terminalId)
  }

  /** End every lease on a terminal in `folder` or below it (the folder was blocked). */
  revokeUnder(folder: string): void {
    for (const [id, lease] of this.leases) {
      if (within(lease.folder, folder)) this.leases.delete(id)
    }
  }

  /** End every lease (the control server stopped, or the app is quitting). */
  revokeAll(): void {
    this.leases.clear()
  }

  /** The operator declined: refuse sends to `terminalId` for {@link DENY_COOLDOWN_MS}. */
  deny(terminalId: string): void {
    this.leases.delete(terminalId)
    this.denied.set(terminalId, this.now() + DENY_COOLDOWN_MS)
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
    for (const id of [...this.leases.keys()]) if (!known(id)) this.leases.delete(id)
    for (const id of [...this.denied.keys()]) if (!known(id)) this.denied.delete(id)
  }

  /** Terminals that currently hold a lease (for tests and diagnostics). */
  activeIds(): string[] {
    return [...this.leases.keys()].filter((id) => this.isActive(id))
  }
}

/** The one live table. */
export const terminalLeases = new TerminalLeases()
