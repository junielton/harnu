/**
 * Builtin detector manifest registry + override merge (A2 two-tier state
 * detection — T11 seed + T9 pure half).
 *
 * The screen-detection feature ships a small set of agent manifests bundled in
 * the app, embedded here as typed `RawManifest` literals rather than `.json`
 * imports so they are guaranteed in the main bundle with no JSON-loader /
 * `resolveJsonModule` coupling. {@link buildRegistry} folds the builtins with
 * user overrides (the `~/.claude/detectors/<agent>.json` files the T9 shell
 * reads from disk) into the compiled list the detector matches against — pure
 * (no fs), so the merge + precedence lands in the coverage surface; the fs read
 * + chokidar watch live in the `screen-detect.ts` shell.
 *
 * Override model (mirrors Herdr): a `<agent>.json` override shallow-merges over
 * the builtin of the SAME agent (`resolveManifest`, per-key precedence); an
 * override for an agent with NO builtin is compiled standalone (a user can add a
 * brand-new agent without a code change). Builtins keep their registry order
 * (the classify precedence); override-only agents append after.
 *
 * Tuning caveat: the bundled rules below are modelled on documented prompts, NOT
 * all verified against a live pane. `match.titleRegex`/`contentAny` and the rule
 * regexes are conservative — a mis-tuned manifest fails safe toward `idle`, never
 * a false `blocked` — and are meant to be refined via a hot-reloaded override
 * (T9) + the `explain` log (T12). `match.process` (the design's other classifier
 * signal) is deferred: it needs the PTY's foreground process name resolved in
 * main; v1 classifies by OSC title + on-screen content marker only.
 */

import { parseManifest, resolveManifest, type RawManifest } from './manifest-load-core'
import type { CompiledManifest } from './screen-detect-core'

/** OpenAI Codex CLI. Mirrors the design.md manifest example. */
const CODEX: RawManifest = {
  agent: 'codex',
  // `process` is the strongest signal (scroll-proof); `titleRegex` corroborates.
  // codex's foreground `comm` is unverified (may be `node`); tune in W6.3.
  match: { process: ['codex'], titleRegex: 'Codex' },
  scan: { lines: 30 },
  rules: [
    { state: 'blocked', any: ['Allow this tool\\?', '\\(y/N\\)', 'Do you want to proceed'] },
    {
      state: 'working',
      any: ['Esc to interrupt', 'esc to stop', 'Thinking', '⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏']
    },
    { state: 'idle', any: ['^›\\s*$', 'Type your message'] }
  ],
  fallback: 'idle'
}

/**
 * Aider (aider-chat). Tuned from REAL captured output (aider 0.86.2 against an
 * ollama model, 2026-06-29). Findings that shaped this:
 *  - aider sets NO OSC title → classify by CONTENT only (`Aider v<n>` banner,
 *    the `with diff edit format` model line, and the `Waiting for <model>`
 *    work indicator are the aider-specific markers).
 *  - working shows `Waiting for <model>` with a `░█` progress bar (NOT a braille
 *    spinner) → that string is the work marker.
 *  - blocked prompts use the `(Y)es/(N)o` style + a `Please answer with one of:`
 *    reprompt; add-file asks `Add … to the chat?`.
 *
 * KNOWN LIMITATION: aider's persistent on-screen identity is weak (the banner
 * scrolls off; the idle prompt is just `>`). Sustained classification really
 * wants `match.process` (the PTY foreground process name) — the deferred
 * classifier signal — so this content set is best for the early-session window
 * (banner + first prompts visible) and during a turn (`Waiting for`).
 */
const AIDER: RawManifest = {
  agent: 'aider',
  // `process` ("aider", verified via `ps comm`) is the robust signal that keeps
  // aider classified even after its banner scrolls off; content markers back it up.
  match: {
    process: ['aider'],
    contentAny: ['Aider v\\d', 'with diff edit format', 'Waiting for ']
  },
  scan: { lines: 30 },
  rules: [
    {
      state: 'blocked',
      any: [
        '\\(Y\\)es/\\(N\\)o',
        'Please answer with one of',
        '\\(y/n\\)',
        '\\? \\[y/n\\]',
        'Add .* to the chat\\?'
      ]
    },
    { state: 'working', any: ['Waiting for ', 'Applying edit', '░█|█░'] }
  ],
  fallback: 'idle'
}

/**
 * The raw builtins, in registry (classify-precedence) order. opencode/goose are
 * intentionally NOT shipped yet — their bottom-buffer strings need samples
 * captured from real panes (T11); a guessed manifest would risk a false
 * classification. A user can add either today via `~/.claude/detectors/`.
 */
const BUILTINS: readonly RawManifest[] = [CODEX, AIDER]

/** The agent ids that ship as builtins (for the shell's logging / diagnostics). */
export const BUILTIN_AGENTS: readonly string[] = BUILTINS.map((b) => String(b.agent))

/**
 * Fold the builtins with per-agent overrides into the compiled registry. Pure.
 *
 * @param overrides - raw override manifests keyed by agent id (from the T9 disk
 *   read). An override for a builtin agent shallow-merges over it; an override
 *   for a new agent is compiled standalone.
 * @returns the compiled manifests in classify-precedence order (builtins first).
 */
export function buildRegistry(
  overrides: ReadonlyMap<string, RawManifest> = new Map()
): CompiledManifest[] {
  const out: CompiledManifest[] = []
  const builtinAgents = new Set<string>()
  for (const raw of BUILTINS) {
    const agent = String(raw.agent)
    builtinAgents.add(agent)
    const r = resolveManifest(raw, overrides.get(agent) ?? null)
    if (r.ok) out.push(r.manifest)
    else console.error(`[detect] manifest "${agent}" failed: ${r.error}`)
  }
  // Override-only agents (no builtin) — compiled standalone, appended after.
  for (const [agent, raw] of overrides) {
    if (builtinAgents.has(agent)) continue
    const r = parseManifest(raw)
    if (r.ok) out.push(r.manifest)
    else console.error(`[detect] override manifest "${agent}" failed: ${r.error}`)
  }
  return out
}

/** Compile just the bundled builtins (no overrides) — the boot-time default. */
export function loadBuiltinManifests(): CompiledManifest[] {
  return buildRegistry()
}
