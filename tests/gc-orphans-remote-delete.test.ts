import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { expectedOf } from '../src/main/gc/gc-confirm'
import { parseOptions } from '../src/main/gc/gc-options'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { createGcOps, type GcShellDeps } from '../src/main/gc/gc-shell'
import { withActor } from '../src/main/gc/gc-actor'
import {
  remoteDeleteRefusal,
  type RemoteFacts,
  type RemotePolicy
} from '../src/main/gc/gc-remote-delete'
import { probeRemoteFacts } from '../src/main/gc/gc-remote-facts'
import { runBatch, type GcOps } from '../src/main/gc/pipeline-core'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import { bundle, NOW, reapItem } from './gc-fixtures'

/**
 * AC-D5 (unit D): "Also delete the branch on the remote". Off by default; offered only for a
 * branch merged by strong proof whose remote branch is not protected; runs
 * `git push <remote> --delete <branch>`; a failure is reported and never undoes or blocks the
 * local clean; the autopilot never does it.
 */

const POLICY: RemotePolicy = { neverDeleteRemote: false, protectedBranches: ['main', 'develop'] }

/** Everything the remote said is fine (delta-1: a merged PR, no open PR, no protection, same tip). */
const GOOD: RemoteFacts = {
  remote: 'origin',
  remoteSha: 'a'.repeat(40),
  remoteMatchesLocal: true,
  openPr: false,
  ghProtected: false
}

function eligible(over: Partial<WorktreeBundle> = {}, itemOver = {}): WorktreeBundle {
  const b = bundle('/ws/wt/feat-x', 'ready')
  return {
    ...b,
    fate: { fate: 'merged', signal: 'gh-merged', strong: true },
    item: reapItem('/ws/wt/feat-x', {
      branch: 'feat/x',
      needsRemoteDelete: true,
      justifiedBy: 'gh-merged',
      ...itemOver
    }),
    remoteFacts: GOOD,
    ...over
  }
}

describe('remoteDeleteRefusal (the one eligibility rule)', () => {
  it('accepts a strongly merged branch that still exists on the remote', () => {
    expect(remoteDeleteRefusal(eligible(), POLICY, GOOD)).toBeNull()
  })

  it.each([
    ['the kill switch is on', eligible(), { ...POLICY, neverDeleteRemote: true }, 'kill-switch'],
    ['the branch is protected', eligible({}, { branch: 'develop' }), POLICY, 'protected-branch'],
    [
      'the fate is not merged',
      eligible({ fate: { fate: 'closed-unmerged', signal: null, strong: false } }),
      POLICY,
      'not-merged'
    ],
    [
      'the merge proof is weak',
      eligible({ fate: { fate: 'merged', signal: 'patch-id', strong: false } }),
      POLICY,
      'weak-proof'
    ],
    [
      'the remote branch is already gone',
      eligible({ remoteFacts: { ...GOOD, remoteSha: null } }),
      POLICY,
      'no-remote-branch'
    ],
    ['there is no branch', eligible({}, { branch: undefined }), POLICY, 'no-branch']
  ] as const)('refuses when %s', (_why, b, policy, code) => {
    expect(remoteDeleteRefusal(b, policy, b.remoteFacts)).toBe(code)
  })
})

describe('parseOptions carries deleteRemote', () => {
  it('keeps only string ids and survives a structured clone', () => {
    const raw = structuredClone({ confirmed: [], expected: {}, deleteRemote: ['a', 7, 'b'] })
    expect(parseOptions(raw).deleteRemote).toEqual(['a', 'b'])
  })
  it('is absent (never "everything") when the renderer sends nothing or a boolean', () => {
    expect(parseOptions({ deleteRemote: true }).deleteRemote).toBeUndefined()
    expect(parseOptions({}).deleteRemote).toBeUndefined()
  })
})

