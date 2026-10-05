import { describe, it, expect } from 'vitest'
// The CI gate cores are the SOURCE of the contract-flag rules. Importing the
// real `.mjs` here is what stops `review-core.ts`'s mirrored constants from
// silently drifting away from the gates they claim to mirror.
import {
  changelogGateVerdict,
  SRC_PREFIX,
  CHANGELOG_FILE
} from '../scripts/ci/changelog-gate-core.mjs'
import {
  awarenessGateVerdict,
  TRIGGER_FILES,
  AWARENESS_DOC
} from '../scripts/ci/awareness-gate-core.mjs'
import {
  userDocsGateVerdict,
  COMPONENT_DIR,
  MAIN_DIR,
  TOOL_CATALOG_FILE,
  USER_DOCS_DIR
} from '../scripts/ci/user-docs-gate-core.mjs'
import {
  parseUnifiedDiff,
  parseNameStatus,
  countPorcelain,
  countDiffRows,
  truncateDiff,
  tokenizeLine,
  wordSpans,
  pairModifiedRows,
  annotateWordDiffs,
  matchesGlob,
  matchBlastRadius,
  contractFlags,
  computeDiscrepancies,
  assembleEvidence,
  CONTRACT_SRC_PREFIX,
  CONTRACT_CHANGELOG_FILE,
  CONTRACT_AWARENESS_TRIGGERS,
  CONTRACT_AWARENESS_DOC,
  CONTRACT_COMPONENT_DIR,
  CONTRACT_MAIN_DIR,
  CONTRACT_TOOL_CATALOG_FILE,
  CONTRACT_USER_DOCS_DIR,
  type DiffRow,
  type DiffRowKind,
  type EvidenceInput,
  type NameStatusEntry,
  type ReviewEvidence
} from '../src/main/review-core'
import { parsePrList } from '../src/main/pr-stack-core'
import type { HeadInfo } from '../src/main/review-head'

// ───────────────────────────────────────────────────────────────────────────
// AC-1 / AC-2 — the unified-diff parser
// ───────────────────────────────────────────────────────────────────────────

const MODIFIED = `diff --git a/src/main/hello.ts b/src/main/hello.ts
index 1111111..2222222 100644
--- a/src/main/hello.ts
+++ b/src/main/hello.ts
@@ -3,4 +3,5 @@ export function hello(): string {
   const greeting = 'hi'
-  return greeting
+  return greeting.trim()
+  // added
   const unused = 1
 }
`

describe('parseUnifiedDiff — a modified file', () => {
  const [file] = parseUnifiedDiff(MODIFIED)

  it('reads the path, status and ± counts', () => {
    expect(file.path).toBe('src/main/hello.ts')
    expect(file.oldPath).toBeNull()
    expect(file.status).toBe('modified')
    expect(file.binary).toBe(false)
    expect(file.added).toBe(2)
    expect(file.deleted).toBe(1)
  })

  it('reads the hunk header, including its heading', () => {
    const [hunk] = file.hunks
    expect(hunk.oldStart).toBe(3)
    expect(hunk.oldLines).toBe(4)
    expect(hunk.newStart).toBe(3)
    expect(hunk.newLines).toBe(5)
    expect(hunk.heading).toBe('export function hello(): string {')
  })

  it('numbers old and new lines independently, per row kind', () => {
    const rows = file.hunks[0].rows.map((r) => [r.kind, r.oldLine, r.newLine, r.text])
    expect(rows).toEqual([
      ['context', 3, 3, "  const greeting = 'hi'"],
      ['del', 4, null, '  return greeting'],
      ['add', null, 4, '  return greeting.trim()'],
      ['add', null, 5, '  // added'],
      ['context', 5, 6, '  const unused = 1'],
      ['context', 6, 7, '}']
    ])
  })
})

describe('parseUnifiedDiff — file lifecycle', () => {
  it('marks an ADDED file', () => {
    const [f] = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`)
    expect(f.status).toBe('added')
    expect(f.path).toBe('new.ts')
    expect(f.added).toBe(2)
    expect(f.deleted).toBe(0)
    expect(f.hunks[0].rows.map((r) => r.oldLine)).toEqual([null, null])
    expect(f.hunks[0].rows.map((r) => r.newLine)).toEqual([1, 2])
  })

  it('marks a DELETED file', () => {
    const [f] = parseUnifiedDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abcdef1..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`)
    expect(f.status).toBe('deleted')
    expect(f.path).toBe('gone.ts')
    expect(f.deleted).toBe(2)
    expect(f.added).toBe(0)
  })

  it('marks a RENAMED file and keeps both paths', () => {
    const [f] = parseUnifiedDiff(`diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 96%
rename from src/old-name.ts
rename to src/new-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 export {}
`)
    expect(f.status).toBe('renamed')
    expect(f.oldPath).toBe('src/old-name.ts')
    expect(f.path).toBe('src/new-name.ts')
    expect(f.added).toBe(1)
    expect(f.deleted).toBe(1)
  })

  it('marks a pure rename with no hunks', () => {
    const [f] = parseUnifiedDiff(`diff --git a/a.ts b/b.ts
similarity index 100%
rename from a.ts
rename to b.ts
`)
    expect(f.status).toBe('renamed')
    expect(f.oldPath).toBe('a.ts')
    expect(f.path).toBe('b.ts')
    expect(f.hunks).toEqual([])
  })

  it('marks a COPIED file', () => {
    const [f] = parseUnifiedDiff(`diff --git a/a.ts b/c.ts
similarity index 100%
copy from a.ts
copy to c.ts
`)
    expect(f.status).toBe('copied')
    expect(f.oldPath).toBe('a.ts')
    expect(f.path).toBe('c.ts')
  })
})

