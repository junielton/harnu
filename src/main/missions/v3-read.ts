/**
 * Missions v4 S-9 (AC-26) — the frozen v3 reader.
 *
 * A copy of the v3 mission and campaign schemas and their two parsers, taken from `mission-core.ts`,
 * `campaign-core.ts` and `outcome-schema.ts` as they stand on main at the slice's base. It is the ONLY
 * v3 code a v4 module may import: `compat.ts` and `record-store.ts` read v3 files through it, so the
 * day the v3 core modules are deleted (S-41) the compatibility suite and the fixtures test keep
 * running on this file alone. For that reason it imports nothing of the app, only `js-yaml` and `zod`.
 *
 * What it keeps: every schema, the file-format split (frontmatter, Log), the two parsers and the two
 * Log readers, and the one behaviour of the v3 parser that is not pure validation (a stored `draft`
 * reads as `active`). What it drops: the builders (`buildMissionFileContent`,
 * `buildCampaignFileContent`), id minting, path helpers, the exclusive create, the per-id lock and
 * every operator door. A v4 build never writes a v3 file, so none of those has a caller here.
 *
 * Frozen means: do not change a schema or a parser here to follow a change in v3. A v3 file that the
 * installed build reads must read here too, so a difference is a bug in this file, and
 * `tests/mission-v4-compat.test.ts` compares both parsers on every fixture.
 *
 * Every object schema is `.passthrough()`, as in v3, so a key a later v3 build adds survives a read.
 */

import yaml from 'js-yaml'
import { z } from 'zod'

// ---- Shared pieces (outcome-schema.ts, copied) -------------------------------

const DeclaredEndSchema = z.object({
  kind: z.enum(['code', 'ui', 'research', 'decision', 'other']),
  target: z.string(),
  evidence: z.string()
})

const OutcomeSchema = z
  .object({
    declaredEnd: DeclaredEndSchema,
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
  .passthrough()

const MemoryDraftSchema = z
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
  .passthrough()

// ---- v3 mission (mission-core.ts, copied) ------------------------------------

/** `mnt-<8 hex>`. */
export const V3_MISSION_ID_RE = /^mnt-[0-9a-f]{8}$/
/** Kebab slug, the same shape card slugs use. */
export const V3_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STEP_ID_RE = /^stp-\d+$/

/** The events Harnu itself recorded on a mission, in the order v3 lists them. */
const LEDGER_KINDS = [
  'dispatched',
  'worktree',
  'pr-opened',
  'pr-merged',
  'ci',
  'verified',
  'session-died',
  'compaction',
  'owner-transfer'
] as const

const BlockerSchema = z
  .object({
    reason: z.string(),
    unblocks: z.string(),
    owner: z.enum(['agent', 'operator']),
    raisedAt: z.string()
  })
  .passthrough()

const StepLinkSchema = z
  .object({
    kind: z.enum(['session', 'worktree', 'card', 'pr']),
    ref: z.string()
  })
  .passthrough()

const CheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    source: z.enum(['agent', 'operator', 'verifier']),
    createdAt: z.string(),
    ticked: z.object({ at: z.string() }).passthrough().optional()
  })
  .passthrough()

const LedgerRowSchema = z
  .object({
    at: z.string(),
    kind: z.enum(LEDGER_KINDS),
    stepId: z.string().optional(),
    ref: z.string(),
    sessionId: z.string().optional(),
    worktree: z.string().optional(),
    branch: z.string().optional(),
    pr: z.number().int().optional(),
    detail: z.string().optional()
  })
  .passthrough()

const MissionStepSchema = z
  .object({
    id: z.string().regex(STEP_ID_RE),
    ordinal: z.number().int(),
    kind: z.enum(['fixed-start', 'fixed-end', 'custom']),
    title: z.string(),
    verification: z.enum(['existence', 'verifier', 'human']),
    proof: z.enum(['unproven', 'claimed', 'verified', 'self-verified']),
    verifiedBy: z
      .object({
        sessionId: z.string(),
        at: z.string(),
        verdict: z.enum(['met', 'unmet', 'blocked', 'needs-human']).optional(),
        evidenceRequired: z.literal(true).optional()
      })
      .optional(),
    links: z.array(StepLinkSchema),
    blockers: z.array(BlockerSchema),
    addedReason: z.string().optional(),
    addedAt: z.string().optional(),
    checks: z.array(CheckSchema).optional(),
    required: z.boolean().optional(),
    discoveredFrom: z.string().optional(),
    edges: z
      .array(
        z.object({ kind: z.enum(['blocks', 'validates', 'related']), to: z.string() }).passthrough()
      )
      .optional(),
    decision: z
      .object({
        title: z.string(),
        options: z.array(z.string()),
        chosen: z.number().int().optional(),
        blocks: z.array(z.string())
      })
      .passthrough()
      .optional()
  })
  .passthrough()

const MissionSchema = z
  .object({
    id: z.string().regex(V3_MISSION_ID_RE),
    slug: z.string().regex(V3_SLUG_RE),
    folder: z.string(),
    owner: z.object({ sessionId: z.string(), folder: z.string() }),
    linkedCard: z.string().optional(),
    status: z.enum(['draft', 'active', 'stale', 'delivered', 'closed']),
    closedAs: z.enum(['delivered', 'discarded']).optional(),
    closeReason: z.string().optional(),
    declaredEnd: DeclaredEndSchema,
    declaredEndApproval: z
      .object({
        at: z.string(),
        bodyHash: z.string(),
        via: z.enum(['chat', 'operator']).optional()
      })
      .passthrough()
      .optional(),
    scope: z.array(StepLinkSchema).optional(),
    pendingRescope: DeclaredEndSchema.optional(),
    steps: z.array(MissionStepSchema),
    blockers: z.array(BlockerSchema).default([]),
    openQuestions: z.array(z.string()),
    pendingClose: z.object({ at: z.string(), requestedBy: z.string() }).optional(),
    stewardPause: z.object({ at: z.string(), reason: z.string() }).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    provenance: z.object({
      author: z.enum(['agent', 'human']),
      at: z.string(),
      branch: z.string().optional()
    }),
    legacy: z
      .object({
        source: z.string(),
        sha256: z.string(),
        needsReview: z.array(z.enum(['declaredEnd']))
      })
      .optional(),
    legacyRaw: z.string().optional(),
    ledger: z.array(LedgerRowSchema).optional(),
    outcome: OutcomeSchema.optional(),
    memoryDrafts: z.array(MemoryDraftSchema).optional(),
    campaignId: z.string().optional(),
    chapterId: z.string().optional()
  })
  .passthrough()

