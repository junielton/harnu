/**
 * T455 W0 round 2, A-P1 / Q6: which prompt rows do the legacy twins pick, and which push rule
 * reproduces them?
 *
 * Sample: the N most recently modified top-level transcripts whose first `entrypoint` is `cli`.
 * Every non-sidechain `user` row with text (not a tool result, not a compact summary) is put in
 * one class by its stored shape. The engine door each class arrives on was observed live (W0 §2,
 * §3): see CLASS_DOOR below.
 *
 * lastPrompt: every `last-prompt` line with text is a sample. Its twin is the line itself. Each
 * rule predicts the newest row it accepts before the line; a sample matches when the line's text
 * (whitespace collapsed, first 40 chars) is a prefix of the prediction. A slash-command row's
 * text is `/name args`, the form the CLI writes.
 *
 * firstPrompt: the twin is the real reader's header (`__scrapeHeaderWithStatForTests`, i.e.
 * `firstRealPrompt` over the first non-sidechain user text, with the 2 MiB head cap). Each rule
 * takes the first row it accepts and passes it through the same `firstRealPrompt`.
 *
 * Prints aggregates only (date, corpus size, counts). Usage (from the repo root):
 *   npx esbuild <this file> --bundle --platform=node --format=cjs --outfile=/tmp/p1.cjs
 *   node /tmp/p1.cjs 400
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { __scrapeHeaderWithStatForTests } from '../../../../src/main/claude-reader'
import { extractCommandName, firstRealPrompt } from '../../../../src/main/claude-reader-derive'

type Klass =
  | 'typed'
  | 'typed-command'
  | 'scheduled-command'
  | 'scheduled-prompt'
  | 'command-unstamped'
  | 'local-command-output'
  | 'peer'
  | 'task-notification'
  | 'cross-session-unstamped'
  | 'teammate-message'
  | 'interrupt'
  | 'compact-continuation'
  | 'meta-other'
  | 'other-stamped'
  | 'other-unstamped'

/** The engine door + origin each class was seen on in the W0 probe runs (W0 §2, §3). */
const CLASS_DOOR: Record<Klass, string> = {
  typed: 'prompt / composer',
  'typed-command': 'command / composer',
  'scheduled-command': 'command / unclassified, a self-paced /loop re-fire (run 6)',
  'scheduled-prompt': 'prompt / unclassified (isMeta), a fixed-interval /loop re-fire (run 5)',
  'command-unstamped': 'command / unclassified or engine',
  'local-command-output': 'command / unclassified',
  peer: 'prompt / peer (isMeta)',
  'task-notification': 'prompt / task-notification',
  'cross-session-unstamped': 'note / engine (a teammate reply, run 4)',
  'teammate-message': 'note / engine (a teammate opening, run 4)',
  interrupt: 'not observed',
  'compact-continuation': 'not observed',
  'meta-other': 'note / engine (isMeta), e.g. a command expansion',
  'other-stamped': 'not observed',
  'other-unstamped': 'not observed'
}

const RULES: Record<string, ReadonlySet<Klass>> = {
  'R1 typed only (round-1 M3)': new Set<Klass>(['typed']),
  'R2 typed + typed slash commands': new Set<Klass>(['typed', 'typed-command']),
  'R3 R2 + unstamped cross-session (teammate replies)': new Set<Klass>([
    'typed',
    'typed-command',
    'cross-session-unstamped'
  ]),
  'R4 R3 + re-submitted scheduled commands (self-paced /loop)': new Set<Klass>([
    'typed',
    'typed-command',
    'cross-session-unstamped',
    'scheduled-command'
  ])
}

/** First-prompt rules: the lastPrompt rules, plus one that mirrors the legacy reader (every class
 *  but `peer`, which P2W2-start-prompt.md §7.7 skips as a candidate). */
