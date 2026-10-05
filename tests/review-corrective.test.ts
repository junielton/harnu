// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import {
  composeCompanionAppend,
  composeReviewCorrective,
  correctiveFromSnapshot,
  sanitizeCorrective,
  withReviewCorrective,
  CORRECTIVE_OPEN,
  CORRECTIVE_CLOSE,
  OPERATOR_OPEN,
  OPERATOR_CLOSE,
  UNKNOWN_CORRECTIVE,
  type ReviewCorrective
} from '../src/main/review-corrective'
import { buildClaudeArgs, forceReadOnlyPermission } from '../src/main/claude-args'
import { assembleEvidence, parseUnifiedDiff } from '../src/main/review-core'
import { resolvePrHead, type GitRun } from '../src/main/review-head'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * T247 (T245 U2) — the review companion must know that it is blind.
 *
 * The thing under test is a CORRECTIVE, not a briefing. The session was never
 * harmed by lacking context; it was harmed by guessing from `git status` and
 * being right about the folder while wrong about the review. So what these tests
 * defend is mostly what the corrective must NOT say — §4.1's exclusion list is
 * normative, and a test suite that only checked the happy string would let the
 * rejected briefing back in one field at a time.
 *
 * ACs: AC-20..AC-25 and AC-29..AC-31. AC-26/AC-27/AC-28 have their own homes
 * (`review-companion.test.ts`, the BUG-94 blocks); AC-32 is `verify: manual,
 * recorded` and cannot be a test — it is the only criterion that proves the
 * feature WORKS rather than that strings appear in strings.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** Source with comments stripped: prose ABOUT a rule is not a violation of it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')
}

const BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98'

function corrective(over: Partial<ReviewCorrective> = {}): ReviewCorrective {
  return { headSha: HEAD, baseSha: BASE, state: 'ready', isRepo: true, prNumber: null, ...over }
}

/**
 * Every state §4.4 names, as a fixture matrix. Each row is a real branch in the
 * code and a real thing that happens in the app — `not-fetched` is the DEFAULT
 * on open, because the pane fetches only on the refresh gesture.
 */
const STATES: Array<{ name: string; input: ReviewCorrective }> = [
  { name: 'ready (the happy path)', input: corrective() },
  { name: 'ready, with a PR', input: corrective({ prNumber: 246 }) },
  { name: 'not fetched (the default on open)', input: corrective({ state: 'not-fetched' }) },
  { name: 'fetch failed', input: corrective({ state: 'fetch-failed' }) },
  { name: 'base unresolved', input: corrective({ state: 'base-unresolved', baseSha: null }) },
  { name: 'not a git work tree', input: corrective({ isRepo: false }) },
  {
    name: 'isRepo false but state ready (emptySnapshot’s exact shape)',
    input: corrective({ isRepo: false, state: 'ready', baseSha: null, headSha: null })
  },
  { name: 'ready but no head sha resolved', input: corrective({ headSha: null }) },
  { name: 'ready but no base sha resolved', input: corrective({ baseSha: null }) },
  { name: 'nothing resolved at all', input: UNKNOWN_CORRECTIVE }
]

// ── AC-20 ───────────────────────────────────────────────────────────────────

