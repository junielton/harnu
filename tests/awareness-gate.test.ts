import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AWARENESS_DOC,
  TRIGGER_FILES,
  awarenessGateVerdict
} from '../scripts/ci/awareness-gate-core.mjs'

/**
 * The self-awareness contract gate (T81), mirror of the CHANGELOG gate. A PR that
 * touches the agent-facing surface — `src/main/mcp/tool-catalog.ts` (the MCP verb
 * catalog) or `src/main/harnu-features.ts` (the doc loader) — must also touch
 * `docs/harnu-features.md`, unless it carries the `no-awareness` escape label. The
 * predicate is pure (files + labels → verdict); the CLI feeds it the real diff.
 *
 * RED CASE (this is what a failing PR sees) — the verify job runs
 * `node scripts/ci/awareness-gate.mjs` and it prints, exit code 1:
 *
 *   $ GATE_CHANGED_FILES="src/main/mcp/tool-catalog.ts" GATE_PR_LABELS="[]" \
 *       node scripts/ci/awareness-gate.mjs
 *   ✗ self-awareness gate failed
 *   This PR changes src/main/mcp/tool-catalog.ts (the agent-facing MCP surface) but
 *   does not update docs/harnu-features.md.
 *   Update docs/harnu-features.md and bump its version marker ...
 *   or apply the 'no-awareness' label ...
 */
describe('awarenessGateVerdict', () => {
  it('FAILS (red case) when the MCP tool catalog changes without a harnu-features.md edit and no escape label', () => {
    const v = awarenessGateVerdict({
      changedFiles: ['src/main/mcp/tool-catalog.ts'],
      labels: []
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('docs/harnu-features.md')
    expect(v.reason).toContain('no-awareness')
  })

  it('FAILS when the harnu-features loader changes without a harnu-features.md edit', () => {
    const v = awarenessGateVerdict({ changedFiles: ['src/main/harnu-features.ts'], labels: [] })
    expect(v.ok).toBe(false)
  })

  it('passes when the agent-facing change comes with a docs/harnu-features.md edit', () => {
    const v = awarenessGateVerdict({
      changedFiles: ['src/main/mcp/tool-catalog.ts', 'docs/harnu-features.md'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it("passes when the 'no-awareness' label escapes the gate (catalog-internal change)", () => {
    const v = awarenessGateVerdict({
      changedFiles: ['src/main/harnu-features.ts'],
      labels: ['no-awareness']
    })
    expect(v.ok).toBe(true)
  })

  it('does NOT trigger for unrelated src/ changes (scope is deliberately narrow)', () => {
    const v = awarenessGateVerdict({
      changedFiles: ['src/main/pty.ts', 'src/renderer/src/App.vue'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('normalizes ./ prefixes and backslashes before matching the trigger paths', () => {
    const v = awarenessGateVerdict({
      changedFiles: ['./src\\main\\mcp\\tool-catalog.ts'],
      labels: []
    })
    expect(v.ok).toBe(false)
  })

  it("treats an unrelated label (or the CHANGELOG gate's) as not escaping this gate", () => {
    const v = awarenessGateVerdict({
      changedFiles: ['src/main/mcp/tool-catalog.ts'],
      labels: ['no-changelog', 'enhancement']
    })
    expect(v.ok).toBe(false)
  })

  // The rename guard: the gate is keyed on file PATHS, so a path that stops
  // existing makes it pass silently ("no agent-facing surface changed").
  it('keys on the renamed harnu-features trigger + doc, and they exist on disk', () => {
    expect(TRIGGER_FILES).toEqual(['src/main/mcp/tool-catalog.ts', 'src/main/harnu-features.ts'])
    expect(AWARENESS_DOC).toBe('docs/harnu-features.md')
    for (const f of [...TRIGGER_FILES, AWARENESS_DOC]) {
      expect(existsSync(resolve(__dirname, '..', f)), f).toBe(true)
    }
  })

  it('FIRES on the renamed trigger file and names the harnu-awareness skill in the error', () => {
    const v = awarenessGateVerdict({ changedFiles: ['src/main/harnu-features.ts'], labels: [] })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('src/main/harnu-features.ts')
    expect(v.reason).toContain('/harnu-awareness')
  })

  it('does not treat the pre-rename capy-features path as an agent-facing surface', () => {
    const v = awarenessGateVerdict({ changedFiles: ['src/main/capy-features.ts'], labels: [] })
    expect(v.ok).toBe(true)
  })
})
