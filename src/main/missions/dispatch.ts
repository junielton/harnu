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
 *   is the synthetic one it spawned; the real id is awaited (`session-boot.ts`), written on the card, and
 *   attached, since the scoped credential carries the id the session really has. A card with no step on it
 *   gets its real id and nothing else.
 *
 * {@link noteCardSpawn} is the other half of the scoping: just before a card's session is spawned, it
 * leaves the note `pty:create` turns into the session's credential (S-25's pending spawn), matched by the
 * card's boot prompt.
 *
 * **Born attached.** A session's first turn can come before any of the above has run, so a scoped
 * credential's first call attaches it too ({@link ensureScopedAttached}). **Never silent**: a bind that
 * fails is a `surprise` on the mission Log and a notice in Activity ({@link reportBindFailure}).
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
import { registerCardSpawn, type Scope } from '../mcp/scope'
import { awaitSessionBoot, spawnedSessionId, type BootedSession } from '../mcp/session-boot'
import { findStepCard, planStepCard, type CardFile } from './cards'
import type { StepV4 } from './model'
import { readMissionRecord } from './record-store'
import { attachDispatchedWorker, logBindSurprise, resolveStepId } from './sessions'

// ---- The board, as the dispatch needs it ---------------------------------------------------------

/** What the dispatch needs of the board. The real one is {@link realBoardIo}. */
export interface BoardIo {
  /** Every card on the board, as files. */
  readAll(): Promise<CardFile[]>
  /** One card by slug, or `null` when the board has none. */
  read(slug: string): Promise<CardFile | null>
  /** Write a NEW card file; `false` when it could not (the slug is taken, or the write failed). */
  create(slug: string, content: string): Promise<boolean>
  /**
   * Change a card that exists: `change` gets what the file says now and returns what it should say, or
   * `null` to leave it. Read and write happen with no other writer of the card in between (BUG-296).
   * `false` when the card could not be read or written.
   */
  rewrite(slug: string, change: (content: string) => string | null): Promise<boolean>
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
  const { withPageFileLock } = await import('../mcp/memory-store')
  const { roadmapDir, repoKey } = await ipc.resolveRoadmap(folder)
  const fileOf = (slug: string): string | null => ipc.resolveCardFile(roadmapDir, slug)
  const readFile = async (file: string): Promise<string | null> => {
    try {
      return await fs.promises.readFile(file, 'utf8')
    } catch {
      return null
    }
  }
  const read = async (slug: string): Promise<CardFile | null> => {
    const file = fileOf(slug)
    const content = file ? await readFile(file) : null
    return content === null ? null : { slug, content }
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
    read,
    async create(slug, content) {
      return (await ipc.createCardFile(folder, slug, content)).ok
    },
    async rewrite(slug, change) {
      const file = fileOf(slug)
      if (!file) return false
      return withPageFileLock(file, async () => {
        const content = await readFile(file)
        if (content === null) return false
        const next = change(content)
        if (next === null || next === content) return true
        try {
          await ipc.atomicWrite(file, next)
          return true
        } catch {
          return false
        }
      })
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
  const resolved = resolveStepId(read.record, stepId, missionId)
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
      const planOver = (all: readonly CardFile[]): ReturnType<typeof planStepCard> =>
        planStepCard({
          missionId: found.missionId,
          step: args.card !== undefined ? { ...step, card: args.card } : step,
          dispatch: { to: args.to ?? 'session' },
          cards: all,
          provenance: { at }
        })
      const plan = planOver(cards)
      if (plan.action === 'refused') return refusal(plan.code, plan.message)
      if (plan.action === 'none') return null
      const late: { refused?: DispatchRefusal } = {}
      const written =
        plan.action === 'create'
          ? await board.create(plan.slug, plan.content)
          : await board.rewrite(plan.slug, (content) => {
              // Planned again over what the card says now: it may have changed since the board was read.
              const fresh = planOver(
                cards.map((c) => (c.slug === plan.slug ? { slug: c.slug, content } : c))
              )
              if (fresh.action === 'bind') return fresh.content
              if (fresh.action === 'refused') late.refused = refusal(fresh.code, fresh.message)
              return null
            })
      if (late.refused) return late.refused
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
  const stamp = (content: string): string =>
    updateFrontmatterFields(content, {
      mission: found.missionId,
      milestone: found.step.milestone ?? null,
      step: found.step.id
    })
  if (!(await board.rewrite(plan.slug, stamp))) {
    return refusal('CARD_WRITE_FAILED', `the card ${plan.slug} could not be written to the board.`)
  }
  return { ok: true, stamped: true }
}

// ---- A bind that fails is loud ------------------------------------------------------------------------

/** What could not be bound, as the Log and the notice name it. */
export interface BindFailure {
  folder: string
  /** `CODE: what to do`. */
  reason: string
  missionId?: string
  stepId?: string
  card?: string
  /** The session that was not attached: more than one path may find it out, and one says it. */
  sessionId?: string
}

/** One Activity notice, in the shape `notify.push` takes. */
export interface BindNotice {
  folderPath: string
  title: string
  description: string
  kind: 'warning'
}

export type BindNotifier = (notice: BindNotice) => unknown

let bindNotifier: BindNotifier | null = null

/** How a notice reaches Activity; registered once by the shell that owns the command bridge. */
export function setBindNotifier(fn: BindNotifier | null): void {
  bindNotifier = fn
}

const REPORTED_CAP = 512
const reported = new Set<string>()

/** `true` the first time `key` is seen. Bounded, oldest first. */
function firstReport(key: string): boolean {
  if (reported.has(key)) return false
  reported.add(key)
  if (reported.size > REPORTED_CAP) reported.delete(reported.values().next().value as string)
  return true
}

/** The card of a step: the one the step names, else the one stamped for it. */
async function stepCardName(
  folder: string,
  missionId: string,
  stepId: string
): Promise<string | undefined> {
  try {
    const read = await readMissionRecord(repoRoot(folder), missionId)
    const named = read.ok ? read.record.steps.find((s) => s.id === stepId)?.card : undefined
    if (named) return named
    const cards = await (await realBoardIo(folder)).readAll()
    return findStepCard(cards, { missionId, stepId })?.slug
  } catch {
    return undefined
  }
}

/**
 * A dispatched session could not be attached to its step: one `surprise` on the mission Log and one
 * notice in Activity per session, both naming the card, whichever path finds it out first. Never
 * throws, and one half failing never loses the other.
 */
export async function reportBindFailure(
  failure: BindFailure,
  notify: BindNotifier | null = bindNotifier
): Promise<void> {
  const { folder, missionId, stepId, sessionId, reason } = failure
  if (sessionId !== undefined && !firstReport(`${missionId}/${stepId}/${sessionId}`)) return
  const card =
    failure.card ??
    (missionId !== undefined && stepId !== undefined
      ? await stepCardName(folder, missionId, stepId)
      : undefined)
  const subject = card !== undefined ? `Card ${card}` : `Step ${stepId ?? '?'}`
  console.warn(`[dispatch] ${subject} was not attached to its step: ${reason}`)
  if (missionId !== undefined && stepId !== undefined) {
    try {
      const logged = await logBindSurprise(folder, missionId, {
        stepId,
        reason,
        ...(card !== undefined ? { card } : {})
      })
      if (!logged.ok) console.warn(`[dispatch] the surprise was not logged: ${logged.error}`)
    } catch (err) {
      console.warn('[dispatch] the surprise was not logged:', err)
    }
  }
  try {
    await notify?.({
      folderPath: folder,
      title: `${subject}: its session was not attached`,
      description: reason,
      kind: 'warning'
    })
  } catch (err) {
    console.warn('[dispatch] the notice was not posted:', err)
  }
}

// ---- A verifier is not a card's session ----------------------------------------------------------------

/** Why a manifest entry or a board card that asks for a verifier is refused, and what to do instead. */
export const verifierRefusal = (slug: string): string =>
  `VERIFIER_NOT_DISPATCHABLE: card "${slug}" asks for role verifier, and submit_manifest and the board only start workers. Start the verifier with create_session({ folder, missionId, stepId, role: 'verifier' }). Nothing was dispatched.`

export const asksForVerifier = (role: unknown): boolean =>
  typeof role === 'string' && role.trim().toLowerCase() === 'verifier'

/** The drain retries a refused card on every pass: say it once in a while, not every time. */
const VERIFIER_NOTICE_MS = 10 * 60_000
const verifierNoticed = new Map<string, number>()

/** Tell the operator why the board did not dispatch `slug`. Never throws. */
export async function noticeVerifierRefused(folder: string, slug: string): Promise<void> {
  const key = `${folder}/${slug}`
  if (Date.now() - (verifierNoticed.get(key) ?? 0) < VERIFIER_NOTICE_MS) return
  verifierNoticed.set(key, Date.now())
  try {
    await bindNotifier?.({
      folderPath: folder,
      title: `Card ${slug}: not dispatched`,
      description: verifierRefusal(slug),
      kind: 'warning'
    })
  } catch (err) {
    console.warn('[dispatch] the notice was not posted:', err)
  }
}

// ---- A scoped session's first call ---------------------------------------------------------------------

/**
 * Born attached (AC-11): a session holding a step's scoped credential may call before its transcript
 * landed, so before the dispatch path attached it. The credential is Harnu's own proof of who it is and
 * what it was started for, so the first call attaches it. A session the record already knows is left
 * alone: one the mission released stays released. A failure is reported and the call goes on to its
 * own refusal.
 */
export async function ensureScopedAttached(
  scope: Extract<Scope, { role: 'worker' | 'verifier' }>
): Promise<void> {
  const failed = (reason: string): Promise<void> =>
    reportBindFailure({
      folder: scope.folder,
      missionId: scope.missionId,
      stepId: scope.stepId,
      sessionId: scope.sessionId,
      reason
    })
  try {
    const read = await readMissionRecord(repoRoot(scope.folder), scope.missionId)
    // No such mission, an unconverted or a closed one: the verb says so itself.
    if (!read.ok || read.source !== 'v4' || read.record.status === 'closed') return
    if (read.record.sessions.some((s) => s.id === scope.sessionId)) return
    const done = await dispatchStep(
      scope.folder,
      {
        missionId: scope.missionId,
        stepId: scope.stepId,
        sessionId: scope.sessionId,
        role: scope.role,
        to: 'session'
      },
      await realBoardIo(scope.folder)
    )
    if (!done.ok) await failed(done.error)
  } catch (err) {
    await failed(err instanceof Error ? err.message : String(err))
  }
}

// ---- A card's session boots: the worker is attached --------------------------------------------------

export type { BootedSession }

export interface BindCardDeps {
  board?: BoardIo
  /** Wait for a synthetic session id to become the real one. Default: `session-boot.ts`. */
  waitForBoot?: (syntheticId: string, timeoutMs: number) => Promise<BootedSession | null>
  /** How long to wait for it. A queued boot may be slow; default 15 minutes. */
  timeoutMs?: number
}

let bootWaiter: BindCardDeps['waitForBoot'] | null = null
export function setBootWaiter(fn: BindCardDeps['waitForBoot'] | null): void {
  bootWaiter = fn ?? null
}

const SYNTHETIC_PREFIX = 'synthetic-'
const BOOT_WAIT_MS = 15 * 60_000

/** A bind that failed, with the step it was for when the card said so. */
export type BindRefusal = DispatchRefusal & { missionId?: string; stepId?: string }

export type CardSessionBound =
  { ok: true; bound: false } | (StepDispatched & { bound: true }) | BindRefusal

/** What a card says of the step it is the work of. */
type CardStep =
  | { kind: 'step'; mission: string; step: string; substrate?: string }
  | { kind: 'plain' }
  /** Missing, empty or not a card: nothing can be said of it, which is never "no step". */
  | { kind: 'unreadable' }

async function readCardStep(board: BoardIo, slug: string): Promise<CardStep> {
  const file = await board.read(slug)
  if (!file) return { kind: 'unreadable' }
  const card = parseCard(file.content, file.slug)
  if (card.malformed) return { kind: 'unreadable' }
  if (!card.mission || !card.step) return { kind: 'plain' }
  return { kind: 'step', mission: card.mission, step: card.step, substrate: card.substrate }
}

/** The refusal of a bind, carrying the step the card named at any time. */
function bindRefusal(code: string, message: string, ...seen: CardStep[]): BindRefusal {
  const known = seen.find((c) => c.kind === 'step')
  return {
    ...refusal(code, message),
    ...(known?.kind === 'step' ? { missionId: known.mission, stepId: known.step } : {})
  }
}

/**
 * A session was bound to a card. The drain and the board bind the synthetic id they spawned, so the
 * real one is awaited first and written on the card (AC-14). When the card is the work of a step, the
 * session is then attached as that step's worker (and the card bound, so the step names it and it
 * carries the marked block). A card with no step on it binds nothing; a card that cannot be read, or
 * lost its step on the way, is a failure and never a card with no step.
 */
export async function bindCardSession(
  folder: string,
  slug: string,
  sessionId: string,
  deps: BindCardDeps = {}
): Promise<CardSessionBound> {
  const board = deps.board ?? (await realBoardIo(folder))
  const before = await readCardStep(board, slug)

  let realId = sessionId
  if (sessionId.startsWith(SYNTHETIC_PREFIX)) {
    const waitForBoot = deps.waitForBoot ?? bootWaiter ?? awaitSessionBoot
    const booted = await waitForBoot(sessionId, deps.timeoutMs ?? BOOT_WAIT_MS)
    if (!booted) {
      const now = await readCardStep(board, slug)
      return now.kind === 'plain' && before.kind !== 'step'
        ? { ok: true, bound: false }
        : bindRefusal(
            'SESSION_NOT_BOOTED',
            `the session for ${slug} did not boot in time, so it was not attached to its step. Attach it from the Mission dropdown.`,
            now,
            before
          )
    }
    realId = booted.sessionId
    await board.rewrite(slug, (content) =>
      parseCard(content, slug).session === sessionId
        ? updateFrontmatterFields(content, { session: realId })
        : null
    )
  }
  // Read now, not only before the wait: the boot may have taken minutes.
  const card = await readCardStep(board, slug)
  if (card.kind === 'plain' && before.kind !== 'step') return { ok: true, bound: false }
  if (card.kind !== 'step') {
    return bindRefusal(
      'CARD_UNREADABLE',
      `the card ${slug} could not be read as the work of its step once its session booted, so the session was not attached. Check the card, then attach the session from the Mission dropdown.`,
      before
    )
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
  return done.ok
    ? { ...done, bound: true }
    : { ...done, missionId: card.mission, stepId: card.step }
}

// ---- The credential of a card's session ---------------------------------------------------------------

/** Where a card's session is about to spawn, and with what boot prompt. */
export interface CardSpawn {
  /** Left out when the card is cut into a worktree that does not exist yet. */
  spawnFolder?: string
  /** The folder whose board holds the card. */
  home: string
  slug: string
  /** The boot prompt the session is spawned with: what tells its note from another card's. */
  prompt?: string
}

/**
 * Leave the note `pty:create` turns into the session's credential (a worker of the card's step), so a
 * session the drain or the board starts holds the scoped verbs of its step and not the whole server.
 * Returns the function that takes the note back, or `null` when the card has no step or the step cannot
 * be dispatched to: the spawn is unscoped, as before, and the bind says why.
 */
async function noteSpawnOfCard(at: CardSpawn, boardArg?: BoardIo): Promise<(() => void) | null> {
  try {
    const board = boardArg ?? (await realBoardIo(at.home))
    const file = await board.read(at.slug)
    if (!file) return null
    const card = parseCard(file.content, file.slug)
    if (card.malformed || !card.mission || !card.step) return null
    const found = await findStep(at.home, card.mission, card.step)
    if (!found.ok) return null
    return registerCardSpawn({
      spawn: { role: 'worker', missionId: found.missionId, stepId: found.step.id },
      ...(at.spawnFolder !== undefined ? { folder: at.spawnFolder } : {}),
      ...(at.prompt !== undefined ? { prompt: at.prompt } : {})
    })
  } catch {
    return null
  }
}

/** Note the credential of card `slug`, whose session spawns in `spawnFolder`. `false`: nothing noted. */
export async function noteCardSpawn(
  spawnFolder: string,
  home: string,
  slug: string,
  boardArg?: BoardIo,
  prompt?: string
): Promise<boolean> {
  return (await noteSpawnOfCard({ spawnFolder, home, slug, prompt }, boardArg)) !== null
}

// ---- The board's and the drain's side of it ------------------------------------------------------------

/**
 * A card was bound to its session (`bindSessionCore`, the one place the board's Dispatch button and the
 * manifest drain both bind through). The session's real id is written on the card and, when the card is
 * the work of a step, the session is attached to the step as a worker once it has booted. Detached on
 * purpose: a boot may queue for minutes and the caller never waits on it; a failure is reported on the
 * mission Log and in Activity. Never throws.
 */
export function bindStepSession(folder: string, slug: string, sessionId: string): void {
  const failed = async (reason: string, step?: BindRefusal): Promise<void> => {
    let at = step?.missionId ? { missionId: step.missionId, stepId: step.stepId } : undefined
    if (!at) {
      const card = await readCardStep(await realBoardIo(folder), slug)
      // A card with no step was never to be attached: only its real session id could not be written.
      if (card.kind === 'plain') {
        console.warn(`[dispatch] ${slug} kept its synthetic session id: ${reason}`)
        return
      }
      if (card.kind === 'step') at = { missionId: card.mission, stepId: card.step }
    }
    await reportBindFailure({
      folder,
      card: slug,
      reason,
      sessionId: spawnedSessionId(sessionId) ?? sessionId,
      ...at
    })
  }
  void bindCardSession(folder, slug, sessionId)
    .then(async (res) => {
      if (!res.ok) await failed(res.error, res)
    })
    .catch((err) => failed(err instanceof Error ? err.message : String(err)))
    .catch((err) => console.warn(`[dispatch] ${slug} was not attached to its step:`, err))
}

/**
 * The board's Dispatch button plans the dispatch before it spawns. When the card is the work of a step,
 * leave the credential note for the session it is about to spawn, matched by the planned prompt. A card
 * cut into a worktree is noted with no folder (the worktree does not exist yet), so only the prompt can
 * claim it. `false` when nothing was noted.
 */
export async function noteBoardCardSpawn(
  folder: string,
  slug: string,
  boardArg?: BoardIo,
  prompt?: string
): Promise<boolean> {
  try {
    const board = boardArg ?? (await realBoardIo(folder))
    const file = await board.read(slug)
    if (!file) return false
    const substrate = parseCard(file.content, file.slug).substrate
    if (substrate === 'internal') return false
    const elsewhere = substrate === 'worktree'
    if (elsewhere && !prompt) return false
    const noted = await noteSpawnOfCard(
      { home: folder, slug, prompt, ...(elsewhere ? {} : { spawnFolder: folder }) },
      board
    )
    return noted !== null
  } catch {
    return false
  }
}

/**
 * What the manifest drain's shell does around a card's session, in the order the drain calls it:
 * `planned` (the card is next), `cut` (its worktree exists, for a worktree card), then `beforeSpawn`
 * (leave the credential note, for the folder and prompt it spawns with). The drain's `spawnSession` is
 * not told which card it is spawning for, so the card waits here by the folder its session spawns in
 * (one card is dispatched at a time within a pass). Attaching the session is `bindStepSession`'s, from
 * the bind. A card with no step is untouched by all of it.
 */
export function createDrainBinder(): {
  planned(folder: string, slug: string): void
  cut(worktreePath: string, home: string, slug: string): void
  /** Take the card waiting for `spawnFolder` and leave its note. The returned function undoes the note. */
  beforeSpawn(spawnFolder: string, prompt?: string): Promise<() => void>
} {
  const dispatching = new Map<string, { home: string; slug: string }>()
  return {
    planned: (folder, slug) => void dispatching.set(folder, { home: folder, slug }),
    cut: (worktreePath, home, slug) => void dispatching.set(worktreePath, { home, slug }),
    async beforeSpawn(spawnFolder, prompt) {
      const card = dispatching.get(spawnFolder)
      dispatching.delete(spawnFolder)
      const undo = card ? await noteSpawnOfCard({ ...card, spawnFolder, prompt }) : null
      return () => undo?.()
    }
  }
}
