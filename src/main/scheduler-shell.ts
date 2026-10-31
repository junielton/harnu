/**
 * T294 (T291 U4) — the scheduler runner.
 *
 * One module-level `setInterval` (30s) drives every worker — N per-worker
 * timers would be N states to drift and clean up on every enable/disable/
 * delete. Each due worker becomes a headless `claude -p` tick: stdin is
 * `/dev/null` (`-p` otherwise waits ~3s for stdin and warns), cwd is the
 * worker's own folder, and the tick is killed at `timeoutSeconds` or by an
 * explicit `stop()`.
 *
 * Pure/thin-shell split per ADR-0001: every decision (`dueWorkers`,
 * `tickArgv`, `nextFailureState`) lives in `scheduler-core.ts` and is
 * unit-tested there; `runFromResult` below — reading what the spawned
 * process actually said — is pure too and unit-tested in this file's test.
 * Everything else here (spawn, timers, fs, IPC, notify) is the env-bound
 * shell, excluded from coverage per the project's ADR-0001 convention.
 *
 * Notification policy (spec §5.3): the scheduler notifies ONLY about
 * itself — a worker disabled by its failure streak, or a worker disabled
 * because its folder vanished. Never per-tick. A worker that wants to say
 * something calls `mcp__harnu__notify` itself, from inside the tick
 * (allowlisted for `observe`, unrestricted for `act`).
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CommandBridge } from './command-bridge'
import { resolveClaudePath } from './claude-cli'
import { stageSkillsForTick } from './bundled-skills'
import { hookSettingsBlobJson } from './hook-bridge'
import { readMcpEnabled } from './mcp/prefs'
import { isFolderDenied } from './mcp/permission-core'
import { atomicWriteFile } from './mcp/atomic-write'
import {
  STEWARD_WAKE_GAP_MS,
  stewardBearer,
  stewardBlockedReason,
  stewardWorkerFor,
  wakeDecision,
  type WakeReason
} from './steward-core'
import {
  releaseCompanionSpawn,
  tickEnv,
  type CompanionSpawnProvider
} from './companion/spawn-inject'
import type { SpawnOwner } from './companion/session-table'
import {
  capResult,
  dueWorkers,
  newWorker,
  nextFailureState,
  parseSkillMentions,
  partitionExtraReadCommands,
  pinWorker,
  runNotificationText,
  shouldNotifyRun,
  tickArgv,
  unpinWorker,
  type Effort,
  type Run,
  type RunStatus,
  type TickContext,
  type Worker,
  type WorkerMode
} from './scheduler-core'
import {
  appendRun,
  deleteWorkerRuns,
  loadRuns,
  loadWorkersForBoot,
  saveWorkers,
  type NetworkLossNotice
} from './scheduler-store'

/** State pushed to the renderer on every change (`scheduler:changed`). */
export interface SchedulerState {
  workers: Worker[]
  runningIds: string[]
}

/** How often the ticker looks for due workers. Not a per-worker timer. */
const TICK_INTERVAL_MS = 30_000

/** `runOnBoot` workers are staggered by this much, in list order (spec §4.6). */
const BOOT_STAGGER_MS = 5_000

/** Roll `permission_denials` up as "Tool ×N", newest tool order preserved. */
function rollupDenials(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const counts = new Map<string, number>()
  for (const d of raw) {
    const name = (d as { tool_name?: string })?.tool_name
    if (typeof name !== 'string') continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([tool, n]) => `${tool} ×${n}`)
}

/**
 * Interpret one finished tick. Pure: the spawn is env-bound but *reading what
 * the process said* is where the bugs live, so it is unit-tested separately.
 * A non-zero exit is an error even when the JSON parsed — a `claude` that
 * printed a result and then failed is not a healthy tick.
 */
export function runFromResult(
  workerId: string,
  startedAt: number,
  endedAt: number,
  stdout: string,
  exitCode: number
): Run {
  const base = {
    workerId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    denials: [] as string[],
    numTurns: 0,
    costUsd: 0
  }
  let doc: Record<string, unknown> | undefined
  try {
    doc = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>
  } catch {
    return {
      ...base,
      status: 'error',
      result: capResult(stdout.trim()),
      terminalReason: 'unparseable'
    }
  }
  const usage = (doc.usage ?? {}) as Record<string, number>
  const failed = doc.is_error === true || exitCode !== 0
  return {
    ...base,
    status: failed ? 'error' : 'ok',
    result: typeof doc.result === 'string' ? capResult(doc.result) : '',
    terminalReason: typeof doc.terminal_reason === 'string' ? doc.terminal_reason : '',
    numTurns: typeof doc.num_turns === 'number' ? doc.num_turns : 0,
    costUsd: typeof doc.total_cost_usd === 'number' ? doc.total_cost_usd : 0,
    tokens: {
      in: usage.input_tokens ?? 0,
      out: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0
    },
    denials: rollupDenials(doc.permission_denials)
  }
}

/** A run record for a tick that never produced process output at all. */
function runForOutcome(
  workerId: string,
  startedAt: number,
  endedAt: number,
  status: Extract<RunStatus, 'timeout' | 'stopped' | 'error'>,
  result: string
): Run {
  return {
    workerId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    status,
    result: capResult(result),
    terminalReason: status,
    numTurns: 0,
    costUsd: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    denials: []
  }
}

// ---------------------------------------------------------------------------
// Runtime state (module-level — one runner per process)
// ---------------------------------------------------------------------------

interface LiveTick {
  worker: Worker
  child: ChildProcess
  startedAt: number
  stdout: string
  timeoutHandle: ReturnType<typeof setTimeout>
  /** Set right before `kill()` so the exit handler knows why it died. */
  outcome: 'timeout' | 'stopped' | null
  settled: boolean
  /** T389: the spawn-ledger owner of this tick's token; released when the child closes. */
  companionOwner?: SpawnOwner
  /** BUG-169: mentions the stager refused for this tick, shown in the run's denials. */
  skillRejections: string[]
}

/**
 * T389: the companion mod's spawn provider for ticks (the same one `pty.ts` uses). `null` — the
 * default and the answer whenever the mod is off — leaves a tick's argv and env as they were.
 */
let companionPlanProvider: CompanionSpawnProvider = async () => null

export function setSchedulerCompanionProvider(fn: CompanionSpawnProvider): void {
  companionPlanProvider = fn
}

