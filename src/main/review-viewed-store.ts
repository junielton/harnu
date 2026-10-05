/**
 * T243 — Review pane: the viewed mark's imperative shell.
 *
 * Two effects, and no decisions: the `<userData>` JSON that holds the operator's
 * local marks, and the `gh api graphql` calls that read and write GitHub's own
 * `viewerViewedState`. Every rule about what a mark MEANS — precedence, blob-SHA
 * invalidation, which pending writes are owed — lives in `review-viewed.ts`,
 * exactly like `review-core.ts` ↔ `review-ipc.ts`.
 *
 * **`markFileAsViewed` / `unmarkFileAsViewed` are GraphQL-only.** There is no
 * REST equivalent — the `/pulls/{n}/files` payload carries no viewed-state field
 * at all — and `PullRequestChangedFile` does not carry the diff text either, so
 * this never replaces the local `git diff`; it only carries the mark.
 *
 * **The read is a NETWORK call and rides the refresh gesture**, per T246's
 * "opening performs no network call" rule for this pane. An open serves
 * {@link cachedRemoteStates}.
 *
 * **No MCP verb reads or writes any of this.** It sits beside the blast-radius
 * list in `<userData>` and shares its posture: what the operator has and has not
 * read is theirs, and an agent has no business either reading it or claiming it.
 *
 * env-bound (`child_process` + `<userData>` fs) ⇒ e2e-only per ADR-0001.
 */

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { spawnEnvOnce } from './appimage-env'
import { folderKey } from './claude-config'
import {
  parseViewedStates,
  pruneMarks,
  sanitizeFolderMarks,
  type FolderMarks,
  type LocalMark,
  type RemoteViewedState
} from './review-viewed'

const runFile = promisify(execFile)

const GH_TIMEOUT_MS = 15_000
const GH_MAX_BUFFER = 1 << 22

/** Pages of 100 files. Ten is well past any diff a human reads in one sitting. */
const MAX_FILE_PAGES = 10

// ═══════════════════════════════════════════════════════════════════════════
// 2. Local persistence (`<userData>/review-viewed.json`)
// ═══════════════════════════════════════════════════════════════════════════

const VIEWED_FILE_NAME = 'review-viewed.json'
const TMP_SUFFIX = '.tmp'

interface ViewedFile {
  version: 1
  folders: Record<string, FolderMarks>
}

function viewedFilePath(): string {
  return path.join(app.getPath('userData'), VIEWED_FILE_NAME)
}

/** Read + parse. Never throws — a missing/corrupt file degrades to empty. */
async function readViewedFile(): Promise<ViewedFile> {
  let raw: string
  try {
    raw = await fs.readFile(viewedFilePath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[review] viewed-state read failed:', err)
    return { version: 1, folders: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1)
      return { version: 1, folders: {} }
    const folders: Record<string, FolderMarks> = {}
    const rawFolders = parsed.folders
    if (typeof rawFolders === 'object' && rawFolders !== null && !Array.isArray(rawFolders)) {
      for (const [key, value] of Object.entries(rawFolders as Record<string, unknown>)) {
        const marks = sanitizeFolderMarks(value)
        if (Object.keys(marks).length > 0) folders[key] = marks
      }
    }
    return { version: 1, folders }
  } catch (err) {
    console.warn('[review] viewed-state corrupt JSON:', err)
    return { version: 1, folders: {} }
  }
}

/** Atomic write (tmp + rename), same as the blast-radius list's. */
async function writeViewedFile(file: ViewedFile): Promise<void> {
  const fp = viewedFilePath()
  await fs.mkdir(path.dirname(fp), { recursive: true })
  const tmp = fp + TMP_SUFFIX
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, fp)
}

/** Every local mark this folder holds. */
export async function getFolderMarks(folderPath: string): Promise<FolderMarks> {
  const file = await readViewedFile()
  return file.folders[folderKey(folderPath)] ?? {}
}

/**
 * Apply one edit to a folder's marks and persist the result.
 *
 * `mark === null` removes the entry, which is what "unread" means locally:
 * there is no such thing as a stored NOT-read, only the absence of a read.
 */
