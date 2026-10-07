import { ipcMain } from 'electron'
import { promises as fs, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, relative, join, sep, isAbsolute } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { isPathWithinRoot } from './settings'

/**
 * Confined directory lister (Cluster C). Backs the Explorer tree pane, which
 * calls it once per folder as the user expands a node — a lazy, one-level
 * listing of a directory's immediate children (files + folders), CONFINED to a
 * single project root and respecting the repo's `.gitignore`.
 *
 * Shape precedent: `markdown-read.ts` (resolve → confine → cap → `ipcMain.handle`)
 * for the security envelope, and `folder-ops.ts`'s `listChildFolders` for the
 * lazy one-level fs read. This is the files+dirs analogue of the latter.
 *
 * Confinement reuses the pure, already-tested `isPathWithinRoot` from
 * `settings.ts` (→ `path.relative`), so `..` traversal, absolute re-roots, and
 * false-positive prefixes are all rejected without a bespoke check. The handler
 * NEVER writes and NEVER throws across the IPC boundary — every failure is a
 * typed `{ entries: [], error }` result the renderer can render.
 */

/** Per-level cap (mirrors `folder-ops.ts`'s `MAX_CHILDREN`). Beyond it we
 *  return the first N and flag `truncated` so a huge dir can never flood the UI. */
export const MAX_CHILDREN = 1000

/** Recursive-search result cap. Once this many matches are collected the walk
 *  stops and flags `truncated` — a finder list never needs more than this and
 *  the UI must never flood. */
export const MAX_SEARCH_RESULTS = 500

/** Hard bound on entries VISITED during a recursive search, so a pathological
 *  repo (deep, huge, mostly un-gitignored) can never hang the walk. Hitting it
 *  returns whatever matched so far with `truncated: true`. */
export const MAX_SEARCH_VISITS = 50_000

/** Below this query length the recursive search is a no-op (`{ entries: [] }`)
 *  — the pane shows the tree instead of walking the world for one letter. */
export const MIN_SEARCH_QUERY = 2

/** Always hidden regardless of `.gitignore` (git never lists `.git` itself, but
 *  it is also never in `.gitignore`). Other dotfiles are shown unless gitignored
 *  — a user's plans may live in `.docs/` etc. */
const ALWAYS_EXCLUDE = new Set(['.git'])

/** The agent's data dir, relative to the Explorer root. Deliverables land in
 *  `.harnu/out/`, and the dir is gitignored in most repos — without an
 *  exemption the tree, the finder and the transcript links could never reach
 *  the very files an agent prints (BUG-128). */
const HARNU_DATA_DIR = '.harnu'

/**
 * Is `relPosix` (a path RELATIVE TO THE EXPLORER ROOT, `/`-separated) the
 * `.harnu/` data dir or anything under it? Such an entry is exempt from every
 * `.gitignore` rule — and from nothing else (`.git` and root confinement are
 * checked separately and unchanged). Pure and deliberately narrow: only the
 * root-level `.harnu`, no nested copies, no legacy `.capy/` alias, and no path
 * that is absolute or climbs out with `..`. Exported for unit tests; the single
 * place the exemption is decided, shared by all three gates.
 */
export function isHarnuDataPath(relPosix: string): boolean {
  if (relPosix !== HARNU_DATA_DIR && !relPosix.startsWith(`${HARNU_DATA_DIR}/`)) return false
  return !relPosix.split('/').includes('..')
}

/** Gitignore verdict for `entryAbs` as the Explorer applies it: the `.harnu/`
 *  data dir is never ignored, everything else defers to the layer chain. */
function isHiddenByGitignore(
  layers: IgnoreLayer[],
  root: string,
  entryAbs: string,
  isDir: boolean
): boolean {
  const rel = relative(root, resolve(entryAbs)).split(sep).join('/')
  if (isHarnuDataPath(rel)) return false
  return isIgnoredByLayers(layers, entryAbs, isDir)
}

