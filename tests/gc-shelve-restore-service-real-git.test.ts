// The restore service against real git (U2.3a AC-1/AC-2/AC-5): shelve a worktree with the real
// executor, then bring it back through `ensure` / `restoreById` the way a resume or Cleanup would.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { probeShelve } from '../src/main/gc/shelve-probe-shell'
import {
  defaultShelveExecDeps,
  shelveWorktree,
  type ShelveDecision
} from '../src/main/gc/shelve-exec-shell'
import {
  createShelveRestorer,
  defaultShelveRestoreDeps,
  type ShelveRestorer
} from '../src/main/gc/shelve-restore-shell'
import { readShelved } from '../src/main/gc/shelve-store'
import { archiveRefs, digestTree, git, makeFixture, type Fixture } from './gc-shelve-fixture'

/** Dependency dirs are regenerable and left to the session's own setup (design §4 U2). */
const DEPENDENCY_DIRS = ['node_modules']

let fx: Fixture
let storeFile: string
let restorer: ShelveRestorer
let changes = 0

beforeEach(() => {
  fx = makeFixture()
  storeFile = path.join(fx.root, 'gc-shelved.json')
  changes = 0
  restorer = createShelveRestorer(
    defaultShelveRestoreDeps({
      // electron-bound in the app; a throwaway repo has no sessions
      readStore: () => readShelved(storeFile),
      forget: async (id) => {
        const { updateShelved, withoutShelved } = await import('../src/main/gc/shelve-store')
        await updateShelved(storeFile, (c) => withoutShelved(c, [id]))
      },
      inUse: async () => false,
      sleep: async () => undefined,
      changed: () => {
        changes++
      }
    })
  )
})
afterEach(() => fx.cleanup())

async function shelve(): Promise<void> {
  const probe = await probeShelve({ item: { repoPath: fx.repo, path: fx.wt } })
  const decision: ShelveDecision = {
    id: `${fx.repo}::worktree::${fx.wt}`,
    repoPath: fx.repo,
    worktreePath: fx.wt,
    branch: 'feat/x',
    binding: { headSha: probe.headSha, workStamp: probe.workStamp, newestMtime: probe.newestMtime },
    since: 0,
    idleDays: 9,
    diskBytes: null
  }
  const out = await shelveWorktree(
    decision,
    defaultShelveExecDeps(storeFile, { inUse: async () => false })
  )
  expect(out.ok).toBe(true)
}

describe('the restore service against real git', () => {
  it('restores byte-identical when asked for a subfolder, forgets the entry, keeps the archive', async () => {
    const before = digestTree(fx.wt, DEPENDENCY_DIRS)
    await shelve()
    const archivesWhileShelved = archiveRefs(fx.repo)
    expect(archivesWhileShelved.length).toBeGreaterThan(0)
    expect(existsSync(fx.wt)).toBe(false)

    const out = await restorer.ensure(path.join(fx.wt, 'notes'))
    expect(out.status).toBe('restored')
    expect(digestTree(fx.wt, DEPENDENCY_DIRS)).toEqual(before)
    expect(existsSync(path.join(fx.wt, 'notes', 'u.txt'))).toBe(true)
    expect((await readShelved(storeFile)).entries).toEqual([])
    expect(archiveRefs(fx.repo)).toEqual(archivesWhileShelved)
    expect(changes).toBe(1)
  })

  it('answers not-shelved for a folder nobody shelved, touching nothing', async () => {
    await shelve()
    const out = await restorer.ensure(fx.repo)
    expect(out).toEqual({ status: 'not-shelved' })
    expect(existsSync(fx.wt)).toBe(false)
  })

  it('moves half-deleted leftovers aside with their bytes intact, then restores over the path', async () => {
    const before = digestTree(fx.wt, DEPENDENCY_DIRS)
    await shelve()
    // The cycle died halfway through the delete: part of the folder is still there.
    mkdirSync(fx.wt, { recursive: true })
    writeFileSync(path.join(fx.wt, 'tracked.txt'), 'original\nlocal edit\nthen more\n')

    const out = await restorer.restoreById(`${fx.repo}::worktree::${fx.wt}`)
    expect(out.status).toBe('restored')
    if (out.status !== 'restored') return
    expect(out.movedAside).not.toBeNull()
    expect(readFileSync(path.join(out.movedAside!, 'tracked.txt'), 'utf8')).toBe(
      'original\nlocal edit\nthen more\n'
    )
    expect(digestTree(fx.wt, DEPENDENCY_DIRS)).toEqual(before)
    expect(readdirSync(path.dirname(fx.wt)).some((n) => n.includes('.leftover-'))).toBe(true)
  })

  it('fails with a reason and keeps the entry when the archive record is gone', async () => {
    await shelve()
    const entry = (await readShelved(storeFile)).entries[0]
    git(fx.repo, 'update-ref', '-d', `${entry.namespace}/shelve/record`)

    const out = await restorer.ensure(fx.wt)
    expect(out).toMatchObject({ status: 'failed', reason: 'record-missing' })
    expect(existsSync(fx.wt)).toBe(false)
    expect((await readShelved(storeFile)).entries).toHaveLength(1)
  })
})
