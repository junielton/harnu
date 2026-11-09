/**
 * Memory U2 S-1 fixture: a large project-memory tree built from code, so the repo carries no
 * 2,000 generated files. `writeMemoryTree` lays out `hot.md`, `decisions.md`, `roadmap/` and
 * `sessions/` exactly as Harnu writes them; the card and digest ids are deterministic.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface FixtureShape {
  cards: number
  inProgress: number
  ready: number
  digests: number
}

/** The AC-5 / AC-8 corpus: 800 cards (60 in-progress, 60 ready) and 1,300 digests. */
export const LARGE: FixtureShape = { cards: 800, inProgress: 60, ready: 60, digests: 1300 }

/** A small corpus for the shape tests. */
export const SMALL: FixtureShape = { cards: 6, inProgress: 2, ready: 2, digests: 5 }

const OTHER_STATUSES = ['review', 'backlog', 'done'] as const

export function cardId(i: number): string {
  return `T${String(i + 1).padStart(4, '0')}`
}

export function cardStatus(i: number, shape: FixtureShape): string {
  if (i < shape.inProgress) return 'in-progress'
  if (i < shape.inProgress + shape.ready) return 'ready'
  return OTHER_STATUSES[i % OTHER_STATUSES.length]
}

/** A long-ish, deterministic card title (about 90 characters) so rows are realistic. */
export function cardTitle(i: number): string {
  return `Memory ch.${(i % 9) + 1} · slice ${i + 1} · tiered read, capped index and a title that is long enough`
}

export function cardSlug(i: number): string {
  return `${cardId(i)}-memory-ch-${(i % 9) + 1}-slice-${i + 1}-tiered-read-capped-index`
}

export function cardFile(i: number, shape: FixtureShape): string {
  const status = cardStatus(i, shape)
  const lines = ['---', `id: ${cardId(i)}`, `title: ${cardTitle(i)}`, `status: ${status}`]
  if (status === 'in-progress') lines.push(`executedIn: card/${cardSlug(i)}`)
  lines.push(
    'provenance:',
    '  author: agent',
    '  at: 2026-11-09T10:00:00.000Z',
    '---',
    '',
    'Body.',
    ''
  )
  return lines.join('\n')
}

/** Digest file name `YYYY-MM-DD-<8 hex>.md`, strictly increasing with `i` (older first). */
export function digestName(i: number): string {
  const day = new Date(Date.UTC(2025, 0, 1) + Math.floor(i / 3) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  return `${day}-${i.toString(16).padStart(8, '0')}.md`
}

export function digestFile(i: number): string {
  const sid = `${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`
  const withProvenance = i % 2 === 0
  return [
    `# Session digest ${i}`,
    '',
    'Did some work.',
    '',
    ...(withProvenance
      ? [
          `> provenance: author=agent · at=2026-11-09T10:00:00Z · branch=card/x-${i} · session=${sid}`
        ]
      : []),
    ''
  ].join('\n')
}

export const HOT_SMALL = [
  '# Where we left off',
  '',
  '## Next action',
  '',
  '- Ship S-1',
  '',
  '> provenance: author=harnu · at=2026-11-09T10:00:00Z',
  ''
].join('\n')

const DECISIONS = [
  '# Decisions',
  '',
  '## Cap the read',
  '',
  '> entry: e-1a2b3c4d · valid_from=2026-11-04',
  '> provenance: author=agent · at=2026-11-04T10:00:00Z',
  '',
  '## Paginate the rest',
  '',
  '> entry: e-2b3c4d5e · valid_from=2026-11-05',
  '> provenance: author=agent · at=2026-11-05T10:00:00Z',
  ''
].join('\n')

/** Write the whole tree under `memoryDir`. Returns it for chaining. */
export async function writeMemoryTree(
  memoryDir: string,
  shape: FixtureShape,
  hot: string = HOT_SMALL
): Promise<string> {
  await fs.mkdir(path.join(memoryDir, 'roadmap'), { recursive: true })
  await fs.mkdir(path.join(memoryDir, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(memoryDir, 'hot.md'), hot)
  await fs.writeFile(path.join(memoryDir, 'decisions.md'), DECISIONS)
  const writes: Promise<void>[] = []
  for (let i = 0; i < shape.cards; i++) {
    writes.push(
      fs.writeFile(path.join(memoryDir, 'roadmap', `${cardSlug(i)}.md`), cardFile(i, shape))
    )
  }
  for (let i = 0; i < shape.digests; i++) {
    writes.push(fs.writeFile(path.join(memoryDir, 'sessions', digestName(i)), digestFile(i)))
  }
  await Promise.all(writes)
  return memoryDir
}