function releaseTickSpawn(live: LiveTick): void {
  if (live.companionOwner) releaseCompanionSpawn(live.companionOwner, 'tick-done')
}

let workersCache: Worker[] = []
const lastRunAt: Record<string, number> = {}
const liveTicks = new Map<string, LiveTick>()
let getWindowRef: (() => BrowserWindow | null) | null = null
let bridgeRef: CommandBridge | null = null
let tickerHandle: ReturnType<typeof setInterval> | null = null
/**
 * T308: hoisted out of `registerScheduler` so `createWorkerForAgent`/
 * `listWorkersForAgent` (the MCP verbs' in-process entry points — no IPC/
 * renderer round trip, they call straight into this module's own
 * `workersCache`) can await the SAME boot-load race guard every `ipcMain`
 * handler already does — see the comment on `registerScheduler` below.
 *
 * BUG-121: this placeholder is an ALREADY-RESOLVED promise, so before
 * `registerScheduler` assigns the real one, `await ready` waits for nothing.
 * That is deliberate for the READ paths (`scheduler:list`, `scheduler:runs`,
 * `listWorkersForAgent`) — an empty read is harmless. It is NOT enough for the
 * write paths, which is what {@link storeLoaded} below exists for.
 */
let ready: Promise<void> = Promise.resolve()

/**
 * BUG-121: has the on-disk store actually been read into `workersCache` yet?
 *
 * `workersCache` is `[]` in two completely different situations — *"the store
 * has not loaded yet"* and *"the store loaded and the operator owns zero
 * workers"* — and {@link ready}'s resolved placeholder cannot tell them apart.
 * Chained with `persistWorkers()`, which is a WHOLE-FILE overwrite and not an
 * append, the first situation is unrecoverable data loss: a write that lands
 * before the load stamps an empty (or one-element) list over every worker the
 * operator owns, with no error and nothing to restore from.
 *
 * So the distinction gets its own flag, set at exactly the instant the cache
 * reflects disk, and every path that MUTATES `workersCache` refuses while it is
 * false. Refuse on "not loaded", never on "empty" — a first-boot install
 * genuinely has zero workers and must still be able to create one.
 */
let storeLoaded = false

/**
 * Thrown by every write path that runs before the store has loaded. A typed
 * error, not a silent no-op: an invisible refusal would just trade one silent
 * failure for another, and the caller (an MCP verb, an IPC handler) has to be
 * able to say *why* nothing was written.
 */
export class SchedulerNotReadyError extends Error {
  readonly code = 'SCHEDULER_NOT_READY'

  constructor() {
    super(
      'SCHEDULER_NOT_READY: the scheduler store has not finished loading. ' +
        'Writing now would overwrite schedulers.json with an incomplete set of ' +
        'workers and destroy the ones already on disk. Retry once the app has booted.'
    )
    this.name = 'SchedulerNotReadyError'
  }
}

/** Guard the write paths share. Throws {@link SchedulerNotReadyError}. */
function assertStoreLoaded(): void {
  if (!storeLoaded) throw new SchedulerNotReadyError()
}

/**
 * Recognise the refusal ACROSS module instances. Prefer this over
 * `instanceof SchedulerNotReadyError` at any boundary: a duplicated module
 * instance (a test registry reset, two bundles resolving this file separately)
 * gives you a *different* class object and `instanceof` silently answers false,
 * turning a handled refusal back into an unhandled throw. The `code` string
 * survives that.
 */
export function isSchedulerNotReady(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'SCHEDULER_NOT_READY'
}

/**
 * `<userData>/harnu.mcp.json` — the same path `mcp/server.ts` writes (T93).
 * That module doesn't export a getter for its running state, so a tick's MCP
 * wiring is best-effort here: the file's mere presence is treated as "the
 * control server is up", the same TOCTOU-narrowing (not eliminating) posture
 * `shouldInjectMcpConfig`'s doc describes — never point `claude` at a file
 * that doesn't exist right now.
 */
function mcpConfigPathIfPresent(): string | undefined {
  const p = join(app.getPath('userData'), 'harnu.mcp.json')
  return existsSync(p) ? p : undefined
}

/** A steward stages skills the way an observe tick does: the stricter rule (no skill with hooks). */
function stageModeOf(mode: WorkerMode): 'observe' | 'act' {
  return mode === 'act' ? 'act' : 'observe'
}

function emitChanged(): void {
  const win = getWindowRef?.()
  if (win && !win.isDestroyed()) {
    const state: SchedulerState = { workers: workersCache, runningIds: [...liveTicks.keys()] }
    win.webContents.send('scheduler:changed', state)
  }
}

async function notifySelf(
  worker: Worker,
  description: string,
  kind: 'info' | 'warning' = 'warning'
): Promise<void> {
  if (!bridgeRef) return
  try {
    await bridgeRef.dispatch('notify.push', {
      folderPath: worker.folder,
      title: `Scheduler: ${worker.name}`,
      description,
      kind
    })
  } catch {
    // Best-effort — a notify failure must never break the tick runner.
  }
}

function updateWorker(id: string, patch: Partial<Worker>): Worker | undefined {
  let updated: Worker | undefined
  workersCache = workersCache.map((w) => {
    if (w.id !== id) return w
    updated = { ...w, ...patch }
    return updated
  })
  return updated
}

/**
 * BUG-121: the single choke point every mutation funnels through, and therefore
 * the right place for the last line of defence. `saveWorkers` is a whole-file
 * overwrite, so this function is where an un-loaded cache becomes an erased
 * `schedulers.json` — it refuses rather than write.
 *
 * **This assert is a BACKSTOP, not the real guard.** Its callers
 * (`scheduler:save`, `scheduler:delete`, `completeTick`, `startTick`) have
 * already mutated `workersCache` by the time they get here, so a throw at this
 * point leaves cache and disk diverged with no rollback. That is unreachable
 * today — all four run after `await ready` inside `registerScheduler` — and it
 * is still the wrong shape to rely on. The REAL guard is the identical assert
 * at the top of `createWorkerForAgent`, placed BEFORE its mutation; that is the
 * pattern any new write path should copy, and neither assert should be deleted
 * as redundant, because they protect different instants.
 */
async function persistWorkers(): Promise<void> {
  assertStoreLoaded()
  await saveWorkers(workersCache, pendingNetworkNotice)
}

