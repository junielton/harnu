/**
 * Campaign ch.6 (T598, spec §3.6) — the zod shapes of the `outcome` and the memory `drafts` a
 * mission or campaign file stores at close. One module so `mission-core.ts` and `campaign-core.ts`
 * validate the same bytes; the TypeScript types live in `consolidator-core.ts`.
 *
 * Both are `.passthrough()` like every record object (a key a later Harnu adds survives a
 * read → write by this one).
 */
import { z } from 'zod'
import type { MemoryDraft, Outcome } from './consolidator-core'

const DeclaredEndShape = z.object({
  kind: z.enum(['code', 'ui', 'research', 'decision', 'other']),
  target: z.string(),
  evidence: z.string()
})

export const OutcomeSchema: z.ZodType<Outcome> = z
  .object({
    declaredEnd: DeclaredEndShape,
    actualEnd: z.string(),
    deviations: z.array(z.string()),
    blockers: z.array(z.object({ reason: z.string(), resolution: z.string() })),
    verificationGaps: z.array(z.string()),
    surprises: z.array(z.string()),
    perStep: z.array(
      z
        .object({
          stepId: z.string(),
          openedAt: z.string(),
          mergedAt: z.string().optional(),
          commits: z.number().int().optional(),
          reverifications: z.number().int().optional()
        })
        .passthrough()
    ),
    nothingNotable: z.literal(true).optional()
  })
  .passthrough() as z.ZodType<Outcome>

export const MemoryDraftSchema: z.ZodType<MemoryDraft> = z
  .object({
    id: z.string(),
    kind: z.enum(['decision', 'lesson', 'hot']),
    page: z.enum(['decisions', 'hot']),
    entry: z.string(),
    cites: z.array(z.object({ kind: z.enum(['step', 'pr', 'commit']), ref: z.string() })),
    mission: z.string(),
    validFrom: z.string(),
    watches: z.array(z.string()).optional(),
    supersedes: z.string().optional()
  })
  .passthrough() as z.ZodType<MemoryDraft>
