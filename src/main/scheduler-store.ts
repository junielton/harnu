/**
 * T294 (T291 U4) — persistence for scheduler workers.
 *
 * Two shapes, two files, for one reason: definitions are small and rewritten
 * rarely (`schedulers.json`), while runs are appended every few minutes
 * forever (`scheduler-runs/<workerId>.jsonl`). Rewriting a growing blob on
 * every tick would be the wrong I/O shape at 288 writes a day, and deleting a
 * worker is deleting one file.
 *
 * Pure/thin-shell split per ADR-0001, mirroring `terminal-ledger.ts`: the
 * parse/serialize half is unit-tested, the fs half uses the same
 * `atomicWriteFile` helper so a crash mid-write cannot corrupt a definition.
 *
 * Every parser degrades rather than throws. A corrupt run line loses that
 * line, not the history; an unreadable definitions file yields an empty
 * list, and the operator sees an empty Scheduler rather than a boot failure.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'
import { resolveNotifyOn, type Run, type Worker } from './scheduler-core'

/** Runs kept per worker. ~17 hours of a 5-minute worker. */
export const RUN_RETENTION = 200

interface WorkersFile {
  version: 1
  workers: Worker[]
}

export function serializeWorkers(workers: readonly Worker[]): string {
  const doc: WorkersFile = { version: 1, workers: [...workers] }
  return JSON.stringify(doc, null, 2)
}

/**
 * Bring one persisted worker up to the CURRENT shape.
 *
 * A definitions file is written by whatever version of Harnu last ran, and the
 * fields on `Worker` are not the fields that were there when it was written.
 * Two directions, both handled here so the rest of the process never sees a
 * stale shape:
 *
 * - **Fields that were removed.** `keepTranscript` (BUG-115) and `provider`
 *   (BUG-114) were both persisted and both did nothing — one selected an output
 *   format nothing consumed, the other was never read on the spawn path at all.
 *   They are dropped on read, so they also stop being written back out the next
 *   time the file is saved: an old file loads, and heals.
 * - **Fields that were added.** `notifyOn` (T304) resolves to `silent`, so a
 *   worker written before it behaves exactly as it did — additive by default,
 *   never a surprise notification the operator did not ask for.
 *
 * Deliberately a WHITELIST rather than a `delete` of the two known names: the
 * next removed field would otherwise ride along in the file forever.
 */
function normalizeWorker(w: Worker): Worker {
  return {
    id: w.id,
    name: typeof w.name === 'string' ? w.name : '',
    enabled: w.enabled === true,
    prompt: typeof w.prompt === 'string' ? w.prompt : '',
    folder: w.folder,
    everyMinutes: typeof w.everyMinutes === 'number' ? w.everyMinutes : 30,
    runOnBoot: w.runOnBoot === true,
    model: typeof w.model === 'string' ? w.model : 'haiku',
    effort: w.effort ?? 'low',
    mode: w.mode === 'act' ? 'act' : 'observe',
    timeoutSeconds: typeof w.timeoutSeconds === 'number' ? w.timeoutSeconds : 300,
    carryLastResult: w.carryLastResult === true,
    notifyOn: resolveNotifyOn(w),
    // BUG-166: only the literal `true` is an opt-in; a worker saved before the field existed,
    // or a hand-edited non-boolean, resolves to off and heals on the next write.
    allowNetwork: w.allowNetwork === true,
    ...(Array.isArray(w.extraReadCommands) ? { extraReadCommands: w.extraReadCommands } : {}),
    ...(typeof w.systemPrompt === 'string' ? { systemPrompt: w.systemPrompt } : {}),
    failureStreak: typeof w.failureStreak === 'number' ? w.failureStreak : 0
  }
}

/** One worker the BUG-166 migration just took the network away from. */
export interface NetworkLossNotice {
  id: string
  name: string
  folder: string
}

/** A prompt that names a URL or the tool itself: the signs a worker was using the network. */
const NETWORK_HINT = /https?:\/\/|webfetch/i

/**
 * BUG-166: the observe workers a save file written BEFORE `allowNetwork` existed will silently lose
 * `WebFetch` for: observe mode, no `allowNetwork` key yet, and a prompt or system prompt that names
 * a URL or `WebFetch`. Read off the RAW file, since {@link parseWorkers} resolves the missing key
 * to `false` and so cannot tell "never set" from "turned off". One-time by construction: the boot
 * migration writes the key back, so the next load finds it and lists nothing.
 */
