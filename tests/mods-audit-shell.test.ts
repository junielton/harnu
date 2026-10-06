/**
 * T389 P4W1 — AC-P4W1-10, -11, -12 and the negative paths of spec §8, against real
 * temp directories with a fake `claude` runner.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createModsAudit } from '../src/main/mods-audit'
import { baseDeps, fakeCli, fixture, makeEnv, ok, type Env } from './mods-audit-shell-helpers'

let env: Env
afterEach(async () => {
  await env.cleanup()
})

describe('mods-audit shell', () => {
  it('no CLI, no spawn', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const { deps } = baseDeps(env, cli, { resolveClaude: async () => null })
    const svc = createModsAudit(deps)
    const view = await svc.list(null)
    expect(view.cli).toEqual({ path: null, version: null })
    expect(view.rows).toEqual([])
    expect((await svc.analyse({ folder: null })).queued).toBe(0)
    await svc.idle()
    expect(cli.run).not.toHaveBeenCalled()
  })

  it('one timeout does not blank the pane', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    await env.addSkillsDirMod('slow-one')
    await env.addSkillsDirMod('zeta')
    const cli = fakeCli()
    const { deps, emitted } = baseDeps(env, cli)
    const svc = createModsAudit(deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()

    const byName = Object.fromEntries(emitted.map((r) => [r.name, r.analysis?.status]))
    expect(byName).toEqual({ alpha: 'ok', 'slow-one': 'failed', zeta: 'ok' })
    const view = await svc.list(null)
    const chips = view.rows
      .filter((r) => r.analysis?.status === 'ok')
      .map((r) => r.analysis!.capabilities)
    expect(chips).toEqual([['tool-calls'], ['tool-calls']])
    // a failed run is not cached: Retry runs it again
    const failed = view.rows.find((r) => r.name === 'slow-one')!
    expect(failed.analysis).toBeNull()
    cli.run.mockClear()
    expect((await svc.analyse({ folder: null, keys: [failed.key], force: true })).queued).toBe(1)
    await svc.idle()
    expect(cli.validateCalls()).toHaveLength(1)
  })

  it('unknown keys are ignored', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(null)
    cli.run.mockClear()
    const outsider = path.join(env.home, 'elsewhere')
    await fs.mkdir(outsider)
    const keys = [
      'skills-dir\u0000x\u0000' + outsider,
      outsider,
      '../../etc',
      '',
      'not-a-key',
      JSON.stringify({ root: outsider })
    ]
    expect((await svc.analyse({ folder: null, keys })).queued).toBe(0)
    await svc.idle()
    expect(cli.validateCalls()).toEqual([])
    // junk arguments are tolerated too
    expect(
      (await svc.analyse({ folder: null, keys: [1, null, {}] as unknown as string[] })).queued
    ).toBe(0)
    // a folder that was never listed has no keys to resolve
    expect((await svc.analyse({ folder: '/never/listed', keys })).queued).toBe(0)
  })

  it('analyses at most two at a time', async () => {
    env = await makeEnv()
    for (const n of ['a1', 'a2', 'a3', 'a4', 'a5']) await env.addSkillsDirMod(n)
    const cli = fakeCli()
    let running = 0
    let peak = 0
    const inner = cli.run.getMockImplementation()!
    cli.run.mockImplementation(async (bin: string, args: string[]) => {
      if (args[1] !== 'validate') return inner(bin, args)
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 15))
      running--
      return inner(bin, args)
    })
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    expect(cli.validateCalls()).toHaveLength(5)
    expect(peak).toBe(2)
  })

  it('re-targets a marketplace-shaped directory once', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('market-one')
    const cli = fakeCli()
    const { deps, emitted } = baseDeps(env, cli)
    const svc = createModsAudit(deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    const calls = cli.validateCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1]![2]).toMatch(/\.claude-plugin\/plugin\.json$/)
    expect(emitted[0]!.analysis!.capabilities).toEqual(['tool-calls'])
  })

  it('counts plugins without a mod instead of listing them', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    await env.addSkillsDirMod('plain-one')
    await env.addSkillsDirMod('plain-two')
    const cli = fakeCli()
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    const view = await svc.list(null)
    expect(view.rows.map((r) => r.name)).toEqual(['alpha'])
    expect(view.withoutModule).toBe(2)
  })

  it('marks every row unsupported when the CLI cannot validate', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const inner = cli.run.getMockImplementation()!
    cli.run.mockImplementation(async (bin: string, args: string[]) =>
      args[1] === 'validate'
        ? {
            stdout: '',
            stderr: "error: unknown command 'validate'",
            code: 1,
            timedOut: false,
            spawnError: false
          }
        : inner(bin, args)
    )
    const { deps, emitted } = baseDeps(env, cli)
    const svc = createModsAudit(deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    expect(emitted[0]!.analysis!.status).toBe('unsupported')
    expect(emitted[0]!.analysis!.capabilities).toEqual([])
    const view = await svc.list(null)
    expect(view.rows).toHaveLength(1) // still listed, from the filesystem
  })

  it('an unparseable report is failed, not a crash', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli()
    const inner = cli.run.getMockImplementation()!
    cli.run.mockImplementation(async (bin: string, args: string[]) =>
      args[1] === 'validate' ? ok('this is not json') : inner(bin, args)
    )
    const { deps, emitted } = baseDeps(env, cli)
    const svc = createModsAudit(deps)
    await svc.list(null)
    await svc.analyse({ folder: null })
    await svc.idle()
    expect(emitted[0]!.analysis!.status).toBe('failed')
  })

  it('drops installed rows when plugin list fails, the other sources still list', async () => {
    env = await makeEnv()
    await env.addSkillsDirMod('alpha')
    const cli = fakeCli({ listFails: true })
    const view = await createModsAudit(baseDeps(env, cli).deps).list(null)
    expect(view.installedUnreadable).toBe(true)
    expect(view.rows.map((r) => r.name)).toEqual(['alpha'])

    const cli2 = fakeCli({ listJson: '{"plugins": []}' })
    const view2 = await createModsAudit(baseDeps(env, cli2).deps).list(null)
    expect(view2.installedUnreadable).toBe(true)
  })

  it('lists installed rows for the folder and keeps the dedupe', async () => {
    env = await makeEnv()
    const installRoot = path.join(env.home, 'cache', 'm', 'tool', '1.0.0')
    await fs.mkdir(path.join(installRoot, '.claude-plugin'), { recursive: true })
    const folder = path.join(env.home, 'proj')
    await fs.mkdir(folder)
    const list = JSON.stringify([
      { id: 'tool@m', version: '1.0.0', scope: 'user', enabled: true, installPath: installRoot },
      {
        id: 'tool@m',
        version: '1.0.0',
        scope: 'local',
        enabled: true,
        installPath: installRoot,
        projectPath: folder
      },
      {
        id: 'tool@m',
        version: '1.0.0',
        scope: 'local',
        enabled: true,
        installPath: installRoot,
        projectPath: '/other'
      },
      {
        id: 'gone@m',
        version: '1.0.0',
        scope: 'user',
        enabled: true,
        installPath: path.join(env.home, 'nope')
      }
    ])
    const cli = fakeCli({ listJson: list })
    const view = await createModsAudit(baseDeps(env, cli).deps).list(folder)
    expect(view.rows.map((r) => [r.name, r.source, r.scope])).toEqual([
      ['tool', 'installed', 'user']
    ])
  })

  it('reads sources: companion first, Boot --plugin-dir, settings env, folder skills', async () => {
    env = await makeEnv()
    const companion = path.join(env.home, 'stage', 'companion')
    await fs.mkdir(path.join(companion, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(companion, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'harnu-companion', version: '0.1.0' })
    )
    const bootDir = path.join(env.home, 'dev', 'boot-mod')
    await fs.mkdir(path.join(bootDir, '.claude-plugin'), { recursive: true })
    await fs.writeFile(path.join(bootDir, '.claude-plugin', 'plugin.json'), '{"name":"boot-mod"}')
    const envDir = path.join(env.home, 'dev', 'env-mod')
    await fs.mkdir(envDir, { recursive: true })
    const folder = path.join(env.home, 'proj')
    await fs.mkdir(path.join(folder, '.claude', 'skills', 'local-mod', '.claude-plugin'), {
      recursive: true
    })
    await fs.writeFile(
      path.join(folder, '.claude', 'skills', 'local-mod', '.claude-plugin', 'plugin.json'),
      '{"name":"local-mod"}'
    )
    const cli = fakeCli()
    const { deps } = baseDeps(env, cli, {
      companionDir: async () => companion,
      readBoot: async () => ({
        extraArgs: `--model x --plugin-dir ${bootDir} --plugin-dir=${companion}`
      }),
      settingsPluginDirs: async () => [envDir, companion].join(path.delimiter)
    })
    const svc = createModsAudit(deps)

    const folderView = await svc.list(folder)
    expect(folderView.rows.map((r) => [r.name, r.source])).toEqual([
      ['harnu-companion', 'harnu'],
      ['boot-mod', 'boot-arg'],
      ['env-mod', 'boot-arg'],
      ['local-mod', 'skills-dir']
    ])
    expect(folderView.rows[0]!.root).toBe(companion)

    // global scope: no Boot extraArgs, no folder skills; the settings env dirs stay
    const globalView = await svc.list(null)
    expect(globalView.rows.map((r) => r.name)).toEqual(['harnu-companion', 'env-mod'])
  })

  it('reports safe-mode folders and the probe policy', async () => {
    env = await makeEnv()
    const folder = path.join(env.home, 'proj')
    await fs.mkdir(folder)
    const cli = fakeCli()
    const svc = createModsAudit(
      baseDeps(env, cli, {
        readBoot: async () => ({ safeMode: true }),
        policy: async () => 'off-here'
      }).deps
    )
    const view = await svc.list(folder)
    expect(view.safeMode).toBe(true)
    expect(view.policy).toBe('off-here')
    // the pane never claims a policy it did not observe
    const plain = await createModsAudit(baseDeps(env, cli).deps).list(folder)
    expect(plain.policy).toBe('unknown')
    expect(plain.safeMode).toBe(false)
  })

  it('answers permissionHookers from cached analyses only', async () => {
    env = await makeEnv()
    const root = await env.addSkillsDirMod('guard')
    const cli = fakeCli()
    const folder = path.join(env.home, 'proj')
    await fs.mkdir(folder)
    // `skills-dir` rows have loadsInFolder `unknown`: a lower bound leaves them out
    const svc = createModsAudit(baseDeps(env, cli).deps)
    await svc.list(folder)
    await svc.analyse({ folder })
    await svc.idle()
    cli.run.mockClear()
    expect(await svc.permissionHookers(folder)).toEqual([])
    expect(cli.run).not.toHaveBeenCalled()

    // a boot-arg mod loads in the folder for sure
    const { deps } = baseDeps(env, cli, {
      readBoot: async () => ({ extraArgs: `--plugin-dir ${root}` })
    })
    const svc2 = createModsAudit({ ...deps, home: () => path.join(env.home, 'no-skills-here') })
    await svc2.list(folder)
    await svc2.analyse({ folder })
    await svc2.idle()
    cli.run.mockClear()
    expect(await svc2.permissionHookers(folder)).toEqual([{ name: 'guard', root }])
    expect(cli.run).not.toHaveBeenCalled()

    // the bytes change: the cached analysis is stale and drops out
    await fs.writeFile(path.join(root, 'hooks', 'register.ts'), '// edited\n')
    expect(await svc2.permissionHookers(folder)).toEqual([])
    // never listed: nothing to answer from
    expect(await svc2.permissionHookers('/never/listed')).toEqual([])
    void fixture
  })
})
