/**
 * `harnu-page://` URL codec, path jail, MIME and response policy (T564 U2, spec §4.1–§4.3). Pure over an
 * injected file-system seam (ADR-0001), so the hostile-path cases are unit-tested without touching a disk.
 *
 * ```
 * harnu-page://f<folderId>/<posix path relative to that folder>[?query][#hash]
 * ```
 *
 * `folderId` is the first 12 hex characters of `sha256(realpath(folder))`; each folder is its own origin.
 */
import { createHash } from 'node:crypto'
import * as path from 'node:path'

export const PAGE_SCHEME = 'harnu-page'
/**
 * The privileges the scheme is registered with (spec §4.1): standard, secure, fetch, streaming. Deliberately NOT
 * `bypassCSP` (the §4.3 policy must bind our own pages), NOT `allowServiceWorkers` and NOT `corsEnabled`.
 */
export const PAGE_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true
} as const
export const FOLDER_ID_LENGTH = 12
/** `html` served to a pane is capped (spec §4.2 step 5). */
export const MAX_PAGE_HTML_BYTES = 8 * 1024 * 1024

/** The first 12 hex characters of `sha256(realpath(folder))`. */
export function folderIdOf(realFolder: string): string {
  return createHash('sha256').update(realFolder).digest('hex').slice(0, FOLDER_ID_LENGTH)
}

/** The URL host of a folder: `f<folderId>`. */
export function pageHostFor(folderId: string): string {
  return `f${folderId}`
}

/** Build the address of `relPath` (posix, relative to the folder). Each segment is percent-encoded. */
export function buildPageUrl(folderId: string, relPath: string): string {
  const encoded = relPath
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return `${PAGE_SCHEME}://${pageHostFor(folderId)}/${encoded}`
}

export interface ParsedPageUrl {
  folderId: string
  /** Decoded posix path with no leading slash; `''` for the folder root. */
  relPath: string
  /** The decoded segments (never `.`/`..`/empty). */
  segments: string[]
}

const HOST_RE = new RegExp(`^f([0-9a-f]{${FOLDER_ID_LENGTH}})$`)

/**
 * Parse and sanitise a `harnu-page:` address. Returns `null` for anything that is not a well-formed address
 * of a folder host, or whose path holds a NUL, a `..`/`.` segment, an encoded separator or a backslash
 * (spec §4.2 step 1). The WHATWG parser has already resolved literal `.`/`..` segments, so a `..` that
 * survives here arrived percent-encoded and is refused.
 */
