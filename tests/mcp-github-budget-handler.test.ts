import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T614 (T611 U3) — `github_budget` driven through the REAL wired handler, against the real
 * process-wide tracker. It pins the payload shape, the `unavailable` answer (still `ok: true`),
 * that the verb is read-only and makes no `gh` call, and that it is on the Scheduler observe list.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const spawned = vi.hoisted(() => ({ gh: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (file === 'gh') spawned.gh += 1
    return (real.execFile as (...a: unknown[]) => unknown)(file, ...rest)
  }) as typeof real.execFile
  return { ...real, execFile }
})

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { githubBudget } from '../src/main/github-budget-tracker'
import { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } from '../src/main/scheduler-core'

const handler = WIRED_TOOLS.find((t) => t.op === 'github_budget')!.handler!
const ctx = { folder: '', folders: [], denyFolders: [], bridge: undefined }

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

const nowSec = Math.floor(Date.now() / 1000)
const bucket = (remaining: number, limit = 5000) => ({
  limit,
  remaining,
  used: limit - remaining,
  reset: nowSec + 1800
})

beforeEach(() => {
  spawned.gh = 0
  githubBudget.setPrefs({
    version: 1,
    threshold: 15,
    checkDelivered: false,
    pausePrStackWhenLow: true,
    notify: true
  })
})

describe('github_budget (T614)', () => {
  it('AC-1: returns the documented shape, with the tighter bucket and Harnu attribution', async () => {
    githubBudget.applyPoll({ ok: true, buckets: { rest: bucket(4000), graphql: bucket(1000) } })
    githubBudget.setLogin('octocat')
    githubBudget.record('missions', 'graphql')
    githubBudget.record('missions', 'graphql')
    githubBudget.record('pr-stack', 'graphql')

    const res = await handler({}, ctx)
    expect(res.isError).toBeFalsy()
    const p = payload(res)
    expect(Object.keys(p).sort()).toEqual(
      [
        'graphql',
        'harnu',
        'login',
        'ok',
        'outside',
        'rest',
        'sampledAt',
        'tighter',
        'throttle'
      ].sort()
    )
    expect(p.ok).toBe(true)
    expect(p.login).toBe('octocat')
    expect(p.tighter).toBe('graphql')
    expect(p.rest).toMatchObject({ limit: 5000, remaining: 4000, used: 1000 })
    expect(p.graphql).toMatchObject({ limit: 5000, remaining: 1000, used: 4000 })
    expect((p.graphql as { resetAt: string }).resetAt).toBe(
      new Date((nowSec + 1800) * 1000).toISOString()
    )
    const throttle = p.throttle as { state: string; since: string; threshold: number }
    expect(throttle.state).toBe('normal')
    expect(throttle.threshold).toBe(15)
    expect(Number.isNaN(Date.parse(throttle.since))).toBe(false)
    const byConsumer = (p.harnu as { byConsumer: Record<string, number> }).byConsumer
    expect(byConsumer.missions).toBe(2)
    expect(byConsumer['pr-stack']).toBe(1)
    expect(p.outside).toBe(4000 - 3)
    expect(typeof p.sampledAt).toBe('string')
  })

  it('reports low once the tighter bucket is at or under the threshold', async () => {
    githubBudget.applyPoll({ ok: true, buckets: { rest: bucket(4000), graphql: bucket(300) } })
    expect((payload(await handler({}, ctx)).throttle as { state: string }).state).toBe('low')
  })

  it('AC-1: answers ok:true with state "unavailable" and null buckets when gh is missing', async () => {
    githubBudget.applyPoll({ ok: false, reason: 'missing' })
    const res = await handler({}, ctx)
    expect(res.isError).toBeFalsy()
    const p = payload(res)
    expect(p.ok).toBe(true)
    expect((p.throttle as { state: string }).state).toBe('unavailable')
    expect(p.reason).toBe('missing')
    expect(p.rest).toBeNull()
    expect(p.graphql).toBeNull()
    expect(p.tighter).toBeNull()
    expect(p.outside).toBeNull()
    expect((p.harnu as { byConsumer: object }).byConsumer).toEqual({})
  })

  it('reads the tracker only: it spawns no gh', async () => {
    githubBudget.applyPoll({ ok: true, buckets: { rest: bucket(4000), graphql: bucket(4000) } })
    await handler({}, ctx)
    expect(spawned.gh).toBe(0)
  })

  it('AC-2: is a read verb on the Scheduler observe allowlist under both prefixes', () => {
    for (const prefix of ['mcp__harnu__', 'mcp__capy__']) {
      expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}github_budget`)
      expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}github_budget`)
    }
    const def = WIRED_TOOLS.find((t) => t.op === 'github_budget')!
    expect(def.mutates).toBe(false)
  })
})
