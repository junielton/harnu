/**
 * Campaign ch.3a (T595, spec `docs/specs/2026-10-30-campaign/spec.md` §3.1, §3.5) — the
 * `Campaign`/`Chapter` record and its on-disk file. Mirrors `mission-core.test.ts`.
 *
 * AC-3a.1: a campaign is stored as `.harnu/campaigns/<id>-<slug>.md` in the MAIN checkout
 * (resolved like missions, so every worktree shares it); read, write and round-trip are
 * byte-stable.
 *
 * The expected values here come from the spec, not from the implementation: the directory
 * name and the `<id>-<slug>.md` shape are §3.1's words, and "byte-stable" means a second
 * build of what was parsed is the identical string.
 */
import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import {
  applyAddChapter,
  buildCampaignFileContent,
  campaignFilePath,
  campaignsDir,
  CAMPAIGN_ID_RE,
  createCampaignFile,
  missingPrerequisites,
  mintCampaignId,
  parseCampaignFile,
  readCampaignLog,
  type Campaign,
  type Chapter
} from '../src/main/campaign-core'

const AT = '2026-10-31T10:00:00.000Z'

function chapter(n: number, over: Partial<Chapter> = {}): Chapter {
  return { id: `chp-${n}`, ordinal: n, title: `Chapter ${n}`, required: true, ...over }
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 'cmp-0a1b2c3d',
    slug: 'content-migration',
    folder: '/work/org/www',
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/work/org/www' },
    title: 'Content migration',
    declaredEnd: {
      kind: 'code',
      target: 'every page migrated',
      evidence: 'the audit script is green'
    },
    chapters: [
      chapter(1, { produces: ['images-on-cdn'] }),
      chapter(2, { consumes: ['images-on-cdn'] })
    ],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    provenance: { author: 'agent', at: AT },
    ...over
  }
}

describe('AC-3a.1 — the campaign file', () => {
  it('lives at <root>/.harnu/campaigns/<id>-<slug>.md', () => {
    expect(campaignsDir('/repo')).toBe(path.join('/repo', '.harnu', 'campaigns'))
    expect(campaignFilePath('/repo', 'cmp-0a1b2c3d', 'content-migration')).toBe(
      path.join('/repo', '.harnu', 'campaigns', 'cmp-0a1b2c3d-content-migration.md')
    )
  })

  it('refuses an id or slug that is not path-safe, so a crafted slug cannot escape the directory', () => {
    expect(() => campaignFilePath('/repo', 'cmp-0a1b2c3d', '../../etc/passwd')).toThrow(/slug/)
    expect(() => campaignFilePath('/repo', 'mnt-0a1b2c3d', 'ok')).toThrow(/id/)
    expect(() => campaignFilePath('/repo', 'cmp-xyz', 'ok')).toThrow(/id/)
  })

  it('mints cmp-<8 hex> ids that avoid the ones taken', () => {
    const draws = ['00000000', '00000000', 'deadbeef']
    const id = mintCampaignId(['cmp-00000000'], () => draws.shift()!)
    expect(id).toBe('cmp-deadbeef')
    expect(CAMPAIGN_ID_RE.test(id)).toBe(true)
  })

  it('round-trips byte-stably: build → parse → build gives the identical string', () => {
    const log =
      '# Content migration\n\n## Log\n\n### 2026-10-31T10:00:00.000Z · surprise\n\nforced.\n'
    const first = buildCampaignFileContent(campaign(), log)
    const parsed = parseCampaignFile(first)
    expect('error' in parsed).toBe(false)
    expect(buildCampaignFileContent(parsed as Campaign, readCampaignLog(first))).toBe(first)
  })

  it('keeps the log body verbatim and reads back every field it was given', () => {
    const full = campaign({
      scope: [{ kind: 'worktree', ref: 'docs/specs/x.md' }],
      closedAs: undefined,
      chapters: [
        chapter(1, { radiant: { template: 'migrate page {slug}', total: 88 } }),
        chapter(2, {
          required: false,
          discoveredFrom: { chapterId: 'chp-1', stepId: 'stp-2' },
          unlocks: { kind: 'chapter', ref: 'chp-1' },
          missionId: 'mnt-0a0a0a0a'
        })
      ]
    })
    const raw = buildCampaignFileContent(full, 'BODY\n')
    expect(readCampaignLog(raw)).toBe('BODY\n')
    expect(parseCampaignFile(raw)).toEqual(full)
  })

  it('stores a string that looks like another type as a string (quoted by the dump)', () => {
    const c = campaign({ title: '123', chapters: [chapter(1, { title: 'true' })] })
    const parsed = parseCampaignFile(buildCampaignFileContent(c)) as Campaign
    expect(parsed.title).toBe('123')
    expect(parsed.chapters[0].title).toBe('true')
  })

  it('a key a later Harnu adds survives a read → write (passthrough, like missions)', () => {
    const raw = buildCampaignFileContent(campaign())
    const doc = yaml.load(raw.split('---\n')[1]) as Record<string, unknown>
    doc.outcome = { actualEnd: 'chapter 6 owns this key' }
    ;(doc.chapters as Array<Record<string, unknown>>)[0].futureField = 7
    const withExtras = `---\n${yaml.dump(doc, { lineWidth: -1 })}---\n`
    const parsed = parseCampaignFile(withExtras) as Campaign
    const rebuilt = yaml.load(buildCampaignFileContent(parsed).split('---\n')[1]) as Record<
      string,
      unknown
    >
    expect(rebuilt.outcome).toEqual({ actualEnd: 'chapter 6 owns this key' })
    expect((rebuilt.chapters as Array<Record<string, unknown>>)[0].futureField).toBe(7)
  })

  it('a corrupt or hand-broken file degrades to { error }, never a half-typed Campaign', () => {
    expect(parseCampaignFile('no frontmatter here')).toEqual({ error: 'no frontmatter block' })
    expect(parseCampaignFile('---\n: : :\n---\n')).toMatchObject({
      error: expect.stringMatching(/^invalid YAML/)
    })
    const bad = buildCampaignFileContent(campaign()).replace('status: active', 'status: nonsense')
    expect(parseCampaignFile(bad)).toMatchObject({
      error: expect.stringMatching(/^invalid campaign: status/)
    })
  })

  it('refuses to WRITE an invalid campaign (a record every later read would reject)', () => {
    expect(() => buildCampaignFileContent(campaign({ id: 'nope' }))).toThrow(/invalid campaign/)
    expect(() =>
      buildCampaignFileContent(campaign({ chapters: [chapter(1, { id: 'x' })] }))
    ).toThrow(/invalid campaign/)
  })

  it('createCampaignFile writes once and never overwrites (EEXIST), same id under another slug included', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-core-'))
    const file = await createCampaignFile(root, campaign(), 'log\n')
    expect(file).toBe(campaignFilePath(root, 'cmp-0a1b2c3d', 'content-migration'))
    expect(await fs.readFile(file, 'utf8')).toBe(buildCampaignFileContent(campaign(), 'log\n'))
    await expect(createCampaignFile(root, campaign(), 'again\n')).rejects.toMatchObject({
      code: 'EEXIST'
    })
    await expect(createCampaignFile(root, campaign({ slug: 'other' }), '')).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect((await fs.readdir(campaignsDir(root))).filter((n) => n.endsWith('.md'))).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toContain('log')
  })
})

