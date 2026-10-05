# ADR-0011 — Syntax highlighting is a class-based emitter mapped onto the terminal's ANSI palette

**Status:** Proposed
**Date:** 2026-08-25
**Author:** agent (T164 U1)
**Deciders:** operator (this ADR is not accepted until read)
**Technical context:** `src/renderer/src/styles/main.css`, `src/renderer/src/styles/themes.css`, `design.md` §6 "Review pane" / §9, the future `ReviewPane.vue`

> Related: [`docs/prds/T164-review-pane.md`](../prds/T164-review-pane.md) §4.3 + D5
> · `docs/specs/2026-08-25-t164-review-pane/spec.html` (approved 2026-08-25, frozen)
> · card `T164-review-pane-per-session-diff-review-surface-the-killer-gap`

---

## 1. Context

The T164 review pane exists so the operator can read a branch diff by hand for
twenty minutes without leaving Capy. The PRD settled **whether** to highlight
(D5: yes — the no-highlight variant was rendered, compared and rejected) and the
**palette** it must draw from. It left exactly one question open, and this ADR
closes it:

> Which mechanism emits the token spans, and which languages must it cover?

The palette constraint is what makes the question non-obvious. Capy ships
**13 themes**, and `themes.css` requires every one of them to define the
complete token set with no gaps. A highlighter that carries its own theme would
add a 14th palette that nobody maintains — or, worse, 13 hand-written ones that
drift the first time a theme is tweaked. Every Capy theme already defines a full
**16-colour ANSI palette** for the terminal (`--term-ansi-*`, read at runtime by
`lib/terminalTheme.ts`). Driving code colour from those tokens covers all 13
themes for free, adds no colour token to the system, and paints the diff with
the same palette the operator was just reading three inches to the left.

That constraint has a mechanical consequence: **the highlighter must emit
classes**. A highlighter that emits inline styles (`<span style="color:#7a9455">`)
has already resolved the colour before the theme is known — theme switching
would require re-tokenising every visible line, and the tokens would live
outside the CSS cascade where no `--term-ansi-*` variable can reach them.

A second requirement comes from PRD §4.3, which is binding regardless of
engine: **word-level intra-line highlighting**. On a modified line only the span
that actually changed is marked, so a one-character edit is findable. That mark
has to compose with the syntax spans on the same line.

## 2. Decision

**Capy highlights code with `lowlight` — highlight.js grammars, class-based
output, delivered as a hast tree — and maps its scope classes onto the
`--term-ansi-*` tokens through seven CSS buckets declared once in `main.css`.**

Concretely:

- **Dependency:** `lowlight@^3.3.0` (pulls `highlight.js@11.11.2`,
  `@types/hast`, `devlop`, `dequal`). One production dependency added.
- **Grammars are registered explicitly**, never the "all languages" bundle:
  `createLowlight({ typescript, javascript, xml, css, json, markdown, bash })`.
  Raw source for those seven plus `core` is ~151 KB before minification and
  tree-shaking; the full auto-registered build is ~2.7 MB and is not used.
- **Colour lives only in CSS.** `main.css` declares seven buckets. Each names
  the class from the approved spec (`.t-key`, `.t-fn`, `.t-str`, `.t-num`,
  `.t-com`, `.t-typ`, `.t-pun`) alongside the `hljs-*` scopes that alias onto
  it, so the spec's markup and the highlighter's output are the same palette,
  never two.

  | Bucket   | Token                      |
  | -------- | -------------------------- |
  | `.t-key` | `--term-ansi-magenta`      |
  | `.t-fn`  | `--term-ansi-blue`         |
  | `.t-str` | `--term-ansi-green`        |
  | `.t-num` | `--term-ansi-yellow`       |
  | `.t-com` | `--term-ansi-bright-black` |
  | `.t-typ` | `--term-ansi-cyan`         |
  | `.t-pun` | `--color-text-3`           |

- **No component ever writes a code colour**, and no theme block ever gains a
  highlight rule. Adding a theme adds zero highlighting work; adding a language
  adds zero CSS.

### One deliberate exception

`.t-pun` (punctuation and operators) resolves to `--color-text-3`, not to an
ANSI hue. This is carried over verbatim from the approved spec and is
deliberate: punctuation is scaffolding, and giving it a hue of its own makes
every line noisier without making any token easier to find. It is still an
**existing** token — no new colour enters the system, which is the property the
constraint actually protects. Plain, unmatched code inherits `--color-text` /
`--color-text-2` from the diff row for the same reason.

`hljs-emphasis` and `hljs-strong` (markdown) carry slant and weight only — no
token at all. `hljs-addition` / `hljs-deletion` are deliberately left unmapped:
they come from highlight.js's own `diff` grammar, which Capy never registers
because the review pane parses the diff itself and paints it with
`.diff-line-*`. Mapping them would give one line two competing add/remove
signals.

## 3. Language coverage

The six the PRD names, plus the one they imply:

| Language    | Grammar      | Status                                                                                                               |
| ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| TypeScript  | `typescript` | Full — keywords, types, generics, decorators, regexp, template literals.                                             |
| JSON        | `json`       | Full. Keys land in `.t-typ` (cyan), values by type.                                                                  |
| Markdown    | `markdown`   | Full — headings, emphasis, links, inline + fenced code, blockquotes.                                                 |
| CSS         | `css`        | Full — selectors, properties, at-rules, `var()`.                                                                     |
| Shell       | `bash`       | Full — builtins, variables, strings, shebang.                                                                        |
| **Vue SFC** | `xml`        | **Partial, knowingly.** See below.                                                                                   |
| JavaScript  | `javascript` | Required transitively: `typescript` derives from it, and the `xml` grammar sub-highlights `<script>` bodies with it. |

