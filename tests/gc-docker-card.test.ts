import { describe, it, expect } from 'vitest'
import {
  dockerCardFacts,
  parseBuildCacheReclaimable,
  parseDanglingImages
} from '../src/main/gc/gc-docker-card'

const DF = [
  '{"Active":"2","Reclaimable":"1.2GB (24%)","Size":"5GB","TotalCount":"8","Type":"Images"}',
  '{"Active":"1","Reclaimable":"0B (0%)","Size":"12MB","TotalCount":"1","Type":"Containers"}',
  '{"Active":"3","Reclaimable":"100MB (10%)","Size":"1GB","TotalCount":"3","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"4.6GB","Size":"4.6GB","TotalCount":"212","Type":"Build Cache"}'
].join('\n')

describe('parseBuildCacheReclaimable: the Build Cache row of docker system df', () => {
  it('reads the reclaimable size of the Build Cache row only', () => {
    expect(parseBuildCacheReclaimable(DF)).toBe(4_600_000_000)
  })

  it('accepts a size followed by a percentage', () => {
    const row = '{"Type":"Build Cache","Reclaimable":"2.5GB (100%)"}'
    expect(parseBuildCacheReclaimable(row)).toBe(2_500_000_000)
  })

  it('reads zero as zero, not as unknown', () => {
    expect(parseBuildCacheReclaimable('{"Type":"Build Cache","Reclaimable":"0B"}')).toBe(0)
  })

  it.each([
    ['no Build Cache row', '{"Type":"Images","Reclaimable":"1GB"}'],
    ['an unreadable size', '{"Type":"Build Cache","Reclaimable":"lots"}'],
    ['no Reclaimable field', '{"Type":"Build Cache"}'],
    ['junk', 'not json'],
    ['nothing', '']
  ])('is null for %s', (_name, stdout) => {
    expect(parseBuildCacheReclaimable(stdout)).toBeNull()
  })

  it('skips a malformed line and still finds the row', () => {
    expect(parseBuildCacheReclaimable(`garbage\n${DF}`)).toBe(4_600_000_000)
  })
})

describe('parseDanglingImages: docker images -f dangling=true', () => {
  const rows = [
    '{"ID":"sha256:aaa","Repository":"<none>","Tag":"<none>","Size":"120MB"}',
    '{"ID":"sha256:bbb","Repository":"<none>","Tag":"<none>","Size":"1.5GB"}'
  ].join('\n')

  it('counts the images and sums their sizes', () => {
    expect(parseDanglingImages(rows)).toEqual({ count: 2, bytes: 1_620_000_000 })
  })

  it('is an honest zero when there are none', () => {
    expect(parseDanglingImages('')).toEqual({ count: 0, bytes: 0 })
    expect(parseDanglingImages('\n\n')).toEqual({ count: 0, bytes: 0 })
  })

  it('counts an image whose size it cannot read, adding nothing for it', () => {
    const out = parseDanglingImages(`${rows}\n{"ID":"sha256:ccc","Size":"huge"}`)
    expect(out).toEqual({ count: 3, bytes: 1_620_000_000 })
  })

  it('ignores lines that are not an image row', () => {
    expect(parseDanglingImages('warning: something\n' + rows).count).toBe(2)
  })
})

describe('dockerCardFacts: with injected deps', () => {
  const run =
    (answers: Record<string, string | Error>) =>
    async (argv: readonly string[]): Promise<{ stdout: string }> => {
      const key = argv.join(' ')
      const answer = answers[key]
      if (answer === undefined) throw new Error(`unexpected docker call: ${key}`)
      if (answer instanceof Error) throw answer
      return { stdout: answer }
    }

  const DF_ARGV = 'system df --format {{json .}}'
  const IMAGES_ARGV = 'images --filter dangling=true --format {{json .}}'

  it('returns both figures', async () => {
    const out = await dockerCardFacts(
      run({
        [DF_ARGV]: DF,
        [IMAGES_ARGV]: '{"ID":"a","Size":"10MB"}'
      })
    )
    expect(out).toEqual({
      buildCacheReclaimableBytes: 4_600_000_000,
      danglingImages: { count: 1, bytes: 10_000_000 }
    })
  })

  it('is null on both when docker is unavailable', async () => {
    const down = new Error('Cannot connect to the Docker daemon')
    const out = await dockerCardFacts(run({ [DF_ARGV]: down, [IMAGES_ARGV]: down }))
    expect(out).toEqual({ buildCacheReclaimableBytes: null, danglingImages: null })
  })

  it('nulls only the figure whose command failed', async () => {
    const out = await dockerCardFacts(
      run({ [DF_ARGV]: new Error('timeout'), [IMAGES_ARGV]: '{"ID":"a","Size":"1MB"}' })
    )
    expect(out).toEqual({
      buildCacheReclaimableBytes: null,
      danglingImages: { count: 1, bytes: 1_000_000 }
    })
  })

  it('only ever reads: it asks docker for a listing, never to prune or remove', async () => {
    const seen: string[] = []
    await dockerCardFacts(async (argv) => {
      seen.push(argv.join(' '))
      return { stdout: '' }
    })
    expect(seen).toHaveLength(2)
    for (const call of seen) expect(call).not.toMatch(/prune|\brm\b|rmi|\s-a\b|--all/)
  })

  it('is null for the build cache when docker answers without that row', async () => {
    const out = await dockerCardFacts(run({ [DF_ARGV]: '', [IMAGES_ARGV]: '' }))
    expect(out.buildCacheReclaimableBytes).toBeNull()
    expect(out.danglingImages).toEqual({ count: 0, bytes: 0 })
  })
})
