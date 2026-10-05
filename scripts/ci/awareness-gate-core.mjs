// Pure predicate for the self-awareness contract gate (T81). Mirrors the CHANGELOG
// gate (changelog-gate-core.mjs): given the files a PR changed plus its labels,
// decide whether an AGENT-FACING change honors the "touch the agent surface ⇒
// update docs/harnu-features.md" contract from CLAUDE.md. No I/O, no git —
// unit-testable in isolation (list of files → verdict). The CLI wrapper in
// awareness-gate.mjs feeds it the real diff.
//
// Trigger is DELIBERATELY narrow: only the canonical agent-facing surfaces —
// the MCP tool catalog (the verbs/ACKs an agent calls) and the self-awareness
// doc's own loader. A change there is what the doc must stay true to.

export const TRIGGER_FILES = ['src/main/mcp/tool-catalog.ts', 'src/main/harnu-features.ts']
export const AWARENESS_DOC = 'docs/harnu-features.md'
export const ESCAPE_LABEL = 'no-awareness'

/**
 * @param {{ changedFiles: string[], labels?: string[] }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function awarenessGateVerdict({ changedFiles, labels = [] }) {
  const norm = changedFiles.map((f) => f.replace(/^\.\//, '').replace(/\\/g, '/'))
  const touchedTriggers = norm.filter((f) => TRIGGER_FILES.includes(f))
  const touchedDoc = norm.some((f) => f === AWARENESS_DOC)
  const escaped = labels.includes(ESCAPE_LABEL)

  if (touchedTriggers.length === 0) {
    return { ok: true, reason: 'no agent-facing surface changed — harnu-features.md not required' }
  }
  if (touchedDoc) {
    return { ok: true, reason: 'docs/harnu-features.md updated alongside the agent-facing change' }
  }
  if (escaped) {
    return {
      ok: true,
      reason: `agent-facing surface changed without ${AWARENESS_DOC}, allowed by the '${ESCAPE_LABEL}' label`
    }
  }
  return {
    ok: false,
    reason:
      `This PR changes ${touchedTriggers.join(', ')} (the agent-facing MCP surface) but does not update ${AWARENESS_DOC}.\n` +
      `Update ${AWARENESS_DOC} and bump its version marker (see the "Self-awareness doc is mandatory" contract in CLAUDE.md;\n` +
      `run /harnu-awareness for the editorial rules), or apply the '${ESCAPE_LABEL}' label for a catalog-internal change\n` +
      `with no new agent-usable semantics.`
  }
}