**Vue SFC is highlighted as `xml`.** highlight.js has no `vue` grammar. Its
`xml` grammar sub-highlights `<style>` bodies as CSS and `<script>` bodies as
**JavaScript**, so a `<script setup lang="ts">` block gets keywords, strings,
comments and calls, but TypeScript-only syntax (type annotations, `satisfies`,
generics on `defineProps`) falls through to plain text. This was verified
against the real grammars, not assumed — see the demo's Vue panel.

That is an acceptable v1 cost: the block is still readable, the failure mode is
"less colour", never "wrong colour", and the alternative (a bespoke SFC grammar)
is real maintenance for a partial win. If it becomes annoying, the fix is local
— split the SFC on its top-level blocks and highlight each with its own grammar.
No CSS and no token changes.

Anything else falls back to unhighlighted plain text in the diff's own colours.
A missing grammar must never be an error; a diff renders regardless.

## 4. Alternatives considered

### Shiki (rejected — fights the constraint head-on)

The accuracy leader: real TextMate grammars, a proper Vue SFC grammar, editor-grade
tokenisation. It is rejected on three counts, in order of weight:

1. **It emits inline styles.** Its themes resolve to hex before render. Its
   `cssVariables` mode does not fix this — it emits `--shiki-*` variables in a
   `style` attribute, so we would maintain a `--shiki-*` → `--term-ansi-*`
   bridge _per theme_, which is exactly the 13-palette problem the constraint
   exists to avoid.
2. **It ships an Oniguruma WASM regex engine** — megabytes into a renderer that
   already carries xterm, and a WASM init on a pane that must open instantly.
3. **Its API is async.** Every other surface in this codebase highlights
   synchronously during render.

Its accuracy advantage is real but small at the fidelity a diff needs: seven
colour buckets, not thirty.

### Prism (rejected — right shape, wrong maintenance story)

Class-based (`token keyword`), light, and would satisfy the constraint. Rejected
because it is in maintenance mode with v2 in long-running alpha, its official
grammar set has no Vue SFC either, and its plugin/`loadLanguages` ergonomics are
built around a global registry that does not compose well with an ESM bundle.
Nothing it offers over highlight.js pays for that.

### highlight.js directly, without lowlight (rejected — HTML strings)

The same grammars and the same classes. Rejected for what it returns: an **HTML
string**. Two costs follow.

First, **word-level marks**. Splicing `<span class="diff-word-add">` at character
offsets into an HTML string means parsing HTML with string operations — the
offsets are in the _text_, and the tags are in the way. With a hast tree the
same operation is an ordinary tree walk over text leaves.

Second, **`v-html`**. An HTML string has to be sanitised and injected;
`lib/markdown.ts` already carries a DOMPurify pass for exactly that reason.
Rendering a hast tree to Vue VNodes is ~20 lines and touches `innerHTML` never
— which is worth having on a surface whose whole job is displaying arbitrary
content pulled off disk.

lowlight is a thin wrapper (~108 KB installed) over the dependency we would take
anyway. There is no case where the string is preferable.

### A bespoke tokeniser (rejected — not the job)

Regex-per-language, exactly seven buckets, zero dependencies. Rejected on
maintenance: six languages of hand-rolled regex is a permanent tax paid in
mis-highlighted strings and comments, to save one dependency.

### A per-theme highlight palette (rejected by D5, recorded for completeness)

13 hand-tuned highlight themes. Rejected before this ADR: it is 13× the work,
it drifts the moment a theme is edited, and it makes the diff a different
colour world from the terminal beside it.

## 5. Consequences

**Good**

- A new theme inherits highlighting for free, provably: nothing in the highlight
  block mentions a theme.
- The diff and the terminal share one palette, so switching theme recolours both
  in the same instant and in the same way.
- No new colour token; `design.md` §9 grows by two diff tokens, and both are for
  the word-level marks, not for syntax.
- Theme switching costs a repaint, not a re-tokenise — the classes are already
  in the DOM and the cascade does the rest.
- No `innerHTML` on the code path.

**Costs, accepted**

- Vue SFC `<script lang="ts">` is highlighted as JavaScript (§3).
- Seven buckets are coarser than an editor's palette. That is the point: a diff
  is read for _what changed_, and thirty colours compete with the add/remove
  signal the pane exists to carry.
- One production dependency, plus the discipline of registering grammars
  explicitly. An `import 'lowlight'` with auto-registration would quietly pull
  ~2.7 MB of grammars into the renderer.
- highlight.js scope names are an upstream contract. A major bump can rename a
  scope; the blast radius is one CSS block, and the demo below makes a
  regression visible in one render.

**Verification**

`scripts/dev/t164-highlight-demo.mjs` builds
`docs/dev/t164-highlight-demo.html` (generated on demand, not committed) from the _real_ `themes.css` and the _real_
`main.css` block — nothing hand-copied — and renders all six languages plus a
word-marked diff in every one of the 13 themes. It **throws** if the highlight
block ever contains a `[data-theme]` or `.theme-` selector, which is the
machine-checkable form of "no per-theme highlight styles".
