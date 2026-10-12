import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  fsOrphanProbe,
  fsPathExistence,
  orphanExpectedOf,
  orphanTranscriptId,
  planOrphanTranscripts,
  repoLabelFor,
  trashTranscriptSlug,
  type OrphanProbe,
  type OrphanTranscriptItem,
  type SlugFacts
} from '../src/main/gc/gc-orphan-transcripts'
import { slugOfPath } from '../src/main/gc/gc-transcripts'
import { parseOptions } from '../src/main/gc/gc-options'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { NOW } from './gc-fixtures'

/**
 * AC-D1 (unit D): transcripts whose folder no longer exists, and that no live or parked session
 * uses, are listed with their size, grouped by repo, and can be moved to the trash after a
 * confirm. A slug whose folder exists, or any session that is live or parked, is never touched.
 */

const GONE = '/nonexistent/unit-d/org/proj/worktrees/PROJ-1-gone'
const LIVE_DIR = '/nonexistent/unit-d/org/proj/www'

function facts(slug: string, cwds: Array<string | null>, over: Partial<SlugFacts> = {}): SlugFacts {
  return {
    slug,
    files: cwds.map((cwd, i) => ({
      name: `s${i}.jsonl`,
      sessionId: `s${i}-${slug}`,
      bytes: 1_000 * (i + 1),
      mtimeMs: NOW - (i + 1) * 86_400_000,
      cwd
    })),
    extraBytes: 500,
    hasMemory: false,
    ...over
  }
}

function probeOf(...slugs: SlugFacts[]): OrphanProbe {
  return {
    listSlugs: async () => slugs.map((s) => s.slug),
    readSlug: async (slug) => slugs.find((s) => s.slug === slug)!
  }
}

const allGone = async (): Promise<'missing'> => 'missing'

