import { describe, it, expect } from 'vitest'
import {
  reduceDetect,
  classifyManifest,
  INITIAL_DETECT_STATE,
  type DetectState
} from '../src/main/detect/detect-orchestrate-core'
import { parseManifest } from '../src/main/detect/manifest-load-core'
import type { CompiledManifest } from '../src/main/detect/screen-detect-core'

/**
 * T8 (pure half) — `reduceDetect` is the per-session fusion of the leaf cores:
 * classify → matchManifest → mergeState → applyStickiness. The invariants pinned:
 *
 *   - an UNRECOGNIZED pane is a silent no-op (emit undefined), so a plain shell's
 *     heuristic dot is never touched;
 *   - a pane that WAS recognized and goes unrecognized REVERTS (emit null);
 *   - a first recognition emits the resolved state;
 *   - blocked is STICKY across an unchanged screen (no re-emit, no un-block);
 *   - identical frames emit undefined (no IPC chatter);
 *   - `blocked → needs-input` mapping flows through.
 */

const compile = (raw: unknown): CompiledManifest => {
  const r = parseManifest(raw)
  if (!r.ok) throw new Error(`bad test manifest: ${r.error}`)
  return r.manifest
}

const codex = compile({
  agent: 'codex',
  match: { titleRegex: 'Codex', contentAny: ['codex>'] },
  scan: { lines: 30 },
  rules: [
    { state: 'blocked', any: ['\\(y/N\\)', 'Allow this tool'] },
    { state: 'working', any: ['Esc to interrupt', 'Thinking', '⠋|⠙|⠹'] },
    { state: 'idle', any: ['^›\\s*$', 'Type your message'] }
  ],
  fallback: 'idle'
})

const aider = compile({
  agent: 'aider',
  match: { titleRegex: null, contentAny: ['aider>'], process: ['aider'] },
  rules: [{ state: 'working', any: ['Thinking'] }],
  fallback: 'idle'
})

const REGISTRY = [codex, aider]
const NOW = 1_700_000_000_000

/** Build a snapshot. */
const snap = (
  lines: string[],
  title: string | null = 'Codex',
  process: string | null = null
): { lines: string[]; title: string | null; process: string | null } => ({
  lines,
  title,
  process
})

describe('classifyManifest', () => {
  it('picks the first manifest that claims the pane', () => {
    expect(classifyManifest('Codex', [], REGISTRY)).toBe(codex)
    expect(classifyManifest(null, ['aider> '], REGISTRY)).toBe(aider)
  })

  it('returns null when no manifest claims the pane (plain shell)', () => {
    expect(classifyManifest('bash', ['user@host:~$ ls'], REGISTRY)).toBeNull()
  })

  it('claims by foreground process name even with neutral title + content (W6.1)', () => {
    // The aider banner scrolled off and there is no title — only the process
    // identifies it. classifyManifest's 4th arg is the foreground process.
    expect(classifyManifest('bash', ['some neutral output', '> '], REGISTRY, 'aider')).toBe(aider)
  })
})

describe('reduceDetect — process classifier keeps a scrolled-off agent recognized (W6.1)', () => {
  it('a neutral aider screen still resolves a state when the process is aider', () => {
    // No banner, no "aider>", no title — without `process` this would be a plain
    // shell (no-op). With process=aider it stays classified and falls to idle.
    const out = reduceDetect(
      INITIAL_DETECT_STATE,
      snap(['(no banner here anymore)', '> '], null, 'aider'),
      REGISTRY,
      NOW
    )
    expect(out.state.agent).toBe('aider')
    expect(out.emit).toBe('idle')
  })

  it('without the process signal the same neutral screen is unrecognized (no-op)', () => {
    const out = reduceDetect(
      INITIAL_DETECT_STATE,
      snap(['(no banner here anymore)', '> '], null, null),
      REGISTRY,
      NOW
    )
    expect(out.state.agent).toBeNull()
    expect(out.emit).toBeUndefined()
  })
})

