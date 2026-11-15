/**
 * Missions v4 S-27 — the steward is RETIRED. This was its lifecycle on disk and in the Scheduler
 * (campaign ch.5a); what is left is the way out:
 *
 *  - Nothing creates a steward and nothing installs its hooks any more.
 *  - At boot, once the Scheduler has loaded, every steward that an older Harnu left behind has its
 *    Scheduler worker deleted and its hooks taken out of the owner folder's
 *    `.claude/settings.local.json` (only ours: the user's own hooks stay), and ONE Activity notice
 *    lists the missions affected. It fires once per boot when stewards existed, never when none did.
 *  - It never reads or writes a mission file: the missions are named from the workers themselves.
 *
 * `steward-core.ts` and `steward-hooks.ts` stay until S-38 deletes the steward files. It imports
 * neither `mcp/tool-handlers` nor `mission-ipc`: both call INTO it.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'
import { listStewards, retireStewardForMission, whenSchedulerLoaded } from './scheduler-shell'
import { removeStewardHooks } from './steward-hooks'

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

export interface RetiredSteward {
  missionId: string
  folder: string
}

/**
 * Delete every steward's Scheduler worker, then take our hooks out of each owner folder that no
 * steward needs any more. Never throws; a steward that could not be retired is left for the next boot
 * and is not in the returned list.
 */
async function retireAllStewards(): Promise<RetiredSteward[]> {
  const found = listStewards()
  const retired: RetiredSteward[] = []
  for (const s of found) {
    try {
      await retireStewardForMission(s.missionId)
      retired.push({ missionId: s.missionId, folder: s.folder })
    } catch (err) {
      console.warn('[steward] could not retire the steward of', s.missionId, err)
    }
  }
  const remaining = listStewards()
  for (const folder of new Set(found.map((s) => path.resolve(s.folder)))) {
    if (remaining.some((s) => same(s.folder, folder))) continue
    try {
      await removeStewardHooksFrom(folder)
    } catch (err) {
      console.warn('[steward] could not remove the steward hooks from', folder, err)
    }
  }
  return retired
}

const NOTICE_RETRY_MS = 2_000
const NOTICE_MAX_TRIES = 30

export interface RetireNoticeDeps {
  /** The command bridge's dispatch: `notify.push` posts the Activity notice. */
  dispatch: (command: string, payload: unknown) => Promise<unknown>
  wait?: (ms: number) => Promise<void>
}

/** The one Activity notice: what vanished, and why nothing is lost. */
function retirementNotice(retired: RetiredSteward[]): {
  folderPath: string
  title: string
  description: string
  kind: 'info'
} {
  const list = retired.map((r) => `${r.missionId} (${path.basename(r.folder)})`).join(', ')
  return {
    folderPath: retired[0].folder,
    title: 'Mission stewards retired',
    description:
      `Missions no longer have a steward. Harnu removed its Scheduler worker and its hooks for ` +
      `${retired.length === 1 ? '1 mission' : `${retired.length} missions`}: ${list}. ` +
      `The session that leads each mission carries on; no mission file was changed.`,
    kind: 'info'
  }
}

/**
 * Boot: once the Scheduler has loaded (it boots on its own clock, so reading its list earlier would
 * find nothing), retire every steward and raise ONE Activity notice naming the missions affected.
 * The bridge refuses to dispatch until the renderer has announced itself, so the notice is retried for
 * a minute before it is dropped.
 */
export async function retireStewardsOnBoot(
  deps: RetireNoticeDeps
): Promise<{ retired: RetiredSteward[] }> {
  await whenSchedulerLoaded()
  const retired = await retireAllStewards()
  if (retired.length === 0) return { retired }
  const wait = deps.wait ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const notice = retirementNotice(retired)
  for (let attempt = 0; attempt < NOTICE_MAX_TRIES; attempt++) {
    try {
      await deps.dispatch('notify.push', notice)
      return { retired }
    } catch {
      await wait(NOTICE_RETRY_MS)
    }
  }
  console.warn('[steward] the retirement notice was not delivered:', notice.description)
  return { retired }
}

/**
 * Kept so `steward-bridge.ts` (S-38 deletes it) still compiles: it no longer re-points anything. The
 * boot path in `index.ts` calls {@link retireStewardsOnBoot}; a stray caller of this one retires too.
 */
export async function reconcileStewards(_missionStatus?: unknown): Promise<void> {
  await retireAllStewards()
}
