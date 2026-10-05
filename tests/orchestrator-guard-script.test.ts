import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decide, isAllowedSurface, targetPathFor } from '../resources/orchestrator-guard/guard.mjs'

/**
 * T109 §2 — the pure decision core of the standalone hook script (plain ESM,
 * zero deps, imported directly since it never goes through a TS build step).
 * The 5-branch decision matrix + fail-open on any internal error is the
 * load-bearing contract: a broken guard must degrade to "normal session"
 * (spec §0), never to a stuck/bricked Claude Code session.
 */

const FOLDER = '/repo/harnu'
const ARMED = { s1: { folder: FOLDER, armedAt: 1 } }

describe('targetPathFor', () => {
  it('reads file_path for Edit/Write', () => {
    expect(targetPathFor('Edit', { file_path: '/a/b.ts' }, '/cwd')).toBe('/a/b.ts')
    expect(targetPathFor('Write', { file_path: '/a/b.ts' }, '/cwd')).toBe('/a/b.ts')
  })

  it('reads notebook_path for NotebookEdit', () => {
    expect(targetPathFor('NotebookEdit', { notebook_path: '/a/b.ipynb' }, '/cwd')).toBe(
      '/a/b.ipynb'
    )
  })

  it('resolves a relative path against cwd', () => {
    expect(targetPathFor('Edit', { file_path: 'b.ts' }, '/a')).toBe('/a/b.ts')
  })

  it('normalizes away a `..` traversal so an escape out of an allowed surface cannot hide behind it', () => {
    expect(targetPathFor('Edit', { file_path: '/tmp/claude-x/../../etc/passwd' }, '/cwd')).toBe(
      '/etc/passwd'
    )
  })

  it('returns null when the expected field is missing or blank', () => {
    expect(targetPathFor('Edit', {}, '/cwd')).toBeNull()
    expect(targetPathFor('Edit', { file_path: '' }, '/cwd')).toBeNull()
    expect(targetPathFor('NotebookEdit', { file_path: '/a/b.ts' }, '/cwd')).toBeNull()
  })
})

describe('isAllowedSurface', () => {
  it('allows the repo .harnu/ dir (AC-2)', () => {
    expect(isAllowedSurface(join(FOLDER, '.harnu', 'memory', 'hot.md'), FOLDER)).toBe(true)
    expect(isAllowedSurface(join(FOLDER, '.harnu'), FOLDER)).toBe(true)
  })

  it('still allows the legacy .capy/ dir — a stale session may keep writing there (AC-2)', () => {
    expect(isAllowedSurface(join(FOLDER, '.capy', 'memory', 'hot.md'), FOLDER)).toBe(true)
    expect(isAllowedSurface(join(FOLDER, '.capy'), FOLDER)).toBe(true)
  })

  it('does not false-positive on siblings sharing either prefix', () => {
    expect(isAllowedSurface(join(FOLDER, '.harnux', 'evil.ts'), FOLDER)).toBe(false)
    expect(isAllowedSurface(join(FOLDER, '.capybara', 'evil.ts'), FOLDER)).toBe(false)
  })

  it('denies product source in the same repo', () => {
    expect(isAllowedSurface(join(FOLDER, 'src', 'main', 'index.ts'), FOLDER)).toBe(false)
  })

  it('does not false-positive on a sibling dir sharing the .capy prefix', () => {
    expect(isAllowedSurface('/repo/harnu/.harnux/evil.ts', FOLDER)).toBe(false)
  })

  it('allows /tmp/claude-* scratchpads', () => {
    expect(isAllowedSurface('/tmp/claude-1000/abc/scratch.txt', FOLDER)).toBe(true)
    expect(isAllowedSurface('/tmp/claude-xyz', FOLDER)).toBe(true)
  })

  it('does not false-positive on a sibling dir sharing only the "claude" substring', () => {
    expect(isAllowedSurface('/tmp/claudexploit/x', FOLDER)).toBe(false)
  })

  it('allows ~/.claude/projects/*/memory/', () => {
    const p = join(homedir(), '.claude', 'projects', 'some-slug', 'memory', 'MEMORY.md')
    expect(isAllowedSurface(p, FOLDER)).toBe(true)
  })

  it('denies ~/.claude/projects/*/ outside memory/', () => {
    const p = join(homedir(), '.claude', 'projects', 'some-slug', 'session.jsonl')
    expect(isAllowedSurface(p, FOLDER)).toBe(false)
  })

  it('denies an unrelated absolute path', () => {
    expect(isAllowedSurface('/etc/passwd', FOLDER)).toBe(false)
  })

  it('denies when folder is missing (no data-dir surface to allow)', () => {
    expect(isAllowedSurface('/tmp/other/file.txt', undefined)).toBe(false)
  })
})

