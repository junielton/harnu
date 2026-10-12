// Pure core of the Cleanup "Archives" category (unit C). Every removal Harnu makes writes
// `refs/archive/<branch>/<stamp>/{tip,wip}` (reaper/archive-core.ts) so the work stays
// recoverable. Nothing ever deleted them, and each keeps its git objects alive for good, so Cleanup
// has to be able to clean its own exhaust: this file groups the refs into one entry per archived
// thing, decides which have outlived the retention, and builds the restore commands the UI copies.
//
// It lists `refs/archive/**` GENERICALLY. A ref of a shape it does not know (another unit's
// naming for a detached worktree, a hand-made ref) is still an entry, with its source unknown,
// so it can be seen, restored and, when it expires, removed. No I/O here: the git that reads
// and deletes lives in archives-shell.ts.

export const ARCHIVE_PREFIX = 'refs/archive/'

/** One ref under `refs/archive/`, as `git for-each-ref` reports it. */
export interface ArchiveRefInfo {
  ref: string
  sha: string
  /** Committer date of the ref's commit, in ms. Only a fallback: the stamp in the name wins. */
  at: number
}

/** One archived thing: a sweep's tip and working state, or a lone generic ref. Plain data. */
export interface ArchiveEntry {
  repoPath: string
  /** `refs/archive/<branch>/<stamp>` for a sweep; the ref itself for a generic one. */
  namespace: string
  /** Every ref of the entry, tip first. */
  refs: string[]
  tipRef: string | null
  tipSha: string | null
  wipRef: string | null
  wipSha: string | null
  hasWip: boolean
  /** The branch the sweep removed, or null for a detached or unknown source. */
  branch: string | null
  /** True when the namespace says the source was a detached HEAD. */
  detached: boolean
  /**
   * The folder the sweep removed, when the journal remembers it (its `trashedPath`); null for an
   * archive older than that record or one written by something else. Filled by `withFolders`.
   */
  folder: string | null
  /** When it was archived, in ms; NaN when neither the name nor the commit says. */
  at: number
  /** `git branch <name> <sha>`, ready to paste; null when there is no tip to restore. */
  restoreCommand: string | null
  /** A detached worktree on the working-state commit; null when there is no wip. */
  wipRestoreCommand: string | null
}

/** `20261002T101500Z` → ms, or null when it is not the compact stamp the Reaper writes. */
export function parseArchiveStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ]
  const at = Date.UTC(y, mo - 1, d, h, mi, s)
  // `Date.UTC` rolls 13/40 over into the next period; only an exact round trip is a real stamp.
  const back = new Date(at)
  const same =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s
  return same ? at : null
}

// Same rule as the journal's restore hint: a value that is already a safe bare shell word stays
// bare; anything else is single-quoted, so a hostile branch name stays literal when pasted.
const SHELL_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/
function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const SHORT = 7

/** The sweep shape: `refs/archive/<branch>/<stamp>/<tip|wip>`. */
const SWEEP_REF = /^refs\/archive\/(.+)\/(\d{8}T\d{6}Z)\/(tip|wip)$/

interface Draft {
  namespace: string
  branch: string | null
  detached: boolean
  stampAt: number | null
  fallbackAt: number
  tip: ArchiveRefInfo | null
  wip: ArchiveRefInfo | null
}

function finish(repoPath: string, d: Draft): ArchiveEntry {
  const refs = [d.tip?.ref, d.wip?.ref].filter((r): r is string => !!r)
  const tipSha = d.tip?.sha ?? null
  const wipSha = d.wip?.sha ?? null
  let restoreCommand: string | null = null
  if (tipSha) {
    const name = d.branch ?? `restored-${tipSha.slice(0, SHORT)}`
    restoreCommand = `git branch ${shellQuote(name)} ${tipSha}`
  }
  return {
    repoPath,
    namespace: d.namespace,
    refs,
    tipRef: d.tip?.ref ?? null,
    tipSha,
    wipRef: d.wip?.ref ?? null,
    wipSha,
    hasWip: wipSha !== null,
    branch: d.branch,
    detached: d.detached,
    folder: null,
    at: d.stampAt ?? d.fallbackAt,
    restoreCommand,
    wipRestoreCommand: wipSha
      ? `git worktree add --detach ../restored-${wipSha.slice(0, SHORT)} ${wipSha}`
      : null
  }
}

/**
 * One entry per archived thing, newest first. A tip and a wip that share a namespace are one
 * entry; any ref of another shape stands alone. A ref whose name is not under `refs/archive/`
 * is ignored here, so nothing outside the namespace can ever be offered for removal.
 */
export function groupArchiveRefs(
  repoPath: string,
  refs: readonly ArchiveRefInfo[]
): ArchiveEntry[] {
  const drafts = new Map<string, Draft>()
  for (const r of refs) {
    if (!r.ref.startsWith(ARCHIVE_PREFIX)) continue
    const m = SWEEP_REF.exec(r.ref)
    if (!m) {
      drafts.set(r.ref, {
        namespace: r.ref,
        branch: null,
        detached: false,
        stampAt: null,
        fallbackAt: r.at,
        tip: r,
        wip: null
      })
      continue
    }
    const [, branch, stamp, role] = m as unknown as [string, string, string, 'tip' | 'wip']
    const namespace = `${ARCHIVE_PREFIX}${branch}/${stamp}`
    let d = drafts.get(namespace)
    if (!d) {
      const detached = branch === 'detached'
      d = {
        namespace,
        branch: detached ? null : branch,
        detached,
        stampAt: parseArchiveStamp(stamp),
        fallbackAt: r.at,
        tip: null,
        wip: null
      }
      drafts.set(namespace, d)
    }
    if (role === 'tip') d.tip = r
    else d.wip = r
  }
  // A wip-only entry has no tip ref to hang its date on: its own commit date is the fallback.
  return [...drafts.values()]
    .map((d) => finish(repoPath, d))
    .sort(
      (a, b) => (Number.isNaN(b.at) ? -Infinity : b.at) - (Number.isNaN(a.at) ? -Infinity : a.at)
    )
}

