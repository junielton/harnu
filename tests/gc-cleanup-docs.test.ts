import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

/**
 * T445 delta 1 (D5) — the cleanup verbs' docs must not claim that no verb removes anything.
 * `remove_containers` exists and removes containers (with the operator's confirmation); what
 * is true is that neither cleanup verb removes anything and no verb cleans a worktree.
 */

const ROOT = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

/** The cleanup section of the agent doc, from its bold lead-in to the next one. */
function featuresSection(): string {
  const doc = read('docs/harnu-features.md')
  const start = doc.indexOf('**Workspace cleanup')
  expect(start).toBeGreaterThan(-1)
  const end = doc.indexOf('**Worktrees.**', start)
  expect(end).toBeGreaterThan(start)
  return doc.slice(start, end)
}

describe('cleanup verbs: no false "nothing can be removed" claims (T445 delta 1)', () => {
  it('list_cleanup’s description does not say no verb removes anything, and names remove_containers', () => {
    const d = MCP_TOOLS.find((t) => t.name === 'list_cleanup')!.description
    expect(d).not.toMatch(/no verb does/i)
    expect(d).toContain('remove_containers')
    expect(d).toMatch(/removes nothing/i)
  })

  it('release_worktree’s description says it deletes nothing and takes a folder or an id', () => {
    const d = MCP_TOOLS.find((t) => t.name === 'release_worktree')!.description
    expect(d).toMatch(/deletes nothing/i)
    expect(d).toMatch(/\bid\b/)
  })

  it('harnu-features does not say the agent cannot remove anything, and points at remove_containers', () => {
    const s = featuresSection()
    expect(s).not.toMatch(/cannot remove anything/i)
    expect(s).toContain('remove_containers')
    expect(s).toMatch(/no verb cleans a worktree/i)
  })

  it('harnu-features documents release by id and the unique listing id', () => {
    const s = featuresSection()
    expect(s).toContain('release_worktree({ folder })')
    expect(s).toContain('release_worktree({ id })')
  })

  it('the user doc does not claim no session can remove anything, and keeps remove_containers’ confirmation', () => {
    const doc = read('docs/user/agent-control.md')
    const start = doc.indexOf('## Watching workspace cleanup')
    expect(start).toBeGreaterThan(-1)
    const section = doc.slice(start, doc.indexOf('## Tracking a mission', start))
    expect(section).not.toMatch(/no way for a session to remove/i)
    expect(section).toMatch(/Stopping, starting and removing containers/)
  })
})
