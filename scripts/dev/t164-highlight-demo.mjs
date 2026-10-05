/**
 * Builds docs/dev/t164-highlight-demo.html — the fixture that proves the T164
 * ANSI-driven syntax mapping (ADR-0011) renders in every theme with ZERO
 * per-theme highlight rules.
 *
 * Nothing here is hand-copied. The page is assembled from:
 *   - src/renderer/src/styles/themes.css  → the real token blocks, rewritten
 *     from `:root[data-theme='x']` to `.theme-x` so several themes can be
 *     shown side by side on one page (a `:root` selector only matches <html>).
 *   - src/renderer/src/styles/main.css    → the diff + syntax block VERBATIM.
 *     If a single per-theme highlight rule ever sneaks in, it lands on this
 *     page too and the demo stops proving anything.
 *   - lowlight                            → the real highlighter, real grammars.
 *
 * Run: node scripts/dev/t164-highlight-demo.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createLowlight } from 'lowlight'
import xml from 'highlight.js/lib/languages/xml'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import bash from 'highlight.js/lib/languages/bash'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(ROOT, 'docs/dev/t164-highlight-demo.html')

const lowlight = createLowlight({ xml, javascript, typescript, css, json, markdown, bash })

// ── 1. themes.css → per-theme scoping classes ────────────────────────────────
const themesCss = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/themes.css'), 'utf8')
const THEMES = [
  'default-dark',
  ...[...themesCss.matchAll(/:root\[data-theme='([^']+)'\]/g)].map((m) => m[1])
]

const scopedThemes = themesCss
  // `@theme` is a Tailwind at-rule a browser would drop on the floor.
  .replace(/@theme \{/, '.theme-default-dark {')
  // the bare `:root {` block carries the default ANSI + diff tokens
  .replace(/^:root \{/gm, '.theme-default-dark {')
  .replace(/:root\[data-theme='([^']+)'\] \{/g, '.theme-$1 {')

// ── 2. main.css → the shipped diff + syntax block, verbatim ──────────────────
const mainCss = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/main.css'), 'utf8')
const START =
  '/* ══════════════════════════════════════════════════════════════════════════\n * Diff surfaces + syntax highlighting'
const END = '@media (prefers-reduced-motion: reduce) {'
const s = mainCss.indexOf(START)
const e = mainCss.indexOf(END)
if (s < 0 || e < 0) throw new Error('main.css: diff/syntax block markers not found')
const highlightCss = mainCss.slice(s, e).trimEnd()

const perThemeLeak = /\[data-theme|\.theme-/.test(highlightCss)
if (perThemeLeak) throw new Error('main.css: the highlight block contains a per-theme selector')

// ── 3. fixtures — the six languages ADR-0011 commits to ──────────────────────
const SAMPLES = [
  {
    label: 'TypeScript — src/main/review-core.ts',
    lang: 'typescript',
    code: `import { z } from 'zod'

/** A single hunk of a unified diff. */
export interface Hunk {
  oldStart: number
  lines: readonly string[]
}

export async function parseUnifiedDiff(raw: string): Promise<Hunk[] | null> {
  const header = /^@@ -(\\d+),?(\\d*) \\+(\\d+)/gm
  if (!raw) return null
  return raw.split('\\n').map((l) => ({ oldStart: 0, lines: [l] })) // TODO
}`
  },
  {
    label: 'Vue SFC — src/renderer/src/components/ReviewPane.vue (grammar: xml)',
    lang: 'xml',
    code:
      `<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ branch: string }>()
const label = computed(() => props.branch.toUpperCase())
</` +
      `script>

<template>
  <div class="pane" :data-branch="branch">{{ label }}</div>
</template>

<style scoped>
.pane { background: var(--color-surface); }
</style>`
  },
  {
    label: 'JSON — package.json',
    lang: 'json',
    code: `{
  "name": "harnu",
  "version": "0.3.28",
  "private": false,
  "engines": { "node": ">=22" },
  "sizes": [1, 2.5, 1e3, null]
}`
  },
  {
    label: 'Markdown — CHANGELOG.md',
    lang: 'markdown',
    code: `## 2026-08-25

### Added

