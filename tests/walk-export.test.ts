import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createWalkStore, type WalkStore } from '../src/main/walk/walk-store'
import { exportWalk } from '../src/main/walk/walk-export'
import { done, endRun, fail, skip, startRun, type Run } from '../src/shared/walk-machine'
import type { WalkScript } from '../src/shared/walk-schema'

// AC-23: Export writes the walk as Markdown, never overwrites a file, and copies the script's images (D-13).

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex'
)

const check = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Check ${id}`,
  why: 'Because.',
  where: { text: `the ${id} page` },
  do: [{ text: `Do ${id}.`, see: `You see ${id}.` }],
  passes: `${id} works.`,
  fails: `${id} is broken.`,
  nothingFromHere: 'Only eyes can tell.',
  ...over
})

const script = {
  title: 'Add CSV export',
  purpose: 'check',
  source: {
    kind: 'pr',
    number: 48,
    title: 'Add CSV export',
    author: 'alex',
    url: 'https://github.com/example-org/example-web/pull/48'
  },
  checks: [
    check('c1', {
      title: 'Export is in the toolbar',
      where: {
        text: 'the Orders page',
        path: 'Orders > Toolbar',
        approximate: true,
        links: [
          { label: 'local app', kind: 'url', target: 'http://localhost:5173/orders' },
          { label: 'PR #48', kind: 'pr', target: '48' },
          { label: 'build-csv.ts', kind: 'file', target: 'src/build-csv.ts', line: 12 }
        ]
      },
      images: [
        { src: 'images/expected.png', alt: 'The toolbar', kind: 'expected', caption: 'The toolbar' }
      ]
    }),
    check('c2', {
      title: 'An empty table exports a header row',
      do: [
        { text: 'Type `zzzz` in the filter.', see: 'No rows match.' },
        { text: 'Click Export.', see: 'A file downloads.' }
      ],
      passes: 'A file with only the header line.',
      fails: 'An empty file.'
    }),
    check('c3', { title: 'A 10,000-row table exports without freezing the page' })
  ]
} as unknown as WalkScript

let root: string
let store: WalkStore
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-export-')))
  store = createWalkStore(root, { now: () => Date.parse('2026-11-16T12:00:00Z') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A walk whose image lives in its own folder, as `walk_open` leaves it, and one finished run. */
async function walked(): Promise<{ walkId: string; runId: string; shot: string }> {
  const made = await store.createWalk(script, {
    transform: async (s, { walkDir }) => {
      mkdirSync(join(walkDir, 'images'), { recursive: true })
      writeFileSync(join(walkDir, 'images', 'expected.png'), PNG)
      return s
    }
  })
  const { walkId, runId } = made
  const shotDir = store.shotsDir(walkId, runId)
  mkdirSync(shotDir, { recursive: true })
  const shot = join(shotDir, 'shot-1.png')
  writeFileSync(shot, PNG)
  const step = (fn: (r: Run) => ReturnType<typeof done>): Promise<unknown> =>
    store.updateRun(walkId, runId, (r) => fn(r))
  await step((r) => startRun(r, Date.parse('2026-11-16T12:01:00Z')))
  await step((r) => done(r, 1)) // c1 passes
  await step((r) => fail(r, { line: 'Header row missing when the table is empty.', shot, now: 2 })) // c2
  await step((r) => endRun(r, Date.parse('2026-11-16T12:30:00Z')))
  return { walkId, runId, shot }
}

describe('walk export', () => {
  it('exports markdown, never overwrites and copies images', async () => {
    const { walkId, runId } = await walked()
    const res = await exportWalk(store, { walkId, runId })
    if (!res.ok) throw new Error(`refused ${res.error.code}`)

    // it lives in the walk's own folder, under the machine's `.harnu/walks/<id>/`
    expect(res.path.startsWith(join(store.walkDir(walkId)))).toBe(true)
    expect(res.path.endsWith('.md')).toBe(true)
    const md = readFileSync(res.path, 'utf8')

    // the title, then the source line with the PR as a link
    expect(md.split('\n')[0]).toBe('# Add CSV export')
    expect(md).toContain(
      'Source: [PR #48 · Add CSV export · alex](https://github.com/example-org/example-web/pull/48)'
    )
    // the checks in order, numbered, each with Where, Do with its see lines, You should see and the Not line
    const at = (s: string): number => md.indexOf(s)
    expect(at('### 1. Export is in the toolbar')).toBeGreaterThan(-1)
    expect(at('### 1.')).toBeLessThan(at('### 2. An empty table exports a header row'))
    expect(at('### 2.')).toBeLessThan(
      at('### 3. A 10,000-row table exports without freezing the page')
    )
    expect(md).toContain('**Where:** the Orders page (Orders > Toolbar, roughly)')
    expect(md).toContain('1. Type `zzzz` in the filter.')
    expect(md).toContain('   - You see: No rows match.')
    expect(md).toContain('2. Click Export.')
    expect(md).toContain('**You should see:** A file with only the header line.')
    expect(md).toContain('**Not:** An empty file.')
    expect(md).toContain("**I'll check:** Nothing from here. Only eyes can tell.")
    // links stay links: a URL, a PR resolved against the source's PR, a file as its path
    expect(md).toContain('[local app](http://localhost:5173/orders)')
    expect(md).toContain('[PR #48](https://github.com/example-org/example-web/pull/48)')
    expect(md).toContain('`src/build-csv.ts:12`')

    // the last run: a table with the operator's note
    expect(md).toContain('## Last run')
    expect(md).toContain('Run 1 · 2026-11-16')
    expect(md).toMatch(/\| 1 \| Export is in the toolbar \| passed \|/)
    expect(md).toMatch(
      /\| 2 \| An empty table exports a header row \| failed \| “Header row missing when the table is empty\.”/
    )
    expect(md).toMatch(
      /\| 3 \| A 10,000-row table exports without freezing the page \| not reached \|/
    )

    // D-13: the script's images are copied beside the file and referenced by a relative path
    const here = dirname(res.path)
    expect(existsSync(join(here, 'images', 'expected.png'))).toBe(true)
    expect(readFileSync(join(here, 'images', 'expected.png')).equals(PNG)).toBe(true)
    expect(md).toContain('![The toolbar](images/expected.png)')
    expect(res.images).toBe(1)
    // the operator's screenshot is copied too, so the note still opens when the file is shared
    expect(res.shots).toBe(1)
    expect(md).toMatch(/\[screenshot\]\(shots\/[^)]+\.png\)/)

    // nothing was overwritten: a second export is a new file with a suffix, the first is byte-identical
    const second = await exportWalk(store, { walkId, runId })
    if (!second.ok) throw new Error(`refused ${second.error.code}`)
    expect(second.path).not.toBe(res.path)
    expect(readFileSync(res.path, 'utf8')).toBe(md)
    expect(existsSync(second.path)).toBe(true)
    // and a third: every earlier export is still exactly as it was written
    const secondMd = readFileSync(second.path, 'utf8')
    const third = await exportWalk(store, { walkId, runId })
    if (!third.ok) throw new Error(`refused ${third.error.code}`)
    expect(readFileSync(res.path, 'utf8')).toBe(md)
    expect(readFileSync(second.path, 'utf8')).toBe(secondMd)
    expect(new Set([res.path, second.path, third.path]).size).toBe(3)
    expect(readdirSync(join(store.walkDir(walkId), 'exports'))).toHaveLength(3)
  })

  it('exports a walk that was never walked without a last-run table, and refuses what is not there', async () => {
    const made = await store.createWalk(script)
    const res = await exportWalk(store, { walkId: made.walkId })
    if (!res.ok) throw new Error(`refused ${res.error.code}`)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('### 3. A 10,000-row table exports without freezing the page')
    expect(md).toContain('## Last run')
    expect(md).toContain('Not walked yet.')
    expect(md).not.toContain('| # |')
    expect(await exportWalk(store, { walkId: 'wlk-00000000' })).toMatchObject({
      ok: false,
      error: { code: 'WALK_NOT_FOUND' }
    })
    expect(await exportWalk(store, { walkId: made.walkId, runId: 'run-deadbeef' })).toMatchObject({
      ok: false,
      error: { code: 'RUN_NOT_FOUND' }
    })
  })

  it('shows a skipped check as skipped in the table', async () => {
    const made = await store.createWalk(script)
    const step = (fn: (r: Run) => ReturnType<typeof done>): Promise<unknown> =>
      store.updateRun(made.walkId, made.runId, (r) => fn(r))
    await step((r) => startRun(r, 1))
    await step((r) => skip(r, 2))
    await step((r) => endRun(r, 3))
    const res = await exportWalk(store, { walkId: made.walkId, runId: made.runId })
    if (!res.ok) throw new Error(`refused ${res.error.code}`)
    expect(readFileSync(res.path, 'utf8')).toMatch(/\| 1 \| Export is in the toolbar \| skipped \|/)
  })
})
