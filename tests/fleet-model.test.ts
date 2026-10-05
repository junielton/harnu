import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFolders } from '../src/main/claude-reader'
import {
  getFleetFolders,
  notifySlugChanged,
  notifyWatcherDegraded,
  notifyWatcherReady,
  onFleetChanged,
  requestFullRescan,
  type FleetChange,
  __fleetScanStatsForTests,
  __setRootDirForTests,
  __setDebounceMsForTests,
  __setDegradedPollMsForTests,
  __setAppendIntervalMsForTests,
  __resetFleetModelForTests,
  __flushPendingRefreshForTests,
  __awaitRefreshIdleForTests
} from '../src/main/fleet-model'
import type { FolderEntry } from '../src/main/folder-model'

/**
 * Integration net for the central fleet model's shell (T123 spec §5.1 W1,
 * AC1/AC2/AC3). Uses a real tmp fixture root — like `claude-reader-cache.test.ts`
 * — so the model exercises the SAME `scanFoldersUncached` scanning path
 * production uses, with only the root directory swapped out via
 * `__setRootDirForTests`. The pure reducers this shell drives are unit-tested
 * directly in `fleet-model-core.test.ts`.
 */

function userLine(opts: { sessionId: string; cwd: string; content: string }): string {
  return JSON.stringify({
    type: 'user',
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    gitBranch: '',
    isSidechain: false,
    message: { role: 'user', content: opts.content },
    uuid: `${opts.sessionId}-u1`,
    timestamp: '2026-06-01T00:00:00.000Z'
  })
}

function folderFor(folders: FolderEntry[], path: string): FolderEntry | undefined {
  return folders.find((f) => f.path === path)
}

