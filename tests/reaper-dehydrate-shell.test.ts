/**
 * Real-git integration coverage for dehydrate / rehydrate (T250).
 *
 * These run against throwaway repositories on disk, not mocks: "the uncommitted
 * edits are byte-identical afterwards", "a committed vendor/ is refused", "the
 * install's lockfile rewrite is named" are claims about git and the filesystem,
 * and a stubbed `execFile` would only assert the arguments we meant to type.
 *
 * The executor is the same `dehydrateItem` / `rehydrateItem` the IPC handler
 * runs; only the session probe and the record write are faked (they need the
 * Electron fleet and `userData`), and the setup runner is `sh -c` in the
 * worktree — the same shape `runManifestCommand` uses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  dehydrateItem,
  rehydrateItem,
  planDehydrate,
  toSetupOutcome,
  type DehydrateDeps,
  type RehydrateDeps,
  type ManifestFacts
} from '../src/main/reaper/dehydrate-core'
import {
  measureFolder,
  probeEphemeralEntries,
  removeEphemeralDir,
  trackedFingerprint,
  type ExecFn
} from '../src/main/reaper/dehydrate-shell'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const run = promisify(execFile)
const exec: ExecFn = async (file, args, opts) => {
  const r = await run(file, [...args], { ...opts, encoding: 'utf8', windowsHide: true })
  return { stdout: r.stdout }
}
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout

let root: string
let repo: string

async function write(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/** A PHP-and-node repo that COMMITS vendor/ and ignores node_modules/. */
async function seedRepo(): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-t250-'))
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@harnu.run'])
  await git(repo, ['config', 'user.name', 'Test'])
  await write(path.join(repo, '.gitignore'), 'node_modules/\n.venv/\n')
  await write(path.join(repo, 'src/app.txt'), 'original\n')
  await write(path.join(repo, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')
  await write(path.join(repo, 'vendor/acme/lib.php'), '<?php // committed dependency\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-qm', 'init'])
}

/** A fresh linked worktree carrying a tracked edit, an untracked file and installed deps. */
async function makeWorktree(name: string, detached = false): Promise<string> {
  const wt = path.join(root, name)
  await git(repo, ['worktree', 'add', '-q', ...(detached ? ['--detach'] : ['-b', name]), wt])
  await write(path.join(wt, 'src/app.txt'), 'original\nan uncommitted edit\n')
  await write(path.join(wt, 'notes.md'), 'untracked, exists nowhere else\n')
  await write(path.join(wt, 'node_modules/left-pad/index.js'), 'module.exports = 1\n'.repeat(500))
  await write(path.join(wt, '.venv/bin/python'), '#!/bin/sh\n')
  return wt
}

function item(wt: string, over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: `item-${wt}`,
    repoPath: repo,
    kind: 'worktree',
    branch: path.basename(wt),
    path: wt,
    hidden: false,
    ageDays: 40,
    diskBytes: null,
    checkpoints: [],
    verdict: 'blocked',
    blockers: ['dirty'],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: null,
    hydration: null,
    ...over
  }
}

const MANIFEST: ManifestFacts = {
  ephemeral: ['node_modules', 'vendor', '.venv', 'venv'],
  setup: []
}

function realDehydrateDeps(manifest: ManifestFacts = MANIFEST): DehydrateDeps {
  return {
    isSessionLive: async () => false,
    readManifest: async () => manifest,
    probeEntries: (wt, entries) => probeEphemeralEntries(exec, wt, entries),
    trackedFingerprint: (wt) => trackedFingerprint(exec, wt),
    removeDir: removeEphemeralDir,
    recordDehydrated: async () => undefined
  }
}

function realRehydrateDeps(setup: string[]): RehydrateDeps {
  return {
    isSessionLive: async () => false,
    readManifest: async () => ({ ephemeral: MANIFEST.ephemeral, setup }),
    preflightShell: async () => undefined,
    runSetupStep: async (command, cwd) => {
      try {
        await run('sh', ['-c', command], { cwd, encoding: 'utf8' })
        return { ok: true }
      } catch (err) {
        return toSetupOutcome(err, command)
      }
    },
    setupPath: async () => process.env.PATH,
    trackedFingerprint: (wt) => trackedFingerprint(exec, wt),
    recordRehydrated: async () => undefined
  }
}

