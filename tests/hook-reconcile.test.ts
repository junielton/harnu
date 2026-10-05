import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHookConfig,
  hookPort,
  hookToken,
  harnuPorts,
  reconcileHooks,
  installHooks,
  uninstallHooks,
  removeOwnHooksSync,
  SENTINEL
} from '../src/main/hook-installer'

/**
 * Self-healing reconciliation of Capy's observer hooks in the global
 * `~/.claude/settings.json`. The bug this fixes: stale entries from instances
 * that died (crash / SIGKILL / a killed e2e instance) keep POSTing to a dead
 * port → `ECONNREFUSED` in every later Claude Code session. Reconciliation
 * prunes DEAD peers (keeping LIVE ones so a second instance can't clobber a
 * running one) and removes our own entry on exit.
 */

type Handler = Record<string, unknown>
const ourHttp = (port: number, token: string): Handler => ({
  type: 'http',
  url: `http://127.0.0.1:${port}/hook/${token}/UserPromptSubmit/_`,
  timeout: 5,
  [SENTINEL]: 'v1'
})
const ourCmd = (port: number, token: string): Handler => ({
  type: 'command',
  command: `curl -s -X POST --data-binary @- http://127.0.0.1:${port}/hook/${token}/Stop/_`,
  timeout: 5,
  [SENTINEL]: 'v1'
})
const userCmd: Handler = { type: 'command', command: 'bash ~/.claude/hooks/my-notify.sh' }

// Post-strip reality: Claude Code re-serializes ~/.claude/settings.json through a
// strict Zod schema that drops unknown keys from hook handlers, so our `_om2tab`
// sentinel is gone after any CC settings write (e.g. `/model`). Only the standard
// `type`/`url`/`timeout`/`command` fields survive. Self-heal must still recognize
// these as ours by their bridge-URL shape — otherwise dead-port orphans are never
// pruned and every later session POSTs to a dead port (ECONNREFUSED).
const ourHttpStripped = (port: number, token: string): Handler => ({
  type: 'http',
  url: `http://127.0.0.1:${port}/hook/${token}/UserPromptSubmit/_`,
  timeout: 5
})
const ourCmdStripped = (port: number, token: string): Handler => ({
  type: 'command',
  command: `curl -s -X POST --data-binary @- http://127.0.0.1:${port}/hook/${token}/Stop/_`,
  timeout: 5
})

function allHandlers(settings: Record<string, unknown>): Handler[] {
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks?: Handler[] }>>
  return Object.values(hooks).flatMap((entries) => entries.flatMap((e) => e.hooks ?? []))
}
const portsPresent = (s: Record<string, unknown>): number[] =>
  allHandlers(s)
    .map(hookPort)
    .filter((p): p is number => p !== null)

describe('hookPort / hookToken — parse the loopback port + token', () => {
  it('reads port + token from an http handler', () => {
    const h = ourHttp(40123, 'tok-abc')
    expect(hookPort(h)).toBe(40123)
    expect(hookToken(h)).toBe('tok-abc')
  })
  it('reads port + token from a command (curl) handler', () => {
    const h = ourCmd(50456, 'tok-xyz')
    expect(hookPort(h)).toBe(50456)
    expect(hookToken(h)).toBe('tok-xyz')
  })
  it('returns null for a non-om2tab handler', () => {
    expect(hookPort(userCmd)).toBeNull()
    expect(hookToken(userCmd)).toBeNull()
  })
})

describe('harnuPorts — distinct ports of our handlers', () => {
  it('collects distinct ports across events, ignoring foreign hooks', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [ourHttp(1111, 'a'), userCmd] }],
        Stop: [{ hooks: [ourCmd(2222, 'b')] }, { hooks: [ourHttp(1111, 'a')] }]
      }
    }
    expect(harnuPorts(settings).sort((x, y) => x - y)).toEqual([1111, 2222])
  })
})