describe('reduceDetect — unrecognized panes', () => {
  it('a never-recognized pane is a silent no-op (emit undefined)', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['$ ls'], 'bash'), REGISTRY, NOW)
    expect(out.emit).toBeUndefined()
    expect(out.state.agent).toBeNull()
    expect(out.state.taskState).toBeNull()
  })

  it('a pane that WAS recognized then goes unrecognized REVERTS (emit null)', () => {
    const prior: DetectState = { lines: ['codex> '], taskState: 'idle', agent: 'codex' }
    const out = reduceDetect(prior, snap(['$ '], 'bash'), REGISTRY, NOW)
    expect(out.emit).toBeNull()
    expect(out.state.taskState).toBeNull()
    expect(out.state.agent).toBeNull()
  })
})

describe('reduceDetect — recognition + state resolution', () => {
  it('first sighting of a working screen emits working', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['⠹ Thinking…']), REGISTRY, NOW)
    expect(out.emit).toBe('working')
    expect(out.state.agent).toBe('codex')
  })

  it('maps a blocked prompt to needs-input', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['Allow this tool? (y/N)']), REGISTRY, NOW)
    expect(out.emit).toBe('needs-input')
  })

  it('claims by content even when the title is absent', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['aider> Thinking'], null), REGISTRY, NOW)
    expect(out.emit).toBe('working')
    expect(out.state.agent).toBe('aider')
  })
})

describe('reduceDetect — explain trace (T12)', () => {
  it('reports the agent, resolved screen state, and the rule/pattern/line that fired', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['⠹ Thinking…']), REGISTRY, NOW)
    expect(out.explain).toBeDefined()
    expect(out.explain?.agent).toBe('codex')
    expect(out.explain?.screen).toBe('working')
    expect(out.explain?.match?.pattern).toBe('Thinking')
    expect(out.explain?.match?.line).toBe('⠹ Thinking…')
  })

  it('reports a null match when only the fallback applied', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['codex> neutral chatter']), REGISTRY, NOW)
    expect(out.explain?.agent).toBe('codex')
    expect(out.explain?.screen).toBe('idle') // fallback
    expect(out.explain?.match).toBeNull()
  })

  it('has no explain trace for an unrecognized pane', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, snap(['$ ls'], 'bash'), REGISTRY, NOW)
    expect(out.explain).toBeUndefined()
  })
})

describe('reduceDetect — change suppression + blocked stickiness', () => {
  it('an identical frame emits undefined (no IPC chatter)', () => {
    const prior: DetectState = { lines: ['⠹ Thinking…'], taskState: 'working', agent: 'codex' }
    const out = reduceDetect(prior, snap(['⠹ Thinking…']), REGISTRY, NOW)
    expect(out.emit).toBeUndefined()
  })

  it('holds needs-input while the screen is unchanged (spinner under a prompt)', () => {
    // Already blocked; a new snapshot whose normalized lines are identical must
    // not re-emit nor un-block.
    const prior: DetectState = {
      lines: ['Allow this tool? (y/N)'],
      taskState: 'needs-input',
      agent: 'codex'
    }
    const out = reduceDetect(prior, snap(['Allow this tool? (y/N)   ']), REGISTRY, NOW)
    expect(out.emit).toBeUndefined()
    expect(out.state.taskState).toBe('needs-input')
  })

  it('holds needs-input even if the manifest would now match working, until the screen changes', () => {
    // Contrived: prev blocked, but this frame’s content matches a working rule
    // while the NORMALIZED lines are unchanged from prev → stickiness holds.
    const prior: DetectState = {
      lines: ['⠹ Thinking…'],
      taskState: 'needs-input',
      agent: 'codex'
    }
    const out = reduceDetect(prior, snap(['⠹ Thinking…']), REGISTRY, NOW)
    expect(out.state.taskState).toBe('needs-input')
    expect(out.emit).toBeUndefined()
  })

  it('accepts the new state once the screen actually changes (prompt answered)', () => {
    const prior: DetectState = {
      lines: ['Allow this tool? (y/N)'],
      taskState: 'needs-input',
      agent: 'codex'
    }
    const out = reduceDetect(prior, snap(['⠹ Thinking…']), REGISTRY, NOW)
    expect(out.emit).toBe('working')
    expect(out.state.taskState).toBe('working')
  })

  it('working → idle flips freely on a real screen change', () => {
    const prior: DetectState = { lines: ['⠹ Thinking…'], taskState: 'working', agent: 'codex' }
    const out = reduceDetect(prior, snap(['› ']), REGISTRY, NOW)
    expect(out.emit).toBe('idle')
  })
})
