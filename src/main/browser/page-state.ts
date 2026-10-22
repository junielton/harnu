/**
 * The `setData` sidecar of a live panel (T564 U2, spec §4.5): the page's own state, kept on disk so a reload and
 * a restart re-read it, and shared by every pane showing the same file.
 *
 * ```
 * <folder>/.harnu/out/browser/state/<sha256(relPath)[:16]>.json   { v: 1, path, rev, updatedAt, data }
 * ```
 *
 * `rev` is a monotonically increasing integer per page path. Writes are atomic (temp + rename), serialised per
 * path, and `data` is capped at 256 KiB serialised. Pure over an injected file-system seam (ADR-0001).
 */
import { createHash } from 'node:crypto'
import * as path from 'node:path'

export const SIDECAR_VERSION = 1
export const MAX_DATA_BYTES = 256 * 1024

export interface PageState {
  v: 1
  /** The folder-relative page path the state belongs to. */
  path: string
  rev: number
  updatedAt: number
  data: unknown
}

/** Where the sidecar of `relPath` lives. */
export function sidecarPath(folder: string, relPath: string): string {
  const key = createHash('sha256').update(relPath).digest('hex').slice(0, 16)
  return path.join(folder, '.harnu', 'out', 'browser', 'state', `${key}.json`)
}

export interface PageStateFs {
  readFile(file: string): Promise<string>
  readFileSync(file: string): string
  /** Write atomically (temp + rename), creating the directory. */
  writeAtomic(file: string, body: string): Promise<void>
}

export type SetDataResult =
  | { ok: true; state: PageState; bytes: number }
  | { ok: false; code: 'DATA_TOO_LARGE'; bytes: number }
  | { ok: false; code: 'REV_CONFLICT'; currentRev: number }

export interface SetDataOptions {
  /** Deep-merge plain objects into the current data instead of replacing it. */
  merge?: boolean
  /** Refuse unless the current rev is exactly this. */
  expectRev?: number
}

export interface PageStateStore {
  /** The current state (rev 0 and `data: null` when nothing was ever stored). */
  read(folder: string, relPath: string): Promise<PageState>
  /** Synchronous read for the page's `getData()` at document start. */
  readSync(folder: string, relPath: string): PageState
  set(folder: string, relPath: string, data: unknown, opts?: SetDataOptions): Promise<SetDataResult>
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge of plain objects; arrays and scalars replace. `null` is a value, not a delete. */
export function mergeData(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue
    out[k] = k in out ? mergeData(out[k], v) : v
  }
  return out
}

function empty(relPath: string): PageState {
  return { v: SIDECAR_VERSION, path: relPath, rev: 0, updatedAt: 0, data: null }
}

function parseState(raw: string, relPath: string): PageState {
  try {
    const v = JSON.parse(raw) as Partial<PageState>
    if (v && v.v === SIDECAR_VERSION && typeof v.rev === 'number' && Number.isInteger(v.rev)) {
      return {
        v: SIDECAR_VERSION,
        path: relPath,
        rev: v.rev,
        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
        data: v.data ?? null
      }
    }
  } catch {
    /* corrupt: start over at rev 0 */
  }
  return empty(relPath)
}

export function createPageStateStore(deps: { fs: PageStateFs; now(): number }): PageStateStore {
  /** Per sidecar path: the tail of the write chain, so two writes to one page never interleave. */
  const chains = new Map<string, Promise<unknown>>()

  async function read(folder: string, relPath: string): Promise<PageState> {
    try {
      return parseState(await deps.fs.readFile(sidecarPath(folder, relPath)), relPath)
    } catch {
      return empty(relPath)
    }
  }

  return {
    read,
    readSync(folder, relPath) {
      try {
        return parseState(deps.fs.readFileSync(sidecarPath(folder, relPath)), relPath)
      } catch {
        return empty(relPath)
      }
    },
    set(folder, relPath, data, opts = {}) {
      const file = sidecarPath(folder, relPath)
      const run = async (): Promise<SetDataResult> => {
        const current = await read(folder, relPath)
        if (opts.expectRev !== undefined && opts.expectRev !== current.rev) {
          return { ok: false, code: 'REV_CONFLICT', currentRev: current.rev }
        }
        const next = opts.merge === true ? mergeData(current.data, data) : data
        const json = JSON.stringify(next === undefined ? null : next)
        const bytes = Buffer.byteLength(json, 'utf8')
        if (bytes > MAX_DATA_BYTES) return { ok: false, code: 'DATA_TOO_LARGE', bytes }
        const state: PageState = {
          v: SIDECAR_VERSION,
          path: relPath,
          rev: current.rev + 1,
          updatedAt: deps.now(),
          data: next === undefined ? null : next
        }
        await deps.fs.writeAtomic(file, JSON.stringify(state))
        return { ok: true, state, bytes }
      }
      const prior = chains.get(file) ?? Promise.resolve()
      const result = prior.then(run, run)
      // The chain must survive a failed write: the next one still waits, and does not inherit the failure.
      const tail = result.catch(() => undefined)
      chains.set(file, tail)
      void tail.then(() => {
        if (chains.get(file) === tail) chains.delete(file)
      })
      return result
    }
  }
}
