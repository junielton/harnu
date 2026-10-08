// Pure core of the English-only gate. See CLAUDE.md § "Language policy" and
// docs/lessons/conventions/001-english-lingua-franca.md.
//
// English is the only working language of this repo. The one exception is i18n
// resources: non-English locale files and the test fixtures that exist to exercise
// locale or unicode handling. This gate flags Portuguese prose anywhere else, which
// is the language that has actually leaked into this tree before.
//
// It is a heuristic on purpose. It matches markers that are common in Portuguese and
// absent from English and code: the `ã`/`õ` vowels, the `-ção`/`-ções` suffix and a
// short list of high-frequency function words. A line is flagged on any one of them.

/** Portuguese markers. Kept short so a false positive stays rare and obvious. */
export const PT_MARKER =
  /[ãõÃÕ]|ção\b|ções\b|\b(?:não|você|vocês|também|então|está|estão|isso|isto|porque|pra|aqui|ainda|agora|sessão|usuário|arquivo)\b/i

/**
 * Paths where non-English text is the point: locale files, the language-policy lessons
 * that quote bad examples, and fixtures that test locale, unicode or this gate.
 */
export const ALLOWED_PATHS = [
  /^src\/renderer\/src\/i18n\/(?!en\.json$)[^/]+\.json$/,
  /^docs\/lessons\/conventions\/001-english-lingua-franca\.md$/,
  /^docs\/lessons\/i18n\/002-vue-i18n-schema-parity\.md$/,
  // Bilingual search synonyms for the Settings search box (a pt-BR user types in pt-BR).
  /^src\/renderer\/src\/components\/SettingsDialog\.vue$/,
  // Fixtures that exercise locale, unicode or non-English input handling.
  /^tests\/push-relay\.test\.ts$/,
  // Asserts the pt-BR name of the review bucket (D2): a locale fixture.
  /^tests\/cleanup-gc-i18n\.test\.ts$/,
  /^tests\/branch-slug\.test\.ts$/,
  /^tests\/claude-watcher\.test\.ts$/,
  /^tests\/pr-stack-format\.test\.ts$/,
  /^tests\/markdown-render\.test\.ts$/,
  /^tests\/speech-kokoro-backend\.test\.ts$/,
  /^tests\/voice-probe\.test\.ts$/,
  /^tests\/worktree-list\.test\.ts$/,
  /^tests\/worktree-tracker\.test\.ts$/,
  /^tests\/roadmap-core\.test\.ts$/, // accent-folding slugify fixture
  /^tests\/mission-core\.test\.ts$/,
  /^tests\/mcp-memory-core\.test\.ts$/,
  // Asserts that a bundled skill contains NO Portuguese, so it must name the words.
  /^tests\/bundled-report-skills\.test\.ts$/,
  // This gate and its test.
  /^scripts\/ci\/english-gate(-core)?\.mjs$/,
  /^tests\/ci-english-gate\.test\.ts$/,
  // Historical record: entries quote the pt-BR language picker by its own name.
  /^CHANGELOG\.md$/
]

/** File extensions the gate reads. Binary and generated files are never scanned. */
export const SCANNED_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue|md|json|ya?ml|sh|css|html)$/

export function isAllowedPath(path) {
  return ALLOWED_PATHS.some((re) => re.test(path))
}

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function findViolations(files) {
  const out = []
  for (const { path, text } of files) {
    if (!SCANNED_EXT.test(path) || isAllowedPath(path)) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (PT_MARKER.test(lines[i])) out.push({ path, line: i + 1, text: lines[i].trim() })
    }
  }
  return out
}
