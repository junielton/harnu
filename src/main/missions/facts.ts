/**
 * Missions v4 S-16a (V-2) — the one adapter that gathers a step's facts.
 *
 * S-7's state function takes a {@link StepInput} per step: the card's column, the pull request's state,
 * the facts Harnu reads beyond it (`ci-green`, `main-green`, `link-exists`) and whether a worker is
 * working. Nothing in the record holds those, so the view and the observer ask this module. It gathers
 * them from what Harnu already holds and nothing else: the board, chapter 2's pull request join (one
 * call per mission, which joins the single-flight cache a chapter 2 poll already warms), its last-known
 * facts and the session list. Every source is a {@link FactsDeps} entry, so the module itself spawns no
 * `git` or `gh`, reads no file and has no Electron import; `mission-ipc.ts` wires the real ones.
 *
 * **Absent is not false** (`state.ts`). A fact the adapter could not read (GitHub unreachable and no
 * earlier sighting, a pull request that aged out of the recent list, a step with nothing to check) is
 * left OUT of the input. `false` means read, and it does not hold. A pull request seen once keeps its
 * state through an unreachable GitHub (the sticky last-known value): never a downgrade.
 *
 * It writes nothing and remembers nothing. What a pass may remember (the sticky sightings) and what it
 * found for each step (the pull requests to attach) come back as data from {@link gatherStepFacts}; only
 * the observer acts on them. Electron-free, and no import of a v3 module (AC-26).
 */

import * as path from 'node:path'
import { mapLegacyDataPath } from '../data-dir'
import { parseCard } from '../roadmap-core'
import type { LinkCacheKind, LinkResolution } from '../mission-link-cache'
import type { MissionPrJoin } from '../pr-stack'
import { findCardByName, indexStepCards, stepCardColumn, stepCardKey, type CardFile } from './cards'
import { leaderOf } from './guard'
import type { MissionLink, MissionV4, StepV4 } from './model'
import type { CardColumn, PrState, ReadFact, StepInput } from './state'
import type { FoundPr } from './verbs-plan'

/** What chapter 2's join answers: pull requests by number, by worktree and by branch. */
export type PrJoin = MissionPrJoin

/** The verdict of one CI read, as chapter 2 words it. */
type Ci = 'passing' | 'failing' | 'pending' | 'unknown'

/** Every source the adapter reads. Each is injected: a test hands over a plain fake. */
export interface FactsDeps {
  /**
   * The board's cards as files. Called once, and only when a step names a card. A throw reads as "no
   * board": every card column is then absent.
   */
  board?: () => Promise<readonly CardFile[]>
  /** The one join for the whole mission: its pull request numbers, worktree paths and card branches. */
  findPrs: (refs: { worktrees: string[]; branches: string[]; numbers: number[] }) => Promise<PrJoin>
  /** CI of the merge commits of merged pull requests on the default branch. */
  findMainCi: (
    numbers: number[]
  ) => Promise<{ ghAvailable: boolean | null; byNumber: Record<number, Ci | null> }>
  /** The last-known resolution of a link (chapter 2's sticky cache), bound to the repo. */
  lastKnown: (kind: LinkCacheKind, ref: string) => LinkResolution | null
  /** Whether an absolute path exists. Asynchronous: the adapter reads no file itself. */
  pathExists: (absolute: string) => Promise<boolean>
  /** A session's task state (`working`, `idle`, …), or `undefined` when none is known. */
  taskState: (sessionId: string) => string | undefined
}

/** One thing a pass may remember: the arguments of `rememberResolved` (minus the repo root). */
export interface Sighting {
  kind: LinkCacheKind
  ref: string
  seen: Omit<LinkResolution, 'at'>
}

export interface StepFacts {
  /** Each step's input, by step id. */
  inputs: Record<string, StepInput>
  /** Sticky sightings: only what was actually read, never a value taken from the cache. */
  sightings: Sighting[]
  /** The pull requests found for each step (its `pr` links, its worktrees, its card's branch). */
  found: FoundPr[]
}

