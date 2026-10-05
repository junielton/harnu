/**
 * THE Containers action function (PRD §3.4, ADR-0014 §3). Stop, start, remove
 * and sweep all go through {@link runContainersAction}; the IPC handler and the
 * MCP verbs both call it, so the safety tiers are enforced here and nowhere
 * else (PRD §7.4). `sweep` is the operator's alone — no MCP op exposes it.
 *
 * Pure over injected I/O: the docker commands, the fresh scan the tiers are
 * judged on, the journal append and the clock are all {@link ActionDeps}.
 */

import {
  ACT_VERBS,
  NEEDS_YOU_VERDICTS,
  type ActErrorCode,
  type ActRequest,
  type ActResult,
  type ActVerb,
  type Actor,
  type ContainersSnapshotAvailable,
  type ContainersSnapshot,
  type StackActResult,
  type StackRow,
  type SweepDisclosure,
  type Tombstone,
  type TombstoneStack
} from './containers-wire'
import { restoreHintForRemove, restoreHintForStop } from './containers-journal'

/** What a multi-argument docker command reported: the arguments it handled, and its error. */
export interface DockerBatchResult {
  done: string[]
  error: string | null
}

export interface ActionDeps {
  /** A scan started after the request arrived: tiers are never judged on a stale verdict. */
  scan(): Promise<ContainersSnapshot>
  /** `docker stop <ids>`. */
  stop(ids: string[]): Promise<DockerBatchResult>
  /** `docker start <ids>`. */
  start(ids: string[]): Promise<DockerBatchResult>
  /** `docker rm <ids>` — never `--force`, never `-v`. */
  removeContainers(ids: string[]): Promise<DockerBatchResult>
  /** `docker volume rm <names>` — never `--force`. */
  removeVolumes(names: string[]): Promise<DockerBatchResult>
  appendTombstone(t: Tombstone): Promise<void>
  now(): number
}

const MAX_STACKS_PER_REQUEST = 500
/** A disclosure names one volume per mount, so its cap is not the stack cap. */
const MAX_VOLUMES_PER_DISCLOSURE = 5000

export type ParsedRequest =
  { ok: true; req: ActRequest } | { ok: false; verb: ActVerb | null; message: string }

function isStackIdList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= MAX_STACKS_PER_REQUEST &&
    v.every((s) => typeof s === 'string' && s.length > 0)
  )
}

function optionalBoolean(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

/** A list of names, possibly empty: a disclosure of nothing is still a disclosure. */
function isNameList(v: unknown, max: number): v is string[] {
  return (
    Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.length > 0)
  )
}

