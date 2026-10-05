import { describe, it, expect } from 'vitest'
import type { TaskState } from '../src/preload'
import {
  isLiveFolder,
  classifyFolder,
  groupByRepo,
  groupByParentDir,
  nestByLineage,
  type Zone,
  type FolderGroup,
  type LineageNode,
  type ClassifyCtx
} from '../src/renderer/src/stores/folder-zones'

// Local mirrors of the module's private input shapes (the module only exports
// FolderGroup/ClassifyCtx, so we rebuild the folder/session literals inline).
type Status = 'active' | 'idle' | 'archived'
interface TSession {
  sessionId: string
  status: Status
  taskState?: TaskState
  modified: string
}
interface TFolder {
  path: string
  pinned: boolean
  repoId?: string
  isMainWorktree?: boolean
  expanded?: boolean
  sessions: TSession[]
  diskExists?: boolean
  bornFrom?: string
}

const NOW = Date.parse('2026-06-11T12:00:00.000Z')
const WINDOW = 24 * 60 * 60 * 1000 // 24h

function session(over: Partial<TSession> = {}): TSession {
  return {
    sessionId: 's1',
    status: 'idle',
    modified: new Date(NOW).toISOString(),
    ...over
  }
}

function folder(over: Partial<TFolder> = {}): TFolder {
  return {
    path: '/home/u/proj',
    pinned: false,
    sessions: [session()],
    ...over
  }
}

function ctx(over: Partial<ClassifyCtx> = {}): ClassifyCtx {
  return {
    nowMs: NOW,
    activeWindowMs: WINDOW,
    hiddenPaths: new Set<string>(),
    livePtySessionIds: new Set<string>(),
    ...over
  }
}

describe('isLiveFolder', () => {
  it('is true when a session id is in the live PTY set', () => {
    const f = folder({ sessions: [session({ sessionId: 'live-1', status: 'idle' })] })
    expect(isLiveFolder(f, new Set(['live-1']))).toBe(true)
  })

  it('is true when a session taskState is working', () => {
    const f = folder({ sessions: [session({ taskState: 'working', status: 'idle' })] })
    expect(isLiveFolder(f, new Set())).toBe(true)
  })

  it('is true when a session taskState is needs-input', () => {
    const f = folder({ sessions: [session({ taskState: 'needs-input', status: 'idle' })] })
    expect(isLiveFolder(f, new Set())).toBe(true)
  })

  it('is true when a session status is active', () => {
    const f = folder({ sessions: [session({ status: 'active' })] })
    expect(isLiveFolder(f, new Set())).toBe(true)
  })

  it('is false when no trigger applies', () => {
    const f = folder({
      sessions: [session({ sessionId: 'x', status: 'idle', taskState: 'idle' })]
    })
    expect(isLiveFolder(f, new Set(['other']))).toBe(false)
  })
})

