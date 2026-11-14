/**
 * Missions v4 S-9 (AC-23, AC-24, AC-27) — the v3 → v4 conversion, pure.
 *
 * One function turns a v3 mission, or a v3 campaign with its chapter missions, into a v4 record
 * (spec "Design · Compatibility with records written by v3", the table "How v3 concepts map to v4").
 * A READ serves the result as an in-memory view; the first v4 WRITE stores it, by copy, in
 * `.harnu/missions-v4/`. Both use this same function, so a view and the record that later replaces it
 * cannot disagree.
 *
 * - **Pure and deterministic.** No clock, no randomness, no file: the same v3 input always gives the
 *   same record, byte for byte once serialized. That is what makes conversion idempotent (AC-27).
 * - **Reaches v3 only through `v3-read.ts`** (AC-26) for the shapes, and `model.ts` for the target.
 * - **No writing-contract rule is applied.** A converted title may be longer than today's cap; caps
 *   live on the write verbs, never on read (spec "The writing contract").
 * - **Nothing a v3 file held is lost silently:** what v4 has no place for is kept under `legacyV3`;
 *   `ledger`, `outcome` and `memoryDrafts` are v3 values the closed v4 model does not hold, so they
 *   go under `legacyV3` too (a campaign's chapter ones under that chapter).
 *
 * Choices the spec leaves open, each pinned by `tests/mission-v4-compat.test.ts`:
 *
 * - A blocker's id counts from `blk-1` across the WHOLE record, mission-level blockers first, then
 *   each step's in step order, so no two blockers of one record share an id.
 * - A decision node keeps its step (its human criterion) AND, while undecided, gets the operator
 *   blocker the table asks for.
 * - `waitsFor` holds the ids of the steps the step waits for, joined with `, `. A milestone's holds
 *   the milestone it waits for (`mls-n`) or `pr:<ref>` / `decision:<ref>`.
 * - A chapter mission closed as delivered is a done milestone: its human-shaped criteria are settled
 *   by the operator who closed it. Criteria tied to a fact stay facts, derived when read.
 */

import { createHash } from 'node:crypto'
import type {
  AcceptanceCriterion,
  BlockerV4,
  Milestone,
  MissionLink,
  MissionV4,
  SessionEntry,
  StepV4
} from './model'
import type { V3Campaign, V3Chapter, V3LedgerRow, V3Mission, V3MissionStep } from './v3-read'

/** A converted record, its Log and the slug its file is named with. */
export interface Converted {
  record: MissionV4
  log: string
  /** The v3 slug: the v4 file is `<id>-<slug>.md`, so a running session's prompt keeps working. */
  slug: string
}

/** A converted campaign also reports the v3 ids it superseded. */
export interface ConvertedCampaign extends Converted {
  /** The campaign id and every chapter mission id it names, sorted: what the new id is hashed from. */
  sourceIds: string[]
}

type Criterion = AcceptanceCriterion
type Settled = NonNullable<Criterion['settled']>

const CLOSED_AS_DELIVERED = 'The chapter mission was closed as delivered in v3'

// ---- Ids -------------------------------------------------------------------------

/**
 * The id of the mission a campaign converts to: `mnt-` plus the first 8 hex of the sha256 of the
 * sorted source ids joined with a newline (spec rule 3), so converting twice, or two sessions
 * converting at once, name the same file.
 */
export function campaignMissionId(sourceIds: readonly string[]): string {
  const sorted = [...new Set(sourceIds)].sort()
  return `mnt-${createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 8)}`
}

/** `mls-<n>` for chapter `chp-<n>`. */
const milestoneIdOf = (chapterId: string): string => `mls-${chapterId.replace(/^chp-/, '')}`

// ---- Small helpers -------------------------------------------------------------

/** The mission's title: the Log's first `# ` heading, else what it was meant to achieve. */
function titleOf(log: string, fallback: string): string {
  return /^# (.+?)\s*$/m.exec(log)?.[1] ?? fallback
}

