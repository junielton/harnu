/**
 * The foreign-checkout walk (delta 7) on a real temp tree with real git: a worktree of
 * another repo, or a plain clone, created inside a worktree carries its own `.git`, which
 * `git worktree list` of the worktree's repo never shows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findForeignCheckouts } from '../src/main/gc/gc-shell'

let tmp = ''

/** Real git, isolated from the machine's config: no global/system config, no hooks. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'harnu',
      GIT_AUTHOR_EMAIL: 'harnu@example.invalid',
      GIT_COMMITTER_NAME: 'harnu',
      GIT_COMMITTER_EMAIL: 'harnu@example.invalid'
    }
  })
}

/** A repo with one commit at `dir`. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** `org/proj/www` and its linked worktree A, whose own root `.git` is a file. */
function worktreeA(): { www: string; a: string } {
  const www = repo(join(tmp, 'org/proj/www'))
  const a = join(tmp, 'org/proj/worktrees/PROJ-0000-slug')
  git(www, 'worktree', 'add', '-q', '-b', 'feat/PROJ-0000-slug', a)
  return { www, a }
}

/** A `.git` file at `dir`, creating the folders on the way. */
function dotGitFile(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /nowhere\n')
  return join(dir, '.git')
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'harnu-gc-foreign-')))
  writeFileSync(join(tmp, 'gitconfig'), '')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('findForeignCheckouts (delta 7)', () => {
  it('finds nothing in a linked worktree: its own root `.git` file never counts', async () => {
    const { a } = worktreeA()
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('finds a worktree of another repo added inside it', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    git(repo2, 'worktree', 'add', '-q', '-b', 'feat/b', join(a, '.claude/worktrees/b'))
    expect(await findForeignCheckouts(a)).toEqual([join(a, '.claude/worktrees/b/.git')])
  })

  it('finds a plain clone inside it, without descending into that `.git` directory', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    git(a, 'clone', '-q', repo2, join(a, 'libs/api-gateway'))
    expect(await findForeignCheckouts(a)).toEqual([join(a, 'libs/api-gateway/.git')])
  })

  it('returns every one, sorted', async () => {
    const { a } = worktreeA()
    const z = dotGitFile(join(a, 'z'))
    const b = dotGitFile(join(a, 'b'))
    expect(await findForeignCheckouts(a)).toEqual([b, z])
  })

  it.each(['node_modules', 'vendor', '.venv', 'venv'])(
    'a `.git` inside %s/somepkg does not count',
    async (dir) => {
      const { a } = worktreeA()
      dotGitFile(join(a, dir, 'somepkg'))
      expect(await findForeignCheckouts(a)).toEqual([])
    }
  )

  it('does not follow a symlink to a repo elsewhere', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    symlinkSync(repo2, join(a, 'linked'))
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('does not record a symlink named `.git`', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    mkdirSync(join(a, 'sub'))
    symlinkSync(join(repo2, '.git'), join(a, 'sub/.git'))
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('sees a `.git` at depth 6 and not one at depth 7', async () => {
    const { a } = worktreeA()
    const six = dotGitFile(join(a, '1/2/3/4/5'))
    dotGitFile(join(a, 'x/2/3/4/5/6'))
    expect(await findForeignCheckouts(a)).toEqual([six])
  })

  it('takes a smaller depth bound', async () => {
    const { a } = worktreeA()
    const two = dotGitFile(join(a, '1'))
    dotGitFile(join(a, 'x/2'))
    expect(await findForeignCheckouts(a, { maxDepth: 2 })).toEqual([two])
  })

  it('rejects when the root is gone', async () => {
    await expect(findForeignCheckouts(join(tmp, 'gone'))).rejects.toThrow(/ENOENT/)
  })

  // Root ignores permissions, so the unreadable folder is readable there.
  it.skipIf(process.getuid?.() === 0)('rejects when a folder inside cannot be read', async () => {
    const { a } = worktreeA()
    const locked = join(a, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      await expect(findForeignCheckouts(a)).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
