// Pure view model of the Cleanup screen (design.md "Workspace GC — unified Cleanup"): turns the
// `gc:snapshot` payload into regions, buckets, blocks, totals and the selection rules, and builds
// the `gc:clean` payload. No DOM, no Vue, no i18n — unit-tested in tests/gc-model.test.ts.

import type { Bucket, DecideCode, WorktreeBundle } from '../../../main/gc/bundle-core'
import type { GcSnapshot, OrphanVolumeItem } from '../../../main/gc/gc-wire'

export type BlockKind = 'worktree' | 'volume'
export type ReasonCode = DecideCode | 'no-known-worktree'

export interface GcBlock {
  id: string
  kind: BlockKind
  bucket: Bucket
  repoPath: string | null
  repoLabel: string | null
  /** Short identity: the worktree folder, or the volume name. */
  name: string
  branch: string | null
  bytes: number
  hasBytes: boolean
  reasonCode: ReasonCode | null
  /** The engine's English sentence with the concrete fact; shown as detail, never as the headline. */
  reasonDetail: string | null
  project: string | null
  stackIds: string[]
  ownedVolumes: string[]
  depsBytes: number | null
  bundle: WorktreeBundle | null
  volume: OrphanVolumeItem | null
}

export interface BucketGroup {
  bucket: Bucket
  blocks: GcBlock[]
  bytes: number
}

export interface RepoRegion {
  repoPath: string
  label: string
  bytes: number
  worktrees: number
  counts: Record<Bucket, number>
  groups: BucketGroup[]
}

export interface BucketTotal {
  count: number
  bytes: number
}

export interface GcModel {
  regions: RepoRegion[]
  /** Worktree blocks only (the map). */
  blocks: GcBlock[]
  /** Every block by id, orphan volumes included. */
  byId: Map<string, GcBlock>
  /** Decide items, biggest first — the "Needs you" list. Orphan volumes included. */
  needsYou: GcBlock[]
  corpses: GcBlock[]
  totals: {
    corpse: BucketTotal
    decide: BucketTotal
    alive: BucketTotal
    orphanVolumes: BucketTotal
  }
  /** Corpse + Decide + orphan volumes: everything that is not untouched. */
  reclaimableBytes: number
  /** False when no worktree reports a size (Windows): the map has nothing to draw. */
  hasBytes: boolean
}

const BUCKET_ORDER: Bucket[] = ['corpse', 'decide', 'alive']

export const volumeBlockId = (name: string): string => `volume:${name}`

const basename = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

const bigFirst = (a: GcBlock, b: GcBlock): number =>
  b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function worktreeBlock(b: WorktreeBundle): GcBlock {
  const { item } = b
  const bytes = item.diskBytes
  return {
    id: item.id,
    kind: 'worktree',
    bucket: b.bucket,
    repoPath: item.repoPath,
    repoLabel: basename(item.repoPath),
    name: item.path ? basename(item.path) : (item.branch ?? item.id),
    branch: item.branch ?? null,
    bytes: bytes ?? 0,
    hasBytes: bytes !== null && bytes !== undefined,
    reasonCode: b.reason?.code ?? null,
    reasonDetail: b.reason?.detail ?? null,
    project: null,
    stackIds: b.stackIds,
    ownedVolumes: b.ownedVolumes,
    depsBytes: b.depsBytes,
    bundle: b,
    volume: null
  }
}

function volumeBlock(v: OrphanVolumeItem): GcBlock {
  return {
    id: v.id,
    kind: 'volume',
    bucket: 'decide',
    repoPath: null,
    repoLabel: null,
    name: v.name,
    branch: null,
    bytes: v.sizeBytes ?? 0,
    hasBytes: v.sizeBytes !== null,
    reasonCode: v.reason.code,
    reasonDetail: v.reason.detail,
    project: v.project,
    stackIds: [],
    ownedVolumes: [v.name],
    depsBytes: null,
    bundle: null,
    volume: v
  }
}

const emptyTotal = (): BucketTotal => ({ count: 0, bytes: 0 })

