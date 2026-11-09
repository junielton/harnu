/**
 * T676 S-2 — the bake-off runner: `scripts/eval/bakeoff/{claude,usage,contestants,contestant-run}.mjs`
 * against the fake `claude` in `tests/fixtures/eval-bakeoff/fake-claude.mjs`. No model is ever
 * called and nothing reaches the network: every git source is a throwaway local repository.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FAKE = resolve(__dirname, 'fixtures/eval-bakeoff/fake-claude.mjs')
const S2 = resolve(__dirname, 'fixtures/eval-bakeoff/s2')
const CONTESTANT_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,Task'
const SUPERPOWERS_PIN = 'bb92a77741419a4ab5f06e711a283343f1ada0c3'
const SLOW_TEST_MS = 120_000

const NUDGE =
  'Your last reply had neither a line starting `QUESTION TO OPERATOR:` nor a line starting ' +
  '`ARTIFACT DONE:`. If you need the operator, end your reply with a line starting ' +
  '`QUESTION TO OPERATOR:`. If the artifact is finished, end your reply with a line ' +
  '`ARTIFACT DONE: <paths>`.'
const OPERATOR_GONE =
  'The operator is unavailable. Answer from your best judgement, finish the artifact and reply ' +
  'ARTIFACT DONE: <paths>.'

/** Parsed JSON: the shapes under test are asserted field by field below. */
type Json = ReturnType<typeof JSON.parse>

/** One scripted invocation of the fake `claude`. */
interface Entry {
  reply?: string
  writes?: { path: string; content: string }[]
  noResult?: boolean
  hangMs?: number
  messageId?: string
}

interface Invocation {
  cwd: string
  argv: string[]
}

let tmp: string
let projects: string
let log: string
let promptLog: string
let scenarioPath: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bakeoff-s2-')))
  projects = join(tmp, 'projects')
  log = join(tmp, 'invocations.jsonl')
  promptLog = join(tmp, 'prompts.jsonl')
  scenarioPath = join(tmp, 'scenario.json')
  vi.stubEnv('HARNU_BAKEOFF_CLAUDE_BIN', FAKE)
  vi.stubEnv('HARNU_BAKEOFF_CLAUDE_PROJECTS', projects)
  vi.stubEnv('FAKE_CLAUDE_SCENARIO', scenarioPath)
  vi.stubEnv('FAKE_CLAUDE_LOG', log)
  vi.stubEnv('FAKE_CLAUDE_PROMPT_LOG', promptLog)
  vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '')
  vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(tmp, { recursive: true, force: true })
})

/** Git with the hook-injected variables removed, so a pre-push run stays in its repo. */
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** A throwaway repository holding `files`; returns its path and HEAD. */
function repoWith(name: string, files: Record<string, string>): { dir: string; head: string } {
  const dir = join(tmp, name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'files')
  return { dir, head: git(dir, 'rev-parse', 'HEAD') }
}

/** Starts a fresh scenario: new array, cursor at zero, empty logs. */
function setScenario(entries: Entry[]): void {
  writeFileSync(scenarioPath, JSON.stringify(entries))
  rmSync(join(projects, '.fake-claude-cursor'), { force: true })
  rmSync(log, { force: true })
  rmSync(promptLog, { force: true })
}

