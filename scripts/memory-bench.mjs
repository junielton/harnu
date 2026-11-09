#!/usr/bin/env node
// CLI for the memory efficiency benchmark (T620, spec
// docs/specs/2026-11-04-memory-benchmark/spec.md). Reads a repo's project memory and its
// Claude transcripts, then prints the scorecard computed by memory-bench-core.mjs.
//
//   npm run memory:bench -- --repo . [--json] [--since 2026-10-01] [--questions <file>]
//
// Read-only by construction: files are only opened for reading, and git is only asked
// `rev-parse` and `worktree list`. Transcripts are streamed, at most half the CPUs at a time.

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { availableParallelism, cpus, homedir } from 'node:os'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import {
  computeScorecard,
  concurrencyLimit,
  createTranscriptFold,
  foldTranscriptLine,
  listPageIds,
  mapLimit,
  mapPath,
  PAGE_DIRS,
  parsePathMaps,
  renderMarkdown,
  slugMayHold,
  unmapPath,
  validateQuestions,
  isUnder
} from './memory-bench-core.mjs'

const USAGE = `usage: memory-bench [--repo <path>] [--home <dir>] [--memory <dir>] [--kind git|non-git]
                    [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--questions <file>]
                    [--boot <dir>] [--path-map <from>=<to>]... [--json]

Without --questions the recall metrics print 0 with recall_questions: 0.
Without --boot the boot metrics print 0 with boot_handoff_measured: 0.`

class ArgError extends Error {}

function parseArgs(argv) {
  const opts = { pathMaps: [], json: false }
  const takes = new Set([
    '--repo',
    '--home',
    '--memory',
    '--kind',
    '--since',
    '--until',
    '--questions',
    '--boot',
    '--path-map'
  ])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (takes.has(a)) {
      const v = argv[++i]
      if (v === undefined) throw new ArgError(`${a} needs a value`)
      if (a === '--path-map') opts.pathMaps.push(v)
      else opts[a.slice(2)] = v
    } else throw new ArgError(`unknown argument: ${a}`)
  }
  for (const k of ['since', 'until']) {
    if (opts[k] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k]))
      throw new ArgError(`--${k} expects YYYY-MM-DD`)
  }
  if (opts.kind !== undefined && opts.kind !== 'git' && opts.kind !== 'non-git') {
    throw new ArgError('--kind expects git or non-git')
  }
  try {
    opts.maps = parsePathMaps(opts.pathMaps).map(({ from, to }) => ({ from, to: path.resolve(to) }))
  } catch (err) {
    throw new ArgError(err.message)
  }
  return opts
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

/** The repo's main checkout and every worktree, or just the folder for a non-git one. */
function scopeOf(repo, kind) {
  if (kind === 'non-git' || !existsSync(path.join(repo, '.git')))
    return { main: repo, roots: [repo] }
  let main = repo
  const roots = new Set([repo])
  try {
    main = path.dirname(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    )
    roots.add(main)
    for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ')) roots.add(line.slice('worktree '.length).trim())
    }
  } catch {
    // Not answerable by git (a broken checkout): score the folder alone.
  }
  return { main, roots: [...roots].sort() }
}

async function readMaybe(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  }
}

async function listMd(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []
    throw err
  }
}

async function readMemory(memoryDir, wantFiles) {
  if (!existsSync(memoryDir)) return null
  const names = { root: await listMd(memoryDir) }
  for (const dir of PAGE_DIRS) names[dir] = await listMd(path.join(memoryDir, dir))
  const hotFile = path.join(memoryDir, 'hot.md')
  const hot = await readMaybe(hotFile)
  const hotMtimeMs = hot === null ? null : (await fs.stat(hotFile)).mtimeMs
  const memory = {
    hot,
    hotMtimeMs,
    index: await readMaybe(path.join(memoryDir, 'index.md')),
    decisions: await readMaybe(path.join(memoryDir, 'decisions.md')),
    names,
    cards: [],
    files: []
  }
  for (const n of names.roadmap) {
    const content = await readMaybe(path.join(memoryDir, 'roadmap', n))
    if (content !== null) memory.cards.push({ page: `roadmap/${n.replace(/\.md$/, '')}`, content })
  }
  if (wantFiles) {
    for (const id of listPageIds(names)) {
      const content = await readMaybe(path.join(memoryDir, `${id}.md`))
      if (content !== null) memory.files.push({ page: id, content })
    }
  }
  return memory
}

