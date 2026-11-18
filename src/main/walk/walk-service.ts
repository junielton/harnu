/**
 * Guided walks: the service behind the four verbs and the operator's outcomes (spec S-2).
 *
 * One object per repo (cached by the walks directory) that owns the rules between the pure machine, the
 * store and the user-turn route:
 *
 *  - the SESSION side: `open`, `extend`, `report` and `get`, which the `walk_*` verbs call;
 *  - the OPERATOR side: `operate`, which the pane's IPC calls (S-3) and the tests call now. It applies one
 *    machine step and writes, in the SAME file write, the `[harnu-walk]` turn that step owes the session
 *    (the outbox), so a crash cannot lose a turn;
 *  - DELIVERY: a turn waits in the run's outbox until `deliver` says a session took it, and `replay`
 *    offers every waiting turn again (after a restart, or when a session comes back).
 *
 * Electron-free: what lives outside (delivering a turn, opening a pane) is the injected
 * {@link WalkRuntime}, which `src/main/index.ts` wires to the command bridge.
 *
 * No verb here takes a command to run, presses an outcome, re-runs, exports, deletes, or settles a
 * criterion; nothing in this module reaches `markCriterion` (the operator's Mark done stays theirs).
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { rawRm } from '../raw-fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { DeliveryOutcome, UserTurnPayload } from '../browser/page-delivery'
import { deliverUserTurn } from '../browser/page-delivery'
import {
  appendChecks,
  back,
  canEscalate,
  closeOutWithSkipped,
  continueWithout,
  done,
  endRun,
  fail,
  followAnyway,
  ordinalOf,
  pickSkipped,
  report as machineReport,
  skip,
  startRun,
  tryAgain,
  treatAsFailed,
  totalChecks,
  view,
  type MachineError,
  type MachineResult,
  type Run
} from '../../shared/walk-machine'
import {
  LIMITS,
  URL_IN_PROSE_MESSAGE,
  URL_IN_PROSE_RE,
  toMachineChecks,
  validateWalkScript,
  type DoItem,
  type Violation,
  type WalkCheck,
  type WalkImage,
  type WalkProbe,
  type WalkScript
} from '../../shared/walk-schema'
import { sourceIdentity, type WalkSource } from '../../shared/walk-source'
import {
  createWalkStore,
  walksDir,
  type OwedTurn,
  type RunRecord,
  type WalkLibraryEntry,
  type WalkRecord,
  type WalkStore
} from './walk-store'
import {
  closeOutText,
  formatTurn,
  progressOf,
  turnKindFor,
  type OperatorOp,
  type TurnCheck,
  type TurnInput,
  type WalkTurnKind
} from './walk-turn'

// ---- Runtime (what lives outside) -------------------------------------------------------------

export interface WalkRuntime {
  /** Hand one turn to the user-turn route; `held` and `failed` leave it in the outbox. */
  deliver(turn: UserTurnPayload): Promise<DeliveryOutcome>
  /** Ask the folder's helper stack to open the pane, in the background. `false` while no pane exists. */
  openPane(a: { folder: string; walkId: string; runId: string }): Promise<boolean>
}

let runtime: WalkRuntime | null = null

/** Wire the runtime (once, from `src/main/index.ts`). Tests build services with their own. */
export function configureWalkRuntime(rt: WalkRuntime | null): void {
  runtime = rt
}

/**
 * The runtime that rides the command bridge: a turn goes through `deliverUserTurn` (the `walk` source of
 * the user-turn route, which wakes a parked session), and the pane is asked for with `pane.openWalk`
 * (which the renderer does not know until S-3, so it answers an error and `opened` stays false).
 */
export function createBridgeRuntime(
  bridge: { dispatch(command: string, payload: unknown): Promise<unknown> },
  waitForSessionReady: (sessionId: string, timeoutMs: number) => Promise<boolean>
): WalkRuntime {
  return {
    deliver: (turn) =>
      deliverUserTurn({ dispatch: (c, p) => bridge.dispatch(c, p), waitForSessionReady }, turn),
    async openPane(a) {
      const res = (await bridge
        .dispatch('pane.openWalk', {
          worktreePath: a.folder,
          walkId: a.walkId,
          runId: a.runId
        })
        .catch(() => null)) as { error?: unknown } | null
      return res !== null && typeof res === 'object' && typeof res.error !== 'string'
    }
  }
}

// ---- Results ----------------------------------------------------------------------------------

export type WalkError = { code: string; message: string } & Record<string, unknown>
export type Refused = { ok: false; error: WalkError; rejected?: Violation[] }
export type Result<T> = ({ ok: true } & T) | Refused

const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): Refused => ({
  ok: false,
  error: { code, message, ...extra }
})
const fromMachine = (e: MachineError & { runId?: string; rev?: number }): Refused => {
  const { code, message, ...rest } = e
  return refuse(code, message, rest)
}

