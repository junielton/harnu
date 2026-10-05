import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

/**
 * The `renderMarkdown` seam (T74 §3.1) — the ONE place that touches the
 * markdown library + the sanitizer. Pure: string in, safe HTML string out. No
 * Vue, no app DOM; `MarkdownRenderer.vue` merely `v-html`s the return value.
 *
 * Markdown from a repo is UNTRUSTED input (another session/agent/PR may have
 * written the file), and an XSS in an Electron renderer is RCE-adjacent, so the
 * seam applies TWO of the three defense layers (§3.2); the app CSP is the third:
 *
 *  1. **Parser without raw HTML** — `markdown-it` with `html: false`. Embedded
 *     HTML tags become escaped text, not DOM nodes, killing `<script>` /
 *     `<img onerror>` at the parser. `validateLink` additionally drops
 *     `javascript:` / `vbscript:` / `file:` hrefs by default.
 *  2. **Sanitize the generated HTML** — pipe the parser output through
 *     `DOMPurify` before it is ever inserted: no `<script>`/`<iframe>`/`on*`.
 *
 * (Layer 3 — the app's `script-src 'self'` / `img-src 'self' data:` CSP — is a
 * net below both, not configured here. See §3.2.)
 */

const md = new MarkdownIt({
  html: false, // layer 1: raw HTML is escaped, never parsed into nodes
  linkify: true,
  breaks: false,
  typographer: false
})

/**
 * GitHub-style heading slug. Lowercase, strip punctuation, spaces → hyphens.
 * Unicode letters/numbers survive so non-ASCII headings still get an id.
 *
 * **The v1 call was "no collision suffixing — duplicate headings share an id,
 * acceptable". BUG-119 revisited it and reversed it.** What made it acceptable
 * was that nothing READS these ids across blocks: the anchor handler in
 * `MarkdownRenderer.vue` is root-scoped, so a duplicate never sent a click to
 * the wrong heading. What it ignored is that a duplicate `id` is invalid HTML
 * whatever reads it, and the app puts SEVERAL of these blocks on one page (a
 * folder view listing card bodies, a memory pane beside a card modal) — so a
 * document-wide `getElementById` or an assistive tech's heading map lands on
 * whichever came first. Two independent mechanisms now keep ids unique, and
 * both are needed because they fix different collisions:
 *
 *  - **within one render** — `uniqueHeadingId` suffixes a repeated slug
 *    (`intro`, `intro-1`, `intro-2`), GitHub's own scheme, using the per-render
 *    id set carried on `env`;
 *  - **across renders** — an optional `idPrefix`, which `MarkdownRenderer.vue`
 *    sets to a per-instance value, so two blocks rendering the SAME source no
 *    longer produce the same ids. It is opt-in: a direct `renderMarkdown()`
 *    call (a test, a future non-Vue consumer) keeps bare slugs.
 *
 * `#anchor` links keep working because the click handler resolves the prefixed
 * id first and falls back to the bare slug (§3.5).
 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Per-render state the renderer rules read off markdown-it's `env`. It is a
 * fresh object per `renderMarkdown` call, which is what makes the heading-id
 * bookkeeping per-render rather than global — the `md` instance itself is
 * module-level and shared by every consumer.
 */
interface RenderEnv {
  copyLabels?: CopyLabels
  idPrefix?: string
  /** Heading ids already handed out in THIS render. */
  usedHeadingIds?: Set<string>
}

/**
 * The id this heading gets, guaranteed unused in this render. Suffixes with
 * `-1`, `-2`, … and keeps counting past a suffix that a literal heading already
 * claimed (a doc with `Intro`, `Intro` and `Intro 1` still gets three ids).
 */
function uniqueHeadingId(slug: string, used: Set<string>): string {
  let candidate = slug
  let n = 1
  while (used.has(candidate)) candidate = `${slug}-${n++}`
  used.add(candidate)
  return candidate
}

// Give every heading an `id` derived from its text so in-document `#anchor`
// links can scroll to it (the pane resolves the click; §3.5).
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const inline = tokens[idx + 1]
  const text = inline && inline.type === 'inline' ? inline.content : ''
  const slug = slugify(text)
  if (slug) {
    const renderEnv = env as RenderEnv
    renderEnv.usedHeadingIds ??= new Set<string>()
    tokens[idx].attrSet(
      'id',
      `${renderEnv.idPrefix ?? ''}${uniqueHeadingId(slug, renderEnv.usedHeadingIds)}`
    )
  }
  return self.renderToken(tokens, idx, options)
}

/**
 * BUG-119 — every table gets its OWN scroll container.
 *
 * Without it the nearest scroll container is the whole rendered block, so
 * dragging a wide table sideways drags the paragraphs above and below it out of
 * the viewport with it — a reader scrolling to read column seven loses the
 * sentence that said what the table was. Wrapping each `<table>` in a
 * `.md-table-scroll` div (styled `overflow-x: auto` in `MarkdownRenderer.vue`)
 * confines the horizontal scroll to the table's own box; the prose stays put.
 *
 * Done at the RENDERER, not with a core rule that inserts tokens, so the
 * wrapper cannot be nested by a plugin that re-renders tables, and every other
 * token type is untouched.
 */
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="md-table-scroll">${self.renderToken(tokens, idx, options)}`
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`

