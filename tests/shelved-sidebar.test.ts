import { describe, it, expect } from 'vitest'
import {
  groupByRepo,
  groupByParentDir,
  isFolderGroup,
  type FolderGroup,
  type ShelvedMember
} from '../src/renderer/src/stores/folder-zones'
import {
  partitionShelved,
  shelvedMatchesQuery,
  shelvedDays,
  shelvedLabel,
  type ShelvedSource
} from '../src/renderer/src/lib/shelved-sidebar'

// U2.3b — shelved worktrees in the sidebar. Neutral vocabulary only (CLAUDE.md "Client confidentiality").

interface TSession {
  sessionId: string
  status: 'active' | 'idle' | 'archived'
  modified: string
  title?: string
}
interface TFolder {
  path: string
  pinned: boolean
  repoId?: string
  isMainWorktree?: boolean
  sessions: TSession[]
  diskExists?: boolean
}

const DAY = 86_400_000
const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const REPO = '/home/u/org/api-gateway'
const REPO_ID = `${REPO}/.git`

const session = (id: string, over: Partial<TSession> = {}): TSession => ({
  sessionId: id,
  status: 'idle',
  modified: new Date(NOW - 9 * DAY).toISOString(),
  ...over
})
const folder = (over: Partial<TFolder> & { path: string }): TFolder => ({
  pinned: false,
  repoId: REPO_ID,
  sessions: [session(`s-${over.path}`)],
  ...over
})
const main = (): TFolder => folder({ path: REPO, isMainWorktree: true })
const shelved = (over: Partial<ShelvedSource> = {}): ShelvedSource => ({
  id: `${REPO}::branch::PROJ-231-auth-refresh`,
  repoPath: REPO,
  worktreePath: `${REPO}/.claude/worktrees/PROJ-231-auth-refresh`,
  branch: 'PROJ-231-auth-refresh',
  shelvedAt: NOW - 9 * DAY,
  idleDays: 11,
  ...over
})

describe('shelvedDays', () => {
  it('counts whole days since the worktree was shelved, never negative', () => {
    expect(shelvedDays(shelved({ shelvedAt: NOW - 9 * DAY - 5_000 }), NOW)).toBe(9)
    expect(shelvedDays(shelved({ shelvedAt: NOW - 3_600_000 }), NOW)).toBe(0)
    expect(shelvedDays(shelved({ shelvedAt: NOW + DAY }), NOW)).toBe(0)
  })
})

describe('shelvedLabel', () => {
  it('uses the branch, the folder name when detached', () => {
    expect(shelvedLabel(shelved())).toBe('PROJ-231-auth-refresh')
    expect(shelvedLabel(shelved({ branch: null, worktreePath: '/x/y/spike-cache/' }))).toBe(
      'spike-cache'
    )
  })
})

