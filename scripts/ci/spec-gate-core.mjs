// Pure predicate for the spec gate (T600, SDD wave A). Given the text of each
// `docs/specs/<dir>/spec.md` plus the list of tracked files, report the defects that
// Campaign wave 1 showed leak into dispatch: duplicate AC ids, a slice citing an AC that
// does not exist, an AC with no proof, a prd/adr/mockup path that is not tracked, a
// gitignored `.harnu/out` path, and a section outside the tier's whitelist. No I/O, no git
// — unit-testable in isolation. The CLI wrapper in spec-gate.mjs feeds it the working tree.
//
// Only specs whose header says `status: approved` are checked: a draft is still being
// written, and the specs that predate the template carry no header block and are skipped.
//
// Header: a `---` fenced block of `key: value` lines at the very top of the file.
//   status: draft | approved
//   tier:   medium | large | complex          (mirrors artifactRequirements in roadmap-core.ts)
//   prd / adr / mockup: repo-relative paths   (complex only)
//
// Tier whitelist of `## ` sections (a leading "1." / "§2" numbering is ignored):
//   medium  = Problem, Slices, Acceptance criteria
//   large   = medium + Goals, Open decisions
//   complex = large  (+ the prd, adr and mockup header fields)
//   every tier also carries "Amendments · Deviations" — the append-only section that
//   dispatch and the verifier write after the spec is approved, so it can never be
//   outside a tier.

export const TIERS = ['medium', 'large', 'complex']
export const PATH_FIELDS = ['prd', 'adr', 'mockup']

const MEDIUM_SECTIONS = ['problem', 'slices', 'acceptance criteria']
const LARGE_SECTIONS = [...MEDIUM_SECTIONS, 'goals', 'open decisions']
const ALWAYS_SECTIONS = ['amendments']

const SECTIONS_BY_TIER = {
  medium: [...MEDIUM_SECTIONS, ...ALWAYS_SECTIONS],
  large: [...LARGE_SECTIONS, ...ALWAYS_SECTIONS],
  complex: [...LARGE_SECTIONS, ...ALWAYS_SECTIONS]
}

const HARNU_OUT_RE = /\.harnu\/out\b/
const PLACEHOLDER_PROOF_RE = /^(?:[-–—]+|tbd|todo|n\/a|none|\?+)$/i

