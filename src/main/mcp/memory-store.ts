/**
 * Env-bound shell for Project Memory (T79 S1): the fs + git-probe marshaling
 * around the pure {@link ../mcp/memory-core} decisions. Resolves a folder to the
 * checkout that OWNS its `.harnu/memory/`, lazily scaffolds the layout on first
 * write, serializes writes through the main process (so the multi-writer problem
 * vaults solve with lock-scripts never exists — §3.3), and regenerates the
 * deterministic `index.md` after every write.
 *
 * env-bound (`node:fs` + `probeGitMeta`) ⇒ e2e-only per ADR-0001; the accept/
 * reject/format math lives in `memory-core.ts` and is unit-tested. This module
 * only does the effect.
 */

import { promises as fs, type Dirent } from 'node:fs'
import * as path from 'node:path'
import { probeGitMeta } from '../git-probe'
import { resolveEffectiveMemoryConfig } from '../memory-location'
import {
  buildMemoryIndex,
  buildMemoryWrite,
  buildTimeline,
  buildWhereBacklink,
  extractHotPreview,
  formatMemoryDate,
  grepMemory,
  parseCardMeta,
  parseMemoryPage,
  resolveMemoryCheckout,
  resolveMemoryDir,
  resolvePageFile,
  validateEntry,
  WHERE_FILE,
  type DigestFile,
  type DigestMeta,
  type IndexCard,
  type MemoryAuthor,
  type MemoryFile,
  type MemoryLocationConfig,
  type MemoryMatch,
  type MemoryStorageMode,
  type Provenance
} from './memory-core'
import { dataDirReady, mkdirDataDir } from '../data-dir'

/** Where a folder's project memory lives, plus the branch to stamp on writes. */
export interface MemoryLocation {
  /** Absolute memory dir serving this folder (in-project `.harnu/memory/` or a central folder). */
  memoryDir: string
  /** The folder's git branch (for provenance), when on one. */
  branch?: string
  /** The repo's MAIN checkout path (source project) — for `where.md` + migration. */
  checkout: string
  /** Where {@link memoryDir} lives relative to the repo (T89). */
  mode: MemoryStorageMode
}

/**
 * Resolve the folder to the memory dir that serves it (§3.1 + T89), collapsing
 * any worktree onto its main checkout via the git common-dir and then consulting
 * the effective memory-location config (per-project override → global default).
 * `in-project` keeps memory at `<checkout>/.harnu/memory/` (unchanged); `central`
 * redirects it to a collision-proof folder under the configured root. Also returns
 * the folder's branch so the caller can stamp it into provenance.
 */
export async function resolveMemoryLocation(folder: string): Promise<MemoryLocation> {
  const meta = await probeGitMeta(folder)
  const checkout = resolveMemoryCheckout(folder, meta.repoId)
  // A repo that was never pinned (so the boot pass never saw it) gets its legacy
  // `.capy/` copied the first time its memory is resolved.
  await dataDirReady(checkout)
  const config = await resolveEffectiveMemoryConfig(checkout)
  const out: MemoryLocation = {
    memoryDir: resolveMemoryDir(folder, meta.repoId, config),
    checkout,
    mode: config.mode
  }
  if (meta.gitBranch) out.branch = meta.gitBranch
  return out
}

// ---- Small fs helpers -------------------------------------------------------

/** Read a UTF-8 file, or `null` when it does not exist (other errors rethrow). */
async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** `.md` filenames directly inside `dir` (sorted); `[]` when the dir is absent. */
async function listMd(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names.filter((n) => n.endsWith('.md')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Write a file only if it does not already exist (user files stay sovereign). */
async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    throw err
  }
}

// ---- Scaffold (lazy, on first write) ---------------------------------------

const HOT_SEED =
  '# Harnu — hot (where we left off)\n' +
  '> ≤500 words · 1s resume cue · edit by hand or via memory_append(page:hot) (replace).\n\n' +
  '_(memory just created — no state recorded yet)_\n'

