/**
 * The workspace-GC verbs as an agent sees them: `list_cleanup` and `release_worktree` (T445,
 * design: workspace-gc §10).
 *
 * Pure + deterministic. It never decides a bucket and never removes anything: every bucket,
 * reason and size comes from the GC bundle core, and the only write an agent can cause is
 * the release mark the handler hands to the GC service. This module only
 *  - redacts absolute paths to basename aliases, the `list_containers` convention
 *    (`folderAlias`, a rebuilt `id`, redacted reasons);
 *  - marks a bundle a blocked folder covers with `agentControllable: false`, and still lists it;
 *  - narrows the listing to one repo and its worktrees when the caller scopes it, with the
 *    totals recomputed over what is left;
 *  - decides a release request: the refusals, in a fixed order, and what the bucket becomes.
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { bucketOf, type Bucket, type WorktreeBundle } from '../gc/bundle-core'
import type { OrphanVolumeItem } from '../gc/gc-housekeeping-input'
import type { GcSnapshot } from '../gc/gc-wire'
import type { NextAction } from './deny-hint'
import { isFolderDenied, isWithinRoot, normalizePath } from './permission-core'
import { redactTranscript } from './transcript-redact'

/** One worktree bundle, redacted. */
export interface ListedBundle {
  /** A readable label, `<repo>::<kind>::<branch>`. Opaque: never a path. */
  id: string
  /** Basename of the worktree folder. */
  folderAlias: string
  /** Null for a detached worktree. */
  branch: string | null
  bucket: Bucket
  /** The one-sentence reason for a Decide bundle; null for corpse and alive. */
  reason: string | null
  /** Disk the checkout occupies (dependency directories included), when it was measured. */
  bytes: number | null
  /** The part of `bytes` that dehydrating would free, when known. */
  depsBytes: number | null
  /** An agent released this bundle: its grace window no longer applies. */
  released: boolean
  /** False when a folder the operator blocked for agents covers this worktree. */
  agentControllable: boolean
}

export interface ListedOrphanVolume {
  id: string
  name: string
  sizeBytes: number | null
  project: string | null
  reason: string
}

export interface CleanupTotals {
  corpse: number
  corpseBytes: number
  decide: number
  decideBytes: number
  alive: number
  orphanVolumes: number
  orphanVolumeBytes: number
}

/** The `list_cleanup` payload: a {@link GcSnapshot}, redacted and optionally scoped. */
export interface CleanupListing {
  scannedAt: number
  bundles: ListedBundle[]
  orphanVolumes: ListedOrphanVolume[]
  totals: CleanupTotals
  autopilot: {
    enabled: boolean
    /** True until the operator acknowledges the first report: the autopilot only counts. */
    reportOnly: boolean
    graceDays: number
  }
  /** When the next timer tick fires, or null when the background scan is off. */
  nextCycleAt: number | null
}

export interface CleanupListingOptions {
  /** The live policy's blocked folders (`Policy.denyFolders`). */
  denyFolders: readonly string[]
  home: string
  /**
   * The folder the caller scoped to; absent lists every bundle. A bundle is in scope when its
   * own repo (`item.repoPath`) is the scoped folder's repo, so a worktree outside the repo
   * tree and unknown to Harnu's folder list is still found.
   */
  scope?: string | null
  /** From `containersScopeRoots`: also keeps whatever lies under the scope or its sibling folders. */
  scopeRoots?: readonly string[] | null
}

const alias = (p: string): string => path.basename(p) || p

/**
 * The raw item id embeds the repo path, so the label is rebuilt from basenames plus a short
 * hash of the raw id. Two repos that share a basename and a branch still get different ids,
 * and the label leaks no path. `release_worktree` accepts it back as `{ id }`.
 */
export function listedId(b: Pick<WorktreeBundle, 'item'>): string {
  const { item } = b
  const tail = item.branch ?? (item.path ? alias(item.path) : '')
  const hash = createHash('sha256').update(item.id).digest('hex').slice(0, 8)
  return `${alias(item.repoPath)}::${item.kind}::${tail}::${hash}`
}

function redact(text: string, home: string): string {
  return redactTranscript(text, { home }).text
}

/** The bundle's anchors: the worktree itself and the repo it belongs to. */
function anchorsOf(b: WorktreeBundle): string[] {
  return [b.item.path, b.item.repoPath].filter((p): p is string => typeof p === 'string' && !!p)
}

