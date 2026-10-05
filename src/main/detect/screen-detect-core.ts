/**
 * Screen-detection match core (A2 two-tier state detection — T1).
 *
 * Pure FSM-free matcher: given the ~30 rendered bottom lines of an agent's
 * terminal grid (extracted in the renderer, see `bottom-lines-core.ts`) and a
 * COMPILED manifest, decide the visual {@link ScreenState} of the pane.
 *
 * This is the screen-scraping fallback half of the two-tier model (the hook FSM
 * `reduceTaskState` is the authoritative half). It is deliberately
 * framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell) so it
 * is unit-testable / Stryker-reachable, exactly like `hook-state.ts` and
 * `mcp/plan-tool-call.ts`.
 *
 * The DANGEROUS ORDER is the state PRECEDENCE, encoded here so a mutation test
 * can reach it:
 *
 *   blocked  >  working  >  idle   (then the manifest `fallback`)
 *
 * Precedence is by STATE, never by the order rules appear in the manifest: a
 * blocked rule anywhere wins over a working rule anywhere, which wins over an
 * idle rule anywhere. This is what keeps a spinner frame (`working`) from
 * masking a `(y/N)` approval prompt (`blocked`) that is also on screen.
 *
 * Manifest COMPILATION (parse JSON, validate fields, build `RegExp`s, merge
 * builtin+override) lives in `manifest-load-core.ts`; this module only consumes
 * the already-compiled shape so matching stays a pure regex fold.
 */

/**
 * The three visual states a screen scrape can resolve. Narrower than `TaskState`
 * on purpose — `completed`/`failed`/`stopped` are lifecycle facts that only the
 * hook FSM / pty-exit axis can know; the screen can only ever see blocked vs
 * working vs idle. The merge core (`state-merge-core.ts`) maps these onto
 * `TaskState` (`blocked → needs-input`).
 */
export type ScreenState = 'blocked' | 'working' | 'idle'

/**
 * State precedence, highest-authority first. Evaluated in THIS order regardless
 * of the manifest's rule order — see the module header.
 */
export const SCREEN_STATE_PRECEDENCE: readonly ScreenState[] = ['blocked', 'working', 'idle']

/**
 * A compiled rule: the target {@link ScreenState} plus the alternative patterns
 * that trigger it. The rule fires when ANY pattern matches ANY scanned line.
 */
export interface CompiledRule {
  state: ScreenState
  /** Pre-compiled, flag-free (stateless `.test`) regexes — OR'd together. */
  any: RegExp[]
}

/**
 * The compiled CLASSIFIER — "is this pane running this agent?". A manifest only
 * gets to label a pane once it CLAIMS it (see {@link paneMatchesManifest}), so a
 * plain bash shell (which no manifest claims) is never mislabeled. v1 has two
 * renderer-feasible signals; `process` (the PTY's foreground process name) needs
 * pid inspection in main and is a deferred upgrade.
 */
export interface CompiledMatch {
  /** Tested against the pane's OSC title (`term.onTitleChange`); `null` if none. */
  titleRegex: RegExp | null
  /** Tested against the scanned bottom lines — a distinctive on-screen marker. */
  contentAny: RegExp[]
  /**
   * Tested against the PTY's FOREGROUND process name (resolved in main from the
   * pty pid — Linux `/proc` `tpgid` → `comm`). The strongest, scroll-proof
   * signal: it identifies the agent regardless of what's on screen, so a
   * weak-identity agent (aider: no OSC title, banner scrolls off) stays
   * classified for the whole run. Empty when the manifest declares no `process`.
   */
  process: RegExp[]
}

/**
 * A manifest after `manifest-load-core` has validated + compiled it. The raw
 * JSON shape (string patterns, optional fields, `osc` block) is not this type —
 * it is normalized down to exactly what matching needs.
 */
