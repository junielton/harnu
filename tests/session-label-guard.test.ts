import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * BUG-78 slice 2 (AC15, spec §5.4) — a regression guard: no renderer surface
 * may hand-roll its own session-name cascade. Every surface that names a
 * session goes through `sessionTitle()` in `lib/session-label.ts`; the
 * topbar/sidebar split this replaced is what hid BUG-78 for two months.
 *
 * `findLabelCascades` is a pure text matcher (self-tested below), applied to
 * every `src/renderer/src/**\/*.{vue,ts}`. `ALLOWLIST` is the deliberate escape
 * hatch: a read that is not building a session's display name, each with its
 * one-line reason. Adding an entry needs that reason in the diff.
 */

export interface Finding {
  /** 1-based line in the source. */
  line: number
  /** The matched text, as written. */
  text: string
  rule: 'summary-cascade' | 'summary-bare' | 'label-field'
}

/** Blank out comments while keeping every newline, so line numbers survive. */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(?<![:'"`\\])\/\/[^\n]*/g, blank)
}

// `.summary` as a property read — but never `aiSummary?.summary` / `aiSummary.summary`
// (the Haiku one-liner, a tooltip). `\b` already keeps `awaySummary`/`taskSummary` out.
const SUMMARY = String.raw`(?<!aiSummary\??)\.summary\b`

const RULES: Array<{ rule: Finding['rule']; re: RegExp }> = [
  // `s.summary || …`, `x?.summary ?? ''`, `s.summary?.trim()`, `s.summary.trim()`
  {
    rule: 'summary-cascade',
    re: new RegExp(`${SUMMARY}\\s*(?:\\|\\||\\?\\?|\\??\\.trim\\(\\))`, 'g')
  },
  // `.summary` handed on bare: a call argument / literal value, or `{{ s.summary }}`
  { rule: 'summary-bare', re: new RegExp(`${SUMMARY}\\s*[,)]`, 'g') },
  { rule: 'summary-bare', re: new RegExp(`\\{\\{[^}]*?${SUMMARY}[^}]*?\\}\\}`, 'g') },
  // Any read of a field only a session name is made of.
  { rule: 'label-field', re: /\.(?:firstPrompt|aiSummary|agentName)\b/g }
]

export function findLabelCascades(src: string): Finding[] {
  const code = stripComments(src)
  const lineOf = (i: number): number => code.slice(0, i).split('\n').length
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const { rule, re } of RULES) {
    for (const m of code.matchAll(re)) {
      const line = lineOf(m.index ?? 0)
      const key = `${line}:${rule}:${m[0]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ line, text: m[0], rule })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

interface AllowEntry {
  /** Path under `src/renderer/src/`. */
  file: string
  /** When set, only findings on a source line containing this text are allowed. */
  lineIncludes?: string
  reason: string
}

const ALLOWLIST: AllowEntry[] = [
  { file: 'lib/session-label.ts', reason: 'the helper itself — the one place the cascade lives' },
  {
    file: 'lib/context-digest.ts',
    reason: 'builds the digest from a DTO (fed by SessionMenu, which already passes sessionTitle)'
  },
  {
    file: 'components/session-sort.ts',
    reason: 'a sort key, not a label — changing it would reorder the sidebar'
  },
  {
    file: 'components/ApprovalRow.vue',
    reason: '`approval.summary` is the tool-call summary ("Bash(ls)"), not a session'
  },
  {
    file: 'components/InboxRail.vue',
    lineIncludes: '{{ row.summary }}',
    reason: "a shadow-log row's tool-call summary, not a session"
  },
  {
    file: 'components/SessionMenu.vue',
    lineIncludes: 'firstPrompt: target.firstPrompt',
    reason: 'the digest\'s "First prompt" section — content, not the name'
  },
  {
    file: 'components/SessionPreview.vue',
    lineIncludes: 'whatsHappening',
    reason: '"What\'s happening now" falls back to the first prompt — content, not the name'
  },
  {
    file: 'composables/useJumpSearch.ts',
    lineIncludes: "firstPrompt: s.firstPrompt ?? ''",
    reason: 'a fuzzy-search haystack field, not a label'
  },
  {
    file: 'stores/session-autoname.ts',
    reason: 'decides WHETHER a session needs a name and writes aiSummary — never displays one'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 'matchesFilter(s.',
    reason: 'the sidebar filter matches the raw fields too, alongside sessionTitle()'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 'aiSummaryById.set(',
    reason: 'reconcile stashes the runtime-only aiSummary before a reload'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 's.aiSummary = ai',
    reason: 'reconcile re-applies the runtime-only aiSummary after a reload'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: '.summary = match.summary',
    reason: 'synthetic→real migration backfills the empty fields — a write, not a label'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 'row.firstPrompt = match.firstPrompt',
    reason: 'synthetic→real migration backfills the empty fields — a write, not a label'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 'if (!s.firstPrompt && firstPromptCandidate)',
    reason: 'live delta backfills an empty firstPrompt — a write, not a label'
  },
  {
    file: 'stores/sessions.ts',
    lineIncludes: 'else if (aiTitle && !s.summary)',
    reason:
      'live delta: an ai-title only fills a summary that is still empty — a write, not a label'
  }
]

const ROOT = path.resolve(__dirname, '../src/renderer/src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(vue|ts)$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}

function allowed(file: string, sourceLine: string): boolean {
  return ALLOWLIST.some(
    (a) => a.file === file && (a.lineIncludes === undefined || sourceLine.includes(a.lineIncludes))
  )
}

describe('findLabelCascades — self-test (BUG-78 AC15)', () => {
  it.each([
    ['s.summary || s.firstPrompt', 'summary-cascade'],
    ["x?.summary ?? ''", 'summary-cascade'],
    ['s.summary?.trim()', 'summary-cascade'],
    ['s.summary.trim()', 'summary-cascade'],
    ['<span>{{ s.summary }}</span>', 'summary-bare'],
    ['speak(kind, alias, s.summary, id)', 'summary-bare'],
    ['const p = s.firstPrompt', 'label-field'],
    ['const a = s.aiSummary?.title', 'label-field'],
    ['if (s.agentName) return s.agentName', 'label-field']
  ])('flags %s', (src, rule) => {
    const found = findLabelCascades(src)
    expect(found.length).toBeGreaterThan(0)
    expect(found.map((f) => f.rule)).toContain(rule)
  })

  it('flags a cascade split across lines, on the line it starts', () => {
    const found = findLabelCascades('const a = 1\nreturn s.summary ||\n  s.firstPrompt')
    expect(found.find((f) => f.rule === 'summary-cascade')?.line).toBe(2)
  })

  it.each([
    ['s.awaySummary || x'],
    ['const tip = aiSummary?.summary'],
    ['aiSummary?.summary || x'],
    ['task.taskSummary || x'],
    ['// return s.summary || s.firstPrompt'],
    ['/* s.summary || s.firstPrompt */'],
    ['<!-- {{ s.summary }} -->'],
    ["$t('voice.voices.summary', { n })"],
    ['s.summary = text'],
    ['const url = "https://x.test/a" // s.summary || s.firstPrompt']
  ])('ignores %s', (src) => {
    expect(findLabelCascades(src)).toEqual([])
  })
})

describe('session-label guard — the renderer tree (BUG-78 AC15)', () => {
  it('no surface builds a session name outside sessionTitle()', () => {
    const offenders: string[] = []
    for (const full of walk(ROOT)) {
      const rel = path.relative(ROOT, full).split(path.sep).join('/')
      const src = readFileSync(full, 'utf8')
      const lines = src.split('\n')
      for (const f of findLabelCascades(src)) {
        if (allowed(rel, lines[f.line - 1] ?? '')) continue
        offenders.push(`${rel}:${f.line} ${f.rule} \`${f.text.trim()}\``)
      }
    }
    expect(
      offenders,
      `use sessionTitle() from lib/session-label.ts (or add an ALLOWLIST entry with a reason):\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('every allowlist entry still matches something (no dead escape hatches)', () => {
    const dead = ALLOWLIST.filter((a) => {
      const full = path.join(ROOT, a.file)
      let src: string
      try {
        src = readFileSync(full, 'utf8')
      } catch {
        return true
      }
      const lines = src.split('\n')
      return !findLabelCascades(src).some(
        (f) => a.lineIncludes === undefined || (lines[f.line - 1] ?? '').includes(a.lineIncludes)
      )
    })
    expect(dead.map((a) => `${a.file} ${a.lineIncludes ?? ''}`)).toEqual([])
  })
})
