// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import type { Run, Worker } from '../src/preload'

/**
 * T311 — a run's `result` is rendered as prose, through the app's ONE markdown
 * seam, on BOTH surfaces that show it.
 *
 * `Run.result` is whatever the model wrote in a headless `claude -p`, which for
 * a real worker is a full triage report: headings, bold, a wide markdown table.
 * The LAST RESULT card printed it with no `pre-wrap` (every newline collapsed
 * into one run-on paragraph) and the run-row disclosure printed it WITH
 * `pre-wrap` but raw (`##`, `**` and table pipes on screen). One field, two
 * renderings, both wrong — the inconsistency as much as the raw markdown.
 *
 * These assert what a reader sees, not that a sanitizer is wired: the XSS case
 * uses a genuinely hostile string and looks for a live node.
 */

function run(over: Partial<Run> = {}): Run {
  return {
    workerId: 'w1',
    startedAt: Date.parse('2026-09-08T09:00:00.000Z'),
    endedAt: Date.parse('2026-09-08T09:00:20.000Z'),
    durationMs: 20_000,
    status: 'ok',
    result: '',
    terminalReason: 'completed',
    numTurns: 3,
    costUsd: 0.02,
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    denials: [],
    ...over
  }
}

const REPORT = [
  '## Triage report',
  '',
  'Found **3** stale branches.',
  '',
  '| Branch | Age | Owner |',
  '| --- | --- | --- |',
  '| feat/a | 12d | ana |',
  '| feat/b | 30d | bo |'
].join('\n')

const STACK_TRACE = [
  'Error: ENOENT: no such file or directory',
  '    at Object.openSync (node:fs:596:3)',
  '    at readFileSync (node:fs:464:35)',
  '    at load (/repo/src/main/index.ts:12:9)'
].join('\n')

const JSON_BLOB = ['{', '  "ok": false,', '  "checked": 12', '}'].join('\n')

const HOSTILE = [
  'Report follows.',
  '',
  '<script>window.__pwned = 1</script>',
  '',
  '<img src=x onerror="window.__pwned = 2">',
  '',
  '[click me](javascript:window.__pwned=3)'
].join('\n')

const WORKER: Worker = {
  id: 'w1',
  name: 'PR watcher',
  enabled: true,
  prompt: 'Check for new PRs.',
  folder: '/repo/alpha',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  notifyOn: 'silent',
  failureStreak: 0
}

let storedRuns: Run[] = []
const schedulerRuns = vi.fn(async () => storedRuns)

