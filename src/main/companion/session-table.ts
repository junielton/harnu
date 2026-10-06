/**
 * The binding table of the companion host (T389 P1W1 §7.5). Pure: the clock and the id
 * generators are injected, nothing here touches I/O.
 *
 * It owns the spawn-token ledger (one entry per `mint`), the bindings (spawn token → `conn` →
 * `sid` → Harnu session key), `conn` rotation and the lease clock. The spawn token and `conn`
 * are CORRELATION, never authentication (contract §3): nothing in here grants a capability
 * because a request carried them, and no view that leaves this module contains either one
 * (SEC-8).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  LEASE_TTL_MS,
  SPAWN_REDEEM_WINDOW_MS,
  STAMP_NONCE_RING,
  type Conn,
  type FeatureId,
  type HelloProfile,
  type HelloRequest,
  type Sid,
  type SpawnToken
} from './contract'
import { createRateBucket, negotiate, type RateBucket, type SeqState } from './wire-core'

export type SpawnOwner =
  { kind: 'pty'; ptyId: string } | { kind: 'tick'; workerId: string; runId: string } // scheduler tick, no PTY (P1W2)

export type TrustClass = 'operator' | 'agent' | 'read-only' | 'tick'

export interface SpawnMeta {
  owner: SpawnOwner
  trust: TrustClass
  cwd: string
}

export interface Binding {
  readonly key: number // table-local ordinal; never on the wire
  readonly owner: SpawnOwner | null // null only for an external binding (P4W3)
  readonly trust: TrustClass
  conn: Conn
  prevConn: Conn | null // accepted for recovery only while `connUsed` is false
  connUsed: boolean
  sid: Sid
  proto: number
  profile: HelloProfile // 'external' is set by P4W3 only
  cliVersion: string
  modVersion: string
  surface: string | null
  cwd: string
  declared: FeatureId[]
  enabled: FeatureId[]
  proven: FeatureId[]
  seq: SeqState
  parked: number // poll/ask requests currently held; always 0 in P1W1
  lastRequestAt: number
  helloAfterSpawnMs: number // monotonic ms from minting the spawn token to its first redemption
  leaseLostAt: number | null // set once, by the sweep; never cleared (ARB-4c is P1W4's rule)
  state: 'bound' | 'ended' | 'closed'
  revoked: boolean // set by revoke(); cleared by the resume hello that follows
  rate: RateBucket
  counters: {
    requests: number
    events: number
    duplicates: number
    gaps: number
    dropped: number
    unknown: number
    refused: number
  }
}

/** Token-free: no `conn`, no spawn token. What every other wave and the bus receive. */
export interface BindingView {
  key: number
  owner: SpawnOwner | null
  trust: TrustClass
  sid: Sid
  sessionKey: string | null
  cwd: string
  profile: HelloProfile
  cliVersion: string
  modVersion: string
  declared: FeatureId[]
  enabled: FeatureId[]
  proven: FeatureId[]
  lease: 'live' | 'lost'
  state: 'bound' | 'ended' | 'closed'
  /** P1W3: how long after the spawn the first hello landed (parity evidence; gate p95 < 2 000). */
  helloAfterSpawnMs: number
  corroborated?: boolean // P4W3
}

/** No token (SEC-8). */
export interface SpawnRecordView {
  cwd: string
  trust: TrustClass
  state: 'minted' | 'redeemed' | 'spent' | 'released'
  releasedReason?: string
}

/** A policy supplied by another wave never sees `conn`. */
export type EnablePolicy = (b: Readonly<BindingView>) => FeatureId[]

export type ReleaseReason = 'pty-exit' | 'spawn-aborted' | 'tick-done'

export type HelloOutcome =
  | { ok: true; binding: Binding; kind: 'spawn' | 'resume' }
  | { ok: false; code: 'UNAUTHORIZED' | 'UNKNOWN_SESSION' }

export interface SessionTableDeps {
  now(): number // monotonic
  mintConn(): Conn
  mintToken(): SpawnToken
  /** Resolves a PTY owner to Harnu's row key; the table stores the owner, not the key. */
  sessionKeyOf?: (owner: SpawnOwner) => string | null
}

interface LedgerEntry {
  token: SpawnToken
  meta: SpawnMeta
  state: SpawnRecordView['state']
  mintedAt: number
  binding: Binding | null
  releasedReason?: string
}

/** Closed and ended bindings kept for diagnostics, and released ledger entries kept for records. */
const KEEP_DEAD_BINDINGS = 128
const KEEP_RELEASED_ENTRIES = 512