beforeAll(async () => {
  await seedRepo()
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('dehydrate against a real repository', () => {
  // AC-1
  it('leaves uncommitted tracked changes byte-identical and keeps untracked work', async () => {
    const wt = await makeWorktree('ac1')
    const editBefore = await fs.readFile(path.join(wt, 'src/app.txt'))
    const statusBefore = await git(wt, ['status', '--porcelain'])

    const r = await dehydrateItem(item(wt), realDehydrateDeps())

    expect(r.ok).toBe(true)
    expect(r.removed.sort()).toEqual(['.venv', 'node_modules'])
    expect(r.trackedChanged).toEqual([])
    expect(await exists(path.join(wt, 'node_modules'))).toBe(false)
    expect(await exists(path.join(wt, '.venv'))).toBe(false)
    expect((await fs.readFile(path.join(wt, 'src/app.txt'))).equals(editBefore)).toBe(true)
    expect(await git(wt, ['status', '--porcelain'])).toBe(statusBefore)
    expect(await fs.readFile(path.join(wt, 'notes.md'), 'utf8')).toBe(
      'untracked, exists nowhere else\n'
    )
    // The branch and the checkout are untouched.
    expect((await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('ac1')
  })

  // AC-3
  it('skips a committed vendor/ with the reason surfaced, and never removes it', async () => {
    const wt = await makeWorktree('ac3')
    const facts = await probeEphemeralEntries(exec, wt, ['node_modules', 'vendor'])
    const plan = planDehydrate({
      sessionLive: false,
      ephemeral: ['node_modules', 'vendor'],
      entries: facts
    })
    expect(plan.skipped).toEqual([{ path: 'vendor', reason: 'tracked' }])

    const r = await dehydrateItem(item(wt), realDehydrateDeps())
    expect(r.skipped).toContainEqual({ path: 'vendor', reason: 'tracked' })
    expect(await fs.readFile(path.join(wt, 'vendor/acme/lib.php'), 'utf8')).toBe(
      '<?php // committed dependency\n'
    )
  })

  it('leaves a seeded symlink and its target alone', async () => {
    const wt = await makeWorktree('link')
    const shared = path.join(root, 'shared-node-modules')
    await write(path.join(shared, 'pkg/index.js'), 'shared\n')
    await fs.rm(path.join(wt, 'node_modules'), { recursive: true })
    await fs.symlink(shared, path.join(wt, 'node_modules'))

    const r = await dehydrateItem(item(wt), realDehydrateDeps())
    expect(r.skipped).toContainEqual({ path: 'node_modules', reason: 'symlink' })
    expect(await exists(path.join(shared, 'pkg/index.js'))).toBe(true)
    expect((await fs.lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(true)
  })

  it('reaches a detached-HEAD worktree', async () => {
    const wt = await makeWorktree('detached', true)
    const r = await dehydrateItem(
      item(wt, { kind: 'detached-worktree', branch: undefined, blockers: ['detached-head'] }),
      realDehydrateDeps()
    )
    expect(r.ok).toBe(true)
    expect(await exists(path.join(wt, 'node_modules'))).toBe(false)
  })

  it('refuses when a session is live at execution time, removing nothing', async () => {
    const wt = await makeWorktree('live')
    const r = await dehydrateItem(item(wt), {
      ...realDehydrateDeps(),
      isSessionLive: async () => true
    })
    expect(r.ok).toBe(false)
    expect(r.skipped).toContainEqual({ path: 'node_modules', reason: 'session-live' })
    expect(await exists(path.join(wt, 'node_modules/left-pad/index.js'))).toBe(true)
  })
})

describe('rehydrate against a real repository', () => {
  async function dehydrated(name: string): Promise<string> {
    const wt = await makeWorktree(name)
    await dehydrateItem(item(wt), realDehydrateDeps())
    return wt
  }

  // AC-5 (success) and AC-2 (tracked set unchanged)
  it('restores a working checkout and reports an unchanged tracked set', async () => {
    const wt = await dehydrated('rehydrate-clean')
    const r = await rehydrateItem(
      item(wt),
      realRehydrateDeps([
        'mkdir -p node_modules/left-pad && echo "restored" > node_modules/left-pad/index.js'
      ])
    )
    expect(r).toMatchObject({ ok: true, changedTracked: [] })
    expect(await fs.readFile(path.join(wt, 'node_modules/left-pad/index.js'), 'utf8')).toBe(
      'restored\n'
    )
  })

  // AC-2 — the install rewrote a tracked lockfile; the result names it.
  it('names a lockfile the install rewrote', async () => {
    const wt = await dehydrated('rehydrate-lock')
    const r = await rehydrateItem(
      item(wt),
      realRehydrateDeps([
        'mkdir -p node_modules/left-pad',
        `printf '{ "lockfileVersion": 3, "rewritten": true }\\n' > package-lock.json`
      ])
    )
    expect(r.ok).toBe(true)
    expect(r.changedTracked).toEqual(['package-lock.json'])
    // The pre-existing uncommitted edit is not reported as the install's doing.
    expect(r.changedTracked).not.toContain('src/app.txt')
  })

  // AC-5 (failure) — create_worktree's vocabulary, from a real `sh -c`.
  it('reports WORKTREE_PROVISION_FAILED for a missing binary', async () => {
    const wt = await dehydrated('rehydrate-missing')
    const r = await rehydrateItem(
      item(wt),
      realRehydrateDeps(['harnu-no-such-binary-t250 install'])
    )
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({
      error: 'WORKTREE_PROVISION_FAILED',
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'harnu-no-such-binary-t250 install',
      kind: 'binary-missing',
      binary: 'harnu-no-such-binary-t250',
      path: process.env.PATH
    })
  })

  it('reports a failing command with its exit code', async () => {
    const wt = await dehydrated('rehydrate-exit')
    const r = await rehydrateItem(item(wt), realRehydrateDeps(['echo broken >&2; exit 3']))
    expect(r.failure).toMatchObject({ kind: 'command-failed', exitCode: 3 })
    expect(r.failure!.stderr).toContain('broken')
  })
})

describe('measureFolder', () => {
  it.skipIf(process.platform !== 'linux')(
    'sizes the folder and each removable child in one du traversal',
    async () => {
      const wt = await makeWorktree('measure')
      await write(path.join(wt, 'node_modules/big.bin'), 'x'.repeat(300_000))
      const m = await measureFolder(exec, wt, ['node_modules'], Date.now())
      const nm = m.byChild.get('node_modules')!
      expect(nm).toBeGreaterThanOrEqual(300_000)
      expect(m.total!).toBeGreaterThan(nm)
    }
  )

  it('is size-blind on Windows by design — never a guess', async () => {
    const m = await measureFolder(exec, root, ['node_modules'], Date.now(), 'win32')
    expect(m.total).toBeNull()
    expect(m.byChild.get('node_modules')).toBeNull()
  })
})
