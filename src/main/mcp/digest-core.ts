/**
 * Pure core for the automatic session digest (T79 S2; memory U1, spec
 * `docs/specs/2026-11-04-memory-u1-capture/spec.md`): git-evidence parsing, the
 * hook-edge trigger ({@link digestTriggerFor}), the commit-or-turns planner
 * ({@link planDigest}), the digest body ({@link renderDigest}) and the `hot.md`
 * snapshot builder.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell): NO
 * `fs`, `child_process`, `electron`, or clock. The engine (`./digest-engine.ts`)
 * reads the transcript and probes git through injected deps and feeds the bytes +
 * an injected `now` in here, so every gate/format decision is deterministic and
 * lands in the coverage surface (`tests/mcp-digest-core.test.ts`).
 *
 * Design contract (PRD §3.4 + §5):
 *  - The digest is EVIDENCE-linked — commits, file stats, what was asked and
 *    answered, the CLI's own recap — NOT a narrative self-report. The
 *    `## Evidence` block is hard git truth; the session's own words are quoted
 *    verbatim and the recap is framed as self-report, never presented as fact.
 *  - The gate is a commit, or enough user turns ({@link DIGEST_GATE}), a single
 *    pinned config rather than a magic number.
 *  - The `hot` snapshot is written straight to `hot.md` by the shell, with a
 *    provenance stamp and a shadow-log entry (BUG-26 removed the review gate).
 *
 * Content is written in English by default (T85 rule — project-memory language
 * follows the app locale; `en` is the default). The shell does not translate;
 * the labels here are the persisted vocabulary.
 */

import * as path from 'node:path'
import { cutText, type TranscriptFacts } from './digest-transcript'

// ---- Constants (all tunable knobs live here, pinned by tests) ----------------

/** 8-char session-id prefix used in the digest filename (`YYYY-MM-DD-<id8>.md`). */
export const SESSION_ID_SHORT_LEN = 8

/** Chars of a commit hash shown in the body (git's abbreviated length). */
export const SHORT_HASH_LEN = 8

/** Max commits listed in a digest body before eliding (bounds the write). */
export const DIGEST_COMMIT_CAP = 20

/** Max files listed in a digest body before eliding. */
export const DIGEST_FILE_CAP = 40

/** Cap for the free-text recap fields folded into a digest (chars). */
const RECAP_MAX_CHARS = 1500

/** Cap for the single "left off" / "next" line (chars). */
const LINE_MAX_CHARS = 500

// ---- Git evidence parsing (pure — shell runs git, this reads the bytes) ------

/** One commit parsed from the `git log` the shell runs. */
export interface DigestCommit {
  /** Full 40-char hash. */
  hash: string
  /** Abbreviated hash for display ({@link SHORT_HASH_LEN} chars). */
  shortHash: string
  /** Committer date, unix SECONDS (git `%ct`). */
  committedAt: number
  /** Commit subject line (`%s`). */
  subject: string
}

/** ASCII unit-separator between the `git log --format` fields. */
export const GIT_LOG_SEP = '\x1f'

/**
 * The exact `--format` the shell MUST pass so {@link parseGitLog} can read it:
 * `<hash>\x1f<committer-unix>\x1f<subject>`. A separator no commit subject can
 * contain, so the parse never mis-splits a subject with spaces/tabs.
 */
export const GIT_LOG_FORMAT = `%H${GIT_LOG_SEP}%ct${GIT_LOG_SEP}%s`

/**
 * Parse `git log --format=GIT_LOG_FORMAT` output into commits, newest-first (git's
 * own order). Malformed/blank lines are skipped, never thrown on.
 */
export function parseGitLog(raw: string): DigestCommit[] {
  const out: DigestCommit[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split(GIT_LOG_SEP)
    if (parts.length < 3) continue
    const hash = parts[0].trim()
    const committedAt = Number(parts[1])
    // A subject can't contain the separator, but rejoin defensively.
    const subject = parts.slice(2).join(GIT_LOG_SEP).trim()
    if (!hash || !Number.isFinite(committedAt)) continue
    out.push({ hash, shortHash: hash.slice(0, SHORT_HASH_LEN), committedAt, subject })
  }
  return out
}

/**
 * Filter to commits at or after `sinceUnixSec` (the session's start). Used when
 * there is no in-run baseline HEAD to diff against. A non-finite `since` returns
 * every commit (degrade to "all recent" rather than dropping everything).
 */
