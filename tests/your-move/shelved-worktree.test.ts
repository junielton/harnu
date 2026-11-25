/**
 * BUG-308 review: a worktree Cleanup shelved has no folder on purpose, and resuming one of its
 * sessions brings it back. Its cards are still actionable, so "the folder is gone" must not
 * apply to it. An unreadable shelved list says nothing: the card stays.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readShelvedForUpdate, SHELVED_FILE } from '../../src/main/gc/shelve-store'
import { shelvedAware, type Presence } from '../../src/main/your-move/hygiene'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-shelved-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const shelve = (worktreePath: string): Promise<void> =>
  writeFile(
    path.join(dir, SHELVED_FILE),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'b',
          repoPath: dir,
          worktreePath,
          branch: 'feat/search',
          headSha: 'abc1234',
          namespace: 'refs/archive/feat-search',
          shelvedAt: 1,
          idleDays: 4,
          reason: 'Shelved',
          freedBytes: null
        }
      ]
    })
  )

const presence = (base: Presence): ((folder: string) => Promise<Presence>) =>
  shelvedAware(
    async () => base,
    () => readShelvedForUpdate(path.join(dir, SHELVED_FILE))
  )

describe('a shelved worktree is not a gone folder', () => {
  it('counts as present, and so does a folder inside it', async () => {
    const wt = path.join(dir, 'wt')
    await shelve(wt)
    expect(await presence('missing')(wt)).toBe('present')
    expect(await presence('missing')(path.join(wt, 'api'))).toBe('present')
  })

  it('leaves a folder nobody shelved as gone, with a list or without one', async () => {
    expect(await presence('missing')(path.join(dir, 'removed'))).toBe('missing')
    await shelve(path.join(dir, 'wt'))
    expect(await presence('missing')(path.join(dir, 'removed'))).toBe('missing')
  })

  it('knows nothing about a missing folder when the list cannot be read', async () => {
    await writeFile(path.join(dir, SHELVED_FILE), 'not json')
    expect(await presence('missing')(path.join(dir, 'removed'))).toBe('unknown')
  })

  it('passes a present or unknown folder through', async () => {
    await writeFile(path.join(dir, SHELVED_FILE), 'not json')
    expect(await presence('present')(dir)).toBe('present')
    expect(await presence('unknown')('relative')).toBe('unknown')
  })
})
