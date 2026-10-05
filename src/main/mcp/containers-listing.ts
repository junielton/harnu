/**
 * The Containers verbs as an agent sees them: `list_containers` (T328) and the
 * `stop_containers` / `start_containers` / `remove_containers` actions (T329).
 *
 * Pure + deterministic. It never derives a verdict and never enforces a tier:
 * every verdict, clock and total comes from the Containers core (T330,
 * ADR-0014), and every stop/start/remove goes through its single action
 * function. This module only
 *  - redacts absolute paths to basename aliases, the `list_workers` convention
 *    (`folderAlias`, `attribution.pathAlias`, `recent[].stacks[].pathAlias`);
 *  - marks a stack a blocked folder covers with `agentControllable: false`,
 *    and still lists it — and names the stacks an action must refuse for it;
 *  - narrows the listing to one repo and its worktrees when the caller scopes
 *    it, with `totals` recomputed by the core's own {@link computeTotals};
 *  - shapes the `DOCKER_UNAVAILABLE` refusal, so docker being down is never
 *    read as an empty machine;
 *  - shapes an action's ACK and the operator's confirm copy.
 */

import * as path from 'node:path'
import { computeTotals } from '../containers/containers-core'
import { shellQuote } from '../containers/containers-journal'
import type {
  ActErrorCode,
  ActResult,
  AgentActVerb,
  Attribution,
  ContainersSnapshot,
  ContainersSnapshotAvailable,
  ContainersSnapshotUnavailable,
  ContainersTotals,
  StackActResult,
  StackRow,
  Tombstone,
  TombstoneStack
} from '../containers/containers-wire'
import type { NextAction } from './deny-hint'
import { isFolderDenied, isWithinRoot, normalizePath } from './permission-core'
import type { McpOp } from './tool-catalog'
import { redactTranscript } from './transcript-redact'

/** A stack's attribution with its absolute paths replaced by an alias. */
export interface ListedAttribution {
  rung: Attribution['rung']
  folderKind: Attribution['folderKind']
  /** Basename of the attributed path (the compose working dir), or null. */
  pathAlias: string | null
}

export type ListedStack = Omit<StackRow, 'attribution'> & {
  attribution: ListedAttribution
  /** Basename of the Harnu folder the stack is attributed to, or null. */
  folderAlias: string | null
  /** False when a folder the operator blocked for agents covers this stack. */
  agentControllable: boolean
}

export type ListedTombstoneStack = Omit<TombstoneStack, 'path'> & { pathAlias: string | null }

export type ListedTombstone = Omit<Tombstone, 'stacks'> & { stacks: ListedTombstoneStack[] }

/** The `list_containers` payload: a {@link ContainersSnapshotAvailable}, redacted. */
export interface ContainersListing {
  scannedAt: number
  dockerAvailable: true
  zombieAfterDays: number
  totals: ContainersTotals
  stacks: ListedStack[]
  recent: ListedTombstone[]
}

export interface DockerUnavailableRefusal {
  ok: false
  error: 'DOCKER_UNAVAILABLE'
  message: string
  /** Docker's own one-line error. */
  dockerError: string
  scannedAt: number
  nextActions: NextAction[]
}

/** The part of a Harnu folder the scope needs. */
export interface ScopeFolder {
  path: string
  repoId?: string
}

export interface ListingOptions {
  /** The live policy's blocked folders (`Policy.denyFolders`). */
  denyFolders: readonly string[]
  home: string
  /** From {@link containersScopeRoots}; null or absent lists every stack. */
  scopeRoots?: readonly string[] | null
}

function alias(p: string | null): string | null {
  if (p === null) return null
  return path.basename(p) || p
}

function anchorsOf(a: Attribution): string[] {
  return [a.path, a.folderPath].filter((p): p is string => p !== null)
}

/** False when a folder the operator blocked covers either of the stack's anchors. */
function isAgentControllable(
  a: Attribution,
  denyFolders: readonly string[],
  home: string
): boolean {
  return !anchorsOf(a).some((p) => isFolderDenied(p, denyFolders, home))
}

function withinAny(p: string, roots: readonly string[], home: string): boolean {
  const target = normalizePath(p, home)
  return roots.some((root) => isWithinRoot(target, root))
}

/**
 * The roots a scoped listing keeps: the scope itself plus every Harnu folder of
 * the same repo (its main checkout and all its worktrees). A scope no known
 * repo contains narrows to that folder alone.
 */
