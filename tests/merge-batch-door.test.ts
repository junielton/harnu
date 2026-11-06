/**
 * Campaign ch.5b (T609, spec §4, AC-5b.3) — the Merge batch door end to end with a FAKE `gh`: merge
 * sequencing, the Log entry, the refusal of a PR that is not the mission's, and that no MCP verb
 * can reach the door.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createMissionFile,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const ID = 'mnt-00000609'
const AT = '2026-11-02T16:00:00.000Z'

function mission(): Mission {
  const step = (id: string, n: number, pr: number): Mission['steps'][0] => ({
    id,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [{ kind: 'pr', ref: `#${pr}` }],
    blockers: []
  })
  return {
    id: ID,
    slug: 'merge-it',
    folder: '/repo',
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PRs merged', evidence: 'green main' },
    steps: [
      step('stp-1', 1, 305),
      step('stp-2', 2, 306),
      step('stp-3', 3, 308),
      {
        id: 'stp-4',
        ordinal: 4,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-11-02T10:00:00.000Z' }
  }
}

/** A fake `gh`: PR state by number, a log of every call, and optional per-PR failures. */
function fakeGh(
  prs: Record<
    number,
    {
      ci: 'SUCCESS' | 'FAILURE'
      state?: string
      base?: string
      oid?: string
      mergeable?: string
    }
  >
) {
  const state = new Map(
    Object.entries(prs).map(([n, v]) => [
      Number(n),
      { state: 'OPEN', base: 'main', oid: `oid${n}`, mergeable: 'MERGEABLE', ...v }
    ])
  )
  const calls: string[] = []
  const mergeRefused = new Set<number>()
  const gh = async (args: readonly string[]): Promise<string> => {
    calls.push(args.join(' '))
    if (args[0] === 'pr' && args[1] === 'view') {
      const p = state.get(Number(args[2]))
      if (!p) throw new Error('Could not resolve to a PullRequest')
      return JSON.stringify({
        state: p.state,
        isDraft: false,
        baseRefName: p.base,
        headRefOid: p.oid,
        mergeable: p.mergeable,
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: p.ci }]
      })
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const n = Number(args[2])
      if (mergeRefused.has(n)) throw new Error('Pull request is not mergeable')
      state.get(n)!.state = 'MERGED'
      return ''
    }
    if (args[0] === 'repo') {
      return JSON.stringify({
        squashMergeAllowed: true,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: false,
        defaultBranchRef: { name: 'main' }
      })
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  return { gh, calls, state, mergeRefused }
}

let root: string
let door: typeof import('../src/main/merge-batch-ipc')

const onDisk = async (): Promise<{ m: Mission; log: string }> => {
  const name = (await fs.readdir(missionsDir(root))).find((n) => n.startsWith(`${ID}-`))!
  const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
  return { m: parseMissionFile(raw) as Mission, log: readMissionLog(raw) }
}

function env(g: ReturnType<typeof fakeGh>, turns: Array<'ran' | 'skipped' | 'timeout'> = []) {
  const seen: string[] = []
  return {
    seen,
    env: {
      gh: g.gh,
      missionPrs: async () => ({ ok: true as const, prs: new Set([305, 306, 308]) }),
      missionState: async (): Promise<'open' | 'closed' | 'paused'> => 'open',
      stewardTurn: async (id: string) => {
        seen.push(`steward ${id}`)
        return turns.shift() ?? 'ran'
      },
      sleep: async () => {},
      now: (() => {
        let t = 0
        return () => (t += 1000)
      })(),
      clock: () => AT,
      timing: { settleTimeoutMs: 10_000, pollMs: 1000 }
    }
  }
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-batch-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-batch-'))
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  vi.resetModules()
  door = await import('../src/main/merge-batch-ipc')
  await createMissionFile(root, mission(), '# Merge it\n')
})