/** Validates an untrusted request (the renderer's payload, an MCP input). */
export function parseActRequest(raw: unknown): ParsedRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, verb: null, message: 'request must be an object' }
  }
  const r = raw as Record<string, unknown>
  const verb = ACT_VERBS.find((v) => v === r.verb) ?? null
  if (!verb) return { ok: false, verb: null, message: `unknown verb: ${String(r.verb)}` }
  const bad = (message: string): ParsedRequest => ({ ok: false, verb, message })

  if (verb === 'stop') {
    if (!optionalBoolean(r.force) || !optionalBoolean(r.bulk)) {
      return bad('force and bulk must be booleans')
    }
    if (r.bulk === true) return { ok: true, req: { verb, bulk: true } }
    if (!isStackIdList(r.stacks)) return bad('stacks must be a non-empty list of stack ids')
    return { ok: true, req: { verb, stacks: r.stacks, force: r.force === true } }
  }
  if (verb === 'start') {
    if (!isStackIdList(r.stacks)) return bad('stacks must be a non-empty list of stack ids')
    return { ok: true, req: { verb, stacks: r.stacks } }
  }
  if (verb === 'sweep') {
    // A sweep picks its own targets in main (T340). A caller that names a stack
    // is asking for something this verb does not offer, so it is refused rather
    // than silently ignored.
    if (r.stacks !== undefined || r.stack !== undefined) {
      return bad('sweep picks its own targets; it takes no stack list')
    }
    if (!optionalBoolean(r.removeVolumes)) return bad('removeVolumes must be a boolean')
    // The operator's selection (T342): the same shape and cap as any other id
    // list. An EMPTY list is refused rather than read as "everything" — nothing
    // ticked is nothing to sweep, and a silent widening there would be the worst
    // possible reading of an empty set on a destructive verb.
    if (r.only !== undefined && !isStackIdList(r.only)) {
      return bad('only must be a non-empty list of stack ids')
    }
    const base = {
      verb,
      removeVolumes: r.removeVolumes === true,
      ...(r.only !== undefined ? { only: r.only as string[] } : {})
    }
    if (r.disclosed === undefined) return { ok: true, req: base }
    // The dialog's disclosure (BUG-137): validated like any other untrusted
    // field, and carried on the request — but never as a target list.
    if (!r.disclosed || typeof r.disclosed !== 'object' || Array.isArray(r.disclosed)) {
      return bad('disclosed must be an object')
    }
    const d = r.disclosed as Record<string, unknown>
    if (
      !isNameList(d.stacks, MAX_STACKS_PER_REQUEST) ||
      !isNameList(d.volumes, MAX_VOLUMES_PER_DISCLOSURE)
    ) {
      return bad('disclosed.stacks and disclosed.volumes must be lists of names')
    }
    return { ok: true, req: { ...base, disclosed: { stacks: d.stacks, volumes: d.volumes } } }
  }
  if (r.stacks !== undefined) return bad('remove takes exactly one stack; there is no bulk form')
  if (typeof r.stack !== 'string' || !r.stack) return bad('stack must be a stack id')
  if (!optionalBoolean(r.removeVolumes)) return bad('removeVolumes must be a boolean')
  return { ok: true, req: { verb, stack: r.stack, removeVolumes: r.removeVolumes === true } }
}

/**
 * The tier table (PRD §3.4 + the MCP spec's refusal codes). Returns the refusal
 * for `verb` on `stack`, or null when the action is allowed. `unknown` is
 * refused for every verb, with or without `force` (PRD §7.1).
 */
export function refusalFor(
  verb: ActVerb,
  stack: Pick<StackRow, 'verdict' | 'running'>,
  opts: { force?: boolean } = {}
): ActErrorCode | null {
  if (stack.verdict === 'unknown') return 'STACK_NOT_ATTRIBUTABLE'
  switch (verb) {
    case 'stop':
      if (stack.verdict === 'active' && !opts.force) return 'STACK_IN_USE'
      if (stack.verdict === 'protected' && !opts.force) return 'STACK_PROTECTED'
      return null
    case 'start':
      return stack.verdict === 'orphan' ? 'WORKTREE_GONE' : null
    case 'remove':
      if (stack.verdict === 'active') return 'STACK_IN_USE'
      if (stack.verdict === 'protected') return 'STACK_PROTECTED'
      if (stack.verdict === 'pending') return 'STACK_PENDING'
      // Docker refuses a running container without `--force`, which is never used.
      if (stack.running) return 'STACK_RUNNING'
      return null
    case 'sweep':
      // A sweep clears the "Needs you" list: every zombie and orphan, and
      // nothing else. Unlike `remove` it accepts a running stack, because it
      // stops it first — docker still never sees `--force` (T340).
      if (stack.verdict === 'active') return 'STACK_IN_USE'
      if (stack.verdict === 'protected') return 'STACK_PROTECTED'
      if (stack.verdict === 'pending') return 'STACK_PENDING'
      // Fails closed: a verdict added later is never swept until it is listed here.
      return NEEDS_YOU_VERDICTS.includes(stack.verdict) ? null : 'STACK_NOT_ATTRIBUTABLE'
  }
}

