/**
 * Imperative shell for the Reaper cleanup engine: gathers real git/gh/fs state,
 * one repo at a time, and hands it to the pure `scan-core` to assemble a
 * {@link ReaperSnapshot}. No decision logic lives here — see `reaper-core.ts` /
 * `scan-core.ts` for the pure classifier and inventory builder.
 *
 * env-bound (`child_process` + `node:fs` + electron `app`) ⇒ e2e-only per
 * ADR-0001; only the re-exported {@link ghCacheFresh} is unit-tested.
 */

import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import {
  buildRepoItems,
  ghCacheFresh,
  parseForEachRef,
  gapFillCandidates,
  isPatchIdContained,
  mergeGapFills,
  parseGhPrListResult,
  parseLsRemoteHeads,
  parsePatchIdSet,
  readGhCacheEntry,
  squashBranchArgv,
  squashHistoryArgv,
  GH_CACHE_VERSION,
  GH_PR_LIST_OPTS,
  PR_LIST_LIMIT,
  type GhCacheEntry,
  type GhGapFill,
  type LocalBranchRef,
  type ReaperSnapshot
} from './scan-core'
import type { BranchFacts, PrFacts, ReapItem } from './reaper-core'
import { parseWorktreeList, type WorktreeListEntry, type WorktreeStatus } from '../worktree-core'
import { readUserProjects } from '../user-projects'
import { getFleetFolders } from '../fleet-model'
import { getTaskStates } from '../hook-bridge'
import { spawnEnvOnce } from '../appimage-env'
import { liveSessionKeys } from '../pty'
import { probeGitMetaBatch } from '../git-probe'
import { probeWorktreeStatus, hasUnpushedCommits, readManifestSources } from '../worktree-ipc'
import { resolveManifest } from '../worktree-manifest'
import {
  deriveHydration,
  isHydratableKind,
  manifestFactsFor,
  normalizeEphemeralEntry,
  planDehydrate,
  withReconciled,
  type DehydratePlan,
  type EphemeralEntryFacts,
  type HydrationRecord,
  type HydrationRecordFile,
  type ManifestFacts
} from './dehydrate-core'
import {
  mapLimit,
  measureFolder,
  probeEphemeralEntries,
  stillModified,
  type ExecFn
} from './dehydrate-shell'
import { readHydrationFile, updateHydrationFile } from './hydration-store'
import { needsWorkStamp, scanWorkStamp } from '../gc/gc-work-stamp'

export { ghCacheFresh }

const execFileAsync = promisify(execFile)

/**
 * Every subprocess in the scan goes through here so it is spawned with the
 * user's login-shell PATH (BUG-34). A Dock-launched macOS build inherits
 * launchd's minimal PATH — no `/opt/homebrew/bin` — so bare `gh` is ENOENT and
 * the scan reports `ghAvailable: false` on a machine where `gh` is installed
 * and authenticated. `git` and `du` ride the same seam for the same reason.
 */
async function runFile(
  file: string,
  args: readonly string[],
  opts: Omit<ExecFileOptions, 'env'>
): Promise<{ stdout: string }> {
  // `encoding` is pinned so the promisified overload resolves to the string
  // form (utf8 is execFile's own default — no behavior change).
  return execFileAsync(file, [...args], {
    ...opts,
    encoding: 'utf8',
    env: await spawnEnvOnce()
  })
}

/** The dehydrate shell's subprocess seam, bound to the same login-PATH runner (BUG-34). */
export const reaperExec: ExecFn = (file, args, opts) =>
  runFile(file, args, { windowsHide: true, ...opts })

/** Shared `execFile` options for `git` probes (no shell, hard bounds). */
const GIT_OPTS = { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 } as const
/** `gh` and the remote `ls-remote` probe get a shorter, network-shaped budget. */
const GH_OPTS = { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 20 } as const
/**
 * Folder sizes are measured for every folder row now (T250), not only the
 * harvestable ones, so the `du` pass is capped rather than serialized — see
 * `DU_BUDGET` in `dehydrate-shell.ts` for the per-call budget.
 */
const MEASURE_CONCURRENCY = 3
// The bulk PR list gets its own, much larger budget — `GH_PR_LIST_OPTS`, shared
// with the PR Stack canvas via scan-core. It asks for up to {@link PR_LIST_LIMIT}
// rows with their check rollups, which neither the 15s network budget nor the
// 1 MiB buffer of {@link GH_OPTS} would survive.

