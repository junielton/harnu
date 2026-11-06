// Real-git coverage of verifyPreservation (U2.1 AC-4): it proves, by git's own hashes, that every
// tracked, untracked and ignored-outside-dependency file of the worktree is recoverable from the
// record — and fails closed on any mismatch or probe error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  preserveWorktree,
  verifyPreservation,
  type VerifyResult
} from '../src/main/gc/shelve-shell'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import { git, makeFixture, type Fixture } from './gc-shelve-fixture'

const NOW = Date.parse('2026-11-05T10:00:00Z')

let fx: Fixture
let record: ShelveRecord

async function preserve(): Promise<ShelveRecord> {
  const r = await preserveWorktree({
    repoPath: fx.repo,
    worktreePath: fx.wt,
    branch: 'feat/x',
    now: NOW
  })
  if (!r.ok) throw new Error(r.message)
  return r.record
}

const reason = (v: VerifyResult): string => (v.ok ? 'ok' : v.reason)

beforeEach(async () => {
  fx = makeFixture()
  record = await preserve()
})
afterEach(() => fx.cleanup())

describe('verifyPreservation — a sound preservation', () => {
  it('passes in both modes, and by default checks the live worktree', async () => {
    expect(await verifyPreservation(record)).toEqual({ ok: true, mode: 'live' })
    expect(await verifyPreservation(record, { mode: 'live' })).toEqual({ ok: true, mode: 'live' })
    expect(await verifyPreservation(record, { mode: 'archive' })).toEqual({
      ok: true,
      mode: 'archive'
    })
  })

  it('does not care about what git does not hold: staging, a changed dependency dir, mtimes', async () => {
    git(fx.wt, 'add', 'tracked.txt')
    writeFileSync(path.join(fx.wt, 'node_modules', 'pkg', 'other.js'), 'regenerable\n')
    const later = new Date(Date.now() + 60_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(path.join(fx.wt, 'notes', 'u.txt'), later, later)
    expect(reason(await verifyPreservation(record))).toBe('ok')
  })
})

describe('verifyPreservation — the worktree changed since (live mode)', () => {
  it.each([
    [
      'a tracked file is edited',
      (wt: string) => writeFileSync(path.join(wt, 'tracked.txt'), 'x\n')
    ],
    ['an untracked file appears', (wt: string) => writeFileSync(path.join(wt, 'new.txt'), 'x\n')],
    [
      'an untracked file is edited',
      (wt: string) => writeFileSync(path.join(wt, 'notes', 'u.txt'), 'y\n')
    ],
    ['a tracked file is deleted', (wt: string) => rmSync(path.join(wt, 'tracked.txt'))],
    [
      'an ignored file is edited',
      (wt: string) => writeFileSync(path.join(wt, '.env'), 'SECRET=2\n')
    ],
    [
      'a new ignored file appears',
      (wt: string) => writeFileSync(path.join(wt, '.harnu', 'out', 'second.txt'), 'x\n')
    ],
    ['an ignored file is deleted', (wt: string) => rmSync(path.join(wt, '.env'))]
  ])('fails closed when %s', async (_name, change) => {
    change(fx.wt)
    expect(reason(await verifyPreservation(record))).toBe('worktree-changed')
    // The archive itself is still sound.
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('ok')
  })

  it('fails when the branch moved', async () => {
    git(fx.wt, 'commit', '-q', '-am', 'later work')
    expect(reason(await verifyPreservation(record))).toBe('head-moved')
  })

  it('fails when the folder is gone (live), and still passes in archive mode', async () => {
    rmSync(fx.wt, { recursive: true, force: true })
    expect(reason(await verifyPreservation(record))).toBe('worktree-missing')
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('ok')
  })

  it('requires an absent snapshot to stay absent', async () => {
    rmSync(path.join(fx.wt, '.env'))
    rmSync(path.join(fx.wt, '.harnu'), { recursive: true })
    git(fx.repo, 'update-ref', '-d', `${record.namespace}/shelve/record`)
    git(fx.repo, 'update-ref', '-d', `${record.namespace}/shelve/ignored`)
    git(fx.repo, 'update-ref', '-d', record.wipRef)
    git(fx.repo, 'update-ref', '-d', record.tipRef)
    const bare = await preserve()
    expect(bare.ignored).toBeNull()
    expect(reason(await verifyPreservation(bare))).toBe('ok')
    mkdirSync(path.join(fx.wt, '.harnu', 'out'), { recursive: true })
    writeFileSync(path.join(fx.wt, '.harnu', 'out', 'late.txt'), 'x\n')
    expect(reason(await verifyPreservation(bare))).toBe('worktree-changed')
  })
})

describe('verifyPreservation — the archive is damaged', () => {
  it('fails when a ref is gone', async () => {
    git(fx.repo, 'update-ref', '-d', record.wipRef)
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('ref-missing')
  })

  it('fails when the record ref is gone', async () => {
    git(fx.repo, 'update-ref', '-d', `${record.namespace}/shelve/record`)
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('ref-missing')
  })

  it('fails when a ref points somewhere else', async () => {
    git(fx.repo, 'update-ref', record.wipRef, record.headSha)
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('ref-moved')
  })

  it('fails when an object of the snapshot is missing from the store', async () => {
    const oid = git(fx.repo, 'rev-parse', `${record.ignored!.ref}:.env`)
    const loose = path.join(fx.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    rmSync(loose, { force: true })
    expect(reason(await verifyPreservation(record, { mode: 'archive' }))).toBe('object-missing')
  })

  it('fails closed, never throws, when git cannot answer', async () => {
    const broken = { ...record, repoPath: path.join(fx.root, 'not-a-repo') }
    const v = await verifyPreservation(broken, { mode: 'archive' })
    expect(reason(v)).toBe('probe-failed')
    expect(reason(await verifyPreservation(broken))).toBe('probe-failed')
  })
})
