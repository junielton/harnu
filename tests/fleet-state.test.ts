import { describe, it, expect } from 'vitest'
import {
  resolveActivity,
  classifyFleetState,
  isNeedsInput,
  STUCK_AFTER_MS,
  type FleetSignals,
  type FleetCtx
} from '../src/renderer/src/stores/fleet-state'
import { deriveStagnation, type TranscriptEntry } from '../src/main/stall-detect'

/**
 * The canonical fleet classifier (T67 §2) — the ONE derivation the sidebar dot,
 * the Fleet board, and the supervision-load counter all consume so they agree by
 * construction. Closes BUG-13 (dot said idle / board said working for the same
 * long tool call) and BUG-15 (orchestrator with live sub-agents listed idle).
 */

const NOW = 1_000_000_000_000 // fixed clock (Date.now() is banned in pure tests)
const TEN_MIN = 10 * 60_000

/** A signals slice with sane, quiet-but-fresh defaults; override per case. */
const sig = (over: Partial<FleetSignals> = {}): FleetSignals => ({
  taskState: undefined,
  status: 'idle',
  modifiedMs: NOW, // fresh by default
  liveAgentCount: 0,
  hasParkedApproval: false,
  lastViewedMs: NOW,
  isViewing: false,
  isLive: true, // fixtures opt IN to "dead" explicitly (BUG-53)
  ...over
})

const ctx = (over: Partial<FleetCtx> = {}): FleetCtx => ({
  nowMs: NOW,
  stuckAfterMs: STUCK_AFTER_MS,
  forgottenAfterMs: TEN_MIN,
  ...over
})

/** Helper: a `modifiedMs` that is `ms` in the past relative to NOW. */
const quietFor = (ms: number): number => NOW - ms