const DAY_MS = 86_400_000

/**
 * The entries strictly older than `keepDays`, oldest first. Fails closed: a retention that is
 * not a positive finite number expires nothing, and an entry whose date is unknown is never
 * expired (nothing says how old it is).
 */
export function expiredArchives(
  entries: readonly ArchiveEntry[],
  keepDays: number,
  now: number
): ArchiveEntry[] {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return []
  const cutoff = now - keepDays * DAY_MS
  return entries.filter((e) => Number.isFinite(e.at) && e.at < cutoff).sort((a, b) => a.at - b.at)
}

/**
 * Names the folder each entry came from, using the journal lines whose archive refs are the
 * entry's own. Matching is by ref name: the journal records exactly the refs it wrote.
 */
export function withFolders(
  entries: readonly ArchiveEntry[],
  journal: ReadonlyArray<{
    archiveTipRef: string | null
    archiveWipRef: string | null
    trashedPath?: string | null
  }>
): ArchiveEntry[] {
  const byRef = new Map<string, string>()
  for (const t of journal) {
    if (typeof t.trashedPath !== 'string' || !t.trashedPath) continue
    for (const ref of [t.archiveTipRef, t.archiveWipRef]) if (ref) byRef.set(ref, t.trashedPath)
  }
  return entries.map((e) => ({
    ...e,
    folder: e.refs.map((r) => byRef.get(r)).find((f): f is string => !!f) ?? null
  }))
}

/** What the operator confirmed deleting: one entry as the screen showed it. */
export interface ConfirmedArchive {
  namespace: string
  tipSha: string | null
  wipSha: string | null
}

/**
 * The fresh entries that match what the operator confirmed, and the namespaces that no longer do.
 * An entry is deleted only if its namespace still exists with exactly the tip and wip shas the
 * confirm listed: a ref that moved, vanished or gained a wip since is `changed` and left alone.
 */
export function confirmedArchives(
  fresh: readonly ArchiveEntry[],
  requested: readonly ConfirmedArchive[]
): { entries: ArchiveEntry[]; changed: string[] } {
  const byNamespace = new Map(fresh.map((e) => [e.namespace, e]))
  const entries: ArchiveEntry[] = []
  const changed: string[] = []
  const seen = new Set<string>()
  for (const r of requested) {
    if (seen.has(r.namespace)) continue
    seen.add(r.namespace)
    const e = byNamespace.get(r.namespace)
    if (e && e.tipSha === r.tipSha && e.wipSha === r.wipSha) entries.push(e)
    else changed.push(r.namespace)
  }
  return { entries, changed }
}

// ---- the card the snapshot carries --------------------------------------------------------------

/** One repo's archives, newest first. */
export interface ArchiveRepoGroup {
  repoPath: string
  /** Basename of the repo folder: what a path-free surface (the agent listing) names it by. */
  repoAlias: string
  count: number
  /** Estimated bytes only the archives keep alive; null when git could not say. */
  bytes: number | null
  entries: ArchiveEntry[]
}

/** The Archives category of the Cleanup screen: every repo's `refs/archive/**`, plus the policy. */
export interface GcArchivesCard {
  repos: ArchiveRepoGroup[]
  count: number
  /** Sum of the repos whose size is known; null when archives exist and none could be sized. */
  bytes: number | null
  /** How many entries are past `keepDays` right now. */
  expiredCount: number
  keepDays: number
  /** "Expire archives automatically": the autopilot may delete the expired ones. */
  autoExpire: boolean
}

export const NO_ARCHIVES: GcArchivesCard = {
  repos: [],
  count: 0,
  bytes: 0,
  expiredCount: 0,
  keepDays: 30,
  autoExpire: false
}

const aliasOf = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

/** Joins what the shell read per repo into the card. Repos with no archives are left out. */
export function buildArchivesCard(
  perRepo: ReadonlyArray<{ repoPath: string; entries: ArchiveEntry[]; bytes: number | null }>,
  policy: { keepDays: number; autoExpire: boolean },
  now: number
): GcArchivesCard {
  const repos: ArchiveRepoGroup[] = perRepo
    .filter((r) => r.entries.length > 0)
    .map((r) => ({
      repoPath: r.repoPath,
      repoAlias: aliasOf(r.repoPath),
      count: r.entries.length,
      bytes: r.bytes,
      entries: r.entries
    }))
    .sort((a, b) => a.repoAlias.localeCompare(b.repoAlias) || a.repoPath.localeCompare(b.repoPath))
  const sized = repos.filter((r) => r.bytes !== null)
  return {
    repos,
    count: repos.reduce((n, r) => n + r.count, 0),
    bytes:
      repos.length === 0 ? 0 : sized.length === 0 ? null : sized.reduce((n, r) => n + r.bytes!, 0),
    expiredCount: repos.reduce(
      (n, r) => n + expiredArchives(r.entries, policy.keepDays, now).length,
      0
    ),
    keepDays: policy.keepDays,
    autoExpire: policy.autoExpire
  }
}
