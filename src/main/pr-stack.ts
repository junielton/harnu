/**
 * T198 — PR Stack Canvas: the imperative shell.
 *
 * Gathers the real `gh`/`git` state for ONE repo and hands it to the pure
 * `pr-stack-core` to assemble the merge graph. No decision logic lives here:
 * which PR is a staging tip, which is merge-next, and where a card sits are
 * all decided in the core.
 *
 * env-bound (`child_process` + electron `ipcMain`) ⇒ e2e-only per ADR-0001;
 * the logic surface is unit-tested in `tests/pr-stack-core.test.ts`.
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { spawnEnvOnce } from './appimage-env'
import { isOpenPrViewJson, matchPrLinkToRemote } from './github-remote'
import { readPrefs, writePrefs, type PrStackPrefs } from './pr-stack-prefs'
import { GH_PR_LIST_OPTS } from './reaper/scan-core'
import {
  parsePrList,
  buildGraph,
  layoutGraph,
  graphEdges,
  kpis,
  shapeKey,
  parseReviewThreads,
  withReviewThreads,
  PR_LIST_LIMIT,
  REVIEW_THREADS_QUERY,
  behindBaseRef,
  parseBehindCount,
  classifyGhFailure,
  type GhFailure,
  type PrEntry,
  type PrGraph,
  type PrStackSnapshot,
  type PrThreadCounts,
  type WorktreeNode
} from './pr-stack-core'

export type { PrStackSnapshot }

const execFileAsync = promisify(execFile)

/**
 * Every subprocess on this path goes through here so it is spawned with the
 * user's login-shell PATH (BUG-34). A Dock-launched macOS build inherits
 * launchd's minimal PATH, which has no `/opt/homebrew/bin` — bare `gh` is then
 * ENOENT and the canvas reports "GitHub CLI is unavailable here" to a user
 * whose `gh` is installed and authenticated.
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

const GIT_OPTS = { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 } as const
/** Budget for the small `gh api graphql` thread query. The PR list uses `GH_PR_LIST_OPTS`. */
const GH_OPTS = { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 22 } as const

/**
 * The fields the canvas needs. `baseRefName` is the one that matters — it is
 * the entire DAG, and the only reason this query differs in kind from the one
 * the Reaper already runs.
 *
 * The second block is T280's widening: every remaining signal the card row
 * wants, asked for ONCE. Appending a name here costs no extra round trip and
 * no extra rate-limit point (spec §3.1), so the query is deliberately wider
 * than what is drawn today — the render units that consume these fields land
 * afterwards, against a `PrEntry` that already carries them.
 */
const GH_FIELDS = [
  'number',
  'title',
  'headRefName',
  'baseRefName',
  'state',
  'isDraft',
  'mergeable',
  'reviewDecision',
  'statusCheckRollup',
  'url',
  'author',
  'updatedAt',
  'mergeStateStatus',
  'additions',
  'deletions',
  'changedFiles',
  'reviewRequests',
  'labels',
  'autoMergeRequest'
].join(',')

