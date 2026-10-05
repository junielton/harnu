/**
 * Mission domain core (T358 S1) — the `Mission`/`MissionStep` data model and its
 * on-disk file format (design `docs/specs/2026-09-26-mission-progress/design.md`
 * §1 data model, §9 storage). Mirrors `roadmap-core.ts` for the board.
 *
 * File format: a YAML frontmatter block carrying the full {@link Mission} struct,
 * then a free-text, append-only markdown **Log** body — the owner's narrative,
 * kept for humans and never authoritative for state (design §9, decision 10).
 *
 * Why `js-yaml` and not the board's reader: `roadmap-core.ts`'s frontmatter
 * reader is a shallow, dependency-free parser tailored to flat card fields — it
 * cannot represent `steps[].links[]`/`steps[].blockers[]`. `worktree-manifest.ts`
 * is the existing main-process precedent for real YAML. Every read goes through a
 * zod schema, so a hand-edited or corrupt file degrades to `{ error }`, never to
 * a half-typed `Mission`.
 *
 * Unlike `roadmap-core.ts` this module also owns its two small I/O paths — the
 * exclusive create and the per-mission-id lock — because S1 ships storage with
 * no IPC/verb shell yet to host them; both are exercised against a real temp dir.
 */

import { createHash, randomBytes } from 'node:crypto'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { dataDirAt, mkdirDataDir } from './data-dir'
import type { MissionProgress } from './mission-progress'
import { serializeByKey } from './roadmap-core'

// ---- Data model (design.md §1 — field-for-field) ----------------------------

/** design.md §1.1 — the declared end, required at creation (decision 5). */
export interface DeclaredEnd {
  kind: 'code' | 'ui' | 'research' | 'decision' | 'other'
  target: string
  evidence: string
}

/** design.md §1.4 — a blocker is a flag on a mission or step, never a status. */
export interface Blocker {
  reason: string
  unblocks: string
  owner: 'agent' | 'operator'
  raisedAt: string
}

/** design.md §1.2 — what Harnu derives live signals from (decisions 10/11). */
export interface StepLink {
  kind: 'session' | 'worktree' | 'card' | 'pr'
  ref: string
}

/**
 * Mission v3 §3.6 — a human check on a step: a confirmation of a deliverable the
 * step produced (DSQA, "validated visually", a designer sign-off). The agent, the
 * operator or a verifier creates one; ONLY the operator ticks or deletes it, through
 * the UI doors — no MCP verb writes `ticked`. Checks never change progress.
 */
export interface Check {
  /** `chk-<n>`, unique per step. */
  id: string
  /** ≤ 200 chars; unique per step, case-insensitively. */
  label: string
  source: 'agent' | 'operator' | 'verifier'
  createdAt: string
  /** Only the operator's `tickCheck` door writes this. */
  ticked?: { at: string }
}

/**
 * design.md §1.2 — one step. Mission v3 §3.3: new missions have no fixed start
 * (scope is an attachment); a legacy file keeps its `fixed-start` step on disk,
 * read as scope and excluded from progress. The end is found by `kind`, never id.
 */
export interface MissionStep {
  id: string
  ordinal: number
  kind: 'fixed-start' | 'fixed-end' | 'custom'
  title: string
  verification: 'existence' | 'verifier' | 'human'
  proof: 'unproven' | 'claimed' | 'verified' | 'self-verified'
  verifiedBy?: {
    sessionId: string
    at: string
    verdict?: 'met' | 'unmet' | 'blocked' | 'needs-human'
  }
  links: StepLink[]
  blockers: Blocker[]
  addedReason?: string
  /** Mission v3 §3.1 — when the step was added; legacy steps without it count as original. */
  addedAt?: string
  /** Mission v3 §3.6 — the step's human checks. */
  checks?: Check[]
}

/**
 * design.md §1.1/§9 — where an imported mission came from (`mission_import_legacy`).
 * `needsReview` names the fields the importer filled best-effort rather than read
 * from the legacy file — `declaredEnd` when no explicit target/evidence was found.
 */
