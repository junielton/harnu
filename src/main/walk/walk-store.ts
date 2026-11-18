/**
 * Guided walks: the store (spec S-1, AC-4, "Where walks live (D-8)").
 *
 * A walk is a directory in the repo's MAIN checkout, shared by every worktree and private to the
 * machine (`.harnu/` is gitignored); a folder that is not a git repository keeps its own:
 *
 * ```
 * <main checkout>/.harnu/walks/<walkId>/
 *   walk.json            the script, rev, the pointer to the live run, the summary of the last ended run
 *   runs/<runId>.json    one file per run: the machine's state, the outbox, the close-out text
 * ```
 *
 * Only main writes these files, each one atomically (a temp file renamed into place, so a reader
 * never sees half a file), and writes to one walk are serialised. A file that does not parse is
 * treated as absent ("starts clean"): the library skips a corrupt walk, a corrupt run reads as no
 * run, and a `live` pointer to an unreadable run does not leave the walk "in progress" forever.
 *
 * The run file is the truth about a run; `walk.json` carries two derived facts so listing stays
 * cheap: `live` (set when a run starts, cleared when it ends) and `lastRun` (rewritten when a run
 * ends). A `ready` run (the roadmap is shown, nobody pressed Start) is not live: the walk reads
 * "not walked yet" and the run is discarded when its pane closes.
 *
 * Electron-free. No verb and no pane use this yet (S-2 and later).
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataDirAt, mainCheckoutRoot, mkdirDataDir } from '../data-dir'
import { atomicWriteFile } from '../mcp/atomic-write'
import { rawRm } from '../raw-fs'
import { counts, newRun, type MachineError, type Run } from '../../shared/walk-machine'
import { toMachineChecks, type WalkScript } from '../../shared/walk-schema'
import type { WalkSource } from '../../shared/walk-source'

// ---- Records ---------------------------------------------------------------------------------

export const WALK_ID_RE = /^wlk-[0-9a-f]{8}$/
export const RUN_ID_RE = /^run-[0-9a-f]{8}$/

export interface LastRun {
  runId: string
  n: number
  /** When the run ended (ms since epoch). */
  at: number
  verified: number
  /** N: the checks that were to be walked. */
  total: number
}

export interface WalkRecord {
  v: 1
  walkId: string
  rev: number
  createdAt: number
  script: WalkScript
  /** The live run, or `null`. A `ready` run is not live. */
  live: { runId: string; n: number } | null
  lastRun: LastRun | null
}

export interface OutboxEntry {
  id: string
  /** `done`, `failed`, `explain`, `simpler`, `treat-as-failed`, `escalate` or `closed` (S-2 names them). */
  kind: string
  checkId: string | null
  /** The turn text, kept verbatim so it can be replayed after a restart. */
  text: string
  createdAt: number
  delivered: boolean
  deliveredAt?: number
}

export interface RunRecord {
  v: 1
  walkId: string
  runId: string
  run: Run
  /** The session that owns the run (the one that called `walk_open`), when known. */
  ownerSessionId: string | null
  outbox: OutboxEntry[]
  closeOut: string | null
}

export type WalkStatus = 'live' | 'walked' | 'not-walked'

export interface WalkLibraryEntry {
  walkId: string
  title: string
  source: WalkSource
  purpose: WalkScript['purpose']
  createdAt: number
  status: WalkStatus
  live: { runId: string; n: number } | null
  lastRun: LastRun | null
}

export type StoreError = MachineError & { runId?: string }
export type StoreResult<T = object> = ({ ok: true } & T) | { ok: false; error: StoreError }

export interface WalkStoreOptions {
  now?: () => number
  /** Test seam: a new `<prefix>-<8 hex>` id. */
  newId?: (prefix: 'wlk' | 'run' | 'out') => string
}

// ---- Paths -----------------------------------------------------------------------------------

/** `<main checkout>/.harnu/walks/`, or `<folder>/.harnu/walks/` outside a git repository. */
export function walksDir(folder: string): string {
  const root = mainCheckoutRoot(folder) ?? resolve(folder)
  return join(dataDirAt(root), 'walks')
}

const runsDir = (base: string, walkId: string): string => join(base, walkId, 'runs')