describe('parseUnifiedDiff — binary files', () => {
  it('flags the textual "Binary files … differ" form and renders no rows', () => {
    const [f] = parseUnifiedDiff(`diff --git a/brand/logo.png b/brand/logo.png
index 1111111..2222222 100644
Binary files a/brand/logo.png and b/brand/logo.png differ
`)
    expect(f.binary).toBe(true)
    expect(f.path).toBe('brand/logo.png')
    expect(f.hunks).toEqual([])
  })

  it('flags the `GIT binary patch` form too', () => {
    const [f] = parseUnifiedDiff(`diff --git a/x.bin b/x.bin
new file mode 100644
index 0000000..2222222
GIT binary patch
literal 8
Pc$^kSU|<4bfB*mh0Ac9K

literal 0
Hc$@<O00001
`)
    expect(f.binary).toBe(true)
    expect(f.status).toBe('added')
    expect(f.hunks).toEqual([])
  })
})

describe('parseUnifiedDiff — no newline at EOF', () => {
  it('marks the row the `\\ No newline` marker followed, not the next one', () => {
    const [f] = parseUnifiedDiff(`diff --git a/eof.txt b/eof.txt
index 1111111..2222222 100644
--- a/eof.txt
+++ b/eof.txt
@@ -1,2 +1,2 @@
 keep
-old tail
\\ No newline at end of file
+new tail
\\ No newline at end of file
`)
    const rows = f.hunks[0].rows
    expect(rows.map((r) => [r.kind, r.noNewline])).toEqual([
      ['context', false],
      ['del', true],
      ['add', true]
    ])
  })
})

describe('parseUnifiedDiff — degenerate input', () => {
  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('\n')).toEqual([])
  })

  it('ignores preamble that arrives before any `diff --git`', () => {
    expect(parseUnifiedDiff('warning: LF will be replaced by CRLF\n')).toEqual([])
  })

  it('treats an omitted hunk count as 1', () => {
    const [f] = parseUnifiedDiff(`diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -7 +7 @@
-a
+b
`)
    expect(f.hunks[0]).toMatchObject({ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 })
    expect(f.hunks[0].rows).toHaveLength(2)
  })

  it('stops a hunk at its declared budget, so trailing junk is never a row', () => {
    const [f] = parseUnifiedDiff(`diff --git a/t.txt b/t.txt
--- a/t.txt
+++ b/t.txt
@@ -1,1 +1,1 @@
-a
+b
--${' '}
2.43.0
`)
    expect(f.hunks[0].rows.map((r) => r.text)).toEqual(['a', 'b'])
  })

  it('tolerates CRLF line endings', () => {
    const [f] = parseUnifiedDiff(
      'diff --git a/c.txt b/c.txt\r\n--- a/c.txt\r\n+++ b/c.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n'
    )
    expect(f.hunks[0].rows.map((r) => r.text)).toEqual(['a', 'b'])
  })

  it('reads an empty context line that lost its leading space', () => {
    const [f] = parseUnifiedDiff(`diff --git a/s.txt b/s.txt
--- a/s.txt
+++ b/s.txt
@@ -1,3 +1,3 @@
 head

-a
+b
`)
    expect(f.hunks[0].rows.map((r) => [r.kind, r.text])).toEqual([
      ['context', 'head'],
      ['context', ''],
      ['del', 'a'],
      ['add', 'b']
    ])
  })

  it('parses several files in one diff', () => {
    const files = parseUnifiedDiff(MODIFIED + MODIFIED.replace(/hello/g, 'world'))
    expect(files.map((f) => f.path)).toEqual(['src/main/hello.ts', 'src/main/world.ts'])
  })
})

describe('parseUnifiedDiff — unicode paths', () => {
  it('reads a raw UTF-8 path', () => {
    const [f] = parseUnifiedDiff(`diff --git a/docs/café-日本.md b/docs/café-日本.md
--- a/docs/café-日本.md
+++ b/docs/café-日本.md
@@ -1,1 +1,1 @@
-á
+é
`)
    expect(f.path).toBe('docs/café-日本.md')
  })

  it('decodes the octal-escaped form git emits with core.quotepath on', () => {
    // `docs/café.md` as git writes it: "a/docs/caf\303\251.md"
    const [f] = parseUnifiedDiff(`diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"
--- "a/docs/caf\\303\\251.md"
+++ "b/docs/caf\\303\\251.md"
@@ -1,1 +1,1 @@
-x
+y
`)
    expect(f.path).toBe('docs/café.md')
  })

  it('reads a quoted rename with escapes on both sides', () => {
    const [f] = parseUnifiedDiff(`diff --git "a/caf\\303\\251.ts" "b/th\\303\\251.ts"
similarity index 100%
rename from "caf\\303\\251.ts"
rename to "th\\303\\251.ts"
`)
    expect(f.oldPath).toBe('café.ts')
    expect(f.path).toBe('thé.ts')
  })

  it('reads a path containing a space via the same-path shortcut', () => {
    const [f] = parseUnifiedDiff(`diff --git a/my docs/read me.md b/my docs/read me.md
--- a/my docs/read me.md
+++ b/my docs/read me.md
@@ -1,1 +1,1 @@
-x
+y
`)
    expect(f.path).toBe('my docs/read me.md')
  })
})

