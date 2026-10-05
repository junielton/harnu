import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'node:os'

/**
 * Imperative-shell tests for the Haiku service. `electron`, `node:child_process`,
 * `./claude-cli`, and `./appimage-env` are mocked (mirrors the usage poller's
 * approach) so we can prove single-flight / cache / never-reject / argv / handler
 * without spawning a real `claude`.
 */

type Cb = (err: Error | null, stdout: string) => void
let pendingCbs: Cb[] = []
let spawnedChildren: { kill: ReturnType<typeof vi.fn> }[] = []

const execFileMock = vi.fn((_bin: string, _args: string[], _opts: unknown, cb: Cb) => {
  pendingCbs.push(cb)
  const child = { kill: vi.fn() }
  spawnedChildren.push(child)
  return child
})
function flush(stdout = '{"title":"t","summary":"s."}', err: Error | null = null): void {
  const cbs = pendingCbs
  pendingCbs = []
  for (const cb of cbs) cb(err, stdout)
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

vi.mock('node:child_process', () => ({
  execFile: (...a: unknown[]) => execFileMock(...(a as [string, string[], unknown, Cb]))
}))
vi.mock('../src/main/claude-cli', () => ({
  resolveClaudePath: vi.fn(async () => '/bin/claude'),
  resolveClaudeVersion: vi.fn(async () => null),
  claudeVersionSync: vi.fn(() => null)
}))
const sanitizeSpawnEnv = vi.fn(() => ({ SANITIZED: '1' }))
vi.mock('../src/main/appimage-env', () => ({
  sanitizeSpawnEnv: (e: unknown) => sanitizeSpawnEnv(e)
}))
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { runHaiku, registerHaikuHandlers, closeHaiku, _resetHaikuState } from '../src/main/haiku'

beforeEach(() => {
  _resetHaikuState()
  execFileMock.mockClear()
  sanitizeSpawnEnv.mockClear()
  pendingCbs = []
  spawnedChildren = []
  handlers.clear()
})

describe('runHaiku single-flight + cache', () => {
  it('shares one spawn for concurrent calls with the same key', async () => {
    const a = runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    const b = runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    await tick()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    flush()
    expect(await a).toEqual(await b)
  })

  it('spawns separately for different keys', async () => {
    runHaiku('p', { key: 'a', cacheTtlMs: 0 })
    runHaiku('p', { key: 'b', cacheTtlMs: 0 })
    await tick()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    flush()
  })

  it('serves a content-hash cache hit without re-spawning within the TTL', async () => {
    const a = runHaiku('p', { key: 'k1' })
    await tick()
    flush()
    await a
    const b = runHaiku('p', { key: 'k2' }) // same prompt+system, different key
    await tick()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(await b).toEqual(await a)
  })
})

describe('runHaiku never-reject', () => {
  it('resolves { ok: false } on spawn error', async () => {
    const a = runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    await tick()
    flush('', new Error('ENOENT'))
    expect(await a).toEqual({ ok: false })
  })
  it('resolves { ok: false } on empty stdout', async () => {
    const a = runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    await tick()
    flush('   ')
    expect(await a).toEqual({ ok: false })
  })
})

describe('runHaiku spawn opts', () => {
  it('runs in homedir with a sanitized env (not raw process.env)', async () => {
    runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    await tick()
    const opts = execFileMock.mock.calls[0][2] as { cwd: string; env: unknown }
    expect(opts.cwd).toBe(homedir())
    expect(sanitizeSpawnEnv).toHaveBeenCalled()
    expect(opts.env).toEqual({ SANITIZED: '1' })
    flush()
  })
})

describe('haiku:autoname handler', () => {
  it('resolves { ok, title, summary } from the model output', async () => {
    registerHaikuHandlers(() => null)
    const handler = handlers.get('haiku:autoname')!
    const pr = handler({}, { sessionId: 's', firstUserText: 'do a thing' }) as Promise<unknown>
    await tick()
    flush('{"title":"do thing","summary":"Does a thing."}')
    expect(await pr).toEqual({ ok: true, title: 'do thing', summary: 'Does a thing.' })
  })

  it('resolves { ok: false } for an empty prompt without spawning', async () => {
    registerHaikuHandlers(() => null)
    const handler = handlers.get('haiku:autoname')!
    const before = execFileMock.mock.calls.length
    const pr = handler({}, { sessionId: 's', firstUserText: '   ' }) as Promise<unknown>
    expect(await pr).toEqual({ ok: false })
    expect(execFileMock.mock.calls.length).toBe(before)
  })
})

describe('closeHaiku', () => {
  it('kills in-flight children', async () => {
    runHaiku('p', { key: 'k', cacheTtlMs: 0 })
    await tick()
    closeHaiku()
    expect(spawnedChildren[0].kill).toHaveBeenCalled()
  })
})
