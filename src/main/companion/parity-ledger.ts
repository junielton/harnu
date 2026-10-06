/**
 * The persisted parity ledger (T389 P1W4 §7.5): `<userData>/companion/parity/<stream>.ndjson`,
 * mode `0600`, rotated at 5 MiB, three generations, 14 days. Appends are buffered (64 records or
 * 2 s) and flushed on quit. Nothing is written while the stream's effective mode is `off`.
 *
 * Electron-free: the directory, the clock and the arbiter's answer are injected, so every rule is
 * tested against a temp directory. A write failure drops the records and counts them; arbitration
 * never depends on the ledger (SEC-1).
 */

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { FactSource, OwnReason } from './arbitration-core'
import type { CompanionMode } from './mode'
import {
  PARITY_GENERATIONS,
  PARITY_ROTATE_BYTES,
  buildParityRecord,
  expiredGenerations,
  parseParityLines,
  rotationNeeded,
  serializeParityRecord,
  type Disposition,
  type ParityRecord,
  type ParityStream
} from './parity-core'
import './parity-identity-rule' // registers the `identity` rule

export interface LedgerDeps {
  /** `<userData>/companion`. */
  dir: string
  now(): number
  /** The CLI version string, or `unknown`. */
  cli(): string
  /** The mod version the session's binding reported, if it has one. */
  modVersion(sid: string): string | null
  /** The arbiter's answer for this stream and session, and the stream's effective mode. */
  context(
    stream: ParityStream,
    sid: string,
    source: FactSource
  ): { owner: FactSource; reason: OwnReason; mode: CompanionMode }
  /** Tests only: a small rotation threshold. */
  rotateBytes?: number
}

export interface ParityLedger {
  recordFact(
    stream: ParityStream,
    source: FactSource,
    sid: string,
    k: string,
    d?: Record<string, string | number | boolean | null>,
    ctx?: { disposition?: Disposition; ts?: number }
  ): void
  /** Synchronous: called from `before-quit`. */
  flush(): void
  read(stream: ParityStream): ParityRecord[]
  stats(): { written: number; dropped: number }
  dispose(): void
}

const FLUSH_COUNT = 64
const FLUSH_MS = 2_000
const RETENTION_SWEEP_MS = 3_600_000

function derivedDisposition(source: FactSource, owner: FactSource): Disposition {
  if (source === 'companion') return owner === 'companion' ? 'applied' : 'record-only'
  return owner === 'companion' ? 'dropped' : 'applied'
}

export function createParityLedger(deps: LedgerDeps): ParityLedger {
  const parityDir = join(deps.dir, 'parity')
  const rotateBytes = deps.rotateBytes ?? PARITY_ROTATE_BYTES
  const buffer = new Map<ParityStream, string[]>()
  let buffered = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let salt: string | null = null
  let lastSweep = -Infinity
  const stats = { written: 0, dropped: 0 }
  let failureLogged = false

  function installSalt(): string {
    if (salt !== null) return salt
    const path = join(deps.dir, 'install-salt')
    try {
      salt = readFileSync(path, 'utf8').trim()
      if (salt.length >= 16) return salt
    } catch {
      // first use
    }
    salt = randomBytes(16).toString('hex')
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, salt, { mode: 0o600 })
    chmodSync(path, 0o600)
    return salt
  }

  const fileOf = (stream: ParityStream, gen = 0): string =>
    join(parityDir, gen === 0 ? `${stream}.ndjson` : `${stream}.${gen}.ndjson`)

  function rotate(stream: ParityStream): void {
    // keep the newest PARITY_GENERATIONS files in total: live, .1, .2
    rmSync(fileOf(stream, PARITY_GENERATIONS - 1), { force: true })
    for (let g = PARITY_GENERATIONS - 2; g >= 0; g--) {
      if (existsSync(fileOf(stream, g))) renameSync(fileOf(stream, g), fileOf(stream, g + 1))
    }
  }

  function sweepRetention(): void {
    const t = deps.now()
    if (t - lastSweep < RETENTION_SWEEP_MS) return
    lastSweep = t
    try {
      const files = readdirSync(parityDir).map((name) => ({
        name,
        mtimeMs: statSync(join(parityDir, name)).mtimeMs
      }))
      for (const name of expiredGenerations(files, t))
        rmSync(join(parityDir, name), { force: true })
    } catch {
      // nothing to sweep
    }
  }

  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (buffered === 0) return
    const pending = [...buffer]
    buffer.clear()
    buffered = 0
    for (const [stream, lines] of pending) {
      try {
        mkdirSync(parityDir, { recursive: true, mode: 0o700 })
        const text = lines.join('')
        const live = fileOf(stream)
        const size = existsSync(live) ? statSync(live).size : 0
        if (rotationNeeded(size, Buffer.byteLength(text), rotateBytes)) rotate(stream)
        const fresh = !existsSync(live)
        appendFileSync(live, text, { mode: 0o600 })
        if (fresh) chmodSync(live, 0o600) // the create mode is masked by the umask
        stats.written += lines.length
      } catch (err) {
        stats.dropped += lines.length
        if (!failureLogged) {
          failureLogged = true
          console.warn(
            `[companion] parity ledger unwritable (${(err as { code?: string }).code ?? 'error'}); records are dropped and counted`
          )
        }
      }
    }
    sweepRetention()
  }

  return {
    recordFact(stream, source, sid, k, d, ctx) {
      try {
        const c = deps.context(stream, sid, source)
        if (c.mode === 'off') return
        const rec = buildParityRecord({
          stream,
          source,
          owner: c.owner,
          reason: c.reason,
          disposition: ctx?.disposition ?? derivedDisposition(source, c.owner),
          sid,
          salt: installSalt(),
          t: deps.now(),
          ts: ctx?.ts,
          k,
          d,
          cli: deps.cli(),
          mod: deps.modVersion(sid)
        })
        const list = buffer.get(stream) ?? []
        list.push(serializeParityRecord(rec))
        buffer.set(stream, list)
        buffered++
        if (buffered >= FLUSH_COUNT) flush()
        else if (!timer) {
          timer = setTimeout(flush, FLUSH_MS)
          timer.unref?.()
        }
      } catch {
        stats.dropped++
      }
    },
    flush,
    read(stream) {
      flush()
      const out: ParityRecord[] = []
      for (let g = PARITY_GENERATIONS - 1; g >= 0; g--) {
        try {
          out.push(...parseParityLines(readFileSync(fileOf(stream, g), 'utf8')))
        } catch {
          // a missing generation
        }
      }
      return out
    },
    stats: () => ({ ...stats }),
    dispose() {
      flush()
    }
  }
}

// ---- The app's one ledger ------------------------------------------------------------------

let current: ParityLedger | null = null

/** Called once by `host.ts`. Until then `recordFact` is a no-op. */
export function configureParityLedger(deps: LedgerDeps): ParityLedger {
  current?.dispose()
  current = createParityLedger(deps)
  return current
}

export const parityLedger = (): ParityLedger | null => current

/** The only entry point (SEC-8): every record is scrubbed on the way in. */
export const recordFact: ParityLedger['recordFact'] = (stream, source, sid, k, d, ctx) =>
  current?.recordFact(stream, source, sid, k, d, ctx)

export const flushParityLedger = (): void => current?.flush()