function isControllable(b: WorktreeBundle, denyFolders: readonly string[], home: string): boolean {
  return !anchorsOf(b).some((p) => isFolderDenied(p, denyFolders, home))
}

/** The repos a scoped folder belongs to: the scope is a repo's checkout, or one of its worktrees. */
function scopedRepos(bundles: readonly WorktreeBundle[], scope: string, home: string): Set<string> {
  const target = normalizePath(scope, home)
  const repos = new Set<string>()
  for (const b of bundles) {
    const repo = normalizePath(b.item.repoPath, home)
    const own = b.item.path ? normalizePath(b.item.path, home) : null
    if (isWithinRoot(target, repo) || (own !== null && isWithinRoot(target, own))) repos.add(repo)
  }
  return repos
}

function inScope(
  b: WorktreeBundle,
  repos: ReadonlySet<string>,
  roots: readonly string[],
  home: string
): boolean {
  if (repos.has(normalizePath(b.item.repoPath, home))) return true
  const own = b.item.path ? normalizePath(b.item.path, home) : null
  return own !== null && roots.some((root) => isWithinRoot(own, root))
}

function listBundle(
  b: WorktreeBundle,
  snap: GcSnapshot,
  opts: CleanupListingOptions
): ListedBundle {
  return {
    id: listedId(b),
    folderAlias: b.item.path ? alias(b.item.path) : alias(b.item.repoPath),
    branch: b.item.branch ?? null,
    bucket: b.bucket,
    reason: b.reason ? redact(b.reason.detail, opts.home) : null,
    bytes: b.item.diskBytes,
    depsBytes: b.depsBytes,
    released: snap.prefs.released[b.item.id] !== undefined,
    agentControllable: isControllable(b, opts.denyFolders, opts.home)
  }
}

function listVolume(v: OrphanVolumeItem, home: string): ListedOrphanVolume {
  return {
    id: v.id,
    name: v.name,
    sizeBytes: v.sizeBytes,
    project: v.project,
    reason: redact(v.reason.detail, home)
  }
}

function totalsOf(
  bundles: readonly ListedBundle[],
  volumes: readonly ListedOrphanVolume[]
): CleanupTotals {
  const sum = (bucket: Bucket): number =>
    bundles.filter((b) => b.bucket === bucket).reduce((n, b) => n + (b.bytes ?? 0), 0)
  const count = (bucket: Bucket): number => bundles.filter((b) => b.bucket === bucket).length
  return {
    corpse: count('corpse'),
    corpseBytes: sum('corpse'),
    decide: count('decide'),
    decideBytes: sum('decide'),
    alive: count('alive'),
    orphanVolumes: volumes.length,
    orphanVolumeBytes: volumes.reduce((n, v) => n + (v.sizeBytes ?? 0), 0)
  }
}

/**
 * Redact (and optionally scope) a snapshot for an agent. A scoped listing leaves the orphan
 * volumes out: they belong to no folder, so no repo scope can claim them.
 */
export function cleanupListing(snap: GcSnapshot, opts: CleanupListingOptions): CleanupListing {
  const scoped = !!opts.scope || !!opts.scopeRoots
  const roots = opts.scopeRoots?.map((r) => normalizePath(r, opts.home)) ?? []
  const repos = opts.scope ? scopedRepos(snap.bundles, opts.scope, opts.home) : new Set<string>()
  const bundles = snap.bundles
    .filter((b) => (scoped ? inScope(b, repos, roots, opts.home) : true))
    .map((b) => listBundle(b, snap, opts))
  const orphanVolumes = scoped ? [] : snap.orphanVolumes.map((v) => listVolume(v, opts.home))
  return {
    scannedAt: snap.scannedAt,
    bundles,
    orphanVolumes,
    totals: totalsOf(bundles, orphanVolumes),
    autopilot: {
      enabled: snap.prefs.autopilot,
      reportOnly: !snap.prefs.firstReportAcknowledged,
      graceDays: snap.prefs.graceDays
    },
    nextCycleAt: snap.nextCycleAt
  }
}

// ---- release_worktree ---------------------------------------------------------------------

export type ReleaseRefusalCode = 'IS_MAIN_CHECKOUT' | 'NOT_A_WORKTREE' | 'FATE_NOT_MERGED'

export interface ReleaseRefusal {
  ok: false
  error: ReleaseRefusalCode
  message: string
  nextActions: NextAction[]
}

