import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Confidentiality gate (T253) — see CLAUDE.md § "Client confidentiality".
 *
 * Harnu is open source and its specs are written from live evidence, which is
 * exactly how a client's tracker keys and repo layout got into the tree in the
 * first place. This asserts they are not there any more.
 *
 * It is deliberately **shape-based, not name-based**. A denylist of real client
 * names would have to spell those names out to match them, putting back into the
 * tracked tree the very strings it exists to remove — and it would still be blind
 * to the next client. So each gate matches the *form* of an identifier and
 * allowlists the neutral vocabulary, which means an unknown client's `XYZ-1234`
 * or `~/Workspace/<their-name>/` fails the first time it is committed.
 *
 * When a gate fires on something genuinely innocent, add that token to the
 * allowlist — never widen the pattern, and never delete the gate.
 *
 * It greps the tracked tree rather than walking directories, so an untracked
 * scratch file never trips it and a newly committed leak always does.
 *
 * The sweep is binary-safe (`--text`, never `-I`). A single NUL byte anywhere in a
 * source file — a deliberate slugify fixture, say — makes git classify the whole file
 * as binary, and `-I` skips it wholesale. That is not hypothetical: it is exactly how
 * `tests/branch-slug.test.ts` carried a client ticket key and its full title straight
 * through the first pass of this scrub while every gate here stayed green.
 */

const REPO_ROOT = resolve(__dirname, '..')

/**
 * Paths the sweep skips.
 *
 * `package-lock.json` is generated dependency metadata; its base64 integrity hashes
 * trip any short pattern. This file is excluded from its own scan so the patterns it
 * declares are not themselves hits.
 *
 * The rest are true binary assets. Because the sweep is `--text`, their bytes are read
 * as mojibake and a long enough font or PNG will eventually spell something shaped like
 * a tracker key. They are excluded **by extension**, never by asking git whether a file
 * looks binary: a text file git misclassifies — a fixture carrying a stray NUL — is
 * exactly the leak class this gate exists to catch, so it must stay in scope.
 */
const EXCLUDED = [
  ':!package-lock.json',
  // Generated from upstream license files (scripts/gen-third-party-notices.mjs):
  // third-party text, not this project's, and full of `draft-2019`-shaped tokens.
  ':!THIRD-PARTY-NOTICES.md',
  ':!tests/no-client-identifiers.test.ts',
  ':!*.png',
  ':!*.ico',
  ':!*.icns',
  ':!*.woff2',
  ':!*.wav'
]

/** Tracker-key prefixes that are the repo's own or the documented neutral placeholders. */
const ALLOWED_UPPER_PREFIXES = [
  'AC', // acceptance criteria — AC-1
  'ACME', // neutral placeholder (CLAUDE.md)
  'ADR', // ADR-0012
  'BCP', // BCP-47, a standard's name
  'BUG', // this repo's own bug cards
  'GUID', // prose, not a key
  'ISO', // ISO-8601, a standard's name
  'PR', // PR-123 in examples
  'PROJ', // neutral placeholder (CLAUDE.md)
  'TASK', // neutral placeholder, pre-existing
  'UPDATE', // constant names
  'XYZ', // the "unknown client" placeholder used to describe this gate itself
  'XX' // literal placeholder
]

/**
 * Lowercase branch-slug forms of the above, plus the non-key `word-nn` strings
 * the tracked tree already carries. This gate matches the SAME digit range as the
 * uppercase one on purpose: a tracker key does not stop being one because it was
 * slugified into a branch name, and the keys this repo actually leaked spanned both
 * ends of that range — a 3-digit and a 5-digit form (`PROJ-231` and `ACME-10996` in
 * the neutral vocabulary). A narrower lowercase range would let the branch form of a
 * short key back in while the uppercase form stayed blocked.
 *
 * Naming the real prefixes here would defeat the file: this gate exists to keep client
 * identifiers out of the tracked tree, so its own docstring must be written in the
 * neutral vocabulary too.
 */
const ALLOWED_LOWER_PREFIXES = [
  'abc',
  'acme',
  // `at` / `rv`: element ids of the promoted Workspace GC mockup (`treemap-at-64`, `rv-18`) — layout
  // names, not tracker keys.
  'at',
  'rv',
  // `pt`: a Tailwind padding utility (`pt-18`), not a tracker key.
  'pt',
  'agent',
  'agents',
  'argv',
  'bug',
  'capy', // pre-rename product name — kept while historical docs still carry it
  'harnu',
  'claude',
  'exit',
  'forged',
  'id',
  'idx',
  'lead',
  'lesson',
  'non',
  'orch',
  'over',
  'pb',
  'port',
  'pr',
  'pre',
  'proj',
  'pty',
  'px',
  'py',
  'real',
  'record',
  'review',
  'rollup',
  'rotate',
  'run',
  'sess',
  'socks',
  // T358: a Mission step id (`stp-<n>`, design §1.2) — Harnu's own vocabulary.
  'stp',
  'task',
  'to',
  'uuid'
]