export function buildGcModel(snapshot: GcSnapshot): GcModel {
  const worktrees = snapshot.bundles.map(worktreeBlock)
  const volumes = snapshot.orphanVolumes.map(volumeBlock)

  const byRepo = new Map<string, GcBlock[]>()
  for (const b of worktrees) {
    const list = byRepo.get(b.repoPath ?? '')
    if (list) list.push(b)
    else byRepo.set(b.repoPath ?? '', [b])
  }

  const regions: RepoRegion[] = [...byRepo.entries()].map(([repoPath, blocks]) => {
    const counts: Record<Bucket, number> = { corpse: 0, decide: 0, alive: 0 }
    const groups: BucketGroup[] = []
    for (const bucket of BUCKET_ORDER) {
      const inBucket = blocks.filter((b) => b.bucket === bucket).sort(bigFirst)
      counts[bucket] = inBucket.length
      if (inBucket.length > 0) {
        groups.push({ bucket, blocks: inBucket, bytes: inBucket.reduce((a, b) => a + b.bytes, 0) })
      }
    }
    return {
      repoPath,
      label: basename(repoPath),
      bytes: blocks.reduce((a, b) => a + b.bytes, 0),
      worktrees: blocks.length,
      counts,
      groups
    }
  })
  regions.sort((a, b) => b.bytes - a.bytes || (a.label < b.label ? -1 : 1))

  const totals = {
    corpse: emptyTotal(),
    decide: emptyTotal(),
    alive: emptyTotal(),
    orphanVolumes: emptyTotal()
  }
  for (const b of worktrees) {
    totals[b.bucket].count++
    totals[b.bucket].bytes += b.bytes
  }
  for (const v of volumes) {
    totals.orphanVolumes.count++
    totals.orphanVolumes.bytes += v.bytes
  }

  const byId = new Map<string, GcBlock>()
  for (const b of [...worktrees, ...volumes]) byId.set(b.id, b)

  return {
    regions,
    blocks: worktrees,
    byId,
    needsYou: [...worktrees.filter((b) => b.bucket === 'decide'), ...volumes].sort(bigFirst),
    corpses: worktrees.filter((b) => b.bucket === 'corpse').sort(bigFirst),
    totals,
    reclaimableBytes: totals.corpse.bytes + totals.decide.bytes + totals.orphanVolumes.bytes,
    hasBytes: worktrees.length === 0 || worktrees.some((b) => b.hasBytes)
  }
}

// ---- selection ------------------------------------------------------------------------------

/** Only Decide items are selectable: corpses are cleaned by the hero, alive items are never touched. */
export const isCheckable = (b: GcBlock): boolean => b.bucket === 'decide'

export function toggleChecked(
  model: GcModel,
  selection: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(selection)
  const block = model.byId.get(id)
  if (next.has(id)) {
    next.delete(id)
  } else if (block && isCheckable(block)) {
    next.add(id)
  }
  return next
}

/** "Select all in repo": that repo's Decide worktrees. Orphan volumes belong to no repo. */
export function selectAllInRepo(model: GcModel, repoPath: string): string[] {
  return model.blocks.filter((b) => b.repoPath === repoPath && isCheckable(b)).map((b) => b.id)
}

export function selectionStats(
  model: GcModel,
  selection: ReadonlySet<string>
): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const id of selection) {
    const b = model.byId.get(id)
    if (!b) continue
    count++
    bytes += b.bytes
  }
  return { count, bytes }
}

/** A selected item that was cleaned, kept or re-bucketed drops out on its own. */
export function prunedSelection(model: GcModel, selection: ReadonlySet<string>): Set<string> {
  const next = new Set<string>()
  for (const id of selection) {
    const b = model.byId.get(id)
    if (b && isCheckable(b)) next.add(id)
  }
  return next
}

// ---- hero -----------------------------------------------------------------------------------

export type HeroState =
  | { kind: 'clean'; count: number; bytes: number; soft: boolean }
  | { kind: 'empty' }
  | { kind: 'running'; done: number; total: number; freedBytes: number }

