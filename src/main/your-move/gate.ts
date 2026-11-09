/**
 * The judge's frozen contract: the exact `claude` argv, the verdict schema and the
 * concurrency cap. Pure: no spawning here (see `judge.ts`).
 *
 * `resources/your-move/gate-v2.md` is the system prompt. Its hash is pinned below because
 * the recall numbers in the PR belong to those exact bytes: a wording change must re-run
 * the eval (plan Task 4) and update the constant in the same commit.
 */

import { z } from 'zod'
import { CARD_KINDS, type Verdict } from './core'

export const GATE_V2_SHA256 = 'a9f0904f256e8c5e73bcaa1d4fca7cf38ed6a1ccf33409435319b10fa1a9345c'

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
const optional = <T extends z.ZodTypeAny>(t: T) =>
  t.nullish().transform((v) => (v === null ? undefined : v))

const newSchema = z.object({
  kind: z.enum(CARD_KINDS),
  ask: z.string().trim().min(1),
  context: optional(z.string()),
  blocks: optional(z.string()),
  options: optional(z.array(z.string())),
  recommended: optional(z.string()),
  link: optional(z.string()),
  confidence: optional(z.enum(['high', 'low'])),
  evidence: optional(z.string())
})

const verdictSchema = z.object({
  new: z.array(newSchema).default([]),
  update: z.array(z.object({ id: z.string().min(1), ask: z.string() })).default([]),
  close: z.array(z.string()).default([])
})

const envelopeSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string(),
  total_cost_usd: z.number().optional()
})

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** Read the CLI's `--output-format json` envelope and validate the verdict inside it. */
export function parseVerdict(
  stdout: string
): { ok: true; verdict: Verdict; costUsd: number } | { ok: false; reason: string } {
  let envelope: z.infer<typeof envelopeSchema>
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success) return { ok: false, reason: 'unexpected CLI output shape' }
    envelope = parsed.data
  } catch {
    return { ok: false, reason: 'CLI output is not JSON' }
  }
  if (envelope.is_error)
    return { ok: false, reason: `CLI reported an error: ${envelope.result.slice(0, 200)}` }
  const text = envelope.result.replace(/^```(?:json)?|```$/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { ok: false, reason: 'reply holds no JSON object' }
  let body: unknown
  try {
    body = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' }
  }
  const v = verdictSchema.safeParse(body)
  if (!v.success)
    return { ok: false, reason: `invalid verdict: ${v.error.issues[0]?.message ?? 'shape'}` }
  return {
    ok: true,
    costUsd: envelope.total_cost_usd ?? 0,
    verdict: {
      new: v.data.new.map((n) => stripUndefined(n)),
      update: v.data.update,
      close: v.data.close
    }
  }
}
