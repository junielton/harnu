/**
 * Missions v4 S-6 (AC-9) — the v4 record: Mission, optional Milestone, Step, acceptance criterion,
 * session entry, blocker with an id, and the attach request.
 *
 * One Markdown file with YAML frontmatter and an append-only Log, in `.harnu/missions-v4/` (spec
 * "Design · The model"). This module is only the SHAPE: the schemas, their types, and the two pure
 * functions that turn a record into file text and back. It reads no file, derives no state and applies
 * no writing-contract rule. Every slice that reads or writes a v4 record imports it, so the names here
 * are the contract.
 *
 * Three rules shape every schema:
 *
 * - **`.passthrough()` everywhere.** A key the schema does not name survives a read → write
 *   (`legacyV3`, `ledger`, `outcome`, `memoryDrafts`, a field a later build adds), exactly as the v3
 *   schemas behave.
 * - **Caps are never applied on read** (spec "The writing contract"): a record written by an older
 *   build, or converted from v3, may hold a title longer than today's cap and must still open. The
 *   caps live in `contract.ts` and are enforced by the verbs on write.
 * - **A read is lenient where the converter or an older write may omit.** `milestones`, `sessions`,
 *   `links` and `blockers` default to empty, a step's `acs` too; the "at least one criterion" rule is
 *   a write rule of the verbs, not a reason to refuse a record on open.
 *
 * Names that exist in `mission-core.ts` for v3 (`Mission`, `MissionStep`, `Blocker`) carry a `V4`
 * suffix here so a file that imports both reads clearly.
 *
 * Pure and Electron-free: tests import it with nothing mocked.
 */

import yaml from 'js-yaml'
import { z } from 'zod'

// ---- Ids ---------------------------------------------------------------------

/** `mnt-<8 hex>`, the same id a v3 mission has, so a running session's prompt keeps working. */
export const MISSION_V4_ID_RE = /^mnt-[0-9a-f]{8}$/
/** `mls-<n>`, numbered from 1 in plan order. */
export const MILESTONE_ID_RE = /^mls-\d+$/
/** `stp-<n>`, numbered from 1; an id is never reused. */
export const STEP_V4_ID_RE = /^stp-\d+$/
/** `ac-<n>`, numbered from 1 within its step. */
export const CRITERION_ID_RE = /^ac-\d+$/
/** `blk-<n>`, numbered from 1; v3 blockers had no id and convert to `blk-1` and up. */
export const BLOCKER_V4_ID_RE = /^blk-\d+$/
/** `atr-<n>`, one attach request. */
export const ATTACH_REQUEST_ID_RE = /^atr-\d+$/

// ---- Closed vocabularies ------------------------------------------------------

/** What Harnu reads itself to settle a criterion (spec "What settles a criterion", row 1). */
export const FACTS = ['pr-opened', 'ci-green', 'pr-merged', 'main-green', 'link-exists'] as const
export type Fact = (typeof FACTS)[number]

/** Who or what settles a criterion: a fact, a second session, the operator, another person. */
export const CRITERION_BY = ['fact', 'session', 'operator', 'person'] as const
export type CriterionBy = (typeof CRITERION_BY)[number]

