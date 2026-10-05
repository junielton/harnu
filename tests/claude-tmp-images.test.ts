import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeTmpRoot,
  matchTmpImagePath,
  confirmTmpImageSource,
  findTmpImageDirs,
  resolveTmpImageFile
} from '../src/main/claude-tmp-images'
import { listImages, readImageDataUrl } from '../src/main/image-cache'
import { resolveCardAssetSource } from '../src/main/roadmap-core'
import { planCanvasAssets } from '../src/main/mcp/canvas-ops'

// BUG-149 — Claude CLI moved pasted images to
// `<os.tmpdir()>/claude-<uid>/<slug>/<session-uuid>/images/<n>.png`. The root is
// shared with every session's scratchpad, so the allowlist accepts ONLY that
// exact shape (lesson security/001) — never the whole tree.

const UUID = '11111111-2222-4333-8444-555555555555'
const SLUG = '-home-u-Workspace-org-www'

describe('claudeTmpRoot', () => {
  it('joins the tmp dir with claude-<uid>', () => {
    expect(claudeTmpRoot('/tmp', 1000)).toBe('/tmp/claude-1000')
  })
  it('is null when the platform has no uid (win32)', () => {
    expect(claudeTmpRoot('/tmp', null)).toBeNull()
  })
})

describe('matchTmpImagePath — exact-shape allowlist (pure)', () => {
  const ROOT = '/tmp/claude-1000'
  it('accepts <root>/<slug>/<uuid>/images/<n>.png', () => {
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/images/3.png`, ROOT)).toEqual({
      slug: SLUG,
      uuid: UUID,
      name: '3.png'
    })
  })
  it('refuses a scratchpad file under the same root', () => {
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/scratchpad/3.png`, ROOT)).toBeNull()
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/scratchpad/images/3.png`, ROOT)).toBeNull()
  })
  it('refuses a non-uuid session segment', () => {
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/not-a-uuid/images/3.png`, ROOT)).toBeNull()
  })
  it('refuses a non-<digits>.png name', () => {
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/images/shot.png`, ROOT)).toBeNull()
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/images/3.jpg`, ROOT)).toBeNull()
  })
  it('refuses extra or missing depth', () => {
    expect(matchTmpImagePath(`${ROOT}/${UUID}/images/3.png`, ROOT)).toBeNull()
    expect(matchTmpImagePath(`${ROOT}/${SLUG}/x/${UUID}/images/3.png`, ROOT)).toBeNull()
  })
  it('refuses a sibling root that shares the string prefix', () => {
    expect(matchTmpImagePath(`${ROOT}-evil/${SLUG}/${UUID}/images/3.png`, ROOT)).toBeNull()
  })
  it('refuses an un-normalised `..` escape', () => {
    expect(
      matchTmpImagePath(`${ROOT}/${SLUG}/${UUID}/images/../../../../etc/1.png`, ROOT)
    ).toBeNull()
  })
})

describe('resolveCardAssetSource — tmp images root (BUG-149 AC4)', () => {
  const HOME = '/home/u'
  const FOLDER = '/home/u/Workspace/repo'
  const ROOT = '/tmp/claude-1000'
  const good = `${ROOT}/${SLUG}/${UUID}/images/2.png`

  it('accepts the exact new shape and carries the root forward for the realpath check', () => {
    expect(resolveCardAssetSource(good, HOME, FOLDER, ROOT)).toEqual({
      ok: true,
      path: good,
      ext: '.png',
      tmpRoot: ROOT
    })
  })
  it('refuses it when no tmp root is configured', () => {
    expect(resolveCardAssetSource(good, HOME, FOLDER)).toEqual({
      ok: false,
      code: 'SOURCE_NOT_ALLOWED'
    })
  })
  it('refuses a scratchpad file, a `..` escape and a bad name under the same root', () => {
    for (const p of [
      `${ROOT}/${SLUG}/${UUID}/scratchpad/2.png`,
      `${ROOT}/${SLUG}/${UUID}/images/../scratchpad/2.png`,
      `${ROOT}/${SLUG}/${UUID}/images/shot.png`
    ]) {
      expect(resolveCardAssetSource(p, HOME, FOLDER, ROOT)).toEqual({
        ok: false,
        code: 'SOURCE_NOT_ALLOWED'
      })
    }
  })
  it('planCanvasAssets (draw_canvas) applies the same jail', () => {
    const ok = planCanvasAssets('board', [good], HOME, FOLDER, ROOT)
    expect(ok.ok).toBe(true)
    const bad = planCanvasAssets(
      'board',
      [`${ROOT}/${SLUG}/${UUID}/scratchpad/2.png`],
      HOME,
      FOLDER,
      ROOT
    )
    expect(bad.ok).toBe(false)
  })
})