const jsonl = (path: string): Json[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const invocations = (): Invocation[] => jsonl(log)
const prompts = (): string[] => jsonl(promptLog).map((p) => p.prompt)

/** The value after `flag` in `argv`. */
const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/** `problem` with an inline target and a `setup` that a contestant clone must never run. */
const problem = {
  id: 'demo',
  dir: join(S2, 'problem'),
  target: { inline: 'source' },
  setup: ['touch setup-marker'],
  test: 'true'
}

/** A repository standing in for this one: the `harnu-spec` tool's source. */
function fakeRepo(): string {
  return repoWith('repo', {
    'resources/skills/skills/spec/SKILL.md': '---\nname: spec\n---\nThe method.\n',
    'resources/skills/skills/spec/scripts/check.mjs': 'export {}\n',
    'docs/specs/TEMPLATE.md': 'The template.\n'
  }).dir
}

async function contestantNamed(id: string): Promise<Json> {
  const { contestants } = await import('../scripts/eval/bakeoff/contestants.mjs')
  return contestants.find((c: { id: string }) => c.id === id)
}

/** Everything `runContestant` needs for one `harnu-spec` (or the named) run. */
async function runArgs(unit: string, id = 'harnu-spec'): Promise<Json> {
  const repo = existsSync(join(tmp, 'repo')) ? join(tmp, 'repo') : fakeRepo()
  return {
    problem,
    contestant: await contestantNamed(id),
    repeat: 1,
    unitDir: join(tmp, 'units', unit),
    roots: { repo, cache: join(tmp, 'cache') },
    skillRef: 'HEAD',
    answerSheetPath: join(problem.dir, 'answer-sheet.md'),
    model: 'full-opus',
    operatorModel: 'full-sonnet'
  }
}

async function run(unit: string, entries: Entry[], id?: string): Promise<Json> {
  const { runContestant } = await import('../scripts/eval/bakeoff/contestant-run.mjs')
  setScenario(entries)
  return runContestant(await runArgs(unit, id))
}

/** Waits until the fake has recorded `n` invocations. */
async function untilInvoked(n: number): Promise<void> {
  await vi.waitFor(() => expect(invocations().length).toBeGreaterThanOrEqual(n), {
    timeout: 20_000,
    interval: 25
  })
}

/** A `claude` that runs `before` in its cwd, then the fake, then `after`. */
function wrappedFake(before: string, after: string): void {
  const wrapper = join(tmp, 'wrapped-claude')
  writeFileSync(wrapper, `#!/bin/sh\n${before}\n'${FAKE}' "$@"\nrc=$?\n${after}\nexit $rc\n`, {
    mode: 0o755
  })
  vi.stubEnv('HARNU_BAKEOFF_CLAUDE_BIN', wrapper)
}

const operatorReply = (entries: string, answer: string): string =>
  `ENTRIES: ${entries}\nANSWER: ${answer}`

it(
  'the simulated operator answers by resuming the contestant session',
  async () => {
    const multiLine = 'Which flag name?\nIt is the second line.\n\nAnd a third paragraph.'
    const result = await run('harnu', [
      { reply: `Reading the code.\nQUESTION TO OPERATOR: ${multiLine}` },
      { reply: operatorReply('A-1, G-2', 'Use --json.\nKeep the rest.') },
      { reply: 'QUESTION TO OPERATOR: Anything else?' },
      { reply: operatorReply('none', 'the sheet does not say; keep the behaviour') },
      {
        reply: 'All set.\nARTIFACT DONE: docs/feature/spec.md',
        writes: [
          { path: 'docs/feature/spec.md', content: 'line one\nline two has words\n' },
          { path: 'notes.txt', content: 'changed\n' }
        ]
      }
    ])

    const unit = join(tmp, 'units', 'harnu')
    const clone = join(unit, 'clone')
    const calls = invocations()
    expect(calls.map((c) => c.cwd)).toEqual([
      clone,
      join(unit, 'operator'),
      clone,
      join(unit, 'operator'),
      clone
    ])

    const [first, op1, resume1, op2, resume2] = calls.map((c) => c.argv)
    expect(first[0]).toBe('-p')
    expect(flag(first, '--model')).toBe('full-opus')
    expect(flag(first, '--max-turns')).toBe('200')
    expect(flag(first, '--tools')).toBe(CONTESTANT_TOOLS)
    expect(flag(first, '--allowedTools')).toBe(CONTESTANT_TOOLS)
    expect(flag(first, '--output-format')).toBe('stream-json')
    expect(first).toContain('--verbose')
    expect(flag(first, '--setting-sources')).toBe('project')
    expect(flag(first, '--add-dir')).toBe(join(unit, 'tool'))
    expect(first).not.toContain('--no-session-persistence')
    expect(flag(first, '--session-id')).toBe(result.sessionId)
    expect(first).not.toContain('--resume')

    // The operator: its own session, no tools, the same one for every question.
    expect(flag(op1, '--model')).toBe('full-sonnet')
    expect(flag(op1, '--max-turns')).toBe('2')
    expect(flag(op1, '--tools')).toBe('')
    expect(op1).not.toContain('--allowedTools')
    expect(op1).not.toContain('--add-dir')
    expect(flag(op1, '--session-id')).toBe(result.operatorSessionId)
    expect(flag(op2, '--resume')).toBe(result.operatorSessionId)
    expect(op2).not.toContain('--session-id')
    expect(result.operatorSessionId).not.toBe(result.sessionId)

    // Every answer goes back by resuming the contestant.
    for (const argv of [resume1, resume2]) {
      expect(flag(argv, '--resume')).toBe(result.sessionId)
      expect(argv).not.toContain('--session-id')
      expect(flag(argv, '--add-dir')).toBe(join(unit, 'tool'))
    }

    const sent = prompts()
    expect(sent[1]).toContain(multiLine)
    expect(sent[1]).toContain(readFileSync(join(problem.dir, 'answer-sheet.md'), 'utf8').trim())
    expect(sent[1]).not.toContain('{{')
    expect(sent[1].startsWith('You are the operator who asked for this change.')).toBe(true)
    expect(sent[2]).toBe('Use --json.\nKeep the rest.')
    expect(sent[3]).toBe('Anything else?')
    expect(sent[4]).toBe('the sheet does not say; keep the behaviour')

    expect(readFileSync(join(unit, 'operator-log.md'), 'utf8')).toBe(
      '## Exchange 1\n\nQuestion:\n' +
        multiLine +
        '\n\nEntries: A-1, G-2\n\nAnswer:\nUse --json.\nKeep the rest.\n' +
        '\n## Exchange 2\n\nQuestion:\nAnything else?\n\nEntries: none\n\n' +
        'Answer:\nthe sheet does not say; keep the behaviour\n'
    )
    expect(readdirSync(join(unit, 'operator'))).toEqual(['answer-sheet.md'])

    expect(existsSync(join(clone, 'setup-marker'))).toBe(false)
    expect(result.status).toBe('done')
    expect(result.contestantTurns).toBe(3)
    expect(result.operatorTurns).toBe(2)
    expect(result.strayReplies).toBe(0)
    expect(result.artifact).toEqual(['docs/feature/spec.md', 'notes.txt'])
    expect(readFileSync(join(unit, 'artifact/docs/feature/spec.md'), 'utf8')).toContain('line one')
    expect(readFileSync(join(unit, 'artifact/notes.txt'), 'utf8')).toBe('changed\n')
    expect(existsSync(join(unit, 'artifact/obsolete.txt'))).toBe(false)
    expect(result.specLines).toBe(2)
    expect(result.specWords).toBe(6)
    expect(result.wallMs).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(join(unit, 'contestant.json'), 'utf8'))).toEqual(result)
    // One stream per invocation, contestant and operator turns alike.
    for (let n = 1; n <= 5; n++) expect(existsSync(join(unit, `stream-${n}.jsonl`))).toBe(true)

    // `superpowers`: the spec file is the plan, whatever else the run wrote. Its fetched tool
    // is already in the cache, so no network is touched. The session commits its plan and
    // deletes a tracked file: the artifact is measured against the pinned commit.
    const cached = join(tmp, 'cache/tools', `superpowers@${SUPERPOWERS_PIN}`, 'brainstorming')
    mkdirSync(cached, { recursive: true })
    writeFileSync(join(cached, 'SKILL.md'), 'Brainstorm.\n')
    wrappedFake(
      '',
      'rm -f obsolete.txt; git add docs; git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -qm plan >/dev/null 2>&1; true'
    )
    const sp = await run(
      'superpowers',
      [
        {
          reply: 'ARTIFACT DONE: docs/superpowers/plans/plan.md',
          writes: [
            { path: 'docs/notes/spec.md', content: 'not the plan, four words\n' },
            { path: 'docs/superpowers/plans/plan.md', content: 'one\ntwo\nthree words here\n' }
          ]
        }
      ],
      'superpowers'
    )
    expect(sp.status).toBe('done')
    expect(sp.artifact).toEqual(['docs/notes/spec.md', 'docs/superpowers/plans/plan.md'])
    expect(sp.specLines).toBe(3)
    expect(sp.specWords).toBe(5)
  },
  SLOW_TEST_MS
)

