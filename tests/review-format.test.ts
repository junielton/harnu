import { describe, it, expect } from 'vitest'
import {
  AUTO_EXPAND_ROW_BUDGET,
  CONTRACT_LINE_SEVERITY,
  autoExpanded,
  contractLineParts,
  flagLinesFor,
  gapBefore,
  grammarFor,
  hunkLabel,
  receiptsFor,
  rowSegments,
  sessionEndStateOf,
  splitPath
} from '../src/renderer/src/components/review-format'
import { assembleEvidence, parseUnifiedDiff, type EvidenceInput } from '../src/main/review-core'

/**
 * The renderer's pure layer for the T164 review pane.
 *
 * These tests are written against the two rules the pane is accountable to,
 * not just against its output shape:
 *
 *  - **R2 (no green means safe).** Exercised as a property: across every
 *    combination of evidence this module can be handed, no descriptor may come
 *    back that reads as "all clear", and no status dot may come back without
 *    the word that makes it legible without colour.
 *  - **R1 / AC-12.** Nothing here calls a model, so the tests only have to pin
 *    that the wording is a KEY the locale files own — the moment a sentence is
 *    composed in code, it stops being auditable in `en.json`.
 */

const BASE_INPUT: EvidenceInput = {
  branch: 'bug/57-reaper-force-push',
  base: 'main',
  revListCount: '4\n',
  behindCount: '0\n',
  numstat: '58\t12\tsrc/main/reaper/scan-core.ts\n4\t0\tCHANGELOG.md\n',
  nameStatus: 'M\tsrc/main/reaper/scan-core.ts\nM\tCHANGELOG.md\n',
  porcelain: '',
  remotes: 'origin\n',
  prListJson: '[]'
}

function evidenceOf(patch: Partial<EvidenceInput> = {}): ReturnType<typeof assembleEvidence> {
  return assembleEvidence({ ...BASE_INPUT, ...patch })
}

describe('splitPath', () => {
  it('splits a path into a dir prefix that keeps its slash and a basename', () => {
    expect(splitPath('src/main/reaper/scan-core.ts')).toEqual({
      dir: 'src/main/reaper/',
      base: 'scan-core.ts'
    })
  })

  it('gives a bare filename an empty dir rather than inventing one', () => {
    expect(splitPath('CHANGELOG.md')).toEqual({ dir: '', base: 'CHANGELOG.md' })
  })
})

describe('receiptsFor', () => {
  it('orders the pairs the way the approved spec does', () => {
    const receipts = receiptsFor(evidenceOf({ porcelain: ' M a.ts\n' }), true)
    expect(receipts.map((r) => r.key)).toEqual(['commits', 'files', 'lines', 'uncommitted', 'pr'])
  })

  it('marks a zero-commit branch with the alarm hue instead of dimming it', () => {
    const receipts = receiptsFor(evidenceOf({ revListCount: '0\n' }), true)
    const commits = receipts.find((r) => r.key === 'commits')
    expect(commits).toMatchObject({ value: '0', alarm: true })
  })

  it('drops the lines pair when the branch changed nothing, per the spec', () => {
    const receipts = receiptsFor(
      evidenceOf({ revListCount: '0\n', numstat: '', nameStatus: '' }),
      true
    )
    expect(receipts.some((r) => r.key === 'lines')).toBe(false)
  })

  it('dims an empty worktree instead of hiding it — an absent receipt is evidence', () => {
    const receipts = receiptsFor(evidenceOf(), true)
    expect(receipts.find((r) => r.key === 'worktree')).toMatchObject({
      valueKey: 'clean',
      dim: true
    })
  })

  it('replaces the PR pairs with a dimmed remote pair when there is no remote (AC-6)', () => {
    const receipts = receiptsFor(evidenceOf({ remotes: '', prListJson: null }), true)
    expect(receipts.some((r) => r.key === 'ci' || r.key === 'prReview')).toBe(false)
    expect(receipts.find((r) => r.key === 'remote')).toMatchObject({
      valueKey: 'localOnly',
      dim: true
    })
  })

  it('distinguishes a missing gh from a missing remote', () => {
    const receipts = receiptsFor(evidenceOf({ prListJson: null }), true)
    expect(receipts.find((r) => r.key === 'remote')).toMatchObject({ valueKey: 'ghUnavailable' })
  })

  it('adds the "no card bound" pair only when no card is bound (AC-5)', () => {
    expect(receiptsFor(evidenceOf(), false).some((r) => r.key === 'intent')).toBe(true)
    expect(receiptsFor(evidenceOf(), true).some((r) => r.key === 'intent')).toBe(false)
  })

  it('R2: a status dot never comes back without the word it encodes', () => {
    const combos: Array<Partial<EvidenceInput>> = [
      {},
      { session: 'done' },
      { session: 'running' },
      { session: 'killed' },
      { session: 'stand-down' },
      { session: 'hibernated' },
      { remotes: '', prListJson: null },
      { revListCount: '0\n', numstat: '', nameStatus: '' },
      {
        prListJson: JSON.stringify([
          {
            number: 9,
            title: 't',
            headRefName: 'bug/57-reaper-force-push',
            baseRefName: 'main',
            state: 'OPEN',
            isDraft: true,
            reviewDecision: 'APPROVED',
            statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' }],
            url: 'u',
            author: { login: 'a' },
            updatedAt: '2026-08-26T00:00:00Z'
          }
        ])
      }
    ]
    for (const patch of combos) {
      for (const card of [true, false]) {
        for (const r of receiptsFor(evidenceOf(patch), card)) {
          if (r.dot) expect(r.valueKey, `dot without a word: ${r.key}`).toBeTruthy()
        }
      }
    }
  })

  it('R2: "ended done" is never the green dot — the claim is what is under review', () => {
    const receipts = receiptsFor(evidenceOf({ session: 'done' }), true)
    expect(receipts.find((r) => r.key === 'session')?.dot).toBe('idle')
  })
})

