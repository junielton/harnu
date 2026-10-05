// Pure predicate for the user-docs contract gate (T124). Mirrors the CHANGELOG
// gate and the self-awareness gate: given the files a PR added/changed plus its
// labels, decide whether a user-visible change honors the "ship a feature ⇒
// update docs/user/" contract from CLAUDE.md. No I/O, no git — unit-testable in
// isolation (file lists → verdict). The CLI wrapper in user-docs-gate.mjs feeds
// it the real diff.
//
// Trigger is deliberately narrower than "any src/ change" (that would make the
// escape label a rubber stamp within days). It fires on:
//   1. An ADDED top-level Vue component under src/renderer/src/components/ — a
//      new screen/pane/dialog a person can see and click. Nested dirs
//      (components/ui/** — low-level primitives like ToggleSwitch) are excluded
//      on purpose: they are not a distinct feature, see the CLAUDE.md
//      "Design entity → file map" convention this mirrors.
//   2. An ADDED top-level file directly under src/main/ — a new main-process
//      capability wired to the UI. Nested dirs (src/main/detect/** — internal
//      fleet-state heuristics; src/main/mcp/** other than tool-catalog.ts — MCP
//      server internals) are excluded: same "not agent/user-actionable" litmus
//      CLAUDE.md already applies to the self-awareness gate.
//   3. src/main/mcp/tool-catalog.ts CHANGING at all (not just added) — a
//      new/changed MCP verb is a user-visible capability too (it belongs in
//      docs/user/agent-control.md), even though the file itself is edited in
//      place rather than created fresh each time.

export const COMPONENT_DIR = 'src/renderer/src/components/'
export const MAIN_DIR = 'src/main/'
export const TOOL_CATALOG_FILE = 'src/main/mcp/tool-catalog.ts'
export const USER_DOCS_DIR = 'docs/user/'
export const ESCAPE_LABEL = 'no-user-docs'

function normalize(f) {
  return f.replace(/^\.\//, '').replace(/\\/g, '/')
}

// True when `path` sits directly inside `dir` — one path segment past the
// prefix, no further slashes. Excludes nested subdirectories on purpose.
function isTopLevelUnder(dir, path) {
  if (!path.startsWith(dir)) return false
  const rest = path.slice(dir.length)
  return rest.length > 0 && !rest.includes('/')
}

/**
 * @param {{ addedFiles?: string[], changedFiles: string[], labels?: string[] }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function userDocsGateVerdict({ addedFiles = [], changedFiles, labels = [] }) {
  const normAdded = addedFiles.map(normalize)
  const normChanged = changedFiles.map(normalize)

  const newComponents = normAdded.filter((f) => isTopLevelUnder(COMPONENT_DIR, f))
  const newMainFiles = normAdded.filter((f) => isTopLevelUnder(MAIN_DIR, f))
  const catalogChanged = normChanged.includes(TOOL_CATALOG_FILE)

  const triggers = [
    ...newComponents,
    ...newMainFiles,
    ...(catalogChanged ? [TOOL_CATALOG_FILE] : [])
  ]

  const touchedDocs = normChanged.some((f) => f.startsWith(USER_DOCS_DIR))
  const escaped = labels.includes(ESCAPE_LABEL)

  if (triggers.length === 0) {
    return { ok: true, reason: 'no new user-visible surface added — docs/user/ not required' }
  }
  if (touchedDocs) {
    return { ok: true, reason: 'docs/user/ updated alongside the user-visible change' }
  }
  if (escaped) {
    return {
      ok: true,
      reason: `user-visible surface changed without docs/user/, allowed by the '${ESCAPE_LABEL}' label`
    }
  }
  return {
    ok: false,
    reason:
      `This PR adds/changes ${triggers.join(', ')} (a new user-visible surface) but does not update anything under ${USER_DOCS_DIR}.\n` +
      `Document the new capability under ${USER_DOCS_DIR} (see the "User docs are mandatory" contract in CLAUDE.md),\n` +
      `or apply the '${ESCAPE_LABEL}' label for an internal/refactor change with no new user-reachable surface.`
  }
}
