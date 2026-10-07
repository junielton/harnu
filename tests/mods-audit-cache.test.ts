/**
 * T389 P4W1 — AC-P4W1-8: an analysis is cached by content hash + CLI version, so
 * reopening the tab (or restarting Harnu) never re-runs `validate` for a plugin
 * whose bytes did not change. Real files and a real cache file; only the CLI is fake.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createModsAudit } from '../src/main/mods-audit'
import { baseDeps, fakeCli, makeEnv, type Env } from './mods-audit-shell-helpers'

let env: Env
afterEach(async () => {
  await env.cleanup()
})

describe('mods-audit cache', () => {
  it('a cache hit runs nothing', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    await env.addSkillsDirMod('beta')
    const cli = fakeCli()
    const { deps } = baseDeps(env, cli)
    const svc = createModsAudit(deps)

    const first = await svc.list(null)
    expect(first.rows).toHaveLength(2)
    expect(first.rows.every((r) => r.analysis === null)).toBe(true)
    const { queued } = await svc.analyse({ folder: null })
    expect(queued).toBe(2)
    await svc.idle()
    expect(cli.validateCalls()).toHaveLength(2)

    // second open of the tab: rows come back analysed, nothing is queued
    const second = await svc.list(null)
    expect(second.rows.map((r) => r.analysis?.status)).toEqual(['ok', 'ok'])
    expect((await svc.analyse({ folder: null })).queued).toBe(0)
    await svc.idle()
    expect(cli.validateCalls()).toHaveLength(2)

    // a restart reads the cache file
    const { deps: deps2 } = baseDeps(env, cli)
    const svc2 = createModsAudit(deps2)
    const third = await svc2.list(null)
    expect(third.rows.map((r) => r.analysis?.status)).toEqual(['ok', 'ok'])
    expect((await svc2.analyse({ folder: null })).queued).toBe(0)
    expect(cli.validateCalls()).toHaveLength(2)
  })

  it('re-runs when a file changed and records changedSince', async () => {
    env = await makeEnv()
    const root = await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const { deps } = baseDeps(env, cli)
    const svc = createModsAudit(deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    const before = (await svc.list(null)).rows[0]!.analysis!

    await fs.writeFile(path.join(root, 'hooks', 'register.ts'), '// changed\n')
    const stale = await svc.list(null)
    expect(stale.rows[0]!.analysis).toBeNull()
    expect((await svc.analyse({ folder: null })).queued).toBe(1)
    await svc.idle()
    expect(cli.validateCalls()).toHaveLength(2)
    const after = (await svc.list(null)).rows[0]!.analysis!
    expect(after.hash).not.toBe(before.hash)
    expect(after.changedSince).toBe(before.analysedAt)
  })

  it('a CLI upgrade invalidates the cache', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const a = createModsAudit(baseDeps(env, cli).deps)
    await a.list(null)
    await a.analyse({ folder: null })
    await a.idle()
    expect(cli.validateCalls()).toHaveLength(1)

    const cli2 = fakeCli()
    cli2.run.mockImplementation(async (_b: string, args: string[]) =>
      args[0] === '--version'
        ? {
            stdout: '2.1.300 (Claude Code)',
            stderr: '',
            code: 0,
            timedOut: false,
            spawnError: false
          }
        : { stdout: '[]', stderr: '', code: 0, timedOut: false, spawnError: false }
    )
    const b = createModsAudit(baseDeps(env, cli2).deps)
    const view = await b.list(null)
    expect(view.rows[0]!.analysis).toBeNull()
  })

  it('treats a corrupt cache file as empty and rewrites it', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    await fs.writeFile(env.cachePath, '{ not json')
    const cli = fakeCli()
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    const parsed = JSON.parse(await fs.readFile(env.cachePath, 'utf8'))
    expect(parsed.v).toBe(1)
    expect(Object.keys(parsed.entries)).toHaveLength(1)
  })

  it('stores hashes, names and declared facts, never file content', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha', 'const SECRET_TOKEN = "do-not-store-me"\n')
    const cli = fakeCli()
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    const text = await fs.readFile(env.cachePath, 'utf8')
    expect(text).not.toContain('do-not-store-me')
    expect(text).not.toContain('SECRET_TOKEN')
  })
})