/** Resolves the repo's default branch, falling back to `main`. */
async function defaultBranchOf(repoPath: string): Promise<string> {
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

/** One `gh pr list` answer: the PRs, whether `gh` is usable, and why a usable one failed. */
type PrFetch = { prs: PrEntry[]; ghAvailable: boolean; ghFailure: GhFailure | null }

/**
 * `ghAvailable: false` is reserved for "gh genuinely cannot be used here" (no
 * binary, no login, not a GitHub remote). A slow or failed answer from a usable
 * `gh` is `ghFailure` instead: the caller must treat `prs: []` there as "unknown",
 * not "no PRs" (BUG-148). Sized with the Reaper's bulk-list budget, which the
 * old 15s / 4 MiB one could not survive.
 */
async function fetchPrs(repoPath: string): Promise<PrFetch> {
  try {
    const { stdout } = await runFile(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', GH_FIELDS],
      { ...GH_PR_LIST_OPTS, cwd: repoPath }
    )
    return { prs: parsePrList(stdout), ghAvailable: true, ghFailure: null }
  } catch (err) {
    // Degrade to an empty result rather than an error dialog; the snapshot
    // carries WHY so the store can keep the last good canvas.
    const failure = classifyGhFailure(err)
    return { prs: [], ghAvailable: failure !== null, ghFailure: failure }
  }
}

/** How long one `gh pr list` serves the mission reads of a repo (Mission v3 §3.8). */
const PR_CACHE_TTL_MS = 60_000

/** Per repo root: the fetch in flight, or the last good one and when it landed. */
const prCache = new Map<string, { settledAt: number | null; result: Promise<PrFetch> }>()

/**
 * Mission v3 §3.8 — {@link fetchPrs} for the mission reads: a single-flight
 * promise per repo root, kept {@link PR_CACHE_TTL_MS} after it lands. Every
 * `mission_get`, every `mission:list` derive and every door re-derive (MCP and
 * IPC run in this one main process) share it, so a list pass over a repo's
 * missions costs one `gh` round trip, not one per mission. A failure is not
 * kept: the next read retries. The canvas keeps its own fresh fetch.
 */
function fetchPrsCached(repoPath: string): Promise<PrFetch> {
  const key = path.resolve(repoPath)
  const hit = prCache.get(key)
  if (hit && (hit.settledAt === null || Date.now() - hit.settledAt < PR_CACHE_TTL_MS)) {
    return hit.result
  }
  const entry = { settledAt: null as number | null, result: fetchPrs(key) }
  prCache.set(key, entry)
  void entry.result.then((r) => {
    if (prCache.get(key) !== entry) return
    if (r.ghAvailable && r.ghFailure === null) entry.settledAt = Date.now()
    else prCache.delete(key)
  })
  return entry.result
}

/** `pending`, or the "gh could not answer in time" result once `ms` elapses. */
async function withinBudget(pending: Promise<PrFetch>, ms: number | undefined): Promise<PrFetch> {
  if (ms === undefined) return pending
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<PrFetch>((resolve) => {
    timer = setTimeout(() => resolve({ prs: [], ghAvailable: false, ghFailure: null }), ms)
  })
  try {
    return await Promise.race([pending, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * T275 — unresolved review threads for every open PR, in ONE `gh api graphql`
 * call (1 rate-limit point for the whole repo — see `REVIEW_THREADS_QUERY`).
 * `gh pr list --json` has no field for thread resolution; it exists only on
 * GraphQL's `reviewThreads`.
 *
 * Degrades exactly like {@link fetchPrs}: a missing or unauthenticated `gh`, a
 * spent rate limit, or a non-GitHub remote (the `{owner}`/`{repo}` placeholders
 * then fail to resolve) is `null` — no thread data, an unchanged canvas — and
 * never a throw.
 */
async function fetchReviewThreads(repoPath: string): Promise<Map<number, PrThreadCounts> | null> {
  try {
    const { stdout } = await runFile(
      'gh',
      [
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'name={repo}',
        '-f',
        `query=${REVIEW_THREADS_QUERY}`
      ],
      { ...GH_OPTS, cwd: repoPath }
    )
    return parseReviewThreads(stdout)
  } catch {
    return null
  }
}

/**
 * How many commits each PR branch is behind its base — the "4 behind" chip's
 * magnitude. Best-effort and individually guarded.
 *
 * A measured `0` IS recorded (T274): it is the only evidence the card has for
 * "up to date". A branch that is not fetched locally has no key at all, which
 * the card reads as "could not measure locally" — never as zero. Whether the
 * chip shows at all is decided with GitHub's `mergeStateStatus`
 * (`prBehindState()` in `pr-stack-format.ts`); this count only enriches it.
 * The yardstick is the PR's own base (`behindBaseRef()`), and both it and the
 * parse (`parseBehindCount()`) are unit-tested in `pr-stack-core`.
 */
async function behindCounts(repoPath: string, graph: PrGraph): Promise<Record<number, number>> {
  const out: Record<number, number> = {}
  await Promise.all(
    graph.nodes.map(async (node) => {
      const base = behindBaseRef(node, graph.defaultBranch)
      try {
        const { stdout } = await runFile(
          'git',
          ['-C', repoPath, 'rev-list', '--count', `${node.pr.branch}..${base}`],
          GIT_OPTS
        )
        const n = parseBehindCount(stdout)
        if (n !== null) out[node.pr.number] = n
      } catch {
        /* branch not present locally — no count, and that is not an error */
      }
    })
  )
  return out
}

/**
 * Builds the snapshot for one repo.
 *
 * `worktrees` is supplied by the caller (the Reaper snapshot already knows
 * every worktree and its {@link import('./reaper/reaper-core').ReapVerdict}),
 * so the verdict is never recomputed here — the canvas and the Cleanup view
 * must never disagree about whether a worktree is done with.
 */
export async function loadPrStack(
  repoPath: string,
  worktrees: WorktreeNode[] = []
): Promise<PrStackSnapshot> {
  // Started first and awaited last: the thread query overlaps the branch
  // probe, `gh pr list` and the behind fan-out instead of queueing after them,
  // so it costs a refresh no extra wall-clock beyond its own round trip.
  const threadsPending = fetchReviewThreads(repoPath)
  const defaultBranch = await defaultBranchOf(repoPath)
  const { prs, ghAvailable, ghFailure } = await fetchPrs(repoPath)
  const topology = buildGraph(prs, defaultBranch)
  const { placements, width, height } = layoutGraph(topology)
  const [behind, threads] = await Promise.all([behindCounts(repoPath, topology), threadsPending])
  const graph = withReviewThreads(topology, threads)

  return {
    repoPath,
    defaultBranch,
    graph,
    placements,
    edges: graphEdges(graph, worktrees),
    // A harvestable worktree leaves the graph for the tray; live ones stay.
    worktrees,
    kpis: kpis(graph),
    world: { width, height },
    shape: shapeKey(graph),
    fetchedAt: Date.now(),
    ghAvailable,
    ghFailure,
    behind
  }
}

/** A linked worktree's git state plus the PRs whose head is its branch (T358 S6). */
export interface WorktreePrJoin {
  exists: boolean
  /** `null` for a detached HEAD or a path git cannot read. */
  branch: string | null
  head: { sha: string; subject: string; at: string } | null
  prs: PrEntry[]
}

/** {@link findPrsForWorktrees}'s answer, keyed by the refs it was asked about. */
export interface MissionPrJoin {
  /** `null` when nothing needed `gh` (it was never called); `false` when it is absent or failed. */
  ghAvailable: boolean | null
  worktrees: Record<string, WorktreePrJoin>
  branches: Record<string, PrEntry[]>
  /** `null` for a number not in the repo's recent PRs (or when `gh` is unavailable). */
  numbers: Record<number, PrEntry | null>
}

/** Branch + head commit of one worktree path; `exists: false` when git cannot read it. */
async function worktreeHead(worktreePath: string): Promise<Omit<WorktreePrJoin, 'prs'>> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', worktreePath, 'log', '-1', '--format=%H%x00%s%x00%cI'],
      GIT_OPTS
    )
    const [sha = '', subject = '', at = ''] = stdout.trim().split('\u0000')
    let branch: string | null = null
    try {
      const ref = await runFile(
        'git',
        ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        GIT_OPTS
      )
      const name = ref.stdout.trim()
      branch = name && name !== 'HEAD' ? name : null
    } catch {
      /* unborn or unreadable HEAD — no branch to join on */
    }
    return { exists: true, branch, head: sha ? { sha, subject, at } : null }
  } catch {
    return { exists: false, branch: null, head: null }
  }
}

/**
 * T358 S6 — the one join `mission_get` reads commits and PRs through (design
 * §7): each linked worktree → its branch, head commit and the PRs whose head is
 * that branch; plus bare branches (a card's `executedIn`) and PR numbers (a
 * `pr` link). The same `gh pr list` the canvas runs ({@link fetchPrs}), asked
 * ONCE for the repo, so a mission with many links costs one round trip — and,
 * through {@link fetchPrsCached}, shared for 60 s by every mission of that repo.
 *
 * Degrades like the canvas: `gh` absent or failing is `ghAvailable: false` with
 * empty PR lists, never a throw. `gh` is not called at all when no ref needs it.
 * A PR number is looked up among the repo's {@link PR_LIST_LIMIT} most recent.
 *
 * `waitMs` bounds how long THIS call waits for `gh` (a door's re-derive): past
 * it the answer is `ghAvailable: false` — the mission reads its sticky
 * last-known states — while the fetch runs on and lands in the cache.
 */
export async function findPrsForWorktrees(
  repoPath: string,
  refs: { worktrees: readonly string[]; branches: readonly string[]; numbers: readonly number[] },
  opts: { waitMs?: number } = {}
): Promise<MissionPrJoin> {
  const heads = await Promise.all(refs.worktrees.map(worktreeHead))
  const wanted = new Set([...refs.branches, ...heads.flatMap((h) => (h.branch ? [h.branch] : []))])
  const needsGh = wanted.size > 0 || refs.numbers.length > 0
  const fetched = needsGh ? await withinBudget(fetchPrsCached(repoPath), opts.waitMs) : null
  const prs = fetched?.prs ?? []
  // A transient failure is "absent or failed" here too: this join has no
  // previous snapshot to fall back on, so it reports what it could not read.
  const ghAvailable = fetched ? fetched.ghAvailable && fetched.ghFailure === null : null
  const onBranch = (branch: string | null): PrEntry[] =>
    branch ? prs.filter((p) => p.branch === branch) : []
  const worktrees: Record<string, WorktreePrJoin> = {}
  refs.worktrees.forEach((wt, i) => {
    worktrees[wt] = { ...heads[i], prs: onBranch(heads[i].branch) }
  })
  const branches: Record<string, PrEntry[]> = {}
  for (const b of refs.branches) branches[b] = onBranch(b)
  const numbers: Record<number, PrEntry | null> = {}
  for (const n of refs.numbers) numbers[n] = prs.find((p) => p.number === n) ?? null
  return { ghAvailable, worktrees, branches, numbers }
}

/** A `gh`/`git` round-trip for a link click must not stall the click for long. */
const LINK_OPTS = { windowsHide: true, timeout: 5_000, maxBuffer: 1 << 20 } as const

/**
 * Option+click on a PR link in a transcript: the PR number when `url` is an
 * OPEN pull request of this folder's own repo, else `null` (the renderer then
 * falls back to the browser). Never rejects — a missing or unauthenticated
 * `gh`, a timeout or any other error is simply "not resolvable".
 */
async function resolvePrLink(
  folderPath: unknown,
  url: unknown
): Promise<{ prNumber: number } | null> {
  if (typeof folderPath !== 'string' || !folderPath || typeof url !== 'string') return null
  try {
    const { stdout: remote } = await runFile(
      'git',
      ['-C', folderPath, 'remote', 'get-url', 'origin'],
      LINK_OPTS
    )
    const prNumber = matchPrLinkToRemote(remote, url)
    if (prNumber === null) return null
    const { stdout } = await runFile('gh', ['pr', 'view', String(prNumber), '--json', 'state'], {
      ...LINK_OPTS,
      cwd: folderPath
    })
    return isOpenPrViewJson(stdout) ? { prNumber } : null
  } catch {
    return null
  }
}

/** Registers the renderer-facing channels. Called once from `src/main/index.ts`. */
export function registerPrStack(): void {
  ipcMain.handle(
    'pr-stack:load',
    async (_e, repoPath: string, worktrees?: WorktreeNode[]): Promise<PrStackSnapshot> =>
      loadPrStack(repoPath, Array.isArray(worktrees) ? worktrees : [])
  )
  ipcMain.handle('pr-stack:resolveLink', (_e, folderPath: unknown, url: unknown) =>
    resolvePrLink(folderPath, url)
  )
  // Whole-object GET/PUT, same contract shape as the Reaper's prefs verbs —
  // the normalization on the way in is what makes a corrupt file harmless.
  ipcMain.handle('pr-stack:prefs', async (): Promise<PrStackPrefs> => readPrefs())
  ipcMain.handle('pr-stack:setPrefs', async (_e, raw: unknown): Promise<PrStackPrefs> =>
    writePrefs(raw)
  )
}
