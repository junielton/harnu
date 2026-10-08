import { describe, it, expect } from 'vitest'
import {
  tickArgv,
  newWorker,
  OBSERVE_TOOLS,
  OBSERVE_NETWORK_TOOLS,
  type Worker
} from '../src/main/scheduler-core'
import { parseWorkers, serializeWorkers, workersLosingNetwork } from '../src/main/scheduler-store'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { parseCreateWorker, parseUpdateWorker } from '../src/main/mcp/validate'
import type { Policy } from '../src/main/mcp/permission-core'

// BUG-166 — an observe tick can `Read` any file the user can read and send it anywhere through
// `WebFetch` (a URL query is enough). Network access is therefore opt-in per worker:
// `allowNetwork: true`. Default off, and turning it on through an agent verb confirms.

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'w',
    enabled: true,
    prompt: 'do the thing',
    folder: '/repo',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...over
  }
}

const valueOf = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const rulesOf = (csv: string | undefined): string[] => (csv ?? '').split(',').filter(Boolean)

describe('BUG-166 — observe argv: WebFetch is off unless the worker opted in', () => {
  it('pins the base observe built-ins, without WebFetch', () => {
    expect(OBSERVE_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'Skill'])
    expect(OBSERVE_NETWORK_TOOLS).toEqual(['WebFetch'])
  })

  it('a new worker is born with network off', () => {
    expect(newWorker('x').allowNetwork).toBe(false)
  })

  it.each([undefined, false])(
    'default argv (allowNetwork: %s) has no WebFetch and denies it',
    (v) => {
      const argv = tickArgv(worker({ allowNetwork: v }), { mcpConfigPath: '/tmp/harnu.json' })
      expect(rulesOf(valueOf(argv, '--tools'))).not.toContain('WebFetch')
      expect(rulesOf(valueOf(argv, '--allowedTools'))).not.toContain('WebFetch')
      expect(rulesOf(valueOf(argv, '--disallowedTools'))).toContain('WebFetch')
    }
  )

  it('an opted-in worker gets WebFetch in --tools and --allowedTools, and it is not denied', () => {
    const argv = tickArgv(worker({ allowNetwork: true }), { mcpConfigPath: '/tmp/harnu.json' })
    expect(rulesOf(valueOf(argv, '--tools'))).toContain('WebFetch')
    expect(rulesOf(valueOf(argv, '--allowedTools'))).toContain('WebFetch')
    expect(rulesOf(valueOf(argv, '--disallowedTools'))).not.toContain('WebFetch')
  })

  it('opting in adds WebFetch and nothing else', () => {
    const off = tickArgv(worker(), {})
    const on = tickArgv(worker({ allowNetwork: true }), {})
    expect(
      rulesOf(valueOf(on, '--tools')).filter((t) => !rulesOf(valueOf(off, '--tools')).includes(t))
    ).toEqual(['WebFetch'])
  })

  it('only the literal true opts in — a truthy string from a hand-edited file does not', () => {
    const argv = tickArgv(worker({ allowNetwork: 'yes' as unknown as boolean }), {})
    expect(rulesOf(valueOf(argv, '--tools'))).not.toContain('WebFetch')
  })

  it('act mode is untouched either way', () => {
    expect(tickArgv(worker({ mode: 'act' }), {})).not.toContain('--tools')
  })

  it('still contains no Bash( rule', () => {
    expect(tickArgv(worker({ allowNetwork: true }), {}).join(' ')).not.toContain('Bash(')
  })
})

describe('BUG-166 — persisted workers migrate to network off', () => {
  const legacy = (over: Record<string, unknown>): string =>
    JSON.stringify({
      version: 1,
      workers: [{ ...worker(), ...over }]
    })

  it('a worker saved before the field existed loads with allowNetwork: false and heals on write', () => {
    const parsed = parseWorkers(legacy({}))
    expect(parsed[0].allowNetwork).toBe(false)
    expect(serializeWorkers(parsed)).toContain('"allowNetwork": false')
  })

  it('an explicit true survives a round trip', () => {
    expect(parseWorkers(legacy({ allowNetwork: true }))[0].allowNetwork).toBe(true)
  })

  it('anything other than the literal true loads as false', () => {
    for (const bad of ['true', 1, 'yes', null, {}]) {
      expect(parseWorkers(legacy({ allowNetwork: bad }))[0].allowNetwork).toBe(false)
    }
  })
})