export interface ReleaseAck {
  ok: true
  op: 'release_worktree'
  folderAlias: string
  branch: string | null
  released: true
  /** True when this bundle was already released: nothing new was recorded. */
  alreadyReleased: boolean
  /** The bucket the bundle takes once the grace no longer applies. */
  bucketAfter: Bucket
  /** Why it is not a corpse, when it is not. */
  reason: string | null
  /** Always false: release marks a bundle, it never removes one. */
  deleted: false
  message: string
}

export interface ReleaseOptions {
  home: string
  now: number
  /** Harnu's folder list, for a main checkout that is not a bundle. */
  folders: ReadonlyArray<{ path: string; isMainWorktree?: boolean }>
}

export type ReleasePlan =
  { ok: false; refusal: ReleaseRefusal } | { ok: true; bundleId: string; ack: ReleaseAck }

const refuse = (
  error: ReleaseRefusalCode,
  message: string,
  next: NextAction
): { ok: false; refusal: ReleaseRefusal } => ({
  ok: false,
  refusal: { ok: false, error, message, nextActions: [next] }
})

/**
 * Decides one release. Order of refusals: main checkout, unknown folder, fate not strongly
 * merged. (A blocked folder is refused by the handler before it reaches here.) A release
 * that passes is accepted even when another rule keeps the bundle out of `corpse`: the ACK
 * then names the bucket it will be in and why, instead of pretending it will be cleaned.
 */
export function planRelease(snap: GcSnapshot, folder: string, opts: ReleaseOptions): ReleasePlan {
  const target = normalizePath(folder, opts.home)
  const same = (p: string): boolean => normalizePath(p, opts.home) === target
  const bundle = snap.bundles.find((b) => b.item.path && same(b.item.path))

  const isMain =
    bundle?.isMainCheckout === true ||
    snap.bundles.some((b) => same(b.item.repoPath)) ||
    opts.folders.some((f) => f.isMainWorktree === true && same(f.path))
  if (isMain) {
    return refuse(
      'IS_MAIN_CHECKOUT',
      "This is a repo's main checkout, which is never cleaned, so there is nothing to release.",
      {
        do: 'Release the feature worktree whose PR merged, not the main checkout.',
        why: 'Only a linked worktree can be a corpse.'
      }
    )
  }
  if (!bundle) {
    return refuse('NOT_A_WORKTREE', "Harnu's last cleanup scan has no worktree at this folder.", {
      do: 'Call list_cleanup to see the worktrees Harnu tracks, and pass the exact folder of one of them. A worktree created moments ago shows up after the next scan.',
      why: 'release_worktree only marks a worktree the cleanup scan already judged.'
    })
  }
  if (bundle.fate.fate !== 'merged' || !bundle.fate.strong) {
    const why =
      bundle.fate.fate === 'merged'
        ? 'its merge is only weakly proven'
        : `its branch state is "${bundle.fate.fate}"`
    return refuse(
      'FATE_NOT_MERGED',
      `This worktree cannot be released: ${why}. Only a strongly merged worktree can skip its grace window.`,
      {
        do: 'Release it after its pull request merged and Harnu has seen the merge (list_cleanup shows the bucket).',
        why: 'The grace window is a safety margin; only proof that the work reached the default branch lifts it.'
      }
    )
  }

  const releasedAlready = snap.prefs.released[bundle.item.id] !== undefined
  // What the next gather will conclude: no grace, and the release time stands in for a
  // missing sign of life. Every other rule is judged exactly as it is.
  const after = bucketOf(
    { ...bundle, graceDays: 0, lastSignOfLifeAt: bundle.lastSignOfLifeAt ?? opts.now },
    opts.now,
    0
  )
  const reason = after.reason ? redact(after.reason.detail, opts.home) : null
  const message =
    after.bucket === 'corpse'
      ? 'Released. The grace window no longer applies, so this worktree is a corpse from the next scan. Nothing was deleted: the operator cleans it, or the autopilot does when it is on and acknowledged.'
      : `Released, but this worktree stays ${after.bucket}: a release lifts the grace window and nothing else. Nothing was deleted.`
  return {
    ok: true,
    bundleId: bundle.item.id,
    ack: {
      ok: true,
      op: 'release_worktree',
      folderAlias: alias(bundle.item.path ?? folder),
      branch: bundle.item.branch ?? null,
      released: true,
      alreadyReleased: releasedAlready,
      bucketAfter: after.bucket,
      reason,
      deleted: false,
      message
    }
  }
}
