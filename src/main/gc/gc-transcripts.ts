// Every Claude transcript on disk, for the one question grace asks: when was anything last
// done under this folder? (design: workspace-gc §3.4; T441 delta 4, N2 and N3). The sidebar's
// reader (claude-reader.ts) deliberately lists interactive sessions only and trusts a legacy
// `sessions-index.json` over the files; both are right for a sidebar and wrong for grace:
// `claude -p` writes `entrypoint: "sdk-cli"`, as do Harnu's own Scheduler workers, and an index
// older than its newest transcript misses it. So this reads every transcript's mtime whatever
// wrote it, plus the index entries, and the newest wins. Pure over an injected probe; the
// real probe is `fsTranscriptProbe`. It never changes what the sidebar lists.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeBundle } from './bundle-core'

export interface TranscriptProbe {
  listProjectDirs(): Promise<string[]>
  /** The legacy index of a project folder, or null when it has none. */
  readIndex(
    slug: string
  ): Promise<Array<{ projectPath?: string; fileMtime?: number; modified?: string }> | null>
  listJsonl(slug: string): Promise<Array<{ name: string; mtimeMs: number }>>
  /** The folder a transcript belongs to, or null when it cannot be told. */
  cwdOf(slug: string, name: string, mtimeMs: number): Promise<string | null>
}

/** The same shape the fleet gives per folder, so the session builder takes either. */
export interface ActivityFolder {
  path: string
  sessions: ReadonlyArray<{ fileMtime?: number; modified?: string }>
}

/** The first non-empty string `cwd` among the lines of a transcript head, whatever its entrypoint. */
export function cwdFromTranscriptHead(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // not a JSON line (a partial last line of the head, say)
    }
  }
  return null
}

const BATCH = 16

export interface TranscriptScan {
  /** Transcripts and index entries whose folder is known. */
  folders: ActivityFolder[]
  /**
   * Transcripts whose folder could not be told (unreadable, no `cwd` in the head, the project
   * folder could not be listed). Their only clue is the project slug; see {@link attributeBySlug}.
   */
  bySlug: Array<{ slug: string; mtimeMs: number }>
  /** The projects root itself could not be read: nothing can be said about any folder. */
  rootUnreadable: boolean
}

/** The folder name Claude gives a project directory: every non-alphanumeric becomes a dash. */
export function slugOfPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Activity for the folders in `paths` from transcripts known only by slug. Slug decoding is
 * lossy, so this over-attributes on purpose (a sibling whose name starts the same counts): the
 * safe direction for grace is "more in use". A path matches its own slug and any slug that
 * continues it, which is how subfolders encode.
 */
export function attributeBySlug(
  bySlug: ReadonlyArray<{ slug: string; mtimeMs: number }>,
  paths: readonly string[]
): ActivityFolder[] {
  const out: ActivityFolder[] = []
  for (const path of new Set(paths)) {
    const own = slugOfPath(path)
    const sessions = bySlug
      .filter((e) => e.slug === own || e.slug.startsWith(`${own}-`))
      .map((e) => ({ fileMtime: e.mtimeMs }))
    if (sessions.length > 0) out.push({ path, sessions })
  }
  return out
}

/**
 * Every transcript on disk, one entry per folder, with the time of every transcript and index
 * entry that names it. It fails closed: whatever cannot be attributed to a folder is returned
 * by slug, and an unreadable root is reported, never read as "no activity".
 */