describe('classifyFolder', () => {
  it('zero-session non-pinned -> stale', () => {
    const f = folder({ sessions: [], pinned: false })
    expect(classifyFolder(f, ctx())).toBe<Zone>('stale')
  })

  it('zero-session pinned -> pinned', () => {
    const f = folder({ sessions: [], pinned: true })
    expect(classifyFolder(f, ctx())).toBe<Zone>('pinned')
  })

  it('hidden path -> hidden', () => {
    const f = folder({ path: '/h/hidden', pinned: false })
    expect(classifyFolder(f, ctx({ hiddenPaths: new Set(['/h/hidden']) }))).toBe<Zone>('hidden')
  })

  it('hidden wins over pinned per ordering (D6 makes this combo unreal, but order holds)', () => {
    const f = folder({ path: '/h/hidden', pinned: true })
    expect(classifyFolder(f, ctx({ hiddenPaths: new Set(['/h/hidden']) }))).toBe<Zone>('hidden')
  })

  it('pinned (non-empty, not hidden) -> pinned', () => {
    const f = folder({ pinned: true })
    expect(classifyFolder(f, ctx())).toBe<Zone>('pinned')
  })

  it('recent-but-not-pinned -> active', () => {
    const recent = new Date(NOW - WINDOW / 2).toISOString()
    const f = folder({
      pinned: false,
      sessions: [session({ sessionId: 'x', status: 'idle', taskState: 'idle', modified: recent })]
    })
    expect(classifyFolder(f, ctx())).toBe<Zone>('active')
  })

  it('live-but-old -> active', () => {
    const old = new Date(NOW - WINDOW * 5).toISOString()
    const f = folder({
      pinned: false,
      sessions: [session({ sessionId: 'pty-1', status: 'idle', taskState: 'idle', modified: old })]
    })
    expect(classifyFolder(f, ctx({ livePtySessionIds: new Set(['pty-1']) }))).toBe<Zone>('active')
  })

  it('old non-pinned non-live -> stale', () => {
    const old = new Date(NOW - WINDOW * 5).toISOString()
    const f = folder({
      pinned: false,
      sessions: [session({ sessionId: 'x', status: 'idle', taskState: 'idle', modified: old })]
    })
    expect(classifyFolder(f, ctx())).toBe<Zone>('stale')
  })

  it('unparseable modified date is not treated as recent', () => {
    const f = folder({
      pinned: false,
      sessions: [
        session({ sessionId: 'x', status: 'idle', taskState: 'idle', modified: 'not-a-date' })
      ]
    })
    expect(classifyFolder(f, ctx())).toBe<Zone>('stale')
  })

  describe('BUG-56 D5 — a confirmed-gone directory never classifies as active', () => {
    it('diskExists:false, not pinned, otherwise-active session -> stale', () => {
      const recent = new Date(NOW - WINDOW / 2).toISOString()
      const f = folder({
        pinned: false,
        diskExists: false,
        sessions: [session({ sessionId: 'x', modified: recent })]
      })
      expect(classifyFolder(f, ctx())).toBe<Zone>('stale')
    })

    it('diskExists:false, not pinned, live PTY session -> stale (belt-and-suspenders over isLiveFolder)', () => {
      const f = folder({
        pinned: false,
        diskExists: false,
        sessions: [session({ sessionId: 'pty-1' })]
      })
      expect(classifyFolder(f, ctx({ livePtySessionIds: new Set(['pty-1']) }))).toBe<Zone>('stale')
    })

    it('diskExists:false BUT pinned -> still pinned (a human explicitly pinned it)', () => {
      const f = folder({ pinned: true, diskExists: false })
      expect(classifyFolder(f, ctx())).toBe<Zone>('pinned')
    })

    it('diskExists:true, not pinned, recent session -> active (unaffected)', () => {
      const recent = new Date(NOW - WINDOW / 2).toISOString()
      const f = folder({
        pinned: false,
        diskExists: true,
        sessions: [session({ sessionId: 'x', modified: recent })]
      })
      expect(classifyFolder(f, ctx())).toBe<Zone>('active')
    })

    it('diskExists undefined (not probed) -> unaffected, falls through to normal rules', () => {
      const recent = new Date(NOW - WINDOW / 2).toISOString()
      const f = folder({
        pinned: false,
        sessions: [session({ sessionId: 'x', modified: recent })]
      })
      expect(classifyFolder(f, ctx())).toBe<Zone>('active')
    })
  })
})

