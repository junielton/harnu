import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runSupervised } from '../src/main/gc/opinion-run'

// The advisor's process supervision (T444 delta 3, item 5): a timeout sends SIGTERM and, if the child
// ignores it, SIGKILL after a grace period, and the promise settles either way. These tests run real
// child processes (node itself), so the signals are real.

const NODE = process.execPath
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const BASE = { cwd: null, env: process.env as Record<string, string>, graceMs: 300 } as const

describe('runSupervised', () => {
  it('writes stdin to the child and resolves with its stdout', async () => {
    const out = await runSupervised(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], {
      ...BASE,
      stdin: 'hello advisor',
      timeoutMs: 5000
    })
    expect(out).toBe('hello advisor')
  })

  it('resolves null on a non-zero exit, on empty output and on a missing binary', async () => {
    expect(
      await runSupervised(NODE, ['-e', 'console.log("x"); process.exit(3)'], {
        ...BASE,
        stdin: '',
        timeoutMs: 5000
      })
    ).toBeNull()
    expect(
      await runSupervised(NODE, ['-e', ''], { ...BASE, stdin: '', timeoutMs: 5000 })
    ).toBeNull()
    expect(
      await runSupervised('/nonexistent/claude-binary', [], { ...BASE, stdin: '', timeoutMs: 5000 })
    ).toBeNull()
  })

  it('does not choke when the child exits before reading its stdin', async () => {
    const out = await runSupervised(NODE, ['-e', 'console.log("done")'], {
      ...BASE,
      stdin: 'x'.repeat(2_000_000),
      timeoutMs: 5000
    })
    expect(out?.trim()).toBe('done')
  })

  it('on timeout sends SIGTERM and settles at once when the child obeys', async () => {
    let pid = 0
    const started = Date.now()
    const out = await runSupervised(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      ...BASE,
      stdin: '',
      timeoutMs: 200,
      graceMs: 5000, // a long grace the child never needs
      onSpawn: (p) => (pid = p)
    })
    expect(out).toBeNull()
    expect(Date.now() - started).toBeLessThan(2500)
    await wait(100)
    expect(alive(pid)).toBe(false)
  })

  it('escalates to SIGKILL when the child ignores SIGTERM, and settles either way', async () => {
    let pid = 0
    const started = Date.now()
    const out = await runSupervised(
      NODE,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { ...BASE, stdin: '', timeoutMs: 400, graceMs: 300, onSpawn: (p) => (pid = p) }
    )
    const took = Date.now() - started
    expect(out).toBeNull()
    expect(took).toBeGreaterThanOrEqual(600) // timeout + grace: it really waited for the escalation
    expect(took).toBeLessThan(4000)
    await wait(100)
    expect(alive(pid)).toBe(false)
  })

  it('never resolves with partial output after a timeout', async () => {
    const out = await runSupervised(
      NODE,
      ['-e', "console.log('partial'); setInterval(() => {}, 1000)"],
      { ...BASE, stdin: '', timeoutMs: 300, graceMs: 200 }
    )
    expect(out).toBeNull()
  })

  it('stops collecting stdout past its cap but still resolves', async () => {
    const out = await runSupervised(
      NODE,
      ['-e', "process.stdout.write('y'.repeat(6 * 1024 * 1024))"],
      { ...BASE, stdin: '', timeoutMs: 10_000, maxStdout: 1024 * 1024 }
    )
    expect(out).not.toBeNull()
    expect((out ?? '').length).toBeLessThan(5 * 1024 * 1024)
  })
})

describe('runSupervised: the folder it runs in is the whole readable world of the advisor', () => {
  const printCwd = [
    '-e',
    'console.log(process.cwd()); console.log(JSON.stringify(require("fs").readdirSync(".")))'
  ]

  it('with no folder it runs in a fresh, empty, private directory, never the shared temp dir', async () => {
    const out = await runSupervised(NODE, printCwd, {
      ...BASE,
      cwd: null,
      stdin: '',
      timeoutMs: 5000
    })
    const [cwd, listing] = (out ?? '').trim().split('\n')
    expect(realpathSync(cwd)).not.toBe(realpathSync(tmpdir()))
    expect(JSON.parse(listing)).toEqual([])
  })

  it('removes that directory when the process is done', async () => {
    let seen = ''
    const out = await runSupervised(NODE, printCwd, {
      ...BASE,
      cwd: null,
      stdin: '',
      timeoutMs: 5000,
      onSpawn: () => {}
    })
    seen = (out ?? '').trim().split('\n')[0]
    expect(seen).not.toBe('')
    expect(existsSync(seen)).toBe(false)
  })

  it('uses two different directories for two runs', async () => {
    const a = (
      await runSupervised(NODE, printCwd, { ...BASE, cwd: null, stdin: '', timeoutMs: 5000 })
    )?.split('\n')[0]
    const b = (
      await runSupervised(NODE, printCwd, { ...BASE, cwd: null, stdin: '', timeoutMs: 5000 })
    )?.split('\n')[0]
    expect(a).not.toBe(b)
  })

  it('runs in the given folder when there is one', async () => {
    const dir = tmpdir()
    const out = await runSupervised(NODE, printCwd, {
      ...BASE,
      cwd: dir,
      stdin: '',
      timeoutMs: 5000
    })
    expect(realpathSync((out ?? '').split('\n')[0])).toBe(realpathSync(dir))
    expect(readdirSync(dir)).toBeDefined()
  })
})
