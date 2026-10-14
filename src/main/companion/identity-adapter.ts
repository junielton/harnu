/**
 * The identity adapter (T389 P1W3 §7.6). It turns the host's facts about bindings into CLAIMS
 * for the renderer: "PTY row `key` is session `sid`". Electron-free: the renderer push, the mode
 * and the CLI gate are injected, so the rules here are unit-tested against the real host core.
 *
 * Rules that matter:
 *  - A binding is re-keyed ONLY by an explicit `session.rebound` (contract §15); an envelope
 *    `sid` that differs never moves it (the server answers `resync`).
 *  - A claim is satisfied (and removed) when the row's key equals its `sid`: the renderer
 *    migrated and `pty:rekey` moved the index.
 *  - A closed or ended binding has no claim and produces no push, so a late request from a dying
 *    process cannot re-animate a parked row (the companion-side twin of ARB-5).
 *  - Nothing here edits a row. The renderer decides, at `session:added`, whether to honour `act`.
 *
 * T455 W2 joins two facts to a claim (`claimFacts`), host-side only while the `row` family is in
 * shadow: the conversation's `transcriptPath`, from `session.snapshot.start` or
 * `session.rebound.transcriptPath` and kept only after `transcript-path.ts` accepted it, and its
 * `lineage`, from the PTY record (`spawnKind`, `spawnSource`) or the host's own rebound
 * bookkeeping, never from the mod. A lineage naming another session is handed to `onLineage`
 * (persisted in `lineage.json`). The renderer push and the diagnostics keep their P1W3 shape.
 */

import type { SessionStartFacts, Sid } from './contract'
import type { CompanionHostFacade } from './host-core'
import {
  classifyIdentity,
  mayAct,
  type IdentityCause,
  type IdentityClaim,
  type IdentityClaimFacts,
  type IdentityDiagnostics,
  type IdentityFact,
  type IdentityOutcome,
  type Lineage
} from './identity-core'
import {
  compareIdentity,
  createParitySink,
  type IdentityParityRecord,
  type IdentityShape,
  type LegacyVia,
  type ParitySink
} from './identity-parity-core'
import type { CompanionMode } from './mode'
import type { BindingView } from './session-table'
import { checkTranscriptPath, type PathFs, type TranscriptPathRefusal } from './transcript-path'
import type { CliGate } from './version-gate'
import { validateStartFacts } from './wire-core'

export interface IdentityAdapterDeps {
  host: Pick<
    CompanionHostFacade,
    'bus' | 'onBindingChange' | 'markProven' | 'rebind' | 'registerEventTypes'
  >
  getMode(): CompanionMode
  /** The CLI gate for this binding's binary (`hello.cli.version`). */
  gateOf(b: BindingView): CliGate
  /** Full-list push to the renderer. Called only when the list changed. */
  push(claims: IdentityClaim[]): void
  /** Monotonic ms; injected so the parity timings are testable. Default `performance.now()`. */
  now?(): number
  /** Epoch ms for a record's `at`. Default `Date.now()`. */
  epochNow?(): number
  /** What the PTY was spawned as (`claude-new`, `claude-fork`, `claude-resume`), if known. */
  spawnKind?(owner: NonNullable<BindingView['owner']>): string | null
  /** P1W4: every comparison also goes to the persisted parity ledger (the in-memory ring stays). */
  onParity?(rec: IdentityParityRecord): void
  /** T455: the session id a `claude-resume` / `claude-fork` PTY was spawned from (`PtyRec`). */
  spawnSource?(owner: NonNullable<BindingView['owner']>): string | null
  /** T455: `~/.claude/projects`; without it no transcript path is ever kept. */
  projectsRoot?(): string | null
  /** T455: tests only, to see every path the validation touches. */
  pathFs?: PathFs
  /** T455: a bound session's lineage names another session (persist it; ids only). */
  onLineage?(e: { sid: Sid; kind: Lineage['kind']; from: Sid }): void
}

/** What the host kept of a conversation's start (T455 §5.3): the path only once validated. */
export interface StartFacts {
  source: SessionStartFacts['source']
  transcriptPath: string | null
}

export type PathDrop = TranscriptPathRefusal | 'no-root' | 'malformed'