describe('real-fs behaviour', () => {
  let base: string
  let root: string
  let home: string
  let imagesDir: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'bug149-'))
    root = join(base, 'claude-1000')
    home = join(base, 'home')
    imagesDir = join(root, SLUG, UUID, 'images')
    await mkdir(imagesDir, { recursive: true })
    await mkdir(join(root, SLUG, UUID, 'scratchpad'), { recursive: true })
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('confirmTmpImageSource returns the real path for a genuine image', async () => {
    const p = join(imagesDir, '1.png')
    await writeFile(p, 'PNG')
    expect(await confirmTmpImageSource(p, root)).toBe(p)
  })

  it('confirmTmpImageSource refuses a symlink pointing outside the images dir', async () => {
    const secret = join(base, 'secret.txt')
    await writeFile(secret, 'ssh-key')
    const link = join(imagesDir, '2.png')
    await symlink(secret, link)
    expect(await confirmTmpImageSource(link, root)).toBeNull()
  })

  it('confirmTmpImageSource refuses a symlink into the scratchpad', async () => {
    const pad = join(root, SLUG, UUID, 'scratchpad', '9.png')
    await writeFile(pad, 'x')
    const link = join(imagesDir, '3.png')
    await symlink(pad, link)
    expect(await confirmTmpImageSource(link, root)).toBeNull()
  })

  it('confirmTmpImageSource refuses a symlinked images dir', async () => {
    const other = join(base, 'elsewhere')
    await mkdir(other)
    await writeFile(join(other, '1.png'), 'x')
    const uuid2 = '22222222-2222-4333-8444-555555555555'
    await mkdir(join(root, SLUG, uuid2), { recursive: true })
    await symlink(other, join(root, SLUG, uuid2, 'images'))
    expect(await confirmTmpImageSource(join(root, SLUG, uuid2, 'images', '1.png'), root)).toBeNull()
  })

  it('confirmTmpImageSource refuses a missing file', async () => {
    expect(await confirmTmpImageSource(join(imagesDir, '8.png'), root)).toBeNull()
  })

  it('findTmpImageDirs locates the session dir under whichever slug holds it', async () => {
    expect(await findTmpImageDirs(root, UUID)).toEqual([imagesDir])
    expect(await findTmpImageDirs(root, '33333333-2222-4333-8444-555555555555')).toEqual([])
    expect(await findTmpImageDirs(join(base, 'nope'), UUID)).toEqual([])
  })

  it('resolveTmpImageFile returns the file, refuses bad names', async () => {
    await writeFile(join(imagesDir, '4.png'), 'x')
    expect(await resolveTmpImageFile(root, UUID, '4.png')).toBe(join(imagesDir, '4.png'))
    expect(await resolveTmpImageFile(root, UUID, '../scratchpad/9.png')).toBeNull()
    expect(await resolveTmpImageFile(root, UUID, '5.png')).toBeNull()
  })

  // AC1 — images only in the new location.
  it('listImages lists images found only under the tmp root', async () => {
    await writeFile(join(imagesDir, '1.png'), 'a')
    await writeFile(join(imagesDir, '2.png'), 'bb')
    const out = await listImages(home, UUID, root)
    expect(out.map((e) => e.name)).toEqual(['2.png', '1.png'])
    expect(out[0].path).toBe(join(imagesDir, '2.png'))
    expect(out[0].bytes).toBe(2)
  })

  // AC2 — legacy only.
  it('listImages still lists the legacy root when the tmp root has nothing', async () => {
    const legacy = join(home, '.claude', 'image-cache', UUID)
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '1.png'), 'a')
    const out = await listImages(home, UUID, root)
    expect(out.map((e) => e.path)).toEqual([join(legacy, '1.png')])
  })

  // AC3 — both roots → merged, deduped, stable newest-first.
  it('merges both roots, dedupes by name preferring the tmp root, newest-first', async () => {
    const legacy = join(home, '.claude', 'image-cache', UUID)
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '1.png'), 'old')
    await writeFile(join(legacy, '2.png'), 'old')
    await writeFile(join(imagesDir, '2.png'), 'new')
    await writeFile(join(imagesDir, '3.png'), 'new')
    const out = await listImages(home, UUID, root)
    expect(out.map((e) => e.name)).toEqual(['3.png', '2.png', '1.png'])
    expect(out.find((e) => e.name === '2.png')?.path).toBe(join(imagesDir, '2.png'))
    expect(out.find((e) => e.name === '1.png')?.path).toBe(join(legacy, '1.png'))
  })

  it('readImageDataUrl reads from the tmp root and falls back to legacy', async () => {
    await writeFile(join(imagesDir, '1.png'), 'NEWDATA')
    const legacy = join(home, '.claude', 'image-cache', UUID)
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '7.png'), 'OLDDATA')
    expect(await readImageDataUrl(home, UUID, '1.png', root)).toBe(
      'data:image/png;base64,' + Buffer.from('NEWDATA').toString('base64')
    )
    expect(await readImageDataUrl(home, UUID, '7.png', root)).toBe(
      'data:image/png;base64,' + Buffer.from('OLDDATA').toString('base64')
    )
    await expect(readImageDataUrl(home, UUID, '../x', root)).rejects.toThrow()
  })
})