export interface LegacyImport {
  /** Absolute path of the `.harnu/goals/*.md` file imported — never modified or deleted. */
  source: string
  /** `sha256:<hex>` of the source file's bytes at import time. */
  sha256: string
  needsReview: 'declaredEnd'[]
}

/** design.md §1.1 — one mission, stored as one `.harnu/missions/<id>-<slug>.md`. */
export interface Mission {
  id: string
  slug: string
  folder: string
  owner: { sessionId: string; folder: string }
  linkedCard?: string
  /**
   * `draft` survives only in legacy files: {@link parseMissionFile} reads it as
   * `active` (Mission v3 §3.4), and no writer produces it any more.
   */
  status: 'draft' | 'active' | 'stale' | 'delivered' | 'closed'
  /** Mission v3 §3.5 — how the operator ended it; set only on a `closed` mission. */
  closedAs?: 'delivered' | 'discarded'
  /** Mission v3 §3.5 — the operator's optional reason for ending it. */
  closeReason?: string
  declaredEnd: DeclaredEnd
  /**
   * The agreement on the declared end. `via: 'chat'` — the end agreed in chat when
   * the mission was created (Mission v3 §3.4); `'operator'` — a re-scope the
   * operator approved. Absent `via` = written before v3.
   */
  declaredEndApproval?: { at: string; bodyHash: string; via?: 'chat' | 'operator' }
  /**
   * Mission v3 §3.3 — the scope documents (spec / PRD / ADR), an attachment that
   * never enters progress. A legacy file has none and keeps them as its fixed
   * start's links instead — read both through {@link missionScope}.
   */
  scope?: StepLink[]
  /**
   * A re-scope `mission_set_end` staged for the operator (decision 6). It lives
   * until the operator approves it ({@link applyApprovedRescope}) or a later
   * `mission_set_end` replaces it — an unrelated edit (a new step, a blocker, a
   * claim) never voids it (design §1.1, resolved in S9).
   */
  pendingRescope?: DeclaredEnd
  steps: MissionStep[]
  /** design.md §1.4 — mission-level blockers (step-level ones live on each step). */
  blockers: Blocker[]
  openQuestions: string[]
  pendingClose?: { at: string; requestedBy: string }
  createdAt: string
  updatedAt: string
  provenance: { author: 'agent' | 'human'; at: string; branch?: string }
  /** design.md §9 — set only on a mission imported from a legacy goal file. */
  legacy?: LegacyImport
  /** design.md §9 — that legacy file's full content, byte-for-byte (the no-loss guarantee). */
  legacyRaw?: string
}

// ---- Validation schemas (one per interface, typed against it) ---------------

/** `mnt-<8 hex>` — minted by {@link mintMissionId}. */
export const MISSION_ID_RE = /^mnt-[0-9a-f]{8}$/
/** `stp-<n>` — ordinal-stable once assigned (design §1.2). */
export const STEP_ID_RE = /^stp-\d+$/
/** Kebab slug, the same shape card slugs use; also keeps the filename path-safe. */
export const MISSION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const DeclaredEndSchema: z.ZodType<DeclaredEnd> = z.object({
  kind: z.enum(['code', 'ui', 'research', 'decision', 'other']),
  target: z.string(),
  evidence: z.string()
})

// Mission v3 §6: every mission object schema is `.passthrough()` — a key a later
// Harnu adds survives a read → write by this one instead of being stripped, so a
// version skew never loses data again (this is the last release with that risk).

const BlockerSchema: z.ZodType<Blocker> = z
  .object({
    reason: z.string(),
    unblocks: z.string(),
    owner: z.enum(['agent', 'operator']),
    raisedAt: z.string()
  })
  .passthrough()

const StepLinkSchema: z.ZodType<StepLink> = z
  .object({
    kind: z.enum(['session', 'worktree', 'card', 'pr']),
    ref: z.string()
  })
  .passthrough()

