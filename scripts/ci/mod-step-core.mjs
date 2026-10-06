// Pure helpers of the `mod` step (P1W2 §7.7 way 2, §7.9). No I/O.

/** First semver in a `claude --version` line, or null. */
export function parseCliVersion(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  const m = line && /(\d+)\.(\d+)\.(\d+)/.exec(line)
  return m ? { raw: line, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null
}

/** -1 | 0 | 1 over numeric components. `target` is "x.y.z". */
export function compareToVersion(parts, target) {
  const t = target.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== t[i]) return parts[i] < t[i] ? -1 : 1
  }
  return 0
}

const NOTE = /^(\S+) (hooks|calls|env reads): (.*)$/

// A hook entry may carry its matcher: `command.run{command=harnu-probe}`. Only the event name
// is compared: the matcher is checked by the source assertions of way 1 (AC-P1W2-12).
// Newer CLIs (2.1.290) annotate a call or env read with the functions that reach it:
// `$.state.get (via doHello, maybeDriftCheck)`. The annotation is dropped before splitting, since
// its commas would otherwise cut the entry in pieces.
function listOf(value) {
  const v = value.replace(/\s*\(via [^)]*\)/g, '').trim()
  if (v === '' || v === 'nothing' || v.startsWith('nothing ')) return []
  return v
    .split(/,\s*(?![^{]*})/)
    .map((s) => s.trim().replace(/\{.*\}$/, ''))
    .filter(Boolean)
}

/**
 * Reads the free-text `notes[]` of `claude plugin validate --json` (its shape is unpinned:
 * smoke D2, OQ-7). A shape change throws, so the `mod` step fails loudly instead of passing
 * on an empty comparison.
 */
export function parseValidateNotes(report) {
  const contents = report && Array.isArray(report.contents) ? report.contents : []
  if (contents.length === 0) {
    throw new Error(
      'validate reported no contents: the folder was validated as a marketplace; pass the plugin.json path'
    )
  }
  const found = { hooks: new Set(), calls: new Set(), 'env reads': new Set() }
  let sawHooks = false
  for (const entry of contents) {
    for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
      const m = NOTE.exec(note)
      if (!m) continue
      if (m[2] === 'hooks') sawHooks = true
      for (const item of listOf(m[3])) found[m[2]].add(item)
    }
  }
  if (!sawHooks) throw new Error('validate output has no "hooks:" note: its notes format changed')
  const sorted = (s) => [...s].sort()
  return {
    hooks: sorted(found.hooks),
    calls: sorted(found.calls),
    envReads: sorted(found['env reads'])
  }
}

/** Human-readable differences between the parsed report and `api-surface.json`; empty = equal. */
export function compareToManifest(parsed, manifest) {
  const out = []
  for (const [key, label] of [
    ['hooks', 'hooks'],
    ['calls', 'calls'],
    ['envReads', 'env reads']
  ]) {
    const have = new Set(parsed[key])
    const want = new Set(manifest[key] ?? [])
    const extra = [...have].filter((x) => !want.has(x))
    const missing = [...want].filter((x) => !have.has(x))
    if (extra.length)
      out.push(`${label}: in the source, not in api-surface.json: ${extra.join(', ')}`)
    if (missing.length)
      out.push(`${label}: in api-surface.json, not in the source: ${missing.join(', ')}`)
  }
  return out
}
