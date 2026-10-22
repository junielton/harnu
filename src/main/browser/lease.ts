/**
 * Browser write leases and deny cooldowns (T564 U4, spec §7.1), the `send_terminal` lease of ADR-0020 applied to
 * a pane.
 *
 * A call on a `lease` row (an `external` page, or any pane the operator opened) raises the operator's confirm. An
 * Allow does not perform that call: it grants a LEASE on that one pane and the agent calls again. While the lease
 * is active every writer's later calls on a lease row run without a prompt. A Deny starts a cooldown during which
 * those calls are refused outright, so an agent cannot badger the operator with a new prompt per call.
 *
 * A lease ends at whichever comes first: {@link LEASE_IDLE_MS} after the last agent write, the pane closing,
 * Disconnect, the folder being blocked (or its read opt-in turned off), the kill-switch flipping, or the app
 * quitting. The pane-state endings (close, Disconnect) are re-checked by the shell when it resolves the gate
 * state; the rest are explicit calls into this table.
 *
 * Pure (ADR-0001): no electron, no fs, the clock is injected. Memory only: a lease never survives the process.
 */
import * as path from 'node:path'

/** A lease ends this long after the last agent write (spec §7.1). */
export const LEASE_IDLE_MS = 10 * 60_000

/** A Deny refuses further lease-row calls on the pane for this long (spec §7.1). */
export const DENY_COOLDOWN_MS = 5 * 60_000

interface Lease {
  /** The pane's folder, so a block of that folder can end the lease. */
  folder: string
  /**
   * The view AND origin the operator approved (`view-host.viewToken`: `<webContents id>|<scheme+host+port>`). A lease
   * counts only while the pane id still names THAT view showing THAT origin: a pane restored under the same id, or
   * one that moved to another site, is a page the operator never approved.
   */
  viewToken: string
  /** Epoch ms of the grant or of the last agent write, whichever is later. */
  lastWriteAt: number
}

/** Whether `target` is `root` itself or lies under it. */
function within(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

export class BrowserLeases {
  private readonly leases = new Map<string, Lease>()
  private readonly denied = new Map<string, number>()
  private readonly listeners = new Set<(paneId: string) => void>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Call `cb` with the pane id whenever a lease is granted or ends (revoke, folder block, kill-switch, Deny, an
   * idled-out lease dropped on a check). The pane chip re-reads its state on it. Display only: a throwing
   * listener never changes what the table decides.
   */
  onChange(cb: (paneId: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(paneId: string): void {
    for (const cb of this.listeners) {
      try {
        cb(paneId)
      } catch {
        // A display listener must never fail the gate.
      }
    }
  }

  /** Start (or restart) the lease on `paneId`, bound to the view `viewToken` that shows it now. */
  grant(paneId: string, folder: string, viewToken: string): void {
    this.leases.set(paneId, { folder, viewToken, lastWriteAt: this.now() })
    // An Allow overrides an earlier Deny: the operator changed their mind.
    this.denied.delete(paneId)
    this.changed(paneId)
  }

  /**
   * Whether `paneId` holds a lease that has not idled out and was granted for the view `viewToken` that shows it
   * now. Drops an expired or stale one.
   */
  isActive(paneId: string, viewToken: string): boolean {
    const lease = this.leases.get(paneId)
    if (!lease) return false
    if (lease.viewToken !== viewToken || this.now() - lease.lastWriteAt >= LEASE_IDLE_MS) {
      this.leases.delete(paneId)
      this.changed(paneId)
      return false
    }
    return true
  }

  /**
   * The pane's token changed under a lease (a main-frame commit to another origin, spec §7.1): the lease ends at
   * once, whatever the next call looks like. A pane that went A → B → A between two calls is then not leased
   * on its return.
   */
  noteToken(paneId: string, viewToken: string): void {
    const lease = this.leases.get(paneId)
    if (lease && lease.viewToken !== viewToken) this.revoke(paneId)
  }

  /** An agent write went out under the lease: the 10 minutes start over. No lease, no effect. */
  noteWrite(paneId: string): void {
    const lease = this.leases.get(paneId)
    if (lease) lease.lastWriteAt = this.now()
  }

  /** Epoch ms the lease ends at if no agent writes, or `null` without one (for the pane chip). */
  idleEndsAt(paneId: string): number | null {
    const lease = this.leases.get(paneId)
    return lease ? lease.lastWriteAt + LEASE_IDLE_MS : null
  }

  /** End the lease on one pane (close, Disconnect). */
  revoke(paneId: string): void {
    if (this.leases.delete(paneId)) this.changed(paneId)
  }

  /** End every lease on a pane in `folder` or below it (the folder was blocked). */
  revokeUnder(folder: string): void {
    for (const [id, lease] of this.leases) {
      if (within(lease.folder, folder)) {
        this.leases.delete(id)
        this.changed(id)
      }
    }
  }

  /** End the leases on panes whose folder is exactly `folder` (the read opt-in turned off). */
  revokeFolder(folder: string): void {
    for (const [id, lease] of this.leases) {
      if (lease.folder !== folder) continue
      this.leases.delete(id)
      this.changed(id)
    }
  }

  /** End every lease (the kill-switch flipped, the control server stopped, or the app is quitting). */
  revokeAll(): void {
    const ids = [...this.leases.keys()]
    this.leases.clear()
    for (const id of ids) this.changed(id)
  }

  /** The operator declined: refuse lease-row calls on `paneId` for {@link DENY_COOLDOWN_MS}. */
  deny(paneId: string): void {
    const had = this.leases.delete(paneId)
    this.denied.set(paneId, this.now() + DENY_COOLDOWN_MS)
    if (had) this.changed(paneId)
  }

  /** Whether `paneId` is inside a Deny cooldown. Drops an elapsed one. */
  isDenied(paneId: string): boolean {
    const until = this.denied.get(paneId)
    if (until === undefined) return false
    if (this.now() >= until) {
      this.denied.delete(paneId)
      return false
    }
    return true
  }

  /** Forget everything about a pane that was closed. */
  forget(paneId: string): void {
    this.revoke(paneId)
    this.denied.delete(paneId)
  }

  /** Forget everything about panes the registry no longer holds. */
  prune(known: (paneId: string) => boolean): void {
    for (const id of [...this.leases.keys()]) {
      if (known(id)) continue
      this.leases.delete(id)
      this.changed(id)
    }
    for (const id of [...this.denied.keys()]) if (!known(id)) this.denied.delete(id)
  }

  /** Panes that currently hold a lease (for tests and diagnostics). */
  activeIds(): string[] {
    return [...this.leases.entries()]
      .filter(([, lease]) => this.now() - lease.lastWriteAt < LEASE_IDLE_MS)
      .map(([id]) => id)
  }
}
