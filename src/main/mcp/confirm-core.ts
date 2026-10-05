/**
 * Pure parked-promise core for the Harnu MCP confirm gate (T13).
 *
 * When a privileged MCP tool call (e.g. an agent requesting elevated boot
 * flags) needs human sign-off, the server "parks" a promise here and surfaces a
 * {@link ConfirmDisclosure} to the operator. The promise settles when the
 * operator responds, the confirm window elapses, the transport aborts, or the
 * server shuts down.
 *
 * SECURITY — this gate fails CLOSED. Every non-affirmative path resolves
 * `deny`: an elapsed deadline (`TIMEOUT`), no operator surface to ask
 * (`NO_WINDOW`), too many concurrent confirms (`DENY_BUSY`), a transport abort
 * (`CANCELLED`), or shutdown (`REJECT_ALL`). Failing OPEN here would grant an
 * external agent a privilege on no-response — exactly the escalation this gate
 * exists to prevent. The deadline therefore resolves `deny`, never `allow` and
 * never an `abstain` a caller might coerce into a grant.
 *
 * Framework-free + side-effect-free (no electron / timers / crypto import): the
 * shell injects {@link ConfirmDeps} (the wire `send`, the `setTimer`/`clearTimer`
 * pair, and `now`) so the core lands in the pure-core coverage surface
 * (ADR-0001) and the unit tests stay deterministic under fake timers.
 */

/** The hook's own soft deadline (3.5s); the confirm window is decoupled from it. */
export const HOOK_DEADLINE_MS = 3_500

/**
 * The SERVER's inline-race window (T44 S4). The tool call awaits the confirm for
 * this long; if the human answers within it, the mutation actuates inline (the
 * fast "focused modal" path). If it elapses, the tool returns a `pending` handle
 * (the agent polls `get_approval`) while the confirm STAYS live — the human
 * answers whenever they return, and the mutation actuates on their Allow. This is
 * a return-timing knob, NOT a deny deadline (BUG-5: no more 30s auto-deny). Kept
 * strictly below {@link MCP_CLIENT_TIMEOUT_MS} so the pending handle is returned
 * before the MCP client abandons the request.
 */
export const CONFIRM_WINDOW_MS = 30_000

/**
 * Hard fail-closed backstop (T44 S4). A confirm nobody ever answers is denied
 * after this long so an abandoned park can never leak a grant. Generous (30 min)
 * so "answer when you're back" really works; the ONLY non-response deny for a
 * live confirm.
 */
export const PARK_TTL_MS = 30 * 60_000

/** Reference MCP client request timeout; the inline race must resolve first. */
export const MCP_CLIENT_TIMEOUT_MS = 60_000

/** Max concurrent parked confirms; a park over this cap is immediately DENY_BUSY. */
export const MAX_PENDING_CONFIRMS = 8

/** The two terminal verdicts. There is deliberately no `abstain` — see module doc. */
export type Verdict = 'allow' | 'deny'

/** Why a parked confirm settled. Every reason but `RESPONDED` accompanies a DENY. */
export type ConfirmReason =
  'RESPONDED' | 'TIMEOUT' | 'NO_WINDOW' | 'DENY_BUSY' | 'CANCELLED' | 'REJECT_ALL' | 'TTL_EXPIRED'

