/**
 * Campaign domain core (T595, chapter 3a) — the `Campaign`/`Chapter` data model of
 * `docs/specs/2026-10-30-campaign/spec.md` §3.1 and its on-disk file. Mirrors
 * `mission-core.ts` on purpose: a campaign is a quest line ABOVE the mission, and a
 * chapter IS a mission (bound by `missionId` when its mission is created), so the two
 * records share one file format, one lock discipline and one storage rule.
 *
 * File format: YAML frontmatter carrying the full {@link Campaign} struct, then a
 * free-text, append-only Log body (surprises forced past the prerequisite pass land
 * there) — never authoritative for state. Stored as `.harnu/campaigns/<id>-<slug>.md`
 * in the repo's MAIN checkout (callers resolve the root once, exactly as for missions),
 * so every worktree shares it.
 *
 * Every read goes through a zod schema, so a hand-edited or corrupt file degrades to
 * `{ error }`, never to a half-typed `Campaign`. Every object schema is `.passthrough()`:
 * a key a later chapter adds (the §3.6 `outcome`, chapter 6) survives a read → write by
 * this version instead of being stripped.
 *
 * Pure except for the two small I/O paths it owns — the exclusive create and the
 * per-campaign-id lock — mirroring `createMissionFile` / `withMissionIdMintLock`.
 */

import { randomBytes } from 'node:crypto'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { dataDirAt, mkdirDataDir } from './data-dir'
import type { DeclaredEnd, StepLink } from './mission-core'
import { serializeByKey } from './roadmap-core'

// ---- Data model (spec §3.1 — field-for-field) --------------------------------

/** Spec §3.1 — `radiant`: one template run N times ("migrate page {slug}" × 88). */
export interface Radiant {
  template: string
  total: number
}

/** Spec §3.1 — `unlocks`: what a locked chapter waits for. Only `chapter` is resolved from the record in 3a. */
export interface ChapterUnlock {
  kind: 'decision' | 'chapter' | 'pr'
  ref: string
}

/** Spec §3.1 — one chapter. A chapter IS a mission, bound when its mission is created. */
export interface Chapter {
  /** `chp-<n>`, ordinal-stable once assigned. */
  id: string
  ordinal: number
  title: string
  /** Bound when the chapter's mission is created (`mission_create { campaignId, chapterId }`). */
  missionId?: string
  /** `false` = a side-quest chapter: outside the headline. */
  required: boolean
  discoveredFrom?: { chapterId: string; stepId?: string }
  unlocks?: ChapterUnlock
  /** Spec §3.5 prerequisite tokens: free strings agreed by the skill. */
  produces?: string[]
  consumes?: string[]
  radiant?: Radiant
}

/** Spec §3.1 — one campaign, stored as one `.harnu/campaigns/<id>-<slug>.md`. */
export interface Campaign {
  id: string
  slug: string
  folder: string
  owner: { sessionId: string; folder: string }
  title: string
  declaredEnd: DeclaredEnd
  /** Ordered; append-only for agents (anti-goal: a plan the agent can silently shrink). */
  chapters: Chapter[]
  status: 'active' | 'delivered' | 'closed'
  closedAs?: 'delivered' | 'discarded'
  closeReason?: string
  scope?: StepLink[]
  /** Set by `campaign_request_close`; consumed by the operator's end door. */
  pendingClose?: { at: string; requestedBy: string }
  createdAt: string
  updatedAt: string
  provenance: { author: 'agent' | 'human'; at: string; branch?: string }
}

// ---- Validation schemas ------------------------------------------------------

/** `cmp-<8 hex>` — minted by {@link mintCampaignId}. */
export const CAMPAIGN_ID_RE = /^cmp-[0-9a-f]{8}$/
/** `chp-<n>` — ordinal-stable once assigned. */
export const CHAPTER_ID_RE = /^chp-\d+$/
/** Kebab slug, the same shape mission and card slugs use; also keeps the filename path-safe. */
export const CAMPAIGN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const DeclaredEndSchema: z.ZodType<DeclaredEnd> = z.object({
  kind: z.enum(['code', 'ui', 'research', 'decision', 'other']),
  target: z.string(),
  evidence: z.string()
})

const StepLinkSchema: z.ZodType<StepLink> = z
  .object({ kind: z.enum(['session', 'worktree', 'card', 'pr']), ref: z.string() })
  .passthrough()