const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'develop']

/** The inputs branch-fate resolution needs for one worktree item. */
export interface FateInput {
  facts: BranchFacts
  localTip: string | null
}

export interface ScanOptions {
  /** Rescan only these (already-discovered) repo paths; merges into the last full snapshot. */
  repoPaths?: string[]
  /** Bypass the gh disk cache. */
  force?: boolean
  /** Prefs-driven protected-branch list (slice 2); defaults to `DEFAULT_PROTECTED_BRANCHES`. */
  protectedBranches?: string[]
}

// ---- gh disk cache (30-min TTL) -------------------------------------------

type GhCacheFile = Record<string, GhCacheEntry>

function ghCachePath(): string {
  return path.join(app.getPath('userData'), 'reaper-gh-cache.json')
}

async function readGhCache(): Promise<GhCacheFile> {
  try {
    const content = await fs.readFile(ghCachePath(), 'utf8')
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? (parsed as GhCacheFile) : {}
  } catch {
    return {}
  }
}

async function writeGhCache(cache: GhCacheFile): Promise<void> {
  try {
    await fs.writeFile(ghCachePath(), JSON.stringify(cache), 'utf8')
  } catch (err) {
    console.warn('[reaper] failed to write gh cache', err)
  }
}

// ---- repo discovery ---------------------------------------------------------

/** Repos with a main worktree Harnu already knows about (from pinned + fleet folders). */
async function discoverRepos(): Promise<Array<{ repoPath: string }>> {
  const [userProjects, fleetFolders] = await Promise.all([readUserProjects(), getFleetFolders()])
  const pathSet = new Set<string>()
  for (const p of userProjects.projects) pathSet.add(p.path)
  for (const f of fleetFolders) pathSet.add(f.path)

  const metaByPath = await probeGitMetaBatch([...pathSet])
  const mainByRepoId = new Map<string, string>()
  for (const [p, meta] of metaByPath) {
    if (meta.repoId && meta.isMainWorktree) mainByRepoId.set(meta.repoId, p)
  }
  return [...mainByRepoId.values()].map((repoPath) => ({ repoPath }))
}

/**
 * Two folder sets from one fleet read:
 *
 * - `live` — a session working or waiting on input with an actually-running PTY.
 *   This is what makes the classifier's verdict `active` (unchanged).
 * - `inUse` — ANY session with a running PTY, idle at its prompt included. The
 *   dehydrate guard (T250) reads this stricter set: an open-but-idle session's
 *   next `npm test` would find its `node_modules` gone, so "no live session"
 *   for a removal means no process at all, not merely no work in flight.
 */
export async function computeFolderSets(): Promise<{ live: Set<string>; inUse: Set<string> }> {
  const taskStates = getTaskStates()
  const running = liveSessionKeys()
  const folders = await getFleetFolders()
  const live = new Set<string>()
  const inUse = new Set<string>()
  for (const folder of folders) {
    for (const session of folder.sessions) {
      if (!running.has(session.sessionId)) continue
      inUse.add(folder.path)
      const state = taskStates.get(session.sessionId)
      if (state === 'working' || state === 'needs-input') {
        live.add(folder.path)
        break
      }
    }
  }
  return { live, inUse }
}

/**
 * Guard 4 of dehydration, probed fresh at execution time (T250). Fails closed:
 * the caller treats a throw as "cannot prove the folder is free".
 */
export async function isFolderInUse(folderPath: string): Promise<boolean> {
  const { live, inUse } = await computeFolderSets()
  return live.has(folderPath) || inUse.has(folderPath)
}

/**
 * The `ephemeral:` and `setup` a repo's manifest resolves to — read through the
 * same `readManifestSources` + `resolveManifest` pair `create_worktree` uses, so
 * what a row discloses is what a rehydrate runs.
 */
export async function readRepoManifest(repoPath: string): Promise<ManifestFacts> {
  const sources = await readManifestSources(repoPath)
  const manifest = resolveManifest(sources, { branch: 'reaper', repo: path.basename(repoPath) })
  return manifestFactsFor(manifest, sources.worktreeMd != null || sources.claudeWorktreeMd != null)
}

// ---- per-repo git probes -----------------------------------------------------

