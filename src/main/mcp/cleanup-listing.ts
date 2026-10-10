/**
 * The workspace-GC verbs as an agent sees them: `list_cleanup` and `release_worktree` (T445,
 * design: workspace-gc §10).
 *
 * Pure + deterministic. It never decides a bucket and never removes anything: every bucket,
 * reason and size comes from the GC bundle core, and the only write an agent can cause is
 * the release mark the handler hands to the GC service. This module only
 *  - keeps every absolute path out of the payload: aliases are basenames, a review reason is a
 *    fixed sentence per code (never the raw git/fs error the code was raised with), and any
 *    other free text a field carries has each path token cut down to its basename;
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
  /** A fixed, path-free sentence for a bundle that needs review; null for ready and in-use. */
  reason: string | null
  /** The review code behind `reason` (`dirty`, `cleanup-failed`, ...); null when there is none. */
  reasonCode: string | null
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
  ready: number
  readyBytes: number
  review: number
  reviewBytes: number
  inUse: number
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
  const tail = item.branch
    ? stripPaths(item.branch, { glued: false })
    : item.path
      ? alias(item.path)
      : ''
  const hash = createHash('sha256').update(item.id).digest('hex').slice(0, 8)
  return `${alias(item.repoPath)}::${item.kind}::${tail}::${hash}`
}

/**
 * Every absolute path in `text` cut down to its basename: POSIX (`/a/b`, `~/a`), Windows
 * (`C:\a\b`, `C:/a`, rooted `\a\b`), UNC (`\\host\share\a`) and `file://` URLs alike, also
 * when a folder name holds spaces. Any other URL is left alone. Applied before the `$HOME`
 * rewrite, so a path inside the home directory loses its prefix as well.
 *
 * A path glued straight after a word character or a dot (`rc=1/srv/...`) is cut when it starts
 * at a well-known root (`/srv`, `/home`, ...): the root list keeps `feat/home/page`-style text
 * from being mistaken for one. Callers holding a git ref pass `{ glued: false }`.
 */
const STOP = '\\s"\'`<>|,;)'
/** One path segment, optionally with single spaces when the path clearly goes on after them. */
const segment = (sep: string): string => {
  const ch = `[^${STOP}${sep}]`
  return `(?:${ch}| (?=(?:${ch}+ )*${ch}+[${sep}]))`
}
const POSIX_SEG = segment('\\/')
const WIN_SEG = segment('\\\\/')
const GLUE_ROOTS =
  'home|Users|srv|tmp|var|opt|mnt|root|usr|etc|private|Volumes|workspace|media|data'

const PATH_TOKEN = new RegExp(
  [
    // 1: file:// URL, 2: any other URL (kept)
    '(file:\\/\\/[^\\s"\'`<>|]*)',
    '([A-Za-z][\\w+.-]*:\\/\\/\\S*)',
    // 3: a rooted POSIX path glued after a word character or a dot
    `(?<=[\\w.])(\\/(?:${GLUE_ROOTS})(?:\\/${POSIX_SEG}*)+)`,
    // 4: drive, UNC, rooted Windows, POSIX and ~ paths
    `((?<![\\w])[A-Za-z]:[\\\\/]${WIN_SEG}*(?:[\\\\/]${WIN_SEG}*)*` +
      `|(?<![\\w])\\\\\\\\[^\\\\/\\s]+[\\\\/]${WIN_SEG}*(?:[\\\\/]${WIN_SEG}*)*` +
      `|(?<![\\w.\\\\])\\\\${WIN_SEG}+(?:\\\\${WIN_SEG}*)+` +
      `|(?<![\\w.~/-])~?(?:\\/${POSIX_SEG}*)+)`
  ].join('|'),
  'g'
)

const baseOf = (token: string): { name: string; trail: string } => {
  const trail = /[.:]+$/.exec(token)?.[0] ?? ''
  const body = trail ? token.slice(0, -trail.length) : token
  const segments = body.split(/[\\/]/).filter((s) => s && s !== '~')
  return { name: segments[segments.length - 1] ?? '', trail }
}

export function stripPaths(text: string, opts: { glued?: boolean } = {}): string {
  const glued = opts.glued ?? true
  return text.replace(PATH_TOKEN, (match, file?: string, url?: string, glue?: string) => {
    if (url) return match
    if (glue !== undefined) {
      // Not a glue we trust (a git ref, say): leave the text alone.
      if (!glued) return match
      const { name, trail } = baseOf(glue)
      return ` ${name}${trail}`
    }
    const { name, trail } = baseOf(file ? file.slice('file://'.length) : match)
    return name + trail
  })
}

/** Free text for the payload: paths cut to basenames, then the usual home/secret redaction. */
function safe(text: string, home: string, opts: { glued?: boolean } = {}): string {
  return redactTranscript(stripPaths(text, opts), { home }).text
}

