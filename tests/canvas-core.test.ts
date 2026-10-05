import { describe, it, expect } from 'vitest'
import {
  CANVAS_SCHEMA_VERSION,
  CANVAS_SUFFIX,
  MAX_CANVAS_EDGES,
  MAX_CANVAS_LABEL_CHARS,
  MAX_CANVAS_NODES,
  canvasExtraKeys,
  canvasLabelAttrs,
  emptyCanvasDocument,
  canvasStem,
  hasCanvasSuffix,
  normalizeCanvasLabel,
  parseCanvasDocument,
  serializeCanvasDocument,
  validateCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'

/**
 * T218 U1 — the pure canvas core. The contract lives in
 * `docs/specs/2026-08-23-t218-canvas-pane.md` §4; every describe below names the
 * acceptance criterion it pins so a reader can map test → AC without guessing.
 */

function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'n-1', shape: 'box', x: 0, y: 0, origin: 'agent', ...over }
}
function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { capycanvas: CANVAS_SCHEMA_VERSION, meta: {}, nodes: [], edges: [], ...over }
}

describe('canvas suffix classification (§4.1)', () => {
  it('matches the double extension, case-insensitively', () => {
    expect(hasCanvasSuffix('/repo/.harnu/out/canvas/board.harnucanvas.json')).toBe(true)
    expect(hasCanvasSuffix('/repo/Board.HarnuCanvas.JSON')).toBe(true)
    expect(hasCanvasSuffix(`/repo/x${CANVAS_SUFFIX}`)).toBe(true)
  })

  it('writes the .harnucanvas.json suffix but still READS the legacy .capycanvas.json (AC-3)', () => {
    expect(CANVAS_SUFFIX).toBe('.harnucanvas.json')
    expect(hasCanvasSuffix('/repo/.capy/out/canvas/board.capycanvas.json')).toBe(true)
    expect(hasCanvasSuffix('/repo/docs/canvas/Old.CapyCanvas.JSON')).toBe(true)
    expect(canvasStem('plan.harnucanvas.json')).toBe('plan')
    expect(canvasStem('plan.capycanvas.json')).toBe('plan')
    expect(canvasStem('plan.json')).toBe('plan.json')
  })

  it('does NOT match a plain .json — the trap that would misroute every JSON file', () => {
    expect(hasCanvasSuffix('/repo/package.json')).toBe(false)
    expect(hasCanvasSuffix('/repo/capycanvas.json')).toBe(false) // no `<name>.` prefix separator
    expect(hasCanvasSuffix('/repo/board.harnucanvas.json.bak')).toBe(false)
    expect(hasCanvasSuffix('/repo/notes.md')).toBe(false)
  })
})

/**
 * U1-4 — the AC that encodes a failure which ACTUALLY happened during the spike
 * (README trap 3): a reader picked the stale attribute path and misreported what
 * the operator had named a node. All four shapes are pinned, and case 4 (both
 * present and DISAGREEING) is the one that catches a wrong precedence — a
 * normalizer that reads `attrs.text.text` first passes cases 1-3 and fails only
 * here, which is exactly why cases 1-3 alone would be coverage theatre.
 */