describe('resolveActivity (working | stuck | idle — the contested axis)', () => {
  it('working + fresh output → working', () => {
    expect(resolveActivity(sig({ taskState: 'working', modifiedMs: NOW }), ctx())).toBe('working')
  })

  it('BUG-13: working + quiet PAST the 5s relax but UNDER N → working, not idle', () => {
    // The exact print: a long tool call, transcript quiet >5s. The old dot went
    // grey (idle); it must read `working` until the silence crosses N.
    const s = sig({ taskState: 'working', status: 'idle', modifiedMs: quietFor(30_000) })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('BUG-13: working + quiet ≥ N → stuck (the state that had no name)', () => {
    const s = sig({ taskState: 'working', status: 'idle', modifiedMs: quietFor(STUCK_AFTER_MS) })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('stuck triggers exactly AT the threshold, not a ms before', () => {
    const base = { taskState: 'working' as const, status: 'idle' as const }
    expect(resolveActivity(sig({ ...base, modifiedMs: quietFor(STUCK_AFTER_MS - 1) }), ctx())).toBe(
      'working'
    )
    expect(resolveActivity(sig({ ...base, modifiedMs: quietFor(STUCK_AFTER_MS) }), ctx())).toBe(
      'stuck'
    )
  })

  it('BUG-15: a quiet orchestrator with live sub-agents is working, never stuck', () => {
    // 5 live sidechains, main transcript silent for ~1h50m. Without aggregation
    // this is idle (board) / stuck. With it: working.
    const s = sig({
      taskState: 'working',
      status: 'idle',
      modifiedMs: quietFor(110 * 60_000),
      liveAgentCount: 5
    })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('BUG-15: sidechain aggregation wins even with no parent taskState', () => {
    const s = sig({ taskState: undefined, status: 'idle', liveAgentCount: 1 })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('sidechains all finished (count 0) → falls back to the parent taskState', () => {
    const s = sig({ taskState: 'idle', status: 'idle', liveAgentCount: 0 })
    expect(resolveActivity(s, ctx())).toBe('idle')
  })

  it('no hook truth yet + active status → working (mirrors the legacy heuristic)', () => {
    expect(resolveActivity(sig({ taskState: undefined, status: 'active' }), ctx())).toBe('working')
  })

  it('no hook truth yet + idle/archived status → idle', () => {
    expect(resolveActivity(sig({ taskState: undefined, status: 'idle' }), ctx())).toBe('idle')
    expect(resolveActivity(sig({ taskState: undefined, status: 'archived' }), ctx())).toBe('idle')
  })

  it('terminal FSM states (idle / stopped / completed / failed) → idle', () => {
    for (const ts of ['idle', 'stopped', 'completed', 'failed'] as const) {
      expect(resolveActivity(sig({ taskState: ts, status: 'active' }), ctx())).toBe('idle')
    }
  })

  it('NaN modifiedMs (empty/invalid date) counts as fresh, never stuck', () => {
    const s = sig({ taskState: 'working', status: 'idle', modifiedMs: NaN })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('an active-status working session that is also quiet ≥ N is still stuck', () => {
    // taskState wins over status: even if status somehow says active, the quiet
    // measure is authoritative for the stuck promotion.
    const s = sig({ taskState: 'working', status: 'active', modifiedMs: quietFor(STUCK_AFTER_MS) })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })
})

describe('classifyFleetState (full 5-state taxonomy)', () => {
  it('needs-input → needs-you (fresh block, max urgency)', () => {
    expect(classifyFleetState(sig({ taskState: 'needs-input' }), ctx())).toBe('needs-you')
  })

  it('a parked approval (S4) → needs-you even without a needs-input taskState', () => {
    expect(classifyFleetState(sig({ taskState: 'working', hasParkedApproval: true }), ctx())).toBe(
      'needs-you'
    )
  })

  it('needs-input ignored past the forgotten threshold → return-here (de-escalated)', () => {
    const s = sig({ taskState: 'needs-input', lastViewedMs: NOW - TEN_MIN })
    expect(classifyFleetState(s, ctx())).toBe('return-here')
  })

  it('needs-input ignored but currently being VIEWED never de-escalates', () => {
    const s = sig({ taskState: 'needs-input', lastViewedMs: NOW - TEN_MIN, isViewing: true })
    expect(classifyFleetState(s, ctx())).toBe('needs-you')
  })

  it('needs-input seen recently stays needs-you (under the forgotten threshold)', () => {
    const s = sig({ taskState: 'needs-input', lastViewedMs: NOW - 60_000 })
    expect(classifyFleetState(s, ctx())).toBe('needs-you')
  })

  it('needs-you outranks activity: a blocked session with live agents is still needs-you', () => {
    const s = sig({ taskState: 'needs-input', liveAgentCount: 3 })
    expect(classifyFleetState(s, ctx())).toBe('needs-you')
  })

  it('working / stuck / idle flow straight through from resolveActivity', () => {
    expect(classifyFleetState(sig({ taskState: 'working', modifiedMs: NOW }), ctx())).toBe(
      'working'
    )
    expect(
      classifyFleetState(sig({ taskState: 'working', modifiedMs: quietFor(STUCK_AFTER_MS) }), ctx())
    ).toBe('stuck')
    expect(classifyFleetState(sig({ taskState: 'idle' }), ctx())).toBe('idle')
  })

  it('completed / failed fold into idle (terminal presentation lives in the surfaces)', () => {
    expect(classifyFleetState(sig({ taskState: 'completed' }), ctx())).toBe('idle')
    expect(classifyFleetState(sig({ taskState: 'failed' }), ctx())).toBe('idle')
  })

  it('the two bug scenarios classify coherently end-to-end', () => {
    // BUG-13 mid-tool-call (30s quiet) → working; (≥N quiet) → stuck.
    expect(
      classifyFleetState(sig({ taskState: 'working', modifiedMs: quietFor(30_000) }), ctx())
    ).toBe('working')
    // BUG-15 orchestrator → working via aggregation.
    expect(
      classifyFleetState(
        sig({ taskState: 'working', modifiedMs: quietFor(110 * 60_000), liveAgentCount: 5 }),
        ctx()
      )
    ).toBe('working')
  })
})

describe('transcriptState precedence (T91 — ground truth when no hook)', () => {
  it('hook taskState always wins over transcriptState', () => {
    // Live hook says working; transcript (staler) says idle → trust the hook.
    expect(
      resolveActivity(
        sig({ taskState: 'working', transcriptState: 'idle', modifiedMs: NOW }),
        ctx()
      )
    ).toBe('working')
    // Hook idle wins even if the transcript still reads working.
    expect(
      resolveActivity(
        sig({ taskState: 'idle', transcriptState: 'working', status: 'active' }),
        ctx()
      )
    ).toBe('idle')
  })

  it('no hook + transcript working → working, and ages into stuck on the same quiet timer', () => {
    expect(
      resolveActivity(
        sig({ taskState: undefined, transcriptState: 'working', modifiedMs: NOW }),
        ctx()
      )
    ).toBe('working')
    expect(
      resolveActivity(
        sig({
          taskState: undefined,
          transcriptState: 'working',
          modifiedMs: quietFor(STUCK_AFTER_MS)
        }),
        ctx()
      )
    ).toBe('stuck')
  })

  it('no hook + transcript idle → idle even if the legacy status says active', () => {
    expect(
      resolveActivity(
        sig({ taskState: undefined, transcriptState: 'idle', status: 'active' }),
        ctx()
      )
    ).toBe('idle')
  })

  it('transcript unknown/undefined falls back to the legacy quiet-timer heuristic', () => {
    expect(
      resolveActivity(
        sig({ taskState: undefined, transcriptState: 'unknown', status: 'active' }),
        ctx()
      )
    ).toBe('working')
    expect(
      resolveActivity(
        sig({ taskState: undefined, transcriptState: 'unknown', status: 'idle' }),
        ctx()
      )
    ).toBe('idle')
  })

  it('no hook + transcript needs-input → needs-you (classifier layers attention on top)', () => {
    expect(
      classifyFleetState(sig({ taskState: undefined, transcriptState: 'needs-input' }), ctx())
    ).toBe('needs-you')
  })

  it('a transcript needs-input, ignored past the forgotten threshold, de-escalates to return-here', () => {
    const s = sig({
      taskState: undefined,
      transcriptState: 'needs-input',
      lastViewedMs: NOW - TEN_MIN
    })
    expect(classifyFleetState(s, ctx())).toBe('return-here')
  })

  it('a live hook working suppresses a transcript needs-input (hook is fresher)', () => {
    // The hook says the model resumed working; the on-disk tail hasn't caught up.
    const s = sig({ taskState: 'working', transcriptState: 'needs-input', modifiedMs: NOW })
    expect(classifyFleetState(s, ctx())).toBe('working')
  })
})

describe('BUG-53: isLive precondition — no "alive" state without proof of life', () => {
  it('dead session + working transcript tail, quiet 71h → idle, never stuck (the 229-phantom case)', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: 'working',
      isLive: false,
      modifiedMs: quietFor(71 * 60 * 60_000)
    })
    expect(resolveActivity(s, ctx())).toBe('idle')
  })

  it('restart simulation: only the transcript signal exists, session is dead → idle, not stuck', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: 'working',
      isLive: false,
      modifiedMs: quietFor(71 * 60 * 60_000),
      lastEventMs: undefined
    })
    expect(resolveActivity(s, ctx())).toBe('idle')
  })

  it('regression guard: a GENUINELY alive session (isLive) with a working tail quiet ≥ N still classifies stuck', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: 'working',
      isLive: true,
      modifiedMs: quietFor(4 * 60_000)
    })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('a live hook (taskState defined) needs no isLive guard — presence IS proof of life', () => {
    const s = sig({
      taskState: 'working',
      isLive: false,
      modifiedMs: quietFor(4 * 60_000)
    })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('a registry entry (registryState defined) needs no isLive guard — presence IS proof of life', () => {
    const s = sig({
      taskState: undefined,
      registryState: 'working',
      isLive: false,
      modifiedMs: quietFor(4 * 60_000)
    })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('level 4 legacy heuristic is gated identically: dead + active status + no markers → idle', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: undefined,
      status: 'active',
      isLive: false
    })
    expect(resolveActivity(s, ctx())).toBe('idle')
  })

  it('level 4 legacy heuristic is unchanged when alive: active status + no markers → working', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: undefined,
      status: 'active',
      isLive: true
    })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('dead sessions with a needs-input transcript tail do not classify needs-you', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: 'needs-input',
      isLive: false
    })
    expect(classifyFleetState(s, ctx())).not.toBe('needs-you')
    expect(isNeedsInput(s)).toBe(false)
  })

  it('alive sessions with a needs-input transcript tail still classify needs-you (regression)', () => {
    const s = sig({
      taskState: undefined,
      registryState: undefined,
      transcriptState: 'needs-input',
      isLive: true
    })
    expect(classifyFleetState(s, ctx())).toBe('needs-you')
    expect(isNeedsInput(s)).toBe(true)
  })
})