/** The worker's most recent recorded result, for `carryLastResult`. */
async function lastResultFor(workerId: string): Promise<string | undefined> {
  const runs = await loadRuns(workerId)
  return runs.length > 0 ? runs[runs.length - 1].result : undefined
}

/**
 * Fold one finished tick into the worker and, if the worker asked for it, say
 * so out loud.
 *
 * **Every outcome funnels through here** — `ok`, `error`, `timeout`, `stopped`
 * and a tick that never spawned all arrive as a `Run` on this one function, so
 * this is the ONLY place T304's per-run notification branches. Scattering
 * `notifySelf` calls across the exit paths is precisely how "notify on failure"
 * regresses into "notify on the failures someone remembered to wire up"; the
 * decision itself is `shouldNotifyRun` in the pure core, and this function only
 * carries it out.
 */
async function completeTick(
  worker: Worker,
  run: Run,
  skillRejections: readonly string[] = []
): Promise<void> {
  liveTicks.delete(worker.id)
  // BUG-108 / BUG-164: `observe` has no shell, so an extra read command never reaches
  // the allowlist. Record it alongside the tick's own permission denials so the
  // Runs tab shows the refusal instead of the operator wondering why their rule
  // did nothing. `act` has no allowlist to widen, so the field is inert there.
  if (worker.mode === 'observe') {
    const { rejected } = partitionExtraReadCommands(worker.extraReadCommands)
    if (rejected.length > 0) {
      run = { ...run, denials: [...rejected.map((r) => `rejected rule: ${r}`), ...run.denials] }
    }
  }
  // BUG-169: a refused skill mention, next to the tick's own permission denials.
  if (skillRejections.length > 0) {
    run = { ...run, denials: [...skillRejections, ...run.denials] }
  }
  await appendRun(run)

  const failure = nextFailureState(worker.failureStreak, run.status)
  // Campaign ch.5a: a steward is never switched off by a failure streak — "a mission's guarantees
  // vanishing through one unnoticed toggle" is what the category exists to prevent. It keeps its
  // beat; the streak still counts, so the operator sees it.
  const streak = failure.streak
  const disable = worker.category === 'steward' ? false : failure.disable
  if (streak !== worker.failureStreak || disable) {
    const updated = updateWorker(worker.id, {
      failureStreak: streak,
      enabled: disable ? false : worker.enabled
    })
    await persistWorkers()
    if (disable && updated) {
      await notifySelf(updated, `Disabled after ${streak} consecutive failures.`)
    }
  }
  // The auto-disable notice above already reports this very tick, and reports
  // it with more consequence attached — a second line about the same run would
  // be the double-notification this setting exists to prevent.
  if (!disable && shouldNotifyRun(worker, run.status)) {
    await notifySelf(worker, runNotificationText(run), run.status === 'ok' ? 'info' : 'warning')
  }
  emitChanged()
}

function finishLiveTick(id: string, exitCode: number | null): void {
  const live = liveTicks.get(id)
  if (!live || live.settled) return
  live.settled = true
  clearTimeout(live.timeoutHandle)
  releaseTickSpawn(live)
  const endedAt = Date.now()

  let run: Run
  if (live.outcome === 'timeout') {
    run = runForOutcome(id, live.startedAt, endedAt, 'timeout', live.stdout)
  } else if (live.outcome === 'stopped') {
    run = runForOutcome(id, live.startedAt, endedAt, 'stopped', live.stdout)
  } else {
    run = runFromResult(id, live.startedAt, endedAt, live.stdout, exitCode ?? 1)
  }
  void completeTick(live.worker, run, live.skillRejections)
}

/**
 * Start one tick for `worker`. Never called for a worker already in
 * `liveTicks` — callers (the ticker, `runNow`) are responsible for that
 * check so this function can stay a straight line.
 */
async function startTick(worker: Worker, wakeReason?: WakeReason): Promise<void> {
  // Campaign ch.5a: the global kill-switches stop a steward like every agent. Checked first, and a
  // blocked beat is not a run: nothing is recorded, no failure counts, the next beat looks again.
  if (worker.category === 'steward') {
    const blocked = await stewardGateReason(worker.folder)
    if (blocked) return
  }
  lastRunAt[worker.id] = Date.now()

  // Spec's vanished-folder rule: check BEFORE spawning, disable + notify,
  // never spawn into a dead cwd.
  const folderOk = await fs
    .access(worker.folder)
    .then(() => true)
    .catch(() => false)
  if (!folderOk) {
    const updated = updateWorker(worker.id, { enabled: false })
    await persistWorkers()
    if (updated) await notifySelf(updated, `Disabled — folder no longer exists: ${worker.folder}`)
    emitChanged()
    return
  }

  const claudePath = await resolveClaudePath()
  const startedAt = Date.now()
  if (!claudePath) {
    await completeTick(
      worker,
      runForOutcome(
        worker.id,
        startedAt,
        Date.now(),
        'error',
        'Could not find the `claude` CLI on PATH.'
      )
    )
    return
  }

  // T305: the prompt's `/skill` mentions are staged alongside the folder's
  // enabled bundled skills. Derived from `worker.prompt` HERE, at spawn time —
  // never read off a stored field, which is what keeps the staged set and the
  // text the model reads from ever disagreeing.
  // BUG-169: an observe tick is staged in observe mode — bundled names resolve to the bundled
  // skill, and a skill that declares hooks is refused and reported on the run.
  const { staged, rejected: skillRejected } = await stageSkillsForTick(
    worker.folder,
    parseSkillMentions(worker.prompt),
    stageModeOf(worker.mode)
  ).catch(() => ({ staged: null, rejected: [] }))
  const lastResult = worker.carryLastResult ? await lastResultFor(worker.id) : undefined
  // A steward presents its OWN bearer (the server recognises it and enforces its allowlist); with
  // no control server up there is nothing for it to do, so it does not tick.
  const mcpConfigPath =
    worker.category === 'steward'
      ? await writeStewardMcpConfig(worker.id)
      : mcpConfigPathIfPresent()
  if (worker.category === 'steward' && !mcpConfigPath) return

  // BUG-111: a tick runs with `--setting-sources ''`, so the globally-installed
  // Harnu hooks never load. Inject them the same way the PTY path does, from the
  // same provider — `null` when the bridge is down or injection is opted out,
  // in which case the tick simply spawns without them, as it always did.
  const hookSettingsJson = hookSettingsBlobJson()

  // T389: the companion mod rides a tick as the first `--plugin-dir`, with a token owned by this
  // run. Sensor-only (trust `tick`).
  const companionPlan = await companionPlanProvider({ cwd: worker.folder, trust: 'tick' })

  const ctx: TickContext = {
    ...(companionPlan ? { companionPluginDir: companionPlan.pluginDir } : {}),
    ...(staged ? { pluginDir: staged.dir } : {}),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(lastResult ? { lastResult } : {}),
    ...(hookSettingsJson ? { hookSettingsJson } : {})
  }

  const argv = tickArgv(
    wakeReason ? { ...worker, prompt: `Woken by: ${wakeReason}.\n\n${worker.prompt}` } : worker,
    ctx
  )
  const companionOwner: SpawnOwner | undefined = companionPlan
    ? { kind: 'tick', workerId: worker.id, runId: `${worker.id}-${startedAt}` }
    : undefined
  const env = tickEnv(
    process.env,
    companionPlan && companionOwner ? companionPlan.mintToken(companionOwner) : null
  )
  const child = spawn(claudePath, argv, {
    cwd: worker.folder,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env } : {})
  })

  const timeoutHandle = setTimeout(() => {
    const l = liveTicks.get(worker.id)
    if (!l || l.settled) return
    l.outcome = 'timeout'
    l.child.kill('SIGTERM')
  }, worker.timeoutSeconds * 1000)

  const live: LiveTick = {
    worker,
    child,
    startedAt,
    stdout: '',
    outcome: null,
    settled: false,
    timeoutHandle,
    skillRejections: skillRejected.map(skillRejectionText),
    ...(companionOwner ? { companionOwner } : {})
  }
  liveTicks.set(worker.id, live)
  emitChanged()

  child.stdout?.on('data', (d: Buffer) => {
    live.stdout += d.toString()
  })
  child.stderr?.on('data', (d: Buffer) => {
    live.stdout += d.toString()
  })
  child.on('error', (err) => {
    const l = liveTicks.get(worker.id)
    if (!l || l.settled) return
    l.settled = true
    clearTimeout(l.timeoutHandle)
    releaseTickSpawn(l)
    void completeTick(
      worker,
      runForOutcome(worker.id, startedAt, Date.now(), 'error', String(err)),
      l.skillRejections
    )
  })
  child.on('exit', (code) => {
    finishLiveTick(worker.id, code)
  })
}