async function listWorktreesRaw(repoPath: string): Promise<WorktreeListEntry[]> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      GIT_OPTS
    )
    return parseWorktreeList(stdout)
  } catch {
    return []
  }
}

async function listLocalBranches(repoPath: string): Promise<LocalBranchRef[]> {
  try {
    const { stdout } = await runFile(
      'git',
      [
        '-C',
        repoPath,
        'for-each-ref',
        'refs/heads',
        '--format',
        '%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(upstream:short)'
      ],
      GIT_OPTS
    )
    return parseForEachRef(stdout)
  } catch {
    return []
  }
}

async function resolveDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      GIT_OPTS
    )
    const short = stdout.trim()
    if (!short) return 'main'
    return short.startsWith('origin/') ? short.slice('origin/'.length) : short
  } catch {
    return 'main'
  }
}

async function listRemoteHeads(repoPath: string): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoPath, 'ls-remote', '--heads', 'origin'],
      GH_OPTS
    )
    return parseLsRemoteHeads(stdout)
  } catch {
    return null
  }
}

interface PrScanFacts {
  prByBranch: Map<string, PrFacts> | null
  ghAvailable: boolean
  prSetComplete: boolean
  prProbedBranches: Set<string>
}

/** One `gh pr list --head <branch>` lookup; returns the raw array, or null when gh failed. */
async function lookupPrForBranch(repoPath: string, branch: string): Promise<unknown[] | null> {
  try {
    const { stdout } = await runFile(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--head',
        branch,
        '--limit',
        '10',
        '--json',
        'headRefName,headRefOid,number,state,mergedAt,reviewDecision,statusCheckRollup'
      ],
      { ...GH_OPTS, cwd: repoPath }
    )
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Resolves PR facts for a repo, honestly.
 *
 * Two rules, both from BUG-74. First, exhaust the list: the old fixed
 * `--limit 100` matched 11 of 143 local branches on the measured corpus, so a
 * branch whose PR merged long ago was simply invisible. Second, when the list
 * *is* capped, say so — `prSetComplete: false` is what stops the classifier
 * reading gh's silence as "there never was a PR". Branches still unresolved
 * after that get an individual lookup, up to {@link GAP_FILL_BUDGET} per scan,
 * and both hits and misses are cached so the same misses are not re-probed on
 * every hourly tick.
 */
async function fetchPrFacts(
  repoPath: string,
  force: boolean,
  cache: GhCacheFile,
  branches: string[]
): Promise<PrScanFacts> {
  const now = Date.now()
  const cached = force ? null : readGhCacheEntry(cache[repoPath], now)

  let prByBranch: Map<string, PrFacts>
  let complete: boolean
  let probed: Set<string>
  let gapFills: Record<string, GhGapFill>
  let rawPrs: unknown
  let bulkFetchedAt: number
  let dirty = false

  if (cached && ghCacheFresh(cached.fetchedAt, now)) {
    prByBranch = cached.prByBranch
    complete = cached.complete
    probed = cached.probed
    gapFills = cached.gapFills
    rawPrs = cache[repoPath]?.prs ?? []
    bulkFetchedAt = cached.fetchedAt
  } else {
    let stdout: string
    try {
      const res = await runFile(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'all',
          '--limit',
          String(PR_LIST_LIMIT),
          '--json',
          'headRefName,headRefOid,number,state,mergedAt,reviewDecision,statusCheckRollup'
        ],
        { ...GH_PR_LIST_OPTS, cwd: repoPath }
      )
      stdout = res.stdout
    } catch {
      // absent / unauthenticated / rate-limited / non-GitHub remote — degrade,
      // and deliberately do not poison the cache so the next scan retries.
      return {
        prByBranch: null,
        ghAvailable: false,
        prSetComplete: false,
        prProbedBranches: new Set()
      }
    }
    const parsedList = parseGhPrListResult(stdout, PR_LIST_LIMIT)
    prByBranch = parsedList.prByBranch
    complete = parsedList.complete
    try {
      rawPrs = JSON.parse(stdout)
    } catch {
      rawPrs = [] // malformed gh output — cache nothing, still report ghAvailable
    }
    // Gap fills survive a bulk refresh — they answer about branches the bulk
    // list never covers, so re-probing them on every TTL rollover is pure waste
    // — but not a forced scan, which is the user's way to clear a stale miss.
    const carried = force ? null : readGhCacheEntry(cache[repoPath], now)
    gapFills = carried?.gapFills ?? {}
    probed = new Set(Object.keys(gapFills))
    mergeGapFills(prByBranch, gapFills)
    bulkFetchedAt = now
    dirty = true
  }

  if (!complete) {
    for (const branch of gapFillCandidates(branches, prByBranch, probed)) {
      const rows = await lookupPrForBranch(repoPath, branch)
      if (rows === null) continue // gh failed for this one — stays honestly unknown
      gapFills[branch] = { probedAt: now, prs: rows }
      probed.add(branch)
      dirty = true
      const found = parseGhPrListResult(JSON.stringify(rows), PR_LIST_LIMIT).prByBranch.get(branch)
      if (found) prByBranch.set(branch, found)
    }
  }

  if (dirty) {
    // Assigned as a new object so `runScan`'s identity check sees the change.
    const entry: GhCacheEntry = {
      version: GH_CACHE_VERSION,
      fetchedAt: bulkFetchedAt,
      prs: rawPrs ?? [],
      complete,
      gapFills
    }
    cache[repoPath] = entry
  }

  return { prByBranch, ghAvailable: true, prSetComplete: complete, prProbedBranches: probed }
}

