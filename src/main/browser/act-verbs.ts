/**
 * The five acting verbs of unit U4 (T564, spec §6.1 rows 10–14): `browser_eval`, `browser_click`, `browser_type`,
 * `browser_fill` and `browser_press`, as pure functions over injected dependencies. The MCP handlers in
 * `mcp/tool-handlers.ts` supply the real ones (the view host over CDP, the leases, the write queue); the tests
 * supply fakes. Every decision (what is actionable, where a click lands, which key a name is) lives in the pure
 * modules these call; this file only sequences them.
 *
 * Every call: gate (pane, Disconnect, content, kill-switch, Pause, tier, lease) → a place in the pane's write
 * queue → the gate again (the state may have changed while it waited) → `agentInput` stamped for the whole run →
 * the CDP work → an ACK that says whether anyone else wrote or the operator used the pane meanwhile.
 */
import {
  clickEvents,
  clickTarget,
  toViewPoint,
  waitActionable,
  actionableRefusal
} from './act-plan'
import type { ClickModifier, ElementProbe, MouseButton, Point } from './act-plan'
import { chordEvents, parseChord } from './cdp-keys'
import type { PaneReaders } from './pane-readers'
import {
  NOTIFY_CHANGE_FN,
  PROBE_FN,
  SELECT_CONTENT_FN,
  SERIALIZE_FN,
  SET_SELECT_FN
} from './probe-source'
import type { BrowserReadDeps, BrowserReadHost } from './read-verbs'
import { refLabel } from './snapshot'
import type { BrowserPaneRecord } from './registry'
import type { BrowserOp } from './access'
import {
  BROWSER_NOTE,
  ackBase,
  gate,
  noteAgentWrite,
  originOf,
  refuse,
  refuseBadArgs,
  type Refusal
} from './verbs-core'
import type { BrowserWriteQueue } from './write-queue'

/** What the view host adds for the acting verbs (`view-host.ts` implements it over Electron). */
export interface BrowserActHost extends BrowserReadHost {
  /**
   * The factor between page CSS px and the view's coordinates while a device is emulated (assumption A5); `1`
   * without one. CDP mouse and touch events take VIEW coordinates.
   */
  inputScale?(paneId: string): number
  /** Show the pane header's `driving` word while a verb runs. */
  drive?(paneId: string, on: boolean): void
}

export interface BrowserActDeps extends BrowserReadDeps {
  host: BrowserActHost
  /** The per-pane write queue (spec §6.4). Absent in a unit test that does not exercise it. */
  queue?: BrowserWriteQueue
}

/** The result cap of `browser_eval` (spec §6.2). */
export const EVAL_VALUE_MAX_BYTES = 64 * 1024
export const EVAL_DEFAULT_TIMEOUT_MS = 15_000
export const EVAL_MAX_TIMEOUT_MS = 30_000

const OBJECT_GROUP = 'harnu-act'

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A CDP failure that means "that node (or its object) no longer exists". */
function isNodeGone(err: unknown): boolean {
  return /no node|not find|cannot find|could not find|given id|detached|no object|not found|context/i.test(
    errorText(err)
  )
}

class OffsetOutside extends Error {}

export interface ActCtx {
  rec: BrowserPaneRecord
  readers: PaneReaders
  scale: number
}

type Located =
  | { refusal: Refusal }
  | { objectId: string; backendNodeId: number; probe: ElementProbe; label?: string }

function isRefusal(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false
}

/* ------------------------------------------------------------------------------------------------ */
/* The shared run: gate → queue → gate → stamp → work → ACK                                           */
/* ------------------------------------------------------------------------------------------------ */