const DECISIONS_SEED =
  '# Harnu — decisions (append-only, most recent at the bottom)\n' +
  '> Each entry: date · decision · why · provenance (stamped by Harnu). Do not edit old entries — only append at the bottom.\n'

/**
 * Lazily scaffold the memory layout on first write (§3.1): create the memory +
 * `sessions/` dirs and seed `hot.md`/`decisions.md`/`index.md` if absent.
 * Idempotent and non-destructive — an existing file is never touched. When
 * `backlink` is given (central storage, T89) a `where.md` is also seeded so a
 * human browsing the central root — and Harnu — can find the source project.
 */
export async function ensureScaffold(
  memoryDir: string,
  now: number,
  backlink?: { sourcePath: string }
): Promise<void> {
  await mkdirDataDir(path.join(memoryDir, 'sessions'))
  await writeIfAbsent(path.join(memoryDir, 'hot.md'), HOT_SEED)
  await writeIfAbsent(path.join(memoryDir, 'decisions.md'), DECISIONS_SEED)
  if (backlink) {
    await writeIfAbsent(
      path.join(memoryDir, WHERE_FILE),
      buildWhereBacklink({ sourcePath: backlink.sourcePath, generatedAt: formatMemoryDate(now) })
    )
  }
  await regenerateIndex(memoryDir, now)
}

// ---- Index regeneration (deterministic, on every write) ---------------------

/**
 * Regenerate the Harnu-managed `index.md` by scanning the memory dir (§3.4).
 * Deterministic + cheap; the user's other files stay sovereign — the index is
 * purely derived, so deleting/editing by hand never corrupts anything.
 */
export async function regenerateIndex(memoryDir: string, now: number): Promise<void> {
  const [hot, decisions, cardFiles, sessions, archive, learning] = await Promise.all([
    readMaybe(path.join(memoryDir, 'hot.md')),
    readMaybe(path.join(memoryDir, 'decisions.md')),
    listMd(path.join(memoryDir, 'roadmap')),
    listMd(path.join(memoryDir, 'sessions')),
    listMd(path.join(memoryDir, 'archive')),
    listMd(path.join(memoryDir, 'learning'))
  ])

  const cards: IndexCard[] = []
  for (const name of cardFiles) {
    const content = await readMaybe(path.join(memoryDir, 'roadmap', name))
    const meta = content ? parseCardMeta(content) : {}
    cards.push({ ...meta, page: `roadmap/${name.replace(/\.md$/, '')}` })
  }

  const index = buildMemoryIndex({
    hasHot: hot !== null,
    hasDecisions: decisions !== null,
    cards,
    sessions,
    archive,
    learning,
    generatedAt: formatMemoryDate(now)
  })
  await fs.writeFile(path.join(memoryDir, 'index.md'), index, 'utf8')
}

// ---- Read -------------------------------------------------------------------

/** The tiered top a page-less `memory_read` returns (`hot` + catalog + page list). */
export interface MemoryOverview {
  hot: string
  index: string
  pages: string[]
}

/** List every readable page id under the memory dir (root + roadmap/sessions/archive/learning). */
async function listReadablePages(memoryDir: string): Promise<string[]> {
  const [root, roadmap, sessions, archive, learning] = await Promise.all([
    listMd(memoryDir),
    listMd(path.join(memoryDir, 'roadmap')),
    listMd(path.join(memoryDir, 'sessions')),
    listMd(path.join(memoryDir, 'archive')),
    listMd(path.join(memoryDir, 'learning'))
  ])
  const strip = (n: string): string => n.replace(/\.md$/, '')
  return [
    ...root.map(strip),
    ...roadmap.map((n) => `roadmap/${strip(n)}`),
    ...sessions.map((n) => `sessions/${strip(n)}`),
    ...archive.map((n) => `archive/${strip(n)}`),
    ...learning.map((n) => `learning/${strip(n)}`)
  ]
}

