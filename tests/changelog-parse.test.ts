import { describe, it, expect } from 'vitest'
import { parseChangelog } from '../src/renderer/src/components/changelog-parse'

const DOC = `# Changelog

Some intro paragraph to ignore.

## 2026-06-18
### Added
- statusLine telemetry cockpit
- Settings changelog tab
### Fixed
- usage-store telemetry mock

## 2026-06-17
### Added
- Feature exploration v2
`

describe('parseChangelog', () => {
  it('parses dated releases with their categorized items, newest first', () => {
    const releases = parseChangelog(DOC)
    expect(releases).toHaveLength(2)

    expect(releases[0].date).toBe('2026-06-18')
    expect(releases[0].groups).toEqual([
      { category: 'Added', items: ['statusLine telemetry cockpit', 'Settings changelog tab'] },
      { category: 'Fixed', items: ['usage-store telemetry mock'] }
    ])

    expect(releases[1].date).toBe('2026-06-17')
    expect(releases[1].groups).toEqual([{ category: 'Added', items: ['Feature exploration v2'] }])
  })

  it('ignores the top-level title and free prose', () => {
    const releases = parseChangelog(DOC)
    expect(releases.map((r) => r.date)).toEqual(['2026-06-18', '2026-06-17'])
  })

  it('strips inline markdown emphasis from items', () => {
    const md = '## 2026-06-18\n### Added\n- **Bold thing** plain and `code`\n'
    expect(parseChangelog(md)[0].groups[0].items[0]).toBe('Bold thing plain and code')
  })

  it('puts items that precede any category under an empty-named group', () => {
    const md = '## 2026-06-18\n- loose item\n### Added\n- grouped item\n'
    const r = parseChangelog(md)[0]
    expect(r.groups[0]).toEqual({ category: '', items: ['loose item'] })
    expect(r.groups[1]).toEqual({ category: 'Added', items: ['grouped item'] })
  })

  it('joins wrapped continuation lines into the preceding item', () => {
    const md = '## 2026-06-18\n### Added\n- a long item that wraps\n  onto a second line\n'
    expect(parseChangelog(md)[0].groups[0].items[0]).toBe(
      'a long item that wraps onto a second line'
    )
  })

  it('returns an empty array for empty or title-only input', () => {
    expect(parseChangelog('')).toEqual([])
    expect(parseChangelog('# Changelog\n\njust prose\n')).toEqual([])
  })
})