it(
  'a contestant that never stops asking ends incomplete',
  async () => {
    // The first prompt: every placeholder filled, nothing left, no absolute path named.
    const exchanges: Entry[] = []
    for (let k = 1; k <= 12; k++) {
      exchanges.push({ reply: `QUESTION TO OPERATOR: Question ${k}?` })
      exchanges.push({ reply: operatorReply('none', `Answer ${k}.`) })
    }
    exchanges.push({ reply: 'QUESTION TO OPERATOR: Question 13?' })
    exchanges.push({ reply: 'QUESTION TO OPERATOR: Question 14?' })

    // Operator exchanges: 12 answered, the 13th gets the fixed text, the 14th ends the run.
    const asking = await run('asking', exchanges)
    expect(invocations()).toHaveLength(26)
    const sent = prompts()
    expect(sent[0]).toContain('../tool')
    expect(sent[0]).toContain('spec/SKILL.md')
    expect(sent[0]).toContain('Approve this spec?')
    expect(sent[0]).toContain('Add a --json flag to the export command.')
    expect(sent[0]).not.toContain('{{')
    expect(sent[0]).not.toContain(tmp)
    expect(sent[0]).not.toContain(NUDGE)
    expect(sent[24]).toBe('Answer 12.')
    expect(sent[25]).toBe(OPERATOR_GONE)
    expect(asking.status).toBe('incomplete')
    expect(asking.operatorTurns).toBe(12)
    expect(asking.contestantTurns).toBe(14)
    const asked = readFileSync(join(tmp, 'units/asking/operator-log.md'), 'utf8')
    expect(asked.match(/^## Exchange /gm)).toHaveLength(12)

    // Stray replies: the first two are nudged, the third ends the run.
    const stray = await run('stray', [
      { reply: 'Still thinking.' },
      { reply: 'Hmm.' },
      { reply: 'Nearly.' }
    ])
    expect(invocations()).toHaveLength(3)
    expect(prompts().slice(1)).toEqual([NUDGE, NUDGE])
    expect(stray.status).toBe('incomplete')
    expect(stray.strayReplies).toBe(3)

    // Retries: an operator turn with no `result` restarts the run from scratch.
    const retried = await run('retried', [
      {
        reply: 'QUESTION TO OPERATOR: First attempt?',
        writes: [{ path: 'first-attempt.md', content: 'discard me\n' }]
      },
      { noResult: true },
      { reply: 'ARTIFACT DONE: spec.md', writes: [{ path: 'spec.md', content: 'kept\n' }] }
    ])
    const retriedUnit = join(tmp, 'units/retried')
    expect(retried.status).toBe('done')
    expect(retried.artifact).toEqual(['spec.md'])
    expect(retried.operatorTurns).toBe(0)
    expect(retried.usage.contestant.total).toBe(110)
    expect(existsSync(join(retriedUnit, 'clone/first-attempt.md'))).toBe(false)
    expect(existsSync(join(retriedUnit, 'operator-log.md'))).toBe(false)
    const retriedCalls = invocations()
    const firstSession = flag(retriedCalls[0].argv, '--session-id')
    expect(flag(retriedCalls[2].argv, '--session-id')).toBe(retried.sessionId)
    expect(retried.sessionId).not.toBe(firstSession)
    expect(prompts()[2]).toBe(prompts()[0])
    // The discarded attempt keeps its evidence aside and its usage in the unit's own file.
    expect(existsSync(join(retriedUnit, `discarded/1/contestant/${firstSession}.jsonl`))).toBe(true)
    expect(existsSync(join(retriedUnit, 'discarded/1/stream-1.jsonl'))).toBe(true)
    expect(existsSync(join(retriedUnit, 'discarded/1/stream-2.jsonl'))).toBe(true)
    const discarded = JSON.parse(
      readFileSync(join(retriedUnit, 'contestant/discarded.json'), 'utf8')
    )
    expect(discarded).toHaveLength(1)
    expect(discarded[0]).toMatchObject({
      unit: 'demo/harnu-spec/r1/contestant',
      phase: 'contestant',
      contestant: 'harnu-spec'
    })
    expect(discarded[0].usage.total).toBe(220)

    // Invocation deadline: a hung turn is killed and retried; a second bad turn fails the run.
    vi.stubEnv('HARNU_BAKEOFF_TIMEOUT_SCALE', '0.002')
    const hung = await run('hung', [{ hangMs: 60_000, reply: 'never' }, { noResult: true }])
    expect(invocations()).toHaveLength(2)
    expect(hung.status).toBe('failed')
    expect(JSON.parse(readFileSync(join(tmp, 'units/hung/contestant.json'), 'utf8')).status).toBe(
      'failed'
    )

    // Run deadline: the total ends the run incomplete, and the kill is not retried.
    const slowTurn: Entry = { hangMs: 5_000, reply: 'QUESTION TO OPERATOR: Slowly?' }
    const answer: Entry = { reply: operatorReply('none', 'Fine.') }
    const slow = await run('slow', [
      slowTurn,
      answer,
      slowTurn,
      answer,
      slowTurn,
      answer,
      slowTurn,
      { reply: 'ARTIFACT DONE: nothing.md' }
    ])
    expect(slow.status).toBe('incomplete')
    expect(invocations()).toHaveLength(7)
  },
  SLOW_TEST_MS
)

it(
  'usage is summed from transcripts and deduplicated by message id',
  async () => {
    const { moveTranscripts } = await import('../scripts/eval/bakeoff/claude.mjs')
    const { sumUsage, countSubAgents } = await import('../scripts/eval/bakeoff/usage.mjs')

    // Hand-computed from the fixture: msg_1 counted once, across the session and its sub-agent.
    const project = join(projects, '-some-cwd')
    mkdirSync(project, { recursive: true })
    cpSync(join(S2, 'transcripts'), project, { recursive: true })
    const dest = join(tmp, 'moved/transcripts/contestant')
    expect(moveTranscripts(['session-a', 'no-such-session'], dest)).toEqual({
      moved: ['session-a']
    })
    expect(existsSync(join(dest, 'session-a.jsonl'))).toBe(true)
    expect(existsSync(join(dest, 'session-a/subagents/agent-1.jsonl'))).toBe(true)
    expect(existsSync(project)).toBe(false)
    expect(sumUsage(dest)).toEqual({
      input: 1310,
      cacheWrite: 240,
      cacheRead: 8000,
      output: 117,
      total: 9667
    })
    expect(sumUsage(join(tmp, 'nothing-here'))).toEqual({
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      total: 0
    })

    // A project directory that holds something else stays.
    const shared = join(projects, '-shared-cwd')
    mkdirSync(shared, { recursive: true })
    cpSync(join(S2, 'transcripts/session-a.jsonl'), join(shared, 'session-a.jsonl'))
    writeFileSync(join(shared, 'other-session.jsonl'), '')
    moveTranscripts(['session-a'], join(tmp, 'moved-2'))
    expect(readdirSync(shared)).toEqual(['other-session.jsonl'])
    rmSync(shared, { recursive: true })

    // Sub-agents are the Task and Agent tool_use blocks, over every stream.
    expect(
      countSubAgents([join(S2, 'streams/stream-1.jsonl'), join(S2, 'streams/stream-2.jsonl')])
    ).toBe(3)

    // A whole run: a repeated message id counts once, and nothing is left behind.
    wrappedFake(
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task"}]}}'`,
      ''
    )
    const result = await run('usage', [
      { reply: 'QUESTION TO OPERATOR: One?', messageId: 'same' },
      { reply: operatorReply('none', 'Yes.') },
      {
        reply: 'ARTIFACT DONE: a.md',
        messageId: 'same',
        writes: [{ path: 'a.md', content: 'a\n' }]
      }
    ])
    const unit = join(tmp, 'units/usage')
    const fixed = { input: 100, cacheWrite: 0, cacheRead: 0, output: 10, total: 110 }
    expect(result.usage).toEqual({ contestant: fixed, operator: fixed })
    expect(result.subAgents).toBe(3)
    expect(existsSync(join(unit, `transcripts/contestant/${result.sessionId}.jsonl`))).toBe(true)
    expect(existsSync(join(unit, `transcripts/operator/${result.operatorSessionId}.jsonl`))).toBe(
      true
    )
    expect(readdirSync(projects)).toEqual(['.fake-claude-cursor'])
  },
  SLOW_TEST_MS
)

it(
  'contestants resolve their pinned tool directories',
  async () => {
    const { contestants, selectContestants, resolveTool } =
      await import('../scripts/eval/bakeoff/contestants.mjs')
    const byId = (id: string): Json => contestants.find((c: { id: string }) => c.id === id)
    const ids = (list: { id: string }[]): string[] => list.map((c) => c.id)
    expect(ids(selectContestants({ withTlc: false }))).toEqual(['harnu-spec', 'superpowers'])
    expect(ids(selectContestants({ withTlc: true }))).toEqual([
      'harnu-spec',
      'superpowers',
      'tlc-spec-driven'
    ])
    for (const c of contestants) {
      expect(c).toEqual(
        expect.objectContaining({
          source: expect.any(Object),
          entry: expect.any(String),
          stopPoint: expect.any(String),
          tells: expect.any(Array),
          specFile: expect.any(String)
        })
      )
    }
    expect(byId('superpowers').source.commit).toBe(SUPERPOWERS_PIN)
    expect(byId('superpowers').specFile).toBe('docs/superpowers/plans/*.md')

    const cacheRoot = join(tmp, 'cache')
    const opts = (dest: string, sources: Record<string, string> = {}): object => ({
      skillRef: 'HEAD',
      repo: '/nonexistent',
      cacheRoot,
      dest: join(tmp, dest),
      sources
    })

    // harnu-spec: the skill directory plus TEMPLATE.md, at --skill-ref of the repo.
    const repo = fakeRepo()
    const repoHead = git(repo, 'rev-parse', 'HEAD')
    expect(
      await resolveTool(byId('harnu-spec'), opts('harnu-tool', { 'harnu-spec': repo }))
    ).toEqual({ sha: repoHead })
    expect(readFileSync(join(tmp, 'harnu-tool/spec/SKILL.md'), 'utf8')).toContain('The method.')
    expect(existsSync(join(tmp, 'harnu-tool/spec/scripts/check.mjs'))).toBe(true)
    expect(readFileSync(join(tmp, 'harnu-tool/spec/TEMPLATE.md'), 'utf8')).toBe('The template.\n')

    // superpowers: `skills/` of the source, its HEAD standing in for the pin.
    const sp = repoWith('sp-source', {
      'README.md': 'not a skill\n',
      'skills/brainstorming/SKILL.md': 'Brainstorm.\n',
      'skills/writing-plans/SKILL.md': 'Plan.\n'
    })
    const spSources = { superpowers: sp.dir }
    expect(await resolveTool(byId('superpowers'), opts('sp-tool', spSources))).toEqual({
      sha: sp.head
    })
    expect(existsSync(join(tmp, 'sp-tool/brainstorming/SKILL.md'))).toBe(true)
    expect(existsSync(join(tmp, 'sp-tool/README.md'))).toBe(false)

    // The fetched tool is cached by id and sha, so a pinned tool already there needs no fetch.
    expect(existsSync(join(cacheRoot, 'tools', `superpowers@${sp.head}`))).toBe(true)
    const pinned = join(cacheRoot, 'tools', `superpowers@${SUPERPOWERS_PIN}`, 'brainstorming')
    mkdirSync(pinned, { recursive: true })
    writeFileSync(join(pinned, 'SKILL.md'), 'From the cache.\n')
    expect(await resolveTool(byId('superpowers'), opts('sp-tool-2'))).toEqual({
      sha: SUPERPOWERS_PIN
    })
    expect(readFileSync(join(tmp, 'sp-tool-2/brainstorming/SKILL.md'), 'utf8')).toBe(
      'From the cache.\n'
    )

    // A source that cannot be read fails with the coded error.
    rmSync(sp.dir, { recursive: true })
    expect(await resolveTool(byId('superpowers'), opts('sp-tool-3', spSources))).toEqual({
      code: 'TOOL_FETCH_FAILED',
      message: expect.any(String)
    })

    // tlc-spec-driven: exactly one directory whose frontmatter names it.
    const skill = (name: string): string => `---\nname: ${name}\n---\nBody.\n`
    const one = repoWith('tlc-one', {
      'skills/a/other/SKILL.md': skill('another-skill'),
      'skills/b/tlc/SKILL.md': skill('tlc-spec-driven'),
      'skills/b/tlc/phases.md': 'Phases.\n'
    })
    expect(
      await resolveTool(byId('tlc-spec-driven'), opts('tlc-tool', { 'tlc-spec-driven': one.dir }))
    ).toEqual({ sha: one.head })
    expect(readFileSync(join(tmp, 'tlc-tool/SKILL.md'), 'utf8')).toContain('tlc-spec-driven')
    expect(existsSync(join(tmp, 'tlc-tool/phases.md'))).toBe(true)

    const none = repoWith('tlc-none', { 'skills/a/SKILL.md': skill('another-skill') })
    const two = repoWith('tlc-two', {
      'skills/a/SKILL.md': skill('tlc-spec-driven'),
      'skills/b/SKILL.md': skill('tlc-spec-driven')
    })
    for (const [dest, source] of [
      ['tlc-none-tool', none.dir],
      ['tlc-two-tool', two.dir]
    ]) {
      expect(
        await resolveTool(byId('tlc-spec-driven'), opts(dest, { 'tlc-spec-driven': source }))
      ).toEqual({ code: 'TOOL_FETCH_FAILED', message: expect.any(String) })
    }
  },
  SLOW_TEST_MS
)

it(
  'a prompt over 200 KiB travels over stdin',
  async () => {
    const { runClaude } = await import('../scripts/eval/bakeoff/claude.mjs')
    const marker = 'BIG-PROMPT-MARKER'
    const big = `${marker}\n${'x'.repeat(210 * 1024)}\nthe end`
    setScenario([{ reply: 'one' }, { reply: 'two' }])
    const cwd = join(tmp, 'cwd')
    mkdirSync(cwd)
    const common = {
      role: 'contestant',
      prompt: big,
      cwd,
      model: 'm',
      tools: [],
      addDirs: [],
      deadlineMs: 30_000,
      maxTurns: 1
    }
    const first = await runClaude({
      ...common,
      sessionId: 'session-1',
      streamPath: join(tmp, 'stream-1.jsonl')
    })
    expect(first).toMatchObject({ status: 'result', resultText: 'one', sessionId: 'session-1' })
    const second = await runClaude({
      ...common,
      resume: 'session-1',
      streamPath: join(tmp, 'stream-2.jsonl')
    })
    expect(second).toMatchObject({
      status: 'result',
      resultText: 'two',
      killed: false,
      exitCode: 0
    })
    expect(prompts()).toEqual([big, big])
    for (const { argv } of invocations()) {
      expect(argv.join(' ')).not.toContain(marker)
    }
  },
  SLOW_TEST_MS
)

it(
  'resolveModel probes each distinct alias once',
  async () => {
    const { resolveModel } = await import('../scripts/eval/bakeoff/claude.mjs')
    setScenario([{ reply: 'ok' }, { reply: 'ok' }])
    const resolved = await resolveModel(['opus', 'opus', 'sonnet', 'claude-full-id-1'])
    expect(resolved.ids).toEqual({
      opus: 'fake-opus',
      sonnet: 'fake-sonnet',
      'claude-full-id-1': 'claude-full-id-1'
    })
    const fixed = { input: 100, cacheWrite: 0, cacheRead: 0, output: 10, total: 110 }
    expect(resolved.probes).toEqual([fixed, fixed])

    const calls = invocations()
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => flag(c.argv, '--model'))).toEqual(['opus', 'sonnet'])
    for (const { argv } of calls) {
      expect(argv[0]).toBe('-p')
      expect(flag(argv, '--max-turns')).toBe('1')
      expect(flag(argv, '--output-format')).toBe('stream-json')
      expect(argv).toContain('--verbose')
    }
    expect(prompts()).toEqual(['ok', 'ok'])
    expect(readdirSync(projects)).toEqual(['.fake-claude-cursor'])

    setScenario([{ noResult: true }])
    expect(await resolveModel(['haiku'])).toEqual({
      code: 'MODEL_UNRESOLVED',
      message: expect.any(String)
    })
  },
  SLOW_TEST_MS
)

