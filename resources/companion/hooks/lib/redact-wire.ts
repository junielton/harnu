import { PLACEHOLDER_VALUE, SECRET_RULES } from './secret-rules.gen'

/**
 * The wire redaction of the companion's text fields (T455 spec §5.5 rule 2). Pure and `$`-free.
 *
 * The rules are T450's deterministic table (`secret-rules.gen.ts`, one source for every mod that
 * stages it). Each match becomes `[REDACTED:<rule>]`: the bare rule id, never T450's
 * `#<tag>` (the tag needs T450's per-install salt, and a preview has no use for telling two
 * secrets apart). There is no entropy rule: it is the one rule that guesses, and its false
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
}

/** T450's `detect` without the entropy pass, the vault and the allowlist: rules in order, the
 * most specific first; a span that overlaps a taken one is skipped. */
function spans(text: string): Span[] {
  const { rules: all, placeholder } = rules()
  const found: Span[] = []
  const taken = (s: number, e: number): boolean => found.some((f) => s < f.end && e > f.start)
  for (const rule of all) {
    rule.re.lastIndex = 0
    for (const m of text.matchAll(rule.re)) {
      const value = m[rule.group]
      if (value === undefined) continue
      const span = m.indices?.[rule.group]
      if (span === undefined) continue
      const [start, end] = span
      if (rule.group !== 0 && (placeholder.test(value) || value.includes('${'))) continue
      if (rule.needs.includes('digit') && !DIGIT.test(value)) continue
      if (rule.needs.includes('letter') && !LETTER.test(value)) continue
      if (taken(start, end)) continue
      found.push({ start, end, rule: rule.id })
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