const REFUSAL_MESSAGES: Record<ActErrorCode, string> = {
  STACK_NOT_FOUND: 'no such stack in the current scan',
  STACK_NOT_ATTRIBUTABLE: 'this stack belongs to no Harnu folder, so Harnu never touches it',
  STACK_IN_USE: 'a Harnu session is working in this folder',
  STACK_PROTECTED: "this stack runs from a repo's main checkout",
  STACK_PENDING: 'this stack is not a zombie yet',
  STACK_RUNNING: 'stop the stack first; removal never uses --force',
  WORKTREE_GONE: 'the worktree this stack ran from no longer exists',
  DOCKER_UNAVAILABLE: 'docker is unavailable',
  DOCKER_FAILED: 'docker reported an error',
  BAD_REQUEST: 'malformed request',
  SWEEP_SET_CHANGED: 'the list moved after the dialog showed it; nothing was removed'
}

function emptyResult(stack: string): StackActResult {
  return {
    stack,
    ok: true,
    containerIds: [],
    freedRamBytes: 0,
    freedVolumeBytes: 0,
    portsReleased: [],
    removedContainers: [],
    removedVolumes: [],
    keptVolumes: []
  }
}

function refused(stack: string, error: ActErrorCode): StackActResult {
  return { ...emptyResult(stack), ok: false, error, message: REFUSAL_MESSAGES[error] }
}

function failed(result: StackActResult, message: string): StackActResult {
  return { ...result, ok: false, error: 'DOCKER_FAILED', message }
}

function portsOf(stack: StackRow, ids: readonly string[]): number[] {
  const set = new Set(ids)
  const ports = stack.containers.filter((c) => set.has(c.id)).flatMap((c) => c.ports)
  return [...new Set(ports)].sort((a, b) => a - b)
}

function ramOf(stack: StackRow, ids: readonly string[]): number {
  const set = new Set(ids)
  return stack.containers
    .filter((c) => set.has(c.id))
    .reduce((sum, c) => sum + (c.memBytes ?? 0), 0)
}

async function stopStack(stack: StackRow, deps: ActionDeps): Promise<StackActResult> {
  const ids = stack.containers.filter((c) => c.running).map((c) => c.id)
  const result = emptyResult(stack.id)
  if (ids.length === 0) return result // already stopped: the desired state holds
  const { done, error } = await deps.stop(ids)
  const out: StackActResult = {
    ...result,
    containerIds: done,
    freedRamBytes: ramOf(stack, done),
    portsReleased: portsOf(stack, done)
  }
  return error || done.length < ids.length
    ? failed(out, error ?? 'not every container stopped')
    : out
}

async function startStack(stack: StackRow, deps: ActionDeps): Promise<StackActResult> {
  const ids = stack.containers.filter((c) => !c.running).map((c) => c.id)
  const result = emptyResult(stack.id)
  if (ids.length === 0) return result // already running
  const { done, error } = await deps.start(ids)
  const out = { ...result, containerIds: done }
  return error || done.length < ids.length
    ? failed(out, error ?? 'not every container started')
    : out
}

function volumeNames(stack: StackRow): string[] {
  return stack.volumes.map((v) => v.name)
}

function volumeBytesOf(stack: StackRow, names: readonly string[]): number {
  const set = new Set(names)
  return stack.volumes
    .filter((v) => set.has(v.name))
    .reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0)
}

/**
 * `docker rm` the stack's containers — never `--force`, so the caller has
 * already stopped them. Every volume counts as kept until the volume phase
 * decides otherwise.
 */
async function removeStackContainers(stack: StackRow, deps: ActionDeps): Promise<StackActResult> {
  const ids = stack.containers.map((c) => c.id)
  const { done, error } = await deps.removeContainers(ids)
  const out: StackActResult = {
    ...emptyResult(stack.id),
    containerIds: done,
    removedContainers: done,
    keptVolumes: volumeNames(stack)
  }
  // A volume a remaining container references is refused by docker anyway;
  // don't try, and keep every volume.
  return error || done.length < ids.length
    ? failed(out, error ?? 'not every container was removed')
    : out
}

