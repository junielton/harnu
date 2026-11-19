// tests/agent-rows.test.ts
// Label + grouping rules for the nested subagent rows in the sidebar
// (design.md §6 "Agent row (sidebar)").
import { describe, it, expect } from 'vitest'
import {
  agentRowLabel,
  agentTypeChip,
  splitAgentsByStatus,
  TASK_LABEL_MAX
} from '../src/renderer/src/lib/agent-rows'

const GENERIC = 'subagent'

describe('agentRowLabel (AC-1)', () => {
  it('prefers the meta.json description', () => {
    expect(
      agentRowLabel(
        { description: 'Verify U2d ACs and band fixes', task: 'You are a verifier…' },
        GENERIC
      )
    ).toBe('Verify U2d ACs and band fixes')
  })

  it('falls back to a one-line truncation of the task', () => {
    const task = 'First line of the task\nsecond   line\twith    spaces ' + 'x'.repeat(200)
    const label = agentRowLabel({ description: '', task }, GENERIC)
    expect(label).not.toMatch(/[\n\t]/)
    expect(label.startsWith('First line of the task second line with spaces')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(TASK_LABEL_MAX)
    expect(label.endsWith('…')).toBe(true)
  })

  it('keeps a short task untouched', () => {
    expect(agentRowLabel({ description: '  ', task: 'Short task' }, GENERIC)).toBe('Short task')
  })

  it('falls back to the generic label when there is neither', () => {
    expect(agentRowLabel({ description: '', task: '' }, GENERIC)).toBe(GENERIC)
    expect(agentRowLabel({ task: '   ' }, GENERIC)).toBe(GENERIC)
  })
})

describe('agentTypeChip (AC-2)', () => {
  it('returns the known agent type', () => {
    expect(agentTypeChip({ agentType: 'general-purpose' })).toBe('general-purpose')
  })

  it('is empty when unknown', () => {
    expect(agentTypeChip({ agentType: '' })).toBe('')
    expect(agentTypeChip({ agentType: '  ' })).toBe('')
  })

  it('never yields the word "subagent"', () => {
    expect(agentTypeChip({ agentType: 'subagent' })).toBe('')
    expect(agentTypeChip({ agentType: 'Subagent' })).toBe('')
  })
})

describe('splitAgentsByStatus (AC-3, AC-4)', () => {
  const mk = (
    id: string,
    status: 'running' | 'done'
  ): { agentId: string; status: 'running' | 'done' } => ({
    agentId: id,
    status
  })

  it('splits running from done, keeping order', () => {
    const { running, done } = splitAgentsByStatus([
      mk('a', 'done'),
      mk('b', 'running'),
      mk('c', 'done'),
      mk('d', 'running')
    ])
    expect(running.map((a) => a.agentId)).toEqual(['b', 'd'])
    expect(done.map((a) => a.agentId)).toEqual(['a', 'c'])
  })

  it('handles all-done and empty lists', () => {
    expect(splitAgentsByStatus([mk('a', 'done')]).running).toEqual([])
    expect(splitAgentsByStatus([])).toEqual({ running: [], done: [] })
  })
})
