import { expect, test } from 'claude-code/testing'

test('session.start passes through', async ($, on) => {
  const seen: unknown[] = []
  // The bottom hook stands for the engine: the plugin under test sits above it.
  on('session.start', async (_$, e) => {
    seen.push(e)
    return { cwd: e.cwd }
  })
  const input = { cwd: '/work/dir', surface: 'terminal' as const, isInteractive: true }
  const out = await $.session.start(input)
  expect(out).toEqual({ cwd: '/work/dir' })
  expect(seen.length).toBe(1)
  expect(seen[0]).toEqual(input)
})
