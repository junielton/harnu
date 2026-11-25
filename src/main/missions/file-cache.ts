/**
 * BUG-278 — a parse cache for mission files, validated by the file's own stamp.
 *
 * Every reader of mission files (the mission-state feed, the `mission:list` IPC, the hibernation
 * sweep) used to read and YAML-parse every file on every poll: 20% of the main thread in a 30 s
 * profile. A file's parsed form is now kept, keyed by path, and reused for as long as the file's
 * stamp (mtime in ns, size, inode) is unchanged. The stamp is one `stat`, never a read.
 *
 * Why it cannot serve a stale mission: every writer replaces a file by writing a temp file and
 * renaming it over (a new inode, a new mtime), and an in-place edit moves the mtime. The stamp is
 * taken BEFORE the read, so a write that lands during the read leaves the entry stamped older than the
 * file and the next call reads again. Writers also call {@link invalidateMissionFile}.
 *
 * The cached value is shared by reference: callers treat it as read-only.
 */
import { promises as fs, stat } from 'node:fs'
import * as path from 'node:path'

interface Stamp {
  mtimeNs: bigint
  size: bigint
  ino: bigint
}

interface Entry {
  file: string
  stamp: Stamp
  value: unknown
}

/**
 * `dir` → (`kind` + file path → entry). A file can be parsed into more than one shape (the v3 reader's,
 * the v4 reader's), so the kind is part of the key; the directory level lets a listing drop the files
 * that left it.
 */
const byDir = new Map<string, Map<string, Entry>>()

const keyOf = (kind: string, file: string): string => `${kind}\u0000${file}`

/** Freeze a parsed value and everything under it, so a caller that mutates it fails loudly. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const v of Object.values(value as object)) deepFreeze(v)
  return value
}

const sameStamp = (a: Stamp, b: Stamp): boolean =>
  a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino

// The callback form of `stat` is about twice as fast as `fs.promises.stat` over a few hundred files,
// and a poll stats every mission file.
function stampOf(file: string): Promise<Stamp> {
  return new Promise((resolve, reject) => {
    stat(file, { bigint: true }, (err, st) =>
      err ? reject(err) : resolve({ mtimeNs: st.mtimeNs, size: st.size, ino: st.ino })
    )
  })
}

/**
 * `parse(raw)` of `file`, from the cache when the file is unchanged since it was parsed. `kind` names
 * the shape `parse` produces (two kinds of one file are cached apart). `parse` must be pure and must
 * not throw for a bad file (return its error value: that is cached too, so a corrupt file is not
 * re-parsed on every poll). The value is deep-frozen and shared: never mutate it. Rejects when the
 * file cannot be stat'ed or read.
 */
export async function readParsedCached<T>(
  kind: string,
  file: string,
  parse: (raw: string) => T
): Promise<T> {
  const stamp = await stampOf(file)
  const dir = path.dirname(file)
  const key = keyOf(kind, file)
  const hit = byDir.get(dir)?.get(key)
  if (hit && sameStamp(hit.stamp, stamp)) return hit.value as T
  const value = deepFreeze(parse(await fs.readFile(file, 'utf8')))
  let files = byDir.get(dir)
  if (!files) byDir.set(dir, (files = new Map()))
  files.set(key, { file, stamp, value })
  return value
}

/** Forget every cached file of `dir` that is not in `names` (it was deleted or renamed away). */
export function pruneMissionDir(dir: string, names: ReadonlySet<string>): void {
  const files = byDir.get(dir)
  if (!files) return
  for (const [key, entry] of files) {
    if (!names.has(path.basename(entry.file))) files.delete(key)
  }
  if (files.size === 0) byDir.delete(dir)
}

const writeListeners = new Set<(file: string) => void>()

/** Counts the writes reported to {@link invalidateMissionFile}, so a shared read can tell it is older than one. */
let writeGeneration = 0

/**
 * One run per key at a time: a caller that arrives while a run is under way gets that run's result,
 * unless a mission file was written since it started (then it starts its own, so a read that begins
 * after a write never serves a result from before it).
 */
export function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const running = new Map<string, { generation: number; promise: Promise<T> }>()
  return (key, run) => {
    const hit = running.get(key)
    if (hit && hit.generation === writeGeneration) return hit.promise
    const entry = {
      generation: writeGeneration,
      promise: run().finally(() => {
        if (running.get(key) === entry) running.delete(key)
      })
    }
    running.set(key, entry)
    return entry.promise
  }
}

/**
 * Run `listener(file)` whenever a writer reports a mission file written ({@link invalidateMissionFile}),
 * so a reader that keeps its own snapshot (hibernation's) can refresh at once instead of at its next
 * poll. Returns the unsubscribe.
 */
export function onMissionFileWritten(listener: (file: string) => void): () => void {
  writeListeners.add(listener)
  return () => writeListeners.delete(listener)
}

/** Forget one file: a writer calls this right after it created or replaced the file. */
export function invalidateMissionFile(file: string): void {
  writeGeneration++
  const dir = path.dirname(file)
  const files = byDir.get(dir)
  if (files) {
    for (const [key, entry] of files) if (entry.file === file) files.delete(key)
    if (files.size === 0) byDir.delete(dir)
  }
  for (const listener of writeListeners) {
    try {
      listener(file)
    } catch {
      /* a listener never breaks a write */
    }
  }
}

/** Test seam: forget everything. */
export function clearMissionFileCache(): void {
  byDir.clear()
}