export function parsePageUrl(raw: string): ParsedPageUrl | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${PAGE_SCHEME}:`) return null
  const host = HOST_RE.exec(url.hostname)
  if (!host) return null
  const segments: string[] = []
  for (const part of url.pathname.split('/')) {
    if (part === '') continue
    let seg: string
    try {
      seg = decodeURIComponent(part)
    } catch {
      return null
    }
    if (seg === '.' || seg === '..') return null
    if (/[\0/\\]/.test(seg)) return null
    segments.push(seg)
  }
  return { folderId: host[1]!, relPath: segments.join('/'), segments }
}

/** Whether a decoded relative path lies in the parts a page may never read (spec §4.2 step 4). */
export function isDeniedPagePath(segments: readonly string[]): boolean {
  const lower = segments.map((s) => s.toLowerCase())
  if (lower.includes('.git')) return true
  return lower[0] === '.harnu' && lower[1] === 'memory'
}

/* ---- MIME ------------------------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function isHtmlFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase()
  return ext === '.html' || ext === '.htm'
}

/* ---- Response policy (spec §4.3) --------------------------------------------------------------- */

/** Offline by default: a patched `<img src="https://x/?d=…">` has nowhere to go (spec §4.3, Q3). */
export const PAGE_CSP_OFFLINE =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; form-action 'none'; frame-src 'none'; base-uri 'self'"

/** With the operator's per-pane "Allow network" switch on. No verb can turn it on. */
export const PAGE_CSP_NETWORK = "default-src * data: blob: 'unsafe-inline'"

export function pageCsp(allowNetwork: boolean): string {
  return allowNetwork ? PAGE_CSP_NETWORK : PAGE_CSP_OFFLINE
}

export function pageResponseHeaders(mime: string, allowNetwork: boolean): Record<string, string> {
  return {
    'Content-Type': mime,
    'Content-Security-Policy': pageCsp(allowNetwork),
    'X-Content-Type-Options': 'nosniff',
    // The cache would hide a file edit from the reload (spec §4.4).
    'Cache-Control': 'no-store'
  }
}

/* ---- The jail ----------------------------------------------------------------------------------- */

/** The file-system seam of the jail: only what it needs, so a test can fake a hostile tree. */
export interface JailFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>
}

export interface PageFolder {
  /** The folder path as Harnu knows it. */
  folder: string
  /** `realpath(folder)`. */
  realFolder: string
}

export type JailFailure =
  | 'bad-path'
  | 'unknown-folder'
  | 'blocked'
  | 'denied-path'
  | 'escape'
  | 'not-found'
  | 'directory'
  | 'too-large'

export type JailVerdict =
  | {
      ok: true
      folder: string
      realFolder: string
      realPath: string
      relPath: string
      size: number
    }
  | { ok: false; reason: JailFailure; status: 400 | 403 | 404 | 413 }

const STATUS: Record<JailFailure, 400 | 403 | 404 | 413> = {
  'bad-path': 400,
  'unknown-folder': 404,
  blocked: 403,
  'denied-path': 403,
  escape: 403,
  'not-found': 404,
  directory: 404,
  'too-large': 413
}

function fail(reason: JailFailure): JailVerdict {
  return { ok: false, reason, status: STATUS[reason] }
}

function relativeSegments(realFolder: string, realPath: string): string[] | null {
  const rel = path.relative(realFolder, realPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep)
}

export interface JailRequest {
  url: string
  /** Every known folder, keyed by folder id. */
  folders: ReadonlyMap<string, PageFolder>
  /** The operator's block, re-checked on EVERY request (spec §4.2 step 3). */
  isBlocked(folder: string): boolean
  fs: JailFs
  maxHtmlBytes?: number
}

/**
 * Resolve a `harnu-page:` request to a real file inside a known, unblocked folder (spec §4.2), or say why not.
 * Order: parse (NUL, `..`, encoded separators) → known folder → blocked → denied parts → `realpath` and the
 * containment test (symlinks that escape) → denied parts again on the REAL path (a symlink into `.git`) →
 * directory and size.
 */
export async function jailResolve(req: JailRequest): Promise<JailVerdict> {
  const parsed = parsePageUrl(req.url)
  if (!parsed) return fail('bad-path')
  const known = req.folders.get(parsed.folderId)
  if (!known) return fail('unknown-folder')
  if (req.isBlocked(known.folder)) return fail('blocked')
  if (parsed.segments.length === 0) return fail('directory')
  if (isDeniedPagePath(parsed.segments)) return fail('denied-path')

  let realPath: string
  try {
    realPath = await req.fs.realpath(path.join(known.realFolder, ...parsed.segments))
  } catch {
    return fail('not-found')
  }
  const realSegments = relativeSegments(known.realFolder, realPath)
  if (!realSegments) return fail('escape')
  if (isDeniedPagePath(realSegments)) return fail('denied-path')

  let st: Awaited<ReturnType<JailFs['stat']>>
  try {
    st = await req.fs.stat(realPath)
  } catch {
    return fail('not-found')
  }
  if (st.isDirectory() || !st.isFile()) return fail('directory')
  if (isHtmlFile(realPath) && st.size > (req.maxHtmlBytes ?? MAX_PAGE_HTML_BYTES)) {
    return fail('too-large')
  }
  return {
    ok: true,
    folder: known.folder,
    realFolder: known.realFolder,
    realPath,
    relPath: parsed.relPath,
    size: st.size
  }
}

/**
 * The same jail for a path a VERB names (`browser_open({ path })`, spec §6.2): repo-relative or absolute, it must
 * land inside `folder` and pass every rule above. Returns the folder-relative posix path.
 */
export async function jailVerbPath(opts: {
  folder: PageFolder
  rawPath: string
  fs: JailFs
  maxHtmlBytes?: number
}): Promise<JailVerdict> {
  if (opts.rawPath.includes('\0')) return fail('bad-path')
  const abs = path.isAbsolute(opts.rawPath)
    ? path.normalize(opts.rawPath)
    : path.join(opts.folder.folder, opts.rawPath)
  // A path that names somewhere outside the folder is refused as such, whether or not the file exists: the
  // answer must not tell the caller which files outside the folder are there.
  const lexical = [opts.folder.folder, opts.folder.realFolder].some(
    (base) => relativeSegments(base, abs) !== null
  )
  if (!lexical) return fail('escape')
  let real: string
  try {
    real = await opts.fs.realpath(abs)
  } catch {
    return fail('not-found')
  }
  const segments = relativeSegments(opts.folder.realFolder, real)
  if (!segments) return fail('escape')
  if (isDeniedPagePath(segments)) return fail('denied-path')
  // Re-run the URL jail on the folder-relative path so the verb and the protocol can never disagree.
  const id = folderIdOf(opts.folder.realFolder)
  return jailResolve({
    url: buildPageUrl(id, segments.join('/')),
    folders: new Map([[id, opts.folder]]),
    isBlocked: () => false,
    fs: opts.fs,
    ...(opts.maxHtmlBytes !== undefined ? { maxHtmlBytes: opts.maxHtmlBytes } : {})
  })
}
