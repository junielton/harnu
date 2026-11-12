/**
 * Stack sampling for a main-thread stall nobody owns (T697, P9).
 *
 * The thread that is stuck cannot say what it is doing, so a worker thread watches a shared
 * heartbeat counter the main thread increments on every probe tick. When the counter has not moved
 * for 50 ms the worker connects to the main thread through the inspector, asks it to pause, reads
 * the call stack of the paused thread and resumes it at once. A sample is kept only if the counter
 * is still unchanged when the pause lands (the same task is still running), so a stack is never
 * attributed to a task that already ended. Samples cost the main thread one pause of well under a
 * millisecond, only while a stall is already in progress; the debugger domain is switched off again
 * after 30 s without one.
 *
 * The worker is an inline script (`eval`), so there is no second file to bundle or to find inside
 * an asar. If the inspector or the worker is unavailable the watchdog stays quiet and stalls are
 * reported as unattributed.
 */

import { Worker } from 'node:worker_threads'
import { ownerFromFrames, shortStack, type RawFrame } from './stall-core'

export interface StackSample {
  /** Wall-clock epoch ms the sample was taken. */
  atMs: number
  frames: RawFrame[]
}

const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require('node:worker_threads')
const inspector = require('node:inspector')
const beat = new Int32Array(workerData.sab)
const THRESHOLD_MS = workerData.thresholdMs
const MAX_PER_STALL = 4
const SPACING_MS = 80
const POLL_MS = 20
const IDLE_DISABLE_MS = 30000

const session = new inspector.Session()
let connected = false
let enabled = false
let pausedFor = -1
let lastBeat = Atomics.load(beat, 0)
let lastChange = Date.now()
let lastSampleAt = 0
let takenThisStall = 0
let lastStallAt = 0
let busy = false

try {
  session.connectToMainThread()
  connected = true
} catch (e) {
  parentPort.postMessage({ type: 'unavailable', reason: String(e && e.message || e) })
}

const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res)))
  )

const urls = new Map()
if (connected) {
  // A call frame names its script by id; the url arrives once, when the debugger domain is enabled.
  session.on('Debugger.scriptParsed', (msg) => urls.set(msg.params.scriptId, msg.params.url))
  session.on('Debugger.paused', (msg) => {
    // Resume first, think later: the main thread is waiting on us.
    const sameTask = Atomics.load(beat, 0) === pausedFor
    const frames = msg.params.callFrames.slice(0, 12).map((f) => ({
      functionName: f.functionName,
      url: f.url || urls.get(f.location.scriptId) || '',
      lineNumber: f.location.lineNumber
    }))
    session.post('Debugger.resume', {}, () => {
      busy = false
    })
    if (sameTask) parentPort.postMessage({ type: 'sample', atMs: Date.now(), frames })
  })

  setInterval(async () => {
    const now = Date.now()
    const b = Atomics.load(beat, 0)
    if (b !== lastBeat) {
      lastBeat = b
      lastChange = now
      takenThisStall = 0
      if (enabled && now - lastStallAt > IDLE_DISABLE_MS) {
        enabled = false
        post('Debugger.disable').catch(() => undefined)
      }
      return
    }
    if (busy || now - lastChange < THRESHOLD_MS) return
    if (takenThisStall >= MAX_PER_STALL || now - lastSampleAt < SPACING_MS) return
    busy = true
    lastSampleAt = now
    lastStallAt = now
    takenThisStall++
    pausedFor = b
    try {
      if (!enabled) {
        await post('Debugger.enable')
        enabled = true
      }
      await post('Debugger.pause')
    } catch (e) {
      busy = false
    }
    // A pause that never lands (the task ended first) must not leave the worker waiting forever.
    setTimeout(() => {
      busy = false
    }, 250)
  }, POLL_MS)
}
`

export interface StallWatchdog {
  /** Call on every probe tick: the proof the main thread is alive. */
  heartbeat(): void
  /** The most common application owner among the samples taken in `[startWallMs, endWallMs]`. */
  sampled(startWallMs: number, endWallMs: number): { owner: string; frames: string[] } | null
  available(): boolean
  stop(): void
}

export function startStallWatchdog(opts: { thresholdMs: number }): StallWatchdog {
  const sab = new SharedArrayBuffer(8)
  const beat = new Int32Array(sab)
  const samples: StackSample[] = []
  let alive = true
  let worker: Worker | null = null

  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab, thresholdMs: opts.thresholdMs }
    })
    worker.unref()
    worker.on('message', (m: { type: string; atMs?: number; frames?: RawFrame[] }) => {
      if (m.type === 'sample' && m.atMs !== undefined && m.frames) {
        samples.push({ atMs: m.atMs, frames: m.frames })
        if (samples.length > 40) samples.shift()
      } else if (m.type === 'unavailable') {
        alive = false
      }
    })
    worker.on('error', () => {
      alive = false
    })
    worker.on('exit', () => {
      alive = false
    })
  } catch {
    alive = false
  }

  return {
    heartbeat: () => {
      Atomics.add(beat, 0, 1)
    },
    sampled(startWallMs, endWallMs) {
      const votes = new Map<string, { count: number; frames: string[] }>()
      for (const s of samples) {
        if (s.atMs < startWallMs - 30 || s.atMs > endWallMs + 30) continue
        const owner = ownerFromFrames(s.frames)
        if (!owner) continue
        const v = votes.get(owner)
        if (v) v.count++
        else votes.set(owner, { count: 1, frames: shortStack(s.frames) })
      }
      let best: { owner: string; count: number; frames: string[] } | null = null
      for (const [owner, v] of votes) if (!best || v.count > best.count) best = { owner, ...v }
      return best ? { owner: best.owner, frames: best.frames } : null
    },
    available: () => alive,
    stop() {
      alive = false
      void worker?.terminate()
    }
  }
}