it(
  'the fake claude replays its scenario, records each invocation and honours its delay',
  async () => {
    const source = readFileSync(FAKE, 'utf8')
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node')
    accessSync(FAKE, constants.X_OK)

    const cwd = join(tmp, 'a cwd')
    mkdirSync(cwd)
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const invoke = (
      args: string[],
      input = 'prompt'
    ): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((done) => {
        const child = spawn(FAKE, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (err += d))
        child.on('close', (code) => done({ code, out, err }))
        child.stdin.end(input)
      })
    const events = (out: string): Json[] =>
      out
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))

    setScenario([
      { reply: 'hello', writes: [{ path: 'sub/dir/file.txt', content: 'written' }] },
      { reply: 'again', messageId: 'fixed-id' },
      { noResult: true, reply: 'never shown' },
      { reply: 'late', hangMs: 150 }
    ])

    const one = await invoke(['-p', '--model', 'opus', '--session-id', 'sess-1'], 'first prompt')
    expect(one.code).toBe(0)
    const [init, assistant, result] = events(one.out)
    expect(init).toMatchObject({ type: 'system', subtype: 'init', model: 'fake-opus' })
    expect(assistant.type).toBe('assistant')
    expect(result).toMatchObject({ type: 'result', result: 'hello' })
    expect(readFileSync(join(cwd, 'sub/dir/file.txt'), 'utf8')).toBe('written')
    const transcript = join(projects, slug, 'sess-1.jsonl')
    const [line] = jsonl(transcript)
    expect(line.message.usage).toEqual({
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 10
    })
    expect(line.message.id).toBeTruthy()

    // A resume appends to the same transcript, and honours messageId.
    const two = await invoke(['-p', '--model', 'sonnet', '--resume', 'sess-1'])
    expect(two.code).toBe(0)
    expect(events(two.out)[0].model).toBe('fake-sonnet')
    const lines = jsonl(transcript)
    expect(lines).toHaveLength(2)
    expect(lines[1].message.id).toBe('fixed-id')
    expect(lines[0].message.id).not.toBe('fixed-id')

    // noResult: no `result` event, no model, exit 0.
    const three = await invoke(['-p', '--model', 'opus', '--session-id', 'sess-3'])
    expect(three.code).toBe(0)
    const threeEvents = events(three.out)
    expect(threeEvents.some((e) => e.type === 'result')).toBe(false)
    expect(threeEvents[0].model).toBeUndefined()

    // hangMs and FAKE_CLAUDE_DELAY_MS both hold the first output back.
    vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '150')
    const before = Date.now()
    const four = await invoke(['-p', '--model', 'opus', '--session-id', 'sess-4'])
    expect(Date.now() - before).toBeGreaterThanOrEqual(300)
    expect(events(four.out)[2].result).toBe('late')
    vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '')

    // Past the end: stderr, exit 3, no result event.
    const past = await invoke(['-p', '--model', 'opus', '--session-id', 'sess-5'])
    expect(past.code).toBe(3)
    expect(past.err).not.toBe('')
    expect(past.out).not.toContain('"result"')

    // One { cwd, argv } line per invocation, the last included.
    const calls = invocations()
    expect(calls).toHaveLength(5)
    expect(Object.keys(calls[0]).sort()).toEqual(['argv', 'cwd'])
    expect(calls[0]).toEqual({
      cwd,
      argv: ['-p', '--model', 'opus', '--session-id', 'sess-1']
    })
    expect(prompts()[0]).toBe('first prompt')

    // Parallel invocations take distinct entries.
    setScenario(Array.from({ length: 8 }, (_, i) => ({ reply: `entry-${i}` })))
    const parallel = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        invoke(['-p', '--model', 'opus', '--session-id', `par-${i}`])
      )
    )
    const replies = parallel.map((p) => events(p.out)[2].result).sort()
    expect(replies).toEqual(Array.from({ length: 8 }, (_, i) => `entry-${i}`))
  },
  SLOW_TEST_MS
)