describe('BUG-166 — the one-time notice lists the workers that just lost network', () => {
  const file = (workers: Record<string, unknown>[]): string =>
    JSON.stringify({ version: 1, workers })
  const w = (over: Record<string, unknown>): Record<string, unknown> => ({ ...worker(), ...over })

  it('lists an observe worker saved before the field whose prompt has a URL', () => {
    const out = workersLosingNetwork(
      file([w({ id: 'a', name: 'A', prompt: 'check https://example.com/status' })])
    )
    expect(out.map((x) => x.id)).toEqual(['a'])
    expect(out[0]).toMatchObject({ name: 'A', folder: '/repo' })
  })

  it('lists one whose prompt names WebFetch, in any case', () => {
    expect(
      workersLosingNetwork(file([w({ id: 'a', prompt: 'use webfetch to read the page' })]))
    ).toHaveLength(1)
  })

  it('lists one whose system prompt mentions a URL', () => {
    expect(
      workersLosingNetwork(file([w({ id: 'a', systemPrompt: 'docs at http://x.dev' })]))
    ).toHaveLength(1)
  })

  it('does not list a worker that never mentions the network', () => {
    expect(workersLosingNetwork(file([w({ id: 'a', prompt: 'summarise the repo' })]))).toEqual([])
  })

  it('does not list a worker that already carries the field (the notice is one-time)', () => {
    expect(
      workersLosingNetwork(file([w({ prompt: 'see https://x.dev', allowNetwork: false })]))
    ).toEqual([])
    expect(
      workersLosingNetwork(file([w({ prompt: 'see https://x.dev', allowNetwork: true })]))
    ).toEqual([])
  })

  it('does not list an act worker — act has no allowlist, so nothing was lost', () => {
    expect(workersLosingNetwork(file([w({ mode: 'act', prompt: 'see https://x.dev' })]))).toEqual(
      []
    )
  })

  it('survives garbage', () => {
    expect(workersLosingNetwork('not json')).toEqual([])
    expect(workersLosingNetwork(JSON.stringify({ workers: 'nope' }))).toEqual([])
  })
})

describe('BUG-166 — agent verbs: turning network on confirms', () => {
  const REPO = '/home/u/repo'
  const policy: Policy = {
    serverEnabled: true,
    denyFolders: [],
    allowFolders: [REPO],
    knownRoots: [REPO]
  }
  const plan = (tool: string, input: unknown): ReturnType<typeof planToolCall> =>
    planToolCall({ tool, input, policy, now: 1_700_000_000_000 })

  const base = { folder: REPO, name: 'w', prompt: 'p', everyMinutes: 15 }

  it('create_worker with allowNetwork:true confirms, observe mode included', () => {
    const r = plan('create_worker', { ...base, mode: 'observe', allowNetwork: true })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldDispatch).toBe(false)
  })

  it('create_worker with allowNetwork:false or omitted stays free', () => {
    expect(plan('create_worker', { ...base, allowNetwork: false }).verdict).toBe('allow')
    expect(plan('create_worker', base).verdict).toBe('allow')
  })

  it('update_worker setting allowNetwork:true confirms — the same risk class as mode:"act"', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { allowNetwork: true } })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
  })

  it('update_worker setting allowNetwork:false stays free — turning it off is the safe direction', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { allowNetwork: false } })
    expect(r.verdict).toBe('allow')
  })

  it('the validators accept the field', () => {
    const c = parseCreateWorker({ ...base, allowNetwork: true })
    expect(c.ok && c.value.allowNetwork).toBe(true)
    const u = parseUpdateWorker({ id: 'w1', set: { allowNetwork: true } })
    expect(u.ok && u.value.set.allowNetwork).toBe(true)
  })

  it('the validators refuse a non-boolean', () => {
    expect(parseCreateWorker({ ...base, allowNetwork: 'yes' }).ok).toBe(false)
    expect(parseUpdateWorker({ id: 'w1', set: { allowNetwork: 1 } }).ok).toBe(false)
  })
})
