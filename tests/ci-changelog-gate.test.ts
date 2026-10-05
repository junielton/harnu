import { describe, it, expect } from 'vitest'
import { changelogGateVerdict } from '../scripts/ci/changelog-gate-core.mjs'

/**
 * The CHANGELOG contract gate (T65 AC1). A PR that touches `src/**` must also
 * touch `CHANGELOG.md`, unless it carries the `no-changelog` escape label. The
 * predicate is pure (files + labels → verdict); the CLI feeds it the real diff.
 *
 * RED CASE (this is what a failing PR sees) — the verify job runs
 * `node scripts/ci/changelog-gate.mjs` and it prints, exit code 1:
 *
 *   $ GATE_CHANGED_FILES="src/main/pty.ts" GATE_PR_LABELS="[]" \
 *       node scripts/ci/changelog-gate.mjs
 *   ✗ CHANGELOG gate failed
 *   This PR changes 1 file(s) under src/ but does not update CHANGELOG.md.
 *   Add a dated entry to CHANGELOG.md (see the "Changelog is mandatory" contract in CLAUDE.md),
 *   or apply the 'no-changelog' label for pure refactor / test / docs PRs.
 */
describe('changelogGateVerdict', () => {
  it('FAILS when src/ changes without a CHANGELOG.md edit and no escape label', () => {
    const v = changelogGateVerdict({ changedFiles: ['src/main/pty.ts'], labels: [] })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('CHANGELOG.md')
    expect(v.reason).toContain('no-changelog')
  })

  it('passes when src/ change comes with a CHANGELOG.md edit', () => {
    const v = changelogGateVerdict({
      changedFiles: ['src/main/pty.ts', 'CHANGELOG.md'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it("passes when src/ changes but the 'no-changelog' label escapes the gate", () => {
    const v = changelogGateVerdict({
      changedFiles: ['src/renderer/src/App.vue'],
      labels: ['no-changelog']
    })
    expect(v.ok).toBe(true)
  })

  it('passes when the PR touches nothing under src/ (docs / config only)', () => {
    const v = changelogGateVerdict({
      changedFiles: ['README.md', 'design.md', '.github/workflows/ci.yml'],
      labels: []
    })
    expect(v.ok).toBe(true)
  })

  it('normalizes ./ prefixes and backslashes before matching', () => {
    const v = changelogGateVerdict({ changedFiles: ['./src\\main\\index.ts'], labels: [] })
    expect(v.ok).toBe(false)
  })

  it('treats an unrelated label as not escaping the gate', () => {
    const v = changelogGateVerdict({
      changedFiles: ['src/preload/index.ts'],
      labels: ['bug', 'enhancement']
    })
    expect(v.ok).toBe(false)
  })
})
