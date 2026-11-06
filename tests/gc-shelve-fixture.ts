// Shared throwaway-repo fixture for the shelve engine's real-git tests (U2.1). Every test builds its
// own repository under os.tmpdir(); nothing here touches the Harnu repo's refs or stash.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

export interface Fixture {
  root: string
  repo: string
  /** A linked worktree on branch `feat/x`. */
  wt: string
  cleanup(): void
}

/** The bytes of the two ignored files outside dependency dirs that {@link dirty} writes. */
export const ENV_BODY = 'SECRET=1\n'
export const SHOT_BODY = 'not-really-a-png\n'
export const IGNORED_BYTES = Buffer.byteLength(ENV_BODY) + Buffer.byteLength(SHOT_BODY)

/** A repo on `main` with a linked worktree on `feat/x`, already carrying {@link dirty} state. */
export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harnu-shelve-'))
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(path.join(repo, 'tracked.txt'), 'original\n')
  writeFileSync(path.join(repo, 'deleted.txt'), 'will be deleted\n')
  writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(path.join(repo, 'run.sh'), 0o755)
  writeFileSync(
    path.join(repo, '.gitignore'),
    ['.env', '.harnu/out/', 'node_modules/', 'dist/', ''].join('\n')
  )
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const wt = path.join(root, 'trees', 'feat-x')
  mkdirSync(path.dirname(wt), { recursive: true })
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
  dirty(wt)
  return { root, repo, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * The state shelving exists for. Idempotent, so a test can stash and then call it again: a tracked
 * edit, a deleted tracked file, a staged new file, an untracked file, an executable edit, a symlink,
 * ignored files outside dependency dirs and an ignored file inside `node_modules`.
 */
export function dirty(wt: string): void {
  writeFileSync(path.join(wt, 'tracked.txt'), 'original\nlocal edit\n')
  rmSync(path.join(wt, 'deleted.txt'), { force: true })
  writeFileSync(path.join(wt, 'staged.txt'), 'staged only\n')
  git(wt, 'add', 'staged.txt')
  mkdirSync(path.join(wt, 'notes'), { recursive: true })
  writeFileSync(path.join(wt, 'notes', 'u.txt'), 'untracked\n')
  writeFileSync(path.join(wt, 'run.sh'), '#!/bin/sh\necho edited\n')
  rmSync(path.join(wt, 'link'), { force: true })
  symlinkSync('tracked.txt', path.join(wt, 'link'))
  writeFileSync(path.join(wt, '.env'), ENV_BODY)
  mkdirSync(path.join(wt, '.harnu', 'out'), { recursive: true })
  writeFileSync(path.join(wt, '.harnu', 'out', 'shot.txt'), SHOT_BODY)
  mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
}

/** Every ref name in the repo, sorted. */
export const refNames = (repo: string): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort()

/** Refs under `refs/archive/`. */
export const archiveRefs = (repo: string): string[] =>
  refNames(repo).filter((r) => r.startsWith('refs/archive/'))

/**
 * path → `mode:content-hash` for every file under `dir` except `.git` and the given top-level
 * names. A symlink is hashed by its target and a regular file by its bytes; only the executable
 * bit of the mode is kept (it is all git holds).
 */
export function digestTree(dir: string, skipTop: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = rel === '' ? name : `${rel}/${name}`
      if (rel === '' && (name === '.git' || skipTop.includes(name))) continue
      const abs = path.join(dir, r)
      const st = lstatSync(abs)
      if (st.isDirectory()) walk(r)
      else if (st.isSymbolicLink()) {
        out[r] = `link:${readlinkSync(abs)}`
      } else {
        const exec = (st.mode & 0o111) !== 0 ? 'x' : '-'
        out[r] = `${exec}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`
      }
    }
  }
  walk('')
  return out
}
