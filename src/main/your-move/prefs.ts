/**
 * Your move preferences: the one mode setting plus a per-folder off switch.
 *
 * Pure plus one small file: no electron import, so it runs in the plain `node` vitest env.
 * `ipc.ts` is the electron shell around it.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../mcp/atomic-write'
import type { YourMoveMode } from './core'

export type { YourMoveMode } from './core'

export interface YourMovePrefs {
  version: 1
  /** Unset until the operator chooses: then {@link DEFAULT_YOUR_MOVE_MODE} applies. */
  mode?: YourMoveMode
  /** Folders (and everything under them) the judge never reads. */
  disabledFolders: string[]
  firstRunNoticeSeen: boolean
  /** Whether mid-turn cards reach the queue. No UI: flipped by the maintainer after Observe. */
  midTurnLive: boolean
}

/** Off until the maintainer accepts a week of Observe cards (U5 moves the default to Live). */
export const DEFAULT_YOUR_MOVE_MODE: YourMoveMode = 'off'

const MODES: readonly YourMoveMode[] = ['off', 'observe', 'live']

export function effectiveMode(p: YourMovePrefs): YourMoveMode {
  return p.mode ?? DEFAULT_YOUR_MOVE_MODE
}

/** Leaving Off drops every cursor, so the days spent Off are never judged and never spend quota. */
export function needsCursorReset(prev: YourMoveMode, next: YourMoveMode): boolean {
  return prev === 'off' && next !== 'off'
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

export function isFolderDisabled(p: YourMovePrefs, folder: string): boolean {
  const target = trimSlash(folder)
  return p.disabledFolders.some((d) => {
    const root = trimSlash(d)
    return target === root || target.startsWith(root + '/')
  })
}

function defaults(): YourMovePrefs {
  return { version: 1, disabledFolders: [], firstRunNoticeSeen: false, midTurnLive: false }
}

/** Keep only well-typed fields: the file is user-writable and a patch comes over IPC. */
function sanitize(input: unknown, base: YourMovePrefs): YourMovePrefs {
  const out = { ...base }
  if (typeof input !== 'object' || input === null) return out
  const o = input as Record<string, unknown>
  if (typeof o.mode === 'string' && MODES.includes(o.mode as YourMoveMode)) {
    out.mode = o.mode as YourMoveMode
  }
  if (Array.isArray(o.disabledFolders)) {
    out.disabledFolders = o.disabledFolders.filter(
      (f): f is string => typeof f === 'string' && f.length > 0
    )
  }
  if (typeof o.firstRunNoticeSeen === 'boolean') out.firstRunNoticeSeen = o.firstRunNoticeSeen
  if (typeof o.midTurnLive === 'boolean') out.midTurnLive = o.midTurnLive
  return out
}

export async function readYourMovePrefs(filePath: string): Promise<YourMovePrefs> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return defaults()
    }
    return sanitize(parsed, defaults())
  } catch {
    return defaults()
  }
}

export async function writeYourMovePrefs(
  filePath: string,
  patch: Partial<YourMovePrefs>
): Promise<YourMovePrefs> {
  const next = sanitize(patch, await readYourMovePrefs(filePath))
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteFile(filePath, JSON.stringify(next, null, 2) + '\n', 0o600)
  return next
}