export async function putFolderMark(
  folderPath: string,
  filePath: string,
  mark: LocalMark | null
): Promise<FolderMarks> {
  const file = await readViewedFile()
  const key = folderKey(folderPath)
  const marks = { ...(file.folders[key] ?? {}) }
  if (mark === null) delete marks[filePath]
  else marks[filePath] = mark
  const pruned = pruneMarks(marks, Date.now())
  if (Object.keys(pruned).length === 0) delete file.folders[key]
  else file.folders[key] = pruned
  await writeViewedFile(file)
  return file.folders[key] ?? {}
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. GitHub (`gh api graphql`)
// ═══════════════════════════════════════════════════════════════════════════

const READ_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`

const MARK_MUTATION = `mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`

const UNMARK_MUTATION = `mutation($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`

async function gh(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile('gh', args, {
    cwd: repoPath,
    timeout: GH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GH_MAX_BUFFER,
    // Spawn with the user's login-shell PATH, or a Dock-launched macOS build
    // resolves `gh` against launchd's minimal PATH and never finds Homebrew
    // (BUG-34).
    env: await spawnEnvOnce()
  })
  return stdout
}

/** The last remote read per PR node, so an OPEN can render without asking. */
const remoteCache = new Map<string, Record<string, RemoteViewedState>>()

/** What this session last read from GitHub for a PR, or `null` if never. */
export function cachedRemoteStates(nodeId: string): Record<string, RemoteViewedState> | null {
  return remoteCache.get(nodeId) ?? null
}

/** Forget everything cached. Test seam; also used when a PR node id changes. */
export function clearRemoteCache(): void {
  remoteCache.clear()
}

/**
 * Read `viewerViewedState` for every file of a PR, paginated.
 *
 * **Only ever called behind the refresh gesture** (rule 3 in this file's
 * header). `null` on any failure — no `gh`, no auth, rate limit, a closed PR —
 * which the resolver reads as "GitHub has no opinion", i.e. exactly the
 * local-only path a repo with no remote already takes.
 */
export async function fetchRemoteViewed(
  repoPath: string,
  nodeId: string
): Promise<Record<string, RemoteViewedState> | null> {
  const states: Record<string, RemoteViewedState> = {}
  let cursor: string | null = null
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    let stdout: string
    try {
      stdout = await gh(repoPath, [
        'api',
        'graphql',
        '-f',
        `query=${READ_QUERY}`,
        '-f',
        `id=${nodeId}`,
        ...(cursor ? ['-f', `cursor=${cursor}`] : [])
      ])
    } catch {
      return null
    }
    const page1 = parseViewedStates(stdout)
    if (page1 === null) return null
    Object.assign(states, page1.states)
    if (page1.endCursor === null) break
    cursor = page1.endCursor
  }
  remoteCache.set(nodeId, states)
  return states
}

/** The single error string a failed mutation reports. Never a stack. */
function ghErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const raw = (e?.stderr || e?.message || '').trim()
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstLine.slice(0, 200) || 'gh api graphql failed'
}

/**
 * Push one mark to GitHub. Returns the error rather than swallowing it: a mark
 * that failed to sync must be visible as unsynced AND say why (AC-6).
 */
export async function pushViewed(
  repoPath: string,
  nodeId: string,
  filePath: string,
  viewed: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await gh(repoPath, [
      'api',
      'graphql',
      '-f',
      `query=${viewed ? MARK_MUTATION : UNMARK_MUTATION}`,
      '-f',
      `id=${nodeId}`,
      '-f',
      `path=${filePath}`
    ])
  } catch (err) {
    return { ok: false, error: ghErrorMessage(err) }
  }
  // Keep the session's cached copy honest without a second round-trip: the
  // operator just changed the very state an OPEN would otherwise render stale.
  const cached = remoteCache.get(nodeId)
  if (cached) cached[filePath] = viewed ? 'VIEWED' : 'UNVIEWED'
  return { ok: true }
}