describe('flagLinesFor', () => {
  it('names a zero-commit branch and says the session claimed done when it did', () => {
    const lines = flagLinesFor(evidenceOf({ revListCount: '0\n', session: 'done' }))
    expect(lines[0]).toMatchObject({ severity: 'bad', key: 'noCommitsSessionDone' })
    expect(lines[0].params.branch).toBe('bug/57-reaper-force-push')
  })

  it('drops the session clause when no session is bound', () => {
    const lines = flagLinesFor(evidenceOf({ revListCount: '0\n' }))
    expect(lines[0].key).toBe('noCommits')
  })

  it('changes the dirty-tree sentence when there is nothing committed to compare to', () => {
    const committed = flagLinesFor(evidenceOf({ porcelain: ' M a.ts\n' }))
    expect(committed.find((l) => l.key === 'dirtyNotInDiff')).toBeTruthy()

    const nothing = flagLinesFor(
      evidenceOf({ revListCount: '0\n', numstat: '', nameStatus: '', porcelain: ' M a.ts\n' })
    )
    expect(nothing.find((l) => l.key === 'dirtyMaybeUnsaved')).toBeTruthy()
  })

  it('fans a single sensitive-paths fact out to one line per path, then summarises', () => {
    const evidence = evidenceOf({
      nameStatus: ['a', 'b', 'c', 'd', 'e'].map((n) => `M\tsrc/main/reaper/${n}.ts`).join('\n'),
      blastRadiusGlobs: ['src/main/reaper/**']
    })
    const lines = flagLinesFor(evidence).filter((l) => l.key.startsWith('sensitive'))
    expect(lines.filter((l) => l.key === 'sensitivePath')).toHaveLength(3)
    expect(lines.find((l) => l.key === 'sensitiveMore')?.params.n).toBe(2)
  })

  it('never composes a sentence in code — every line is a key plus params', () => {
    const lines = flagLinesFor(evidenceOf({ revListCount: '0\n', porcelain: ' M a.ts\n' }))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l.key).toMatch(/^[a-zA-Z]+$/)
      expect(typeof l.params).toBe('object')
    }
  })

  it('R2: an evidence set with nothing wrong produces NO flag line at all', () => {
    const clean = evidenceOf({
      prListJson: JSON.stringify([
        {
          number: 231,
          title: 't',
          headRefName: 'bug/57-reaper-force-push',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
          url: 'u',
          author: { login: 'a' },
          updatedAt: '2026-08-26T00:00:00Z'
        }
      ])
    })
    // Absence, not an "all clear" descriptor: there is no key this module can
    // return that says nothing is wrong.
    expect(flagLinesFor(clean)).toEqual([])
  })

  it('folds contract-unmet into the ledger line rather than emitting a duplicate row', () => {
    const evidence = evidenceOf({
      nameStatus: 'M\tsrc/main/reaper/scan-core.ts\n',
      numstat: '1\t0\tsrc/main/reaper/scan-core.ts\n'
    })
    expect(evidence.discrepancies.some((d) => d.kind === 'contract-unmet')).toBe(true)
    expect(flagLinesFor(evidence).some((l) => l.key.startsWith('contract'))).toBe(false)
    // …but the fact survives, named, on the ledger line.
    expect(contractLineParts(evidence.contracts)).toContainEqual({
      id: 'changelog',
      code: 'CHANGELOG.md',
      stateKey: 'notTouched'
    })
  })
})