const GLYPH = {
  todo: '-',
  awaiting: '-',
  skipped: '-',
  verified: '✓',
  caveat: '!',
  disagrees: '!',
  failed: '✗'
} as const

// ---- Text rules for what the agent sends after the script -------------------------------------

/** Plain text only, as in a script: no emoji (a copy of the schema's rule, which is not exported). */
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|️|⃣/u
const PLACEHOLDER_RE = /<[A-Za-z][A-Za-z0-9_ .-]{0,40}>/

export const EXTEND_LIMITS = {
  more: LIMITS.more,
  extra: 6,
  /** Deepenings accumulate, at most this many sub-checks per check. */
  extraPerCheck: 18,
  simplerText: 240,
  simplerDo: 5,
  evidence: 600,
  correction: 600
} as const

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

class Violations {
  readonly list: Violation[] = []
  add(path: string, rule: string, message: string): void {
    if (!this.list.some((v) => v.path === path && v.rule === rule))
      this.list.push({ path, rule, message })
  }
}

function proseRules(
  v: Violations,
  probe: WalkProbe,
  path: string,
  text: string,
  max: number
): void {
  if (text.length > max) v.add(path, 'TOO_LONG', `At most ${max} characters.`)
  if (EMOJI_RE.test(text)) v.add(path, 'EMOJI', 'Plain text only: no emoji.')
  if (probe.looksLikeSecret(text)) v.add(path, 'SECRET_IN_TEXT', 'That text looks like a secret.')
}

function doItems(
  v: Violations,
  probe: WalkProbe,
  path: string,
  raw: unknown,
  max: number
): DoItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    v.add(path, 'MISSING', 'A list of at least one item.')
    return []
  }
  if (raw.length > max) v.add(path, 'TOO_MANY', `At most ${max} items.`)
  const out: DoItem[] = []
  raw.forEach((it: unknown, i: number) => {
    const p = `${path}[${i}]`
    if (!isObj(it)) return v.add(p, 'NOT_AN_OBJECT', 'An item is an object.')
    if (!nonEmpty(it.text)) v.add(`${p}.text`, 'MISSING', 'Say what to do.')
    else {
      proseRules(v, probe, `${p}.text`, it.text, LIMITS.passes)
      if (URL_IN_PROSE_RE.test(it.text)) v.add(`${p}.text`, 'URL_IN_PROSE', URL_IN_PROSE_MESSAGE)
    }
    if (!nonEmpty(it.see)) v.add(`${p}.see`, 'MISSING', 'Say what the operator should see.')
    else proseRules(v, probe, `${p}.see`, it.see, LIMITS.passes)
    if (it.block !== undefined) {
      if (!isObj(it.block) || !nonEmpty(it.block.text))
        v.add(`${p}.block`, 'BAD_VALUE', 'A block has its text.')
      else {
        if (PLACEHOLDER_RE.test(it.block.text))
          v.add(`${p}.block`, 'PLACEHOLDER_IN_COMMAND', 'Write the real value, not a placeholder.')
        if (probe.looksLikeSecret(it.block.text))
          v.add(`${p}.block`, 'SECRET_IN_TEXT', 'That text looks like a secret.')
      }
    }
    out.push(it as unknown as DoItem)
  })
  return out
}

// ---- Arguments --------------------------------------------------------------------------------

export interface ExtendArgs {
  walkId: string
  checkId?: string
  more?: unknown
  extra?: unknown
  simpler?: unknown
  append?: unknown
  expectRev?: number
}

export type ReportArgs =
  | {
      walkId: string
      runId?: string
      checkId: string
      kind?: 'check'
      result: 'pass' | 'fail'
      evidence: string
    }
  | { walkId: string; runId?: string; checkId: string; kind: 'correction'; text: string }

export interface OperateArgs {
  walkId: string
  runId: string
  op: OperatorOp
  /** `fail`: the operator's line. */
  line?: string
  /** `fail`: the absolute path of the screenshot Harnu saved in the run's shots folder. */
  shot?: string
  /** `pick-skipped`: the check to retry. */
  checkId?: string
  /** `end`, or any step that ends the run: the pane's own close-out text (else the default). */
  closeOut?: string
  /** `continue-without`: the wait, for a dev override of the 30 s of D-7. */
  waitMs?: number
}

export interface WalkService {
  readonly folder: string
  readonly store: WalkStore
  open(a: { sessionId?: string; script: unknown; probe: WalkProbe }): Promise<
    Result<{
      walkId: string
      runId: string
      checks: number
      toWalk: number
      rejected: Violation[]
      opened: boolean
    }>
  >
  get(a: { walkId: string }): Promise<Result<{ walk: Record<string, unknown> }>>
  getBySource(a: { source: unknown }): Promise<Result<{ walks: Record<string, unknown>[] }>>
  extend(a: ExtendArgs & { probe: WalkProbe }): Promise<Result<Record<string, unknown>>>
  report(a: ReportArgs): Promise<Result<Record<string, unknown>>>
  operate(a: OperateArgs): Promise<Result<{ run: Run; sent: WalkTurnKind[] }>>
  /** Offer every turn still in an outbox again, oldest first (after a restart, or when a session returns). */
  replay(): Promise<{ delivered: number; pending: number }>
  /** Resolves when every delivery started so far has settled (tests, and a clean shutdown). */
  idle(): Promise<void>
}

