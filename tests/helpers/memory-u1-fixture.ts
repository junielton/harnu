/**
 * The shared fixture of the memory U1 capture spec (`docs/specs/2026-11-04-memory-u1-capture/spec.md`,
 * "The shared fixture"). The table lives in `tests/fixtures/memory-u1/sessions.json`; this helper
 * turns a row into the transcript lines Claude Code would have written. S-1 ships
 * `transcriptLines`; S-2 adds `buildMemoryU1Home`, which writes those lines to disk next to a real
 * git repo.
 */
import { execFile } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { slugOfPath } from '../../src/main/gc/gc-transcripts'

const runFile = promisify(execFile)

export interface FixtureSession {
  id: string // full session id
  folder: 'repo' | 'plain' | 'gone'
  startMin: number // minutes after T
  endMin: number
  turns: number
  gitCalls: { atMin: number; subject: string; subagent?: boolean }[]
  ask?: { atMin: number; answers: Record<string, string | string[]> }
  lastText?: string
}

export interface MemoryU1Fixture {
  /** The fixture's epoch, an ISO instant. */
  T: string
  /** The ten rows, in table order. */
  sessions: FixtureSession[]
}

export interface FixturePaths {
  repo: string
  plain: string
  gone: string
}

const FIXTURE_FILE = path.join(__dirname, '..', 'fixtures', 'memory-u1', 'sessions.json')

/** Reads the fixture table from disk (a fresh copy on every call). */
export function loadMemoryU1Fixture(): MemoryU1Fixture {
  return JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as MemoryU1Fixture
}

/** One fixture row by its 8-character prefix. Throws for an unknown id. */
export function fixtureSession(id8: string): FixtureSession {
  const found = loadMemoryU1Fixture().sessions.find((s) => s.id.startsWith(id8))
  if (!found) throw new Error(`no fixture session ${id8}`)
  return found
}

/** The fixture epoch in epoch milliseconds. */
export function fixtureT(): number {
  return Date.parse(loadMemoryU1Fixture().T)
}

/** Epoch milliseconds of `min` minutes (and `sec` seconds) after T. */
export function atMinute(min: number, sec = 0): number {
  return fixtureT() + min * 60_000 + sec * 1_000
}

const BRANCH: Record<FixtureSession['folder'], string | undefined> = {
  repo: 'main',
  plain: undefined,
  gone: 'feature-x'
}

/**
 * A line before numbering. `useKey` names the tool_use id this line carries, `resultOf` the
 * tool_use whose id its tool_result block points at; both resolve once lines are numbered.
 */
interface Draft {
  ms: number | null
  entry: Record<string, unknown>
  useKey?: string
  resultOf?: string
}

