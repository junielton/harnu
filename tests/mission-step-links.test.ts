/**
 * Missions v4 · S-13 · AC-34 — step links.
 *
 * Two halves. (1) A pull request on a step's branch attaches to the step by itself: a pure function
 * turns the pull requests found for a mission's steps (plain values: a step id or a branch, a number,
 * a state) into the links to add, and a write adds them once. The finder lives in chapter 2's observer
 * and calling this from its pass is slice S-16's. (2) A page or report link must be an `http(s)`
 * address or a path inside the repo: no other scheme, no absolute path, no `..` out of the repo, no
 * symlink out of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMissionRecordContent, type MissionV4, type StepV4 } from '../src/main/missions/model'
import { guardMission, type Actor } from '../src/main/missions/guard'
import { readMissionRecord } from '../src/main/missions/record-store'
import { addLink, attachFoundPrs, planPrLinks, type FoundPr } from '../src/main/missions/verbs-plan'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const ID = 'mnt-cc000001'
const NOW = '2026-11-14T10:00:00Z'

const leader: Actor = { kind: 'session', sessionId: LEADER }
const worker: Actor = { kind: 'session', sessionId: WORKER }
const operator: Actor = { kind: 'operator' }
const system: Actor = { kind: 'worker' }
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

const step = (id: string, over: Partial<StepV4> = {}): StepV4 => ({
  id,
  title: `Step ${id}`.replace('Step stp-', 'Build part '),
  acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
  links: [],
  blockers: [],
  ...over
})

const missionOf = (over: Partial<MissionV4> = {}): MissionV4 => ({
  schemaVersion: 4,
  id: ID,
  title: 'Score report',
  doneWhen: 'Every candidate sees a score report',
  status: 'open',
  milestones: [],
  steps: [step('stp-1'), step('stp-2')],
  sessions: [
    { id: LEADER, role: 'leads', from: NOW, to: null },
    { id: WORKER, role: 'worked', from: NOW, to: null }
  ],
  links: [],
  blockers: [],
  ...over
})

let root = ''
let outside = ''
const v4Dir = (): string => path.join(root, '.harnu', 'missions-v4')
const v4File = (): string => path.join(v4Dir(), `${ID}-score-report.md`)
const seed = (record: MissionV4 = missionOf()): void => {
  mkdirSync(v4Dir(), { recursive: true })
  writeFileSync(v4File(), buildMissionRecordContent(record, ''))
}
const load = async (id = ID): Promise<MissionV4> => {
  const r = await readMissionRecord(root, id)
  if (!r.ok) throw new Error(r.error)
  return r.record
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-step-links-'))
  outside = mkdtempSync(path.join(os.tmpdir(), 'harnu-step-links-outside-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('the pull request attaches by itself', () => {
  describe('planPrLinks: the pull requests found, as plain values, become the links to add', () => {
    const record = missionOf()

    it('a pull request found for a step id becomes a pr link on that step', () => {
      const plan = planPrLinks(record, [{ stepId: 'stp-2', number: 301, state: 'open' }])
      expect(plan.add).toEqual([{ stepId: 'stp-2', link: { kind: 'pr', ref: '301' } }])
      expect(plan.skipped).toEqual([])
    })

    it('a pull request found by its branch attaches to the step that branch belongs to', () => {
      const plan = planPrLinks(record, [{ branch: 'card/T9-score', number: 12, state: 'merged' }], {
        'stp-1': 'card/T9-score'
      })
      expect(plan.add).toEqual([{ stepId: 'stp-1', link: { kind: 'pr', ref: '12' } }])
    })

    it('a pull request a step already carries is not added again, whichever way it was written', () => {
      const withLink = missionOf({
        steps: [step('stp-1', { links: [{ kind: 'pr', ref: '12' }] }), step('stp-2')]
      })
      const plan = planPrLinks(withLink, [{ stepId: 'stp-1', number: 12, state: 'open' }])
      expect(plan.add).toEqual([])
      expect(plan.skipped).toEqual([{ number: 12, reason: 'already-linked' }])
    })

    it('the same pull request found twice is added once; stacked pull requests all attach', () => {
      const plan = planPrLinks(record, [
        { stepId: 'stp-1', number: 5, state: 'open' },
        { stepId: 'stp-1', number: 5, state: 'open' },
        { stepId: 'stp-1', number: 6, state: 'merged' }
      ])
      expect(plan.add.map((a) => a.link.ref)).toEqual(['5', '6'])
    })

    it('a closed pull request counts as none: it does not attach, and a skip names why', () => {
      const plan = planPrLinks(record, [{ stepId: 'stp-1', number: 7, state: 'closed' }])
      expect(plan.add).toEqual([])
      expect(plan.skipped).toEqual([{ number: 7, reason: 'closed' }])
    })

    it('a pull request that belongs to no step of the mission, or names no number, is skipped and named', () => {
      const plan = planPrLinks(
        record,
        [
          { stepId: 'stp-9', number: 1, state: 'open' },
          { branch: 'card/unknown', number: 2, state: 'open' },
          { stepId: 'stp-1', number: 0, state: 'open' },
          { stepId: 'stp-1', number: 1.5, state: 'open' }
        ],
        { 'stp-1': 'card/T9-score' }
      )
      expect(plan.add).toEqual([])
      expect(plan.skipped.map((s) => s.reason)).toEqual([
        'no-step',
        'no-step',
        'bad-number',
        'bad-number'
      ])
    })

    it('a branch that two steps share is ambiguous: the pull request is skipped, never guessed', () => {
      const plan = planPrLinks(record, [{ branch: 'card/T9-score', number: 8, state: 'open' }], {
        'stp-1': 'card/T9-score',
        'stp-2': 'card/T9-score'
      })
      expect(plan.add).toEqual([])
      expect(plan.skipped).toEqual([{ number: 8, reason: 'ambiguous-branch' }])
    })

    it('a step id the record does not have is found through the ids a v3 campaign had', () => {
      const converted = missionOf({
        legacyV3: { stepIds: [{ mission: 'mnt-ca000002', step: 'stp-7', id: 'stp-2' }] }
      })
      const plan = planPrLinks(converted, [{ stepId: 'stp-7', number: 40, state: 'open' }])
      expect(plan.add).toEqual([{ stepId: 'stp-2', link: { kind: 'pr', ref: '40' } }])
    })

    it('a step id wins over a branch when a found pull request carries both', () => {
      const plan = planPrLinks(
        record,
        [{ stepId: 'stp-2', branch: 'card/T9-score', number: 3, state: 'open' }],
        { 'stp-1': 'card/T9-score' }
      )
      expect(plan.add).toEqual([{ stepId: 'stp-2', link: { kind: 'pr', ref: '3' } }])
    })

    it('is pure: the record it was given is not touched', () => {
      const copy = structuredClone(record)
      planPrLinks(record, [{ stepId: 'stp-1', number: 5, state: 'open' }])
      expect(record).toEqual(copy)
    })
  })

  describe('attachFoundPrs: the write that adds them once', () => {
    const found: FoundPr[] = [
      { stepId: 'stp-1', number: 11, state: 'open' },
      { branch: 'card/T9-score', number: 12, state: 'merged' }
    ]

    it('writes the links, and a second pass over the same pull requests writes nothing', async () => {
      seed()
      const first = await attachFoundPrs(root, operator, ID, found, { 'stp-2': 'card/T9-score' })
      expect(first).toMatchObject({ ok: true })
      expect(first.ok && first.added).toEqual([
        { stepId: 'stp-1', ref: '11' },
        { stepId: 'stp-2', ref: '12' }
      ])
      const record = await load()
      expect(record.steps[0].links).toEqual([{ kind: 'pr', ref: '11' }])
      expect(record.steps[1].links).toEqual([{ kind: 'pr', ref: '12' }])

      const bytes = readFileSync(v4File())
      const second = await attachFoundPrs(root, operator, ID, found, { 'stp-2': 'card/T9-score' })
      expect(second).toMatchObject({ ok: true, added: [] })
      expect(readFileSync(v4File()).equals(bytes)).toBe(true)
    })

    it('a pull request that appears later is added, and the earlier ones stay as they were', async () => {
      seed()
      await attachFoundPrs(root, operator, ID, [found[0]])
      const later = await attachFoundPrs(root, operator, ID, [
        found[0],
        { stepId: 'stp-1', number: 13, state: 'open' }
      ])
      expect(later.ok && later.added).toEqual([{ stepId: 'stp-1', ref: '13' }])
      expect((await load()).steps[0].links.map((l) => l.ref)).toEqual(['11', '13'])
    })

    it("it is the app's write, not a session's verb: a system worker is read only, a closed mission refuses", async () => {
      seed()
      const bytes = readFileSync(v4File())
      expect(await attachFoundPrs(root, system, ID, found)).toMatchObject({
        ok: false,
        code: 'READ_ONLY'
      })
      seed(missionOf({ status: 'closed', closedAs: 'delivered' }))
      const closed = readFileSync(v4File())
      expect(await attachFoundPrs(root, operator, ID, found)).toMatchObject({
        ok: false,
        code: 'MISSION_CLOSED'
      })
      expect(readFileSync(v4File()).equals(closed)).toBe(true)
      expect(bytes.equals(closed)).toBe(false)
    })

    it('an unknown mission is MISSION_NOT_FOUND', async () => {
      seed()
      expect(await attachFoundPrs(root, operator, 'mnt-00000000', found)).toMatchObject({
        ok: false,
        code: 'MISSION_NOT_FOUND'
      })
    })

    describe('on a mission that exists only as v3', () => {
      const V3_ID = 'mnt-5c0de001'
      const dirV3 = (): string => path.join(root, '.harnu', 'missions')
      const hashes = (): Record<string, string> =>
        Object.fromEntries(
          readdirSync(dirV3()).map((n) => [n, sha(readFileSync(path.join(dirV3(), n)))])
        )

      beforeEach(() => {
        cpSync(path.join(FIXTURES, 'missions'), dirV3(), { recursive: true })
      })

      it('a pass with nothing to add creates no v4 record and no directory', async () => {
        const before = hashes()
        const r = await attachFoundPrs(root, operator, V3_ID, [
          { stepId: 'stp-99', number: 1, state: 'open' }
        ])
        expect(r).toMatchObject({ ok: true, added: [] })
        expect(existsSync(v4Dir())).toBe(false)
        expect(hashes()).toEqual(before)
      })

      it('a pull request that attaches makes the v4 copy, and the v3 files keep their bytes and their hash', async () => {
        const before = hashes()
        const r = await attachFoundPrs(root, operator, V3_ID, [
          { stepId: 'stp-1', number: 777, state: 'open' }
        ])
        expect(r).toMatchObject({ ok: true, added: [{ stepId: 'stp-1', ref: '777' }] })
        expect(hashes()).toEqual(before)
        expect((await load(V3_ID)).steps[0].links).toContainEqual({ kind: 'pr', ref: '777' })
      })
    })
  })
})

describe('a page or report link is an http(s) address or a path inside the repo', () => {
  const link = async (kind: 'url' | 'doc', ref: string, actor: Actor = worker) =>
    addLink(root, actor, { missionId: ID, stepId: 'stp-1', kind, ref })
  const refusedBy = async (kind: 'url' | 'doc', ref: string): Promise<string> => {
    const r = await link(kind, ref)
    return r.ok ? 'ok' : r.code
  }

  beforeEach(() => {
    seed()
    mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true })
    writeFileSync(path.join(root, 'docs', 'specs', 'spec.md'), '# spec\n')
    writeFileSync(path.join(root, 'README.md'), '# readme\n')
  })

  it('accepts http and https addresses and repo paths, for both kinds', async () => {
    for (const kind of ['url', 'doc'] as const) {
      for (const ref of [
        'http://localhost:5173/score-report',
        'https://example.com/report?round=2#top',
        'HTTPS://EXAMPLE.COM/x',
        'docs/specs/spec.md',
        'docs/not-written-yet.md',
        'docs/../README.md',
        './README.md'
      ]) {
        expect(await refusedBy(kind, ref), `${kind} ${ref}`).toBe('ok')
      }
    }
  })

  it('refuses every other scheme', async () => {
    for (const ref of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/x',
      'vbscript:x',
      'blob:https://example.com/1',
      'mailto:a@b.c',
      'ssh://git@example.com/x',
      'about:blank'
    ]) {
      expect(await refusedBy('url', ref), ref).toBe('BAD_LINK')
      expect(await refusedBy('doc', ref), ref).toBe('BAD_LINK')
    }
  })

  it('refuses an address that only looks like http: control characters, no host, credentials in the way', async () => {
    for (const ref of [
      'ht\ntp://example.com',
      'https://',
      'http:///x',
      ' https://example.com',
      'https://example.com ',
      'https://exa mple.com',
      'https://u:p@example.com/x',
      ''
    ]) {
      expect(await refusedBy('url', ref), JSON.stringify(ref)).toBe('BAD_LINK')
    }
  })

  it('refuses an absolute path', async () => {
    for (const ref of [
      '/etc/passwd',
      path.join(root, 'README.md'),
      '\\\\server\\share\\x',
      'C:\\Users\\x',
      'c:/x',
      '~/x'
    ]) {
      expect(await refusedBy('doc', ref), ref).toBe('BAD_LINK')
    }
  })

  it('refuses a path that escapes the repo with ..', async () => {
    for (const ref of [
      '../outside.md',
      'docs/../../outside.md',
      '..',
      'docs/specs/../../../x',
      'docs/../..\\x'
    ]) {
      expect(await refusedBy('doc', ref), ref).toBe('BAD_LINK')
    }
  })

  it('refuses a path that escapes the repo through a symlink, existing or not yet written', async () => {
    writeFileSync(path.join(outside, 'secret.md'), 'secret\n')
    symlinkSync(outside, path.join(root, 'docs', 'link-out'))
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'docs', 'secret-link.md'))
    symlinkSync(path.join(outside, 'not-written-yet.md'), path.join(root, 'docs', 'dangling.md'))
    for (const ref of [
      'docs/link-out',
      'docs/link-out/secret.md',
      'docs/link-out/not-yet.md',
      'docs/link-out/deeper/not-yet.md',
      'docs/secret-link.md',
      'docs/dangling.md',
      'docs/link-out/../secret.md'
    ]) {
      expect(await refusedBy('doc', ref), ref).toBe('BAD_LINK')
    }
  })

  it('a symlink that stays inside the repo is fine', async () => {
    symlinkSync(path.join(root, 'docs', 'specs'), path.join(root, 'docs', 'link-in'))
    expect(await refusedBy('doc', 'docs/link-in/spec.md')).toBe('ok')
  })

  it('a path that cannot be proven to stay inside (it is not written yet and holds ..) is refused', async () => {
    expect(await refusedBy('doc', 'docs/nowhere/../spec.md')).toBe('BAD_LINK')
  })

  it('applies to a link on the mission as well as on a step, and a refusal writes nothing', async () => {
    const bytes = readFileSync(v4File())
    const r = await addLink(root, leader, { missionId: ID, kind: 'doc', ref: 'file:///etc/passwd' })
    expect(r).toMatchObject({ ok: false, code: 'BAD_LINK' })
    expect(readFileSync(v4File()).equals(bytes)).toBe(true)
  })

  it('the refusal names the way out and never carries the refused text', async () => {
    const r = await link('url', 'javascript:alert(document.cookie)')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/^BAD_LINK: /)
      expect(r.error).toMatch(/http/)
      expect(r.error).not.toContain('document.cookie')
    }
  })

  it('a worktree link is a path, and is not held to the page rule', async () => {
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'worktree',
      ref: '/home/user/Workspace/org/www/.claude/worktrees/card-T701'
    })
    expect(r).toMatchObject({ ok: true })
    for (const ref of ['javascript:alert(1)', 'https://example.com', '', 'a\nb']) {
      const bad = await addLink(root, leader, {
        missionId: ID,
        stepId: 'stp-1',
        kind: 'worktree',
        ref
      })
      expect(bad, ref).toMatchObject({ ok: false, code: 'BAD_LINK' })
    }
  })
})

// ---- Delta 3: a pull request is one pull request however it is written; hardened doc paths ---------

describe('a pull request is the same pull request however its link was written', () => {
  const converted = (ref: string): MissionV4 =>
    missionOf({ steps: [step('stp-1', { links: [{ kind: 'pr', ref }] }), step('stp-2')] })

  for (const ref of ['owner/repo#302', '#302', '302', 'https://github.com/owner/repo/pull/302']) {
    it(`a step that carries ${ref} gains no second link for pull request 302`, () => {
      const plan = planPrLinks(converted(ref), [{ stepId: 'stp-1', number: 302, state: 'open' }])
      expect(plan.add).toEqual([])
      expect(plan.skipped).toEqual([{ number: 302, reason: 'already-linked' }])
    })
  }

  it('a pull request 3020 is not 302, and 302 on another step is its own link', () => {
    const plan = planPrLinks(converted('owner/repo#302'), [
      { stepId: 'stp-1', number: 30, state: 'open' },
      { stepId: 'stp-2', number: 302, state: 'open' }
    ])
    expect(plan.add.map((a) => `${a.stepId}#${a.link.ref}`)).toEqual(['stp-1#30', 'stp-2#302'])
  })

  it('attachFoundPrs on a step converted with owner/repo#302 writes nothing', async () => {
    seed(converted('owner/repo#302'))
    const bytes = readFileSync(v4File())
    const r = await attachFoundPrs(root, operator, ID, [
      { stepId: 'stp-1', number: 302, state: 'merged' }
    ])
    expect(r).toMatchObject({ ok: true, added: [] })
    expect(readFileSync(v4File()).equals(bytes)).toBe(true)
  })

  it('mission_link of 302 on a step that carries owner/repo#302 is the same link: added is false', async () => {
    seed(converted('owner/repo#302'))
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'pr',
      ref: '302'
    })
    expect(r).toMatchObject({ ok: true, added: false })
    expect((await load()).steps[0].links).toEqual([{ kind: 'pr', ref: 'owner/repo#302' }])
  })
})

describe('a page or report link never points into .git, .harnu or node_modules', () => {
  const refusedBy = async (kind: 'url' | 'doc', ref: string): Promise<string> => {
    const r = await addLink(root, leader, { missionId: ID, stepId: 'stp-1', kind, ref })
    return r.ok ? 'ok' : r.code
  }

  beforeEach(() => {
    seed()
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(root, 'docs', 'real.md'), '# real\n')
    mkdirSync(path.join(root, '.git'), { recursive: true })
    writeFileSync(path.join(root, '.git', 'config'), '[core]\n')
  })

  it('refuses a repo path with a .git, a .harnu or a node_modules segment, in any case and any spelling', async () => {
    for (const kind of ['doc', 'url'] as const) {
      for (const ref of [
        '.git/config',
        '.GIT/config',
        'docs/.git/config',
        './.git/config',
        'docs/../.git/config',
        '.harnu/../.git/config',
        'docs\\.git\\config',
        '.harnu/missions-v4/mnt-aa000001-x.md',
        '.Harnu/memory/hot.md',
        'docs/.harnu/x.md',
        'node_modules/left-pad/readme.md',
        'docs/node_modules/x.md',
        'Node_Modules/x'
      ]) {
        expect(await refusedBy(kind, ref), `${kind} ${ref}`).toBe('BAD_LINK')
      }
    }
  })

  it('refuses a symlink inside the repo that leads into .git', async () => {
    symlinkSync(path.join(root, '.git'), path.join(root, 'docs', 'to-git'))
    expect(await refusedBy('doc', 'docs/to-git/config')).toBe('BAD_LINK')
    expect(await refusedBy('doc', 'docs/to-git')).toBe('BAD_LINK')
  })

  it('still accepts a name that only starts like one, and an address that has .git in it', async () => {
    for (const ref of [
      'docs/real.md',
      '.gitignore',
      'docs/.github/workflow.md',
      'docs/git-notes.md',
      'docs/node_modules_notes.md',
      'https://github.com/owner/repo.git',
      'https://example.com/node_modules/x'
    ]) {
      expect(await refusedBy('doc', ref), ref).toBe('ok')
    }
  })

  it('a worktree link is a path of a checkout or an evidence folder, and is not held to this', async () => {
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'worktree',
      ref: '.harnu/evidence/mnt-cc000001/stp-1'
    })
    expect(r).toMatchObject({ ok: true })
  })
})

describe('a link refusal says what to pass instead', () => {
  it('a session link that is not a session id says to pass the id of the session', async () => {
    seed()
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'session',
      ref: 'the builder session'
    })
    expect(r).toMatchObject({ ok: false, code: 'BAD_LINK' })
    expect(r.ok ? '' : r.error).toMatch(/pass the id of the session/i)
    expect(r.ok ? '' : r.error).not.toContain('the builder session')
  })

  it('a pr link that is not a number says to pass the number', async () => {
    seed()
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'pr',
      ref: 'my pull request'
    })
    expect(r.ok ? '' : r.error).toMatch(/pass the pull request number/i)
  })

  it('an unknown kind says which five to pass', async () => {
    seed()
    const r = await addLink(root, leader, {
      missionId: ID,
      stepId: 'stp-1',
      kind: 'steward',
      ref: 'x'
    })
    expect(r.ok ? '' : r.error).toMatch(/pass one of session, pr, worktree, url, doc/)
  })
})

// ---- Delta 1, item 5: Harnu's own call is { kind: 'harnu' } ----------------------------------------

describe("Harnu's own call attaches the pull requests as harnu", () => {
  const harnu: Actor = { kind: 'harnu' }
  const found: FoundPr[] = [
    { stepId: 'stp-1', number: 11, state: 'open' },
    { branch: 'card/T9-score', number: 12, state: 'merged' }
  ]

  it('attaches, once, and a second pass over the same pull requests writes nothing', async () => {
    seed()
    const first = await attachFoundPrs(root, harnu, ID, found, { 'stp-2': 'card/T9-score' })
    expect(first).toMatchObject({ ok: true })
    expect(first.ok && first.added).toEqual([
      { stepId: 'stp-1', ref: '11' },
      { stepId: 'stp-2', ref: '12' }
    ])
    const record = await load()
    expect(record.steps[0].links).toEqual([{ kind: 'pr', ref: '11' }])
    expect(record.steps[1].links).toEqual([{ kind: 'pr', ref: '12' }])
    const bytes = readFileSync(v4File())
    const second = await attachFoundPrs(root, harnu, ID, found, { 'stp-2': 'card/T9-score' })
    expect(second).toMatchObject({ ok: true, added: [] })
    expect(readFileSync(v4File()).equals(bytes)).toBe(true)
  })

  it('is judged as harnu, never as the operator: the guard names its standing', () => {
    const access = guardMission(missionOf(), harnu, 'write')
    expect(access).toEqual({ ok: true, standing: 'harnu' })
    expect(access).not.toMatchObject({ standing: 'operator' })
  })

  it('a closed mission refuses it, and a mission it does not know is MISSION_NOT_FOUND', async () => {
    seed(missionOf({ status: 'closed', closedAs: 'delivered' }))
    const bytes = readFileSync(v4File())
    expect(await attachFoundPrs(root, harnu, ID, found)).toMatchObject({
      ok: false,
      code: 'MISSION_CLOSED'
    })
    expect(readFileSync(v4File()).equals(bytes)).toBe(true)
    expect(await attachFoundPrs(root, harnu, 'mnt-00000000', found)).toMatchObject({
      ok: false,
      code: 'MISSION_NOT_FOUND'
    })
  })

  it('on a mission that exists only as v3 it attaches into the v4 copy and leaves every v3 file whole', async () => {
    const dirV3 = path.join(root, '.harnu', 'missions')
    cpSync(path.join(FIXTURES, 'missions'), dirV3, { recursive: true })
    const hashes = (): Record<string, string> =>
      Object.fromEntries(readdirSync(dirV3).map((n) => [n, sha(readFileSync(path.join(dirV3, n)))]))
    const before = hashes()
    const r = await attachFoundPrs(root, harnu, 'mnt-5c0de001', [
      { stepId: 'stp-1', number: 778, state: 'open' }
    ])
    expect(r).toMatchObject({ ok: true, added: [{ stepId: 'stp-1', ref: '778' }] })
    expect(hashes()).toEqual(before)
  })
})