/** The settled result of a parked confirm. */
export interface ConfirmOutcome {
  /** The decision. `allow` only ever comes from an explicit operator response. */
  verdict: Verdict
  /** What caused the settle, for auditing the fail-closed path that fired. */
  reason: ConfirmReason
  /**
   * T61: for a `create_worktree` confirm whose disclosure offered inheritance
   * ({@link ConfirmDisclosure.worktreeInheritOffer}), the operator's checkbox
   * state at Allow — `false` when they unchecked "inherit agent control". Absent
   * (or on any non-response settle) means "not specified": the actuation applies
   * its own authoritative default (inherit, since the disclosure only offered it
   * when the setting was ON + the repo allowed). Never affects the fail-closed
   * lifecycle — it only tunes an ALLOW's side effect.
   */
  inheritWorktreeControl?: boolean
  /**
   * T72: for an inheritance-DISCOVERY confirm (a mutation denied FOLDER_NOT_ALLOWED
   * in a canonical worktree of an already-allowed repo — {@link
   * ConfirmDisclosure.inheritDiscoveryOffer}), the scope the operator picked at
   * Allow: `'always'` = turn on the global opt-in + mark this worktree (persistent,
   * revocable by the repo); `'once'` = allow just this worktree, just this app
   * session. Absent (or on any non-response settle) means "not specified": the
   * actuation defaults to `'once'` (least privilege — a surface that could not show
   * the selector, e.g. a parked Inbox row, NEVER turns on the global capability).
   * Never affects the fail-closed lifecycle — it only tunes an ALLOW's side effect.
   */
  inheritScope?: 'always' | 'once'
  /**
   * T93: for a confirm that offered "always allow this verb here"
   * ({@link ConfirmDisclosure.alwaysAllowOffer}), the checkbox state at Allow —
   * `true` = persist a `mcp__harnu__<verb>` rule into the folder's
   * `.claude/settings.local.json` so the verb runs without a confirm there from now
   * on. Absent (or on any non-response settle) means "not specified": nothing is
   * persisted (the safe default — a surface that could not show the checkbox never
   * mints a durable grant). Never affects the fail-closed lifecycle.
   */
  alwaysAllow?: boolean
  /**
   * T104: for a `submit_manifest` confirm ({@link ConfirmDisclosure.manifestCards}),
   * the slugs the operator left CHECKED at Allow — the partial-go list (§2.2). Only
   * these are stamped `approved`. Absent (or on any non-response settle) means "not
   * specified": the actuation stamps NOTHING (fail closed — the checklist is the
   * entire authorization surface here, unlike the other boolean extras above, so a
   * surface that never sent it must never be read as "approve everything").
   */
  manifestSelectedSlugs?: string[]
  /**
   * T102: for a `submit_manifest` confirm, the operator's per-card substrate
   * override at Allow (slug → `session|worktree|teammate|internal`) — only
   * entries that differ from the disclosed row need to be present, but a
   * surface may send the full map unconditionally (the actuation writes idempotently).
   * Absent (or on any non-response settle) means "no override": the stamped
   * card keeps whatever substrate was already disclosed/on-disk.
   */
  manifestSubstrateOverrides?: Record<string, string>
}

/** Optional per-response data the operator surface may attach to a verdict (T61/T72/T93/T104). */
export interface ConfirmResponseData {
  /** The "inherit agent control" checkbox state at Allow (create_worktree, T61). */
  inheritWorktreeControl?: boolean
  /** The inheritance-discovery scope the operator picked at Allow (T72). */
  inheritScope?: 'always' | 'once'
  /** The "always allow this verb here" checkbox state at Allow (T93). */
  alwaysAllow?: boolean
  /** The manifest checklist's checked slugs at Allow (T104). */
  manifestSelectedSlugs?: string[]
  /** The manifest checklist's per-card substrate override at Allow (T102). */
  manifestSubstrateOverrides?: Record<string, string>
}

/**
 * One card's disclosure row in a `submit_manifest` confirm (T104 §2.1) — built
 * SERVER-SIDE from the on-disk card, never from agent-supplied text. Plain
 * strings throughout (not roadmap-core's literal unions) so this generic
 * confirm gate stays dependency-free; the shell narrows when it builds the row.
 */
export interface ManifestCardDisclosure {
  /** The card slug/id. */
  slug: string
  /** The on-disk title. */
  title: string
  /** T105 kind (scout/bug/feature/review/chore), when set. */
  kind?: string
  /** T105 complexity (trivial/simple/standard/complex), when set. */
  complexity?: string
  /** Resolved substrate (session/worktree/teammate/internal) for THIS dispatch. */
  substrate?: string
  /** Resolved launch model for THIS dispatch, when known. */
  model?: string
  /** Resolved launch effort for THIS dispatch, when known. */
  effort?: string
  /** Non-blocking readiness-lint gaps (T105 §3.3) — shown, never a refusal. */
  gaps: string[]
  /** The boot prompt that WOULD be generated for this card, verbatim (§2.1). */
  prompt: string
  /**
   * The approval fingerprint ({@link computeCardApprovalHash} in roadmap-core)
   * of THIS row's title/spec/body, computed once here at disclosure-build time.
   * Not rendered by the operator surface — carried through so the Allow
   * actuation stamps EXACTLY what was disclosed, never a value re-read from disk
   * after the operator has already seen (and could act on) the row.
   */
  bodyHash: string
}

