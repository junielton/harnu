import { describe, it, expect } from 'vitest'
import {
  validateSource,
  validateCriterion,
  sourceIdentity,
  isGitBranchName,
  type SourceProbe,
  type WalkSource
} from '../src/shared/walk-source'

const probe: SourceProbe = {
  cardSlugExists: (slug) => slug === 't100-search-box',
  mission: (id) =>
    id === 'mnt-aaaaaaaa'
      ? {
          milestones: ['mls-1'],
          steps: [
            { id: 'stp-1', milestone: 'mls-1', criteria: ['ac-1', 'ac-2'] },
            { id: 'stp-2', milestone: null, criteria: ['ac-3'] }
          ]
        }
      : null
}

const rules = (source: unknown): string[] =>
  validateSource(source, probe).violations.map((v) => `${v.path} ${v.rule}`)

describe('walk sources', () => {
  it('validates each source kind and keeps criteria to a mission source', () => {
    // feature: text, at most 300 characters
    expect(rules({ kind: 'feature', text: 'A search box.' })).toEqual([])
    expect(rules({ kind: 'feature', text: '  ' })).toEqual(['$.source.text MISSING'])
    expect(rules({ kind: 'feature', text: 'x'.repeat(301) })).toEqual(['$.source.text TOO_LONG'])

    // pr: a positive number, title and author (the agent's declaration), optional url
    expect(rules({ kind: 'pr', number: 101, title: 'Add search', author: 'a colleague' })).toEqual(
      []
    )
    expect(rules({ kind: 'pr', number: 0, title: 'Add search', author: 'a' })).toEqual([
      '$.source.number PR_NOT_A_NUMBER'
    ])
    expect(rules({ kind: 'pr', number: 1.5, title: 'x', author: 'a' })).toEqual([
      '$.source.number PR_NOT_A_NUMBER'
    ])
    expect(rules({ kind: 'pr', number: 7, title: 'x', author: 'a', url: 'ftp://x' })).toEqual([
      '$.source.url URL_NOT_HTTP'
    ])

    // branch: a name git accepts, plus a base
    expect(rules({ kind: 'branch', branch: 'feature/search-box', base: 'main' })).toEqual([])
    expect(rules({ kind: 'branch', branch: 'bad name', base: 'main' })).toEqual([
      '$.source.branch BAD_BRANCH_NAME'
    ])
    expect(rules({ kind: 'branch', branch: 'a..b', base: 'main' })).toEqual([
      '$.source.branch BAD_BRANCH_NAME'
    ])
    for (const bad of [
      '',
      '-x',
      'x.lock',
      'a@{b',
      '/x',
      'x/',
      'a//b',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      '@'
    ])
      expect(isGitBranchName(bad), bad).toBe(false)
    expect(isGitBranchName('fix/T-1_x.y')).toBe(true)

    // card: a slug that is on the board
    expect(rules({ kind: 'card', slug: 't100-search-box' })).toEqual([])
    expect(rules({ kind: 'card', slug: 'nope' })).toEqual(['$.source.slug CARD_NOT_FOUND'])

    // mission: ids on the mission record, with a scope
    expect(rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'mission' })).toEqual([])
    expect(
      rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'step', id: 'stp-1' })
    ).toEqual([])
    expect(
      rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'milestone', id: 'mls-1' })
    ).toEqual([])
    expect(rules({ kind: 'mission', missionId: 'mnt-bbbbbbbb', scope: 'mission' })).toEqual([
      '$.source.missionId MISSION_NOT_FOUND'
    ])
    expect(
      rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'step', id: 'stp-9' })
    ).toEqual(['$.source.id STEP_NOT_FOUND'])
    expect(
      rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'milestone', id: 'mls-9' })
    ).toEqual(['$.source.id MILESTONE_NOT_FOUND'])
    expect(rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'step' })).toEqual([
      '$.source.id MISSING'
    ])
    expect(
      rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'mission', id: 'stp-1' })
    ).toEqual(['$.source.id NOT_ALLOWED'])
    expect(rules({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'galaxy' })).toEqual([
      '$.source.scope BAD_VALUE'
    ])

    // unknown kind, missing source
    expect(rules({ kind: 'thing' })).toEqual(['$.source.kind BAD_VALUE'])
    expect(rules(undefined)).toEqual(['$.source MISSING'])

    // criterion: only with a mission source, and only an id that exists on that mission
    const mission: WalkSource = { kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'mission' }
    const crit = (c: unknown, s: WalkSource | null): string[] =>
      validateCriterion(c, s, probe, '$.checks[0].criterion').map((v) => v.rule)
    expect(crit('ac-2', mission)).toEqual([])
    expect(crit('ac-9', mission)).toEqual(['CRITERION_NOT_FOUND'])
    expect(crit(undefined, mission)).toEqual([])
    expect(crit('ac-1', { kind: 'feature', text: 'x' })).toEqual(['CRITERION_NEEDS_MISSION_SOURCE'])
    expect(crit('ac-1', { kind: 'card', slug: 't100-search-box' })).toEqual([
      'CRITERION_NEEDS_MISSION_SOURCE'
    ])
    expect(crit('ac-1', null)).toEqual(['CRITERION_NEEDS_MISSION_SOURCE'])
    expect(crit(undefined, { kind: 'feature', text: 'x' })).toEqual([])
    expect(crit(42, mission)).toEqual(['BAD_VALUE'])

    // identity: what `walk_open` compares to refuse a second live walk
    expect(sourceIdentity({ kind: 'feature', text: '  A search box. ' })).toBe(
      'feature:A search box.'
    )
    expect(sourceIdentity({ kind: 'pr', number: 101, title: 't', author: 'a' })).toBe('pr:101')
    expect(sourceIdentity({ kind: 'branch', branch: 'b', base: 'main' })).toBe('branch:b->main')
    expect(sourceIdentity({ kind: 'card', slug: 's' })).toBe('card:s')
    expect(
      sourceIdentity({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'step', id: 'stp-1' })
    ).toBe('mission:mnt-aaaaaaaa:step:stp-1')
    expect(sourceIdentity({ kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'mission' })).toBe(
      'mission:mnt-aaaaaaaa:mission:'
    )
  })
})
