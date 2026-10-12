/**
 * T460 batch 0 — the expected-deltas document: validation shared by `dialog-baseline.mjs diff`
 * and `tests/dialog-baseline-deltas.test.ts` (which also checks the file against
 * `expected-deltas.schema.json`).
 *
 * A delta is one thing a migration batch PROMISES will change in the before/after baseline. See the
 * schema for the fields. Entries whose `property` is a bare wildcard family (`card.rect.*`,
 * `body.rect.*`, `body.scrollHeight`, `body.clientHeight`, `card.style.max-height`) are PLACEHOLDERS
 * in the catalog: a batch must narrow them to its own dialogs (and, where it can, to a `from`/`to`)
 * before use — `PLACEHOLDER_PROPERTIES` names them, and the test pins that the catalog marks them.
 */

export const ALLOWED_KEYS = ['dialog', 'property', 'from', 'to', 'height', 'theme', 'reason']

/** Catalog entries that are `dialog: "*"` placeholders: a batch narrows `dialog` before use. */
export const PLACEHOLDER_PROPERTIES = [
  'card.rect.*',
  'body.rect.*',
  'body.scrollHeight',
  'body.clientHeight',
  'card.style.max-height'
]

/** Validate an expected-deltas document by the schema's rules (no ajv dependency). Throws. */
export function validateDeltas(doc) {
  if (doc?.version !== 1 || !Array.isArray(doc.deltas)) {
    throw new Error('expected-deltas: need { "version": 1, "deltas": [...] }')
  }
  doc.deltas.forEach((d, i) => {
    if (
      typeof d.dialog !== 'string' ||
      typeof d.property !== 'string' ||
      typeof d.reason !== 'string'
    ) {
      throw new Error(
        `expected-deltas[${i}]: "dialog", "property" and "reason" are required strings`
      )
    }
    for (const k of Object.keys(d)) {
      if (!ALLOWED_KEYS.includes(k)) throw new Error(`expected-deltas[${i}]: unknown key "${k}"`)
    }
    if (d.height !== undefined && !Number.isInteger(d.height)) {
      throw new Error(`expected-deltas[${i}]: "height" must be an integer`)
    }
    if (d.theme !== undefined && typeof d.theme !== 'string') {
      throw new Error(`expected-deltas[${i}]: "theme" must be a string`)
    }
  })
  return doc
}
