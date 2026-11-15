/**
 * The posture every mission operator door shares: nothing under `src/main/mcp/` — no `mission_*`
 * handler, no catalog entry — can reach one. The UI reaches them through `src/main/mission-ipc.ts`
 * only. Also pins that the v3 draft ceremony (the draft status and the approve door) is gone.
 *
 * Missions v4 S-41: the v3 door functions themselves (`applyOperatorEnd`, the human-check doors and
 * the human-step tick, with their cases) went with `mission-core.ts`; the v4 doors are covered by
 * `tests/mission-doors-v4.test.ts`. These two cases test files that still exist, so they stay,
 * unchanged: the door names below are the v3 names, kept so a handler that wired one by mistake is
 * still caught.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

describe('no MCP code path reaches an operator door', () => {
  const DOORS = [
    'applyApprovedRescope',
    'applyOperatorVerifyStep',
    'applyOperatorEnd',
    // Mission v3 §3.6: only the operator ticks or deletes a check.
    'applyTickCheck',
    'applyDeleteCheck',
    // Campaign spec §3.4: pausing the steward is a mission door, never a verb.
    'applyPauseSteward',
    'applyResumeSteward'
  ]
  const mcpDir = path.join(__dirname, '..', 'src', 'main', 'mcp')

  function sources(dir: string): Array<{ file: string; text: string }> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return sources(full)
      return e.name.endsWith('.ts') ? [{ file: full, text: readFileSync(full, 'utf8') }] : []
    })
  }

  it('no file under src/main/mcp/ calls a door or imports the IPC module that does', () => {
    const files = sources(mcpDir)
    expect(files.length).toBeGreaterThan(10)
    for (const { file, text } of files) {
      for (const door of DOORS) {
        // A mention in a comment is fine; a call or an import binding is not.
        expect(text, `${file} calls ${door}`).not.toMatch(new RegExp(`\\b${door}\\s*\\(`))
        expect(text, `${file} imports ${door}`).not.toMatch(
          new RegExp(`import[^;]*\\b${door}\\b[^;]*from`, 's')
        )
      }
      expect(text, `${file} imports mission-ipc`).not.toMatch(/from ['"][./]*mission-ipc['"]/)
    }
  })
})

describe('Mission v3 §3.4/§3.5 — the draft ceremony is gone', () => {
  it('no source file under src/main refers to MISSION_DRAFT or the approve door', () => {
    const root = path.join(__dirname, '..')
    let hits = ''
    try {
      hits = execFileSync(
        'git',
        ['grep', '-n', '-e', 'MISSION_DRAFT', '-e', 'applyOperatorApprove', '--', 'src/main'],
        { cwd: root, encoding: 'utf8' }
      ).trim()
    } catch (err) {
      // git grep exits 1 when nothing matches — the outcome this test wants.
      if ((err as { status?: number }).status !== 1) throw err
    }
    expect(hits).toBe('')
  })
})