beforeEach(() => {
  schedulerRuns.mockClear()
  const api = {
    schedulerRuns,
    bundledSkillsGet: vi.fn(async () => ({ catalog: [], enabled: {} })),
    bundledSkillsGetFolder: vi.fn(async () => ({})),
    skillsAvailable: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

function mountDetail() {
  return mount(SchedulerWorkerDetail, {
    props: { worker: WORKER, running: false, nowMs: Date.now() },
    global: { plugins: [i18n] }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

/** Mount with ONE stored run, and open its row — so the LAST RESULT card and the
 * disclosure are showing the very same `Run.result` at the same time. */
async function mountWithOpenRow(result: string) {
  storedRuns = [run({ result })]
  const w = mountDetail()
  await settle()
  await w.findAll('[data-dsqa="run-row"]')[0].trigger('click')
  await settle()
  return w
}

describe('T311 — a run result renders as prose, on both surfaces', () => {
  it('renders markdown, not the markdown source (AC-1)', async () => {
    const w = await mountWithOpenRow(REPORT)
    const blocks = w.findAll('[data-dsqa="run-result-prose"]')
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      // Structure, not source.
      expect(block.find('h2').exists()).toBe(true)
      expect(block.find('strong').text()).toBe('3')
      expect(block.find('table').exists()).toBe(true)
      expect(block.findAll('th').map((c) => c.text())).toEqual(['Branch', 'Age', 'Owner'])
      // None of the syntax survives as literal text.
      const text = block.text()
      expect(text).not.toContain('##')
      expect(text).not.toContain('**')
      expect(text).not.toContain('| --- |')
    }
  })

  it('renders the SAME string identically on both surfaces (AC-2)', async () => {
    const w = await mountWithOpenRow(REPORT)
    const [card, disclosure] = w.findAll('[data-dsqa="run-result-prose"]')
    // Same container contract...
    expect(disclosure.attributes('class')).toBe(card.attributes('class'))

    // ...and identical rendered prose — EXCEPT the heading ids, which must not
    // be identical. This test used to assert byte-identity including the ids,
    // and that is exactly how it documented BUG-119's third defect: two blocks a
    // few pixels apart, on one page, emitting the same `id` for the same
    // heading. Invalid HTML, and a document-wide `getElementById` or an
    // assistive tech's heading map lands on whichever came first. The renderer
    // now prefixes each instance's ids, so the assertion is split in two rather
    // than relaxed: the prose is identical once the ids are normalized, and the
    // raw ids are provably different.
    const normalize = (html: string): string => html.replace(/\bid="md\d+-/g, 'id="md-')
    expect(normalize(disclosure.element.innerHTML)).toBe(normalize(card.element.innerHTML))

    const headingIds = (root: Element): string[] =>
      [...root.querySelectorAll('[id]')].map((n) => n.id)
    const cardIds = headingIds(card.element)
    const disclosureIds = headingIds(disclosure.element)
    expect(cardIds.length).toBeGreaterThan(0)
    expect(cardIds).toHaveLength(disclosureIds.length)
    expect(cardIds.some((id) => disclosureIds.includes(id))).toBe(false)
  })

  it('clamps its height and scrolls on both axes (AC-3, AC-4)', async () => {
    const w = await mountWithOpenRow(REPORT)
    for (const block of w.findAll('[data-dsqa="run-result-prose"]')) {
      const cls = block.attributes('class') ?? ''
      // A bounded scroll container: a long report never pushes the tab off
      // screen, and a wide markdown table scrolls inside the block instead of
      // widening the panel. jsdom has no layout engine, so the class list IS
      // the observable contract here (same reasoning as the scrollbars test).
      expect(cls).toContain('max-h-[220px]')
      expect(cls).toContain('overflow-auto')
      expect(cls).toContain('scrollable')
    }
  })

  it('an empty result keeps the empty-state copy, on both surfaces (AC-5)', async () => {
    storedRuns = [run({ status: 'stopped', result: '', terminalReason: 'stopped' })]
    const w = mountDetail()
    await settle()
    await w.findAll('[data-dsqa="run-row"]')[0].trigger('click')
    await settle()
    // No prose block at all — not a blank one.
    expect(w.findAll('[data-dsqa="run-result-prose"]')).toHaveLength(0)
    // The line appears twice: once in the LAST RESULT card, once in the row.
    const copies = w.text().split('This run produced no result.').length - 1
    expect(copies).toBe(2)
    // And never the bare em-dash the LAST RESULT card used to print.
    expect(w.get('[data-dsqa="last-result-body"]').text()).not.toContain('—')
  })

  it('a result that is whitespace-only is also empty, not a blank block (AC-5)', async () => {
    const w = await mountWithOpenRow('   \n  \n')
    expect(w.findAll('[data-dsqa="run-result-prose"]')).toHaveLength(0)
  })

  it('keeps the line breaks of a stack trace (AC-6)', async () => {
    const w = await mountWithOpenRow(STACK_TRACE)
    for (const block of w.findAll('[data-dsqa="run-result-prose"]')) {
      // markdown-it runs with `breaks: false`, so the newlines survive into the
      // HTML but would collapse to spaces without `pre-wrap` — which is exactly
      // what turned LAST RESULT into one run-on line. The block's `.result-prose`
      // class carries that rule; the newlines have to still BE there for it to
      // have anything to preserve.
      expect(block.attributes('class')).toContain('result-prose')
      expect(block.element.innerHTML).toContain('\nat Object.openSync')
      expect(block.text()).toContain('node:fs:596:3')
      // KNOWN, MEASURED LIMITATION (T311): markdown-it strips the leading
      // whitespace of a paragraph's continuation lines, so the frames' 4-space
      // indent is gone — one frame per line survives, the indent does not.
      // Fixing that means changing the shared seam, which six other consumers
      // depend on; it is deliberately NOT done here.
      expect(block.element.innerHTML).not.toContain('\n    at')
    }
  })

  it('keeps the shape of a JSON blob, and does not mangle a bare sentence (AC-6)', async () => {
    const json = await mountWithOpenRow(JSON_BLOB)
    for (const block of json.findAll('[data-dsqa="run-result-prose"]')) {
      // Same limitation: the line breaks survive, the 2-space indent does not.
      expect(block.element.innerHTML).toContain('\n"ok": false,')
    }
    const plain = await mountWithOpenRow('Nothing changed since yesterday.')
    for (const block of plain.findAll('[data-dsqa="run-result-prose"]')) {
      expect(block.find('p').text()).toBe('Nothing changed since yesterday.')
    }
  })

  it('renders a hostile result inert (AC-7)', async () => {
    const w = await mountWithOpenRow(HOSTILE)
    const blocks = w.findAll('[data-dsqa="run-result-prose"]')
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      const el = block.element
      // Nothing executable survived as a NODE...
      expect(el.querySelector('script')).toBeNull()
      expect(el.querySelector('img')).toBeNull()
      expect(el.querySelector('[onerror]')).toBeNull()
      // ...no anchor points at a javascript: URI...
      for (const a of Array.from(el.querySelectorAll('a'))) {
        expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i)
      }
      // ...and the tags are on screen as the literal text a reader should see.
      expect(block.text()).toContain('<script>window.__pwned = 1</script>')
      // markdown-it's own `validateLink` rejects the scheme before DOMPurify
      // ever sees it, so the link never becomes an anchor at all.
      expect(block.text()).toContain('[click me](javascript:window.__pwned=3)')
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