// ---- Link helpers --------------------------------------------------------------------

/** The pull request number a `pr` link names: `12`, `#12` or a `/pull/12` URL. */
function prNumberOf(ref: string): number | null {
  const m = /(?:#|\/pull\/|^)(\d+)\/?\s*$/.exec(ref.trim())
  return m ? Number(m[1]) : null
}

/** A `worktree` or `doc` link's ref as an absolute path; a relative one is read from the repo root. */
function linkPath(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(root, mapLegacyDataPath(ref))
}

const linksOf = (step: StepV4, kind: MissionLink['kind']): MissionLink[] =>
  step.links.filter((l) => l.kind === kind)

type PrRow = NonNullable<PrJoin['numbers'][number]>

/** Merged beats open beats closed: the one pull request whose state stands for the step. */
function pickPr(candidates: readonly PrRow[]): PrRow | undefined {
  for (const state of ['MERGED', 'OPEN', 'CLOSED'] as const) {
    const hit = candidates.filter((p) => p.state === state).sort((a, b) => b.number - a.number)[0]
    if (hit) return hit
  }
  return undefined
}

const PR_STATE: Record<PrRow['state'], Exclude<PrState, 'none'>> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed'
}

const ciFact = (ci: string | undefined): boolean | undefined =>
  ci === 'passing' ? true : ci === 'failing' ? false : undefined

// ---- The adapter ----------------------------------------------------------------------

/**
 * Gather every step's input and what the observer needs beyond it. Reads through `deps` only; never
 * throws on a source that fails (that fact is simply absent).
 */