/** A v3 mission, as `parseMissionFile` returns it. */
export type V3Mission = z.infer<typeof MissionSchema>
export type V3MissionStep = z.infer<typeof MissionStepSchema>
export type V3LedgerRow = z.infer<typeof LedgerRowSchema>

// ---- v3 campaign (campaign-core.ts, copied) ----------------------------------

/** `cmp-<8 hex>`. */
export const V3_CAMPAIGN_ID_RE = /^cmp-[0-9a-f]{8}$/
const CHAPTER_ID_RE = /^chp-\d+$/

const ChapterSchema = z
  .object({
    id: z.string().regex(CHAPTER_ID_RE),
    ordinal: z.number().int(),
    title: z.string(),
    missionId: z.string().optional(),
    required: z.boolean(),
    discoveredFrom: z
      .object({ chapterId: z.string(), stepId: z.string().optional() })
      .passthrough()
      .optional(),
    unlocks: z
      .object({ kind: z.enum(['decision', 'chapter', 'pr']), ref: z.string() })
      .passthrough()
      .optional(),
    produces: z.array(z.string()).optional(),
    consumes: z.array(z.string()).optional(),
    radiant: z
      .object({ template: z.string(), total: z.number().int().min(0) })
      .passthrough()
      .optional()
  })
  .passthrough()

const CampaignSchema = z
  .object({
    id: z.string().regex(V3_CAMPAIGN_ID_RE),
    slug: z.string().regex(V3_SLUG_RE),
    folder: z.string(),
    owner: z.object({ sessionId: z.string(), folder: z.string() }),
    title: z.string(),
    declaredEnd: DeclaredEndSchema,
    chapters: z.array(ChapterSchema),
    status: z.enum(['active', 'delivered', 'closed']),
    closedAs: z.enum(['delivered', 'discarded']).optional(),
    closeReason: z.string().optional(),
    scope: z.array(StepLinkSchema).optional(),
    pendingClose: z.object({ at: z.string(), requestedBy: z.string() }).optional(),
    outcome: OutcomeSchema.optional(),
    memoryDrafts: z.array(MemoryDraftSchema).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    provenance: z.object({
      author: z.enum(['agent', 'human']),
      at: z.string(),
      branch: z.string().optional()
    })
  })
  .passthrough()

/** A v3 campaign, as `parseCampaignFile` returns it. */
export type V3Campaign = z.infer<typeof CampaignSchema>
export type V3Chapter = z.infer<typeof ChapterSchema>

// ---- File format and parsers -------------------------------------------------

/** Collapse zod issues into one line: `steps.1.proof: Invalid option …`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/** Split a file into its leading frontmatter (inner text) and body (the Log). */
function splitFile(raw: string): { inner: string; body: string } | null {
  const open = /^---\r?\n/.exec(raw)
  if (!open) return null
  const afterOpen = raw.slice(open[0].length)
  const close = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(afterOpen)
  if (!close) return null
  return {
    inner: afterOpen.slice(0, close.index),
    body: afterOpen.slice(close.index + close[0].length)
  }
}

/** The frontmatter as data, read with js-yaml's CORE schema so a timestamp stays a string. */
function loadFrontmatter(raw: string): { data: unknown } | { error: string } {
  const split = splitFile(raw)
  if (!split) return { error: 'no frontmatter block' }
  try {
    return { data: yaml.load(split.inner, { schema: yaml.CORE_SCHEMA }) as unknown }
  } catch (e) {
    return { error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` }
  }
}

/**
 * Parse a v3 mission file. Never throws: a missing frontmatter, a YAML syntax error or a schema
 * mismatch returns `{ error }`. A stored `draft` reads as `active`, exactly as the v3 parser does.
 */
export function parseV3MissionFile(raw: string): V3Mission | { error: string } {
  const loaded = loadFrontmatter(raw)
  if ('error' in loaded) return loaded
  const checked = MissionSchema.safeParse(loaded.data)
  if (!checked.success) return { error: `invalid mission: ${describeIssues(checked.error)}` }
  const mission = checked.data
  if (mission.status === 'draft') mission.status = 'active'
  return mission
}

/** Parse a v3 campaign file. Never throws; a schema mismatch returns `{ error }`. */
export function parseV3CampaignFile(raw: string): V3Campaign | { error: string } {
  const loaded = loadFrontmatter(raw)
  if ('error' in loaded) return loaded
  const checked = CampaignSchema.safeParse(loaded.data)
  if (!checked.success) return { error: `invalid campaign: ${describeIssues(checked.error)}` }
  return checked.data
}

/** A v3 mission file's free-text Log body (everything after the frontmatter); `''` when none. */
export function readV3MissionLog(raw: string): string {
  return splitFile(raw)?.body ?? ''
}

/** A v3 campaign file's free-text Log body; `''` when none. */
export function readV3CampaignLog(raw: string): string {
  return splitFile(raw)?.body ?? ''
}