/** BUG-169: how a refused mention reads in the Runs tab. */
function skillRejectionText(r: {
  mention: string
  reason: 'hooks' | 'unsafe-layout' | 'unsafe-frontmatter'
}): string {
  const why =
    r.reason === 'hooks'
      ? 'declares hooks'
      : r.reason === 'unsafe-frontmatter'
        ? 'unsafe frontmatter'
        : 'unsafe files'
  return `rejected skill: /${r.mention} (${why})`
}

/** One 30s beat: start every worker `dueWorkers` says is ready. */
async function tick(): Promise<void> {
  const now = Date.now()
  const running = [...liveTicks.keys()]
  const due = dueWorkers(workersCache, lastRunAt, running, now)
  for (const worker of due) {
    void startTick(worker)
  }
}

/**
 * BUG-166: the migration notice that is owed but not yet delivered. Persisted with every workers
 * write (see {@link persistWorkers}), so it survives a restart until a dispatch succeeds.
 */
let pendingNetworkNotice: NetworkLossNotice[] = []

let networkNoticeRetryMs = 2_000
const NETWORK_NOTICE_MAX_TRIES = 90

/** Bumped on every scheduler start and stop, so a stale delivery loop ends instead of lingering. */
let noticeEpoch = 0

/** Test seam: the wait between delivery attempts. */
export function setNetworkNoticeRetryMs(ms: number): void {
  networkNoticeRetryMs = ms
}

/**
 * BUG-166: one notice, listing the observe workers that just lost `WebFetch` because their saved
 * definition predates the opt-in and their prompt names a URL or the tool. Posted into the
 * operator's Activity history under the first affected worker's folder.
 *
 * The command bridge REFUSES to dispatch until the renderer has announced itself, and this runs
 * from `initScheduler`, before the window exists. A single fire-and-forget dispatch (the first
 * version) was therefore lost every time, and since the file had already been healed it could never
 * be sent again. So the notice is retried like `data-dir-boot`'s, and the record is cleared only
 * after a dispatch SUCCEEDED. If this boot never gets a ready bridge, the record stays on disk and
 * the next boot delivers it.
 */
async function deliverNetworkNotice(epoch: number): Promise<void> {
  for (let attempt = 0; attempt < NETWORK_NOTICE_MAX_TRIES; attempt++) {
    if (epoch !== noticeEpoch) return
    const lost = pendingNetworkNotice
    if (lost.length === 0) return
    const names = lost.map((w) => w.name || w.id).join(', ')
    try {
      if (!bridgeRef) throw new Error('no bridge')
      await bridgeRef.dispatch('notify.push', {
        folderPath: lost[0].folder,
        title: 'Scheduler: network access is now opt-in',
        description: `Observe workers no longer get WebFetch by default. These mention a URL or WebFetch and now run without it: ${names}. Turn on "Network access" in a worker's Settings if it needs it.`,
        kind: 'warning'
      })
    } catch {
      await new Promise((r) => setTimeout(r, networkNoticeRetryMs))
      continue
    }
    if (epoch !== noticeEpoch) return
    pendingNetworkNotice = []
    await persistWorkers().catch(() => {})
    return
  }
}