- **Review pane** tokens — \`--diff-add-word\` / \`--diff-del-word\`.
- See [ADR-0011](docs/adr/0011-syntax-highlighting-mapped-onto-the-ansi-palette.md).

> Colour is never the only channel.`
  },
  {
    label: 'CSS — src/renderer/src/styles/main.css',
    lang: 'css',
    code: `.diff-line-add {
  background: var(--color-green-soft);
}
#review .diff-word-del:hover {
  border-radius: 2px;
  opacity: 0.8;
}
@media (min-width: 1000px) {
  .intent { width: 320px; }
}`
  },
  {
    label: 'Shell — scripts/ci/awareness-gate.mjs (runner)',
    lang: 'bash',
    code: `#!/usr/bin/env bash
set -euo pipefail

BASE="\${1:-main}"
for f in $(git diff --name-only "$BASE"...HEAD); do
  if [[ "$f" == docs/* ]]; then
    echo "docs touched: $f" >&2
  fi
done
exit 0`
  }
]

// ── 4. hast → html (span + text only; everything else is a bug) ──────────────
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const toHtml = (node) => {
  if (node.type === 'text') return esc(node.value)
  if (node.type === 'root') return node.children.map(toHtml).join('')
  if (node.type === 'element') {
    const cls = (node.properties?.className ?? []).join(' ')
    return `<span${cls ? ` class="${cls}"` : ''}>${node.children.map(toHtml).join('')}</span>`
  }
  return ''
}
const highlight = (lang, code) => toHtml(lowlight.highlight(lang, code))

// ── 5. a diff fixture, so the token half of the change is visible too ────────
// Each row is highlighted in three pieces so the word mark wraps ONLY the span
// that actually changed — the point of --diff-*-word is that a one-token edit
// is findable without reading the whole line.
const ts = (c) => highlight('typescript', c)
const DIFF_ROWS = [
  ['ctx', ' ', 21, 21, ts('export function worstCi(states: CiState[]): CiState {')],
  [
    'del',
    '-',
    22,
    null,
    ts('  if (states') +
      `<span class="diff-word-del">${ts(".includes('failing')")}</span>` +
      ts(") return 'failing'")
  ],
  [
    'add',
    '+',
    null,
    22,
    ts('  if (states') +
      `<span class="diff-word-add">${ts(".some((s) => s === 'failing')")}</span>` +
      ts(") return 'failing'")
  ],
  ['ctx', ' ', 23, 23, ts("  return states[0] ?? 'none'")],
  ['ctx', ' ', 24, 24, ts('}')]
]
const diffHtml = DIFF_ROWS.map(([kind, sign, o, n, code]) => {
  const bg = kind === 'add' ? ' diff-line-add' : kind === 'del' ? ' diff-line-del' : ''
  const signCls = kind === 'add' ? 'sign add' : kind === 'del' ? 'sign del' : 'sign'
  return `<div class="row"><span class="gut"><span class="ln">${o ?? ''}</span><span class="ln">${n ?? ''}</span><span class="${signCls}">${sign}</span></span><span class="code${bg}">${code}</span></div>`
}).join('\n        ')

// ── 6. page ──────────────────────────────────────────────────────────────────
const panel = (theme, samples) => `
    <section class="panel theme-${theme}">
      <header class="panel-head"><b>${theme}</b><span>data-theme='${theme}'</span></header>
      <div class="panel-body">
        <div class="file"><div class="file-head">unified diff · line + word marks</div><div class="hunk">
        ${diffHtml}
        </div></div>
${samples
  .map(
    (x) =>
      `        <div class="file"><div class="file-head">${esc(x.label)}</div><pre class="hunk plain"><code>${highlight(x.lang, x.code)}</code></pre></div>`
  )
  .join('\n')}
      </div>
    </section>`

const diffOnly = (theme) => `
    <section class="panel theme-${theme}">
      <header class="panel-head"><b>${theme}</b></header>
      <div class="panel-body">
        <div class="file"><div class="hunk">
        ${diffHtml}
        </div></div>
      </div>
    </section>`

const FULL = ['default-dark', 'light', 'tokyo-night']
const COMPACT = THEMES.filter((t) => !FULL.includes(t))
const compactSample = SAMPLES[0]

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>T164 · ANSI-driven syntax highlighting across every theme</title>
<style>
/* ───── generated from src/renderer/src/styles/themes.css ───── */
${scopedThemes}

/* ───── VERBATIM from src/renderer/src/styles/main.css ───── */
${highlightCss}

/* ───── OPEN QUESTION harness: variant B only. Not shipped — this is the
   rejected-by-default option, rendered so the operator can compare. ───── */
.alt .theme-default-dark .diff-line-del { background: rgba(198, 103, 90, 0.18); }
.alt .theme-light .diff-line-del { background: rgba(220, 38, 38, 0.15); }
.alt .theme-tokyo-night .diff-line-del { background: rgba(247, 118, 142, 0.2); }