/** The fixed, path-free sentence for each review code. The raw detail is never passed on. */
const REVIEW_SENTENCES: Record<string, string> = {
  dirty: 'The working tree has uncommitted changes, or could not be verified clean.',
  unpushed: 'The branch has commits that are not pushed.',
  'open-idle-session': 'A session is still open in this worktree, though idle.',
  'closed-unmerged': 'The pull request was closed without being merged.',
  'remote-gone': 'The remote branch is gone and no pull request records a merge.',
  detached: 'This worktree has a detached HEAD, so there is no branch to judge.',
  'unknown-fate': 'The state of the branch could not be determined.',
  'weak-merge-signal': 'The merge is only weakly proven.',
  'shared-stack': 'A Docker stack also runs from outside this worktree.',
  'path-unresolved': 'A path of this worktree could not be resolved.',
  'nested-worktree':
    'Another worktree or checkout lives inside this one, so removing it would take that one along.',
  'check-failed':
    'Harnu could not check this worktree for other checkouts, so it cannot tell whether removing it would take one along.',
  locked: 'This worktree is locked in git; release it there first.'
}

const GENERIC_REVIEW_SENTENCE = 'This worktree needs your review.'

/** `Cleanup stopped at <step>.` — the step is a short lowercase word, never free text. */
function cleanupFailedSentence(detail: string): string {
  const step = /^Cleanup stopped at ([a-z][a-z-]*)\b/.exec(detail)?.[1]
  return `Cleanup stopped at ${step ?? 'an earlier step'}.`
}

/** A review reason as the agent sees it: its code and a fixed sentence. Both are path-free. */
export function reviewReason(reason: { code: string; detail: string } | null): {
  code: string
  sentence: string
} | null {
  if (!reason) return null
  const sentence =
    reason.code === 'cleanup-failed'
      ? cleanupFailedSentence(reason.detail)
      : (REVIEW_SENTENCES[reason.code] ?? GENERIC_REVIEW_SENTENCE)
  return { code: reason.code, sentence }
}

/**
 * Whether the bundle carries a release that still applies: a mark made at the bundle's current
 * tip. A mark from an older tip, or a legacy one with no tip, does not count.
 */
function releaseApplies(snap: GcSnapshot, b: WorktreeBundle): boolean {
  const tip = snap.prefs.releasedFrom[b.item.id]?.localTip
  return snap.prefs.released[b.item.id] !== undefined && !!tip && tip === b.localTip
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
  const reason = reviewReason(b.reason)
  return {
    id: safe(listedId(b), opts.home),
    folderAlias: safe(b.item.path ? alias(b.item.path) : alias(b.item.repoPath), opts.home),
    branch: b.item.branch ? safe(b.item.branch, opts.home, { glued: false }) : null,
    bucket: b.bucket,
    reason: reason?.sentence ?? null,
    reasonCode: reason?.code ?? null,
    bytes: b.item.diskBytes,
    depsBytes: b.depsBytes,
    released: releaseApplies(snap, b),
    agentControllable: isControllable(b, opts.denyFolders, opts.home)
  }
}