export function commitsSince(
  commits: readonly DigestCommit[],
  sinceUnixSec: number
): DigestCommit[] {
  if (!Number.isFinite(sinceUnixSec)) return [...commits]
  return commits.filter((c) => c.committedAt >= sinceUnixSec)
}

/**
 * Return the commits NEWER than `baselineHash` (exclusive). `commits` is
 * newest-first, so we take from the top until the baseline appears. Used for the
 * incremental digest: only the work done since the last digest this run. An empty
 * baseline returns every commit; a baseline not present returns every commit
 * (the whole log is "new" relative to an unknown point).
 */
export function commitsAfter(
  commits: readonly DigestCommit[],
  baselineHash: string
): DigestCommit[] {
  if (!baselineHash) return [...commits]
  const out: DigestCommit[] = []
  for (const c of commits) {
    if (
      c.hash === baselineHash ||
      c.hash.startsWith(baselineHash) ||
      baselineHash.startsWith(c.hash)
    )
      break
    out.push(c)
  }
  return out
}

/** One file's churn parsed from `git diff --numstat`. */
export interface DigestFileStat {
  /** Lines added (0 for a binary file, where git prints `-`). */
  added: number
  /** Lines deleted (0 for a binary file). */
  deleted: number
  /** The file path (a rename shows as `old => new`, kept verbatim). */
  file: string
}

/**
 * Parse `git diff --numstat` output (`<added>\t<deleted>\t<file>`) into file
 * stats. Binary files print `-`/`-` for the counts → treated as 0. Malformed
 * lines are skipped.
 */
export function parseNumstat(raw: string): DigestFileStat[] {
  const out: DigestFileStat[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0])
    const deleted = parts[1] === '-' ? 0 : Number(parts[1])
    const file = parts.slice(2).join('\t').trim()
    if (!file) continue
    out.push({
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      file
    })
  }
  return out
}

/** Roll up a file-stat list into a one-line churn summary. */
export function summarizeStats(stats: readonly DigestFileStat[]): {
  files: number
  added: number
  deleted: number
} {
  let added = 0
  let deleted = 0
  for (const s of stats) {
    added += s.added
    deleted += s.deleted
  }
  return { files: stats.length, added, deleted }
}

// ---- Filename / slug --------------------------------------------------------

/** The 8-char session-id prefix used in filenames + labels. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_SHORT_LEN)
}

/**
 * The digest page slug: `YYYY-MM-DD-<sessionId8>` — matches the `DIGEST_NAME`
 * convention `memory-core.ts` parses for the timeline (§3.2). The shell targets
 * `sessions/<slug>` via `appendMemoryEntry`.
 */
export function digestSlug(date: string, sessionId: string): string {
  return `${date}-${shortSessionId(sessionId)}`
}

// ---- Digest body helpers ----------------------------------------------------