// ---- Reading ---------------------------------------------------------------------------------

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  } catch {
    return null // missing and corrupt read the same: absent
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function asWalk(x: unknown, walkId: string): WalkRecord | null {
  if (!isObj(x) || x.v !== 1 || x.walkId !== walkId || !isObj(x.script)) return null
  if (!Array.isArray(x.script.checks) || typeof x.rev !== 'number') return null
  return x as unknown as WalkRecord
}

function asRun(x: unknown, walkId: string, runId: string): RunRecord | null {
  if (!isObj(x) || x.v !== 1 || x.walkId !== walkId || x.runId !== runId) return null
  if (!isObj(x.run) || !Array.isArray(x.run.checks) || !Array.isArray(x.outbox)) return null
  return x as unknown as RunRecord
}

// ---- The store -------------------------------------------------------------------------------

export interface WalkStore {
  createWalk(
    script: WalkScript,
    opts?: { ownerSessionId?: string }
  ): Promise<{ walkId: string; runId: string; n: number }>
  listWalks(): Promise<WalkLibraryEntry[]>
  readWalk(walkId: string): Promise<WalkRecord | null>
  readRun(walkId: string, runId: string): Promise<RunRecord | null>
  /**
   * Apply one machine step to a run, atomically. A refused step writes nothing. The `live` pointer
   * is set when the run turns live and cleared (with `lastRun` rewritten) when it ends.
   */
  updateRun(
    walkId: string,
    runId: string,
    step: (run: Run) => { ok: true; run: Run } | { ok: false; error: MachineError }
  ): Promise<StoreResult<{ run: Run }>>
  /** A fresh `ready` run n + 1 of the walk. Refused `WALK_RUN_LIVE` while one is live. */
  newRun(walkId: string): Promise<StoreResult<{ runId: string; n: number }>>
  /** Discard a run that never started (its pane closed). The walk stays. */
  discardReadyRun(walkId: string, runId: string): Promise<StoreResult>
  /** Keep a turn for the session until it is delivered. */
  enqueue(
    walkId: string,
    runId: string,
    turn: { kind: string; text: string; checkId?: string | null }
  ): Promise<OutboxEntry | null>
  pendingOutbox(walkId: string, runId: string): Promise<OutboxEntry[]>
  markDelivered(walkId: string, runId: string, entryId: string): Promise<boolean>
}

/** The write queues, one per walk directory, shared by every store instance in the process. */
const chains = new Map<string, Promise<unknown>>()

export function createWalkStore(folder: string, opts: WalkStoreOptions = {}): WalkStore {
  const now = opts.now ?? Date.now
  const newId =
    opts.newId ?? ((prefix: string): string => `${prefix}-${randomBytes(4).toString('hex')}`)
  const base = (): string => walksDir(folder)

  // Writes to one walk run one at a time: a read-modify-write never interleaves with another. The
  // chain is keyed by the walk's directory and lives at module level, so two stores opened from
  // different worktrees of one repo (same main-checkout directory) still queue behind each other.
  function locked<T>(walkId: string, fn: () => Promise<T>): Promise<T> {
    const key = join(base(), walkId)
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    chains.set(key, tail)
    // drop the entry once the queue is idle, so the map does not grow with every walk ever touched
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return next
  }

  const walkFile = (walkId: string): string => join(base(), walkId, 'walk.json')
  const runFile = (walkId: string, runId: string): string =>
    join(runsDir(base(), walkId), `${runId}.json`)

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdirDataDir(join(file, '..'))
    await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', 0o600)
  }

  async function readWalk(walkId: string): Promise<WalkRecord | null> {
    if (!WALK_ID_RE.test(walkId)) return null
    return asWalk(await readJson(walkFile(walkId)), walkId)
  }

  async function readRun(walkId: string, runId: string): Promise<RunRecord | null> {
    if (!WALK_ID_RE.test(walkId) || !RUN_ID_RE.test(runId)) return null
    return asRun(await readJson(runFile(walkId, runId)), walkId, runId)
  }

  /** The ordinals of the runs a walk keeps (and its summary hints), for numbering a new one. */
  async function highestN(walk: WalkRecord): Promise<number> {
    let max = Math.max(walk.lastRun?.n ?? 0, walk.live?.n ?? 0)
    let names: string[] = []
    try {
      names = await fs.readdir(runsDir(base(), walk.walkId))
    } catch {
      /* no runs yet */
    }
    for (const name of names) {
      const m = /^(run-[0-9a-f]{8})\.json$/.exec(name)
      if (!m) continue
      const rec = await readRun(walk.walkId, m[1])
      if (rec) max = Math.max(max, rec.run.n)
    }
    return max
  }

  async function makeRun(
    walk: WalkRecord,
    n: number,
    ownerSessionId: string | null
  ): Promise<{ runId: string; n: number }> {
    const runId = newId('run')
    const rec: RunRecord = {
      v: 1,
      walkId: walk.walkId,
      runId,
      run: newRun(toMachineChecks(walk.script), { n }),
      ownerSessionId,
      outbox: [],
      closeOut: null
    }
    await writeJson(runFile(walk.walkId, runId), rec)
    return { runId, n }
  }

  return {
    readWalk,
    readRun,

    async createWalk(script, o = {}) {
      const walkId = newId('wlk')
      const walk: WalkRecord = {
        v: 1,
        walkId,
        rev: 1,
        createdAt: now(),
        script,
        live: null,
        lastRun: null
      }
      return locked(walkId, async () => {
        await writeJson(walkFile(walkId), walk)
        const { runId, n } = await makeRun(walk, 1, o.ownerSessionId ?? null)
        return { walkId, runId, n }
      })
    },

    async listWalks() {
      let names: string[] = []
      try {
        names = await fs.readdir(base())
      } catch {
        return []
      }
      const out: WalkLibraryEntry[] = []
      for (const name of names.sort()) {
        const walk = await readWalk(name)
        if (!walk) continue // a corrupt or foreign directory starts clean: not listed
        let live = walk.live
        if (live) {
          const rec = await readRun(walk.walkId, live.runId)
          if (!rec || rec.run.state !== 'live') live = null // an unreadable run is not "in progress"
        }
        out.push({
          walkId: walk.walkId,
          title: walk.script.title,
          source: walk.script.source,
          purpose: walk.script.purpose,
          createdAt: walk.createdAt,
          status: live ? 'live' : walk.lastRun ? 'walked' : 'not-walked',
          live,
          lastRun: walk.lastRun
        })
      }
      // newest run first: a live run, then the last ended one, then when the walk was written
      const recency = (e: WalkLibraryEntry): number => e.lastRun?.at ?? e.createdAt
      return out.sort((a, b) => {
        if (!!a.live !== !!b.live) return a.live ? -1 : 1
        return recency(b) - recency(a)
      })
    },

    updateRun(walkId, runId, step) {
      return locked(walkId, async (): Promise<StoreResult<{ run: Run }>> => {
        const walk = await readWalk(walkId)
        if (!walk) return { ok: false, error: { code: 'WALK_NOT_FOUND', message: 'No such walk.' } }
        const rec = await readRun(walkId, runId)
        if (!rec) return { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'No such run.' } }
        const res = step(rec.run)
        if (!res.ok) return { ok: false, error: res.error }
        const next = res.run

        let live = walk.live
        let lastRun = walk.lastRun
        if (next.state === 'live') {
          if (live && live.runId !== runId)
            return {
              ok: false,
              error: {
                code: 'WALK_RUN_LIVE',
                message: 'Another run of this walk is live.',
                runId: live.runId
              }
            }
          live = { runId, n: next.n }
        } else if (next.state === 'ended') {
          if (live?.runId === runId) live = null
          const c = counts(next)
          lastRun = {
            runId,
            n: next.n,
            at: next.endedAt ?? now(),
            verified: c.verified,
            total: c.total
          }
        }
        await writeJson(runFile(walkId, runId), { ...rec, run: next })
        const changed = live?.runId !== walk.live?.runId || lastRun !== walk.lastRun
        if (changed)
          await writeJson(walkFile(walkId), { ...walk, rev: walk.rev + 1, live, lastRun })
        return { ok: true, run: next }
      })
    },

    newRun(walkId) {
      return locked(walkId, async (): Promise<StoreResult<{ runId: string; n: number }>> => {
        const walk = await readWalk(walkId)
        if (!walk) return { ok: false, error: { code: 'WALK_NOT_FOUND', message: 'No such walk.' } }
        if (walk.live) {
          const rec = await readRun(walkId, walk.live.runId)
          if (rec && rec.run.state === 'live')
            return {
              ok: false,
              error: {
                code: 'WALK_RUN_LIVE',
                message: 'A run of this walk is live.',
                runId: walk.live.runId
              }
            }
        }
        const n = (await highestN(walk)) + 1
        const made = await makeRun(walk, n, null)
        return { ok: true, ...made }
      })
    },

    discardReadyRun(walkId, runId) {
      return locked(walkId, async (): Promise<StoreResult> => {
        const rec = await readRun(walkId, runId)
        if (!rec) return { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'No such run.' } }
        if (rec.run.state !== 'ready')
          return {
            ok: false,
            error: { code: 'RUN_NOT_READY', message: 'Only a run that never started is discarded.' }
          }
        await fs.rm(runFile(walkId, runId), { force: true })
        await rawRm(join(runsDir(base(), walkId), runId), { recursive: true, force: true })
        return { ok: true }
      })
    },

    enqueue(walkId, runId, turn) {
      return locked(walkId, async () => {
        const rec = await readRun(walkId, runId)
        if (!rec) return null
        const entry: OutboxEntry = {
          id: newId('out'),
          kind: turn.kind,
          checkId: turn.checkId ?? null,
          text: turn.text,
          createdAt: now(),
          delivered: false
        }
        await writeJson(runFile(walkId, runId), { ...rec, outbox: [...rec.outbox, entry] })
        return entry
      })
    },

    async pendingOutbox(walkId, runId) {
      return ((await readRun(walkId, runId))?.outbox ?? []).filter((o) => !o.delivered)
    },

    markDelivered(walkId, runId, entryId) {
      return locked(walkId, async () => {
        const rec = await readRun(walkId, runId)
        const hit = rec?.outbox.find((o) => o.id === entryId)
        if (!rec || !hit || hit.delivered) return false
        const outbox = rec.outbox.map((o) =>
          o.id === entryId ? { ...o, delivered: true, deliveredAt: now() } : o
        )
        await writeJson(runFile(walkId, runId), { ...rec, outbox })
        return true
      })
    }
  }
}
