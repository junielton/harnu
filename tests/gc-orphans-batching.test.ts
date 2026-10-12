import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import {
  fsOrphanProbe,
  orphanExpectedOf,
  type OrphanTranscriptItem
} from '../src/main/gc/gc-orphan-transcripts'
import {
  stackLeftoverExpectedOf,
  stackLeftoverId,
  type StackLeftoverItem
} from '../src/main/gc/gc-stack-leftovers'
import { parseOptions } from '../src/main/gc/gc-options'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { NOW } from './gc-fixtures'

/**
 * Delta-1 item 8: a batch of N ids costs ONE fresh look, not N full gathers; and a transcript's
 * folder is not read again from its head while the file has not changed.
 */

const GONE = '/ws/gone'

function transcriptsRig(n: number) {
  const items: OrphanTranscriptItem[] = Array.from({ length: n }, (_v, i) => ({
    id: `transcripts:s${i}`,
    slug: `s${i}`,
    folder: `${GONE}/${i}`,
    repoLabel: 'proj',
    bytes: 1_000 + i,
    sessionCount: 1,
    newestAt: NOW - 1e9,
    hasMemory: false,
    proof: 'proven' as const
  }))
  const state = { fresh: 0, gathers: 0, trashed: [] as string[] }
  let q = 0
  const done: Array<{ results: Array<Record<string, unknown>> }> = []
  const deps: ManualCleanDeps = {
    prefs: () => defaultGcPrefs(),
    gather: async () => {
      state.gathers++
      return { bundles: [], orphanVolumes: [], orphanTranscripts: structuredClone(items) }
    },
    opsFor: () => {
      throw new Error('no ops')
    },
    freshOrphans: async () => [],
    freshOrphanTranscripts: async () => {
      state.fresh++
      return structuredClone(items)
    },
    trashTranscripts: async (slug) => void state.trashed.push(slug),
    workStampOf: async () => null,
    removeOrphanVolumes: async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    }),
    queue: createJobQueue({
      newId: () => `j${++q}`,
      emitProgress: () => undefined,
      emitDone: (d) => done.push(d as never)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { items, deps, state, done }
}

describe('one fresh look per batch', () => {
  it('twelve transcript folders in one clean take one fresh look and all go', async () => {
    const r = transcriptsRig(12)
    const opts = parseOptions(
      structuredClone({
        confirmed: r.items.map((i) => i.id),
        expected: Object.fromEntries(r.items.map((i) => [i.id, orphanExpectedOf(i)]))
      })
    )
    submitManualClean(
      r.deps,
      r.items.map((i) => i.id),
      opts
    )
    await r.deps.queue.idle()
    expect(r.state.fresh).toBe(1)
    expect(r.state.trashed).toHaveLength(12)
    expect(r.done[0]!.results.every((x) => x.ok === true)).toBe(true)
  })

  it('a failing fresh look refuses every id of the batch, once', async () => {
    const r = transcriptsRig(3)
    let calls = 0
    r.deps.freshOrphanTranscripts = async () => {
      calls++
      throw new Error('EIO')
    }
    const opts = parseOptions(
      structuredClone({
        confirmed: r.items.map((i) => i.id),
        expected: Object.fromEntries(r.items.map((i) => [i.id, orphanExpectedOf(i)]))
      })
    )
    submitManualClean(
      r.deps,
      r.items.map((i) => i.id),
      opts
    )
    await r.deps.queue.idle()
    expect(calls).toBe(1)
    expect(r.done[0]!.results.map((x) => String(x.error))).toEqual([
      'probe-failed: EIO',
      'probe-failed: EIO',
      'probe-failed: EIO'
    ])
    expect(r.state.trashed).toEqual([])
  })

  it('stack leftovers: several projects in one clean take one fresh look', async () => {
    const mk = (p: string): StackLeftoverItem => ({
      id: stackLeftoverId(p),
      project: p,
      dirs: [GONE],
      containers: [{ id: `c-${p}`, name: p, state: 'exited' }],
      networks: [],
      volumes: []
    })
    const items = [mk('a'), mk('b'), mk('c')]
    let fresh = 0
    const removed: string[] = []
    let q = 0
    const done: Array<{ results: Array<Record<string, unknown>> }> = []
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({
        bundles: [],
        orphanVolumes: [],
        stackLeftovers: structuredClone(items)
      }),
      opsFor: () => {
        throw new Error('no ops')
      },
      freshOrphans: async () => [],
      freshStackLeftovers: async () => {
        fresh++
        return structuredClone(items)
      },
      removeStackLeftovers: async (it) => {
        removed.push(it.project)
        return { removedContainers: 1, removedNetworks: 0, errors: [] }
      },
      workStampOf: async () => null,
      removeOrphanVolumes: async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `j${++q}`,
        emitProgress: () => undefined,
        emitDone: (d) => done.push(d as never)
      }),
      state: createCycleState(),
      now: () => NOW
    }
    const opts = parseOptions(
      structuredClone({
        confirmed: items.map((i) => i.id),
        expected: Object.fromEntries(items.map((i) => [i.id, stackLeftoverExpectedOf(i)]))
      })
    )
    submitManualClean(
      deps,
      items.map((i) => i.id),
      opts
    )
    await deps.queue.idle()
    expect(fresh).toBe(1)
    expect(removed).toEqual(['a', 'b', 'c'])
  })
})

