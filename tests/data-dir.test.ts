import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_DIR,
  dataDir,
  dataDirAt,
  mainCheckoutRoot,
  repoDataDir,
  repoRoot
} from '../src/main/data-dir'
import { mainCheckoutRoot as hibernationMainCheckoutRoot } from '../src/main/hibernation'

describe('data-dir resolver', () => {
  let tmp: string
  let main: string
  let linked: string

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'data-dir-')))
    main = join(tmp, 'main')
    linked = join(tmp, 'linked')
    await mkdir(join(main, '.git', 'worktrees', 'linked'), { recursive: true })
    await writeFile(join(main, '.git', 'worktrees', 'linked', 'commondir'), '../..\n')
    await mkdir(linked, { recursive: true })
    await writeFile(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'linked')}\n`)
  })

  afterEach(() => rm(tmp, { recursive: true, force: true }))

  it('keeps the current directory name (no behavior change in this unit)', () => {
    expect(DATA_DIR).toBe('.harnu')
  })

  it('dataDirAt joins the data dir under a resolved root', () => {
    expect(dataDirAt('/r')).toBe(join('/r', DATA_DIR))
  })

  it('dataDir is per-worktree: a linked worktree keeps its own dir', () => {
    expect(dataDir(linked)).toBe(join(linked, DATA_DIR))
  })

  it('repoDataDir resolves a linked worktree to the MAIN checkout', () => {
    expect(repoRoot(linked)).toBe(main)
    expect(repoDataDir(linked)).toBe(join(main, DATA_DIR))
    expect(repoDataDir(main)).toBe(join(main, DATA_DIR))
  })

  it('falls back to the folder itself outside a git repo', async () => {
    const plain = join(tmp, 'plain')
    await mkdir(plain)
    expect(mainCheckoutRoot(plain)).toBeNull()
    expect(repoDataDir(plain)).toBe(join(plain, DATA_DIR))
  })

  it('hibernation re-exports the same resolver (one implementation)', () => {
    expect(hibernationMainCheckoutRoot).toBe(mainCheckoutRoot)
  })
})