export async function gatherStepFacts(
  root: string,
  record: MissionV4,
  deps: FactsDeps
): Promise<StepFacts> {
  const leader = leaderOf(record)

  // The cards: the board is read once, and only when a step names a card.
  let files: readonly CardFile[] = []
  if (deps.board && record.steps.some((s) => s.card)) {
    try {
      files = await deps.board()
    } catch {
      files = []
    }
  }
  const index = indexStepCards(files)
  const cardOf = (step: StepV4): { column?: CardColumn; branch?: string } => {
    const ref = { missionId: record.id, stepId: step.id }
    const named = step.card ? findCardByName(files, step.card) : undefined
    const card = named
      ? parseCard(named.content, named.slug)
      : step.card
        ? index.get(stepCardKey(ref))?.card
        : undefined
    const column = stepCardColumn(card, ref)
    if (column === undefined) return {}
    return { column, ...(card?.executedIn ? { branch: card.executedIn } : {}) }
  }
  const cards = new Map(record.steps.map((s) => [s.id, cardOf(s)] as const))

  // The refs the one join is asked for.
  const exists = new Map<string, boolean>()
  const checkPath = async (abs: string): Promise<boolean> => {
    const known = exists.get(abs)
    if (known !== undefined) return known
    let ok = false
    try {
      ok = await deps.pathExists(abs)
    } catch {
      ok = false
    }
    exists.set(abs, ok)
    return ok
  }
  const worktreePaths = new Set<string>()
  for (const s of record.steps) {
    for (const l of linksOf(s, 'worktree')) {
      const abs = linkPath(root, l.ref)
      if (await checkPath(abs)) worktreePaths.add(abs)
    }
  }
  const branches = new Set<string>()
  for (const c of cards.values()) if (c.branch) branches.add(c.branch)
  const numbers = new Set<number>()
  for (const s of record.steps) {
    for (const l of linksOf(s, 'pr')) {
      const n = prNumberOf(l.ref)
      if (n !== null) numbers.add(n)
    }
  }

  let join: PrJoin = { ghAvailable: null, worktrees: {}, branches: {}, numbers: {} }
  if (worktreePaths.size + branches.size + numbers.size > 0) {
    try {
      join = await deps.findPrs({
        worktrees: [...worktreePaths],
        branches: [...branches],
        numbers: [...numbers]
      })
    } catch {
      join = { ghAvailable: false, worktrees: {}, branches: {}, numbers: {} }
    }
  }

  // Each step's pull requests: the numbers of its `pr` links, its existing worktrees, its card's branch.
  interface StepPrs {
    candidates: PrRow[]
    /** A `pr` link whose number the join did not list (aged out, or GitHub unreachable). */
    unresolved: number[]
    /** The step has a worktree or a card branch whose pull requests were asked for. */
    askedByBranch: boolean
  }
  const prsOf = new Map<string, StepPrs>()
  for (const s of record.steps) {
    const byNumber = new Map<number, PrRow>()
    const unresolved: number[] = []
    let askedByBranch = false
    for (const l of linksOf(s, 'pr')) {
      const n = prNumberOf(l.ref)
      if (n === null) continue
      const row = join.numbers[n]
      if (row) byNumber.set(row.number, row)
      else unresolved.push(n)
    }
    for (const l of linksOf(s, 'worktree')) {
      const abs = linkPath(root, l.ref)
      if (!exists.get(abs)) continue
      askedByBranch = true
      for (const p of join.worktrees[abs]?.prs ?? []) byNumber.set(p.number, p)
    }
    const branch = cards.get(s.id)?.branch
    if (branch) {
      askedByBranch = true
      for (const p of join.branches[branch] ?? []) byNumber.set(p.number, p)
    }
    prsOf.set(s.id, { candidates: [...byNumber.values()], unresolved, askedByBranch })
  }

  // The sticky state a step falls back on when nothing was read: never a downgrade.
  const stickyPr = (
    nums: readonly number[]
  ): { state: 'open' | 'merged'; number: number } | undefined => {
    let best: { state: 'open' | 'merged'; number: number } | undefined
    for (const n of nums) {
      const known = deps.lastKnown('pr', String(n))
      if (known?.state !== 'OPEN' && known?.state !== 'MERGED') continue
      const state = known.state === 'MERGED' ? 'merged' : 'open'
      if (!best || (state === 'merged' && best.state === 'open')) best = { state, number: n }
    }
    return best
  }

  // One main-CI read for the merged pull requests of every step.
  const chosen = new Map<string, PrRow | undefined>()
  const mergedNumbers = new Set<number>()
  for (const s of record.steps) {
    const row = pickPr(prsOf.get(s.id)?.candidates ?? [])
    chosen.set(s.id, row)
    if (row?.state === 'MERGED') mergedNumbers.add(row.number)
  }
  const mainCi: Record<number, Ci | null> = {}
  const toAsk = [...mergedNumbers]
  if (toAsk.length > 0) {
    try {
      Object.assign(mainCi, (await deps.findMainCi(toAsk)).byNumber)
    } catch {
      /* unreadable: the sticky value, else absent */
    }
  }

  const inputs: Record<string, StepInput> = {}
  const sightings: Sighting[] = []
  const sighted = new Set<string>()
  const sight = (s: Sighting): void => {
    const key = `${s.kind}\u0000${s.ref}`
    if (sighted.has(key)) return
    sighted.add(key)
    sightings.push(s)
  }
  const found: FoundPr[] = []
  const foundKeys = new Set<string>()

  for (const step of record.steps) {
    const input: StepInput = {}
    const facts: Partial<Record<ReadFact, boolean>> = {}
    const card = cards.get(step.id)
    if (card?.column !== undefined) input.card = card.column

    const { candidates, unresolved, askedByBranch } = prsOf.get(step.id) as StepPrs
    const row = chosen.get(step.id)
    let prNumber: number | undefined
    let prMerged = false
    if (row) {
      input.pr = PR_STATE[row.state]
      prNumber = row.state === 'CLOSED' ? undefined : row.number
      prMerged = row.state === 'MERGED'
    } else {
      const sticky = stickyPr(unresolved)
      if (sticky) {
        input.pr = sticky.state
        prNumber = sticky.number
        prMerged = sticky.state === 'merged'
      } else if (unresolved.length === 0 && askedByBranch && join.ghAvailable === true) {
        input.pr = 'none'
      }
    }

    for (const p of candidates) {
      const key = `${step.id}#${p.number}`
      if (!foundKeys.has(key)) {
        foundKeys.add(key)
        found.push({ stepId: step.id, number: p.number, state: PR_STATE[p.state] })
      }
      if (p.state === 'CLOSED') continue
      sight({
        kind: 'pr',
        ref: String(p.number),
        seen: {
          state: p.state,
          prNumber: p.number,
          url: p.url,
          baseRefName: p.base,
          ...(p.mergedAt ? { mergedAt: p.mergedAt } : {})
        }
      })
      if (p.ci === 'passing' || p.ci === 'failing') {
        sight({ kind: 'pr-ci', ref: String(p.number), seen: { state: p.ci, prNumber: p.number } })
      }
    }

    // ci-green: the pull request's ci; main-green: the merge commit's CI, merged pull requests only.
    if (prNumber !== undefined) {
      const ci = row ? ciFact(row.ci) : ciFact(deps.lastKnown('pr-ci', String(prNumber))?.state)
      if (ci !== undefined) facts['ci-green'] = ci
      if (prMerged) {
        const read = mainCi[prNumber]
        const main =
          ciFact(read ?? undefined) ?? ciFact(deps.lastKnown('pr-main', String(prNumber))?.state)
        if (main !== undefined) facts['main-green'] = main
        if (read === 'passing' || read === 'failing') {
          sight({ kind: 'pr-main', ref: String(prNumber), seen: { state: read, prNumber } })
        }
      }
    }

    const linkExists = await linkExistsOf(root, step, join, deps, checkPath)
    if (linkExists !== undefined) facts['link-exists'] = linkExists
    if (Object.keys(facts).length > 0) input.facts = facts

    const working = linksOf(step, 'session').some(
      (l) => l.ref !== leader && deps.taskState(l.ref) === 'working'
    )
    if (working) input.workerWorking = true

    inputs[step.id] = input
  }
  return { inputs, sightings, found }
}