async function foldFile(file) {
  const fold = createTranscriptFold()
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of rl) foldTranscriptLine(fold, line)
  return fold
}

/** Every session (top-level transcript) whose folder lies in one of the scope roots. */
async function readSessions(home, roots, maps, limit) {
  const projects = path.join(home, 'projects')
  let slugs = []
  try {
    slugs = (await fs.readdir(projects, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const recorded = roots.map((r) => unmapPath(r, maps))
  const files = []
  for (const slug of slugs.sort()) {
    if (!recorded.some((r) => slugMayHold(slug, r))) continue
    for (const e of await fs.readdir(path.join(projects, slug), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(projects, slug, e.name))
    }
  }
  const existence = new Map()
  const rows = await mapLimit(files, limit, async (file) => {
    const fold = await foldFile(file)
    if (fold.cwd === null) return null
    const cwd = mapPath(fold.cwd, maps)
    if (!roots.some((r) => isUnder(cwd, r))) return null
    if (!existence.has(cwd)) existence.set(cwd, existsSync(cwd))
    return {
      sessionId: path.basename(file, '.jsonl'),
      cwd,
      startMs: fold.startMs,
      endMs: fold.endMs,
      operatorTurns: fold.operatorTurns,
      bytes: (await fs.stat(file)).size,
      cwdExists: existence.get(cwd)
    }
  })
  return rows.filter(Boolean)
}

async function readBoot(dir) {
  if (!dir) return null
  const boot = {}
  for (const src of ['startup', 'resume', 'compact']) {
    const text = await readMaybe(path.join(dir, `${src}.txt`))
    if (text !== null) boot[src] = text
  }
  return boot
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const repo = path.resolve(opts.repo ?? '.')
  if (!existsSync(repo)) throw new ArgError(`--repo ${opts.repo}: no such folder`)
  const kind = opts.kind ?? (existsSync(path.join(repo, '.git')) ? 'git' : 'non-git')
  const { main: checkout, roots } = scopeOf(repo, kind)
  const home = path.resolve(
    opts.home ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')
  )
  const memoryDir = path.resolve(opts.memory ?? path.join(checkout, '.harnu', 'memory'))

  let questions = null
  if (opts.questions) {
    const text = await readMaybe(path.resolve(opts.questions))
    if (text === null) throw new ArgError(`--questions ${opts.questions}: no such file`)
    try {
      questions = validateQuestions(JSON.parse(text))
    } catch (err) {
      throw new ArgError(`--questions ${opts.questions}: ${err.message}`)
    }
  }
  const cpuCount =
    typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  const card = computeScorecard({
    repo: { name: path.basename(checkout), kind },
    roots,
    window: { since: opts.since ?? null, until: opts.until ?? null },
    memory: await readMemory(memoryDir, questions !== null),
    sessions: await readSessions(home, roots, opts.maps, concurrencyLimit(cpuCount)),
    questions,
    questionsName: opts.questions ? path.basename(opts.questions) : null,
    boot: await readBoot(opts.boot ? path.resolve(opts.boot) : null)
  })
  process.stdout.write(opts.json ? `${JSON.stringify(card, null, 2)}\n` : renderMarkdown(card))
}

main().catch((err) => {
  if (err instanceof ArgError) {
    process.stderr.write(`memory-bench: ${err.message}\n${USAGE}\n`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`memory-bench: ${err.stack ?? err}\n`)
  process.exitCode = 1
})
