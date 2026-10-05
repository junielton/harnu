import { describe, it, expect } from 'vitest'
import {
  githubPullsUrlFromRemote,
  githubRepoFromRemote,
  parseGithubPrUrl,
  matchPrLinkToRemote,
  isOpenPrViewJson
} from '../src/main/github-remote'

const PULLS = 'https://github.com/acme/web-api/pulls'

describe('githubPullsUrlFromRemote', () => {
  it.each([
    'https://github.com/acme/web-api.git',
    'https://github.com/acme/web-api',
    'https://github.com/acme/web-api/',
    'http://github.com/acme/web-api.git',
    'https://www.github.com/acme/web-api.git',
    'https://GitHub.com/acme/web-api.git',
    'git@github.com:acme/web-api.git',
    'git@github.com:acme/web-api',
    'github.com:acme/web-api.git',
    'ssh://git@github.com/acme/web-api.git',
    'ssh://git@github.com:22/acme/web-api.git',
    'git+ssh://git@github.com/acme/web-api.git',
    'git://github.com/acme/web-api.git',
    'git@github.com-work:acme/web-api.git',
    '  https://github.com/acme/web-api.git\n'
  ])('maps %s to the pulls page', (remote) => {
    expect(githubPullsUrlFromRemote(remote)).toBe(PULLS)
  })

  it('never carries credentials from the remote into the URL', () => {
    expect(githubPullsUrlFromRemote('https://user:s3cret@github.com/acme/web-api.git')).toBe(PULLS)
  })

  it('keeps dots, underscores and dashes in the repo name', () => {
    expect(githubPullsUrlFromRemote('git@github.com:acme/my_repo.js-v2.git')).toBe(
      'https://github.com/acme/my_repo.js-v2/pulls'
    )
  })

  it.each([
    '',
    '   ',
    'https://gitlab.com/acme/web-api.git',
    'git@bitbucket.org:acme/web-api.git',
    'https://github.example.com/acme/web-api.git',
    'https://notgithub.com/acme/web-api.git',
    'https://github.com/acme',
    'https://github.com/acme/web-api/tree/main',
    'git@github.com:acme.git',
    '/srv/git/web-api.git',
    '../web-api',
    'file:///srv/git/web-api.git',
    'https://github.com/acme/%2e%2e',
    'https://github.com/-acme/web-api',
    'not a url'
  ])('returns null for %j', (remote) => {
    expect(githubPullsUrlFromRemote(remote)).toBeNull()
  })
})

describe('githubRepoFromRemote', () => {
  it('parses every accepted remote shape to the same owner/repo', () => {
    for (const remote of [
      'https://github.com/acme/web-api.git',
      'git@github.com:acme/web-api.git',
      'ssh://git@github.com/acme/web-api',
      'git@github.com-work:acme/web-api.git'
    ]) {
      expect(githubRepoFromRemote(remote)).toEqual({ owner: 'acme', repo: 'web-api' })
    }
  })

  it('never carries embedded credentials into the result', () => {
    const ref = githubRepoFromRemote('https://user:s3cret@github.com/acme/web-api.git')
    expect(JSON.stringify(ref)).not.toContain('s3cret')
  })

  it.each(['', 'https://gitlab.com/acme/web-api.git', 'not a url', '/srv/a:b'])(
    'returns null for %j',
    (remote) => {
      expect(githubRepoFromRemote(remote)).toBeNull()
    }
  )
})

describe('parseGithubPrUrl', () => {
  const PR = { owner: 'acme', repo: 'web-api', number: 412 }

  it.each([
    'https://github.com/acme/web-api/pull/412',
    'https://www.github.com/acme/web-api/pull/412',
    'http://github.com/acme/web-api/pull/412',
    'https://github.com/acme/web-api/pull/412/',
    'https://github.com/acme/web-api/pull/412/files',
    'https://github.com/acme/web-api/pull/412/commits',
    'https://github.com/acme/web-api/pull/412/checks',
    'https://github.com/acme/web-api/pull/412?diff=split',
    'https://github.com/acme/web-api/pull/412#issuecomment-123',
    'https://github.com/acme/web-api/pull/412/files?w=1#diff-abc',
    'https://GitHub.com/acme/web-api/pull/412'
  ])('accepts %s', (url) => {
    expect(parseGithubPrUrl(url)).toEqual(PR)
  })

  it.each([
    'https://gitlab.com/acme/web-api/pull/412',
    'https://github.com.evil.example/acme/web-api/pull/412',
    'https://github.com/acme/web-api/pulls',
    'https://github.com/acme/web-api/issues/412',
    'https://github.com/acme/web-api/pull/0',
    'https://github.com/acme/web-api/pull/-3',
    'https://github.com/acme/web-api/pull/4.5',
    'https://github.com/acme/web-api/pull/abc',
    'https://github.com/acme/web-api/pull/412/other',
    'https://github.com/acme/web-api/pull/412/files/extra',
    'https://github.com/acme/web-api/pull',
    'https://github.com/acme/pull/412',
    'https://github.com/-bad/web-api/pull/412',
    'https://github.com/acme/../pull/412',
    'ssh://git@github.com/acme/web-api/pull/412',
    'not a url',
    ''
  ])('rejects %j', (url) => {
    expect(parseGithubPrUrl(url)).toBeNull()
  })
})

describe('matchPrLinkToRemote', () => {
  const REMOTE = 'git@github.com:Acme/Web-API.git'

  it('returns the PR number for a link into the same repo, ignoring case', () => {
    expect(matchPrLinkToRemote(REMOTE, 'https://github.com/acme/web-api/pull/9/files')).toBe(9)
  })

  it('returns null for another repo, another owner, or a non-PR link', () => {
    expect(matchPrLinkToRemote(REMOTE, 'https://github.com/acme/other/pull/9')).toBeNull()
    expect(matchPrLinkToRemote(REMOTE, 'https://github.com/other/web-api/pull/9')).toBeNull()
    expect(matchPrLinkToRemote(REMOTE, 'https://github.com/acme/web-api/pulls')).toBeNull()
  })

  it('returns null when the remote is not on GitHub', () => {
    expect(
      matchPrLinkToRemote(
        'https://gitlab.com/acme/web-api.git',
        'https://github.com/acme/web-api/pull/9'
      )
    ).toBeNull()
  })
})

describe('isOpenPrViewJson', () => {
  it('is true only for an OPEN state', () => {
    expect(isOpenPrViewJson('{"state":"OPEN"}')).toBe(true)
    expect(isOpenPrViewJson('{"state":"MERGED"}')).toBe(false)
    expect(isOpenPrViewJson('{"state":"CLOSED"}')).toBe(false)
    expect(isOpenPrViewJson('{}')).toBe(false)
    expect(isOpenPrViewJson('nope')).toBe(false)
    expect(isOpenPrViewJson('null')).toBe(false)
    expect(isOpenPrViewJson('')).toBe(false)
  })
})