describe('groupByRepo', () => {
  it('groups two folders sharing a repoId into one FolderGroup, main worktree first', () => {
    const main = folder({
      path: '/repos/app',
      repoId: '/repos/app/.git',
      isMainWorktree: true
    })
    const wt = folder({
      path: '/repos/app-wt/feature',
      repoId: '/repos/app/.git',
      isMainWorktree: false
    })
    const out = groupByRepo([wt, main])
    expect(out).toHaveLength(1)
    const group = out[0] as FolderGroup
    expect(group.kind).toBe('folder-group')
    expect(group.source).toBe('repo')
    expect(group.id).toBe('/repos/app/.git')
    expect(group.key).toBe('repo:/repos/app/.git')
    expect(group.expanded).toBe(true)
    expect(group.folders).toHaveLength(2)
    expect(group.folders[0].path).toBe('/repos/app') // main first
    expect(group.folders[1].path).toBe('/repos/app-wt/feature')
    // label = basename of the main worktree path
    expect(group.label).toBe('app')
  })

  it('marks a group collapsed when its repoId is in collapsedRepoIds', () => {
    const main = folder({ path: '/repos/app', repoId: '/repos/app/.git', isMainWorktree: true })
    const wt = folder({ path: '/repos/app-wt/x', repoId: '/repos/app/.git' })
    const other = folder({ path: '/repos/lib', repoId: '/repos/lib/.git', isMainWorktree: true })
    const otherWt = folder({ path: '/repos/lib-wt/y', repoId: '/repos/lib/.git' })
    const out = groupByRepo([main, wt, other, otherWt], new Set(['repo:/repos/app/.git']))
    const appGroup = out.find((n): n is FolderGroup => 'kind' in n && n.id === '/repos/app/.git')!
    const libGroup = out.find((n): n is FolderGroup => 'kind' in n && n.id === '/repos/lib/.git')!
    expect(appGroup.expanded).toBe(false) // in the collapsed set
    expect(libGroup.expanded).toBe(true) // not in the set → still expanded
  })

  it('a single repoId member passes through unchanged', () => {
    const f = folder({ path: '/repos/solo', repoId: '/repos/solo/.git' })
    const out = groupByRepo([f])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(f)
    expect((out[0] as { kind?: string }).kind).toBeUndefined()
  })

  it('a folder without a repoId passes through unchanged', () => {
    const f = folder({ path: '/loose/dir' })
    const out = groupByRepo([f])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(f)
  })

  it('empty-string repoId is treated as no repoId (passthrough)', () => {
    const a = folder({ path: '/a', repoId: '' })
    const b = folder({ path: '/b', repoId: '' })
    const out = groupByRepo([a, b])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('label falls back to dirname(repoId) basename when no main worktree present', () => {
    const a = folder({ path: '/wt/a', repoId: '/code/myrepo/.git', isMainWorktree: false })
    const b = folder({ path: '/wt/b', repoId: '/code/myrepo/.git', isMainWorktree: false })
    const out = groupByRepo([a, b])
    expect(out).toHaveLength(1)
    const group = out[0] as FolderGroup
    // dirname('/code/myrepo/.git') = '/code/myrepo' -> basename = 'myrepo'
    expect(group.label).toBe('myrepo')
  })

  it('places the group at the first member position and keeps unrelated folders in their slots', () => {
    const loose1 = folder({ path: '/z/before' })
    const memberA = folder({ path: '/repos/x/a', repoId: '/repos/x/.git', isMainWorktree: true })
    const loose2 = folder({ path: '/z/middle' })
    const memberB = folder({ path: '/repos/x/b', repoId: '/repos/x/.git', isMainWorktree: false })
    const loose3 = folder({ path: '/z/after' })

    const out = groupByRepo([loose1, memberA, loose2, memberB, loose3])
    // loose1, group(at memberA's slot), loose2, loose3
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(loose1)
    const group = out[1] as FolderGroup
    expect(group.kind).toBe('folder-group')
    expect(group.source).toBe('repo')
    expect(group.folders.map((f) => f.path)).toEqual(['/repos/x/a', '/repos/x/b'])
    expect(out[2]).toBe(loose2)
    expect(out[3]).toBe(loose3)
  })

  it('within a group without a main worktree, members sort stably by path', () => {
    const c = folder({ path: '/r/c', repoId: '/code/r/.git' })
    const a = folder({ path: '/r/a', repoId: '/code/r/.git' })
    const b = folder({ path: '/r/b', repoId: '/code/r/.git' })
    const out = groupByRepo([c, a, b])
    expect(out).toHaveLength(1)
    const group = out[0] as FolderGroup
    expect(group.folders.map((f) => f.path)).toEqual(['/r/a', '/r/b', '/r/c'])
  })
})

/** Narrow a node to a FolderGroup for assertions. */
function isGroup(n: unknown): n is FolderGroup {
  return typeof n === 'object' && n != null && (n as { kind?: string }).kind === 'folder-group'
}

describe('groupByParentDir', () => {
  it('groups two siblings under a synthetic header named after their direct parent dir', () => {
    const a = folder({ path: '/w/org/api-gateway' })
    const b = folder({ path: '/w/org/web-api' })

    const out = groupByParentDir([a, b])

    expect(out).toHaveLength(1)
    expect(isGroup(out[0])).toBe(true)
    const group = out[0] as FolderGroup
    expect(group.source).toBe('path')
    expect(group.id).toBe('/w/org')
    expect(group.key).toBe('path:/w/org')
    expect(group.label).toBe('org')
    expect(group.expanded).toBe(true)
    expect(group.folders.map((f) => f.path)).toEqual(['/w/org/api-gateway', '/w/org/web-api'])
  })

  it('leaves a folder with no sibling under its parent as a bare row (identity preserved)', () => {
    const solo = folder({ path: '/w/org/only-one' })

    const out = groupByParentDir([solo])

    expect(out).toHaveLength(1)
    expect(out[0]).toBe(solo)
  })

  it('makes the parent directory member #0 when that directory is itself a visible folder', () => {
    const parent = folder({ path: '/w/org', pinned: true })
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([parent, a, b])

    expect(out).toHaveLength(1)
    const group = out[0] as FolderGroup
    expect(group.id).toBe('/w/org')
    expect(group.folders[0]).toBe(parent) // real reference preserved (reactivity)
    expect(group.folders.map((f) => f.path)).toEqual(['/w/org', '/w/org/a', '/w/org/b'])
  })

  it('resolves a deep chain deepest-first: /a, /a/b, /a/b/c yields loose a + group b={b,c}', () => {
    const a = folder({ path: '/a' })
    const b = folder({ path: '/a/b' })
    const c = folder({ path: '/a/b/c' })

    const out = groupByParentDir([a, b, c])

    // Being a group's PARENT wins over being another group's member, so `b` is
    // pulled out of bucket `/a` — which then has too few members to form.
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a)
    const group = out[1] as FolderGroup
    expect(group.id).toBe('/a/b')
    expect(group.folders.map((f) => f.path)).toEqual(['/a/b', '/a/b/c'])
  })

  it('a folder near the filesystem root never swallows grandchildren (the $HOME regression)', () => {
    const home = folder({ path: '/home/u', pinned: true })
    const p1 = folder({ path: '/home/u/Workspace/org/p1' })
    const p2 = folder({ path: '/home/u/Workspace/org/p2' })

    const out = groupByParentDir([home, p1, p2])

    // `home` is not the DIRECT parent of either project, so it stays a lone row.
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(home)
    const group = out[1] as FolderGroup
    expect(group.id).toBe('/home/u/Workspace/org')
    expect(group.folders.map((f) => f.path)).toEqual([
      '/home/u/Workspace/org/p1',
      '/home/u/Workspace/org/p2'
    ])
  })

  it('passes an existing repo FolderGroup through by identity, never as member or parent', () => {
    const wtA = folder({ path: '/repos/app', repoId: '/repos/app/.git', isMainWorktree: true })
    const wtB = folder({ path: '/repos/app/wt/x', repoId: '/repos/app/.git' })
    const repoGroup = groupByRepo([wtA, wtB])[0] as FolderGroup
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([repoGroup, a, b])

    expect(out).toHaveLength(2)
    expect(out[0]).toBe(repoGroup)
    expect((out[1] as FolderGroup).source).toBe('path')
  })

  it('emits the group at its first member position and keeps unrelated folders in their slots', () => {
    // The two loose folders must NOT share a parent dir, or they'd group too.
    const before = folder({ path: '/z1/before' })
    const a = folder({ path: '/w/org/a' })
    const middle = folder({ path: '/z2/middle' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([before, a, middle, b])

    expect(out).toHaveLength(3)
    expect(out[0]).toBe(before)
    expect((out[1] as FolderGroup).id).toBe('/w/org')
    expect(out[2]).toBe(middle)
  })

  it('marks a group collapsed when its namespaced key is in the collapsed set', () => {
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([a, b], new Set(['path:/w/org']))

    expect((out[0] as FolderGroup).expanded).toBe(false)
  })

  it('is not collapsed by an un-namespaced key (repo and path keys never cross)', () => {
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([a, b], new Set(['/w/org']))

    expect((out[0] as FolderGroup).expanded).toBe(true)
  })

  it('prefers an alias over the derived label and keeps derivedLabel as the reset target', () => {
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })

    const out = groupByParentDir([a, b], undefined, { 'path:/w/org': 'Org Systems' })

    const group = out[0] as FolderGroup
    expect(group.label).toBe('Org Systems')
    expect(group.derivedLabel).toBe('org')
  })

  it('gives colliding labels a parent-dir hint, across repo and path groups alike', () => {
    // A repo group that derives the label "www"…
    const wtA = folder({ path: '/x/www', repoId: '/x/www/.git', isMainWorktree: true })
    const wtB = folder({ path: '/x/www-wt/f', repoId: '/x/www/.git' })
    const repoGroup = groupByRepo([wtA, wtB])[0] as FolderGroup
    // …and a path group that also derives "www".
    const a = folder({ path: '/y/www/a' })
    const b = folder({ path: '/y/www/b' })

    const out = groupByParentDir([repoGroup, a, b])

    const groups = out.filter(isGroup)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.label === 'www')).toBe(true)
    expect(groups[0].parentHint).toBe('x')
    expect(groups[1].parentHint).toBe('y')
  })

  it('clears a stale parentHint when the label no longer collides', () => {
    const a = folder({ path: '/y/www/a' })
    const b = folder({ path: '/y/www/b' })

    const out = groupByParentDir([a, b])

    expect((out[0] as FolderGroup).parentHint).toBeUndefined()
  })

  it('never mutates its input array', () => {
    const a = folder({ path: '/w/org/a' })
    const b = folder({ path: '/w/org/b' })
    const input = [a, b]

    groupByParentDir(input)

    expect(input).toEqual([a, b])
  })
})