/** A canonical section name from a `## ` heading: numbering, markdown and punctuation dropped. */
function sectionKey(heading) {
  const text = heading
    .replace(/^[§\d.\s]+/, '')
    .replace(/[`*_]/g, '')
    .trim()
    .toLowerCase()
  if (text.startsWith('amendments')) return 'amendments'
  if (text.startsWith('acceptance criteria')) return 'acceptance criteria'
  return text
}

function stripQuotes(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2').trim()
}

/** Split the leading `---` block off the file. `null` header when there is none. */
function parseHeader(content) {
  const lines = content.split('\n')
  if (lines[0].trim() !== '---') return { header: null, bodyStart: 0 }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return { header: null, bodyStart: 0 }
  const header = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i])
    if (m) header[m[1].toLowerCase()] = stripQuotes(m[2])
  }
  return { header, bodyStart: end + 1 }
}

function normalizePath(p) {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** A tracked file, or a tracked directory (a mockup is usually a folder of screens). */
function isTracked(path, trackedFiles) {
  const p = normalizePath(path)
  const dir = p.endsWith('/') ? p : `${p}/`
  return trackedFiles.some((f) => {
    const n = normalizePath(f)
    return n === p || n.startsWith(dir)
  })
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

const isSeparatorRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')

/** The AC table under `## Acceptance criteria`: rows keyed by the header's column names. */
function parseAcRows(sectionLines) {
  const rows = []
  let columns = null
  for (const { line, no } of sectionLines) {
    if (!line.trim().startsWith('|')) continue
    const cells = splitRow(line)
    if (isSeparatorRow(cells)) continue
    if (!columns) {
      columns = cells.map((c) => c.toLowerCase())
      continue
    }
    const col = (name) => {
      const idx = columns.findIndex((c) => c === name || c.startsWith(name))
      return idx === -1 ? '' : (cells[idx] ?? '')
    }
    rows.push({ id: col('id').replace(/[`*]/g, '').trim(), proof: col('proof'), line: no })
  }
  return rows
}

/** Each `### S-n …` slice under `## Slices` with its `acs:` list. */
function parseSlices(sectionLines) {
  const slices = []
  let current = null
  for (const { line, no } of sectionLines) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) {
      const idMatch = /^(S-[A-Za-z0-9]+)/.exec(h[1])
      current = { id: idMatch ? idMatch[1] : h[1], line: no, acs: [] }
      slices.push(current)
      continue
    }
    const acs = /^[-*]\s*acs?\s*:\s*(.*)$/i.exec(line.trim())
    if (acs && current) {
      current.acs = acs[1]
        .split(',')
        .map((t) => t.replace(/[`*]/g, '').trim())
        .filter((t) => t && !/^(?:[-–—]+|none)$/i.test(t))
    }
  }
  return slices
}

/**
 * @param {string} content  the spec file text
 * @param {string} path     the spec's repo-relative path (for messages only)
 * @param {string[]} trackedFiles  every tracked file in the repo
 * @returns {{ rule: string, message: string, line?: number }[]}  empty when the spec passes
 *   or is not `status: approved`.
 */
export function checkSpec(content, path, trackedFiles = []) {
  const { header, bodyStart } = parseHeader(content)
  if (!header || header.status !== 'approved') return []

  const failures = []
  const fail = (rule, message, line) => failures.push({ rule, message, ...(line ? { line } : {}) })

  const tier = header.tier
  if (!TIERS.includes(tier)) {
    fail(
      'bad-header',
      `header \`tier\` must be one of ${TIERS.join(' | ')} (got ${tier ? `"${tier}"` : 'nothing'}) — the section whitelist cannot be applied without it`
    )
  }

  // Header paths: tracked, never under .harnu/out, and complex-only.
  for (const field of PATH_FIELDS) {
    const value = header[field]
    if (!value) continue
    if (tier && TIERS.includes(tier) && tier !== 'complex') {
      fail(
        'section-outside-tier',
        `header field \`${field}\` is outside the ${tier} tier — only a complex spec carries prd, adr and mockup`
      )
    }
    if (HARNU_OUT_RE.test(value)) continue // reported once by the whole-file scan below
    if (!isTracked(value, trackedFiles)) {
      fail('untracked-path', `header \`${field}: ${value}\` is not a tracked file in the repo`)
    }
  }

  const lines = content.split('\n')
  let inFence = false
  let sectionKeyNow = null
  const sections = new Map() // key -> [{ line, no }]
  const seenSections = []

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]
    const no = i + 1
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      if (sectionKeyNow) sections.get(sectionKeyNow).push({ line, no })
      continue
    }
    if (!inFence) {
      const h = /^##\s+(.+?)\s*$/.exec(line)
      if (h) {
        sectionKeyNow = sectionKey(h[1])
        if (!sections.has(sectionKeyNow)) sections.set(sectionKeyNow, [])
        seenSections.push({ key: sectionKeyNow, title: h[1], no })
        continue
      }
    }
    if (sectionKeyNow) sections.get(sectionKeyNow).push({ line, no })
  }

  // .harnu/out anywhere in the file (header included): a fresh worktree cannot see it.
  lines.forEach((line, i) => {
    if (HARNU_OUT_RE.test(line)) {
      fail(
        'harnu-out-path',
        `line ${i + 1} points at .harnu/out, which is gitignored and invisible to a fresh worktree — commit the artifact and cite its committed path`,
        i + 1
      )
    }
  })

  // Section whitelist for the tier.
  if (TIERS.includes(tier)) {
    for (const s of seenSections) {
      if (!SECTIONS_BY_TIER[tier].includes(s.key)) {
        fail(
          'section-outside-tier',
          `section "${s.title.replace(/^[§\d.\s]+/, '')}" is outside the ${tier} tier whitelist (${SECTIONS_BY_TIER[tier].join(', ')})`,
          s.no
        )
      }
    }
  }

  // AC table: unique ids, a proof on each.
  const acRows = parseAcRows(sections.get('acceptance criteria') ?? [])
  const known = new Set()
  const reported = new Set()
  for (const row of acRows) {
    if (!row.id) continue
    if (known.has(row.id) && !reported.has(row.id)) {
      fail('duplicate-ac', `AC id ${row.id} appears more than once in the table`, row.line)
      reported.add(row.id)
    }
    known.add(row.id)
    if (!row.proof || PLACEHOLDER_PROOF_RE.test(row.proof.trim())) {
      fail('missing-proof', `${row.id} has no proof`, row.line)
    }
  }

  // Slices: every cited AC exists.
  for (const slice of parseSlices(sections.get('slices') ?? [])) {
    for (const ac of slice.acs) {
      if (!known.has(ac)) {
        fail(
          'unknown-slice-ac',
          `slice ${slice.id} cites ${ac}, which is not in the Acceptance criteria table`,
          slice.line
        )
      }
    }
  }

  void path
  return failures
}

/**
 * @param {{ specs: { path: string, content: string }[], trackedFiles?: string[] }} input
 * @returns {{ ok: boolean, reason: string, checked: number, skipped: number,
 *   failures: { path: string, rule: string, message: string, line?: number }[] }}
 */
export function specGateVerdict({ specs, trackedFiles = [] }) {
  const failures = []
  let checked = 0
  let skipped = 0
  for (const spec of specs) {
    const { header } = parseHeader(spec.content)
    if (!header || header.status !== 'approved') {
      skipped++
      continue
    }
    checked++
    for (const f of checkSpec(spec.content, spec.path, trackedFiles)) {
      failures.push({ path: spec.path, ...f })
    }
  }
  if (failures.length === 0) {
    return {
      ok: true,
      reason: `${checked} approved spec(s) checked, ${skipped} skipped (draft or no header)`,
      checked,
      skipped,
      failures
    }
  }
  const body = failures
    .map((f) => `  ${f.path}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.message}`)
    .join('\n')
  return {
    ok: false,
    reason: `${failures.length} defect(s) in approved specs:\n${body}\n\nFix the spec in the same PR. A spec still being written stays \`status: draft\` and is skipped.`,
    checked,
    skipped,
    failures
  }
}
