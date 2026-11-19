import { app, ipcMain, type BrowserWindow, type ProcessMetric } from 'electron'
import * as v8 from 'node:v8'
import {
  createSampler,
  readThreadCpu,
  TICKS_PER_SEC,
  coreCount,
  type ProcRawSample
} from './proc-linux'
import { cpuPercent, type CpuTimeSample } from './cpu-delta'
import { aggregateSubtree, subtreePids, type ProcNode } from './aggregate'
import { heapStatus } from './thresholds'
import { getPolicy, setPolicy } from './policy-store'
import { livePtyDescriptors, type LivePtyDescriptor } from '../pty'
import { hibernatedKeys } from '../hibernation'
import { explainFleet, type LiveSession, type Policy } from '../fleet-policy'
import { getStallMonitor } from './stall-registry'
import type { HeapSample, ProcSample, SessionSample, MonitorSample, StallsSample } from './types'

/**
 * The System Monitor's two cadences (T127 spec §5) + the IPC surface (§6.3) that
 * exposes them. This is the imperative shell: state, timers, and the electron/`/proc`
 * edges the pure modules (`proc-parse`, `cpu-delta`, `aggregate`, `thresholds`,
 * `fleet-policy#explainFleet`) don't touch.
 *
 * Hard rule (spec §2): this module reads ONLY `livePtyDescriptors()` (in-memory),
 * `hibernatedKeys()` (in-memory), `app.getAppMetrics()`, `v8.getHeapStatistics()`,
 * and `/proc` (memory-backed). Never `scanFolders()`, a JSONL, or a git probe.
 */

const HEARTBEAT_MS = 30_000
const FULL_SAMPLE_MS = 1_500

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let fullTimer: ReturnType<typeof setInterval> | null = null
/** Refcounted so a double `monitor:start` is safe and a stray `monitor:stop` can't silence a still-open pane. */
let fullSamplerRefcount = 0

/** Previous tick's raw jiffies per pid — cpu-delta's required "prev" input. */
let prevCpuByPid = new Map<number, CpuTimeSample>()

/** Last observed live RSS per session, so a just-parked row can report what it saved. */
const lastKnownRssBySessionKey = new Map<string, number>()

const procSampler = createSampler()

function heapSample(atMs: number): HeapSample {
  const stats = v8.getHeapStatistics()
  const usedBytes = stats.used_heap_size
  const limitBytes = stats.heap_size_limit
  return { atMs, usedBytes, limitBytes, status: heapStatus(usedBytes, limitBytes) }
}

function pushHeap(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('monitor:heap', heapSample(Date.now()))
}

/** `'Browser' | 'Tab' | 'GPU' | 'Utility' | ...` (Electron's own labels) → the mockup's friendly names. */
function friendlyProcessName(type: ProcessMetric['type']): string {
  switch (type) {
    case 'Browser':
      return 'main'
    case 'Tab':
      return 'renderer'
    case 'GPU':
      return 'GPU'
    case 'Utility':
      return 'network'
    case 'Zygote':
      return 'zygote'
    case 'Sandbox helper':
      return 'sandbox'
    case 'Pepper Plugin':
    case 'Pepper Plugin Broker':
      return 'plugin'
    default:
      return 'other'
  }
}

/** The 'Harnu' group — cross-platform via `app.getAppMetrics()` (spec §6.2). */
function harnuGroup(): ProcSample[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    name: friendlyProcessName(m.type),
    cpuPct: m.cpu.percentCPUUsage,
    // Electron reports memory in KiB.
    rssBytes: m.memory.workingSetSize * 1024
  }))
}

/** One `/proc` tick → per-pid CPU% (via cpu-delta against the previous tick) + the aggregate-ready node list. */
function sampleProcTree(atMs: number): { nodes: ProcNode[]; byPid: Map<number, ProcSample> } {
  const raw: ProcRawSample[] = procSampler.tick()
  const cores = coreCount()
  const nextPrev = new Map<number, CpuTimeSample>()
  const nodes: ProcNode[] = []
  const byPid = new Map<number, ProcSample>()
  for (const p of raw) {
    const curr: CpuTimeSample = { utime: p.utime, stime: p.stime, atMs }
    const cpuPct = cpuPercent(prevCpuByPid.get(p.pid) ?? null, curr, TICKS_PER_SEC, cores)
    nextPrev.set(p.pid, curr)
    nodes.push({ pid: p.pid, ppid: p.ppid, cpuPct, rssBytes: p.rssBytes })
    byPid.set(p.pid, { pid: p.pid, name: p.comm, cpuPct, rssBytes: p.rssBytes })
  }
  prevCpuByPid = nextPrev
  return { nodes, byPid }
}