/** One row of a directory listing. */
export interface ExplorerEntry {
  /** File or directory name (last path segment). */
  name: string
  /** Absolute path of the entry. */
  path: string
  /** True for a directory (drives the expand chevron in the tree). */
  isDir: boolean
}

/**
 * Result of listing one directory. `error` is a short machine code
 * (`'out-of-root'`, `'not-found'`, `'read-failed'`) when the listing failed;
 * `truncated` flags that {@link MAX_CHILDREN} was hit and `entries` is a prefix.
 */
export interface ExplorerListing {
  entries: ExplorerEntry[]
  error?: string
  truncated?: boolean
}

/**
 * Result of a recursive, project-wide file search (Cluster F). Structurally
 * identical to {@link ExplorerListing} — same `entries` rows, same typed `error`
 * codes, same `truncated` flag — so the Explorer pane renders a flat result list
 * exactly the way it renders a directory listing. `truncated` here means EITHER
 * {@link MAX_SEARCH_RESULTS} or {@link MAX_SEARCH_VISITS} was hit.
 */
export type ExplorerSearchResult = ExplorerListing

/** A single `.gitignore` file's rules, bound to the directory it lives in.
 *  Patterns are matched relative to `dir` (git semantics). */
interface IgnoreLayer {
  dir: string
  ig: Ignore
}

/**
 * Build one ignore layer from a `.gitignore`'s raw contents, anchored at `dir`.
 * Pure — exported for unit tests. `dir` is resolved so later `path.relative`
 * comparisons are stable.
 */
export function buildIgnoreLayer(dir: string, gitignoreContent: string): IgnoreLayer {
  return { dir: resolve(dir), ig: ignore().add(gitignoreContent) }
}

/**
 * Is `entryAbs` ignored by ANY layer in the chain? Each layer matches the entry
 * by its path *relative to that layer's directory* (git's per-`.gitignore`
 * semantics), with a trailing `/` appended for directories so a `dist/`-style
 * dir pattern matches (the `ignore` lib only matches a directory pattern when
 * the queried path carries the slash). Pure — exported for unit tests.
 */
export function isIgnoredByLayers(
  layers: IgnoreLayer[],
  entryAbs: string,
  isDir: boolean
): boolean {
  const abs = resolve(entryAbs)
  for (const { dir, ig } of layers) {
    const rel = relative(dir, abs)
    // Skip a layer that doesn't contain the entry (shouldn't happen for the
    // root→dir chain, but keeps the fn total for arbitrary inputs).
    if (rel === '' || rel.startsWith('..')) continue
    const relPosix = rel.split(sep).join('/')
    if (ig.ignores(isDir ? `${relPosix}/` : relPosix)) return true
  }
  return false
}

/**
 * Directories first, then files; within each group, locale-aware,
 * case-insensitive alpha. Pure — exported for unit tests. Sorts in place and
 * returns the same array.
 */
export function sortExplorerEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' })
  })
}

/**
 * Read the `.gitignore` layers applicable at `dir`: every `.gitignore` found on
 * the ancestor chain from `root` down to `dir` (inclusive), in root→dir order.
 * A missing/unreadable `.gitignore` contributes no layer. Never throws.
 */
async function readIgnoreChain(root: string, dir: string): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = []
  // Walk from root down to dir, collecting each directory on the path.
  const rel = relative(root, dir)
  const segments = rel === '' ? [] : rel.split(sep)
  let current = root
  const chainDirs = [current]
  for (const seg of segments) {
    current = join(current, seg)
    chainDirs.push(current)
  }
  for (const d of chainDirs) {
    let content: string
    try {
      content = await fs.readFile(join(d, '.gitignore'), 'utf8')
    } catch {
      continue // no .gitignore here — skip
    }
    layers.push(buildIgnoreLayer(d, content))
  }
  return layers
}

/**
 * List the immediate children of `dir`, confined to `root`, respecting
 * `.gitignore`. See {@link ExplorerListing}. Read-only; never throws.
 */