const CheckSchema: z.ZodType<Check> = z
  .object({
    id: z.string(),
    label: z.string(),
    source: z.enum(['agent', 'operator', 'verifier']),
    createdAt: z.string(),
    ticked: z.object({ at: z.string() }).passthrough().optional()
  })
  .passthrough()

const MissionStepSchema: z.ZodType<MissionStep> = z
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
        verdict: z.enum(['met', 'unmet', 'blocked', 'needs-human']).optional()
      })
      .optional(),
    links: z.array(StepLinkSchema),
    blockers: z.array(BlockerSchema),
    addedReason: z.string().optional(),
    addedAt: z.string().optional(),
    checks: z.array(CheckSchema).optional()
  })
  .passthrough()

/** Key order here is the key order written to disk — the design's field order. */
const MissionSchema: z.ZodType<Mission> = z
  .object({
    id: z.string().regex(MISSION_ID_RE),
    slug: z.string().regex(MISSION_SLUG_RE),
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
    // Defaulted, not required: a file written before mission-level blockers
    // existed (T358 S1–S3) still reads, as "no blockers".
    blockers: z.array(BlockerSchema).default([]),
    openQuestions: z.array(z.string()),
    pendingClose: z.object({ at: z.string(), requestedBy: z.string() }).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    provenance: z.object({
      author: z.enum(['agent', 'human']),
      at: z.string(),
      branch: z.string().optional()
    }),
    // T358 S7: declared here, not left to zod's default key-stripping — a field the
    // schema does not name is silently dropped on the next read → write (S1 F2).
    legacy: z
      .object({
        source: z.string(),
        sha256: z.string(),
        needsReview: z.array(z.enum(['declaredEnd']))
      })
      .optional(),
    legacyRaw: z.string().optional()
  })
  .passthrough()

/** Collapse zod issues into one line: `steps.1.proof: Invalid option …`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

// ---- File format (design.md §9) ---------------------------------------------

/** Split a file into its leading frontmatter (inner text) and body (the Log). */
function splitMissionFile(raw: string): { inner: string; body: string } | null {
  const open = /^---\r?\n/.exec(raw)
  if (!open) return null
  const afterOpen = raw.slice(open[0].length)
  // The fence may close the frontmatter immediately (empty inner text).
  const close = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(afterOpen)
  if (!close) return null
  return {
    inner: afterOpen.slice(0, close.index),
    body: afterOpen.slice(close.index + close[0].length)
  }
}

/**
 * Serialize a mission to its file content: frontmatter carrying every
 * {@link Mission} field, then `log` verbatim as the body. Throws on a mission
 * that fails validation — writing an invalid file must fail loudly, not land a
 * record every later read would reject.
 *
 * Dumped with js-yaml's DEFAULT schema, which quotes any string that would read
 * back as another type (`'123'`, `'true'`, `'null'`, ISO timestamps), so the
 * CORE-schema read in {@link parseMissionFile} gets every string back as a string.
 */
export function buildMissionFileContent(mission: Mission, log = ''): string {
  const checked = MissionSchema.safeParse(mission)
  if (!checked.success) {
    throw new Error(`invalid mission: ${describeIssues(checked.error)}`)
  }
  const frontmatter = yaml.dump(checked.data, {
    lineWidth: -1, // never fold long strings — a folded scalar is harder to diff
    noRefs: true,
    skipInvalid: true // drops keys an optional field left explicitly `undefined`
  }) as string
  return `---\n${frontmatter}---\n${log}`
}

/**
 * Parse a mission file back into a validated {@link Mission}. Never throws: a
 * missing frontmatter, a YAML syntax error or a schema mismatch all return
 * `{ error }` naming what was wrong. Read with js-yaml's CORE schema so a
 * hand-edited, unquoted timestamp stays a string instead of becoming a `Date`.
 */