describe('U1-4 label normalization — all four attribute shapes (§4.5)', () => {
  it('case 1: only attrs.text.text (the creation path) → that value', () => {
    expect(normalizeCanvasLabel({ attrs: { text: { text: 'Created' } } })).toBe('Created')
  })

  it('case 2: only attrs.label.text (the rename path) → that value', () => {
    expect(normalizeCanvasLabel({ attrs: { label: { text: 'Renamed' } } })).toBe('Renamed')
  })

  it('case 3: both present and AGREEING → that value', () => {
    expect(
      normalizeCanvasLabel({ attrs: { text: { text: 'Same' }, label: { text: 'Same' } } })
    ).toBe('Same')
  })

  it('case 4: both present and DISAGREEING → the rename path wins, never the stale creation path', () => {
    // This is the live failure: X6 leaves `attrs.text.text` at its creation
    // value after `node.attr('label/text', …)`. Reading it back reports the name
    // the node had BEFORE the human renamed it.
    expect(
      normalizeCanvasLabel({
        attrs: { text: { text: 'Browser' }, label: { text: 'Operator renamed this' } }
      })
    ).toBe('Operator renamed this')
  })

  it('an EMPTY rename (the operator cleared the label) beats a stale non-empty creation value', () => {
    expect(normalizeCanvasLabel({ attrs: { text: { text: 'Stale' }, label: { text: '' } } })).toBe(
      ''
    )
  })

  it('falls back to the persisted top-level label when there are no X6 attrs', () => {
    expect(normalizeCanvasLabel({ label: 'Persisted' })).toBe('Persisted')
  })

  it('prefers either attribute path over a stale top-level label', () => {
    expect(normalizeCanvasLabel({ label: 'Stale top-level', attrs: { text: { text: 'A' } } })).toBe(
      'A'
    )
    expect(
      normalizeCanvasLabel({ label: 'Stale top-level', attrs: { label: { text: 'B' } } })
    ).toBe('B')
  })

  it('returns undefined when no path carries a string label', () => {
    expect(normalizeCanvasLabel({})).toBeUndefined()
    expect(normalizeCanvasLabel({ label: 42 })).toBeUndefined()
    expect(normalizeCanvasLabel({ attrs: { label: { text: 99 } } })).toBeUndefined()
    expect(normalizeCanvasLabel(null)).toBeUndefined()
    expect(normalizeCanvasLabel('not an object')).toBeUndefined()
  })

  it('validation resolves the disagreeing case onto the node it returns', () => {
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ attrs: { text: { text: 'Stale' }, label: { text: 'Fresh' } } })]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.nodes[0].label).toBe('Fresh')
    // The stale attrs never survive into the persisted document — the top-level
    // `label` is the ONLY label anything above the core is asked to read.
    expect(serializeCanvasDocument(r.doc)).not.toContain('Stale')
    expect(serializeCanvasDocument(r.doc)).not.toContain('attrs')
  })

  it('canvasLabelAttrs writes BOTH paths from the normalized value (the write half of §4.5)', () => {
    expect(canvasLabelAttrs('Fresh')).toEqual({ text: { text: 'Fresh' }, label: { text: 'Fresh' } })
    // Round-trip: attrs written from a normalized label can never re-read stale.
    expect(normalizeCanvasLabel({ attrs: canvasLabelAttrs('Fresh') })).toBe('Fresh')
  })
})

/**
 * U1-5 — the stamp that lets an agent tell its own drawing from the operator's
 * edits. The point of the AC is that a missing origin is a REFUSAL, so the tests
 * assert both the code and that nothing was defaulted.
 */