/** Collapse whitespace + hard-cap a free-text field so the body stays bounded. */
function elide(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

/** The uncommitted-changes line of the Evidence block. */
function dirtyLine(dirtyCount: number): string {
  return `_${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'} in the working tree (not in the commits above)._`
}

/**
 * The Evidence lines for a commit-backed digest: the capped commit list, the
 * files line and the uncommitted line, as the pre-U1 digest wrote them (spec
 * Formats §3).
 */
function commitEvidenceLines(
  commits: readonly DigestCommit[],
  fileStats: readonly DigestFileStat[],
  dirtyCount: number
): string[] {
  const lines: string[] = [`**Commits (${commits.length})**`]
  if (commits.length === 0) {
    lines.push('- _(none)_')
  } else {
    for (const c of commits.slice(0, DIGEST_COMMIT_CAP)) {
      lines.push(`- \`${c.shortHash}\` ${c.subject || '(no subject)'}`)
    }
    const hiddenCommits = commits.length - DIGEST_COMMIT_CAP
    if (hiddenCommits > 0) lines.push(`- _…and ${hiddenCommits} more_`)
  }

  if (fileStats.length > 0) {
    const sum = summarizeStats(fileStats)
    lines.push('')
    lines.push(`**Files (${sum.files}, +${sum.added}/−${sum.deleted})**`)
    const shown = fileStats.slice(0, DIGEST_FILE_CAP).map((s) => `\`${s.file}\``)
    const hiddenFiles = fileStats.length - DIGEST_FILE_CAP
    const suffix = hiddenFiles > 0 ? ` _(+${hiddenFiles} more)_` : ''
    lines.push(shown.join(', ') + suffix)
  }

  if (dirtyCount > 0) {
    lines.push('')
    lines.push(dirtyLine(dirtyCount))
  }
  return lines
}

// ---- Hot proposal builder (the ≤500-word retomada snapshot) ------------------

/** Everything the hot-proposal builder needs — assembled by the shell. */
export interface HotProposalInput {
  /** `YYYY-MM-DD`. */
  date: string
  /** Session label. */
  title: string
  /** Git branch, when on one. */
  branch?: string
  /** Session commits (newest-first) — only the latest is named in the snapshot. */
  commits: readonly DigestCommit[]
  /** The freshest `last-prompt`, when present. */
  lastPrompt?: string
  /** The CLI's own recap, when present (fallback for "next"). */
  awaySummary?: string
  /** Page id of the full digest this snapshot summarizes (`sessions/<slug>`). */
  digestPage: string
}

/**
 * Build the `hot.md` snapshot — the "where we left off" retomada cue (PRD §5,
 * Parnin). Deliberately short (well under the 500-word `hot` cap in
 * `memory-core.HOT_MAX_WORDS`): NOW (what this was), LAST (commit evidence), NEXT
 * (the open thread), and a `[[link]]` to the full digest. The shell writes it to
 * `hot.md` directly after the digest, replacing the previous snapshot.
 */
export function buildHotProposal(input: HotProposalInput): string {
  const lines: string[] = []
  const title = input.title.trim() || 'Recent session'
  lines.push(`**Now:** ${elide(title, LINE_MAX_CHARS)}`)
  lines.push('')

  const branchPart = input.branch ? ` on \`${input.branch}\`` : ''
  const latest = input.commits[0]
  if (latest) {
    const n = input.commits.length
    const plural = n === 1 ? 'commit' : 'commits'
    lines.push(
      `**Last (${input.date}):** ${n} ${plural}${branchPart} — latest \`${latest.shortHash}\` ${latest.subject || '(no subject)'}`
    )
  } else {
    lines.push(`**Last (${input.date}):** no new commits${branchPart}`)
  }
  lines.push('')

  const next = (input.lastPrompt || input.awaySummary || '').trim()
  lines.push(`**Next:** ${next ? elide(next, LINE_MAX_CHARS) : '—'}`)
  lines.push('')

  lines.push(`Full digest: [[${input.digestPage}]]`)
  return lines.join('\n') + '\n'
}

// ---- Memory U1 (S-1): shared types, trigger, planner, digest body ------------

/** What the shell learned from git for one session's folder. */
export type GitEvidence =
  | {
      kind: 'repo'
      head: string | null
      commits: DigestCommit[]
      fileStats: DigestFileStat[]
      dirtyCount: number
    }
  | { kind: 'not-a-repo' }
  | { kind: 'unavailable' } // the folder is gone (orphan); S-5

/** Why a digest is being written; picks the header verb. */
export type DigestReason = 'ended' | 'idle' | 'compact' | 'catch-up' | 'orphan'

/** The relevance gate: a commit, or enough operator turns (D-1). */
export interface DigestGate {
  minCommits: number
  minUserTurns: number
}

/** The default gate: one commit, or three user turns (D-1, PRD §3.1). */
export const DIGEST_GATE: DigestGate = { minCommits: 1, minUserTurns: 3 }

/** What a hook edge asks the digest engine to do. */
export type DigestTrigger = 'digest-ended' | 'digest-compact' | 'arm-idle' | 'cancel-idle' | 'none'

/**
 * Maps one hook edge to the engine's action, in a fixed order: `PreCompact` digests whatever the
 * task state; `SessionEnd` and a completed turn digest as ended; a working or waiting session
 * cancels the idle timer; an idle one arms it; anything else does nothing.
 */
export function digestTriggerFor(edge: { event: string; taskState: string }): DigestTrigger {
  if (edge.event === 'PreCompact') return 'digest-compact'
  if (edge.event === 'SessionEnd') return 'digest-ended'
  if (edge.taskState === 'completed') return 'digest-ended'
  if (edge.taskState === 'working' || edge.taskState === 'needs-input') return 'cancel-idle'
  if (edge.taskState === 'idle') return 'arm-idle'
  return 'none'
}

export interface DigestPlanInput {
  facts: TranscriptFacts
  git: GitEvidence
  /** What this session's previous digest saw. */
  last: { head: string | null; userTurns: number } | null
  /** True for a transcript whose folder is gone (S-5). */
  orphan?: boolean
  gate?: DigestGate
}

export type DigestPlan =
  | { action: 'skip'; reason: 'insufficient' | 'unchanged' }
  | {
      action: 'write'
      evidence: 'commits' | 'no-commits' | 'no-git' | 'orphan'
      relevance: 'commits' | 'turns'
    }

/**
 * Decides whether a session gets a digest, in the spec's fixed order: the gate (commits, else
 * user turns), then dedup against the previous digest (same head and same turn count), then the
 * evidence kind. Sees no MCP verb, no memory module and no file path.
 */
export function planDigest(input: DigestPlanInput): DigestPlan {
  const gate = input.gate ?? DIGEST_GATE
  const { git, facts, last } = input
  const n = git.kind === 'repo' ? git.commits.length : 0
  let relevance: 'commits' | 'turns'
  if (n >= gate.minCommits) relevance = 'commits'
  else if (facts.userTurns >= gate.minUserTurns) relevance = 'turns'
  else return { action: 'skip', reason: 'insufficient' }

  const head = git.kind === 'repo' ? git.head : null
  if (last !== null && head === last.head && facts.userTurns === last.userTurns) {
    return { action: 'skip', reason: 'unchanged' }
  }

  let evidence: Extract<DigestPlan, { action: 'write' }>['evidence']
  if (input.orphan === true || git.kind === 'unavailable') evidence = 'orphan'
  else if (git.kind === 'not-a-repo') evidence = 'no-git'
  else evidence = n >= 1 ? 'commits' : 'no-commits'
  return { action: 'write', evidence, relevance }
}

export interface DigestRenderInput {
  /** YYYY-MM-DD, passed in. */
  date: string
  /** Cut to {@link DIGEST_TITLE_MAX} code points by renderDigest. */
  title: string
  /** Ignored when git.kind is 'not-a-repo'. */
  branch?: string
  sessionShort: string
  reason: DigestReason
  plan: Extract<DigestPlan, { action: 'write' }>
  git: GitEvidence
  facts: TranscriptFacts
  awaySummary?: string
  taskSummary?: string
  lastPrompt?: string
  /** Commits on the checkout not attributed to this session (S-4). */
  otherCommits?: number
}

/**
 * The whole digest's cap. Mirrors `memory-core.MEMORY_ENTRY_MAX_CHARS` (the cap
 * `appendMemoryEntry` checks on the entry alone, as JavaScript string length) without importing that
 * fs-bound module; a test pins the two equal.
 */
export const DIGEST_MAX_CHARS = 8_000

/** The digest title's cap (code points). */
export const DIGEST_TITLE_MAX = 200

/** The content a section is replaced with when the digest is over {@link DIGEST_MAX_CHARS}. */
export const CUT_TO_FIT = '_…cut to fit_'

const REASON_VERB: Record<DigestReason, string> = {
  ended: 'ended',
  idle: 'went idle',
  compact: 'compacted',
  'catch-up': 'caught up',
  orphan: 'recovered from a removed folder'
}

const NEWLINES = /\s*\r?\n\s*/g

/** A verbatim block: every line prefixed `> `, an empty line rendered as `>`. */
function quoteBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n')
}