export function containersScopeRoots(
  scope: string,
  folders: readonly ScopeFolder[],
  home: string
): string[] {
  const target = normalizePath(scope, home)
  const owner = folders
    .map((f) => ({ path: normalizePath(f.path, home), repoId: f.repoId }))
    .filter((f) => isWithinRoot(target, f.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const roots = new Set([target])
  if (owner?.repoId !== undefined) {
    for (const f of folders) if (f.repoId === owner.repoId) roots.add(normalizePath(f.path, home))
  }
  return [...roots]
}

function listStack(s: StackRow, opts: ListingOptions): ListedStack {
  const { attribution, ...rest } = s
  return {
    ...rest,
    attribution: {
      rung: attribution.rung,
      folderKind: attribution.folderKind,
      pathAlias: alias(attribution.path)
    },
    folderAlias: alias(attribution.folderPath),
    agentControllable: isAgentControllable(attribution, opts.denyFolders, opts.home)
  }
}

/**
 * Every spelling of `p` a restore hint can carry, longest first: the
 * shell-quoted word the journal writes (`'/tmp/it'\''s'`), its inside without
 * the outer quotes, then the raw path. Splitting on the raw path alone misses
 * a directory whose name holds a single quote, and leaks it (T329 AC-9).
 */
function hintSpellings(p: string): string[] {
  const quoted = shellQuote(p)
  const inner = quoted.startsWith("'") && quoted.endsWith("'") ? quoted.slice(1, -1) : quoted
  return [...new Set([quoted, inner, p])]
}

/** A tombstone's restore hint with every stack's absolute directory shown as `<alias>`. */
export function redactRestoreHint(t: Tombstone): string | null {
  let restoreHint = t.restoreHint
  for (const s of t.stacks) {
    // The remove hint names the stack's directory; keep the command's shape
    // but never the absolute path, however the hint quoted it.
    if (restoreHint === null || !s.path) continue
    for (const spelling of hintSpellings(s.path)) {
      restoreHint = restoreHint.split(spelling).join(`<${alias(s.path)}>`)
    }
  }
  return restoreHint
}

function listTombstone(t: Tombstone): ListedTombstone {
  return {
    ...t,
    stacks: t.stacks.map(({ path: p, ...rest }) => ({ ...rest, pathAlias: alias(p) })),
    restoreHint: redactRestoreHint(t)
  }
}

/** Redact (and optionally scope) an available snapshot for an agent. */
export function containersListing(
  snap: ContainersSnapshotAvailable,
  opts: ListingOptions
): ContainersListing {
  const roots = opts.scopeRoots?.map((r) => normalizePath(r, opts.home)) ?? null
  const stacks = roots
    ? snap.stacks.filter((s) =>
        anchorsOf(s.attribution).some((p) => withinAny(p, roots, opts.home))
      )
    : snap.stacks
  const recent = roots
    ? snap.recent.filter((t) => t.stacks.some((s) => s.path && withinAny(s.path, roots, opts.home)))
    : snap.recent
  return {
    scannedAt: snap.scannedAt,
    dockerAvailable: true,
    zombieAfterDays: snap.zombieAfterDays,
    totals: roots ? computeTotals(stacks) : snap.totals,
    stacks: stacks.map((s) => listStack(s, opts)),
    recent: recent.map(listTombstone)
  }
}

/** Docker is missing or down: a refusal carrying docker's error, never an empty list. */
export function dockerUnavailableRefusal(
  snap: ContainersSnapshotUnavailable,
  home: string
): DockerUnavailableRefusal {
  const dockerError = redactTranscript(snap.dockerError, { home }).text
  return {
    ok: false,
    error: 'DOCKER_UNAVAILABLE',
    message: `Docker is unavailable, so no containers were scanned: ${dockerError}. This is not an empty machine.`,
    dockerError,
    scannedAt: snap.scannedAt,
    nextActions: [
      {
        do: 'Tell the operator Docker is unavailable (the CLI is missing or its daemon is down), then retry once it is running.',
        why: 'Harnu reads containers through the docker CLI; until it answers there is nothing to list.'
      }
    ]
  }
}

// ---- T329: the action verbs -------------------------------------------------

/**
 * Parity (T329 AC-6): every verb an agent may drive (`AgentActVerb`) and the
 * ONE MCP op that exposes it. A UI action with no agent verb, or an agent verb
 * with no UI action, fails the parity test.
 *
 * `AgentActVerb` is `ActVerb` minus `sweep` (T340): a sweep is one operator
 * gesture over the whole "Needs you" list and has no MCP op, so the exclusion
 * is checked by the compiler — a new verb added to `ActVerb` still has to be
 * mapped here or deliberately excluded there, and neither can be forgotten.
 */
export const CONTAINERS_ACT_OPS = {
  stop: 'stop_containers',
  start: 'start_containers',
  remove: 'remove_containers'
} as const satisfies Record<AgentActVerb, McpOp>

export type ContainersActOp = (typeof CONTAINERS_ACT_OPS)[AgentActVerb]

/** A per-stack code an agent reads: the action function's own, plus the folder block. */
export type ContainersActError = ActErrorCode | 'FOLDER_NOT_ALLOWED'

const FOLDER_BLOCKED_MESSAGE = 'a folder the operator blocked for agents covers this stack'

/**
 * The requested stack ids a folder the operator blocked covers. The action
 * verbs carry stack ids, never a folder, so the MCP gate cannot see a block;
 * the handler refuses these per stack before the action runs. An id the
 * snapshot doesn't know is not listed — the action refuses it STACK_NOT_FOUND.
 */
export function blockedStackIds(
  snap: ContainersSnapshotAvailable,
  ids: readonly string[],
  denyFolders: readonly string[],
  home: string
): string[] {
  if (denyFolders.length === 0) return []
  const byId = new Map(snap.stacks.map((s) => [s.id, s]))
  return [...new Set(ids)].filter((id) => {
    const s = byId.get(id)
    return s !== undefined && !isAgentControllable(s.attribution, denyFolders, home)
  })
}

export interface StopStackAck {
  stack: string
  ok: boolean
  freedBytes: number
  portsReleased: number[]
  error?: ContainersActError
  message?: string
}

export interface StartStackAck {
  stack: string
  ok: boolean
  error?: ContainersActError
  message?: string
}

export interface StopContainersAck {
  ok: boolean
  results: StopStackAck[]
  /** Set when the action ran but its journal line could not be written. */
  message?: string
}

export interface StartContainersAck {
  ok: boolean
  results: StartStackAck[]
  message?: string
}

export interface RemoveContainersAck {
  ok: boolean
  stack: string
  removedContainers: string[]
  removedVolumes: string[]
  /** Volumes left in place: not requested, shared with another stack, or refused by docker. */
  keptVolumes: string[]
  /** The compose recreate command, directory shown as `<alias>`; absent when nothing can recreate it. */
  restoreHint?: string
  error?: ContainersActError
  message?: string
}

/** A request-level refusal: nothing was attempted, so there are no per-stack results. */
export interface ContainersActRefusal {
  ok: false
  error: ActErrorCode
  message: string
  /** Docker's own one-line error, on DOCKER_UNAVAILABLE. */
  dockerError?: string
  nextActions: NextAction[]
}

export interface ActAckInput {
  /** The stack ids the agent named, in its order. */
  requested: readonly string[]
  /** The ids refused FOLDER_NOT_ALLOWED before the action ran. */
  blocked: readonly string[]
  /** The action function's result; null when every stack was blocked, so nothing ran. */
  result: ActResult | null
  home: string
}

export interface ActAck {
  isError: boolean
  payload: StopContainersAck | StartContainersAck | RemoveContainersAck | ContainersActRefusal
}

type Outcome = Omit<StackActResult, 'error'> & { error?: ContainersActError }

function redact(text: string, home: string): string {
  return redactTranscript(text, { home }).text
}

function blockedOutcome(stack: string): Outcome {
  return {
    stack,
    ok: false,
    error: 'FOLDER_NOT_ALLOWED',
    message: FOLDER_BLOCKED_MESSAGE,
    containerIds: [],
    freedRamBytes: 0,
    freedVolumeBytes: 0,
    portsReleased: [],
    removedContainers: [],
    removedVolumes: [],
    keptVolumes: []
  }
}

/** One outcome per distinct requested id, in the agent's order. */
function outcomesOf(input: ActAckInput): Outcome[] {
  const byId = new Map((input.result?.results ?? []).map((r) => [r.stack, r]))
  const blocked = new Set(input.blocked)
  const out: Outcome[] = []
  for (const id of new Set(input.requested)) {
    if (blocked.has(id)) out.push(blockedOutcome(id))
    else {
      const r = byId.get(id)
      if (r) out.push(r)
    }
  }
  return out
}

function errorFields(o: Outcome, home: string): { error?: ContainersActError; message?: string } {
  if (!o.error) return {}
  return { error: o.error, ...(o.message ? { message: redact(o.message, home) } : {}) }
}

function requestRefusal(error: ActErrorCode, message: string, home: string): ContainersActRefusal {
  if (error === 'DOCKER_UNAVAILABLE') {
    const dockerError = redact(message, home)
    return {
      ok: false,
      error,
      message: `Docker is unavailable, so nothing was changed: ${dockerError}.`,
      dockerError,
      nextActions: [
        {
          do: 'Tell the operator Docker is unavailable (the CLI is missing or its daemon is down), then retry once it is running.',
          why: 'Harnu acts on containers through the docker CLI; until it answers nothing can be stopped, started or removed.'
        }
      ]
    }
  }
  return { ok: false, error, message: redact(message, home), nextActions: [] }
}

/**
 * Shapes an action's result into the verb's ACK (MCP spec, T329). `ok` is true
 * only when every named stack succeeded and the journal line was written; a
 * partial failure is reported per stack, never swallowed.
 */
export function containersActAck(verb: AgentActVerb, input: ActAckInput): ActAck {
  const { result, home } = input
  if (result?.error) {
    return { isError: true, payload: requestRefusal(result.error, result.message ?? '', home) }
  }
  const outcomes = outcomesOf(input)
  const ok = (result?.ok ?? true) && outcomes.length > 0 && outcomes.every((o) => o.ok)
  // The action function reports a failed journal write as a top-level message.
  const journalMessage = result?.message ? redact(result.message, home) : undefined

  if (verb === 'remove') {
    const o = outcomes[0] ?? blockedOutcome(input.requested[0] ?? '')
    const hint = result?.tombstone ? redactRestoreHint(result.tombstone) : null
    const own = errorFields(o, home)
    const message = [own.message, journalMessage].filter(Boolean).join('; ')
    const payload: RemoveContainersAck = {
      ok,
      stack: o.stack,
      removedContainers: o.removedContainers,
      removedVolumes: o.removedVolumes,
      keptVolumes: o.keptVolumes,
      ...(hint ? { restoreHint: hint } : {}),
      ...(own.error ? { error: own.error } : {}),
      ...(message ? { message } : {})
    }
    return { isError: !ok, payload }
  }

  const top = { ok, ...(journalMessage ? { message: journalMessage } : {}) }
  const payload: StopContainersAck | StartContainersAck =
    verb === 'stop'
      ? {
          ...top,
          results: outcomes.map((o) => ({
            stack: o.stack,
            ok: o.ok,
            freedBytes: o.freedRamBytes,
            portsReleased: o.portsReleased,
            ...errorFields(o, home)
          }))
        }
      : {
          ...top,
          results: outcomes.map((o) => ({ stack: o.stack, ok: o.ok, ...errorFields(o, home) }))
        }
  return { isError: !ok, payload }
}

function stackIdsArg(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.stacks) ? args.stacks : [args.stack]
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0))]
}

