// U3.7: the stale-volume ledger. Every warning that was raised is remembered in userData, so a rescan
// or a restart never repeats it (the new-zombie alert's pattern, containers-ipc).

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export const STALE_LEDGER_FILE = 'containers-stale-volumes-notified.json'
/** The most keys kept; past it the oldest are dropped (a warning that old is not worth repeating). */
export const STALE_LEDGER_MAX = 500

export function staleLedgerFile(userDataDir: string): string {
  return path.join(userDataDir, STALE_LEDGER_FILE)
}

export async function readStaleLedger(file: string): Promise<Set<string>> {
  try {
    const keys = (JSON.parse(await fs.readFile(file, 'utf8')) as { keys?: unknown }).keys
    return new Set(
      Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
    )
  } catch {
    return new Set()
  }
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
export async function writeStaleLedger(file: string, keys: ReadonlySet<string>): Promise<void> {
  const kept = [...keys].slice(-STALE_LEDGER_MAX)
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify({ version: 1, keys: kept }) + '\n', 'utf8')
  await fs.rename(tmp, file)
}
