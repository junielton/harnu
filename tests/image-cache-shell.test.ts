import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdir, stat, readFile } from 'node:fs/promises'
import { listImages, readImageDataUrl } from '../src/main/image-cache'

// Shell I/O for the Pasted-images gallery, tested with a mocked fs so the
// readdir/sort/stat → ImageEntry path and the base64 data-URL are observable
// without real files. The path-traversal guard (resolveImagePath) is proven by
// asserting readFile is NEVER reached for a forged name (lesson security/001).

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn()
}))

const HOME = '/home/u'
const UUID = '11111111-2222-4333-8444-555555555555'

beforeEach(() => {
  vi.mocked(readdir).mockReset()
  vi.mocked(stat).mockReset()
  vi.mocked(readFile).mockReset()
})

describe('listImages', () => {
  it('returns [] when the directory does not exist (never throws)', async () => {
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    await expect(listImages(HOME, UUID)).resolves.toEqual([])
  })

  it('returns only .png entries, newest-first, with the path built in main', async () => {
    vi.mocked(readdir).mockResolvedValue(['2.png', '1.png', 'x.txt'] as never)
    vi.mocked(stat).mockResolvedValue({ size: 100, mtimeMs: 5 } as never)
    const out = await listImages(HOME, UUID)
    // Independent signal: assert the real order (2 before 1) — a lexicographic
    // bug would pass `1.png` first — and the exact path literal built in main.
    expect(out.map((e) => e.name)).toEqual(['2.png', '1.png'])
    expect(out[0].path).toBe(`/home/u/.claude/image-cache/${UUID}/2.png`)
    expect(out[0].bytes).toBe(100)
    expect(out[0].mtimeMs).toBe(5)
  })

  it('drops a file pruned between readdir and stat instead of rejecting the list', async () => {
    vi.mocked(readdir).mockResolvedValue(['2.png', '1.png'] as never)
    // The live cache prunes 1.png after readdir saw it — its stat rejects.
    vi.mocked(stat).mockImplementation(async (p: never) => {
      if (String(p).endsWith('1.png')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return { size: 100, mtimeMs: 5 } as never
    })
    // Independent signal: the survivor is returned and the call never rejects.
    await expect(listImages(HOME, UUID)).resolves.toEqual([
      { name: '2.png', path: `/home/u/.claude/image-cache/${UUID}/2.png`, bytes: 100, mtimeMs: 5 }
    ])
  })
})

describe('readImageDataUrl', () => {
  it('returns a base64 data URL for a valid name', async () => {
    const buf = Buffer.from('PNGDATA')
    vi.mocked(readFile).mockResolvedValue(buf as never)
    const url = await readImageDataUrl(HOME, UUID, '1.png')
    // Independent signal: compute the expected base64 via the stdlib Buffer,
    // not via the implementation.
    expect(url).toBe('data:image/png;base64,' + buf.toString('base64'))
  })

  it('rejects an invalid name without touching the filesystem', async () => {
    await expect(readImageDataUrl(HOME, UUID, '../x')).rejects.toThrow()
    expect(readFile).not.toHaveBeenCalled()
  })
})