const ChapterSchema: z.ZodType<Chapter> = z
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

/** Key order here is the key order written to disk — the spec's field order. */
const CampaignSchema: z.ZodType<Campaign> = z
  .object({
    id: z.string().regex(CAMPAIGN_ID_RE),
    slug: z.string().regex(CAMPAIGN_SLUG_RE),
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
    createdAt: z.string(),
    updatedAt: z.string(),
    provenance: z.object({
      author: z.enum(['agent', 'human']),
      at: z.string(),
      branch: z.string().optional()
    })
  })
  .passthrough()

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

// ---- File format -------------------------------------------------------------

/** Split a file into its leading frontmatter (inner text) and body (the Log). */
function splitCampaignFile(raw: string): { inner: string; body: string } | null {
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

/**
 * Serialize a campaign to its file content: frontmatter carrying every {@link Campaign}
 * field, then `log` verbatim as the body. Throws on a campaign that fails validation —
 * writing an invalid file must fail loudly, not land a record every later read rejects.
 * Dumped with js-yaml's DEFAULT schema (it quotes any string that would read back as
 * another type), read back with the CORE schema, so every string stays a string and the
 * round trip is byte-stable.
 */
export function buildCampaignFileContent(campaign: Campaign, log = ''): string {
  const checked = CampaignSchema.safeParse(campaign)
  if (!checked.success) throw new Error(`invalid campaign: ${describeIssues(checked.error)}`)
  const frontmatter = yaml.dump(checked.data, {
    lineWidth: -1,
    noRefs: true,
    skipInvalid: true // drops keys an optional field left explicitly `undefined`
  }) as string
  return `---\n${frontmatter}---\n${log}`
}

/**
 * Parse a campaign file back into a validated {@link Campaign}. Never throws: a missing
 * frontmatter, a YAML syntax error or a schema mismatch all return `{ error }` naming
 * what was wrong.
 */
export function parseCampaignFile(raw: string): Campaign | { error: string } {
  const split = splitCampaignFile(raw)
  if (!split) return { error: 'no frontmatter block' }
  let data: unknown
  try {
    data = yaml.load(split.inner, { schema: yaml.CORE_SCHEMA }) as unknown
  } catch (e) {
    return { error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` }
  }
  const checked = CampaignSchema.safeParse(data)
  if (!checked.success) return { error: `invalid campaign: ${describeIssues(checked.error)}` }
  return checked.data
}

/** The file's free-text Log body (everything after the frontmatter); `''` when none. */
export function readCampaignLog(raw: string): string {
  return splitCampaignFile(raw)?.body ?? ''
}

// ---- Ids, paths, exclusive create -------------------------------------------

const MINT_ATTEMPTS = 32

/**
 * Mint a fresh `cmp-<8 hex>` id that is not in `existingIds`, redrawing on a collision.
 * `randomHex` is injectable for tests. Throws rather than loop forever.
 */
export function mintCampaignId(
  existingIds: readonly string[],
  randomHex: () => string = () => randomBytes(4).toString('hex')
): string {
  const taken = new Set(existingIds)
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = `cmp-${randomHex()}`
    if (CAMPAIGN_ID_RE.test(id) && !taken.has(id)) return id
  }
  throw new Error(`could not mint a free campaign id in ${MINT_ATTEMPTS} attempts`)
}

/** The directory every campaign file of a repo lives in (gitignored via `.harnu/`). */
export function campaignsDir(folder: string): string {
  return path.join(dataDirAt(folder), 'campaigns')
}

/**
 * `<folder>/.harnu/campaigns/<id>-<slug>.md`. `folder` is the repo's storage root — the
 * caller resolves it once per repo so every worktree shares one place. Throws on an id or
 * slug that is not path-safe, so a crafted slug can never escape the campaigns directory.
 */
export function campaignFilePath(folder: string, id: string, slug: string): string {
  if (!CAMPAIGN_ID_RE.test(id)) throw new Error(`invalid campaign id: ${id}`)
  if (!CAMPAIGN_SLUG_RE.test(slug)) throw new Error(`invalid campaign slug: ${slug}`)
  return path.join(campaignsDir(folder), `${id}-${slug}.md`)
}

function campaignExistsError(id: string, existing: string): Error {
  return Object.assign(new Error(`EEXIST: campaign ${id} already exists (${existing})`), {
    code: 'EEXIST'
  })
}

const campaignLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` against every other call for the same campaign id (the board's
 * {@link serializeByKey}). Wrap the whole read → mutate → write in `fn`. Not re-entrant —
 * calling it again for the same id from inside `fn` deadlocks, and that includes
 * {@link createCampaignFile}, which takes it too. In-process only, like the mission lock.
 */
export function withCampaignLock<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
  return serializeByKey(campaignLocks, campaignId, fn)
}

/**
 * Create a new campaign file, never overwriting: the write uses `{ flag: 'wx' }`, so a
 * genuine collision rejects with `EEXIST`. The same id under a different slug is the same
 * collision, but the filename embeds the slug so `wx` cannot see it — the directory is
 * checked after the write, and a clash removes the file this call just wrote before
 * rejecting `EEXIST`. Runs under the id's lock. Resolves to the written file's path.
 */
export async function createCampaignFile(
  folder: string,
  campaign: Campaign,
  log = ''
): Promise<string> {
  const content = buildCampaignFileContent(campaign, log) // validates before any I/O
  const file = campaignFilePath(folder, campaign.id, campaign.slug)
  const dir = campaignsDir(folder)
  return withCampaignLock(campaign.id, async () => {
    await mkdirDataDir(dir)
    await writeFile(file, content, { flag: 'wx', encoding: 'utf8' })
    const own = path.basename(file)
    const clash = (await readdir(dir)).find(
      (n) => n !== own && n.startsWith(`${campaign.id}-`) && n.endsWith('.md')
    )
    if (clash) {
      await unlink(file)
      throw campaignExistsError(campaign.id, clash)
    }
    return file
  })
}

// ---- Chapters ----------------------------------------------------------------

/** What a verb may set on a new chapter; the id, ordinal and `missionId` are Harnu's. */
export interface NewChapter {
  title: string
  required: boolean
  consumes?: string[]
  produces?: string[]
  radiant?: Radiant
  discoveredFrom?: Chapter['discoveredFrom']
  unlocks?: ChapterUnlock
}

/** Build one chapter at `ordinal`, dropping the keys the caller left unset. */
export function buildChapter(input: NewChapter, ordinal: number): Chapter {
  return {
    id: `chp-${ordinal}`,
    ordinal,
    title: input.title,
    required: input.required,
    ...(input.discoveredFrom ? { discoveredFrom: input.discoveredFrom } : {}),
    ...(input.unlocks ? { unlocks: input.unlocks } : {}),
    ...(input.produces && input.produces.length > 0 ? { produces: input.produces } : {}),
    ...(input.consumes && input.consumes.length > 0 ? { consumes: input.consumes } : {}),
    ...(input.radiant ? { radiant: input.radiant } : {})
  }
}

/**
 * Append a chapter (spec §3.1: ordered, append-only for agents). Pure. The id and ordinal
 * come from the chapter count, so they are stable and a removed chapter can never be
 * re-issued — there is no removal.
 */
export function applyAddChapter(campaign: Campaign, input: NewChapter, at: string): Campaign {
  const next = structuredClone(campaign)
  const ordinal = next.chapters.reduce((max, c) => Math.max(max, c.ordinal), 0) + 1
  next.chapters.push(buildChapter(input, ordinal))
  next.updatedAt = at
  return next
}

/** One token a chapter consumes that no earlier chapter produces. */
export interface MissingPrerequisite {
  chapterId: string
  title: string
  token: string
}

/**
 * Spec §3.5 — the prerequisite pass. For each chapter at index `from` or later, every token
 * it `consumes` must be `produces`d by a chapter BEFORE it (a chapter never satisfies its
 * own need; a side-quest chapter counts as a producer). Returns every gap, in chapter then
 * token order, so a refusal can name them all. `from` lets `campaign_add_chapter` judge only
 * the chapter it adds: earlier chapters were accepted (or forced) when they were added.
 */
export function missingPrerequisites(
  chapters: readonly Pick<Chapter, 'id' | 'title' | 'consumes' | 'produces'>[],
  from = 0
): MissingPrerequisite[] {
  const out: MissingPrerequisite[] = []
  const produced = new Set<string>()
  chapters.forEach((c, i) => {
    if (i >= from) {
      for (const token of c.consumes ?? []) {
        if (!produced.has(token)) out.push({ chapterId: c.id, title: c.title, token })
      }
    }
    for (const token of c.produces ?? []) produced.add(token)
  })
  return out
}
