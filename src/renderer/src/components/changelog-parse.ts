/**
 * Pure parser for the repo `CHANGELOG.md` (Keep a Changelog format), rendered by
 * the Settings → Changelog tab (`ChangelogPane.vue`). Framework-free so it's
 * unit-testable in the `node` vitest env (`tests/changelog-parse.test.ts`).
 *
 * Recognizes `## <date>` releases, `### <Category>` groups, and `- <item>`
 * bullets (with wrapped continuation lines joined). The `# Changelog` title and
 * any free prose are ignored.
 */

export interface ChangelogGroup {
  category: string
  items: string[]
}

export interface ChangelogRelease {
  date: string
  groups: ChangelogGroup[]
}

/** Strip the inline markdown we use in entries (bold, italic, code, links). */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

export function parseChangelog(md: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let group: ChangelogGroup | null = null

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    const date = /^##\s+(.+)$/.exec(line)
    if (date) {
      release = { date: date[1].trim(), groups: [] }
      group = null
      releases.push(release)
      continue
    }
    if (!release) continue

    const cat = /^###\s+(.+)$/.exec(line)
    if (cat) {
      group = { category: cat[1].trim(), items: [] }
      release.groups.push(group)
      continue
    }

    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item) {
      if (!group) {
        group = { category: '', items: [] }
        release.groups.push(group)
      }
      group.items.push(stripInline(item[1]))
      continue
    }

    // Wrapped continuation: an indented, non-blank line extends the last item.
    if (group && group.items.length && /^\s+\S/.test(raw)) {
      const i = group.items.length - 1
      group.items[i] = stripInline(`${group.items[i]} ${line.trim()}`)
    }
  }

  // Drop releases that carried no items at all (e.g. a bare title-only doc).
  return releases.filter((r) => r.groups.some((g) => g.items.length > 0))
}