describe('merge-batch door — sequencing with a fake gh', () => {
  it('merges #305 → #306 → #308 in order, the steward between merges, and logs it', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' }, 308: { ci: 'SUCCESS' } })
    const { env: e, seen } = env(g)
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306, 308] }, e)
    expect(res).toMatchObject({ ok: true, outcome: { merged: [305, 306, 308], stop: null } })
    const merges = g.calls.filter((c) => c.startsWith('pr merge'))
    expect(merges).toEqual([
      'pr merge 305 --squash --match-head-commit oid305',
      'pr merge 306 --squash --match-head-commit oid306',
      'pr merge 308 --squash --match-head-commit oid308'
    ])
    expect(seen).toEqual([`steward ${ID}`, `steward ${ID}`])
    const { log } = await onDisk()
    expect(log).toMatch(/operator merge batch: merged #305, #306, #308 in order/)
  })

  it('stops on a red that appears after a merge, merges nothing further, and asks again for the rest', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' }, 308: { ci: 'SUCCESS' } })
    const { env: e } = env(g)
    // The steward's turn (rebase) makes #306's CI go red.
    e.stewardTurn = async () => {
      g.state.get(306)!.ci = 'FAILURE'
      return 'ran'
    }
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306, 308] }, e)
    expect(res).toMatchObject({
      ok: true,
      outcome: { merged: [305], remaining: [306, 308], stop: { at: 306, reason: 'red' } }
    })
    expect(g.calls.filter((c) => c.startsWith('pr merge'))).toEqual([
      'pr merge 305 --squash --match-head-commit oid305'
    ])
    const { log } = await onDisk()
    expect(log).toMatch(/merged #305 — stopped at #306 \(red\)/)
    expect(log).toMatch(/Still to merge: #306, #308/)
  })

  it('a red PR up front merges nothing', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'FAILURE' }, 308: { ci: 'SUCCESS' } })
    const res = await door.runMergeBatchDoor(
      { root, missionId: ID, prs: [305, 306, 308] },
      env(g).env
    )
    expect(res).toMatchObject({
      ok: true,
      outcome: { merged: [], stop: { at: 306, reason: 'red' } }
    })
    expect(g.calls.some((c) => c.startsWith('pr merge'))).toBe(false)
  })

  it('a merge GitHub refuses stops the batch with its message', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' } })
    g.mergeRefused.add(306)
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306] }, env(g).env)
    expect(res).toMatchObject({
      ok: true,
      outcome: { merged: [305], stop: { at: 306, reason: 'merge-failed' } }
    })
  })

  it('uses the merge method the repo allows', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' } })
    const orig = g.gh
    const e = env(g).env
    e.gh = async (args) =>
      args[0] === 'repo'
        ? JSON.stringify({
            squashMergeAllowed: false,
            mergeCommitAllowed: true,
            defaultBranchRef: { name: 'main' }
          })
        : orig(args)
    await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, e)
    expect(g.calls).toContain('pr merge 305 --merge --match-head-commit oid305')
  })
})