describe('contractLineParts', () => {
  it('names every contract in the spec order once any of them is in play', () => {
    const parts = contractLineParts(evidenceOf().contracts)
    expect(parts.map((p) => p.id)).toEqual(['changelog', 'awareness', 'userDocs', 'i18n'])
  })

  it('says "not applicable" for a contract that never triggered — never a pass mark', () => {
    const parts = contractLineParts(evidenceOf().contracts)
    expect(parts.find((p) => p.id === 'i18n')?.stateKey).toBe('notApplicable')
    expect(parts.find((p) => p.id === 'changelog')?.stateKey).toBe('touched')
  })

  it('renders nothing when no contract applies — silence, not four empty verdicts', () => {
    const parts = contractLineParts(
      evidenceOf({ revListCount: '0\n', numstat: '', nameStatus: '' }).contracts
    )
    expect(parts).toEqual([])
  })

  it('stays an info line, matching the frozen spec (the sentence carries the gap)', () => {
    expect(CONTRACT_LINE_SEVERITY).toBe('info')
  })
})

describe('sessionEndStateOf', () => {
  it('maps the live task-state vocabulary onto the evidence vocabulary', () => {
    expect(sessionEndStateOf({ taskState: 'completed' })).toBe('done')
    expect(sessionEndStateOf({ taskState: 'failed' })).toBe('killed')
    expect(sessionEndStateOf({ taskState: 'stopped' })).toBe('stand-down')
    expect(sessionEndStateOf({ taskState: 'working' })).toBe('running')
    expect(sessionEndStateOf({ taskState: 'needs-input' })).toBe('running')
  })

  it('reports a parked session as hibernated regardless of its last task-state', () => {
    expect(sessionEndStateOf({ taskState: 'working', hibernated: true })).toBe('hibernated')
  })

  it('refuses to call an idle session done — t125 is not built, so nothing supports it', () => {
    expect(sessionEndStateOf({ taskState: 'idle' })).toBeNull()
    expect(sessionEndStateOf({})).toBeNull()
    expect(sessionEndStateOf(null)).toBeNull()
  })
})

describe('grammarFor', () => {
  it('resolves the six languages ADR-0011 commits to', () => {
    expect(grammarFor('a/b.ts')).toBe('typescript')
    expect(grammarFor('a/b.json')).toBe('json')
    expect(grammarFor('a/b.md')).toBe('markdown')
    expect(grammarFor('a/b.css')).toBe('css')
    expect(grammarFor('a/b.sh')).toBe('bash')
    expect(grammarFor('a/b.js')).toBe('javascript')
  })

  it('highlights a Vue SFC as xml — knowingly partial, never wrong (ADR-0011 §3)', () => {
    expect(grammarFor('src/App.vue')).toBe('xml')
  })

  it('returns null for anything unregistered, so a diff still renders', () => {
    expect(grammarFor('a/b.rs')).toBeNull()
    expect(grammarFor('Makefile')).toBeNull()
  })
})

