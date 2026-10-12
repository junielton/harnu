// "No dead ends" (unit B), main side: the facts a guided action shows the operator and the one
// preparatory step it runs before the ordinary, fully guarded remove. Everything is injected, so the
// rules are tested on fakes here; the real git lock lives in gc-guided-real-git.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'
import { AS_GIVEN, type WorktreeBundle } from '../src/main/gc/bundle-core'
import {
  dockerStartHint,
  guidanceFor,
  parseLockReasons,
  prepareClean,
  sessionCountsHere,
  sessionStateOf,
  unquoteGitC,
  userNameOfUid,
  type GuidedDeps
} from '../src/main/gc/gc-guided'
import { findForeignCheckouts } from '../src/main/gc/gc-shell'
import { bundle, reapItem } from './gc-fixtures'

const WT = '/ws/org/proj/worktrees/PROJ-1-slug'
const OTHER = '/ws/org/proj/www'
/** Another worktree of the same repo that uses the stack: not the main checkout. */
const ELSE = '/ws/org/proj/worktrees/PROJ-2-other'

function container(id: string, dir: string, binds: string[] = []): InspectedContainer {
  return {
    id,
    name: `ctr-${id}`,
    image: 'postgres:16',
    labels: { [COMPOSE_WORKING_DIR_LABEL]: dir },
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    ports: [],
    mounts: binds.map((source) => ({ type: 'bind', source, name: null, destination: '/x' }))
  } as InspectedContainer
}

const stack = (id: string, containers: InspectedContainer[]): StackGroup => ({
  id,
  name: id,
  kind: 'compose',
  project: id,
  containers
})

function review(over: Partial<WorktreeBundle> = {}, code = 'dirty'): WorktreeBundle {
  const b = bundle(WT, 'review', { reason: { code: code as never, detail: 'x' } })
  b.item = reapItem(WT, { repoPath: OTHER })
  return Object.assign(b, over)
}

interface Calls {
  lock: Array<[string, string | null]>
  started: string[][]
  unlock: string[]
  parked: string[]
  stopped: string[][]
  removedContainers: string[][]
  removedVolumes: string[][]
}

function deps(
  calls: Calls,
  over: Partial<GuidedDeps> & { stacks?: StackGroup[] } = {}
): GuidedDeps {
  const { stacks = [], ...rest } = over
  return {
    lockReason: async () => undefined,
    unlock: async (_repo, p) => void calls.unlock.push(p),
    lock: async (_repo, p, reason) => void calls.lock.push([p, reason]),
    sessionsIn: async () => [],
    park: (key) => void calls.parked.push(key),
    listStacks: async () => ({ stacks }),
    realPaths: async () => AS_GIVEN,
    docker: {
      start: async (ids) => (calls.started.push(ids), { done: ids, error: null }),
      stop: async (ids) => (calls.stopped.push(ids), { done: ids, error: null }),
      removeContainers: async (ids) => (
        calls.removedContainers.push(ids),
        { done: ids, error: null }
      ),
      removeVolumes: async (names) => (
        calls.removedVolumes.push(names),
        { done: names, error: null }
      )
    },
    sessionFolders: async () => [],
    walkForeign: async () => [],
    ownerOf: async () => 'root',
    currentUser: () => 'me',
    platform: 'linux',
    ...rest
  }
}

const fresh = (): Calls => ({
  lock: [],
  started: [],
  unlock: [],
  parked: [],
  stopped: [],
  removedContainers: [],
  removedVolumes: []
})

describe('unquoteGitC — git C-quotes what it prints (delta 2)', () => {
  it('leaves an unquoted value alone', () => {
    expect(unquoteGitC('on the usb disk')).toBe('on the usb disk')
  })
  it('unquotes escapes and octal UTF-8 bytes', () => {
    expect(unquoteGitC('"n\\303\\243o mexer \\"x\\""')).toBe('não mexer "x"')
    expect(unquoteGitC('"a\\\\b"')).toBe('a\\b')
    expect(unquoteGitC('"tab\\there\\nnew"')).toBe('tab\there\nnew')
  })
  it('a quote that is part of the value, not a wrapper, stays', () => {
    expect(unquoteGitC('say "hi"')).toBe('say "hi"')
  })
})

