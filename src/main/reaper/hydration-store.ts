// Disk shell for Cleanup's hydration records (T250) — what Harnu dehydrated and
// what a rehydrate changed, per worktree. Pure shape + transitions live in
// `dehydrate-core.ts` (`normalizeHydrationFile`, `withDehydrated`, …); this is
// the thin read/write, same split as `prefs.ts` / `journal.ts`.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  emptyHydrationFile,
  normalizeHydrationFile,
  type HydrationRecordFile
} from './dehydrate-core'

export function hydrationPath(): string {
  return path.join(app.getPath('userData'), 'reaper-hydration.json')
}

export async function readHydrationFile(): Promise<HydrationRecordFile> {
  try {
    return normalizeHydrationFile(JSON.parse(await fs.readFile(hydrationPath(), 'utf8')))
  } catch {
    return emptyHydrationFile()
  }
}

async function writeHydrationFile(file: HydrationRecordFile): Promise<void> {
  const filePath = hydrationPath()
  const tmpPath = `${filePath}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmpPath, JSON.stringify(file, null, 2) + '\n', 'utf8')
  await fs.rename(tmpPath, filePath)
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Read-modify-write, serialized: a scan's reconciliation and an operation's
 * record can land close together, and two interleaved read/writes would drop
 * one of them. Rejects when the write fails — a lost record is a reported
 * failure, never a silent one (it decides whether the row says "dehydrated").
 */
export function updateHydrationFile(
  fn: (file: HydrationRecordFile) => HydrationRecordFile
): Promise<HydrationRecordFile> {
  const run = queue.then(async () => {
    const next = fn(await readHydrationFile())
    await writeHydrationFile(next)
    return next
  })
  queue = run.catch(() => undefined)
  return run
}
