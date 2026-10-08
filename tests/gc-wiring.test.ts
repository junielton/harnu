import { readFileSync, readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The electron-bound shells cannot be imported here, so the invariants that only their wiring
// holds are pinned from source (the same approach as gc-ipc-surface.test.ts). Each test names
// the mutation it exists to catch.
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ipc = read('src/main/gc/gc-ipc.ts')
const scan = read('src/main/gc/gc-scan-shell.ts')
const reaper = read('src/main/reaper/reaper-ipc.ts')
const containersShell = read('src/main/containers/containers-shell.ts')

/** The source between a marker and the next one, so a test reads one handler and not the file. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, `missing ${from}`).toBeGreaterThanOrEqual(0)
  const b = src.indexOf(to, a + from.length)
  return src.slice(a, b < 0 ? undefined : b)
}

describe('the autopilot never takes the forced path (M7)', () => {
  it('builds its ops with createGcOps', () => {
    expect(between(ipc, 'const cycleDeps', 'reaper.setAfterScan')).toMatch(
      /opsFor: \(\) => createGcOps\(withRun\('autopilot'\)\)/
    )
  })

  it('has no import path to the forced ops from the cycle or the planner', () => {
    for (const file of ['gc-cycle.ts', 'autopilot-core.ts', 'gc-jobs-core.ts']) {
      expect(read(`src/main/gc/${file}`), file).not.toMatch(/gc-forced-ops|createForcedGcOps/)
    }
  })

  it('only the operator-actor ops are ever forced', () => {
    expect(ipc).toMatch(/forced \? createForcedGcOps\(withRun\('operator'\)\)/)
    expect(ipc.match(/createForcedGcOps\(/g)).toHaveLength(1)
  })
})

describe('gc:clean returns before the job runs (M10)', () => {
  it('the channel handler does not await anything', () => {
    const handler = between(ipc, "ipcMain.handle('gc:clean'", "ipcMain.handle('gc:keep'")
    expect(handler).not.toMatch(/await|\.finished|\.then\(/)
  })

  it('the service method is synchronous and never waits on the queue', () => {
    const method = between(ipc, '    clean: (rawIds, rawOpts) =>', '    keep: async')
    expect(method).not.toMatch(/await|\.finished|idle\(\)/)
  })
})

describe('one timer', () => {
  it('no GC module owns a timer', () => {
    for (const file of readdirSync(new URL('../src/main/gc', import.meta.url))) {
      if (!file.endsWith('.ts')) continue
      expect(read(`src/main/gc/${file}`), file).not.toMatch(/\bsetInterval\s*\(|\bsetTimeout\s*\(/)
    }
  })

  it('the Reaper tick awaits the cycle hook inside runScheduledTick', () => {
    const tick = between(reaper, 'const runScheduledTick', 'const scheduleTicks')
    expect(tick).toMatch(/await afterScan\(\)/)
    expect(tick).toMatch(/tickRunning = true/)
    expect(tick.indexOf('await afterScan()')).toBeGreaterThan(tick.indexOf('await scanAll('))
  })

  it('the cycle is registered on that hook and nowhere else', () => {
    expect(ipc.match(/reaper\.setAfterScan\(/g)).toHaveLength(1)
    expect(ipc).toMatch(/runGcCycle\(cycleDeps, 'timer'\)/)
  })
})

describe('the feeds are wired (M12, M13, M14, M17)', () => {
  it('M12: the Containers scan passes the inherited bucket feed', () => {
    expect(containersShell).toMatch(/inheritedBucketOf: inheritedBucketFor/)
  })

  it('M13: the gather passes the volume facts to the bundle builder', () => {
    expect(between(scan, 'const input = {', 'let bundles')).toMatch(/volumes: df/)
  })

  it('M14: knownFolders counts hidden folders and every worktree of every repo', () => {
    const known = between(scan, 'async function everyKnownFolder', 'export async function gatherGc')
    expect(known).toMatch(/hiddenPaths/)
    expect(known).toMatch(/listAllWorktreePaths\(repoPaths\)/)
    expect(known).toMatch(/getFleetFolders\(\)/)
    expect(known).toMatch(/readUserProjects\(\)/)
    expect(known).toMatch(/\.\.\.repoPaths/)
  })

  it('M14: the housekeeping planner gets that full list', () => {
    expect(scan).toMatch(/knownFolders: known/)
  })

  it('M17: orphan volumes reach the snapshot', () => {
    expect(between(ipc, 'const buildSnapshot', 'const service')).toMatch(
      /orphanVolumes: g\.orphanVolumes/
    )
  })
})

describe('every consumer sees a halted item as Needs review (delta 1, item 4)', () => {
  it('gather() applies the failures before it caches and feeds anything', () => {
    const gather = between(ipc, 'const gather = ', 'const queue = createJobQueue')
    const applied = gather.indexOf('withFailures(')
    expect(applied).toBeGreaterThanOrEqual(0)
    expect(applied).toBeLessThan(gather.indexOf('cache = g'))
    expect(applied).toBeLessThan(gather.indexOf('setInheritedBuckets('))
  })

  it('the cycle shares the same failure memory as the manual jobs', () => {
    expect(ipc.match(/createCycleState\(\)/g)).toHaveLength(1)
    expect(between(ipc, 'submitManualClean(', 'parseIds(rawIds)')).toMatch(/\bstate,/)
  })
})

describe('GC jobs and the Reaper never run destructive work at once (delta 1, item 4)', () => {
  it('a GC job runs inside the Reaper op chain', () => {
    expect(between(ipc, 'const queue = createJobQueue', 'const shellDeps')).toMatch(
      /around: \(work\) => reaper\.runExclusive\(work\)/
    )
  })

  it('the Reaper exposes that chain, which also waits out a running scan', () => {
    expect(reaper).toMatch(/runExclusive: \(fn\) => runOp\(fn\)/)
    expect(between(reaper, 'const runOp', 'const opsIdle')).toMatch(/await scanIdle\(\)/)
  })

  it.each(['reaper:clean', 'reaper:sweep', 'reaper:dehydrate', 'reaper:rehydrate'])(
    '%s goes through the same chain',
    (channel) => {
      const handler = between(reaper, `'${channel}'`, 'ipcMain.handle(')
      expect(handler).toMatch(/runOp\(/)
    }
  )
})

describe('a bundle never owns a volume another folder may share (delta 1, item 1)', () => {
  it('the gather feeds the bundle builder the folders and the pinned project names', () => {
    const input = between(scan, 'const input = {', 'let bundles')
    expect(input).toMatch(/knownFolders: guards\.knownFolders/)
    expect(input).toMatch(/protectedProjects: guards\.protectedProjects/)
    expect(scan).toMatch(/const guards = volumeGuards\(sources, dirExists\)/)
  })

  it('reads them before the bundles are built, from the same files as the orphan planner', () => {
    expect(scan.indexOf('const guards = volumeGuards(')).toBeLessThan(
      scan.indexOf('let bundles = buildBundles(')
    )
    expect(scan).toMatch(/planHousekeeping\([\s\S]*guards\.protectedProjects/)
  })
})

describe('worktree cleanup never removes volumes (D1)', () => {
  it('every runBatch call passes removeVolumes:false, and no pref feeds it', () => {
    for (const file of ['gc-cycle.ts', 'gc-manual.ts']) {
      const src = read(`src/main/gc/${file}`)
      expect(src, file).toMatch(/removeVolumes: false/)
      expect(src, file).not.toMatch(/removeVolumes:\s*prefs/)
    }
  })

  it('the prefs no longer carry the retired switches', () => {
    const code = read('src/main/gc/gc-prefs.ts')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/removeVolumes|volumes: boolean|categories\.volumes/)
  })
})

describe('the Docker card reaches the snapshot (delta 2, item 2)', () => {
  it('the gather asks docker for the card facts and the snapshot carries them', () => {
    expect(scan).toMatch(/dockerCardFacts\(/)
    expect(between(ipc, 'const buildSnapshot', 'const service')).toMatch(/docker: g\.docker/)
  })

  it('is not asked when docker is known to be absent', () => {
    expect(scan).toMatch(/available\s*\?[\s\S]*dockerCardFacts|!available[\s\S]*null/)
  })
})
