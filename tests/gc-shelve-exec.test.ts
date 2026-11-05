// shelveWorktree with every dependency faked (U2.2 AC-3, AC-4): the order of the steps, what each
// refusal leaves behind, and that the folder is only deleted once the decision still holds and the
// archive is verified.

import { describe, expect, it } from 'vitest'
import type { ShelveProbe } from '../src/main/gc/shelve-eligibility-core'
import {
  shelveWorktree,
  type ShelveDecision,
  type ShelveExecDeps
} from '../src/main/gc/shelve-exec-shell'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import type { ShelvedEntry } from '../src/main/gc/shelve-store'

const HEAD = 'a'.repeat(40)
const NOW = Date.parse('2026-11-05T10:00:00Z')

const decision = (over: Partial<ShelveDecision> = {}): ShelveDecision => ({
  id: '/r::worktree::/r-trees/feat-x',
  repoPath: '/r',
  worktreePath: '/r-trees/feat-x',
  branch: 'feat/x',
  binding: { headSha: HEAD, workStamp: 'w1', newestMtime: 100 },
  since: NOW - 9 * 86_400_000,
  idleDays: 9,
  diskBytes: 5_000,
  ...over
})

const probeOf = (over: Partial<ShelveProbe> = {}): ShelveProbe => ({
  headSha: HEAD,
  workStamp: 'w1',
  newestMtime: 100,
  lastCommitAt: NOW - 9 * 86_400_000,
  manifestDelegates: false,
  ...over
})

const record = {
  version: 1,
  namespace: 'refs/archive/feat/x/20261105T100000Z',
  headSha: HEAD,
  branch: 'feat/x',
  worktreePath: '/r-trees/feat-x',
  tipRef: 'refs/archive/feat/x/20261105T100000Z/tip',
  wipRef: 'refs/archive/feat/x/20261105T100000Z/wip'
} as unknown as ShelveRecord

interface Harness {
  calls: string[]
  stored: ShelvedEntry[]
  deps: ShelveExecDeps
}

function harness(over: Partial<ShelveExecDeps> = {}, probes: ShelveProbe[] = []): Harness {
  const calls: string[] = []
  const stored: ShelvedEntry[] = []
  const queue = [...probes]
  const deps: ShelveExecDeps = {
    probe: async () => {
      calls.push('probe')
      return queue.shift() ?? probeOf()
    },
    inUse: async () => {
      calls.push('inUse')
      return false
    },
    canUnregister: async () => {
      calls.push('canUnregister')
      return true
    },
    manifest: async () => {
      calls.push('manifest')
      return { dependencyDirs: ['node_modules', '**/node_modules'], delegates: false }
    },
    preserve: async (input) => {
      calls.push(`preserve:${(input.dependencyDirs ?? []).join(',')}`)
      return { ok: true, record }
    },
    verify: async () => {
      calls.push('verify')
      return { ok: true, mode: 'live' }
    },
    remember: async (e) => {
      calls.push('remember')
      stored.push(e)
    },
    forget: async (id) => {
      calls.push('forget')
      stored.splice(0, stored.length, ...stored.filter((e) => e.id !== id))
    },
    removeFolder: async () => {
      calls.push('removeFolder')
    },
    unregister: async () => {
      calls.push('unregister')
      return true
    },
    now: () => NOW,
    ...over
  }
  return { calls, stored, deps }
}

describe('shelveWorktree — the order (AC-3)', () => {
  it('re-probes, preserves with the repo’s own dependency dirs, verifies, remembers, THEN deletes', async () => {
    const h = harness()
    const out = await shelveWorktree(decision(), h.deps)
    expect(out.ok).toBe(true)
    expect(h.calls).toEqual([
      'probe',
      'inUse',
      'canUnregister',
      'manifest',
      'preserve:node_modules,**/node_modules',
      'verify',
      'probe',
      'inUse',
      'remember',
      'removeFolder',
      'unregister'
    ])
    if (!out.ok) return
    expect(out.entry).toMatchObject({
      id: decision().id,
      worktreePath: '/r-trees/feat-x',
      branch: 'feat/x',
      headSha: HEAD,
      namespace: record.namespace,
      shelvedAt: NOW,
      idleDays: 9,
      freedBytes: 5_000
    })
    expect(out.entry.reason).toBe('Shelved `feat/x` — idle 9 d, branch kept')
    expect(h.stored).toHaveLength(1)
  })

  it('a detached worktree says so in its reason', async () => {
    const h = harness()
    const out = await shelveWorktree(decision({ branch: null }), h.deps)
    expect(out.ok && out.entry.reason).toBe(
      `Shelved detached HEAD ${HEAD.slice(0, 7)} — idle 9 d, archive kept`
    )
    expect(out.ok && out.entry.branch).toBeNull()
  })
})

