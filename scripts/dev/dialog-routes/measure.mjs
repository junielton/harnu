/**
 * T460 batch 0 — what the baseline measures about one OPEN dialog, and the geometry invariants
 * (spec §6.3 steps 4-5). Shared by `scripts/dev/dialog-baseline.mjs` and
 * `tests/e2e/ci/dialog-geometry.spec.ts`, so "the footer is on screen" means the same thing in both.
 *
 * Nothing here asserts. `measureDialog` reads the live DOM of the ELECTRON renderer; `violations`
 * is a pure function over its result.
 */

/**
 * Read everything §6.3 step 4 lists, from the topmost open `[role="dialog"]`.
 * Runs inside the page, so it must stay self-contained (no closures).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ settleMs?: number }} [opts]
 */
export async function measureDialog(page, opts = {}) {
  // The card scales in over ~140ms (`.anim-fade-in-scale`); measuring mid-animation would read a
  // transformed rect. Wait for the animation set to be empty, then a short settle.
  await page.evaluate(async () => {
    const card = [...document.querySelectorAll('[role="dialog"]')].at(-1)
    const anims = card ? card.getAnimations({ subtree: true }) : []
    await Promise.all(anims.map((a) => a.finished.catch(() => {})))
  })
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs)

  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[role="dialog"]')]
    const card = cards.at(-1)
    if (!card) return { error: 'no [role="dialog"] is open' }

    const rectOf = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        top: round(r.top),
        bottom: round(r.bottom),
        left: round(r.left),
        right: round(r.right),
        width: round(r.width),
        height: round(r.height)
      }
    }
    const round = (n) => Math.round(n * 100) / 100
    const css = (el, props) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))
    }

    // The scrim is the nearest ancestor that covers the viewport (position: fixed). Some
    // surfaces put role="dialog" on the scrim itself.
    let scrim = null
    for (let el = card; el; el = el.parentElement) {
      if (getComputedStyle(el).position === 'fixed' && el !== document.documentElement) {
        scrim = el
        break
      }
    }

    // Header / footer: the semantic element when there is one, else null (a dialog may have none).
    const header = card.querySelector('header')
    const footer = card.querySelector('footer')
    // Body: the first descendant whose own overflow-y scrolls; else null.
    const body =
      [...card.querySelectorAll('*')].find((el) => {
        const oy = getComputedStyle(el).overflowY
        return (oy === 'auto' || oy === 'scroll') && el.clientHeight > 0
      }) ?? null
    const title = card.querySelector('h1, h2, h3')

    const active = document.activeElement
    const activeDesc =
      !active || active === document.body
        ? 'body'
        : [
            active.tagName.toLowerCase(),
            active.getAttribute('data-testid') && `testid=${active.getAttribute('data-testid')}`,
            active.getAttribute('data-test') && `test=${active.getAttribute('data-test')}`,
            active.getAttribute('data-dsqa') && `dsqa=${active.getAttribute('data-dsqa')}`,
            active.getAttribute('aria-label') && `aria-label=${active.getAttribute('aria-label')}`,
            active.id && `id=${active.id}`
          ]
            .filter(Boolean)
            .join(' ')

    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialogsOpen: cards.length,
      card: {
        rect: rectOf(card),
        style: css(card, [
          'width',
          'max-height',
          'height',
          'border-top-left-radius',
          'background-color',
          'padding-top',
          'padding-right',
          'padding-bottom',
          'padding-left',
          'border-top-width'
        ]),
        ariaLabelledby: card.getAttribute('aria-labelledby'),
        ariaLabel: card.getAttribute('aria-label')
      },
      header: { rect: rectOf(header), style: css(header, ['padding-top', 'padding-bottom']) },
      body: {
        rect: rectOf(body),
        scrollHeight: body ? body.scrollHeight : null,
        clientHeight: body ? body.clientHeight : null
      },
      footer: { rect: rectOf(footer), style: css(footer, ['padding-top', 'padding-bottom']) },
      title: {
        text: title ? title.textContent.trim().slice(0, 80) : null,
        style: css(title, ['font-size', 'font-weight', 'line-height'])
      },
      scrim: scrim
        ? { rect: rectOf(scrim), style: css(scrim, ['background-color', 'z-index']) }
        : null,
      pageOverflowY: getComputedStyle(document.body).overflowY,
      activeElement: activeDesc
    }
  })
}

/**
 * The BUG-184 acceptance criteria as a loop over every dialog (spec §6.3 step 5):
 * the card never starts above the viewport, the footer never ends below it, header and footer
 * (when the dialog has them) are on screen, and — for content that is long — the body is what
 * scrolls. Pure; returns human-readable violations, `[]` when the geometry is sound.
 *
 * @param {any} m a `measureDialog` result
 * @param {{ longContent?: boolean }} [opts] `longContent`: the route is seeded with enough rows
 *   that the body MUST overflow its box.
 * @returns {string[]}
 */
export function violations(m, opts = {}) {
  if (m.error) return [m.error]
  const out = []
  const h = m.viewport.height
  const w = m.viewport.width
  const card = m.card.rect
  if (card.top < 0) out.push(`card.top ${card.top} < 0 (the header is above the viewport)`)
  if (card.bottom > h) out.push(`card.bottom ${card.bottom} > innerHeight ${h}`)
  if (card.left < 0 || card.right > w)
    out.push(`card is wider than the viewport (${card.left}..${card.right} of ${w})`)
  for (const part of ['header', 'footer']) {
    const r = m[part].rect
    if (!r) continue
    if (r.top < 0 || r.bottom > h) {
      out.push(`${part} is off screen (${r.top}..${r.bottom} of ${h})`)
    }
  }
  if (opts.longContent) {
    if (!m.body.rect) out.push('long content but no scrolling body was found')
    else if (!(m.body.scrollHeight > m.body.clientHeight)) {
      out.push(
        `body does not scroll (scrollHeight ${m.body.scrollHeight} <= clientHeight ${m.body.clientHeight})`
      )
    }
  }
  return out
}