describe('nestByLineage (T191)', () => {
  function isLineage(node: TFolder | LineageNode<TFolder>): node is LineageNode<TFolder> {
    return 'kind' in node && node.kind === 'lineage-nest'
  }

  it('flat input (no bornFrom anywhere) passes every folder through unchanged', () => {
    const a = folder({ path: '/repos/app' })
    const b = folder({ path: '/repos/app-wt/x' })
    const out = nestByLineage([a, b])
    expect(out).toEqual([a, b])
  })

  it('nests N children under one mother', () => {
    const mother = folder({ path: '/repos/app/.claude/worktrees/orchestrator' })
    const child1 = folder({
      path: '/repos/app/.claude/worktrees/wave-1',
      bornFrom: mother.path
    })
    const child2 = folder({
      path: '/repos/app/.claude/worktrees/wave-2',
      bornFrom: mother.path
    })
    const out = nestByLineage([mother, child1, child2])
    expect(out).toHaveLength(1)
    const node = out[0] as LineageNode<TFolder>
    expect(isLineage(node)).toBe(true)
    expect(node.mother.path).toBe(mother.path)
    expect(node.children.map((c) => c.path)).toEqual([child1.path, child2.path])
    expect(node.expanded).toBe(true)
  })

  it('flattens a grandchild to its root mother (depth never exceeds one)', () => {
    const root = folder({ path: '/repos/app/.claude/worktrees/root' })
    const middle = folder({ path: '/repos/app/.claude/worktrees/middle', bornFrom: root.path })
    const leaf = folder({ path: '/repos/app/.claude/worktrees/leaf', bornFrom: middle.path })
    const out = nestByLineage([root, middle, leaf])
    expect(out).toHaveLength(1)
    const node = out[0] as LineageNode<TFolder>
    expect(node.mother.path).toBe(root.path)
    // Both the direct child AND the grandchild sit one level under root — never
    // a 2-level staircase.
    expect(node.children.map((c) => c.path).sort()).toEqual([leaf.path, middle.path].sort())
  })

  it('breaks a cycle by dropping the closing edge — both folders render flat', () => {
    const a = folder({
      path: '/repos/app/.claude/worktrees/a',
      bornFrom: '/repos/app/.claude/worktrees/b'
    })
    const b = folder({
      path: '/repos/app/.claude/worktrees/b',
      bornFrom: '/repos/app/.claude/worktrees/a'
    })
    const out = nestByLineage([a, b])
    expect(out).toEqual([a, b])
    expect(out.some(isLineage)).toBe(false)
  })

  it('a missing mother leaves the child flat, never orphaned or hidden', () => {
    const orphan = folder({
      path: '/repos/app/.claude/worktrees/orphan',
      bornFrom: '/repos/app/.claude/worktrees/deleted-mother'
    })
    const out = nestByLineage([orphan])
    expect(out).toEqual([orphan])
  })

  it('a mother outside this call (cross-zone) leaves the child flat', () => {
    // The mother genuinely exists, but this call only receives the folders of
    // ONE zone/group — the mother simply isn't in `folders`, exactly as it
    // wouldn't be if it were hidden, deleted, or in a different zone.
    const child = folder({
      path: '/repos/app/.claude/worktrees/child',
      bornFrom: '/repos/app/.claude/worktrees/orchestrator-in-another-zone'
    })
    const out = nestByLineage([child])
    expect(out).toEqual([child])
  })

  it('a mother outside this call (cross-group / cross-repo) leaves the child flat', () => {
    // Mirrors the cross-zone case: a `bornFrom` recorded against a DIFFERENT
    // repo's worktree (which the write-time guard should never produce, but the
    // read path stays defensive per the spec's "ignored at read time too") is
    // indistinguishable from any other absent mother here.
    const child = folder({
      path: '/repos/app/.claude/worktrees/child',
      bornFrom: '/repos/other-repo/.claude/worktrees/mother'
    })
    const out = nestByLineage([child])
    expect(out).toEqual([child])
  })

  it('preserves sibling order exactly as given', () => {
    const mother = folder({ path: '/repos/app/.claude/worktrees/orchestrator' })
    const c1 = folder({ path: '/repos/app/.claude/worktrees/c1', bornFrom: mother.path })
    const c2 = folder({ path: '/repos/app/.claude/worktrees/c2', bornFrom: mother.path })
    const c3 = folder({ path: '/repos/app/.claude/worktrees/c3', bornFrom: mother.path })
    const out = nestByLineage([mother, c3, c1, c2]) as [LineageNode<TFolder>]
    expect(out[0].children.map((c) => c.path)).toEqual([c3.path, c1.path, c2.path])
  })

  it('a mother with zero live children stays a bare folder (no badge)', () => {
    const lonely = folder({ path: '/repos/app/.claude/worktrees/lonely' })
    const out = nestByLineage([lonely])
    expect(out).toEqual([lonely])
    expect(out.some(isLineage)).toBe(false)
  })

  it('a mother is collapsed only when its path is in collapsedMotherPaths', () => {
    const mother = folder({ path: '/repos/app/.claude/worktrees/orchestrator' })
    const child = folder({ path: '/repos/app/.claude/worktrees/wave-1', bornFrom: mother.path })
    const out = nestByLineage([mother, child], new Set([mother.path]))
    const node = out[0] as LineageNode<TFolder>
    expect(node.expanded).toBe(false)
    // The count is still there even collapsed (D5 — never hidden by collapse).
    expect(node.children).toHaveLength(1)
  })
})

