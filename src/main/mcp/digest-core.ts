/**
 * Pure core for the automatic session digest (T79 S2): the deterministic
 * relevance threshold, git-evidence parsing, the evidence-linked digest markdown
 * formatter, and the proposed-`hot.md` snapshot builder.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell): NO
 * `fs`, `child_process`, `electron`, or clock. The shell (`../memory-digest.ts`)
 * probes git + reads the transcript and feeds the bytes + an injected `now` in
 * here, so every gate/format decision is deterministic and lands in the coverage
 * surface (`tests/mcp-digest-core.test.ts`).
 *
 * Design contract (PRD §3.4 + §5):
 *  - The digest is EVIDENCE-linked — commits, file stats, the CLI's own recap —
 *    NOT a narrative self-report. The `## Evidence` block is hard git truth; the
 *    `## Recap` block is clearly framed as the session's OWN words (self-report
 *    lies in 22.6% of episodes — PRD §5), never presented as fact.
 *  - The relevance gate LEADS with commit-count — the strongest done-by-evidence
 *    signal (PRD §5). It is a single tunable config so the threshold is pinned by
 *    a unit test and documented, not scattered as a magic number.
 *  - The `hot` snapshot is a PROPOSAL only: the human accepts it in the Approval
 *    Inbox; it is never written silently (PRD §3.4 — "suggested, not silent").
 *
 * Content is written in English by default (T85 rule — project-memory language
 * follows the app locale; `en` is the default). The shell does not translate;
 * the labels here are the persisted vocabulary.
 */

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

// ---- Relevance gate (§3.4 — "trabalho relevante"; §5 — done-by-evidence) ----

/** The measurable work a session produced, as probed by the shell from git. */
export interface SessionWorkSignals {
  /** Commits attributable to THIS session on its branch (the primary signal). */
  commitCount: number
  /** Distinct files changed across those commits (context, not a gate). */
  filesChanged: number
  /** Uncommitted working-tree files (supplementary evidence, never a gate). */
  dirtyCount: number
}

/**
 * The relevance threshold (PRD open-question §8.2). Commit-count is the only gate
 * by default: uncommitted churn and idle duration are narrative, not evidence, so
 * a session that ran long but produced nothing never spams a digest. Kept as a
 * config object (not a literal) so the threshold is a single documented,
 * unit-pinned knob the shell can override.
 */
export interface DigestRelevanceConfig {
  /** Minimum session commits for a digest to be worth writing. */
  minCommits: number
}

/** The default: ≥1 commit — the strongest done-by-evidence signal (PRD §5). */
export const DEFAULT_DIGEST_RELEVANCE: DigestRelevanceConfig = { minCommits: 1 }

/** Why a session was (or wasn't) judged worth a digest. */
export type RelevanceReason = 'commits' | 'insufficient'

/** Outcome of {@link isRelevantWork}. */
export interface RelevanceVerdict {
  relevant: boolean
  reason: RelevanceReason
}

/**
 * Decide whether a session did enough to warrant a digest. Pure: the shell
 * supplies the git-probed signals. Commit-count leads (§5): ≥`minCommits`
 * commits ⇒ relevant. Everything else ⇒ not relevant (so the digest never fires
 * on time-in-seat alone, and a later commit can still trigger it).
 */
export function isRelevantWork(
  signals: SessionWorkSignals,
  config: DigestRelevanceConfig = DEFAULT_DIGEST_RELEVANCE
): RelevanceVerdict {
  if (signals.commitCount >= config.minCommits) return { relevant: true, reason: 'commits' }
  return { relevant: false, reason: 'insufficient' }
}

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

// ---- Digest formatter (the evidence-linked body) ----------------------------

/** Whether the digest was triggered by the session ending or going long-idle. */
export type DigestEndReason = 'ended' | 'idle'

/** Everything the formatter needs — assembled by the shell from git + transcript. */
export interface DigestInput {
  /** `YYYY-MM-DD` (server clock). */
  date: string
  /** Session label (custom/ai title, else a fallback) — the `# ` heading. */
  title: string
  /** Git branch the work landed on (omitted when detached / not a repo). */
  branch?: string
  /** 8-char session-id prefix. */
  sessionShort: string
  /** Trigger — renders "ended" vs "went idle". */
  endReason: DigestEndReason
  /** The CLI's own "Goal:… Next:…" recap (verbatim), when present (T91 §4). */
  awaySummary?: string
  /** The `task-summary` entry text, when present (T91 §3). */
  taskSummary?: string
  /** The freshest `last-prompt`, when present (T91 §3). */
  lastPrompt?: string
  /** Session commits (newest-first) — the primary evidence. */
  commits: readonly DigestCommit[]
  /** Aggregate file churn across those commits. */
  fileStats: readonly DigestFileStat[]
  /** Uncommitted working-tree file count (supplementary). */
  dirtyCount: number
}

