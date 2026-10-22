/**
 * `browser_upload`, pure core (T572 U5, spec §6.1 row 17, §6.2, decision 24): which files an agent may hand to a
 * page's `<input type=file>`. Only files INSIDE the pane's folder leave, nothing that looks like a secret, nothing
 * huge, and a symlink never lets a path out. The lexical half runs at plan level (before any confirm, §6.3); the
 * real-path half runs in the handler with the filesystem injected, so both are tested without a disk.
 */
import * as path from 'node:path'

export const MAX_UPLOAD_FILES = 10
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** The names an upload never takes, however the path got there (spec §6.2): `.git/**`, `.env*`, `*.pem`, `*.key`, `id_*`. */
export function forbiddenUploadReason(p: string): string | null {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  if (parts.some((s) => s.toLowerCase() === '.git')) return 'it is inside .git'
  const base = (parts[parts.length - 1] ?? '').toLowerCase()
  if (base === '.env' || base.startsWith('.env.')) return 'it is an .env file'
  if (base.endsWith('.pem') || base.endsWith('.key')) return 'it is a key file'
  if (base.startsWith('id_')) return 'it looks like an SSH key'
  return null
}

export type UploadRefusalCode = 'BAD_ARGS' | 'UPLOAD_PATH_DENIED' | 'UPLOAD_TOO_LARGE'

export interface UploadRefusal {
  code: UploadRefusalCode
  detail: string
}

/** The plan-level checks of the arguments alone (no filesystem): the count and the forbidden names. */
export function checkUploadArgs(args: Record<string, unknown>): UploadRefusal | null {
  const paths = args.paths
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((p) => typeof p !== 'string' || p === '')
  ) {
    return { code: 'BAD_ARGS', detail: '`paths` is a list of 1..10 file paths.' }
  }
  if (paths.length > MAX_UPLOAD_FILES) {
    return { code: 'BAD_ARGS', detail: `At most ${MAX_UPLOAD_FILES} files per call.` }
  }
  for (const p of paths as string[]) {
    const why = forbiddenUploadReason(p)
    if (why) return { code: 'UPLOAD_PATH_DENIED', detail: `${shorten(p)}: ${why}.` }
  }
  return null
}

function shorten(p: string): string {
  const chars = [...p]
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : p
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface UploadIo {
  realpath(p: string): Promise<string>
  /** `null` when the path does not exist; `kind` tells a regular file from anything else. */
  stat(p: string): Promise<{ kind: 'file' | 'other'; size: number } | null>
}

export type UploadPlan =
  | { ok: true; files: Array<{ path: string; name: string; bytes: number }> }
  | ({ ok: false } & UploadRefusal)

/**
 * Resolve and vet every path. A path is relative to the folder or absolute; it must resolve (lexically, then through
 * every symlink) inside the folder's real path, be a regular file, not be a forbidden name at any step, and be at most
 * {@link MAX_UPLOAD_BYTES}. A path that lexically leaves the folder is refused WITHOUT touching the disk, so the
 * answer never says whether a file outside the folder exists. All-or-nothing: one bad path refuses the call.
 */
export async function planUpload(opts: {
  folder: string
  paths: readonly string[]
  io: UploadIo
}): Promise<UploadPlan> {
  const argRefusal = checkUploadArgs({ paths: [...opts.paths] })
  if (argRefusal) return { ok: false, ...argRefusal }
  let rootReal: string
  try {
    rootReal = await opts.io.realpath(opts.folder)
  } catch {
    return { ok: false, code: 'UPLOAD_PATH_DENIED', detail: 'The pane folder is not readable.' }
  }
  const root = path.resolve(opts.folder)
  const files: Array<{ path: string; name: string; bytes: number }> = []
  for (const given of opts.paths) {
    const abs = path.resolve(root, given)
    if (!inside(root, abs)) {
      return {
        ok: false,
        code: 'UPLOAD_PATH_DENIED',
        detail: `${shorten(given)}: it is outside the pane's folder.`
      }
    }
    let real: string
    try {
      real = await opts.io.realpath(abs)
    } catch {
      return { ok: false, code: 'UPLOAD_PATH_DENIED', detail: `${shorten(given)}: not found.` }
    }
    if (!inside(rootReal, real)) {
      return {
        ok: false,
        code: 'UPLOAD_PATH_DENIED',
        detail: `${shorten(given)}: it leaves the folder through a link.`
      }
    }
    // The forbidden names apply to where the path really points, too (a link called notes.txt to .git/config).
    const why = forbiddenUploadReason(path.relative(rootReal, real))
    if (why) return { ok: false, code: 'UPLOAD_PATH_DENIED', detail: `${shorten(given)}: ${why}.` }
    const st = await opts.io.stat(real)
    if (!st)
      return { ok: false, code: 'UPLOAD_PATH_DENIED', detail: `${shorten(given)}: not found.` }
    if (st.kind !== 'file') {
      return {
        ok: false,
        code: 'UPLOAD_PATH_DENIED',
        detail: `${shorten(given)}: not a regular file.`
      }
    }
    if (st.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        code: 'UPLOAD_TOO_LARGE',
        detail: `${shorten(given)}: over ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB.`
      }
    }
    files.push({ path: real, name: path.basename(real), bytes: st.size })
  }
  return { ok: true, files }
}