describe('fleet-model — central in-memory fleet (T123 §5.1 W1)', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-fleet-model-'))
    await __resetFleetModelForTests()
    __setRootDirForTests(root)
    __setDebounceMsForTests(5)
  })

  afterEach(async () => {
    await __resetFleetModelForTests()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('AC2: a burst of concurrent boot calls single-flights into ONE full scan and shares the same array reference', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )

    const results = await Promise.all(Array.from({ length: 20 }, () => getFleetFolders()))

    expect(__fleetScanStatsForTests().fullScans).toBe(1)
    const first = results[0]
    for (const r of results) expect(r).toBe(first) // literal same reference, not just deep-equal
    expect(folderFor(first, '/work/Alpha')?.sessions.map((s) => s.sessionId)).toEqual(['sess1'])
  })

  it('AC2 (through the public entrypoint): a burst of concurrent scanFolders() calls single-flights too', async () => {
    // Same scenario as above, but through `claude-reader.ts`'s `scanFolders()`
    // — the actual function every MCP handler / consumer calls — to prove the
    // dynamic-import bridge into the model doesn't reopen the race.
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )

    const results = await Promise.all(Array.from({ length: 20 }, () => scanFolders()))

    expect(__fleetScanStatsForTests().fullScans).toBe(1)
    const first = results[0]
    for (const r of results) expect(r).toBe(first)
  })

  it('AC1: post-boot reads never touch disk again — zero additional scans, same reference', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )
    await getFleetFolders() // boot
    const statsAfterBoot = __fleetScanStatsForTests()

    const a = await getFleetFolders()
    const b = await getFleetFolders()
    const c = await getFleetFolders()

    expect(__fleetScanStatsForTests()).toEqual(statsAfterBoot) // no new scans at all
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('AC3: a slug-scoped watcher refresh incorporates a newly-appended session WITHOUT a full rescan', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot with an empty slug (no sessions yet)
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )
    notifySlugChanged('slug-a')
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().fullScans).toBe(fullScansAfterBoot) // NOT a full rescan
    expect(__fleetScanStatsForTests().slugScans).toBe(1)

    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Alpha')?.sessions.map((s) => s.sessionId)).toEqual(['sess1'])
  })

  it('AC3: a slug-scoped refresh reflects a session REMOVAL without a full rescan', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    const sessPath = join(slugDir, 'sess1.jsonl')
    await fs.writeFile(
      sessPath,
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )
    const booted = await getFleetFolders()
    expect(folderFor(booted, '/work/Alpha')?.sessions.length).toBe(1)
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    await fs.rm(sessPath)
    notifySlugChanged('slug-a')
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().fullScans).toBe(fullScansAfterBoot)
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Alpha')).toBeUndefined()
  })

  it('AC3: multiple notifySlugChanged calls for the same slug before the debounce fires collapse into ONE scan', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot

    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )
    notifySlugChanged('slug-a')
    notifySlugChanged('slug-a')
    notifySlugChanged('slug-a')
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().slugScans).toBe(1)
  })

  it('a degraded-watcher notification falls back to a full rescan', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot (slug-a empty, slug-b doesn't exist yet)
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    // A whole new slug appears on disk — something only a full rescan (not a
    // slug-scoped one, since we were never told about "slug-b") would catch.
    const newSlugDir = join(root, 'slug-b')
    await fs.mkdir(newSlugDir, { recursive: true })
    await fs.writeFile(
      join(newSlugDir, 'sess2.jsonl'),
      userLine({ sessionId: 'sess2', cwd: '/work/Beta', content: 'hi' }) + '\n'
    )

    notifyWatcherDegraded()
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().fullScans).toBe(fullScansAfterBoot + 1)
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Beta')?.sessions.map((s) => s.sessionId)).toEqual(['sess2'])
  })

  it('BUG-55 / spec §3.3: a slug dir NOT present at boot (e.g. EnterWorktree re-homing a session) is picked up via the ordinary slug-scoped notify — get_fleet reflects it without a full rescan', async () => {
    await getFleetFolders() // boot — root has no slugs yet
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    const newSlugDir = join(root, 'brand-new-slug')
    await fs.mkdir(newSlugDir, { recursive: true })
    await fs.writeFile(
      join(newSlugDir, 'sessN.jsonl'),
      userLine({ sessionId: 'sessN', cwd: '/work/New', content: 'hi' }) + '\n'
    )
    notifySlugChanged('brand-new-slug')
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().fullScans).toBe(fullScansAfterBoot) // slug-scoped, not a full rescan
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/New')?.sessions.map((s) => s.sessionId)).toEqual(['sessN'])
  })

  it("an unrelated slug is left untouched by another slug's refresh", async () => {
    const slugA = join(root, 'slug-a')
    const slugB = join(root, 'slug-b')
    await fs.mkdir(slugA, { recursive: true })
    await fs.mkdir(slugB, { recursive: true })
    await fs.writeFile(
      join(slugB, 'sessB.jsonl'),
      userLine({ sessionId: 'sessB', cwd: '/work/Beta', content: 'hi' }) + '\n'
    )
    const booted = await getFleetFolders()
    const originalBetaSession = folderFor(booted, '/work/Beta')?.sessions[0]

    await fs.writeFile(
      join(slugA, 'sessA.jsonl'),
      userLine({ sessionId: 'sessA', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )
    notifySlugChanged('slug-a')
    await __flushPendingRefreshForTests()

    const folders = await getFleetFolders()
    // slug-b's session object is the SAME reference as before — never re-scanned
    // (the folder-grouping array itself is rebuilt on every derive, but the
    // untouched session entries inside it are not).
    expect(folderFor(folders, '/work/Beta')?.sessions[0]).toBe(originalBetaSession)
    expect(folderFor(folders, '/work/Alpha')?.sessions.map((s) => s.sessionId)).toEqual(['sessA'])
  })

  it('C1: a continuous sub-debounce event stream does NOT starve the refresh (fixed window, real timer)', async () => {
    // Regression net for the sliding-debounce starvation hole: the old
    // clear-and-re-arm behavior meant events arriving faster than the window
    // pushed the refresh out forever (and no TTL backstops it any more).
    // This test runs the REAL timer path — no __flushPendingRefreshForTests,
    // which bypasses the timer entirely and would hide exactly this bug.
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot

    await fs.writeFile(
      join(slugDir, 'sess1.jsonl'),
      userLine({ sessionId: 'sess1', cwd: '/work/Alpha', content: 'hi' }) + '\n'
    )

    __setDebounceMsForTests(25)
    // Fire events every 5 ms for 200 ms — always inside the 25 ms window.
    // Under the sliding debounce this would yield ZERO refreshes.
    const end = Date.now() + 200
    while (Date.now() < end) {
      notifySlugChanged('slug-a')
      await new Promise((r) => setTimeout(r, 5))
    }
    // The last event in the loop may have (re)armed the debounce timer without
    // it having fired yet — await the drain explicitly so this can't flake on
    // a loaded CI box racing the real timer against the assertions below.
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().slugScans).toBeGreaterThanOrEqual(1)
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Alpha')?.sessions.map((s) => s.sessionId)).toEqual(['sess1'])
  })

  it('I2: notifyWatcherReady triggers one full rescan, catching files that landed in the boot→watch gap', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    // A session lands "between" the boot scan and chokidar's registration —
    // no watcher event will ever fire for it if it then goes quiet.
    await fs.writeFile(
      join(slugDir, 'gap-sess.jsonl'),
      userLine({ sessionId: 'gap-sess', cwd: '/work/Gap', content: 'hi' }) + '\n'
    )

    notifyWatcherReady()
    await __flushPendingRefreshForTests()

    expect(__fleetScanStatsForTests().fullScans).toBe(fullScansAfterBoot + 1)
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Gap')?.sessions.map((s) => s.sessionId)).toEqual(['gap-sess'])
  })

  it('I2: watcher events arriving BEFORE boot completes are queued, not dropped', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })

    // Event fires pre-boot (no getFleetFolders yet) — must be queued.
    notifySlugChanged('slug-a')
    await fs.writeFile(
      join(slugDir, 'early.jsonl'),
      userLine({ sessionId: 'early', cwd: '/work/Early', content: 'hi' }) + '\n'
    )

    await getFleetFolders() // boot (also sees the file — that is fine)
    await __flushPendingRefreshForTests()

    // The queued slug refresh ran after boot instead of being silently dropped.
    expect(__fleetScanStatsForTests().slugScans).toBe(1)
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Early')?.sessions.map((s) => s.sessionId)).toEqual(['early'])
  })

  it('I1: while degraded, the model keeps poll-rescanning instead of trusting the broken watcher again', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await getFleetFolders() // boot
    const fullScansAfterBoot = __fleetScanStatsForTests().fullScans

    __setDegradedPollMsForTests(15)
    notifyWatcherDegraded()

    // Let several poll intervals elapse on the REAL timers.
    await new Promise((r) => setTimeout(r, 150))

    // The immediate degrade rescan + at least two poll rescans — a one-shot
    // fallback would stop at +1.
    expect(__fleetScanStatsForTests().fullScans).toBeGreaterThanOrEqual(fullScansAfterBoot + 3)

    // And the polls actually observe new disk state, not just spin.
    await fs.writeFile(
      join(slugDir, 'late.jsonl'),
      userLine({ sessionId: 'late', cwd: '/work/Late', content: 'hi' }) + '\n'
    )
    await new Promise((r) => setTimeout(r, 100))
    // A poll may have fired right at the edge of the wait window without its
    // rescan having settled yet — await the drain explicitly so this can't
    // flake on a loaded CI box.
    await __flushPendingRefreshForTests()
    const folders = await getFleetFolders()
    expect(folderFor(folders, '/work/Late')?.sessions.map((s) => s.sessionId)).toEqual(['late'])
  })

  it('AC-6: emits fleet:changed with slug coverage when a slug refresh changes membership', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 's1.jsonl'),
      userLine({ sessionId: 's1', cwd: '/w/A', content: 'hi' }) + '\n'
    )
    await getFleetFolders()
    const seen: FleetChange[] = []
    const off = onFleetChanged((c) => seen.push(c))
    await fs.writeFile(
      join(slugDir, 's2.jsonl'),
      userLine({ sessionId: 's2', cwd: '/w/A', content: 'yo' }) + '\n'
    )
    notifySlugChanged('slug-a')
    await __flushPendingRefreshForTests()
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ slugs: ['slug-a'], full: false })
  })

  it('AC-4 (main half): an append that changes no membership emits nothing', async () => {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    const f = join(slugDir, 's1.jsonl')
    await fs.writeFile(f, userLine({ sessionId: 's1', cwd: '/w/A', content: 'hi' }) + '\n')
    await getFleetFolders()
    const seen: FleetChange[] = []
    const off = onFleetChanged((c) => seen.push(c))
    for (let i = 0; i < 50; i++) {
      await fs.appendFile(f, userLine({ sessionId: 's1', cwd: '/w/A', content: `m${i}` }) + '\n')
      notifySlugChanged('slug-a')
    }
    await __flushPendingRefreshForTests()
    off()
    expect(seen).toHaveLength(0)
  })

  it('AC-6: a degraded/ready full rescan that changes membership emits with full: true', async () => {
    await getFleetFolders()
    const seen: FleetChange[] = []
    const off = onFleetChanged((c) => seen.push(c))
    const slugDir = join(root, 'slug-b')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'x.jsonl'),
      userLine({ sessionId: 'x', cwd: '/w/B', content: 'hi' }) + '\n'
    )
    notifyWatcherReady()
    await __flushPendingRefreshForTests()
    off()
    expect(seen.at(-1)).toMatchObject({ full: true })
  })

  it('AC-6: a listener that throws does not break the drain or the other listeners', async () => {
    await getFleetFolders()
    const seen: FleetChange[] = []
    const offBad = onFleetChanged(() => {
      throw new Error('boom')
    })
    const off = onFleetChanged((c) => seen.push(c))
    const slugDir = join(root, 'slug-d')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'd.jsonl'),
      userLine({ sessionId: 'd', cwd: '/w/D', content: 'hi' }) + '\n'
    )
    notifySlugChanged('slug-d')
    await __flushPendingRefreshForTests()
    offBad()
    off()
    expect(seen).toHaveLength(1)
    expect(folderFor(await getFleetFolders(), '/w/D')).toBeDefined()
  })

  it('AC-26: requestFullRescan runs exactly one full scan and resolves with the refreshed model', async () => {
    await getFleetFolders()
    const before = __fleetScanStatsForTests().fullScans
    const slugDir = join(root, 'slug-c')
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(
      join(slugDir, 'c.jsonl'),
      userLine({ sessionId: 'c', cwd: '/w/C', content: 'hi' }) + '\n'
    )
    const folders = await requestFullRescan()
    expect(__fleetScanStatsForTests().fullScans - before).toBe(1)
    expect(folders.some((f) => f.path === '/w/C')).toBe(true)
  })
  it('D8: a slug dirtied again while its refresh ran is left out of that push', async () => {
    const slugA = join(root, 'slug-a')
    await fs.mkdir(slugA, { recursive: true })
    await fs.writeFile(
      join(slugA, 's1.jsonl'),
      userLine({ sessionId: 's1', cwd: '/w/A', content: 'hi' }) + '\n'
    )
    await getFleetFolders()
    const seen: FleetChange[] = []
    const off = onFleetChanged((c) => seen.push(c))
    const slugB = join(root, 'slug-b')
    await fs.mkdir(slugB, { recursive: true })
    await fs.writeFile(
      join(slugB, 'b1.jsonl'),
      userLine({ sessionId: 'b1', cwd: '/w/B', content: 'hi' }) + '\n'
    )
    notifySlugChanged('slug-a')
    notifySlugChanged('slug-b')
    const p = __flushPendingRefreshForTests() // the drain is now inside its scan
    notifySlugChanged('slug-a') // a new event for slug-a lands mid-scan
    await p
    await __flushPendingRefreshForTests()
    off()
    expect(seen[0]).toMatchObject({ slugs: ['slug-b'], full: false })
  })

  it('D8: a full rescan raced by a slug event does not claim full coverage', async () => {
    await getFleetFolders()
    const seen: FleetChange[] = []
    const off = onFleetChanged((c) => seen.push(c))
    const slugC = join(root, 'slug-c')
    await fs.mkdir(slugC, { recursive: true })
    await fs.writeFile(
      join(slugC, 'c.jsonl'),
      userLine({ sessionId: 'c', cwd: '/w/C', content: 'hi' }) + '\n'
    )
    notifyWatcherReady()
    const p = __flushPendingRefreshForTests()
    notifySlugChanged('slug-a')
    await p
    await __flushPendingRefreshForTests()
    off()
    expect(seen[0]).toMatchObject({ full: false })
    expect(seen[0].slugs).not.toContain('slug-a')
  })

  it('AC-17: 8 append notifications/s for one slug run ≤ 0.5 passes/s; a membership event still lands within the window', async () => {
    vi.useFakeTimers()
    try {
      const slugDir = join(root, 'slug-a')
      await fs.mkdir(slugDir, { recursive: true })
      await fs.writeFile(
        join(slugDir, 's1.jsonl'),
        userLine({ sessionId: 's1', cwd: '/w/A', content: 'hi' }) + '\n'
      )
      __setDebounceMsForTests(250)
      __setAppendIntervalMsForTests(2000)
      await getFleetFolders()
      const before = __fleetScanStatsForTests().slugScans
      for (let i = 0; i < 80; i++) {
        notifySlugChanged('slug-a', 'append')
        await vi.advanceTimersByTimeAsync(125)
      }
      const passes = __fleetScanStatsForTests().slugScans - before
      expect(passes / 10).toBeLessThanOrEqual(0.5)
      const mid = __fleetScanStatsForTests().slugScans
      notifySlugChanged('slug-a', 'membership')
      await vi.advanceTimersByTimeAsync(260)
      await __flushPendingRefreshForTests()
      expect(__fleetScanStatsForTests().slugScans).toBeGreaterThan(mid)
    } finally {
      vi.useRealTimers()
    }
  })

  // The cadence tests below run on fake timers and never call the flush helper: it
  // forces a pass, which would hide a slot that never fires or an upgrade that never
  // happens. A pass is observed by `slugScans`, which ticks synchronously at its start.
  // Each pass's real disk read is awaited between fake-time steps (`__awaitRefreshIdleForTests`),
  // so a slow machine cannot make the next pass start late in fake time.

  /**
   * Seeds `slug-a` with one transcript, boots the model, then lands a second session
   * through one membership pass so the slug has a `lastPassAt`. Returns once that
   * pass has been merged (its scan does real disk I/O), with its start time.
   */
  async function bootWithPrimedSlug(): Promise<{ file: string; primedAt: number }> {
    const slugDir = join(root, 'slug-a')
    await fs.mkdir(slugDir, { recursive: true })
    const file = join(slugDir, 's1.jsonl')
    await fs.writeFile(file, userLine({ sessionId: 's1', cwd: '/w/A', content: 'hi' }) + '\n')
    __setDebounceMsForTests(250)
    __setAppendIntervalMsForTests(2000)
    await getFleetFolders()
    await fs.writeFile(
      join(slugDir, 's0.jsonl'),
      userLine({ sessionId: 's0', cwd: '/w/A', content: 'yo' }) + '\n'
    )
    notifySlugChanged('slug-a', 'membership')
    const [primedAt] = await advanceRecordingPasses(300)
    expect(primedAt).toBeDefined()
    expect(folderFor(await getFleetFolders(), '/w/A')?.sessions).toHaveLength(2)
    return { file, primedAt }
  }

  /** Advances fake time in 25 ms steps (calling `every.fn` each `every.ms`) and returns the time each slug pass started. */
  async function advanceRecordingPasses(
    totalMs: number,
    every?: { ms: number; fn: () => void }
  ): Promise<number[]> {
    const starts: number[] = []
    let seen = __fleetScanStatsForTests().slugScans
    for (let t = 0; t < totalMs; t += 25) {
      if (every && t % every.ms === 0) every.fn()
      await vi.advanceTimersByTimeAsync(25)
      await __awaitRefreshIdleForTests()
      const n = __fleetScanStatsForTests().slugScans
      if (n > seen) {
        starts.push(Date.now())
        seen = n
      }
    }
    return starts
  }

  it('AC-17: appends every 125 ms neither starve nor postpone the slot — passes land 2–2.3 s apart', async () => {
    vi.useFakeTimers()
    try {
      const { primedAt } = await bootWithPrimedSlug()
      const passes = await advanceRecordingPasses(4500, {
        ms: 125,
        fn: () => notifySlugChanged('slug-a', 'append')
      })
      expect(passes.length).toBeGreaterThanOrEqual(2)
      expect(passes[0] - primedAt).toBeGreaterThanOrEqual(2000)
      expect(passes[0] - primedAt).toBeLessThanOrEqual(2300)
      expect(passes[1] - passes[0]).toBeGreaterThanOrEqual(2000)
      expect(passes[1] - passes[0]).toBeLessThanOrEqual(2300)
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-17: a membership event upgrades a waiting append slot to the 250 ms window, and the slot does not fire again', async () => {
    vi.useFakeTimers()
    try {
      await bootWithPrimedSlug()
      notifySlugChanged('slug-a', 'append') // slot due ~2 s after the primed pass
      expect(await advanceRecordingPasses(200)).toEqual([])
      const upgradedAt = Date.now()
      notifySlugChanged('slug-a', 'membership')
      const passes = await advanceRecordingPasses(2500)
      expect(passes).toHaveLength(1)
      expect(passes[0] - upgradedAt).toBeLessThanOrEqual(300)
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-17: an append inside the interval waits for its slot, then reaches the model', async () => {
    vi.useFakeTimers()
    try {
      const { file, primedAt } = await bootWithPrimedSlug()
      const countOf = async (): Promise<number | undefined> =>
        folderFor(await getFleetFolders(), '/w/A')?.sessions.find((x) => x.sessionId === 's1')
          ?.messageCount
      const countBefore = await countOf()
      await fs.appendFile(file, userLine({ sessionId: 's1', cwd: '/w/A', content: 'more' }) + '\n')
      notifySlugChanged('slug-a', 'append')
      const early = await advanceRecordingPasses(primedAt + 1900 - Date.now())
      expect(early).toEqual([])
      expect(await countOf()).toBe(countBefore)
      const due = await advanceRecordingPasses(300)
      expect(due).toHaveLength(1)
      expect(due[0] - primedAt).toBeGreaterThanOrEqual(2000)
      expect(await countOf()).toBeGreaterThan(countBefore ?? 0)
    } finally {
      vi.useRealTimers()
    }
  })
})
