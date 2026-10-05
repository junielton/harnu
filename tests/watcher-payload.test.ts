import { describe, it, expect } from 'vitest'
import { buildSessionUpdate, buildSubagentUpdate, readAgentMeta } from '../src/main/claude-watcher'

const MAX_EVENT_BYTES = 16 * 1024
const bytes = (p: unknown): number => Buffer.byteLength(JSON.stringify(p))

const big = 'x'.repeat(5 * 1024 * 1024)
const lines = [
  {
    type: 'user',
    message: { role: 'user', content: '<system-reminder>noise</system-reminder>real question here' }
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'm',
      stop_reason: 'end_turn',
      content: [{ type: 'tool_result', content: big }]
    }
  },
  { type: 'custom-title', customTitle: 'Renamed' },
  { type: 'ai-title', aiTitle: 'AI title' }
]

describe('session:updated payload (AC-20)', () => {
  it('carries no newLines and serializes under 16 KB even with a 5 MB tool output', () => {
    const p = buildSessionUpdate('slug', 'sid', lines)
    expect('newLines' in p).toBe(false)
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EVENT_BYTES)
    expect(p.renameTitle).toBe('Renamed')
    expect(p.aiTitle).toBe('AI title')
  })

  // Parity with the renderer mirror this replaced (`lib/first-prompt.ts`, now
  // deleted) is pinned as the frozen value that mirror produced for `lines`.
  it('firstPromptCandidate matches what the renderer mirror produced', () => {
    expect(buildSessionUpdate('s', 'i', lines).firstPromptCandidate).toBe('real question here')
  })

  it('firstPromptCandidate skips sidechain and non-user lines, and resolves a slash command', () => {
    const user = (text: string, extra: object = {}): object => ({
      type: 'user',
      message: { role: 'user', content: text },
      ...extra
    })
    expect(
      buildSessionUpdate('s', 'i', [
        { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
        user('side', { isSidechain: true }),
        user('real one')
      ]).firstPromptCandidate
    ).toBe('real one')
    expect(
      buildSessionUpdate('s', 'i', [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<command-name>usage</command-name>' }]
          }
        }
      ]).firstPromptCandidate
    ).toBe('usage')
  })

  it('stays under 16 KB when every string field is pathologically large', () => {
    const huge = '"\n'.repeat(200_000)
    const p = buildSessionUpdate('slug', 'sid', [
      { type: 'user', message: { role: 'user', content: huge } },
      { type: 'custom-title', customTitle: huge },
      { type: 'ai-title', aiTitle: huge },
      { type: 'system', subtype: 'away_summary', content: huge }
    ])
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EVENT_BYTES)
    expect(p.renameTitle?.length).toBeGreaterThan(0)
    expect(p.awaySummary?.length).toBeGreaterThan(0)
  })

  it('accepts the legacy `title` field of a custom-title line, latest rename wins', () => {
    const p = buildSessionUpdate('s', 'i', [
      { type: 'custom-title', customTitle: 'First' },
      { type: 'custom-title', title: 'Legacy title' }
    ])
    expect(p.renameTitle).toBe('Legacy title')
  })

  it('omits firstPromptCandidate when the delta has no real user prompt', () => {
    const p = buildSessionUpdate('s', 'i', [
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'side' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } }
    ])
    expect('firstPromptCandidate' in p).toBe(false)
  })

  it('readAgentMeta keeps the first defined value per field', () => {
    const m = readAgentMeta([
      { attributionAgent: 'general-purpose', type: 'user', message: { content: 'the task' } },
      { attributionAgent: 'other', type: 'assistant', message: { model: 'm1' } }
    ])
    expect(m).toEqual({ agentType: 'general-purpose', model: 'm1', task: 'the task' })
  })
})

describe('subagent:updated payload (AC-20)', () => {
  it('carries meta instead of newLines and stays under 16 KB', () => {
    const p = buildSubagentUpdate('slug', 'parent', 'agent-1', [
      { attributionAgent: 'general-purpose', type: 'user', message: { content: big } },
      { type: 'assistant', message: { model: 'm1', content: [{ type: 'text', text: big }] } }
    ])
    expect('newLines' in p).toBe(false)
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EVENT_BYTES)
    expect(p).toMatchObject({
      slug: 'slug',
      parentSessionId: 'parent',
      agentId: 'agent-1',
      meta: { agentType: 'general-purpose', model: 'm1' }
    })
  })
})