describe('reconcileHooks — prune dead peers + own, keep live peers, optionally add', () => {
  let settings: Record<string, unknown>
  beforeEach(() => {
    settings = {
      model: 'keep-me', // unknown top-level key must survive
      hooks: {
        UserPromptSubmit: [{ hooks: [ourHttp(1111, 'peerLive'), ourHttp(2222, 'peerDead')] }],
        SessionStart: [{ hooks: [ourHttp(3333, 'ownTok')] }],
        Stop: [{ matcher: '', hooks: [userCmd] }]
      }
    }
  })

  it('install: drops dead peer + own-stale, keeps live peer + foreign, adds our new entry', () => {
    const out = reconcileHooks(settings, {
      add: buildHookConfig(9999, 'ownTok'),
      ourToken: 'ownTok',
      deadPorts: new Set([2222])
    })
    const ports = portsPresent(out)
    expect(ports).toContain(1111) // live peer kept
    expect(ports).not.toContain(2222) // dead peer pruned
    expect(ports).not.toContain(3333) // own-stale (token match) pruned
    expect(ports).toContain(9999) // our fresh entry added
    expect(allHandlers(out)).toContainEqual(userCmd) // foreign untouched
    expect(out.model).toBe('keep-me') // unknown key preserved
  })

  it('exit/uninstall-own: removes only our token, keeps peers (live AND dead) + foreign', () => {
    const out = reconcileHooks(settings, { ourToken: 'ownTok' })
    const ports = portsPresent(out)
    expect(ports).toContain(1111)
    expect(ports).toContain(2222) // no deadPorts given → dead peer left alone
    expect(ports).not.toContain(3333) // our token removed
    expect(allHandlers(out)).toContainEqual(userCmd)
  })

  it('prune-only (disabled boot): drops dead + own, no add', () => {
    const out = reconcileHooks(settings, { ourToken: 'ownTok', deadPorts: new Set([2222]) })
    expect(portsPresent(out)).toEqual([1111])
    expect(allHandlers(out)).toContainEqual(userCmd)
  })

  it('drops emptied entries/events and deletes hooks entirely when nothing remains', () => {
    const onlyOurs = { hooks: { SessionStart: [{ hooks: [ourHttp(3333, 'ownTok')] }] } }
    const out = reconcileHooks(onlyOurs, { ourToken: 'ownTok' })
    expect(out.hooks).toBeUndefined()
  })

  it('no-op when nothing matches (no add, no token, no deadPorts)', () => {
    const out = reconcileHooks(settings, {})
    expect(portsPresent(out).sort((x, y) => x - y)).toEqual([1111, 2222, 3333])
  })
})

describe('self-heal survives Claude Code stripping our _om2tab sentinel', () => {
  it('hookPort/hookToken parse a sentinel-less handler (CC keeps url/command)', () => {
    expect(hookPort(ourHttpStripped(45489, 'tok'))).toBe(45489)
    expect(hookToken(ourHttpStripped(45489, 'tok'))).toBe('tok')
    expect(hookPort(ourCmdStripped(50456, 'cmdtok'))).toBe(50456)
    expect(hookToken(ourCmdStripped(50456, 'cmdtok'))).toBe('cmdtok')
  })

  it('still ignores a genuinely foreign handler (no over-broadening)', () => {
    expect(hookPort(userCmd)).toBeNull()
    expect(hookToken(userCmd)).toBeNull()
  })

  it('harnuPorts finds our ports even without the sentinel', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [ourHttpStripped(45489, 'a'), userCmd] }],
        Stop: [{ hooks: [ourCmdStripped(35193, 'b')] }]
      }
    }
    expect(harnuPorts(settings).sort((x, y) => x - y)).toEqual([35193, 45489])
  })

  it('prunes a DEAD sentinel-less peer (the real ECONNREFUSED orphan)', () => {
    const settings = {
      model: 'keep-me',
      hooks: {
        UserPromptSubmit: [
          { hooks: [ourHttpStripped(35193, 'live')] },
          { hooks: [ourHttpStripped(45489, 'dead')] }
        ],
        Stop: [{ hooks: [userCmd] }]
      }
    }
    const out = reconcileHooks(settings, { deadPorts: new Set([45489]) })
    const ports = portsPresent(out)
    expect(ports).toContain(35193) // live peer kept
    expect(ports).not.toContain(45489) // dead orphan pruned despite missing sentinel
    expect(allHandlers(out)).toContainEqual(userCmd) // foreign untouched
    expect(out.model).toBe('keep-me')
  })

  it('removes our own sentinel-less entry on exit (token match after CC strip)', () => {
    const out = reconcileHooks(
      { hooks: { SessionStart: [{ hooks: [ourHttpStripped(35193, 'mine'), userCmd] }] } },
      { ourToken: 'mine' }
    )
    // sentinel-independent: our handler is gone, only the foreign hook remains
    expect(allHandlers(out)).toEqual([userCmd])
  })
})

