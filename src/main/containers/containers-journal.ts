/**
 * The Containers journal (PRD §3.5): one tombstone per action, appended as a
 * JSON line to `<userData>/containers-log.jsonl`. Pure (de)serialization and
 * restore hints, plus a thin append/read shell that takes the file path — the
 * caller resolves `userData`, so this module never imports Electron.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  ACT_VERBS,
  ACTORS as WIRE_ACTORS,
  type Actor,
  type ActVerb,
  type Tombstone,
  type TombstoneStack
} from './containers-wire'

export const JOURNAL_FILE = 'containers-log.jsonl'

export function journalFile(userDataDir: string): string {
  return path.join(userDataDir, JOURNAL_FILE)
}

export function serializeTombstone(t: Tombstone): string {
  return JSON.stringify(t) + '\n'
}

// The wire's own roster, like the verbs below, so an actor added there is never dropped on read.
const ACTORS: readonly Actor[] = WIRE_ACTORS
// The wire's own roster, so a verb added there is never silently dropped when
// its tombstones are read back (T340).
const VERBS: readonly ActVerb[] = ACT_VERBS

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isTombstoneStack(v: unknown): v is TombstoneStack {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  const freed = s.freed as Record<string, unknown> | null | undefined
  return (
    typeof s.stack === 'string' &&
    typeof s.name === 'string' &&
    (typeof s.path === 'string' || s.path === null) &&
    isStringArray(s.containerIds) &&
    !!freed &&
    typeof freed === 'object' &&
    typeof freed.ramBytes === 'number' &&
    Array.isArray(freed.ports) &&
    freed.ports.every((p) => typeof p === 'number') &&
    isStringArray(freed.volumes) &&
    typeof freed.volumeBytes === 'number' &&
    (s.keptVolumes === undefined || isStringArray(s.keptVolumes)) &&
    (s.keptVolumeBytes === undefined || typeof s.keptVolumeBytes === 'number')
  )
}

export function isTombstone(v: unknown): v is Tombstone {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    typeof t.at === 'number' &&
    ACTORS.includes(t.actor as Actor) &&
    VERBS.includes(t.verb as ActVerb) &&
    Array.isArray(t.stacks) &&
    t.stacks.every(isTombstoneStack) &&
    (typeof t.restoreHint === 'string' || t.restoreHint === null)
  )
}

/** Parses journal JSONL, newest first, skipping malformed lines. */
export function parseJournal(content: string, limit = Number.POSITIVE_INFINITY): Tombstone[] {
  const out: Tombstone[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isTombstone(parsed)) out.push(parsed)
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, limit)
}

// Already safe as a bare shell word; anything else is single-quoted, because a
// restore hint is a command a human pastes into a terminal.
const SHELL_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/

export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** What the labels or `docker compose config` know about how a stack starts (all optional). */
export interface HintFacts {
  configFiles?: readonly string[]
  profiles?: readonly string[]
  envFile?: string | null
  hasBuild?: boolean
}

/** The stack facts a restore hint is built from. */
export interface HintStack {
  kind: 'compose' | 'container'
  project: string | null
  worktreePath: string | null
  worktreeExists: boolean
  facts?: HintFacts | null
}

/**
 * The command that brings a compose stack back after `down` or a removal (U3.4, AC-U3d):
 * `docker compose -p P --project-directory WD [-f F]… [--profile X]… [--env-file E] up -d [--build]`.
 * It names the project with `-p`: a name that came from `-p` or `COMPOSE_PROJECT_NAME` would
 * otherwise come back under the directory's default name, and miss the volumes the operator kept.
 * Every path is shell-quoted, because a restore hint is a command a human pastes into a terminal.
 */
export function composeUpCommand(f: {
  project: string | null
  workingDir: string
  configFiles: readonly string[]
  profiles: readonly string[]
  envFile: string | null
  hasBuild: boolean
}): string {
  return [
    'docker compose',
    ...(f.project ? ['-p', shellQuote(f.project)] : []),
    '--project-directory',
    shellQuote(f.workingDir),
    ...f.configFiles.flatMap((file) => ['-f', shellQuote(file)]),
    ...f.profiles.flatMap((profile) => ['--profile', shellQuote(profile)]),
    ...(f.envFile ? ['--env-file', shellQuote(f.envFile)] : []),
    'up -d',
    ...(f.hasBuild ? ['--build'] : [])
  ].join(' ')
}

/**
 * The compose command for a stack, or null when nothing can bring it back: not a compose stack,
 * no known directory, or the directory is gone.
 */
function composeHint(stack: HintStack): string | null {
  if (stack.kind !== 'compose' || !stack.worktreePath || !stack.worktreeExists) return null
  return composeUpCommand({
    project: stack.project,
    workingDir: stack.worktreePath,
    configFiles: stack.facts?.configFiles ?? [],
    profiles: stack.facts?.profiles ?? [],
    envFile: stack.facts?.envFile ?? null,
    hasBuild: stack.facts?.hasBuild ?? false
  })
}

/**
 * After a stop. A compose stack gets its `compose up -d` command and NEVER `docker start <ids>`
 * (U3.4, risk 9: it fails once the stack was brought down, and is the wrong tool for a stack that
 * needs its network back); null when the stack's directory is unknown or gone. A standalone
 * container that was merely stopped keeps `docker start` (12-char ids, which docker accepts as
 * prefixes).
 */
export function restoreHintForStop(
  stack: HintStack,
  containerIds: readonly string[]
): string | null {
  if (containerIds.length === 0) return null
  if (stack.kind === 'compose') return composeHint(stack)
  return `docker start ${containerIds.map((id) => shellQuote(id.slice(0, 12))).join(' ')}`
}

/**
 * After a removal: the compose recreate command when the stack came from a compose project whose
 * worktree still exists; otherwise nothing can bring the stack back, and the hint is null.
 */
export function restoreHintForRemove(stack: HintStack): string | null {
  return composeHint(stack)
}

export async function appendTombstone(file: string, t: Tombstone): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, serializeTombstone(t), 'utf8')
}

/** Every tombstone, newest first; `[]` when the file is missing or unreadable. */
export async function readJournal(
  file: string,
  limit = Number.POSITIVE_INFINITY
): Promise<Tombstone[]> {
  try {
    return parseJournal(await fs.readFile(file, 'utf8'), limit)
  } catch {
    return []
  }
}