describe('partitionShelved', () => {
  it('takes a shelved worktree out of the live list: it is never a normal or ghost row', () => {
    const ghost = folder({
      path: shelved().worktreePath,
      diskExists: false,
      sessions: [session('a1'), session('a2')]
    })
    const { live } = partitionShelved([main(), ghost], [shelved()], NOW)
    expect(live.map((f) => f.path)).toEqual([REPO])
  })

  it('also takes out a folder INSIDE a shelved worktree (a session started in WT/api)', () => {
    const inner = folder({ path: `${shelved().worktreePath}/api`, sessions: [session('x')] })
    const { live, byRepo } = partitionShelved([main(), inner], [shelved()], NOW)
    expect(live.map((f) => f.path)).toEqual([REPO])
    expect(byRepo.get(REPO_ID)?.[0].sessions.map((s) => s.sessionId)).toEqual(['x'])
  })

  it('attaches the ghost folder sessions to the shelved member, keyed by the repo id', () => {
    const ghost = folder({
      path: shelved().worktreePath,
      sessions: [session('a1'), session('a2')]
    })
    const { byRepo } = partitionShelved([main(), ghost], [shelved()], NOW)
    const members = byRepo.get(REPO_ID) ?? []
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({
      id: shelved().id,
      label: 'PROJ-231-auth-refresh',
      branch: 'PROJ-231-auth-refresh',
      days: 9
    })
    expect(members[0].sessions.map((s) => s.sessionId)).toEqual(['a1', 'a2'])
  })

  it('a shelved worktree with no sessions is still a member (the branch survives)', () => {
    const { byRepo } = partitionShelved([main()], [shelved()], NOW)
    expect(byRepo.get(REPO_ID)?.[0].sessions).toEqual([])
  })

  it('orders members most recently shelved first', () => {
    const a = shelved({
      id: 'a',
      worktreePath: `${REPO}/.w/a`,
      branch: 'a',
      shelvedAt: NOW - 20 * DAY
    })
    const b = shelved({
      id: 'b',
      worktreePath: `${REPO}/.w/b`,
      branch: 'b',
      shelvedAt: NOW - 2 * DAY
    })
    const { byRepo } = partitionShelved([main()], [a, b], NOW)
    expect(byRepo.get(REPO_ID)?.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('drops an entry whose repo has no folder in the list (no home, no section)', () => {
    const other = shelved({
      id: 'z',
      repoPath: '/home/u/org/portal',
      worktreePath: '/home/u/org/portal/w'
    })
    const { byRepo } = partitionShelved([main()], [other], NOW)
    expect(byRepo.size).toBe(0)
  })

  it('matches the repo through the main worktree path when the repo id differs by a symlink', () => {
    const symlinked = folder({
      path: REPO,
      isMainWorktree: true,
      repoId: '/real/store/api-gateway/.git'
    })
    const { byRepo } = partitionShelved([symlinked], [shelved()], NOW)
    expect(byRepo.has('/real/store/api-gateway/.git')).toBe(true)
  })

  it('tolerates trailing slashes and backslashes in the recorded paths', () => {
    const e = shelved({ repoPath: `${REPO}/`, worktreePath: `${shelved().worktreePath}\\` })
    const ghost = folder({ path: shelved().worktreePath })
    const { live, byRepo } = partitionShelved([main(), ghost], [e], NOW)
    expect(live.map((f) => f.path)).toEqual([REPO])
    expect(byRepo.get(REPO_ID)).toHaveLength(1)
  })

  it('is a no-op without shelved entries', () => {
    const folders = [main(), folder({ path: `${REPO}/.claude/worktrees/w2` })]
    const { live, byRepo } = partitionShelved(folders, [], NOW)
    expect(live).toEqual(folders)
    expect(byRepo.size).toBe(0)
  })
})

describe('groupByRepo with shelved members (AC-4)', () => {
  const member = (id: string): ShelvedMember<TSession> => ({
    id,
    label: id,
    branch: id,
    worktreePath: `${REPO}/.w/${id}`,
    repoPath: REPO,
    days: 3,
    sessions: []
  })

  it('a repo with ONE live folder and a shelved one still forms a group', () => {
    const out = groupByRepo([main()], undefined, undefined, new Map([[REPO_ID, [member('a')]]]))
    expect(out).toHaveLength(1)
    const g = out[0] as FolderGroup<TFolder, TSession>
    expect(isFolderGroup(g)).toBe(true)
    expect(g.folders).toHaveLength(1)
    expect(g.shelved?.map((m) => m.id)).toEqual(['a'])
  })

  it('without shelved members one folder stays a bare row (unchanged behaviour)', () => {
    const out = groupByRepo([main()])
    expect(out).toHaveLength(1)
    expect(isFolderGroup(out[0])).toBe(false)
  })

  it('the header member count stays the LIVE members only', () => {
    const w2 = folder({ path: `${REPO}/.claude/worktrees/w2` })
    const out = groupByRepo(
      [main(), w2],
      undefined,
      undefined,
      new Map([[REPO_ID, [member('a'), member('b')]]])
    )
    const g = out[0] as FolderGroup<TFolder, TSession>
    expect(g.folders).toHaveLength(2)
    expect(g.shelved).toHaveLength(2)
  })

  it('a group with no shelved members carries no shelved list', () => {
    const w2 = folder({ path: `${REPO}/.claude/worktrees/w2` })
    const g = groupByRepo([main(), w2])[0] as FolderGroup<TFolder, TSession>
    expect(g.shelved).toBeUndefined()
  })

  it('a shelved list for a repo with no live folder creates no group', () => {
    const out = groupByRepo([], undefined, undefined, new Map([[REPO_ID, [member('a')]]]))
    expect(out).toEqual([])
  })

  it('survives groupByParentDir untouched, never nested into a path group', () => {
    const sibling = folder({ path: '/home/u/org/portal', repoId: undefined })
    const out = groupByParentDir(
      groupByRepo([main(), sibling], undefined, undefined, new Map([[REPO_ID, [member('a')]]]))
    )
    const repoGroup = out.find((n) => isFolderGroup(n) && n.source === 'repo') as FolderGroup<
      TFolder,
      TSession
    >
    expect(repoGroup.shelved).toHaveLength(1)
  })
})

describe('shelvedMatchesQuery', () => {
  const m: ShelvedMember<TSession> = {
    id: 'a',
    label: 'PROJ-231-auth-refresh',
    branch: 'PROJ-231-auth-refresh',
    worktreePath: `${REPO}/.w/auth`,
    repoPath: REPO,
    days: 9,
    sessions: [session('s1', { title: 'Refresh-token rotation' })]
  }
  const title = (s: TSession): string => s.title ?? ''

  it('matches the branch, the path and a session title, case-insensitively', () => {
    expect(shelvedMatchesQuery(m, 'auth-refresh', title)).toBe(true)
    expect(shelvedMatchesQuery(m, '.w/AUTH', title)).toBe(true)
    expect(shelvedMatchesQuery(m, 'rotation', title)).toBe(true)
    expect(shelvedMatchesQuery(m, 'nothing-like-it', title)).toBe(false)
  })
})
