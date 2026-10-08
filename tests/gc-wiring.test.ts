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
    expect(containersShell).toMatch(/inheritedBucketOf: bucketLookup\(realOf\)/)
    // ...keyed on real paths: the feed is built with the gather's resolver.
    expect(ipc).toMatch(/bucketFeed\(g\.bundles, g\.canonical\)/)
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
    expect(input).toMatch(/knownFolders: bundleFolders/)
    expect(scan).toMatch(/foldersForBundles\(guards\.knownFolders,/)
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

describe('S2 delta 4 contracts (delta 2, item 3)', () => {
  it('the gather builds canonical from real paths of everything the builder compares', () => {
    const block = between(scan, 'const canonical = await resolveRealPaths(', 'const input = {')
    for (const source of [
      'itemPaths',
      'repoPaths',
      'containerFolderPaths',
      'sessions.keys()',
      'stackPaths.values()',
      'prefs.neverClean',
      'guards.knownFolders'
    ]) {
      expect(block, source).toContain(source)
    }
    expect(between(scan, 'const input = {', 'let bundles')).toMatch(/canonical/)
  })

  it('only the operator path sets the review gate, and only for a non-ready bundle', () => {
    expect(read('src/main/gc/gc-cycle.ts')).not.toMatch(/confirmReview|confirmDecide/)
    const manual = read('src/main/gc/gc-manual.ts')
    expect(manual).toMatch(/confirmReview: forced/)
    expect(manual).not.toMatch(/confirmReview: true/)
  })
})

describe('Keep survives a stale cache (delta 3, item 1)', () => {
  it('gc:keep records the fate from a fresh gather, not from the cache', () => {
    const keep = between(ipc, '    keep: async', '    unkeep: async')
    expect(keep).toMatch(/gatherFresh\(\)/)
    expect(keep).not.toMatch(/cache \?\?|cache\.bundles/)
    expect(keep).toMatch(/keepFromFresh\(/)
  })

  it('a gather clears only the marks it judged, and only if they are still the same', () => {
    expect(between(ipc, 'const gather = ', 'const queue = createJobQueue')).toMatch(
      /withoutStaleKeeps\(prefs, g\.staleKeeps, protect\)/
    )
    expect(scan).toMatch(/judgeKeeps\(/)
  })

  it('a fresh gather waits for the one in flight and then starts its own', () => {
    expect(between(ipc, 'const gatherFresh', 'const queue = createJobQueue')).toMatch(
      /await gathering[\s\S]*return gather\(\)/
    )
  })
})

describe('an orphan volume is re-planned right before removal (delta 3, item 4)', () => {
  it('the service gives the manual job a gather that starts after the call', () => {
    expect(ipc).toMatch(/const freshOrphans = async[\s\S]*\(await gatherFresh\(\)\)\.orphanVolumes/)
    expect(between(ipc, 'submitManualClean(', 'parseIds(rawIds)')).toMatch(/\bfreshOrphans,/)
  })
})

describe('leftover folders are stat-ed (delta 3, item 6)', () => {
  it('the gather builds its existence check over the leftover folders too', () => {
    expect(scan).toMatch(/existenceCandidates\(\{[\s\S]*remembered: rememberedDirs/)
    expect(scan).toMatch(/await buildDirExists\(/)
  })
})

describe('a scheduled Reaper tick yields to a running GC job (delta 3, item 7: M20)', () => {
  it('skips the whole tick, before it claims the slot or scans, while the GC is busy', () => {
    const tick = between(reaper, 'const runScheduledTick', 'const scheduleTicks')
    expect(tick).toMatch(/if \(gcBusy\?\.\(\)\) return/)
    expect(tick.indexOf('gcBusy')).toBeLessThan(tick.indexOf('tickRunning = true'))
    expect(tick.indexOf('gcBusy')).toBeLessThan(tick.indexOf('await scanAll('))
  })

  it('the busy check is the GC queue, registered once on the Reaper control', () => {
    expect(reaper).toMatch(/setBusy: \(check\) => \{\s*gcBusy = check\s*\}/)
    expect(ipc.match(/reaper\.setBusy\(/g)).toHaveLength(1)
    expect(ipc).toMatch(/reaper\.setBusy\(\(\) => queue\.busy\(\)\)/)
  })
})

describe('session presence on real paths (delta 3b, item 8)', () => {
  it('the gather resolves every session-set folder and passes canonical to the presence read', () => {
    const block = between(scan, '// Sessions on real paths', 'const stacks = groupStacks')
    expect(block).toMatch(/resolveRealPaths\(/)
    expect(block).toMatch(/sessionsFrom(Folders|Fleet)\(/)
    expect(block).toMatch(/sets\.live/)
    expect(block).toMatch(/sets\.inUse/)
  })
})

describe('grace activity comes from the whole transcript index (delta 3b, item 9)', () => {
  it('the gather feeds every fleet folder, not only the item paths', () => {
    expect(between(scan, '// Sessions on real paths', 'const stacks = groupStacks')).toMatch(
      /sessionsFromFleet\(fleet,/
    )
  })
})

describe('compose names are read from subfolders (delta 3b, item 10)', () => {
  it('the gather walks each known folder and feeds the files to the guards', () => {
    expect(scan).toMatch(/collectProjectFiles\(p,/)
    expect(scan).toMatch(/files: await collectProjectFiles/)
    expect(scan).toMatch(/guards\.unresolved/)
  })
})

describe('the bundle builder gets only the folders that cannot fake a nested worktree (S2 delta 6)', () => {
  it('the gather filters the known folders before they reach buildBundles', () => {
    expect(scan).toMatch(/const bundleFolders = foldersForBundles\(/)
    expect(between(scan, 'const input = {', 'let bundles')).toMatch(/knownFolders: bundleFolders/)
  })
})

describe('foreign checkouts are walked in the gather (S2 delta 7)', () => {
  it('feeds the bundle builder the walk results and explains a failed walk', () => {
    expect(scan).toMatch(/await collectForeignCheckouts\(/)
    expect(between(scan, 'const input = {', 'let bundles')).toMatch(
      /foreignCheckouts: foreign\.found/
    )
    expect(scan).toMatch(/explainFailedWalks\(/)
  })
})

describe('Keep protects at once (delta 4, N1)', () => {
  it('gc:keep persists a provisional mark before it waits for any gather', () => {
    const keep = between(ipc, '    keep: async', '    unkeep: async')
    expect(keep.indexOf('withProvisionalKeep(')).toBeGreaterThanOrEqual(0)
    expect(keep.indexOf('withProvisionalKeep(')).toBeLessThan(keep.indexOf('gatherFresh()'))
    expect(keep.indexOf('await persist(')).toBeLessThan(keep.indexOf('gatherFresh()'))
  })

  it('a gather protects provisional marks and marks written after it started', () => {
    expect(between(ipc, 'const gather = ', 'const gatherFresh')).toMatch(
      /protectedFromGather\(keepWrites, provisionalKeeps, startedAt\)[\s\S]*withoutStaleKeeps\(prefs, g\.staleKeeps, protect\)/
    )
  })

  it('a refused unknown id takes its provisional mark back', () => {
    expect(between(ipc, '    keep: async', '    unkeep: async')).toMatch(/withoutKeep\(/)
  })
})
