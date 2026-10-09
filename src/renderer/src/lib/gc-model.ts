// Pure view model of the Cleanup screen (design.md "Workspace GC — unified Cleanup"): turns the
// `gc:snapshot` payload into regions, buckets, blocks, totals and the selection rules, and builds
// the `gc:clean` payload. No DOM, no Vue, no i18n — unit-tested in tests/gc-model.test.ts.

import type { Bucket, ReviewCode, WorktreeBundle } from '../../../main/gc/bundle-core'
import type {
  GcCleanOptions,
  GcDockerCard,
  GcExpected,
  GcSnapshot,
  OrphanVolumeItem
} from '../../../main/gc/gc-wire'

export type BlockKind = 'worktree' | 'volume'
export type ReasonCode = ReviewCode | 'no-known-worktree'

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
  /** `proj/www`-style label for the region header (the full path is its tooltip). */
  displayLabel: string
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
  /** Needs review items, biggest first — the "Needs review" list. Orphan volumes included. */
  review: GcBlock[]
  ready: GcBlock[]
  totals: {
    ready: BucketTotal
    review: BucketTotal
    'in-use': BucketTotal
    orphanVolumes: BucketTotal
    /** What the autopilot's next Docker housekeeping would reclaim (cache + dangling images), when it is on. */
    docker: BucketTotal
  }
  /** The snapshot's Docker figures, null per figure when Docker did not answer for it. */
  docker: GcDockerCard
  /** Ready + Needs review + orphan volumes + Docker cache/images: everything that is not untouched. */
  reclaimableBytes: number
  /** False when no worktree reports a size (Windows): the map has nothing to draw. */
  hasBytes: boolean
}

const BUCKET_ORDER: Bucket[] = ['ready', 'review', 'in-use']

export const volumeBlockId = (name: string): string => `volume:${name}`

const basename = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

/**
 * The label a map region wears: the last two path segments (`proj/www`, `org/portal`), so a repo with
 * an org parent reads like the mockup's `org/proj/www` and two repos called `www` stay apart.
 */
export function repoDisplayLabel(repoPath: string): string {
  const parts = repoPath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.slice(-2).join('/') || repoPath
}

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
    repoLabel: repoDisplayLabel(item.repoPath),
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
    bucket: 'review',
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
    const counts: Record<Bucket, number> = { ready: 0, review: 0, 'in-use': 0 }
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
      displayLabel: repoDisplayLabel(repoPath),
      bytes: blocks.reduce((a, b) => a + b.bytes, 0),
      worktrees: blocks.length,
      counts,
      groups
    }
  })
  regions.sort((a, b) => b.bytes - a.bytes || (a.label < b.label ? -1 : 1))

  const totals = {
    ready: emptyTotal(),
    review: emptyTotal(),
    'in-use': emptyTotal(),
    orphanVolumes: emptyTotal(),
    docker: emptyTotal()
  }
  const docker: GcDockerCard = snapshot.docker ?? {
    buildCacheReclaimableBytes: null,
    danglingImages: null,
    orphanVolumesHidden: null
  }
  if (snapshot.prefs.categories.dockerCache) {
    totals.docker.count = docker.danglingImages?.count ?? 0
    totals.docker.bytes =
      (docker.buildCacheReclaimableBytes ?? 0) + (docker.danglingImages?.bytes ?? 0)
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
    review: [...worktrees.filter((b) => b.bucket === 'review'), ...volumes].sort(bigFirst),
    ready: worktrees.filter((b) => b.bucket === 'ready').sort(bigFirst),
    totals,
    docker,
    reclaimableBytes:
      totals.ready.bytes + totals.review.bytes + totals.orphanVolumes.bytes + totals.docker.bytes,
    hasBytes: worktrees.length === 0 || worktrees.some((b) => b.hasBytes)
  }
}

// ---- selection ------------------------------------------------------------------------------

/** Only Needs review items are selectable: ready items are cleaned by the hero, in-use items are never touched. */
export const isCheckable = (b: GcBlock): boolean => b.bucket === 'review'

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

/** "Select all in repo": that repo's Needs review worktrees. Orphan volumes belong to no repo. */
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
  if (model.ready.length === 0) return { kind: 'empty' }
  return {
    kind: 'clean',
    count: model.ready.length,
    bytes: model.totals.ready.bytes,
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
  /** Stacks this removal stops (the breakdown line sums them). */
  stackCount: number
  reasonCode: ReasonCode | null
  reasonDetail: string | null
  project: string | null
  /** The worktree may hold work no other branch has. */
  risk: boolean
}

/**
 * Needs review reasons under which the removed code is NOT unique to this worktree. Everything else —
 * including an unknown or failed state — is treated as a risk and gets the stronger warning.
 */
const NOT_RISKY: ReadonlySet<string> = new Set(['open-idle-session', 'shared-stack'])

export function dialogRows(model: GcModel, ids: readonly string[]): DialogRow[] {
  const rows: DialogRow[] = []
  for (const id of ids) {
    const b = model.byId.get(id)
    if (!b) continue
    const chips: RemovalChip[] = []
    if (b.kind === 'volume') {
      chips.push('volume')
    } else {
      if (b.stackIds.length > 0) chips.push('stack')
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
      stackCount: b.kind === 'volume' ? 0 : b.stackIds.length,
      reasonCode: b.reasonCode,
      reasonDetail: b.reasonDetail,
      project: b.project,
      risk: b.kind === 'worktree' && b.bucket === 'review' && !NOT_RISKY.has(b.reasonCode ?? '')
    })
  }
  return rows
}

/** The numbers behind the dialog's breakdown line. A worktree's volumes are kept, so only volume ROWS count. */
export interface DialogBreakdown {
  stacks: number
  deps: number
  worktrees: number
  volumes: number
}