describe('parseLockReasons', () => {
  it('reads the reason git recorded, and none when it recorded none', () => {
    const out = [
      'worktree /a',
      'HEAD abc',
      'branch refs/heads/a',
      'locked on a usb stick',
      '',
      'worktree /b',
      'HEAD def',
      'locked',
      '',
      'worktree /c',
      'HEAD 123',
      ''
    ].join('\n')
    const m = parseLockReasons(out)
    expect(m.get('/a')).toBe('on a usb stick')
    const q = parseLockReasons(['worktree /c', 'locked "n\\303\\243o \\"x\\""', ''].join('\n'))
    expect(q.get('/c')).toBe('não "x"')
    expect(m.get('/b')).toBeNull()
    expect(m.has('/c')).toBe(false)
  })
})

describe('guidanceFor (AC-B3 lock reason, AC-B4 sessions, AC-B5 stacks)', () => {
  it('shows the lock reason git has', async () => {
    const g = await guidanceFor(
      review({ locked: true }, 'locked'),
      deps(fresh(), { lockReason: async () => 'portable disk' })
    )
    expect(g.lock).toEqual({ reason: 'portable disk' })
  })

  it('says a lock has no reason when git recorded none', async () => {
    const g = await guidanceFor(
      review({ locked: true }, 'locked'),
      deps(fresh(), { lockReason: async () => null })
    )
    expect(g.lock).toEqual({ reason: null })
  })

  it('counts the idle sessions it would close and the busy ones that block it', async () => {
    const g = await guidanceFor(
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(fresh(), {
        sessionsIn: async () => [
          { key: 'a', state: 'idle', origin: 'agent' },
          { key: 'b', state: 'working', origin: 'agent' }
        ]
      })
    )
    expect(g.sessions).toEqual({ idle: 1, busy: 1, userOpened: 0 })
  })

  it('names a shared stack, the other folders that use it, and whether it binds this folder', async () => {
    const shared = stack('web', [container('c1', ELSE, [`${WT}/data`]), container('c2', ELSE)])
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), { stacks: [shared] })
    )
    expect(g.stacks).toEqual([
      {
        id: 'web',
        name: 'web',
        otherFolders: [ELSE],
        bindsThisFolder: true,
        containers: 2,
        containerNames: ['ctr-c1', 'ctr-c2'],
        stopBlocked: null
      }
    ])
  })

  it('a stack that only touches this folder by attribution does not bind it', async () => {
    const shared = stack('web', [container('c1', ELSE)])
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), { stacks: [shared] })
    )
    expect(g.stacks[0]).toMatchObject({ bindsThisFolder: false, otherFolders: [ELSE] })
  })

  it('gives the Docker start hint of the platform when the scan was blind', async () => {
    const mac = await guidanceFor(
      review({ dockerBlind: true }),
      deps(fresh(), { platform: 'darwin' })
    )
    expect(mac.docker).toEqual({ hint: 'open -a Docker' })
    expect(dockerStartHint('linux')).toBe('sudo systemctl start docker')
    expect(dockerStartHint('win32')).toBeNull()
  })
})

