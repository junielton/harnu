/**
 * T456 W2 — the mod half of `park.query`, pinned from the source (spec §5.2, §14 risk "a future mod
 * change makes `park.query`'s handler write something"): the handler makes no `$` call other than
 * `$.session.surfaces` (AC-W2-10), the command is in the mod's closed tables with the feature
 * `act.park`, never tokenless, and the contract file and the checked-in surface carry it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_FEATURE,
  IMPLEMENTED_COMMANDS,
  TOKENLESS_OK
} from '../../resources/companion/hooks/lib/command-core'
import { COMMAND_NAMES } from '../../src/main/companion/command-gate-core'

const ROOT = join(__dirname, '../../resources/companion')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** The text of one top-level function of `register.ts`, from its signature to its closing brace. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  if (start < 0) throw new Error(`no function ${name}`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 2)
}

describe('runParkQuery (AC-W2-10)', () => {
  const src = read('hooks/register.ts')

  it('makes no $ call other than $.session.surfaces', () => {
    const body = functionBody(src, 'runParkQuery')
    const calls = [...body.matchAll(/\$\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`)
    expect(calls).toEqual(['session.surfaces'])
    // `$` reaches nothing else: not passed on to another function, not stored.
    const uses = [...body.matchAll(/\$(?![.\w])/g)].length
    const params = 1 // `$: Dollar` in the signature
    expect(uses - params).toBe(0)
  })

  it('is the park.query case of the closed switch', () => {
    const sw = functionBody(src, 'runHandler')
    expect(sw).toMatch(/case 'park\.query':\s*\n\s*return runParkQuery\(\$\)/)
  })

  it('the pure answer lives under hooks/lib and touches no $', () => {
    const lib = read('hooks/lib/park-query.ts')
    expect(lib).not.toMatch(/\$\./)
    expect(lib).not.toMatch(/from 'claude-code'/)
  })
})

describe('the closed tables (spec §5.2)', () => {
  it('park.query needs act.park, is implemented, and is never tokenless (spec §8.2)', () => {
    expect(COMMAND_FEATURE['park.query']).toBe('act.park')
    expect(IMPLEMENTED_COMMANDS.has('park.query')).toBe(true)
    expect(TOKENLESS_OK.has('park.query')).toBe(false)
  })

  it('the mod and the host know the same command names', () => {
    expect(Object.keys(COMMAND_FEATURE).sort()).toEqual([...COMMAND_NAMES].sort())
  })
})

describe('the contract and the surface manifest carry it', () => {
  it('contract.ts declares the command, its args and its result', () => {
    const c = read('hooks/contract.ts')
    expect(c).toMatch(/'park\.query': \{ cause: ParkCause \}/)
    expect(c).toMatch(/'park\.query': ParkQueryData/)
    expect(c).toMatch(/export type ParkBusyReason/)
  })

  it('01-contract.md names the command row, the feature and fleet.idle', () => {
    const doc = readFileSync(
      join(__dirname, '../../docs/specs/T389-companion-mod/01-contract.md'),
      'utf8'
    )
    expect(doc).toMatch(/\| `park\.query` +\|/)
    expect(doc).toMatch(/\| `act\.park` +\| actuator/)
    expect(doc).toMatch(
      /idle: \{ tasks: \{ id: string; type: string \}\[\]; crons: \{ recurring: boolean \}\[\] \} \\?\| null/
    )
  })

  it('api-surface.json lists $.session.surfaces', () => {
    const m = JSON.parse(read('api-surface.json')) as { calls: string[] }
    expect(m.calls).toContain('$.session.surfaces')
  })

  it('the plugin types declare fleet.idle', () => {
    expect(read('types/index.d.ts')).toMatch(/idle: \{/)
  })
})