/* ───── demo harness only — no token, no highlight rule ───── */
* { box-sizing: border-box; }
body { margin: 0; padding: 28px; background: #0b0b0d; color: #e8e8ea;
  font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 17px; margin: 0 0 4px; }
.lede { color: #9a9aa2; max-width: 76ch; margin: 0 0 22px; font-size: 12.5px; }
.lede code { font-family: ui-monospace, monospace; font-size: 11.5px; }
.grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
.panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg);
  background: var(--color-bg); color: var(--color-text); overflow: hidden; width: 560px; max-width: 100%; }
.panel-head { display: flex; align-items: baseline; gap: 9px; padding: 9px 12px;
  background: var(--color-surface); border-bottom: 1px solid var(--color-border);
  font: 550 12.5px/1 ui-sans-serif, system-ui, sans-serif; color: var(--color-text); }
.panel-head span { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; color: var(--color-text-4); }
.panel-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.file { border: 1px solid var(--color-border); border-radius: var(--radius); overflow: hidden; background: var(--color-surface); }
.file-head { padding: 6px 10px; background: var(--color-surface-2); border-bottom: 1px solid var(--color-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--color-text-3); }
.hunk { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.65; color: var(--color-text-2); }
pre.hunk { margin: 0; padding: 8px 12px; overflow-x: auto; }
pre.hunk code { white-space: pre; }
.row { display: flex; align-items: flex-start; }
.row .gut { flex: none; display: flex; background: var(--color-surface-2);
  border-right: 1px solid var(--color-border); color: var(--color-text-4); font-size: 11px; user-select: none; }
.row .gut .ln { width: 34px; text-align: right; padding-right: 6px; }
.row .gut .sign { width: 16px; text-align: center; }
.row .gut .sign.add { color: var(--color-green); }
.row .gut .sign.del { color: var(--color-red); }
.row .code { flex: 1; min-width: 0; padding: 0 12px; white-space: pre; overflow-x: auto; }
.compact .panel { width: 340px; }
.compact .panel-body { padding: 9px; }
.section-title { margin: 30px 0 12px; font-size: 13px; color: #c9c9d1; }
.section-title small { color: #77777f; font-weight: 400; }
.ab-label { margin: 16px 0 7px; font: 600 12px ui-sans-serif, system-ui; color: #c9c9d1; }
.ab-label code { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 400; color: #9a9aa2; }
</style>
</head>
<body>
<h1>T164 · one syntax mapping, every theme</h1>
<p class="lede">
  Every code colour on this page resolves to a <code>--term-ansi-*</code> token (ADR-0011).
  The highlight CSS below the theme blocks is copied <b>verbatim</b> from
  <code>src/renderer/src/styles/main.css</code> and contains no
  <code>[data-theme]</code> selector — the build fails if one appears. The only thing that
  changes between the panels is which theme block is in scope. Regenerate with
  <code>node scripts/dev/t164-highlight-demo.mjs</code>.
</p>

<h2 class="section-title">Full sample <small>— diff surfaces + all six languages</small></h2>
<div class="grid">${FULL.map((t) => panel(t, SAMPLES)).join('')}
</div>

<h2 class="section-title">Open question <small>— should removals weigh the same as additions?</small></h2>
<p class="lede">
  <code>--green-soft</code> is alpha <code>.18</code>; <code>--red-soft</code> is <code>.10</code>.
  Those alphas were tuned for badges and toasts, where red is an alarm that should stay quiet — in a
  diff, add and remove are peers. <b>A is what ships</b> (the approved rendering, no new token).
  B is what a symmetric <code>--diff-del-line</code> would look like. Operator's call.
</p>
<div class="ab-label">A — SHIPPED: removals reuse <code>--red-soft</code> (.10)</div>
<div class="grid">${FULL.map((t) => diffOnly(t)).join('')}
</div>
<div class="ab-label">B — NOT SHIPPED: a new <code>--diff-del-line</code> at matching weight (.18)</div>
<div class="grid alt">${FULL.map((t) => diffOnly(t)).join('')}
</div>

<h2 class="section-title">Every remaining theme <small>— same rules, no per-theme work (${COMPACT.length} more)</small></h2>
<div class="grid compact">${COMPACT.map((t) => panel(t, [compactSample])).join('')}
</div>
</body>
</html>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
console.log(
  `wrote ${path.relative(ROOT, OUT)} — ${THEMES.length} themes, ${SAMPLES.length} languages`
)
