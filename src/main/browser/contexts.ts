/**
 * Execution contexts of a pane's frames (T564 U4, spec §6.2 `browser_eval` `frame`): which JavaScript context is a
 * frame's own (default, main-world) one, fed from `Runtime.executionContextCreated` / `…Destroyed` /
 * `…Cleared`. `Runtime.enable` announces the contexts that already exist, so the table is complete from the
 * moment the pane's debugger attaches. Pure (ADR-0001).
 */

export interface ContextTracker {
  ingest(method: string, params: unknown): void
  /** The default (main-world) context id of `frameId`, or `undefined` while it has none. */
  defaultFor(frameId: string): number | undefined
}

interface CreatedParams {
  context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
}

export function createContextTracker(): ContextTracker {
  /** frameId → context id (default worlds only). */
  const byFrame = new Map<string, number>()
  return {
    ingest(method, params) {
      if (method === 'Runtime.executionContextCreated') {
        const c = (params as CreatedParams | undefined)?.context
        const frameId = c?.auxData?.frameId
        if (c?.auxData?.isDefault === true && frameId !== undefined && typeof c.id === 'number') {
          byFrame.set(frameId, c.id)
        }
      } else if (method === 'Runtime.executionContextDestroyed') {
        const id = (params as { executionContextId?: number } | undefined)?.executionContextId
        for (const [frame, ctx] of byFrame) if (ctx === id) byFrame.delete(frame)
      } else if (method === 'Runtime.executionContextsCleared') {
        byFrame.clear()
      }
    },
    defaultFor: (frameId) => byFrame.get(frameId)
  }
}
