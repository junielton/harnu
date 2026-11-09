/**
 * The judge pipeline for one segment: two independent detector runs, a combine step, and one
 * enrichment call. Pure over injected `detect` and `enrich`, so the shipped inspector and the
 * eval harness run the very same code.
 *
 * Recall over noise, at every step:
 * - `new` and `update` are the UNION of the two runs, so a miss needs both runs to miss;
 * - `close` is the INTERSECTION, because a wrong close loses a card;
 * - one failed run falls back to the other; only two failed runs fail the segment;
 * - enrichment only ever adds fields and merges duplicates. Each card says which candidates
 *   it `covers`; a candidate no card covers is filed as its own card, so a merge can never
 *   cost a card. If enrichment fails, returns invalid JSON or zero cards, the candidates
 *   themselves are filed.
 */

import type { JudgeNew, Verdict } from './core'
import type { EnrichOutcome, JudgeOutcome } from './judge'
import { renderForEnrich, renderForJudge, type SegmentEntry } from './segment'

/** Case, accents, punctuation and spacing do not make two asks different items. */
export function normalizeAsk(ask: string): string {
  return ask
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The first card of each normalized text, in order. */
export function dedupeCandidates(cards: readonly JudgeNew[]): JudgeNew[] {
  const seen = new Set<string>()
  const out: JudgeNew[] = []
  for (const c of cards) {
    const key = normalizeAsk(c.ask)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** New and update: union. Close: only what both runs close. */
export function combineDetections(a: Verdict, b: Verdict): Verdict {
  const updateIds = new Set<string>()
  const update: Verdict['update'] = []
  for (const u of [...a.update, ...b.update]) {
    if (updateIds.has(u.id)) continue
    updateIds.add(u.id)
    update.push(u)
  }
  const closedByB = new Set(b.close)
  return {
    new: dedupeCandidates([...a.new, ...b.new]),
    update,
    close: [...new Set(a.close)].filter((id) => closedByB.has(id))
  }
}

export interface PipelineDeps {
  detect(input: string): Promise<JudgeOutcome>
  enrich(input: string): Promise<EnrichOutcome>
}

export type SegmentJudgment =
  | {
      ok: true
      verdict: Verdict
      costUsd: number
      /** Detector runs that failed (0 or 1; two failures fail the segment). */
      detectorFailures: number
      enrichment: 'none' | 'enriched' | 'fallback'
      /** Candidates no enriched card covered, filed as they were detected. */
      uncovered?: number
      enrichFailure?: string
    }
  | { ok: false; reason: string }

export async function judgeSegment(
  deps: PipelineDeps,
  open: readonly { id: string; ask: string }[],
  entries: readonly SegmentEntry[]
): Promise<SegmentJudgment> {
  const input = renderForJudge(open, entries)
  const [a, b] = await Promise.all([deps.detect(input), deps.detect(input)])
  let cost = (a.ok ? a.costUsd : 0) + (b.ok ? b.costUsd : 0)
  let verdict: Verdict
  let detectorFailures = 0
  if (a.ok && b.ok) {
    verdict = combineDetections(a.verdict, b.verdict)
  } else if (a.ok || b.ok) {
    const ok = (a.ok ? a : b) as Extract<JudgeOutcome, { ok: true }>
    verdict = { ...ok.verdict, new: dedupeCandidates(ok.verdict.new) }
    detectorFailures = 1
  } else {
    return { ok: false, reason: a.ok === false ? a.reason : 'detector failed' }
  }

  const candidates = verdict.new
  if (candidates.length === 0) {
    return { ok: true, verdict, costUsd: cost, detectorFailures, enrichment: 'none' }
  }
  const enriched = await deps.enrich(renderForEnrich(open, entries, candidates))
  if (enriched.ok) cost += enriched.costUsd
  if (enriched.ok && enriched.cards.length > 0) {
    // Only integer indexes inside the candidate list count; anything else is ignored.
    const covered = new Set<number>()
    for (const card of enriched.cards) {
      for (const i of card.covers ?? []) {
        if (Number.isInteger(i) && (i as number) >= 0 && (i as number) < candidates.length) {
          covered.add(i as number)
        }
      }
    }
    const uncovered = candidates.filter((_, i) => !covered.has(i))
    const cards = enriched.cards.map(({ covers: _covers, ...card }) => card)
    return {
      ok: true,
      verdict: { ...verdict, new: [...cards, ...uncovered] },
      costUsd: cost,
      detectorFailures,
      enrichment: 'enriched',
      uncovered: uncovered.length
    }
  }
  return {
    ok: true,
    verdict,
    costUsd: cost,
    detectorFailures,
    enrichment: 'fallback',
    enrichFailure: enriched.ok ? 'returned no cards' : enriched.reason
  }
}
