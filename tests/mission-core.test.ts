import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyApprovedRescope,
  buildMissionFileContent,
  createMissionFile,
  mintMissionId,
  missionFilePath,
  missionScope,
  parseMissionFile,
  readMissionLog,
  requestCloseRefusal,
  withMissionIdMintLock,
  MISSION_ID_RE,
  MISSION_STEP_CONTROLLED_FIELDS,
  type Mission
} from '../src/main/mission-core'

/**
 * A Mission exercising every field of design.md §1: the fixed frame plus two
 * custom steps, every optional field set, nested `links[]`/`blockers[]`, and
 * strings chosen to trip a naive YAML writer (a `---` fence, colons, quotes,
 * newlines, and scalars that look like numbers/booleans/null/timestamps).
 */
function fullMission(): Mission {
  return {
    id: 'mnt-0a1b2c3d',
    slug: 'mission-progress-rollout',
    folder: '/home/dev/Workspace/org/proj/www',
    owner: { sessionId: '8f2c1e4a-1111-4222-8333-944455556666', folder: '/home/dev/wt/owner' },
    linkedCard: 'T358-mission-progress-promote-the-goal-file-to-a-structured-mission',
    status: 'active',
    declaredEnd: {
      kind: 'code',
      target: "PR merging T358's 4 slices into main",
      evidence: 'green CI + delivery-verifier report: all ACs "met"'
    },
    declaredEndApproval: { at: '2026-09-26T10:00:00.000Z', bodyHash: 'sha256:abc123' },
    pendingRescope: {
      kind: 'research',
      target: 'multi-line target\n---\nwith a fence inside',
      evidence: '123'
    },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [{ kind: 'card', ref: 'T361-mission-progress-spec' }],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'custom',
        title: 'Data model: true',
        verification: 'verifier',
        proof: 'verified',
        verifiedBy: { sessionId: 'aaaa-bbbb', at: '2026-09-27T08:30:00.000Z', verdict: 'met' },
        links: [
          { kind: 'session', ref: '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff' },
          { kind: 'worktree', ref: '/home/dev/wt/T358-s1' },
          { kind: 'pr', ref: 'owner/repo#123' }
        ],
        blockers: [
          {
            reason: 'waiting on review: "LGTM" needed',
            unblocks: 'a reviewer approves PR #123',
            owner: 'operator',
            raisedAt: '2026-09-27T09:00:00.000Z'
          }
        ],
        addedReason: 'split out of the fixed frame after scoping'
      },
      {
        id: 'stp-3',
        ordinal: 3,
        kind: 'custom',
        title: 'null',
        verification: 'human',
        proof: 'claimed',
        links: [],
        blockers: [
          {
            reason: 'needs the operator',
            unblocks: 'yes',
            owner: 'agent',
            raisedAt: '2026-09-27T09:05:00.000Z'
          }
        ],
        addedReason: 'operator asked for a manual check'
      },
      {
        id: 'stp-4',
        ordinal: 4,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'self-verified',
        verifiedBy: { sessionId: 'owner-self', at: '2026-09-28T12:00:00.000Z' },
        links: [],
        blockers: []
      }
    ],
    blockers: [
      {
        reason: 'mission-level: waiting on the operator to pick a release window',
        unblocks: 'operator: "Tuesday"',
        owner: 'operator',
        raisedAt: '2026-09-27T10:00:00.000Z'
      }
    ],
    openQuestions: ['Should E be decided now?', '', 'multi\nline: question'],
    pendingClose: { at: '2026-09-28T12:05:00.000Z', requestedBy: 'owner-self' },
    createdAt: '2026-09-26T09:00:00.000Z',
    updatedAt: '2026-09-28T12:05:00.000Z',
    provenance: { author: 'agent', at: '2026-09-26T09:00:00.000Z', branch: 'main' }
  }
}

