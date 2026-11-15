/**
 * Missions v4 S-26 (AC-68) — dispatching a step binds its card and attaches the worker.
 *
 * A step has a board card only when it is dispatched to a session or worktree of its own, and the
 * session that takes it is attached as a worker whose scoped verbs reach only that step (S-25). Three
 * paths dispatch a step, and each ends in this module:
 *
 * - **`create_session` by the leader, with a step** ({@link dispatchStep}): once the session has
 *   materialized, the step's card is created in `backlog` (or the card the step already has is bound),
 *   stamped with `mission`, `milestone` and `step`, and given the marked block of the step's criteria
 *   (S-10's `planStepCard`); the session is attached as a worker and linked to the step, and the step
 *   names the card, all in ONE write of the mission. The ACK carries both ({@link dispatchAck}).
 * - **`submit_manifest` with a step on a card** ({@link stampCardForStep}): the card the leader names is
 *   stamped for the step when the manifest is stamped, in its frontmatter only, so the fingerprint the
 *   drain checks (title, spec, body) is untouched. The session the drain starts is bound when it boots.
 * - **A board dispatch, and the drain's boot** ({@link bindCardSession}): the card carries the step it
 *   is the work of, so the session bound to it is attached to that step. The session id the drain binds
 *   is the synthetic one it spawned; the real id is awaited, since the scoped credential carries the id
 *   the session really has. A card with no step on it binds nothing, and is dispatched as it always was.
 *
 * {@link noteCardSpawn} is the other half of the scoping: just before a card's session is spawned, it
 * leaves the note `pty:create` turns into the session's credential (S-25's pending spawn), keyed by the
 * folder the session spawns in.
 *
 * **A step the leader does itself gets no card**, and nothing here is called for it: a card exists only
 * because a step was dispatched. A verifier started for a step is attached to the mission but gets no
 * card and is not linked to the step (it checks the step, it did not build it).
 *
 * Harnu writes as `{ kind: 'harnu' }` (C3-59), never as the leader or the operator; the Log names the
 * step by its quoted title and never a session id. The board is reached through {@link BoardIo}, so the
 * module has no electron import of its own and a test can stand a folder in for the board.
 */

import { repoRoot } from '../data-dir'
import {
  isCardSubstrate,
  parseCard,
  updateFrontmatterFields,
  type CardSubstrate
} from '../roadmap-core'
import { registerPendingSpawn } from '../mcp/scope'
import { findStepCard, planStepCard, type CardFile } from './cards'
import type { StepV4 } from './model'
import { readMissionRecord } from './record-store'
import { attachDispatchedWorker, resolveStepId } from './sessions'

// ---- The board, as the dispatch needs it ---------------------------------------------------------

