/**
 * T572 (browser pane U5, AC-7) — `browser_upload`: only files inside the pane's folder leave, never a secret, never a
 * huge file, and a link never lets a path out.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  checkUploadArgs,
  forbiddenUploadReason,
  planUpload,
  type UploadIo
} from '../src/main/browser/upload-plan'

const FOLDER = '/work/app'

/** A fake disk: `files` maps a real path to a size; `links` maps a path to where it points. */
function disk(
  files: Record<string, number>,
  links: Record<string, string> = {},
  dirs: string[] = []
): UploadIo {
  const real = (p: string): string => {
    let cur = p
    for (let i = 0; i < 8 && links[cur] !== undefined; i++) cur = links[cur]!
    return cur
  }
  return {
    realpath: async (p) => {
      const r = real(p)
      if (files[r] === undefined && !dirs.includes(r) && r !== FOLDER) throw new Error('ENOENT')
      return r
    },
    stat: async (p) => {
      if (dirs.includes(p)) return { kind: 'other', size: 0 }
      return files[p] === undefined ? null : { kind: 'file', size: files[p]! }
    }
  }
}

describe('forbiddenUploadReason', () => {
  it('refuses .git, .env*, *.pem, *.key and id_*', () => {
    for (const p of [
      '.git/config',
      'sub/.git/HEAD',
      '.GIT/config',
      '.env',
      '.env.local',
      'cfg/.env.production',
      'certs/server.pem',
      'k.KEY',
      'id_rsa',
      'home/.ssh/id_ed25519.pub',
      // The widened list (delta 1).
      '.envrc',
      '.env-backup',
      'cfg/.ENV.production',
      '.git-credentials',
      '.npmrc',
      'sub/.netrc',
      '.pypirc',
      'id_rsa.pub',
      'id_ed25519',
      '.harnu/memory/hot.md',
      'x/.harnu/out/downloads/a.txt',
      '.HARNU/out/a.txt'
    ]) {
      expect(forbiddenUploadReason(p), p).not.toBeNull()
    }
  })

  it('lets ordinary files through, including look-alikes', () => {
    for (const p of [
      'README.md',
      'src/environment.ts',
      'envelope.pdf',
      'valid_id.txt',
      'a.keynote',
      'monkey.png',
      'npmrc.md',
      'harnu.md',
      'docs/netrc-guide.txt'
    ]) {
      expect(forbiddenUploadReason(p), p).toBeNull()
    }
  })
})

describe('checkUploadArgs (plan level)', () => {
  it('needs 1..10 non-empty string paths', () => {
    expect(checkUploadArgs({})?.code).toBe('BAD_ARGS')
    expect(checkUploadArgs({ paths: [] })?.code).toBe('BAD_ARGS')
    expect(checkUploadArgs({ paths: [''] })?.code).toBe('BAD_ARGS')
    expect(checkUploadArgs({ paths: [1] })?.code).toBe('BAD_ARGS')
    expect(checkUploadArgs({ paths: Array.from({ length: 11 }, (_, i) => `f${i}`) })?.code).toBe(
      'BAD_ARGS'
    )
    expect(checkUploadArgs({ paths: Array.from({ length: 10 }, (_, i) => `f${i}`) })).toBeNull()
  })

  it('refuses a forbidden name before anything else', () => {
    const r = checkUploadArgs({ paths: ['ok.txt', '.env'] })
    expect(r?.code).toBe('UPLOAD_PATH_DENIED')
    expect(r?.detail).toContain('.env')
  })
})

describe('checkUploadArgs with the pane folder: the lexical path check is plan level (delta 1)', () => {
  const FOLDER = '/work/app'
  it('refuses `..`, an absolute path elsewhere and a traversal that lands outside, without any filesystem', () => {
    for (const p of ['../x.txt', '/etc/hostname', 'sub/../../y.txt', '/work/app/../other/z.txt']) {
      const r = checkUploadArgs({ paths: [p] }, FOLDER)
      expect(r, p).toMatchObject({ code: 'UPLOAD_PATH_DENIED' })
      expect(r?.detail).toContain('outside')
    }
  })

  it('judges the name where the path really lands (`sub/../.env` is `.env`)', () => {
    expect(checkUploadArgs({ paths: ['sub/../.env'] }, FOLDER)).toMatchObject({
      code: 'UPLOAD_PATH_DENIED'
    })
    expect(checkUploadArgs({ paths: ['a/../.harnu/x.md'] }, FOLDER)).toMatchObject({
      code: 'UPLOAD_PATH_DENIED'
    })
  })

  it('lets a path inside the folder through, relative or absolute', () => {
    expect(
      checkUploadArgs({ paths: ['a.txt', 'sub/b.png', '/work/app/c.md', 'sub/../d.txt'] }, FOLDER)
    ).toBeNull()
  })

  it('without a folder only the names are judged (the handler re-checks with the folder)', () => {
    expect(checkUploadArgs({ paths: ['../x.txt'] })).toBeNull()
  })
})