describe('planOrphanTranscripts', () => {
  it('lists a gone folder with its size, sessions and newest activity', async () => {
    const items = await planOrphanTranscripts({
      probe: probeOf(facts(slugOfPath(GONE), [GONE, GONE])),
      exists: allGone,
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: ['/nonexistent/unit-d/org/proj/www']
    })
    expect(items).toEqual([
      {
        id: orphanTranscriptId(slugOfPath(GONE)),
        slug: slugOfPath(GONE),
        folder: GONE,
        // Not inside the known repo `www`: the generic `worktrees` parent names the repo above it.
        repoLabel: 'proj',
        bytes: 1_000 + 2_000 + 500,
        sessionCount: 2,
        newestAt: NOW - 86_400_000,
        hasMemory: false
      }
    ])
  })

  it('never lists a slug whose folder still exists', async () => {
    const items = await planOrphanTranscripts({
      probe: probeOf(facts(slugOfPath(LIVE_DIR), [LIVE_DIR])),
      exists: async (p) => (p === LIVE_DIR ? 'exists' : 'missing'),
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it('never lists a slug that spells the same as an existing known folder', async () => {
    // Slugs are lossy: `a/b-c` and `a-b/c` share one. The other spelling being alive protects it.
    const items = await planOrphanTranscripts({
      probe: probeOf(facts('-x-a-b-c', ['/x/a/b-c'])),
      exists: allGone,
      protectedSessionIds: new Set(),
      protectedFolders: ['/x/a-b/c'],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it.each([
    ['one transcript has no readable folder', [GONE, null]],
    ['one of the folders exists', [GONE, LIVE_DIR]]
  ] as const)('fails closed when %s', async (_why, cwds) => {
    const items = await planOrphanTranscripts({
      probe: probeOf(facts('s', [...cwds])),
      exists: async (p) => (p === LIVE_DIR ? 'exists' : 'missing'),
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it('treats an existence check that could not answer as "exists"', async () => {
    const items = await planOrphanTranscripts({
      probe: probeOf(facts('s', [GONE])),
      exists: async () => 'unknown',
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it('skips a slug holding a live or parked session, whatever its folder says', async () => {
    const f = facts('s', [GONE, GONE])
    const items = await planOrphanTranscripts({
      probe: probeOf(f),
      exists: allGone,
      protectedSessionIds: new Set([f.files[1]!.sessionId]),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it('skips a slug that could not be listed, and one with no transcripts', async () => {
    const items = await planOrphanTranscripts({
      probe: probeOf(facts('empty', []), facts('broken', [GONE], { unlistable: true })),
      exists: allGone,
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items).toEqual([])
  })

  it('skips an unreadable projects root (nothing can be said)', async () => {
    const probe: OrphanProbe = {
      listSlugs: async () => {
        throw new Error('EACCES')
      },
      readSlug: async () => facts('x', [GONE])
    }
    expect(
      await planOrphanTranscripts({
        probe,
        exists: allGone,
        protectedSessionIds: new Set(),
        protectedFolders: [],
        repoPaths: []
      })
    ).toEqual([])
  })

  it('sorts biggest first and flags a memory folder', async () => {
    const small = facts('small', ['/gone/a'])
    const big = facts('big', ['/gone/b', '/gone/b'], { hasMemory: true })
    const items = await planOrphanTranscripts({
      probe: probeOf(small, big),
      exists: allGone,
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: []
    })
    expect(items.map((i) => i.slug)).toEqual(['big', 'small'])
    expect(items[0]!.hasMemory).toBe(true)
  })
})

describe('repoLabelFor (the group a leftover lands in)', () => {
  const repos = ['/ws/org/proj/www', '/ws/org/api-gateway']
  it('a folder inside a known repo belongs to it', () => {
    expect(repoLabelFor('/ws/org/proj/www/.claude/worktrees/x', repos)).toBe('www')
  })
  it('the longest known repo wins', () => {
    expect(repoLabelFor('/ws/org/api-gateway/sub/x', [...repos, '/ws/org'])).toBe('api-gateway')
  })
  it('a `.claude/worktrees` folder names the repo above it, known or not', () => {
    expect(repoLabelFor('/elsewhere/portal/.claude/worktrees/x', [])).toBe('portal')
  })
  it('a `<repo>-worktrees` parent names the repo', () => {
    expect(repoLabelFor('/ws/web-api-worktrees/PROJ-9-x', [])).toBe('web-api')
  })
  it('a generic `worktrees` parent falls back to the folder above it', () => {
    expect(repoLabelFor('/ws/org/proj/worktrees/PROJ-1-gone', [])).toBe('proj')
  })
  it('anything else is grouped by its parent folder', () => {
    expect(repoLabelFor('/ws/scratch/thing', [])).toBe('scratch')
  })
})

// ---- the real filesystem: a fake HOME/.claude/projects -------------------------------------------

describe('against a fake HOME/.claude/projects', () => {
  let home: string
  let root: string
  let aliveDir: string
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'harnu-orphan-home-'))
    root = path.join(home, '.claude', 'projects')
    mkdirSync(root, { recursive: true })
    aliveDir = path.join(home, 'work', 'alive')
    mkdirSync(aliveDir, { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function transcript(slug: string, session: string, cwd: string, ageDays = 5): string {
    const dir = path.join(root, slug)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${session}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'user', cwd, sessionId: session }) + '\n')
    const t = new Date(Date.now() - ageDays * 86_400_000)
    utimesSync(file, t, t)
    return file
  }

  it('lists only the slug whose folder is gone, with real sizes', async () => {
    const goneDir = path.join(home, 'work', 'removed-worktree')
    transcript(slugOfPath(goneDir), 'aaaa', goneDir)
    transcript(slugOfPath(aliveDir), 'bbbb', aliveDir)
    // Subagent output and tool results sit in a folder named after the session: they count.
    mkdirSync(path.join(root, slugOfPath(goneDir), 'aaaa', 'subagents'), { recursive: true })
    writeFileSync(
      path.join(root, slugOfPath(goneDir), 'aaaa', 'subagents', 'a.jsonl'),
      'x'.repeat(100)
    )

    const items = await planOrphanTranscripts({
      probe: fsOrphanProbe(root),
      exists: fsPathExistence,
      protectedSessionIds: new Set(),
      protectedFolders: [aliveDir],
      repoPaths: []
    })
    expect(items.map((i) => i.folder)).toEqual([goneDir])
    expect(items[0]!.sessionCount).toBe(1)
    expect(items[0]!.bytes).toBeGreaterThan(100)
    expect(items[0]!.hasMemory).toBe(false)
  })

  it('reads a memory folder as memory, and a protected session id keeps the slug out', async () => {
    const goneDir = path.join(home, 'work', 'removed-worktree')
    transcript(slugOfPath(goneDir), 'aaaa', goneDir)
    mkdirSync(path.join(root, slugOfPath(goneDir), 'memory'))
    writeFileSync(path.join(root, slugOfPath(goneDir), 'memory', 'MEMORY.md'), '- a note')
    const base = {
      probe: fsOrphanProbe(root),
      exists: fsPathExistence,
      protectedFolders: [],
      repoPaths: []
    }
    const listed = await planOrphanTranscripts({ ...base, protectedSessionIds: new Set() })
    expect(listed[0]!.hasMemory).toBe(true)
    const kept = await planOrphanTranscripts({ ...base, protectedSessionIds: new Set(['aaaa']) })
    expect(kept).toEqual([])
  })

  it('fsPathExistence: a missing path is gone, a present one exists', async () => {
    expect(await fsPathExistence(aliveDir)).toBe('exists')
    expect(await fsPathExistence(path.join(home, 'nope'))).toBe('missing')
  })

  it('trashTranscriptSlug moves exactly one project folder and refuses anything else', async () => {
    const goneDir = path.join(home, 'work', 'removed-worktree')
    transcript(slugOfPath(goneDir), 'aaaa', goneDir)
    const trashed: string[] = []
    const trash = async (p: string): Promise<void> => void trashed.push(p)
    await trashTranscriptSlug(root, slugOfPath(goneDir), trash)
    expect(trashed).toEqual([path.join(root, slugOfPath(goneDir))])

    for (const bad of ['', '..', '.', '../etc', 'a/b', `a${path.sep}b`, 'missing-slug']) {
      await expect(trashTranscriptSlug(root, bad, trash)).rejects.toThrow()
    }
    // A symlinked project folder is never followed out of the root.
    symlinkSync(os.tmpdir(), path.join(root, 'link'))
    await expect(trashTranscriptSlug(root, 'link', trash)).rejects.toThrow()
    expect(trashed).toHaveLength(1)
  })
})

// ---- the manual clean ------------------------------------------------------------------------------

function item(over: Partial<OrphanTranscriptItem> = {}): OrphanTranscriptItem {
  return {
    id: orphanTranscriptId('slug-a'),
    slug: 'slug-a',
    folder: GONE,
    repoLabel: 'proj',
    bytes: 4_096,
    sessionCount: 2,
    newestAt: NOW - 86_400_000,
    hasMemory: false,
    ...over
  }
}

function rig(
  items: OrphanTranscriptItem[],
  fresh: () => Promise<OrphanTranscriptItem[]> = async () => items
) {
  const trashed: string[] = []
  const reconciled: string[] = []
  const done: Array<{ results: Array<Record<string, unknown>> }> = []
  let n = 0
  const deps: ManualCleanDeps = {
    prefs: () => defaultGcPrefs(),
    gather: async () => ({
      bundles: [],
      orphanVolumes: [],
      orphanTranscripts: structuredClone(items)
    }),
    opsFor: () => {
      throw new Error('no worktree ops expected')
    },
    freshOrphans: async () => [],
    freshOrphanTranscripts: fresh,
    trashTranscripts: async (slug) => void trashed.push(slug),
    reconcileFolder: async (folder) => void reconciled.push(folder),
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
      emitDone: (d) => done.push(d as never)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, trashed, reconciled, done }
}

const sent = (it: OrphanTranscriptItem, over: Record<string, unknown> = {}) =>
  parseOptions(
    structuredClone({
      confirmed: [it.id],
      expected: { [it.id]: orphanExpectedOf(it) },
      ...over
    })
  )

async function run(
  r: ReturnType<typeof rig>,
  ids: string[],
  opts: ReturnType<typeof parseOptions>
) {
  submitManualClean(r.deps, ids, opts)
  await r.deps.queue.idle()
  return r.done[0]!.results
}

describe('the manual clean of orphan transcripts', () => {
  it('accepts the bucket on the wire', () => {
    const o = sent(item())
    expect(o.expected![item().id]).toMatchObject({ bucket: 'orphan-transcripts' })
  })

  it('trashes the project folder and reconciles the sidebar, after a confirm', async () => {
    const it1 = item()
    const r = rig([it1])
    const [res] = await run(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ id: it1.id, ok: true, freedBytes: 4_096 })
    expect(r.trashed).toEqual(['slug-a'])
    expect(r.reconciled).toEqual([GONE])
  })

  it('refuses without its own confirmation, and without the facts shown', async () => {
    const it1 = item()
    const r = rig([it1])
    const [a] = await run(r, [it1.id], sent(it1, { confirmed: [] }))
    expect(a).toMatchObject({ ok: false, error: 'needs-confirmation' })
    const r2 = rig([it1])
    const [b] = await run(r2, [it1.id], sent(it1, { expected: {} }))
    expect(b).toMatchObject({ ok: false, error: 'missing-expected' })
    expect(r.trashed.concat(r2.trashed)).toEqual([])
  })

  it('refuses what changed since it was shown (a session wrote more)', async () => {
    const shown = item()
    const r = rig([{ ...shown, bytes: 9_999 }])
    const [res] = await run(r, [shown.id], sent(shown))
    expect(res).toMatchObject({ ok: false, error: 'changed-since-confirm' })
    expect(r.trashed).toEqual([])
  })

  it('refuses an item that is no longer an orphan, judged by a gather that starts now', async () => {
    const it1 = item()
    const r = rig([it1], async () => [])
    const [res] = await run(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ ok: false, error: 'no-longer-orphan' })
    expect(r.trashed).toEqual([])
  })

  it('a failed look right before the trash is a refusal, not a guess', async () => {
    const it1 = item()
    const r = rig([it1], async () => {
      throw new Error('EIO')
    })
    const [res] = await run(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ ok: false })
    expect(String(res!.error)).toMatch(/probe-failed/)
    expect(r.trashed).toEqual([])
  })

  it('a trash that fails reports the step and leaves the sidebar alone', async () => {
    const it1 = item()
    const r = rig([it1])
    r.deps.trashTranscripts = vi.fn(async () => {
      throw new Error('EBUSY')
    })
    const [res] = await run(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ ok: false, haltedAt: 'trash' })
    expect(r.reconciled).toEqual([])
  })
})

describe('the recency guard (delta-1 item 4)', () => {
  const HOUR = 3_600_000
  const probeWithAge = (ageMs: number[]): OrphanProbe =>
    probeOf({
      slug: 's',
      files: ageMs.map((age, i) => ({
        name: `s${i}.jsonl`,
        sessionId: `id${i}`,
        bytes: 100,
        mtimeMs: NOW - age,
        cwd: GONE
      })),
      extraBytes: 0,
      hasMemory: false
    })
  const plan = (probe: OrphanProbe) =>
    planOrphanTranscripts({
      probe,
      exists: allGone,
      protectedSessionIds: new Set(),
      protectedFolders: [],
      repoPaths: [],
      now: NOW
    })

  it('refuses a project whose newest transcript was written within the last 24 hours', async () => {
    // A session still writing from a terminal outside Harnu, in a folder that is gone.
    expect(await plan(probeWithAge([HOUR, 10 * 24 * HOUR]))).toEqual([])
    expect(await plan(probeWithAge([23 * HOUR]))).toEqual([])
  })

  it('lists it once everything in it is older than that', async () => {
    expect((await plan(probeWithAge([25 * HOUR, 10 * 24 * HOUR]))).map((i) => i.slug)).toEqual([
      's'
    ])
  })

  it('a transcript dated in the future counts as just written', async () => {
    expect(await plan(probeWithAge([-HOUR]))).toEqual([])
  })
})
