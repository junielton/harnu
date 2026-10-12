import { describe, expect, it } from 'vitest'
import {
  createPathExistence,
  parseFstabMountPoints,
  parseMountInfo,
  type ExistenceDeps
} from '../src/main/gc/gc-orphan-existence'

/**
 * Delta-1 item 3: ENOENT is not proof that a folder is gone. A project on a drive that is not
 * mounted right now (a USB disk, an NFS or sshfs share, a symlinked parent whose target is
 * unmounted) has no folder either, and its transcripts must never be listed as orphaned. A
 * simulated disk: a set of directories (with their contents), symlinks, and what is mounted.
 */

interface Disk {
  /** Directories that exist and what each holds (names only). */
  dirs: Record<string, string[]>
  links?: Record<string, string>
  mounted?: string[] | null
  fstab?: string[]
  files?: string[]
  failOn?: Record<string, string>
}

function fake(d: Disk): ReturnType<typeof createPathExistence> {
  const err = (code: string): Error => Object.assign(new Error(code), { code })
  const resolve = (p: string): string => {
    for (const [l, t] of Object.entries(d.links ?? {})) {
      if (p === l || p.startsWith(`${l}/`)) return resolve(t + p.slice(l.length))
    }
    return p
  }
  const present = (p: string): boolean => p in d.dirs || (d.files ?? []).includes(p)
  const deps: ExistenceDeps = {
    lstat: async (p) => {
      if (d.failOn?.[p]) throw err(d.failOn[p]!)
      if (present(p) || (d.links ?? {})[p]) return { isDirectory: () => p in d.dirs }
      // a missing parent of a link target is a plain ENOENT
      throw err('ENOENT')
    },
    stat: async (p) => {
      const r = resolve(p)
      if (present(r)) return { isDirectory: () => r in d.dirs }
      throw err('ENOENT')
    },
    readdir: async (p) => d.dirs[resolve(p)] ?? [],
    realpath: async (p) => resolve(p),
    mounts: async () => (d.mounted === undefined ? [] : d.mounted),
    fstab: async () => d.fstab ?? []
  }
  return createPathExistence(deps)
}

describe('an ordinary disk', () => {
  const disk: Disk = {
    dirs: {
      '/': ['home'],
      '/home': ['u'],
      '/home/u': ['work'],
      '/home/u/work': ['repo'],
      '/home/u/work/repo': ['.claude', 'src'],
      '/home/u/work/repo/.claude': ['worktrees'],
      '/home/u/work/repo/.claude/worktrees': []
    }
  }
  const ex = fake(disk)
  it('a folder that is there exists', async () => {
    expect(await ex('/home/u/work/repo')).toBe('exists')
  })
  it('a removed worktree under a non-empty or empty parent is gone', async () => {
    expect(await ex('/home/u/work/repo/.claude/worktrees/x')).toBe('gone')
    expect(await ex('/home/u/work/repo/gone')).toBe('gone')
  })
  it('a repo removed with several folders above it still is gone while an ancestor holds other things', async () => {
    expect(await ex('/home/u/work/old/proj/worktrees/x')).toBe('gone')
  })
  it('any error but "not found" is unknown', async () => {
    const e = fake({ ...disk, failOn: { '/home/u/work/repo/p': 'EACCES' } })
    expect(await e('/home/u/work/repo/p')).toBe('unknown')
  })
})

describe('drives that are not there right now', () => {
  const base = {
    '/': ['media', 'mnt', 'srv', 'home'],
    '/home': ['u'],
    '/home/u': ['remote', 'link']
  }
  it('a USB disk under /media: unmounted mount point is unknown, mounted is gone', async () => {
    const dirs = { ...base, '/media': ['u'], '/media/u': ['DISK'], '/media/u/DISK': [] as string[] }
    expect(await fake({ dirs, mounted: [] })('/media/u/DISK/proj/wt')).toBe('unknown')
    expect(await fake({ dirs, mounted: ['/media/u/DISK'] })('/media/u/DISK/proj/wt')).toBe('gone')
  })
  it('/mnt and /run/media and /Volumes follow the same rule', async () => {
    for (const p of ['/mnt/data/proj/wt', '/run/media/u/D/proj/wt', '/Volumes/D/proj/wt']) {
      const parts = p.split('/').filter(Boolean)
      const dirs: Record<string, string[]> = { ...base }
      let cur = ''
      for (const part of parts.slice(0, -2)) {
        dirs[cur || '/'] = [...(dirs[cur || '/'] ?? []), part]
        cur += `/${part}`
        dirs[cur] = dirs[cur] ?? []
      }
      expect(await fake({ dirs, mounted: [] })(p), p).toBe('unknown')
    }
  })
  it('an NFS share listed in fstab but not mounted is unknown; once mounted it is gone', async () => {
    const dirs = { ...base, '/srv': ['nfs'], '/srv/nfs': ['team'] }
    const fstab = ['/srv/nfs']
    expect(await fake({ dirs, mounted: ['/'], fstab })('/srv/nfs/team/proj')).toBe('unknown')
    expect(await fake({ dirs, mounted: ['/', '/srv/nfs'], fstab })('/srv/nfs/team/proj')).toBe(
      'gone'
    )
  })
  it('an sshfs folder in the home, unmounted (an empty directory), is unknown', async () => {
    const dirs = { ...base, '/home/u/remote': [] as string[] }
    expect(await fake({ dirs, mounted: [] })('/home/u/remote/proj/wt')).toBe('unknown')
  })
  it('a symlinked parent whose target is gone is unknown', async () => {
    const dirs = { ...base }
    const ex = fake({ dirs, links: { '/home/u/link': '/mnt/disk' }, mounted: [] })
    expect(await ex('/home/u/link/proj')).toBe('unknown')
  })
  it('a symlinked parent that points at an unmounted, empty mount point is unknown', async () => {
    const dirs = { ...base, '/mnt': ['disk'], '/mnt/disk': [] as string[] }
    const ex = fake({ dirs, links: { '/home/u/link': '/mnt/disk' }, mounted: [] })
    expect(await ex('/home/u/link/proj')).toBe('unknown')
  })
  it('when the mount table cannot be read, anything under a removable root is unknown, the rest is judged normally', async () => {
    const dirs = { ...base, '/media': ['u'], '/media/u': [] as string[], '/home/u/work': ['a'] }
    const ex = fake({ dirs, mounted: null })
    expect(await ex('/media/u/D/proj')).toBe('unknown')
    expect(await ex('/home/u/work/gone')).toBe('gone')
  })
})

describe('reading the mount tables', () => {
  it('mountinfo: the mount point is the fifth field, octal escapes decoded', () => {
    const text = [
      '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
      '40 22 8:17 / /media/u/MY\\040DISK rw - vfat /dev/sdb1 rw',
      'garbage'
    ].join('\n')
    expect(parseMountInfo(text)).toEqual(['/', '/media/u/MY DISK'])
  })
  it('fstab: the second field, comments and swap/none skipped', () => {
    const text = [
      '# comment',
      'UUID=1 / ext4 defaults 0 1',
      'server:/x /srv/nfs nfs defaults 0 0',
      '/dev/sda2 none swap sw 0 0',
      ''
    ].join('\n')
    expect(parseFstabMountPoints(text)).toEqual(['/', '/srv/nfs'])
  })
})
