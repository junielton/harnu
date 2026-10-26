/**
 * The T247 content-neutrality matrix (AC-22): words the companion's context must never carry,
 * because each is triage substrate or a judgement. One shared list so a text composed for the
 * review companion is judged by the same rules as its spawn-time corrective.
 *
 * `tests/review-corrective.test.ts` is a pinned guard and keeps its own literal copy; the drift
 * test in `tests/companion/review-selection-core.test.ts` fails if the two stop agreeing.
 */
export const FORBIDDEN: Array<[string, RegExp]> = [
  ['CI state', /\b(check|checks|CI|passing|failing|green|red)\b/i],
  ['PR/review state', /\b(draft|mergeable|approved|changes requested|review decision)\b/i],
  ['commit counts', /\b\d+\s+commits?\b/i],
  ['file counts', /\b\d+\s+files?\b/i],
  ['± counts', /[+−-]\d+\s*\/\s*[+−-]?\d+|\b\d+\s+(insertions?|deletions?|additions?)\b/i],
  ['a verdict', /\b(looks good|seems fine|risky|suspicious|recommend|should approve)\b/i]
]