describe('prepareClean (AC-B3, AC-B4, AC-B5)', () => {
  it('unlock: runs git worktree unlock on the locked worktree only', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(calls, { lockReason: async () => null })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.unlock).toEqual([WT])
  })

  it('unlock: a worktree that is not locked is not unlocked', async () => {
    const calls = fresh()
    const r = await prepareClean({ kind: 'unlock' }, review(), deps(calls))
    expect(r).toEqual({ ok: false, error: 'prep-not-applicable' })
    expect(calls.unlock).toEqual([])
  })

  it('unlock: names the cause when git refuses', async () => {
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(fresh(), {
        lockReason: async () => null,
        unlock: async () => {
          throw new Error('fatal: not locked')
        }
      })
    )
    expect(r).toEqual({ ok: false, error: 'unlock-failed: fatal: not locked' })
  })

  it('close-session: parks only the idle Harnu session of the folder', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(calls, { sessionsIn: async () => [{ key: 'idle-1', state: 'idle' }] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.parked).toEqual(['idle-1'])
  })

  it('close-session: never touches a working session, and parks nothing at all', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(calls, {
        sessionsIn: async () => [
          { key: 'idle-1', state: 'idle' },
          { key: 'busy-1', state: 'needs-input' }
        ]
      })
    )
    expect(r).toEqual({ ok: false, error: 'session-busy' })
    expect(calls.parked).toEqual([])
  })

  it('close-session: a session Harnu does not own is not Harnu’s to close', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(calls, { sessionsIn: async () => [] })
    )
    expect(r).toEqual({ ok: false, error: 'session-not-closable' })
    expect(calls.parked).toEqual([])
  })

  it('stop-stack: stops that stack’s running containers, never removes one and never a volume', async () => {
    const calls = fresh()
    const shared = stack('web', [container('c1', ELSE, [`${WT}/data`]), container('c2', ELSE)])
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [shared] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([['c1', 'c2']])
    expect(calls.removedContainers).toEqual([])
    expect(calls.removedVolumes).toEqual([])
  })

  it('stop-stack: containers that are already stopped are left alone', async () => {
    const calls = fresh()
    const stopped = {
      ...container('c1', ELSE, [`${WT}/data`]),
      state: 'exited'
    } as InspectedContainer
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [stopped, container('c2', ELSE)])] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([['c2']])
  })

  it('stop-stack: the undo starts exactly the containers it stopped', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, {
        stacks: [stack('web', [container('c1', ELSE, [`${WT}/d`]), container('c2', ELSE)])]
      })
    )
    await (r as { undo: () => Promise<void> }).undo()
    expect(calls.started).toEqual([['c1', 'c2']])
  })

  it('stop-stack: the main checkout’s own stack is refused, and nothing is stopped', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', OTHER, [`${WT}/data`])])] })
    )
    expect(r).toEqual({ ok: false, error: 'stack-is-main-checkout' })
    expect(calls.stopped).toEqual([])
  })

  it.each(['live', 'parked'] as const)(
    'stop-stack: a stack another folder uses with a %s session is refused',
    async (state) => {
      const calls = fresh()
      const r = await prepareClean(
        { kind: 'stop-stack', stackIds: ['web'] },
        review({ sharedStackIds: ['web'] }, 'shared-stack'),
        deps(calls, {
          stacks: [stack('web', [container('c1', ELSE, [`${WT}/data`])])],
          sessionFolders: async () => [{ folder: ELSE, state }]
        })
      )
      expect(r).toEqual({ ok: false, error: 'stack-used-elsewhere' })
      expect(calls.stopped).toEqual([])
    }
  )

  it('stop-stack: a dry run refuses the same things and stops nothing', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', OTHER, [`${WT}/data`])])] }),
      { dry: true }
    )
    expect(r).toEqual({ ok: false, error: 'stack-is-main-checkout' })
    const ok = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', ELSE, [`${WT}/data`])])] }),
      { dry: true }
    )
    expect(ok).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([])
  })

  it('stop-stack: refuses a stack the bundle does not list as shared', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['db'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('db', [container('c9', ELSE)])] })
    )
    expect(r).toEqual({ ok: false, error: 'prep-not-applicable' })
    expect(calls.stopped).toEqual([])
  })

  it('stop-stack: a failed stop restarts what it had stopped and says so', async () => {
    const calls = fresh()
    const base = deps(calls, {
      stacks: [
        stack('web', [
          container('c1', ELSE, [`${WT}/x`]),
          container('c2', ELSE),
          container('c3', ELSE)
        ])
      ]
    })
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      {
        ...base,
        docker: { ...base.docker, stop: async () => ({ done: ['c1', 'c2'], error: 'daemon gone' }) }
      }
    )
    expect(r).toEqual({ ok: false, error: 'stack-stop-failed: daemon gone' })
    expect(calls.started).toEqual([['c1', 'c2']])
    expect(calls.removedContainers).toEqual([])
  })

  it('leave-stack: allowed when no container of the stack binds this folder', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'leave-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', ELSE)])] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([])
  })

  it('leave-stack: refused while a container of the stack bind-mounts this folder', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'leave-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', ELSE, [`${WT}/data`])])] })
    )
    expect(r).toEqual({ ok: false, error: 'stack-binds-folder' })
  })
})

