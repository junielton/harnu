import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Explorer `listDir` core (Cluster C): the confined, `.gitignore`-aware
 * one-level directory lister backing the Explorer tree pane. The risk surface is
 * (1) the confinement gate — a `dir` outside `root` must be refused, never
 * escape — and (2) the gitignore filtering (root + ancestor-chain layers), the
 * `.git` always-hide, and the dirs-first sort. Every assertion observes an
 * independent signal (a real on-disk tree, a hand-written path literal), never a
 * value derived from the function under test.
 *
 * `electron` is mocked because `explorer-ipc` → `settings` imports `app`/`ipcMain`.
 */
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import {
  listDir,
  searchFiles,
  isIgnoredByLayers,
  buildIgnoreLayer,
  sortExplorerEntries,
  type ExplorerEntry
} from '../src/main/explorer-ipc'

describe('isIgnoredByLayers — pure gitignore matching', () => {
  it('matches a directory pattern (node_modules/) only for a directory', () => {
    const layers = [buildIgnoreLayer('/repo', 'node_modules/\n')]
    expect(isIgnoredByLayers(layers, '/repo/node_modules', true)).toBe(true)
    // A *file* literally named node_modules is not matched by the dir pattern.
    expect(isIgnoredByLayers(layers, '/repo/node_modules', false)).toBe(false)
  })

  it('matches a bare pattern (dist) for both a dir and a file of that name', () => {
    const layers = [buildIgnoreLayer('/repo', 'dist\n')]
    expect(isIgnoredByLayers(layers, '/repo/dist', true)).toBe(true)
    expect(isIgnoredByLayers(layers, '/repo/dist', false)).toBe(true)
  })

  it('matches a file glob (*.log, .env)', () => {
    const layers = [buildIgnoreLayer('/repo', '*.log\n.env\n')]
    expect(isIgnoredByLayers(layers, '/repo/debug.log', false)).toBe(true)
    expect(isIgnoredByLayers(layers, '/repo/.env', false)).toBe(true)
    expect(isIgnoredByLayers(layers, '/repo/README.md', false)).toBe(false)
  })

  it('honors an ancestor-chain layer anchored at a deeper dir', () => {
    // A .gitignore in /repo/pkg ignores `build/` relative to /repo/pkg.
    const layers = [buildIgnoreLayer('/repo/pkg', 'build/\n')]
    expect(isIgnoredByLayers(layers, '/repo/pkg/build', true)).toBe(true)
    // Same name one level up is NOT covered by the deeper layer.
    expect(isIgnoredByLayers(layers, '/repo/build', true)).toBe(false)
  })
})

describe('sortExplorerEntries — dirs first, then alpha (case-insensitive)', () => {
  it('orders directories before files, each locale-aware case-insensitive', () => {
    const rows: ExplorerEntry[] = [
      { name: 'README.md', path: '/r/README.md', isDir: false },
      { name: 'src', path: '/r/src', isDir: true },
      { name: 'Apple', path: '/r/Apple', isDir: true },
      { name: 'app.ts', path: '/r/app.ts', isDir: false },
      { name: 'zebra', path: '/r/zebra', isDir: true }
    ]
    sortExplorerEntries(rows)
    expect(rows.map((r) => r.name)).toEqual(['Apple', 'src', 'zebra', 'app.ts', 'README.md'])
  })
})

describe('listDir — confinement gate', () => {
  it('refuses a dir that escapes the root with error out-of-root', async () => {
    const res = await listDir('/home/u/project', '/home/u/project/../secret')
    expect(res.error).toBe('out-of-root')
    expect(res.entries).toEqual([])
  })

  it('refuses an absolute re-root outside the project', async () => {
    const res = await listDir('/home/u/project', '/etc')
    expect(res.error).toBe('out-of-root')
    expect(res.entries).toEqual([])
  })

  it('rejects empty inputs without throwing', async () => {
    expect((await listDir('', '/x')).error).toBe('invalid-path')
    expect((await listDir('/x', '')).error).toBe('invalid-path')
  })
})