async function initScheduler(): Promise<void> {
  const boot = await loadWorkersForBoot()
  workersCache = boot.workers
  // BUG-121: set at exactly the instant the cache reflects disk — after the
  // read, before anything that could await and let a write interleave. From
  // here on an empty `workersCache` means the operator owns zero workers.
  storeLoaded = true
  // BUG-166: every worker now carries an explicit `allowNetwork`, written back in the same write
  // that records the notice that is owed for it, so the two can never be split by a crash. The
  // notice is then delivered in the background, with retry (see deliverNetworkNotice).
  const owed = [...boot.pendingNotice, ...boot.lostNetwork].filter(
    (w, i, all) => all.findIndex((x) => x.id === w.id) === i
  )
  pendingNetworkNotice = owed
  const epoch = ++noticeEpoch
  if (boot.needsHeal || owed.length > 0) await persistWorkers()
  if (owed.length > 0) void deliverNetworkNotice(epoch)
  for (const w of workersCache) {
    const runs = await loadRuns(w.id)
    if (runs.length > 0) lastRunAt[w.id] = runs[runs.length - 1].startedAt
  }
  emitChanged()

  // §4.6: runOnBoot workers fire at startup, staggered so they never land in
  // the same second.
  const bootWorkers = workersCache.filter((w) => w.enabled && w.runOnBoot)
  bootWorkers.forEach((w, i) => {
    setTimeout(() => {
      if (!liveTicks.has(w.id)) void startTick(w)
    }, i * BOOT_STAGGER_MS)
  })
}

// ---------------------------------------------------------------------------
// T308: the MCP verbs' entry points (create_worker / list_workers)
//
// Straight-line calls into THIS module's own `workersCache` — no IPC, no
// renderer round trip. The MCP server already runs in the main process, and a
// worker's live state is exactly `workersCache` + `scheduler-store.ts`'s
// on-disk runs, so routing through the renderer (like `notify`/`speak` do,
// because THEIR target genuinely lives there) would just be a second, slower
// path to the same state this module already owns. Both await the module-level
// `ready` for the same reason every `ipcMain` handler below does: a call that
// lands while `initScheduler()` is still loading must not race the boot load.
// ---------------------------------------------------------------------------

/** Input for {@link createWorkerForAgent} — the `create_worker` MCP verb's shape. */
export interface CreateWorkerAgentInput {
  folder: string
  name: string
  prompt: string
  everyMinutes: number
  mode: WorkerMode
  model?: string
  effort?: Effort
  /** T316 AC-5: defaults to {@link newWorker}'s 300s when omitted. */
  timeoutSeconds?: number
  /** BUG-166: opt in to WebFetch. Defaults to off. */
  allowNetwork?: boolean
}

/** Result of {@link createWorkerForAgent}. */
export interface CreateWorkerAgentResult {
  worker: Worker
  /**
   * T305: of the skills the prompt `/mentions`, the ones that did NOT resolve
   * to anything staged for this folder — reported so the ACK can warn instead
   * of silently accepting a mention that will never stage (AC-6).
   */
  missingSkills: string[]
  /** BUG-169: mentions an `observe` tick will refuse to stage because the skill declares hooks. */
  rejectedSkills: string[]
}

/**
 * Create a worker on behalf of an agent (T308 AC-1). Unlike {@link newWorker}
 * (born `enabled: false` — the UI form's half-typed-prompt guard, see its own
 * doc), every field arrives atomically in one call here, so there is no
 * in-between state to protect against: the worker is born ENABLED and fires
 * from the Scheduler's next 30s tick.
 *
 * BUG-121: rejects with {@link SchedulerNotReadyError} when the store has not
 * loaded. `await ready` alone is not that check — before `registerScheduler`
 * runs, `ready` is an already-resolved placeholder that waits for nothing, so
 * this call would append to an EMPTY cache and then whole-file overwrite
 * `schedulers.json` with just the one new worker. The assert is placed before
 * any mutation, so a refused call leaves even the in-memory cache untouched.
 */
export async function createWorkerForAgent(
  input: CreateWorkerAgentInput
): Promise<CreateWorkerAgentResult> {
  await ready
  assertStoreLoaded()
  const base = newWorker(randomUUID())
  const worker: Worker = {
    ...base,
    name: input.name,
    prompt: input.prompt,
    folder: input.folder,
    everyMinutes: input.everyMinutes,
    mode: input.mode,
    model: input.model ?? base.model,
    effort: input.effort ?? base.effort,
    timeoutSeconds: input.timeoutSeconds ?? base.timeoutSeconds,
    allowNetwork: input.allowNetwork === true,
    enabled: true
  }
  workersCache = [...workersCache, worker]
  await persistWorkers()
  emitChanged()

  const mentions = parseSkillMentions(worker.prompt)
  let missingSkills: string[] = []
  let rejectedSkills: string[] = []
  if (mentions.length > 0) {
    const out = await stageSkillsForTick(worker.folder, mentions, stageModeOf(worker.mode)).catch(
      () => null
    )
    const resolved = new Set(out?.staged?.mentioned ?? [])
    rejectedSkills = (out?.rejected ?? []).map((r) => r.mention)
    missingSkills = mentions.filter((m) => !resolved.has(m) && !rejectedSkills.includes(m))
  }
  return { worker, missingSkills, rejectedSkills }
}

/** One redacted-at-the-source row {@link listWorkersForAgent} returns. Folder redaction is the MCP handler's job (fleet-read parity), not this shell's. */
export interface AgentWorkerRow {
  id: string
  name: string
  folder: string
  mode: WorkerMode
  everyMinutes: number
  enabled: boolean
  /** Campaign ch.5a: `'steward'` for a mission's system worker; absent for a user worker. */
  category?: 'steward'
  /** Set with `category: 'steward'`: the mission it serves. */
  missionId?: string
  lastRun?: { status: RunStatus; startedAt: number }
}

/**
 * List workers on behalf of an agent (T308 AC-4), optionally scoped to one
 * folder. Returns the RAW folder path — the MCP handler (`tool-handlers.ts`)
 * redacts it to an alias the same way `get_fleet`/`list_worktrees` do; this
 * shell layer only assembles the truth.
 */
export async function listWorkersForAgent(folder?: string): Promise<AgentWorkerRow[]> {
  await ready
  const scoped = folder ? workersCache.filter((w) => w.folder === folder) : workersCache
  return Promise.all(
    scoped.map(async (w) => {
      const runs = await loadRuns(w.id)
      const last = runs[runs.length - 1]
      const row: AgentWorkerRow = {
        id: w.id,
        name: w.name,
        folder: w.folder,
        mode: w.mode,
        everyMinutes: w.everyMinutes,
        enabled: w.enabled,
        ...(w.category === 'steward' ? { category: w.category, missionId: w.missionId } : {})
      }
      if (last) row.lastRun = { status: last.status, startedAt: last.startedAt }
      return row
    })
  )
}