describe('guidanceFor — why a stack cannot be stopped (delta 1)', () => {
  it('the main checkout’s stack says so', async () => {
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), { stacks: [stack('web', [container('c1', OTHER, [`${WT}/data`])])] })
    )
    expect(g.stacks[0].stopBlocked).toBe('main-checkout')
  })

  it('a stack another folder uses with a session says so', async () => {
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), {
        stacks: [stack('web', [container('c1', ELSE)])],
        sessionFolders: async () => [{ folder: ELSE, state: 'live' }]
      })
    )
    expect(g.stacks[0].stopBlocked).toBe('in-use-elsewhere')
  })
})

describe('an unreadable folder (AC-B6, real filesystem)', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-unreadable-'))
  })
  afterEach(() => {
    try {
      chmodSync(path.join(root, 'wt', 'private'), 0o755)
    } catch {
      // not created
    }
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names the exact path the scan could not read, its owner and a command that fixes it',
    async () => {
      mkdirSync(path.join(root, 'wt', 'private', 'deep'), { recursive: true })
      chmodSync(path.join(root, 'wt', 'private'), 0o000)
      const b = review({ nestedWorktrees: undefined as never }, 'check-failed')
      b.item = reapItem(path.join(root, 'wt'), { repoPath: OTHER })
      const g = await guidanceFor(
        b,
        deps(fresh(), {
          walkForeign: (p) => findForeignCheckouts(p),
          ownerOf: async () => 'root',
          currentUser: () => 'me'
        })
      )
      const priv = path.join(root, 'wt', 'private')
      expect(g.unreadable).toEqual({
        path: priv,
        owner: 'root',
        fixCommand: `sudo chown -R $USER ${priv}`
      })
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a folder the operator owns needs only a chmod',
    async () => {
      mkdirSync(path.join(root, 'wt', 'private'), { recursive: true })
      chmodSync(path.join(root, 'wt', 'private'), 0o000)
      const b = review({ nestedWorktrees: undefined as never }, 'check-failed')
      b.item = reapItem(path.join(root, 'wt'), { repoPath: OTHER })
      const g = await guidanceFor(
        b,
        deps(fresh(), {
          walkForeign: (p) => findForeignCheckouts(p),
          ownerOf: async () => 'me',
          currentUser: () => 'me'
        })
      )
      expect(g.unreadable?.fixCommand).toBe(`chmod -R u+rwX ${path.join(root, 'wt', 'private')}`)
    }
  )

  it('says nothing when the folder reads fine now', async () => {
    const g = await guidanceFor(
      review({ nestedWorktrees: undefined as never }, 'check-failed'),
      deps(fresh(), { walkForeign: async () => [] })
    )
    expect(g.unreadable).toBeNull()
  })
})