export async function scanTranscripts(
  probe: TranscriptProbe,
  now: number
): Promise<TranscriptScan> {
  const byPath = new Map<string, Array<{ fileMtime?: number; modified?: string }>>()
  const bySlug: TranscriptScan['bySlug'] = []
  const add = (path: string, s: { fileMtime?: number; modified?: string }): void => {
    const list = byPath.get(path) ?? []
    list.push(s)
    byPath.set(path, list)
  }
  let slugs: string[]
  try {
    slugs = await probe.listProjectDirs()
  } catch {
    return { folders: [], bySlug: [], rootUnreadable: true }
  }
  for (const slug of slugs) {
    try {
      for (const e of (await probe.readIndex(slug)) ?? []) {
        if (typeof e.projectPath === 'string' && e.projectPath) {
          add(e.projectPath, { fileMtime: e.fileMtime, modified: e.modified })
        }
      }
    } catch {
      // The index is an extra; the transcripts below are always read.
    }
    let files: Array<{ name: string; mtimeMs: number }>
    try {
      files = await probe.listJsonl(slug)
    } catch {
      // Cannot tell what ran here: treat the project as active right now.
      bySlug.push({ slug, mtimeMs: now })
      continue
    }
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async (f) => {
          const cwd = await probe.cwdOf(slug, f.name, f.mtimeMs).catch(() => null)
          if (cwd) add(cwd, { fileMtime: f.mtimeMs })
          else bySlug.push({ slug, mtimeMs: f.mtimeMs })
        })
      )
    }
  }
  return {
    folders: [...byPath].map(([path, sessions]) => ({ path, sessions })),
    bySlug,
    rootUnreadable: false
  }
}

/** The folders alone, for callers that do not need the fail-closed leftovers. */
export async function transcriptFolders(probe: TranscriptProbe): Promise<ActivityFolder[]> {
  return (await scanTranscripts(probe, Date.now())).folders
}

/**
 * When the transcripts root could not be read nothing can be said about recent activity, so
 * nothing is ready this gather. Uses the code that already means "the session state of this
 * worktree is unknown".
 */
export function withGraceUnknown(bundles: readonly WorktreeBundle[]): WorktreeBundle[] {
  return bundles.map((b) =>
    b.bucket === 'ready'
      ? {
          ...b,
          bucket: 'review' as const,
          reason: {
            code: 'open-idle-session' as const,
            detail:
              "Harnu could not read Claude's transcripts folder, so it cannot tell whether anything ran in this worktree recently."
          }
        }
      : b
  )
}

/** The fleet's folders and the transcript folders as one list, one entry per folder. */
export function mergeActivityFolders(
  fleet: readonly ActivityFolder[],
  transcripts: readonly ActivityFolder[]
): ActivityFolder[] {
  const byPath = new Map<string, ActivityFolder['sessions'][number][]>()
  for (const f of [...fleet, ...transcripts]) {
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), ...f.sessions])
  }
  return [...byPath].map(([path, sessions]) => ({ path, sessions }))
}

// ---- the real filesystem ---------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024
/** A transcript's folder never changes as it grows, so a read answer is kept for the session. */
const cwdCache = new Map<string, string>()

export function fsTranscriptProbe(root = join(homedir(), '.claude', 'projects')): TranscriptProbe {
  return {
    listProjectDirs: async () => {
      try {
        return (await fs.readdir(root, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch (err) {
        // No root at all means Claude never recorded anything; any other failure is unreadable.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
    readIndex: async (slug) => {
      try {
        const idx = JSON.parse(
          await fs.readFile(join(root, slug, 'sessions-index.json'), 'utf8')
        ) as {
          entries?: unknown
        }
        return Array.isArray(idx.entries) ? (idx.entries as never) : null
      } catch {
        return null
      }
    },
    listJsonl: async (slug) => {
      const dir = join(root, slug)
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
      const out: Array<{ name: string; mtimeMs: number }> = []
      for (const name of names) {
        // A file that cannot be stat'ed may well be active: count it as modified right now.
        const st = await fs.stat(join(dir, name)).catch(() => null)
        out.push({ name, mtimeMs: st ? st.mtimeMs : Date.now() })
      }
      return out
    },
    cwdOf: async (slug, name) => {
      const file = join(root, slug, name)
      const known = cwdCache.get(file)
      if (known) return known
      const fh = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(HEAD_BYTES)
        const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
        const cwd = cwdFromTranscriptHead(buf.toString('utf8', 0, bytesRead))
        if (cwd) cwdCache.set(file, cwd)
        return cwd
      } finally {
        await fh.close()
      }
    }
  }
}