/** What the operator is asked to sign off on. */
export interface ConfirmDisclosure {
  /** Human-readable prompt shown to the operator. */
  prompt: string
  /** The resolved permission mode the agent would run under. */
  permissionMode: string
  /** Non-default boot flags being requested (already filtered to the notable ones). */
  nonDefaultFlags: string[]
  /**
   * Shell commands (`sh -c`) a `create_worktree` confirm will run, verbatim as
   * executed — the RCE surface (T08). Empty/absent for non-worktree ops.
   */
  commands?: string[]
  /**
   * T61: when true, this `create_worktree` confirm OFFERS agent-control inheritance
   * (the global opt-in is ON and the base repo is agent-allowed). The operator
   * surface renders an opt-out checkbox (default checked); its state rides back on
   * {@link ConfirmResponseData.inheritWorktreeControl}. Absent/false → no checkbox,
   * no inheritance (current behavior). Never gates the confirm itself.
   */
  worktreeInheritOffer?: boolean
  /**
   * T72: when true, this is an inheritance-DISCOVERY confirm — the agent tried to
   * act in a canonical `.claude/worktrees/*` worktree whose parent repo is already
   * agent-allowed, so instead of a dead-end deny the operator is offered the
   * inheritance. The surface renders a `'always' | 'once'` scope selector (default
   * `'once'`) whose choice rides back on {@link ConfirmResponseData.inheritScope};
   * the `prompt` narrates all three senses for the parked surface (which has no
   * selector → default `'once'`). Absent/false → not a discovery confirm. Never
   * gates the confirm itself.
   */
  inheritDiscoveryOffer?: boolean
  /**
   * T93: when true, this confirm OFFERS "always allow this verb here" — the operator
   * surface renders a checkbox whose state rides back on
   * {@link ConfirmResponseData.alwaysAllow}; on Allow the shell persists a
   * `mcp__harnu__<verb>` rule into the folder's `.claude/settings.local.json`. Offered
   * for every mutation that passes the confirm EXCEPT `plan_mission` and the T72
   * discovery variant. Independent of the T61/T72 offers (may co-occur with
   * `worktreeInheritOffer` on a create_worktree). Absent/false → no checkbox. Never
   * gates the confirm itself.
   */
  alwaysAllowOffer?: boolean
  /**
   * T93: the INITIAL checkbox state for an `alwaysAllowOffer` confirm — `true`
   * (checked) for ordinary verbs, `false` (unchecked) for the dangerous ones
   * (`create_worktree`/`spawn_terminal`), so a durable auto-allow of a shell-running
   * verb is always a deliberate tick. Only meaningful when `alwaysAllowOffer` is true.
   */
  alwaysAllowDefault?: boolean
  /**
   * T104: for a `submit_manifest` confirm, the per-card checklist (§2.1) — the
   * PRIMARY content of this disclosure, not an extra. The operator surface
   * renders one checkbox row per entry (all CHECKED by default), and the
   * checked slugs ride back on {@link ConfirmResponseData.manifestSelectedSlugs}.
   * Absent/undefined → not a manifest confirm (renders like any other op).
   */
  manifestCards?: ManifestCardDisclosure[]
  /**
   * T104: the cost-estimate note shown once for the whole batch — "no history
   * yet" until a usage heuristic exists (§2.1). Only meaningful alongside
   * `manifestCards`.
   */
  manifestCostNote?: string
}

/** The disclosure plus the routing fields the operator surface needs. */
export interface ConfirmWire extends ConfirmDisclosure {
  /** Correlation id minted by {@link ConfirmCore.park}; the response references it. */
  id: string
  /** Epoch ms at which this confirm fails closed if still unanswered (PARK_TTL). */
  deadline: number
  /**
   * Render hint (T44 S4): `modal` when the window was focused at park time (show
   * the fast confirm overlay), `parked` when it was not (show a row in the
   * Approval Inbox + chime + OS attention). Never affects the fail-closed lifecycle.
   */
  mode: 'modal' | 'parked'
}

/** Opaque timer handle returned by the injected scheduler. */
type TimerHandle = ReturnType<typeof setTimeout>