// Delta 1 (findings 1 and 2): a prep that ran must be undoable, and a dry run must change nothing.
describe('prepareClean — dry run and undo', () => {
  it('a dry run validates and touches nothing', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(calls, { lockReason: async () => 'usb' }),
      { dry: true }
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.unlock).toEqual([])
    const p = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(calls, { sessionsIn: async () => [{ key: 'i', state: 'idle' }] }),
      { dry: true }
    )
    expect(p).toMatchObject({ ok: true })
    expect(calls.parked).toEqual([])
  })

  it('a dry run still refuses what the real one would', async () => {
    const r = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(fresh(), { sessionsIn: async () => [{ key: 'b', state: 'working' }] }),
      { dry: true }
    )
    expect(r).toEqual({ ok: false, error: 'session-busy' })
  })

  it('unlock hands back an undo that locks again with the ORIGINAL reason', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(calls, { lockReason: async () => 'usb' })
    )
    expect(r.ok).toBe(true)
    await (r as { undo: () => Promise<void> }).undo()
    expect(calls.lock).toEqual([[WT, 'usb']])
  })

  it('a lock that had no reason is locked again with none', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(calls, { lockReason: async () => null })
    )
    await (r as { undo: () => Promise<void> }).undo()
    expect(calls.lock).toEqual([[WT, null]])
  })

  it('a failed unlock leaves nothing to undo and nothing changed', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      deps(calls, {
        lockReason: async () => 'usb',
        unlock: async () => {
          throw new Error('nope')
        }
      })
    )
    expect(r).toEqual({ ok: false, error: 'unlock-failed: nope' })
    expect(calls.lock).toEqual([])
  })

  it('closing a session cannot be undone, which is why it runs last', async () => {
    const r = await prepareClean(
      { kind: 'close-session' },
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(fresh(), { sessionsIn: async () => [{ key: 'i', state: 'idle' }] })
    )
    expect(r).toMatchObject({ ok: true })
    expect((r as { undo?: unknown }).undo).toBeUndefined()
  })
})

// Delta 1 (findings 4 and 5): "idle" is strict, and a session in a nested worktree is not this one's.
describe('sessionStateOf — only an explicit resting state is idle', () => {
  it.each([
    ['idle', 'idle'],
    ['completed', 'idle'],
    ['stopped', 'idle'],
    ['working', 'working'],
    ['needs-input', 'needs-input'],
    ['failed', 'working'],
    [null, 'working'],
    [undefined, 'working']
  ] as const)('%s → %s', (hook, expected) => {
    expect(sessionStateOf(hook, false)).toBe(expected)
  })

  it('the owner of a mission with a live child is never idle', () => {
    expect(sessionStateOf('idle', true)).toBe('working')
  })
})

describe('sessionCountsHere — a nested worktree’s sessions are not this worktree’s', () => {
  const inside = (c: string, p: string): boolean => c === p || c.startsWith(p + '/')
  it('counts the worktree itself and a plain subfolder', () => {
    expect(sessionCountsHere(WT, WT, [], inside)).toBe(true)
    expect(sessionCountsHere(`${WT}/api`, WT, [], inside)).toBe(true)
  })
  it('does not count a folder outside it', () => {
    expect(sessionCountsHere('/ws/other', WT, [], inside)).toBe(false)
  })
  it('does not count a nested worktree, or anything under it', () => {
    const nested = [`${WT}/.claude/worktrees/x`]
    expect(sessionCountsHere(nested[0], WT, nested, inside)).toBe(false)
    expect(sessionCountsHere(`${nested[0]}/src`, WT, nested, inside)).toBe(false)
    expect(sessionCountsHere(`${WT}/api`, WT, nested, inside)).toBe(true)
  })
})

describe('sessions are looked up without the nested worktrees, and user-opened ones are counted', () => {
  it('passes the bundle’s nested worktrees down, for guidance and for the prep', async () => {
    const seen: string[][] = []
    const nested = [`${WT}/.claude/worktrees/x`]
    const d = deps(fresh(), {
      sessionsIn: async (_p, n) => (seen.push(n), [{ key: 'i', state: 'idle' }])
    })
    const b = review({ session: 'open-idle', nestedWorktrees: nested }, 'open-idle-session')
    await guidanceFor(b, d)
    await prepareClean({ kind: 'close-session' }, b, d, { dry: true })
    expect(seen).toEqual([nested, nested])
  })

  it('says how many of the sessions the operator opened themself', async () => {
    const g = await guidanceFor(
      review({ session: 'open-idle' }, 'open-idle-session'),
      deps(fresh(), {
        sessionsIn: async () => [
          { key: 'a', state: 'idle', origin: 'operator' },
          { key: 'b', state: 'idle', origin: 'agent' }
        ]
      })
    )
    expect(g.sessions).toEqual({ idle: 2, busy: 0, userOpened: 1 })
  })
})