export async function listDir(root: string, dir: string): Promise<ExplorerListing> {
  if (typeof root !== 'string' || typeof dir !== 'string' || !root || !dir) {
    return { entries: [], error: 'invalid-path' }
  }
  const resolvedRoot = resolve(root)
  const resolvedDir = resolve(dir)

  // Security gate — a malicious `dir` can never escape the project root.
  if (!isPathWithinRoot(resolvedDir, resolvedRoot)) {
    return { entries: [], error: 'out-of-root' }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>> | null
  try {
    stat = await fs.stat(resolvedDir)
  } catch {
    return { entries: [], error: 'not-found' }
  }
  if (!stat.isDirectory()) return { entries: [], error: 'not-found' }

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(resolvedDir, { withFileTypes: true })
  } catch {
    return { entries: [], error: 'read-failed' }
  }

  const layers = await readIgnoreChain(resolvedRoot, resolvedDir)

  const kept: ExplorerEntry[] = []
  for (const d of dirents) {
    if (ALWAYS_EXCLUDE.has(d.name)) continue
    // Resolve symlinks only for the isDir flag; the listing stays one level.
    const isDir =
      d.isDirectory() || (d.isSymbolicLink() && (await isDirSymlink(resolvedDir, d.name)))
    const abs = join(resolvedDir, d.name)
    if (isHiddenByGitignore(layers, resolvedRoot, abs, isDir)) continue
    kept.push({ name: d.name, path: abs, isDir })
  }

  sortExplorerEntries(kept)

  const truncated = kept.length > MAX_CHILDREN
  return {
    entries: truncated ? kept.slice(0, MAX_CHILDREN) : kept,
    ...(truncated ? { truncated: true } : {})
  }
}