/** Collapse whitespace + hard-cap a free-text field so the body stays bounded. */
function elide(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

/** The best available session recap, framed as the session's OWN words. */
function recapText(input: DigestInput): string {
  const src = input.awaySummary || input.taskSummary || input.lastPrompt || ''
  return src ? elide(src, RECAP_MAX_CHARS) : ''
}

/**
 * Build the evidence-linked digest markdown for `sessions/<slug>.md`. The body
 * has three parts, in trust order: a one-line header, the git `## Evidence`
 * (hard truth), then the session's own `## Recap` (clearly framed as self-report,
 * never as fact). Starts with a `# ` heading so `memory-core.parseDigestMeta`
 * reads it as the timeline title. Provenance is NOT added here — the memory
 * writer (`appendMemoryEntry`) stamps it server-side.
 *
 * Caps the commit + file lists ({@link DIGEST_COMMIT_CAP} / {@link DIGEST_FILE_CAP})
 * and LOGS the elision inline ("+N more") — never a silent truncation.
 */
export function formatDigest(input: DigestInput): string {
  const lines: string[] = []
  const title = input.title.trim() || `Session ${input.sessionShort}`
  lines.push(`# ${title}`)
  lines.push('')

  // One-line header: what/where/why-now, all facts.
  const verb = input.endReason === 'ended' ? 'ended' : 'went idle'
  const branchPart = input.branch ? ` · branch \`${input.branch}\`` : ''
  lines.push(`_Session \`${input.sessionShort}\`${branchPart} · ${verb} · auto-digest_`)
  lines.push('')

  // Evidence — the hard git truth (never self-report).
  lines.push('## Evidence')
  const commits = input.commits
  lines.push(`**Commits (${commits.length})**`)
  if (commits.length === 0) {
    lines.push('- _(none)_')
  } else {
    for (const c of commits.slice(0, DIGEST_COMMIT_CAP)) {
      lines.push(`- \`${c.shortHash}\` ${c.subject || '(no subject)'}`)
    }
    const hiddenCommits = commits.length - DIGEST_COMMIT_CAP
    if (hiddenCommits > 0) lines.push(`- _…and ${hiddenCommits} more_`)
  }

  if (input.fileStats.length > 0) {
    const sum = summarizeStats(input.fileStats)
    lines.push('')
    lines.push(`**Files (${sum.files}, +${sum.added}/−${sum.deleted})**`)
    const shown = input.fileStats.slice(0, DIGEST_FILE_CAP).map((s) => `\`${s.file}\``)
    const hiddenFiles = input.fileStats.length - DIGEST_FILE_CAP
    const suffix = hiddenFiles > 0 ? ` _(+${hiddenFiles} more)_` : ''
    lines.push(shown.join(', ') + suffix)
  }

  if (input.dirtyCount > 0) {
    lines.push('')
    lines.push(
      `_${input.dirtyCount} uncommitted change${input.dirtyCount === 1 ? '' : 's'} in the working tree (not in the commits above)._`
    )
  }

  // Recap — the session's OWN words (self-report; framed, never trusted as fact).
  const recap = recapText(input)
  if (recap) {
    lines.push('')
    lines.push('## Recap')
    lines.push("_The session's own summary — context, not verified fact:_")
    lines.push('')
    lines.push(recap)
  }

  // Left off — the freshest open thread (the retomada cue).
  const leftOff = input.lastPrompt ? elide(input.lastPrompt, LINE_MAX_CHARS) : ''
  if (leftOff && leftOff !== recap) {
    lines.push('')
    lines.push('## Left off')
    lines.push(leftOff)
  }

  return lines.join('\n') + '\n'
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
 * Build the PROPOSED `hot.md` snapshot — the "where we left off" retomada cue
 * (PRD §5, Parnin). Deliberately short (well under the 500-word `hot` cap in
 * `memory-core.HOT_MAX_WORDS`): NOW (what this was), LAST (commit evidence), NEXT
 * (the open thread), and a `[[link]]` to the full digest. This is a PROPOSAL —
 * the shell surfaces it in the Approval Inbox and only writes it to `hot.md` on
 * the human's Accept (PRD §3.4).
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
