import { describe, it, expect } from 'vitest'
import { reactive, isReactive } from 'vue'
import { resolveSpawnSpec, toPlainBootOverride } from '../src/renderer/src/components/spawn-spec'
import type { Session } from '../src/renderer/src/stores/sessions'
import type { ClaudeBootConfig } from '../src/preload'

/**
 * The renderer half of "the config gets applied": `resolveSpawnSpec` decides
 * what to launch and snapshots the per-session bootOverride into a PLAIN object
 * (no Vue Proxy) so it survives Electron's structured-clone IPC — the exact
 * "An object could not be cloned" regression. Paired with
 * `claude-config.test.ts` (override → argv), this covers the chain end to end.
 */

function makeSession(over: Partial<Session>): Session {
  return {
    sessionId: 'synthetic-abc',
    fullPath: '',
    fileMtime: 0,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '',
    modified: '',
    gitBranch: '',
    projectPath: '/repo/foo',
    isSidechain: false,
    status: 'active',
    resumable: true,
    bridged: false,
    ...over
  }
}

describe('resolveSpawnSpec', () => {
  it('unknown id → bare shell', () => {
    expect(resolveSpawnSpec(undefined, 'x')).toEqual({ kind: 'shell' })
  })

  it('folder terminal → bare shell (checked before any claude branch)', () => {
    const s = makeSession({ sessionId: 'shellterm-1', isShellTerminal: true, synthetic: false })
    expect(resolveSpawnSpec(s, 'shellterm-1')).toEqual({ kind: 'shell' })
  })

  it('isShellTerminal wins over a stray synthetic/fork flag combo (explicit marker)', () => {
    // Defensive: a terminal should never be mistaken for a resumable/forkable
    // Claude session even if other flags somehow coexist.
    const s = makeSession({
      sessionId: 'shellterm-2',
      isShellTerminal: true,
      synthetic: true,
      forkSourceId: 'src'
    })
    expect(resolveSpawnSpec(s, 'shellterm-2')).toEqual({ kind: 'shell' })
  })

  it('real entry → claude --resume <uuid>', () => {
    const s = makeSession({ sessionId: 'uuid-1', synthetic: false })
    expect(resolveSpawnSpec(s, 'uuid-1')).toEqual({
      kind: 'claude-resume',
      claudeSessionId: 'uuid-1'
    })
  })

  it('real entry with a remoteControl bootOverride → forwards a plain snapshot on resume (RC-UI)', () => {
    // The Remote Control toggle (RC-UI) marks the live entry's bootOverride;
    // the resume respawn must carry it so `claude --resume` relaunches with
    // `--remote-control`. The snapshot must be a plain, clonable object.
    const reactiveOverride = reactive<ClaudeBootConfig>({ remoteControl: true })
    const s = makeSession({ sessionId: 'uuid-1', synthetic: false, bootOverride: reactiveOverride })
    const spec = resolveSpawnSpec(s, 'uuid-1')
    expect(spec.kind).toBe('claude-resume')
    expect(spec.claudeSessionId).toBe('uuid-1')
    expect(spec.bootOverride).toEqual({ remoteControl: true })
    expect(isReactive(spec.bootOverride)).toBe(false)
    expect(() => structuredClone(spec.bootOverride)).not.toThrow()
  })

  it('real entry with no bootOverride → resume spec leaves bootOverride undefined', () => {
    const s = makeSession({ sessionId: 'uuid-1', synthetic: false })
    expect(resolveSpawnSpec(s, 'uuid-1').bootOverride).toBeUndefined()
  })

  // BUG: the boot prompt is one-shot, but it lives on a PERSISTENT field. It is
  // written to the synthetic's bootOverride at dispatch, survives the in-place
  // synth→real migrate (same object) and every disk reconcile (bootOverride is in
  // RENDERER_ONLY_SESSION_KEYS) — so forwarding it on resume replayed the prompt on
  // every respawn: waking from hibernation, or closing and reopening the tab.
  it('real entry → resume spec DROPS the one-shot prePrompt (never replayed on respawn)', () => {
    const s = makeSession({
      sessionId: 'uuid-1',
      synthetic: false,
      bootOverride: { prePrompt: 'Review PR #42 and report back' }
    })
    const spec = resolveSpawnSpec(s, 'uuid-1')
    expect(spec.kind).toBe('claude-resume')
    // Nothing left to override → no override at all, exactly like a cold disk session.
    expect(spec.bootOverride).toBeUndefined()
  })

  it('real entry → resume keeps the durable override keys while dropping prePrompt', () => {
    const s = makeSession({
      sessionId: 'uuid-1',
      synthetic: false,
      bootOverride: { remoteControl: true, model: 'opus', prePrompt: 'boot me' }
    })
    const spec = resolveSpawnSpec(s, 'uuid-1')
    expect(spec.bootOverride).toEqual({ remoteControl: true, model: 'opus' })
    expect(() => structuredClone(spec.bootOverride)).not.toThrow()
  })

  it('plain synthetic KEEPS prePrompt — the first boot is what delivers it', () => {
    const s = makeSession({ synthetic: true, bootOverride: { prePrompt: 'boot me' } })
    const spec = resolveSpawnSpec(s, 'synthetic-abc')
    expect(spec.kind).toBe('claude-new')
    expect(spec.bootOverride).toEqual({ prePrompt: 'boot me' })
  })

  it('fork synthetic → claude-fork from the source uuid (no bootOverride)', () => {
    const s = makeSession({ synthetic: true, forkSourceId: 'src-uuid' })
    expect(resolveSpawnSpec(s, 'synthetic-abc')).toEqual({
      kind: 'claude-fork',
      claudeSessionId: 'src-uuid'
    })
  })

  it('plain synthetic with no override → claude-new, bootOverride undefined', () => {
    const s = makeSession({ synthetic: true })
    expect(resolveSpawnSpec(s, 'synthetic-abc')).toEqual({
      kind: 'claude-new',
      bootOverride: undefined
    })
  })

  it('plain synthetic carries its launch override as a PLAIN, cloneable object', () => {
    // Simulate the Pinia-reactive synthetic: bootOverride read back is a Proxy.
    const reactiveOverride = reactive<ClaudeBootConfig>({
      model: 'sonnet',
      chrome: true,
      addDirs: ['/x', '/y']
    })
    expect(isReactive(reactiveOverride)).toBe(true)

    const spec = resolveSpawnSpec(
      makeSession({ synthetic: true, bootOverride: reactiveOverride }),
      'synthetic-abc'
    )

    expect(spec.kind).toBe('claude-new')
    // The override survived…
    expect(spec.bootOverride).toEqual({ model: 'sonnet', chrome: true, addDirs: ['/x', '/y'] })
    // …as a plain object (no reactivity), so the IPC structured clone can't choke.
    expect(isReactive(spec.bootOverride)).toBe(false)
    expect(() => structuredClone(spec.bootOverride)).not.toThrow()
  })

  // BLOCKER-1: the agentControlled marker MUST reach the spawn spec, or main's
  // withhold-mcp-config + force-downgrade (pty.ts) never fires for agent sessions.
  it('agent-created synthetic → claude-new carries agentControlled:true', () => {
    const spec = resolveSpawnSpec(
      makeSession({ synthetic: true, agentControlled: true }),
      'synthetic-abc'
    )
    expect(spec.kind).toBe('claude-new')
    expect(spec.agentControlled).toBe(true)
  })

  it('agent-created fork synthetic → claude-fork carries agentControlled:true', () => {
    const s = makeSession({ synthetic: true, forkSourceId: 'src', agentControlled: true })
    const spec = resolveSpawnSpec(s, 'synthetic-abc')
    expect(spec.kind).toBe('claude-fork')
    expect(spec.agentControlled).toBe(true)
  })

  it('a USER synthetic is never agentControlled (no privileged/Conductor spawn for human sessions)', () => {
    expect(
      resolveSpawnSpec(makeSession({ synthetic: true }), 'synthetic-abc').agentControlled
    ).toBeUndefined()
  })

  // T337 AC-7: a session an older build persisted with the now-removed it2
  // "Host agent teams in Harnu" LEAD-TOGGLE (`hostTeammates`/`hostRootGuid`)
  // must still resolve safely — `resolveSpawnSpec` no longer knows those
  // fields at all, so they are silently ignored rather than read. This
  // assertion is deliberately agnostic to whether `hostTeammates`/`hostRootGuid`
  // end up on the resolved spec, so it stays green whether or not the
  // (now-removed) forwarding code is present — it pins the no-crash / correct-
  // kind contract across the removal, not the removed behavior itself.
  it("legacy hostTeammates:true + hostRootGuid on a session entry (an older build's data) never throws and still resumes as a plain claude session", () => {
    const legacy = {
      ...makeSession({ sessionId: 'uuid-legacy', synthetic: false }),
      // Not part of `Session` anymore — kept via a loose cast to simulate
      // stale in-memory/disk-shaped data from before the purge.
      hostTeammates: true,
      hostRootGuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
    } as unknown as Session
    expect(() => resolveSpawnSpec(legacy, 'uuid-legacy')).not.toThrow()
    const spec = resolveSpawnSpec(legacy, 'uuid-legacy')
    expect(spec.kind).toBe('claude-resume')
    expect(spec.claudeSessionId).toBe('uuid-legacy')
  })
})