const ownerKey = (o: SpawnOwner): string =>
  o.kind === 'pty' ? `pty:${o.ptyId}` : `tick:${o.workerId}:${o.runId}`

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export class SessionTable {
  private readonly bindings = new Map<number, Binding>()
  private readonly conns = new Map<Conn, Binding>() // the current conn of each binding
  private readonly prevConns = new Map<Conn, Binding>()
  private readonly tokens = new Map<string, LedgerEntry>()
  private readonly owners = new Map<string, LedgerEntry>()
  private readonly nonces = new Map<number, string[]>()
  private nextKey = 1

  constructor(private readonly deps: SessionTableDeps) {}

  mint(meta: SpawnMeta): SpawnToken {
    const key = ownerKey(meta.owner)
    const old = this.owners.get(key)
    // A second mint for one owner supersedes an unredeemed first one.
    if (old && !old.binding) this.tokens.delete(old.token)
    const token = this.deps.mintToken()
    const entry: LedgerEntry = {
      token,
      meta: { owner: { ...meta.owner }, trust: meta.trust, cwd: meta.cwd },
      state: 'minted',
      mintedAt: this.deps.now(),
      binding: null
    }
    this.tokens.set(token, entry)
    this.owners.set(key, entry)
    return token
  }

  release(owner: SpawnOwner, reason: ReleaseReason): Binding | null {
    const entry = this.owners.get(ownerKey(owner))
    if (!entry || entry.state === 'released') return null
    entry.state = 'released'
    entry.releasedReason = reason
    this.tokens.delete(entry.token)
    this.pruneReleased()
    const b = entry.binding
    if (!b || b.state === 'closed') return null
    b.state = 'closed'
    b.leaseLostAt ??= this.deps.now()
    this.pruneDead()
    return b
  }

  hello(req: HelloRequest, enable: EnablePolicy): HelloOutcome {
    if (req.spawn !== undefined) return this.helloSpawn(req, enable)
    if (req.resume !== undefined) return this.helloResume(req, enable)
    return { ok: false, code: 'UNAUTHORIZED' }
  }

  /** Who a spawn token was minted for (a refused hello names its owner, never the token). */
  ownerOfSpawn(token: string): SpawnOwner | null {
    return this.tokens.get(token)?.meta.owner ?? null
  }

  resolve(conn: Conn): Binding | 'STALE_CONN' {
    const b = this.conns.get(conn)
    if (!b || b.state !== 'bound' || b.revoked) return 'STALE_CONN'
    return b
  }

  touch(b: Binding): void {
    b.lastRequestAt = this.deps.now()
    b.connUsed = true
    b.counters.requests++
    if (b.owner) {
      const entry = this.owners.get(ownerKey(b.owner))
      if (entry && entry.state === 'redeemed') entry.state = 'spent'
    }
  }

  /** From `bye`. The lease reads `lost` at once; there is no 20 s wait. */
  end(b: Binding, _reason: string): void {
    if (b.state !== 'bound') return
    b.state = 'ended'
    b.leaseLostAt ??= this.deps.now()
    this.pruneDead()
  }

  /** Only caller: the `session.rebound` handler (P1W3). */
  rebind(b: Binding, sid: Sid): void {
    b.sid = sid
  }

  leaseOf(b: Binding): 'live' | 'lost' {
    if (b.state !== 'bound') return 'lost'
    if (b.parked > 0) return 'live'
    return this.deps.now() - b.lastRequestAt < LEASE_TTL_MS ? 'live' : 'lost'
  }

  /**
   * Bindings whose lease just turned lost. Sets `leaseLostAt` once, so each loss is one edge. An
   * inert binding (`enabled` empty) is skipped: its silence is by design (contract §11.3).
   */
  sweep(): Binding[] {
    const lost: Binding[] = []
    for (const b of this.bindings.values()) {
      if (b.state !== 'bound' || b.leaseLostAt !== null || b.enabled.length === 0) continue
      if (this.leaseOf(b) === 'lost') {
        b.leaseLostAt = this.deps.now()
        lost.push(b)
      }
    }
    return lost
  }

  /**
   * After the machine resumes from sleep: every binding that has not already been swept as lost
   * gets `ms` to speak again before the loss counts. Never pulls `lastRequestAt` backwards.
   */
  grace(ms: number): void {
    const until = this.deps.now() + ms - LEASE_TTL_MS
    for (const b of this.bindings.values()) {
      if (b.state === 'bound' && b.leaseLostAt === null) {
        b.lastRequestAt = Math.max(b.lastRequestAt, until)
      }
    }
  }

  /** A parked request counts toward the lease until the returned function is called. */
  hold(view: Pick<BindingView, 'key'>): () => void {
    const b = this.bindings.get(view.key)
    if (!b) return () => undefined
    b.parked++
    let released = false
    return () => {
      if (released) return
      released = true
      b.parked = Math.max(0, b.parked - 1)
      b.lastRequestAt = Math.max(b.lastRequestAt, this.deps.now())
    }
  }

  spawnRecord(owner: SpawnOwner): SpawnRecordView | null {
    const e = this.owners.get(ownerKey(owner))
    if (!e) return null
    const rec: SpawnRecordView = { cwd: e.meta.cwd, trust: e.meta.trust, state: e.state }
    if (e.releasedReason !== undefined) rec.releasedReason = e.releasedReason
    return rec
  }

  /** Unredeemed spawn tokens that are still inside their redeem window. */
  pendingSpawns(): number {
    const now = this.deps.now()
    let n = 0
    for (const e of this.tokens.values()) {
      if (e.state === 'minted' && now - e.mintedAt <= SPAWN_REDEEM_WINDOW_MS) n++
    }
    return n
  }

  /** Contract §3 item 9. Callers: P1W4 (kill switch), P4W3. */
  revoke(view: Pick<BindingView, 'key'>): void {
    const b = this.bindings.get(view.key)
    if (!b) return
    b.revoked = true
    b.enabled = []
  }

  markProven(view: Pick<BindingView, 'key'>, feature: FeatureId): void {
    const b = this.bindings.get(view.key)
    if (b && !b.proven.includes(feature)) b.proven.push(feature)
  }

  revokeProof(view: Pick<BindingView, 'key'>, feature: FeatureId): void {
    const b = this.bindings.get(view.key)
    if (b) b.proven = b.proven.filter((f) => f !== feature)
  }

  /**
   * Resolves an MCP caller stamp (contract §24, consumed by P2W5). `conn` and the nonce ring never
   * leave the table; a nonce enters the ring only when the mac verifies.
   */
  verifyStamp(
    handle: string,
    nonce: string,
    tool: string,
    mac: string
  ): { binding: BindingView; verdict: 'verified' | 'bad-mac' | 'replayed' } | 'unknown-binding' {
    for (const b of this.bindings.values()) {
      if (b.state !== 'bound' || b.revoked) continue
      if (!safeEqualHex(sha256hex(`harnu-stamp-handle\n${b.conn}`).slice(0, 12), handle)) continue
      const expected = sha256hex(`harnu-stamp-v1\n${b.conn}\n${nonce}\n${tool}`).slice(0, 32)
      const view = this.viewOf(b)
      if (!safeEqualHex(expected, mac)) return { binding: view, verdict: 'bad-mac' }
      const ring = this.nonces.get(b.key) ?? []
      if (ring.includes(nonce)) return { binding: view, verdict: 'replayed' }
      ring.push(nonce)
      if (ring.length > STAMP_NONCE_RING) ring.shift()
      this.nonces.set(b.key, ring)
      return { binding: view, verdict: 'verified' }
    }
    return 'unknown-binding'
  }

  byKey(key: number): Binding | null {
    return this.bindings.get(key) ?? null
  }

  all(): Binding[] {
    return [...this.bindings.values()]
  }

  viewOf(b: Binding): BindingView {
    return {
      key: b.key,
      owner: b.owner ? { ...b.owner } : null,
      trust: b.trust,
      sid: b.sid,
      sessionKey: this.sessionKeyOf(b.owner),
      cwd: b.cwd,
      profile: b.profile,
      cliVersion: b.cliVersion,
      modVersion: b.modVersion,
      declared: [...b.declared],
      enabled: [...b.enabled],
      proven: [...b.proven],
      lease: this.leaseOf(b),
      state: b.state,
      helloAfterSpawnMs: b.helloAfterSpawnMs
    }
  }

  view(): BindingView[] {
    return this.all().map((b) => this.viewOf(b))
  }

  // ---- hello ------------------------------------------------------------------------------

  private helloSpawn(req: HelloRequest, enable: EnablePolicy): HelloOutcome {
    const entry = this.tokens.get(req.spawn as string)
    if (!entry) return { ok: false, code: 'UNAUTHORIZED' }
    if (entry.state === 'minted') {
      if (this.deps.now() - entry.mintedAt > SPAWN_REDEEM_WINDOW_MS) {
        return { ok: false, code: 'UNAUTHORIZED' }
      }
      const b = this.createBinding(entry, req)
      entry.binding = b
      entry.state = 'redeemed'
      this.refresh(b, req, enable)
      return { ok: true, binding: b, kind: 'spawn' }
    }
    if (entry.state === 'redeemed' && entry.binding && entry.binding.state === 'bound') {
      // Contract §3 item 3: the conn it issued was never used, so the response was lost.
      const b = entry.binding
      this.rotate(b)
      b.sid = req.sid
      this.refresh(b, req, enable)
      return { ok: true, binding: b, kind: 'spawn' }
    }
    return { ok: false, code: 'UNAUTHORIZED' }
  }

  private helloResume(req: HelloRequest, enable: EnablePolicy): HelloOutcome {
    const conn = (req.resume as { conn: Conn }).conn
    const current = this.conns.get(conn)
    const prev = this.prevConns.get(conn)
    const b = current ?? (prev && !prev.connUsed ? prev : undefined)
    if (!b || b.state !== 'bound') return { ok: false, code: 'UNKNOWN_SESSION' }
    this.rotate(b)
    this.refresh(b, req, enable)
    return { ok: true, binding: b, kind: 'resume' }
  }

  private createBinding(entry: LedgerEntry, req: HelloRequest): Binding {
    const now = this.deps.now()
    const b: Binding = {
      key: this.nextKey++,
      owner: entry.meta.owner,
      trust: entry.meta.trust,
      conn: this.deps.mintConn(),
      prevConn: null,
      connUsed: false,
      sid: req.sid,
      proto: 1,
      profile: 'interactive',
      cliVersion: '',
      modVersion: '',
      surface: null,
      cwd: req.cwd,
      declared: [],
      enabled: [],
      proven: [],
      seq: { last: 0 },
      parked: 0,
      lastRequestAt: now,
      helloAfterSpawnMs: Math.max(0, now - entry.mintedAt),
      leaseLostAt: null,
      state: 'bound',
      revoked: false,
      rate: createRateBucket(now),
      counters: {
        requests: 0,
        events: 0,
        duplicates: 0,
        gaps: 0,
        dropped: 0,
        unknown: 0,
        refused: 0
      }
    }
    this.bindings.set(b.key, b)
    this.conns.set(b.conn, b)
    return b
  }

  /** Each accepted hello after the first: prevConn ← conn, a new conn, seq back to 1. */
  private rotate(b: Binding): void {
    if (b.prevConn) this.prevConns.delete(b.prevConn)
    this.conns.delete(b.conn)
    b.prevConn = b.conn
    this.prevConns.set(b.conn, b)
    b.conn = this.deps.mintConn()
    this.conns.set(b.conn, b)
    b.connUsed = false
    b.seq = { last: 0 }
  }

  /** What every accepted hello re-reads from the request; trust and owner never change. */
  private refresh(b: Binding, req: HelloRequest, enable: EnablePolicy): void {
    b.proto = negotiate(req.protoMin, req.protoMax) ?? b.proto
    b.profile = req.isInteractive === false ? 'headless' : 'interactive'
    b.cliVersion = req.cli.version
    b.modVersion = req.mod.version
    b.surface = req.surface
    b.cwd = req.cwd
    b.declared = [...req.declared]
    b.lastRequestAt = Math.max(b.lastRequestAt, this.deps.now())
    b.revoked = false
    let chosen: FeatureId[] = []
    try {
      chosen = enable(this.viewOf(b))
    } catch {
      chosen = [] // a policy that throws enables nothing: legacy stays authoritative
    }
    b.enabled = chosen.filter((f) => b.declared.includes(f))
  }

  private sessionKeyOf(owner: SpawnOwner | null): string | null {
    if (!owner) return null
    if (owner.kind === 'tick') return `tick:${owner.workerId}:${owner.runId}`
    return this.deps.sessionKeyOf?.(owner) ?? null
  }

  private pruneDead(): void {
    const dead = [...this.bindings.values()].filter((b) => b.state !== 'bound')
    for (const b of dead.slice(0, Math.max(0, dead.length - KEEP_DEAD_BINDINGS))) {
      this.bindings.delete(b.key)
      this.conns.delete(b.conn)
      if (b.prevConn) this.prevConns.delete(b.prevConn)
      this.nonces.delete(b.key)
    }
  }

  private pruneReleased(): void {
    const released = [...this.owners.entries()].filter(([, e]) => e.state === 'released')
    for (const [k] of released.slice(0, Math.max(0, released.length - KEEP_RELEASED_ENTRIES))) {
      this.owners.delete(k)
    }
  }
}
