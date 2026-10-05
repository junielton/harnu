import type { RoadmapCard, CardSubstrate } from '../../../preload'

/**
 * Dispatch-substrate resolution (T102) — the PURE decision behind "where does
 * a card's dispatch actually run": the same folder (`session`/`teammate`), a
 * fresh worktree (`worktree`), or nowhere at all (`internal` — the orchestrator
 * resolves it with its own subagents, never a new Harnu session). Mirrors
 * `roadmap-core.ts`'s `CARD_SUBSTRATES`/`resolveCardSubstrate` (renderer-local
 * per the module's mirroring convention — `stores/roadmap.ts` already mirrors
 * `COLUMN_ORDER`/`compareCards` the same way) so `RoadmapBoard.vue` can branch
 * dispatch without crossing into `main`.
 */

/** Mirror of `roadmap-core.CARD_SUBSTRATES` — the closed enum a selector picks from. */
export const CARD_SUBSTRATES: readonly CardSubstrate[] = [
  'session',
  'worktree',
  'teammate',
  'internal'
]

/** Mirror of `roadmap-core.resolveCardSubstrate` — defaults absent to `session`. */
export function resolveCardSubstrate(card: Pick<RoadmapCard, 'substrate'>): CardSubstrate {
  return card.substrate ?? 'session'
}

/** Mirror of `roadmap-core.isCardSubstrate` — whether `v` is a recognized substrate. */
export function isCardSubstrate(v: string): v is CardSubstrate {
  return (CARD_SUBSTRATES as readonly string[]).includes(v)
}

/**
 * One card's dispatch branch, resolved from its substrate (T102 four modes).
 * Every variant carries the RESOLVED `substrate` (post any override) so a
 * caller never has to re-derive it separately for the post-dispatch bind.
 */
export type DispatchTarget =
  | { kind: 'same-folder'; substrate: CardSubstrate; folder: string; teammateOf?: string }
  | { kind: 'worktree'; substrate: 'worktree'; repoPath: string; branch: string }
  | { kind: 'skip-internal'; substrate: 'internal' }

/** One branch name per dispatched card (T80 §3.4 — "one branch per card"). */
export function worktreeDispatchBranch(slug: string): string {
  return `card/${slug}`
}

/**
 * Decide HOW a card dispatches (T102), given the resolved substrate (default
 * or human override, already folded by the caller into `substrateOverride`)
 * and the board's folder. `session`/`teammate` both spawn in the SAME folder —
 * `teammate` additionally carries the card's authoring session id (when known,
 * `card.provenance.sessionId`) so the bind can record the parent link. `worktree`
 * names the target repo + a per-card branch for a fresh `create_worktree`.
 * `internal` never spawns — the caller must not call `dispatchCardSession` at
 * all for this target (the card stays bound to the orchestrator's own session).
 *
 * `substrateOverride` accepts a plain `string` (not the narrow union) because
 * its caller is typically a `SegmentedControl` v-model, whose emitted type is
 * a broader `string | number | boolean` — an unrecognized/empty override is
 * silently ignored (falls back to the card's own resolved substrate), never a
 * throw, mirroring `roadmap-core.isCardSubstrate`'s lenient-read convention.
 */
export function planCardDispatch(
  card: Pick<RoadmapCard, 'slug' | 'substrate' | 'provenance'>,
  folder: string,
  substrateOverride?: string
): DispatchTarget {
  const override =
    substrateOverride && isCardSubstrate(substrateOverride) ? substrateOverride : undefined
  const substrate = override ?? resolveCardSubstrate(card)
  if (substrate === 'internal') return { kind: 'skip-internal', substrate }
  if (substrate === 'worktree') {
    return {
      kind: 'worktree',
      substrate,
      repoPath: folder,
      branch: worktreeDispatchBranch(card.slug)
    }
  }
  if (substrate === 'teammate') {
    const teammateOf = card.provenance.sessionId
    return { kind: 'same-folder', substrate, folder, ...(teammateOf ? { teammateOf } : {}) }
  }
  return { kind: 'same-folder', substrate, folder }
}
