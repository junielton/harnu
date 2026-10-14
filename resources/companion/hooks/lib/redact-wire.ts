import { PLACEHOLDER_VALUE, SECRET_RULES } from './secret-rules.gen'

/**
 * The wire redaction of the companion's text fields (T455 spec §5.5 rule 2). Pure and `$`-free.
 *
 * The rules are T450's deterministic table (`secret-rules.gen.ts`, one source for every mod that
 * stages it); overlapping matches are merged rather than skipped (see `spans`). Each match becomes
 * `[REDACTED:<rule>]`: the bare rule id, never T450's `#<tag>` (the tag needs T450's per-install
 * salt, and a preview has no use for telling two secrets apart). There is no entropy rule: it is the one rule that guesses, and its false
 * positives would blank ordinary prompts.
 *
 * Stated limit: a secret no deterministic rule matches (a password typed in prose, an unknown
 * format, a high-entropy key with no known prefix) goes out as written. A field is withheld
 * (`null`) only when the pass itself throws, never because a text "looks secret".
 */

interface Compiled {
  id: string
  re: RegExp
  group: number
  needs: readonly ('digit' | 'letter')[]
}

let compiled: { rules: Compiled[]; placeholder: RegExp } | null = null

/** Compiled on first use, never at load: a source the runtime refused must not fail the module. */
function rules(): { rules: Compiled[]; placeholder: RegExp } {
  compiled ??= {
    rules: SECRET_RULES.map((r) => ({
      id: r.id,
      re: new RegExp(r.source, r.flags),
      group: r.group ?? 0,
      needs: r.needs ?? []
    })),
    placeholder: new RegExp(PLACEHOLDER_VALUE.source, PLACEHOLDER_VALUE.flags)
  }
  return compiled
}

const DIGIT = /[0-9]/
const LETTER = /[A-Za-z]/

interface Span {
  start: number
  end: number
  rule: string
  /** When the span was found: rules run most specific first, so a lower number is more specific. */
  order: number
}

/**
 * T450's `detect` without the entropy pass, the vault and the allowlist: rules in order, the most
 * specific first.
 *
 * One deliberate hardening over T450's `detect` (verifiers' D3): where `detect` SKIPS a match that
 * overlaps a span already taken, this MERGES them and redacts the union, under the rule that
 * matched first. Skipping left the rest of the larger secret raw (`PASSWORD=Hunter2x-` before a
 * provider token, the parts of a URL password around one). The rule SOURCES are T450's, unchanged.
 */
function spans(text: string): Span[] {
  const { rules: all, placeholder } = rules()
  const found: Span[] = []
  let order = 0
  for (const rule of all) {
    rule.re.lastIndex = 0
    for (const m of text.matchAll(rule.re)) {
      const value = m[rule.group]
      if (value === undefined) continue
      const span = m.indices?.[rule.group]
      if (span === undefined) continue
      if (rule.group !== 0 && (placeholder.test(value) || value.includes('${'))) continue
      if (rule.needs.includes('digit') && !DIGIT.test(value)) continue
      if (rule.needs.includes('letter') && !LETTER.test(value)) continue
      let next: Span = { start: span[0], end: span[1], rule: rule.id, order: order++ }
      // The stored spans are disjoint, so one pass finds every span this one touches: whatever
      // the union reaches beyond `next` lies inside a span it absorbed, and no other stored span
      // overlaps that one. The union keeps the rule found first.
      const kept: Span[] = []
      for (const f of found) {
        if (next.start < f.end && next.end > f.start) {
          const first = f.order < next.order ? f : next
          next = {
            start: Math.min(f.start, next.start),
            end: Math.max(f.end, next.end),
            rule: first.rule,
            order: first.order
          }
        } else kept.push(f)
      }
      found.length = 0
      found.push(...kept)
      found.push(next)
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Every rule match replaced by `[REDACTED:<rule>]`. Throws only when the pass itself breaks. */
export function redactForWire(text: string): string {
  if (text === '') return text
  let out = ''
  let at = 0
  for (const s of spans(text)) {
    out += text.slice(at, s.start) + `[REDACTED:${s.rule}]`
    at = s.end
  }
  return out + text.slice(at)
}

/** One text field for the wire: redacted, or `null` when the pass throws (fail-closed). */
export function redactField(
  text: string,
  redact: (t: string) => string = redactForWire
): string | null {
  try {
    return redact(text)
  } catch {
    return null
  }
}
