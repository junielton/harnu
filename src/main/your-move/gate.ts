/**
 * The judge's frozen contract: the exact `claude` argv, the verdict schema and the
 * concurrency cap. Pure: no spawning here (see `judge.ts`).
 *
 * Two prompt resources: `gate-v1.md`, the frozen detector (its recall numbers belong to those
 * exact bytes, so it is shipped verbatim), and `enrich-v1.md`, which completes the candidates
 * the detector found. Both hashes are pinned below: a wording change must re-run the eval and
 * update the constant in the same commit.
 */

import { z } from 'zod'
import { CARD_KINDS, type JudgeNew, type Verdict } from './core'

export const GATE_V1_SHA256 = '873be6bd858a8e8fe71712ad2744ddaf4c4dda423af077dec9cb18b265d4e310'
export const ENRICH_V1_SHA256 = '3267c57bac7d82e85aa7bb003fb0d0dbcf1cc3cbb2ba5bae470d42183d86abcc'

/**
 * Isolated invocation: no session, no settings, no MCP, no slash commands, no tools. The
 * prompt goes on stdin; the caller sets cwd to an empty directory and the two
 * `CLAUDE_CODE_DISABLE_*` environment variables.
 */
export function buildJudgeArgs(gatePath: string): string[] {
  return [
    '-p',
    '--model',
    'haiku',
    '--effort',
    'low',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    '',
    '--system-prompt-file',
    gatePath,
    '--output-format',
    'json'
  ]
}

/** `max(1, min(4, floor(cores / 2)))`: the judge never takes more than half the machine. */
export function judgeConcurrency(cores: number): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

// Models write `null` for fields they were told to omit: treat it as absent.
const nullToUndefined = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)

const newSchema = z.object({
  kind: z.enum(CARD_KINDS),
  ask: z.string().trim().min(1),
  context: z.string().nullish().transform(nullToUndefined),
  blocks: z.string().nullish().transform(nullToUndefined),
  options: z.array(z.string()).nullish().transform(nullToUndefined),
  recommended: z.string().nullish().transform(nullToUndefined),
  link: z.string().nullish().transform(nullToUndefined),
  confidence: z.enum(['high', 'low']).nullish().transform(nullToUndefined),
  evidence: z.string().nullish().transform(nullToUndefined)
})

const verdictSchema = z.object({
  new: z.array(newSchema).default([]),
  // Gate v1 sends bare ids; an {id, ask} object is accepted too. A bare id carries no ask.
  update: z
    .array(
      z.union([
        z
          .string()
          .min(1)
          .transform((id) => ({ id })),
        z.object({ id: z.string().min(1), ask: z.string().optional() })
      ])
    )
    .default([]),
  close: z.array(z.string()).default([])
})

// `covers` lists the candidate indexes an enriched card stands for. Unknown values are
// tolerated here (the pipeline ignores them): a sloppy index must never void the enrichment.
const enrichedSchema = newSchema.extend({
  covers: z.array(z.unknown()).nullish().transform(nullToUndefined)
})

const enrichmentSchema = z.object({ new: z.array(enrichedSchema).default([]) })

/** A card the enrichment call wrote, with the candidates it claims to cover. */
export type EnrichedCard = JudgeNew & { covers?: unknown[] }

const envelopeSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string(),
  total_cost_usd: z.number().optional()
})

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** Read the CLI's `--output-format json` envelope and the JSON object inside its `result`. */
function readEnvelope(
  stdout: string
): { ok: true; body: unknown; costUsd: number } | { ok: false; reason: string } {
  let envelope: z.infer<typeof envelopeSchema>
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success) return { ok: false, reason: 'unexpected CLI output shape' }
    envelope = parsed.data
  } catch {
    return { ok: false, reason: 'CLI output is not JSON' }
  }
  if (envelope.is_error) {
    return { ok: false, reason: `CLI reported an error: ${envelope.result.slice(0, 200)}` }
  }
  const text = envelope.result.replace(/^```(?:json)?|```$/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { ok: false, reason: 'reply holds no JSON object' }
  try {
    return {
      ok: true,
      body: JSON.parse(text.slice(start, end + 1)),
      costUsd: envelope.total_cost_usd ?? 0
    }
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' }
  }
}

export function parseVerdict(
  stdout: string
): { ok: true; verdict: Verdict; costUsd: number } | { ok: false; reason: string } {
  const read = readEnvelope(stdout)
  if (!read.ok) return read
  const v = verdictSchema.safeParse(read.body)
  if (!v.success) {
    return { ok: false, reason: `invalid verdict: ${v.error.issues[0]?.message ?? 'shape'}` }
  }
  return {
    ok: true,
    costUsd: read.costUsd,
    verdict: {
      new: v.data.new.map((n) => stripUndefined(n)),
      update: v.data.update,
      close: v.data.close
    }
  }
}

/** The enrichment reply: `{"new":[…]}`. An empty list parses; the caller decides it is not enough. */
export function parseEnrichment(
  stdout: string
): { ok: true; cards: EnrichedCard[]; costUsd: number } | { ok: false; reason: string } {
  const read = readEnvelope(stdout)
  if (!read.ok) return read
  const v = enrichmentSchema.safeParse(read.body)
  if (!v.success) {
    return { ok: false, reason: `invalid enrichment: ${v.error.issues[0]?.message ?? 'shape'}` }
  }
  return { ok: true, costUsd: read.costUsd, cards: v.data.new.map((n) => stripUndefined(n)) }
}