/**
 * Thrown by {@link updateWorkerForAgent} / {@link deleteWorkerForAgent} when
 * `id` names no worker. A typed error, not a silent no-op, so the MCP handler
 * can say precisely why nothing changed — same convention as
 * {@link SchedulerNotReadyError}.
 */
export class WorkerNotFoundError extends Error {
  readonly code = 'WORKER_NOT_FOUND'

  constructor(id: string) {
    super(`WORKER_NOT_FOUND: no worker with id "${id}"`)
    this.name = 'WorkerNotFoundError'
  }
}

/**
 * Recognise the refusal ACROSS module instances — same reasoning as
 * {@link isSchedulerNotReady}: `instanceof` silently answers false across a
 * duplicated module instance, turning a handled refusal back into an
 * unhandled throw.
 */
export function isWorkerNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'WORKER_NOT_FOUND'
}

/**
 * T316: synchronous in-memory lookup — the folder a worker belongs to, or
 * `undefined` if `id` names no worker (or the store has not loaded yet).
 * `update_worker`/`delete_worker` address a worker by `id` alone and carry no
 * `folder` field of their own, so the MCP gate (`server.ts`) resolves its
 * anchor from here — the same shape `resolveSessionGateFolder` resolves a
 * `message_session`/`orchestrator_arm` target's folder from a `sessionId`,
 * applied to a worker instead of a session. An unresolved id fails CLOSED
 * (the gate denies FOLDER_NOT_ALLOWED) rather than defaulting to some folder.
 */
export function folderForWorkerId(id: string): string | undefined {
  return workersCache.find((w) => w.id === id)?.folder
}

/**
 * Campaign ch.5a (spec §3.4): thrown when an edit or delete targets a mission's steward. A steward is
 * a system worker bound to its mission — its lifecycle is the mission's, and pausing it is a mission
 * door, so neither an agent nor the worker form can change or remove it.
 */
export class WorkerIsStewardError extends Error {
  readonly code = 'WORKER_IS_STEWARD'

  constructor(id: string) {
    super(
      `WORKER_IS_STEWARD: worker "${id}" is a mission's steward — a system worker. It is created when the mission is and deleted when the operator ends the mission; it cannot be edited, disabled or deleted. Pausing it is a mission door in the UI.`
    )
    this.name = 'WorkerIsStewardError'
  }
}

/** Cross-module-instance recognition, same reasoning as {@link isWorkerNotFound}. */
export function isWorkerIsSteward(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'WORKER_IS_STEWARD'
}

/** The subset of `Worker` fields `update_worker` may change. */
export type UpdateWorkerPatch = Partial<
  Pick<
    Worker,
    | 'name'
    | 'prompt'
    | 'everyMinutes'
    | 'mode'
    | 'model'
    | 'effort'
    | 'timeoutSeconds'
    | 'enabled'
    | 'runOnBoot'
    | 'carryLastResult'
    | 'notifyOn'
    | 'extraReadCommands'
    | 'systemPrompt'
    | 'allowNetwork'
  >
>

/** Input for {@link updateWorkerForAgent} — the `update_worker` MCP verb's shape. */
export interface UpdateWorkerAgentInput {
  id: string
  set: UpdateWorkerPatch
}

/** Result of {@link updateWorkerForAgent}. */
export interface UpdateWorkerAgentResult {
  worker: Worker
  /** T305/AC-6 parity with create_worker — only recomputed when `set.prompt` changed. */
  missingSkills: string[]
  /** BUG-169: see {@link CreateWorkerAgentResult.rejectedSkills}. */
  rejectedSkills: string[]
  /**
   * T316 decision 4: an edit never reaches a tick already running — it takes
   * effect starting the NEXT tick. `true` means a tick was live (with the
   * PRE-edit worker) at the moment this call landed.
   */
  tickInFlight: boolean
}

/**
 * Edit an EXISTING worker on behalf of an agent (T316 AC-1/AC-2) — the fix
 * half `create_worker` never had. Routes through {@link updateWorker}, the
 * SAME in-memory-cache mutation `completeTick`/`startTick` already share
 * (T316 decision 3): there is never a second, competing way to change
 * `workersCache`, so a write here can never be clobbered by the next UI save
 * (there is no watcher that reloads `schedulers.json` from disk). Unlike
 * {@link createWorkerForAgent} this NEVER creates a worker — `id` must already
 * exist, or it rejects with {@link WorkerNotFoundError}.
 */
export async function updateWorkerForAgent(
  input: UpdateWorkerAgentInput
): Promise<UpdateWorkerAgentResult> {
  await ready
  assertStoreLoaded()
  const target = workersCache.find((w) => w.id === input.id)
  if (!target) throw new WorkerNotFoundError(input.id)
  if (target.category === 'steward') throw new WorkerIsStewardError(input.id)

  const tickInFlight = liveTicks.has(input.id)
  // T483: `pinnedAt` is the operator's curation and `UpdateWorkerPatch` excludes it by type; strip
  // it at runtime too so no caller (a future one, a cast) can set or clear a pin through this path.
  const { pinnedAt: _ignoredPin, ...safeSet } = input.set as UpdateWorkerPatch & {
    pinnedAt?: unknown
  }
  void _ignoredPin
  const updated = updateWorker(input.id, safeSet)
  if (!updated) throw new WorkerNotFoundError(input.id)
  await persistWorkers()
  emitChanged()

  let missingSkills: string[] = []
  let rejectedSkills: string[] = []
  if (input.set.prompt !== undefined) {
    const mentions = parseSkillMentions(updated.prompt)
    if (mentions.length > 0) {
      const out = await stageSkillsForTick(
        updated.folder,
        mentions,
        stageModeOf(updated.mode)
      ).catch(() => null)
      const resolved = new Set(out?.staged?.mentioned ?? [])
      rejectedSkills = (out?.rejected ?? []).map((r) => r.mention)
      missingSkills = mentions.filter((m) => !resolved.has(m) && !rejectedSkills.includes(m))
    }
  }
  return { worker: updated, missingSkills, rejectedSkills, tickInFlight }
}

/**
 * T483: pin or unpin a worker — the operator's curation, reachable only through the
 * `scheduler:setPinned` IPC (no MCP verb carries it). Goes through the same cache mutation and
 * persistence as every other write, so a stale debounced `scheduler:save` can never resurrect an
 * old pin state: `scheduler:save` ignores `pinnedAt` and this is the only door that moves it.
 */
