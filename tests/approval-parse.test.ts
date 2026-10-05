import { describe, it, expect } from 'vitest'
import { parseApprovalBody, toolSummary } from '../src/main/approval-parse'

/**
 * Pure-core tests for the Approval Inbox (spec §5.1). No electron/IPC/server —
 * only body extraction + the readable tool summary, mirroring hook-state.test.ts.
 */

const META = {
  requestId: 'req-1',
  kind: 'permission_request' as const,
  createdAtMs: 1000,
  deadlineMs: 5000
}

describe('parseApprovalBody', () => {
  it('maps a full body; requestId/createdAtMs/deadlineMs come from meta, not body', () => {
    const w = parseApprovalBody(
      { session_id: 'S1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
      META
    )
    expect(w).toEqual({
      requestId: 'req-1',
      sessionId: 'S1',
      kind: 'permission_request',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      summary: 'Bash(rm -rf build)',
      createdAtMs: 1000,
      deadlineMs: 5000
    })
  })

  it('defaults toolInput to {} when absent / null / non-object (never null, never throws)', () => {
    expect(parseApprovalBody({ tool_name: 'Bash' }, META).toolInput).toEqual({})
    expect(parseApprovalBody({ tool_input: null }, META).toolInput).toEqual({})
    expect(parseApprovalBody({ tool_input: 42 }, META).toolInput).toEqual({})
    expect(parseApprovalBody({ tool_input: ['a'] }, META).toolInput).toEqual({})
  })

  it('serializes non-string tool_input values into short JSON strings', () => {
    const w = parseApprovalBody({ tool_input: { count: 3, nested: { a: 1 } } }, META)
    expect(w.toolInput).toEqual({ count: '3', nested: '{"a":1}' })
  })

  it("defaults toolName to '' when absent", () => {
    expect(parseApprovalBody({ session_id: 'S1' }, META).toolName).toBe('')
  })

  it('tolerates the camelCase variants', () => {
    const w = parseApprovalBody(
      { sessionId: 'S2', toolName: 'Edit', toolInput: { file_path: '.env' } },
      META
    )
    expect(w.sessionId).toBe('S2')
    expect(w.toolName).toBe('Edit')
    expect(w.toolInput).toEqual({ file_path: '.env' })
  })

  it('propagates kind from meta', () => {
    expect(parseApprovalBody({}, { ...META, kind: 'permission_prompt' }).kind).toBe(
      'permission_prompt'
    )
  })
})

describe('toolSummary', () => {
  it('summarizes known tools by their primary argument', () => {
    expect(toolSummary('Bash', { command: 'rm -rf build' })).toBe('Bash(rm -rf build)')
    expect(toolSummary('Edit', { file_path: '.env' })).toBe('Edit(.env)')
    expect(toolSummary('Write', { file_path: 'src/main/pty.ts', content: '…' })).toBe(
      'Write(src/main/pty.ts)'
    )
    expect(toolSummary('Read', { file_path: 'README.md' })).toBe('Read(README.md)')
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('Grep(TODO)')
  })

  it('truncates an argument longer than maxLen with an ellipsis', () => {
    const out = toolSummary('Bash', { command: 'one two three four five six' }, 10)
    expect(out).toBe('Bash(one two t…)')
    expect(out.length).toBe('Bash('.length + 10 + ')'.length)
  })

  it('summarizes an MCP tool by its first key=value pair', () => {
    expect(toolSummary('mcp__github__create_pr', { repo: 'x', title: 'y' })).toBe(
      'mcp__github__create_pr(repo=x)'
    )
  })

  it('falls back to the bare tool name when there is no obvious argument', () => {
    expect(toolSummary('SomeTool', {})).toBe('SomeTool')
    expect(toolSummary('Bash', {})).toBe('Bash')
  })

  it("returns '' on an empty tool name", () => {
    expect(toolSummary('', {})).toBe('')
  })

  it('returns the raw technical tool name — never an i18n key (lesson i18n/001)', () => {
    // The summary is the technical noun verbatim; it must not be a translation key.
    expect(toolSummary('mcp__github__create_pr', {})).toBe('mcp__github__create_pr')
  })
})
