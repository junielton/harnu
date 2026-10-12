// "Is this folder really gone?" for the orphan-transcript listing (delta-1 item 3). A missing
// entry (ENOENT) is not proof: a project on a drive that is not mounted right now (a USB disk, an
// NFS or sshfs share, a symlinked parent whose target is unmounted) has no folder either, and its
// transcripts must never be offered for the trash. So "gone" is the answer only when nothing
// suggests a missing mount; anything else is `unknown`, and `unknown` is never listed.
//
// Rules, in order, for a path whose own entry is missing:
//  1. any error but "not found" is unknown;
//  2. the nearest existing ancestor is found by walking up (links followed); a link that dangles
//     on the way is unknown (its target may be an unmounted drive);
//  3. the path is judged on its real location (that ancestor's real path plus what is missing):
//     under a mount point listed in fstab that is not mounted now → unknown; under a removable or
//     network root (/media, /mnt, /run/media, /net, /Volumes) with no mount point of its own
//     mounted now → unknown; a mount table that cannot be read leaves those roots unknown;
//  4. more than one segment missing under an ancestor that is an empty directory and not a mount
//     point is the shape of an unmounted mount point → unknown;
//  5. otherwise gone.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type Existence = 'exists' | 'gone' | 'unknown'

export interface ExistenceDeps {
  lstat(p: string): Promise<{ isDirectory(): boolean }>
  /** Follows links. */
  stat(p: string): Promise<{ isDirectory(): boolean }>
  readdir(p: string): Promise<string[]>
  realpath(p: string): Promise<string>
  /** Mount points mounted now, or null when the table cannot be read. */
  mounts(): Promise<string[] | null>
  /** Mount points the system is configured to mount (fstab). */
  fstab(): Promise<string[]>
}

/** Roots under which a drive may come and go; an absent mount under one is never proof of a gone folder. */
const REMOVABLE_ROOTS = ['/media', '/mnt', '/run/media', '/net', '/Volumes']

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

const under = (p: string, root: string): boolean =>
  root !== '/' && (p === root || p.startsWith(`${root}/`))

/** The mount points of a /proc/self/mountinfo text (fifth field, octal escapes decoded). */
export function parseMountInfo(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4]
    if (!field || !field.startsWith('/')) continue
    out.push(field.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))))
  }
  return out
}

/** The mount points of an fstab text (second field), without comments, swap and `none`. */
export function parseFstabMountPoints(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const field = line.split(/\s+/)[1]
    if (!field || !field.startsWith('/')) continue
    out.push(field.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))))
  }
  return out
}

export function createPathExistence(deps: ExistenceDeps): (p: string) => Promise<Existence> {
  return async (p) => {
    try {
      await deps.lstat(p)
      return 'exists'
    } catch (err) {
      const code = codeOf(err)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unknown'
    }

    // 2. the nearest existing ancestor
    const missing: string[] = [path.basename(p)]
    let anc = path.dirname(p)
    for (;;) {
      try {
        const st = await deps.stat(anc)
        if (!st.isDirectory()) return 'unknown'
        break
      } catch (err) {
        const code = codeOf(err)
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unknown'
        // A link that is there but points nowhere: its target may be an unmounted drive.
        try {
          await deps.lstat(anc)
          return 'unknown'
        } catch (e2) {
          const c2 = codeOf(e2)
          if (c2 !== 'ENOENT' && c2 !== 'ENOTDIR') return 'unknown'
        }
        const parent = path.dirname(anc)
        if (parent === anc) return 'unknown'
        missing.unshift(path.basename(anc))
        anc = parent
      }
    }

    // 3. judged on the real location
    let realAnc: string
    try {
      realAnc = await deps.realpath(anc)
    } catch {
      return 'unknown'
    }
    const real = path.join(realAnc, ...missing)
    let mounted: string[] | null
    let configured: string[]
    try {
      mounted = await deps.mounts()
      configured = await deps.fstab()
    } catch {
      return 'unknown'
    }
    for (const f of configured) {
      if (under(real, f) && (mounted === null || !mounted.includes(f))) return 'unknown'
    }
    const root = REMOVABLE_ROOTS.find((r) => under(real, r) && real !== r)
    if (root) {
      const own = mounted?.find((m) => m !== root && under(m, root) && under(real, m))
      if (!own) return 'unknown'
    }

    // 4. the shape of an unmounted mount point
    if (missing.length > 1 && !(mounted ?? []).includes(realAnc)) {
      try {
        if ((await deps.readdir(realAnc)).length === 0) return 'unknown'
      } catch {
        return 'unknown'
      }
    }
    return 'gone'
  }
}

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export const realExistenceDeps: ExistenceDeps = {
  lstat: (p) => fs.lstat(p),
  stat: (p) => fs.stat(p),
  readdir: (p) => fs.readdir(p),
  realpath: (p) => fs.realpath(p),
  mounts: async () => {
    const text = await readText('/proc/self/mountinfo')
    return text === null ? null : parseMountInfo(text)
  },
  fstab: async () => parseFstabMountPoints((await readText('/etc/fstab')) ?? '')
}

export const fsPathExistence = createPathExistence(realExistenceDeps)