/**
 * The page-less `memory_read`: the tiered top (`hot.md` + `index.md` + the page
 * list). Returns `null` when no memory exists yet for the folder (a fresh repo).
 */
export async function readMemoryOverview(memoryDir: string): Promise<MemoryOverview | null> {
  const hot = await readMaybe(path.join(memoryDir, 'hot.md'))
  const index = await readMaybe(path.join(memoryDir, 'index.md'))
  const pages = await listReadablePages(memoryDir)
  if (hot === null && index === null && pages.length === 0) return null
  return { hot: hot ?? '', index: index ?? '', pages }
}

/** Read outcome for a single memory page. */
export type ReadPageResult =
  | { ok: true; page: string; content: string }
  | { ok: false; error: 'BAD_PAGE' | 'PAGE_NOT_FOUND'; detail: string }

/** Read one named memory page's content (traversal-safe via the page gate). */
export async function readMemoryPage(memoryDir: string, page: string): Promise<ReadPageResult> {
  const parsed = parseMemoryPage(page)
  if (!parsed.ok) return { ok: false, error: 'BAD_PAGE', detail: parsed.detail }
  const file = resolvePageFile(memoryDir, parsed.value)
  if (!file) return { ok: false, error: 'BAD_PAGE', detail: 'page escapes the memory directory' }
  const content = await readMaybe(file)
  if (content === null) {
    return {
      ok: false,
      error: 'PAGE_NOT_FOUND',
      detail: `page "${parsed.value.page}" does not exist yet`
    }
  }
  return { ok: true, page: parsed.value.page, content }
}

// ---- UI read (the memory pane + folder-hover, T79 S3) -----------------------

/**
 * Everything the memory UI (§4.2) needs for a folder in one confined read: the
 * full `hot.md` + `decisions.md`, a trimmed `hotPreview` for the 1s folder-hover
 * cue, and the parsed `timeline` of `sessions/` digests (newest first, with
 * provenance). Resolves the folder to the repo's shared memory like every verb
 * (§3.1), so a worktree sees the SAME spotlight. `exists` is false for a repo
 * that has no memory yet — the UI renders an honest empty state, never an error.
 */
export interface MemoryPaneData {
  /** Whether any memory content exists yet for this repo. */
  exists: boolean
  /** Absolute `.harnu/memory/` path serving this folder (for display/debug). */
  memoryDir: string
  /** The folder's git branch, when on one (for the pane header context). */
  branch?: string
  /** Full `hot.md`, or `null` when absent. */
  hot: string | null
  /** Trimmed top of `hot.md` for the folder-hover card (`''` when no content). */
  hotPreview: string
  /** Full `decisions.md`, or `null` when absent. */
  decisions: string | null
  /** Parsed session digests, newest first. */
  timeline: DigestMeta[]
}

/**
 * Read the UI-facing memory bundle for a folder (T79 S3). Env-bound (git probe +
 * fs) ⇒ e2e-only per ADR-0001; the trimming/parsing math lives in `memory-core`
 * (`extractHotPreview` / `buildTimeline`) and is unit-tested. Non-destructive —
 * a read never scaffolds (unlike a write): an absent memory yields `exists:false`.
 */
export async function readMemoryForFolder(folder: string): Promise<MemoryPaneData> {
  const { memoryDir, branch } = await resolveMemoryLocation(folder)
  const [hot, decisions, digestNames] = await Promise.all([
    readMaybe(path.join(memoryDir, 'hot.md')),
    readMaybe(path.join(memoryDir, 'decisions.md')),
    listMd(path.join(memoryDir, 'sessions'))
  ])

  const digestFiles: DigestFile[] = []
  for (const name of digestNames) {
    const content = await readMaybe(path.join(memoryDir, 'sessions', name))
    if (content !== null) digestFiles.push({ name, content })
  }
  const timeline = buildTimeline(digestFiles)

  const data: MemoryPaneData = {
    exists: hot !== null || decisions !== null || timeline.length > 0,
    memoryDir,
    hot,
    hotPreview: hot ? extractHotPreview(hot) : '',
    decisions,
    timeline
  }
  if (branch) data.branch = branch
  return data
}