async function probeStatusUnpushed(
  worktrees: WorktreeListEntry[],
  mainWorktreePath: string
): Promise<{
  statusByPath: Map<string, WorktreeStatus | null>
  unpushedByPath: Map<string, boolean | null>
}> {
  const statusByPath = new Map<string, WorktreeStatus | null>()
  const unpushedByPath = new Map<string, boolean | null>()
  for (const w of worktrees) {
    if (w.bare || w.detached || w.path === mainWorktreePath) continue
    try {
      // BUG-75: the split probe, never `isWorktreeDirty` — an untracked file
      // must not read as a blocker here.
      statusByPath.set(w.path, await probeWorktreeStatus(w.path))
    } catch {
      statusByPath.set(w.path, null)
    }
    try {
      unpushedByPath.set(w.path, await hasUnpushedCommits(w.path))
    } catch {
      unpushedByPath.set(w.path, null)
    }
  }
  return { statusByPath, unpushedByPath }
}

/** `git merge-base --is-ancestor <sha> origin/<default>` → true/false/unknown. */
async function isAncestorOfDefault(
  repoPath: string,
  sha: string,
  defaultBranch: string
): Promise<boolean | null> {
  try {
    await runFile(
      'git',
      ['-C', repoPath, 'merge-base', '--is-ancestor', sha, `origin/${defaultBranch}`],
      GIT_OPTS
    )
    return true
  } catch (err) {
    const code = (err as { code?: number }).code
    return code === 1 ? false : null
  }
}

// ---- squash-equivalence probe (BUG-93, imperative half) ----------------------

/**
 * Runs `git <a> | git <b>` with the two children piped directly to each other,
 * and resolves with the tail's stdout.
 *
 * The pipe is the point: the head of this pipeline is a `git log -p` over up to
 * {@link SQUASH_PROBE_HISTORY} commits, which can be hundreds of megabytes of
 * patch text. Buffering that through Node (as `runFile` would) is what
 * `maxBuffer` exists to refuse; `git patch-id`'s own output is a few kilobytes.
 */
async function runGitPipe(
  head: readonly string[],
  tail: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  const env = await spawnEnvOnce()
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        a.kill()
        b.kill()
      } catch {
        /* already gone */
      }
      resolve(value)
    }
    const a = spawn('git', [...head], { env, windowsHide: true })
    const b = spawn('git', [...tail], { env, windowsHide: true })
    const timer = setTimeout(() => finish(null), timeoutMs)
    let out = ''
    // An early `patch-id` exit closes its stdin, so the producer's writes EPIPE.
    // That is an ordinary end of the pipeline, not a failure to report.
    a.on('error', () => finish(null))
    b.on('error', () => finish(null))
    a.stdout.on('error', () => undefined)
    b.stdin.on('error', () => undefined)
    a.stdout.pipe(b.stdin)
    b.stdout.setEncoding('utf8')
    b.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    b.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/** The probe's own budget; the history walk is the expensive half. */
const SQUASH_HISTORY_TIMEOUT_MS = 120_000
const SQUASH_BRANCH_TIMEOUT_MS = 30_000

