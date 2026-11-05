// Real-git coverage of the dependency dirs shelving leaves out (U2.2 AC-3): the repo's OWN
// `ephemeral:` list decides what is not snapshotted, at any depth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { preserveWorktree, restoreWorktree, verifyPreservation } from '../src/main/gc/shelve-shell'
import { shelveManifestFrom } from '../src/main/gc/shelve-manifest-shell'
import { dependencyDirsFor } from '../src/main/gc/shelve-core'
import { DEFAULT_EPHEMERAL } from '../src/main/worktree-manifest'
import { ENV_BODY, git, makeFixture, type Fixture } from './gc-shelve-fixture'

const NOW = Date.parse('2026-11-05T10:00:00Z')

let fx: Fixture
beforeEach(() => {
  fx = makeFixture()
})
afterEach(() => fx.cleanup())

const ignoreLocally = (pattern: string): void => {
  const exclude = path.resolve(fx.repo, git(fx.repo, 'rev-parse', '--git-path', 'info/exclude'))
  mkdirSync(path.dirname(exclude), { recursive: true })
  appendFileSync(exclude, `${pattern}\n`)
}

const input = (over: Record<string, unknown> = {}) => ({
  repoPath: fx.repo,
  worktreePath: fx.wt,
  branch: 'feat/x' as string | null,
  now: NOW,
  ...over
})

const files = (ref: string): string[] =>
  git(fx.repo, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort()

describe('a repo with a custom ephemeral list (AC-3)', () => {
  it('snapshots everything outside those dirs, including node_modules the list does not name', async () => {
    ignoreLocally('.cache-x/')
    mkdirSync(path.join(fx.wt, '.cache-x'), { recursive: true })
    writeFileSync(path.join(fx.wt, '.cache-x', 'blob'), 'regenerable\n')
    const manifest = shelveManifestFrom(
      { worktreeMd: '---\nephemeral:\n  - .cache-x\n---\n' },
      fx.repo
    )
    expect(manifest.dependencyDirs).toEqual(['.cache-x', '**/.cache-x'])

    const r = await preserveWorktree(input({ dependencyDirs: manifest.dependencyDirs }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(files(r.record.ignored!.ref)).toEqual([
      '.env',
      '.harnu/out/shot.txt',
      'node_modules/pkg/index.js'
    ])
    expect(r.record.dependencyDirs).toEqual(['.cache-x', '**/.cache-x'])
    expect((await verifyPreservation(r.record)).ok).toBe(true)
  })

  it('a record made with any-depth entries restores byte-for-byte what it kept', async () => {
    ignoreLocally('.cache-x/')
    mkdirSync(path.join(fx.wt, '.cache-x'), { recursive: true })
    writeFileSync(path.join(fx.wt, '.cache-x', 'blob'), 'regenerable\n')
    const dirs = shelveManifestFrom(
      { worktreeMd: '---\nephemeral:\n  - .cache-x\n---\n' },
      fx.repo
    ).dependencyDirs
    const r = await preserveWorktree(input({ dependencyDirs: dirs }))
    if (!r.ok) throw new Error(r.message)
    rmSync(fx.wt, { recursive: true, force: true })
    const back = await restoreWorktree(r.record)
    expect(back.ok).toBe(true)
    expect(readFileSync(path.join(fx.wt, '.env'), 'utf8')).toBe(ENV_BODY)
    expect(existsSync(path.join(fx.wt, '.cache-x'))).toBe(false)
  })
})

describe('nested dependency dirs in a monorepo (AC-3)', () => {
  const nested = (): void => {
    const dir = path.join(fx.wt, 'packages', 'a', 'node_modules', 'dep')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(300 * 1024, 1))
  }

  it('without the any-depth entry a nested node_modules counts toward the cap (the problem)', async () => {
    nested()
    const r = await preserveWorktree(
      input({ dependencyDirs: ['node_modules'], capBytes: 100 * 1024 })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('snapshot-too-large')
  })

  it('with the manifest list at any depth it is left out, verifies live, and is not recreated', async () => {
    nested()
    const dirs = dependencyDirsFor(DEFAULT_EPHEMERAL)
    const r = await preserveWorktree(input({ dependencyDirs: dirs, capBytes: 100 * 1024 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(files(r.record.ignored!.ref)).toEqual(['.env', '.harnu/out/shot.txt'])
    expect((await verifyPreservation(r.record)).ok).toBe(true)

    rmSync(fx.wt, { recursive: true, force: true })
    const back = await restoreWorktree(r.record)
    expect(back.ok).toBe(true)
    expect(existsSync(path.join(fx.wt, 'packages', 'a', 'node_modules'))).toBe(false)
    expect(readFileSync(path.join(fx.wt, '.env'), 'utf8')).toBe(ENV_BODY)
  })

  it('an ignored file that merely sits next to a nested dependency dir is still kept', async () => {
    nested()
    writeFileSync(path.join(fx.wt, 'packages', 'a', '.env.local'), 'KEEP=1\n')
    ignoreLocally('.env.local')
    const r = await preserveWorktree(
      input({ dependencyDirs: dependencyDirsFor(DEFAULT_EPHEMERAL), capBytes: 100 * 1024 })
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(files(r.record.ignored!.ref)).toContain('packages/a/.env.local')
  })
})
