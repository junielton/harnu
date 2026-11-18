import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALWAYS_LOAD_OPS, MCP_OPS, MCP_TOOLS, isAlwaysLoadOp } from '../src/main/mcp/tool-catalog'
import { parseToolInput } from '../src/main/mcp/validate'
import {
  walkExtend,
  walkGet,
  walkOpen,
  walkReport,
  type WalkVerbEnv
} from '../src/main/mcp/walk-handlers'
import { createWalkService, type WalkRuntime } from '../src/main/walk/walk-service'
import { createWalkProbe } from '../src/main/walk/walk-links'

const VERBS = ['walk_open', 'walk_extend', 'walk_report', 'walk_get'] as const

let root: string
let folder: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-verbs-')))
  folder = join(root, 'repo')
  mkdirSync(folder)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const check = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Check ${id}`,
  why: 'It is the feature.',
  where: { text: 'Notes page' },
  do: [{ text: 'Type `standup`.', see: 'Two rows stay.' }],
  passes: 'Two rows.',
  fails: 'More rows.',
  check: { how: 'count the rows' },
  ...over
})

const SOURCES: Record<string, Record<string, unknown>> = {
  feature: { kind: 'feature', text: 'A search box on the notes list.' },
  pr: { kind: 'pr', number: 101, title: 'Add a search box', author: 'a colleague' },
  branch: { kind: 'branch', branch: 'feature/search', base: 'main' },
  card: { kind: 'card', slug: 'search-box' },
  mission: { kind: 'mission', missionId: 'mnt-aaaaaaaa', scope: 'step', id: 'stp-1' }
}

const script = (
  source: Record<string, unknown> = SOURCES.feature,
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  title: 'Search box',
  purpose: 'check',
  source,
  checks: [check('c1'), check('c2', { check: undefined, nothingFromHere: 'Only eyes can tell.' })],
  ...over
})

const runtime: WalkRuntime = {
  deliver: async () => ({ status: 'held' }),
  openPane: async () => false // the pane type does not exist yet
}

const env = (): WalkVerbEnv => ({
  service: createWalkService(folder, { runtime: () => runtime }),
  probeFor: async () =>
    createWalkProbe({
      folder,
      knownFolders: [folder],
      cardSlugs: () => ['search-box'],
      mission: (id) =>
        id === 'mnt-aaaaaaaa'
          ? {
              milestones: ['mls-1'],
              steps: [{ id: 'stp-1', milestone: 'mls-1', criteria: ['ac-1'] }]
            }
          : null
    })
})

const open = async (
  e: WalkVerbEnv,
  source: Record<string, unknown> = SOURCES.feature
): Promise<{ walkId: string; runId: string }> => {
  const res = await walkOpen({ folder, sessionId: 'sess-1', script: script(source) }, e)
  if (!res.ok) throw new Error(JSON.stringify(res))
  return { walkId: res.walkId as string, runId: res.runId as string }
}

describe('walk verbs', () => {
  it('the four verbs load on turn one', () => {
    for (const name of VERBS) {
      const tool = MCP_TOOLS.find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.alwaysLoad, name).toBe(true)
      expect(isAlwaysLoadOp(name), name).toBe(true)
      expect((MCP_OPS as readonly string[]).includes(name), name).toBe(true)
      expect((ALWAYS_LOAD_OPS as readonly string[]).includes(name), name).toBe(true)
      // the three writes run free like open_file; the read is not a mutation
      expect(tool?.mutates, name).toBe(name !== 'walk_get')
      expect(Boolean(tool?.silentAllowInAgentFolder), name).toBe(name !== 'walk_get')
    }
    // and the doc a session reads first documents them, with the seven turn kinds
    const doc = readFileSync(join(__dirname, '..', 'docs', 'harnu-features.md'), 'utf8')
    for (const name of VERBS) expect(doc, name).toContain(name)
    for (const kind of [
      'done',
      'failed',
      'explain',
      'simpler',
      'treat-as-failed',
      'escalate',
      'closed'
    ])
      expect(doc, kind).toContain(`\`${kind}\``)
    expect(doc).toContain('[harnu-walk]')
    expect(doc).toContain('[harnu-walk-request]')
    // each verb parses its own catalog shape and refuses a malformed call
    expect(parseToolInput('walk_get', { folder: '/a/b', walkId: 'wlk-5d2e91ab' }).ok).toBe(true)
    expect(parseToolInput('walk_open', { folder: '/a/b' }).ok).toBe(false) // no script
    expect(parseToolInput('walk_get', { folder: 'relative' }).ok).toBe(false) // folder is absolute
  })

  it('opens a walk from any source, lists by source and grows the walk', async () => {
    const e = env()
    const opened: Record<string, { walkId: string; runId: string }> = {}
    // a new walk and its first run (`ready`, not live) from every source
    for (const [kind, source] of Object.entries(SOURCES)) {
      const res = await walkOpen({ folder, sessionId: 'sess-1', script: script(source) }, e)
      expect(res, kind).toMatchObject({
        ok: true,
        op: 'walk_open',
        checks: 2,
        toWalk: 2,
        rejected: [],
        opened: false // no pane type yet
      })
      opened[kind] = { walkId: res.walkId as string, runId: res.runId as string }
      const run = await e.service.store.readRun(opened[kind].walkId, opened[kind].runId)
      expect(run?.run.state, kind).toBe('ready')
      expect((await e.service.store.readWalk(opened[kind].walkId))?.live, kind).toBeNull()
    }
    // always a NEW walk, even for a source that already has one (a run that never started does not block)
    const again = await walkOpen({ folder, sessionId: 'sess-1', script: script(SOURCES.pr) }, e)
    expect(again.ok).toBe(true)
    expect(again.walkId).not.toBe(opened.pr.walkId)

    // a script that breaks rules is refused WHOLE, each violation with its JSON path and rule
    const bad = await walkOpen(
      {
        folder,
        script: script(SOURCES.feature, {
          checks: [check('c1', { why: undefined, passes: '' }), check('c1')]
        })
      },
      e
    )
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatchObject({ code: 'SCRIPT_REJECTED' })
    const paths = (bad.rejected as { path: string; rule: string }[]).map(
      (v) => `${v.path} ${v.rule}`
    )
    expect(paths).toEqual(
      expect.arrayContaining(['$.checks[0].why MISSING', '$.checks[1].id DUPLICATE_ID'])
    )
    expect((await e.service.store.listWalks()).length).toBe(6) // nothing of the refused script was written

    // refused WALK_RUN_LIVE only while a STARTED run of a walk with that source is live
    const pr = opened.pr
    expect((await e.service.operate({ ...pr, op: 'start' })).ok).toBe(true)
    const refused = await walkOpen({ folder, script: script(SOURCES.pr) }, e)
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'WALK_RUN_LIVE', walkId: pr.walkId, runId: pr.runId }
    })
    // a different source, and the same PR number with different words in the declaration, are judged by identity
    expect((await walkOpen({ folder, script: script(SOURCES.branch) }, e)).ok).toBe(true)
    expect(
      (await walkOpen({ folder, script: script({ ...SOURCES.pr, title: 'Another title' }) }, e)).ok
    ).toBe(false)
    // a feature compares after trimming
    expect(
      (
        await walkOpen(
          {
            folder,
            script: script({ kind: 'feature', text: '  A search box on the notes list.  ' })
          },
          e
        )
      ).ok
    ).toBe(true) // the feature walk is only `ready`, so it does not block
    // once the run ends the source can be opened again
    expect((await e.service.operate({ ...pr, op: 'end' })).ok).toBe(true)
    expect((await walkOpen({ folder, script: script(SOURCES.pr) }, e)).ok).toBe(true)

    // walk_get by source lists the existing walks of that source with their last runs
    const bySource = await walkGet({ folder, source: SOURCES.pr }, e)
    expect(bySource.ok).toBe(true)
    const prWalks = bySource.walks as { walkId: string; status: string; lastRun: unknown }[]
    expect(prWalks.length).toBe(3) // the first, its twin, and the one opened after the end
    const first = prWalks.find((w) => w.walkId === pr.walkId)
    expect(first).toMatchObject({ status: 'walked', lastRun: { n: 1 } })
    expect(prWalks.filter((w) => w.status === 'not-walked').length).toBe(2)
    expect(
      (await walkGet({ folder, source: { kind: 'pr', number: 999, title: 'x', author: 'y' } }, e))
        .walks as unknown[]
    ).toEqual([])
    // walk_get takes exactly one of walkId and source
    expect((await walkGet({ folder }, e)).ok).toBe(false)
    expect((await walkGet({ folder, walkId: pr.walkId, source: SOURCES.pr }, e)).ok).toBe(false)

    // ---- what Explain more adds is stored on the WALK, not on the run ----
    const feat = opened.feature
    const runBefore = readFileSync(
      join(e.service.store.walkDir(feat.walkId), 'runs', `${feat.runId}.json`),
      'utf8'
    )
    const w0 = (await walkGet({ folder, walkId: feat.walkId }, e)).walk as { rev: number }
    const grown = await walkExtend(
      {
        folder,
        walkId: feat.walkId,
        checkId: 'c1',
        more: 'It is the whole feature.',
        extra: [{ text: 'Narrow the window to 375 px.', see: 'Nothing is clipped.' }],
        simpler: {
          text: 'Type the word and look at the list.',
          do: [{ text: 'Type `standup`.', see: 'Two rows.' }]
        }
      },
      e
    )
    expect(grown).toMatchObject({ ok: true, op: 'walk_extend', rev: w0.rev + 1 })
    const walk = await e.service.store.readWalk(feat.walkId)
    expect(walk?.deepenings).toEqual([
      expect.objectContaining({ checkId: 'c1', more: 'It is the whole feature.', addedInRun: 1 })
    ])
    expect(walk?.deepenings?.[0].extra?.[0]).toMatchObject({
      id: 'e1',
      text: 'Narrow the window to 375 px.'
    })
    expect(walk?.simpler?.[0]).toMatchObject({ checkId: 'c1', addedInRun: 1 })
    expect(
      readFileSync(join(e.service.store.walkDir(feat.walkId), 'runs', `${feat.runId}.json`), 'utf8')
    ).toBe(runBefore) // the run file is byte-identical
    // a stale write is refused, a deleted walk is refused, a rule broken is named
    expect(
      await walkExtend(
        { folder, walkId: feat.walkId, checkId: 'c1', more: 'x', expectRev: w0.rev },
        e
      )
    ).toMatchObject({
      ok: false,
      error: { code: 'REV_CONFLICT' }
    })
    expect(
      await walkExtend({ folder, walkId: 'wlk-00000000', checkId: 'c1', more: 'x' }, e)
    ).toMatchObject({
      ok: false,
      error: { code: 'WALK_NOT_FOUND' }
    })
    expect(
      await walkExtend({ folder, walkId: feat.walkId, checkId: 'zz', more: 'x' }, e)
    ).toMatchObject({
      ok: false,
      error: { code: 'CHECK_NOT_FOUND' }
    })
    const tooLong = await walkExtend(
      { folder, walkId: feat.walkId, checkId: 'c1', more: 'x'.repeat(401) },
      e
    )
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'EXTENSION_REJECTED' } })
    expect((tooLong.rejected as { path: string }[])[0].path).toBe('$.more')
    // at most 18 sub-checks per check in all: the first answer added 1, so two sixes fit (13), a third does not
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `Step ${i}.`, see: 'Fine.' }))
    for (let i = 0; i < 2; i++)
      expect(
        (await walkExtend({ folder, walkId: feat.walkId, checkId: 'c1', extra: six }, e)).ok
      ).toBe(true)
    expect(
      await walkExtend({ folder, walkId: feat.walkId, checkId: 'c1', extra: six }, e)
    ).toMatchObject({
      ok: false,
      error: { code: 'TOO_MANY_EXTRA' }
    })
    expect(
      (await walkExtend({ folder, walkId: feat.walkId, checkId: 'c1', extra: six.slice(0, 5) }, e))
        .ok
    ).toBe(true) // 18
    expect(
      (await walkExtend({ folder, walkId: feat.walkId, checkId: 'c1', extra: [six[0]] }, e)).ok
    ).toBe(false)

    // append: checks found mid-walk go at the end, N grows, the walk only grows
    const appended = await walkExtend({ folder, walkId: feat.walkId, append: [check('c3')] }, e)
    expect(appended).toMatchObject({ ok: true, appended: ['c3'] })
    expect((await e.service.store.readWalk(feat.walkId))?.script.checks.map((c) => c.id)).toEqual([
      'c1',
      'c2',
      'c3'
    ])
    expect(
      (await e.service.store.readRun(feat.walkId, feat.runId))?.run.checks.map((c) => c.id)
    ).toEqual(['c1', 'c2', 'c3'])
    expect(
      await walkExtend({ folder, walkId: feat.walkId, append: [check('c3')] }, e)
    ).toMatchObject({
      ok: false,
      rejected: [expect.objectContaining({ path: '$.append[0].id', rule: 'DUPLICATE_ID' })]
    })

    // walk_get by id: enough for a session with no memory of the walk to carry on
    const got = (await walkGet({ folder, walkId: feat.walkId }, e)).walk as Record<string, unknown>
    expect(got).toMatchObject({
      walkId: feat.walkId,
      title: 'Search box',
      source: SOURCES.feature,
      run: { runId: feat.runId, n: 1, state: 'ready' },
      progress: { verified: 0, open: 3, total: 3 },
      outbox: { pending: 0 },
      deepened: ['c1']
    })
    expect((got.checks as { glyph: string }[]).map((c) => c.glyph)).toEqual(['-', '-', '-'])
  })

  it('copies the images into the walk and gives every edge item its id', async () => {
    const e = env()
    writeFileSync(join(folder, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const res = await walkOpen(
      {
        folder,
        script: script(SOURCES.feature, {
          checks: [
            check('c1', {
              images: [{ src: 'shot.png', alt: 'Search typed', kind: 'expected' }],
              edge: [
                { text: 'Narrow the window.', see: 'Nothing is clipped.' },
                { text: 'Type nothing.', see: 'All rows stay.' }
              ]
            })
          ]
        })
      },
      e
    )
    expect(res.ok).toBe(true)
    const walkDir = e.service.store.walkDir(res.walkId as string)
    expect(readdirSync(join(walkDir, 'images'))).toEqual(['c1-1-shot.png'])
    const stored = (await e.service.store.readWalk(res.walkId as string))!.script.checks[0]
    expect(stored.images?.[0].src).toBe('images/c1-1-shot.png')
    expect(stored.edge?.map((x) => x.id)).toEqual(['e1', 'e2'])
  })

  it('one correction per failure and no attempt limit', async () => {
    const e = env()
    const { walkId, runId } = await open(e)
    const svc = e.service
    expect((await svc.operate({ walkId, runId, op: 'start' })).ok).toBe(true)

    // Failed needs a line or an image
    expect(await svc.operate({ walkId, runId, op: 'fail' })).toMatchObject({
      ok: false,
      error: { code: 'FAILURE_NEEDS_LINE' }
    })
    expect(await svc.operate({ walkId, runId, op: 'fail', line: '   ' })).toMatchObject({
      ok: false,
      error: { code: 'FAILURE_NEEDS_LINE' }
    })
    // a screenshot must be one Harnu saved in this run's folder
    expect(await svc.operate({ walkId, runId, op: 'fail', shot: '/etc/passwd' })).toMatchObject({
      ok: false,
      error: { code: 'SHOT_OUTSIDE_RUN' }
    })
    // no correction without a failure
    expect(
      await walkReport(
        { folder, walkId, runId, checkId: 'c1', kind: 'correction', text: 'Try X.' },
        e
      )
    ).toMatchObject({ ok: false, error: { code: 'NO_FAILURE' } })

    const shots = svc.store.shotsDir(walkId, runId)
    mkdirSync(shots, { recursive: true })
    for (let attempt = 1; attempt <= 6; attempt++) {
      // a line one time, an image the next: either is enough
      const failure =
        attempt % 2 === 1
          ? await svc.operate({ walkId, runId, op: 'fail', line: `It shows ${attempt + 2} rows.` })
          : await svc.operate({ walkId, runId, op: 'fail', shot: join(shots, `${attempt}.png`) })
      expect(failure.ok, `failure ${attempt}`).toBe(true)

      // one correction per failure
      const first = await walkReport(
        {
          folder,
          walkId,
          runId,
          checkId: 'c1',
          kind: 'correction',
          text: `Correction ${attempt}.`
        },
        e
      )
      expect(first.ok, `correction ${attempt}`).toBe(true)
      // a second one before the operator answers again is refused
      expect(
        await walkReport(
          { folder, walkId, runId, checkId: 'c1', kind: 'correction', text: 'Another.' },
          e
        )
      ).toMatchObject({ ok: false, error: { code: 'CORRECTION_PENDING' } })

      // Try again re-serves the SAME check with its outcomes: no attempt limit
      const again = await svc.operate({ walkId, runId, op: 'try-again' })
      expect(again.ok).toBe(true)
      const got = (await walkGet({ folder, walkId }, e)).walk as {
        cursor: { checkId: string; phase: string; n: number }
        checks: { id: string; attempts: number }[]
      }
      expect(got.cursor).toMatchObject({ checkId: 'c1', phase: 'todo', n: 1 })
      expect(got.checks.find((c) => c.id === 'c1')?.attempts).toBe(attempt)
    }
    // the failures were delivered as turns to the session in order (held here: no session in this test)
    const kinds = (await svc.store.pendingOutbox(walkId, runId)).map((o) => o.kind)
    expect(kinds).toEqual(Array(6).fill('failed'))
  })

  it('no verb can perform, press, re-run, export or settle', () => {
    const forbidden = [
      'command',
      'cmd',
      'run',
      'exec',
      'press',
      'done',
      'skip',
      'back',
      'failed',
      'outcome',
      'rerun',
      'reRun',
      'export',
      'delete',
      'remove',
      'settle',
      'tick',
      'markDone'
    ]
    const inputs: Record<string, string[]> = {}
    for (const name of VERBS) {
      const tool = MCP_TOOLS.find((t) => t.name === name)!
      const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape
      inputs[name] = Object.keys(shape).sort()
      for (const key of inputs[name]) expect(forbidden, `${name}.${key}`).not.toContain(key)
    }
    // the catalog lists each verb's inputs: this is the whole surface
    expect(inputs).toEqual({
      walk_open: ['folder', 'script', 'sessionId'],
      walk_extend: [
        'append',
        'checkId',
        'expectRev',
        'extra',
        'folder',
        'more',
        'simpler',
        'walkId'
      ],
      walk_report: ['checkId', 'evidence', 'folder', 'kind', 'result', 'runId', 'text', 'walkId'],
      walk_get: ['folder', 'source', 'walkId']
    })
    // a result of a report is only `pass` or `fail`: the operator's outcomes cannot be sent as one
    const report = MCP_TOOLS.find((t) => t.name === 'walk_report')!
    expect(
      report.inputSchema.safeParse({ folder: '/a', walkId: 'w', checkId: 'c', result: 'done' })
        .success
    ).toBe(false)
    expect(
      report.inputSchema.safeParse({ folder: '/a', walkId: 'w', checkId: 'c', kind: 'skip' })
        .success
    ).toBe(false)

    // none reaches the operator's settle door, or a function that presses an outcome
    const files = [
      join(__dirname, '..', 'src', 'main', 'mcp', 'walk-handlers.ts'),
      ...readdirSync(join(__dirname, '..', 'src', 'main', 'walk')).map((f) =>
        join(__dirname, '..', 'src', 'main', 'walk', f)
      )
    ]
    const code = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    for (const file of files) {
      const text = code(file)
      expect(text, file).not.toMatch(/markCriterion|missions\/doors|mission_settle_ac/)
    }
    // the verbs' own module does not even import the operator side of the service
    const handlers = code(files[0])
    expect(handlers).not.toMatch(/\.operate\(|\.replay\(|newRun\(/)
  })
})
