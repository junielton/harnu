import { describe, it, expect } from 'vitest'
import { userDocsGateVerdict } from '../scripts/ci/user-docs-gate-core.mjs'

/**
 * The user-docs contract gate (T124), third instance of the CHANGELOG /
 * self-awareness pattern. A PR that adds a new top-level Vue component under
 * src/renderer/src/components/, a new top-level file directly under src/main/,
 * or changes src/main/mcp/tool-catalog.ts must also touch docs/user/**, unless
 * it carries the `no-user-docs` escape label. The predicate is pure (added +
 * changed files + labels → verdict); the CLI feeds it the real diff.
 *
 * RED CASE (this is what a failing PR sees) — the verify job runs
 * `node scripts/ci/user-docs-gate.mjs` and it prints, exit code 1:
 *
 *   $ GATE_ADDED_FILES="src/renderer/src/components/FooPane.vue" \
 *       GATE_CHANGED_FILES="src/renderer/src/components/FooPane.vue" GATE_PR_LABELS="[]" \
 *       node scripts/ci/user-docs-gate.mjs
 *   ✗ user-docs gate failed
 *   This PR adds/changes src/renderer/src/components/FooPane.vue (a new user-visible
 *   surface) but does not update anything under docs/user/.
 *   Document the new capability under docs/user/ ...
 *   or apply the 'no-user-docs' label ...
 */
describe('userDocsGateVerdict', () => {
  it('FAILS (red case) when a new top-level component is added without a docs/user/ edit', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/renderer/src/components/FooPane.vue'],
      changedFiles: ['src/renderer/src/components/FooPane.vue'],
      labels: []
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('docs/user/')
    expect(v.reason).toContain('no-user-docs')
  })

  it('FAILS when a new top-level src/main/ file is added without a docs/user/ edit', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/main/foo-feature.ts'],
      changedFiles: ['src/main/foo-feature.ts'],
      labels: []
    })
    expect(v.ok).toBe(false)
  })

  it('FAILS when src/main/mcp/tool-catalog.ts changes without a docs/user/ edit', () => {
    const v = userDocsGateVerdict({
      addedFiles: [],
      changedFiles: ['src/main/mcp/tool-catalog.ts'],
      labels: []
    })
    expect(v.ok).toBe(false)
  })

  it('passes when a new component comes with a docs/user/ edit', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/renderer/src/components/FooPane.vue'],
      changedFiles: ['src/renderer/src/components/FooPane.vue', 'docs/user/foo.md'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it("passes when the 'no-user-docs' label escapes the gate", () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/main/foo-feature.ts'],
      changedFiles: ['src/main/foo-feature.ts'],
      labels: ['no-user-docs']
    })
    expect(v.ok).toBe(true)
  })

  it('does NOT trigger for a modified (not added) existing component or main file', () => {
    const v = userDocsGateVerdict({
      addedFiles: [],
      changedFiles: ['src/renderer/src/components/Sidebar.vue', 'src/main/pty.ts'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('does NOT trigger for an added file nested under components/ui/ (low-level primitives)', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/renderer/src/components/ui/NewToggle.vue'],
      changedFiles: ['src/renderer/src/components/ui/NewToggle.vue'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('does NOT trigger for an added file nested under src/main/detect/ or src/main/mcp/ (internal machinery)', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/main/detect/new-heuristic.ts', 'src/main/mcp/new-internal.ts'],
      changedFiles: ['src/main/detect/new-heuristic.ts', 'src/main/mcp/new-internal.ts'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('does NOT trigger for unrelated added files elsewhere in src/', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/preload/new-helper.ts'],
      changedFiles: ['src/preload/new-helper.ts'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('normalizes ./ prefixes and backslashes before matching', () => {
    const v = userDocsGateVerdict({
      addedFiles: ['./src\\main\\foo-feature.ts'],
      changedFiles: ['./src\\main\\foo-feature.ts'],
      labels: []
    })
    expect(v.ok).toBe(false)
  })

  it("treats an unrelated label (or the other gates') as not escaping this gate", () => {
    const v = userDocsGateVerdict({
      addedFiles: ['src/main/foo-feature.ts'],
      changedFiles: ['src/main/foo-feature.ts'],
      labels: ['no-changelog', 'no-awareness']
    })
    expect(v.ok).toBe(false)
  })
})