/** A one-line verbatim item: newlines collapsed to one space. */
function oneLine(text: string): string {
  return text.replace(NEWLINES, ' ')
}

/** The Evidence content for the plan's evidence kind. */
function evidenceContent(input: DigestRenderInput): string {
  const { git, plan } = input
  const lines: string[] = []
  const repo = git.kind === 'repo' ? git : null
  if (plan.evidence === 'no-git') {
    lines.push('_Not a git repository: no git evidence._')
  } else if (plan.evidence === 'orphan' && !repo) {
    lines.push('_The folder was removed; git evidence is not available._')
  } else if (plan.evidence === 'no-commits') {
    lines.push('**Commits (0)** — none in this session')
    if (repo && repo.dirtyCount > 0) lines.push('', dirtyLine(repo.dirtyCount))
  } else {
    // 'commits', or 'orphan' with the orphan branch's repo evidence (S-5).
    lines.push(
      ...commitEvidenceLines(repo?.commits ?? [], repo?.fileStats ?? [], repo?.dirtyCount ?? 0)
    )
  }
  const others = input.otherCommits ?? 0
  if (others > 0) {
    const noun = others === 1 ? 'commit' : 'commits'
    lines.push(
      '',
      `_${others} other ${noun} landed on this checkout during the session (not attributed to it)._`
    )
  }
  return lines.join('\n')
}