it(
  'claude runs niced with the CPU caps and no holdout path in its environment',
  async () => {
    const { runClaude } = await import('../scripts/eval/bakeoff/claude.mjs')
    const real = execFileSync('sh', ['-c', 'command -v nice'], { encoding: 'utf8' }).trim()
    const bin = join(tmp, 'bin')
    const niceLog = join(tmp, 'nice.log')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'nice'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${niceLog}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 }
    )
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('HARNU_BAKEOFF_HOLDOUT', '/private/holdout')
    vi.stubEnv('HARNU_BAKEOFF_WORK', '/private/work')
    vi.stubEnv('CLAUDECODE', '1')
    const envDump = join(tmp, 'env.txt')
    wrappedFake(`env > '${envDump}'`, '')
    setScenario([{ reply: 'ok' }])

    const cwd = join(tmp, 'cwd')
    mkdirSync(cwd)
    await runClaude({
      role: 'operator',
      prompt: 'hi',
      cwd,
      model: 'm',
      tools: [],
      addDirs: [],
      sessionId: 's',
      deadlineMs: 30_000,
      maxTurns: 2,
      streamPath: join(tmp, 'stream.jsonl')
    })

    expect(readFileSync(niceLog, 'utf8')).toMatch(/^-n 19 /)
    const env = readFileSync(envDump, 'utf8').split('\n')
    expect(env).toContain('GOMAXPROCS=1')
    expect(env).toContain('PYTEST_ADDOPTS=-p no:xdist')
    expect(env).toContain('npm_config_jobs=1')
    expect(
      env.filter((l) => /^(HARNU_BAKEOFF_HOLDOUT|HARNU_BAKEOFF_WORK|CLAUDECODE)=/.test(l))
    ).toEqual([])
  },
  SLOW_TEST_MS
)