/** Does a symlink resolve to a directory? Read error → treat as a file. Never throws. */
async function isDirSymlink(parent: string, name: string): Promise<boolean> {
  try {
    const s = await fs.stat(join(parent, name))
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Try to read the single `.gitignore` living directly in `dir` → one layer, or
 *  `null` when absent/unreadable. Used to grow the ignore-layer stack live as the
 *  recursive search descends (mirrors {@link readIgnoreChain}, one dir at a time). */
async function readIgnoreLayerAt(dir: string): Promise<IgnoreLayer | null> {
  try {
    const content = await fs.readFile(join(dir, '.gitignore'), 'utf8')
    return buildIgnoreLayer(dir, content)
  } catch {
    return null
  }
}

/**
 * Fuzzy score for `hayLower` against `needleLower` (both already lowercased,
 * the haystack a POSIX-normalized path relative to root). Returns `null` when
 * there is no match at all, otherwise a rank where **lower is better**:
 *
 * - a **contiguous substring** match scores by its start index (earlier = lower
 *   = better), so `mark` hitting `src/markdown.ts` beats a scattered hit;
 * - a **subsequence** match (all needle chars appear in order, but not
 *   contiguously — e.g. `src/mark` → `src/renderer/lib/markdown.ts`) lands in a
 *   worse bucket than ANY contiguous match.
 *
 * This is the "substring baseline + light subsequence improvement" the finder
 * wants: predictable, allocation-free, single left-to-right pass.
 */
function fuzzyScore(hayLower: string, needleLower: string): number | null {
  const idx = hayLower.indexOf(needleLower)
  if (idx !== -1) return idx // contiguous — best bucket (0..)
  let h = 0
  for (let n = 0; n < needleLower.length; n++) {
    h = hayLower.indexOf(needleLower[n], h)
    if (h === -1) return null
    h += 1
  }
  return 1_000_000 // subsequence — worse than any contiguous index
}

/** A matched entry carried through the walk with its rank + relative path. */
interface ScoredEntry extends ExplorerEntry {
  score: number
  rel: string
}

/**
 * Recursively search `root`'s subtree for files/dirs whose path RELATIVE TO ROOT
 * fuzzy-matches `query` (case-insensitive). Prunes `.git` and any gitignored
 * directory DURING descent (so `node_modules` and friends are never walked —
 * both correct and the key perf bound), building the ignore-layer stack live.
 * Read-only; never throws. See {@link ExplorerSearchResult}.
 */
export async function searchFiles(root: string, query: string): Promise<ExplorerSearchResult> {
  if (typeof root !== 'string' || typeof query !== 'string' || !root) {
    return { entries: [], error: 'invalid-path' }
  }
  const needle = query.trim().toLowerCase()
  if (needle.length < MIN_SEARCH_QUERY) return { entries: [] }

  const resolvedRoot = resolve(root)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(resolvedRoot)
  } catch {
    return { entries: [], error: 'not-found' }
  }
  if (!stat.isDirectory()) return { entries: [], error: 'not-found' }

  const matches: ScoredEntry[] = []
  let visited = 0
  let truncated = false

  // `layers` covers root..dir inclusive (the chain applicable to `dir`'s
  // children), matching listDir's `readIgnoreChain` semantics.
  const walk = async (dir: string, layers: IgnoreLayer[]): Promise<void> => {
    if (truncated) return
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip, never throw
    }
    for (const d of dirents) {
      if (truncated) return
      if (ALWAYS_EXCLUDE.has(d.name)) continue
      if (++visited > MAX_SEARCH_VISITS) {
        truncated = true
        return
      }
      const abs = join(dir, d.name)
      // Defensive confinement: structurally we only ever descend within root,
      // but never emit/descend into anything that resolves outside it.
      if (!isPathWithinRoot(abs, resolvedRoot)) continue
      const isDir = d.isDirectory() || (d.isSymbolicLink() && (await isDirSymlink(dir, d.name)))
      if (isHiddenByGitignore(layers, resolvedRoot, abs, isDir)) continue

      const rel = relative(resolvedRoot, abs).split(sep).join('/')
      const score = fuzzyScore(rel.toLowerCase(), needle)
      if (score !== null) {
        matches.push({ name: d.name, path: abs, isDir, score, rel })
        if (matches.length >= MAX_SEARCH_RESULTS) {
          truncated = true
          return
        }
      }
      if (isDir) {
        const childLayer = await readIgnoreLayerAt(abs)
        await walk(abs, childLayer ? [...layers, childLayer] : layers)
      }
    }
  }

  const rootLayer = await readIgnoreLayerAt(resolvedRoot)
  await walk(resolvedRoot, rootLayer ? [rootLayer] : [])

  // Rank: best fuzzy score first, then shortest relative path (closest to root),
  // then locale alpha — surfaces top-level & tightest matches in a finder.
  matches.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length
    return a.rel.localeCompare(b.rel, undefined, { sensitivity: 'accent' })
  })

  return {
    entries: matches.map(({ name, path, isDir }) => ({ name, path, isDir })),
    ...(truncated ? { truncated: true } : {})
  }
}

/** One transcript token that resolved to a real, revealable entry. */
export interface ResolvedPath {
  /** The candidate text exactly as it appeared in the terminal. */
  text: string
  /** Absolute, resolved path of the entry. */
  path: string
  /** True for a directory — the caller expands rather than opens it. */
  isDir: boolean
}

/** Hard bound on how many tokens one line may ask us to stat. A pathological
 *  line (a `ls` dump) must never turn into hundreds of `stat` calls per hover. */
export const MAX_RESOLVE_CANDIDATES = 32

/**
 * Resolve transcript path tokens to real entries (T-file-links).
 *
 * This is the gate that decides whether an option+click target becomes a link
 * at all. A candidate survives only if it EXISTS, sits INSIDE `root`, and is
 * NOT gitignored — the last rule matters because the Explorer tree prunes
 * gitignored entries, so a link to one could be clicked but never revealed.
 * The one exception is the `.harnu/` data dir ({@link isHarnuDataPath}), which
 * the tree shows even though it is gitignored.
 *
 * Confinement reuses the same pure `isPathWithinRoot` that guards `listDir`,
 * so `..` traversal and absolute re-roots are rejected without a bespoke check.
 * Like every handler in this file it NEVER writes and NEVER throws across the
 * IPC boundary — bad input is simply an empty result.
 */
