/**
 * BUG-266 AC-3 — issuing a child process must not block the thread that carries keystrokes.
 *
 * `spawn()` is a `fork()` of the calling process (docs/dev/spawn-runner.md), so what one costs grows with the
 * size of the parent: ~7 ms at 110 MB, 14 ms at 654 MB in Electron's main, 27 ms median at 452 MB in plain
 * Node, with a 100-370 ms tail under load in the live app. This case runs the product's own git probe
 * (`probeGitMeta`, the Your move / sidebar path) against 20 folders at the main process's size and times
 * how long the CALLING thread is held until the call has been issued, i.e. until it returns its promise.
 * That is the part a keystroke waits for. It does not wait for the child.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearGitProbeCache, probeGitMeta } from '../../src/main/git-probe'

/** The main process of the packaged build sat at about this RSS in the profile that opened BUG-266. */
const TARGET_RSS_MB = 460
const CALLS = 20
/** AC-3: one issue must hold the thread for less than this. */
const BUDGET_MS = 10

const ballast: Buffer[] = []
const rssMb = (): number => process.memoryUsage().rss / 1048576

let root = ''
beforeAll(async () => {
  while (rssMb() < TARGET_RSS_MB) ballast.push(Buffer.alloc(8 << 20, (ballast.length & 255) + 1))
  root = await mkdtemp(join(tmpdir(), 'harnu-spawn-issue-'))
})
afterAll(async () => {
  ballast.length = 0
  await rm(root, { recursive: true, force: true })
})

describe('issuing a child process (BUG-266 AC-3)', () => {
  it(
    `holds the calling thread under ${BUDGET_MS} ms per call at ~${TARGET_RSS_MB} MB RSS`,
    {
      timeout: 60_000
    },
    async () => {
      clearGitProbeCache()
      const rss = Math.round(rssMb())
      const issueMs: number[] = []
      const pending: Array<Promise<unknown>> = []
      for (let i = 0; i < CALLS; i++) {
        const t0 = performance.now()
        pending.push(probeGitMeta(join(root, `folder-${i}`)))
        issueMs.push(performance.now() - t0)
        // Let the previous child's exit and any timers run, as they would between real events.
        await new Promise((r) => setTimeout(r, 15))
      }
      await Promise.all(pending)
      const sorted = [...issueMs].sort((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95) - 1]
      const detail =
        `rss=${rss}MB median=${sorted[CALLS >> 1].toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
        `max=${sorted[CALLS - 1].toFixed(2)}ms (budget ${BUDGET_MS}ms)`
      console.info(`[perf] spawn issue: ${detail}`)
      expect(p95, detail).toBeLessThan(BUDGET_MS)
      expect(sorted[CALLS >> 1], detail).toBeLessThan(BUDGET_MS)
    }
  )
})