/** The session's descendants (NOT the root itself — its own cost rolls into the row's aggregate total). */
function childProcSamples(
  nodes: ProcNode[],
  rootPid: number,
  byPid: Map<number, ProcSample>
): ProcSample[] {
  const samples: ProcSample[] = []
  for (const pid of subtreePids(nodes, rootPid)) {
    if (pid === rootPid) continue
    const sample = byPid.get(pid)
    if (sample) samples.push(sample)
  }
  return samples
}

function liveSessionRows(
  descriptors: readonly LivePtyDescriptor[],
  nodes: ProcNode[],
  byPid: Map<number, ProcSample>,
  policy: Policy,
  atMs: number
): SessionSample[] {
  const liveSessions: LiveSession[] = descriptors.map((d) => ({
    sessionKey: d.sessionKey,
    kind: d.kind,
    taskState: d.taskState,
    lastFocusedAt: d.lastFocusedAt,
    lastActivityAt: d.lastActivityAt,
    isSelected: d.isSelected,
    // The Approval Inbox lives outside pty.ts's tracked state — same "wired false
    // deliberately" posture as `fleetSnapshot()` in pty.ts.
    hasPendingApproval: false
  }))
  const explanationBySessionKey = new Map(
    explainFleet(liveSessions, atMs, policy).map((e) => [e.sessionKey, e])
  )

  return descriptors.map((d) => {
    const total = aggregateSubtree(nodes, d.pid)
    const explanation = explanationBySessionKey.get(d.sessionKey)
    if (total.rssBytes !== null) lastKnownRssBySessionKey.set(d.sessionKey, total.rssBytes)
    return {
      sessionKey: d.sessionKey,
      kind: d.kind,
      state: 'live',
      cpuPct: total.cpuPct,
      rssBytes: total.rssBytes,
      procs: childProcSamples(nodes, d.pid, byPid),
      idleMs: explanation?.idleMs ?? 0,
      parkable: explanation?.parkable ?? false,
      reason: explanation?.reason ?? 'active',
      sweepRank: explanation?.sweepRank ?? null,
      savedBytes: null
    }
  })
}

function parkedSessionRows(): SessionSample[] {
  return [...hibernatedKeys()].map((sessionKey) => ({
    sessionKey,
    // A parked session was, by construction, a `claude-resume` before it was parked
    // (fleet-policy's `isParkable` only ever parks that kind) — see `hibernation.ts`.
    kind: 'claude-resume',
    state: 'parked',
    cpuPct: null,
    rssBytes: null,
    procs: [],
    idleMs: 0,
    parkable: true,
    reason: 'parked',
    sweepRank: null,
    savedBytes: lastKnownRssBySessionKey.get(sessionKey) ?? null
  }))
}

/** The renderer's main-thread CPU at the previous full sample, for the busy % delta. */
let prevRendererThread: CpuTimeSample | null = null
const RENDERER_FALLBACK_SPAN_MS = 60_000

/**
 * Busy % of the renderer's main thread. On Linux it is that thread's own CPU share (`/proc`, `tid === pid`);
 * elsewhere it falls back to the time spent in reported long tasks over the last minute, a lower bound,
 * and says so (`approx`).
 */
function rendererBusy(
  getWindow: () => BrowserWindow | null,
  atMs: number
): { pct: number | null; approx: boolean } {
  const monitor = getStallMonitor()
  const win = getWindow()
  const pid = win && !win.isDestroyed() ? win.webContents.getOSProcessId() : 0
  const cpu = pid > 0 ? readThreadCpu(pid, pid) : null
  if (cpu) {
    const curr: CpuTimeSample = { utime: cpu.utime, stime: cpu.stime, atMs }
    const pct = cpuPercent(prevRendererThread, curr, TICKS_PER_SEC, 1)
    prevRendererThread = curr
    return { pct: pct === null ? null : Math.round(pct * 10) / 10, approx: false }
  }
  prevRendererThread = null
  if (!monitor) return { pct: null, approx: true }
  const share =
    monitor.rendererStalledMs(RENDERER_FALLBACK_SPAN_MS, atMs) / RENDERER_FALLBACK_SPAN_MS
  return { pct: Math.min(100, Math.round(share * 1000) / 10), approx: true }
}