export async function resolvePaths(
  root: string,
  cwd: string,
  candidates: string[]
): Promise<ResolvedPath[]> {
  if (typeof root !== 'string' || !root || typeof cwd !== 'string' || !cwd) return []
  if (!Array.isArray(candidates) || candidates.length === 0) return []

  const resolvedRoot = resolve(root)
  const resolvedCwd = resolve(cwd)
  const home = homedir()

  const seen = new Set<string>()
  const unique: string[] = []
  for (const c of candidates) {
    if (typeof c !== 'string' || !c || seen.has(c)) continue
    seen.add(c)
    unique.push(c)
    if (unique.length >= MAX_RESOLVE_CANDIDATES) break
  }

  // Per-call memo of the gitignore chain by parent directory. A transcript
  // line commonly lists several siblings (same dir) or a deep common prefix,
  // so without this `readIgnoreChain` re-reads the same root→parent
  // `.gitignore` files from disk once per candidate (up to
  // `MAX_RESOLVE_CANDIDATES` times per hover). Scoped to this single call —
  // never module-level — so it can't outlive a hover and serve stale
  // `.gitignore` content on the next one.
  const ignoreChainCache = new Map<string, IgnoreLayer[]>()

  const out: ResolvedPath[] = []
  for (const text of unique) {
    const expanded = text === '~' || text.startsWith(`~/`) ? join(home, text.slice(1)) : text
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(resolvedCwd, expanded)
    if (!isPathWithinRoot(abs, resolvedRoot)) continue

    // Match the tree's visibility rules — an always-excluded segment (e.g.
    // `.git`, which is never in `.gitignore`) is unreachable, same as `listDir`.
    if (
      relative(resolvedRoot, abs)
        .split(sep)
        .some((seg) => ALWAYS_EXCLUDE.has(seg))
    )
      continue

    let isDir: boolean
    try {
      isDir = (await fs.stat(abs)).isDirectory()
    } catch {
      continue
    }

    // Match the tree's visibility rules — a gitignored entry is unreachable.
    const parentDir = resolve(abs, '..')
    let layers = ignoreChainCache.get(parentDir)
    if (!layers) {
      layers = await readIgnoreChain(resolvedRoot, parentDir)
      ignoreChainCache.set(parentDir, layers)
    }
    if (isHiddenByGitignore(layers, resolvedRoot, abs, isDir)) continue

    out.push({ text, path: abs, isDir })
  }
  return out
}

/**
 * Register the explorer IPC handlers. Request/response only — no streaming, no
 * window handle needed. `explorer:listDir` (Cluster C — one-level lazy listing)
 * and `explorer:search` (Cluster F — recursive, gitignore-pruned finder), plus
 * `explorer:resolve` (transcript path tokens → real, revealable entries).
 */
export function registerExplorerHandlers(): void {
  ipcMain.handle(
    'explorer:listDir',
    (_e, args: { root: string; dir: string }): Promise<ExplorerListing> => {
      const { root, dir } = args ?? ({} as { root: string; dir: string })
      return listDir(root, dir)
    }
  )
  ipcMain.handle(
    'explorer:search',
    (_e, args: { root: string; query: string }): Promise<ExplorerSearchResult> => {
      const { root, query } = args ?? ({} as { root: string; query: string })
      return searchFiles(root, query)
    }
  )
  ipcMain.handle(
    'explorer:resolve',
    (_e, args: { root: string; cwd: string; candidates: string[] }): Promise<ResolvedPath[]> => {
      const { root, cwd, candidates } =
        args ?? ({} as { root: string; cwd: string; candidates: string[] })
      return resolvePaths(root, cwd, candidates)
    }
  )
}
