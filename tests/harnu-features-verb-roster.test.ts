import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * T314 — the verb-roster drift gate.
 *
 * `docs/harnu-features.md` is prepended to EVERY Harnu session's system prompt.
 * Its verb index — the "The core verbs are available from the first turn: …" /
 * "The rest surface when you search your tools for them: …" pair — is the list a
 * session reads FIRST to learn what it can call. A session that reads the index
 * and stops there concludes an unlisted verb DOES NOT EXIST.
 *
 * That is not hypothetical. `create_worker` shipped, was left out of the index,
 * and an orchestrator told the operator twice — as fact — that no MCP verb could
 * mint a Scheduler worker. A monitoring watchdog went unarmed across two
 * deliveries because of an omission in a prose paragraph.
 *
 * FOUR ops in a row landed with the index unedited (`create_worker`,
 * `list_workers`, then `draw_canvas` and `speak`, the two this change fixes), and
 * the CI self-awareness gate was GREEN on all four: `scripts/ci/awareness-gate.mjs`
 * asserts that `docs/harnu-features.md` was TOUCHED when `tool-catalog.ts` changes —
 * and editing the verb's PROSE SECTION satisfies it. It cannot go red for this
 * defect. This test can.
 *
 * The assertion is `MCP_OPS ⊆ index`, in that one direction, because omission is
 * the drift that actually happens. The reverse (a phantom name in the index that
 * is not an op) is asserted too, but only because both sets are already parsed —
 * it is free, not the point.
 *
 * TWO parsing details decide whether this test is worth having:
 *
 *  1. COMMENTS ARE STRIPPED BEFORE THE NAMES ARE EXTRACTED. `MCP_OPS`' entries
 *     are quoted string literals, and its comments quote things too — the
 *     `create_worker` entry's comment says `mode: 'act'`. An unstripped regex
 *     reports `act` as an op, and the test then demands the doc index a verb that
 *     does not exist. A guard that invents a phantom op is worse than no guard,
 *     so the strip has its own cases below.
 *
 *  2. BOTH INDEX SENTENCES ARE THE INDEX. Six ops are named in the "core verbs"
 *     sentence and never repeated in the "The rest surface…" one. A parser that
 *     reads only the second sentence reports those six as missing — six false
 *     failures on a green tree.
 *
 * The parse is deliberately loud: every anchor it depends on is asserted present,
 * so a doc rewrite that moves the index makes this test RED (go fix the parser)
 * rather than silently matching nothing and passing forever — which is exactly
 * the failure mode of the gate it exists to backstop.
 */

/**
 * `stripComments`, `opsFromCatalogSource` and `indexFromFeaturesDoc` are EXPORTED
 * DELIBERATELY, though nothing imports them. They are the parser this file's
 * verdict rests on, and exporting them lets a reviewer import them into a scratch
 * spec and probe the parse against inputs this file does not commit — which is
 * how the vacuous `not.toContain('harnu')` assertion below was caught. Not dead
 * code to tidy away.
 */

const REPO_ROOT = resolve(__dirname, '..')
const CATALOG_FILE = 'src/main/mcp/tool-catalog.ts'
const FEATURES_FILE = 'docs/harnu-features.md'

/** Opens the "core verbs" sentence — the first half of the index. */
const INDEX_START = 'The core verbs are available from the first turn:'
/** First thing AFTER the index; the `capy://` resource URIs are not verbs. */
const INDEX_END = 'Resources:'

/**
 * Strips block comments and line comments.
 *
 * Not string-aware, which is safe HERE only because it is applied to the
 * already-narrowed `MCP_OPS` block — a list of bare identifiers whose comments
 * are the only place a `/` ever appears. Narrow first, then strip; never the
 * other way round on the whole file, where a `capy://` inside a string literal
 * would eat the rest of the line.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Every `'quoted_name'` in `block`, in source order. */
function quotedNames(block: string): string[] {
  return [...block.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])
}

/** The raw body of the `export const MCP_OPS = [ … ] as const` literal. */
function mcpOpsBlock(source: string): string {
  const m = /export const MCP_OPS = \[([\s\S]*?)\n\] as const/.exec(source)
  if (!m) {
    throw new Error(
      `${CATALOG_FILE}: could not find the "export const MCP_OPS = [ … ] as const" block. ` +
        `The catalog was restructured — update the parser in ${__filename}, do not delete this test.`
    )
  }
  return m[1]
}

/** The op names declared in `MCP_OPS`, comments stripped (see detail 1 above). */
export function opsFromCatalogSource(source: string): string[] {
  return quotedNames(stripComments(mcpOpsBlock(source)))
}

/**
 * The verb index of `docs/harnu-features.md`: BOTH sentences (see detail 2), the
 * backticked names in them, and the 1-based line the index starts on so a failure
 * can point at it.
 */
