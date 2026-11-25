/**
 * The conformance matrix as the source of which rows each smoke case proves (guided test walk, AC-33).
 *
 * The spec carries two tables that must say the same thing: the conformance matrix (one row per rule, its
 * `proof` column names a smoke case `W-n` or a test) and the smoke test's case table (each case with the
 * rows it proves). The matrix is the source: this module derives the case -> rows table from it, then
 * compares it both ways with the cases the script really has and with the case table of the spec.
 *
 * Pure: it reads text and returns facts. `--list-proofs` and every run call it.
 */
import { readFileSync } from 'node:fs'

export const SPEC_PATH = 'docs/specs/2026-11-17-guided-test-walk/spec.md'

const cells = (line) =>
  line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())

/** Natural order of `M-4`, `M-27`, `M-A-1`: the numbered rows first, then the added ones. */
export function rowOrder(a, b) {
  const key = (id) => {
    const m = /^M-(A-)?(\d+)$/.exec(id)
    return m ? [m[1] ? 1 : 0, Number(m[2])] : [2, 0]
  }
  const [ka, na] = key(a)
  const [kb, nb] = key(b)
  return ka - kb || na - nb
}

export const caseOrder = (a, b) => Number(a.slice(2)) - Number(b.slice(2))

/**
 * Read the two tables out of the spec text.
 * @returns {{ matrix: Map<string, string>, table: Map<string, string[]|'none'> }}
 *   `matrix`: row id -> its proof cell; `table`: case id -> the rows the spec's case table lists.
 */
export function readSpecTables(text) {
  const matrix = new Map()
  const table = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const c = cells(line)
    if (/^M-(A-)?\d+$/.test(c[0] ?? '') && c.length >= 4) matrix.set(c[0], c[c.length - 1])
    else if (/^W-\d+$/.test(c[0] ?? '') && c.length === 3) {
      const rows = c[2].match(/M-(?:A-)?\d+/g)
      table.set(c[0], rows ?? 'none')
    }
  }
  return { matrix, table }
}

/** case id -> sorted row ids, from the matrix's proof column. */
export function deriveFromMatrix(matrix) {
  const out = new Map()
  for (const [row, proof] of matrix) {
    for (const w of new Set(proof.match(/\bW-\d+\b/g) ?? [])) {
      if (!out.has(w)) out.set(w, new Set())
      out.get(w).add(row)
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort(rowOrder)]))
}

/**
 * The three ways AC-33 fails. `cases` is the script's own registry (`{ id, guard? }[]`).
 * @returns {{ derived: Map<string,string[]>, problems: string[] }}
 */
export function checkProofs({ matrix, table }, cases) {
  const derived = deriveFromMatrix(matrix)
  const problems = []
  const have = new Set(cases.map((c) => c.id))

  for (const c of cases) {
    const rows = derived.get(c.id) ?? []
    if (c.guard) {
      if (rows.length)
        problems.push(
          `${c.id} is an isolation guard but the matrix cites it for ${rows.join(', ')}`
        )
    } else if (!rows.length) problems.push(`${c.id} cites no matrix row (a case must prove a rule)`)
  }
  for (const [id, rows] of derived) {
    if (!have.has(id))
      problems.push(`${rows.join(', ')} cite ${id} as proof, but the script has no such case`)
  }
  for (const id of [...new Set([...derived.keys(), ...table.keys(), ...have])].sort(caseOrder)) {
    const want = (derived.get(id) ?? []).join(', ') || 'none'
    const got = table.has(id)
      ? table.get(id) === 'none'
        ? 'none'
        : [...table.get(id)].sort(rowOrder).join(', ')
      : null
    if (got === null)
      problems.push(`${id} is missing from the spec's case table (matrix says ${want})`)
    else if (got !== want)
      problems.push(`the case table lists ${id} as [${got}] but the matrix derives [${want}]`)
  }
  return { derived, problems }
}

export const readSpec = (repo) => readFileSync(`${repo}/${SPEC_PATH}`, 'utf8')