function describeStack(id: string, byId: ReadonlyMap<string, StackRow>): string {
  const s = byId.get(id)
  if (!s) return `  - ${id} — not in Harnu's last scan`
  const where = s.attribution.path ?? 'no Harnu folder'
  return `  - ${id} — ${s.verdict}, ${s.running ? 'running' : 'stopped'}, ${where}`
}

/**
 * The operator's confirm copy for a Containers action. `remove_containers`
 * always lands here; `stop_containers` lands here on `force: true`; under the
 * operator's "Ask before agent actions" every one of the three does, so the
 * copy reads honestly either way. The stack lines come from Harnu's last scan
 * and may be stale: the tiers are re-checked on a fresh scan when the operator
 * allows.
 */
export function containersConfirmPrompt(
  op: ContainersActOp,
  args: Record<string, unknown>,
  snap: ContainersSnapshot | null
): string {
  const byId = new Map(
    snap?.dockerAvailable ? snap.stacks.map((s) => [s.id, s] as const) : ([] as const)
  )
  const ids = stackIdsArg(args)
  const lines = ids.map((id) => describeStack(id, byId)).join('\n')
  const recheck = 'Harnu re-checks every stack on a fresh scan when you allow.'

  if (op === 'remove_containers') {
    const s = byId.get(ids[0] ?? '')
    const volumes =
      args.removeVolumes === true
        ? `Also removes its volumes that no other stack uses${
            s
              ? ` (${
                  s.volumes
                    .filter((v) => !v.shared)
                    .map((v) => v.name)
                    .join(', ') || 'none'
                })`
              : ''
          }: the data in them is gone for good.`
        : 'Keeps its volumes (removeVolumes is not set).'
    return (
      `Remove Docker stack "${ids[0] ?? '(none)'}" for an agent:\n${lines}\n\n` +
      `Its containers are deleted with docker rm, never --force. There is no undo: only a compose stack whose worktree still exists can be recreated.\n` +
      `${volumes}\n\n` +
      `${recheck} A running, active, protected, pending or unattributed stack is refused.`
    )
  }
  const n = ids.length
  const noun = `${n} Docker stack${n === 1 ? '' : 's'}`
  if (op === 'start_containers') return `Start ${noun} for an agent:\n${lines}\n\n${recheck}`
  if (args.force === true) {
    return (
      `Force-stop ${noun} for an agent:\n${lines}\n\n` +
      `force lets a stop reach an ACTIVE stack (a session is working in its folder) or a PROTECTED one (a repo's main checkout). A stack Harnu can't attribute to a folder is still refused. A stop is reversible: start_containers brings it back.\n\n${recheck}`
    )
  }
  return `Stop ${noun} for an agent:\n${lines}\n\nA stop is reversible: start_containers brings it back.\n\n${recheck}`
}