describe('a manual clean passes the remote choice only for the ids that asked', () => {
  function rig(bundles: WorktreeBundle[]) {
    const seen: Array<{ id: string; deleteRemote: boolean }> = []
    const ops: GcOps = {
      reprobe: async () => ({ ok: true }),
      stopStacks: async () => undefined,
      removeContainers: async () => undefined,
      removeVolumes: async () => undefined,
      dropDeps: async () => 0,
      recheck: async () => ({ ok: true }),
      cleanGit: async (b, o) => {
        seen.push({ id: b.item.id, deleteRemote: o?.deleteRemote === true })
        return o?.deleteRemote
          ? { remoteDelete: { branch: b.item.branch!, ok: false, error: 'remote said no' } }
          : undefined
      }
    }
    let n = 0
    const done: unknown[] = []
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({ bundles: structuredClone(bundles), orphanVolumes: [] }),
      opsFor: () => ops,
      freshOrphans: async () => [],
      workStampOf: async () => null,
      removeOrphanVolumes: async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: (d) => done.push(d)
      }),
      state: createCycleState(),
      now: () => NOW
    }
    return { deps, seen, done }
  }

  it('a requested remote delete that fails is reported on the item and the local clean stays ok', async () => {
    const a = eligible()
    const b = {
      ...eligible(),
      item: { ...eligible().item, id: `${a.item.id}-2`, path: '/ws/wt/feat-y', branch: 'feat/y' }
    }
    const r = rig([a, b])
    const opts = structuredClone({
      expected: { [a.item.id]: expectedOf(a), [b.item.id]: expectedOf(b) },
      confirmed: [],
      deleteRemote: [a.item.id]
    })
    submitManualClean(r.deps, [a.item.id, b.item.id], parseOptions(opts))
    await r.deps.queue.idle()
    expect(r.seen).toEqual([
      { id: a.item.id, deleteRemote: true },
      { id: b.item.id, deleteRemote: false }
    ])
    const results = (r.done[0] as { results: Array<Record<string, unknown>> }).results
    expect(results[0]).toMatchObject({
      ok: true,
      remoteDelete: { branch: 'feat/x', ok: false, error: 'remote said no' }
    })
    expect(results[1]!.remoteDelete).toBeUndefined()
  })
})

describe('runBatch reports the remote outcome and never lets it fail the item', () => {
  it('an ok item with a failed remote delete stays ok', async () => {
    const ops: GcOps = {
      reprobe: async () => ({ ok: true }),
      stopStacks: async () => undefined,
      removeContainers: async () => undefined,
      removeVolumes: async () => undefined,
      dropDeps: async () => 0,
      recheck: async () => ({ ok: true }),
      cleanGit: async () => ({ remoteDelete: { branch: 'feat/x', ok: false, error: 'denied' } })
    }
    const [r] = await runBatch([eligible()], ops, { removeVolumes: false, deleteRemote: true })
    expect(r).toMatchObject({
      ok: true,
      haltedAt: null,
      remoteDelete: { ok: false, error: 'denied' }
    })
  })
})

// ---- the real thing: a bare remote ---------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