// External links (`http`/`https`/`mailto`) open in the OS browser via the app's
// existing `setWindowOpenHandler` allowlist — render them `target="_blank"` with
// `rel="noopener noreferrer"` (the latter also defuses reverse-tabnabbing).
// Internal (`#anchor`) and relative links keep their bare href; the pane's click
// handler decides what to do with them.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? ''
  if (/^(https?:|mailto:)/i.test(href)) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/** Lucide `copy` / `check` glyphs (design.md §5 — stroke 1.6, fill none), inlined so the
 * seam never depends on a Vue icon component. The `md-icon-copy`/`md-icon-check` classes
 * (plain `class`, no `data-*` needed) let CSS show exactly one per button state
 * (`MarkdownRenderer.vue`'s scoped `:deep()` rules). */
const COPY_ICON =
  '<svg class="md-icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const CHECK_ICON =
  '<svg class="md-icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

/**
 * T121 — every fenced code block gets a hover-revealed copy button. Delegates to
 * markdown-it's own fence renderer to build the `<pre><code>` (preserving language class,
 * escaping, everything the default rule already does correctly) and wraps it with a
 * `.md-code-block` container + button carrying the RAW fence source in `data-raw` — never
 * the highlighted/escaped `<code>` innerText, which a later `innerText` read would mangle.
 *
 * `env.copyLabels` (passed by `MarkdownRenderer.vue` from `$t()`) supplies the localized
 * idle/copied labels baked into the markup at render time — the seam has no i18n
 * dependency of its own. Missing labels (e.g. a direct `renderMarkdown()` call in a test)
 * fall back to plain English so the button still renders.
 */
interface CopyLabels {
  copy: string
  copied: string
}
const DEFAULT_COPY_LABELS: CopyLabels = { copy: 'Copy code', copied: 'Copied' }

const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const rendered = defaultFence(tokens, idx, options, env, self)
  const labels: CopyLabels = {
    ...DEFAULT_COPY_LABELS,
    ...(env as { copyLabels?: CopyLabels })?.copyLabels
  }
  // `encodeURIComponent`, NOT `escapeHtml`: DOMPurify TRIMS leading/trailing whitespace
  // off every attribute value it re-serializes, which would silently eat the fence's
  // trailing newline (and any blank lines at the block's edges). Percent-encoding
  // leaves no leading/trailing whitespace to trim — and, as a bonus, needs no HTML
  // escaping at all (`%XX` sequences contain no `"`/`&`/`<`/`>`). Decoded back with
  // `decodeURIComponent` in `MarkdownRenderer.vue`'s click handler.
  const rawAttr = encodeURIComponent(tokens[idx].content)
  const copyLabelAttr = md.utils.escapeHtml(labels.copy)
  const copiedLabelAttr = md.utils.escapeHtml(labels.copied)
  const button =
    `<button type="button" class="md-code-copy-btn" data-raw="${rawAttr}" ` +
    `data-label-idle="${copyLabelAttr}" data-label-copied="${copiedLabelAttr}" ` +
    `aria-label="${copyLabelAttr}" title="${copyLabelAttr}">${COPY_ICON}${CHECK_ICON}</button>`
  return `<div class="md-code-block">${button}${rendered}</div>`
}

/**
 * Render untrusted markdown to a sanitized HTML string. `ADD_ATTR: ['target']`
 * preserves the `_blank` we set above (DOMPurify strips `target` by default for
 * tabnabbing safety — the `rel` we pair with it restores that safety). `data-raw` /
 * `data-label-idle` / `data-label-copied` (T121 copy button) are ALSO added by name —
 * a narrow, explicit exception, not the broad `ALLOW_DATA_ATTR: false` loosening: every
 * OTHER data attribute is still stripped. Every other DOMPurify default holds: no
 * `<script>`/`<iframe>`/`<object>`, no `on*` handlers, no `javascript:`/`data:`
 * (non-image) URIs.
 *
 * `idPrefix` (optional) is prepended verbatim to every heading id — how a caller
 * that renders the SAME source into two blocks on one page keeps their ids
 * distinct (see `slugify`'s note on the reversed v1 decision). Omit it and
 * heading ids are the bare slugs, deduplicated within this render only.
 */
export function renderMarkdown(src: string, copyLabels?: CopyLabels, idPrefix?: string): string {
  const env: RenderEnv = { copyLabels, idPrefix }
  const rawHtml = md.render(typeof src === 'string' ? src : '', env)
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'data-raw', 'data-label-idle', 'data-label-copied'],
    ALLOW_DATA_ATTR: false
  })
}