describe('decide (§2 decision matrix, 5 branches)', () => {
  it('branch 1: agent_id present -> allow, even for an unarmed/unsurfaced path', () => {
    const payload = {
      agent_id: 'agent-42',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/harnu/src/main/index.ts' },
      cwd: '/repo/harnu'
    }
    expect(decide(payload, ARMED)).toEqual({ decision: 'allow' })
  })

  it('branch 1: camelCase agentId is also honored', () => {
    const payload = { agentId: 'agent-42', session_id: 's1', tool_name: 'Edit', tool_input: {} }
    expect(decide(payload, ARMED)).toEqual({ decision: 'allow' })
  })

  it('branch 2: session_id not armed -> allow, even for a product-source write', () => {
    const payload = {
      session_id: 'unarmed-session',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/harnu/src/main/index.ts' },
      cwd: '/repo/harnu'
    }
    expect(decide(payload, ARMED)).toEqual({ decision: 'allow' })
  })

  it('branch 2: no armed map at all -> allow', () => {
    const payload = {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/harnu/src/main/index.ts' },
      cwd: '/repo/harnu'
    }
    expect(decide(payload, undefined)).toEqual({ decision: 'allow' })
  })

  it.each(['.harnu', '.capy'])('branch 3: armed session writing inside %s/ -> allow', (dir) => {
    const payload = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: join(FOLDER, dir, 'memory', 'notes.md') },
      cwd: FOLDER
    }
    expect(decide(payload, ARMED)).toEqual({ decision: 'allow' })
  })

  it('a `..` traversal out of an allowed surface is normalized and denied, not allowed', () => {
    const payload = {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/claude-1000/../../etc/passwd' },
      cwd: '/tmp/claude-1000'
    }
    expect(decide(payload, ARMED).decision).toBe('deny')
  })

  it('branch 4: armed session writing product code -> deny with a steering reason', () => {
    const payload = {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: join(FOLDER, 'src', 'main', 'index.ts') },
      cwd: FOLDER
    }
    const result = decide(payload, ARMED)
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('docs/harnu-orchestrator.md')
  })

  it('branch 5: an internal throw during decision degrades to allow + logs an error', () => {
    // A getter that throws when read simulates a malformed payload accessor.
    const evilPayload = {
      get session_id() {
        throw new Error('boom')
      }
    }
    const result = decide(evilPayload, ARMED)
    expect(result.decision).toBe('allow')
    expect(result.error).toContain('boom')
  })

  it('an unresolvable target path degrades to allow + logs, rather than denying', () => {
    const payload = { session_id: 's1', tool_name: 'Edit', tool_input: {}, cwd: FOLDER }
    const result = decide(payload, ARMED)
    expect(result.decision).toBe('allow')
    expect(result.error).toBeTruthy()
  })

  it('a corrupt/garbage armed value behaves like "not armed" (fail-open, AC-3)', () => {
    const payload = {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: join(FOLDER, 'src', 'main', 'index.ts') },
      cwd: FOLDER
    }
    expect(decide(payload, 'not-an-object').decision).toBe('allow')
    expect(decide(payload, null).decision).toBe('allow')
    expect(decide(payload, 42).decision).toBe('allow')
  })
})