describe('AC-20 — the session is told the cwd is unrelated, and given the range', () => {
  it('names the negative fact and the exact command', () => {
    const text = composeReviewCorrective(corrective())
    expect(text).toMatch(/HEAD is unrelated/i)
    // The negative fact has to name the commands the session would otherwise
    // reach for — "your cwd is different" is not actionable, "git status here
    // describes something else" is.
    for (const cmd of ['git status', 'git branch', 'git log']) {
      expect(text).toContain(cmd)
    }
    expect(text).toContain(`git diff ${BASE}...${HEAD}`)
  })

  it('a folder whose HEAD differs from the reviewed head still gets one range, not two', () => {
    // The defect in one line: the folder is on `main`, the review is of a PR
    // head 38 commits away, and nothing in the corrective refers to the folder.
    const text = composeReviewCorrective(corrective({ prNumber: 246 }))
    expect(text).toContain(`git diff ${BASE}...${HEAD}`)
    expect(text).toContain('#246')
    // No location claim of any kind (§4.5): the companion spawns in the folder
    // the operator requested while a PR review re-resolves to the repo's MAIN
    // worktree, so any sentence about WHERE it stands can be wrong.
    expect(text).not.toMatch(/you are in|your working directory is|located in|cwd is `/i)
  })
})

// ── AC-21 ───────────────────────────────────────────────────────────────────

describe('AC-21 — delivered via appendSystemPrompt; no user turn, ever', () => {
  it('lands on --append-system-prompt and leaves no positional tail', () => {
    const argv = buildClaudeArgs(
      ['--session-id', 'u'],
      withReviewCorrective(forceReadOnlyPermission({}), corrective())
    )
    const at = argv.indexOf('--append-system-prompt')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toContain(CORRECTIVE_OPEN)
    // A bare `--` means everything after it is a POSITIONAL — a first USER turn.
    // Its absence is the structural form of "the session still never speaks
    // first", and it is what keeps the transcript free of Harnu's words (AC-30).
    expect(argv).not.toContain('--')
  })

  it('an operator pre-prompt cannot smuggle a user turn onto this path', () => {
    const argv = buildClaudeArgs(
      ['--session-id', 'u'],
      withReviewCorrective(
        forceReadOnlyPermission({ prePrompt: 'summarise this PR and tell me if it is safe' }),
        corrective()
      )
    )
    expect(argv).not.toContain('--')
    expect(argv.join(' ')).not.toContain('summarise this PR')
  })

  it('the corrective tells the session not to speak until asked', () => {
    // Belt to the argv braces: even as system-prompt text, an orientation the
    // model reads as a request produces the auto-summary PRD §2 forbids.
    const text = composeReviewCorrective(corrective())
    expect(text).toMatch(/not a request/i)
    expect(text).toMatch(/until the operator asks/i)
  })

  it('no source file on this path writes a prompt into the PTY', () => {
    for (const rel of [
      'src/main/review-corrective.ts',
      'src/renderer/src/stores/helpers.ts',
      'src/renderer/src/components/ReviewPane.vue'
    ]) {
      expect(codeOnly(read(rel)), `${rel} reaches for ptyWrite`).not.toContain('ptyWrite')
    }
  })
})

// ── AC-22 ───────────────────────────────────────────────────────────────────

describe('AC-22 — content neutrality, across the whole fixture matrix', () => {
  /**
   * Tested to T243 AC-8's standard: over every state, not as a grep against one
   * rendered template. The exclusion list in spec §4.1 is NORMATIVE — every item
   * here is triage substrate, and Claude-authored triage of "which files matter"
   * is an unresolved product decision that must not be settled as the side
   * effect of a context fix.
   */
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['CI state', /\b(check|checks|CI|passing|failing|green|red)\b/i],
    ['PR/review state', /\b(draft|mergeable|approved|changes requested|review decision)\b/i],
    ['commit counts', /\b\d+\s+commits?\b/i],
    ['file counts', /\b\d+\s+files?\b/i],
    ['± counts', /[+−-]\d+\s*\/\s*[+−-]?\d+|\b\d+\s+(insertions?|deletions?|additions?)\b/i],
    ['a verdict', /\b(looks good|seems fine|risky|suspicious|recommend|should approve)\b/i]
  ]

  for (const { name, input } of STATES) {
    it(`says nothing evaluative for: ${name}`, () => {
      const text = composeReviewCorrective(input)
      for (const [label, re] of FORBIDDEN) {
        expect(text, `${name} leaks ${label}`).not.toMatch(re)
      }
    })
  }

  it('is deterministic in its five inputs and blind to everything else', () => {
    // The structural proof, not a wording one: build a full snapshot with a
    // large diff, a rich evidence header and a file list, project it, and show
    // the output is identical to one built from the five scalars alone.
    const files = parseUnifiedDiff(
      `diff --git a/src/secret.ts b/src/secret.ts\n--- a/src/secret.ts\n+++ b/src/secret.ts\n@@ -1 +1 @@\n-old\n+new\n`
    )
    const snapshot = {
      folder: '/repos/harnu',
      branch: 'fix/topbar-drag-region',
      base: 'main',
      baseSha: BASE,
      head: {
        kind: 'pr' as const,
        name: 'fix/topbar-drag-region',
        ref: 'refs/harnu/pr/246',
        sha: HEAD,
        state: 'ready' as const,
        prNumber: 246,
        freshness: 'moved' as const,
        fetchedAt: 1,
        fetchFailed: false
      },
      isRepo: true,
      evidence: assembleEvidence({
        branch: 'fix/topbar-drag-region',
        base: 'main',
        revListCount: '38\n',
        behindCount: '0\n',
        numstat: '9\t3\tsrc/secret.ts\n',
        nameStatus: 'M\tsrc/secret.ts\n',
        porcelain: '',
        remotes: 'origin\n',
        prListJson: '[]',
        session: null
      }),
      files,
      truncated: true,
      omittedFiles: ['src/omitted.ts'],
      totalRows: 60_001
    }
    const text = composeReviewCorrective(correctiveFromSnapshot(snapshot))
    expect(text).toBe(
      composeReviewCorrective({
        headSha: HEAD,
        baseSha: BASE,
        state: 'ready',
        isRepo: true,
        prNumber: 246
      })
    )
    // Concretely: none of the rich half of that snapshot survives the projection.
    for (const leak of ['secret.ts', 'omitted.ts', 'fix/topbar-drag-region']) {
      expect(text, `leaked ${leak}`).not.toContain(leak)
    }
    // Word-bounded, so a digit pair that happens to sit inside a SHA is not
    // mistaken for a count that leaked.
    expect(text, 'leaked the commit count').not.toMatch(/\b38\b/)
    expect(text, 'leaked the row count').not.toMatch(/\b60001\b/)
  })

  it('says nothing that implies the pane is showing the whole diff', () => {
    // §4.4: `omittedFiles` drops whole files and `totalRows` is a ROW count, so
    // a corrective that reads as "this is all of it" is a confident lie. The
    // sentence is unconditional so it carries no information about truncation.
    const truncated = composeReviewCorrective(corrective())
    expect(truncated).toMatch(/may be showing only part of it/i)
  })

  it('the field itself is five scalars, so nothing else can be sent', () => {
    expect(Object.keys(sanitizeCorrective({})).sort()).toEqual(
      ['baseSha', 'headSha', 'isRepo', 'prNumber', 'state'].sort()
    )
    // Main re-narrows on arrival: a caller that hands over a whole snapshot gets
    // the five scalars anyway, so AC-22 is a property of main rather than a
    // promise about the renderer.
    const smuggled = sanitizeCorrective({
      headSha: HEAD,
      baseSha: BASE,
      state: 'ready',
      isRepo: true,
      prNumber: 1,
      files: ['src/secret.ts'],
      evidence: { ci: 'failing' }
    })
    expect(smuggled).not.toHaveProperty('files')
    expect(smuggled).not.toHaveProperty('evidence')
    expect(composeReviewCorrective(smuggled)).not.toContain('secret.ts')
  })
})

// ── AC-23 ───────────────────────────────────────────────────────────────────

describe('AC-23 — identity is SHAs, never a ref name', () => {
  /**
   * `refs/harnu/pr/<n>` is force-overwritten by every refresh
   * (`review-head.ts#fetchPrHead` uses a `+` refspec), so a corrective naming the
   * ref keeps SUCCEEDING against different content. A stale command that errors
   * makes a session ask; a stale command that WORKS makes it guess, which is the
   * defect one layer up. Commit SHAs are immutable.
   */
  for (const { name, input } of STATES) {
    it(`emits no ref name for: ${name}`, () => {
      const text = composeReviewCorrective(input)
      expect(text).not.toMatch(/refs\//)
      expect(text).not.toMatch(/\borigin\//)
      expect(text).not.toMatch(/\bpull\/\d+\/head\b/)
    })
  }

  it('a ref name in a SHA field is rejected rather than rendered', () => {
    const text = composeReviewCorrective(
      sanitizeCorrective({
        headSha: 'refs/harnu/pr/246',
        baseSha: 'origin/main',
        state: 'ready',
        isRepo: true,
        prNumber: 246
      })
    )
    expect(text).not.toContain('refs/harnu/pr/246')
    expect(text).not.toContain('origin/main')
    // Falls back to "cannot be named" rather than emitting a half-formed range.
    expect(text).toMatch(/cannot be named from here/i)
  })

  it('the snapshot now carries the head SHA the corrective needs', async () => {
    // T244 AC-6's plumbing, landed here: `resolvePrHead` used to derive the
    // local oid purely for `freshness` and throw it away.
    const git: GitRun = async (args) =>
      args[0] === 'rev-parse' ? `${HEAD}\n` : args[0] === 'reflog' ? 'HEAD@{1700000000}' : ''
    const head = await resolvePrHead(
      git,
      { number: 246, headRefName: 'fix/topbar', baseRefName: 'main', headOid: HEAD },
      { fetch: false }
    )
    expect(head.state).toBe('ready')
    expect(head.sha).toBe(HEAD)
  })
})

// ── AC-24 ───────────────────────────────────────────────────────────────────

describe('AC-24 — every unreadable state names its state and no unresolvable ref', () => {
  const UNREADABLE = STATES.filter(
    ({ input }) => !(input.isRepo && input.state === 'ready' && input.baseSha && input.headSha)
  )

  for (const { name, input } of UNREADABLE) {
    it(`refuses to name a range, and says why, for: ${name}`, () => {
      const text = composeReviewCorrective(input)
      expect(text).toMatch(/cannot be named from here/i)
      // Never a half-formed command with an empty side — the `isRepo: false`
      // trap, where `emptySnapshot` reports `state: 'ready'` with `ref: ''` and a
      // `state`-first guard emits `git diff main...`.
      expect(text).not.toMatch(/git diff \S*\.\.\.\s*$/m)
      expect(text).not.toContain('git diff  ')
      // And it tells the session what to do instead of guessing, which is the
      // entire point: a session with no information asks.
      expect(text).toMatch(/ask the operator/i)
    })
  }

  it('names each state distinctly, so "why" is answerable', () => {
    expect(composeReviewCorrective(corrective({ state: 'not-fetched' }))).toMatch(
      /not been fetched/i
    )
    expect(composeReviewCorrective(corrective({ state: 'fetch-failed' }))).toMatch(
      /fetching .* failed/i
    )
    expect(composeReviewCorrective(corrective({ state: 'base-unresolved' }))).toMatch(
      /base .* did not resolve/i
    )
    expect(composeReviewCorrective(corrective({ isRepo: false }))).toMatch(/not a git work tree/i)
  })

  it('a detached HEAD cannot be presented as a branch name', () => {
    // `head.name` is a short SHA on a detached HEAD (§4.4). The corrective never
    // reads `name` at all — there is no field for it — so this holds by
    // construction, and this test is what keeps that door shut.
    expect(Object.keys(UNKNOWN_CORRECTIVE)).not.toContain('name')
    expect(Object.keys(UNKNOWN_CORRECTIVE)).not.toContain('branch')
    expect(read('src/main/review-corrective.ts')).not.toMatch(/\bhead\.name\b/)
  })
})

// ── AC-25 ───────────────────────────────────────────────────────────────────

describe("AC-25 — the operator's own text is delimited, not merged", () => {
  /**
   * Accumulation is a HAZARD here. `appendSystemPrompt` is in
   * `ACCUMULATE_TEXT_KEYS`, and the operator's global/folder text lands FIRST —
   * so without a fence, a folder prompt ("always run the tests and fix what
   * fails") reads as the opening instruction of a read-only stranger that cannot
   * fix anything.
   */
  const OWN = 'always run the tests and fix what fails'

  it('keeps the operator’s append, fenced and attributed', () => {
    const composed = composeCompanionAppend(OWN, corrective())
    expect(composed).toContain(OWN)
    // Never discarded — that would be a silent override of their setting.
    expect(composed.indexOf(OPERATOR_OPEN)).toBeLessThan(composed.indexOf(OWN))
    expect(composed.indexOf(OWN)).toBeLessThan(composed.indexOf(OPERATOR_CLOSE))
    // Fenced OUTSIDE the corrective, never inside it.
    expect(composed.indexOf(OPERATOR_CLOSE)).toBeLessThan(composed.indexOf(CORRECTIVE_OPEN))
    const block = composed.slice(composed.indexOf(CORRECTIVE_OPEN))
    expect(block).not.toContain(OWN)
  })

  it('states the precedence explicitly, and puts the corrective last', () => {
    const composed = composeCompanionAppend(OWN, corrective())
    expect(composed).toMatch(/authored by Harnu, not by the operator/i)
    expect(composed).toMatch(/does not grant write access/i)
    expect(composed.trimEnd().endsWith(CORRECTIVE_CLOSE)).toBe(true)
  })

  it('emits no empty operator fence when there is nothing to fence', () => {
    for (const empty of [undefined, '', '   ']) {
      const composed = composeCompanionAppend(empty, corrective())
      expect(composed).not.toContain(OPERATOR_OPEN)
      expect(composed.startsWith(CORRECTIVE_OPEN)).toBe(true)
    }
  })

  it('survives the real merge chain, with the Harnu preamble in front', () => {
    const argv = buildClaudeArgs(
      ['--session-id', 'u'],
      withReviewCorrective(forceReadOnlyPermission({ appendSystemPrompt: OWN }), corrective()),
      'HARNU PREAMBLE'
    )
    const value = argv[argv.indexOf('--append-system-prompt') + 1]
    expect(value.indexOf('HARNU PREAMBLE')).toBeLessThan(value.indexOf(OPERATOR_OPEN))
    expect(value.indexOf(OPERATOR_OPEN)).toBeLessThan(value.indexOf(CORRECTIVE_OPEN))
  })
})

// ── AC-29 / AC-30 ───────────────────────────────────────────────────────────

describe('AC-29 — the corrective does not survive promotion', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('the promoted pane is an ordinary claude pane with no orientation on it', () => {
    const helpers = useHelpersStore()
    const sessions = useSessionsStore()
    const paneId = helpers.addReviewCompanionHelper(
      '/repos/harnu',
      '/repos/harnu',
      corrective({ prNumber: 246 })
    )
    const before = helpers.byWorktree.get('/repos/harnu')!.panes[0] as { sessionId: string }
    sessions.folders = [
      {
        path: '/repos/harnu',
        alias: 'harnu',
        expanded: true,
        sessions: [{ sessionId: before.sessionId, projectPath: '/repos/harnu' }]
      }
    ] as never

    const newId = helpers.promoteReviewCompanion('/repos/harnu', paneId)
    const after = helpers.byWorktree.get('/repos/harnu')!.panes.find((p) => p.id === newId)!

    // Promotion is a REPLACEMENT, so the orientation goes with the pane it was
    // captured on. A promoted session describing a read-only posture it no
    // longer has, about a review that was just closed, would be worse than
    // silence — it would be confidently wrong in both halves.
    expect(after.type).toBe('claude')
    expect(after).not.toHaveProperty('corrective')
  })

  it('only the read-only spawn path composes one at all', () => {
    const pty = codeOnly(read('src/main/pty.ts'))
    // One call site, inside the `opts.readOnly` branch. A resume (which is what
    // promotion spawns) never reaches it.
    expect(pty.match(/withReviewCorrective\(/g)).toHaveLength(1)
    const branch = pty.slice(pty.indexOf('if (opts.readOnly) {'))
    expect(branch.slice(0, branch.indexOf('} else if'))).toContain('withReviewCorrective(')
  })
})

describe('AC-30 — the transcript is never labelled with the corrective', () => {
  it('the corrective travels only as a flag value, never as a positional', () => {
    // The sidebar label is `summary || firstPrompt`, and `firstPrompt` is the
    // first USER message in the JSONL. `--append-system-prompt` writes no turn,
    // so there is nothing for the label to pick up — which is a property of the
    // CHANNEL, and this is the assertion that keeps the channel from changing.
    const argv = buildClaudeArgs(
      ['--session-id', 'u'],
      withReviewCorrective(forceReadOnlyPermission({}), corrective({ prNumber: 246 }))
    )
    const at = argv.indexOf('--append-system-prompt')
    const positionals = argv.filter((a, i) => i !== at + 1 && a.includes(CORRECTIVE_OPEN))
    expect(positionals).toEqual([])
    expect(argv).not.toContain('--')
  })
})

// ── AC-31 ───────────────────────────────────────────────────────────────────

describe('AC-31 — model-facing prose, not UI copy', () => {
  it('the composer never reaches for i18n, and does not vary by locale', () => {
    // Comments ABOUT the rule are prose, not a violation of it — only code may
    // not reach for the locale layer.
    const src = codeOnly(read('src/main/review-corrective.ts'))
    expect(src).not.toMatch(/\bvue-i18n\b|\$t\(|\bi18n\b/)
    // A translated corrective would fork model behaviour by the operator's
    // language setting — a bug nobody would ever find.
    expect(composeReviewCorrective(corrective())).toBe(composeReviewCorrective(corrective()))
  })

  it('no sentence of it leaked into either locale file', () => {
    const text = composeReviewCorrective(corrective())
    for (const locale of [JSON.stringify(en), JSON.stringify(ptBR)]) {
      expect(locale).not.toContain('HEAD is unrelated')
      expect(locale).not.toContain(CORRECTIVE_OPEN)
    }
    expect(text).toContain(CORRECTIVE_OPEN)
  })

  it("but the disclosure's LABEL is UI copy, in both locales", () => {
    expect(typeof (en.reviewCompanion as Record<string, unknown>).disclosure).toBe('string')
    expect(typeof (ptBR.reviewCompanion as Record<string, unknown>).disclosure).toBe('string')
    expect((en.reviewCompanion as Record<string, string>).disclosure).not.toBe(
      (ptBR.reviewCompanion as Record<string, string>).disclosure
    )
  })
})

// ── AC-26 (the header disclosure's structural half) ─────────────────────────

describe('AC-26 — the disclosure renders the exact composed string', () => {
  it('the header calls the same composer main does, over the pane’s own facts', () => {
    const src = read('src/renderer/src/components/HelperPane.vue')
    expect(src).toContain('composeReviewCorrective(props.pane.corrective)')
    // Rendered verbatim, not re-described: a second wording of the same facts is
    // the shape that silently goes out of date.
    expect(src).toContain('{{ correctiveText }}')
    expect(src).toContain("$t('reviewCompanion.disclosure')")
  })
})
