// The worktrees Harnu shelved, remembered durably (autonomous cleanup U2.2, design C3 and D-B).
//
// A shelved worktree is NOT a removed one: its folder is gone on purpose, but its branch, its
// archive and its sessions are all still meant to be there. Everything that decides "is this
// folder gone for good?" (orphan transcripts, ghosts, the sidebar's removal ledger) reads this
// store first. The data side only: the sidebar section that shows them is U2.3.
//
// Pure helpers over a plain file shape, plus a thin atomic read/write shell like gc-prefs.ts.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { isInside } from '../containers/containers-core'
import { canonicalPathKey } from './bundle-core'

export const SHELVED_FILE = 'gc-shelved.json'

export interface ShelvedEntry {
  /** The cleanup bundle id (`<repo>::<kind>::<branch or path>`). */
  id: string
  repoPath: string
  worktreePath: string
  /** Null for a detached worktree. */
  branch: string | null
  /** The commit the worktree was on. */
  headSha: string
  /** `refs/archive/…`: where the shelve record lives. */
  namespace: string
  shelvedAt: number
  /** Whole days idle when it was shelved. */
  idleDays: number
  /** One sentence, English, for the journal: "Shelved `feat/x` — idle 9 d, branch kept". */
  reason: string
  /** Bytes the folder occupied (what shelving gave back), when it was measured. */
  freedBytes: number | null
}

export interface ShelvedFile {
  version: 1
  entries: ShelvedEntry[]
}

export const NO_SHELVED: ShelvedFile = { version: 1, entries: [] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function entryOf(raw: unknown): ShelvedEntry | null {
  if (!isRecord(raw)) return null
  if (
    !str(raw.id) ||
    !str(raw.repoPath) ||
    !str(raw.worktreePath) ||
    !(str(raw.branch) || raw.branch === null) ||
    !str(raw.headSha) ||
    !str(raw.namespace) ||
    !num(raw.shelvedAt) ||
    !num(raw.idleDays) ||
    typeof raw.reason !== 'string' ||
    !(num(raw.freedBytes) || raw.freedBytes === null)
  ) {
    return null
  }
  return {
    id: raw.id,
    repoPath: raw.repoPath,
    worktreePath: raw.worktreePath,
    branch: raw.branch,
    headSha: raw.headSha,
    namespace: raw.namespace,
    shelvedAt: raw.shelvedAt,
    idleDays: raw.idleDays,
    reason: raw.reason,
    freedBytes: raw.freedBytes
  }
}

/** Tolerates anything: junk entries are dropped, an unknown version reads as empty. */
export function normalizeShelved(raw: unknown): ShelvedFile {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return NO_SHELVED
  const entries: ShelvedEntry[] = []
  for (const e of raw.entries) {
    const entry = entryOf(e)
    if (entry) entries.push(entry)
  }
  return { version: 1, entries }
}

export function withShelved(file: ShelvedFile, entry: ShelvedEntry): ShelvedFile {
  return { version: 1, entries: [...file.entries.filter((e) => e.id !== entry.id), entry] }
}

export function withoutShelved(file: ShelvedFile, ids: readonly string[]): ShelvedFile {
  const gone = new Set(ids)
  return { version: 1, entries: file.entries.filter((e) => !gone.has(e.id)) }
}

export function shelvedFolders(file: ShelvedFile): string[] {
  return file.entries.map((e) => e.worktreePath)
}

/** True when `folder` is a shelved worktree or lies inside one (a session started in `WT/api`). */
export function isShelvedFolder(
  file: ShelvedFile,
  folder: string,
  platform: string = process.platform
): boolean {
  const key = canonicalPathKey(folder, platform)
  return file.entries.some((e) => isInside(key, canonicalPathKey(e.worktreePath, platform)))
}

// ---- the file ---------------------------------------------------------------------------------

/** Missing or corrupt reads as empty: the store must never be the reason a gather fails. */
export async function readShelved(file: string): Promise<ShelvedFile> {
  try {
    return normalizeShelved(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return NO_SHELVED
  }
}

/**
 * The read a write is built on. Only an absent file is empty (a first run); a file that is there
 * but cannot be read, parsed or understood (a newer version) throws, so a write never replaces the
 * record of the other shelved worktrees with a single entry.
 */
export async function readShelvedForUpdate(file: string): Promise<ShelvedFile> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NO_SHELVED
    throw err
  }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`${path.basename(file)} is not a version 1 shelved store`)
  }
  return normalizeShelved(parsed)
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
export async function writeShelved(file: string, data: ShelvedFile): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(normalizeShelved(data), null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}