/** Containers first, volumes second, and a volume only when asked (PRD §3.4). */
async function removeStack(
  stack: StackRow,
  removeVolumes: boolean,
  deps: ActionDeps
): Promise<StackActResult> {
  const eligible = stack.volumes.filter((v) => !v.shared).map((v) => v.name)
  const shared = stack.volumes.filter((v) => v.shared).map((v) => v.name)
  const removed = await removeStackContainers(stack, deps)
  if (!removed.ok) return removed
  let out: StackActResult = {
    ...removed,
    keptVolumes: removeVolumes ? shared : volumeNames(stack)
  }
  if (!removeVolumes || eligible.length === 0) return out

  const vol = await deps.removeVolumes(eligible)
  const removedSet = new Set(vol.done)
  out = {
    ...out,
    removedVolumes: vol.done,
    keptVolumes: [...shared, ...eligible.filter((n) => !removedSet.has(n))],
    freedVolumeBytes: volumeBytesOf(stack, vol.done)
  }
  return vol.error || vol.done.length < eligible.length
    ? failed(out, vol.error ?? 'not every volume was removed')
    : out
}

/** Runs one stack's docker work; a throw fails that stack, never the request. */
async function attempt(id: string, run: () => Promise<StackActResult>): Promise<StackActResult> {
  try {
    return await run()
  } catch (err) {
    return failed(emptyResult(id), err instanceof Error ? err.message : String(err))
  }
}

