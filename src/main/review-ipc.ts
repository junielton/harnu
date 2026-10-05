/**
 * T164 U2 — Review pane: the imperative shell.
 *
 * Runs the real `git`/`gh` for ONE branch and hands the stdout to the pure
 * `review-core` to become a diff plus an evidence header. No decision logic
 * lives here: what counts as a discrepancy, what a contract flag means and
 * which paths are sensitive are all decided in the core.
 *
 * Two things this shell guarantees, both from PRD AC4:
 *
 *  - **Nothing throws.** Every git/gh call degrades to `null`, and `null` is a
 *    legitimate answer (no repo, no remote, no `gh`, no auth) rather than an
 *    error to surface.
 *  - **Git-only is first-class.** A repo with no remote produces a complete
 *    snapshot with `pr.applicable === false`, not a partial one.
 *
 * It also owns the per-repo blast-radius list. That file mirrors
 * `routing-policy.ts` deliberately: same `<userData>` JSON shape, same
 * {@link folderKey}, and the same security posture — **no MCP verb reads or
 * writes it**. The operator's never-delegate list must not be legible to the
 * agents it is meant to constrain, so the only writers are the human-facing IPC
 * handlers registered here.
 *
 * env-bound (`child_process` + electron `ipcMain` + `<userData>` fs) ⇒ e2e-only
 * per ADR-0001; every decision is unit-tested in `tests/review-core.test.ts`.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { spawnEnvOnce } from './appimage-env'
import { folderKey } from './claude-config'
import { ghCacheFresh } from './reaper/scan-core'
import { parsePrList } from './pr-stack-core'
import {
  annotateWordDiffs,
  assembleEvidence,
  countDiffRows,
  parseUnifiedDiff,
  truncateDiff,
  type DiffFile,
  type ReviewEvidence,
  type SessionEndState
} from './review-core'
import {
  localHeadState,
  mainWorktreeFrom,
  resolveCommit,
  resolvePrBase,
  resolvePrHead,
  type GitRun,
  type ReviewHead
} from './review-head'
import { checkSubmittable, type ReviewVerdict, type SubmitRefusal } from './review-submit-core'
import {
  planPendingPushes,
  resolveViewed,
  resolveViewedFiles,
  type RemoteViewedState,
  type ViewedState
} from './review-viewed'
import {
  cachedRemoteStates,
  fetchRemoteViewed,
  getFolderMarks,
  pushViewed,
  putFolderMark
} from './review-viewed-store'

const execFileAsync = promisify(execFile)

/**
 * Every subprocess on this path goes through here so it is spawned with the
 * user's login-shell PATH (BUG-34). A Dock-launched macOS build inherits
 * launchd's minimal PATH — no `/opt/homebrew/bin` — so bare `gh` is ENOENT and
 * the pane falls back to git-only evidence on a machine where `gh` is
 * installed and authenticated.
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

const GIT_TIMEOUT_MS = 20_000
/** `git fetch` is the one call on this path that crosses the network. */
const GIT_FETCH_TIMEOUT_MS = 60_000
/** A branch-wide diff is the biggest string this app ever reads from git. */
const GIT_MAX_BUFFER = 64 << 20
const GH_TIMEOUT_MS = 15_000
const GH_MAX_BUFFER = 1 << 22

/** Rendered rows past which whole files are dropped and the pane says so. */
const DEFAULT_MAX_ROWS = 60_000
/** Rows past which word-level annotation is skipped (see `annotateWordDiffs`). */
const WORD_DIFF_ROW_BUDGET = 20_000

/** Fields the evidence header needs; a subset of what the PR Stack asks for. */
const GH_FIELDS = [
  'number',
  // T243 — the PR's GraphQL NODE id, which is what every mutation on a pull
  // request takes (`markFileAsViewed`'s `pullRequestId` is not the number).
  // It rides this same already-cached call, so having it costs nothing.
  'id',
  'title',
  'headRefName',
  // T246 — the PR's current head SHA. Rides the SAME already-cached call, so
  // "is what I am reading still the head?" costs nothing extra and is answered
  // as a boolean instead of as an age.
  'headRefOid',
  'baseRefName',
  'state',
  'isDraft',
  'mergeable',
  'reviewDecision',
  'statusCheckRollup',
  'url',
  'author',
  'updatedAt'
].join(',')