const ALL_CLASSES = Object.keys(CLASS_DOOR) as Klass[]
const FP_RULES: Record<string, ReadonlySet<Klass>> = {
  ...RULES,
  'F legacy mirror (any class but peer)': new Set<Klass>(ALL_CLASSES.filter((k) => k !== 'peer'))
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

function textOf(msg: unknown): string | null {
  const c = (msg as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return null
  if (c.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'))
    return null
  return c
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : ''
    )
    .join('')
}

function classify(o: Record<string, unknown>, text: string): Klass {
  const kind = (o.origin as { kind?: string } | undefined)?.kind
  const t = text.trimStart()
  const cmd = extractCommandName(text)
  if (typeof o.scheduledTaskId === 'string') return cmd ? 'scheduled-command' : 'scheduled-prompt'
  if (kind === 'human') return cmd ? 'typed-command' : 'typed'
  if (kind === 'peer') return 'peer'
  if (kind === 'task-notification') return 'task-notification'
  if (kind) return 'other-stamped'
  if (cmd) return 'command-unstamped'
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-caveat>'))
    return 'local-command-output'
  if (t.startsWith('Another Claude session sent a message')) return 'cross-session-unstamped'
  if (t.startsWith('<teammate-message')) return 'teammate-message'
  if (t.startsWith('[Request interrupted')) return 'interrupt'
  if (t.startsWith('This session is being continued')) return 'compact-continuation'
  if (o.isMeta === true) return 'meta-other'
  return 'other-unstamped'
}

/** The text the CLI would write for the row: `/name args` for a slash command. */
function candidate(k: Klass, text: string): string {
  if (k === 'typed-command' || k === 'command-unstamped' || k === 'scheduled-command') {
    const name = extractCommandName(text)
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? ''
    return norm(args.trim() ? `${name} ${args}` : name)
  }
  return norm(text)
}

const bump = (rec: Record<string, number>, k: string, n = 1): void => {
  rec[k] = (rec[k] ?? 0) + n
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 400)
  const root = join(homedir(), '.claude', 'projects')
  const all: { path: string; mtime: number }[] = []
  for (const d of readdirSync(root)) {
    let names: string[]
    try {
      names = readdirSync(join(root, d))
    } catch {
      continue
    }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(root, d, f)
      try {
        const st = statSync(path)
        if (st.isFile()) all.push({ path, mtime: st.mtimeMs })
      } catch {
        /* vanished */
      }
    }
  }
  all.sort((a, b) => b.mtime - a.mtime)

  const rows: Record<string, number> = {}
  const rowsMeta: Record<string, number> = {}
  const sessionsWith: Record<string, number> = {}
  const versions: Record<string, number> = {}
  let lpLines = 0
  const lpNamed: Record<string, number> = {}
  type LpTally = {
    match: number
    noCandidate: number
    miss: Record<string, number>
    /** The same, counting only lines whose text differs from the file's previous line. */
    distinctMatch: number
    distinctMiss: Record<string, number>
    /** Sessions with at least one miss of that class. */
    sessionsWithMiss: Record<string, number>
  }
  const lpByRule: Record<string, LpTally> = {}
  for (const r of Object.keys(RULES))
    lpByRule[r] = {
      match: 0,
      noCandidate: 0,
      miss: {},
      distinctMatch: 0,
      distinctMiss: {},
      sessionsWithMiss: {}
    }
  let lpDistinct = 0
  /** Distinct unmatched lines by the shape of their first characters (no text printed). */
  const lpUnmatchedShape: Record<string, number> = {}
  const fpLegacyPick: Record<string, number> = {}
  const fpByRule: Record<string, { match: number; miss: Record<string, number> }> = {}
  for (const r of Object.keys(FP_RULES)) fpByRule[r] = { match: 0, miss: {} }
  let fpSessions = 0
  let fpLegacyEmpty = 0

  let used = 0
  for (const { path } of all) {
    if (used >= n) break
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    let entry: string | null = null
    const parsed: Record<string, unknown>[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      let o: unknown
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o || typeof o !== 'object') continue
      const rec = o as Record<string, unknown>
      if (entry === null && typeof rec.entrypoint === 'string') entry = rec.entrypoint
      parsed.push(rec)
    }
    if (entry !== 'cli') continue
    used++

    const seen = new Set<Klass>()
    const missSeen: Record<string, Set<string>> = {}
    let prevLine = ''
    const prompts: { k: Klass; cand: string; text: string }[] = []
    for (const o of parsed) {
      if (o.type === 'user' && o.isSidechain !== true && !o.toolUseResult && !o.isCompactSummary) {
        const text = textOf(o.message)
        if (text === null || !text.trim()) continue
        const k = classify(o, text)
        bump(rows, k)
        if (o.isMeta === true) bump(rowsMeta, k)
        if (typeof o.version === 'string') bump(versions, o.version)
        seen.add(k)
        prompts.push({ k, cand: candidate(k, text), text })
      } else if (
        o.type === 'last-prompt' &&
        typeof o.lastPrompt === 'string' &&
        o.lastPrompt.trim()
      ) {
        lpLines++
        const want = norm(o.lastPrompt).slice(0, 40)
        const distinct = norm(o.lastPrompt) !== prevLine
        prevLine = norm(o.lastPrompt)
        if (distinct) lpDistinct++
        let named: Klass | 'unmatched' = 'unmatched'
        for (let i = prompts.length - 1; i >= 0; i--) {
          if (prompts[i].cand.startsWith(want)) {
            named = prompts[i].k
            break
          }
        }
        bump(lpNamed, named)
        if (named === 'unmatched' && distinct) {
          const shape = want.startsWith('[Image')
            ? 'starts [Image'
            : want.startsWith('[Pasted')
              ? 'starts [Pasted'
              : want.startsWith('/')
                ? 'starts /'
                : 'other'
          bump(lpUnmatchedShape, shape)
        }
        for (const [r, accept] of Object.entries(RULES)) {
          let pred: string | null = null
          for (let i = prompts.length - 1; i >= 0; i--) {
            if (accept.has(prompts[i].k)) {
              pred = prompts[i].cand
              break
            }
          }
          const t = lpByRule[r]
          let miss: string | null = null
          if (pred === null) {
            t.noCandidate++
            miss = `no candidate (line names ${named})`
          } else if (pred.startsWith(want)) {
            t.match++
            if (distinct) t.distinctMatch++
          } else miss = `line names ${named}`
          if (miss) {
            bump(t.miss, miss)
            if (distinct) bump(t.distinctMiss, miss)
            ;(missSeen[r] ??= new Set()).add(miss)
          }
        }
      }
    }
    for (const k of seen) bump(sessionsWith, k)
    for (const [r, set] of Object.entries(missSeen))
      for (const m of set) bump(lpByRule[r].sessionsWithMiss, m)

    // firstPrompt against the real reader.
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    const header = await __scrapeHeaderWithStatForTests(path, st)
    if (!header) continue
    fpSessions++
    const legacy = header.firstPrompt
    if (!legacy) fpLegacyEmpty++
    // The row the legacy took: the first one whose firstRealPrompt is non-empty.
    const pick = prompts.find((p) => firstRealPrompt([p.text]))
    bump(fpLegacyPick, legacy ? (pick?.k ?? 'not found') : 'none (empty)')
    for (const [r, accept] of Object.entries(FP_RULES)) {
      const first = prompts.find((p) => accept.has(p.k) && firstRealPrompt([p.text]))
      const pred = first ? firstRealPrompt([first.text]) : ''
      if (pred === legacy) fpByRule[r].match++
      else bump(fpByRule[r].miss, `legacy took ${legacy ? (pick?.k ?? 'not found') : 'none'}`)
    }
  }

  const vers = Object.keys(versions).sort()
  console.log(
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        corpusTopLevelTranscripts: all.length,
        sampled: used,
        rowVersions: { min: vers[0], max: vers[vers.length - 1] },
        classDoor: CLASS_DOOR,
        promptRows: rows,
        promptRowsIsMeta: rowsMeta,
        sessionsWith,
        lastPrompt: {
          linesWithText: lpLines,
          distinctLines: lpDistinct,
          namedRowClass: lpNamed,
          distinctUnmatchedShape: lpUnmatchedShape,
          byRule: lpByRule
        },
        firstPrompt: {
          sessions: fpSessions,
          legacyEmpty: fpLegacyEmpty,
          legacyPickedClass: fpLegacyPick,
          byRule: fpByRule
        }
      },
      null,
      1
    )
  )
}

void main()
