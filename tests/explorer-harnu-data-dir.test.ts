import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * BUG-128 — `.harnu/**` is the agent's data dir (deliverables land in
 * `.harnu/out/`) and is gitignored in most repos, so the Explorer's three
 * gitignore gates (`listDir`, `searchFiles`, `resolvePaths`) used to hide the
 * very files an agent prints in the transcript. Only the root-level `.harnu/`
 * subtree is exempt; every other gitignored path must stay hidden, and `.git`
 * and root confinement must be unchanged.
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

import { isHarnuDataPath, listDir, searchFiles, resolvePaths } from '../src/main/explorer-ipc'

describe('isHarnuDataPath — the exemption predicate', () => {
  it('accepts the data dir itself and everything under it', () => {
    expect(isHarnuDataPath('.harnu')).toBe(true)
    expect(isHarnuDataPath('.harnu/out')).toBe(true)
    expect(isHarnuDataPath('.harnu/out/T389-roteiro-operador.md')).toBe(true)
    expect(isHarnuDataPath('.harnu/memory/roadmap/x.md')).toBe(true)
  })

  it('rejects look-alikes, nested data dirs and every other path', () => {
    expect(isHarnuDataPath('')).toBe(false)
    expect(isHarnuDataPath('.harnu-old/out')).toBe(false)
    expect(isHarnuDataPath('.harnux')).toBe(false)
    expect(isHarnuDataPath('sub/.harnu/out/a.md')).toBe(false)
    expect(isHarnuDataPath('node_modules/.harnu/a')).toBe(false)
    expect(isHarnuDataPath('src/main/pty.ts')).toBe(false)
  })

  it('does NOT alias the legacy .capy/ data dir', () => {
    expect(isHarnuDataPath('.capy')).toBe(false)
    expect(isHarnuDataPath('.capy/out/x.md')).toBe(false)
  })

  it('never exempts an escape or an absolute path', () => {
    expect(isHarnuDataPath('../.harnu/out')).toBe(false)
    expect(isHarnuDataPath('/.harnu/out')).toBe(false)
    expect(isHarnuDataPath('.harnu/../node_modules/x')).toBe(false)
  })
})

let root: string
const NAME = 'T389-roteiro-operador.md'

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-datadir-'))
  const w = async (rel: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), 'x')
  }
  await w(`.harnu/out/${NAME}`)
  await w('.harnu/out/canvas/board.harnucanvas.json')
  await w('.harnu/memory/hot.md')
  await w('.capy/out/legacy-roteiro.md')
  await w('node_modules/dep/index.js')
  await w('dist/bundle.js')
  await w('random-ignored/notes.md')
  await w('sub/.harnu/out/nested-roteiro.md')
  await w('src/main/pty.ts')
  await w('.env')
  await w('.git/config')
  // Everything below is gitignored — `.harnu/` included, as in this very repo.
  await fs.writeFile(
    path.join(root, '.gitignore'),
    ['.harnu/', '.capy/', 'node_modules/', 'dist/', 'random-ignored/', 'sub/.harnu/', '.env'].join(
      '\n'
    ) + '\n'
  )
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const names = (r: { entries: Array<{ name: string }> }): string[] => r.entries.map((e) => e.name)

describe('listDir — .harnu/** shows up despite .gitignore', () => {
  it('lists .harnu at the root, and still hides every other ignored entry', async () => {
    const got = names(await listDir(root, root))
    expect(got).toContain('.harnu')
    expect(got).toContain('src')
    for (const hidden of ['.capy', 'node_modules', 'dist', 'random-ignored', '.env', '.git']) {
      expect(got).not.toContain(hidden)
    }
  })

  it('lists every child of .harnu, siblings of out included', async () => {
    expect(names(await listDir(root, path.join(root, '.harnu'))).sort()).toEqual(['memory', 'out'])
  })

  it('lists nested directories and files under .harnu/out', async () => {
    expect(names(await listDir(root, path.join(root, '.harnu', 'out')))).toEqual(['canvas', NAME])
    expect(names(await listDir(root, path.join(root, '.harnu', 'out', 'canvas')))).toEqual([
      'board.harnucanvas.json'
    ])
  })

  it('does not exempt a .harnu that is not at the root', async () => {
    expect(names(await listDir(root, path.join(root, 'sub')))).not.toContain('.harnu')
  })
})

describe('searchFiles — .harnu/** is searchable, everything else ignored stays pruned', () => {
  it('finds the motivating deliverable by name', async () => {
    const res = await searchFiles(root, 'roteiro-operador')
    expect(res.entries.map((e) => path.relative(root, e.path))).toEqual([`.harnu/out/${NAME}`])
  })

  it('finds a nested file under .harnu/out', async () => {
    const res = await searchFiles(root, 'board.harnucanvas')
    expect(res.entries.map((e) => path.relative(root, e.path))).toEqual([
      '.harnu/out/canvas/board.harnucanvas.json'
    ])
  })

  it('never surfaces ignored node_modules, dist, random dirs, .capy or a nested .harnu', async () => {
    for (const q of ['index.js', 'bundle', 'notes', 'legacy-roteiro', 'nested-roteiro']) {
      expect((await searchFiles(root, q)).entries).toEqual([])
    }
  })
})

describe('resolvePaths — .harnu/** resolves, relative exactly as an agent prints it', () => {
  it('resolves the motivating path (file)', async () => {
    const out = await resolvePaths(root, root, [`.harnu/out/${NAME}`])
    expect(out).toEqual([
      {
        text: `.harnu/out/${NAME}`,
        path: path.join(root, '.harnu', 'out', NAME),
        isDir: false
      }
    ])
  })

  it('resolves the data dir and a subdirectory (dir → reveal)', async () => {
    const out = await resolvePaths(root, root, ['.harnu', '.harnu/out'])
    expect(out.map((r) => [r.text, r.isDir])).toEqual([
      ['.harnu', true],
      ['.harnu/out', true]
    ])
  })

  it('resolves an absolute path and a relative-from-a-nested-cwd path under .harnu', async () => {
    const abs = path.join(root, '.harnu', 'out', NAME)
    expect((await resolvePaths(root, root, [abs])).map((r) => r.path)).toEqual([abs])
    const viaCwd = await resolvePaths(root, path.join(root, '.harnu'), [`out/${NAME}`])
    expect(viaCwd.map((r) => r.path)).toEqual([abs])
  })

  it('still drops every other gitignored path', async () => {
    const out = await resolvePaths(root, root, [
      'node_modules/dep/index.js',
      'dist/bundle.js',
      'random-ignored/notes.md',
      '.capy/out/legacy-roteiro.md',
      'sub/.harnu/out/nested-roteiro.md',
      '.env'
    ])
    expect(out).toEqual([])
  })

  it('keeps .git unreachable and confinement unchanged', async () => {
    expect(await resolvePaths(root, root, ['.git/config'])).toEqual([])
    expect(
      await resolvePaths(root, root, [
        '../.harnu/out/x.md',
        '.harnu/../node_modules/dep/index.js',
        '/etc/hosts'
      ])
    ).toEqual([])
  })
})