it(
  'killAll ends the running sessions and the interrupted run is discarded',
  async () => {
    const { killAll, runClaude, resetInterrupted } =
      await import('../scripts/eval/bakeoff/claude.mjs')
    const { runContestant } = await import('../scripts/eval/bakeoff/contestant-run.mjs')

    setScenario([{ hangMs: 60_000, reply: 'never' }])
    const args = await runArgs('interrupted')
    const running = runContestant(args)
    await untilInvoked(1)
    const sessionId = flag(invocations()[0].argv, '--session-id')
    expect(await killAll()).toEqual([sessionId])

    const result = await running
    expect(result.status).toBe('interrupted')
    expect(existsSync(join(args.unitDir, 'contestant.json'))).toBe(false)
    const discarded = JSON.parse(
      readFileSync(join(args.unitDir, 'contestant/discarded.json'), 'utf8')
    )
    expect(discarded).toHaveLength(1)
    expect(discarded[0].usage.total).toBe(110)
    expect(existsSync(join(args.unitDir, `discarded/1/contestant/${sessionId}.jsonl`))).toBe(true)
    expect(readdirSync(projects)).toEqual(['.fake-claude-cursor'])

    // Between turns a unit could start one more session: after killAll, none starts.
    const cwd = join(tmp, 'cwd')
    mkdirSync(cwd)
    const refused = await runClaude({
      role: 'contestant',
      prompt: 'p',
      cwd,
      model: 'm',
      tools: [],
      addDirs: [],
      sessionId: 'late',
      deadlineMs: 30_000,
      maxTurns: 1,
      streamPath: join(tmp, 'late.jsonl')
    })
    expect(refused).toMatchObject({ status: 'error', interrupted: true })
    expect(invocations()).toHaveLength(1)

    // A resume in the same process starts over, on the interrupted unit's own directory.
    resetInterrupted()
    setScenario([{ reply: 'ARTIFACT DONE: a.md', writes: [{ path: 'a.md', content: 'a\n' }] }])
    const resumed = await runContestant(args)
    expect(resumed.status).toBe('done')
    expect(resumed.artifact).toEqual(['a.md'])
  },
  SLOW_TEST_MS
)