export async function setWorkerPinned(id: string, pinned: boolean): Promise<Worker[]> {
  await ready
  assertStoreLoaded()
  const idx = workersCache.findIndex((w) => w.id === id)
  if (idx < 0) throw new WorkerNotFoundError(id)
  workersCache = workersCache.map((w) =>
    w.id === id ? (pinned ? pinWorker(w, Date.now()) : unpinWorker(w)) : w
  )
  await persistWorkers()
  emitChanged()
  return workersCache
}

/**
 * Delete a worker on behalf of an agent (T316 AC-4) — the same effect as the
 * `scheduler:delete` IPC handler below (kills a live tick, drops the worker
 * AND its run history), just callable without a renderer round trip.
 */
export async function deleteWorkerForAgent(id: string): Promise<{ wasRunning: boolean }> {
  await ready
  assertStoreLoaded()
  const target = workersCache.find((w) => w.id === id)
  if (!target) throw new WorkerNotFoundError(id)
  if (target.category === 'steward') throw new WorkerIsStewardError(id)

  const live = liveTicks.get(id)
  const wasRunning = live !== undefined
  if (live) {
    live.outcome = 'stopped'
    live.child.kill('SIGTERM')
  }
  workersCache = workersCache.filter((w) => w.id !== id)
  await persistWorkers()
  await deleteWorkerRuns(id)
  emitChanged()
  return { wasRunning }
}

// ---------------------------------------------------------------------------
// Campaign ch.5a (T597): the steward — a mission's system worker
// ---------------------------------------------------------------------------

/** Test seam: how a woken steward actually ticks. Default: the real spawn path. */
let tickStarter: (worker: Worker, reason: WakeReason) => Promise<void> = (w, reason) =>
  startTick(w, reason)

export function setStewardTickStarter(
  fn: ((worker: Worker, reason: WakeReason) => Promise<void>) | null
): void {
  tickStarter = fn ?? ((w, reason) => startTick(w, reason))
}

let wakeGapMs = STEWARD_WAKE_GAP_MS

/** Test seam: the coalescing gap between event-driven ticks. */
export function setStewardWakeGapMs(ms: number): void {
  wakeGapMs = ms
}

/** One pending trailing wake per steward, so a burst of events yields one extra tick, not N. */
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Why a steward must not tick right now (agent control off, folder blocked), or `null`. */
async function stewardGateReason(folder: string): Promise<string | null> {
  const serverEnabled = await readMcpEnabled()
  // Imported lazily: `user-projects` drags in the git probe, which the runner's own tests (rightly)
  // do not provide an `execFile` for, and a steward's gate is the only reader.
  const { readUserProjects } = await import('./user-projects')
  const denied = (await readUserProjects()).projects
    .filter((p) => p.agentDenied === true)
    .map((p) => p.path)
  return stewardBlockedReason({ serverEnabled, folderDenied: isFolderDenied(folder, denied) })
}

function stewardConfigPath(workerId: string): string {
  return join(app.getPath('userData'), 'steward-mcp', `${workerId}.json`)
}

/**
 * The tick's own `--mcp-config`: the control server's URL with a bearer derived for THIS worker
 * (never the server secret itself). `undefined` when the control server is not up.
 */
async function writeStewardMcpConfig(workerId: string): Promise<string | undefined> {
  try {
    const base = JSON.parse(
      await fs.readFile(join(app.getPath('userData'), 'harnu.mcp.json'), 'utf8')
    ) as {
      mcpServers?: { harnu?: { url?: string; headers?: { Authorization?: string } } }
    }
    const entry = base.mcpServers?.harnu
    const secret = entry?.headers?.Authorization?.replace(/^Bearer /, '')
    if (!entry?.url || !secret) return undefined
    const doc = {
      mcpServers: {
        harnu: {
          type: 'http',
          url: entry.url,
          headers: { Authorization: `Bearer ${stewardBearer(secret, workerId)}` }
        }
      }
    }
    const file = stewardConfigPath(workerId)
    await fs.mkdir(join(app.getPath('userData'), 'steward-mcp'), { recursive: true, mode: 0o700 })
    await atomicWriteFile(file, JSON.stringify(doc, null, 2) + '\n', 0o600)
    return file
  } catch {
    return undefined
  }
}

/**
 * Create the steward of `missionId` (one per mission; a second call returns the first). Born
 * enabled, category `steward`, on the 20-minute fallback beat. Rejects with
 * {@link SchedulerNotReadyError} before the store has loaded, like every write path.
 */
export async function createStewardForMission(input: {
  missionId: string
  folder: string
  title: string
}): Promise<Worker> {
  await ready
  assertStoreLoaded()
  const existing = workersCache.find(
    (w) => w.category === 'steward' && w.missionId === input.missionId
  )
  if (existing) return existing
  const worker = stewardWorkerFor({ id: randomUUID(), ...input })
  workersCache = [...workersCache, worker]
  await persistWorkers()
  emitChanged()
  return worker
}

/** Delete every steward of `missionId` (and its runs, its tick, its MCP config). Returns how many went. */
export async function retireStewardForMission(missionId: string): Promise<number> {
  await ready
  assertStoreLoaded()
  const doomed = workersCache.filter((w) => w.category === 'steward' && w.missionId === missionId)
  for (const w of doomed) {
    const live = liveTicks.get(w.id)
    if (live) {
      live.outcome = 'stopped'
      live.child.kill('SIGTERM')
    }
    const timer = wakeTimers.get(w.id)
    if (timer) clearTimeout(timer)
    wakeTimers.delete(w.id)
    await fs.unlink(stewardConfigPath(w.id)).catch(() => {})
    await deleteWorkerRuns(w.id)
  }
  if (doomed.length > 0) {
    workersCache = workersCache.filter((w) => !doomed.includes(w))
    await persistWorkers()
    emitChanged()
  }
  return doomed.length
}

/**
 * Synchronous: the steward behind a worker id, for the control server's bearer check. `undefined`
 * once the worker is gone — which is what makes a deleted steward's bearer dead.
 */
export function stewardForWorkerId(
  workerId: string
): { workerId: string; missionId: string; folder: string } | undefined {
  const w = workersCache.find((x) => x.id === workerId)
  return w && w.category === 'steward' && w.missionId
    ? { workerId: w.id, missionId: w.missionId, folder: w.folder }
    : undefined
}

