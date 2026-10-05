// Pure key-parity core for the i18n contract gate (T65 AC2). Deep-flattens a
// messages object to full dotted leaf paths (`a.b.c`) and diffs the key sets of
// two locales. No I/O — unit-testable with fixtures. The CLI in i18n-parity.mjs
// loads the real en.json / pt-BR.json and reports the diff.

/**
 * Deep-flatten to leaf paths. Plain objects and arrays are descended (arrays by
 * numeric index); every non-object leaf yields one dotted path. This mirrors
 * vue-i18n's key model — you translate by full leaf path, so parity must be
 * checked per path (`a.b.c`), not per nesting level. An empty object / array is
 * recorded at its own path so a leaf-vs-empty-container mismatch stays visible.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @param {string[]} out
 * @returns {string[]}
 */
export function flattenKeys(value, prefix = '', out = []) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value)
    if (entries.length === 0) {
      if (prefix) out.push(prefix)
      return out
    }
    for (const [k, v] of entries) {
      flattenKeys(v, prefix ? `${prefix}.${k}` : k, out)
    }
    return out
  }
  if (prefix) out.push(prefix)
  return out
}

/**
 * @param {object} en
 * @param {object} pt
 * @returns {{ ok: boolean, missingInPt: string[], missingInEn: string[] }}
 */
export function parityVerdict(en, pt) {
  const enKeys = new Set(flattenKeys(en))
  const ptKeys = new Set(flattenKeys(pt))
  const missingInPt = [...enKeys].filter((k) => !ptKeys.has(k)).sort()
  const missingInEn = [...ptKeys].filter((k) => !enKeys.has(k)).sort()
  return {
    ok: missingInPt.length === 0 && missingInEn.length === 0,
    missingInPt,
    missingInEn
  }
}
