// U3.6: the capacity watcher is wired to the real parts and nothing else: the ONE composed Docker
// planner, the machine-wide lock, the failure-streak kill switch, the real capacity reader and the
// docker events stream; it reaches the renderer on its own channel and in the snapshot.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(join(__dirname, '../src', rel), 'utf8')

describe('gc-ipc wires the capacity watcher', () => {
  const ipc = read('main/gc/gc-ipc.ts')

  it('runs a pass through runCapacityPass over the real reader, planners, lock and kill switch', () => {
    expect(ipc).toMatch(/runCapacityPass\(/)
    expect(ipc).toMatch(/readCapacity:\s*\(\)\s*=>\s*readBridgeCapacity\(\{\s*run:\s*runDocker/)
    expect(ipc).toMatch(/\.\.\.dockerPlanners/)
    expect(ipc).toMatch(/withLockFile\(dockerLockPath\(\)/)
    expect(ipc).toMatch(/persist\(withDockerDisabled\(prefs\)\)/)
  })

  it('builds the park planner once: the watcher reuses the cycle composition, it does not fork it', () => {
    expect(ipc.match(/createParkPlanner\(/g)).toHaveLength(1)
    expect(ipc.match(/composeDockerPlanners\(/g)).toHaveLength(1)
  })

  it('listens on docker network events with a fallback interval and stops on quit', () => {
    expect(ipc).toMatch(/watchNetworkEvents\(/)
    expect(ipc).toMatch(/createCapacityWatcher\(/)
    expect(ipc).toMatch(/intervalMs:\s*CAPACITY_INTERVAL_MS/)
    expect(ipc).toMatch(/before-quit/)
    expect(ipc).toMatch(/watcher\.stop\(\)/)
  })

  it('pushes the pass on gc:docker:watch (only when it changed) and puts it in the snapshot', () => {
    expect(ipc).toMatch(/send\('gc:docker:watch'/)
    expect(ipc).toMatch(/dockerWatch:\s*state\.dockerWatch/)
  })
})

describe('the renderer side is reachable', () => {
  it('the preload exposes the push', () => {
    expect(read('preload/index.ts')).toMatch(/onGcDockerWatch/)
    expect(read('preload/index.ts')).toMatch(/'gc:docker:watch'/)
  })
  it('the gc store subscribes to it', () => {
    expect(read('renderer/src/stores/gc.ts')).toMatch(/onGcDockerWatch/)
  })
})

describe('the watcher never spawns a mutating docker command itself', () => {
  it('capacity-watcher(-core) import no child_process and name no mutating verb', () => {
    for (const f of ['main/gc/capacity-watcher.ts', 'main/gc/capacity-watcher-core.ts']) {
      const src = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(src).not.toMatch(/child_process|execFile|spawn\(/)
      expect(src).not.toMatch(/docker (rm|stop|down|network rm|volume)/)
    }
  })
})
