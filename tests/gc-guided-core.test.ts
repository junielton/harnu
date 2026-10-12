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
  type GuidedDeps
} from '../src/main/gc/gc-guided'
import { findForeignCheckouts } from '../src/main/gc/gc-shell'
import { bundle, reapItem } from './gc-fixtures'

const WT = '/ws/org/proj/worktrees/PROJ-1-slug'
const OTHER = '/ws/org/proj/www'

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
          { key: 'a', state: 'idle' },
          { key: 'b', state: 'working' }
        ]
      })
    )
    expect(g.sessions).toEqual({ idle: 1, busy: 1 })
  })

  it('names a shared stack, the other folders that use it, and whether it binds this folder', async () => {
    const shared = stack('web', [container('c1', OTHER, [`${WT}/data`]), container('c2', OTHER)])
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), { stacks: [shared] })
    )
    expect(g.stacks).toEqual([
      { id: 'web', name: 'web', otherFolders: [OTHER], bindsThisFolder: true, containers: 2 }
    ])
  })

  it('a stack that only touches this folder by attribution does not bind it', async () => {
    const shared = stack('web', [container('c1', OTHER)])
    const g = await guidanceFor(
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(fresh(), { stacks: [shared] })
    )
    expect(g.stacks[0]).toMatchObject({ bindsThisFolder: false, otherFolders: [OTHER] })
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

  it('stop-stack: stops and removes that stack’s containers and never a volume', async () => {
    const calls = fresh()
    const shared = stack('web', [container('c1', OTHER, [`${WT}/data`]), container('c2', OTHER)])
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [shared] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([['c1', 'c2']])
    expect(calls.removedContainers).toEqual([['c1', 'c2']])
    expect(calls.removedVolumes).toEqual([])
  })

  it('stop-stack: refuses a stack the bundle does not list as shared', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['db'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('db', [container('c9', OTHER)])] })
    )
    expect(r).toEqual({ ok: false, error: 'prep-not-applicable' })
    expect(calls.stopped).toEqual([])
  })

  it('stop-stack: a failed docker stop is named and nothing is removed', async () => {
    const calls = fresh()
    const base = deps(calls, { stacks: [stack('web', [container('c1', OTHER, [`${WT}/x`])])] })
    const r = await prepareClean(
      { kind: 'stop-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      {
        ...base,
        docker: { ...base.docker, stop: async () => ({ done: [], error: 'daemon gone' }) }
      }
    )
    expect(r).toEqual({ ok: false, error: 'stack-stop-failed: daemon gone' })
    expect(calls.removedContainers).toEqual([])
  })

  it('leave-stack: allowed when no container of the stack binds this folder', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'leave-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', OTHER)])] })
    )
    expect(r).toMatchObject({ ok: true })
    expect(calls.stopped).toEqual([])
  })

  it('leave-stack: refused while a container of the stack bind-mounts this folder', async () => {
    const calls = fresh()
    const r = await prepareClean(
      { kind: 'leave-stack', stackIds: ['web'] },
      review({ sharedStackIds: ['web'] }, 'shared-stack'),
      deps(calls, { stacks: [stack('web', [container('c1', OTHER, [`${WT}/data`])])] })
    )
    expect(r).toEqual({ ok: false, error: 'stack-binds-folder' })
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