/** Side-effecting collaborators injected by the shell (keeps the core pure). */
export interface ConfirmDeps {
  /**
   * Deliver the confirm wire to an operator surface. Returns `false` when there
   * is NO window to show it — the core then fails CLOSED with `NO_WINDOW`.
   */
  send: (wire: ConfirmWire) => boolean
  /** Schedule the deadline callback; returns a handle for {@link ConfirmDeps.clearTimer}. */
  setTimer: (fn: () => void, ms: number) => TimerHandle
  /** Cancel a scheduled deadline. */
  clearTimer: (handle: TimerHandle) => void
  /** Current epoch ms (used to stamp the wire `deadline`). */
  now: () => number
  /**
   * Whether the app window is focused right now (T44 S4). Sets the wire's render
   * `mode` (focused → `modal`, else → `parked`). Optional — absent → `parked`
   * (fail toward the calmer, notify-the-human surface). Never affects lifecycle.
   */
  isFocused?: () => boolean
  /**
   * Notified whenever a parked confirm settles (respond / TTL / cancel / rejectAll)
   * — T44 S4, lets the shell emit `mcp:confirm:resolved` so a parked Inbox row
   * prunes even when the operator did not answer it directly. Optional; best-effort.
   */
  onSettled?: (id: string, outcome: ConfirmOutcome) => void
}

/**
 * Outcome of {@link ConfirmCore.park} (T44 S4). Either an immediate fail-closed
 * `denied` (no operator surface / saturated — nothing parked), or a `live`
 * confirm carrying its `id`, the render `mode`, and a `settled` promise that
 * resolves ONLY on respond / cancel / rejectAll / TTL. The caller (server) races
 * `settled` against {@link CONFIRM_WINDOW_MS} to decide inline-actuate vs. return
 * a pending handle — the confirm stays live either way.
 */
export type ParkResult =
  | { kind: 'denied'; outcome: ConfirmOutcome }
  | { kind: 'live'; id: string; mode: 'modal' | 'parked'; settled: Promise<ConfirmOutcome> }

/** The confirm-gate surface returned by {@link createConfirmCore}. */
export interface ConfirmCore {
  /**
   * Park a confirm for `disclosure`. Returns `{kind:'denied'}` immediately when
   * the pending cap is hit (`DENY_BUSY`) or there is no operator surface
   * (`NO_WINDOW`); otherwise `{kind:'live', id, mode, settled}` where `settled`
   * stays pending until {@link ConfirmCore.respond}, the {@link PARK_TTL_MS}
   * backstop, a {@link ConfirmCore.cancel}, or {@link ConfirmCore.rejectAll}.
   */
  park(disclosure: ConfirmDisclosure): ParkResult
  /**
   * Settle a parked confirm with an explicit operator verdict. Returns the
   * verdict on success, or `false` when no confirm matches `id` (already
   * settled, unknown, or timed out). Optional `data` rides onto the settled
   * {@link ConfirmOutcome} (T61: the create_worktree inherit checkbox).
   */
  respond(id: string, verdict: Verdict, data?: ConfirmResponseData): Verdict | false
  /** Abort a parked confirm (transport closed): settles it `deny`/`CANCELLED`. */
  cancel(id: string): boolean
  /** Deny + clear every pending confirm (server shutdown). */
  rejectAll(): void
  /** Number of currently parked confirms. */
  pendingCount(): number
  /**
   * Snapshot of every still-live confirm's wire (BUG-25). Lets the shell
   * re-hydrate the operator surface — the renderer has no other way to learn
   * about a confirm that parked before it was listening (a reload, a fresh
   * window, or a race at boot): the `send` in {@link park} fires exactly once,
   * so a surface that missed it would otherwise never see the confirm again
   * until it fails closed on the {@link PARK_TTL_MS} backstop. Mirrors
   * `listPendingApprovals` in `approval-resolver.ts` for the sibling hook queue.
   */
  list(): ConfirmWire[]
  /**
   * BUG-32 / spec D1: promote every still-live confirm currently rendered
   * `parked` to `modal` and return their (mutated) wires, in park order (D5).
   * Called by the shell on window focus regain so a confirm that arrived
   * while the operator was away reaches the modal the moment they return,
   * instead of waiting behind the Approval Inbox forever. Idempotent (D2): a
   * confirm already promoted has `mode: 'modal'` and is skipped on the next
   * call — there is no re-emit for a confirm nothing changed about. A confirm
   * excluded by a same-epoch {@link ConfirmCore.dismiss} (D4) is skipped too.
   */
  promotePending(): ConfirmWire[]
  /**
   * D3: defer a promoted confirm without producing a verdict — "not now", not
   * "no". The confirm stays live in `pending` (its {@link PARK_TTL_MS} keeps
   * running unchanged) and its wire `mode` reverts to `parked` so it
   * reappears in the Approval Inbox "Needs you" tab. D4: excluded from the
   * next {@link ConfirmCore.promotePending} call until a subsequent {@link
   * ConfirmCore.advanceFocusEpoch} (the shell calls this on window blur) moves
   * the focus epoch past the one recorded here — otherwise a dismissal would
   * be immediately undone by the very next focus-regain promotion. Returns
   * the reverted wire, or `false` when `id` is not a currently-`modal` live
   * confirm (nothing to dismiss).
   */
  dismiss(id: string): ConfirmWire | false
  /**
   * D4: advance the focus epoch. The shell calls this on window blur so a
   * dismissal recorded in the epoch that is now ending no longer excludes its
   * confirm from the NEXT focus-regain promotion.
   */
  advanceFocusEpoch(): void
}