describe('isNeedsInput (canonical "blocked on you" — dot/board/queue share it)', () => {
  it('true for a hook needs-input or a parked approval', () => {
    expect(isNeedsInput({ taskState: 'needs-input' })).toBe(true)
    expect(isNeedsInput({ taskState: 'working', hasParkedApproval: true })).toBe(true)
  })
  it('true for a transcript needs-input only when there is no hook truth', () => {
    expect(isNeedsInput({ taskState: undefined, transcriptState: 'needs-input' })).toBe(true)
    expect(isNeedsInput({ taskState: 'working', transcriptState: 'needs-input' })).toBe(false)
    expect(isNeedsInput({ taskState: 'idle', transcriptState: 'needs-input' })).toBe(false)
  })
  it('false when neither signal is asking', () => {
    expect(isNeedsInput({ taskState: 'working', transcriptState: 'working' })).toBe(false)
    expect(isNeedsInput({})).toBe(false)
  })
})

describe('T92 overlay precedence: hooks > registry > transcript', () => {
  it('hooks win over the registry (registry only decides when hooks are absent)', () => {
    // hook says idle, registry says working → idle (hooks authoritative)
    expect(
      resolveActivity(sig({ taskState: 'idle', registryState: 'working', status: 'active' }), ctx())
    ).toBe('idle')
    // hook says working, registry says idle → working
    expect(
      resolveActivity(sig({ taskState: 'working', registryState: 'idle', modifiedMs: NOW }), ctx())
    ).toBe('working')
  })

  it('registry decides for sessions WITHOUT hooks (external), beating the transcript', () => {
    // no hooks, registry busy, transcript quiet → working (registry wins over status)
    expect(
      resolveActivity(
        sig({ taskState: undefined, registryState: 'working', status: 'idle', modifiedMs: NOW }),
        ctx()
      )
    ).toBe('working')
    // no hooks, registry idle, transcript ACTIVE → idle (registry overrides the heuristic)
    expect(
      resolveActivity(sig({ taskState: undefined, registryState: 'idle', status: 'active' }), ctx())
    ).toBe('idle')
  })

  it('transcript heuristic is the last resort (neither hooks nor registry)', () => {
    expect(
      resolveActivity(
        sig({ taskState: undefined, registryState: undefined, status: 'active' }),
        ctx()
      )
    ).toBe('working')
  })

  it('registry working + quiet ≥ N → stuck (same freshness math as hooks)', () => {
    const s = sig({
      taskState: undefined,
      registryState: 'working',
      status: 'idle',
      modifiedMs: quietFor(STUCK_AFTER_MS)
    })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('registry `waiting` → needs-you, but only when hooks are absent', () => {
    expect(
      classifyFleetState(sig({ taskState: undefined, registryState: 'needs-input' }), ctx())
    ).toBe('needs-you')
    // a hook that moved past the block (taskState idle) is NEVER overridden by a stale registry waiting
    expect(
      classifyFleetState(sig({ taskState: 'idle', registryState: 'needs-input' }), ctx())
    ).toBe('idle')
    // an active hook state also wins over registry waiting
    expect(
      classifyFleetState(
        sig({ taskState: 'working', registryState: 'needs-input', modifiedMs: NOW }),
        ctx()
      )
    ).toBe('working')
  })
})

describe('T92 freshness: the stuck timer anchors to max(transcript, last event)', () => {
  it('a fresh hook event keeps a working session alive even when the transcript is stale', () => {
    // transcript quiet ≥ N, but a hook event just fired → still working
    const s = sig({
      taskState: 'working',
      status: 'idle',
      modifiedMs: quietFor(STUCK_AFTER_MS),
      lastEventMs: NOW
    })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('a fresh transcript keeps it alive even when the last event is stale', () => {
    const s = sig({
      taskState: 'working',
      status: 'idle',
      modifiedMs: NOW,
      lastEventMs: quietFor(STUCK_AFTER_MS)
    })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('BOTH anchors stale ≥ N → stuck', () => {
    const s = sig({
      taskState: 'working',
      status: 'idle',
      modifiedMs: quietFor(STUCK_AFTER_MS),
      lastEventMs: quietFor(STUCK_AFTER_MS)
    })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('NaN transcript but a fresh event → working (event anchor rescues the NaN)', () => {
    const s = sig({ taskState: 'working', status: 'idle', modifiedMs: NaN, lastEventMs: NOW })
    expect(resolveActivity(s, ctx())).toBe('working')
  })
})

describe('T175/T176: stagnation OR-branch — the noisy stall the silence timer alone cannot see', () => {
  const stagnantVerdict = {
    stagnant: true,
    calls: 10,
    distinct: 1,
    topTarget: 'Bash: npm test',
    topCount: 10
  }
  const busyNotStagnantVerdict = {
    stagnant: false,
    calls: 8,
    distinct: 8,
    topTarget: '',
    topCount: 0
  }

  it('the entire point of the change: stagnant + FRESH modifiedMs (the silence rule would say working) → stuck', () => {
    // modifiedMs is NOW — the old silence-only rule would never fire here.
    const s = sig({ taskState: 'working', modifiedMs: NOW, stagnation: stagnantVerdict })
    expect(resolveActivity(s, ctx())).toBe('stuck')
  })

  it('genuinely novel work at the same call volume is NOT flagged (stagnant: false passes through)', () => {
    const s = sig({ taskState: 'working', modifiedMs: NOW, stagnation: busyNotStagnantVerdict })
    expect(resolveActivity(s, ctx())).toBe('working')
  })

  it('no stagnation signal at all (undefined) behaves exactly as before — silence rule alone decides', () => {
    expect(
      resolveActivity(sig({ taskState: 'working', modifiedMs: NOW, stagnation: undefined }), ctx())
    ).toBe('working')
    expect(
      resolveActivity(
        sig({ taskState: 'working', modifiedMs: quietFor(STUCK_AFTER_MS), stagnation: undefined }),
        ctx()
      )
    ).toBe('stuck')
  })

  it('stagnation applies uniformly across every activity source (hook / registry / transcript)', () => {
    // Level 2: PID registry, no hooks.
    expect(
      resolveActivity(
        sig({
          taskState: undefined,
          registryState: 'working',
          modifiedMs: NOW,
          stagnation: stagnantVerdict
        }),
        ctx()
      )
    ).toBe('stuck')
    // Level 3: transcript turn-over state, no hooks/registry, alive.
    expect(
      resolveActivity(
        sig({
          taskState: undefined,
          registryState: undefined,
          transcriptState: 'working',
          isLive: true,
          modifiedMs: NOW,
          stagnation: stagnantVerdict
        }),
        ctx()
      )
    ).toBe('stuck')
  })

  it('classifyFleetState surfaces the stagnant verdict as stuck end-to-end (the full taxonomy)', () => {
    const s = sig({ taskState: 'working', modifiedMs: NOW, stagnation: stagnantVerdict })
    expect(classifyFleetState(s, ctx())).toBe('stuck')
  })

  it('needs-you still outranks a stagnant verdict — attention layers on top of activity', () => {
    const s = sig({ taskState: 'needs-input', stagnation: stagnantVerdict })
    expect(classifyFleetState(s, ctx())).toBe('needs-you')
  })

  it(
    'END-TO-END (the AC): a real transcript of 11 identical failing Bash calls, run through ' +
      'the actual deriveStagnation fold, classifies stuck while modifiedMs is still advancing — ' +
      'the OLD silence-only rule alone would say working here',
    () => {
      let uid = 0
      const entry = (
        name: string,
        input: Record<string, unknown>,
        tsMs: number
      ): TranscriptEntry => ({
        type: 'assistant',
        uuid: `uuid-${++uid}`,
        timestamp: new Date(tsMs).toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] }
      })
      const t0 = Date.parse('2026-07-22T12:00:00Z')
      const entries = [
        entry('Bash', { command: 'npm test' }, t0), // prior — establishes the target
        ...Array.from({ length: 10 }, (_, i) =>
          entry('Bash', { command: 'npm test' }, t0 + 400_000 + i * 10_000)
        )
      ]
      const verdict = deriveStagnation(entries)
      expect(verdict.stagnant).toBe(true) // the real detector, not a hand-built fixture

      // The transcript is still being appended to RIGHT NOW (modifiedMs === NOW):
      // the old silence rule sees zero quiet time and would say `working`.
      const s = sig({ taskState: 'working', modifiedMs: NOW, stagnation: verdict })
      expect(resolveActivity(s, ctx())).toBe('stuck')

      // Proof the silence rule genuinely would NOT have fired on its own: strip
      // the stagnation signal and the same fresh modifiedMs reads `working`.
      expect(resolveActivity(sig({ taskState: 'working', modifiedMs: NOW }), ctx())).toBe('working')
    }
  )
})

describe('STUCK_AFTER_MS', () => {
  it('is 3 minutes (documented threshold N)', () => {
    expect(STUCK_AFTER_MS).toBe(180_000)
  })
})