/** Run a git command in `cwd`; returns stdout, or `null` on ANY failure. */
async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      // A `fetch` is the one call here that legitimately goes to the network,
      // and a 20 s cap on it turns a slow connection into "the fetch failed".
      timeout:
        args[0] === 'fetch' || args.includes('fetch') ? GIT_FETCH_TIMEOUT_MS : GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * Run `gh` in `cwd` with `stdin` piped in, and report the exit code honestly.
 *
 * Deliberately NOT `runFile`/`promisify`: the promisified form gives no handle
 * on the child's stdin, and this is the one call in the module whose payload
 * must not be an argument. Unlike every other spawn here it does NOT degrade to
 * `null` — a write whose outcome is unknown is the failure this whole path is
 * built to avoid, so a failure comes back as a failure with `gh`'s own words.
 */
async function runGhStdin(
  cwd: string,
  args: readonly string[],
  stdin: string
): Promise<{ ok: boolean; output: string }> {
  const env = await spawnEnvOnce()
  return new Promise((resolve) => {
    const child = execFile(
      'gh',
      [...args],
      { cwd, timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: GH_MAX_BUFFER, env },
      (err, stdout, stderr) => {
        const output = `${stderr ?? ''}${stdout ?? ''}`.trim()
        resolve(err ? { ok: false, output: output || err.message } : { ok: true, output })
      }
    )
    // `gh` can exit before the body is written (bad auth, no such PR), which
    // lands as EPIPE on this stream. The callback above already carries the
    // real reason; an unhandled 'error' here would crash the main process with
    // the uninteresting half of the story.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}

// ── gh cache (TTL reused from the Reaper) ──────────────────────────────────

interface GhCacheEntry {
  fetchedAt: number
  /** `null` = gh is absent/unauthenticated, which is itself a cacheable fact. */
  json: string | null
}

const ghCache = new Map<string, GhCacheEntry>()

/**
 * `gh pr list` for a repo, behind the Reaper's cache TTL ({@link ghCacheFresh})
 * so opening the pane repeatedly doesn't hammer the API. A failure is cached
 * too: on a machine with no `gh` the answer will not change in 30 minutes, and
 * re-paying a process spawn to learn that again is pure latency.
 */
async function fetchPrJson(repoPath: string, force: boolean): Promise<string | null> {
  const key = folderKey(repoPath)
  const cached = ghCache.get(key)
  if (!force && cached && ghCacheFresh(cached.fetchedAt, Date.now())) return cached.json
  let json: string | null = null
  try {
    const { stdout } = await runFile(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '100', '--json', GH_FIELDS],
      { cwd: repoPath, timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: GH_MAX_BUFFER }
    )
    json = stdout
  } catch {
    // `gh` absent, not on PATH, or unauthenticated. Not an error here (AC4).
    json = null
  }
  ghCache.set(key, { fetchedAt: Date.now(), json })
  return json
}

// ── Base resolution ────────────────────────────────────────────────────────

/** The repo's default branch from `origin/HEAD`, falling back to `main`. */
async function defaultBranchOf(repoPath: string): Promise<string> {
  const raw = await runGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const short = raw?.trim() ?? ''
  if (short) return short.startsWith('origin/') ? short.slice('origin/'.length) : short
  for (const candidate of ['main', 'master']) {
    const ok = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', candidate])
    if (ok?.trim()) return candidate
  }
  return 'main'
}

/**
 * Resolve the base to diff against (PRD §9 Q4). An explicit base wins; a base
 * that does not resolve falls back to the repo default rather than producing an
 * empty diff that would read as "nothing changed".
 */
async function resolveBase(repoPath: string, requested?: string): Promise<string> {
  if (requested?.trim()) {
    const ok = await runGit(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${requested.trim()}^{commit}`
    ])
    if (ok?.trim()) return requested.trim()
  }
  return defaultBranchOf(repoPath)
}

/** The worktree's current branch, or the short SHA when detached. */
async function currentBranch(repoPath: string): Promise<string> {
  const raw = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = raw?.trim() ?? ''
  if (name && name !== 'HEAD') return name
  const sha = await runGit(repoPath, ['rev-parse', '--short', 'HEAD'])
  return sha?.trim() ?? ''
}

// ── Blast-radius config (operator-owned, agent-unreadable) ──────────────────

const BLAST_FILE_NAME = 'blast-radius.json'
const TMP_SUFFIX = '.tmp'

/** One repo's sensitive-path list. */
export interface BlastRadiusConfig {
  globs: string[]
}

interface BlastRadiusFile {
  version: 1
  folders: Record<string, BlastRadiusConfig>
}

function blastFilePath(): string {
  return path.join(app.getPath('userData'), BLAST_FILE_NAME)
}

function emptyBlastFile(): BlastRadiusFile {
  return { version: 1, folders: {} }
}

/** Coerce a raw blob into a sanitized config — strings only, no blanks, unique. */
function sanitizeConfig(raw: unknown): BlastRadiusConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { globs: [] }
  const globs = (raw as Record<string, unknown>).globs
  if (!Array.isArray(globs)) return { globs: [] }
  const clean = globs
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
  return { globs: [...new Set(clean)] }
}

/** Read + parse. Never throws — a missing/corrupt file degrades to empty. */
async function readBlastFile(): Promise<BlastRadiusFile> {
  let raw: string
  try {
    raw = await fs.readFile(blastFilePath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[review] blast-radius read failed:', err)
    return emptyBlastFile()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return emptyBlastFile()
    const folders: Record<string, BlastRadiusConfig> = {}
    const rawFolders = parsed.folders
    if (typeof rawFolders === 'object' && rawFolders !== null && !Array.isArray(rawFolders)) {
      for (const [key, value] of Object.entries(rawFolders as Record<string, unknown>)) {
        const cfg = sanitizeConfig(value)
        if (cfg.globs.length > 0) folders[key] = cfg
      }
    }
    return { version: 1, folders }
  } catch (err) {
    console.warn('[review] blast-radius corrupt JSON:', err)
    return emptyBlastFile()
  }
}

/** Atomic write (tmp + rename), same as the routing policy's. */
async function writeBlastFile(file: BlastRadiusFile): Promise<void> {
  const fp = blastFilePath()
  await fs.mkdir(path.dirname(fp), { recursive: true })
  const tmp = fp + TMP_SUFFIX
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, fp)
}

/** A folder's sensitive-path list (empty when it has none). */
export async function getBlastRadius(folderPath: string): Promise<BlastRadiusConfig> {
  const file = await readBlastFile()
  return file.folders[folderKey(folderPath)] ?? { globs: [] }
}

/** Persist a folder's sensitive-path list (whole-object write; empty prunes). */
export async function setBlastRadius(
  folderPath: string,
  config: BlastRadiusConfig
): Promise<BlastRadiusConfig> {
  const file = await readBlastFile()
  const key = folderKey(folderPath)
  const clean = sanitizeConfig(config)
  if (clean.globs.length === 0) delete file.folders[key]
  else file.folders[key] = clean
  await writeBlastFile(file)
  return file.folders[key] ?? { globs: [] }
}

/** One submission: the verdict, the prose, and what the operator actually read. */
export interface ReviewSubmitArgs {
  folder: string
  /** From the snapshot's evidence. `null` refuses — there is nothing to review. */
  prNumber: number | null
  verdict: ReviewVerdict
  /** The operator's own prose. Goes over stdin, never argv. */
  body: string
  /** The base the RENDERED diff was computed against (may be `origin/main`). */
  base: string
  /** The ref the rendered diff was computed from. */
  headRef: string
  /** The sha that ref resolved to when the snapshot was built. */
  headOid: string | null
}

/**
 * What happened, in three mutually exclusive shapes: submitted (`ok`), refused
 * before anything was spawned (`refusal`), or `gh` ran and failed (`error`).
 */
export interface ReviewSubmitResult {
  ok: boolean
  refusal: SubmitRefusal | null
  /** The two shas / the two base names, when naming them helps (never prose). */
  detail: string | null
  /** `gh`'s own words, verbatim. Never summarised, never swallowed. */
  error: string | null
}

// ── Snapshot ───────────────────────────────────────────────────────────────

/** Everything the renderer asks for in one round-trip: "branch X vs base Y". */
export interface ReviewSnapshot {
  /**
   * The cwd the review actually ran in. For a foreign PR this is the repo's
   * MAIN worktree, which may differ from the folder the caller passed — the
   * renderer needs the real one so "Open in terminal" does not point elsewhere.
   */
  folder: string
  /** The BARE head name, and what the PR/CI chips match on (T246 hole 3). */
  branch: string
  base: string
  /**
   * The COMMIT {@link base} resolved to, or `null` when it did not resolve
   * (T244 AC-6 / T247). The immutable half of the pair `head.sha` completes: a
   * base *name* is a moving target the moment anyone pushes to it, so anything
   * that has to be able to reproduce THIS diff later — a head pin on a submitted
   * review, the companion's orientation — needs the SHA, not the name.
   */
  baseSha: string | null
  /** The reviewed head in both representations, plus why it is (un)readable. */
  head: ReviewHead
  /** False when `folder` is not inside a git work tree at all (PRD §6). */
  isRepo: boolean
  evidence: ReviewEvidence
  files: DiffFile[]
  /** Files dropped to keep the renderer responsive (PRD AC11). */
  truncated: boolean
  omittedFiles: string[]
  /** Total rows BEFORE truncation, so the pane can say what it is not showing. */
  totalRows: number
  /** Which files have been read, and whether GitHub agrees (T243). */
  viewed: ReviewViewed
  fetchedAt: number
}

/** The viewed-state half of a snapshot — see `review-viewed.ts` for the rules. */
export interface ReviewViewed {
  /**
   * The PR node id marks can be pushed to, or `null` for a local-only branch.
   * Carried on the snapshot so a mark is one round-trip and not three.
   */
  prNodeId: string | null
  /**
   * GitHub's own state was read at some point this session. `false` means the
   * pane is rendering local marks alone — which is the OPEN case, because
   * reading `viewerViewedState` is a network call and T246 puts those behind
   * the refresh gesture.
   */
  remoteKnown: boolean
  /** Path → state, for every file in this snapshot. */
  files: Record<string, ViewedState>
}

/** One mark edit: what to set, on which bytes, for which PR (when there is one). */
export interface ReviewSetViewedArgs {
  folder: string
  path: string
  /** The POST-image blob SHA the operator is looking at. */
  blobSha: string | null
  viewed: boolean
  /** From the snapshot's `viewed.prNodeId`; `null` keeps the mark local-only. */
  prNodeId: string | null
}

/** The single file's new state, plus the reason it is not synced when it isn't. */
export interface ReviewSetViewedResult {
  path: string
  state: ViewedState
  /** Non-null ONLY when a PR was known and its mutation failed (AC-6). */
  error: string | null
}

export interface ReviewLoadArgs {
  folder: string
  base?: string
  head?: string
  /**
   * Review THIS pull request's head instead of the folder's branch (T246).
   *
   * The head is read from `refs/pull/<n>/head` for EVERY PR, fork or not: it
   * exists for all of them, so there is no branch in the logic to get wrong and
   * no class of PR that silently takes a different path. With this set, the
   * review runs in the repo's main worktree — reviewing someone else's PR must
   * not cost a working tree.
   */
  prNumber?: number
  /**
   * Go to the network for the head. False on OPEN, true only on the explicit
   * refresh gesture: the pane is offline-first by design, and a view that
   * fetches because it was opened is exactly the implicit cost that rules out.
   */
  fetch?: boolean
  /** The bound session's end state, when the caller knows one. */
  session?: SessionEndState | null
  /** Bypass the gh cache. */
  force?: boolean
  maxRows?: number
}

function emptySnapshot(folder: string, branch: string, base: string): ReviewSnapshot {
  const head = localHead(branch)
  return {
    folder,
    branch,
    base,
    baseSha: null,
    head,
    isRepo: false,
    evidence: assembleEvidence({
      branch,
      base,
      head,
      revListCount: null,
      behindCount: null,
      numstat: null,
      nameStatus: null,
      porcelain: null,
      remotes: null,
      prListJson: null
    }),
    files: [],
    truncated: false,
    omittedFiles: [],
    totalRows: 0,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: Date.now()
  }
}

/** The pre-T246 shape: the folder's own branch, read straight off disk. */
function localHead(name: string, over: Partial<ReviewHead> = {}): ReviewHead {
  return {
    kind: 'local',
    name,
    ref: name,
    sha: null,
    state: 'ready',
    prNumber: null,
    freshness: 'unknown',
    fetchedAt: null,
    fetchFailed: false,
    ...over
  }
}

/** `gh` numbers are trusted but not assumed — this is a ref name we build. */
function validPrNumber(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Gather everything about `head` vs `base` in one pass.
 *
 * The diff uses three-dot (`base...head`) so it shows what the BRANCH did, not
 * what the base did in the meantime — the difference matters the moment a
 * branch is a few days old, and reviewing the two-dot diff is how an operator
 * ends up reading someone else's commits.
 *
 * **The order is load-bearing (T246 hole 4).** `gh pr list` is read BEFORE the
 * base is resolved, because a PR's base is `baseRefName` and nothing else: a
 * stacked PR diffed against the repo default silently shows its parent's
 * commits as its own. Before this the base was resolved first and the PR data
 * arrived twenty lines later, so `baseRefName` was simply not available in time
 * to be used.
 *
 * **Read-only git plus `fetch`, always.** No `checkout`, no `reset`, no
 * `stash`. For a foreign PR the cwd is the repo's main worktree, which normally
 * has the operator's own uncommitted work in it; `fetch` and `diff <a>...<b>`
 * never touch the working tree, the index or HEAD, and that is what makes this
 * safe. `tests/review-head.test.ts` pins the rule.
 */
export async function loadReview(args: ReviewLoadArgs): Promise<ReviewSnapshot> {
  const requested = args.folder ?? ''
  const prNumber = validPrNumber(args.prNumber)

  // A foreign PR has no worktree of its own — that is the whole point of this
  // path — so it is reviewed from the repo's MAIN worktree. Resolved from git
  // rather than from whichever folder the caller happened to hold, so the ref
  // fetched on one open is findable on the next.
  let folder = requested
  if (prNumber !== null && requested) {
    const commonDir = await runGit(requested, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ])
    folder = mainWorktreeFrom(commonDir, requested)
  }
  const git: GitRun = (a) => runGit(folder, a)

  const inRepo = (await git(['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
  if (!inRepo) {
    const name = args.head?.trim() || ''
    return emptySnapshot(folder, name, await resolveBase(folder, args.base))
  }

  // Remotes first, then `gh`, then the head and the base that depends on it.
  const remotes = await git(['remote'])
  const prListJson =
    (remotes ?? '').trim().length > 0 ? await fetchPrJson(folder, args.force === true) : null
  const prs = prListJson === null ? null : parsePrList(prListJson)

  const { head, base, baseSha } = await resolveHeadAndBase(git, folder, args, prNumber, prs)

  // An unreadable head runs NO count at all. `runGit` degrades to `null` and
  // `parseCount(null)` is `0`, so diffing a ref that is not on disk would
  // produce numbers indistinguishable from a branch with nothing on it — the
  // "no commits" reading that makes an operator Close on an unfetched PR.
  const diffable = head.state === 'ready'
  const range = `${base}...${head.ref}`
  const [revListCount, behindCount, numstat, nameStatus, diffRaw] = diffable
    ? await Promise.all([
        git(['rev-list', '--count', `${base}..${head.ref}`]),
        git(['rev-list', '--count', `${head.ref}..${base}`]),
        git(['diff', '--numstat', range]),
        git(['diff', '--name-status', '--find-renames', range]),
        git(['diff', '--find-renames', '--no-color', range])
      ])
    : [null, null, null, null, null]

  // The main worktree's uncommitted files are the OPERATOR's own work and say
  // nothing about someone else's PR. Reporting them as a gap in that PR would
  // be a fabricated discrepancy, so the question is not even asked.
  const porcelain = head.kind === 'local' ? await git(['status', '--porcelain']) : null

  const evidence = assembleEvidence({
    branch: head.name,
    base,
    revListCount,
    behindCount,
    numstat,
    nameStatus,
    porcelain,
    remotes,
    prListJson,
    head,
    session: args.session ?? null,
    blastRadiusGlobs: (await getBlastRadius(folder)).globs
  })

  const parsed = parseUnifiedDiff(diffRaw ?? '')
  const totalRows = countDiffRows(parsed)
  const capped = truncateDiff(parsed, args.maxRows ?? DEFAULT_MAX_ROWS)

  // The PR the head actually belongs to, re-found rather than threaded through:
  // `head.prNumber` is set by both resolution paths, so there is one lookup and
  // no second place for the two to disagree.
  const pr = head.prNumber !== null ? (prs?.find((p) => p.number === head.prNumber) ?? null) : null

  return {
    folder,
    branch: head.name,
    base,
    baseSha,
    head,
    isRepo: true,
    evidence,
    files: annotateWordDiffs(capped.files, { maxRows: WORD_DIFF_ROW_BUDGET }),
    truncated: capped.truncated,
    omittedFiles: capped.omittedFiles,
    totalRows,
    viewed: await viewedFor(folder, capped.files, pr?.nodeId ?? null, args.fetch === true),
    fetchedAt: Date.now()
  }
}

/**
 * Assemble the snapshot's viewed block.
 *
 * **The network call is gated on `refresh`, not on having a PR** — T246 makes
 * "opening performs no network call" a hard rule for this pane, and reading
 * `viewerViewedState` is a GraphQL round-trip. An OPEN therefore renders local
 * marks plus whatever this session already read; the refresh gesture is what
 * goes and asks.
 *
 * A refresh also PUSHES the unsynced writes it finds, because that is what a
 * local mark is under this card's precedence rule: not a competing opinion, a
 * write waiting to go up. It is capped so one gesture cannot become a hundred
 * round-trips, and a push that fails simply leaves the mark pending — visibly
 * unsynced, never silently promoted.
 */
async function viewedFor(
  folder: string,
  files: readonly DiffFile[],
  nodeId: string | null,
  refresh: boolean
): Promise<ReviewViewed> {
  const marks = await getFolderMarks(folder)
  let remote: Record<string, RemoteViewedState> | null = nodeId ? cachedRemoteStates(nodeId) : null

  if (nodeId && refresh) {
    const fresh = await fetchRemoteViewed(folder, nodeId)
    if (fresh) {
      for (const filePath of planPendingPushes(files, marks, fresh)) {
        const res = await pushViewed(folder, nodeId, filePath, true)
        if (!res.ok) continue
        marks[filePath] = { ...marks[filePath], pending: false }
        await putFolderMark(folder, filePath, marks[filePath])
        fresh[filePath] = 'VIEWED'
      }
      remote = fresh
    }
  }

  return {
    prNodeId: nodeId,
    remoteKnown: remote !== null,
    files: resolveViewedFiles(files, marks, remote)
  }
}

/**
 * Mark (or unmark) ONE file as read.
 *
 * The local write always happens; the GitHub push happens only when a PR is
 * known, and its failure is RETURNED rather than thrown — with no PR, no remote
 * or no `gh` this is a purely local gesture that raises nothing (AC-5), and
 * with a PR that does exist a failed mutation must be surfaced and must not
 * render as synced (AC-6).
 */
export async function setViewed(args: ReviewSetViewedArgs): Promise<ReviewSetViewedResult> {
  const folder = args.folder ?? ''
  const filePath = args.path ?? ''
  const blob = args.blobSha ?? ''
  const nodeId = args.prNodeId || null
  if (!folder || !filePath) return { path: filePath, state: 'unviewed', error: null }

  let error: string | null = null
  if (nodeId) {
    const res = await pushViewed(folder, nodeId, filePath, args.viewed)
    if (!res.ok) error = res.error
  }

  const mark = args.viewed ? { blob, at: Date.now(), pending: error !== null } : null
  await putFolderMark(folder, filePath, mark)

  return {
    path: filePath,
    state: resolveViewed({
      local: mark ?? undefined,
      currentBlob: args.blobSha,
      remote: nodeId ? (cachedRemoteStates(nodeId)?.[filePath] ?? null) : null
    }),
    error
  }
}

/**
 * Submit a review to GitHub, under the operator's own identity (T244).
 *
 * **This is the only write in the whole review pane, and it is the only one
 * that another human can see.** Three things about it are load-bearing:
 *
 *  - **No agent can reach it.** `review:submitReview` is registered like any
 *    other IPC channel and appears in NO MCP verb, no session, no skill.
 *    Approving someone's code is an *accept* door, and Harnu's zero-friction
 *    principle keeps those shut to everything but a person.
 *    `tests/review-pane-contract.test.ts` fails if this channel ever turns up in
 *    the tool catalog.
 *  - **`gh`, not the API.** It inherits the operator's existing auth, so Harnu
 *    never handles, stores, scopes or refreshes a token — and therefore can
 *    never hold a credential with more reach than the person in front of it.
 *  - **The body goes over stdin.** `--body-file -`, never argv: it is arbitrary
 *    operator prose, argv makes quoting a correctness problem, and
 *    `/proc/<pid>/cmdline` is world-readable (BUG-84).
 *
 * Everything is re-read HERE, at submit time — the PR's own base and the
 * reviewed ref's current sha — and compared against what the rendered snapshot
 * was built from. A snapshot is a photograph; approving from one without
 * re-checking is approving whatever the branch happens to hold by the time the
 * click lands.
 */
export async function submitReview(args: ReviewSubmitArgs): Promise<ReviewSubmitResult> {
  const folder = args.folder ?? ''
  const prNumber = validPrNumber(args.prNumber)
  if (!folder || prNumber === null) {
    return { ok: false, refusal: 'no-pr', detail: null, error: null }
  }

  // The PR's own base, from the SAME cached `gh pr list` the snapshot read, so
  // the guard compares the diff against the record it was built from rather
  // than against a fresher one the operator never saw.
  const prs = parsePrList((await fetchPrJson(folder, false)) ?? '')
  const pr = prs.find((p) => p.number === prNumber) ?? null

  const decision = checkSubmittable({
    verdict: args.verdict,
    body: args.body ?? '',
    prNumber,
    snapshotBase: args.base ?? '',
    prBase: pr?.base ?? null,
    pinnedOid: args.headOid ?? null,
    currentOid: await resolveCommit((a) => runGit(folder, a), args.headRef ?? '')
  })
  if (!decision.ok) {
    return { ok: false, refusal: decision.refusal, detail: decision.detail ?? null, error: null }
  }

  const run = await runGhStdin(folder, decision.args, args.body)
  // A submitted state is rendered ONLY off a zero exit code. An approval the
  // operator believes happened and did not is strictly worse than a visible
  // error, so a non-zero exit surfaces `gh`'s own words verbatim.
  return {
    ok: run.ok,
    refusal: null,
    detail: null,
    error: run.ok ? null : run.output || 'gh pr review failed'
  }
}

/**
 * The head to diff and the base to diff it against, decided together.
 *
 * They are one decision because the base COMES FROM the head's PR: resolving
 * them separately is what let the old ordering diff a stacked branch against
 * the repo default. An explicit `args.base` still wins over everything — a
 * caller naming a base has stated an intent no inference should overrule.
 *
 * `baseSha` rides along for the same reason `head.sha` does (T244 AC-6 / T247):
 * the base NAME is a moving target, and every consumer that has to reproduce
 * this exact diff later needs the commit. It is resolved through the same
 * {@link resolveCommit} every other SHA on this path goes through, so a base
 * that renders and a base that pins can never disagree.
 */
async function resolveHeadAndBase(
  git: GitRun,
  folder: string,
  args: ReviewLoadArgs,
  prNumber: number | null,
  prs: ReturnType<typeof parsePrList> | null
): Promise<{ head: ReviewHead; base: string; baseSha: string | null }> {
  const withBaseSha = async (r: {
    head: ReviewHead
    base: string
  }): Promise<{ head: ReviewHead; base: string; baseSha: string | null }> => ({
    ...r,
    // `base-unresolved` already MEANS "this name resolves to nothing"; asking
    // git again would be a second round trip for an answer we hold.
    baseSha: r.head.state === 'base-unresolved' ? null : await resolveCommit(git, r.base)
  })
  const explicitBase = args.base?.trim() ?? ''

  if (prNumber !== null) {
    const pr = prs?.find((p) => p.number === prNumber) ?? null
    const head = await resolvePrHead(
      git,
      {
        number: prNumber,
        // With no `gh` we still know the number, so the pull ref is still the
        // right ref — only the human-readable name is missing, and `pull/12` is
        // an honest stand-in rather than a branch name we invented.
        headRefName: pr?.branch || `pull/${prNumber}`,
        baseRefName: pr?.base ?? '',
        headOid: pr?.headOid ?? null
      },
      { fetch: args.fetch === true }
    )
    if (explicitBase) return withBaseSha({ head, base: await resolveBase(folder, explicitBase) })
    if (!pr?.base) return withBaseSha({ head, base: await resolveBase(folder, undefined) })

    const resolved = await resolvePrBase(git, pr.base)
    // REFUSE rather than fall back (AC-4). Falling through to the repo default
    // would render a confident diff against a base this PR never named, and a
    // wrong diff is worse than no diff.
    if (resolved === null) {
      return withBaseSha({ head: { ...head, state: 'base-unresolved' }, base: pr.base })
    }
    return withBaseSha({ head, base: resolved })
  }

  const name = args.head?.trim() || (await currentBranch(folder))
  const pr = prs?.find((p) => p.branch === name) ?? null
  const local = await localHeadState(git, name, pr?.headOid ?? null)
  const head = localHead(name, {
    prNumber: pr?.number ?? null,
    sha: local.sha,
    freshness: local.freshness
  })

  if (explicitBase) return withBaseSha({ head, base: await resolveBase(folder, explicitBase) })
  if (!pr?.base) return withBaseSha({ head, base: await resolveBase(folder, undefined) })

  const resolved = await resolvePrBase(git, pr.base)
  if (resolved === null) {
    return withBaseSha({ head: { ...head, state: 'base-unresolved' }, base: pr.base })
  }
  return withBaseSha({ head, base: resolved })
}

/**
 * Registers the renderer-facing channels. Called once from `src/main/index.ts`.
 *
 * `getWindow` is used for one thing: broadcasting `review:blastRadiusChanged`
 * when the operator edits a repo's sensitive-path list, so a review pane that
 * is already open re-flags its files instead of showing a stale never-delegate
 * list — the one state where being out of date is a safety problem rather than
 * a cosmetic one.
 */
export function registerReviewHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('review:load', async (_e, args: ReviewLoadArgs): Promise<ReviewSnapshot> =>
    loadReview(args ?? { folder: '' })
  )
  ipcMain.handle('review:blastRadius', async (_e, folderPath: string): Promise<BlastRadiusConfig> =>
    getBlastRadius(folderPath ?? '')
  )
  ipcMain.handle(
    'review:setViewed',
    async (_e, args: ReviewSetViewedArgs): Promise<ReviewSetViewedResult> =>
      setViewed(args ?? { folder: '', path: '', blobSha: null, viewed: false, prNodeId: null })
  )
  /**
   * T244 — the pane's ONE write to GitHub. Human-gesture only: this channel is
   * absent from `src/main/mcp/tool-catalog.ts` and a test fails if it is added.
   */
  ipcMain.handle(
    'review:submitReview',
    async (_e, args: ReviewSubmitArgs): Promise<ReviewSubmitResult> =>
      submitReview(
        args ?? {
          folder: '',
          prNumber: null,
          verdict: 'comment',
          body: '',
          base: '',
          headRef: '',
          headOid: null
        }
      )
  )
  ipcMain.handle(
    'review:setBlastRadius',
    async (_e, folderPath: string, config: BlastRadiusConfig): Promise<BlastRadiusConfig> => {
      const saved = await setBlastRadius(folderPath ?? '', config)
      getWindow()?.webContents.send('review:blastRadiusChanged', {
        folder: folderPath ?? '',
        globs: saved.globs
      })
      return saved
    }
  )
}