export interface IdentityAdapter {
  claims(): IdentityClaim[]
  /** T455: the claims with their transcript path and lineage (host-side only in W2). */
  claimFacts(): IdentityClaimFacts[]
  /** T455: the validated transcript of the binding's CURRENT conversation, or null. */
  transcriptPathOf(b: BindingView): string | null
  /** T455: the last `start` kept for the binding's current conversation, or null. */
  startOf(b: BindingView): StartFacts | null
  /** T455: where the binding's current conversation came from; null for a tick. */
  lineageOf(b: BindingView): Lineage | null
  /** T455: transcript paths dropped, by reason (counts only). */
  pathDrops(): Partial<Record<PathDrop, number>>
  /** The renderer's report after a migration: feeds the parity record (spec §7.7, §13). */
  recordOutcome(o: IdentityOutcome): void
  diagnostics(): IdentityDiagnostics
  dispose(): void
}

const CAUSES: ReadonlySet<string> = new Set(['clear', 'resume', 'unknown'])

export function createIdentityAdapter(deps: IdentityAdapterDeps): IdentityAdapter {
  const views = new Map<number, BindingView>()
  const causes = new Map<number, IdentityCause>()
  const claims = new Map<number, IdentityClaim>()
  const conflicted = new Map<number, Sid>() // binding → the sid already counted as a conflict
  const stats = { conflicts: 0, reboundGap: 0, rebounds: 0 }
  const now = deps.now ?? ((): number => performance.now())
  const epochNow = deps.epochNow ?? ((): number => Date.now())
  const ring = createParitySink(500)
  const sink: ParitySink = {
    ...ring,
    add(rec) {
      ring.add(rec)
      try {
        deps.onParity?.(rec)
      } catch {
        // the ledger is evidence, never a dependency of identity
      }
    }
  }
  let lastPushed = '[]'
  /** T455: per binding, the start of its current conversation (`sid` is the one it belongs to). */
  const starts = new Map<number, StartFacts & { sid: Sid }>()
  /** T455: per binding, the in-session rebound that started its current conversation. */
  const rebounds = new Map<number, { cause: IdentityCause; from: Sid; sid: Sid }>()
  const savedLineage = new Set<string>()
  const drops: Partial<Record<PathDrop, number>> = {}
  const drop = (why: PathDrop): void => void (drops[why] = (drops[why] ?? 0) + 1)

  /** Keeps `raw` as the conversation's transcript only if it passes the checks for `sid`. */
  function keepPath(raw: unknown, sid: Sid): string | null {
    const root = deps.projectsRoot?.() ?? null
    if (root === null) {
      drop('no-root')
      return null
    }
    const r = checkTranscriptPath(raw, sid, root, deps.pathFs)
    if (r.ok) return r.path
    drop(r.why)
    return null
  }

  /** Per binding, the lineage of its current conversation, frozen the first time it is read. */
  const lineages = new Map<number, { sid: Sid; lineage: Lineage | null }>()

  /**
   * Read from the PTY record at the first sight of a conversation and then frozen: a synth→real
   * migration later rewrites a `claude-fork` record's kind to `claude-resume` (`pty.ts`), which
   * must not turn a fork into a resume.
   */
  function lineageOf(b: BindingView): Lineage | null {
    const memo = lineages.get(b.key)
    if (memo && memo.sid === b.sid) return memo.lineage
    const lineage = deriveLineage(b)
    lineages.set(b.key, { sid: b.sid, lineage })
    return lineage
  }

  function deriveLineage(b: BindingView): Lineage | null {
    if (b.owner === null || b.owner.kind === 'tick') return null
    const rb = rebounds.get(b.key)
    if (rb && rb.sid === b.sid) {
      return { kind: rb.cause === 'clear' ? 'new' : 'resume', from: rb.from }
    }
    const kind = deps.spawnKind?.(b.owner) ?? null
    if (kind === 'claude-fork') return { kind: 'fork', from: deps.spawnSource?.(b.owner) ?? null }
    if (kind === 'claude-resume') {
      return { kind: 'resume', from: deps.spawnSource?.(b.owner) ?? null }
    }
    return { kind: 'new', from: null }
  }

  /** §6.3 step 2: the first time a bound conversation's lineage names ANOTHER session. */
  function noteLineage(b: BindingView): void {
    const l = lineageOf(b)
    if (!l || l.from === null || l.from === b.sid) return
    const id = `${b.sid}\u0000${l.kind}\u0000${l.from}`
    if (savedLineage.has(id)) return
    savedLineage.add(id)
    try {
      deps.onLineage?.({ sid: b.sid, kind: l.kind, from: l.from })
    } catch {
      // lineage is evidence for a later wave, never a dependency of identity
    }
  }

  function onSnapshot(b: BindingView, d: unknown): void {
    if (b.state !== 'bound' || typeof d !== 'object' || d === null) return
    const raw = (d as Record<string, unknown>).start
    if (raw === undefined) return // a reload's re-hello: keep the last start (§5.3)
    const facts = validateStartFacts(raw)
    if (!facts) {
      drop('malformed')
      return
    }
    const path = keepPath(facts.transcriptPath, b.sid)
    const prev = starts.get(b.key)
    // a bad path never clears a good one kept for the same conversation
    if (path === null && prev && prev.sid === b.sid && prev.transcriptPath !== null) return
    starts.set(b.key, { sid: b.sid, source: facts.source, transcriptPath: path })
  }

  /** A companion fact waiting for the legacy side (or the end of its binding). */
  interface Seen {
    binding: number
    shape: IdentityShape
    key: string
    sid: Sid
    helloAfterSpawnMs: number
    spawnAt: number // monotonic
  }
  const seen = new Set<Seen>()
  const shapeOf = (b: BindingView, cause: IdentityCause): IdentityShape => {
    if (b.owner?.kind === 'tick') return 'tick'
    if (cause === 'clear') return 'clear'
    if (cause === 'resume' || cause === 'unknown') return 'in-session-resume'
    if (b.trust === 'agent') return 'agent'
    const kind = b.owner ? deps.spawnKind?.(b.owner) : null
    if (kind === 'claude-fork') return 'fork'
    if (kind === 'claude-resume' || b.sessionKey === b.sid) return 'resume'
    return 'new'
  }

  /** Records what the companion saw for a claim, once per (binding, key, sid). */
  function noteSeen(b: BindingView, fact: Extract<IdentityFact, { kind: 'claim' }>): void {
    for (const s of seen)
      if (s.binding === b.key && s.key === fact.key && s.sid === fact.sid) return
    seen.add({
      binding: b.key,
      shape: shapeOf(b, fact.cause),
      key: fact.key,
      sid: fact.sid,
      helloAfterSpawnMs: fact.cause === 'spawn' ? Math.round(b.helloAfterSpawnMs) : 0,
      spawnAt: now() - (fact.cause === 'spawn' ? b.helloAfterSpawnMs : 0)
    })
  }

  const list = (): IdentityClaim[] => [...claims.values()].map((c) => ({ ...c }))

  function push(): void {
    const body = JSON.stringify(list())
    if (body === lastPushed) return
    lastPushed = body
    try {
      deps.push(list())
    } catch {
      // the renderer may be gone (window reload): it pulls the list again at store init
    }
  }

  /** Another live binding holding `sid`, as its row key. */
  function liveKeyForSid(sid: Sid, exceptBinding: number): string | null {
    for (const v of views.values()) {
      if (
        v.key !== exceptBinding &&
        v.state === 'bound' &&
        v.sid === sid &&
        v.sessionKey !== null
      ) {
        return v.sessionKey
      }
    }
    return null
  }

  /** A binding ended with companion facts nobody compared: the legacy side never bound. */
  function flushSeen(binding: number): void {
    for (const s of [...seen]) {
      if (s.binding !== binding) continue
      seen.delete(s)
      sink.add(
        compareIdentity(
          {
            shape: s.shape,
            companion: { key: s.key, sid: s.sid, helloAfterSpawnMs: s.helloAfterSpawnMs },
            legacy: null
          },
          epochNow()
        )
      )
    }
  }

  function recordOutcome(o: IdentityOutcome): void {
    // The companion fact is found by the transcript first (a crossed legacy binder moved another
    // row to it: a mismatch), then by the row (the same row bound to another transcript).
    const target =
      [...seen].find((s) => s.sid === o.sid) ?? [...seen].find((s) => s.key === o.fromKey)
    const legacy =
      o.via === 'companion'
        ? null
        : {
            key: o.fromKey,
            sid: o.sid,
            via: o.via as LegacyVia,
            afterSpawnMs: target ? Math.max(0, Math.round(now() - target.spawnAt)) : 0
          }
    if (!target) {
      // No hello for this session. In `off` nothing is expected from the mod: not a record.
      if (deps.getMode() !== 'off' && legacy) {
        sink.add(compareIdentity({ shape: 'new', companion: null, legacy }, epochNow()))
      }
      return
    }
    seen.delete(target)
    sink.add(
      compareIdentity(
        {
          shape: target.shape,
          companion: {
            key: target.key,
            sid: target.sid,
            helloAfterSpawnMs: target.helloAfterSpawnMs
          },
          legacy
        },
        epochNow()
      )
    )
  }

  function recompute(b: BindingView): void {
    views.set(b.key, b)
    if (b.state !== 'bound' || b.owner === null) {
      claims.delete(b.key)
      conflicted.delete(b.key)
      starts.delete(b.key)
      rebounds.delete(b.key)
      lineages.delete(b.key)
      flushSeen(b.key)
      return
    }
    noteLineage(b)
    const fact: IdentityFact = classifyIdentity({
      key: b.sessionKey,
      sid: b.sid,
      cause: causes.get(b.key) ?? 'spawn',
      ownerKind: b.owner.kind,
      liveKeyForSid: liveKeyForSid(b.sid, b.key)
    })
    if (fact.kind === 'claim') {
      noteSeen(b, fact)
      conflicted.delete(b.key)
      claims.set(b.key, {
        key: fact.key,
        sid: fact.sid,
        cause: fact.cause,
        act:
          b.enabled.includes('sense.identity') &&
          mayAct({ mode: deps.getMode(), gate: deps.gateOf(b), lease: b.lease, fact })
      })
      return
    }
    claims.delete(b.key)
    if (fact.kind === 'conflict') {
      if (conflicted.get(b.key) !== fact.sid) {
        conflicted.set(b.key, fact.sid)
        stats.conflicts++
        sink.add(
          compareIdentity(
            {
              shape: shapeOf(b, causes.get(b.key) ?? 'resume'),
              companion: { key: fact.key, sid: fact.sid, helloAfterSpawnMs: 0 },
              legacy: null,
              conflict: true
            },
            epochNow()
          )
        )
      }
    } else {
      conflicted.delete(b.key)
    }
  }

  function onRebound(b: BindingView, d: unknown): void {
    if (b.state !== 'bound' || typeof d !== 'object' || d === null) return
    const { prevSid, sid, cause } = d as Record<string, unknown>
    if (typeof sid !== 'string' || typeof prevSid !== 'string' || !CAUSES.has(String(cause))) return
    if (sid === b.sid) return // a duplicate: nothing to do
    if (prevSid !== b.sid) stats.reboundGap++ // an earlier rebound was lost: accept this one anyway
    stats.rebounds++
    causes.set(b.key, cause as IdentityCause)
    // T455: a new conversation. Its lineage names the sid the HOST had bound (never the mod's
    // `prevSid`), and its start is the rebound's path, checked against the NEW sid.
    rebounds.set(b.key, { cause: cause as IdentityCause, from: b.sid, sid })
    const raw = (d as Record<string, unknown>).transcriptPath
    starts.set(b.key, {
      sid,
      source: cause === 'clear' ? 'clear' : 'resume',
      transcriptPath: raw === undefined ? null : keepPath(raw, sid)
    })
    deps.host.rebind(b, sid) // fires onBindingChange, which recomputes
  }

  // The server delivers only event types a wave registered (contract §8): these four are ours.
  deps.host.registerEventTypes(['session.snapshot', 'session.rebound', 'session.end', 'mod.error'])

  const offs = [
    deps.host.bus.on('hello', (b, kind) => {
      if (kind === 'spawn') {
        causes.set(b.key, 'spawn')
        // contract §11.2: a hello that redeemed a spawn token proves `sense.identity`
        if (b.enabled.includes('sense.identity')) deps.host.markProven(b, 'sense.identity')
      }
      recompute(b)
      push()
    }),
    deps.host.bus.on('event', (b, ev) => {
      if (ev.t === 'session.rebound') {
        onRebound(b, ev.d)
        push()
      } else if (ev.t === 'session.snapshot') {
        onSnapshot(b, ev.d)
      }
    }),
    deps.host.bus.on('lease', (b) => {
      recompute(b)
      push()
    }),
    deps.host.bus.on('end', (b) => {
      recompute(b)
      push()
    }),
    deps.host.onBindingChange((b) => {
      recompute(b)
      push()
    })
  ]

  const startFor = (b: BindingView): (StartFacts & { sid: Sid }) | null => {
    const st = starts.get(b.key)
    return st && st.sid === b.sid ? st : null
  }

  return {
    claims: list,
    claimFacts: () =>
      [...claims].map(([key, c]) => {
        const v = views.get(key)
        return {
          ...c,
          transcriptPath: v ? (startFor(v)?.transcriptPath ?? null) : null,
          lineage: v ? lineageOf(v) : null
        }
      }),
    transcriptPathOf: (b) => startFor(b)?.transcriptPath ?? null,
    startOf: (b) => {
      const st = startFor(b)
      return st ? { source: st.source, transcriptPath: st.transcriptPath } : null
    },
    lineageOf,
    pathDrops: () => ({ ...drops }),
    recordOutcome,
    diagnostics: () => ({
      claims: list(),
      ...stats,
      parity: { ...sink.summary(), recent: sink.list().slice(-20) }
    }),
    dispose() {
      for (const off of offs) off()
    }
  }
}