/**
 * Memoized on `(repoPath, branch tip, default-branch tip)` — the two shas fully
 * determine the answer, and both are already in hand from `for-each-ref` and
 * `rev-parse`. Without this an hourly background scan re-derives the same
 * verdict for every unchanged branch, forever.
 */
const squashProbeCache = new Map<string, boolean>()
/** Bounded so a long-lived app with many repos cannot grow it without limit. */
const SQUASH_CACHE_MAX = 4000

function squashCacheKey(repoPath: string, branchSha: string, defaultSha: string): string {
  return `${repoPath}\u0000${branchSha}\u0000${defaultSha}`
}

async function revParse(repoPath: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await runFile('git', ['-C', repoPath, 'rev-parse', rev], GIT_OPTS)
    const sha = stdout.trim()
    return sha ? sha : null
  } catch {
    return null
  }
}

/**
 * Patch-id containment for the branches that still lack a merge signal.
 *
 * Reads nothing but diffs and writes no git objects — see
 * {@link squashHistoryArgv} for why that constraint exists and why the spec's
 * `git commit-tree` recipe was not used.
 *
 * Runs only for *candidates*: a branch already proven an ancestor, or already
 * carrying a merged PR, has its answer and does not need a second one. In the
 * degraded case this card exists for — no gh at all — nothing is filtered out,
 * which is exactly when the probe is the only containment evidence there is.
 */
async function probeSquashEquivalence(
  repoPath: string,
  defaultBranch: string,
  candidates: LocalBranchRef[]
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>()
  if (candidates.length === 0) return out

  const defaultSha = await revParse(repoPath, `origin/${defaultBranch}`)
  if (defaultSha === null) return out // no resolvable default branch — nothing to compare against

  const unmemoized: LocalBranchRef[] = []
  for (const ref of candidates) {
    const cached = squashProbeCache.get(squashCacheKey(repoPath, ref.sha, defaultSha))
    if (cached === undefined) unmemoized.push(ref)
    else out.set(ref.branch, cached)
  }
  if (unmemoized.length === 0) return out

  const historyArgv = squashHistoryArgv(repoPath, defaultBranch)
  const historyOut = await runGitPipe(
    historyArgv.log,
    historyArgv.patchId,
    SQUASH_HISTORY_TIMEOUT_MS
  )
  if (historyOut === null) return out // probe unavailable — every candidate stays null
  const history = parsePatchIdSet(historyOut)

  for (const ref of unmemoized) {
    const argv = squashBranchArgv(repoPath, defaultBranch, ref.branch)
    const branchOut = await runGitPipe(argv.diff, argv.patchId, SQUASH_BRANCH_TIMEOUT_MS)
    if (branchOut === null) {
      out.set(ref.branch, null) // this one failed; say so rather than claim a negative
      continue
    }
    const contained = isPatchIdContained(branchOut, history)
    out.set(ref.branch, contained)
    if (squashProbeCache.size >= SQUASH_CACHE_MAX) squashProbeCache.clear()
    squashProbeCache.set(squashCacheKey(repoPath, ref.sha, defaultSha), contained)
  }
  return out
}

/**
 * Commit date (ms since epoch) keyed by sha, for detached worktrees only — a
 * detached HEAD has no branch ref, so `for-each-ref` (which dates every other
 * row) has nothing to key on and the row would ship with a blank age. One
 * `git show -s` per detached entry; a sha that cannot be read degrades to
 * `null`, which the row already renders as an unknown age.
 */
async function probeCommitDates(
  repoPath: string,
  shas: string[]
): Promise<Map<string, number | null>> {
  const bySha = new Map<string, number | null>()
  for (const sha of shas) {
    if (!sha || bySha.has(sha)) continue
    try {
      const { stdout } = await runFile(
        'git',
        ['-C', repoPath, 'show', '-s', '--format=%ct', sha],
        GIT_OPTS
      )
      const secs = Number.parseInt(stdout.trim(), 10)
      bySha.set(sha, Number.isFinite(secs) ? secs * 1000 : null)
    } catch {
      bySha.set(sha, null)
    }
  }
  return bySha
}

interface PendingHydration {
  record: HydrationRecord | undefined
  entries: EphemeralEntryFacts[]
  plan: DehydratePlan
  stillChanged: string[]
  /** Set by `deriveInto`: the record says dehydrated but a removed path is back. */
  stale: boolean
}