describe('userNameOfUid — the owner is a name, not a number (delta 1)', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    '# a comment',
    'junie:x:1000:1000:Junie,,,:/home/junie:/bin/zsh',
    'broken line'
  ].join('\n')
  it('resolves a uid from /etc/passwd', () => {
    expect(userNameOfUid(0, passwd)).toBe('root')
    expect(userNameOfUid(1000, passwd)).toBe('junie')
  })
  it('falls back to the number when nobody has it, or the file is unreadable', () => {
    expect(userNameOfUid(4242, passwd)).toBe('4242')
    expect(userNameOfUid(1000, null)).toBe('1000')
  })
})

// Delta 2 item 3: a live or parked session that HOLDS a bind mount of the stack — from inside the
// mount source or from a folder that contains it — keeps the stack off the table.
describe('stop-stack refuses a stack a session holds a mount of (delta 2)', () => {
  const INFRA = '/ws/infra'
  const A = '/ws/wtA'
  const B = '/ws/wtB'
  const infra = () =>
    stack('infra', [
      container('c1', INFRA, [`${A}/src`, `${B}/src`, `${WT}/data`]),
      container('c2', INFRA)
    ])
  const run = (sessions: Array<{ folder: string; state: 'live' | 'parked' }>, dry = false) =>
    prepareClean(
      { kind: 'stop-stack', stackIds: ['infra'] },
      review({ sharedStackIds: ['infra'] }, 'shared-stack'),
      deps(fresh(), { stacks: [infra()], sessionFolders: async () => sessions }),
      { dry }
    )

  it('a live session at the root of a worktree whose src is mounted: refused', async () => {
    expect(await run([{ folder: B, state: 'live' }])).toEqual({
      ok: false,
      error: 'stack-used-elsewhere'
    })
  })
  it('a parked one, too', async () => {
    expect(await run([{ folder: A, state: 'parked' }])).toEqual({
      ok: false,
      error: 'stack-used-elsewhere'
    })
  })
  it('a session inside a mount source: refused', async () => {
    expect(await run([{ folder: `${B}/src/app`, state: 'live' }])).toMatchObject({ ok: false })
  })
  it('a session at an ancestor that contains a mount source: refused', async () => {
    expect(await run([{ folder: '/ws', state: 'live' }])).toMatchObject({ ok: false })
  })
  it('a session that has nothing to do with the mounts: allowed', async () => {
    expect(await run([{ folder: '/ws/elsewhere', state: 'live' }], true)).toMatchObject({
      ok: true
    })
  })
  it('a session in THIS worktree is not counted: the same action closes it', async () => {
    expect(await run([{ folder: WT, state: 'live' }], true)).toMatchObject({ ok: true })
    expect(await run([{ folder: `${WT}/api`, state: 'live' }], true)).toMatchObject({ ok: true })
  })
  it('the guidance says why', async () => {
    const g = await guidanceFor(
      review({ sharedStackIds: ['infra'] }, 'shared-stack'),
      deps(fresh(), {
        stacks: [infra()],
        sessionFolders: async () => [{ folder: B, state: 'live' }]
      })
    )
    expect(g.stacks[0].stopBlocked).toBe('in-use-elsewhere')
  })
})

