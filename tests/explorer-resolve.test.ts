import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths, MAX_RESOLVE_CANDIDATES } from '../src/main/explorer-ipc'

/**
 * `explorer:resolve` is the gate that decides whether a path printed in a
 * transcript becomes an option+clickable link. It must agree with what the
 * Explorer tree can actually SHOW: inside the root and outside `.git`. The tree
 * lists gitignored entries (dimmed), so those resolve too.
 */

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'harnu-resolve-'))
  await fs.mkdir(join(root, 'src', 'main'), { recursive: true })
  await fs.writeFile(join(root, 'src', 'main', 'pty.ts'), 'x')
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await fs.writeFile(join(root, 'src', 'main', `${name}.ts`), 'x')
  }
  await fs.mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await fs.writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'x')
  await fs.mkdir(join(root, '.git'), { recursive: true })
  await fs.writeFile(join(root, '.git', 'config'), 'x')
  await fs.writeFile(join(root, '.gitignore'), 'node_modules\n')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('resolvePaths', () => {
  it('resolves a root-relative path against cwd', async () => {
    const out = await resolvePaths(root, root, ['src/main/pty.ts'])
    expect(out).toEqual([
      { text: 'src/main/pty.ts', path: join(root, 'src', 'main', 'pty.ts'), isDir: false }
    ])
  })

  it('flags a directory', async () => {
    const out = await resolvePaths(root, root, ['src/main'])
    expect(out).toEqual([{ text: 'src/main', path: join(root, 'src', 'main'), isDir: true }])
  })

  it('resolves a relative path against a nested cwd', async () => {
    const out = await resolvePaths(root, join(root, 'src'), ['main/pty.ts'])
    expect(out[0]?.path).toBe(join(root, 'src', 'main', 'pty.ts'))
  })

  it('accepts an absolute path inside the root', async () => {
    const abs = join(root, 'src', 'main', 'pty.ts')
    const out = await resolvePaths(root, root, [abs])
    expect(out).toEqual([{ text: abs, path: abs, isDir: false }])
  })

  it('drops a path that does not exist', async () => {
    expect(await resolvePaths(root, root, ['src/main/nope.ts'])).toEqual([])
  })

  it('drops a path outside the root', async () => {
    expect(await resolvePaths(root, root, ['../escape', '/etc/hosts'])).toEqual([])
  })

  it('resolves a gitignored path, since the tree lists it dimmed', async () => {
    const out = await resolvePaths(root, root, ['node_modules/dep/index.js'])
    expect(out.map((r) => r.path)).toEqual([join(root, 'node_modules', 'dep', 'index.js')])
  })

  it('drops a path under .git even though it is not gitignored', async () => {
    // `.git` is never listed in `.gitignore` (git doesn't put itself there), so
    // this must be rejected by the ALWAYS_EXCLUDE check specifically — the tree
    // never shows `.git`, so a link into it could never be revealed.
    expect(await resolvePaths(root, root, ['.git/config'])).toEqual([])
  })

  it('dedupes repeated candidates', async () => {
    const out = await resolvePaths(root, root, ['src/main/pty.ts', 'src/main/pty.ts'])
    expect(out).toHaveLength(1)
  })

  it('caps how many candidates it will stat', async () => {
    const many = Array.from({ length: MAX_RESOLVE_CANDIDATES + 5 }, (_, i) => `src/main/x${i}.ts`)
    // None exist, so the assertion is that it returns rather than hanging, and
    // that the cap is a real number the provider can rely on.
    expect(await resolvePaths(root, root, many)).toEqual([])
    expect(MAX_RESOLVE_CANDIDATES).toBe(32)
  })

  it('never throws on junk input', async () => {
    // @ts-expect-error deliberately wrong shape — this crosses an IPC boundary.
    expect(await resolvePaths(root, root, null)).toEqual([])
    expect(await resolvePaths('', '', ['a/b'])).toEqual([])
  })
})