/**
 * Hydration facts for one worktree row (T250). The git guards are skipped for a
 * folder in use — the plan skips every present entry as `session-live` without
 * them — but `lstat` still runs so the plan can name what it skipped.
 */
async function probeHydration(
  item: ReapItem,
  manifest: ManifestFacts,
  record: HydrationRecord | undefined,
  inUse: boolean
): Promise<PendingHydration> {
  const worktree = item.path!
  const listed = manifest.ephemeral
    .map(normalizeEphemeralEntry)
    .filter((p): p is string => p !== null)
  // The record's removed paths are probed too: a path dropped from `ephemeral:`
  // since it was removed must still be seen coming back.
  const probePaths = [...new Set([...listed, ...(record?.removed ?? [])])]
  const sessionLive = inUse || item.verdict === 'active'
  let entries: EphemeralEntryFacts[]
  try {
    entries = await probeEphemeralEntries(reaperExec, worktree, probePaths, { git: !sessionLive })
  } catch {
    entries = probePaths.map((p) => ({
      path: p,
      presence: 'unreadable',
      contained: false,
      ignored: null,
      tracked: null
    }))
  }
  let stillChanged = record?.rehydrateChanged ?? []
  if (stillChanged.length > 0) {
    try {
      stillChanged = await stillModified(reaperExec, worktree, stillChanged)
    } catch {
      // keep the disclosure rather than drop it on a failed probe
    }
  }
  return {
    record,
    entries,
    plan: planDehydrate({ sessionLive, ephemeral: manifest.ephemeral, entries }),
    stillChanged,
    stale: false
  }
}