/** Internal bookkeeping for one parked confirm. */
interface Pending {
  resolve: (outcome: ConfirmOutcome) => void
  timer: TimerHandle
  /**
   * The wire originally sent at park time (BUG-25: replayed by {@link
   * ConfirmCore.list}). BUG-32: promote/dismiss REPLACE this field with a new
   * `{...wire, mode}` object (never mutate the existing one in place) so an
   * already-returned reference — e.g. a wire a caller stashed from an earlier
   * `list()`/`park()` call — stays a frozen snapshot instead of silently
   * changing mode underneath it; `list()`/promote/dismiss always read the
   * current `entry.wire` fresh.
   */
  wire: ConfirmWire
  /**
   * BUG-32 / spec D4: the focus epoch active when this confirm was last
   * dismissed, or `undefined` if never dismissed. Compared against the live
   * `focusEpoch` in {@link createConfirmCore.promotePending} — equal means
   * "dismissed this focus session, don't re-promote yet".
   */
  dismissedAtFocusEpoch?: number
}

/**
 * Build a confirm-gate core over the injected {@link ConfirmDeps}. The returned
 * surface owns a private `Map` of pending confirms; nothing leaks to module
 * scope, so multiple cores (e.g. per server instance) are independent.
 *
 * @param deps - the wire `send`, timer pair, and clock.
 * @returns a {@link ConfirmCore}.
 */
