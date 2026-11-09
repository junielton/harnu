import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJudgeRunner } from '../../src/main/your-move/judge'
import { buildJudgeArgs } from '../../src/main/your-move/gate'

const OK = JSON.stringify({
  is_error: false,
  total_cost_usd: 0.0004,
  result: '{"new":[{"kind":"decide","ask":"Pick one"}],"update":[],"close":[]}'
})

let dir: string
let bin: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-judge-'))
  bin = path.join(dir, 'fake-claude')
  // A stand-in for the `claude` binary, driven by files in FAKE_DIR.
  await writeFile(
    bin,
    `#!/bin/sh
d="$FAKE_DIR"
cat > "$d/stdin.$$"
printf '%s\\n' "$@" > "$d/args"
pwd > "$d/cwd"
printenv CLAUDE_CODE_DISABLE_CLAUDE_MDS > "$d/env1"
printenv CLAUDE_CODE_DISABLE_AUTO_MEMORY > "$d/env2"
echo x >> "$d/calls"
n=$(wc -l < "$d/calls")
touch "$d/running.$$"
r=$(ls "$d" | grep -c '^running\\.')
echo "$r" >> "$d/concurrency"
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
rm -f "$d/running.$$"
if [ "$n" -le "\${FAKE_FAIL_FIRST:-0}" ]; then echo 'not json at all'; else cat "$d/reply"; fi
`
  )
  await chmod(bin, 0o755)
  await writeFile(path.join(dir, 'reply'), OK)
  await mkdirp(path.join(dir, 'empty'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function mkdirp(p: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(p, { recursive: true })
}

const make = (over: Record<string, unknown> = {}, cores = 8) =>
  createJudgeRunner({
    binary: async () => bin,
    gatePath: '/gate/gate-v2.md',
    emptyDir: path.join(dir, 'empty'),
    env: { PATH: process.env.PATH ?? '', FAKE_DIR: dir, ...over },
    cores,
    delay: async () => undefined
  })

describe('judge runner', () => {
  it('sends the prompt on stdin, not argv', async () => {
    const out = await make().run('OPEN_CARDS: []\n\nSEGMENT:\n[ASSISTANT] hi')
    expect(out).toMatchObject({ ok: true, costUsd: 0.0004 })
    const stdinFile = (await import('node:fs/promises').then((f) => f.readdir(dir))).find((f) =>
      f.startsWith('stdin.')
    )!
    expect(await readFile(path.join(dir, stdinFile), 'utf8')).toBe(
      'OPEN_CARDS: []\n\nSEGMENT:\n[ASSISTANT] hi'
    )
    const args = (await readFile(path.join(dir, 'args'), 'utf8')).split('\n')
    expect(args.join('\n')).not.toContain('SEGMENT')
    expect(args.slice(0, -1)).toEqual(buildJudgeArgs('/gate/gate-v2.md'))
  })

  it('runs in emptyDir with both CLAUDE_CODE_DISABLE_* vars set', async () => {
    await make().run('x')
    expect((await readFile(path.join(dir, 'cwd'), 'utf8')).trim()).toBe(
      await import('node:fs/promises').then((f) => f.realpath(path.join(dir, 'empty')))
    )
    expect((await readFile(path.join(dir, 'env1'), 'utf8')).trim()).toBe('1')
    expect((await readFile(path.join(dir, 'env2'), 'utf8')).trim()).toBe('1')
  })

  it('retries a bad-JSON reply 3 times with growing delay, then ok:false', async () => {
    const delays: number[] = []
    const runner = createJudgeRunner({
      binary: async () => bin,
      gatePath: '/g.md',
      emptyDir: path.join(dir, 'empty'),
      env: { PATH: process.env.PATH ?? '', FAKE_DIR: dir, FAKE_FAIL_FIRST: '99' },
      cores: 8,
      delay: async (ms) => {
        delays.push(ms)
      }
    })
    const out = await runner.run('x')
    expect(out.ok).toBe(false)
    expect(delays).toEqual([4000, 8000])
    expect((await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(3)
  })

  it('succeeds on a later attempt without reporting the earlier failure', async () => {
    const out = await make({ FAKE_FAIL_FIRST: '1' }).run('x')
    expect(out.ok).toBe(true)
  })

  it('never runs more than judgeConcurrency children at once', async () => {
    const runner = make({ FAKE_SLEEP: '0.3' }, 4) // 4 cores → 2 children
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => runner.run(`in ${i}`)))
    expect(outs.every((o) => o.ok)).toBe(true)
    const seen = (await readFile(path.join(dir, 'concurrency'), 'utf8'))
      .trim()
      .split('\n')
      .map(Number)
    expect(Math.max(...seen)).toBeLessThanOrEqual(2)
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(2)
  })

  it('a missing binary is a failure, not a throw', async () => {
    const runner = createJudgeRunner({
      binary: async () => path.join(dir, 'does-not-exist'),
      gatePath: '/g.md',
      emptyDir: path.join(dir, 'empty'),
      env: {},
      cores: 8,
      delay: async () => undefined
    })
    const out = await runner.run('x')
    expect(out.ok).toBe(false)
  })

  it('closeAll stops accepting work', async () => {
    const runner = make()
    runner.closeAll()
    expect((await runner.run('x')).ok).toBe(false)
  })
})