export interface CompiledManifest {
  /** Agent id this manifest detects (e.g. `codex`). Carried for `explain`/logs. */
  agent: string
  /** Classifier deciding whether a pane is THIS agent (vs another / plain shell). */
  match: CompiledMatch
  /** How many bottom lines to actually scan (the manifest's `scan.lines`). */
  scanLines: number
  /** Detection rules, any order — precedence is applied by state, not position. */
  rules: CompiledRule[]
  /** State when no rule matches. */
  fallback: ScreenState
}

/**
 * Does `manifest` CLAIM this pane? True when its FOREGROUND PROCESS name matches
 * (strongest, scroll-proof), OR its title regex matches the OSC title, OR any
 * content marker matches a scanned line. A manifest with NO positive signal (no
 * `titleRegex`, empty `contentAny` + `process`) claims NOTHING — positive
 * identification is required so an unrecognized shell is left to the legacy
 * activity heuristic rather than mislabeled. Pure (flag-free `.test`).
 *
 * @param process - the pane's foreground process name (resolved in main), or
 *   `null` when unavailable (non-Linux, or no foreground process resolved).
 */
export function paneMatchesManifest(
  title: string | null,
  lines: string[],
  manifest: CompiledManifest,
  process: string | null = null
): boolean {
  const { titleRegex, contentAny, process: processRegex } = manifest.match
  if (process !== null) {
    for (const re of processRegex) {
      re.lastIndex = 0
      if (re.test(process)) return true
    }
  }
  if (titleRegex && title !== null) {
    titleRegex.lastIndex = 0
    if (titleRegex.test(title)) return true
  }
  for (const re of contentAny) {
    if (firstLineMatching(re, lines) !== null) return true
  }
  return false
}

/**
 * The detail of which rule/pattern/line produced a match — the data backing a
 * future `explain` (design technique §6, plan T12). `null` when nothing matched
 * (the caller then falls back). Kept as a separate return from
 * {@link matchManifest} so the common path stays a bare `ScreenState`.
 */
export interface ManifestMatch {
  state: ScreenState
  /** Index into `manifest.rules` of the rule that fired. */
  ruleIndex: number
  /** The pattern source string that matched. */
  pattern: string
  /** The scanned line the pattern matched against. */
  line: string
}

/** True if `re` matches at least one of `lines`. Stateless (no `g` flag). */
function firstLineMatching(re: RegExp, lines: string[]): string | null {
  for (const line of lines) {
    // `re` is compiled flag-free in `manifest-load-core`, so `.test` is
    // stateless; reset `lastIndex` defensively in case a `g`-flagged regex is
    // ever hand-injected, so matching can never depend on call order.
    re.lastIndex = 0
    if (re.test(line)) return line
  }
  return null
}

/**
 * Evaluate `manifest` against `bottomLines`, returning the full match detail or
 * `null` when only the fallback applies. Slices to the manifest's `scanLines`
 * window first, then walks states in precedence order (blocked → working →
 * idle), and within a state walks the manifest's rules in declared order so the
 * FIRST concrete match is the one explained. Pure + deterministic.
 */
export function evaluateManifest(
  bottomLines: string[],
  manifest: CompiledManifest
): ManifestMatch | null {
  const scan =
    manifest.scanLines > 0 && bottomLines.length > manifest.scanLines
      ? bottomLines.slice(-manifest.scanLines)
      : bottomLines
  for (const state of SCREEN_STATE_PRECEDENCE) {
    for (let ruleIndex = 0; ruleIndex < manifest.rules.length; ruleIndex++) {
      const rule = manifest.rules[ruleIndex]
      if (rule.state !== state) continue
      for (const re of rule.any) {
        const line = firstLineMatching(re, scan)
        if (line !== null) return { state, ruleIndex, pattern: re.source, line }
      }
    }
  }
  return null
}

/**
 * Resolve the {@link ScreenState} of a pane from its bottom lines + compiled
 * manifest. The thin wrapper over {@link evaluateManifest}: a real match wins,
 * otherwise the manifest's `fallback`. This is the function the detector shell
 * (plan T8) calls per snapshot.
 */
export function matchManifest(bottomLines: string[], manifest: CompiledManifest): ScreenState {
  return evaluateManifest(bottomLines, manifest)?.state ?? manifest.fallback
}