export async function runWrite(
  op: BrowserOp,
  args: { paneId: string } & Record<string, unknown>,
  key: object,
  deps: BrowserActDeps,
  body: (ctx: ActCtx) => Promise<Record<string, unknown> | Refusal>
): Promise<Record<string, unknown>> {
  const first = await gate(op, args.paneId, deps, args)
  if ('refusal' in first) return first.refusal
  const rec = first.rec!
  const readers = deps.host.readers(rec.paneId)
  // A record without a view is a pane that is mid-close.
  if (!readers || !first.live) return refuse('PANE_NOT_FOUND', { folder: rec.folder })

  const exec = async (): Promise<Record<string, unknown> | Refusal> => {
    // The queue wait is real time: the lease can end, the operator can Pause or Disconnect, the folder can be
    // blocked. Judge the pane again right before acting.
    const again = await gate(op, args.paneId, deps, args)
    if ('refusal' in again) return again.refusal
    const token = deps.registry.beginWrite(rec.paneId)
    // Every acting verb is agent INPUT for the emit gate (spec §5.4): stamped before dispatch, ended after.
    deps.registry.beginAgentInput(rec.paneId)
    deps.host.drive?.(rec.paneId, true)
    let result: Record<string, unknown> | Refusal
    let report: ReturnType<typeof deps.registry.endWrite>
    try {
      result = await body({ rec, readers, scale: deps.host.inputScale?.(rec.paneId) ?? 1 })
    } finally {
      report = deps.registry.endWrite(token)
      deps.registry.endAgentInput(rec.paneId)
      deps.host.drive?.(rec.paneId, false)
    }
    if (isRefusal(result)) return result
    // The write ran: only now do the lease's 10 idle minutes start over (a refusal or a throw never gets here).
    noteAgentWrite(deps, rec.paneId)
    return {
      ...result,
      operatorInteracted: report.operatorInteracted,
      __othersWrote: report.othersWrote
    }
  }

  const queued = deps.queue
    ? await deps.queue.run(rec.paneId, key, exec)
    : ({ ok: true as const, value: await exec(), othersWrote: false } as const)
  if (!queued.ok) return refuse(queued.error, { folder: rec.folder })
  const out = queued.value
  if (isRefusal(out)) return out
  const { __othersWrote, ...rest } = out as Record<string, unknown> & { __othersWrote?: boolean }
  const live = deps.host.info(rec.paneId)
  return {
    ...ackBase(rec, live, originOf(rec, live, deps)),
    ...rest,
    othersWrote: queued.othersWrote || __othersWrote === true,
    note: BROWSER_NOTE
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Locating an element by ref                                                                         */
/* ------------------------------------------------------------------------------------------------ */

async function viewport(
  deps: BrowserActDeps,
  paneId: string
): Promise<{ width: number; height: number } | null> {
  try {
    const m = (await deps.host.cdp(paneId, 'Page.getLayoutMetrics', {})) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
    }
    const w = m.cssVisualViewport?.clientWidth
    const h = m.cssVisualViewport?.clientHeight
    return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
      ? { width: w, height: h }
      : null
  } catch {
    return null
  }
}

/**
 * Resolve `ref`, scroll the element into view and wait (up to 5 s) until it is visible, stable and — when the verb
 * clicks — un-obscured. A dead ref is `REF_STALE`, an unknown one `REF_NOT_FOUND`.
 */
async function locate(
  ref: string,
  ctx: ActCtx,
  deps: BrowserActDeps,
  opts: { needsHit: boolean; offset?: Point }
): Promise<Located> {
  const folder = ctx.rec.folder
  const resolved = ctx.readers.refs.resolve(ref)
  if (!resolved.ok) return { refusal: refuse(resolved.error, { folder }) }
  const paneId = ctx.rec.paneId
  let objectId: string
  try {
    const node = (await deps.host.cdp(paneId, 'DOM.resolveNode', {
      backendNodeId: resolved.backendNodeId,
      objectGroup: OBJECT_GROUP
    })) as { object?: { objectId?: string } }
    if (!node.object?.objectId) return { refusal: refuse('REF_STALE', { folder }) }
    objectId = node.object.objectId
  } catch {
    return { refusal: refuse('REF_STALE', { folder }) }
  }

  const sample = async (): Promise<ElementProbe> => {
    await deps.host
      .cdp(paneId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: resolved.backendNodeId })
      .catch(() => undefined)
    const res = (await deps.host.cdp(paneId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: PROBE_FN,
      arguments: [{ value: opts.offset ?? null }],
      returnByValue: true
    })) as { result?: { value?: ElementProbe }; exceptionDetails?: unknown }
    if (res.exceptionDetails || !res.result?.value)
      throw new Error('no object: the element is gone')
    const probe = res.result.value
    if (opts.offset && probe.rect && !clickTarget(probe.rect, opts.offset).ok)
      throw new OffsetOutside()
    return probe
  }

  try {
    const outcome = await waitActionable({
      sample,
      now: deps.now,
      sleep: deps.sleep,
      needsHit: opts.needsHit,
      viewport: () => viewport(deps, paneId)
    })
    if (!outcome.ok) {
      return {
        refusal: refuse(actionableRefusal(outcome.reason), { folder, during: 'input' })
      }
    }
    return {
      objectId,
      backendNodeId: resolved.backendNodeId,
      probe: outcome.probe,
      ...(resolved.label !== undefined ? { label: resolved.label } : {})
    }
  } catch (err) {
    if (err instanceof OffsetOutside) return { refusal: refuse('OFFSET_OUTSIDE_BOX', { folder }) }
    if (isNodeGone(err)) return { refusal: refuse('REF_STALE', { folder }) }
    return { refusal: refuse('INPUT_FAILED', { folder, detail: deps.scrub(errorText(err)) }) }
  }
}

