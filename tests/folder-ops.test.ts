import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Folder-ops IPC core (T69): create-a-subfolder + recursively-list-subfolders,
 * backing the FolderMenu "New folder…" / "Open subfolder…" flows. The risk
 * surface is (1) the traversal defense on the name (must stay inside the parent)
 * and (2) the bounded, ignore-aware walk (depth cap + node_modules/.git/… skip).
 * Every assertion observes an independent signal — a real on-disk tree, a
 * hand-written path literal — never a value derived from the function under test.
 *
 * `electron` is mocked because `folder-ops` → `user-projects` imports `app`.
 */
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  ipcMain: { handle: (): void => {} }
}))

import {
  resolveSubfolderTarget,
  createSubfolder,
  listSubfolders,
  listChildFolders
} from '../src/main/folder-ops'

describe('resolveSubfolderTarget — traversal defense', () => {
  const parent = '/home/u/project'

  it('resolves a plain single-segment name inside the parent', () => {
    expect(resolveSubfolderTarget(parent, 'feature')).toBe('/home/u/project/feature')
  })

  it('resolves a nested relative name that stays inside the parent', () => {
    expect(resolveSubfolderTarget(parent, 'a/b')).toBe('/home/u/project/a/b')
  })

  it('rejects an empty / whitespace-only name', () => {
    expect(() => resolveSubfolderTarget(parent, '')).toThrow()
    expect(() => resolveSubfolderTarget(parent, '   ')).toThrow()
  })

  it('rejects an absolute path', () => {
    expect(() => resolveSubfolderTarget(parent, '/etc/passwd')).toThrow()
  })

  it('rejects `..` traversal that escapes the parent', () => {
    expect(() => resolveSubfolderTarget(parent, '..')).toThrow()
    expect(() => resolveSubfolderTarget(parent, '../sibling')).toThrow()
    expect(() => resolveSubfolderTarget(parent, 'a/../../escape')).toThrow()
  })
})

describe('createSubfolder — real fs', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-folderops-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates the directory and returns its (real) path', async () => {
    const created = await createSubfolder(root, 'feature')
    // Independent signal: the directory genuinely exists on disk now.
    const st = await fs.stat(path.join(root, 'feature'))
    expect(st.isDirectory()).toBe(true)
    // The returned path resolves to the same place (realpath may differ from the
    // literal on macOS /var→/private/var, so compare via realpath).
    expect(created).toBe(await fs.realpath(path.join(root, 'feature')))
  })

  it('is idempotent for an already-existing directory', async () => {
    await createSubfolder(root, 'dup')
    await expect(createSubfolder(root, 'dup')).resolves.toBeTruthy()
  })

  it('rejects when a NON-directory already occupies the target', async () => {
    await fs.writeFile(path.join(root, 'afile'), 'x')
    await expect(createSubfolder(root, 'afile')).rejects.toThrow()
  })

  it('rejects when the parent is not an existing directory', async () => {
    await expect(createSubfolder(path.join(root, 'nope'), 'x')).rejects.toThrow()
  })

  it('rejects a traversal name without writing anything outside the parent', async () => {
    await expect(createSubfolder(root, '../escape')).rejects.toThrow()
    // Nothing was created next to the temp root.
    await expect(fs.stat(path.join(root, '..', 'escape'))).rejects.toThrow()
  })
})

describe('listSubfolders — bounded, ignore-aware walk', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-folderscan-'))
    // A tree: src/lib/util/deep/toodeep (5 levels), plus ignored + dot dirs.
    await fs.mkdir(path.join(root, 'src/lib/util/deep/toodeep'), { recursive: true })
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true })
    await fs.mkdir(path.join(root, '.git/objects'), { recursive: true })
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true })
    await fs.mkdir(path.join(root, 'vendor'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'file.txt'), 'x') // files are skipped
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists directories, skipping ignored + dot dirs, capped at depth 4', async () => {
    const { entries, truncated } = await listSubfolders(root)
    const rels = entries.map((e) => e.relativePath)

    expect(rels).toContain('src')
    expect(rels).toContain('docs')
    expect(rels).toContain('src/lib')
    expect(rels).toContain('src/lib/util')
    expect(rels).toContain('src/lib/util/deep') // depth 4 — included

    // Depth cap: the 5th level is never enumerated.
    expect(rels).not.toContain('src/lib/util/deep/toodeep')
    // Ignored + dot dirs (and their children) never appear.
    expect(rels).not.toContain('node_modules')
    expect(rels).not.toContain('node_modules/pkg')
    expect(rels).not.toContain('vendor')
    expect(rels).not.toContain('.git')
    expect(rels).not.toContain('.hidden')
    // Files are never listed.
    expect(rels).not.toContain('src/file.txt')

    expect(truncated).toBe(false)
    // Sorted ascending by relative path.
    expect([...rels].sort()).toEqual(rels)
  })

  it('reports the correct depth per entry', async () => {
    const { entries } = await listSubfolders(root)
    const byRel = new Map(entries.map((e) => [e.relativePath, e.depth]))
    expect(byRel.get('src')).toBe(1)
    expect(byRel.get('src/lib')).toBe(2)
    expect(byRel.get('src/lib/util/deep')).toBe(4)
  })

  it('rejects a non-directory root', async () => {
    await expect(listSubfolders(path.join(root, 'does-not-exist'))).rejects.toThrow()
  })
})

describe('listChildFolders — one lazy level (T73)', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-childscan-'))
    // Direct children: app (has a real subdir), leaf (empty), onlyIgnored
    // (contains only node_modules → no expandable children).
    await fs.mkdir(path.join(root, 'app/Http'), { recursive: true })
    await fs.mkdir(path.join(root, 'leaf'), { recursive: true })
    await fs.mkdir(path.join(root, 'onlyIgnored/node_modules/pkg'), { recursive: true })
    // Noise that must never surface as a direct child.
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true })
    await fs.writeFile(path.join(root, 'file.txt'), 'x')
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns only direct children, skipping ignored/dot dirs and files', async () => {
    const { entries, truncated } = await listChildFolders(root)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(['app', 'leaf', 'onlyIgnored']) // sorted, one level only
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('.hidden')
    expect(names).not.toContain('file.txt')
    expect(names).not.toContain('Http') // grandchild — never in a one-level scan
    expect(truncated).toBe(false)
  })

  it('flags hasChildren only for a node with a non-ignored subdirectory', async () => {
    const { entries } = await listChildFolders(root)
    const byName = new Map(entries.map((e) => [e.name, e.hasChildren]))
    expect(byName.get('app')).toBe(true) // app/Http
    expect(byName.get('leaf')).toBe(false) // empty
    // Its only subdir is node_modules → not expandable in the picker.
    expect(byName.get('onlyIgnored')).toBe(false)
  })

  it('returns absolute paths that resolve under the scanned dir', async () => {
    const { entries } = await listChildFolders(root)
    const app = entries.find((e) => e.name === 'app')!
    expect(app.path).toBe(path.join(path.resolve(root), 'app'))
  })

  it('rejects a non-directory path', async () => {
    await expect(listChildFolders(path.join(root, 'does-not-exist'))).rejects.toThrow()
  })
})
