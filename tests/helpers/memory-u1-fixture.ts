/**
 * The shared fixture of the memory U1 capture spec (`docs/specs/2026-11-04-memory-u1-capture/spec.md`,
 * "The shared fixture"). The table lives in `tests/fixtures/memory-u1/sessions.json`; this helper
 * turns a row into the transcript lines Claude Code would have written. S-1 ships
 * `transcriptLines`; S-2 adds `buildMemoryU1Home`, which writes those lines to disk next to a real
 * git repo.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

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