/**
 * `link-exists`: the step has at least one `pr`, `worktree` or `doc` link and each resolves (the path
 * exists in the repo; the pull request is open or merged). A `url` link is never checked. `undefined`
 * (absent) when the step has nothing to check or a pull request could not be read; `false` only when a
 * link was read and does not resolve.
 */
async function linkExistsOf(
  root: string,
  step: StepV4,
  join: PrJoin,
  deps: FactsDeps,
  checkPath: (abs: string) => Promise<boolean>
): Promise<boolean | undefined> {
  const links = step.links.filter(
    (l) => l.kind === 'pr' || l.kind === 'worktree' || l.kind === 'doc'
  )
  if (links.length === 0) return undefined
  let unknown = false
  for (const l of links) {
    if (l.kind === 'pr') {
      const n = prNumberOf(l.ref)
      if (n === null) return false
      const row = join.numbers[n]
      if (row) {
        if (row.state === 'CLOSED') return false
        continue
      }
      const known = deps.lastKnown('pr', String(n))
      if (known?.state === 'OPEN' || known?.state === 'MERGED') continue
      unknown = true
    } else if (!(await checkPath(linkPath(root, l.ref)))) {
      return false
    }
  }
  return unknown ? undefined : true
}

/** Each step's input, by step id. See {@link gatherStepFacts} for what else a pass learns. */
export async function gatherStepInputs(
  root: string,
  record: MissionV4,
  deps: FactsDeps
): Promise<Record<string, StepInput>> {
  return (await gatherStepFacts(root, record, deps)).inputs
}