describe('rowSegments', () => {
  it('emits one unmarked segment when the row carries no word-level spans', () => {
    const segs = rowSegments('const x = 1', undefined, 'add', null)
    expect(segs).toHaveLength(1)
    expect(segs[0].mark).toBeNull()
    expect(segs[0].parts.map((p) => p.text).join('')).toBe('const x = 1')
  })

  it('wraps exactly the changed span, and only on a changed row', () => {
    const text = 'return age < ttlMs && sha === recordedSha'
    const segs = rowSegments(text, [{ start: 20, end: text.length }], 'add', null)
    const marked = segs.filter((s) => s.mark === 'add')
    expect(marked).toHaveLength(1)
    expect(marked[0].parts.map((p) => p.text).join('')).toBe(text.slice(20))
    // Context rows never take a mark even if spans somehow arrive.
    expect(rowSegments(text, [{ start: 0, end: 3 }], null, null).every((s) => !s.mark)).toBe(true)
  })

  it('never loses or reorders a character, marked or not, highlighted or not', () => {
    const text = "  const live = await lsRemoteHeads(repo) // 'x'"
    for (const grammar of [null, 'typescript']) {
      for (const spans of [undefined, [{ start: 8, end: 12 }], [{ start: 0, end: text.length }]]) {
        const joined = rowSegments(text, spans, 'del', grammar)
          .flatMap((s) => s.parts)
          .map((p) => p.text)
          .join('')
        expect(joined, `grammar=${grammar}`).toBe(text)
      }
    }
  })

  it('emits highlight CLASSES and never a colour — the cascade owns the palette', () => {
    const parts = rowSegments('const x = 1', undefined, null, 'typescript').flatMap((s) => s.parts)
    expect(parts.some((p) => p.cls.includes('hljs-'))).toBe(true)
    for (const p of parts) expect(p.cls).not.toMatch(/#|rgb|var\(/)
  })

  it('degrades to plain text on an unknown grammar instead of throwing', () => {
    const segs = rowSegments('¯\\_(ツ)_/¯', undefined, null, 'not-a-language')
    expect(
      segs
        .flatMap((s) => s.parts)
        .map((p) => p.text)
        .join('')
    ).toBe('¯\\_(ツ)_/¯')
  })

  it('emits nothing for a blank row rather than a dead empty span per line', () => {
    expect(rowSegments('', undefined, 'add', 'typescript')).toEqual([])
  })
})

describe('autoExpanded', () => {
  const files = parseUnifiedDiff(
    ['a', 'b', 'c']
      .map(
        (n) =>
          `diff --git a/src/${n}.ts b/src/${n}.ts\n--- a/src/${n}.ts\n+++ b/src/${n}.ts\n@@ -1,1 +1,2 @@\n line\n+added ${n}\n`
      )
      .join('')
  )

  it('opens everything that fits the budget', () => {
    expect(autoExpanded(files, new Set())).toEqual({
      'src/a.ts': true,
      'src/b.ts': true,
      'src/c.ts': true
    })
  })

  it('collapses past the budget but always opens the first file (never a blank pane)', () => {
    const map = autoExpanded(files, new Set(), 1)
    expect(map['src/a.ts']).toBe(true)
    expect(map['src/b.ts']).toBe(false)
    expect(map['src/c.ts']).toBe(false)
  })

  it('R3: a sensitive file opens expanded even with the budget already spent', () => {
    const map = autoExpanded(files, new Set(['src/c.ts']), 1)
    expect(map['src/b.ts']).toBe(false)
    expect(map['src/c.ts']).toBe(true)
  })

  it('leaves a binary file collapsed — there is nothing to render inside it', () => {
    const binary = parseUnifiedDiff(
      'diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n'
    )
    expect(autoExpanded(binary, new Set())['x.png']).toBe(false)
  })

  it('keeps a real budget, so a huge diff cannot build every row on open (AC-11)', () => {
    expect(AUTO_EXPAND_ROW_BUDGET).toBeGreaterThan(0)
    expect(AUTO_EXPAND_ROW_BUDGET).toBeLessThan(5000)
  })
})

describe('gapBefore / hunkLabel', () => {
  const files = parseUnifiedDiff(
    'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n' +
      '@@ -10,2 +10,3 @@ fn one\n a\n+b\n c\n' +
      '@@ -40,1 +41,1 @@ fn two\n-d\n+e\n'
  )
  const hunks = files[0].hunks

  it('reports the lines git skipped before the first hunk', () => {
    expect(gapBefore(hunks, 0)).toBe(9)
  })

  it('reports the lines skipped between two hunks', () => {
    expect(gapBefore(hunks, 1)).toBe(28)
  })

  it('reports no gap where the hunks are adjacent, and never a negative one', () => {
    const adjacent = parseUnifiedDiff(
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n a\n+b\n'
    )[0].hunks
    expect(gapBefore(adjacent, 0)).toBe(0)
    expect(gapBefore(hunks, 99)).toBe(0)
  })

  it('renders the hunk label exactly as git prints it', () => {
    expect(hunkLabel(hunks[0])).toBe('@@ -10,2 +10,3 @@ fn one')
  })
})
