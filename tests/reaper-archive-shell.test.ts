/**
 * Real-git integration coverage for the preserve-before-sweeping shell (T254).
 *
 * These run against a throwaway repository on disk rather than a mock: the
 * claims under test — untracked files ARE captured, ignored files are NOT, the
 * refs survive `git gc --prune=now`, the restored bytes are identical — are
 * claims about git's behaviour, and a stubbed `execFile` would only assert that
 * we typed the arguments we meant to type.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { archiveTip, archiveWip } from '../src/main/reaper/archive-shell'

const run = promisify(execFile)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { windowsHide: true })).stdout

const NS = 'refs/archive/feat/x/20260828T182233Z'
const TIP_REF = `${NS}/tip`
const WIP_REF = `${NS}/wip`

let repo: string
let root: string

/** A repo on `feat/x` carrying tracked edits, untracked files, and ignored build output. */
async function seedRepo(): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-t254-'))
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@harnu.run'])
  await git(repo, ['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\n')
  await fs.writeFile(path.join(repo, '.gitignore'), 'build/\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-qm', 'init'])
  await git(repo, ['checkout', '-qb', 'feat/x'])

  // The three shapes that matter: a tracked modification, an untracked file
  // that exists nowhere else (the motivating 87-line ADR), and ignored output.
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\nlocal edit\n')
  await fs.writeFile(path.join(repo, 'adr.md'), '# ADR 0001\nexists nowhere else\n')
  await fs.mkdir(path.join(repo, 'notes'))
  await fs.writeFile(path.join(repo, 'notes/deep.txt'), 'nested untracked\n')
  await fs.mkdir(path.join(repo, 'build'))
  await fs.writeFile(path.join(repo, 'build/bundle.js'), 'regenerable\n')
}