export function parseMissionFile(raw: string): Mission | { error: string } {
  const split = splitMissionFile(raw)
  if (!split) return { error: 'no frontmatter block' }
  let data: unknown
  try {
    data = yaml.load(split.inner, { schema: yaml.CORE_SCHEMA }) as unknown
  } catch (e) {
    return { error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` }
  }
  const checked = MissionSchema.safeParse(data)
  if (!checked.success) return { error: `invalid mission: ${describeIssues(checked.error)}` }
  const mission = checked.data
  // Mission v3 §3.4: there is no draft any more. A legacy draft reads as active
  // everywhere (the hibernation exemption, the stall rule, every reader); the next
  // write persists it. `draft` stays in the enum so old files keep parsing.
  if (mission.status === 'draft') mission.status = 'active'
  return mission
}

/**
 * Mission v3 §3.3 — the mission's scope documents: `mission.scope` when set,
 * else a legacy fixed start's links (the file is never rewritten for this).
 */
export function missionScope(mission: Pick<Mission, 'scope' | 'steps'>): StepLink[] {
  if (mission.scope) return mission.scope
  return mission.steps.find((s) => s.kind === 'fixed-start')?.links ?? []
}

/** The file's free-text Log body (everything after the frontmatter); `''` when none. */
export function readMissionLog(raw: string): string {
  return splitMissionFile(raw)?.body ?? ''
}

// ---- Ids, paths, exclusive create (design.md §9) ----------------------------

/** How many draws {@link mintMissionId} tries before giving up (2^32 space). */
const MINT_ATTEMPTS = 32

/**
 * Mint a fresh `mnt-<8 hex>` id that is not in `existingIds`, redrawing on a
 * collision. `randomHex` is injectable for tests; production draws 4 random
 * bytes. Throws rather than loop forever if every draw collides (only reachable
 * with a broken random source).
 */
export function mintMissionId(
  existingIds: readonly string[],
  randomHex: () => string = () => randomBytes(4).toString('hex')
): string {
  const taken = new Set(existingIds)
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = `mnt-${randomHex()}`
    if (MISSION_ID_RE.test(id) && !taken.has(id)) return id
  }
  throw new Error(`could not mint a free mission id in ${MINT_ATTEMPTS} attempts`)
}

/** The directory every mission file of a repo lives in (gitignored via `.harnu/`). */
export function missionsDir(folder: string): string {
  return path.join(dataDirAt(folder), 'missions')
}

/**
 * `<folder>/.harnu/missions/<id>-<slug>.md`. `folder` is the repo's storage root
 * — the caller resolves it once per repo so every worktree shares one place
 * (design §9, decision 17). Throws on an id or slug that is not path-safe, so a
 * crafted slug can never escape the missions directory.
 */
export function missionFilePath(folder: string, id: string, slug: string): string {
  if (!MISSION_ID_RE.test(id)) throw new Error(`invalid mission id: ${id}`)
  if (!MISSION_SLUG_RE.test(slug)) throw new Error(`invalid mission slug: ${slug}`)
  return path.join(missionsDir(folder), `${id}-${slug}.md`)
}

/** An `EEXIST`-coded error, the same shape `fs` raises for a `wx` collision. */
function missionExistsError(id: string, existing: string): Error {
  return Object.assign(new Error(`EEXIST: mission ${id} already exists (${existing})`), {
    code: 'EEXIST'
  })
}

/**
 * Create a new mission file, never overwriting (mirrors `createCardFile` in
 * `roadmap-ipc.ts`): the write uses `{ flag: 'wx' }`, so a genuine collision
 * rejects with `EEXIST` instead of silently replacing a mission. The same id
 * under a different slug is the same collision, but the filename embeds the
 * slug so `wx` cannot see it — the directory is checked after the write, and a
 * clash removes the file this call just wrote before rejecting `EEXIST`.
 *
 * The write → check → rollback runs under {@link withMissionIdMintLock} for the
 * mission's id: unserialized, two same-id creates with different slugs could
 * both see the other's file and both roll back, leaving no mission at all. With
 * the lock exactly one lands (in-process; same limit as the lock itself). Do not
 * call this from inside `withMissionIdMintLock` for the same id — it deadlocks.
 * Resolves to the written file's path.
 */
export async function createMissionFile(
  folder: string,
  mission: Mission,
  log = ''
): Promise<string> {
  const content = buildMissionFileContent(mission, log) // validates before any I/O
  const file = missionFilePath(folder, mission.id, mission.slug)
  const dir = missionsDir(folder)
  return withMissionIdMintLock(mission.id, async () => {
    await mkdirDataDir(dir)
    await writeFile(file, content, { flag: 'wx', encoding: 'utf8' })
    const own = path.basename(file)
    const clash = (await readdir(dir)).find(
      (n) => n !== own && n.startsWith(`${mission.id}-`) && n.endsWith('.md')
    )
    if (clash) {
      await unlink(file)
      throw missionExistsError(mission.id, clash)
    }
    return file
  })
}

// ---- Controlled fields + per-mission-id lock (design.md §4, §9) -------------

/**
 * Step fields `mission_update_step` refuses in its `set` — they change only
 * through `mission_verify_step` or the operator's UI (design §4, the same
 * posture as `update_card` refusing `status`/`approved`).
 */
export const MISSION_STEP_CONTROLLED_FIELDS = ['proof', 'verifiedBy'] as const

/** Per-mission-id promise chains — serializes {@link withMissionIdMintLock} calls. */
const missionLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` against every other call for the same `missionId`, via the
 * board's {@link serializeByKey}. Keyed by mission id, not repo (design §9,
 * Review Focus #2): an owner handling two children's reports back-to-back must
 * not lose one read-modify-write, while writes to unrelated missions in the
 * same repo never queue behind each other. Wrap the whole read → mutate →
 * write in `fn`. Not re-entrant — calling it again for the same id from inside
 * `fn` deadlocks (this includes {@link createMissionFile}, which takes it
 * too). In-process only: two Harnu processes are not covered (the same limit
 * `roadmap-ipc.ts` accepts).
 */
export function withMissionIdMintLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
  return serializeByKey(missionLocks, missionId, fn)
}

// ---- Operator doors (design.md §3 — UI-only, no MCP verb) -------------------
//
// The state transitions ONLY the operator makes. No `mission_*` verb calls
// these (T358 S4 AC-S4-2, S9 AC-S9-7): the agent stages a re-scope
// (`mission_set_end` → `pendingRescope`) or requests a close
// (`mission_request_close` → `pendingClose`), and the operator's UI applies it
// through `mission-ipc.ts` (S9). Mission v3 §3.4/§3.5: there is no draft to
// approve; the one end door (close or discard) works on any open mission. All
// are pure — the caller does the locked read → apply → write.

/** `sha256:<hex>` of a declared end — the approval stamp a re-scope voids (design §3). */
export function declaredEndHash(end: DeclaredEnd): string {
  const canonical = JSON.stringify([end.kind, end.target, end.evidence])
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Every open blocker on the mission — its own and every step's (design §1.4). */
export function openBlockerCount(mission: Mission): number {
  return mission.blockers.length + mission.steps.reduce((n, s) => n + s.blockers.length, 0)
}

/**
 * Mission v3 §3.4 — a mission is STARTED once any step has a link (a legacy fixed
 * start's links are scope, not work) or a proof other than `unproven`. Before
 * that, steps are planning: `mission_add_step` needs no reason for them.
 */
export function isStarted(mission: Pick<Mission, 'steps'>): boolean {
  return mission.steps.some(
    (s) => s.kind !== 'fixed-start' && (s.links.length > 0 || s.proof !== 'unproven')
  )
}

/** The `fixed-end` step — `steps[last]` by construction (decision 4). */
export function fixedEndStep(mission: Mission): MissionStep | undefined {
  return mission.steps.find((s) => s.kind === 'fixed-end')
}

/** `verifiedBy.sessionId` on a step the operator verified from the UI — never a session UUID. */
export const OPERATOR_VERIFIER = 'operator'

// ---- Human checks (Mission v3 §3.6) -----------------------------------------
//
// A check is a human confirmation of a deliverable a step produced. The agent
// (`mission_add_check`), a verifier (`mission_verify_step` → `needs-human`) and
// the operator (the `addCheck` door) create them; ONLY the operator ticks or
// deletes one (`applyTickCheck` / `applyDeleteCheck`, reached from
// `mission-ipc.ts` only). Trust is convention plus audit, like the proof label.
// Checks never change a step's state or the headline.

/** Longest check label (Mission v3 §3.6). */
export const CHECK_LABEL_MAX = 200

/** A mission a check can be written on: any but `closed`. */
function assertCheckable(mission: Mission): void {
  if (mission.status === 'closed') {
    throw new Error(
      `MISSION_CLOSED: mission ${mission.id} was closed by the operator — its checks are a record now.`
    )
  }
}

function checkStep(mission: Mission, stepId: string): MissionStep {
  const step = mission.steps.find((s) => s.id === stepId)
  if (!step) {
    throw new Error(
      `STEP_NOT_FOUND: mission ${mission.id} has no step ${stepId} — mission_get lists its steps.`
    )
  }
  return step
}

/** A check label as stored: whitespace collapsed, trimmed; throws BAD_ARGS when empty or too long. */
export function normalizeCheckLabel(raw: string): string {
  const label = raw.replace(/\s+/g, ' ').trim()
  if (!label || label.length > CHECK_LABEL_MAX) {
    throw new Error(`BAD_ARGS: a check label is 1..${CHECK_LABEL_MAX} characters.`)
  }
  return label
}

/**
 * Add a check to a step. Labels are unique per step, case-insensitively: a label
 * already there (from anyone) is kept as it is — the first creator's source and
 * spelling win — and nothing is added. Pure; throws STEP_NOT_FOUND, BAD_ARGS or
 * MISSION_CLOSED.
 */
export function applyAddCheck(
  mission: Mission,
  stepId: string,
  label: string,
  source: Check['source'],
  at: string
): Mission {
  assertCheckable(mission)
  const clean = normalizeCheckLabel(label)
  const next = structuredClone(mission)
  const step = checkStep(next, stepId)
  const checks = step.checks ?? []
  if (checks.some((c) => c.label.toLowerCase() === clean.toLowerCase())) return next
  const n = checks.reduce((max, c) => Math.max(max, Number(/^chk-(\d+)$/.exec(c.id)?.[1] ?? 0)), 0)
  step.checks = [...checks, { id: `chk-${n + 1}`, label: clean, source, createdAt: at }]
  next.updatedAt = at
  return next
}

function findCheck(mission: Mission, step: MissionStep, checkId: string): Check {
  const check = step.checks?.find((c) => c.id === checkId)
  if (!check) {
    throw new Error(
      `CHECK_NOT_FOUND: step ${step.id} of mission ${mission.id} has no check ${checkId}.`
    )
  }
  return check
}

/** The operator's door: tick (or un-tick) a check. The only writer of `ticked`. */
export function applyTickCheck(
  mission: Mission,
  stepId: string,
  checkId: string,
  mark: { at: string; ticked: boolean }
): Mission {
  assertCheckable(mission)
  const next = structuredClone(mission)
  const check = findCheck(next, checkStep(next, stepId), checkId)
  if (mark.ticked) check.ticked = { at: mark.at }
  else delete check.ticked
  next.updatedAt = mark.at
  return next
}

/** The operator's door: delete a check. The agent can add checks, never remove them. */
export function applyDeleteCheck(
  mission: Mission,
  stepId: string,
  checkId: string,
  op: { at: string }
): Mission {
  assertCheckable(mission)
  const next = structuredClone(mission)
  const step = checkStep(next, stepId)
  findCheck(next, step, checkId)
  step.checks = (step.checks ?? []).filter((c) => c.id !== checkId)
  next.updatedAt = op.at
  return next
}

/**
 * The operator ticked (or un-ticked) a `human`-level step (design §1.3): the
 * only way such a step's proof moves — `mission_verify_step` refuses a `human`
 * step. Ticking records `verified` with the operator as the verifier; un-ticking
 * returns the step to `unproven`. Throws on an unknown step, a step of any other
 * verification level, or a mission that is not in play (`draft`/`closed`).
 */
export function applyOperatorVerifyStep(
  mission: Mission,
  stepId: string,
  mark: { at: string; verified: boolean }
): Mission {
  if (mission.status === 'draft' || mission.status === 'closed') {
    throw new Error(`mission ${mission.id} is ${mission.status} — steps are not verified there`)
  }
  const next = structuredClone(mission)
  const step = next.steps.find((s) => s.id === stepId)
  if (!step) throw new Error(`mission ${mission.id} has no step ${stepId}`)
  if (step.verification !== 'human') {
    throw new Error(
      `step ${stepId} is ${step.verification}-level — only a human step is the operator's`
    )
  }
  if (mark.verified) {
    step.proof = 'verified'
    step.verifiedBy = { sessionId: OPERATOR_VERIFIER, at: mark.at, verdict: 'met' }
  } else {
    step.proof = 'unproven'
    delete step.verifiedBy
  }
  next.updatedAt = mark.at
  return next
}

/**
 * The operator approved a staged re-scope (design §3, decision 6): the pending
 * end becomes the declared end under a fresh approval stamp, and the fixed-end
 * step's proof is VOIDED back to `unproven` — from `verified` and from
 * `self-verified` alike (Review Focus #4) — because the old proof was about a
 * target that no longer exists. For the same reason a pending close is voided,
 * and a `delivered` mission goes back to `active`. An imported mission's
 * `legacy.needsReview` loses `declaredEnd`: the operator just approved one.
 * Throws when nothing is staged.
 */
export function applyApprovedRescope(mission: Mission, approval: { at: string }): Mission {
  if (!mission.pendingRescope) {
    throw new Error(`mission ${mission.id} has no pending re-scope to approve`)
  }
  const next = structuredClone(mission)
  const declaredEnd = next.pendingRescope as DeclaredEnd
  delete next.pendingRescope
  delete next.pendingClose
  next.declaredEnd = declaredEnd
  next.declaredEndApproval = {
    at: approval.at,
    bodyHash: declaredEndHash(declaredEnd),
    via: 'operator'
  }
  for (const step of next.steps) {
    if (step.kind !== 'fixed-end') continue
    step.proof = 'unproven'
    delete step.verifiedBy
  }
  if (next.status === 'delivered') next.status = 'active'
  // An imported mission's best-effort declared end is now one the operator
  // approved — it no longer needs review (T358 S7, design §9).
  if (next.legacy) {
    next.legacy.needsReview = next.legacy.needsReview.filter((f) => f !== 'declaredEnd')
  }
  next.updatedAt = approval.at
  return next
}

/** A refusal code of `mission_request_close` (Mission v2 §3.5; v3 dropped the draft refusal). */
export type RequestCloseRefusalCode =
  'MISSION_CLOSED' | 'END_NOT_VERIFIED' | 'OPEN_BLOCKERS' | 'RESCOPE_PENDING'

/**
 * What `mission_request_close` would refuse right now (Mission v2 §3.5) — the
 * same checks, in the same order, so `mission_get.closeReadiness` and the verb
 * can never disagree. `null` = a request would land `delivered` + `pendingClose`.
 * It also refuses a staged re-scope: the operator approves (or replaces) that
 * first, since approving it voids the end's proof.
 */
export function requestCloseRefusal(
  mission: Mission
): { code: RequestCloseRefusalCode; reason: string } | null {
  if (mission.status === 'closed') {
    return {
      code: 'MISSION_CLOSED',
      reason: `mission ${mission.id} was closed by the operator — a closed mission is immutable by verb.`
    }
  }
  const end = fixedEndStep(mission)
  if (end?.proof !== 'verified') {
    return {
      code: 'END_NOT_VERIFIED',
      reason: `the fixed end (${end?.id ?? 'missing'}) is ${end?.proof ?? 'missing'} — a close needs it verified via mission_verify_step by a session that built none of the steps${end?.proof === 'self-verified' ? '; self-verified never counts' : ''}.`
    }
  }
  const open = openBlockerCount(mission)
  if (open > 0) {
    return {
      code: 'OPEN_BLOCKERS',
      reason: `mission ${mission.id} has ${open} open blocker(s) — clear them with mission_clear_blocker first.`
    }
  }
  if (mission.pendingRescope) {
    return {
      code: 'RESCOPE_PENDING',
      reason: `mission ${mission.id} has a staged re-scope — the operator approves it (which resets the fixed end's proof) before a close can be requested.`
    }
  }
  return null
}

/** Mission v3 §3.5 — one thing the operator should know before ending a mission. */
export interface CloseWarning {
  kind: 'end-unverified' | 'left-behind' | 'checks-open' | 'blockers-open' | 'rescope-staged'
  detail: string
}

/**
 * What the end dialog shows (Mission v3 §3.5): every open matter, computed in
 * one place. These are WARNINGS — the operator can end any non-closed mission
 * anyway; nothing here refuses.
 */
export function closeWarnings(mission: Mission, progress: MissionProgress): CloseWarning[] {
  const out: CloseWarning[] = []
  const end = fixedEndStep(mission)
  if (end?.proof !== 'verified') {
    out.push({
      kind: 'end-unverified',
      detail: `the end (${end?.id ?? 'missing'}) is ${end?.proof ?? 'missing'}, not verified`
    })
  }
  if (progress.leftBehind.length > 0) {
    out.push({
      kind: 'left-behind',
      detail: `${progress.leftBehind.length} step(s) left behind: ${progress.leftBehind.join(', ')}`
    })
  }
  const open = mission.steps.flatMap((s) =>
    (s.checks ?? []).filter((c) => !c.ticked).map((c) => `${s.id}: ${c.label}`)
  )
  if (open.length > 0) {
    out.push({
      kind: 'checks-open',
      detail: `${open.length} unticked check(s) — ${open.join('; ')}`
    })
  }
  const blockers = openBlockerCount(mission)
  if (blockers > 0) out.push({ kind: 'blockers-open', detail: `${blockers} open blocker(s)` })
  if (mission.pendingRescope) {
    out.push({
      kind: 'rescope-staged',
      detail: `a re-scope is staged: ${mission.pendingRescope.kind} · ${mission.pendingRescope.target}`
    })
  }
  return out
}

/**
 * The operator ended a mission (Mission v3 §3.5) — the ONE end door: "close as
 * delivered" or "discard", with an optional reason, on any mission that is not
 * already closed. It never refuses on open matters ({@link closeWarnings} shows
 * them first). The mission becomes `closed` with `closedAs`; a pending close is
 * consumed; the file stays on disk as the record. No verb reaches this — the
 * agent's side is `mission_request_close`. Throws `MISSION_CLOSED` on a closed
 * mission, so a double click is a refusal, never a second write.
 */
export function applyOperatorEnd(
  mission: Mission,
  end: { at: string; closedAs: 'delivered' | 'discarded'; reason?: string }
): Mission {
  if (mission.status === 'closed') {
    throw new Error(
      `MISSION_CLOSED: mission ${mission.id} is already closed (${mission.closedAs ?? 'closed'}).`
    )
  }
  const next = structuredClone(mission)
  delete next.pendingClose
  next.status = 'closed'
  next.closedAs = end.closedAs
  const reason = end.reason?.replace(/\s+/g, ' ').trim()
  if (reason) next.closeReason = reason
  else delete next.closeReason
  next.updatedAt = end.at
  return next
}