describe('resolveSpawnSpec — session mode (T123)', () => {
  it('carries the entry mode onto the spawn spec', () => {
    const entry = { id: 'synthetic-1', isNew: true, mode: 'learning' } as never
    expect(resolveSpawnSpec(entry, 'synthetic-1').mode).toBe('learning')
  })

  it('leaves mode undefined for a normal session', () => {
    const entry = { id: 'synthetic-1', isNew: true } as never
    expect(resolveSpawnSpec(entry, 'synthetic-1').mode).toBeUndefined()
  })

  it('plain synthetic with mode: learning → claude-new carries mode', () => {
    const s = makeSession({ synthetic: true, mode: 'learning' })
    const spec = resolveSpawnSpec(s, 'synthetic-abc')
    expect(spec.kind).toBe('claude-new')
    expect(spec.mode).toBe('learning')
  })

  it('fork synthetic with mode: learning → claude-fork carries mode', () => {
    const s = makeSession({ synthetic: true, forkSourceId: 'src-uuid', mode: 'learning' })
    const spec = resolveSpawnSpec(s, 'synthetic-abc')
    expect(spec.kind).toBe('claude-fork')
    expect(spec.mode).toBe('learning')
  })
})

describe('toPlainBootOverride', () => {
  it('undefined / empty → undefined', () => {
    expect(toPlainBootOverride(undefined)).toBeUndefined()
    expect(toPlainBootOverride({})).toBeUndefined()
  })

  it('deep-copies a reactive override into a plain, lossless snapshot', () => {
    const r = reactive<ClaudeBootConfig>({ effort: 'high', allowedTools: ['Bash', 'Edit'] })
    const plain = toPlainBootOverride(r)
    expect(plain).toEqual({ effort: 'high', allowedTools: ['Bash', 'Edit'] })
    expect(isReactive(plain)).toBe(false)
    // Nested array is a fresh copy, not the reactive one.
    expect(isReactive(plain!.allowedTools)).toBe(false)
  })
})

