// Harnu's own record of the folders it removed (delta-2 item 1, proof (a)). A folder that is missing
// is not thereby gone (an unmounted drive is missing too), but one Harnu itself removed is known to
// be gone, however it was removed: this ledger is written at the one door every removal ends at
// (`detachFromSidebar`) and read when transcripts are judged. Small, bounded, best-effort: a damaged
// or unwritable file just means nothing is remembered (and so nothing is proven).

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export const MAX_REMOVED_FOLDERS = 2000
const FILE = 'removed-folders.json'

const file = (): string => path.join(app.getPath('userData'), FILE)

interface Ledger {
  version: 1
  /** Oldest first. */
  folders: string[]
}

export async function readRemovedFolders(): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Partial<Ledger>
    return Array.isArray(raw.folders)
      ? raw.folders.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : []
  } catch {
    return []
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** Records a removed folder (once, newest last). Serialized; never rejects. */
export function recordRemovedFolder(folder: string): Promise<void> {
  const run = queue.then(async () => {
    try {
      const next = (await readRemovedFolders()).filter((f) => f !== folder)
      next.push(folder)
      const body: Ledger = { version: 1, folders: next.slice(-MAX_REMOVED_FOLDERS) }
      const target = file()
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(`${target}.tmp`, JSON.stringify(body) + '\n', 'utf8')
      await fs.rename(`${target}.tmp`, target)
    } catch (err) {
      console.warn('[gc] could not record a removed folder', err)
    }
  })
  queue = run
  return run
}
