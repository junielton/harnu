import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureDataDir,
  ensureDataDirExcluded,
  mkdirDataDir,
  resetDataDirExcludeCache
} from '../src/main/data-dir'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  })

const lines = (s: string): string[] => s.split('\n').filter((l) => l.length > 0)

describe('ensureDataDirExcluded', () => {
  let tmp: string
  let main: string
  let linked: string

  beforeEach(async () => {
    resetDataDirExcludeCache()
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'data-dir-exclude-')))
    main = join(tmp, 'main')
    linked = join(tmp, 'linked')
    await mkdir(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', linked, '-b', 'wt')
  })

  afterEach(() => rm(tmp, { recursive: true, force: true }))

  const excludeFile = (): string => join(main, '.git', 'info', 'exclude')

  it('appends both rules to the main checkout exclude, keeping the data dir out of status', async () => {
    await ensureDataDirExcluded(main)
    const rules = lines(await readFile(excludeFile(), 'utf8'))
    expect(rules).toContain('/.capy/')
    expect(rules).toContain('/.harnu/')

    await mkdir(join(main, '.capy', 'memory'), { recursive: true })
    await mkdir(join(main, '.harnu'), { recursive: true })
    await writeFile(join(main, '.capy', 'memory', 'hot.md'), 'x')
    await writeFile(join(main, '.harnu', 'a.md'), 'x')
    expect(git(main, 'status', '--porcelain')).toBe('')
  })

  it('from a linked worktree, writes the COMMON git dir so every worktree is covered', async () => {
    await ensureDataDirExcluded(linked)
    const rules = lines(await readFile(excludeFile(), 'utf8'))
    expect(rules).toContain('/.capy/')
    expect(rules).toContain('/.harnu/')

    await mkdir(join(linked, '.harnu', 'out'), { recursive: true })
    await writeFile(join(linked, '.harnu', 'out', 'x.md'), 'x')
    expect(git(linked, 'status', '--porcelain')).toBe('')
    expect(git(main, 'status', '--porcelain')).toBe('')
  })

  it('is idempotent: a second call adds nothing', async () => {
    await ensureDataDirExcluded(main)
    const first = await readFile(excludeFile(), 'utf8')
    resetDataDirExcludeCache() // force the second call to re-read the file
    await ensureDataDirExcluded(main)
    expect(await readFile(excludeFile(), 'utf8')).toBe(first)
  })

  it('preserves existing exclude content and only adds the missing rule', async () => {
    await mkdir(join(main, '.git', 'info'), { recursive: true })
    await writeFile(excludeFile(), '# mine\n*.swp\n/.capy/')
    await ensureDataDirExcluded(main)
    const text = await readFile(excludeFile(), 'utf8')
    expect(text.startsWith('# mine\n*.swp\n/.capy/\n')).toBe(true)
    expect(lines(text).filter((l) => l === '/.capy/')).toHaveLength(1)
    expect(lines(text)).toContain('/.harnu/')
  })

  it('creates info/ when it does not exist', async () => {
    await rm(join(main, '.git', 'info'), { recursive: true, force: true })
    await ensureDataDirExcluded(main)
    expect((await stat(excludeFile())).isFile()).toBe(true)
  })

  it('concurrent first writes append each rule exactly once', async () => {
    await Promise.all(Array.from({ length: 8 }, () => mkdirDataDir(join(main, '.capy', 'memory'))))
    const rules = lines(await readFile(excludeFile(), 'utf8'))
    expect(rules.filter((l) => l === '/.capy/')).toHaveLength(1)
    expect(rules.filter((l) => l === '/.harnu/')).toHaveLength(1)
  })

  it('concurrent first writes from different worktrees of one repo append each rule once', async () => {
    await Promise.all([
      ...Array.from({ length: 4 }, () => ensureDataDirExcluded(main)),
      ...Array.from({ length: 4 }, () => ensureDataDirExcluded(linked))
    ])
    const rules = lines(await readFile(excludeFile(), 'utf8'))
    expect(rules.filter((l) => l === '/.capy/')).toHaveLength(1)
    expect(rules.filter((l) => l === '/.harnu/')).toHaveLength(1)
  })

  it('caches a non-repo folder: git is probed once, later calls are free', async () => {
    const plain = join(tmp, 'plain-cached')
    await mkdir(plain)
    await ensureDataDirExcluded(plain)
    // Turn the folder into a repo behind the cache's back: the negative result stands.
    git(plain, 'init', '-q')
    await ensureDataDirExcluded(plain)
    await Promise.all([ensureDataDirExcluded(plain), ensureDataDirExcluded(plain)])
    expect(await readFile(join(plain, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.capy')
  })

  it('is a silent no-op outside a git repo', async () => {
    const plain = join(tmp, 'plain')
    await mkdir(plain)
    await expect(ensureDataDirExcluded(plain)).resolves.toBeUndefined()
    await expect(stat(join(plain, '.git'))).rejects.toThrow()
    await expect(stat(join(plain, 'info'))).rejects.toThrow()
  })

  it('is a silent no-op on a folder that does not exist', async () => {
    await expect(ensureDataDirExcluded(join(tmp, 'ghost'))).resolves.toBeUndefined()
  })

  it('never touches the tracked .gitignore', async () => {
    await writeFile(join(main, '.gitignore'), 'node_modules\n')
    git(main, 'add', '.gitignore')
    git(main, 'commit', '-q', '-m', 'ignore')
    await ensureDataDirExcluded(main)
    expect(await readFile(join(main, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(git(main, 'status', '--porcelain')).toBe('')
  })
})

describe('ensureDataDir / mkdirDataDir', () => {
  let tmp: string
  let repo: string

  beforeEach(async () => {
    resetDataDirExcludeCache()
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'data-dir-mk-')))
    repo = join(tmp, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
  })

  afterEach(() => rm(tmp, { recursive: true, force: true }))

  it('ensureDataDir creates the data dir and excludes it', async () => {
    await ensureDataDir(repo)
    expect((await stat(join(repo, '.harnu'))).isDirectory()).toBe(true)
    const rules = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(rules).toContain('/.harnu/')
    expect(rules).toContain('/.capy/') // the legacy copy is kept out of git too
  })

  it('mkdirDataDir makes the nested dir and excludes the owning data dir', async () => {
    const dir = join(repo, '.harnu', 'missions')
    await mkdirDataDir(dir)
    expect((await stat(dir)).isDirectory()).toBe(true)
    await writeFile(join(dir, 'm.md'), 'x')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('mkdirDataDir still recognizes the legacy .capy dir as a data dir', async () => {
    const dir = join(repo, '.capy', 'missions')
    await mkdirDataDir(dir)
    await writeFile(join(dir, 'm.md'), 'x')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('mkdirDataDir is a plain mkdir -p for a path outside any data dir (central memory)', async () => {
    const dir = join(tmp, 'central', 'memory', 'sessions')
    await mkdirDataDir(dir)
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.capy')
  })
})
