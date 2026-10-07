import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WITH_CLI, assertNotBlockedByAuth, runClaude } from './support/run-claude'

const TSC = resolve(import.meta.dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')

function tsc(cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, [TSC, '-p', join(cwd, 'tsconfig.json'), '--noEmit'], { cwd })
    let out = ''
    c.stdout.on('data', (d: Buffer) => (out += d))
    c.stderr.on('data', (d: Buffer) => (out += d))
    c.on('close', (code) => res({ code, out }))
  })
}

// Drift way 3: the engine lays `.claude-plugin/types/` beside a loaded mod, so the types exist
// only after a real load; `tsc` against them catches an API change the other two ways miss.
describe.skipIf(!WITH_CLI)('the mod type-checks against the installed CLI', () => {
  it('types compile against the installed CLI (drift way 3)', async () => {
    const r = await runClaude()
    try {
      assertNotBlockedByAuth(r)
      const result = await tsc(r.companionDir)
      expect(result.code, result.out).toBe(0)
    } finally {
      await r.cleanup()
    }
  })
})