// ---- Append (the serialized mutation) --------------------------------------

/** Outcome of a `memory_append`. */
export type AppendResult =
  | { ok: true; page: string; file: string; bytes: number }
  | {
      ok: false
      error: 'BAD_PAGE' | 'BAD_ENTRY' | 'PAGE_NOT_FOUND' | 'PATH_ESCAPE'
      detail: string
    }

/**
 * Append (or, for `hot.md`, replace) a body entry with server-stamped
 * provenance (§3.3). Body-only: YAML frontmatter/`status` is never touched
 * (card frontmatter mutation is T80). `author` is derived from the authenticated
 * caller — NEVER from the entry content. Serialized through the main process, so
 * concurrent writers can't corrupt the file. Regenerates `index.md` on success.
 */
export async function appendMemoryEntry(input: {
  memoryDir: string
  page: string
  entry: string
  author: MemoryAuthor
  branch?: string
  sessionId?: string
  now: number
  /** Central storage (T89): seed `where.md` pointing back at this source project. */
  backlink?: { sourcePath: string }
}): Promise<AppendResult> {
  const parsed = parseMemoryPage(input.page)
  if (!parsed.ok) return { ok: false, error: 'BAD_PAGE', detail: parsed.detail }
  const check = validateEntry(parsed.value, input.entry)
  if (!check.ok) return { ok: false, error: 'BAD_ENTRY', detail: check.detail }

  await ensureScaffold(input.memoryDir, input.now, input.backlink)

  const file = resolvePageFile(input.memoryDir, parsed.value)
  if (!file) return { ok: false, error: 'PATH_ESCAPE', detail: 'page escapes the memory directory' }

  const existing = await readMaybe(file)
  if (parsed.value.requireExists && existing === null) {
    return {
      ok: false,
      error: 'PAGE_NOT_FOUND',
      detail: `card "${parsed.value.page}" does not exist — creating cards is not available via memory_append (that is the roadmap-kanban path)`
    }
  }

  const provenance: Provenance = { author: input.author, at: formatMemoryDate(input.now) }
  if (input.branch) provenance.branch = input.branch
  if (input.sessionId) provenance.sessionId = input.sessionId

  const content = buildMemoryWrite({
    existing: existing ?? '',
    entry: input.entry,
    provenance,
    mode: parsed.value.mode
  })

  await mkdirDataDir(path.dirname(file))
  await fs.writeFile(file, content, 'utf8')
  await regenerateIndex(input.memoryDir, input.now)

  return {
    ok: true,
    page: parsed.value.page,
    file: parsed.value.file,
    bytes: Buffer.byteLength(content)
  }
}

// ---- Query ------------------------------------------------------------------

/** Read every `.md` under the memory dir into {@link MemoryFile}s for grep. */
async function readAllMemoryFiles(memoryDir: string): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const strip = (n: string): string => n.replace(/\.md$/, '')

  for (const name of await listMd(memoryDir)) {
    const content = await readMaybe(path.join(memoryDir, name))
    if (content !== null) out.push({ page: strip(name), content })
  }
  for (const dir of ['roadmap', 'sessions', 'archive', 'learning']) {
    for (const name of await listMd(path.join(memoryDir, dir))) {
      const content = await readMaybe(path.join(memoryDir, dir, name))
      if (content !== null) out.push({ page: `${dir}/${strip(name)}`, content })
    }
  }
  return out
}

/**
 * The v1 `memory_query`: a serialized server-side grep across the memory dir
 * (§3.3). Returns bounded matches; an absent memory dir yields no matches.
 */