/** The transcript lines of one session (and of its subagent file), with placeholders resolved. */
export function transcriptLines(
  s: FixtureSession,
  paths: FixturePaths
): { main: string[]; subagent: string[] } {
  const id8 = s.id.slice(0, 8)
  const T = fixtureT()
  const at = (min: number, sec = 0): number => T + min * 60_000 + sec * 1_000
  const main: Draft[] = []
  const sub: Draft[] = []

  const user = (
    content: unknown,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    type: 'user',
    ...extra,
    message: { role: 'user', content }
  })
  const assistant = (
    messageId: string,
    content: unknown[],
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    type: 'assistant',
    ...extra,
    message: { id: messageId, role: 'assistant', content }
  })
  const toolUse = (name: string, input: unknown): Record<string, unknown> => ({
    type: 'tool_use',
    id: '',
    name,
    input
  })
  const toolResult = (content: string): Record<string, unknown> => ({
    type: 'tool_result',
    tool_use_id: '',
    content
  })

  // 1. The summary line, no timestamp.
  main.push({ ms: null, entry: { type: 'summary', summary: 'fixture' } })

  // 2. An isMeta noise line at S.
  main.push({ ms: at(s.startMin), entry: user(`noise ${id8}`, { isMeta: true }) })

  // 3. The turns, each answered 30 s later.
  for (let k = 1; k <= s.turns; k++) {
    const turnAt = at(s.startMin + (k - 1) * 10)
    main.push({ ms: turnAt, entry: user(`turn ${k} of ${id8}`) })
    main.push({
      ms: turnAt + 30_000,
      entry: assistant(`${id8}-r${k}`, [{ type: 'text', text: `reply ${k}` }])
    })
  }

  // 4. After turn 1, one second apart: lines that look like turns but are not.
  if (s.turns >= 1) {
    const base = at(s.startMin + 1)
    main.push({
      ms: base,
      entry: assistant(`${id8}-read`, [toolUse('Read', { file_path: 'README.md' })]),
      useKey: 'read'
    })
    main.push({ ms: base + 1_000, entry: user([toolResult('ok')]), resultOf: 'read' })
    main.push({ ms: base + 2_000, entry: user(`noise ${id8}`, { isSidechain: true }) })
    main.push({ ms: base + 3_000, entry: user(`noise ${id8}`, { isCompactSummary: true }) })
    main.push({
      ms: base + 4_000,
      entry: user([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
        }
      ])
    })
    main.push({ ms: base + 5_000, entry: user('<local-command-stdout>ok</local-command-stdout>') })
  }

  // 5. The git calls, each with its result 2 s later.
  s.gitCalls.forEach((call, i) => {
    const key = `git-${i}`
    const target = call.subagent ? sub : main
    const flags = call.subagent ? { isSidechain: true } : {}
    target.push({
      ms: at(call.atMin),
      entry: assistant(
        `${id8}-git${i + 1}`,
        [toolUse('Bash', { command: `git commit -m "${call.subject}"` })],
        flags
      ),
      useKey: key
    })
    target.push({
      ms: at(call.atMin, 2),
      entry: user([toolResult('ok')], flags),
      resultOf: key
    })
  })

  // 6. The ask, answered 1 min later.
  if (s.ask) {
    const questions = Object.keys(s.ask.answers).map((question) => ({ question }))
    main.push({
      ms: at(s.ask.atMin),
      entry: assistant(`${id8}-ask`, [toolUse('AskUserQuestion', { questions })]),
      useKey: 'ask'
    })
    main.push({
      ms: at(s.ask.atMin + 1),
      entry: {
        ...user([toolResult('answered')]),
        toolUseResult: { answers: s.ask.answers }
      },
      resultOf: 'ask'
    })
  }

  // 7. The last message, at E.
  main.push({
    ms: at(s.endMin),
    entry: assistant(`${id8}-end`, [{ type: 'text', text: s.lastText ?? `done ${id8}` }])
  })

  const cwd = paths[s.folder]
  const branch = BRANCH[s.folder]
  const finish = (drafts: Draft[], uuidPrefix: string): string[] => {
    // Timestamp order; the summary line (no timestamp) stays first. Array#sort is stable.
    const ordered = [...drafts].sort((a, b) => (a.ms ?? -Infinity) - (b.ms ?? -Infinity))
    const ids = new Map<string, string>()
    ordered.forEach((d, i) => {
      if (d.useKey) ids.set(d.useKey, `toolu_${id8}_${i + 1}`)
    })
    return ordered.map((d, i) => {
      const entry: Record<string, unknown> = {
        ...d.entry,
        sessionId: s.id,
        uuid: `${id8}-${uuidPrefix}${i + 1}`,
        cwd
      }
      if (branch) entry.gitBranch = branch
      if (d.ms !== null) entry.timestamp = new Date(d.ms).toISOString()
      const blocks = (entry.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks as Record<string, unknown>[]) {
          if (block.type === 'tool_use' && d.useKey) block.id = ids.get(d.useKey)
          if (block.type === 'tool_result' && d.resultOf) block.tool_use_id = ids.get(d.resultOf)
        }
      }
      return JSON.stringify(entry)
    })
  }

  return { main: finish(main, ''), subagent: finish(sub, 's') }
}