describe('applyAddChapter — chapters are appended, ordered, never removed', () => {
  it('appends with the next chp-<n> id and ordinal and stamps updatedAt', () => {
    const next = applyAddChapter(
      campaign(),
      { title: 'Verify', required: true },
      '2026-11-01T00:00:00.000Z'
    )
    expect(next.chapters.map((c) => [c.id, c.ordinal])).toEqual([
      ['chp-1', 1],
      ['chp-2', 2],
      ['chp-3', 3]
    ])
    expect(next.chapters[2]).toMatchObject({ title: 'Verify', required: true })
    expect(next.updatedAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('does not mutate its input', () => {
    const before = campaign()
    const snapshot = structuredClone(before)
    applyAddChapter(before, { title: 'Verify', required: true }, AT)
    expect(before).toEqual(snapshot)
  })
})

describe('AC-3a.4 — missingPrerequisites (spec §3.5)', () => {
  it('flags a chapter that consumes a token no EARLIER chapter produces, naming it', () => {
    const chapters = [
      chapter(1, { consumes: ['images-on-cdn'] }),
      chapter(2, { produces: ['images-on-cdn'] })
    ]
    expect(missingPrerequisites(chapters)).toEqual([
      { chapterId: 'chp-1', title: 'Chapter 1', token: 'images-on-cdn' }
    ])
  })

  it('accepts a token produced by an earlier chapter, and a chapter never consumes its own product', () => {
    expect(
      missingPrerequisites([
        chapter(1, { produces: ['a'] }),
        chapter(2, { consumes: ['a'], produces: ['b'] }),
        chapter(3, { consumes: ['a', 'b'] })
      ])
    ).toEqual([])
    expect(missingPrerequisites([chapter(1, { consumes: ['a'], produces: ['a'] })])).toEqual([
      { chapterId: 'chp-1', title: 'Chapter 1', token: 'a' }
    ])
  })

  it('reports every missing token, and checks only chapters from `from` on', () => {
    const chapters = [chapter(1, { consumes: ['old-gap'] }), chapter(2, { consumes: ['x', 'y'] })]
    expect(missingPrerequisites(chapters, 1).map((m) => m.token)).toEqual(['x', 'y'])
    expect(missingPrerequisites(chapters).map((m) => m.token)).toEqual(['old-gap', 'x', 'y'])
  })

  it('a side-quest chapter that produces a token still counts as an earlier producer', () => {
    expect(
      missingPrerequisites([
        chapter(1, { required: false, produces: ['t'] }),
        chapter(2, { consumes: ['t'] })
      ])
    ).toEqual([])
  })
})
