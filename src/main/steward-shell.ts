/**
 * Campaign ch.5a (T597, spec §3.4 + §3.7) — the steward's lifecycle on disk and in the Scheduler.
 *
 * The pure halves are `steward-core.ts` (worker shape, allowlist, bearer) and `steward-hooks.ts`
 * (the settings transforms). This is the env-bound shell: it creates a mission's steward and
 * installs its three hooks in the owner folder's `.claude/settings.local.json`, and at close
 * removes the steward and — when no other stewarded mission still needs them — the hooks.
 *
 * It imports neither `mcp/tool-handlers` nor `mission-ipc`: both call INTO it, so everything it
 * needs about a mission is passed as arguments.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'
import { getStewardHookEndpoint } from './hook-bridge'
import { createStewardForMission, listStewards, retireStewardForMission } from './scheduler-shell'
import { mergeStewardHooks, removeStewardHooks } from './steward-hooks'

export type HooksOutcome = 'installed' | 'removed' | 'unchanged' | 'skipped'

export function settingsLocalPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json')
}

type Read =
  { kind: 'missing' } | { kind: 'ok'; value: unknown; mode: number } | { kind: 'unreadable' }

async function readSettings(file: string): Promise<Read> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { kind: 'unreadable' }
    const mode = (await fs.stat(file).catch(() => null))?.mode ?? 0o644
    return { kind: 'ok', value, mode: mode & 0o777 }
  } catch {
    return { kind: 'unreadable' }
  }
}

async function writeSettings(file: string, value: unknown, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', mode)
}

/**
 * Install (or refresh) the steward hooks in `folder`'s `.claude/settings.local.json`. A file that
 * is not valid JSON is the user's: left alone, outcome `skipped`. So is a run with no hook bridge
 * to point the hooks at — boot reconciliation installs them once it is up.
 */
export async function installStewardHooks(folder: string): Promise<HooksOutcome> {
  const endpoint = getStewardHookEndpoint()
  if (!endpoint) return 'skipped'
  const file = settingsLocalPath(folder)
  const read = await readSettings(file)
  if (read.kind === 'unreadable') return 'skipped'
  const next = mergeStewardHooks(read.kind === 'ok' ? read.value : undefined, endpoint)
  if (read.kind === 'ok' && JSON.stringify(next) === JSON.stringify(read.value)) return 'unchanged'
  await writeSettings(file, next, read.kind === 'ok' ? read.mode : 0o644)
  return 'installed'
}

/** Remove the steward hooks from `folder`'s settings file, and nothing else. */
export async function removeStewardHooksFrom(folder: string): Promise<HooksOutcome> {
  const file = settingsLocalPath(folder)
  const read = await readSettings(file)
  if (read.kind === 'unreadable') return 'skipped'
  if (read.kind === 'missing') return 'unchanged'
  const next = removeStewardHooks(read.value)
  if (JSON.stringify(next) === JSON.stringify(read.value)) return 'unchanged'
  await writeSettings(file, next, read.mode)
  return 'removed'
}

const same = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

/** What `mission_create` reports about the steward it set up. */
export interface StewardStart {
  created: boolean
  workerId?: string
  hooks?: HooksOutcome
  /** Why no steward exists (only when `created` is false and it was asked for). */
  error?: string
}

/**
 * Give a freshly created mission its steward and hooks. Never throws: a mission is already on disk
 * by now, and a steward that could not start (the Scheduler not loaded yet, say) is reported in
 * the ACK, not allowed to fail the mission.
 */
export async function startStewardForMission(input: {
  missionId: string
  ownerFolder: string
  title: string
}): Promise<StewardStart> {
  try {
    const worker = await createStewardForMission({
      missionId: input.missionId,
      folder: input.ownerFolder,
      title: input.title
    })
    let hooks: HooksOutcome
    try {
      hooks = await installStewardHooks(input.ownerFolder)
    } catch (err) {
      console.warn('[steward] could not install hooks:', err)
      hooks = 'skipped'
    }
    return { created: true, workerId: worker.id, hooks }
  } catch (err) {
    return { created: false, error: (err as Error).message.split(':')[0] }
  }
}

/**
 * The mission is closed: delete its steward, and take the hooks out of the owner folder unless
 * another stewarded mission there still needs them. Idempotent; never throws.
 */
export async function retireStewardForClosedMission(input: {
  missionId: string
  ownerFolder: string
}): Promise<void> {
  try {
    await retireStewardForMission(input.missionId)
    if (!listStewards().some((s) => same(s.folder, input.ownerFolder))) {
      await removeStewardHooksFrom(input.ownerFolder)
    }
  } catch (err) {
    console.warn('[steward] could not retire the steward of', input.missionId, err)
  }
}

/**
 * Boot reconciliation, once the hook bridge is up: every steward's hooks are re-pointed at the live
 * port/token (they change every boot), and a steward whose mission was closed while Harnu was away
 * (or from another clone) is retired. `missionStatus` is injected so this file stays free of the
 * mission store.
 */
export async function reconcileStewards(
  missionStatus: (folder: string, missionId: string) => Promise<'closed' | 'open' | 'unknown'>
): Promise<void> {
  for (const s of listStewards()) {
    try {
      if ((await missionStatus(s.folder, s.missionId)) === 'closed') {
        await retireStewardForClosedMission({ missionId: s.missionId, ownerFolder: s.folder })
        continue
      }
      await installStewardHooks(s.folder)
    } catch (err) {
      console.warn('[steward] reconcile failed for', s.missionId, err)
    }
  }
}