/** What {@link buildMemoryU1Home} built. */
export interface MemoryU1Home {
  /** `<tmp>/home`; the transcripts live under `<home>/.claude/projects/`. */
  home: string
  /** `<tmp>/repo`, a git repo on `main` with the fixture's commits. */
  repo: string
  /** `<tmp>/plain`, a folder that is not a git work tree. */
  plain: string
  /** `<tmp>/repo/.claude/worktrees/feature-x`, never created. */
  gone: string
  sessions: FixtureSession[]
  /** Absolute path of a session's main transcript. */
  transcriptOf(id: string): string
  /** Absolute paths of a session's subagent transcripts (empty when it has none). */
  subagentsOf(id: string): string[]
}

/**
 * Every git call the helper makes is isolated from the machine's configuration: no global or
 * system config, no signing, no hooks.
 */
async function fixtureGit(cwd: string, args: string[], dateMs?: number): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com'
  }
  if (dateMs !== undefined) {
    const date = new Date(dateMs).toISOString()
    env.GIT_AUTHOR_DATE = date
    env.GIT_COMMITTER_DATE = date
  }
  const { stdout } = await runFile(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    { env }
  )
  return stdout
}

/**
 * Builds a temp home for the replay (spec "The shared fixture"): the git repo with one commit per
 * fixture git call, the plain folder, and every transcript under `<home>/.claude/projects/`, each
 * file's mtime set to its session's end. `.harnu/` is excluded in the repo's `.git/info/exclude`
 * so the digests a replay writes there never count as uncommitted changes.
 */
export async function buildMemoryU1Home(tmp: string): Promise<MemoryU1Home> {
  const { sessions } = loadMemoryU1Fixture()
  const home = path.join(tmp, 'home')
  const repo = path.join(tmp, 'repo')
  const plain = path.join(tmp, 'plain')
  const gone = path.join(repo, '.claude', 'worktrees', 'feature-x')
  const paths: FixturePaths = { repo, plain, gone }

  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(plain, { recursive: true })
  const plainIsTree = await fixtureGit(plain, ['rev-parse', '--is-inside-work-tree']).then(
    () => true,
    () => false
  )
  if (plainIsTree) throw new Error(`${plain} is inside a git work tree; pick another tmp dir`)

  await fixtureGit(repo, ['init', '--template=', '-b', 'main'])
  await fs.mkdir(path.join(repo, '.git', 'info'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git', 'info', 'exclude'), '.harnu/\n')
  const T = fixtureT()
  await fixtureGit(repo, ['commit', '--allow-empty', '-m', 'chore: init'], T - 86_400_000)
  const calls = sessions
    .filter((s) => s.folder === 'repo')
    .flatMap((s) => s.gitCalls)
    .sort((a, b) => a.atMin - b.atMin)
  for (const call of calls) {
    await fs.writeFile(path.join(repo, `${call.subject}.txt`), `${call.subject}\n`)
    await fixtureGit(repo, ['add', `${call.subject}.txt`])
    await fixtureGit(repo, ['commit', '-m', call.subject], atMinute(call.atMin, 1))
  }

  const projects = path.join(home, '.claude', 'projects')
  const mains = new Map<string, string>()
  const subs = new Map<string, string[]>()
  for (const s of sessions) {
    const dir = path.join(projects, slugOfPath(paths[s.folder]))
    const lines = transcriptLines(s, paths)
    const end = new Date(atMinute(s.endMin))
    const file = path.join(dir, `${s.id}.jsonl`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, lines.main.join('\n') + '\n')
    await fs.utimes(file, end, end)
    mains.set(s.id, file)
    if (lines.subagent.length > 0) {
      const subFile = path.join(dir, s.id, 'subagents', 'agent-1.jsonl')
      await fs.mkdir(path.dirname(subFile), { recursive: true })
      await fs.writeFile(subFile, lines.subagent.join('\n') + '\n')
      await fs.utimes(subFile, end, end)
      subs.set(s.id, [subFile])
    }
  }

  return {
    home,
    repo,
    plain,
    gone,
    sessions,
    transcriptOf(id: string): string {
      const file = mains.get(id)
      if (!file) throw new Error(`no fixture transcript for ${id}`)
      return file
    },
    subagentsOf(id: string): string[] {
      return subs.get(id) ?? []
    }
  }
}
