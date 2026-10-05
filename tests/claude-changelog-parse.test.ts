import { describe, it, expect } from 'vitest'
import { parseClaudeChangelog, MAX_CLAUDE_RELEASES } from '../src/main/claude-changelog-parse'

const DOC = `# Changelog

## 1.2.3
- Added a shiny feature
- Fixed **a bug** with \`--flag\`

## 1.2.2
- Improved [the docs](https://example.com)
`

describe('parseClaudeChangelog', () => {
  it('parses version headings with their bullets, newest first', () => {
    const r = parseClaudeChangelog(DOC)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({
      version: '1.2.3',
      changes: ['Added a shiny feature', 'Fixed a bug with --flag']
    })
    expect(r[1]).toEqual({ version: '1.2.2', changes: ['Improved the docs'] })
  })

  it('ignores headings that are not semver (title, prose, pre-release)', () => {
    const md = '# Changelog\n\n## Unreleased\n- nope\n\n## 1.0.0-beta\n- nope\n\n## 1.0.0\n- yes\n'
    expect(parseClaudeChangelog(md).map((x) => x.version)).toEqual(['1.0.0'])
  })

  it('caps the list at MAX_CLAUDE_RELEASES', () => {
    const md = Array.from(
      { length: MAX_CLAUDE_RELEASES + 5 },
      (_, i) => `## 1.0.${i}\n- item\n`
    ).join('\n')
    expect(parseClaudeChangelog(md)).toHaveLength(MAX_CLAUDE_RELEASES)
  })

  it('returns an empty array for empty or release-less input', () => {
    expect(parseClaudeChangelog('')).toEqual([])
    expect(parseClaudeChangelog('# Changelog\n\njust prose\n')).toEqual([])
  })
})