export function indexFromFeaturesDoc(doc: string): { names: string[]; line: number } {
  const start = doc.indexOf(INDEX_START)
  if (start === -1) {
    throw new Error(
      `${FEATURES_FILE}: could not find the index anchor ${JSON.stringify(INDEX_START)}. ` +
        `The verb index was reworded — update the parser in ${__filename}, do not delete this test.`
    )
  }
  const end = doc.indexOf(INDEX_END, start)
  if (end === -1) {
    throw new Error(
      `${FEATURES_FILE}: found the index anchor but not its terminator ${JSON.stringify(INDEX_END)}.`
    )
  }
  return {
    names: [...doc.slice(start, end).matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]),
    line: doc.slice(0, start).split('\n').length
  }
}

/** The failure a future omission actually prints. AC-5: name the verb, name the place. */
function driftReport(missing: string[], total: number, line: number): string {
  return [
    `${FEATURES_FILE}:${line} — the MCP verb index omits ${missing.length} of the ${total} ops declared in ${CATALOG_FILE}:`,
    ...missing.map((op) => `  - ${op}`),
    ``,
    `Fix: add each name, in backticks, to the index paragraph at ${FEATURES_FILE}:${line} —`,
    `the "${INDEX_START} …" sentence or the "The rest surface when you search your tools for them: …"`,
    `sentence that follows it. An op named in EITHER one counts as indexed.`,
    ``,
    `Why this is not cosmetic: that paragraph is prepended to every session's system prompt and is`,
    `the first thing a session reads to learn what it can call. A verb missing from it is a verb the`,
    `session concludes does not exist — even when the same document documents it in prose further down.`
  ].join('\n')
}

const catalogSource = readFileSync(resolve(REPO_ROOT, CATALOG_FILE), 'utf8')
const featuresDoc = readFileSync(resolve(REPO_ROOT, FEATURES_FILE), 'utf8')

describe('stripComments', () => {
  it('drops a line comment and keeps the code around it', () => {
    expect(stripComments("'a',\n// note\n'b',")).toBe("'a',\n\n'b',")
  })

  it('drops a block comment spanning several lines', () => {
    expect(stripComments("'a',\n/* note\n   more */\n'b',")).toBe("'a',\n\n'b',")
  })

  it('leaves a source with no comments byte-identical', () => {
    expect(stripComments("'a',\n'b',")).toBe("'a',\n'b',")
  })
})

describe('opsFromCatalogSource', () => {
  it('extracts the declared op names in source order', () => {
    const fixture = ['export const MCP_OPS = [', "  'alpha',", "  'beta'", '] as const'].join('\n')
    expect(opsFromCatalogSource(fixture)).toEqual(['alpha', 'beta'])
  })

  // AC-3 — the phantom-op guard, on a fixture. A name that exists ONLY inside a
  // comment is not an op, and must never reach the subset assertion: it would
  // demand the doc index a verb nobody can call.
  it('does NOT treat a quoted name that appears only inside a comment as an op', () => {
    const fixture = [
      'export const MCP_OPS = [',
      "  'real_op',",
      "  // T308: the default is `mode: 'line_phantom'` and it is not an op",
      "  /* a block note mentioning 'block_phantom' in passing */",
      "  'other_op'",
      '] as const'
    ].join('\n')
    expect(opsFromCatalogSource(fixture)).toEqual(['real_op', 'other_op'])
  })

  // AC-3 — the same guard against the REAL catalog, and proof it is load-bearing
  // rather than decorative: the unstripped block genuinely does yield `act`.
  it("does not report `act` from the real catalog — it appears only in a comment (mode: 'act')", () => {
    expect(quotedNames(mcpOpsBlock(catalogSource))).toContain('act')
    expect(opsFromCatalogSource(catalogSource)).not.toContain('act')
  })

  // LOAD-BEARING, not decorative — do not delete as noise. The subset assertion
  // in the last describe passes VACUOUSLY on an empty parse (∅ ⊆ anything), which
  // is by design: this guard is the half that catches it, and it was proved to
  // fire. Remove it and a parser that silently matches nothing goes green forever.
  it('parses a plausible number of ops (a parser that silently matches nothing is the bug)', () => {
    const ops = opsFromCatalogSource(catalogSource)
    expect(ops.length).toBeGreaterThan(20)
    expect(new Set(ops).size).toBe(ops.length)
    expect(ops).toContain('get_fleet')
    expect(ops).toContain('orchestrator_disarm')
  })
})

