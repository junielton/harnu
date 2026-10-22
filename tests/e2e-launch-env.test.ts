import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildElectronEnv } from './e2e/ci/fixtures/launch-env'

/**
 * BUG-199 — an Electron child launched from a Wayland session ignores xvfb and opens its window
 * on the operator's real desktop. Every e2e launch therefore goes through one helper whose env
 * builder drops the two variables that make Electron pick the Wayland compositor.
 */
describe('buildElectronEnv', () => {
  const wayland = {
    PATH: '/usr/bin',
    DISPLAY: ':99',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_SESSION_TYPE: 'wayland'
  }

  it('removes WAYLAND_DISPLAY and XDG_SESSION_TYPE from the child environment', () => {
    const env = buildElectronEnv(wayland)
    expect(env).not.toHaveProperty('WAYLAND_DISPLAY')
    expect(env).not.toHaveProperty('XDG_SESSION_TYPE')
    expect(env.DISPLAY).toBe(':99')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('does not let an override put the Wayland variables back', () => {
    const env = buildElectronEnv(wayland, { XDG_SESSION_TYPE: 'wayland', HOME: '/tmp/h' })
    expect(env).not.toHaveProperty('XDG_SESSION_TYPE')
    expect(env.HOME).toBe('/tmp/h')
  })

  it('does not mutate the environment it was given', () => {
    const base = { ...wayland }
    buildElectronEnv(base)
    expect(base).toEqual(wayland)
  })

  it('drops undefined values so the result is a plain string map', () => {
    const env = buildElectronEnv({ A: '1', B: undefined })
    expect(env).toEqual({ A: '1' })
  })
})

describe('e2e launch call sites', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
    })

  it('launches Electron only from the shared helper', () => {
    const offenders = files(join(__dirname))
      .filter((f) => !f.endsWith('e2e-launch-env.test.ts'))
      .filter((f) => /electron\.launch\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(__dirname, f))
    expect(offenders).toEqual(['e2e/ci/fixtures/launch-app.ts'])
  })
})