/** What the dispatch needs of the board. The real one is {@link realBoardIo}. */
export interface BoardIo {
  /** Every card on the board, as files. */
  readAll(): Promise<CardFile[]>
  /** One card by slug, or `null` when the board has none. */
  read(slug: string): Promise<CardFile | null>
  /** Write a NEW card file; `false` when it could not (the slug is taken, or the write failed). */
  create(slug: string, content: string): Promise<boolean>
  /** Replace a card file that exists. */
  write(slug: string, content: string): Promise<boolean>
  /** Run `fn` with no other card id being minted on this board, so two creates never share an id. */
  lock<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * The board of `folder`: the cards of the repo's one roadmap, through the same door every other board
 * write goes through. Imported when it is first needed, so this module loads without electron.
 */
export async function realBoardIo(folder: string): Promise<BoardIo> {
  const ipc = await import('../roadmap-ipc')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { roadmapDir, repoKey } = await ipc.resolveRoadmap(folder)
  const fileOf = (slug: string): string | null => ipc.resolveCardFile(roadmapDir, slug)
  const readFile = async (file: string): Promise<string | null> => {
    try {
      return await fs.promises.readFile(file, 'utf8')
    } catch {
      return null
    }
  }
  return {
    async readAll() {
      let names: string[] = []
      try {
        names = (await fs.promises.readdir(roadmapDir)).filter((n) => n.endsWith('.md'))
      } catch {
        return []
      }
      const out: CardFile[] = []
      for (const name of names) {
        const content = await readFile(path.join(roadmapDir, name))
        if (content !== null) out.push({ slug: name.slice(0, -3), content })
      }
      return out
    },
    async read(slug) {
      const file = fileOf(slug)
      const content = file ? await readFile(file) : null
      return content === null ? null : { slug, content }
    },
    async create(slug, content) {
      return (await ipc.createCardFile(folder, slug, content)).ok
    },
    async write(slug, content) {
      const file = fileOf(slug)
      if (!file) return false
      try {
        await ipc.atomicWrite(file, content)
        return true
      } catch {
        return false
      }
    },
    lock: (fn) => ipc.withCardIdMintLock(repoKey, fn)
  }
}

// ---- Results ---------------------------------------------------------------------------------------

/** A dispatch that could not go on: `code` is the typed reason, `error` says `CODE: what to do`. */
export interface DispatchRefusal {
  ok: false
  code: string
  error: string
}

/** What a dispatch did to the step's card. */
export interface CardOutcome {
  slug: string
  /** The card's id (`T12`), when this dispatch made the card. */
  id?: string
  action: 'created' | 'bound'
}

export interface StepDispatched {
  ok: true
  missionId: string
  stepId: string
  stepTitle: string
  /** `null` for a verifier, and for a dispatch that is not to work of its own. */
  card: CardOutcome | null
  worker: { sessionId: string; role: 'worker' | 'verifier' }
}

const refusal = (code: string, message: string): DispatchRefusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

/** What `create_session`'s ACK gains: the step's card and the worker it attached. */
export function dispatchAck(done: StepDispatched): {
  card: CardOutcome | null
  worker: { sessionId: string; missionId: string; stepId: string; role: 'worker' | 'verifier' }
} {
  return {
    card: done.card,
    worker: {
      sessionId: done.worker.sessionId,
      missionId: done.missionId,
      stepId: done.stepId,
      role: done.worker.role
    }
  }
}

// ---- The mission a dispatch is for ------------------------------------------------------------------

type Found = { ok: true; missionId: string; step: StepV4 } | DispatchRefusal

/** The open v4 mission and the step a dispatch names, or the refusal. */
async function findStep(folder: string, missionId: string, stepId: string): Promise<Found> {
  const read = await readMissionRecord(repoRoot(folder), missionId)
  if (!read.ok) return refusal(read.code, read.error.replace(/^[A-Z_]+: /, ''))
  if (read.source !== 'v4') {
    return refusal(
      'MISSION_NOT_V4',
      `${missionId} is a v3 mission, and dispatching one of its steps would convert it by the first write. Convert it first with a v4 verb such as mission_add_milestone.`
    )
  }
  if (read.record.status === 'closed') {
    return refusal('MISSION_CLOSED', `${missionId} is closed; start a new mission instead.`)
  }
  const resolved = resolveStepId(read.record, stepId)
  const step = resolved === null ? undefined : read.record.steps.find((s) => s.id === resolved)
  if (!step) {
    return refusal(
      'STEP_NOT_FOUND',
      `${missionId} has no step ${stepId}; it has ${read.record.steps.map((s) => s.id).join(', ') || 'no steps'}.`
    )
  }
  return { ok: true, missionId: read.record.id, step }
}

const nowIso = (): string => new Date().toISOString()

// ---- create_session: the card and the worker, in one go ---------------------------------------------

export interface StepDispatchArgs {
  missionId: string
  stepId: string
  /** The REAL id of the session that was started (what its credential carries). */
  sessionId: string
  role: 'worker' | 'verifier'
  /** Where the step's work goes. Default `session`. `internal` is the leader's own subagents: no card. */
  to?: CardSubstrate
  /** A card the step is to be bound to (a manifest or board card), instead of one it already names. */
  card?: string
  at?: string
}

/**
 * Dispatch a step to a session that exists: create or bind its card, attach the session as a worker.
 * Idempotent: dispatching the same step again binds the one card and attaches nothing twice.
 */
export async function dispatchStep(
  folder: string,
  args: StepDispatchArgs,
  board: BoardIo
): Promise<StepDispatched | DispatchRefusal> {
  const found = await findStep(folder, args.missionId, args.stepId)
  if (!found.ok) return found
  const { step } = found
  const at = args.at ?? nowIso()

  let card: CardOutcome | null = null
  if (args.role === 'worker') {
    const planned = await board.lock(async (): Promise<CardOutcome | null | DispatchRefusal> => {
      const cards = await board.readAll()
      const plan = planStepCard({
        missionId: found.missionId,
        step: args.card !== undefined ? { ...step, card: args.card } : step,
        dispatch: { to: args.to ?? 'session' },
        cards,
        provenance: { at }
      })
      if (plan.action === 'refused') return refusal(plan.code, plan.message)
      if (plan.action === 'none') return null
      const written =
        plan.action === 'create'
          ? await board.create(plan.slug, plan.content)
          : await board.write(plan.slug, plan.content)
      if (!written) {
        return refusal(
          'CARD_WRITE_FAILED',
          `the card ${plan.slug} could not be written to the board.`
        )
      }
      return plan.action === 'create'
        ? { slug: plan.slug, id: plan.id, action: 'created' }
        : { slug: plan.slug, action: 'bound' }
    })
    if (planned !== null && 'ok' in planned) return planned
    card = planned
  }

  const attached = await attachDispatchedWorker(folder, found.missionId, {
    sessionId: args.sessionId,
    stepId: step.id,
    actor: { kind: 'harnu' },
    at,
    link: args.role === 'worker',
    ...(card ? { card: card.slug } : {})
  })
  if (!attached.ok) return { ok: false, code: attached.code, error: attached.error }
  return {
    ok: true,
    missionId: found.missionId,
    stepId: step.id,
    stepTitle: step.title,
    card,
    worker: { sessionId: args.sessionId, role: args.role }
  }
}

// ---- submit_manifest: the card is stamped for its step ---------------------------------------------

export interface StampCardArgs {
  slug: string
  missionId: string
  stepId: string
  /** The substrate of the dispatch (the manifest's, else the card's). `internal` stamps nothing. */
  to?: CardSubstrate
  /** Judge and report only: write nothing. A manifest judges every card before it stamps one. */
  dryRun?: boolean
}

/**
 * Stamp an existing card for the step it is the work of, in its frontmatter only (`mission`, `milestone`,
 * `step`): the body is untouched, so the manifest's fingerprint of title, spec and body stays valid.
 * Refused when the card is closed, is the work of another step, or the step already has another card;
 * a card already stamped for this step is left as it is.
 */
export async function stampCardForStep(
  folder: string,
  args: StampCardArgs,
  boardArg?: BoardIo
): Promise<{ ok: true; stamped: boolean } | DispatchRefusal> {
  const found = await findStep(folder, args.missionId, args.stepId)
  if (!found.ok) return found
  const board = boardArg ?? (await realBoardIo(folder))
  const cards = await board.readAll()
  const plan = planStepCard({
    missionId: found.missionId,
    step: { ...found.step, card: args.slug },
    dispatch: { to: args.to ?? 'session' },
    cards,
    provenance: { at: nowIso() }
  })
  if (plan.action === 'refused') return refusal(plan.code, plan.message)
  if (plan.action === 'none') return { ok: true, stamped: false }
  if (plan.action === 'create')
    return refusal('CARD_NOT_FOUND', `the board has no card ${args.slug}.`)

  const own = findStepCard(cards, { missionId: found.missionId, stepId: found.step.id })
  if (own && own.slug !== plan.slug) {
    return refusal(
      'CARD_BOUND_ELSEWHERE',
      `${found.step.id} already has the card ${own.slug}; a step has one card.`
    )
  }
  const file = cards.find((c) => c.slug === plan.slug)
  if (!file) return refusal('CARD_NOT_FOUND', `the board has no card ${args.slug}.`)
  const card = parseCard(file.content, file.slug)
  if (card.mission === found.missionId && card.step === found.step.id) {
    return { ok: true, stamped: false }
  }
  if (args.dryRun) return { ok: true, stamped: true }
  const next = updateFrontmatterFields(file.content, {
    mission: found.missionId,
    milestone: found.step.milestone ?? null,
    step: found.step.id
  })
  if (!(await board.write(plan.slug, next))) {
    return refusal('CARD_WRITE_FAILED', `the card ${plan.slug} could not be written to the board.`)
  }
  return { ok: true, stamped: true }
}

// ---- A card's session boots: the worker is attached --------------------------------------------------

/** A session that materialized: the report the renderer sends when a synthetic id becomes a real one. */
export interface BootedSession {
  syntheticId: string
  sessionId: string
  folder: string
}

export interface BindCardDeps {
  board?: BoardIo
  /** Wait for a synthetic session id to become the real one. Absent: the id given is the real one. */
  waitForBoot?: (syntheticId: string, timeoutMs: number) => Promise<BootedSession | null>
  /** How long to wait for it. A queued boot may be slow; default 15 minutes. */
  timeoutMs?: number
}

const SYNTHETIC_PREFIX = 'synthetic-'
const BOOT_WAIT_MS = 15 * 60_000

export type CardSessionBound =
  { ok: true; bound: false } | (StepDispatched & { bound: true }) | DispatchRefusal

/**
 * A session was bound to a card: when the card is the work of a step, attach the session as that step's
 * worker (and bind the card, so the step names it and it carries the marked block). A card with no step
 * on it binds nothing. The drain binds the synthetic id it spawned, so the real one is awaited first.
 */
export async function bindCardSession(
  folder: string,
  slug: string,
  sessionId: string,
  deps: BindCardDeps = {}
): Promise<CardSessionBound> {
  const board = deps.board ?? (await realBoardIo(folder))
  const file = await board.read(slug)
  if (!file) return { ok: true, bound: false }
  const card = parseCard(file.content, file.slug)
  if (card.malformed || !card.mission || !card.step) return { ok: true, bound: false }

  let realId = sessionId
  if (sessionId.startsWith(SYNTHETIC_PREFIX) && deps.waitForBoot) {
    const booted = await deps.waitForBoot(sessionId, deps.timeoutMs ?? BOOT_WAIT_MS)
    if (!booted) {
      return refusal(
        'SESSION_NOT_BOOTED',
        `the session for ${slug} did not boot in time, so it was not attached to ${card.step}. Attach it from the Mission pane.`
      )
    }
    realId = booted.sessionId
  }
  const to =
    card.substrate !== undefined && isCardSubstrate(card.substrate) ? card.substrate : 'session'
  const done = await dispatchStep(
    folder,
    {
      missionId: card.mission,
      stepId: card.step,
      sessionId: realId,
      role: 'worker',
      to,
      card: slug
    },
    board
  )
  return done.ok ? { ...done, bound: true } : done
}

// ---- The credential of a card's session ---------------------------------------------------------------

/**
 * Just before the session of card `slug` spawns in `spawnFolder`: when the card is the work of an open
 * step, leave the note `pty:create` turns into the session's credential (a worker of that step), so a
 * session the drain or the board starts holds the scoped verbs of its step and not the whole server.
 * `home` is the folder whose board holds the card (a worktree spawn has another folder than its card).
 * `false` when the card has no step, or the step cannot be dispatched to: the spawn is unscoped, as before.
 */
export async function noteCardSpawn(
  spawnFolder: string,
  home: string,
  slug: string,
  boardArg?: BoardIo
): Promise<boolean> {
  try {
    const board = boardArg ?? (await realBoardIo(home))
    const file = await board.read(slug)
    if (!file) return false
    const card = parseCard(file.content, file.slug)
    if (card.malformed || !card.mission || !card.step) return false
    const found = await findStep(home, card.mission, card.step)
    if (!found.ok) return false
    registerPendingSpawn(spawnFolder, {
      role: 'worker',
      missionId: found.missionId,
      stepId: found.step.id
    })
    return true
  } catch {
    return false
  }
}