describe('indexFromFeaturesDoc', () => {
  // AC-6 — the "core verbs" sentence is half the index. Reading only "The rest
  // surface…" reports these six as missing on a perfectly correct document.
  it('reads BOTH index sentences, so the six core verbs count as indexed', () => {
    const { names } = indexFromFeaturesDoc(featuresDoc)
    for (const core of [
      'get_fleet',
      'get_session',
      'memory_read',
      'memory_query',
      'plan_mission',
      'open_file'
    ]) {
      expect(names).toContain(core)
    }
  })

  // The terminator is what stops the index parse from swallowing the rest of the
  // document. Falsifiable on purpose: `spawning` and `inflight` are backticked
  // prose from LATER sections, so they appear iff the terminator stopped working
  // — measured, a broken terminator pulls in 79 extra names, these two among
  // them. (An earlier version of this case asserted `not.toContain('harnu')`,
  // which could never fail: the name regex needs a closing backtick right after
  // the identifier, and the resource URIs read `capy://fleet`, so no bare `harnu`
  // is ever produced by any input. It passed with the terminator deleted.)
  it('stops at the terminator instead of reading on into the rest of the document', () => {
    const { names } = indexFromFeaturesDoc(featuresDoc)
    expect(names).not.toContain('spawning')
    expect(names).not.toContain('inflight')
    expect(names.length).toBeGreaterThan(20)
  })

  // The same property on a fixture, where the excluded name is planted rather
  // than borrowed from prose that could be reworded out from under the test.
  it('excludes a backticked name that sits after the terminator', () => {
    const doc = [
      'preamble',
      `${INDEX_START} \`get_fleet\`, \`open_file\`.`,
      'The rest surface when you search your tools for them: `notify`.',
      `${INDEX_END} \`capy://fleet\`.`,
      '',
      'Later prose mentioning `not_a_verb`, which is not in the index.'
    ].join('\n')
    expect(indexFromFeaturesDoc(doc).names).toEqual(['get_fleet', 'open_file', 'notify'])
  })

  it('reports the 1-based line the index starts on, for the failure message', () => {
    const { line } = indexFromFeaturesDoc(featuresDoc)
    const lines = featuresDoc.split('\n')
    expect(lines[line - 1]).toContain(INDEX_START)
  })
})

/**
 * The LOUD-PARSE property, pinned.
 *
 * Every anchor this file depends on is asserted present, so a restructure that
 * moves the catalog block or rewords the index makes the suite RED — "go fix the
 * parser" — instead of quietly matching nothing and passing forever. That quiet
 * pass is the exact failure mode of the gate this file exists to backstop, so
 * the property is worth a test rather than a promise in a comment: without one, a
 * refactor could turn a loud failure into a silent one and nothing would notice.
 */
describe('the parse fails loudly when an anchor it depends on is gone', () => {
  it('throws when the MCP_OPS block cannot be found in the catalog', () => {
    expect(() => opsFromCatalogSource('export const SOMETHING_ELSE = []\n')).toThrow(
      /could not find the "export const MCP_OPS/
    )
  })

  it('throws when the index anchor sentence is gone from the doc', () => {
    expect(() => indexFromFeaturesDoc('# a doc with no verb index\n')).toThrow(
      /could not find the index anchor/
    )
  })

  it('throws when the index anchor is present but its terminator is gone', () => {
    expect(() => indexFromFeaturesDoc(`${INDEX_START} \`get_fleet\`. and then nothing`)).toThrow(
      /found the index anchor but not its terminator/
    )
  })

  it('names the file it could not parse, so the message points somewhere', () => {
    expect(() => opsFromCatalogSource('')).toThrow(new RegExp(CATALOG_FILE))
    expect(() => indexFromFeaturesDoc('')).toThrow(new RegExp(FEATURES_FILE))
  })
})

describe('the harnu-features.md verb index tracks the MCP tool catalog', () => {
  // AC-1 — the gate itself. Every op the router dispatches must be named in the
  // index a session reads to discover it.
  it('names EVERY op declared in MCP_OPS', () => {
    const ops = opsFromCatalogSource(catalogSource)
    const { names, line } = indexFromFeaturesDoc(featuresDoc)
    const indexed = new Set(names)
    const missing = ops.filter((op) => !indexed.has(op))

    expect(missing, driftReport(missing, ops.length, line)).toEqual([])
  })

  // The reverse direction — free, since both sets are already parsed. A phantom
  // index entry is a rarer defect (a typo, or a verb removed from the catalog and
  // left in the prose), but it lies to a session just as effectively.
  it('names nothing that is not an op (no phantom entries)', () => {
    const ops = new Set(opsFromCatalogSource(catalogSource))
    const { names, line } = indexFromFeaturesDoc(featuresDoc)
    const phantom = [...new Set(names)].filter((n) => !ops.has(n))

    expect(
      phantom,
      `${FEATURES_FILE}:${line} — the MCP verb index names ${phantom.length} thing(s) that are not ops in ` +
        `${CATALOG_FILE}: ${phantom.join(', ')}. Either it is a typo, or the verb was removed from the ` +
        `catalog and left in the index — a session will try to call it and fail.`
    ).toEqual([])
  })
})
