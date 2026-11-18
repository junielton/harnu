/**
 * Guided walks: Export markdown (spec S-4, AC-23, D-13).
 *
 * An OPERATOR action, never a verb: the pane's Export button (past run, close-out card) asks main to write the
 * walk as one Markdown file and opens it in the viewer. Where it writes follows D-13: inside the walk's own
 * folder under `.harnu/walks/<walkId>/exports/<name>/`, which is private to the machine, shared by every worktree
 * and never swept by accident. Nothing is committed by Harnu: to share the walk, the operator copies the folder
 * (the file, the script's images and the operator's screenshots sit side by side, so every link still opens).
 *
 * Contents: the title, the source line, the checks in order (Where, Do with its see lines, You should see, the
 * `Not` line, what Harnu checks) with links as Markdown links, and a "Last run" table with the operator's notes.
 *
 * It never overwrites: each export is a NEW folder (`<name>`, then `<name>-2`, `<name>-3`, ...), claimed with a
 * non-recursive `mkdir`, and every copy is exclusive. Electron-free.
 */
import { promises as fs, constants as fsConstants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  counts,
  newRun,
  ordinalOf,
  type CheckState,
  type Run,
  type RunCheck
} from '../../shared/walk-machine'
import { toMachineChecks, type WalkCheck, type WalkLink } from '../../shared/walk-schema'
import type { WalkSource } from '../../shared/walk-source'
import {
  RUN_ID_RE,
  WALK_ID_RE,
  type RunRecord,
  type WalkRecord,
  type WalkStore
} from './walk-store'

export type ExportResult =
  | { ok: true; path: string; dir: string; images: number; shots: number }
  | { ok: false; error: { code: string; message: string } }

const refuse = (code: string, message: string): ExportResult => ({
  ok: false,
  error: { code, message }
})

// ---- The Markdown --------------------------------------------------------------------------------