describe('a restart that fails after a partial stop is reported, not swallowed (delta 2 item 4)', () => {
  it('names the containers that were left stopped', async () => {
    const calls = fresh()
    const base = deps(calls, {
      stacks: [
        stack('web', [
          container('c1', ELSE, [`${WT}/x`]),
          container('c2', ELSE),
          container('c3', ELSE)
        ])
      ]
    })
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      {
        ...base,
        docker: {
          ...base.docker,
          stop: async () => ({ done: ['c1', 'c2'], error: 'daemon gone' }),
          start: async () => ({ done: ['c1'], error: 'no such container' })
        }
      }
    )
    expect(r.ok).toBe(false)
    const error = (r as { error: string }).error
    expect(error).toMatch(/^stack-stop-failed: daemon gone/)
    expect(error).toContain('rollback-failed')
    // c2 did not start again; c1 did. Named by container name, not id.
    expect(error).toContain('ctr-c2')
    expect(error).not.toContain('ctr-c1')
  })

  it('a start that throws names everything it had stopped', async () => {
    const base = deps(fresh(), {
      stacks: [stack('web', [container('c1', ELSE, [`${WT}/x`]), container('c2', ELSE)])]
    })
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      {
        ...base,
        docker: {
          ...base.docker,
          stop: async () => ({ done: ['c1'], error: 'daemon gone' }),
          start: async () => {
            throw new Error('docker is gone')
          }
        }
      }
    )
    expect((r as { error: string }).error).toContain('left stopped: ctr-c1')
  })
})

describe('the prep is journalled before it changes anything (delta 2 item 6)', () => {
  const journalDeps = (log: string[], over: Partial<GuidedDeps> = {}): GuidedDeps => ({
    ...deps(fresh(), {
      lockReason: async () => 'usb',
      unlock: async () => void log.push('unlock'),
      lock: async () => void log.push('lock'),
      ...over
    }),
    journal: {
      begin: async (e) => (log.push(`begin ${e.kind}`), 'tok'),
      end: async () => void log.push('end')
    }
  })

  it('unlock: the entry is written BEFORE the unlock, and cleared by the undo', async () => {
    const log: string[] = []
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      journalDeps(log)
    )
    expect(log).toEqual(['begin unlock', 'unlock'])
    await (r as { undo: () => Promise<void> }).undo()
    expect(log).toEqual(['begin unlock', 'unlock', 'lock', 'end'])
  })

  it('unlock: a successful remove settles the entry without touching the lock', async () => {
    const log: string[] = []
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      journalDeps(log)
    )
    await (r as { settle: () => Promise<void> }).settle()
    expect(log).toEqual(['begin unlock', 'unlock', 'end'])
  })

  it('unlock: an undo that fails keeps the entry, so the next boot retries it', async () => {
    const log: string[] = []
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      journalDeps(log, {
        lock: async () => {
          throw new Error('git is gone')
        }
      })
    )
    await expect((r as { undo: () => Promise<void> }).undo()).rejects.toThrow()
    expect(log).not.toContain('end')
  })

  it('unlock: nothing is left in the journal when the unlock itself fails', async () => {
    const log: string[] = []
    const r = await prepareClean(
      { kind: 'unlock' },
      review({ locked: true }, 'locked'),
      journalDeps(log, {
        unlock: async () => {
          throw new Error('nope')
        }
      })
    )
    expect(r.ok).toBe(false)
    expect(log).toEqual(['begin unlock', 'end'])
  })

  it('a dry run writes nothing', async () => {
    const log: string[] = []
    await prepareClean({ kind: 'unlock' }, review({ locked: true }, 'locked'), journalDeps(log), {
      dry: true
    })
    expect(log).toEqual([])
  })

  it('stop-stack: the stopped ids and their bind sources are written BEFORE the stop', async () => {
    const entries: unknown[] = []
    const order: string[] = []
    const base = deps(fresh(), {
      stacks: [stack('web', [container('c1', ELSE, [`${WT}/x`]), container('c2', ELSE)])]
    })
    const d: GuidedDeps = {
      ...base,
      docker: {
        ...base.docker,
        stop: async (ids) => (order.push('stop'), { done: ids, error: null })
      },
      journal: {
        begin: async (e) => (entries.push(e), order.push('begin'), 'tok'),
        end: async () => void order.push('end')
      }
    }
    await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      d
    )
    expect(order).toEqual(['begin', 'stop'])
    expect(entries[0]).toMatchObject({
      kind: 'stop-stack',
      containerIds: ['c1', 'c2'],
      containerNames: ['ctr-c1', 'ctr-c2'],
      bindSources: expect.arrayContaining([`${WT}/x`])
    })
  })
})