describe('parseUnifiedDiff — a very large hunk', () => {
  const N = 5000
  const body = Array.from({ length: N }, (_, i) => `+line ${i}`).join('\n')
  const huge = `diff --git a/big.txt b/big.txt
new file mode 100644
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,${N} @@
${body}
`

  it('parses ≥5,000 rows without loss', () => {
    const [f] = parseUnifiedDiff(huge)
    expect(f.hunks[0].rows).toHaveLength(N)
    expect(f.added).toBe(N)
    expect(f.hunks[0].rows[N - 1]).toMatchObject({ newLine: N, text: `line ${N - 1}` })
    expect(countDiffRows([f])).toBe(N)
  })

  it('truncates whole files past the row budget and names what it dropped', () => {
    const files = parseUnifiedDiff(huge + MODIFIED)
    const capped = truncateDiff(files, 100)
    expect(capped.files.map((f) => f.path)).toEqual(['big.txt'])
    expect(capped.truncated).toBe(true)
    expect(capped.omittedFiles).toEqual(['src/main/hello.ts'])
  })

  it('keeps everything when the budget is not exceeded', () => {
    const files = parseUnifiedDiff(MODIFIED)
    expect(truncateDiff(files, 1000)).toMatchObject({ truncated: false, omittedFiles: [] })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// AC-3 — word-level intra-line diff
// ───────────────────────────────────────────────────────────────────────────

describe('tokenizeLine', () => {
  it('splits into identifier / whitespace / single-punctuation tokens', () => {
    expect(tokenizeLine('const a = 1').map((t) => t.text)).toEqual([
      'const',
      ' ',
      'a',
      ' ',
      '=',
      ' ',
      '1'
    ])
  })

  it('records offsets into the original text', () => {
    const [, , a] = tokenizeLine('const a = 1')
    expect([a.start, a.end]).toEqual([6, 7])
  })
})

describe('wordSpans', () => {
  const span = (s: string, sp: { start: number; end: number }): string => s.slice(sp.start, sp.end)

  it('marks only the changed word on an otherwise identical line', () => {
    const old = '  return greeting'
    const nw = '  return farewell'
    const { del, add } = wordSpans(old, nw)
    expect(del.map((s) => span(old, s))).toEqual(['greeting'])
    expect(add.map((s) => span(nw, s))).toEqual(['farewell'])
  })

  it('finds a one-character change', () => {
    const old = 'const timeout = 1000'
    const nw = 'const timeout = 2000'
    const { del, add } = wordSpans(old, nw)
    expect(del.map((s) => span(old, s))).toEqual(['1000'])
    expect(add.map((s) => span(nw, s))).toEqual(['2000'])
  })

  it('marks a pure insertion on the added side only', () => {
    const old = 'return greeting'
    const nw = 'return greeting.trim()'
    const { del, add } = wordSpans(old, nw)
    expect(del).toEqual([])
    expect(add.map((s) => span(nw, s))).toEqual(['.trim()'])
  })

  it('marks a pure deletion on the deleted side only', () => {
    const old = 'const x: number = 1'
    const nw = 'const x = 1'
    const { del, add } = wordSpans(old, nw)
    expect(add).toEqual([])
    expect(del.map((s) => span(old, s))).toEqual([': number'])
  })

  it('finds several disjoint changes on one line', () => {
    const old = 'fn(a, b, c)'
    const nw = 'fn(x, b, z)'
    const { del, add } = wordSpans(old, nw)
    expect(del.map((s) => span(old, s))).toEqual(['a', 'c'])
    expect(add.map((s) => span(nw, s))).toEqual(['x', 'z'])
  })

  it('returns two EMPTY arrays for identical lines — computed, not absent', () => {
    expect(wordSpans('same', 'same')).toEqual({ del: [], add: [] })
  })

  it('falls back to one coarse span past the LCS token budget', () => {
    const old = 'x '.repeat(600) + 'a'
    const nw = 'x '.repeat(600) + 'b'
    const { del, add } = wordSpans(old + ' tail', 'z ' + nw)
    expect(del).toHaveLength(1)
    expect(add).toHaveLength(1)
  })
})

describe('pairModifiedRows', () => {
  const rows = (kinds: DiffRowKind[]): DiffRow[] =>
    kinds.map((kind) => ({ kind, oldLine: null, newLine: null, text: '', noNewline: false }))

  it('pairs a del run with the add run that follows it', () => {
    expect(pairModifiedRows(rows(['context', 'del', 'del', 'add', 'add', 'context']))).toEqual([
      { delIndex: 1, addIndex: 3 },
      { delIndex: 2, addIndex: 4 }
    ])
  })

  it('pairs only min(dels, adds) when the runs are uneven', () => {
    expect(pairModifiedRows(rows(['del', 'del', 'add']))).toEqual([{ delIndex: 0, addIndex: 2 }])
  })

  it('pairs nothing when a del run is not followed by adds', () => {
    expect(pairModifiedRows(rows(['del', 'context', 'add']))).toEqual([])
  })
})

describe('annotateWordDiffs', () => {
  it('annotates the modified pair of a real hunk', () => {
    const annotated = annotateWordDiffs(parseUnifiedDiff(MODIFIED))
    const rows = annotated[0].hunks[0].rows
    const del = rows.find((r) => r.kind === 'del')!
    const add = rows.find((r) => r.kind === 'add')!
    expect(del.spans).toEqual([])
    expect(add.spans).toBeDefined()
    expect(add.spans!.map((s) => add.text.slice(s.start, s.end))).toEqual(['.trim()'])
  })

  it('leaves context rows and unpaired adds un-annotated', () => {
    const rows = annotateWordDiffs(parseUnifiedDiff(MODIFIED))[0].hunks[0].rows
    expect(rows.filter((r) => r.kind === 'context').every((r) => r.spans === undefined)).toBe(true)
    expect(rows.filter((r) => r.kind === 'add').at(-1)!.spans).toBeUndefined()
  })

  it('does not mutate the input structure', () => {
    const parsed = parseUnifiedDiff(MODIFIED)
    annotateWordDiffs(parsed)
    expect(parsed[0].hunks[0].rows.every((r) => r.spans === undefined)).toBe(true)
  })

  it('skips annotation for a pair that is a replacement, not an edit', () => {
    const parsed = parseUnifiedDiff(`diff --git a/r.ts b/r.ts
--- a/r.ts
+++ b/r.ts
@@ -1,1 +1,1 @@
-alpha beta gamma delta
+zzz
`)
    const rows = annotateWordDiffs(parsed)[0].hunks[0].rows
    expect(rows.every((r) => r.spans === undefined)).toBe(true)
  })

  it('skips annotation entirely past the row budget', () => {
    const parsed = parseUnifiedDiff(MODIFIED)
    const out = annotateWordDiffs(parsed, { maxRows: 2 })
    expect(out[0].hunks[0].rows.every((r) => r.spans === undefined)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// name-status / porcelain helpers
// ───────────────────────────────────────────────────────────────────────────

describe('parseNameStatus', () => {
  it('reads adds, deletes, modifies, renames and copies', () => {
    expect(
      parseNameStatus(
        [
          'A\tnew.ts',
          'D\tgone.ts',
          'M\tsrc/x.ts',
          'R096\tsrc/a.ts\tsrc/b.ts',
          'C075\ta.ts\tc.ts',
          'T\tlink'
        ].join('\n')
      )
    ).toEqual([
      { status: 'added', path: 'new.ts', oldPath: null },
      { status: 'deleted', path: 'gone.ts', oldPath: null },
      { status: 'modified', path: 'src/x.ts', oldPath: null },
      { status: 'renamed', path: 'src/b.ts', oldPath: 'src/a.ts' },
      { status: 'copied', path: 'c.ts', oldPath: 'a.ts' },
      { status: 'modified', path: 'link', oldPath: null }
    ])
  })

  it('unquotes a unicode path', () => {
    expect(parseNameStatus('M\t"docs/caf\\303\\251.md"')).toEqual([
      { status: 'modified', path: 'docs/café.md', oldPath: null }
    ])
  })

  it('ignores blank and malformed rows', () => {
    expect(parseNameStatus('\nX\n?\tjunk\n')).toEqual([])
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('countPorcelain', () => {
  it('counts one changed path per non-empty line', () => {
    expect(countPorcelain(' M src/a.ts\n?? scratch.txt\n')).toBe(2)
    expect(countPorcelain('')).toBe(0)
    expect(countPorcelain('\n\n')).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// AC-7 — blast-radius glob matching
// ───────────────────────────────────────────────────────────────────────────

describe('matchesGlob', () => {
  it('matches an exact path', () => {
    expect(matchesGlob('src/main/mcp/tool-catalog.ts', 'src/main/mcp/tool-catalog.ts')).toBe(true)
    expect(matchesGlob('src/main/mcp/tool-catalog.ts', 'src/main/mcp/server.ts')).toBe(false)
  })

  it('treats `*` as one path segment', () => {
    expect(matchesGlob('src/main/*.ts', 'src/main/pty.ts')).toBe(true)
    expect(matchesGlob('src/main/*.ts', 'src/main/mcp/server.ts')).toBe(false)
  })

  it('treats `**` as any depth', () => {
    expect(matchesGlob('src/main/reaper/**', 'src/main/reaper/scan-core.ts')).toBe(true)
    expect(matchesGlob('src/main/reaper/**', 'src/main/reaper/a/b/c.ts')).toBe(true)
    expect(matchesGlob('src/main/reaper/**', 'src/main/pty.ts')).toBe(false)
  })

  it('lets `**/` match zero segments', () => {
    expect(matchesGlob('**/*.pem', 'key.pem')).toBe(true)
    expect(matchesGlob('**/*.pem', 'secrets/deep/key.pem')).toBe(true)
  })

  it('reads a trailing slash as "this directory and everything under it"', () => {
    expect(matchesGlob('src/main/mcp/', 'src/main/mcp/server.ts')).toBe(true)
    expect(matchesGlob('src/main/mcp/', 'src/main/mcpx.ts')).toBe(false)
  })

  it('matches the BASENAME when the pattern has no slash', () => {
    expect(matchesGlob('*.env', 'deploy/prod.env')).toBe(true)
    expect(matchesGlob('CODEOWNERS', 'CODEOWNERS')).toBe(true)
    expect(matchesGlob('CODEOWNERS', 'docs/CODEOWNERS')).toBe(true)
  })

  it('supports `?` and character classes', () => {
    expect(matchesGlob('src/v?.ts', 'src/v2.ts')).toBe(true)
    expect(matchesGlob('src/v[12].ts', 'src/v2.ts')).toBe(true)
    expect(matchesGlob('src/v[!12].ts', 'src/v2.ts')).toBe(false)
  })

  it('does not let regex metacharacters in a path leak through', () => {
    expect(matchesGlob('src/a.ts', 'src/aXts')).toBe(false)
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true)
  })

  it('ignores a blank pattern', () => {
    expect(matchesGlob('   ', 'anything.ts')).toBe(false)
  })
})

describe('matchBlastRadius', () => {
  const files = ['src/main/reaper/scan-core.ts', 'README.md', 'deploy/prod.env']

  it('returns the matching files in diff order', () => {
    expect(matchBlastRadius(['src/main/reaper/**', '*.env'], files)).toEqual([
      'src/main/reaper/scan-core.ts',
      'deploy/prod.env'
    ])
  })

  it('never matches when the operator has no list', () => {
    expect(matchBlastRadius([], files)).toEqual([])
  })

  it('reports a file once even when several globs hit it', () => {
    expect(matchBlastRadius(['src/**', 'src/main/reaper/**'], files)).toEqual([
      'src/main/reaper/scan-core.ts'
    ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// AC-8 — contract flags, and their parity with the real CI gates
// ───────────────────────────────────────────────────────────────────────────

const ns = (status: NameStatusEntry['status'], path: string): NameStatusEntry => ({
  status,
  path,
  oldPath: null
})

const flag = (entries: NameStatusEntry[], id: string): ReturnType<typeof contractFlags>[number] =>
  contractFlags(entries).find((f) => f.id === id)!

describe('contractFlags', () => {
  it('mirrors the CI gates constant-for-constant', () => {
    expect(CONTRACT_SRC_PREFIX).toBe(SRC_PREFIX)
    expect(CONTRACT_CHANGELOG_FILE).toBe(CHANGELOG_FILE)
    expect([...CONTRACT_AWARENESS_TRIGGERS]).toEqual(TRIGGER_FILES)
    expect(CONTRACT_AWARENESS_DOC).toBe(AWARENESS_DOC)
    expect(CONTRACT_COMPONENT_DIR).toBe(COMPONENT_DIR)
    expect(CONTRACT_MAIN_DIR).toBe(MAIN_DIR)
    expect(CONTRACT_TOOL_CATALOG_FILE).toBe(TOOL_CATALOG_FILE)
    expect(CONTRACT_USER_DOCS_DIR).toBe(USER_DOCS_DIR)
  })

  it('CHANGELOG: required by any src/ change, satisfied by the file itself', () => {
    expect(flag([ns('modified', 'src/main/pty.ts')], 'changelog')).toMatchObject({
      required: true,
      satisfied: false,
      triggers: ['src/main/pty.ts']
    })
    expect(
      flag([ns('modified', 'src/main/pty.ts'), ns('modified', 'CHANGELOG.md')], 'changelog')
    ).toMatchObject({ required: true, satisfied: true })
    expect(flag([ns('modified', 'docs/x.md')], 'changelog')).toMatchObject({ required: false })
  })

  it('self-awareness: required by the tool catalog or the features loader', () => {
    expect(flag([ns('modified', 'src/main/mcp/tool-catalog.ts')], 'awareness')).toMatchObject({
      required: true,
      satisfied: false
    })
    expect(
      flag(
        [ns('modified', 'src/main/harnu-features.ts'), ns('modified', 'docs/harnu-features.md')],
        'awareness'
      )
    ).toMatchObject({ required: true, satisfied: true })
    expect(flag([ns('modified', 'src/main/mcp/server.ts')], 'awareness')).toMatchObject({
      required: false
    })
  })

  it('user docs: fires on an ADDED top-level component or main file, not on an edit', () => {
    expect(
      flag([ns('added', 'src/renderer/src/components/ReviewPane.vue')], 'userDocs')
    ).toMatchObject({
      required: true
    })
    expect(
      flag([ns('added', 'src/renderer/src/components/ui/Toggle.vue')], 'userDocs')
    ).toMatchObject({
      required: false
    })
    expect(flag([ns('added', 'src/main/review-ipc.ts')], 'userDocs')).toMatchObject({
      required: true
    })
    expect(flag([ns('added', 'src/main/detect/screen-detect.ts')], 'userDocs')).toMatchObject({
      required: false
    })
    expect(
      flag([ns('modified', 'src/renderer/src/components/Sidebar.vue')], 'userDocs')
    ).toMatchObject({
      required: false
    })
    expect(
      flag(
        [ns('added', 'src/main/review-ipc.ts'), ns('modified', 'docs/user/agent-control.md')],
        'userDocs'
      )
    ).toMatchObject({ required: true, satisfied: true })
  })

  it('user docs: a CHANGED tool catalog is a trigger even though it is not added', () => {
    expect(flag([ns('modified', 'src/main/mcp/tool-catalog.ts')], 'userDocs')).toMatchObject({
      required: true,
      triggers: ['src/main/mcp/tool-catalog.ts']
    })
  })

  it('i18n: touching one locale without the other is the unmet state', () => {
    expect(flag([ns('modified', 'src/renderer/src/i18n/en.json')], 'i18n')).toMatchObject({
      required: true,
      satisfied: false
    })
    expect(
      flag(
        [
          ns('modified', 'src/renderer/src/i18n/en.json'),
          ns('modified', 'src/renderer/src/i18n/pt-BR.json')
        ],
        'i18n'
      )
    ).toMatchObject({ required: true, satisfied: true })
    expect(flag([ns('modified', 'src/main/pty.ts')], 'i18n')).toMatchObject({ required: false })
  })

  it('normalizes `./` and backslash paths the way the gates do', () => {
    expect(flag([ns('modified', './src/main/pty.ts')], 'changelog')).toMatchObject({
      required: true,
      triggers: ['src/main/pty.ts']
    })
    expect(flag([ns('modified', 'src\\main\\mcp\\tool-catalog.ts')], 'awareness')).toMatchObject({
      required: true
    })
  })

  it('agrees with the real gate verdicts on a matrix of diffs', () => {
    const cases: NameStatusEntry[][] = [
      [ns('modified', 'src/main/pty.ts')],
      [ns('modified', 'src/main/pty.ts'), ns('modified', 'CHANGELOG.md')],
      [ns('modified', 'docs/plan.md')],
      [ns('modified', 'src/main/mcp/tool-catalog.ts')],
      [ns('modified', 'src/main/mcp/tool-catalog.ts'), ns('modified', 'docs/harnu-features.md')],
      [ns('added', 'src/renderer/src/components/ReviewPane.vue')],
      [ns('added', 'src/main/review-ipc.ts'), ns('modified', 'docs/user/index.md')],
      [ns('added', 'src/renderer/src/components/ui/Toggle.vue')]
    ]
    for (const entries of cases) {
      const changedFiles = entries.map((e) => e.path)
      const addedFiles = entries.filter((e) => e.status === 'added').map((e) => e.path)
      const flags = contractFlags(entries)
      const ours = (id: string): boolean => {
        const f = flags.find((x) => x.id === id)!
        return !f.required || f.satisfied
      }
      expect(ours('changelog')).toBe(changelogGateVerdict({ changedFiles }).ok)
      expect(ours('awareness')).toBe(awarenessGateVerdict({ changedFiles }).ok)
      expect(ours('userDocs')).toBe(userDocsGateVerdict({ addedFiles, changedFiles }).ok)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// AC-4 / AC-5 / AC-6 — evidence assembly and discrepancies
// ───────────────────────────────────────────────────────────────────────────

const NAME_STATUS = [
  'M\tsrc/main/reaper/scan-core.ts',
  'M\tCHANGELOG.md',
  'A\tsrc/main/new.ts'
].join('\n')
const NUMSTAT = [
  '58\t12\tsrc/main/reaper/scan-core.ts',
  '7\t0\tCHANGELOG.md',
  '82\t0\tsrc/main/new.ts'
].join('\n')

const prJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify([
    {
      number: 231,
      title: 'Reaper force-push',
      headRefName: 'bug/57-reaper-force-push',
      baseRefName: 'main',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: null,
      statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      url: 'https://github.com/o/r/pull/231',
      author: { login: 'junielton' },
      updatedAt: '2026-08-25T10:00:00Z',
      ...over
    }
  ])

const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  branch: 'bug/57-reaper-force-push',
  base: 'main',
  revListCount: '4\n',
  behindCount: '0\n',
  numstat: NUMSTAT,
  nameStatus: NAME_STATUS,
  porcelain: ' M src/main/pty.ts\n?? scratch.txt\n',
  remotes: 'origin\n',
  prListJson: prJson(),
  ...over
})

const kinds = (e: ReviewEvidence): string[] => e.discrepancies.map((d) => d.kind)

/** The pre-T246 head: the folder's own branch, read straight off disk. */
const LOCAL_HEAD: HeadInfo = {
  kind: 'local',
  state: 'ready',
  ref: 'bug/57-reaper-force-push',
  prNumber: null,
  freshness: 'unknown',
  fetchedAt: null,
  fetchFailed: false
}

/** A head fetched from `refs/pull/<n>/head` — someone else's PR. */
const prHead = (over: Partial<HeadInfo>): HeadInfo => ({
  ...LOCAL_HEAD,
  kind: 'pr',
  ref: 'refs/harnu/pr/231',
  prNumber: 231,
  ...over
})

describe('assembleEvidence — the full receipts (AC-4)', () => {
  const e = assembleEvidence(input({ session: 'done' }))

  it('reports commits ahead, files and ± counts', () => {
    expect(e.commitsAhead).toBe(4)
    expect(e.behindBase).toBe(0)
    expect(e.filesChanged).toBe(3)
    expect(e.added).toBe(147)
    expect(e.deleted).toBe(12)
  })

  it('reports the dirty working-tree count as its own signal', () => {
    expect(e.dirtyCount).toBe(2)
  })

  it('carries per-file ± counts and status', () => {
    expect(e.files[0]).toMatchObject({
      path: 'src/main/reaper/scan-core.ts',
      status: 'modified',
      added: 58,
      deleted: 12,
      binary: false
    })
    expect(e.files[2]).toMatchObject({ path: 'src/main/new.ts', status: 'added' })
  })

  it('carries the bound session end state through untouched', () => {
    expect(e.session).toBe('done')
    expect(assembleEvidence(input()).session).toBeNull()
  })

  it('reuses the PR parser for lifecycle, draft, review decision and CI', () => {
    expect(e.pr).toMatchObject({
      applicable: true,
      pr: { number: 231, state: 'OPEN', isDraft: false, ci: 'passing', reviewDecision: null }
    })
  })

  it('rolls CI up to the WORST check, not the last one', () => {
    const failing = assembleEvidence(
      input({
        prListJson: prJson({
          statusCheckRollup: [
            { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' }
          ]
        })
      })
    )
    expect(failing.pr).toMatchObject({ applicable: true, pr: { ci: 'failing' } })
    expect(kinds(failing)).toContain('ci-failing')
  })

  it('reports no PR when the branch has none, without inventing one', () => {
    const e2 = assembleEvidence(input({ prListJson: JSON.stringify([]) }))
    expect(e2.pr).toEqual({ applicable: true, pr: null })
    expect(kinds(e2)).toContain('no-pr')
  })

  it('flags a binary file from its `-\\t-` numstat row', () => {
    const e2 = assembleEvidence(
      input({ nameStatus: 'M\tbrand/logo.png', numstat: '-\t-\tbrand/logo.png' })
    )
    expect(e2.files[0]).toMatchObject({
      path: 'brand/logo.png',
      binary: true,
      added: 0,
      deleted: 0
    })
  })

  it('keys a rename by its new path', () => {
    const e2 = assembleEvidence(
      input({
        nameStatus: 'R096\tsrc/a.ts\tsrc/b.ts',
        numstat: '3\t1\tsrc/{a.ts => b.ts}'
      })
    )
    expect(e2.files[0]).toMatchObject({
      path: 'src/b.ts',
      oldPath: 'src/a.ts',
      added: 3,
      deleted: 1
    })
  })
})

describe('assembleEvidence — git-only is FIRST-CLASS (AC-5)', () => {
  it('marks PR/CI not-applicable when the repo has no remote, and does not throw', () => {
    const e = assembleEvidence(input({ remotes: '', prListJson: null }))
    expect(e.pr).toEqual({ applicable: false, reason: 'no-remote' })
    expect(kinds(e)).toContain('no-remote')
    // Every git-derived receipt is still fully populated.
    expect(e.commitsAhead).toBe(4)
    expect(e.filesChanged).toBe(3)
    expect(e.added).toBe(147)
  })

  it('marks PR/CI not-applicable when `gh` is absent or unauthenticated', () => {
    const e = assembleEvidence(input({ prListJson: null }))
    expect(e.pr).toEqual({ applicable: false, reason: 'gh-unavailable' })
    expect(kinds(e)).toContain('gh-unavailable')
  })

  it('never surfaces a not-applicable PR as anything worse than info', () => {
    for (const e of [
      assembleEvidence(input({ remotes: '', prListJson: null })),
      assembleEvidence(input({ prListJson: null }))
    ]) {
      const pr = e.discrepancies.filter(
        (d) => d.kind === 'no-remote' || d.kind === 'gh-unavailable'
      )
      expect(pr.every((d) => d.severity === 'info')).toBe(true)
    }
  })

  it('survives every git call failing at once', () => {
    const e = assembleEvidence({
      branch: 'feat/x',
      base: 'main',
      revListCount: null,
      behindCount: null,
      numstat: null,
      nameStatus: null,
      porcelain: null,
      remotes: null,
      prListJson: null
    })
    expect(e.commitsAhead).toBe(0)
    expect(e.behindBase).toBeNull()
    expect(e.files).toEqual([])
    expect(e.dirtyCount).toBe(0)
    expect(e.pr).toEqual({ applicable: false, reason: 'no-remote' })
    expect(kinds(e)).toContain('no-commits')
  })

  it('treats malformed gh JSON as "no PR for this branch", not a crash', () => {
    const e = assembleEvidence(input({ prListJson: 'not json' }))
    expect(e.pr).toEqual({ applicable: true, pr: null })
  })
})

describe('discrepancies are COMPUTED, not rendered (AC-6)', () => {
  it('names `no-commits` with the branch when the branch is empty', () => {
    const e = assembleEvidence(input({ revListCount: '0\n' }))
    const d = e.discrepancies.find((x) => x.kind === 'no-commits')!
    expect(d).toEqual({
      kind: 'no-commits',
      severity: 'bad',
      data: { branch: 'bug/57-reaper-force-push' }
    })
  })

  it('names `dirty-tree` with the count', () => {
    const d = assembleEvidence(input()).discrepancies.find((x) => x.kind === 'dirty-tree')!
    expect(d).toEqual({ kind: 'dirty-tree', severity: 'warn', data: { count: 2 } })
  })

  it('omits `dirty-tree` on a clean worktree', () => {
    expect(kinds(assembleEvidence(input({ porcelain: '' })))).not.toContain('dirty-tree')
  })

  it('names `sensitive-paths` with the paths that matched', () => {
    const e = assembleEvidence(input({ blastRadiusGlobs: ['src/main/reaper/**'] }))
    expect(e.sensitivePaths).toEqual(['src/main/reaper/scan-core.ts'])
    expect(e.files[0].sensitive).toBe(true)
    expect(e.files[1].sensitive).toBe(false)
    expect(e.discrepancies.find((d) => d.kind === 'sensitive-paths')).toEqual({
      kind: 'sensitive-paths',
      severity: 'warn',
      data: { paths: ['src/main/reaper/scan-core.ts'], count: 1 }
    })
  })

  it('names `behind-base` with the count and the base', () => {
    const d = assembleEvidence(input({ behindCount: '4' })).discrepancies.find(
      (x) => x.kind === 'behind-base'
    )!
    expect(d).toEqual({ kind: 'behind-base', severity: 'warn', data: { count: 4, base: 'main' } })
  })

  it('names one `contract-unmet` per unmet contract, by id', () => {
    const e = assembleEvidence(
      input({
        nameStatus: ['M\tsrc/main/mcp/tool-catalog.ts', 'M\tsrc/renderer/src/i18n/en.json'].join(
          '\n'
        )
      })
    )
    const unmet = e.discrepancies
      .filter((d) => d.kind === 'contract-unmet')
      .map((d) => d.data.contract)
    expect(unmet).toEqual(expect.arrayContaining(['changelog', 'awareness', 'userDocs', 'i18n']))
  })

  it('raises no contract discrepancy when every contract is satisfied or not in play', () => {
    const e = assembleEvidence(
      input({ nameStatus: 'M\tdocs/plan.md', numstat: '1\t0\tdocs/plan.md' })
    )
    expect(kinds(e)).not.toContain('contract-unmet')
  })

  it('names a draft PR, a pending CI and a merged PR', () => {
    expect(kinds(assembleEvidence(input({ prListJson: prJson({ isDraft: true }) })))).toContain(
      'pr-draft'
    )
    expect(
      kinds(
        assembleEvidence(
          input({
            prListJson: prJson({ statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] })
          })
        )
      )
    ).toContain('ci-pending')
    expect(kinds(assembleEvidence(input({ prListJson: prJson({ state: 'MERGED' }) })))).toContain(
      'pr-merged'
    )
  })

  it('orders bad before warn before info', () => {
    const e = assembleEvidence(
      input({
        revListCount: '0',
        blastRadiusGlobs: ['src/main/**'],
        prListJson: null
      })
    )
    const severities = e.discrepancies.map((d) => d.severity)
    expect(severities).toEqual(
      [...severities].sort((a, b) => 'bad warn info'.indexOf(a) - 'bad warn info'.indexOf(b))
    )
    expect(severities[0]).toBe('bad')
  })

  it('emits NO prose — a discrepancy is a kind plus its data (R1/R2)', () => {
    const e = assembleEvidence(input({ revListCount: '0', blastRadiusGlobs: ['src/main/**'] }))
    for (const d of e.discrepancies) {
      expect(Object.keys(d).sort()).toEqual(['data', 'kind', 'severity'])
      for (const value of Object.values(d.data)) {
        // Only identifiers and numbers cross this boundary — no sentences.
        const strings = Array.isArray(value) ? value : [value]
        for (const s of strings) {
          if (typeof s === 'string') expect(s).not.toMatch(/\s/)
        }
      }
    }
  })

  it('is derivable from a hand-built evidence object without touching git', () => {
    const evidence: Omit<ReviewEvidence, 'discrepancies'> = {
      branch: 'feat/t171-status-strip',
      base: 'main',
      commitsAhead: 0,
      behindBase: null,
      files: [],
      filesChanged: 0,
      added: 0,
      deleted: 0,
      dirtyCount: 6,
      sensitivePaths: [],
      contracts: [],
      session: 'done',
      pr: { applicable: true, pr: null },
      head: LOCAL_HEAD
    }
    expect(computeDiscrepancies(evidence)).toEqual([
      { kind: 'no-commits', severity: 'bad', data: { branch: 'feat/t171-status-strip' } },
      { kind: 'dirty-tree', severity: 'warn', data: { count: 6 } }
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// T246 — a head this machine never checked out
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The whole card in one property: an unfetched head and an empty branch produce
 * IDENTICAL git output — `runGit` degrades to `null`, `parseCount(null)` is 0 —
 * and they must not produce identical evidence. An operator who reads "no
 * commits" on someone else's PR concludes nothing happened and Closes, which is
 * the exact R2 failure the review pane exists to prevent.
 */
describe('AC-1 — an unreadable head never renders as "no commits"', () => {
  const unfetched = assembleEvidence(
    input({
      revListCount: null,
      behindCount: null,
      numstat: null,
      nameStatus: null,
      porcelain: null,
      head: prHead({ state: 'not-fetched' })
    })
  )
  const empty = assembleEvidence(input({ revListCount: '0\n', numstat: '', nameStatus: '' }))

  it('says `head-not-fetched`, and does NOT say `no-commits`', () => {
    expect(kinds(unfetched)).toContain('head-not-fetched')
    expect(kinds(unfetched)).not.toContain('no-commits')
  })

  it('is a different discrepancy set from a branch that really has nothing on it', () => {
    expect(kinds(empty)).toContain('no-commits')
    expect(kinds(empty)).not.toContain('head-not-fetched')
    expect(kinds(unfetched)).not.toEqual(kinds(empty))
  })

  it('names a failed fetch separately from having nothing to fetch (AC-7)', () => {
    const failed = assembleEvidence(
      input({ revListCount: null, head: prHead({ state: 'fetch-failed' }) })
    )
    expect(kinds(failed)).toContain('head-fetch-failed')
    expect(kinds(failed)).not.toContain('head-not-fetched')
  })

  it('names an unresolvable base rather than diffing against a guess (AC-4)', () => {
    const refused = assembleEvidence(
      input({
        base: 'feat/deleted',
        revListCount: null,
        head: prHead({ state: 'base-unresolved' })
      })
    )
    const d = refused.discrepancies.find((x) => x.kind === 'base-unresolved')
    expect(d).toBeTruthy()
    expect(d?.data.base).toBe('feat/deleted')
    expect(kinds(refused)).not.toContain('no-commits')
  })

  it('reports a refresh that failed while an older copy still renders', () => {
    const stale = assembleEvidence(input({ head: prHead({ fetchFailed: true }) }))
    expect(kinds(stale)).toContain('refresh-failed')
    // …and the diff below is still real, so the blocking states stay absent.
    expect(kinds(stale)).not.toContain('head-fetch-failed')
  })
})

describe('AC-6 — staleness is stated as a boolean, and only when it is bad news', () => {
  it('says nothing at all when the copy IS the current head — no all-clear row', () => {
    const current = assembleEvidence(input({ head: prHead({ freshness: 'current' }) }))
    expect(kinds(current)).not.toContain('head-moved')
    expect(kinds(current).filter((k) => k.startsWith('head-'))).toEqual([])
  })

  it('says the PR moved when the fetched copy is behind it', () => {
    const moved = assembleEvidence(input({ head: prHead({ freshness: 'moved' }) }))
    expect(kinds(moved)).toContain('head-moved')
  })

  /**
   * The same comparison on a LOCAL branch means the operator moved, not the PR.
   * A shared sentence there would be a confident lie about which side is stale.
   */
  it('uses a different kind for a local branch that differs from the PR', () => {
    const mine = assembleEvidence(
      input({ head: { ...LOCAL_HEAD, freshness: 'moved', prNumber: 231 } })
    )
    expect(kinds(mine)).toContain('head-local-differs')
    expect(kinds(mine)).not.toContain('head-moved')
  })
})

describe('AC-5 — PR matching survives a foreign head', () => {
  it('matches by PR NUMBER when the caller resolved one', () => {
    // The branch string is the bare `headRefName`, and the PR is found by
    // number — two forks may legitimately propose the same branch name.
    const e = assembleEvidence(input({ head: prHead({ prNumber: 231 }) }))
    expect(e.pr.applicable).toBe(true)
    expect(e.pr.applicable && e.pr.pr?.number).toBe(231)
    expect(e.pr.applicable && e.pr.pr?.ci).toBe('passing')
  })

  it('still matches your OWN branch by name, with no number in play', () => {
    const e = assembleEvidence(input())
    expect(e.pr.applicable && e.pr.pr?.number).toBe(231)
  })

  it('finds no PR — and does not throw — when the number is not in the list', () => {
    const e = assembleEvidence(input({ head: prHead({ prNumber: 999 }) }))
    expect(e.pr.applicable && e.pr.pr).toBeNull()
  })

  it('reads `headRefOid` off the gh payload', () => {
    const [entry] = parsePrList(prJson({ headRefOid: 'deadbeef' }))
    expect(entry.headOid).toBe('deadbeef')
    expect(parsePrList(prJson()).at(0)?.headOid).toBeNull()
  })
})

describe('a foreign PR does not report the main worktree as its own dirt', () => {
  /**
   * The cwd for a foreign PR is the repo's MAIN worktree, whose uncommitted
   * files are the operator's own work. Counting them as a gap in someone else's
   * branch would be a fabricated discrepancy.
   */
  it('drops `dirty-tree` on a PR head, and keeps it on a local branch', () => {
    const foreign = assembleEvidence(input({ head: prHead({}) }))
    expect(kinds(foreign)).not.toContain('dirty-tree')
    expect(kinds(assembleEvidence(input()))).toContain('dirty-tree')
  })
})