function listVolume(v: OrphanVolumeItem, home: string): ListedOrphanVolume {
  return {
    id: safe(v.id, home),
    name: safe(v.name, home),
    sizeBytes: v.sizeBytes,
    project: v.project === null ? null : safe(v.project, home),
    reason: safe(v.reason.detail, home)
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
    ready: count('ready'),
    readyBytes: sum('ready'),
    review: count('review'),
    reviewBytes: sum('review'),
    inUse: count('in-use'),
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
  /** Why it is not ready to clean, when it is not: a fixed, path-free sentence. */
  reason: string | null
  /** The review code behind `reason`; null when there is none. */
  reasonCode: string | null
  /** Always false: release marks a bundle, it never removes one. */
  deleted: false
  message: string
}

/** What the agent named: the worktree's folder, or the `id` `list_cleanup` listed. */
export interface ReleaseRequest {
  folder?: string
  id?: string
}

export interface ReleaseOptions {
  /**
   * Real path of any folder the request touches (symlinks followed), from `realPathLookup`.
   * Absent compares by normalized spelling only.
   */
  real?: (p: string) => string
  /** The live policy's blocked folders; a blocked worktree OR repo is refused first. */
  denyFolders: readonly string[]
  home: string
  now: number
  /** Harnu's folder list, for a main checkout that is not a bundle. */
  folders: ReadonlyArray<{ path: string; isMainWorktree?: boolean }>
}

export type ReleasePlan =
  /** A folder the operator blocked covers the worktree or its repo (the handler refuses it). */
  | { ok: false; blocked: true }
  | { ok: false; blocked?: false; refusal: ReleaseRefusal }
  | {
      ok: true
      bundleId: string
      from: { repoPath: string; path: string; localTip: string }
      ack: ReleaseAck
    }

const refuse = (
  error: ReleaseRefusalCode,
  message: string,
  next: NextAction
): { ok: false; refusal: ReleaseRefusal } => ({
  ok: false,
  refusal: { ok: false, error, message, nextActions: [next] }
})

/**
 * Decides one release. Order of refusals: a blocked worktree or repo (before anything else, so
 * an out-of-tree worktree of a blocked repo is always FOLDER_NOT_ALLOWED), main checkout,
 * unknown folder, fate not strongly merged. A release
 * that passes is accepted even when another rule keeps the bundle out of `ready`: the ACK
 * then names the bucket it will be in and why, instead of pretending it will be cleaned.
 */
export function planRelease(
  snap: GcSnapshot,
  request: ReleaseRequest,
  opts: ReleaseOptions
): ReleasePlan {
  const folder = request.folder
  const real = (p: string): string => opts.real?.(p) ?? normalizePath(p, opts.home)
  const target = folder ? real(folder) : null
  const same = (p: string): boolean => target !== null && real(p) === target
  const bundle = request.id
    ? snap.bundles.find((b) => listedId(b) === request.id)
    : snap.bundles.find((b) => b.item.path && same(b.item.path))

  if (bundle && anchorsOf(bundle).some((p) => isFolderDenied(p, opts.denyFolders, opts.home))) {
    return { ok: false, blocked: true }
  }

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
        why: 'Only a linked worktree can be ready to clean.'
      }
    )
  }
  if (!bundle) {
    return refuse('NOT_A_WORKTREE', "Harnu's last cleanup scan has no worktree there.", {
      do: 'Call list_cleanup and pass the `id` of the worktree from its listing, or the exact folder of the worktree you worked in. A worktree created moments ago shows up after the next scan.',
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

  // A merge proof is about one tip. With no tip on record the release could not be tied to
  // anything, so it would never apply: say so instead of recording a dead mark.
  const localTip = bundle.localTip
  if (typeof localTip !== 'string' || !localTip) {
    return refuse(
      'FATE_NOT_MERGED',
      "This worktree's branch tip could not be read, so a merge cannot be tied to it.",
      {
        do: 'Retry after the next cleanup scan; call list_cleanup to see whether the worktree is judged.',
        why: 'A release applies to the exact tip it was made at.'
      }
    )
  }

  const releasedAlready = releaseApplies(snap, bundle)
  // What the next gather will conclude: no grace, and the release time stands in for a
  // missing sign of life. Every other rule is judged exactly as it is.
  const judged = bucketOf(
    { ...bundle, graceDays: 0, lastSignOfLifeAt: bundle.lastSignOfLifeAt ?? opts.now },
    opts.now,
    0
  )
  // The snapshot's own failure overlay wins: a bundle whose last cleanup halted reads
  // "Needs review" for the failure window whatever its facts say, so a release cannot promise
  // it is about to be cleaned.
  const halted = bundle.reason?.code === 'cleanup-failed'
  // A bundle the snapshot already holds in review is past its grace window, so a release (which
  // lifts the grace and nothing else) cannot move it out, whatever rule put it there — a git
  // lock, a nested worktree, a shared stack. Reading the snapshot rather than re-deriving keeps
  // that true for a rule `bucketOf` does not know yet.
  const held = bundle.bucket === 'review'
  const after = halted || held ? { bucket: 'review' as const, reason: bundle.reason } : judged
  const reason = reviewReason(after.reason)
  const message = halted
    ? 'Released, but the last cleanup of this worktree stopped, so it stays in review until that failure note expires (about a day) or the operator retries. Nothing was deleted.'
    : held
      ? 'Released, but this worktree stays in review: a release lifts the grace window and nothing else. Nothing was deleted.'
      : after.bucket === 'ready'
        ? 'Released. The grace window no longer applies, so this worktree is ready to clean from the next scan. Nothing was deleted: the operator cleans it, or the autopilot does when it is on and acknowledged.'
        : `Released, but this worktree is not ready to clean (it is ${after.bucket}): a release lifts the grace window and nothing else. Nothing was deleted.`
  return {
    ok: true,
    bundleId: bundle.item.id,
    from: { repoPath: bundle.item.repoPath, path: bundle.item.path ?? '', localTip },
    ack: {
      ok: true,
      op: 'release_worktree',
      folderAlias: safe(alias(bundle.item.path ?? bundle.item.repoPath), opts.home),
      branch: bundle.item.branch ? safe(bundle.item.branch, opts.home, { glued: false }) : null,
      released: true,
      alreadyReleased: releasedAlready,
      bucketAfter: after.bucket,
      reason: reason?.sentence ?? null,
      reasonCode: reason?.code ?? null,
      deleted: false,
      message
    }
  }
}