describe('mission-core — frontmatter round-trip (design.md §1, §9)', () => {
  it('round-trips a full Mission through build/parse', () => {
    const mission = fullMission()
    const content = buildMissionFileContent(mission)
    expect(parseMissionFile(content)).toStrictEqual(mission)
  })

  it('keeps the Log body verbatim and separate from the frontmatter', () => {
    const log = '## Log\n\n- 2026-09-28 10:00 — dispatched S1\n---\nnot a fence for the parser\n'
    const content = buildMissionFileContent(fullMission(), log)
    expect(readMissionLog(content)).toBe(log)
    expect(parseMissionFile(content)).toStrictEqual(fullMission())
  })

  it('drops an optional field left explicitly undefined instead of failing to write', () => {
    const mission: Mission = { ...fullMission(), linkedCard: undefined, pendingClose: undefined }
    const parsed = parseMissionFile(buildMissionFileContent(mission))
    expect(parsed).not.toHaveProperty('linkedCard')
    expect(parsed).not.toHaveProperty('pendingClose')
  })

  it('round-trips an imported mission: legacy metadata and legacyRaw survive byte-for-byte (S1 F2)', () => {
    // Strings a naive YAML writer mangles: a frontmatter block of its own, `---`
    // fences, CRLF, tabs, trailing spaces, a leading space, no final newline, a
    // BOM, a NUL, emoji, and a body that is nothing but whitespace.
    const raws = [
      '---\nsession: 3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c\n---\n\n# Goal\n\n## Log\n- a\n',
      'line one\r\nline two\r\n---\r\n',
      '\tindented with a tab  \n  two leading spaces\n\n\n',
      ' leading space, no final newline',
      '﻿bom first\n',
      'nul \u0000 inside\n',
      'émoji 🦫 and ação\n',
      ' \n\t\n',
      ''
    ]
    for (const legacyRaw of raws) {
      const mission: Mission = {
        ...fullMission(),
        legacy: {
          source: '/repo/.harnu/goals/3f2a9c10-export.md',
          sha256: 'sha256:00ff',
          needsReview: ['declaredEnd']
        },
        legacyRaw
      }
      const parsed = parseMissionFile(buildMissionFileContent(mission, '# t\n\n## Log\n'))
      expect(parsed).toStrictEqual(mission)
      expect((parsed as Mission).legacyRaw).toBe(legacyRaw)
    }
  })

  it("approving a re-scope clears an imported mission's declaredEnd needs-review flag", () => {
    const mission: Mission = {
      ...fullMission(),
      legacy: {
        source: '/repo/.harnu/goals/x.md',
        sha256: 'sha256:00ff',
        needsReview: ['declaredEnd']
      },
      legacyRaw: 'raw\n'
    }
    const approved = applyApprovedRescope(mission, { at: '2026-09-28T13:00:00.000Z' })
    expect(approved.legacy).toStrictEqual({ ...mission.legacy, needsReview: [] })
    expect(approved.legacyRaw).toBe('raw\n')
    expect(mission.legacy?.needsReview).toStrictEqual(['declaredEnd']) // input untouched
  })

  it('round-trips mission-level blockers (design §1.4 — a blocker flags a mission OR a step)', () => {
    const parsed = parseMissionFile(buildMissionFileContent(fullMission())) as Mission
    expect(parsed.blockers).toStrictEqual(fullMission().blockers)
    expect(parsed.steps[1].blockers).toStrictEqual(fullMission().steps[1].blockers)
  })

  it('reads a mission file written before mission-level blockers existed as blockers: []', () => {
    const content = buildMissionFileContent({ ...fullMission(), blockers: [] }).replace(
      /^blockers: \[\]\n/m,
      ''
    )
    expect(content).not.toMatch(/^blockers:/m)
    expect((parseMissionFile(content) as Mission).blockers).toStrictEqual([])
  })

  it('returns { error } for a malformed mission-level blocker', () => {
    const content = buildMissionFileContent(fullMission()).replace(
      "owner: operator\n    raisedAt: '2026-09-27T10:00:00.000Z'",
      "owner: nobody\n    raisedAt: '2026-09-27T10:00:00.000Z'"
    )
    expect((parseMissionFile(content) as { error: string }).error).toMatch(
      /^invalid mission: blockers\.0\.owner: /
    )
  })

  it('reads a hand-edited, unquoted timestamp back as a string, not a Date', () => {
    const content = buildMissionFileContent(fullMission()).replace(
      "createdAt: '2026-09-26T09:00:00.000Z'",
      'createdAt: 2026-09-26T09:00:00.000Z'
    )
    expect(content).toContain('createdAt: 2026-09-26T09:00:00.000Z')
    expect(parseMissionFile(content)).toMatchObject({ createdAt: '2026-09-26T09:00:00.000Z' })
  })

  it('refuses to build a file from an invalid mission', () => {
    const bad = { ...fullMission(), id: 'T358' }
    expect(() => buildMissionFileContent(bad)).toThrow(/invalid mission: id/)
  })

  it('returns { error } for a file with no frontmatter or an unclosed one', () => {
    expect(parseMissionFile('## Log only\n')).toEqual({ error: 'no frontmatter block' })
    expect(parseMissionFile('---\nid: mnt-0a1b2c3d\n')).toEqual({ error: 'no frontmatter block' })
    expect(readMissionLog('## Log only\n')).toBe('')
  })

  it('returns { error } for a YAML syntax error', () => {
    const result = parseMissionFile('---\nid: [unclosed\n---\n')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/^invalid YAML: /)
  })

  it('returns { error } naming the path of a schema mismatch', () => {
    const content = buildMissionFileContent(fullMission()).replace('proof: claimed', 'proof: done')
    const result = parseMissionFile(content)
    expect((result as { error: string }).error).toMatch(/^invalid mission: steps\.2\.proof: /)
  })

  it('returns { error } for an empty or non-mapping frontmatter', () => {
    expect((parseMissionFile('---\n---\n') as { error: string }).error).toMatch(
      /^invalid mission: \(root\): /
    )
    expect((parseMissionFile('---\n- a\n- b\n---\n') as { error: string }).error).toMatch(
      /^invalid mission: /
    )
  })
})