describe('U1-5 origin is required, never defaulted (§4.4)', () => {
  it('a node with no origin is refused with missing-origin', () => {
    const raw = { id: 'n-1', shape: 'box', x: 0, y: 0 }
    const r = validateCanvasDocument(doc({ nodes: [raw] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing-origin')
    expect(r.error).toContain('n-1')
  })

  it('an EDGE with no origin is refused with missing-origin too', () => {
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'a' }), node({ id: 'b' })],
        edges: [{ id: 'e-1', source: 'a', target: 'b' }]
      })
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing-origin')
    expect(r.error).toContain('e-1')
  })

  it('an explicit null origin is refused, not coerced', () => {
    const r = validateCanvasDocument(doc({ nodes: [node({ origin: null })] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing-origin')
  })

  it('an origin outside the two-value vocabulary is refused with invalid-origin', () => {
    for (const bad of ['paste', 'AGENT', '', 'human', 1, true]) {
      const r = validateCanvasDocument(doc({ nodes: [node({ origin: bad })] }))
      expect(r.ok, `origin ${JSON.stringify(bad)} must be refused`).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('invalid-origin')
    }
  })

  it('NO code path can produce a document whose element lacks an origin', () => {
    // The whole value of the stamp is that a reader can trust it. If validation
    // ever admitted an unstamped element, "the operator drew this" would become
    // a guess. Both accepted values survive verbatim; nothing else gets through.
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'a', origin: 'agent' }), node({ id: 'b', origin: 'operator' })],
        edges: [{ id: 'e-1', source: 'a', target: 'b', origin: 'operator' }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.nodes.map((n) => n.origin)).toEqual(['agent', 'operator'])
    expect(r.doc.edges[0].origin).toBe('operator')
    for (const el of [...r.doc.nodes, ...r.doc.edges]) {
      expect(['agent', 'operator']).toContain(el.origin)
    }
  })

  it('the stamp is creation provenance, not ownership — it survives the other side editing', () => {
    // An operator-stamped node re-serialized by the agent's writer keeps
    // `operator`; a last-writer stamp would erase "what did the human add".
    const first = validateCanvasDocument(
      doc({ nodes: [node({ origin: 'operator', label: 'mine' })] })
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const moved: CanvasDocument = {
      ...first.doc,
      nodes: [{ ...first.doc.nodes[0], x: 500, label: 'renamed by the agent' }]
    }
    const again = parseCanvasDocument(serializeCanvasDocument(moved))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.doc.nodes[0].origin).toBe('operator')
  })
})

describe('U1-6 dangling edges are a validation failure (§4.3)', () => {
  it('an edge whose source is not a node is refused', () => {
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'b' })],
        edges: [{ id: 'e-1', source: 'ghost', target: 'b', origin: 'agent' }]
      })
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('dangling-edge')
    expect(r.error).toContain('ghost')
  })

  it('an edge whose target is not a node is refused', () => {
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'a' })],
        edges: [{ id: 'e-1', source: 'a', target: 'ghost', origin: 'agent' }]
      })
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('dangling-edge')
  })

  it('the dangling edge is REFUSED, not silently dropped', () => {
    const r = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'a' })],
        edges: [
          { id: 'e-ok', source: 'a', target: 'a', origin: 'agent' },
          { id: 'e-bad', source: 'a', target: 'ghost', origin: 'agent' }
        ]
      })
    )
    // A "helpful" reader would keep e-ok and drop e-bad, leaving the file
    // quietly disagreeing with what its author wrote.
    expect(r.ok).toBe(false)
  })

  it('a duplicate id across nodes AND edges is refused', () => {
    const same = validateCanvasDocument(doc({ nodes: [node({ id: 'dup' }), node({ id: 'dup' })] }))
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.code).toBe('duplicate-id')

    const cross = validateCanvasDocument(
      doc({
        nodes: [node({ id: 'dup' })],
        edges: [{ id: 'dup', source: 'dup', target: 'dup', origin: 'agent' }]
      })
    )
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.code).toBe('duplicate-id')
  })
})

