// Pure predicate for the CHANGELOG contract gate (T65 AC1). Given the files a PR
// changed plus its labels, decide whether it honors the "touch src/ ⇒ touch
// CHANGELOG.md" contract from CLAUDE.md. No I/O, no git — unit-testable in
// isolation (list of files → verdict). The CLI wrapper in changelog-gate.mjs
// feeds it the real diff.

export const SRC_PREFIX = 'src/'
export const CHANGELOG_FILE = 'CHANGELOG.md'
export const ESCAPE_LABEL = 'no-changelog'

/**
 * @param {{ changedFiles: string[], labels?: string[] }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function changelogGateVerdict({ changedFiles, labels = [] }) {
  const norm = changedFiles.map((f) => f.replace(/^\.\//, '').replace(/\\/g, '/'))
  const touchedSrc = norm.filter((f) => f.startsWith(SRC_PREFIX))
  const touchedChangelog = norm.some((f) => f === CHANGELOG_FILE)
  const escaped = labels.includes(ESCAPE_LABEL)

  if (touchedSrc.length === 0) {
    return { ok: true, reason: 'no src/ changes — CHANGELOG not required' }
  }
  if (touchedChangelog) {
    return { ok: true, reason: 'CHANGELOG.md updated alongside src/ changes' }
  }
  if (escaped) {
    return {
      ok: true,
      reason: `src/ changed without CHANGELOG.md, allowed by the '${ESCAPE_LABEL}' label`
    }
  }
  return {
    ok: false,
    reason:
      `This PR changes ${touchedSrc.length} file(s) under src/ but does not update ${CHANGELOG_FILE}.\n` +
      `Add a dated entry to ${CHANGELOG_FILE} (see the "Changelog is mandatory" contract in CLAUDE.md),\n` +
      `or apply the '${ESCAPE_LABEL}' label for pure refactor / test / docs PRs.`
  }
}