export function createConfirmCore(deps: ConfirmDeps): ConfirmCore {
  const { send, setTimer, clearTimer, now } = deps
  const pending = new Map<string, Pending>()
  let seq = 0
  // BUG-32 / spec D4: monotonic, incremented by `advanceFocusEpoch` (shell: on
  // window blur). Only ever compared for equality against a dismissal's
  // captured value, so it never needs to reset.
  let focusEpoch = 0

  /** Settle + remove a pending confirm; returns false if `id` was not parked. */
  const settle = (id: string, outcome: ConfirmOutcome): boolean => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    clearTimer(entry.timer)
    entry.resolve(outcome)
    // T44 S4: tell the shell so it can prune a parked Inbox row on ANY settle
    // (respond / TTL / cancel / rejectAll), best-effort, never throwing into settle.
    try {
      deps.onSettled?.(id, outcome)
    } catch {
      /* a listener fault must never break the fail-closed settle */
    }
    return true
  }

  return {
    park(disclosure): ParkResult {
      // Fail CLOSED when saturated: never block, never grant.
      if (pending.size >= MAX_PENDING_CONFIRMS) {
        return { kind: 'denied', outcome: { verdict: 'deny', reason: 'DENY_BUSY' } }
      }
      const id = `confirm-${++seq}`
      const mode: 'modal' | 'parked' = deps.isFocused?.() ? 'modal' : 'parked'
      const wire: ConfirmWire = {
        id,
        prompt: disclosure.prompt,
        permissionMode: disclosure.permissionMode,
        nonDefaultFlags: [...disclosure.nonDefaultFlags],
        // Defensive clone, normalized to [] so the renderer's .length checks are
        // simple (mirrors nonDefaultFlags). Carries the create_worktree RCE commands.
        commands: disclosure.commands ? [...disclosure.commands] : [],
        // T61: whether to render the agent-control-inheritance opt-out checkbox.
        worktreeInheritOffer: disclosure.worktreeInheritOffer === true,
        // T72: whether to render the inheritance-discovery scope selector.
        inheritDiscoveryOffer: disclosure.inheritDiscoveryOffer === true,
        // T93: whether to render the "always allow this verb here" checkbox + its
        // initial state (unchecked for the dangerous verbs).
        alwaysAllowOffer: disclosure.alwaysAllowOffer === true,
        alwaysAllowDefault: disclosure.alwaysAllowDefault === true,
        // T104: the manifest checklist, defensively cloned (mirrors `commands`).
        ...(disclosure.manifestCards
          ? { manifestCards: disclosure.manifestCards.map((c) => ({ ...c })) }
          : {}),
        ...(disclosure.manifestCostNote !== undefined
          ? { manifestCostNote: disclosure.manifestCostNote }
          : {}),
        // Deadline is the fail-closed TTL backstop (T44 S4), not a 30s deny.
        deadline: now() + PARK_TTL_MS,
        mode
      }
      // No operator surface accepted the wire -> fail CLOSED, nothing parked.
      if (!send(wire)) {
        return { kind: 'denied', outcome: { verdict: 'deny', reason: 'NO_WINDOW' } }
      }
      let resolveOuter!: (outcome: ConfirmOutcome) => void
      const settled = new Promise<ConfirmOutcome>((res) => {
        resolveOuter = res
      })
      // The ONLY non-response deny for a live confirm: the long TTL backstop.
      const timer = setTimer(() => {
        settle(id, { verdict: 'deny', reason: 'TTL_EXPIRED' })
      }, PARK_TTL_MS)
      pending.set(id, { resolve: resolveOuter, timer, wire })
      return { kind: 'live', id, mode, settled }
    },

    respond(id, verdict, data) {
      const outcome: ConfirmOutcome = { verdict, reason: 'RESPONDED' }
      // T61: carry the operator's inherit-checkbox choice onto the outcome so the
      // awaiting create_worktree actuation can honor the opt-out. Only meaningful
      // on `allow`; ignored by the fail-closed paths.
      if (data && data.inheritWorktreeControl !== undefined) {
        outcome.inheritWorktreeControl = data.inheritWorktreeControl
      }
      // T72: carry the inheritance-discovery scope (always/once) the same way, so the
      // awaiting discovery actuation can turn on the opt-in (always) or register the
      // once-allow. Only meaningful on `allow`; ignored by the fail-closed paths.
      if (data && data.inheritScope !== undefined) {
        outcome.inheritScope = data.inheritScope
      }
      // T93: carry the "always allow this verb here" choice so the awaiting actuation
      // persists a `mcp__harnu__<verb>` rule. Only meaningful on `allow`; ignored by
      // the fail-closed paths (a denied/timed-out confirm never persists a grant).
      if (data && data.alwaysAllow !== undefined) {
        outcome.alwaysAllow = data.alwaysAllow
      }
      // T104: carry the manifest checklist's checked slugs so the awaiting
      // actuation stamps ONLY those cards. Only meaningful on `allow`; ignored by
      // the fail-closed paths (a denied/timed-out manifest confirm stamps nothing).
      if (data && data.manifestSelectedSlugs !== undefined) {
        outcome.manifestSelectedSlugs = [...data.manifestSelectedSlugs]
      }
      // T102: carry the per-card substrate override map the same way — a plain
      // object copy (not an array), so it survives the settle unmodified. Only
      // meaningful on `allow`; ignored by the fail-closed paths (a denied/timed-out
      // manifest confirm stamps nothing, so no override is ever applied either).
      if (data && data.manifestSubstrateOverrides !== undefined) {
        outcome.manifestSubstrateOverrides = { ...data.manifestSubstrateOverrides }
      }
      return settle(id, outcome) ? verdict : false
    },

    cancel(id) {
      return settle(id, { verdict: 'deny', reason: 'CANCELLED' })
    },

    rejectAll() {
      for (const id of [...pending.keys()]) {
        settle(id, { verdict: 'deny', reason: 'REJECT_ALL' })
      }
    },

    pendingCount() {
      return pending.size
    },

    list() {
      return [...pending.values()].map((p) => p.wire)
    },

    promotePending(): ConfirmWire[] {
      const promoted: ConfirmWire[] = []
      // Map iteration order === insertion (park) order, so this is D5 for free.
      for (const entry of pending.values()) {
        if (entry.wire.mode !== 'parked') continue
        if (entry.dismissedAtFocusEpoch === focusEpoch) continue
        entry.wire = { ...entry.wire, mode: 'modal' }
        promoted.push(entry.wire)
      }
      return promoted
    },

    dismiss(id): ConfirmWire | false {
      const entry = pending.get(id)
      if (!entry || entry.wire.mode !== 'modal') return false
      entry.wire = { ...entry.wire, mode: 'parked' }
      entry.dismissedAtFocusEpoch = focusEpoch
      return entry.wire
    },

    advanceFocusEpoch(): void {
      focusEpoch++
    }
  }
}