describe('resolveSpawnSpec — the T215 ownership marker', () => {
  it("forwards spawnedBy:'agent' on a plain synthetic (MCP create_session)", () => {
    const s = makeSession({ synthetic: true, spawnedBy: 'agent' })
    expect(resolveSpawnSpec(s, 'synthetic-abc').spawnedBy).toBe('agent')
  })

  it("forwards spawnedBy:'operator' on a plain synthetic (+ New session)", () => {
    const s = makeSession({ synthetic: true, spawnedBy: 'operator' })
    expect(resolveSpawnSpec(s, 'synthetic-abc').spawnedBy).toBe('operator')
  })

  it('forwards it on a FORK synthetic', () => {
    const s = makeSession({ synthetic: true, forkSourceId: 'src-1', spawnedBy: 'operator' })
    expect(resolveSpawnSpec(s, 'synthetic-abc').spawnedBy).toBe('operator')
  })

  it('forwards it on a REAL disk resume — the case that matters most', () => {
    // A parked agent session is resumed as `claude-resume`. If the marker were
    // dropped on this branch, waking it (or just reopening its tab) would make
    // it look operator-owned and silently take it out of message_session\'s
    // reach — a regression with no visible symptom except a refusal.
    const s = makeSession({ sessionId: 'real-1', spawnedBy: 'agent' })
    const spec = resolveSpawnSpec(s, 'real-1')
    expect(spec.kind).toBe('claude-resume')
    expect(spec.spawnedBy).toBe('agent')
  })

  it('omits the key entirely when the entry carries no origin', () => {
    // A cold transcript that predates the marker: the spawn SITE supplies the
    // gesture fallback, and main fails closed to 'operator'. An explicit
    // `undefined` key would cross IPC as noise.
    const spec = resolveSpawnSpec(makeSession({ sessionId: 'real-1' }), 'real-1')
    expect('spawnedBy' in spec).toBe(false)
  })

  it('ignores a garbage origin rather than forwarding it', () => {
    const s = makeSession({ sessionId: 'real-1', spawnedBy: 'nonsense' as never })
    expect('spawnedBy' in resolveSpawnSpec(s, 'real-1')).toBe(false)
  })

  it('a folder terminal never carries an origin (it has no sessionKey at all)', () => {
    const s = makeSession({ sessionId: 'shellterm-1', isShellTerminal: true, spawnedBy: 'agent' })
    expect(resolveSpawnSpec(s, 'shellterm-1')).toEqual({ kind: 'shell' })
  })
})