describe('transcript heads are read once while the file is unchanged', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-heads-'))
    mkdirSync(path.join(root, 'slug-a'))
    writeFileSync(
      path.join(root, 'slug-a', 's1.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/gone/a' }) + '\n'
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a second pass hits the cache; a changed file is read again', async () => {
    const reads: string[] = []
    const probe = fsOrphanProbe(root, { onHeadRead: (f) => reads.push(f) })
    await probe.readSlug('slug-a')
    await probe.readSlug('slug-a')
    await probe.readSlug('slug-a')
    expect(reads).toHaveLength(1)
    appendFileSync(path.join(root, 'slug-a', 's1.jsonl'), 'more\n')
    const t = new Date(Date.now() + 5_000)
    utimesSync(path.join(root, 'slug-a', 's1.jsonl'), t, t)
    const facts = await probe.readSlug('slug-a')
    expect(reads).toHaveLength(2)
    expect(facts.files[0]!.cwd).toBe('/gone/a')
  })

  it('an unreadable head is not cached as an answer', async () => {
    mkdirSync(path.join(root, 'slug-b'))
    writeFileSync(path.join(root, 'slug-b', 's2.jsonl'), 'no cwd here\n')
    const reads: string[] = []
    const probe = fsOrphanProbe(root, { onHeadRead: (f) => reads.push(f) })
    expect((await probe.readSlug('slug-b')).files[0]!.cwd).toBeNull()
    await probe.readSlug('slug-b')
    expect(reads).toHaveLength(2)
  })
})

describe('one fresh gather per request, whatever its kinds (delta-2 item 3)', () => {
  const volume = (n: string) => ({
    id: `volume:${n}`,
    name: n,
    sizeBytes: 100,
    project: 'p',
    reason: { code: 'no-known-worktree' as const, detail: 'x' }
  })

  it('volumes, transcripts and stack leftovers in one request cost one gather', async () => {
    const vols = [volume('v1'), volume('v2'), volume('v3')]
    const t: OrphanTranscriptItem = {
      id: 'transcripts:s',
      slug: 's',
      folder: '/gone/s',
      repoLabel: 'r',
      bytes: 10,
      sessionCount: 1,
      newestAt: 0,
      hasMemory: false,
      proof: 'proven'
    }
    const st: StackLeftoverItem = {
      id: stackLeftoverId('pj'),
      project: 'pj',
      dirs: ['/gone'],
      containers: [{ id: 'c1', name: 'c', state: 'exited' }],
      networks: [],
      volumes: []
    }
    let gathers = 0
    let q = 0
    const done: Array<{ results: Array<Record<string, unknown>> }> = []
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({
        bundles: [],
        orphanVolumes: structuredClone(vols),
        orphanTranscripts: [structuredClone(t)],
        stackLeftovers: [structuredClone(st)]
      }),
      opsFor: () => {
        throw new Error('no ops')
      },
      // The one door: every kind is read from the same fresh gather.
      freshGather: async () => {
        gathers++
        return {
          orphanVolumes: structuredClone(vols),
          orphanTranscripts: [structuredClone(t)],
          stackLeftovers: [structuredClone(st)]
        }
      },
      freshOrphans: async () => {
        throw new Error('legacy per-kind look used')
      },
      freshOrphanTranscripts: async () => {
        throw new Error('legacy per-kind look used')
      },
      freshStackLeftovers: async () => {
        throw new Error('legacy per-kind look used')
      },
      trashTranscripts: async () => undefined,
      removeStackLeftovers: async () => ({ removedContainers: 1, removedNetworks: 0, errors: [] }),
      workStampOf: async () => null,
      removeOrphanVolumes: async (names) => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 100 * names.length,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `j${++q}`,
        emitProgress: () => undefined,
        emitDone: (d) => done.push(d as never)
      }),
      state: createCycleState(),
      now: () => NOW
    }
    const ids = [...vols.map((v) => v.id), t.id, st.id]
    const expected: Record<string, unknown> = {}
    for (const v of vols)
      expected[v.id] = {
        bucket: 'orphan-volume',
        reasonCode: 'no-known-worktree',
        headSha: null,
        stackIds: [],
        ownedVolumes: [v.name],
        bytes: 100,
        path: null,
        project: 'p'
      }
    expected[t.id] = orphanExpectedOf(t)
    expected[st.id] = stackLeftoverExpectedOf(st)
    submitManualClean(deps, ids, parseOptions(structuredClone({ confirmed: ids, expected })))
    await deps.queue.idle()
    expect(done[0]!.results.map((r) => r.ok)).toEqual([true, true, true, true, true])
    expect(gathers).toBe(1)
  })
})