/** Directory names allowed directly under a `Workspace/` path in an example. */
const ALLOWED_WORKSPACE_DIRS = [
  'capy', // pre-rename checkout dir — kept while historical docs still carry it
  'harnu',
  'example-client',
  'jnieltn', // the author's own namespace, not a client
  'me', // neutral stand-in for the author's own namespace
  'org', // neutral placeholder (CLAUDE.md)
  'repo',
  'sandbox'
]

/**
 * Same, for the `-home-u-Workspace-<org>-<repo>` slug form Claude Code uses as a
 * project directory name. `-` is the separator there, so the segment stops at the
 * first one and `example-client` reads as `example`.
 */
const ALLOWED_WORKSPACE_SLUG_SEGMENTS = [
  'capy',
  'harnu',
  'example',
  'jnieltn',
  'me',
  'org',
  'repo',
  'sandbox'
]

/**
 * The shape gates above cannot see a bare name: a client written as a plain word in a
 * mockup row or a worked example has no key shape and no `Workspace/` prefix. That gap
 * is real — it let two client names and a private product name sit in `design.md` and
 * two specs through every earlier sweep.
 *
 * Closing it with names spelled out in this file would defeat the gate (see the top of
 * the file), so the names live in a local, untracked denylist instead:
 * `.harnu/private-denylist.txt`, one term per line, `#` for comments. `.harnu/` is
 * gitignored, so the list never enters the tree. On a maintainer machine that has the
 * file, every term is matched as a whole word, case-insensitively, across the tracked
 * tree. Anywhere the file is absent — CI, a contributor's clone — this check is skipped.
 */
const PRIVATE_DENYLIST = resolve(REPO_ROOT, '.harnu/private-denylist.txt')

function denylistTerms(): string[] {
  if (!existsSync(PRIVATE_DENYLIST)) return []
  return readFileSync(PRIVATE_DENYLIST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

/** Tracked files that contain a denylisted term, with the term itself masked. */
function denylistHits(terms: string[]): string[] {
  const args = ['grep', '--text', '-n', '-i', '-w', '-F']
  for (const t of terms) args.push('-e', t)
  try {
    const out = execFileSync('git', [...args, '--', '.', ...EXCLUDED], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    // Report file:line only. Echoing the line would print the name into CI logs.
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(':').slice(0, 2).join(':'))
      .slice(0, 20)
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1 && !e.stdout) return []
    throw err
  }
}

function grepTracked(pattern: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '--text', '-h', '-o', '-E', pattern, '--', '.', ...EXCLUDED],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      }
    )
    return out.split('\n').filter(Boolean)
  } catch (err) {
    // `git grep` exits 1 with no output when nothing matched — that is the pass.
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1 && !e.stdout) return []
    throw err
  }
}

/** Where a violating token actually is, so a failure is actionable. */
function locate(pattern: string, token: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '--text', '-n', '-E', pattern, '--', '.', ...EXCLUDED],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      }
    )
    return out.split('\n').filter((l) => l.includes(token))
  } catch {
    return []
  }
}

function offenders(pattern: string, allowed: string[], strip: RegExp): string[] {
  const seen = new Set<string>()
  for (const hit of grepTracked(pattern)) {
    const prefix = hit.replace(strip, '')
    if (!allowed.includes(prefix)) seen.add(hit)
  }
  return [...seen].flatMap((t) => locate(pattern, t)).slice(0, 20)
}

describe('tracked tree carries no client identifiers', () => {
  it('has no tracker key outside the neutral vocabulary', () => {
    expect(offenders('\\b[A-Z]{2,6}-[0-9]{2,6}\\b', ALLOWED_UPPER_PREFIXES, /-[0-9]+$/)).toEqual([])
  })

  it('has no lowercase branch slug of a tracker key outside the neutral vocabulary', () => {
    expect(offenders('\\b[a-z]{2,6}-[0-9]{2,6}\\b', ALLOWED_LOWER_PREFIXES, /-[0-9]+$/)).toEqual([])
  })

  it('has no client or employer directory under a Workspace path', () => {
    expect(offenders('Workspace/[A-Za-z0-9_.-]+', ALLOWED_WORKSPACE_DIRS, /^Workspace\//)).toEqual(
      []
    )
  })

  it.skipIf(!existsSync(PRIVATE_DENYLIST))('has no term from the local private denylist', () => {
    expect(denylistHits(denylistTerms())).toEqual([])
  })

  it('has no client or employer segment in a Workspace project slug', () => {
    expect(
      offenders('Workspace-[a-z][a-z0-9]*', ALLOWED_WORKSPACE_SLUG_SEGMENTS, /^Workspace-/)
    ).toEqual([])
  })
})