describe('shelveWorktree — changed since decided (AC-4)', () => {
  it.each([
    ['HEAD moved', { headSha: 'b'.repeat(40) }],
    ['a file was edited (work stamp)', { workStamp: 'w2' }],
    ['a newer file mtime', { newestMtime: 200 }],
    ['the tree became clean', { workStamp: null, newestMtime: null }]
  ])('%s → refused before anything is touched', async (_n, change) => {
    const h = harness({}, [probeOf(change)])
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'reprobe', reason: 'changed-since-decided' })
    expect(h.calls).toEqual(['probe'])
    expect(h.stored).toEqual([])
  })

  it('a change between verify and the delete refuses it, with nothing deleted and nothing remembered', async () => {
    const h = harness({}, [probeOf(), probeOf({ workStamp: 'w9' })])
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'reprobe', reason: 'changed-since-decided' })
    expect(h.calls).not.toContain('removeFolder')
    expect(h.calls).not.toContain('remember')
  })

  it('a session that opened in the folder meanwhile refuses it', async () => {
    let n = 0
    const h = harness({
      inUse: async () => {
        n++
        return n === 2
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'in-use', reason: 'in-use' })
    expect(h.calls).not.toContain('removeFolder')
  })

  it('a repo that now delegates create:/remove: refuses it (C10)', async () => {
    const h = harness({}, [probeOf({ manifestDelegates: true })])
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'reprobe', reason: 'delegated-manifest' })
  })

  it('an in-use check that cannot answer counts as in use', async () => {
    const h = harness({
      inUse: async () => {
        throw new Error('no answer')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'in-use' })
    expect(h.calls).toEqual(['probe'])
  })
})

describe('shelveWorktree — any failure before the delete leaves the worktree untouched (AC-3)', () => {
  it('a registration that cannot be removed on its own (locked, ambiguous) is found out before preserving', async () => {
    const h = harness({ canUnregister: async () => false })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'unregister', folderRemoved: false })
    expect(h.calls).not.toContain('preserve:node_modules,**/node_modules')
    expect(h.calls).not.toContain('removeFolder')
  })

  it('a refused preservation (snapshot too large) stops there', async () => {
    const h = harness({
      preserve: async () => ({
        ok: false,
        reason: 'snapshot-too-large',
        message: 'too big',
        bytes: 9,
        capBytes: 1
      })
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({
      ok: false,
      step: 'preserve',
      reason: 'snapshot-too-large',
      folderRemoved: false
    })
    expect(h.calls).not.toContain('verify')
    expect(h.calls).not.toContain('removeFolder')
    expect(h.stored).toEqual([])
  })

  it('a verification that fails stops there', async () => {
    const h = harness({
      verify: async () => ({ ok: false, reason: 'worktree-changed', message: 'differs' })
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'verify', reason: 'worktree-changed' })
    expect(h.calls).not.toContain('removeFolder')
    expect(h.stored).toEqual([])
  })

  it('a preserve that throws is a refusal, never a throw to the caller', async () => {
    const h = harness({
      preserve: async () => {
        throw new Error('boom')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'preserve', folderRemoved: false })
    expect(h.calls).not.toContain('removeFolder')
  })

  it('an entry that cannot be remembered means nothing is deleted', async () => {
    const h = harness({
      remember: async () => {
        throw new Error('disk full')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'remember', folderRemoved: false })
    expect(h.calls).not.toContain('removeFolder')
  })
})

describe('shelveWorktree — the delete itself', () => {
  it('a delete that fails once is retried once', async () => {
    let n = 0
    const h = harness({
      removeFolder: async () => {
        n++
        if (n === 1) throw new Error('EBUSY')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out.ok).toBe(true)
    expect(n).toBe(2)
  })

  it('a delete that fails twice with the folder still whole takes the entry back out', async () => {
    const h = harness({
      removeFolder: async () => {
        throw new Error('EACCES')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'remove', folderRemoved: false })
    expect(h.calls.filter((c) => c === 'forget')).toHaveLength(1)
    expect(h.stored).toEqual([])
    expect(h.calls).not.toContain('unregister')
  })

  it('a delete that fails twice halfway keeps the entry: it is never silently lost', async () => {
    let verifies = 0
    const h = harness({
      verify: async () => {
        verifies++
        return verifies === 1
          ? { ok: true, mode: 'live' }
          : { ok: false, reason: 'worktree-changed', message: 'half gone' }
      },
      removeFolder: async () => {
        throw new Error('EACCES')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'remove', folderRemoved: true })
    expect(h.stored).toHaveLength(1)
    expect(h.calls).not.toContain('forget')
  })

  it('a registration that could not be dropped after the delete keeps the entry and says so', async () => {
    const h = harness({ unregister: async () => false })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'unregister', folderRemoved: true })
    expect(h.stored).toHaveLength(1)
  })

  it('an unregister that throws is the same failure, not a throw', async () => {
    const h = harness({
      unregister: async () => {
        throw new Error('git gone')
      }
    })
    const out = await shelveWorktree(decision(), h.deps)
    expect(out).toMatchObject({ ok: false, step: 'unregister', folderRemoved: true })
  })
})