export function dialogBreakdown(rows: readonly DialogRow[]): DialogBreakdown {
  return {
    stacks: rows.reduce((a, r) => a + r.stackCount, 0),
    deps: rows.filter((r) => r.chips.includes('deps')).length,
    worktrees: rows.filter((r) => r.kind === 'worktree').length,
    volumes: rows.filter((r) => r.kind === 'volume').length
  }
}

// ---- gc:clean payload -----------------------------------------------------------------------

export interface CleanRequest {
  ids: string[]
  options: Required<Pick<GcCleanOptions, 'expected'>> & Pick<GcCleanOptions, 'confirmed'>
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

/**
 * The facts a row showed for one item, in the shape `gc:clean` compares them with a fresh gather.
 * Mirrors `expectedOf` / `orphanExpectedOf` in `src/main/gc/gc-confirm.ts` (same semantics; the
 * renderer never imports main code). A worktree's `bytes` is sent but not compared; a volume's size
 * and project are, and a missing project counts as a change. `path` is the worktree folder as the row
 * showed it (null for a volume): a worktree moved with `git worktree move` keeps its id, head and reason.
 */
export function expectedFor(b: GcBlock): GcExpected {
  if (b.kind === 'volume') {
    return {
      bucket: 'orphan-volume',
      reasonCode: b.reasonCode,
      headSha: null,
      stackIds: [],
      ownedVolumes: [b.name],
      bytes: b.hasBytes ? b.bytes : null,
      path: null,
      project: b.project
    }
  }
  return {
    bucket: b.bucket,
    reasonCode: b.reasonCode,
    headSha: b.bundle?.localTip ?? null,
    stackIds: sorted(b.stackIds),
    ownedVolumes: sorted(b.ownedVolumes),
    bytes: b.hasBytes ? b.bytes : null,
    path: b.bundle?.item.path ?? null,
    workStamp: b.bundle?.item.workStamp ?? null
  }
}

/** A halted ready item: shown as review (`cleanup-failed`), retried as the ready item it still is. */
export function isRetryAsReady(b: GcBlock): boolean {
  return b.kind === 'worktree' && b.bucket === 'review' && b.bundle?.retryAs === 'ready'
}

/**
 * The single place that builds the `gc:clean` payload, so a change of the wire contract is one edit.
 * `ready` is the hero's bulk clean (expected facts, nothing confirmed); `review` is Remove selected
 * (every id confirmed, expected for each). Ids the model no longer knows are dropped, never sent blind.
 */
export function cleanRequestFor(
  model: GcModel,
  ids: readonly string[],
  mode: 'ready' | 'review'
): CleanRequest {
  const want: Bucket = mode === 'ready' ? 'ready' : 'review'
  const kept: string[] = []
  const expected: Record<string, GcExpected> = {}
  for (const id of ids) {
    const b = model.byId.get(id)
    // A ready item whose cleanup halted is listed as review (`retryAs`), but its Retry is the
    // ready path: guarded, and needing no confirmation of its own (TM-05).
    if (!b || (b.bucket !== want && !(mode === 'ready' && isRetryAsReady(b)))) continue
    kept.push(id)
    expected[id] = expectedFor(b)
  }
  const options: CleanRequest['options'] = { expected }
  if (mode === 'review') options.confirmed = [...kept]
  return { ids: kept, options }
}

// ---- the dialog binds to what it showed -------------------------------------------------------

/** What a confirm dialog showed when it opened: its rows and the exact request it will send. */
export interface CapturedConfirm {
  mode: 'ready' | 'review'
  /** The ids that survived capture (unknown or wrong-bucket ids are dropped, never sent blind). */
  ids: string[]
  rows: DialogRow[]
  request: CleanRequest
}

/** Freeze the dialog's rows and `expected` facts at the moment it opens; null when nothing is valid. */
export function captureConfirm(
  model: GcModel,
  ids: readonly string[],
  mode: 'ready' | 'review'
): CapturedConfirm | null {
  const request = cleanRequestFor(model, ids, mode)
  if (request.ids.length === 0) return null
  return { mode, ids: request.ids, rows: dialogRows(model, request.ids), request }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Same comparison main makes (`bundleChangedSince` / `volumeChangedSince`): bucket, reason, head, stacks and
 * volumes — and, for an orphan volume only, its size and project. A worktree's disk use drifts without
 * anything having changed, so its bytes are not compared.
 */
/** Slashes and `.` / `..` segments normalized, so a spelling difference of the same folder is not a change. */
function pathKey(p: string | null | undefined): string | null {
  if (!p) return null
  const abs = /^[\\/]/.test(p)
  const out: string[] = []
  for (const seg of p.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

function sameFacts(a: GcExpected, b: GcExpected): boolean {
  if (a.bucket !== b.bucket || a.reasonCode !== b.reasonCode || a.headSha !== b.headSha)
    return false
  if (!sameList(a.stackIds, b.stackIds) || !sameList(a.ownedVolumes, b.ownedVolumes)) return false
  if (a.bucket === 'orphan-volume')
    return a.bytes === b.bytes && (a.project ?? null) === (b.project ?? null)
  return pathKey(a.path) === pathKey(b.path)
}

/**
 * Whether what the open dialog showed is no longer what the model says (a cycle or a job refreshed the
 * snapshot underneath it). The dialog then blocks its confirm until it is reopened.
 */
export function confirmChanged(model: GcModel, captured: CapturedConfirm): boolean {
  const fresh = cleanRequestFor(model, captured.ids, captured.mode)
  if (!sameList(fresh.ids, captured.ids)) return true
  return captured.ids.some(
    (id) => !sameFacts(fresh.options.expected[id], captured.request.options.expected[id])
  )
}