const cell = (s: string): string =>
  s
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The URL of PR `n` of the source PR's repository, when the source says where that is. */
function prUrl(source: WalkSource, n: string): string | null {
  if (source.kind !== 'pr' || !source.url) return null
  const m = /^(https:\/\/[^?#]+?)\/pull\/\d+/.exec(source.url)
  return m && /^\d+$/.test(n) ? `${m[1]}/pull/${n}` : null
}

function linkMd(source: WalkSource, l: WalkLink): string {
  if (l.kind === 'url') return `[${l.label}](${l.target})`
  if (l.kind === 'pr') {
    const url = prUrl(source, l.target)
    return url ? `[${l.label}](${url})` : l.label
  }
  if (l.kind === 'file') return `\`${l.target}${l.line ? `:${l.line}` : ''}\``
  return `\`${l.target}\`` // a folder
}

function sourceMd(source: WalkSource): string {
  switch (source.kind) {
    case 'pr': {
      const text = [`PR #${source.number}`, source.title, source.author].filter(Boolean).join(' · ')
      return source.url ? `[${text}](${source.url})` : text
    }
    case 'branch':
      return `Branch \`${source.branch}\` → \`${source.base}\``
    case 'card':
      return `Card · ${source.slug}`
    case 'mission':
      return source.scope === 'mission'
        ? `Mission ${source.missionId} · the whole mission`
        : `Mission ${source.missionId} · ${source.scope} “${source.id ?? ''}”`
    default:
      return source.text
  }
}

const RESULT: Record<CheckState, string> = {
  verified: 'passed',
  caveat: 'not confirmed',
  disagrees: 'not confirmed',
  failed: 'failed',
  skipped: 'skipped',
  todo: 'not reached',
  awaiting: 'not reached'
}

/** What a check's row of the table says in its Notes column: the operator's lines, their screenshots, the rest. */
function notesOf(rc: RunCheck, shots: Map<string, string>): string {
  const parts: string[] = []
  for (const f of rc.failures) {
    if (f.from !== 'operator') continue
    const bits: string[] = []
    if (f.line) bits.push(`“${f.line}”`)
    const copied = f.shot ? shots.get(f.shot) : undefined
    if (copied) bits.push(`[screenshot](${copied})`)
    if (bits.length) parts.push(bits.join(' '))
  }
  if (rc.correction?.text) parts.push(`correction: ${rc.correction.text}`)
  if (rc.report?.result === 'fail') parts.push(`agent: ${rc.report.evidence}`)
  return cell(parts.join(' · '))
}

export function walkMarkdown(
  walk: WalkRecord,
  rec: RunRecord | null,
  /** The screenshot files copied beside the export: absolute path to the relative link. */
  shots: Map<string, string> = new Map()
): string {
  const { script } = walk
  const ref: Run = rec?.run ?? newRun(toMachineChecks(script), { n: 1 })
  const out: string[] = [`# ${script.title}`, '', `Source: ${sourceMd(script.source)}`, '']

  out.push('## Checks', '')
  for (const c of script.checks) out.push(...checkMd(c, ordinalOf(ref, c.id), script.source))

  out.push('## Last run', '')
  if (!rec) {
    out.push('Not walked yet.', '')
    return out.join('\n')
  }
  const c = counts(rec.run)
  const when = rec.run.endedAt ?? rec.run.startedAt
  out.push(
    `Run ${rec.run.n}${when ? ` · ${isoDay(when)}` : ''} · ${c.verified} of ${c.total} passed`,
    '',
    '| # | Check | Result | Notes |',
    '| --- | --- | --- | --- |'
  )
  for (const rc of rec.run.checks) {
    if (!rc.countable) continue
    const ck = script.checks.find((x) => x.id === rc.id)
    if (!ck) continue
    out.push(
      `| ${ordinalOf(rec.run, rc.id)} | ${cell(ck.title)} | ${RESULT[rc.state]} | ${notesOf(rc, shots)} |`
    )
  }
  out.push('')
  return out.join('\n')
}

function checkMd(c: WalkCheck, n: number | null, source: WalkSource): string[] {
  const lines: string[] = []
  if (n === null) {
    // a row verified before the walk: drawn, not numbered, not walked
    lines.push(`### ✓ ${c.title}`, '')
    lines.push(`Already verified${c.evidence ? `: ${c.evidence}` : '.'}`, '')
    return lines
  }
  lines.push(`### ${n}. ${c.title}`, '')
  const where = [c.where.text]
  if (c.where.path) where.push(`(${c.where.path}${c.where.approximate ? ', roughly' : ''})`)
  lines.push(`**Where:** ${where.join(' ')}`, '')
  if (c.where.links?.length)
    lines.push(`**Links:** ${c.where.links.map((l) => linkMd(source, l)).join(' · ')}`, '')
  lines.push('**Do:**', '')
  c.do.forEach((d, i) => {
    lines.push(`${i + 1}. ${d.text}`)
    lines.push(`   - You see: ${d.see}`)
    if (d.block)
      lines.push(
        '',
        '   ```' + (d.block.lang ?? ''),
        ...d.block.text.split('\n').map((l) => `   ${l}`),
        '   ```'
      )
  })
  lines.push('', `**You should see:** ${c.passes}`)
  if (c.fails) lines.push('', `**Not:** ${c.fails}`)
  for (const im of c.images ?? []) {
    lines.push('', `![${im.alt}](${im.src})`)
    if (im.caption && im.caption !== im.alt) lines.push(`*${im.caption}*`)
  }
  lines.push(
    '',
    c.check
      ? `**I'll check:** ${c.check.how}`
      : `**I'll check:** Nothing from here.${c.nothingFromHere ? ` ${c.nothingFromHere}` : ''}`,
    ''
  )
  return lines
}

// ---- Writing it ----------------------------------------------------------------------------------

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'walk'

/** Claim a fresh directory `<parent>/<name>`, then `<name>-2`, `<name>-3`, ...: never an existing one. */
async function claimDir(parent: string, name: string): Promise<{ dir: string; name: string }> {
  await fs.mkdir(parent, { recursive: true })
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? name : `${name}-${i}`
    const dir = join(parent, candidate)
    try {
      await fs.mkdir(dir) // not recursive: it fails if the name is taken, however it was taken
      return { dir, name: candidate }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('no free export name')
}

/** Is `file` a path inside `root` once resolved? */
const inside = (root: string, file: string): boolean => {
  const rel = relative(resolve(root), resolve(file))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function copyExclusive(from: string, to: string): Promise<boolean> {
  try {
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL)
    return true
  } catch {
    return false // a missing source (the operator deleted it) is left out, never an error
  }
}

export async function exportWalk(
  store: WalkStore,
  a: { walkId: string; runId?: string }
): Promise<ExportResult> {
  if (!WALK_ID_RE.test(a.walkId)) return refuse('BAD_ARGS', 'That is not a walk id.')
  const walk = await store.readWalk(a.walkId)
  if (!walk) return refuse('WALK_NOT_FOUND', 'No such walk.')
  let rec: RunRecord | null = null
  if (a.runId !== undefined) {
    if (!RUN_ID_RE.test(a.runId)) return refuse('BAD_ARGS', 'That is not a run id.')
    rec = await store.readRun(a.walkId, a.runId)
    if (!rec) return refuse('RUN_NOT_FOUND', 'No such run.')
  } else if (walk.lastRun) {
    rec = await store.readRun(a.walkId, walk.lastRun.runId)
  }

  const walkDir = store.walkDir(a.walkId)
  const { dir, name } = await claimDir(join(walkDir, 'exports'), slugOf(walk.script.title))

  // the script's images, copied beside the file under the same relative path the script uses
  let images = 0
  for (const c of walk.script.checks) {
    for (const im of c.images ?? []) {
      const from = resolve(walkDir, im.src)
      if (!inside(walkDir, from) || isAbsolute(im.src)) continue
      if (await copyExclusive(from, join(dir, im.src))) images++
    }
  }
  // the operator's screenshots of that run, so a note still opens when the folder is shared
  const shots = new Map<string, string>()
  if (rec) {
    const shotsRoot = store.shotsDir(a.walkId, rec.runId)
    for (const rc of rec.run.checks)
      for (const f of rc.failures) {
        if (!f.shot || shots.has(f.shot) || !inside(shotsRoot, f.shot)) continue
        const rel = `shots/${basename(f.shot)}`
        if (await copyExclusive(f.shot, join(dir, rel))) shots.set(f.shot, rel)
      }
  }

  const path = join(dir, `${name}.md`)
  await fs.writeFile(path, walkMarkdown(walk, rec, shots), { flag: 'wx', mode: 0o600 })
  return { ok: true, path, dir, images, shots: shots.size }
}