/** `doneWhen`: the declared end's target, then "Proof: evidence" (spec table, row 2). */
function doneWhenOf(end: { target: string; evidence: string }): string {
  const target = end.target.trim()
  const sentence = /[.!?]$/.test(target) ? target : `${target}.`
  return end.evidence.trim() === '' ? sentence : `${sentence} Proof: ${end.evidence.trim()}`
}

/** Links of kind doc from the scope documents and a legacy fixed start's links, once each. */
function docLinks(
  sources: ReadonlyArray<ReadonlyArray<{ ref: string }> | undefined>
): MissionLink[] {
  const seen = new Set<string>()
  const out: MissionLink[] = []
  for (const list of sources) {
    for (const { ref } of list ?? []) {
      if (seen.has(ref)) continue
      seen.add(ref)
      out.push({ kind: 'doc', ref })
    }
  }
  return out
}

/** The mission's closing facts: `open` or `closed`, `closedAs`, `closeReason`, `closeRequested`. */
function closing(source: {
  status: string
  closedAs?: 'delivered' | 'discarded'
  closeReason?: string
  pendingClose?: { at: string }
}): Pick<MissionV4, 'status' | 'closedAs' | 'closeReason' | 'closeRequested'> {
  if (source.status === 'closed') {
    return {
      status: 'closed',
      ...(source.closedAs ? { closedAs: source.closedAs } : {}),
      ...(source.closeReason ? { closeReason: source.closeReason } : {})
    }
  }
  return {
    status: 'open',
    ...(source.pendingClose ? { closeRequested: { at: source.pendingClose.at } } : {})
  }
}

/** A blocker before it has an id. */
type BlockerDraft = Omit<BlockerV4, 'id'>

/**
 * Mission-level blockers of a v3 mission: its own, those of a fixed start or end, then one for every
 * unticked check on the fixed end. The mapping table has no row for the fixed end, so an unticked
 * check there becomes an operator-owned blocker, texts passed through whole (caps are never applied on
 * conversion): the operator must not lose something they owe, and a false alarm beats a miss.
 */
function missionLevelBlockers(mission: V3Mission): BlockerDraft[] {
  const fixedEnd = mission.steps.find((s) => s.kind === 'fixed-end')
  return [
    ...mission.blockers.map(draftOf),
    ...mission.steps.filter((s) => s.kind !== 'custom').flatMap((s) => s.blockers.map(draftOf)),
    ...(fixedEnd?.checks ?? [])
      .filter((c) => !c.ticked)
      .map((c): BlockerDraft => ({
        reason: c.label,
        ask: c.label,
        unblocks: 'Closing the mission',
        owner: 'operator',
        raisedAt: c.createdAt
      }))
  ]
}

function draftOf(b: {
  reason: string
  unblocks: string
  owner: 'agent' | 'operator'
  raisedAt: string
}): BlockerDraft {
  return { reason: b.reason, unblocks: b.unblocks, owner: b.owner, raisedAt: b.raisedAt }
}

/** A counter that hands out `blk-1`, `blk-2`, … for one record. */
function blockerCounter(): () => string {
  let n = 0
  return () => `blk-${++n}`
}

function toBlocker(b: BlockerDraft, id: string): BlockerV4 {
  return { id, ...b }
}

/** The `pr` and `worktree` links of a mission's fixed end: v4 link kinds, so they join the mission's links. */
function fixedEndLinks(mission: V3Mission): MissionLink[] {
  const end = mission.steps.find((s) => s.kind === 'fixed-end')
  return (end?.links ?? [])
    .filter((l) => l.kind === 'pr' || l.kind === 'worktree')
    .map((l) => ({ kind: l.kind as 'pr' | 'worktree', ref: l.ref }))
}

