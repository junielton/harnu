/**
 * BUG-240 S-1 — `git/refs`: read HEAD and refs straight from the git directory,
 * with no `git` spawn. The contract is "exact or say you cannot tell": on a layout
 * it does not fully understand (reftable, malformed HEAD, a long symbolic chain)
 * it returns the `UNSURE` sentinel and the caller uses the spawn path.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { UNSURE, readHead, readRef, readSymbolicRef, resolveGitDirs } from '../src/main/git/refs'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const commit = (cwd: string, msg: string): void => {
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg)
}

let root = ''
let main = ''
let linked = ''
let rootSha = ''
let childSha = ''

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-gitrefs-'))
  main = path.join(root, 'main')
  linked = path.join(root, 'linked')
  await fs.mkdir(main)
  git(main, 'init', '-q', '-b', 'main')
  commit(main, 'root')
  rootSha = git(main, 'rev-parse', 'HEAD')
  git(main, 'worktree', 'add', '-q', '-b', 'feat/child', linked)
  commit(linked, 'child')
  childSha = git(linked, 'rev-parse', 'HEAD')
})

describe('git/refs', () => {
  it('resolves refs across layouts and falls back when unsure', async () => {
    // A main checkout: `.git` is a directory, git dir and common dir are one.
    const mainDirs = await resolveGitDirs(main)
    expect(mainDirs).toEqual({
      gitDir: await fs.realpath(path.join(main, '.git')),
      commonDir: await fs.realpath(path.join(main, '.git'))
    })
    if (mainDirs === null || mainDirs === UNSURE) throw new Error('unreachable')
    expect(await readHead(mainDirs)).toEqual({
      kind: 'branch',
      ref: 'refs/heads/main',
      branch: 'main'
    })
    expect(await readRef(mainDirs, 'refs/heads/main')).toBe(rootSha)

    // A linked worktree: `.git` is a file, the refs live in the common dir.
    const linkedDirs = await resolveGitDirs(linked)
    if (linkedDirs === null || linkedDirs === UNSURE) throw new Error('linked worktree not read')
    expect(linkedDirs.commonDir).toBe(await fs.realpath(path.join(main, '.git')))
    expect(linkedDirs.gitDir).not.toBe(linkedDirs.commonDir)
    expect(await readHead(linkedDirs)).toEqual({
      kind: 'branch',
      ref: 'refs/heads/feat/child',
      branch: 'feat/child'
    })
    expect(await readRef(linkedDirs, 'refs/heads/feat/child')).toBe(childSha)
    // A ref of the SHARED repo, read through the linked worktree.
    expect(await readRef(linkedDirs, 'refs/heads/main')).toBe(rootSha)

    // A missing ref is `null`, not a throw and not the sentinel.
    expect(await readRef(mainDirs, 'refs/heads/nope')).toBeNull()

    // A detached HEAD carries the sha and no branch.
    const detached = path.join(root, 'detached')
    git(main, 'worktree', 'add', '-q', '--detach', detached, rootSha)
    const detachedDirs = await resolveGitDirs(detached)
    if (detachedDirs === null || detachedDirs === UNSURE) throw new Error('detached not read')
    expect(await readHead(detachedDirs)).toEqual({ kind: 'detached', sha: rootSha })

    // A ref that exists only in packed-refs (peeled `^` lines are skipped).
    const packed = path.join(root, 'packed')
    await fs.mkdir(packed)
    git(packed, 'init', '-q', '-b', 'main')
    commit(packed, 'p1')
    const packedSha = git(packed, 'rev-parse', 'HEAD')
    git(packed, 'tag', '-a', '-m', 'annotated', 'v1')
    git(packed, 'branch', 'side')
    git(packed, 'pack-refs', '--all')
    await expect(fs.stat(path.join(packed, '.git', 'refs', 'heads', 'side'))).rejects.toThrow()
    const packedDirs = await resolveGitDirs(packed)
    if (packedDirs === null || packedDirs === UNSURE) throw new Error('packed not read')
    expect(await readRef(packedDirs, 'refs/heads/side')).toBe(packedSha)
    expect(await readRef(packedDirs, 'refs/heads/main')).toBe(packedSha)
    expect(await readRef(packedDirs, 'refs/tags/v1')).toBe(git(packed, 'rev-parse', 'refs/tags/v1'))
    expect(await readRef(packedDirs, 'refs/heads/not-there')).toBeNull()
    expect(await readHead(packedDirs)).toMatchObject({ kind: 'branch', branch: 'main' })

    // `origin/HEAD` is a symbolic ref: read it as one.
    git(main, 'update-ref', 'refs/remotes/origin/main', rootSha)
    git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    expect(await readSymbolicRef(mainDirs, 'refs/remotes/origin/HEAD')).toBe(
      'refs/remotes/origin/main'
    )
    expect(await readSymbolicRef(mainDirs, 'refs/remotes/origin/absent')).toBeNull()

    // Not a working tree: a regular file, a directory with no `.git`, a missing path.
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    const file = path.join(root, 'spec.md')
    await fs.writeFile(file, '# spec')
    expect(await resolveGitDirs(plain)).toBeNull()
    expect(await resolveGitDirs(file)).toBeNull()
    expect(await resolveGitDirs(path.join(root, 'gone'))).toBeNull()
    // It does not walk up: a subdirectory of a repo is not itself a working tree here.
    await fs.mkdir(path.join(main, 'sub'))
    expect(await resolveGitDirs(path.join(main, 'sub'))).toBeNull()

    // Anything it does not fully understand is the sentinel, never a guess.
    const reftable = path.join(root, 'reftable')
    await fs.mkdir(reftable)
    git(reftable, 'init', '-q', '-b', 'main')
    await fs.mkdir(path.join(reftable, '.git', 'reftable'))
    expect(await resolveGitDirs(reftable)).toBe(UNSURE)

    const refStorage = path.join(root, 'refstorage')
    await fs.mkdir(refStorage)
    git(refStorage, 'init', '-q', '-b', 'main')
    await fs.appendFile(
      path.join(refStorage, '.git', 'config'),
      '[extensions]\n\trefStorage = reftable\n'
    )
    expect(await resolveGitDirs(refStorage)).toBe(UNSURE)

    const malformed = path.join(root, 'malformed')
    await fs.mkdir(malformed)
    git(malformed, 'init', '-q', '-b', 'main')
    await fs.writeFile(path.join(malformed, '.git', 'HEAD'), 'not a head\n')
    const malformedDirs = await resolveGitDirs(malformed)
    if (malformedDirs === null || malformedDirs === UNSURE) throw new Error('unreachable')
    expect(await readHead(malformedDirs)).toBe(UNSURE)

    // A symbolic ref with more than one level is not followed.
    await fs.writeFile(path.join(main, '.git', 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n')
    expect(await readRef(mainDirs, 'refs/heads/alias')).toBe(UNSURE)
    // A loose ref with unexpected content is not guessed at either.
    await fs.writeFile(path.join(main, '.git', 'refs', 'heads', 'junk'), 'zzz\n')
    expect(await readRef(mainDirs, 'refs/heads/junk')).toBe(UNSURE)
  })
})