describe('against a real bare remote', () => {
  let root: string
  let repo: string
  let remote: string
  const WT = '/ws/wt/feat-x'

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-remote-delete-'))
    remote = path.join(root, 'origin.git')
    repo = path.join(root, 'repo')
    mkdirSync(remote)
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote])
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 'T')
    writeFileSync(path.join(repo, 'f.txt'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'branch', 'feat/x')
    // The branch tracks origin: the delete goes to the branch's own upstream remote.
    git(repo, 'push', '-q', '-u', 'origin', 'feat/x')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const remoteHas = (branch: string): boolean =>
    git(remote, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) !== ''

  function shellDeps(): GcShellDeps {
    const run = async (r: string, args: string[]): Promise<string> =>
      execFileSync('git', ['-C', r, ...args], { encoding: 'utf8' })
    const executor: ExecutorDeps = {
      probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
      hasUnpushed: async () => false,
      trash: async () => undefined,
      git: run,
      resolveSha: async (r, rev) => git(r, 'rev-parse', rev),
      archiveTip: async (_r, ref) => ref,
      archiveWip: async (_r, ref) => ref,
      detachSidebar: async () => undefined,
      canUnregister: async () => true,
      removeWorktreeAdmin: async () => true,
      appendTombstone: async () => undefined,
      now: () => NOW
    }
    return {
      executor,
      remotePolicy: async () => POLICY,
      allowRemoteDelete: true,
      // Real git for the remote; no GitHub here, so the two GitHub answers are stated.
      remoteFacts: async (b: WorktreeBundle) => ({
        ...(await probeRemoteFacts(b, {
          git: run,
          gh: async () => {
            throw new Error('no gh')
          }
        })),
        openPr: false,
        ghProtected: false
      })
    } as unknown as GcShellDeps
  }

  function item(over = {}): WorktreeBundle {
    const b = eligible()
    return {
      ...b,
      item: {
        ...b.item,
        repoPath: repo,
        path: WT,
        remoteSha: git(repo, 'rev-parse', 'feat/x'),
        ...over
      },
      localTip: git(repo, 'rev-parse', 'feat/x')
    }
  }

  it('deletes the remote branch when asked, with git push --delete', async () => {
    const out = await createGcOps(shellDeps()).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(false)
    expect(out).toEqual({ remoteDelete: { branch: 'feat/x', ok: true } })
    // The local branch went too (the ordinary clean), and main was never touched.
    expect(git(repo, 'branch', '--list', 'feat/x')).toBe('')
    expect(remoteHas('main')).toBe(true)
  })

  it('leaves the remote branch alone by default', async () => {
    const out = await createGcOps(shellDeps()).cleanGit(item())
    expect(remoteHas('feat/x')).toBe(true)
    expect(out?.remoteDelete).toBeUndefined()
    expect(git(repo, 'branch', '--list', 'feat/x')).toBe('')
  })

  it('a remote that refuses the delete is reported; the local clean still completes', async () => {
    const hook = path.join(remote, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "deletes are not allowed here" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const out = await createGcOps(shellDeps()).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(true)
    expect(out?.remoteDelete).toMatchObject({ branch: 'feat/x', ok: false })
    expect(out?.remoteDelete?.error).toMatch(/deletes are not allowed here|rejected|failed/i)
    expect(git(repo, 'branch', '--list', 'feat/x')).toBe('')
  })

  it('a remote that moved since the scan is not deleted (lease)', async () => {
    const other = path.join(root, 'other')
    execFileSync('git', ['clone', '-q', remote, other])
    git(other, 'config', 'user.email', 'a@b.c')
    git(other, 'config', 'user.name', 'T')
    git(other, 'checkout', '-q', 'feat/x')
    writeFileSync(path.join(other, 'g.txt'), '2')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'someone pushed more')
    git(other, 'push', '-q', 'origin', 'feat/x')
    const out = await createGcOps(shellDeps()).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(true)
    expect(out?.remoteDelete?.ok).toBe(false)
  })

  it('refuses a protected branch and the kill switch even when asked', async () => {
    const protectedDeps = {
      ...shellDeps(),
      remotePolicy: async () => ({ ...POLICY, protectedBranches: ['feat/x'] })
    } as GcShellDeps
    const a = await createGcOps(protectedDeps).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(true)
    expect(a?.remoteDelete).toMatchObject({
      ok: false,
      error: expect.stringContaining('protected')
    })

    git(repo, 'branch', 'feat/x')
    const killed = {
      ...shellDeps(),
      remotePolicy: async () => ({ ...POLICY, neverDeleteRemote: true })
    } as GcShellDeps
    const b = await createGcOps(killed).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(true)
    expect(b?.remoteDelete?.ok).toBe(false)
  })

  it('the autopilot actor can never delete a remote branch', async () => {
    const autopilot = withActor(shellDeps(), 'autopilot', () => defaultGcPrefs())
    expect(autopilot.allowRemoteDelete).toBe(false)
    const out = await createGcOps(autopilot).cleanGit(item(), { deleteRemote: true })
    expect(remoteHas('feat/x')).toBe(true)
    expect(out?.remoteDelete?.ok).toBe(false)
    expect(withActor(shellDeps(), 'operator', () => defaultGcPrefs()).allowRemoteDelete).toBe(true)
  })
})

describe('the autopilot has no way to ask (wiring)', () => {
  const read = async (p: string): Promise<string> =>
    (await import('node:fs')).readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  it.each(['gc-cycle.ts', 'autopilot-core.ts', 'gc-jobs-core.ts'])(
    '%s never mentions deleteRemote',
    async (file) => {
      expect(await read(`src/main/gc/${file}`)).not.toMatch(/deleteRemote/)
    }
  )
  it('only gc-manual forwards the choice into a run', async () => {
    expect(await read('src/main/gc/gc-manual.ts')).toMatch(/deleteRemote/)
    vi.fn()
  })
})