/** Role and name of the element, and whether it still looks like it did in the snapshot that made the ref. */
async function describe(
  loc: { backendNodeId: number; label?: string },
  ctx: ActCtx,
  deps: BrowserActDeps
): Promise<{ target: { role: string; name: string } | null; stale: boolean }> {
  try {
    const res = (await deps.host.cdp(ctx.rec.paneId, 'Accessibility.getPartialAXTree', {
      backendNodeId: loc.backendNodeId,
      fetchRelatives: false
    })) as { nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> }
    const n = res.nodes?.[0]
    const role = typeof n?.role?.value === 'string' ? n.role.value : ''
    const name = typeof n?.name?.value === 'string' ? n.name.value : ''
    if (!n) return { target: null, stale: loc.label !== undefined }
    return {
      target: { role, name: deps.scrub(name) },
      stale: loc.label !== undefined && loc.label !== refLabel(role, name)
    }
  } catch {
    return { target: null, stale: loc.label !== undefined }
  }
}

async function focusElement(
  loc: { backendNodeId: number },
  ctx: ActCtx,
  deps: BrowserActDeps
): Promise<void> {
  await deps.host.cdp(ctx.rec.paneId, 'DOM.focus', { backendNodeId: loc.backendNodeId })
}

async function call(
  deps: BrowserActDeps,
  ctx: ActCtx,
  objectId: string,
  fn: string,
  arg?: unknown
): Promise<unknown> {
  const res = (await deps.host.cdp(ctx.rec.paneId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    ...(arg !== undefined ? { arguments: [{ value: arg }] } : {}),
    returnByValue: true
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  return res.result?.value
}

async function releaseObjects(deps: BrowserActDeps, ctx: ActCtx): Promise<void> {
  await deps.host
    .cdp(ctx.rec.paneId, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP })
    .catch(() => undefined)
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_click                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface ClickArgs {
  paneId: string
  ref: string
  button?: MouseButton
  clickCount?: number
  modifiers?: ClickModifier[]
  offset?: Point
}

export async function clickVerb(
  args: ClickArgs,
  deps: BrowserActDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_click', args as never, key, deps, (ctx) => performClick(args, ctx, deps))
}

/**
 * The click itself, inside a run that already holds the pane's place in the write queue. `browser_download({ ref })`
 * clicks through this too (T572), so it never queues behind itself.
 */
export async function performClick(
  args: Omit<ClickArgs, 'paneId'>,
  ctx: ActCtx,
  deps: BrowserActDeps
): Promise<Record<string, unknown> | Refusal> {
  try {
    const loc = await locate(args.ref, ctx, deps, {
      needsHit: true,
      ...(args.offset ? { offset: args.offset } : {})
    })
    if ('refusal' in loc) return loc.refusal
    const aim = clickTarget(loc.probe.rect!, args.offset)
    if (!aim.ok) return refuse('OFFSET_OUTSIDE_BOX', { folder: ctx.rec.folder })
    const seen = await describe(loc, ctx, deps)
    const at = toViewPoint(aim.point, ctx.scale)
    try {
      for (const ev of clickEvents(at, {
        ...(args.button ? { button: args.button } : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {}),
        ...(args.modifiers ? { modifiers: args.modifiers } : {})
      })) {
        await deps.host.cdp(ctx.rec.paneId, 'Input.dispatchMouseEvent', ev)
      }
    } catch (err) {
      return refuse('INPUT_FAILED', {
        folder: ctx.rec.folder,
        detail: deps.scrub(errorText(err))
      })
    }
    return { target: seen.target, snapshotStale: seen.stale }
  } finally {
    await releaseObjects(deps, ctx)
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_type                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export interface TypeArgs {
  paneId: string
  ref?: string
  text: string
  delayMs?: number
  submit?: boolean
}

async function pressChord(deps: BrowserActDeps, ctx: ActCtx, name: string): Promise<void> {
  const chord = parseChord(name)
  if (!chord) return
  for (const ev of chordEvents(chord)) {
    await deps.host.cdp(ctx.rec.paneId, 'Input.dispatchKeyEvent', ev)
  }
}

export async function typeVerb(
  args: TypeArgs,
  deps: BrowserActDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_type', args as never, key, deps, async (ctx) => {
    try {
      let target: { role: string; name: string } | null = null
      let stale = false
      if (args.ref !== undefined) {
        const loc = await locate(args.ref, ctx, deps, { needsHit: false })
        if ('refusal' in loc) return loc.refusal
        if (!loc.probe.editable && !loc.probe.isSelect) {
          return refuse('ELEMENT_NOT_EDITABLE', { folder: ctx.rec.folder })
        }
        const seen = await describe(loc, ctx, deps)
        target = seen.target
        stale = seen.stale
        try {
          await focusElement(loc, ctx, deps)
        } catch (err) {
          return isNodeGone(err)
            ? refuse('REF_STALE', { folder: ctx.rec.folder })
            : refuse('INPUT_FAILED', { folder: ctx.rec.folder, detail: deps.scrub(errorText(err)) })
        }
      }
      try {
        const delay = args.delayMs ?? 0
        if (delay <= 0) {
          await deps.host.cdp(ctx.rec.paneId, 'Input.insertText', { text: args.text })
        } else {
          for (const ch of args.text) {
            if (ch === '\n') await pressChord(deps, ctx, 'Enter')
            else {
              await deps.host.cdp(ctx.rec.paneId, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: ch,
                text: ch,
                modifiers: 0
              })
              await deps.host.cdp(ctx.rec.paneId, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: ch,
                modifiers: 0
              })
            }
            await deps.sleep(delay)
          }
        }
        if (args.submit === true) await pressChord(deps, ctx, 'Enter')
      } catch (err) {
        return refuse('INPUT_FAILED', {
          folder: ctx.rec.folder,
          detail: deps.scrub(errorText(err))
        })
      }
      return { typedChars: [...args.text].length, target, snapshotStale: stale }
    } finally {
      await releaseObjects(deps, ctx)
    }
  })
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_fill                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export interface FillArgs {
  paneId: string
  fields: Array<{ ref: string; value: string }>
}

export async function fillVerb(
  args: FillArgs,
  deps: BrowserActDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_fill', args as never, key, deps, async (ctx) => {
    try {
      // Every ref is checked before anything is touched, so a stale one cannot leave a half-filled form.
      for (const f of args.fields) {
        const r = ctx.readers.refs.resolve(f.ref)
        if (!r.ok) return refuse(r.error, { folder: ctx.rec.folder })
      }
      const filled: Array<{ ref: string; target: { role: string; name: string } | null }> = []
      let stale = false
      for (const f of args.fields) {
        const loc = await locate(f.ref, ctx, deps, { needsHit: false })
        if ('refusal' in loc) return loc.refusal
        if (!loc.probe.editable && !loc.probe.isSelect) {
          return refuse('ELEMENT_NOT_EDITABLE', { folder: ctx.rec.folder })
        }
        const seen = await describe(loc, ctx, deps)
        stale = stale || seen.stale
        try {
          await focusElement(loc, ctx, deps)
          if (loc.probe.isSelect) {
            const ok = await call(deps, ctx, loc.objectId, SET_SELECT_FN, f.value)
            if (ok !== true) {
              return refuseBadArgs(
                `The <select> for ${f.ref} has no option with that value or label.`
              )
            }
          } else {
            await call(deps, ctx, loc.objectId, SELECT_CONTENT_FN)
            if (f.value === '') await pressChord(deps, ctx, 'Backspace')
            else await deps.host.cdp(ctx.rec.paneId, 'Input.insertText', { text: f.value })
            await call(deps, ctx, loc.objectId, NOTIFY_CHANGE_FN)
          }
        } catch (err) {
          return isNodeGone(err)
            ? refuse('REF_STALE', { folder: ctx.rec.folder })
            : refuse('INPUT_FAILED', { folder: ctx.rec.folder, detail: deps.scrub(errorText(err)) })
        }
        filled.push({ ref: f.ref, target: seen.target })
      }
      return { filled, snapshotStale: stale }
    } finally {
      await releaseObjects(deps, ctx)
    }
  })
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_press                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface PressArgs {
  paneId: string
  keys: string[]
  ref?: string
}