export async function queryMemory(
  memoryDir: string,
  query: string
): Promise<{ matches: MemoryMatch[]; truncated: boolean }> {
  const files = await readAllMemoryFiles(memoryDir)
  return grepMemory(files, query)
}

// ---- Assisted migration (T89) ----------------------------------------------

/** Machine-readable outcome of a single-repo memory move (the renderer localizes). */
export type MigrationCode =
  'moved' | 'nothing-to-move' | 'same-location' | 'target-exists' | 'failed'

/** Report of one repo's memory migration — fs move + verify (T89 guardrail). */
export interface MemoryMigrationReport {
  ok: boolean
  code: MigrationCode
  /** Absolute source memory dir. */
  from: string
  /** Absolute destination memory dir. */
  to: string
  /** Relative file paths moved (only when `code === 'moved'`). */
  movedFiles: string[]
  /** Human-readable extra context (errors, verify failures). */
  detail?: string
}

/** Relative paths of every file under `dir` (recursive); `[]` when absent. */
async function listAllFilesRel(dir: string, base: string = dir): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listAllFilesRel(abs, base)))
    else out.push(path.relative(base, abs))
  }
  return out
}

/** Names directly under `dir` (non-recursive); `[]` when absent. */
async function dirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Move a repo's memory dir from `fromDir` to `toDir` (T89 assisted migration):
 * refuse to clobber a non-empty destination, prefer an atomic `rename`, fall back
 * to copy+remove across filesystems (Drive/external disk are commonly a different
 * device), then VERIFY every source file landed. Never silently orphans — every
 * outcome is reported with a machine code.
 */
export async function moveMemoryDir(
  fromDir: string,
  toDir: string
): Promise<MemoryMigrationReport> {
  const base: MemoryMigrationReport = {
    ok: false,
    code: 'failed',
    from: fromDir,
    to: toDir,
    movedFiles: []
  }
  if (path.resolve(fromDir) === path.resolve(toDir)) {
    return { ...base, ok: true, code: 'same-location' }
  }

  const srcFiles = await listAllFilesRel(fromDir)
  if (srcFiles.length === 0) return { ...base, ok: true, code: 'nothing-to-move' }

  const destEntries = await dirEntries(toDir)
  if (destEntries.length > 0) {
    return { ...base, code: 'target-exists', detail: 'destination already holds memory' }
  }

  try {
    await mkdirDataDir(path.dirname(toDir))
    // Remove an empty stub destination so `rename` doesn't collide on it.
    await fs.rm(toDir, { recursive: true, force: true })
    try {
      await fs.rename(fromDir, toDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Cross-device: copy then remove the source.
        await fs.cp(fromDir, toDir, { recursive: true })
        await fs.rm(fromDir, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    // Verify: every source file exists at the destination.
    const destFiles = new Set(await listAllFilesRel(toDir))
    const missing = srcFiles.filter((f) => !destFiles.has(f))
    if (missing.length > 0) {
      return { ...base, code: 'failed', detail: `verify failed: ${missing.length} file(s) missing` }
    }
    return { ok: true, code: 'moved', from: fromDir, to: toDir, movedFiles: srcFiles }
  } catch (err) {
    return { ...base, code: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Migrate ONE repo's memory between two configs (T89). Probes git once to resolve
 * both the source and destination memory dirs (so a worktree collapses to its
 * checkout), then delegates to {@link moveMemoryDir}. Used when a per-project
 * override changes, and per-repo inside the global batch.
 */
export async function migrateMemory(input: {
  folder: string
  from: MemoryLocationConfig
  to: MemoryLocationConfig
}): Promise<MemoryMigrationReport> {
  const meta = await probeGitMeta(input.folder)
  const fromDir = resolveMemoryDir(input.folder, meta.repoId, input.from)
  const toDir = resolveMemoryDir(input.folder, meta.repoId, input.to)
  return moveMemoryDir(fromDir, toDir)
}
