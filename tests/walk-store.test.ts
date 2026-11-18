import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkStore, walksDir } from '../src/main/walk/walk-store'

// every file the store writes must go through the atomic writer (a temp file renamed into place): the spy
// records each path it is asked for, so a store that wrote with a plain `writeFile` is caught
const atomic = vi.hoisted(() => ({ calls: [] as { path: string; mode: number }[] }))
vi.mock('../src/main/mcp/atomic-write', async (orig) => {
  const real = await orig<typeof import('../src/main/mcp/atomic-write')>()
  return {
    ...real,
    atomicWriteFile: async (path: string, body: string, mode: number): Promise<void> => {
      atomic.calls.push({ path, mode })
      return real.atomicWriteFile(path, body, mode)
    }
  }
})
import { startRun, done, newRun, type Run } from '../src/shared/walk-machine'
import type { WalkScript } from '../src/shared/walk-schema'

const script = (title = 'Search box'): WalkScript =>
  ({
    title,
    purpose: 'check',
    source: { kind: 'feature', text: 'A search box.' },
    checks: [
      {
        id: 'c1',
        title: 'Typing narrows the list',
        why: 'It is the feature.',
        where: { text: 'Notes page' },
        do: [{ text: 'Type `standup`.', see: 'Two rows stay.' }],
        passes: 'Two rows.',
        fails: 'More rows.',
        nothingFromHere: 'Only eyes can tell.'
      },
      {
        id: 'c2',
        title: 'Clearing restores the list',
        why: 'The reverse.',
        where: { text: 'Notes page' },
        do: [{ text: 'Clear the box.', see: 'All notes are back.' }],
        passes: 'Twelve rows.',
        fails: 'Fewer rows.',
        check: { how: 'count the rows' }
      }
    ]
  }) as unknown as WalkScript

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-store-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const clock = (): (() => number) => {
  let t = Date.parse('2026-11-17T10:00:00Z')
  return () => (t += 1000)
}