it(
  'no session inherits the holdout, work or cache location',
  async () => {
    const { resolveModel } = await import('../scripts/eval/bakeoff/claude.mjs')
    const envLog = join(tmp, 'env.jsonl')
    vi.stubEnv('FAKE_CLAUDE_ENV_LOG', envLog)
    vi.stubEnv('HARNU_BAKEOFF_HOLDOUT', join(tmp, 'private-holdout'))
    vi.stubEnv('HARNU_BAKEOFF_WORK', join(tmp, 'private-work'))
    vi.stubEnv('HARNU_BAKEOFF_CACHE', join(tmp, 'private-cache'))

    setScenario([{ reply: 'ok' }])
    await resolveModel(['haiku'])
    const result = await run('env', [
      { reply: 'QUESTION TO OPERATOR: Which?' },
      { reply: operatorReply('none', 'That one.') },
      { reply: 'ARTIFACT DONE: a.md', writes: [{ path: 'a.md', content: 'a\n' }] }
    ])
    expect(result.status).toBe('done')

    // The probe, the contestant's first turn, the operator and the contestant's resume.
    const sessions = jsonl(envLog).map((line) => line.env as string[])
    expect(sessions).toHaveLength(4)
    for (const names of sessions) {
      // A control: the recording does see what the harness passes on.
      expect(names).toContain('HARNU_BAKEOFF_CLAUDE_PROJECTS')
      for (const hidden of ['HARNU_BAKEOFF_HOLDOUT', 'HARNU_BAKEOFF_WORK', 'HARNU_BAKEOFF_CACHE']) {
        expect(names).not.toContain(hidden)
      }
    }
  },
  SLOW_TEST_MS
)