describe('listDir — real fixture (gitignore + .git + sort)', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-explorer-'))
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist\n.env\n*.log\n')
    await fs.mkdir(path.join(root, 'node_modules'))
    await fs.mkdir(path.join(root, 'dist'))
    await fs.mkdir(path.join(root, '.git'))
    await fs.mkdir(path.join(root, 'src'))
    await fs.mkdir(path.join(root, '.docs')) // dotfile dir NOT gitignored → shown
    await fs.writeFile(path.join(root, 'README.md'), '# hi')
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1')
    await fs.writeFile(path.join(root, 'debug.log'), 'noise')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('excludes gitignored + .git, keeps dotfiles that are not ignored', async () => {
    const res = await listDir(root, root)
    expect(res.error).toBeUndefined()
    const names = res.entries.map((e) => e.name)
    // Hidden: node_modules, dist, .env, debug.log (gitignore) + .git (always).
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('dist')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('debug.log')
    expect(names).not.toContain('.git')
    // Shown: .docs, src (dirs, alpha) then files alpha. `.gitignore` is itself
    // tracked by git (never self-ignored), so it appears; '.' sorts before 'R'.
    expect(names).toEqual(['.docs', 'src', '.gitignore', 'README.md'])
    // isDir flags correct.
    expect(res.entries.find((e) => e.name === 'src')?.isDir).toBe(true)
    expect(res.entries.find((e) => e.name === 'README.md')?.isDir).toBe(false)
  })

  it('applies a nested .gitignore to a subdirectory listing', async () => {
    const pkg = path.join(root, 'pkg')
    await fs.mkdir(pkg)
    await fs.writeFile(path.join(pkg, '.gitignore'), 'build/\n')
    await fs.mkdir(path.join(pkg, 'build'))
    await fs.mkdir(path.join(pkg, 'lib'))
    // Root's *.log rule still applies to the child dir too (chain layering).
    await fs.writeFile(path.join(pkg, 'trace.log'), 'x')
    await fs.writeFile(path.join(pkg, 'index.ts'), 'x')

    const res = await listDir(root, pkg)
    const names = res.entries.map((e) => e.name)
    expect(names).not.toContain('build') // nested .gitignore
    expect(names).not.toContain('trace.log') // inherited root rule
    // `.gitignore` (this dir's own) is tracked → listed; '.' sorts before 'i'.
    expect(names).toEqual(['lib', '.gitignore', 'index.ts'])
  })

  it('returns not-found for a missing dir inside the root', async () => {
    const res = await listDir(root, path.join(root, 'does-not-exist'))
    expect(res.error).toBe('not-found')
  })
})

describe('searchFiles — recursive, gitignore-pruned project finder', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-search-'))
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist\n*.log\n')
    // Ignored subtrees that must NEVER be walked or matched.
    await fs.mkdir(path.join(root, 'node_modules', 'markdown-it'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'markdown-it', 'index.js'), 'x')
    await fs.mkdir(path.join(root, '.git', 'markers'), { recursive: true })
    await fs.writeFile(path.join(root, '.git', 'markers', 'markdown.txt'), 'x')
    await fs.mkdir(path.join(root, 'dist'))
    await fs.writeFile(path.join(root, 'dist', 'markdown.bundle.js'), 'x')
    // A deep, tracked file the finder MUST reach.
    await fs.mkdir(path.join(root, 'src', 'renderer', 'lib'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'renderer', 'lib', 'markdown.ts'), 'x')
    await fs.writeFile(path.join(root, 'README.md'), '# hi')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns [] for an empty or 1-char query without walking', async () => {
    expect((await searchFiles(root, '')).entries).toEqual([])
    expect((await searchFiles(root, 'm')).entries).toEqual([])
  })

  it('finds a deep file and prunes .git / node_modules / dist', async () => {
    const res = await searchFiles(root, 'markdown')
    expect(res.error).toBeUndefined()
    const paths = res.entries.map((e) => e.path)
    // The deep tracked file is found.
    expect(paths).toContain(path.join(root, 'src', 'renderer', 'lib', 'markdown.ts'))
    // Nothing from an ignored/.git subtree ever appears (pruned during descent).
    expect(paths.every((p) => !p.includes(`${path.sep}node_modules${path.sep}`))).toBe(true)
    expect(paths.every((p) => !p.includes(`${path.sep}.git${path.sep}`))).toBe(true)
    expect(paths.every((p) => !p.includes(`${path.sep}dist${path.sep}`))).toBe(true)
  })

  it('matches against the path relative to root (subsequence across segments)', async () => {
    // `src/mark` is NOT a contiguous substring of `src/renderer/lib/markdown.ts`
    // but IS a subsequence — the finder should still surface it.
    const res = await searchFiles(root, 'src/mark')
    const rels = res.entries.map((e) => path.relative(root, e.path))
    expect(rels).toContain(path.join('src', 'renderer', 'lib', 'markdown.ts'))
  })

  it('stays confined to the root and never errors on a normal tree', async () => {
    const res = await searchFiles(root, 'md')
    expect(res.error).toBeUndefined()
    expect(res.entries.every((e) => e.path.startsWith(root))).toBe(true)
  })
})