export interface WalkServiceOptions {
  /** Share an existing store (a repo's worktrees share one); default: a new one. */
  store?: WalkStore
  runtime?: () => WalkRuntime | null
  now?: () => number
  newId?: (prefix: 'wlk' | 'run' | 'out') => string
}

// ---- The service ------------------------------------------------------------------------------

/** One store per walks directory: it serialises the writes of a walk, so worktrees of a repo share it. */
const stores = new Map<string, WalkStore>()
const services = new Map<string, WalkService>()
/** A run being flushed right now (module-wide, so two services of one repo never deliver a turn twice). */
const flushing = new Set<string>()

/**
 * The service of a folder. Each folder keeps its own (a turn names the folder it was opened from, so the
 * session fallback is the right worktree's), over the one store of its repo.
 */
export function walkServiceFor(folder: string): WalkService {
  const key = resolve(folder)
  let svc = services.get(key)
  if (!svc) {
    const dir = walksDir(folder)
    let store = stores.get(dir)
    if (!store) {
      store = createWalkStore(folder)
      stores.set(dir, store)
    }
    svc = createWalkService(folder, { store })
    services.set(key, svc)
  }
  return svc
}

export function createWalkService(folder: string, opts: WalkServiceOptions = {}): WalkService {
  const now = opts.now ?? Date.now
  const store =
    opts.store ??
    createWalkStore(folder, {
      now,
      ...(opts.newId ? { newId: opts.newId } : {})
    })
  const rt = (): WalkRuntime | null => (opts.runtime ? opts.runtime() : runtime)
  const inflight = new Set<Promise<unknown>>()

  // ---- images and edge ids: made when a script is accepted -----------------------------------

  /** Copy the checks' images into the walk's own folder and give every `edge` item its id. */
  async function adoptChecks(
    checks: WalkCheck[],
    walkDir: string,
    taken = 0
  ): Promise<WalkCheck[]> {
    const out: WalkCheck[] = []
    let n = taken
    for (const check of checks) {
      let next: WalkCheck = check
      if (check.images?.length) {
        await mkdir(join(walkDir, 'images'), { recursive: true })
        const images: WalkImage[] = []
        for (const im of check.images) {
          const from = isAbsolute(im.src) ? resolve(im.src) : resolve(folder, im.src)
          const name = `${check.id}-${++n}-${basename(from).replace(/[^A-Za-z0-9._-]/g, '_')}`
          await copyFile(from, join(walkDir, 'images', name))
          images.push({ ...im, src: `images/${name}` })
        }
        next = { ...next, images }
      }
      if (check.edge?.length)
        next = { ...next, edge: check.edge.map((e, i) => ({ ...e, id: `e${i + 1}` })) }
      out.push(next)
    }
    return out
  }

  // ---- delivery ------------------------------------------------------------------------------

  async function ownerOf(walkId: string, rec: RunRecord): Promise<string | null> {
    if (rec.ownerSessionId) return rec.ownerSessionId
    // a re-run has no caller: the session that wrote the walk, else the folder's selected one (null)
    const first = (await store.listRuns(walkId))[0]
    return first?.ownerSessionId ?? null
  }

  /** The session a run's turns are addressed to, read before a step (the turn builders are synchronous). */
  async function ownerOfRun(walkId: string, runId: string): Promise<string | null> {
    const rec = await store.readRun(walkId, runId)
    return rec ? ownerOf(walkId, rec) : null
  }

  async function flush(
    walkId: string,
    runId: string
  ): Promise<{ delivered: number; pending: number }> {
    const key = `${walksDir(folder)}/${walkId}/${runId}`
    const out = { delivered: 0, pending: 0 }
    const r = rt()
    if (!r || flushing.has(key)) {
      out.pending = (await store.pendingOutbox(walkId, runId)).length
      return out
    }
    flushing.add(key)
    try {
      const rec = await store.readRun(walkId, runId)
      if (!rec) return out
      const sessionId = await ownerOf(walkId, rec)
      const pending = await store.pendingOutbox(walkId, runId)
      for (const entry of pending) {
        const outcome = await r
          .deliver({ sessionId, folder, text: entry.text, source: 'walk' })
          .catch((): DeliveryOutcome => ({ status: 'failed', reason: 'delivery threw' }))
        if (outcome.status !== 'delivered') break // order matters: nothing overtakes a waiting turn
        await store.markDelivered(walkId, runId, entry.id)
        out.delivered++
        // the agent's wait runs from the moment its turn is taken, not from the press (D-7)
        if (entry.kind === 'done' && entry.checkId) {
          const at = now()
          await store.updateRun(walkId, runId, (run) => {
            const c = run.checks.find((k) => k.id === entry.checkId)
            if (!c || c.state !== 'awaiting') return { ok: true, run }
            const next = structuredClone(run)
            next.checks.find((k) => k.id === entry.checkId)!.deliveredAt = at
            return { ok: true, run: next }
          })
        }
      }
      out.pending = (await store.pendingOutbox(walkId, runId)).length
      return out
    } finally {
      flushing.delete(key)
    }
  }

  function kick(walkId: string, runId: string): void {
    const p = flush(walkId, runId)
      .catch(() => undefined)
      .finally(() => inflight.delete(p))
    inflight.add(p)
  }

  // ---- turns: built from the walk and the run, after the step --------------------------------

  function turnCheck(run: Run, walk: WalkRecord, id: string): TurnCheck | undefined {
    const c = walk.script.checks.find((k) => k.id === id)
    const n = ordinalOf(run, id)
    if (!c || n === null) return undefined
    return { id, title: c.title, how: c.check?.how ?? null, n }
  }

  function baseTurn(
    kind: WalkTurnKind,
    run: Run,
    ctx: { walk: WalkRecord; rec: RunRecord },
    sessionId: string | null
  ): TurnInput {
    return {
      kind,
      walkTitle: ctx.walk.script.title,
      walkId: ctx.walk.walkId,
      runId: ctx.rec.runId,
      runN: run.n,
      total: totalChecks(run),
      sessionId,
      source: ctx.walk.script.source,
      progress: progressOf(run)
    }
  }

  /** The close-out turn a step owes when it ended the run. */
  function closedTurn(
    prev: Run,
    next: Run,
    ctx: { walk: WalkRecord; rec: RunRecord },
    owner: string | null,
    closeOut: string | undefined
  ): OwedTurn[] {
    if (prev.state === 'ended' || next.state !== 'ended') return []
    const text = formatTurn({
      ...baseTurn('closed', next, ctx, owner),
      closeOut: closeOut ?? closeOutText(next, ctx.walk.script)
    })
    return [{ kind: 'closed', checkId: null, text }]
  }

  // ---- the verbs -----------------------------------------------------------------------------

  const svc: WalkService = {
    folder,
    store,

    async open({ sessionId, script, probe }) {
      const v = validateWalkScript(script, probe)
      if (!v.ok)
        return {
          ...refuse('SCRIPT_REJECTED', 'The script broke rules: fix each one and send it whole.'),
          rejected: v.violations
        }
      const id = sourceIdentity(v.script.source)
      const live = (await store.listWalks()).find(
        (e) => e.status === 'live' && e.live && sourceIdentity(e.source) === id
      )
      if (live?.live)
        return refuse(
          'WALK_RUN_LIVE',
          'A run of a walk with this source is live: continue it, or let the operator end it.',
          { walkId: live.walkId, runId: live.live.runId }
        )
      let created: { walkId: string; runId: string; n: number }
      try {
        created = await store.createWalk(v.script, {
          ...(sessionId ? { ownerSessionId: sessionId } : {}),
          transform: async (s, { walkDir }) => {
            try {
              return { ...s, checks: await adoptChecks(s.checks, walkDir) }
            } catch (err) {
              await rawRm(walkDir, { recursive: true, force: true })
              throw err
            }
          }
        })
      } catch (err) {
        return refuse(
          'IMAGE_COPY_FAILED',
          `An image could not be copied into the walk: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const r = rt()
      const opened = r
        ? await r
            .openPane({ folder, walkId: created.walkId, runId: created.runId })
            .catch(() => false)
        : false
      return {
        ok: true,
        walkId: created.walkId,
        runId: created.runId,
        checks: v.script.checks.length,
        toWalk: v.script.checks.filter((c) => !c.status).length,
        rejected: [],
        opened
      }
    },

    async get({ walkId }) {
      const walk = await store.readWalk(walkId)
      if (!walk) return refuse('WALK_NOT_FOUND', 'No such walk.')
      return { ok: true, walk: await describeWalk(walk) }
    },

    async getBySource({ source }) {
      const parsed = looseSource(source)
      if (!parsed) return refuse('BAD_ARGS', 'source is not a walk source.')
      const id = sourceIdentity(parsed)
      const entries = (await store.listWalks()).filter((e) => sourceIdentity(e.source) === id)
      const walks: Record<string, unknown>[] = []
      for (const e of entries) walks.push(summaryOf(e))
      return { ok: true, walks }
    },

    async extend(a) {
      const walk0 = await store.readWalk(a.walkId)
      if (!walk0) return refuse('WALK_NOT_FOUND', 'No such walk (it may have been deleted).')

      if (a.append !== undefined) {
        if (
          a.checkId !== undefined ||
          a.more !== undefined ||
          a.extra !== undefined ||
          a.simpler !== undefined
        )
          return refuse(
            'BAD_ARGS',
            'append stands alone: send it without checkId, more, extra or simpler.'
          )
        return extendAppend(a, walk0)
      }
      if (!nonEmpty(a.checkId)) return refuse('BAD_ARGS', 'checkId is required (or send append).')
      if (a.more === undefined && a.extra === undefined && a.simpler === undefined)
        return refuse('BAD_ARGS', 'Send more, extra or simpler.')
      if (!walk0.script.checks.some((c) => c.id === a.checkId))
        return refuse('CHECK_NOT_FOUND', `No check ${a.checkId} in this walk.`)

      const v = new Violations()
      const checkId = a.checkId
      if (a.more !== undefined) {
        if (!nonEmpty(a.more)) v.add('$.more', 'BAD_VALUE', 'more is text.')
        else proseRules(v, a.probe, '$.more', a.more, EXTEND_LIMITS.more)
      }
      let extra: DoItem[] | undefined
      if (a.extra !== undefined)
        extra = doItems(v, a.probe, '$.extra', a.extra, EXTEND_LIMITS.extra)
      let simpler: { text: string; do: DoItem[] } | undefined
      if (a.simpler !== undefined) {
        if (!isObj(a.simpler)) v.add('$.simpler', 'NOT_AN_OBJECT', 'simpler is an object.')
        else {
          if (!nonEmpty(a.simpler.text)) v.add('$.simpler.text', 'MISSING', 'Say it more simply.')
          else proseRules(v, a.probe, '$.simpler.text', a.simpler.text, EXTEND_LIMITS.simplerText)
          const d = doItems(v, a.probe, '$.simpler.do', a.simpler.do, EXTEND_LIMITS.simplerDo)
          simpler = { text: String(a.simpler.text ?? ''), do: d }
        }
      }
      if (v.list.length)
        return { ...refuse('EXTENSION_REJECTED', 'The extension broke rules.'), rejected: v.list }

      const res = await store.updateWalk(a.walkId, (walk) => {
        if (a.expectRev !== undefined && a.expectRev !== walk.rev)
          return {
            ok: false,
            error: {
              code: 'REV_CONFLICT',
              message: 'The walk changed: read it and send again.',
              rev: walk.rev
            } as MachineError
          }
        const addedInRun = addedInRunOf(walk)
        const at = now()
        const deepenings = [...(walk.deepenings ?? [])]
        const simplerCards = [...(walk.simpler ?? [])]
        if (a.more !== undefined || extra) {
          const used = deepenings
            .filter((d) => d.checkId === checkId)
            .reduce((n, d) => n + (d.extra?.length ?? 0), 0)
          if (used + (extra?.length ?? 0) > EXTEND_LIMITS.extraPerCheck)
            return {
              ok: false,
              error: {
                code: 'TOO_MANY_EXTRA',
                message: `A check takes at most ${EXTEND_LIMITS.extraPerCheck} sub-checks in all.`
              }
            }
          const taken = (walk.script.checks.find((c) => c.id === checkId)?.edge?.length ?? 0) + used
          deepenings.push({
            checkId,
            ...(typeof a.more === 'string' ? { more: a.more } : {}),
            ...(extra ? { extra: extra.map((e, i) => ({ ...e, id: `e${taken + i + 1}` })) } : {}),
            addedInRun,
            at
          })
        }
        if (simpler)
          simplerCards.push({ checkId, text: simpler.text, do: simpler.do, addedInRun, at })
        return { ok: true, walk: { ...walk, deepenings, simpler: simplerCards } }
      })
      if (!res.ok) return fromMachine(res.error)
      return { ok: true, op: 'walk_extend', walkId: a.walkId, rev: res.walk.rev }
    },

    async report(a) {
      const walk = await store.readWalk(a.walkId)
      if (!walk) return refuse('WALK_NOT_FOUND', 'No such walk.')
      const runId = a.runId ?? walk.live?.runId
      if (!runId) return refuse('RUN_NOT_LIVE', 'The walk has no live run to report on.')
      const v = new Violations()
      const probe = nullProbe
      const text = a.kind === 'correction' ? a.text : a.evidence
      const max = a.kind === 'correction' ? EXTEND_LIMITS.correction : EXTEND_LIMITS.evidence
      if (!nonEmpty(text))
        return refuse(
          'BAD_ARGS',
          a.kind === 'correction' ? 'text is required.' : 'evidence is required.'
        )
      proseRules(v, probe, '$.text', text, max)
      if (EMOJI_RE.test(text) || text.length > max)
        return { ...refuse('REPORT_REJECTED', 'The text broke rules.'), rejected: v.list }
      const at = now()
      const owner = await ownerOfRun(a.walkId, runId)
      const res = await store.updateRun(
        a.walkId,
        runId,
        (run) =>
          machineReport(
            run,
            a.kind === 'correction'
              ? { kind: 'correction', checkId: a.checkId, text }
              : { kind: 'check', checkId: a.checkId, result: a.result, evidence: text, now: at }
          ),
        {
          turns: (next, ctx) => closedTurn(ctx.rec.run, next, ctx, owner, undefined),
          closeOut: (next, ctx) =>
            ctx.rec.run.state !== 'ended' && next.state === 'ended'
              ? closeOutText(next, ctx.walk.script)
              : null
        }
      )
      if (!res.ok) return fromMachine(res.error)
      if (res.owed.length) kick(a.walkId, runId)
      return {
        ok: true,
        op: 'walk_report',
        walkId: a.walkId,
        runId,
        checkId: a.checkId,
        view: view(res.run)
      }
    },

    async operate(a) {
      const at = now()
      const step = (run: Run): MachineResult => applyOp(run, a, at)
      let sent: WalkTurnKind[] = []
      const owner = await ownerOfRun(a.walkId, a.runId)
      const res = await store.updateRun(a.walkId, a.runId, step, {
        turns: (next, ctx) => {
          const prev = ctx.rec.run
          const answered = prev.cursor ? prev.checks.find((c) => c.id === prev.cursor) : undefined
          const kind = turnKindFor(a.op, answered ?? null)
          const turns: OwedTurn[] = []
          if (kind && answered) {
            const check =
              turnCheck(next, ctx.walk, answered.id) ?? turnCheck(prev, ctx.walk, answered.id)
            const input: TurnInput = {
              ...baseTurn(kind, next, ctx, owner),
              ...(check ? { check } : {})
            }
            if (kind === 'failed') {
              const last = next.checks.find((c) => c.id === answered.id)?.failures.at(-1)
              if (last?.line) input.line = last.line
              if (last?.shot) input.shot = last.shot
            }
            if (kind === 'treat-as-failed') {
              const ev = prev.checks.find((c) => c.id === answered.id)?.report?.evidence
              if (ev) input.evidence = ev
            }
            if (kind === 'escalate')
              input.attempts = next.checks.find((c) => c.id === answered.id)?.attempts ?? 0
            turns.push({ kind, checkId: answered.id, text: formatTurn(input) })
          }
          turns.push(...closedTurn(prev, next, ctx, owner, a.closeOut))
          sent = turns.map((t) => t.kind as WalkTurnKind)
          return turns
        },
        closeOut: (next, ctx) =>
          ctx.rec.run.state !== 'ended' && next.state === 'ended'
            ? (a.closeOut ?? closeOutText(next, ctx.walk.script))
            : null
      })
      if (!res.ok) return fromMachine(res.error)
      if (res.owed.length) kick(a.walkId, a.runId)
      return { ok: true, run: res.run, sent }
    },

    replay: replayAll,

    async idle() {
      while (inflight.size) await Promise.all([...inflight])
    }
  }

  // ---- operator steps ------------------------------------------------------------------------

  function applyOp(run: Run, a: OperateArgs, at: number): MachineResult {
    switch (a.op) {
      case 'start':
        return startRun(run, at)
      case 'done':
        return done(run, at)
      case 'fail': {
        if (a.shot && !shotInside(a)) {
          return {
            ok: false,
            error: {
              code: 'SHOT_OUTSIDE_RUN',
              message: "The screenshot is not in the run's shots folder."
            }
          }
        }
        return fail(run, {
          ...(a.line !== undefined ? { line: a.line } : {}),
          ...(a.shot ? { shot: a.shot } : {}),
          now: at
        })
      }
      case 'skip':
        return skip(run, at)
      case 'back':
        return back(run)
      case 'try-again':
        return tryAgain(run)
      case 'follow-anyway':
        return followAnyway(run, at)
      case 'treat-as-failed':
        return treatAsFailed(run, at)
      case 'continue-without':
        return continueWithout(run, at, a.waitMs)
      case 'pick-skipped':
        return pickSkipped(run, a.checkId ?? '')
      case 'close-out-with-skipped':
        return closeOutWithSkipped(run, at)
      case 'end':
        return endRun(run, at)
      case 'explain':
      case 'simpler':
      case 'escalate': {
        // no state change: the turn is the only effect, and the pane creates nothing
        if (run.state !== 'live')
          return {
            ok: false,
            error: {
              code: run.state === 'ended' ? 'RUN_ENDED' : 'RUN_NOT_LIVE',
              message: 'The run is not live.'
            }
          }
        if (run.cursor === null)
          return { ok: false, error: { code: 'NO_CURRENT', message: 'No check is being served.' } }
        if (a.op === 'escalate' && !canEscalate(run, run.cursor))
          return {
            ok: false,
            error: {
              code: 'ESCALATION_NOT_OFFERED',
              message: 'The door appears from the second failure.'
            }
          }
        return { ok: true, run }
      }
    }
  }

  function shotInside(a: OperateArgs): boolean {
    if (!a.shot || !isAbsolute(a.shot)) return false
    const rel = relative(store.shotsDir(a.walkId, a.runId), resolve(a.shot))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  // ---- append --------------------------------------------------------------------------------

  async function extendAppend(
    a: ExtendArgs & { probe: WalkProbe },
    walk0: WalkRecord
  ): Promise<Result<Record<string, unknown>>> {
    if (!Array.isArray(a.append) || a.append.length === 0)
      return refuse('BAD_ARGS', 'append is a list of at least one check.')
    // the new checks are validated as a script of their own with the walk's title, purpose and source;
    // a source problem (a card since removed) is not the agent's to fix here
    const check = validateWalkScript(
      {
        title: walk0.script.title,
        purpose: walk0.script.purpose,
        source: walk0.script.source,
        checks: a.append
      },
      a.probe
    )
    const violations = check.ok
      ? []
      : check.violations
          .filter((x) => !x.path.startsWith('$.source'))
          .map((x) => ({ ...x, path: x.path.replace(/^\$\.checks/, '$.append') }))
    const existing = new Set(walk0.script.checks.map((c) => c.id))
    a.append.forEach((c: unknown, i: number) => {
      if (isObj(c) && typeof c.id === 'string' && existing.has(c.id))
        violations.push({
          path: `$.append[${i}].id`,
          rule: 'DUPLICATE_ID',
          message: 'A check with this id is already in the walk.'
        })
    })
    if (violations.length)
      return {
        ...refuse('EXTENSION_REJECTED', 'The new checks broke rules.'),
        rejected: violations
      }
    const incoming = (check as { ok: true; script: WalkScript }).script.checks

    const runs = await store.listRuns(a.walkId)
    const latestN = runs.at(-1)?.run.n ?? 1
    const addedInRun = walk0.live?.n ?? latestN
    let adopted: WalkCheck[]
    try {
      adopted = await adoptChecks(incoming, store.walkDir(a.walkId))
    } catch (err) {
      return refuse(
        'IMAGE_COPY_FAILED',
        `An image could not be copied into the walk: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const res = await store.updateWalk(a.walkId, (walk) => {
      if (a.expectRev !== undefined && a.expectRev !== walk.rev)
        return {
          ok: false,
          error: {
            code: 'REV_CONFLICT',
            message: 'The walk changed: read it and send again.',
            rev: walk.rev
          } as MachineError
        }
      const taken = new Set(walk.script.checks.map((c) => c.id))
      if (adopted.some((c) => taken.has(c.id)))
        return {
          ok: false,
          error: {
            code: 'DUPLICATE_CHECK',
            message: 'A check with this id is already in the walk.'
          }
        }
      return {
        ok: true,
        walk: {
          ...walk,
          script: { ...walk.script, checks: [...walk.script.checks, ...adopted] },
          added: [...(walk.added ?? []), ...adopted.map((c) => ({ checkId: c.id, addedInRun }))]
        }
      }
    })
    if (!res.ok) return fromMachine(res.error)
    // the runs that can still be walked grow with the walk: N goes up, nothing is reordered
    for (const rec of await store.listRuns(a.walkId)) {
      if (rec.run.state === 'ended') continue
      await store.updateRun(a.walkId, rec.runId, (run) =>
        appendChecks(run, toMachineChecks({ ...res.walk.script, checks: adopted }))
      )
    }
    return {
      ok: true,
      op: 'walk_extend',
      walkId: a.walkId,
      rev: res.walk.rev,
      appended: adopted.map((c) => c.id)
    }
  }

  // ---- reads ---------------------------------------------------------------------------------

  async function describeWalk(walk: WalkRecord): Promise<Record<string, unknown>> {
    const runs = await store.listRuns(walk.walkId)
    const liveRun = walk.live ? runs.find((r) => r.runId === walk.live?.runId) : undefined
    const current =
      liveRun ?? [...runs].reverse().find((r) => r.run.state === 'ready') ?? runs.at(-1)
    const byId = new Map(walk.script.checks.map((c) => [c.id, c]))
    const added = new Map((walk.added ?? []).map((x) => [x.checkId, x.addedInRun]))
    let checks: Record<string, unknown>[] = []
    let cursor: Record<string, unknown> | null = null
    let lastFailure: Record<string, unknown> | null = null
    const awaiting: Record<string, unknown>[] = []
    let progress: Record<string, unknown> | null = null
    if (current) {
      const run = current.run
      progress = { ...progressOf(run), total: totalChecks(run) }
      const v = view(run)
      cursor = { ...v, state: run.state }
      for (const c of run.checks) {
        const f = c.failures.at(-1)
        if (f && (!lastFailure || (f.at ?? 0) >= ((lastFailure.at as number) ?? 0)))
          lastFailure = { checkId: c.id, ...f }
        if (c.state === 'awaiting') awaiting.push({ checkId: c.id, needs: 'report' })
        if (c.state === 'failed' && !c.correction)
          awaiting.push({ checkId: c.id, needs: 'correction' })
      }
      checks = run.checks.map((c) => ({
        id: c.id,
        n: ordinalOf(run, c.id),
        title: byId.get(c.id)?.title ?? c.id,
        glyph: GLYPH[c.state],
        state: c.state,
        closedHow: c.closedHow,
        attempts: c.attempts,
        ...(added.has(c.id) ? { addedInRun: added.get(c.id) } : {})
      }))
      // an explain or simpler turn the agent has not answered yet
      for (const turn of current.outbox) {
        if ((turn.kind !== 'explain' && turn.kind !== 'simpler') || !turn.checkId) continue
        const answered =
          turn.kind === 'explain'
            ? (walk.deepenings ?? []).some(
                (d) => d.checkId === turn.checkId && d.at >= turn.createdAt
              )
            : (walk.simpler ?? []).some((d) => d.checkId === turn.checkId && d.at >= turn.createdAt)
        if (!answered)
          awaiting.push({
            checkId: turn.checkId,
            needs: turn.kind === 'explain' ? 'extend' : 'simpler'
          })
      }
    }
    const pending = runs.flatMap((r) => r.outbox.filter((o) => !o.delivered))
    return {
      walkId: walk.walkId,
      title: walk.script.title,
      purpose: walk.script.purpose,
      source: walk.script.source,
      rev: walk.rev,
      live: walk.live,
      run: current ? { runId: current.runId, n: current.run.n, state: current.run.state } : null,
      progress,
      cursor,
      checks,
      lastFailure,
      awaitingAgent: awaiting,
      outbox: { pending: pending.length, kinds: pending.map((o) => o.kind) },
      deepened: [...new Set((walk.deepenings ?? []).map((d) => d.checkId))],
      runs: runs.map((r) => ({
        runId: r.runId,
        n: r.run.n,
        state: r.run.state,
        ...(r.run.startedAt !== undefined ? { startedAt: r.run.startedAt } : {}),
        ...(r.run.endedAt !== undefined ? { endedAt: r.run.endedAt } : {}),
        progress: { ...progressOf(r.run), total: totalChecks(r.run) }
      })),
      lastRun: walk.lastRun
    }
  }

  function summaryOf(e: WalkLibraryEntry): Record<string, unknown> {
    return {
      walkId: e.walkId,
      title: e.title,
      purpose: e.purpose,
      status: e.status,
      createdAt: e.createdAt,
      live: e.live,
      lastRun: e.lastRun
    }
  }

  async function replayAll(): Promise<{ delivered: number; pending: number }> {
    const total = { delivered: 0, pending: 0 }
    for (const w of await store.listWalks()) {
      for (const rec of await store.listRuns(w.walkId)) {
        if (!rec.outbox.some((o) => !o.delivered)) continue
        const r = await flush(w.walkId, rec.runId)
        total.delivered += r.delivered
        total.pending += r.pending
      }
    }
    return total
  }

  return svc
}

// ---- helpers ----------------------------------------------------------------------------------

const nullProbe: WalkProbe = {
  cardSlugExists: () => true,
  mission: () => null,
  fileInFolder: () => true,
  folderKnown: () => true,
  image: () => ({ ok: true, bytes: 0 }),
  looksLikeSecret: () => false
}

function addedInRunOf(walk: WalkRecord): number {
  return walk.live?.n ?? walk.lastRun?.n ?? 1
}

/** A well-formed source for a lookup. Unlike `validateSource` it asks nothing of the board or a mission. */
export function looseSource(x: unknown): WalkSource | null {
  if (!isObj(x)) return null
  switch (x.kind) {
    case 'feature':
      return nonEmpty(x.text) ? { kind: 'feature', text: x.text } : null
    case 'pr':
      return typeof x.number === 'number' && Number.isInteger(x.number) && x.number > 0
        ? {
            kind: 'pr',
            number: x.number,
            title: String(x.title ?? ''),
            author: String(x.author ?? '')
          }
        : null
    case 'branch':
      return nonEmpty(x.branch) && nonEmpty(x.base)
        ? { kind: 'branch', branch: x.branch, base: x.base }
        : null
    case 'card':
      return nonEmpty(x.slug) ? { kind: 'card', slug: x.slug } : null
    case 'mission':
      return nonEmpty(x.missionId) &&
        (x.scope === 'step' || x.scope === 'milestone' || x.scope === 'mission')
        ? {
            kind: 'mission',
            missionId: x.missionId,
            scope: x.scope,
            ...(nonEmpty(x.id) ? { id: x.id } : {})
          }
        : null
    default:
      return null
  }
}