describe('merge-batch door — Delta 1: facts, head pin, guard', () => {
  it('reads head sha, base and mergeability with the PR, and pins the merge to the head it read', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS', oid: 'deadbeef' } })
    await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, env(g).env)
    const view = g.calls.find((c) => c.startsWith('pr view 305'))!
    expect(view).toMatch(/baseRefName/)
    expect(view).toMatch(/headRefOid/)
    expect(view).toMatch(/mergeable/)
    expect(g.calls).toContain('pr merge 305 --squash --match-head-commit deadbeef')
  })

  it('a head that moves after the read is refused by GitHub (the pin), and the batch stops there', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' } })
    const orig = g.gh
    const e = env(g).env
    e.gh = async (args) => {
      if (args[1] === 'merge' && args[2] === '306') {
        // somebody pushed after the gates were read: gh refuses the stale pin
        throw new Error('Head branch was modified. Review and try the merge again.')
      }
      return orig(args)
    }
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306] }, e)
    expect(res).toMatchObject({
      ok: true,
      outcome: { merged: [305], stop: { at: 306, reason: 'merge-failed' } }
    })
  })

  it('a CONFLICTING PR and a PR that does not target the default branch merge nothing', async () => {
    const conflict = fakeGh({ 305: { ci: 'SUCCESS', mergeable: 'CONFLICTING' } })
    expect(
      await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, env(conflict).env)
    ).toMatchObject({ ok: true, outcome: { merged: [], stop: { at: 305, reason: 'conflict' } } })
    const stacked = fakeGh({ 305: { ci: 'SUCCESS', base: 'feat/parent' } })
    expect(
      await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, env(stacked).env)
    ).toMatchObject({ ok: true, outcome: { merged: [], stop: { at: 305, reason: 'wrong-base' } } })
    expect(conflict.calls.some((c) => c.startsWith('pr merge'))).toBe(false)
    expect(stacked.calls.some((c) => c.startsWith('pr merge'))).toBe(false)
  })

  it('a steward turn that did not run stops the batch after the first merge', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' } })
    const e = env(g, ['skipped']).env
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306] }, e)
    expect(res).toMatchObject({
      ok: true,
      outcome: { merged: [305], stop: { at: 306, reason: 'steward-skipped' } }
    })
  })

  it('only one batch runs per mission: a second call while one is in flight is refused BATCH_RUNNING', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' } })
    const e = env(g).env
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    e.stewardTurn = async () => {
      await gate
      return 'ran'
    }
    const first = door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306] }, e)
    await new Promise((r) => setTimeout(r, 20))
    const second = await door.runMergeBatchDoor({ root, missionId: ID, prs: [306] }, e)
    expect(second).toMatchObject({ ok: false })
    expect((second as { error: string }).error).toMatch(/^BATCH_RUNNING/)
    release()
    expect(await first).toMatchObject({ ok: true, outcome: { merged: [305, 306] } })
    // …and the guard is released afterwards (even a stopped batch frees the mission)
    const g2 = fakeGh({ 305: { ci: 'FAILURE' } })
    expect(
      await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, env(g2).env)
    ).toMatchObject({ ok: true })
  })

  it('the guard is released when the batch throws', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' } })
    const e = env(g).env
    e.missionPrs = async () => {
      throw new Error('boom')
    }
    await expect(door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, e)).rejects.toThrow()
    const ok = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305] }, env(g).env)
    expect(ok).toMatchObject({ ok: true })
  })

  it('a mission closed or a steward paused between merges stops the batch before the next merge', async () => {
    for (const [state, reason] of [
      ['closed', 'mission-closed'],
      ['paused', 'paused']
    ] as const) {
      const g = fakeGh({ 305: { ci: 'SUCCESS' }, 306: { ci: 'SUCCESS' } })
      const e = env(g).env
      let phase: 'open' | 'closed' | 'paused' = 'open'
      e.missionState = async () => phase
      e.stewardTurn = async () => {
        phase = state
        return 'ran'
      }
      const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 306] }, e)
      expect(res).toMatchObject({
        ok: true,
        outcome: { merged: [305], stop: { at: 306, reason } }
      })
      expect(g.calls.filter((c) => c.startsWith('pr merge'))).toHaveLength(1)
    }
  })
})

describe('merge-batch door — refusals', () => {
  it('refuses a PR that is not one of the mission’s (nothing is read or merged)', async () => {
    const g = fakeGh({ 305: { ci: 'SUCCESS' }, 999: { ci: 'SUCCESS' } })
    const res = await door.runMergeBatchDoor({ root, missionId: ID, prs: [305, 999] }, env(g).env)
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/^NOT_A_MISSION_PR: #999/)
    expect(g.calls).toEqual([])
  })

  it('refuses malformed arguments', async () => {
    const g = fakeGh({})
    for (const bad of [null, {}, { root, missionId: ID }, { root, missionId: ID, prs: ['305'] }]) {
      expect(await door.runMergeBatchDoor(bad, env(g).env)).toMatchObject({ ok: false })
    }
    expect(
      await door.runMergeBatchDoor({ root, missionId: ID, prs: [] }, env(g).env)
    ).toMatchObject({ ok: false })
  })
})

describe('merge-batch is an operator door only', () => {
  it('nothing under src/main/mcp/ imports or calls it', () => {
    const dir = path.join(__dirname, '..', 'src', 'main', 'mcp')
    const files = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(path.join(d, e.name))
          : e.name.endsWith('.ts')
            ? [path.join(d, e.name)]
            : []
      )
    for (const f of files(dir)) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/merge-batch/)
      expect(text, f).not.toMatch(/\brunMergeBatchDoor\b/)
    }
  })

  it('no catalog verb is named for merging', async () => {
    const { MCP_TOOLS } = await import('../src/main/mcp/tool-catalog')
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /merge/i.test(n))).toEqual([])
  })
})