describe('planUpload', () => {
  it('accepts files inside the folder, relative or absolute, with their sizes', async () => {
    const io = disk({ [`${FOLDER}/a.txt`]: 10, [`${FOLDER}/sub/b.png`]: 2048 })
    const r = await planUpload({ folder: FOLDER, paths: ['a.txt', `${FOLDER}/sub/b.png`], io })
    expect(r).toEqual({
      ok: true,
      files: [
        { path: `${FOLDER}/a.txt`, name: 'a.txt', bytes: 10 },
        { path: `${FOLDER}/sub/b.png`, name: 'b.png', bytes: 2048 }
      ]
    })
  })

  it('refuses a path that leaves the folder, without touching the disk', async () => {
    let touched = false
    const io: UploadIo = {
      realpath: async (p) => {
        if (p !== FOLDER) touched = true
        return p
      },
      stat: async () => {
        touched = true
        return null
      }
    }
    for (const p of ['../secret.txt', '/etc/passwd', 'sub/../../x', `${FOLDER}/../other/y`]) {
      const r = await planUpload({ folder: FOLDER, paths: [p], io })
      expect(r, p).toMatchObject({ ok: false, code: 'UPLOAD_PATH_DENIED' })
    }
    expect(touched).toBe(false)
  })

  it('refuses a symlink that points outside the folder', async () => {
    const io = disk({ '/etc/passwd': 100 }, { [`${FOLDER}/notes.txt`]: '/etc/passwd' })
    const r = await planUpload({ folder: FOLDER, paths: ['notes.txt'], io })
    expect(r).toMatchObject({ ok: false, code: 'UPLOAD_PATH_DENIED' })
    expect((r as { detail: string }).detail).toContain('link')
  })

  it('refuses a link inside the folder that points at .git (the forbidden names apply to where it really goes)', async () => {
    const io = disk(
      { [`${FOLDER}/.git/config`]: 50 },
      { [`${FOLDER}/notes.txt`]: `${FOLDER}/.git/config` }
    )
    const r = await planUpload({ folder: FOLDER, paths: ['notes.txt'], io })
    expect(r).toMatchObject({ ok: false, code: 'UPLOAD_PATH_DENIED' })
  })

  it('refuses a directory, and a file that is not there', async () => {
    const io = disk({}, {}, [`${FOLDER}/sub`])
    expect(await planUpload({ folder: FOLDER, paths: ['sub'], io })).toMatchObject({
      ok: false,
      code: 'UPLOAD_PATH_DENIED'
    })
    expect(await planUpload({ folder: FOLDER, paths: ['nope.txt'], io })).toMatchObject({
      ok: false,
      code: 'UPLOAD_PATH_DENIED'
    })
  })

  it('refuses a file over 50 MiB, and takes one at exactly the limit', async () => {
    const io = disk({
      [`${FOLDER}/big.bin`]: MAX_UPLOAD_BYTES + 1,
      [`${FOLDER}/edge.bin`]: MAX_UPLOAD_BYTES
    })
    expect(await planUpload({ folder: FOLDER, paths: ['big.bin'], io })).toMatchObject({
      ok: false,
      code: 'UPLOAD_TOO_LARGE'
    })
    expect(await planUpload({ folder: FOLDER, paths: ['edge.bin'], io })).toMatchObject({
      ok: true
    })
  })

  it('is all-or-nothing: one bad path refuses the call', async () => {
    const io = disk({ [`${FOLDER}/a.txt`]: 1 })
    const r = await planUpload({ folder: FOLDER, paths: ['a.txt', '../x'], io })
    expect(r.ok).toBe(false)
  })

  it('an unreadable folder is refused', async () => {
    const io: UploadIo = {
      realpath: async () => {
        throw new Error('EACCES')
      },
      stat: async () => null
    }
    expect(await planUpload({ folder: FOLDER, paths: ['a'], io })).toMatchObject({ ok: false })
  })
})