describe('mission-core — Mission v3 schema (spec §3.3, §3.4, §3.6, §6)', () => {
  it('(a) reads a legacy draft as active — draft stays parseable, never surfaces', () => {
    const content = buildMissionFileContent({ ...fullMission(), status: 'draft' })
    expect(content).toMatch(/^status: draft$/m)
    expect((parseMissionFile(content) as Mission).status).toBe('active')
  })

  it('(b) passthrough: unknown top-level, step, link, blocker and check keys survive a round-trip', () => {
    const m = fullMission() as unknown as Record<string, unknown>
    const steps = m.steps as Record<string, unknown>[]
    m.futureTop = { nested: 'kept' }
    steps[1].futureStep = 'kept'
    ;(steps[1].links as Record<string, unknown>[])[0].futureLink = 7
    ;(steps[1].blockers as Record<string, unknown>[])[0].futureBlocker = true
    steps[2].checks = [
      {
        id: 'chk-1',
        label: 'DSQA',
        source: 'agent',
        createdAt: '2026-10-01T00:00:00.000Z',
        futureCheck: 'x'
      }
    ]
    const once = parseMissionFile(buildMissionFileContent(m as unknown as Mission)) as Mission
    const twice = parseMissionFile(buildMissionFileContent(once)) as unknown as Record<
      string,
      unknown
    >
    const s = twice.steps as Record<string, unknown>[]
    expect(twice.futureTop).toStrictEqual({ nested: 'kept' })
    expect(s[1].futureStep).toBe('kept')
    expect((s[1].links as Record<string, unknown>[])[0].futureLink).toBe(7)
    expect((s[1].blockers as Record<string, unknown>[])[0].futureBlocker).toBe(true)
    expect((s[2].checks as Record<string, unknown>[])[0].futureCheck).toBe('x')
  })

  it('(c) checks, scope, closedAs, closeReason, addedAt and via round-trip', () => {
    const mission: Mission = {
      ...fullMission(),
      status: 'closed',
      closedAs: 'discarded',
      closeReason: 'superseded by v3',
      scope: [{ kind: 'worktree', ref: 'docs/specs/x/spec.md' }],
      declaredEndApproval: { at: '2026-09-26T10:00:00.000Z', bodyHash: 'sha256:abc', via: 'chat' }
    }
    mission.steps[1].addedAt = '2026-09-27T08:00:00.000Z'
    mission.steps[2].checks = [
      {
        id: 'chk-1',
        label: 'DSQA done',
        source: 'verifier',
        createdAt: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'chk-2',
        label: 'designer sign-off',
        source: 'operator',
        createdAt: '2026-10-01T00:01:00.000Z',
        ticked: { at: '2026-10-01T01:00:00.000Z' }
      }
    ]
    expect(parseMissionFile(buildMissionFileContent(mission))).toStrictEqual(mission)
  })

  it('refuses an unknown closedAs or check source', () => {
    const bad = { ...fullMission(), closedAs: 'abandoned' } as unknown as Mission
    expect(() => buildMissionFileContent(bad)).toThrow(/closedAs/)
    const m = fullMission()
    m.steps[2].checks = [{ id: 'chk-1', label: 'x', source: 'robot', createdAt: 'now' } as never]
    expect(() => buildMissionFileContent(m)).toThrow(/checks/)
  })

  it('(d) missionScope: the scope attachment, else the legacy fixed start links', () => {
    const legacy = fullMission()
    expect(missionScope(legacy)).toStrictEqual([
      { kind: 'card', ref: 'T361-mission-progress-spec' }
    ])
    const v3: Mission = {
      ...fullMission(),
      scope: [{ kind: 'worktree', ref: 'docs/specs/x/spec.md' }],
      steps: fullMission().steps.filter((s) => s.kind !== 'fixed-start')
    }
    expect(missionScope(v3)).toStrictEqual([{ kind: 'worktree', ref: 'docs/specs/x/spec.md' }])
    expect(missionScope({ ...v3, scope: undefined })).toStrictEqual([])
  })
})

