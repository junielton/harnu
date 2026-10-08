import { describe, it, expect } from 'vitest'
import { stripPaths, reviewReason } from '../src/main/mcp/cleanup-listing'
import { bucketOf } from '../src/main/gc/bundle-core'
import { explainFailedWalks } from '../src/main/gc/gc-foreign'
import { bundle, NOW, WT_READY } from './gc-snapshot-fixtures'

/**
 * T445 final round — `stripPaths` cuts every absolute path in a free-text field down to its
 * basename. Each shape below once slipped through (or could): a `file://` URL, a rooted
 * Windows path with no drive, a path glued after a word character or a dot, and a path whose
 * folder names contain spaces.
 */

describe('stripPaths: the shapes that must not leak', () => {
  it('a file:// URL is scrubbed, an http(s) URL is left alone', () => {
    expect(stripPaths('open file:///srv/ws/org/proj/www now')).toBe('open www now')
    expect(stripPaths('see file:///C:/Users/dev/proj/x.txt.')).toBe('see x.txt.')
    expect(stripPaths('file://localhost/srv/ws/org/www')).toBe('www')
    expect(stripPaths('docs at https://example.com/a/b ok')).toBe(
      'docs at https://example.com/a/b ok'
    )
  })

  it('a rooted Windows path with no drive letter is scrubbed', () => {
    expect(stripPaths('cannot open \\srv\\ws\\org\\proj\\www')).toBe('cannot open www')
    expect(stripPaths("fatal: '\\srv\\ws\\org\\www' is dirty")).toBe("fatal: 'www' is dirty")
    // a UNC path and a drive path keep working
    expect(stripPaths('\\\\fileserver\\share\\proj\\y')).toBe('y')
    expect(stripPaths('C:\\Users\\dev\\proj\\x')).toBe('x')
  })

  it('a path glued after a word character or a dot is scrubbed', () => {
    for (const text of ['rc=1/srv/ws/org/www', 'exit128/srv/ws/org/www', 'done./srv/ws/org/www']) {
      const out = stripPaths(text)
      expect(out).not.toContain('/srv')
      expect(out).toContain('www')
    }
    expect(stripPaths('failed rc=1/home/dev/proj/x')).not.toMatch(/\/home|\/dev/)
  })

  it('a path with spaces in its folder names is scrubbed whole', () => {
    expect(stripPaths('error in /srv/ws/my project/www is fatal')).toBe('error in www is fatal')
    expect(stripPaths('error in /srv/ws/my big project/www is fatal')).toBe('error in www is fatal')
    expect(stripPaths('from /srv/ws/a b/c to /srv/ws/d.')).toBe('from c to d.')
    expect(stripPaths('cannot read C:\\Program Files\\App Data\\x.exe now')).toBe(
      'cannot read x.exe now'
    )
    expect(stripPaths('~/My Documents/proj/x was moved')).toBe('x was moved')
  })

  it('a path followed by ordinary words keeps those words', () => {
    expect(stripPaths('the folder /srv/ws/www is dirty')).toBe('the folder www is dirty')
    expect(stripPaths('in /srv/ws/www and /srv/ws/api both')).toBe('in www and api both')
  })

  it('what is not an absolute path is left alone', () => {
    expect(stripPaths('and/or a/b/c')).toBe('and/or a/b/c')
    expect(stripPaths('see lib/utils/helpers and src/main')).toBe(
      'see lib/utils/helpers and src/main'
    )
  })

  it('a branch name is never mangled when glue-scrubbing is off (free text may lose a ref like feat/home/x)', () => {
    expect(stripPaths('feat/home/refactor', { glued: false })).toBe('feat/home/refactor')
    expect(stripPaths('v2/srv/thing', { glued: false })).toBe('v2/srv/thing')
  })
})

describe('reviewReason: a nested-worktree that could not be checked has its own sentence', () => {
  const FOUND = /lives inside/
  const COULD_NOT = /could not check this worktree for other checkouts/

  it('the S2 wordings for "could not be checked" read as the could-not-check sentence', () => {
    const base = bundle(WT_READY)
    // Built by the real bucket rule, so a rewording in S2 fails here instead of drifting.
    const noNested = bucketOf({ ...base, nestedWorktrees: undefined as never }, NOW, 2)
    const noForeign = bucketOf({ ...base, foreignCheckouts: undefined as never }, NOW, 2)
    for (const r of [noNested.reason, noForeign.reason]) {
      expect(r?.code).toBe('nested-worktree')
      expect(reviewReason(r)!.sentence).toMatch(COULD_NOT)
    }
  })

  it('S3’s explained failed walk (with its cause, even a path) reads as the could-not-check sentence', () => {
    const base = bundle(WT_READY, { bucket: 'review' })
    const generic = bucketOf({ ...base, foreignCheckouts: undefined as never }, NOW, 2)
    const [explained] = explainFailedWalks(
      [{ ...base, bucket: generic.bucket, reason: generic.reason }],
      new Map([[base.item.id, "EACCES: permission denied, scandir '/srv/ws/org/proj/www/secret'"]])
    )
    expect(explained!.reason?.detail).toContain('EACCES')
    const out = reviewReason(explained!.reason)!
    expect(out.code).toBe('nested-worktree')
    expect(out.sentence).toMatch(COULD_NOT)
    expect(out.sentence).not.toContain('EACCES')
    expect(out.sentence).not.toContain('/srv')
  })

  it('a worktree or checkout that was found inside keeps the "lives inside" sentence', () => {
    const base = bundle(WT_READY)
    const nested = bucketOf({ ...base, nestedWorktrees: ['/srv/ws/inner'] }, NOW, 2)
    const foreign = bucketOf({ ...base, foreignCheckouts: ['/srv/ws/clone/.git'] }, NOW, 2)
    for (const r of [nested.reason, foreign.reason]) {
      expect(r?.code).toBe('nested-worktree')
      expect(reviewReason(r)!.sentence).toMatch(FOUND)
      expect(reviewReason(r)!.sentence).not.toMatch(COULD_NOT)
    }
  })
})