/** What a link points at. A `card` link is gone: a dispatched step names its card in `card`. */
export const LINK_KINDS = ['session', 'pr', 'worktree', 'url', 'doc'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

/** The facts a blocker may wait for (`clearsWhen`, D-12). */
export const CLEARS_WHEN = ['pr-merged', 'ci-green', 'main-green'] as const
export type ClearsWhen = (typeof CLEARS_WHEN)[number]

/** Whose move a blocker is. */
export const BLOCKER_OWNERS = ['agent', 'operator'] as const

/** A session is attached as the one that leads or as one that worked a step (a session history row; an attach request has no role). */
export const SESSION_ROLES = ['leads', 'worked'] as const
export type SessionRole = (typeof SESSION_ROLES)[number]

/** `open` or `closed`; "ready to close" is derived, never stored. */
export const MISSION_STATUSES = ['open', 'closed'] as const

/** What the operator decided on an attach request; `null` while it is pending. */
export const ATTACH_DECISIONS = ['allowed', 'denied'] as const

// ---- State vocabulary -----------------------------------------------------------

/*
 * One state vocabulary (spec "One state vocabulary"), named once as IDENTIFIERS: kebab-case keys that
 * `state.ts` (S-7) returns and the renderer translates through i18n, so a display word is never a key.
 * A step is `todo`, `running`, `waiting-review` or `done`; blocked is a mark on a step, never a fifth
 * state. The card slice (S-10) maps the board's columns onto these too, so both import them from here.
 */
export const STEP_STATES = ['todo', 'running', 'waiting-review', 'done'] as const
export type StepState = (typeof STEP_STATES)[number]

/** A milestone's state, derived from its steps. */
export const MILESTONE_STATES = ['not-started', 'in-progress', 'waiting-review', 'done'] as const
export type MilestoneState = (typeof MILESTONE_STATES)[number]

/** A mission is `open`, `ready-to-close` (every required step is done; derived) or `closed`. */
export const MISSION_STATES = ['open', 'ready-to-close', 'closed'] as const
export type MissionState = (typeof MISSION_STATES)[number]

/**
 * The English words of the spec's vocabulary, for AGENT-FACING text only (a verb's ACK, a summary, a
 * skill): the pane and the pill translate the identifier through i18n instead. Every identifier above
 * has a word, and none is a word the writing contract refuses: "in review" and "driver" are never
 * here. Not to be confused with `STATE_WORDS` in `contract.ts`, the six words a title may not be. (`to do`, `running` and `done` are fine as a state; the contract only refuses a TITLE that is
 * nothing but one.)
 */
export const STATE_LABELS: Readonly<Record<StepState | MilestoneState | MissionState, string>> =
  Object.freeze({
    todo: 'to do',
    running: 'running',
    'waiting-review': 'waiting for review',
    done: 'done',
    'not-started': 'not started',
    'in-progress': 'in progress',
    open: 'open',
    'ready-to-close': 'ready to close',
    closed: 'closed'
  })

// ---- Entities -----------------------------------------------------------------

/*
 * Each entity is a CLOSED interface, written by hand (as `mission-core.ts` does for v3), and its schema
 * is annotated with it: a misspelt field (`step.titel`, a literal with `critera: []`) is a compile
 * error in every slice that imports these types. The schemas stay `.passthrough()`, so at RUNTIME a key
 * the interface does not name still survives a parse and the file round trip. A caller that reads such
 * a key on purpose names it with {@link WithUnknownKeys}.
 */

/**
 * The one way to read a key the closed types do not name, on purpose: a later build's field, or a
 * value the compatibility reader keeps. `(step as WithUnknownKeys<StepV4>).futureKey` is `unknown`.
 */
export type WithUnknownKeys<T> = T & { [key: string]: unknown }

/** A link on a step or on the mission. */
export interface MissionLink {
  kind: LinkKind
  ref: string
}

export const LinkSchema: z.ZodType<MissionLink> = z
  .object({ kind: z.enum(LINK_KINDS), ref: z.string() })
  .passthrough()

/**
 * The stamp a human-shaped criterion carries once settled (`{ at, by, evidence }`): `by` is the second
 * session's id, or `operator`; `person` names the other person when the operator marked it for them.
 */
export interface Settled {
  at: string
  by: string
  evidence?: string
  person?: string
}

export const SettledSchema: z.ZodType<Settled> = z
  .object({
    at: z.string(),
    by: z.string(),
    evidence: z.string().optional(),
    person: z.string().optional()
  })
  .passthrough()

/**
 * A builder's own check of a criterion: labelled, and never proof. `by` is the session that built the
 * step. It sits beside `settled` and never replaces it: a criterion with a self-check and no `settled`
 * is still open (spec "Facts, and who is trusted": a self-check is labelled and never proof).
 */
export interface SelfCheck {
  at: string
  by: string
  evidence: string
}

export const SelfCheckSchema: z.ZodType<SelfCheck> = z
  .object({ at: z.string(), by: z.string(), evidence: z.string() })
  .passthrough()

/**
 * An acceptance criterion: a fact that is true when its step is done. `fact` names the thing Harnu
 * reads and is required when `by` is `fact`; `person` names who approves when `by` is `person`.
 * A criterion tied to a fact is settled by the fact (derived, never stored); `settled` is stored only
 * for the three human-shaped ways.
 */
export interface AcceptanceCriterion {
  id: string
  text: string
  by: CriterionBy
  fact?: Fact
  person?: string
  settled?: Settled
  selfCheck?: SelfCheck
}

export const CriterionSchema: z.ZodType<AcceptanceCriterion> = z
  .object({
    id: z.string().regex(CRITERION_ID_RE),
    text: z.string(),
    by: z.enum(CRITERION_BY),
    fact: z.enum(FACTS).optional(),
    person: z.string().optional(),
    settled: SettledSchema.optional(),
    selfCheck: SelfCheckSchema.optional()
  })
  .passthrough()
  .refine((c) => c.by !== 'fact' || c.fact !== undefined, {
    message: 'a criterion settled by a fact names the fact',
    path: ['fact']
  })

/**
 * A blocker with an id. `reason` is the exact thing needed; `ask` and `unblocks` are the next-step
 * wording and are optional on read because a blocker converted from v3 has neither. `clearsWhen` is a
 * fact that, once it holds, stops the blocker showing with no manual clear. `raisedAt` is what a
 * reminder's age is counted from.
 */
export interface BlockerV4 {
  id: string
  reason: string
  ask?: string
  unblocks?: string
  owner: 'agent' | 'operator'
  clearsWhen?: ClearsWhen
  raisedAt?: string
}

export const BlockerSchema: z.ZodType<BlockerV4> = z
  .object({
    id: z.string().regex(BLOCKER_V4_ID_RE),
    reason: z.string(),
    ask: z.string().optional(),
    unblocks: z.string().optional(),
    owner: z.enum(BLOCKER_OWNERS),
    clearsWhen: z.enum(CLEARS_WHEN).optional(),
    raisedAt: z.string().optional()
  })
  .passthrough()

/**
 * An optional stop on the way. A milestone holds no criteria of its own: they live on its steps, so
 * a milestone that carries `acs` (or `criteria`) is refused rather than silently ignored.
 */
export interface Milestone {
  id: string
  title: string
  optional: boolean
  waitsFor: string | null
}

export const MilestoneSchema: z.ZodType<Milestone> = z
  .object({
    id: z.string().regex(MILESTONE_ID_RE),
    title: z.string(),
    optional: z.boolean().default(false),
    waitsFor: z.string().nullable().default(null),
    acs: z.never().optional(),
    criteria: z.never().optional()
  })
  .passthrough()

/**
 * One unit of work, one pull request. `card` is set only when the step is dispatched to its own session
 * or worktree; `startedAt` when a dispatched step starts or the leader starts one it does itself.
 */
export interface StepV4 {
  id: string
  milestone?: string
  title: string
  optional?: boolean
  card?: string
  startedAt?: string
  acs: AcceptanceCriterion[]
  links: MissionLink[]
  blockers: BlockerV4[]
  waitsFor?: string | null
}

export const StepSchema: z.ZodType<StepV4> = z
  .object({
    id: z.string().regex(STEP_V4_ID_RE),
    milestone: z.string().regex(MILESTONE_ID_RE).optional(),
    title: z.string(),
    optional: z.boolean().optional(),
    card: z.string().optional(),
    startedAt: z.string().optional(),
    acs: z.array(CriterionSchema).default([]),
    links: z.array(LinkSchema).default([]),
    blockers: z.array(BlockerSchema).default([]),
    waitsFor: z.string().nullable().optional()
  })
  .passthrough()

/**
 * Where a session stopped: the step it was on and what it was waiting for. Both optional; the
 * hand-off writes them, a session that is still working has `stoppedAt: null`.
 */
export interface StoppedAt {
  step?: string
  waitingFor?: string
}

export const StoppedAtSchema: z.ZodType<StoppedAt> = z
  .object({ step: z.string().optional(), waitingFor: z.string().optional() })
  .passthrough()

/** One row of the mission's session history. A mission has at most one `leads` open at a time. */
export interface SessionEntry {
  id: string
  role: SessionRole
  from: string
  to: string | null
  stoppedAt?: StoppedAt | null
}

export const SessionEntrySchema: z.ZodType<SessionEntry> = z
  .object({
    id: z.string(),
    role: z.enum(SESSION_ROLES),
    from: z.string(),
    to: z.string().nullable(),
    stoppedAt: StoppedAtSchema.nullable().optional()
  })
  .passthrough()

/**
 * A session's request to JOIN a mission that exists, and what the operator answered. Nobody asks to
 * lead: a session that creates a mission leads it (operator's decision, spec amendment C3-32). The
 * verb that writes it and the door that reads it share this one definition. `decision` is `null`
 * while the request is pending; the mission record holds the requests in `attachRequests`.
 */
export interface AttachRequest {
  id: string
  missionId: string
  sessionId: string
  at: string
  decision: 'allowed' | 'denied' | null
  decidedAt?: string
}

export const AttachRequestSchema: z.ZodType<AttachRequest> = z
  .object({
    id: z.string().regex(ATTACH_REQUEST_ID_RE),
    missionId: z.string().regex(MISSION_V4_ID_RE),
    sessionId: z.string().min(1),
    at: z.string(),
    decision: z.enum(ATTACH_DECISIONS).nullable(),
    decidedAt: z.string().optional()
  })
  .passthrough()

/**
 * The mission. Key order here is the key order written to disk. `doneWhenVerified` is set on a record
 * converted from a v3 mission whose fixed end was verified: who and when. `attachRequests` is absent
 * until a session first asks to join.
 */
export interface MissionV4 {
  schemaVersion: 4
  id: string
  title: string
  doneWhen: string
  doneWhenVerified?: { by: string; at: string }
  status: 'open' | 'closed'
  closedAs?: 'delivered' | 'discarded'
  closeReason?: string
  closeRequested?: { at: string }
  milestones: Milestone[]
  steps: StepV4[]
  sessions: SessionEntry[]
  links: MissionLink[]
  blockers: BlockerV4[]
  attachRequests?: AttachRequest[]
  legacyV3?: unknown
}

export const MissionRecordSchema: z.ZodType<MissionV4> = z
  .object({
    schemaVersion: z.literal(4),
    id: z.string().regex(MISSION_V4_ID_RE),
    title: z.string(),
    doneWhen: z.string(),
    doneWhenVerified: z.object({ by: z.string(), at: z.string() }).passthrough().optional(),
    status: z.enum(MISSION_STATUSES),
    closedAs: z.enum(['delivered', 'discarded']).optional(),
    closeReason: z.string().optional(),
    closeRequested: z.object({ at: z.string() }).passthrough().optional(),
    milestones: z.array(MilestoneSchema).default([]),
    steps: z.array(StepSchema),
    sessions: z.array(SessionEntrySchema).default([]),
    links: z.array(LinkSchema).default([]),
    blockers: z.array(BlockerSchema).default([]),
    attachRequests: z.array(AttachRequestSchema).optional(),
    legacyV3: z.unknown().optional()
  })
  .passthrough()

/**
 * Compile-time proof that every entity type is closed: an index signature would make a misspelt field
 * compile. `npm run typecheck` fails here if one gains `[key: string]: …`.
 */
type IsClosed<T> = string extends keyof T ? false : true
type AssertTrue<T extends true> = T
export type ClosedEntityTypes = [
  AssertTrue<IsClosed<MissionV4>>,
  AssertTrue<IsClosed<Milestone>>,
  AssertTrue<IsClosed<StepV4>>,
  AssertTrue<IsClosed<AcceptanceCriterion>>,
  AssertTrue<IsClosed<Settled>>,
  AssertTrue<IsClosed<SelfCheck>>,
  AssertTrue<IsClosed<BlockerV4>>,
  AssertTrue<IsClosed<MissionLink>>,
  AssertTrue<IsClosed<SessionEntry>>,
  AssertTrue<IsClosed<StoppedAt>>,
  AssertTrue<IsClosed<AttachRequest>>
]

// ---- File format --------------------------------------------------------------

/** Collapse zod issues into one line: `steps.1.acs.0.by: Invalid option …`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/** Split a file into its leading frontmatter (inner text) and body (the Log). */
function splitRecordFile(raw: string): { inner: string; body: string } | null {
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
 * Serialize a record to its file content: the frontmatter, then `log` verbatim as the body. Throws on
 * a record that fails validation: writing an invalid file must fail loudly, not land a record every
 * later read would reject. Dumped with js-yaml's DEFAULT schema, which quotes any string that would
 * read back as another type (`'123'`, `'true'`, `'null'`, an ISO timestamp), so the CORE-schema read
 * in {@link parseMissionRecordFile} gives every string back as a string.
 */
export function buildMissionRecordContent(record: MissionV4, log = ''): string {
  const checked = MissionRecordSchema.safeParse(record)
  if (!checked.success) {
    throw new Error(`invalid mission: ${describeIssues(checked.error)}`)
  }
  const frontmatter = yaml.dump(checked.data, {
    lineWidth: -1, // never fold long strings: a folded scalar is harder to diff
    noRefs: true,
    skipInvalid: true // drops keys an optional field left explicitly `undefined`
  }) as string
  return `---\n${frontmatter}---\n${log}`
}

/**
 * Parse a v4 record file back into a validated {@link MissionV4}. Never throws: a missing frontmatter,
 * a YAML syntax error or a schema mismatch (a v3 file included: it has no `schemaVersion: 4`) returns
 * `{ error }` naming what was wrong. Read with the CORE schema so a hand-edited, unquoted timestamp
 * stays a string instead of becoming a `Date`.
 */
export function parseMissionRecordFile(raw: string): MissionV4 | { error: string } {
  const split = splitRecordFile(raw)
  if (!split) return { error: 'no frontmatter block' }
  let data: unknown
  try {
    data = yaml.load(split.inner, { schema: yaml.CORE_SCHEMA }) as unknown
  } catch (e) {
    return { error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` }
  }
  const checked = MissionRecordSchema.safeParse(data)
  if (!checked.success) return { error: `invalid mission: ${describeIssues(checked.error)}` }
  return checked.data
}

/** The file's free-text Log body (everything after the frontmatter); `''` when none. */
export function readMissionRecordLog(raw: string): string {
  return splitRecordFile(raw)?.body ?? ''
}