describe('U1-7 an unknown schema major is refused, not migrated (§4.3)', () => {
  it('refuses a future major with schema-unsupported', () => {
    const r = validateCanvasDocument(doc({ capycanvas: 2 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('schema-unsupported')
    expect(r.error).toContain('2')
  })

  it('refuses version 0 and a missing/non-integer version', () => {
    for (const bad of [0, 1.5, '1', null, undefined]) {
      const d = doc({ capycanvas: bad })
      if (bad === undefined) delete d.capycanvas
      const r = validateCanvasDocument(d)
      expect(r.ok, `capycanvas ${JSON.stringify(bad)} must be refused`).toBe(false)
    }
  })

  it('does NOT rewrite the version onto a document it refuses', () => {
    const input = doc({ capycanvas: 7, nodes: [node()] })
    validateCanvasDocument(input)
    expect(input.capycanvas).toBe(7) // untouched — nothing was migrated in place
  })
})

describe('U1-3 caps are refusals, never truncations (§4.7)', () => {
  it(`refuses more than ${MAX_CANVAS_NODES} nodes`, () => {
    const nodes = Array.from({ length: MAX_CANVAS_NODES + 1 }, (_, i) => node({ id: `n-${i}` }))
    const r = validateCanvasDocument(doc({ nodes }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('too-many-nodes')
  })

  it(`accepts exactly ${MAX_CANVAS_NODES} nodes (the cap is inclusive)`, () => {
    const nodes = Array.from({ length: MAX_CANVAS_NODES }, (_, i) => node({ id: `n-${i}` }))
    const r = validateCanvasDocument(doc({ nodes }))
    expect(r.ok).toBe(true)
  })

  it(`refuses more than ${MAX_CANVAS_EDGES} edges`, () => {
    const edges = Array.from({ length: MAX_CANVAS_EDGES + 1 }, (_, i) => ({
      id: `e-${i}`,
      source: 'a',
      target: 'a',
      origin: 'agent'
    }))
    const r = validateCanvasDocument(doc({ nodes: [node({ id: 'a' })], edges }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('too-many-edges')
  })

  it('refuses an over-long label instead of trimming it', () => {
    const long = 'x'.repeat(MAX_CANVAS_LABEL_CHARS + 1)
    const r = validateCanvasDocument(doc({ nodes: [node({ label: long })] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('label-too-long')
  })

  it('a label of exactly the cap is accepted, unmodified', () => {
    const exact = 'x'.repeat(MAX_CANVAS_LABEL_CHARS)
    const r = validateCanvasDocument(doc({ nodes: [node({ label: exact })] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.nodes[0].label).toHaveLength(MAX_CANVAS_LABEL_CHARS)
  })
})

describe('geometry and props (§4.3, §5.2)', () => {
  it('refuses NaN / Infinity coordinates', () => {
    for (const bad of [NaN, Infinity, -Infinity, '10', null]) {
      expect(validateCanvasDocument(doc({ nodes: [node({ x: bad })] })).ok).toBe(false)
      expect(validateCanvasDocument(doc({ nodes: [node({ y: bad })] })).ok).toBe(false)
    }
  })

  it('refuses non-positive sizes (they render as invisible or inverted nodes)', () => {
    expect(validateCanvasDocument(doc({ nodes: [node({ width: 0 })] })).ok).toBe(false)
    expect(validateCanvasDocument(doc({ nodes: [node({ height: -5 })] })).ok).toBe(false)
    expect(validateCanvasDocument(doc({ nodes: [node({ width: 1, height: 1 })] })).ok).toBe(true)
  })

  it('refuses props that are not plain JSON', () => {
    expect(validateCanvasDocument(doc({ nodes: [node({ props: { f: () => 1 } })] })).ok).toBe(false)
    expect(validateCanvasDocument(doc({ nodes: [node({ props: { n: NaN } })] })).ok).toBe(false)
    expect(validateCanvasDocument(doc({ nodes: [node({ props: [1, 2] })] })).ok).toBe(false)
    expect(
      validateCanvasDocument(
        doc({ nodes: [node({ props: { src: 'assets/a.png', n: [1, { k: null }] } })] })
      ).ok
    ).toBe(true)
  })

  it('refuses a node with no id or no shape', () => {
    expect(
      validateCanvasDocument(doc({ nodes: [{ shape: 'box', x: 0, y: 0, origin: 'agent' }] })).ok
    ).toBe(false)
    expect(validateCanvasDocument(doc({ nodes: [node({ shape: '' })] })).ok).toBe(false)
  })
})

describe('U1-10 unknown TOP-LEVEL keys survive a round-trip (§4.3)', () => {
  it('preserves an unknown top-level key verbatim', () => {
    const parsed = parseCanvasDocument(
      JSON.stringify({
        capycanvas: 1,
        futureThing: { deep: [1, 2, { k: 'v' }] },
        meta: { title: 'T' },
        nodes: [],
        edges: []
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canvasExtraKeys(parsed.doc)).toEqual(['futureThing'])
    expect(parsed.doc.futureThing).toEqual({ deep: [1, 2, { k: 'v' }] })

    const round = parseCanvasDocument(serializeCanvasDocument(parsed.doc))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.doc.futureThing).toEqual({ deep: [1, 2, { k: 'v' }] })
    expect(JSON.parse(serializeCanvasDocument(round.doc)).futureThing).toEqual({
      deep: [1, 2, { k: 'v' }]
    })
  })

  it('preserves unknown meta keys too', () => {
    const parsed = parseCanvasDocument(
      JSON.stringify(doc({ meta: { title: 'T', viewport: { zoom: 1.5 } } }))
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(JSON.parse(serializeCanvasDocument(parsed.doc)).meta.viewport).toEqual({ zoom: 1.5 })
  })

  it('does NOT preserve unknown keys inside a node or edge (§4.3 — X6 normalizes those)', () => {
    const parsed = parseCanvasDocument(
      JSON.stringify(
        doc({
          nodes: [node({ id: 'a', junk: 'dropped', attrs: { text: { text: 'L' } } })],
          edges: [{ id: 'e', source: 'a', target: 'a', origin: 'agent', junk: 'dropped' }]
        })
      )
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const out = JSON.parse(serializeCanvasDocument(parsed.doc))
    expect(out.nodes[0].junk).toBeUndefined()
    expect(out.edges[0].junk).toBeUndefined()
    expect(out.nodes[0].label).toBe('L')
  })
})

describe('serialization is deterministic and stably ordered (§4.1)', () => {
  it('writes 2-space JSON with LF and a trailing newline', () => {
    const text = serializeCanvasDocument(emptyCanvasDocument('2026-08-23T10:00:00.000Z', 'T'))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).not.toContain('\r')
    expect(text.split('\n')[1]).toBe('  "capycanvas": 1,')
  })

  it('serializing twice is byte-identical, and key order does not depend on input order', () => {
    const a = parseCanvasDocument(
      JSON.stringify({
        edges: [],
        nodes: [{ origin: 'agent', y: 2, x: 1, shape: 'box', id: 'n' }],
        meta: { updatedAt: 'u', title: 't', createdAt: 'c' },
        capycanvas: 1
      })
    )
    const b = parseCanvasDocument(
      JSON.stringify({
        capycanvas: 1,
        meta: { title: 't', createdAt: 'c', updatedAt: 'u' },
        nodes: [{ id: 'n', shape: 'box', x: 1, y: 2, origin: 'agent' }],
        edges: []
      })
    )
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(serializeCanvasDocument(a.doc)).toBe(serializeCanvasDocument(b.doc))
    expect(serializeCanvasDocument(a.doc)).toBe(serializeCanvasDocument(a.doc))
  })

  it('unknown top-level keys are written last so they cannot reorder the known four', () => {
    const parsed = parseCanvasDocument(
      JSON.stringify({ aaa: 1, capycanvas: 1, meta: {}, nodes: [], edges: [], zzz: 2 })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(JSON.parse(serializeCanvasDocument(parsed.doc)))).toEqual([
      'capycanvas',
      'meta',
      'nodes',
      'edges',
      'aaa',
      'zzz'
    ])
  })
})

describe('parseCanvasDocument', () => {
  it('refuses malformed JSON with parse-failed instead of throwing', () => {
    const r = parseCanvasDocument('{ not json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('parse-failed')
  })

  it('refuses a JSON array / scalar at the top level', () => {
    expect(parseCanvasDocument('[]').ok).toBe(false)
    expect(parseCanvasDocument('"hello"').ok).toBe(false)
  })

  it('emptyCanvasDocument is valid and round-trips', () => {
    const empty = emptyCanvasDocument('2026-08-23T10:00:00.000Z', 'Board')
    const r = parseCanvasDocument(serializeCanvasDocument(empty))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc).toEqual(empty)
  })
})