/** Every steward (for boot reconciliation and the hook refcount). */
export function listStewards(): Array<{ workerId: string; missionId: string; folder: string }> {
  return workersCache.flatMap((w) =>
    w.category === 'steward' && w.missionId
      ? [{ workerId: w.id, missionId: w.missionId, folder: w.folder }]
      : []
  )
}

export type WakeOutcome = { woke: true } | { woke: false; reason: string; deferred?: true }

/**
 * Wake the steward of `missionId` for a mission event (a ledger row, a CI change, a child going
 * idle, a blocker cleared). Idempotent and cheap to call from anywhere: no steward, a disabled or
 * blocked one, or a tick inside the coalescing gap are all answers, never errors.
 */
export async function wakeStewardForMission(
  missionId: string,
  reason: WakeReason
): Promise<WakeOutcome> {
  await ready
  if (!storeLoaded) return { woke: false, reason: 'SCHEDULER_NOT_READY' }
  const w = workersCache.find((x) => x.category === 'steward' && x.missionId === missionId)
  if (!w) return { woke: false, reason: 'no steward for this mission' }
  const decision = wakeDecision({
    enabled: w.enabled,
    running: liveTicks.has(w.id),
    blockedReason: await stewardGateReason(w.folder),
    now: Date.now(),
    lastStartedAt: lastRunAt[w.id],
    gapMs: wakeGapMs
  })
  if (decision.action === 'skip') return { woke: false, reason: decision.reason }
  if (decision.action === 'defer') {
    if (!wakeTimers.has(w.id)) {
      wakeTimers.set(
        w.id,
        setTimeout(() => {
          wakeTimers.delete(w.id)
          void wakeStewardForMission(missionId, reason)
        }, decision.inMs)
      )
    }
    return { woke: false, deferred: true, reason: 'coalesced into the next tick' }
  }
  lastRunAt[w.id] = Date.now()
  void tickStarter(w, reason)
  return { woke: true }
}

/**
 * Register the scheduler's IPC surface and start its ticker. Call once at
 * boot, alongside the other `register*` calls in `index.ts`.
 */
export function registerScheduler(
  getWindow: () => BrowserWindow | null,
  bridge: CommandBridge
): void {
  getWindowRef = getWindow
  bridgeRef = bridge

  // Every handler below awaits this FIRST. Without it, a `scheduler:save`
  // that lands while `loadWorkers()` is still in flight races the boot-time
  // load: the load's own `workersCache = await loadWorkers()` can resolve
  // AFTER the save's synchronous mutation, silently discarding the just-saved
  // worker when it overwrites the module-level variable.
  //
  // BUG-121: this line is also what flips `storeLoaded`, so calling it is what
  // makes the write paths usable AT ALL. That used to be an invisible ordering
  // dependency on `index.ts` calling `registerScheduler` before
  // `registerMcpServer` — reorder them and `create_worker` would erase
  // `schedulers.json` in silence. It now refuses instead, loudly, and the
  // ordering itself is pinned by tests/scheduler-store-load-guard.test.ts.
  ready = initScheduler()

  ipcMain.handle('scheduler:list', async (): Promise<Worker[]> => {
    await ready
    return workersCache
  })

  ipcMain.handle('scheduler:save', async (_e, draft: Partial<Worker>): Promise<Worker[]> => {
    await ready
    const id = draft.id && draft.id.length > 0 ? draft.id : randomUUID()
    // Campaign ch.5a: a steward is read-only to the operator's form too — and the form can never
    // mint one (no `steward` mode, category or mission binding in a draft).
    if (workersCache.some((w) => w.id === id && w.category === 'steward')) {
      throw new WorkerIsStewardError(id)
    }
    if (draft.mode === 'steward') draft = { ...draft, mode: 'observe' }
    if ('category' in draft || 'missionId' in draft) {
      const { category: _c, missionId: _m, ...plain } = draft
      void _c
      void _m
      draft = plain
    }
    const existingIdx = workersCache.findIndex((w) => w.id === id)
    const base: Worker = existingIdx >= 0 ? workersCache[existingIdx] : newWorker(id)
    // T483: a draft never moves the pin — `scheduler:setPinned` is the only door. The renderer's
    // debounced draft is built from a snapshot, so honoring its `pinnedAt` could undo a pin made
    // after the snapshot was taken.
    const { pinnedAt: _draftPin, ...draftWithoutPin } = draft
    void _draftPin
    const merged: Worker = { ...base, ...draftWithoutPin, id }
    if (existingIdx >= 0) workersCache[existingIdx] = merged
    else workersCache = [...workersCache, merged]
    await persistWorkers()
    emitChanged()
    return workersCache
  })

  ipcMain.handle(
    'scheduler:setPinned',
    async (_e, id: string, pinned: boolean): Promise<Worker[]> =>
      setWorkerPinned(id, pinned === true)
  )

  ipcMain.handle('scheduler:delete', async (_e, id: string): Promise<Worker[]> => {
    await ready
    if (workersCache.some((w) => w.id === id && w.category === 'steward')) {
      throw new WorkerIsStewardError(id)
    }
    const live = liveTicks.get(id)
    if (live) {
      live.outcome = 'stopped'
      live.child.kill('SIGTERM')
    }
    workersCache = workersCache.filter((w) => w.id !== id)
    await persistWorkers()
    await deleteWorkerRuns(id)
    emitChanged()
    return workersCache
  })

  ipcMain.handle('scheduler:runNow', async (_e, id: string): Promise<void> => {
    await ready
    if (liveTicks.has(id)) return
    const worker = workersCache.find((w) => w.id === id)
    if (worker) void startTick(worker)
  })

  ipcMain.handle('scheduler:stop', async (_e, id: string): Promise<void> => {
    await ready
    const live = liveTicks.get(id)
    if (!live) return
    live.outcome = 'stopped'
    live.child.kill('SIGTERM')
  })

  ipcMain.handle('scheduler:runs', async (_e, id: string): Promise<Run[]> => {
    await ready
    return loadRuns(id)
  })

  tickerHandle = setInterval(() => {
    void tick()
  }, TICK_INTERVAL_MS)
}

/** Test/quit hook — never called by production code paths otherwise. */
export function stopSchedulerTicker(): void {
  noticeEpoch++
  if (tickerHandle) clearInterval(tickerHandle)
  tickerHandle = null
}