export function workersLosingNetwork(text: string): NetworkLossNotice[] {
  try {
    const doc = JSON.parse(text) as { workers?: unknown }
    if (!Array.isArray(doc.workers)) return []
    return doc.workers
      .filter(
        (w): w is Worker =>
          !!w &&
          typeof w === 'object' &&
          typeof (w as Worker).id === 'string' &&
          typeof (w as Worker).folder === 'string' &&
          (w as Worker).folder.length > 0 &&
          (w as Worker).mode !== 'act' &&
          !('allowNetwork' in (w as object))
      )
      .filter((w) => NETWORK_HINT.test(w.prompt ?? '') || NETWORK_HINT.test(w.systemPrompt ?? ''))
      .map((w) => ({ id: w.id, name: typeof w.name === 'string' ? w.name : '', folder: w.folder }))
  } catch {
    return []
  }
}

/** A worker with no folder could never run — drop it rather than surface it. */
export function parseWorkers(text: string): Worker[] {
  try {
    const doc = JSON.parse(text) as Partial<WorkersFile>
    if (!Array.isArray(doc.workers)) return []
    return doc.workers
      .filter(
        (w): w is Worker =>
          !!w && typeof w.id === 'string' && typeof w.folder === 'string' && w.folder.length > 0
      )
      .map(normalizeWorker)
  } catch {
    return []
  }
}

export function appendRunLine(run: Run): string {
  return JSON.stringify(run) + '\n'
}

export function parseRuns(text: string): Run[] {
  const out: Run[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Run)
    } catch {
      // A corrupt line loses itself, never the rest of the history.
    }
  }
  return out
}

export function trimRuns(runs: readonly Run[], max: number): Run[] {
  return runs.length <= max ? [...runs] : runs.slice(runs.length - max)
}

// ── fs shell (env-bound ⇒ e2e-only per ADR-0001) ─────────────────────────────

function workersPath(): string {
  return join(app.getPath('userData'), 'schedulers.json')
}

function runsDir(): string {
  return join(app.getPath('userData'), 'scheduler-runs')
}

function runsPath(workerId: string): string {
  return join(runsDir(), `${workerId}.jsonl`)
}

export async function loadWorkers(): Promise<Worker[]> {
  return (await loadWorkersForBoot()).workers
}

/**
 * Boot-time load (BUG-166): the workers, plus whether the file predates `allowNetwork` and which
 * observe workers that cost `WebFetch`. `needsHeal` is true when any worker lacks the key, so the
 * caller writes the migrated file back and the notice fires exactly once.
 */
export async function loadWorkersForBoot(): Promise<{
  workers: Worker[]
  lostNetwork: NetworkLossNotice[]
  needsHeal: boolean
}> {
  try {
    const text = await fs.readFile(workersPath(), 'utf8')
    const workers = parseWorkers(text)
    const doc = JSON.parse(text) as { workers?: unknown[] }
    const needsHeal = (doc.workers ?? []).some(
      (w) => !!w && typeof w === 'object' && !('allowNetwork' in (w as object))
    )
    return { workers, lostNetwork: workersLosingNetwork(text), needsHeal }
  } catch {
    return { workers: [], lostNetwork: [], needsHeal: false }
  }
}

export async function saveWorkers(workers: readonly Worker[]): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await atomicWriteFile(workersPath(), serializeWorkers(workers), 0o600)
}

export async function loadRuns(workerId: string): Promise<Run[]> {
  try {
    return parseRuns(await fs.readFile(runsPath(workerId), 'utf8'))
  } catch {
    return []
  }
}

export async function appendRun(run: Run): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true })
  await fs.appendFile(runsPath(run.workerId), appendRunLine(run), 'utf8')
  const all = await loadRuns(run.workerId)
  if (all.length > RUN_RETENTION) {
    await atomicWriteFile(
      runsPath(run.workerId),
      trimRuns(all, RUN_RETENTION).map(appendRunLine).join(''),
      0o600
    )
  }
}

export async function deleteWorkerRuns(workerId: string): Promise<void> {
  await fs.rm(runsPath(workerId), { force: true })
}