describe('mission-core — id minting and exclusive create (design.md §9)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'mission-core-'))
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('mintMissionId avoids a collision', () => {
    const draws = ['0a1b2c3d', '0a1b2c3d', 'deadbeef']
    const id = mintMissionId(['mnt-0a1b2c3d'], () => draws.shift()!)
    expect(id).toBe('mnt-deadbeef')
    expect(draws).toEqual([]) // it retried past BOTH colliding draws
  })

  it('mintMissionId mints mnt-<8 hex> from real randomness by default', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintMissionId([])))
    for (const id of ids) expect(id).toMatch(MISSION_ID_RE)
    expect(ids.size).toBe(50)
  })

  it('mintMissionId fails loudly instead of looping forever when every draw collides', () => {
    expect(() => mintMissionId(['mnt-00000000'], () => '00000000')).toThrow(/could not mint/)
  })

  it('missionFilePath is <folder>/.harnu/missions/<id>-<slug>.md', () => {
    expect(missionFilePath('/repo', 'mnt-0a1b2c3d', 'ship-it')).toBe(
      join('/repo', '.harnu', 'missions', 'mnt-0a1b2c3d-ship-it.md')
    )
  })

  it('missionFilePath refuses an id or slug that is not path-safe', () => {
    expect(() => missionFilePath('/repo', 'mnt-0a1b2c3d', '../escape')).toThrow(
      /invalid mission slug/
    )
    expect(() => missionFilePath('/repo', '../mnt', 'ok')).toThrow(/invalid mission id/)
  })

  it('missionFilePath write uses wx and fails loudly on EEXIST', async () => {
    const first = fullMission()
    const file = await createMissionFile(repo, first, '## Log\n')
    expect(file).toBe(missionFilePath(repo, first.id, first.slug))
    const before = await readFile(file, 'utf8')
    expect(parseMissionFile(before)).toStrictEqual(first)

    // Same id + same slug: the exclusive write itself refuses.
    const again = { ...fullMission(), status: 'closed' as const }
    await expect(createMissionFile(repo, again)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(file, 'utf8')).toBe(before) // never overwritten

    // Same id under a different slug is the same collision, not a new file.
    const renamed = { ...fullMission(), slug: 'another-title' }
    await expect(createMissionFile(repo, renamed)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readdir(join(repo, '.harnu', 'missions'))).toEqual([
      'mnt-0a1b2c3d-mission-progress-rollout.md'
    ])
  })

  it('two racing creates of one mission: exactly one lands, the other rejects EEXIST', async () => {
    const results = await Promise.allSettled([
      createMissionFile(repo, fullMission(), 'first\n'),
      createMissionFile(repo, fullMission(), 'second\n')
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'EEXIST' })
  })

  it('two concurrent creates with the same id and different slugs leave exactly one survivor', async () => {
    const trials = 200
    const failures: string[] = []
    for (let t = 0; t < trials; t++) {
      const root = join(repo, `trial-${t}`)
      const results = await Promise.allSettled([
        createMissionFile(root, { ...fullMission(), slug: 'first-title' }),
        createMissionFile(root, { ...fullMission(), slug: 'second-title' })
      ])
      const files = await readdir(join(root, '.harnu', 'missions'))
      const landed = results.filter((r) => r.status === 'fulfilled').length
      if (files.length !== 1 || landed !== 1) {
        failures.push(`trial ${t}: ${landed} fulfilled, files=[${files.join(', ')}]`)
      }
    }
    expect(failures).toEqual([])
  })

  it('createMissionFile refuses an invalid mission before touching disk', async () => {
    await expect(
      createMissionFile(repo, { ...fullMission(), steps: 'nope' } as never)
    ).rejects.toThrow(/invalid mission: steps/)
    await expect(readdir(join(repo, '.harnu', 'missions'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('mission-core — per-mission-id write lock (design.md §9, Review Focus #2)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'mission-lock-'))
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** A second mission, so two ids share one repo. */
  function missionB(): Mission {
    return { ...fullMission(), id: 'mnt-bbbbbbbb', slug: 'other-mission', openQuestions: [] }
  }

  /**
   * One owner-side write: read the file, yield (as a real handler awaiting I/O
   * would), then write back with one more open question. Two of these racing
   * unguarded both read the same original and the later write drops the other.
   */
  async function appendQuestion(file: string, question: string): Promise<void> {
    const raw = await readFile(file, 'utf8')
    const mission = parseMissionFile(raw) as Mission
    await sleep(20)
    mission.openQuestions.push(question)
    await writeFile(file, buildMissionFileContent(mission, readMissionLog(raw)), 'utf8')
  }

  async function questionsOf(file: string): Promise<string[]> {
    return (parseMissionFile(await readFile(file, 'utf8')) as Mission).openQuestions
  }

  it('control: two unguarded concurrent writers to one mission lose a write', async () => {
    const a = fullMission()
    const file = await createMissionFile(repo, a)
    await Promise.all([appendQuestion(file, 'writer-1'), appendQuestion(file, 'writer-2')])
    const qs = await questionsOf(file)
    expect(qs.filter((q) => q.startsWith('writer-'))).toHaveLength(1) // the race is real
  })

  it('withMissionIdMintLock serializes two concurrent writers on the same mission id, but not on two different ids', async () => {
    const a = fullMission()
    const b = missionB()
    const fileA = await createMissionFile(repo, a)
    const fileB = await createMissionFile(repo, b)

    let releaseA!: () => void
    const aGate = new Promise<void>((r) => (releaseA = r))
    const order: string[] = []

    // Writer A1 holds mission A's lock until the gate opens.
    const a1 = withMissionIdMintLock(a.id, async () => {
      order.push('a1:start')
      await aGate
      await appendQuestion(fileA, 'writer-1')
      order.push('a1:end')
    })
    // Writer A2 targets the SAME mission: it must wait for A1.
    const a2 = withMissionIdMintLock(a.id, async () => {
      order.push('a2:start')
      await appendQuestion(fileA, 'writer-2')
      order.push('a2:end')
    })
    // Writer B targets a DIFFERENT mission: it must not wait for A1.
    const bDone = withMissionIdMintLock(b.id, async () => {
      await appendQuestion(fileB, 'writer-b')
      return 'b-done'
    })

    try {
      const winner = await Promise.race([bDone, sleep(2000).then(() => 'timed-out')])
      expect(winner).toBe('b-done') // B finished while A's lock was still held
      expect(order).toEqual(['a1:start']) // A2 has not started behind the held lock
      expect(await questionsOf(fileB)).toEqual(['writer-b'])
    } finally {
      releaseA() // even on failure, so a held lock never leaks into the next test
    }
    await Promise.all([a1, a2])
    expect(order).toEqual(['a1:start', 'a1:end', 'a2:start', 'a2:end'])
    const qs = await questionsOf(fileA)
    expect(qs).toEqual([...fullMission().openQuestions, 'writer-1', 'writer-2']) // neither lost
  })

  it('a rejected write surfaces its error but never poisons the next writer on that id', async () => {
    const id = 'mnt-cccccccc'
    const failed = withMissionIdMintLock(id, async () => {
      throw new Error('disk full')
    })
    const next = withMissionIdMintLock(id, async () => 'ran')
    await expect(failed).rejects.toThrow('disk full')
    await expect(next).resolves.toBe('ran')
  })

  it('names the step fields mission_update_step may never set', () => {
    expect(MISSION_STEP_CONTROLLED_FIELDS).toEqual(['proof', 'verifiedBy'])
  })
})

describe('requestCloseRefusal — what mission_request_close would refuse now (Mission v2 §3.5)', () => {
  /** An active mission, fixed end verified, nothing open — overridden per case. */
  function closable(
    over: Partial<Mission> = {},
    endProof: Mission['steps'][number]['proof'] = 'verified'
  ): Mission {
    // fullMission() carries a staged re-scope and a pending close — drop both.
    const { pendingRescope: _rescope, pendingClose: _close, ...base } = fullMission()
    return {
      ...base,
      status: 'active',
      blockers: [],
      steps: base.steps.map((s) => ({
        ...s,
        blockers: [],
        ...(s.kind === 'fixed-end' ? { proof: endProof } : {})
      })),
      ...over
    }
  }

  it('Mission v3 §3.4: never refuses for being a draft — there is no draft refusal any more', () => {
    expect(requestCloseRefusal(closable({ status: 'draft' }))).toBeNull()
  })

  it('refuses a closed mission', () => {
    expect(requestCloseRefusal(closable({ status: 'closed' }))?.code).toBe('MISSION_CLOSED')
  })

  it('refuses an end that is not verified — self-verified and claimed included', () => {
    for (const proof of ['unproven', 'claimed', 'self-verified'] as const) {
      const r = requestCloseRefusal(closable({}, proof))
      expect(r?.code, proof).toBe('END_NOT_VERIFIED')
      expect(r?.reason, proof).toContain(proof)
    }
  })

  it('refuses open blockers, mission-level or step-level', () => {
    const blocker = { reason: 'r', unblocks: 'u', owner: 'operator' as const, raisedAt: 't' }
    expect(requestCloseRefusal(closable({ blockers: [blocker] }))?.code).toBe('OPEN_BLOCKERS')
    const m = closable()
    m.steps[1].blockers = [blocker]
    expect(requestCloseRefusal(m)?.code).toBe('OPEN_BLOCKERS')
  })

  it('refuses a staged re-scope', () => {
    const pendingRescope = { kind: 'code' as const, target: 't', evidence: 'e' }
    expect(requestCloseRefusal(closable({ pendingRescope }))?.code).toBe('RESCOPE_PENDING')
  })

  it('allows a verified end with nothing open, active or already delivered', () => {
    expect(requestCloseRefusal(closable())).toBeNull()
    expect(requestCloseRefusal(closable({ status: 'delivered' }))).toBeNull()
  })
})
