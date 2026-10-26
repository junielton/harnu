// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildSelector, cssEscape, describeNode } from '../src/preload/overlay/selector'
import {
  componentFromAttributes,
  computedStyles,
  discoverComponent,
  normalizeComponentSource,
  outerHtmlShallow,
  probeSource
} from '../src/preload/overlay/capture'
import { COMPUTED_STYLE_ALLOWLIST, MAX_STYLES } from '../src/shared/browser-comment'

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

describe('buildSelector', () => {
  it('prefers a unique data-testid', () => {
    const d = page('<main><button data-testid="pay" id="x" class="btn">Pay</button></main>')
    expect(buildSelector(d.querySelector('button')!, d)).toBe('[data-testid="pay"]')
  })

  it('falls back to a unique id', () => {
    const d = page('<main><button id="pay" class="btn">Pay</button></main>')
    expect(buildSelector(d.querySelector('button')!, d)).toBe('#pay')
  })

  it('skips a data-testid that is not unique', () => {
    const d = page(
      '<ul><li data-testid="row" class="a">1</li><li data-testid="row" class="b">2</li></ul>'
    )
    const sel = buildSelector(d.querySelectorAll('li')[1]!, d)
    expect(sel).not.toContain('data-testid')
    expect(d.querySelectorAll(sel)).toHaveLength(1)
  })

  it('builds the shortest unique tag.class path, with nth-of-type for same-tag siblings', () => {
    const d = page(
      '<section><form class="checkout"><button class="btn primary">A</button><button class="btn">B</button></form><p>x</p></section>'
    )
    const target = d.querySelectorAll('button')[1]!
    const sel = buildSelector(target, d)
    expect(d.querySelectorAll(sel)).toHaveLength(1)
    expect(d.querySelector(sel)).toBe(target)
    expect(sel.split(' > ').length).toBeLessThanOrEqual(2)
  })

  it('anchors on a unique ancestor id instead of walking to the root', () => {
    const d = page(
      '<div><div id="app"><div><span>a</span><span>b</span></div></div><div><div><span>c</span><span>d</span></div></div></div>'
    )
    const target = d.querySelectorAll('span')[1]!
    const sel = buildSelector(target, d)
    expect(sel.startsWith('#app')).toBe(true)
    expect(d.querySelector(sel)).toBe(target)
  })

  it('ignores generated-looking class names', () => {
    const d = page('<div class="css-1a2b3c4 real"><i class="sc-AbC123x"></i><i>y</i></div>')
    const sel = buildSelector(d.querySelector('i')!, d)
    expect(sel).not.toMatch(/css-1a2b3c4|sc-AbC123x/)
    expect(d.querySelector(sel)).toBe(d.querySelector('i'))
  })

  it('caps at 512 characters', () => {
    let html = '<span>x</span>'
    for (let i = 0; i < 400; i++) html = `<div class="level-${i}">${html}</div>`
    const d = page(html)
    expect(buildSelector(d.querySelector('span')!, d).length).toBeLessThanOrEqual(512)
  })

  it('escapes odd ids and classes', () => {
    const d = page('<div id="a:b.c"></div><p class="x:y">t</p>')
    expect(d.querySelector(buildSelector(d.querySelector('div')!, d))).toBe(d.querySelector('div'))
    expect(d.querySelector(buildSelector(d.querySelector('p')!, d))).toBe(d.querySelector('p'))
    expect(cssEscape('1a')).toBeTruthy()
  })
})

describe('describeNode', () => {
  it('names the tag, up to two classes and the size', () => {
    const d = page('<button class="btn primary extra">x</button>')
    expect(describeNode(d.querySelector('button')!, { width: 167.6, height: 40.2 })).toBe(
      'button.btn.primary · 168×40'
    )
  })
  it('prefers an ARIA role when it is a plain word', () => {
    const d = page('<div role="dialog" class="m">x</div>')
    expect(describeNode(d.querySelector('div')!, { width: 10, height: 20 })).toBe(
      'dialog.m · 10×20'
    )
  })
})