beforeAll(async () => {
  await seedRepo()
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('archiveTip / archiveWip against a real repository', () => {
  it('points the tip ref at the branch head', async () => {
    const head = (await git(repo, ['rev-parse', 'feat/x'])).trim()
    const written = await archiveTip(repo, TIP_REF, head)
    expect(written).toBe(head)
    expect((await git(repo, ['rev-parse', TIP_REF])).trim()).toBe(head)
  })

  it('captures tracked modifications and untracked files, and skips ignored ones', async () => {
    const commit = await archiveWip(repo, WIP_REF, repo)
    expect((await git(repo, ['rev-parse', WIP_REF])).trim()).toBe(commit)

    const files = (await git(repo, ['ls-tree', '-r', '--name-only', WIP_REF]))
      .split('\n')
      .filter(Boolean)
    expect(files).toContain('tracked.txt')
    expect(files).toContain('adr.md')
    expect(files).toContain('notes/deep.txt')
    expect(files).not.toContain('build/bundle.js')

    // The tip alone does not hold any of it — which is why a second ref exists.
    const tipFiles = (await git(repo, ['ls-tree', '-r', '--name-only', TIP_REF]))
      .split('\n')
      .filter(Boolean)
    expect(tipFiles).not.toContain('adr.md')
  })

  it('leaves the worktree index and the repo-wide stash untouched', async () => {
    const status = await git(repo, ['status', '--porcelain'])
    expect(status).toContain(' M tracked.txt')
    expect(status).toContain('?? adr.md')
    expect((await git(repo, ['stash', 'list'])).trim()).toBe('')
  })

  it('survives the sweep: refs outlive a branch delete, a wiped worktree and gc --prune=now', async () => {
    const before = new Map<string, string>()
    for (const rel of ['tracked.txt', 'adr.md', 'notes/deep.txt']) {
      before.set(rel, await fs.readFile(path.join(repo, rel), 'utf8'))
    }

    // Sweep: drop the branch and everything the folder held.
    await git(repo, ['checkout', '-q', 'main'])
    await git(repo, ['branch', '-D', 'feat/x'])
    for (const rel of ['adr.md', 'notes', 'build']) {
      await fs.rm(path.join(repo, rel), { recursive: true, force: true })
    }
    await git(repo, ['checkout', '--', 'tracked.txt'])
    await git(repo, ['gc', '--prune=now', '-q'])

    const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/archive/']))
      .split('\n')
      .filter(Boolean)
    expect(refs.sort()).toEqual([TIP_REF, WIP_REF].sort())

    // Restore into a detached worktree — the recovery route docs/user/cleanup.md
    // documents — and compare bytes.
    const restore = path.join(root, 'restored')
    await git(repo, ['worktree', 'add', '--detach', '-q', restore, WIP_REF])
    for (const [rel, content] of before) {
      expect(await fs.readFile(path.join(restore, rel), 'utf8')).toBe(content)
    }
    expect(await fs.readFile(path.join(restore, 'tracked.txt'), 'utf8')).toContain('local edit')
  })
})

describe('the stash stack is never touched (AC-6)', () => {
  it('has no `git stash push` anywhere in the reaper implementation', async () => {
    const dir = path.join(process.cwd(), 'src/main/reaper')
    const names = await fs.readdir(dir)
    const offenders: string[] = []
    for (const name of names.filter((n) => n.endsWith('.ts'))) {
      const raw = await fs.readFile(path.join(dir, name), 'utf8')
      // Comments are stripped first: this file's own header explains WHY the
      // stash is off-limits, and prose about the rule must not trip the rule.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      // Both the shell form and the argv form the executor deps would use.
      if (/stash['"\s,\]]*.{0,12}push/.test(src) || /git stash push/.test(src)) {
        offenders.push(name)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * The shape production actually runs on.
 *
 * Every folder-bearing `ReapItem` is built from a `git worktree list` entry with
 * the main checkout explicitly skipped (`scan-core.ts`), so `archiveWip` is
 * ALWAYS called with `worktreePath !== repoPath`: a linked worktree whose `.git`
 * is a *file* pointing into `<repo>/.git/worktrees/<name>`, sharing the main
 * repo's object store, while the closing `update-ref` runs in a different cwd.
 * The suite above covers only a plain checkout, which no sweep ever targets.
 */
describe('archiveWip against a linked worktree (the production shape)', () => {
  const NS2 = 'refs/archive/feat/y/20260828T190000Z'
  const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x4d])

  let root2: string
  let repo2: string
  let wt: string

  beforeAll(async () => {
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-t254-wt-'))
    repo2 = path.join(root2, 'repo')
    await fs.mkdir(repo2)
    await git(repo2, ['init', '-q', '-b', 'main'])
    await git(repo2, ['config', 'user.email', 'test@harnu.run'])
    await git(repo2, ['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(repo2, 'tracked.txt'), 'v1\n')
    await fs.writeFile(path.join(repo2, '.gitignore'), 'build/\n')
    await git(repo2, ['add', '-A'])
    await git(repo2, ['commit', '-qm', 'init'])

    wt = path.join(root2, 'wt')
    await git(repo2, ['worktree', 'add', '-q', '-b', 'feat/y', wt])
    await fs.writeFile(path.join(wt, 'tracked.txt'), 'v1\nlocal edit\n')
    await git(wt, ['add', 'tracked.txt']) // staged, not committed
    await fs.writeFile(path.join(wt, 'adr.md'), '# ADR\nexists nowhere else\n')
    await fs.writeFile(path.join(wt, 'shot.bin'), BINARY) // untracked binary
    await fs.mkdir(path.join(wt, 'build'))
    await fs.writeFile(path.join(wt, 'build/bundle.js'), 'regenerable\n')
  })

  afterAll(async () => {
    await fs.rm(root2, { recursive: true, force: true })
  })

  it('restores staged, unstaged and untracked work byte-identically after a full sweep', async () => {
    await archiveTip(repo2, `${NS2}/tip`, (await git(repo2, ['rev-parse', 'feat/y'])).trim())
    await archiveWip(repo2, `${NS2}/wip`, wt)

    // Sweep the worktree exactly as the executor does: trash the folder, prune,
    // delete the branch, then prove the objects are not merely unreferenced.
    await fs.rm(wt, { recursive: true, force: true })
    await git(repo2, ['worktree', 'prune'])
    await git(repo2, ['branch', '-D', 'feat/y'])
    await git(repo2, ['gc', '--prune=now', '-q'])

    const restore = path.join(root2, 'restored')
    await git(repo2, ['worktree', 'add', '--detach', '-q', restore, `${NS2}/wip`])

    expect(await fs.readFile(path.join(restore, 'tracked.txt'), 'utf8')).toBe('v1\nlocal edit\n')
    expect(await fs.readFile(path.join(restore, 'adr.md'), 'utf8')).toBe(
      '# ADR\nexists nowhere else\n'
    )
    // Byte-for-byte, not just present: an archive that mangles binary content
    // preserves nothing that matters.
    expect(await fs.readFile(path.join(restore, 'shot.bin'))).toEqual(BINARY)
    await expect(fs.access(path.join(restore, 'build/bundle.js'))).rejects.toThrow()

    // The tip is still reachable too, and the worktree's own index was never used.
    expect((await git(repo2, ['rev-parse', `${NS2}/tip`])).trim()).toBeTruthy()
    expect((await git(repo2, ['stash', 'list'])).trim()).toBe('')
  })
})