describe('classifyFolder — git-listed worktrees (T388)', () => {
  const ctx: ClassifyCtx = {
    nowMs: NOW,
    activeWindowMs: WINDOW,
    hiddenPaths: new Set(),
    livePtySessionIds: new Set()
  }
  it('AC-32: a git-listed folder whose only sessions are old classifies active', () => {
    const f = {
      path: '/r/wt',
      pinned: false,
      sessions: [session({ modified: '2026-01-01T00:00:00.000Z' })],
      gitListed: true
    }
    expect(classifyFolder(f, ctx)).toBe('active')
  })
  it('a sessionless git-listed folder classifies active', () => {
    expect(
      classifyFolder({ path: '/r/wt', pinned: false, sessions: [], gitListed: true }, ctx)
    ).toBe('active')
  })
  it('AC-10: hidden beats git-listed', () => {
    const hidden = { ...ctx, hiddenPaths: new Set(['/r/wt']) }
    expect(
      classifyFolder({ path: '/r/wt', pinned: false, sessions: [], gitListed: true }, hidden)
    ).toBe('hidden')
  })
  it('AC-10: a git-listed folder whose directory is confirmed gone still classifies active', () => {
    // B3 order: gitListed is checked before the ghost rule — git just listed it,
    // which is fresher evidence than a stale disk probe.
    expect(
      classifyFolder(
        { path: '/r/wt', pinned: false, sessions: [session()], gitListed: true, diskExists: false },
        ctx
      )
    ).toBe('active')
  })
})
