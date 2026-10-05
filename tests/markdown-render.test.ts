// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/renderer/src/lib/markdown'

/**
 * XSS suite for the `renderMarkdown` seam (T74 AC2/AC3). Markdown from a repo is
 * untrusted, and an XSS in an Electron renderer is RCE-adjacent, so the seam
 * MUST neutralize the classic vectors. DOMPurify needs a DOM, hence jsdom.
 *
 * We assert on the ACTUAL RENDERED DOM (what a `v-html` of this string would
 * become), not on substrings: with `html: false` the parser escapes raw HTML to
 * INERT TEXT, so the literal words "onerror"/"javascript:" survive as harmless
 * text nodes — what must never survive is a LIVE element or attribute. Parsing
 * the output and querying it captures exactly that, and stays robust across
 * markdown-it/DOMPurify version bumps.
 */
function parse(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}
function hasEventHandlerAttr(root: HTMLElement): boolean {
  return [...root.querySelectorAll('*')].some((node) =>
    [...node.attributes].some((attr) => /^on/i.test(attr.name))
  )
}

describe('renderMarkdown — sanitization (both layers present)', () => {
  it('drops a raw <script> block', () => {
    const dom = parse(renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter'))
    expect(dom.querySelector('script')).toBeNull()
  })

  it('does not create an anchor with a javascript: href', () => {
    const dom = parse(renderMarkdown('[click me](javascript:alert(1))'))
    // markdown-it's validateLink drops the scheme → no anchor is created at all.
    expect(dom.querySelector('a[href^="javascript:" i]')).toBeNull()
    expect(dom.querySelector('a')).toBeNull()
  })

  it('escapes an <img onerror> instead of emitting a live element', () => {
    const dom = parse(renderMarkdown('<img src=x onerror=alert(1)>'))
    expect(dom.querySelector('img')).toBeNull()
    expect(hasEventHandlerAttr(dom)).toBe(false)
  })

  it('neutralizes a raw <a href="javascript:"> anchor', () => {
    const dom = parse(renderMarkdown('<a href="javascript:alert(1)">x</a>'))
    expect(dom.querySelector('a')).toBeNull() // escaped to text by html:false
    expect(dom.querySelector('script')).toBeNull()
  })

  it('strips inline event handlers from raw HTML', () => {
    const dom = parse(renderMarkdown('<div onclick="alert(1)">hi</div>'))
    expect(hasEventHandlerAttr(dom)).toBe(false)
    expect(dom.querySelector('div')).toBeNull() // escaped, not a live element
  })

  it('drops <iframe> and <object> embeds', () => {
    const dom = parse(
      renderMarkdown('<iframe src="https://evil.example"></iframe>\n\n<object></object>')
    )
    expect(dom.querySelector('iframe')).toBeNull()
    expect(dom.querySelector('object')).toBeNull()
  })

  it('does not smuggle a script or data: link via a data: URI', () => {
    const dom = parse(renderMarkdown('[x](data:text/html,<script>alert(1)</script>)'))
    expect(dom.querySelector('script')).toBeNull()
    expect(dom.querySelector('a[href^="data:" i]')).toBeNull()
  })
})

describe('renderMarkdown — correct rendering', () => {
  it('renders basic prose (headings, emphasis, code)', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code`.')
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('gives headings a slugified id for in-document anchors', () => {
    const html = renderMarkdown('## Hello World!')
    expect(html).toMatch(/<h2[^>]*id="hello-world"[^>]*>/)
  })

  it('opens external links in a new window with rel=noopener noreferrer', () => {
    const html = renderMarkdown('[site](https://example.com)')
    expect(html).toMatch(/href="https:\/\/example\.com"/)
    expect(html).toMatch(/target="_blank"/)
    expect(html).toMatch(/rel="noopener noreferrer"/)
  })

  it('leaves a relative link as a bare href (the pane decides what to do)', () => {
    const html = renderMarkdown('[other](./other.md)')
    expect(html).toMatch(/href="\.\/other\.md"/)
    expect(html).not.toMatch(/target="_blank"/)
  })

  it('leaves an in-document anchor link as a bare #href', () => {
    const html = renderMarkdown('[jump](#hello-world)')
    expect(html).toMatch(/href="#hello-world"/)
    expect(html).not.toMatch(/target="_blank"/)
  })

  it('renders tables (GFM)', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toMatch(/<table/)
    expect(html).toMatch(/<td>1<\/td>/)
  })
})

describe('renderMarkdown — fenced code block copy button (T121)', () => {
  const raw = '<div class="x">it\'s & "quoted"</div>'
  const source = '```\n' + raw + '\n```'

  it('carries the RAW fence source in data-raw (percent-encoded), surviving DOMPurify sanitize', () => {
    const dom = parse(renderMarkdown(source))
    const btn = dom.querySelector('.md-code-copy-btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    // Raw source (+ the trailing newline markdown-it's fence token always keeps) —
    // NOT the rendered <code>'s escaped/entity-encoded text. Percent-encoded (not
    // escapeHtml'd) so DOMPurify's attribute-value trim can't eat the trailing '\n'.
    expect(decodeURIComponent(btn.dataset.raw ?? '')).toBe(raw + '\n')
  })

  it('the raw content differs from the rendered <code> text — an innerText-based copy would be wrong', () => {
    const dom = parse(renderMarkdown(source))
    const btn = dom.querySelector('.md-code-copy-btn') as HTMLButtonElement
    const code = dom.querySelector('pre code') as HTMLElement
    // The rendered node's escaped markup differs textually from the raw fence source
    // (entities render back to their literal characters via textContent, but the
    // SOURCE markup string itself — e.g. the literal `<div ...>` tag text — only
    // survives in data-raw, never as a live/parsed node in the sanitized output).
    expect(dom.querySelector('.md-code-block div.x')).toBeNull()
    expect(decodeURIComponent(btn.dataset.raw ?? '')).toBe(raw + '\n')
    expect(code.textContent?.trim()).not.toBe('')
  })

  it('bakes the localized idle/copied labels into the button', () => {
    const dom = parse(
      renderMarkdown('```\nhello\n```', { copy: 'Copiar código', copied: 'Copiado' })
    )
    const btn = dom.querySelector('.md-code-copy-btn') as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe('Copiar código')
    expect(btn.getAttribute('title')).toBe('Copiar código')
    expect(btn.dataset.labelIdle).toBe('Copiar código')
    expect(btn.dataset.labelCopied).toBe('Copiado')
  })

  it('gives every fenced block its own independent button with its own raw content', () => {
    const dom = parse(renderMarkdown('```\nfirst\n```\n\n```\nsecond\n```'))
    const btns = [...dom.querySelectorAll('.md-code-copy-btn')] as HTMLButtonElement[]
    expect(btns).toHaveLength(2)
    expect(decodeURIComponent(btns[0].dataset.raw ?? '')).toBe('first\n')
    expect(decodeURIComponent(btns[1].dataset.raw ?? '')).toBe('second\n')
  })

  it('does not loosen the sanitize contract for unrelated data attributes', () => {
    // The seam's DOMPurify config stays ALLOW_DATA_ATTR:false, with only the three
    // T121 attributes explicitly allowlisted — an arbitrary data-* on raw HTML must
    // still be neutralized (html:false escapes it to inert text either way).
    const dom = parse(renderMarkdown('<div data-evil="x">hi</div>'))
    expect(dom.querySelector('[data-evil]')).toBeNull()
  })
})

describe('renderMarkdown — per-table scroll wrapper (BUG-119)', () => {
  it('wraps every table in its own .md-table-scroll container', () => {
    const dom = parse(
      renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n\ntext\n\n| c |\n| - |\n| 3 |')
    )
    const wrappers = [...dom.querySelectorAll('.md-table-scroll')]
    expect(wrappers).toHaveLength(2)
    // One wrapper per table, and the table is its DIRECT child — a wrapper that
    // merely contains the table somewhere below would not be the element whose
    // `overflow-x` confines the scroll.
    for (const wrapper of wrappers) {
      expect(wrapper.children).toHaveLength(1)
      expect(wrapper.firstElementChild?.tagName).toBe('TABLE')
    }
    // Every table is wrapped — none escapes to scroll the whole block.
    expect(dom.querySelectorAll('table')).toHaveLength(2)
    for (const table of dom.querySelectorAll('table')) {
      expect(table.parentElement?.classList.contains('md-table-scroll')).toBe(true)
    }
  })

  it('survives DOMPurify — the wrapper is a plain div, not a stripped node', () => {
    const html = renderMarkdown('| a |\n| - |\n| 1 |')
    expect(html).toContain('<div class="md-table-scroll">')
    expect(html.indexOf('<div class="md-table-scroll">')).toBeLessThan(html.indexOf('<table'))
  })

  it('wraps nothing when there is no table', () => {
    expect(renderMarkdown('# hi\n\njust prose')).not.toContain('md-table-scroll')
  })
})

describe('renderMarkdown — heading id collisions (BUG-119, reverses the v1 call)', () => {
  it('suffixes repeated headings within one render instead of sharing an id', () => {
    const dom = parse(renderMarkdown('## Intro\n\n## Intro\n\n## Intro'))
    const ids = [...dom.querySelectorAll('h2')].map((h) => h.id)
    expect(ids).toEqual(['intro', 'intro-1', 'intro-2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps counting past a suffix a literal heading already claimed', () => {
    const dom = parse(renderMarkdown('## Intro\n\n## Intro 1\n\n## Intro'))
    const ids = [...dom.querySelectorAll('h2')].map((h) => h.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['intro', 'intro-1', 'intro-2'])
  })

  it('leaves the first occurrence on its bare slug, so #anchor links still resolve', () => {
    const html = renderMarkdown('## Hello World!\n\n## Hello World!')
    expect(html).toMatch(/<h2[^>]*id="hello-world"[^>]*>/)
  })

  it('two blocks rendering the SAME source share no id once each carries a prefix', () => {
    const source = '# Report\n\n## Findings\n\n## Findings'
    const a = [...parse(renderMarkdown(source, undefined, 'md1-')).querySelectorAll('[id]')].map(
      (n) => n.id
    )
    const b = [...parse(renderMarkdown(source, undefined, 'md2-')).querySelectorAll('[id]')].map(
      (n) => n.id
    )
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(3)
    expect(a.some((id) => b.includes(id))).toBe(false)
    // The prefix is the ONLY difference — the slugs themselves stay readable.
    expect(a.map((id) => id.replace(/^md1-/, ''))).toEqual(b.map((id) => id.replace(/^md2-/, '')))
  })

  it('is opt-in: a call without a prefix keeps bare slugs', () => {
    expect(renderMarkdown('## Hello World!')).toMatch(/id="hello-world"/)
  })
})