function stallsSample(
  getWindow: () => BrowserWindow | null,
  atMs: number
): StallsSample | undefined {
  const monitor = getStallMonitor()
  if (!monitor) return undefined
  const summary = monitor.summary(atMs)
  const renderer = rendererBusy(getWindow, atMs)
  return {
    main: { ...summary.main, busyPct: monitor.mainBusyPct(), busyApprox: false },
    renderer: { ...summary.renderer, busyPct: renderer.pct, busyApprox: renderer.approx }
  }
}

function buildSample(atMs: number, getWindow: () => BrowserWindow | null): MonitorSample {
  const { nodes, byPid } = sampleProcTree(atMs)
  const stalls = stallsSample(getWindow, atMs)
  return {
    atMs,
    heap: heapSample(atMs),
    harnu: harnuGroup(),
    sessions: [
      ...liveSessionRows(livePtyDescriptors(), nodes, byPid, getPolicy(), atMs),
      ...parkedSessionRows()
    ],
    ...(stalls ? { stalls } : {})
  }
}

function pushFullSample(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('monitor:sample', buildSample(Date.now(), getWindow))
}

function startFullSampler(getWindow: () => BrowserWindow | null): void {
  fullSamplerRefcount++
  if (fullTimer) return // already running — the refcount above is what start/stop balance against
  pushFullSample(getWindow) // immediate sample so the takeover doesn't wait a full tick
  fullTimer = setInterval(() => pushFullSample(getWindow), FULL_SAMPLE_MS)
}

function stopFullSampler(): void {
  fullSamplerRefcount = Math.max(0, fullSamplerRefcount - 1)
  if (fullSamplerRefcount > 0) return
  if (fullTimer) {
    clearInterval(fullTimer)
    fullTimer = null
  }
}

export function registerMonitorHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('monitor:start', (): void => startFullSampler(getWindow))
  ipcMain.handle('monitor:stop', (): void => stopFullSampler())
  // BUG-69: Park-now converged onto `pty:park` (pty.ts's `hibernateSession`),
  // the same kill+flag+broadcast transaction the automatic sweep uses — no
  // separate flag-only verb here anymore (that was the bug: a flag with no
  // broadcast left the renderer's terminal never disposed).
  ipcMain.handle('monitor:policyGet', (): Policy => getPolicy())
  ipcMain.handle('monitor:policySet', (_e, patch: Partial<Policy>): Policy => setPolicy(patch))

  // T697: the renderer reports its long tasks here; a diagnostic block can be injected on either
  // thread (off unless HARNU_STALL_INJECT=1) to prove the monitor names its owner.
  ipcMain.on('monitor:stallReport', (_e, batch: unknown): void => {
    getStallMonitor()?.reportRenderer(batch)
  })
  ipcMain.handle('monitor:stallEnabled', (): boolean => getStallMonitor() !== null)
  ipcMain.handle('monitor:injectStall', (_e, thread: unknown, ms: unknown): boolean => {
    if (process.env.HARNU_STALL_INJECT !== '1') return false
    const duration = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
    if (thread === 'main') getStallMonitor()?.injectMainStall(duration)
    else if (thread === 'renderer') {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('monitor:injectStall', duration)
    } else return false
    return true
  })

  stopHeartbeat()
  pushHeap(getWindow)
  heartbeatTimer = setInterval(() => pushHeap(getWindow), HEARTBEAT_MS)
}

/** Stop the always-on heartbeat. Called from `before-quit`, beside `stopHibernationSweep`. */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** Stop the full sampler unconditionally (quit-time cleanup — bypasses the refcount). */
export function stopFullSamplerForced(): void {
  fullSamplerRefcount = 0
  if (fullTimer) {
    clearInterval(fullTimer)
    fullTimer = null
  }
}