/** Mission links: the documents first, then the fixed ends' own links, none twice. */
function missionLinks(docs: MissionLink[], fixedEnds: MissionLink[]): MissionLink[] {
  const seen = new Set<string>()
  return [...docs, ...fixedEnds].filter((l) => {
    const key = `${l.kind}\u0000${l.ref}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---- Steps ---------------------------------------------------------------------

interface StepContext {
  mission: V3Mission
  /** Old step id → new step id. */
  idOf: ReadonlyMap<string, string>
  milestone?: string
  nextBlocker: () => string
  /** True for a chapter mission closed as delivered: its human-shaped criteria are settled. */
  closedDelivered: boolean
}

/** The branches of the worktrees a step links, from the ledger rows that recorded them. */
function branchesOf(step: V3MissionStep, ledger: readonly V3LedgerRow[]): Set<string> {
  const refs = new Set(step.links.filter((l) => l.kind === 'worktree').map((l) => l.ref))
  const out = new Set<string>()
  for (const row of ledger) {
    if (row.kind === 'worktree' && row.branch && refs.has(row.worktree ?? row.ref)) {
      out.add(row.branch)
    }
  }
  return out
}

/** Does the step have a pull request: a `pr` link, or a worktree whose branch has one in the ledger. */
function hasPullRequest(step: V3MissionStep, ledger: readonly V3LedgerRow[]): boolean {
  if (step.links.some((l) => l.kind === 'pr')) return true
  const branches = branchesOf(step, ledger)
  return (
    branches.size > 0 &&
    ledger.some((r) => r.pr !== undefined && !!r.branch && branches.has(r.branch))
  )
}

/** The criteria of one step, without ids (they are numbered once the list is complete). */
function criteriaOf(step: V3MissionStep, ctx: StepContext): Array<Omit<Criterion, 'id'>> {
  const { mission } = ctx
  const out: Array<Omit<Criterion, 'id'>> = []
  const fallbackAt = mission.updatedAt

  if (step.verification === 'existence') {
    out.push({ text: 'The linked work exists', by: 'fact', fact: 'link-exists' })
  }
  if (hasPullRequest(step, mission.ledger ?? [])) {
    out.push({ text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' })
  }

  if (step.verification === 'verifier') {
    const text = 'A second session checked the work'
    if (step.proof === 'verified') {
      const by = step.verifiedBy
      out.push({
        text,
        by: 'session',
        settled: {
          at: by?.at ?? fallbackAt,
          by: by?.sessionId ?? 'v3',
          evidence: `Verified in v3 (verdict ${by?.verdict ?? 'met'})`
        }
      })
    } else if (step.proof === 'self-verified' || step.proof === 'claimed') {
      // A self-check is labelled and never proof: the criterion stays open and the check is noted, in
      // the model's shape { at, by, evidence }. The v3 word stays at `legacyV3.steps[].proof`.
      const by = step.verifiedBy
      out.push({
        text,
        by: 'session',
        selfCheck:
          step.proof === 'self-verified' && by
            ? {
                at: by.at,
                by: by.sessionId,
                evidence: `Self-verified in v3 (verdict ${by.verdict ?? 'met'})`
              }
            : {
                at: fallbackAt,
                by: step.links.find((l) => l.kind === 'session')?.ref ?? mission.owner.sessionId,
                evidence: 'Claimed done in v3, never checked'
              }
      })
    } else {
      out.push({ text, by: 'session' })
    }
  }

  if (step.verification === 'human') {
    out.push({
      text: step.title,
      by: 'operator',
      ...(step.proof === 'verified'
        ? { settled: { at: step.verifiedBy?.at ?? fallbackAt, by: 'operator' } }
        : {})
    })
  }

  for (const check of step.checks ?? []) {
    out.push({
      text: check.label,
      by: 'operator',
      ...(check.ticked ? { settled: { at: check.ticked.at, by: 'operator' } } : {})
    })
  }

  if (ctx.closedDelivered) {
    // The operator closed the chapter as delivered: the human-shaped criteria it left open are theirs.
    const stamp: Settled = { at: mission.updatedAt, by: 'operator', evidence: CLOSED_AS_DELIVERED }
    for (const c of out) if (c.by !== 'fact' && !c.settled) c.settled = stamp
  }
  return out
}

/**
 * `waitsFor` per step: the steps it waits for, from an edge of kind `blocks` and from an undecided
 * decision node's `blocks`. `validates` and `related` are never read by anyone and are dropped.
 */
function waitsForMap(
  steps: readonly V3MissionStep[],
  idOf: ReadonlyMap<string, string>
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (target: string, source: string): void => {
    const to = idOf.get(target)
    const from = idOf.get(source)
    if (!to || !from || to === from) return
    const list = out.get(to) ?? []
    if (!list.includes(from)) list.push(from)
    out.set(to, list)
  }
  for (const step of steps) {
    if (step.kind !== 'custom') continue
    for (const edge of step.edges ?? []) if (edge.kind === 'blocks') add(edge.to, step.id)
    if (step.decision && step.decision.chosen === undefined) {
      for (const target of step.decision.blocks) add(target, step.id)
    }
  }
  return out
}

/** The custom steps of a mission as v4 steps. */
function convertSteps(ctx: StepContext): StepV4[] {
  const { mission } = ctx
  const waits = waitsForMap(mission.steps, ctx.idOf)
  const out: StepV4[] = []
  for (const step of mission.steps) {
    if (step.kind !== 'custom') continue
    const id = ctx.idOf.get(step.id) as string

    const cards = step.links.filter((l) => l.kind === 'card')
    const links: MissionLink[] = step.links
      .filter((l) => l.kind === 'pr' || l.kind === 'worktree')
      .map((l) => ({ kind: l.kind as 'pr' | 'worktree', ref: l.ref }))

    const blockers: BlockerV4[] = step.blockers.map((b) => toBlocker(draftOf(b), ctx.nextBlocker()))
    if (step.decision && step.decision.chosen === undefined) {
      const { title, options, blocks } = step.decision
      blockers.push({
        id: ctx.nextBlocker(),
        reason: `Choose: ${title} (${options.join(' / ')})`,
        ask: `Choose: ${title}`,
        ...(blocks.length > 0
          ? {
              unblocks: blocks
                .map((b) => mission.steps.find((s) => s.id === b)?.title ?? b)
                .join(', ')
            }
          : {}),
        owner: 'operator'
      })
    }

    const acs = criteriaOf(step, ctx).map((c, n) => ({ ...c, id: `ac-${n + 1}` }) as Criterion)
    const waitsFor = waits.get(id)
    out.push({
      id,
      ...(ctx.milestone ? { milestone: ctx.milestone } : {}),
      title: step.title,
      ...(step.required === false ? { optional: true } : {}),
      ...(cards[0] ? { card: cards[0].ref } : {}),
      acs,
      links,
      blockers,
      ...(waitsFor ? { waitsFor: waitsFor.join(', ') } : {})
    })
  }
  return out
}

/** The session links of a mission's steps, in order of appearance: the sessions that worked it. */
function workedSessionsOf(mission: V3Mission): Array<{ id: string; from: string }> {
  const out: Array<{ id: string; from: string }> = []
  for (const step of mission.steps) {
    for (const link of step.links) {
      if (link.kind !== 'session' || out.some((s) => s.id === link.ref)) continue
      out.push({ id: link.ref, from: step.addedAt ?? mission.createdAt })
    }
  }
  return out
}

/** The values a v3 mission held that v4 has no place for, kept so nothing is lost silently. */
function missionLegacy(mission: V3Mission, withSteps: boolean): Record<string, unknown> {
  const fixed = (kind: 'fixed-start' | 'fixed-end'): Record<string, unknown> | undefined => {
    const s = mission.steps.find((x) => x.kind === kind)
    if (!s) return undefined
    const cards = s.links.filter((l) => l.kind === 'card')
    return {
      id: s.id,
      proof: s.proof,
      ...(s.verifiedBy ? { verifiedBy: s.verifiedBy } : {}),
      // Every check, ticked or not, with its id, source, creation time and tick stamp.
      ...(s.checks && s.checks.length > 0 ? { checks: s.checks } : {}),
      // A card link is not a v4 link kind; the pr and worktree links joined the mission's own.
      ...(cards.length > 0 ? { links: cards } : {})
    }
  }
  const stepsLegacy = mission.steps
    .filter((s) => s.kind === 'custom')
    .map((s) => ({
      id: s.id,
      verification: s.verification,
      proof: s.proof,
      ...(s.verifiedBy ? { verifiedBy: s.verifiedBy } : {}),
      ...(s.addedAt ? { addedAt: s.addedAt } : {}),
      ...(s.addedReason ? { addedReason: s.addedReason } : {}),
      ...(s.discoveredFrom ? { discoveredFrom: s.discoveredFrom } : {}),
      ...(s.edges?.some((e) => e.kind !== 'blocks')
        ? { droppedEdges: s.edges.filter((e) => e.kind !== 'blocks') }
        : {}),
      ...(s.decision ? { decision: s.decision } : {}),
      ...(s.links.filter((l) => l.kind === 'card').length > 1
        ? { cards: s.links.filter((l) => l.kind === 'card').map((l) => l.ref) }
        : {})
    }))
  return {
    id: mission.id,
    slug: mission.slug,
    folder: mission.folder,
    ownerFolder: mission.owner.folder,
    ...(mission.linkedCard ? { linkedCard: mission.linkedCard } : {}),
    status: mission.status,
    declaredEnd: mission.declaredEnd,
    ...(mission.declaredEndApproval ? { declaredEndApproval: mission.declaredEndApproval } : {}),
    ...(mission.pendingRescope ? { pendingRescope: mission.pendingRescope } : {}),
    openQuestions: mission.openQuestions,
    ...(mission.stewardPause ? { stewardPause: mission.stewardPause } : {}),
    ...(mission.legacy ? { legacy: mission.legacy } : {}),
    ...(mission.legacyRaw !== undefined ? { legacyRaw: mission.legacyRaw } : {}),
    ...(mission.campaignId ? { campaignId: mission.campaignId } : {}),
    ...(mission.chapterId ? { chapterId: mission.chapterId } : {}),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    provenance: mission.provenance,
    ...(fixed('fixed-start') ? { fixedStart: fixed('fixed-start') } : {}),
    ...(fixed('fixed-end') ? { fixedEnd: fixed('fixed-end') } : {}),
    // v3 values the closed v4 model does not hold: kept here, as they were.
    ...(mission.ledger ? { ledger: mission.ledger } : {}),
    ...(mission.outcome ? { outcome: mission.outcome } : {}),
    ...(mission.memoryDrafts ? { memoryDrafts: mission.memoryDrafts } : {}),
    ...(withSteps ? { steps: stepsLegacy } : {})
  }
}

/** Identity ids for a mission that keeps its own step ids. */
function identityIds(mission: V3Mission): Map<string, string> {
  return new Map(mission.steps.filter((s) => s.kind === 'custom').map((s) => [s.id, s.id]))
}

// ---- A mission -----------------------------------------------------------------

/**
 * Convert a v3 mission to a v4 record. The id, the step ids and the slug are kept, so a running
 * session's prompt, its `stp-n` references and the file name all keep working.
 */
export function convertV3Mission(mission: V3Mission, log: string): Converted {
  const nextBlocker = blockerCounter()
  const blockers = missionLevelBlockers(mission).map((b) => toBlocker(b, nextBlocker()))
  const steps = convertSteps({
    mission,
    idOf: identityIds(mission),
    nextBlocker,
    closedDelivered: false
  })

  const closed = mission.status === 'closed'
  const sessions: SessionEntry[] = [
    {
      id: mission.owner.sessionId,
      role: 'leads',
      from: mission.createdAt,
      to: closed ? mission.updatedAt : null,
      stoppedAt: null
    },
    ...workedSessionsOf(mission)
      .filter((s) => s.id !== mission.owner.sessionId)
      .map((s): SessionEntry => ({
        id: s.id,
        role: 'worked',
        from: s.from,
        to: closed ? mission.updatedAt : null,
        stoppedAt: null
      }))
  ]

  const fixedEnd = mission.steps.find((s) => s.kind === 'fixed-end')
  const verified =
    fixedEnd?.proof === 'verified' && fixedEnd.verifiedBy
      ? { by: fixedEnd.verifiedBy.sessionId, at: fixedEnd.verifiedBy.at }
      : undefined

  const record: MissionV4 = {
    schemaVersion: 4,
    id: mission.id,
    title: titleOf(log, mission.declaredEnd.target),
    doneWhen: doneWhenOf(mission.declaredEnd),
    ...(verified ? { doneWhenVerified: verified } : {}),
    ...closing(mission),
    milestones: [],
    steps,
    sessions,
    links: missionLinks(
      docLinks([mission.scope, mission.steps.find((s) => s.kind === 'fixed-start')?.links]),
      fixedEndLinks(mission)
    ),
    blockers,
    legacyV3: missionLegacy(mission, true)
  }
  return { record, log, slug: mission.slug }
}

// ---- A campaign ----------------------------------------------------------------

/** The unlock a chapter waits for, as a milestone's `waitsFor`. */
function waitsForOfChapter(chapter: V3Chapter): string | null {
  if (!chapter.unlocks) return null
  const { kind, ref } = chapter.unlocks
  return kind === 'chapter' ? milestoneIdOf(ref) : `${kind}:${ref}`
}

/**
 * Convert a v3 campaign and its chapter missions to ONE v4 mission (spec rule 3): chapters become
 * milestones in order, the chapter missions' steps become its steps (numbered `stp-1` up across the
 * whole mission, the old ids kept under `legacyV3.stepIds`), and a chapter with no mission yet is a
 * milestone with no steps. `chapters` holds the chapter missions that could be read; a bound chapter
 * whose mission is not in it converts as a milestone with no steps.
 */
export function convertV3Campaign(
  campaign: V3Campaign,
  campaignLog: string,
  chapters: ReadonlyArray<{ mission: V3Mission; log: string }>
): ConvertedCampaign {
  const byMissionId = new Map(chapters.map((c) => [c.mission.id, c]))
  const bound = campaign.chapters.flatMap((ch) => (ch.missionId ? [ch.missionId] : []))
  const sourceIds = [...new Set([campaign.id, ...bound])].sort()
  const id = campaignMissionId(sourceIds)

  // The chapter missions that exist, in chapter order.
  const parts = campaign.chapters.flatMap((chapter) => {
    const found = chapter.missionId ? byMissionId.get(chapter.missionId) : undefined
    return found ? [{ chapter, ...found }] : []
  })

  // Step ids run across the whole mission; each chapter mission keeps its own old → new map.
  let nextStep = 0
  const idMaps = new Map<string, Map<string, string>>()
  const stepIds: Array<{ mission: string; step: string; id: string }> = []
  for (const { mission } of parts) {
    const map = new Map<string, string>()
    for (const step of mission.steps) {
      if (step.kind !== 'custom') continue
      const next = `stp-${++nextStep}`
      map.set(step.id, next)
      stepIds.push({ mission: mission.id, step: step.id, id: next })
    }
    idMaps.set(mission.id, map)
  }

  // Blockers: mission-level ones of every chapter first, then each step's, in chapter order.
  const nextBlocker = blockerCounter()
  const blockers = parts.flatMap(({ mission }) =>
    missionLevelBlockers(mission).map((b) => toBlocker(b, nextBlocker()))
  )
  const steps = parts.flatMap(({ chapter, mission }) =>
    convertSteps({
      mission,
      idOf: idMaps.get(mission.id) as Map<string, string>,
      milestone: milestoneIdOf(chapter.id),
      nextBlocker,
      closedDelivered: mission.status === 'closed' && mission.closedAs === 'delivered'
    })
  )

  const milestones: Milestone[] = campaign.chapters.map((chapter) => ({
    id: milestoneIdOf(chapter.id),
    title: chapter.title,
    optional: !chapter.required,
    waitsFor: waitsForOfChapter(chapter)
  }))

  const closed = campaign.status === 'closed'
  const sessions: SessionEntry[] = [
    {
      id: campaign.owner.sessionId,
      role: 'leads',
      from: campaign.createdAt,
      to: closed ? campaign.updatedAt : null,
      stoppedAt: null
    }
  ]
  for (const { mission } of parts) {
    const people = [
      { id: mission.owner.sessionId, from: mission.createdAt },
      ...workedSessionsOf(mission)
    ]
    for (const p of people) {
      if (sessions.some((s) => s.id === p.id)) continue
      sessions.push({
        id: p.id,
        role: 'worked',
        from: p.from,
        to: closed ? campaign.updatedAt : null,
        stoppedAt: null
      })
    }
  }

  // The chapter logs follow the campaign's own, each marked with the mission it came from.
  const log = parts.reduce((acc, { mission, log: chapterLog }) => {
    const text = chapterLog.trim()
    return text === ''
      ? acc
      : `${acc.replace(/\n*$/, '\n')}\n<!-- imported from ${mission.id} -->\n${text}\n`
  }, campaignLog)

  const record: MissionV4 = {
    schemaVersion: 4,
    id,
    title: campaign.title,
    doneWhen: doneWhenOf(campaign.declaredEnd),
    ...closing(campaign),
    milestones,
    steps,
    sessions,
    links: missionLinks(
      docLinks([campaign.scope, ...parts.map(({ mission }) => mission.scope)]),
      parts.flatMap(({ mission }) => fixedEndLinks(mission))
    ),
    blockers,
    legacyV3: {
      campaign: campaign.id,
      slug: campaign.slug,
      folder: campaign.folder,
      ownerFolder: campaign.owner.folder,
      status: campaign.status,
      declaredEnd: campaign.declaredEnd,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      provenance: campaign.provenance,
      sourceIds,
      stepIds,
      // The campaign's own outcome and memory drafts; each chapter's sit under its chapter, with its
      // ledger, whose rows keep the v3 step ids they were written with (`stepIds` maps them).
      ...(campaign.outcome ? { outcome: campaign.outcome } : {}),
      ...(campaign.memoryDrafts ? { memoryDrafts: campaign.memoryDrafts } : {}),
      chapters: campaign.chapters.map((chapter) => {
        const found = chapter.missionId ? byMissionId.get(chapter.missionId) : undefined
        return {
          id: chapter.id,
          ordinal: chapter.ordinal,
          ...(chapter.missionId ? { missionId: chapter.missionId } : {}),
          required: chapter.required,
          ...(chapter.discoveredFrom ? { discoveredFrom: chapter.discoveredFrom } : {}),
          ...(chapter.unlocks ? { unlocks: chapter.unlocks } : {}),
          ...(chapter.produces ? { produces: chapter.produces } : {}),
          ...(chapter.consumes ? { consumes: chapter.consumes } : {}),
          ...(chapter.radiant ? { radiant: chapter.radiant } : {}),
          ...(found
            ? {
                mission: {
                  ...missionLegacy(found.mission, true),
                  ...(found.mission.closedAs ? { closedAs: found.mission.closedAs } : {}),
                  ...(found.mission.closeReason ? { closeReason: found.mission.closeReason } : {})
                }
              }
            : {})
        }
      })
    }
  }
  return { record, log, slug: campaign.slug, sourceIds }
}