/**
 * Renders the digest body for `sessions/<date>-<id8>.md` (spec Formats, "The digest body"): the
 * title, the header line with its evidence token, Evidence, then the session's own words — the
 * asked-and-answered pairs, the open questions, the recap, where it left off and its last
 * message — each copied verbatim as a blockquote, never translated. Over
 * {@link DIGEST_MAX_CHARS} the sections are cut from the last one up to the pairs; the title,
 * header and Evidence never are. Pure: the same input gives the same bytes. Provenance is added
 * by the memory writer, not here.
 */
export function renderDigest(input: DigestRenderInput): string {
  const title = cutText(input.title.trim() || `Session ${input.sessionShort}`, DIGEST_TITLE_MAX)
  const branchPart =
    input.branch && input.git.kind !== 'not-a-repo' ? ` · branch \`${input.branch}\`` : ''
  const header = `_Session \`${input.sessionShort}\`${branchPart} · ${REASON_VERB[input.reason]} · auto-digest · evidence: ${input.plan.evidence}_`

  // Sections 4 to 8 (index 0 to 4), each null when it has nothing to show.
  const { facts } = input
  const recapSource = [input.awaySummary, input.taskSummary, input.lastPrompt].find(
    (t): t is string => typeof t === 'string' && t.trim() !== ''
  )
  const recapKey = recapSource?.trim()
  const lastPrompt = input.lastPrompt?.trim() ?? ''
  const lastText = facts.lastAssistantText.trim()
  const sections: { heading: string; content: string | null }[] = [
    {
      heading: 'Asked and answered',
      content: facts.asked.length
        ? facts.asked
            .map((p) => `> - **Q:** ${oneLine(p.question)} — **A:** ${oneLine(p.answer)}`)
            .join('\n')
        : null
    },
    {
      heading: 'Open questions',
      content: facts.openQuestions.length
        ? facts.openQuestions.map((q) => `> - ${oneLine(q)}`).join('\n')
        : null
    },
    {
      heading: 'Recap',
      content: recapKey
        ? "_The session's own summary — context, not verified fact:_\n\n" +
          quoteBlock(cutText(recapKey, RECAP_MAX_CHARS))
        : null
    },
    {
      heading: 'Left off',
      content:
        lastPrompt && lastPrompt !== recapKey
          ? quoteBlock(cutText(lastPrompt, LINE_MAX_CHARS))
          : null
    },
    {
      heading: 'Last message',
      content: lastText && lastText !== recapKey ? quoteBlock(lastText) : null
    }
  ]

  const assemble = (): string => {
    const parts = [`# ${title}`, header, `## Evidence\n\n${evidenceContent(input)}`]
    for (const s of sections) if (s.content !== null) parts.push(`## ${s.heading}\n\n${s.content}`)
    return parts.join('\n\n') + '\n'
  }

  let out = assemble()
  for (let i = sections.length - 1; i >= 0 && out.length > DIGEST_MAX_CHARS; i--) {
    if (sections[i].content === null) continue
    sections[i].content = CUT_TO_FIT
    out = assemble()
  }
  return out
}

// ---- The memory-root guard (S-3) --------------------------------------------

/**
 * Whether the digest engine may write into the memory of `checkout` (the folder whose
 * `.harnu/memory/` would hold the digest). False for the home directory itself, the
 * filesystem root, and anything inside `<home>/.claude` (Claude Code's data) or
 * `<home>/.harnu` (the global memory layer, ADR-0024), so a session started in one of
 * those never gets a digest written there. Pure path math: no fs.
 */
export function digestTargetAllowed(checkout: string, home: string): boolean {
  void checkout
  void home
  void path
  throw new Error('not implemented')
}