export async function pressVerb(
  args: PressArgs,
  deps: BrowserActDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_press', args as never, key, deps, async (ctx) => {
    try {
      let stale = false
      if (args.ref !== undefined) {
        const loc = await locate(args.ref, ctx, deps, { needsHit: false })
        if ('refusal' in loc) return loc.refusal
        stale = (await describe(loc, ctx, deps)).stale
        try {
          await focusElement(loc, ctx, deps)
        } catch (err) {
          return isNodeGone(err)
            ? refuse('REF_STALE', { folder: ctx.rec.folder })
            : refuse('INPUT_FAILED', { folder: ctx.rec.folder, detail: deps.scrub(errorText(err)) })
        }
      }
      const pressed: string[] = []
      try {
        for (const k of args.keys) {
          await pressChord(deps, ctx, k)
          pressed.push(k)
        }
      } catch (err) {
        return {
          ...refuse('INPUT_FAILED', { folder: ctx.rec.folder, detail: deps.scrub(errorText(err)) }),
          pressed
        }
      }
      return { pressed, snapshotStale: stale }
    } finally {
      await releaseObjects(deps, ctx)
    }
  })
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_eval                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export interface EvalArgs {
  paneId: string
  expression: string
  awaitPromise?: boolean
  frame?: string
  timeoutMs?: number
}