async function scanOneRepo(
  repoPath: string,
  opts: {
    force: boolean
    hiddenPaths: string[]
    liveFolders: Set<string>
    inUseFolders: Set<string>
    hydrationFile: HydrationRecordFile
    protectedBranches: string[]
    /** Receives the facts and local tip each worktree item was judged on (workspace GC). */
    fateSink: Map<string, FateInput>
  },
  ghCache: GhCacheFile,
  now: number
): Promise<ReaperSnapshot['repos'][number]> {
  const worktrees = await listWorktreesRaw(repoPath)
  const localBranches = await listLocalBranches(repoPath)
  const defaultBranch = await resolveDefaultBranch(repoPath)
  const remoteHeads = await listRemoteHeads(repoPath)
  // Only branches this scan will actually classify are worth a gap-fill lookup:
  // the protected ones never produce an item, so probing them would spend the
  // budget on rows nobody sees.
  // Branches with a checkout come first: they are the rows carrying disk and the
  // ones a sweep can actually reclaim, so a spent budget should land there.
  const protectedSet = new Set([defaultBranch, ...opts.protectedBranches])
  const checkedOut = new Set(
    worktrees.filter((w) => !w.bare && !w.detached && w.branch).map((w) => w.branch)
  )
  const gapCandidates = localBranches
    .map((r) => r.branch)
    .filter((b) => !protectedSet.has(b))
    .sort((a, b) => Number(checkedOut.has(b)) - Number(checkedOut.has(a)))
  const { prByBranch, ghAvailable, prSetComplete, prProbedBranches } = await fetchPrFacts(
    repoPath,
    opts.force,
    ghCache,
    gapCandidates
  )
  const { statusByPath, unpushedByPath } = await probeStatusUnpushed(worktrees, repoPath)

  const ancestorByBranch = new Map<string, boolean | null>()
  for (const ref of localBranches) {
    ancestorByBranch.set(ref.branch, await isAncestorOfDefault(repoPath, ref.sha, defaultBranch))
  }

  // Only branches with no containment answer yet are worth the probe: an ancestor
  // is already proven, and a merged PR already justifies the sweep. Protected
  // branches never produce an item at all.
  const squashCandidates = localBranches.filter(
    (ref) =>
      !protectedSet.has(ref.branch) &&
      ancestorByBranch.get(ref.branch) !== true &&
      prByBranch?.get(ref.branch)?.state !== 'MERGED'
  )
  const patchIdContainedByBranch = await probeSquashEquivalence(
    repoPath,
    defaultBranch,
    squashCandidates
  )

  const commitDateBySha = await probeCommitDates(
    repoPath,
    worktrees.filter((w) => !w.bare && (w.detached || !w.branch)).map((w) => w.head)
  )

  const items = buildRepoItems({
    repoPath,
    defaultBranch,
    protectedBranches: opts.protectedBranches,
    worktrees,
    mainWorktreePath: repoPath,
    localBranches,
    remoteHeads,
    prByBranch,
    ghAvailable,
    prSetComplete,
    prProbedBranches,
    hiddenPaths: opts.hiddenPaths,
    liveFolders: opts.liveFolders,
    statusByPath,
    unpushedByPath,
    ancestorByBranch,
    patchIdContainedByBranch,
    commitDateBySha,
    collectFateInput: (id, input) => opts.fateSink.set(id, input),
    now
  })

  // T250 — hydration. A manifest that cannot be read yields an EMPTY ephemeral
  // list, not the default one: the manifest may have narrowed the default on
  // purpose, and "could not read the rules" must never widen what is removable.
  let manifest: ManifestFacts
  try {
    manifest = await readRepoManifest(repoPath)
  } catch {
    manifest = { ephemeral: [], setup: [] }
  }
  const pending = new Map<string, PendingHydration>()
  for (const item of items) {
    if (!isHydratableKind(item.kind) || !item.path) continue
    pending.set(
      item.id,
      await probeHydration(
        item,
        manifest,
        opts.hydrationFile.worktrees[item.path],
        opts.inUseFolders.has(item.path)
      )
    )
  }

  // Every folder row is measured now, not just the harvestable ones: Dehydrate
  // is offered on `blocked` rows, and its whole case is the number (AC-6). The
  // removable children are measured inside the same `du` traversal. A row whose
  // folder is in use renders nothing, so it is not worth a traversal.
  const measurable = items.filter(
    (i) =>
      i.path && i.verdict !== 'active' && (isHydratableKind(i.kind) || i.kind === 'hidden-folder')
  )
  await mapLimit(measurable, MEASURE_CONCURRENCY, async (item) => {
    const removable = pending.get(item.id)?.plan.removable ?? []
    const measure = await measureFolder(reaperExec, item.path!, removable, now)
    item.diskBytes = measure.total
    const hydration = pending.get(item.id)
    if (!hydration) return
    const sizes = removable.map((r) => measure.byChild.get(r) ?? null)
    const reclaimable = sizes.some((s) => s === null)
      ? null
      : sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0)
    deriveInto(item, hydration, manifest, reclaimable)
  })
  // Rows not measured (in use) still get their hydration, with no figure.
  for (const item of items) {
    const hydration = pending.get(item.id)
    if (hydration && item.hydration === null) deriveInto(item, hydration, manifest, null)
  }

  // A fingerprint of the uncommitted work, for the force path to compare against. A probe that
  // cannot answer is recorded as "unknown", never as "no work", so the force path says so instead
  // of comparing a live value against nothing.
  await mapLimit(items.filter(needsWorkStamp), MEASURE_CONCURRENCY, async (item) => {
    item.workStamp = await scanWorkStamp(reaperExec, item.path!)
  })

  const reconcile = [...pending.entries()].flatMap(([id, h]) => {
    const item = items.find((i) => i.id === id)
    if (!item?.path || !h.record) return []
    const changedShrank = h.stillChanged.length !== h.record.rehydrateChanged.length
    return h.stale || changedShrank
      ? [{ path: item.path, dehydrationStale: h.stale, stillChanged: h.stillChanged }]
      : []
  })
  if (reconcile.length > 0) {
    await updateHydrationFile((file) =>
      reconcile.reduce((f, r) => withReconciled(f, r.path, r), file)
    ).catch((err) => console.warn('[reaper] failed to reconcile hydration records', err))
  }

  return { repoPath, items }
}

function deriveInto(
  item: ReapItem,
  hydration: PendingHydration,
  manifest: ManifestFacts,
  reclaimableBytes: number | null
): void {
  const { info, dehydrationStale } = deriveHydration({
    record: hydration.record,
    entries: hydration.entries,
    plan: hydration.plan,
    canRehydrate: manifest.setup.length > 0,
    stillChanged: hydration.stillChanged,
    reclaimableBytes
  })
  item.hydration = info
  hydration.stale = dehydrationStale
}

// ---- snapshot memoization + single-flight ------------------------------------