describe('reconcileHooks — T338 team-event migration (dead-port prior-boot handler)', () => {
  // The removal drops TaskCreated/TaskCompleted/TeammateIdle from EVENT_SPECS, so
  // a fresh install never re-adds them — but an EXISTING install from an older
  // Capy build already wrote a TeammateIdle handler into ~/.claude/settings.json
  // under a now-dead boot's port. `reconcileHooks` is generic over event names
  // (it walks whatever `settings.hooks` actually holds, not EVENT_SPECS), so this
  // proves the self-heal still prunes that orphan on the next boot even though
  // the code that used to install it is gone — and never touches an unrelated
  // foreign hook on the same event name.
  it('prunes a prior-boot Capy TeammateIdle handler whose port is dead', () => {
    const settings = {
      hooks: {
        TeammateIdle: [{ hooks: [ourHttp(6060, 'oldBoot')] }]
      }
    }
    const out = reconcileHooks(settings, { deadPorts: new Set([6060]) })
    expect(portsPresent(out)).toEqual([])
    expect(out.hooks).toBeUndefined()
  })

  it('keeps a foreign (non-Capy) TeammateIdle hook untouched alongside a pruned dead one', () => {
    const foreignTeammateIdle: Handler = {
      type: 'command',
      command: 'bash ~/.claude/hooks/notify-teammate-idle.sh'
    }
    const settings = {
      hooks: {
        TeammateIdle: [{ hooks: [ourHttp(6060, 'oldBoot'), foreignTeammateIdle] }]
      }
    }
    const out = reconcileHooks(settings, { deadPorts: new Set([6060]) })
    expect(portsPresent(out)).toEqual([])
    expect(allHandlers(out)).toEqual([foreignTeammateIdle])
  })
})

describe('installHooks / uninstallHooks / removeOwnHooksSync (file I/O)', () => {
  let path: string
  beforeEach(() => {
    path = join(
      tmpdir(),
      `harnu-reconcile-${process.pid}-${Math.random().toString(36).slice(2)}.json`
    )
  })
  afterEach(() => {
    try {
      rmSync(path)
    } catch {
      /* ignore */
    }
  })
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

  it('installHooks prunes a dead peer while keeping a foreign hook, and adds ours', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [userCmd] }],
          UserPromptSubmit: [{ hooks: [ourHttp(2222, 'dead')] }]
        }
      })
    )
    await installHooks(40000, 'fresh', { path, deadPorts: new Set([2222]) })
    const out = read()
    expect(portsPresent(out)).not.toContain(2222)
    expect(portsPresent(out)).toContain(40000)
    expect(allHandlers(out)).toContainEqual(userCmd)
  })

  it('installHooks keeps a LIVE peer (does not clobber a running instance)', async () => {
    writeFileSync(
      path,
      JSON.stringify({ hooks: { Stop: [{ hooks: [ourCmd(1111, 'livepeer')] }] } })
    )
    await installHooks(40000, 'fresh', { path, deadPorts: new Set() })
    const ports = portsPresent(read())
    expect(ports).toContain(1111) // live peer survives
    expect(ports).toContain(40000)
  })

  it('uninstallHooks({token}) removes only our entry, keeping a peer', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [ourHttp(40000, 'mine'), ourHttp(1111, 'peer')] }] }
      })
    )
    await uninstallHooks({ path, token: 'mine' })
    expect(portsPresent(read())).toEqual([1111])
  })

  it('removeOwnHooksSync removes our entry synchronously (for exit handlers)', () => {
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [ourHttp(40000, 'mine'), userCmd] }] } })
    )
    removeOwnHooksSync('mine', path)
    const out = read()
    expect(portsPresent(out)).toEqual([])
    expect(allHandlers(out)).toContainEqual(userCmd)
  })

  it('removeOwnHooksSync never throws on a missing/garbage file', () => {
    expect(() => removeOwnHooksSync('mine', join(tmpdir(), 'harnu-nope-xyz.json'))).not.toThrow()
    writeFileSync(path, 'not json {')
    expect(() => removeOwnHooksSync('mine', path)).not.toThrow()
  })
})
