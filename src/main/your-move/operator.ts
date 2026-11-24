/**
 * Who a session belongs to: only a session whose transcript holds an operator entry is worth a
 * judge call (BUG-300). STUB: the red commit; the real gate lands in the next commit.
 */

import type { YourMoveStore } from './store'

export interface OperatorGate {
  /** Does the transcript at `path` hold at least one operator entry? */
  has(sessionId: string, path: string): Promise<boolean>
}

export function createOperatorGate(): OperatorGate {
  return { has: async () => true }
}

export interface CleanupDeps {
  store: YourMoveStore
  gate: OperatorGate
  locate(sessionId: string): Promise<string | null>
  now(): number
}

/** Closes the open judge cards of sessions the operator never typed in. Returns how many closed. */
export async function closeIneligibleCards(_deps: CleanupDeps): Promise<number> {
  return 0
}
