import { describe, expect, it, vi } from 'vitest'
import { runHousekeeping } from '../src/main/gc/housekeeping-shell'
import type { HousekeepingPlan } from '../src/main/gc/housekeeping-core'

const BUILDER_OUT = 'sha256:aaa111\nsha256:bbb222\nTotal:\t512MB\n'
const IMAGE_OUT = 'Deleted Images:\ndeleted: sha256:ccc333\n\nTotal reclaimed space: 1.2GB\n'

function dockerError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error(`Command failed: docker\n${stderr}`), { stderr })
}

const fullPlan: HousekeepingPlan = {
  builderPruneUntilHours: 168,
  danglingImages: true,
  orphanVolumes: ['proj_db', 'proj_cache']
}

describe('runHousekeeping', () => {
  it('(a) parses bytes per kind and sums volume sizes for successful removals', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv[0] === 'builder') return { stdout: BUILDER_OUT }
      if (argv[0] === 'image') return { stdout: IMAGE_OUT }
      return { stdout: `${argv[2]}\n` }
    })
    const volumeBytes = new Map<string, number | null>([
      ['proj_db', 1000],
      ['proj_cache', 234]
    ])

    const result = await runHousekeeping(fullPlan, { run, volumeBytes })

    expect(calls).toEqual([
      ['builder', 'prune', '-f', '--filter', 'until=168h'],
      ['image', 'prune', '-f'],
      ['volume', 'rm', 'proj_db'],
      ['volume', 'rm', 'proj_cache']
    ])
    expect(result).toEqual({
      buildCacheBytes: 512_000_000,
      imageBytes: 1_200_000_000,
      volumeBytes: 1234,
      errors: []
    })
  })

  it('(b) isolates an image prune failure: others still run, imageBytes is 0', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv[0] === 'image') throw dockerError('Error response from daemon: boom')
      if (argv[0] === 'builder') return { stdout: BUILDER_OUT }
      return { stdout: `${argv[2]}\n` }
    })
    const volumeBytes = new Map<string, number | null>([
      ['proj_db', 100],
      ['proj_cache', 50]
    ])

    const result = await runHousekeeping(fullPlan, { run, volumeBytes })

    expect(calls).toHaveLength(4)
    expect(calls[0][0]).toBe('builder')
    expect(calls[2]).toEqual(['volume', 'rm', 'proj_db'])
    expect(calls[3]).toEqual(['volume', 'rm', 'proj_cache'])
    expect(result.imageBytes).toBe(0)
    expect(result.buildCacheBytes).toBe(512_000_000)
    expect(result.volumeBytes).toBe(150)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('image prune')
    expect(result.errors[0]).toContain('Error response from daemon: boom')
  })

  it('(c) a failed volume rm does not stop the next one and counts no bytes', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv[2] === 'proj_db') throw dockerError('Error: volume is in use')
      return { stdout: `${argv[2]}\n` }
    })
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: ['proj_db', 'proj_cache']
    }
    const volumeBytes = new Map<string, number | null>([
      ['proj_db', 9000],
      ['proj_cache', 234]
    ])

    const result = await runHousekeeping(plan, { run, volumeBytes })

    expect(calls).toEqual([
      ['volume', 'rm', 'proj_db'],
      ['volume', 'rm', 'proj_cache']
    ])
    expect(result.volumeBytes).toBe(234)
    expect(result.buildCacheBytes).toBe(0)
    expect(result.imageBytes).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('volume rm proj_db')
    expect(result.errors[0]).toContain('volume is in use')
  })

  it('(d) an empty plan never calls run and returns the zero result', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: []
    }

    const result = await runHousekeeping(plan, { run })

    expect(run).not.toHaveBeenCalled()
    expect(result).toEqual({ buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] })
  })

  it('(e) omitted volumeBytes yields volumeBytes 0 without throwing', async () => {
    const run = vi.fn(async (argv: readonly string[]) => ({ stdout: `${argv[2]}\n` }))
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: ['proj_db']
    }

    const result = await runHousekeeping(plan, { run })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] })
  })
})
