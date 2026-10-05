/**
 * Pure parser for the Claude Code CLI's CHANGELOG.md (fetched from GitHub raw).
 * Framework-free so it's unit-testable in the node vitest env. The Claude Code
 * format differs from Harnu's own CHANGELOG (`changelog-parse.ts`): version
 * headings `## X.Y.Z` + flat `- ` bullets — no `### Category` groups, no dates.
 */

export interface ClaudeRelease {
  /** Semver string, e.g. "1.2.3". */
  version: string
  /** Bullet lines under the version, inline markdown stripped. */
  changes: string[]
}

/** Cap on retained releases (newest-first), matching the standalone watcher. */
export const MAX_CLAUDE_RELEASES = 20

/** Strip the inline markdown we expect in entries (code, bold, italic, links). */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

export function parseClaudeChangelog(md: string): ClaudeRelease[] {
  const sections = md.split(/^## /m).slice(1)
  const releases: ClaudeRelease[] = []

  for (const section of sections) {
    if (releases.length >= MAX_CLAUDE_RELEASES) break
    const lines = section.split('\n')
    const version = (lines[0] ?? '').trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue
    const changes = lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => stripInline(l.slice(2)))
    releases.push({ version, changes })
  }

  return releases
}
