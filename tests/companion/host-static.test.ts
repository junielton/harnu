import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { post, shortTmp } from './support/client'
import { createCompanionHost, fakeMode, tick } from './support/host-rig'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import type { EndpointFile } from '../../src/main/companion/contract'

const root = join(__dirname, '..', '..')
const companionDir = join(root, 'src', 'main', 'companion')
const sources = readdirSync(companionDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(companionDir, f), 'utf8') }))

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/**
 * Strips string literals but keeps what a template literal interpolates: `${spawnToken}` inside a
 * backtick string is an identifier passed to the call, the prose around it is not.
 */
function stripLiterals(args: string): string {
  return args
    .replace(/`(?:\\.|[^`\\])*`/g, (lit) =>
      [...lit.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' ')
    )
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '')
}

/** The identifiers of every `console.*(...)` call in a source text. */
function consoleIdentifiers(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/console\.\w+\(/g)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    out.push(stripLiterals(text.slice(start, i - 1)))
  }
  return out
}

describe('secrets never leave the table', () => {
  it('no secret leaves the table (conformance row 20)', async () => {
    const dir = join(shortTmp('hc-st-'), 'companion')
    const bus: unknown[] = []
    const host = createCompanionHost({ dir, mode: fakeMode('shadow').mode, log: () => undefined })
    cleanups.push(
      () => host.close(),
      () => rmSync(join(dir, '..'), { recursive: true, force: true })
    )
    await host.register()
    host.facade.setEnablePolicy(() => ['sense.identity'])
    host.facade.registerEventTypes(['subagent.started'])
    host.facade.bus.on('hello', (...a) => void bus.push(a))
    host.facade.bus.on('event', (...a) => void bus.push(a))
    host.facade.bus.on('lease', (...a) => void bus.push(a))
    host.facade.bus.on('end', (...a) => void bus.push(a))
    host.facade.onBindingChange((b) => void bus.push(b))

    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const secrets: string[] = [ep.token, ep.token.slice(0, 12)]
    const tokens: string[] = []
    for (const id of ['a', 'b', 'c']) {
      const spawn = host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: id },
        trust: 'operator',
        cwd: '/tmp/example-project'
      })!
      tokens.push(spawn)
      secrets.push(spawn, spawn.slice(3)) // with and without the `sp_` prefix
      const sid = `0000000${tokens.length}-0000-4000-8000-000000000000`
      const r = await post(ep, 'hello', { body: { ...helloSpawnRequest, sid, spawn } })
      secrets.push(r.json.conn, r.json.conn.slice(2))
      await post(ep, 'events', {
        body: {
          v: 1,
          sid,
          conn: r.json.conn,
          sentAt: 1,
          events: [{ seq: 1, t: 'subagent.started', ts: 1, d: { agentType: 'x' } }]
        }
      })
    }
    host.facade.releaseSpawn({ kind: 'pty', ptyId: 'c' }, 'pty-exit')
    host.facade.revoke(host.facade.getBinding('00000001-0000-4000-8000-000000000000')!)
    await tick()

    const diagnostics = JSON.stringify(host.facade.diagnostics())
    const published = JSON.stringify(bus)
    const records = JSON.stringify([
      host.facade.spawnRecord({ kind: 'pty', ptyId: 'a' }),
      host.facade.getBinding('00000001-0000-4000-8000-000000000000')
    ])
    expect(bus.length).toBeGreaterThan(5)
    for (const s of secrets) {
      expect(s.length).toBeGreaterThan(8)
      expect(diagnostics).not.toContain(s)
      expect(published).not.toContain(s)
      expect(records).not.toContain(s)
    }
    expect(diagnostics).not.toMatch(/socketPath|c\.sock|"port"/)
    expect(diagnostics).not.toMatch(/"conn"|spawnToken/)
  })
})

describe('static checks of src/main/companion', () => {
  it('the console scanner sees a leaked identifier and ignores prose', () => {
    const idents = consoleIdentifiers(
      'console.log("the token is", spawnToken); console.warn(`bad ${endpointToken}`); console.info("a token in prose")'
    )
    expect(idents).toHaveLength(3)
    expect(idents.filter((i) => /token/i.test(i))).toHaveLength(2) // the two identifiers, not the prose
  })

  it('static: no secret logging, no legacy coupling', () => {
    expect(sources.length).toBeGreaterThanOrEqual(10)
    const secretIdent = /(token|conn|secret|bearer|authorization)/i
    for (const { file, text } of sources) {
      // every console.* call: refuse a secret-shaped identifier among its arguments
      for (const identifiers of consoleIdentifiers(text)) {
        expect(identifiers, `${file}: console call passes ${identifiers}`).not.toMatch(secretIdent)
      }
      // legacy coupling: the companion is born beside the old paths, never on top of them
      for (const imp of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = imp[1]
        expect(spec, `${file} imports ${spec}`).not.toMatch(/hook-bridge|responder-registry/)
        if (/(^|\/)pty$/.test(spec)) {
          const named = text.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/pty['"]/)
          expect(named?.[1].trim(), `${file} imports pty internals`).toBe('sessionKeyForPty')
        }
      }
    }
  })

  it('the dev mint is registered only behind the isPackaged check', () => {
    const ipc = readFileSync(join(companionDir, 'companion-ipc.ts'), 'utf8')
    const at = ipc.indexOf("'companion:devMintSpawn'")
    expect(at).toBeGreaterThan(-1)
    expect(ipc.indexOf("'companion:devMintSpawn'", at + 1)).toBe(-1) // registered exactly once
    const guard = ipc.lastIndexOf('if (!app.isPackaged)', at)
    expect(guard).toBeGreaterThan(-1)
    // the registration lies inside the guard's block
    const open = ipc.indexOf('{', guard)
    let depth = 0
    let close = -1
    for (let i = open; i < ipc.length; i++) {
      if (ipc[i] === '{') depth++
      if (ipc[i] === '}' && --depth === 0) {
        close = i
        break
      }
    }
    expect(at).toBeGreaterThan(open)
    expect(at).toBeLessThan(close)
    // diagnostics, by contrast, is registered unconditionally
    expect(ipc.indexOf("'companion:diagnostics'")).toBeLessThan(guard)
  })

  it('the Electron glue is excluded from coverage with a reason; the cores are not', () => {
    const cfg = readFileSync(join(root, 'vitest.config.mts'), 'utf8')
    for (const shell of ['host.ts', 'companion-ipc.ts', 'audit-log.ts']) {
      expect(cfg).toMatch(new RegExp(`'src/main/companion/${shell.replace('.', '\\.')}',\\s*//`))
    }
    for (const core of [
      'host-core',
      'server',
      'session-table',
      'wire-core',
      'rendezvous',
      'mode'
    ]) {
      expect(cfg).not.toContain(`src/main/companion/${core}.ts'`)
    }
  })

  it('index.ts registers the host beside the hook bridge and closes it on quit', () => {
    const index = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    expect(index).toMatch(/void registerCompanionHost\(\(\) => mainWindow\)\.catch/)
    expect(index).toMatch(/void closeCompanionHost\(\)/)
  })
})