/** Runs one multi-argument docker command; a throw reads as "nothing was done". */
async function batch(run: () => Promise<DockerBatchResult>): Promise<DockerBatchResult> {
  try {
    return await run()
  } catch (err) {
    return { done: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** A stack an action changed, and what it did to it. */
interface Touched {
  stack: StackRow
  r: StackActResult
}

/**
 * A sweep's container phase for one stack: stop it when it is running, then
 * `docker rm` it. A stop that failed leaves containers running, and removing
 * those would need `--force`, which is never used — so the stack is reported
 * failed and its removal is skipped (T340 AC-3).
 */
async function sweepStackContainers(stack: StackRow, deps: ActionDeps): Promise<StackActResult> {
  if (!stack.running) return removeStackContainers(stack, deps)
  const stopped = await stopStack(stack, deps)
  if (!stopped.ok) return { ...stopped, keptVolumes: volumeNames(stack) }
  const removed = await removeStackContainers(stack, deps)
  return {
    ...removed,
    containerIds: [...new Set([...stopped.containerIds, ...removed.containerIds])],
    freedRamBytes: stopped.freedRamBytes,
    portsReleased: stopped.portsReleased
  }
}

/**
 * Which swept stack may remove which volumes, once every container is gone.
 *
 * A volume is removable when nothing outside the sweep still mounts it: two
 * swept stacks sharing one volume both lose it, which is exactly why the volume
 * phase waits for every container removal. A volume any surviving stack mounts
 * is kept, and so is one docker flags as shared for a reason the snapshot
 * cannot attribute to a stack (it belongs to another compose project). Each
 * volume is claimed by one stack, so nothing is counted twice.
 */
function planSweepVolumes(
  swept: readonly Touched[],
  snap: ContainersSnapshotAvailable
): Map<string, string[]> {
  const gone = new Set(swept.filter((t) => t.r.ok).map((t) => t.stack.id))
  const owners = new Map<string, string[]>()
  for (const s of snap.stacks) {
    for (const v of s.volumes) owners.set(v.name, [...(owners.get(v.name) ?? []), s.id])
  }
  const claimed = new Set<string>()
  const plan = new Map<string, string[]>()
  for (const { stack, r } of swept) {
    const take: string[] = []
    if (r.ok) {
      for (const v of stack.volumes) {
        if (claimed.has(v.name)) continue
        const own = owners.get(v.name) ?? [stack.id]
        const otherProject = v.shared && own.length <= 1
        if (otherProject || !own.every((id) => gone.has(id))) continue
        claimed.add(v.name)
        take.push(v.name)
      }
    }
    plan.set(stack.id, take)
  }
  return plan
}

/**
 * One sweep: stop-then-remove every target's containers, and only then — and
 * only when asked — remove the volumes nothing outside the sweep still needs.
 * Results keep the target order, whatever each phase did to them.
 */
async function runSweep(
  targets: readonly PlannedTarget[],
  removeVolumes: boolean,
  snap: ContainersSnapshotAvailable,
  deps: ActionDeps
): Promise<{ results: StackActResult[]; swept: Touched[] }> {
  const rows = new Map<string, StackActResult>()
  const swept: Touched[] = []

  // Phase 1 — containers.
  for (const target of targets) {
    const stack = target.stack
    if (target.refusal || !stack) {
      rows.set(target.id, refused(target.id, target.refusal ?? 'STACK_NOT_FOUND'))
      continue
    }
    const r = await attempt(stack.id, () => sweepStackContainers(stack, deps))
    swept.push({ stack, r })
    rows.set(target.id, r)
  }

  // Phase 2 — volumes, after every container removal, and only when asked.
  const plan = removeVolumes ? planSweepVolumes(swept, snap) : new Map<string, string[]>()
  const eligible = [...plan.values()].flat()
  if (eligible.length > 0) {
    const vol = await batch(() => deps.removeVolumes(eligible))
    const done = new Set(vol.done)
    // Every swept stack is re-read against what actually went: a volume two of
    // them shared is removed once, by the stack that claimed it, and neither
    // reports it as kept.
    for (const t of swept) {
      const mine = plan.get(t.stack.id) ?? []
      const removed = mine.filter((n) => done.has(n))
      const out: StackActResult = {
        ...t.r,
        removedVolumes: removed,
        keptVolumes: volumeNames(t.stack).filter((n) => !done.has(n)),
        freedVolumeBytes: volumeBytesOf(t.stack, removed)
      }
      t.r =
        removed.length < mine.length
          ? failed(out, vol.error ?? 'not every volume was removed')
          : out
      rows.set(t.stack.id, t.r)
    }
  }

  return { results: [...rows.values()], swept }
}

function tombstoneStack(stack: StackRow, r: StackActResult): TombstoneStack {
  // What a removal left behind is recorded in the journal itself, so "volume
  // kept" survives a restart and reads the same for the view and an agent.
  const keptSet = new Set(r.keptVolumes)
  const keptRows = stack.volumes.filter((v) => keptSet.has(v.name))
  // An unknown size is left off rather than summed as 0, so the view reads
  // "size unknown" instead of "0 B".
  const keptBytes = keptRows.every((v) => typeof v.sizeBytes === 'number')
    ? keptRows.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0)
    : null
  const keptFields =
    r.keptVolumes.length > 0
      ? {
          keptVolumes: [...r.keptVolumes],
          ...(keptBytes !== null ? { keptVolumeBytes: keptBytes } : {})
        }
      : {}
  return {
    stack: stack.id,
    name: stack.name,
    path: stack.attribution.path,
    containerIds: r.containerIds,
    freed: {
      ramBytes: r.freedRamBytes,
      ports: r.portsReleased,
      volumes: r.removedVolumes,
      volumeBytes: r.freedVolumeBytes
    },
    ...keptFields
  }
}

function restoreHint(verb: ActVerb, touched: readonly Touched[]): string | null {
  if (verb === 'stop') return restoreHintForStop(touched.flatMap((t) => t.r.containerIds))
  // A removal is restored by recreating the one stack it took. A sweep that
  // cleared several is not describable by one command, and a hint naming one
  // arbitrary stack would read as if it restored the batch: null is the honest
  // answer (T340).
  if ((verb === 'remove' || verb === 'sweep') && touched.length === 1) {
    const s = touched[0]!.stack
    return restoreHintForRemove({
      kind: s.kind,
      project: s.project,
      worktreePath: s.attribution.path,
      worktreeExists: s.attribution.folderKind !== 'gone'
    })
  }
  return null
}

/** One stack a request targets: the row it resolved to, and why it may not be touched. */
interface PlannedTarget {
  id: string
  stack: StackRow | null
  refusal: ActErrorCode | null
}

/** The stacks a request targets, with a refusal for each one that may not be touched. */
function planTargets(req: ActRequest, snap: ContainersSnapshotAvailable): PlannedTarget[] {
  const byId = new Map(snap.stacks.map((s) => [s.id, s]))
  if (req.verb === 'sweep') {
    // "Clear the list": every stack the tier table lets a sweep touch — every
    // zombie and orphan, running or exited (T340). The table is the only thing
    // that decides, so no flag in the request can widen the set.
    //
    // `only` (T342) narrows that set and nothing else: it is applied AFTER the
    // tier filter, so an id the table refuses — or one no scan knows — is simply
    // absent from the result rather than becoming a target or a refusal. Absent
    // `only` leaves the set exactly as it was before selection existed.
    const only = req.only ? new Set(req.only) : null
    return snap.stacks
      .filter((s) => refusalFor('sweep', s) === null)
      .filter((s) => only === null || only.has(s.id))
      .map((s) => ({ id: s.id, stack: s, refusal: null }))
  }
  if (req.verb === 'stop' && req.bulk) {
    // "Stop N running": every running stack under "Needs you" — never active,
    // protected, pending or unknown (PRD §3.4). Main picks the set, so a
    // renderer can't smuggle another stack into a bulk stop.
    return snap.stacks
      .filter((s) => s.running && NEEDS_YOU_VERDICTS.includes(s.verdict))
      .map((s) => ({ id: s.id, stack: s, refusal: null }))
  }
  const ids = req.verb === 'remove' ? [req.stack] : [...new Set(req.stacks ?? [])]
  const force = req.verb === 'stop' && req.force === true
  return ids.map((id) => {
    const stack = byId.get(id) ?? null
    if (!stack) return { id, stack, refusal: 'STACK_NOT_FOUND' as const }
    return { id, stack, refusal: refusalFor(req.verb, stack, { force }) }
  })
}

/**
 * The volumes a sweep of `targets` would take if every one of them succeeded —
 * exactly what the dialog offers before anything has run. Derived from
 * {@link planSweepVolumes}, the same function the volume phase itself runs, so
 * the disclosed rule and the applied rule can never drift apart.
 */
function intendedSweepVolumes(
  targets: readonly PlannedTarget[],
  snap: ContainersSnapshotAvailable
): string[] {
  const swept: Touched[] = []
  for (const t of targets) {
    if (t.refusal || !t.stack) continue
    swept.push({ stack: t.stack, r: emptyResult(t.stack.id) })
  }
  return [...planSweepVolumes(swept, snap).values()].flat()
}

/** Multiset equality: the same names, however they are ordered. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((name, i) => name === right[i])
}

/**
 * Whether the fresh scan still yields what the dialog disclosed (BUG-137).
 *
 * `targets` comes from {@link planTargets}, which never reads the disclosure:
 * main still picks its own set from its own tier table (T340), narrowed by the
 * operator's selection (T342). This only compares the two afterwards — so a
 * selection that took a stack out is checked against a disclosure that left it
 * out too, and a dialog listing a stack the selection dropped is refused.
 * Volumes are compared whether or not the operator
 * ticked the box — the dialog discloses them either way, and a confirm is a
 * promise about the whole list it showed, not just the part it would delete.
 */
function sweepSetMoved(
  disclosed: SweepDisclosure,
  targets: readonly PlannedTarget[],
  snap: ContainersSnapshotAvailable
): boolean {
  return (
    !sameNames(
      disclosed.stacks,
      targets.map((t) => t.id)
    ) || !sameNames(disclosed.volumes, intendedSweepVolumes(targets, snap))
  )
}

/** Stop, start and remove: one stack at a time, in the order the request named. */
async function runPerStack(
  req: Exclude<ActRequest, { verb: 'sweep' }>,
  targets: readonly PlannedTarget[],
  deps: ActionDeps
): Promise<{ results: StackActResult[]; swept: Touched[] }> {
  const results: StackActResult[] = []
  const swept: Touched[] = []
  for (const target of targets) {
    const stack = target.stack
    if (target.refusal || !stack) {
      results.push(refused(target.id, target.refusal ?? 'STACK_NOT_FOUND'))
      continue
    }
    const r = await attempt(stack.id, () => {
      if (req.verb === 'stop') return stopStack(stack, deps)
      if (req.verb === 'start') return startStack(stack, deps)
      return removeStack(stack, req.removeVolumes === true, deps)
    })
    results.push(r)
    swept.push({ stack, r })
  }
  return { results, swept }
}

/**
 * Runs one stop / start / remove / sweep request for `actor`. The actor is
 * never read from the request: the IPC handler passes `operator`, an MCP
 * handler `agent` — and a sweep, which is the operator's gesture, is refused
 * for any other actor.
 *
 * Writes ONE tombstone per action, listing every stack it changed; an action
 * that changed nothing (everything refused, or already in the desired state)
 * writes none.
 */
export async function runContainersAction(
  raw: unknown,
  actor: Actor,
  deps: ActionDeps
): Promise<ActResult> {
  const parsed = parseActRequest(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      verb: parsed.verb,
      error: 'BAD_REQUEST',
      message: parsed.message,
      results: [],
      tombstone: null
    }
  }
  const req = parsed.req
  if (req.verb === 'sweep' && actor !== 'operator') {
    // A sweep is one operator gesture over the whole "Needs you" list. An agent
    // stops and removes stacks one at a time, and no MCP op exposes this verb
    // (T340); a sweep arriving with an agent actor is a bug, not a request.
    return {
      ok: false,
      verb: req.verb,
      error: 'BAD_REQUEST',
      message: 'sweep is an operator action; an agent stops and removes stacks one at a time',
      results: [],
      tombstone: null
    }
  }

  const snap = await deps.scan()
  if (!snap.dockerAvailable) {
    return {
      ok: false,
      verb: req.verb,
      error: 'DOCKER_UNAVAILABLE',
      message: snap.dockerError,
      results: [],
      tombstone: null
    }
  }

  const targets = planTargets(req, snap)
  if (req.verb === 'sweep' && req.disclosed && sweepSetMoved(req.disclosed, targets, snap)) {
    // The confirm dialog's promise, made binding (BUG-137). Between the snapshot
    // the dialog rendered and the click, a stack can cross its "unused for"
    // threshold or lose its worktree and land in the sweep — and with the volume
    // box ticked, lose its data — having never been on screen. The whole sweep
    // fails closed: nothing is stopped, removed or journalled, and the operator
    // confirms the new list instead.
    return {
      ok: false,
      verb: req.verb,
      error: 'SWEEP_SET_CHANGED',
      message: REFUSAL_MESSAGES.SWEEP_SET_CHANGED,
      results: [],
      tombstone: null
    }
  }
  const { results, swept } =
    req.verb === 'sweep'
      ? await runSweep(targets, req.removeVolumes === true, snap, deps)
      : await runPerStack(req, targets, deps)
  const touched = swept.filter(({ r }) => r.containerIds.length > 0 || r.removedVolumes.length > 0)

  let tombstone: Tombstone | null = null
  let journalError: string | undefined
  if (touched.length > 0) {
    tombstone = {
      at: deps.now(),
      actor,
      verb: req.verb,
      stacks: touched.map((t) => tombstoneStack(t.stack, t.r)),
      restoreHint: restoreHint(req.verb, touched)
    }
    try {
      await deps.appendTombstone(tombstone)
    } catch (err) {
      // The action happened but its record did not: a failed result, never silent.
      journalError = `journal write failed: ${err instanceof Error ? err.message : String(err)}`
      tombstone = null
    }
  }

  return {
    ok: !journalError && results.every((r) => r.ok),
    verb: req.verb,
    ...(journalError ? { message: journalError } : {}),
    results,
    tombstone
  }
}
