/**
 * Guided walks: link and image validation, the real reads behind `WalkProbe` (spec S-1, AC-2).
 *
 * The schema (`src/shared/walk-schema.ts`) is pure and asks a probe what lives outside the script:
 * is this file inside the folder, is this folder known, how big is this image and is it inside the
 * jail, does this text look like a secret. This file answers with the filesystem. It is
 * synchronous on purpose (a script is validated in one pass) and Electron-free.
 *
 * Jails, all checked on the REAL path so a symlink cannot walk out (lesson security/001):
 *  - a `file` link: inside the walk's folder, an existing regular file;
 *  - an image: inside the walk's folder, the legacy image cache (`~/.claude/image-cache/`), or the
 *    exact pasted-image shape `<tmp>/claude-<uid>/<slug>/<uuid>/images/<n>.png`.
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { imageMimeType } from '../markdown-core'
import { matchTmpImagePath } from '../claude-tmp-images-core'
import { redactTranscript } from '../mcp/transcript-redact'
import type { ImageFact, WalkProbe } from '../../shared/walk-schema'
import type { MissionFacts } from '../../shared/walk-source'

export interface WalkProbeOptions {
  /** The folder the walk is opened from: `file` links and relative image paths resolve here. */
  folder: string
  /** The folders Harnu knows (pinned or seen), for `folder` links. */
  knownFolders: readonly string[] | (() => readonly string[])
  /** The slugs of the folder's board cards. */
  cardSlugs: () => readonly string[]
  /** The mission record `id` names, as the facts a walk may rely on; `null` when there is none. */
  mission: (id: string) => MissionFacts | null
  /** Extra roots an image may live in (a test seam; the image cache and the tmp shape are built in). */
  imageRoots?: readonly string[]
  /** Test seams. */
  home?: string
  tmp?: string
  uid?: number | null
}

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Is `abs` equal to `root` or inside it? Both already resolved. */
function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function createWalkProbe(opts: WalkProbeOptions): WalkProbe {
  const folderReal = realOrNull(resolve(opts.folder)) ?? resolve(opts.folder)
  const home = opts.home ?? homedir()
  const tmp = opts.tmp ?? tmpdir()
  const uid =
    opts.uid !== undefined
      ? opts.uid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : null
  const tmpRoot = uid === null ? null : join(tmp, `claude-${uid}`)
  const cacheRoot = join(home, '.claude', 'image-cache')
  const extraRoots = (opts.imageRoots ?? []).map((r) => resolve(r))

  /** Is the (lexical) absolute path inside one of the image roots? */
  const lexicallyInJail = (abs: string): boolean =>
    inside(resolve(opts.folder), abs) ||
    inside(cacheRoot, abs) ||
    extraRoots.some((r) => inside(r, abs)) ||
    (tmpRoot !== null && matchTmpImagePath(abs, tmpRoot) !== null)

  const realInJail = (real: string): boolean =>
    inside(folderReal, real) ||
    [cacheRoot, ...extraRoots].some((r) => inside(realOrNull(r) ?? r, real)) ||
    (tmpRoot !== null && matchTmpImagePath(real, realOrNull(tmpRoot) ?? tmpRoot) !== null)

  return {
    cardSlugExists: (slug) => opts.cardSlugs().includes(slug),
    mission: (id) => opts.mission(id),

    fileInFolder(rel: string): boolean {
      if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || isAbsolute(rel))
        return false
      const abs = resolve(opts.folder, rel)
      if (!inside(resolve(opts.folder), abs)) return false
      const real = realOrNull(abs)
      if (real === null || !inside(folderReal, real)) return false
      try {
        return statSync(real).isFile()
      } catch {
        return false
      }
    },

    folderKnown(path: string): boolean {
      if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) return false
      const known =
        typeof opts.knownFolders === 'function' ? opts.knownFolders() : opts.knownFolders
      const want = resolve(path)
      return known.some((k) => resolve(k) === want)
    },

    image(src: string): ImageFact {
      if (typeof src !== 'string' || src.length === 0 || src.includes('\0'))
        return { ok: false, reason: 'outside-jail' }
      const abs = isAbsolute(src) ? resolve(src) : resolve(opts.folder, src)
      if (!lexicallyInJail(abs)) return { ok: false, reason: 'outside-jail' }
      const real = realOrNull(abs)
      if (real === null) return { ok: false, reason: 'missing' }
      if (!realInJail(real)) return { ok: false, reason: 'outside-jail' }
      if (imageMimeType(real) === null) return { ok: false, reason: 'not-image' }
      try {
        const st = statSync(real)
        if (!st.isFile()) return { ok: false, reason: 'missing' }
        return { ok: true, bytes: st.size }
      } catch {
        return { ok: false, reason: 'missing' }
      }
    },

    looksLikeSecret: (text: string): boolean =>
      redactTranscript(text, { home: '' }).redactionCount > 0
  }
}