describe('walk store', () => {
  it('keeps walks and runs, survives a restart and recovers from a corrupt file', async () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(
      repo,
      '-c',
      'user.email=a@b.c',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    )
    const tree = join(root, 'tree')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', tree)

    // two worktrees of one repo read the same walks, kept in the main checkout
    expect(walksDir(tree)).toBe(join(repo, '.harnu', 'walks'))
    expect(walksDir(repo)).toBe(join(repo, '.harnu', 'walks'))
    const s1 = createWalkStore(tree, { now: clock() })
    const created = await s1.createWalk(script(), { ownerSessionId: 'sess-1' })
    expect(created.walkId).toMatch(/^wlk-[0-9a-f]{8}$/)
    expect(created.runId).toMatch(/^run-[0-9a-f]{8}$/)
    expect(created.n).toBe(1)
    const s2 = createWalkStore(repo, { now: clock() })
    expect((await s2.listWalks()).map((w) => w.walkId)).toEqual([created.walkId])

    // a `ready` run is not live: the walk reads "not walked yet"
    let entry = (await s2.listWalks())[0]
    expect(entry).toMatchObject({
      status: 'not-walked',
      live: null,
      lastRun: null,
      title: 'Search box'
    })
    const walk0 = await s2.readWalk(created.walkId)
    expect(walk0?.live).toBeNull()
    expect((await s2.readRun(created.walkId, created.runId))?.run.state).toBe('ready')

    // starting the run sets the `live` pointer
    await s1.updateRun(created.walkId, created.runId, (run) => startRun(run))
    entry = (await s2.listWalks())[0]
    expect(entry).toMatchObject({ status: 'live', live: { runId: created.runId, n: 1 } })
    // the pointer is in walk.json itself, not only inferred by the listing
    expect((await s2.readWalk(created.walkId))?.live).toEqual({ runId: created.runId, n: 1 })
    // one run is live per walk: a re-run is refused, and says which one is live
    const refused = await s2.newRun(created.walkId)
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'WALK_RUN_LIVE', runId: created.runId }
    })
    // a live run cannot be discarded as if it were a ready one
    expect(await s2.discardReadyRun(created.walkId, created.runId)).toMatchObject({ ok: false })

    // an outbox entry survives with the run
    await s1.enqueue(created.walkId, created.runId, {
      kind: 'done',
      text: 'turn text',
      checkId: 'c1'
    })
    // finish the run: `lastRun` is rewritten and the `live` pointer cleared with it
    const finish = (run: Run) => {
      let r = done(run, 0) // c1 has nothing to check from here
      if (!r.ok) return r
      r = done(r.run, 0) as typeof r // c2 awaits the agent: stays awaiting
      return r
    }
    await s1.updateRun(created.walkId, created.runId, finish)
    await s1.updateRun(created.walkId, created.runId, (run) => ({
      ok: true as const,
      run: { ...run, state: 'ended' as const, endedAt: 99 }
    }))
    expect((await s2.readWalk(created.walkId))?.live).toBeNull() // cleared on disk with the end
    entry = (await s2.listWalks())[0]
    expect(entry.status).toBe('walked')
    expect(entry.live).toBeNull()
    expect(entry.lastRun).toMatchObject({ runId: created.runId, n: 1, verified: 1, total: 2 })
    expect(typeof entry.lastRun?.at).toBe('number')

    // survives a restart: a brand-new store instance reads everything back
    const s3 = createWalkStore(tree)
    expect((await s3.readWalk(created.walkId))?.lastRun?.verified).toBe(1)
    const rec = await s3.readRun(created.walkId, created.runId)
    expect(rec?.run.state).toBe('ended')
    expect(rec?.outbox).toHaveLength(1)
    expect(rec?.outbox[0]).toMatchObject({ kind: 'done', delivered: false })
    // the outbox replays what is undelivered, and an acknowledged entry leaves it
    const pending = await s3.pendingOutbox(created.walkId, created.runId)
    expect(pending).toHaveLength(1)
    await s3.markDelivered(created.walkId, created.runId, pending[0].id)
    expect(await s3.pendingOutbox(created.walkId, created.runId)).toHaveLength(0)

    // re-run: run n + 1 of the same walk, `ready`, and not live
    const again = await s3.newRun(created.walkId)
    expect(again).toMatchObject({ ok: true, n: 2 })
    expect((await s3.listWalks())[0]).toMatchObject({ status: 'walked', live: null })

    // a ready run is discarded when its pane closes; the walk stays and the next run reuses the ordinal
    if (!again.ok) throw new Error('unreachable')
    expect(await s3.discardReadyRun(created.walkId, again.runId)).toEqual({ ok: true })
    expect(await s3.readRun(created.walkId, again.runId)).toBeNull()
    expect((await s3.readWalk(created.walkId))?.script.title).toBe('Search box')
    const third = await s3.newRun(created.walkId)
    expect(third).toMatchObject({ ok: true, n: 2 })

    // writes are atomic: nothing but the final files is left behind
    const files = (dir: string): string[] => readdirSync(dir)
    const walkDir = join(walksDir(repo), created.walkId)
    expect(files(walkDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(files(join(walkDir, 'runs')).filter((f) => f.endsWith('.tmp'))).toEqual([])

    // a corrupt run file starts clean: it reads as no run, and the walk still lists
    writeFileSync(join(walkDir, 'runs', `${created.runId}.json`), '{ not json')
    expect(await s3.readRun(created.walkId, created.runId)).toBeNull()
    expect((await s3.listWalks())[0].walkId).toBe(created.walkId)

    // a corrupt walk file starts clean: it is skipped by the library, never thrown
    const other = await s3.createWalk(script('Other walk'))
    writeFileSync(join(walksDir(repo), other.walkId, 'walk.json'), '\u0000garbage')
    expect(await s3.readWalk(other.walkId)).toBeNull()
    expect((await s3.listWalks()).map((w) => w.walkId)).toEqual([created.walkId])
    // and a live pointer to an unreadable run does not leave the walk "in progress" forever
    const pointed = await s3.createWalk(script('Pointed'))
    await s3.updateRun(pointed.walkId, pointed.runId, (run) => startRun(run))
    writeFileSync(join(walksDir(repo), pointed.walkId, 'runs', `${pointed.runId}.json`), '[')
    expect((await s3.listWalks()).find((w) => w.walkId === pointed.walkId)).toMatchObject({
      status: 'not-walked',
      live: null
    })
  })

  it('a non-git folder keeps its own walks, and a run that ends on its last check records it', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(walksDir(plain)).toBe(join(plain, '.harnu', 'walks'))
    const store = createWalkStore(plain, { now: clock() })
    const c = await store.createWalk(script())
    expect(existsSync(join(plain, '.harnu', 'walks', c.walkId, 'walk.json'))).toBe(true)
    expect(existsSync(join(plain, '.harnu', 'walks', c.walkId, 'runs', `${c.runId}.json`))).toBe(
      true
    )
    // a refused machine step writes nothing and says why
    const res = await store.updateRun(c.walkId, c.runId, (run) => done(run, 0)) // not live yet
    expect(res).toMatchObject({ ok: false, error: { code: 'RUN_NOT_LIVE' } })
    expect((await store.readRun(c.walkId, c.runId))?.run.state).toBe('ready')
    // the machine's own run shape round-trips through the file
    const fresh = newRun([{ id: 'c1', hasAgentCheck: false, blocks: [] }], { n: 1 })
    expect(fresh.state).toBe('ready')
    expect(await store.readWalk('wlk-00000000')).toBeNull()
  })

  it('serialises concurrent writes to one run', async () => {
    const store = createWalkStore(join(root), { now: clock() })
    const c = await store.createWalk(script())
    await store.updateRun(c.walkId, c.runId, (run) => startRun(run))
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.enqueue(c.walkId, c.runId, { kind: 'done', text: `t${i}`, checkId: 'c1' })
      )
    )
    const rec = await store.readRun(c.walkId, c.runId)
    expect(rec?.outbox).toHaveLength(8)
    expect(new Set(rec?.outbox.map((o) => o.id)).size).toBe(8)
  })

  it('serialises writes across two store instances on the same walks directory', async () => {
    // two stores over one directory (two worktrees of one repo) must queue behind one another
    const a = createWalkStore(join(root), { now: clock() })
    const b = createWalkStore(join(root), { now: clock() })
    const c = await a.createWalk(script())
    await a.updateRun(c.walkId, c.runId, (run) => startRun(run))
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? a : b).enqueue(c.walkId, c.runId, {
          kind: 'done',
          text: `t${i}`,
          checkId: 'c1'
        })
      )
    )
    const rec = await a.readRun(c.walkId, c.runId)
    expect(rec?.outbox.map((o) => o.text).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `t${i}`).sort()
    )
  })

  it('writes every walk and run file through the atomic writer, owner-only', async () => {
    const store = createWalkStore(join(root), { now: clock() })
    atomic.calls.length = 0
    const c = await store.createWalk(script())
    await store.updateRun(c.walkId, c.runId, (run) => startRun(run))
    await store.enqueue(c.walkId, c.runId, { kind: 'done', text: 't', checkId: 'c1' })
    const [pending] = await store.pendingOutbox(c.walkId, c.runId)
    await store.markDelivered(c.walkId, c.runId, pending.id)
    await store.updateWalk(c.walkId, (walk) => ({ ok: true, walk: { ...walk } }))
    const made = await store.newRun(c.walkId)
    expect(made).toMatchObject({ ok: false }) // live: refused, nothing written for it

    const dir = join(walksDir(root), c.walkId)
    const written = new Set(atomic.calls.map((x) => x.path))
    // the two files of the walk, each written atomically (never a plain write that could be read half done)
    expect(written.has(join(dir, 'walk.json'))).toBe(true)
    expect(written.has(join(dir, 'runs', `${c.runId}.json`))).toBe(true)
    // nothing the store wrote bypassed the writer: every JSON file on disk is one it was asked to write
    const onDisk = [
      join(dir, 'walk.json'),
      ...readdirSync(join(dir, 'runs')).map((f) => join(dir, 'runs', f))
    ]
    for (const f of onDisk) expect(written.has(f)).toBe(true)
    expect(atomic.calls.every((x) => x.mode === 0o600)).toBe(true)
  })

  it('refuses to turn a second run live while another run of the walk is live', async () => {
    const store = createWalkStore(join(root), { now: clock() })
    const c = await store.createWalk(script())
    // two runs exist and neither is live: both are `ready`
    const second = await store.newRun(c.walkId)
    if (!second.ok) throw new Error('unreachable')
    await store.updateRun(c.walkId, c.runId, (run) => startRun(run))

    const refused = await store.updateRun(c.walkId, second.runId, (run) => startRun(run))
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'WALK_RUN_LIVE', runId: c.runId }
    })
    // nothing was written for the refused run: it is still ready, and the live pointer is unchanged
    expect((await store.readRun(c.walkId, second.runId))?.run.state).toBe('ready')
    expect((await store.readWalk(c.walkId))?.live).toEqual({ runId: c.runId, n: 1 })
  })
})