describe('outerHtmlShallow', () => {
  it('elides children past depth 2 and never mutates the page', () => {
    const d = page(
      '<div id="r"><section><article><p>deep <b>deeper</b></p></article></section></div>'
    )
    const root = d.querySelector('#r')!
    const html = outerHtmlShallow(root)
    expect(html).toContain('<section>')
    expect(html).toContain('<article>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('…')
    expect(d.querySelector('b')).not.toBeNull()
  })
  it('drops typed values and script/style bodies', () => {
    const d = page(
      '<form><input value="hunter2" type="password"><textarea>secret</textarea><script>steal()</script></form>'
    )
    const html = outerHtmlShallow(d.querySelector('form')!)
    expect(html).not.toContain('hunter2')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('steal()')
  })
  it('caps at about 2 KB', () => {
    const d = page(`<div>${'x'.repeat(9000)}</div>`)
    expect(outerHtmlShallow(d.querySelector('div')!).length).toBeLessThanOrEqual(2049)
  })
})

describe('computedStyles', () => {
  it('reads only allowlisted properties, at most 40', () => {
    const d = page(
      '<div id="s" style="color: red; display: block; --secret: 1; background-image: url(x)"></div>'
    )
    const styles = computedStyles(d.querySelector('#s')!, window)
    expect(styles.color).toBeTruthy()
    expect(styles['--secret']).toBeUndefined()
    expect(styles['background-image']).toBeUndefined()
    for (const k of Object.keys(styles)) expect(COMPUTED_STYLE_ALLOWLIST).toContain(k)
    expect(Object.keys(styles).length).toBeLessThanOrEqual(MAX_STYLES)
  })
})

describe('component discovery', () => {
  it('reads Vue data-v-inspector from the node or an ancestor and keeps file:line only', () => {
    const d = page(
      '<div data-v-inspector="src/components/PayButton.vue:42:7"><span id="in">x</span></div>'
    )
    expect(componentFromAttributes(d.querySelector('#in')!)).toBe('src/components/PayButton.vue:42')
  })
  it('is null when nothing says', () => {
    const d = page('<div><span id="in">x</span></div>')
    expect(componentFromAttributes(d.querySelector('#in')!)).toBeNull()
  })
  it('normalises a source string and refuses junk', () => {
    expect(normalizeComponentSource('src/A.vue')).toBe('src/A.vue')
    expect(normalizeComponentSource('src/A.vue:3')).toBe('src/A.vue:3')
    expect(normalizeComponentSource('src/A.vue:3:9')).toBe('src/A.vue:3')
    expect(normalizeComponentSource('a\u0007b\nc')).toBe('abc')
    expect(normalizeComponentSource('x'.repeat(500))).toBeNull()
    expect(normalizeComponentSource('')).toBeNull()
    expect(normalizeComponentSource({ file: 'x' })).toBeNull()
  })
  it('falls back to a bounded page-world probe by POINT and never writes onto the page node', async () => {
    const d = page('<div id="n">x</div>')
    const el = d.querySelector('#n')!
    const seenAttrs: string[][] = []
    const observer = new MutationObserver(() => undefined)
    observer.observe(el, { attributes: true })
    let code = ''
    const out = await discoverComponent(
      el,
      {
        executeJavaScript: async (c) => {
          code = c
          seenAttrs.push(Array.from(el.attributes).map((a) => a.name))
          return 'src/Dev.svelte:9'
        }
      },
      { x: 12.4, y: 30.6 }
    )
    expect(out).toBe('src/Dev.svelte:9')
    // The probe addresses the node by where it was clicked, so the page node carries nothing at any moment.
    expect(code).toContain('elementsFromPoint(12, 31)')
    expect(seenAttrs).toEqual([['id']])
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })
  it('gives up silently on a probe that hangs or throws', async () => {
    const d = page('<div id="n">x</div>')
    const el = d.querySelector('#n')!
    const pt = { x: 1, y: 1 }
    expect(
      await discoverComponent(el, { executeJavaScript: () => new Promise(() => undefined) }, pt, 20)
    ).toBeNull()
    expect(
      await discoverComponent(
        el,
        {
          executeJavaScript: async () => {
            throw new Error('x')
          }
        },
        pt
      )
    ).toBeNull()
  })
  it('prefers the DOM attribute and does not run the probe at all', async () => {
    const d = page('<div data-v-inspector="src/A.vue:1:1"><i id="n"></i></div>')
    let ran = false
    const out = await discoverComponent(
      d.querySelector('#n')!,
      { executeJavaScript: async () => ((ran = true), null) },
      { x: 1, y: 1 }
    )
    expect(out).toBe('src/A.vue:1')
    expect(ran).toBe(false)
  })
  it('the probe source reads the three framework markers', () => {
    const src = probeSource(10, 20)
    expect(src).toContain('__vueParentComponent')
    expect(src).toContain('__reactFiber$')
    expect(src).toContain('_debugSource')
    expect(src).toContain('__svelte_meta')
    expect(src).toContain('elementsFromPoint(10, 20)')
    expect(src).toContain('data-harnu-overlay')
    expect(src).not.toContain('data-harnu-probe')
  })
})