interface FrameNode {
  frame?: { id?: string; name?: string; url?: string }
  childFrames?: FrameNode[]
}

/** The default context of the child frame whose name or address contains `wanted`. */
async function frameContext(
  deps: BrowserActDeps,
  ctx: ActCtx,
  wanted: string
): Promise<{ contextId: number } | { refusal: Refusal }> {
  const miss = (): { refusal: Refusal } => ({
    refusal: refuse('FRAME_NOT_FOUND', { folder: ctx.rec.folder, detail: wanted })
  })
  let tree: FrameNode | undefined
  try {
    tree = (
      (await deps.host.cdp(ctx.rec.paneId, 'Page.getFrameTree', {})) as { frameTree?: FrameNode }
    ).frameTree
  } catch {
    return miss()
  }
  const found: Array<{ id: string; name: string; url: string }> = []
  const walk = (n: FrameNode | undefined, top: boolean): void => {
    if (!n) return
    if (!top && n.frame?.id)
      found.push({ id: n.frame.id, name: n.frame.name ?? '', url: n.frame.url ?? '' })
    for (const c of n.childFrames ?? []) walk(c, false)
  }
  walk(tree, true)
  const hit = found.find((f) => f.name === wanted) ?? found.find((f) => f.url.includes(wanted))
  if (!hit) return miss()
  const contextId = ctx.readers.contexts.defaultFor(hit.id)
  // A frame from another site lives in another process; its context is not reachable from this session.
  return contextId === undefined ? miss() : { contextId }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Cut `text` to at most `max` bytes on a character boundary. */
function cutBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = byteLength(ch)
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

export async function evalVerb(
  args: EvalArgs,
  deps: BrowserActDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_eval', args as never, key, deps, async (ctx) => {
    const paneId = ctx.rec.paneId
    const folder = ctx.rec.folder
    const timeoutMs = Math.min(args.timeoutMs ?? EVAL_DEFAULT_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS)
    let contextId: number | undefined
    if (args.frame !== undefined) {
      const fr = await frameContext(deps, ctx, args.frame)
      if ('refusal' in fr) return fr.refusal
      contextId = fr.contextId
    }
    try {
      const evaluating = deps.host.cdp(paneId, 'Runtime.evaluate', {
        expression: args.expression,
        awaitPromise: args.awaitPromise !== false,
        returnByValue: false,
        generatePreview: false,
        objectGroup: OBJECT_GROUP,
        // Synchronous work is bounded by the engine; the wait on a promise by the race below.
        timeout: timeoutMs,
        ...(contextId !== undefined ? { contextId } : {})
      })
      const TIMED_OUT = Symbol('timeout')
      const winner = await Promise.race([
        evaluating,
        deps.sleep(timeoutMs).then(() => TIMED_OUT)
      ]).catch((err: unknown) => {
        throw err
      })
      if (winner === TIMED_OUT) {
        void evaluating.catch(() => undefined)
        await deps.host.cdp(paneId, 'Runtime.terminateExecution', {}).catch(() => undefined)
        return refuse('EVAL_TIMEOUT', { folder, detail: `${timeoutMs} ms` })
      }
      const res = winner as {
        result?: {
          type?: string
          subtype?: string
          value?: unknown
          unserializableValue?: string
          objectId?: string
          description?: string
        }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }
      if (res.exceptionDetails) {
        const description =
          res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'error'
        return {
          type: 'error',
          thrown: {
            message: deps.scrub(description.split('\n')[0] ?? description),
            stack: deps.scrub(description)
          },
          truncated: false
        }
      }
      const r = res.result ?? { type: 'undefined' }
      const type = r.subtype ?? r.type ?? 'undefined'
      let serialized: string | undefined
      if (r.type === 'undefined') serialized = undefined
      else if (r.objectId) {
        const v = await call(deps, ctx, r.objectId, SERIALIZE_FN)
        serialized = typeof v === 'string' ? v : undefined
        if (serialized === undefined) {
          // A function, a DOM node, a circular object: what the page calls it is the best honest answer.
          return {
            type,
            value: deps.scrub(r.description ?? ''),
            serializable: false,
            truncated: false
          }
        }
      } else if (r.unserializableValue !== undefined) {
        return { type, value: r.unserializableValue, serializable: false, truncated: false }
      } else serialized = JSON.stringify(r.value)
      if (serialized === undefined) return { type, truncated: false }
      const clean = deps.scrub(serialized)
      if (byteLength(clean) > EVAL_VALUE_MAX_BYTES) {
        return { type, value: cutBytes(clean, EVAL_VALUE_MAX_BYTES), truncated: true }
      }
      let value: unknown = clean
      try {
        value = JSON.parse(clean)
      } catch {
        /* the scrubber changed the text so it no longer parses: the scrubbed text is the value */
      }
      return { type, value, truncated: false }
    } catch (err) {
      return refuse('INPUT_FAILED', { folder, detail: deps.scrub(errorText(err)) })
    } finally {
      await releaseObjects(deps, ctx)
    }
  })
}
