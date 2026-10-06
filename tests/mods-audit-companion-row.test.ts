/**
 * T389 P4W1 — AC-P4W1-14 at the unit level: row 1 is the staged Harnu mod, produced by the
 * same code path as every other row (P4W1-S4), and its chips are the ones its checked-in
 * `api-surface.json` implies. LV-P4W1-a repeats it against the running app.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createModsAudit } from '../src/main/mods-audit'
import { deriveCapabilities } from '../src/main/mods-audit-core'
import surface from '../resources/companion/api-surface.json'
import { baseDeps, fakeCli, makeEnv, type Env } from './mods-audit-shell-helpers'

let env: Env | undefined
afterEach(async () => {
  await env?.cleanup()
})

describe('the Harnu mod row', () => {
  it('derives its chips from api-surface.json', () => {
    const chips = deriveCapabilities({
      hooks: surface.hooks.map((event) => ({ event, opaque: false })),
      calls: surface.calls.map((c) => ({ op: c.replace(/^\$\./, '') })),
      env: { reads: surface.envReads }
    })
    // $.http.fetch, $.fs.read and the env read; no hook of the mod maps to a chip.
    expect(chips).toEqual(['network', 'files', 'env'])
  })

  it('is first, labelled harnu, and absent when nothing is staged', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const staged = await env.addSkillsDirMod('harnu-companion')
    const cli = fakeCli()

    const withMod = createModsAudit(baseDeps(env, cli, { companionDir: async () => staged }).deps)
    const first = (await withMod.list(null)).rows
    expect(first[0]).toMatchObject({ name: 'harnu-companion', source: 'harnu' })
    expect(first.filter((r) => r.root === first[0]!.root)).toHaveLength(1)

    const without = createModsAudit(baseDeps(env, cli).deps)
    const rows = (await without.list(null)).rows
    expect(rows.some((r) => r.source === 'harnu')).toBe(false)
  })
})