export function heroState(
  model: GcModel,
  running: { done: number; total: number; freedBytes: number } | null,
  firstReportAcknowledged: boolean
): HeroState {
  if (running) {
    return {
      kind: 'running',
      done: running.done,
      total: running.total,
      freedBytes: running.freedBytes
    }
  }
  if (model.corpses.length === 0) return { kind: 'empty' }
  return {
    kind: 'clean',
    count: model.corpses.length,
    bytes: model.totals.corpse.bytes,
    soft: !firstReportAcknowledged
  }
}

// ---- confirm dialog -------------------------------------------------------------------------

export type RemovalChip = 'stack' | 'volume' | 'deps' | 'checkout' | 'branch'

export interface DialogRow {
  id: string
  kind: BlockKind
  repo: string | null
  name: string
  branch: string | null
  bytes: number
  chips: RemovalChip[]
  reasonCode: ReasonCode | null
  reasonDetail: string | null
  project: string | null
  /** The worktree may hold work no other branch has. */
  risk: boolean
}

/**
 * Decide reasons under which the removed code is NOT unique to this worktree. Everything else —
 * including an unknown or failed state — is treated as a risk and gets the stronger warning.
 */
const NOT_RISKY: ReadonlySet<string> = new Set(['open-idle-session', 'shared-stack'])

export function dialogRows(
  model: GcModel,
  ids: readonly string[],
  removeVolumes: boolean
): DialogRow[] {
  const rows: DialogRow[] = []
  for (const id of ids) {
    const b = model.byId.get(id)
    if (!b) continue
    const chips: RemovalChip[] = []
    if (b.kind === 'volume') {
      chips.push('volume')
    } else {
      if (b.stackIds.length > 0) chips.push('stack')
      if (removeVolumes && b.ownedVolumes.length > 0) chips.push('volume')
      if ((b.depsBytes ?? 0) > 0) chips.push('deps')
      chips.push('checkout')
      if (b.branch) chips.push('branch')
    }
    rows.push({
      id,
      kind: b.kind,
      repo: b.repoLabel,
      name: b.name,
      branch: b.branch,
      bytes: b.bytes,
      chips,
      reasonCode: b.reasonCode,
      reasonDetail: b.reasonDetail,
      project: b.project,
      risk: b.kind === 'worktree' && b.bucket === 'decide' && !NOT_RISKY.has(b.reasonCode ?? '')
    })
  }
  return rows
}

// ---- gc:clean payload -----------------------------------------------------------------------

/** What the dialog showed for one item; main refuses the item if its facts changed since. */
export interface ExpectedFacts {
  bucket: Bucket
  reasonCode: string | null
  headSha: string | null
  stackIds: string[]
  ownedVolumes: string[]
  bytes: number | null
}

export interface CleanRequestOptions {
  /** Ids the operator explicitly confirmed — Decide items and orphan volumes. Absent for bulk corpses. */
  confirmed?: string[]
  expected: Record<string, ExpectedFacts>
}

export interface CleanRequest {
  ids: string[]
  options: CleanRequestOptions
}

/**
 * The single place that builds the `gc:clean` payload, so a change of the wire contract is one edit.
 * `corpses` is the hero's bulk clean (expected facts, nothing confirmed); `decide` is Remove selected
 * (every id confirmed, expected for each). Ids the model no longer knows are dropped, never sent blind.
 */
export function cleanRequestFor(
  model: GcModel,
  ids: readonly string[],
  mode: 'corpses' | 'decide'
): CleanRequest {
  const want: Bucket = mode === 'corpses' ? 'corpse' : 'decide'
  const kept: string[] = []
  const expected: Record<string, ExpectedFacts> = {}
  for (const id of ids) {
    const b = model.byId.get(id)
    if (!b || b.bucket !== want) continue
    kept.push(id)
    expected[id] = {
      bucket: b.bucket,
      reasonCode: b.reasonCode,
      headSha: b.bundle?.localTip ?? b.bundle?.item.headSha ?? null,
      stackIds: [...b.stackIds],
      ownedVolumes: [...b.ownedVolumes],
      bytes: b.hasBytes ? b.bytes : null
    }
  }
  const options: CleanRequestOptions = { expected }
  if (mode === 'decide') options.confirmed = [...kept]
  return { ids: kept, options }
}