let cachedSnapshot: ReaperSnapshot | null = null
/** What each worktree item was judged on, per repo, kept in step with `cachedSnapshot`. */
let cachedFate = new Map<string, Map<string, FateInput>>()
let inflight: Promise<ReaperSnapshot> | null = null

/** The last computed snapshot, or `null` before the first scan. */
export function lastSnapshot(): ReaperSnapshot | null {
  return cachedSnapshot
}

/**
 * The facts and the real checked-out commit behind every worktree item of the last scan, by
 * item id. The workspace GC resolves branch fate from these, so a strong-merge proof is
 * checked against the commit the worktree really has.
 */
export function lastFateInputs(): Map<string, FateInput> {
  const out = new Map<string, FateInput>()
  for (const repo of cachedFate.values()) for (const [id, input] of repo) out.set(id, input)
  return out
}

/** Every worktree path of the given repos (main checkout and linked, bare excluded). */
/** Paths of the worktrees git lists as locked, across the repos. */
export async function listLockedWorktreePaths(repoPaths: readonly string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const repoPath of repoPaths) {
    for (const w of await listWorktreesRaw(repoPath)) if (!w.bare && w.locked) out.add(w.path)
  }
  return [...out]
}

export async function listAllWorktreePaths(repoPaths: readonly string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const repoPath of repoPaths) {
    for (const w of await listWorktreesRaw(repoPath)) if (!w.bare) out.add(w.path)
  }
  return [...out]
}

async function runScan(opts: ScanOptions): Promise<ReaperSnapshot> {
  const now = Date.now()
  const [userProjects, folderSets, allRepos, hydrationFile] = await Promise.all([
    readUserProjects(),
    computeFolderSets(),
    discoverRepos(),
    readHydrationFile()
  ])
  const liveFolders = folderSets.live
  const hiddenPaths = userProjects.hiddenPaths ?? []
  const wantedPaths = opts.repoPaths
  const targets = wantedPaths?.length
    ? allRepos.filter((r) => wantedPaths.includes(r.repoPath))
    : allRepos

  const ghCache = await readGhCache()
  let cacheDirty = false
  const freshRepos: ReaperSnapshot['repos'] = []
  const freshFate = new Map<string, Map<string, FateInput>>()
  // Serialized: one repo at a time, git commands within a repo sequential.
  for (const target of targets) {
    const before = ghCache[target.repoPath]
    const fateSink = new Map<string, FateInput>()
    freshFate.set(target.repoPath, fateSink)
    const result = await scanOneRepo(
      target.repoPath,
      {
        force: opts.force === true,
        hiddenPaths,
        liveFolders,
        inUseFolders: folderSets.inUse,
        hydrationFile,
        protectedBranches: opts.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
        fateSink
      },
      ghCache,
      now
    )
    if (ghCache[target.repoPath] !== before) cacheDirty = true
    freshRepos.push(result)
  }
  if (cacheDirty) await writeGhCache(ghCache)

  // A scoped rescan (repoPaths given) merges into the last full snapshot, so
  // untouched repos keep their prior classification instead of vanishing.
  if (wantedPaths?.length && cachedSnapshot) {
    const byRepo = new Map(cachedSnapshot.repos.map((r) => [r.repoPath, r]))
    for (const r of freshRepos) byRepo.set(r.repoPath, r)
    cachedSnapshot = { scannedAt: now, repos: [...byRepo.values()] }
    for (const [repo, sink] of freshFate) cachedFate.set(repo, sink)
  } else {
    cachedSnapshot = { scannedAt: now, repos: freshRepos }
    cachedFate = freshFate
  }
  return cachedSnapshot
}

/**
 * Resolves once no scan is in flight. A dehydrate or rehydrate waits on this
 * before it touches a tree, so a `du` never walks a directory mid-removal — the
 * failure mode there is a wrong number rather than a crash, which is worse
 * (spec, "Open questions" — decided here: serialize).
 */
export async function scanIdle(): Promise<void> {
  const current = inflight
  if (current)
    await current.then(
      () => undefined,
      () => undefined
    )
}

/** Scan every known repo (or just `opts.repoPaths`), single-flighted. */
export async function scanAll(opts: ScanOptions = {}): Promise<ReaperSnapshot> {
  if (inflight) return inflight
  inflight = runScan(opts).finally(() => {
    inflight = null
  })
  return inflight
}
