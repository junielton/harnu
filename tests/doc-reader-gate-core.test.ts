import { describe, it, expect } from 'vitest'
import {
  decideDocRead,
  gateHookOutput,
  parseMinLines,
  wholeFileReadTarget,
  DOC_READER_DEFAULT_MIN_LINES,
  type GateInput,
  type GateOptions
} from '../src/main/doc-reader/gate-core'

/**
 * T1 spike, eval layer 1: the doc-reader read gate's routing decisions. These cases mirror
 * shunt's hook evals and add the cases shunt gets wrong for docs: a subagent's reads, and
 * targeted `head`/`tail` reads.
 */

const sizes: Record<string, number> = {
  '/repo/docs/big.md': 1200,
  '/repo/docs/small.md': 40,
  '/repo/docs/edge.md': 350,
  '/repo/notes/BIG.MARKDOWN': 900,
  '/repo/src/big.ts': 5000,
  '/repo/README.txt': 600
}

const opts: GateOptions = {
  minLines: 350,
  countLines: (p) => sizes[p] ?? null,
  agentName: 'harnu:doc-reader'
}

const read = (file_path: string, extra: Record<string, unknown> = {}): GateInput => ({
  tool_name: 'Read',
  tool_input: { file_path, ...extra },
  cwd: '/repo'
})
const bash = (command: string): GateInput => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd: '/repo'
})

describe('decideDocRead — Read', () => {
  it('denies a full read of a large doc and names the agent and the escape hatch', () => {
    const d = decideDocRead(read('/repo/docs/big.md'), opts)
    expect(d.action).toBe('deny')
    if (d.action !== 'deny') return
    expect(d.lines).toBe(1200)
    expect(d.reason).toContain('harnu:doc-reader')
    expect(d.reason).toContain('offset and limit')
  })

  it('allows a small doc, and a doc exactly at the threshold', () => {
    expect(decideDocRead(read('/repo/docs/small.md'), opts)).toEqual({
      action: 'allow',
      why: 'small'
    })
    expect(decideDocRead(read('/repo/docs/edge.md'), opts)).toEqual({
      action: 'allow',
      why: 'small'
    })
  })

  it('allows a targeted read (offset or limit) of a large doc', () => {
    expect(decideDocRead(read('/repo/docs/big.md', { offset: 100 }), opts).action).toBe('allow')
    expect(decideDocRead(read('/repo/docs/big.md', { limit: 50 }), opts).action).toBe('allow')
  })

  it('leaves code files alone in v1, however large', () => {
    expect(decideDocRead(read('/repo/src/big.ts'), opts)).toEqual({
      action: 'allow',
      why: 'not-a-doc'
    })
  })

  it('matches doc extensions case-insensitively', () => {
    expect(decideDocRead(read('/repo/notes/BIG.MARKDOWN'), opts).action).toBe('deny')
  })

  it('resolves a relative path against the hook cwd', () => {
    expect(decideDocRead(read('docs/big.md'), opts).action).toBe('deny')
  })

  it('fails open on a missing file or a malformed payload', () => {
    expect(decideDocRead(read('/repo/docs/nope.md'), opts)).toEqual({
      action: 'allow',
      why: 'missing'
    })
    expect(decideDocRead({ tool_name: 'Read', tool_input: {} }, opts).action).toBe('allow')
    expect(decideDocRead({ tool_name: 'Read' }, opts).action).toBe('allow')
    expect(decideDocRead({}, opts).action).toBe('allow')
  })

  it("allows every subagent's reads, the doc-reader's own included", () => {
    const sub = { ...read('/repo/docs/big.md'), agent_id: 'a1', agent_type: 'harnu:doc-reader' }
    expect(decideDocRead(sub, opts)).toEqual({ action: 'allow', why: 'subagent' })
    const explore = { ...read('/repo/docs/big.md'), agent_id: 'a2', agent_type: 'Explore' }
    expect(decideDocRead(explore, opts).action).toBe('allow')
  })

  it('ignores tools other than Read and Bash', () => {
    const grep = { tool_name: 'Grep', tool_input: { path: '/repo/docs/big.md' }, cwd: '/repo' }
    expect(decideDocRead(grep, opts)).toEqual({ action: 'allow', why: 'not-a-read' })
  })
})

describe('decideDocRead — Bash', () => {
  it('denies cat/less/more of a large doc, with or without flags or quotes', () => {
    expect(decideDocRead(bash('cat docs/big.md'), opts).action).toBe('deny')
    expect(decideDocRead(bash('cat -n /repo/docs/big.md'), opts).action).toBe('deny')
    expect(decideDocRead(bash("less 'docs/big.md'"), opts).action).toBe('deny')
    expect(decideDocRead(bash('more "README.txt"'), opts).action).toBe('deny')
  })

  it('allows targeted commands that shunt would have blocked', () => {
    for (const c of ['head -50 docs/big.md', 'tail docs/big.md', "sed -n '1,40p' docs/big.md"])
      expect(decideDocRead(bash(c), opts).action).toBe('allow')
  })

  it('allows pipes, redirects, chains and substitutions', () => {
    for (const c of [
      'cat docs/big.md | grep foo',
      'cat docs/big.md > /tmp/x',
      'cat docs/big.md && echo done',
      'cat $(ls docs/big.md)',
      'cat docs/big.md docs/small.md'
    ])
      expect(decideDocRead(bash(c), opts).action).toBe('allow')
  })

  it('allows cat of a small doc or a code file', () => {
    expect(decideDocRead(bash('cat docs/small.md'), opts).action).toBe('allow')
    expect(decideDocRead(bash('cat src/big.ts'), opts).action).toBe('allow')
  })
})

describe('wholeFileReadTarget', () => {
  it('returns the single operand of a whole-file command', () => {
    expect(wholeFileReadTarget('cat a.md')).toBe('a.md')
    expect(wholeFileReadTarget('  bat -p "a b.md"  ')).toBeNull() // a space inside quotes is not parsed
    expect(wholeFileReadTarget('echo a.md')).toBeNull()
    expect(wholeFileReadTarget('')).toBeNull()
  })
})

describe('parseMinLines', () => {
  it('accepts a positive integer and falls back to the default otherwise', () => {
    expect(parseMinLines('500')).toBe(500)
    expect(parseMinLines(' 80 ')).toBe(80)
    for (const bad of [undefined, '', 'abc', '-5', '0', '3.5'])
      expect(parseMinLines(bad)).toBe(DOC_READER_DEFAULT_MIN_LINES)
  })
})

describe('gateHookOutput', () => {
  it('prints an empty object to allow, and a PreToolUse deny to block', () => {
    expect(gateHookOutput({ action: 'allow', why: 'small' })).toBe('{}')
    const out = JSON.parse(gateHookOutput(decideDocRead(read('/repo/docs/big.md'), opts)))
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('1200 lines')
  })
})
