/**
 * Pure argv construction for launching the `claude` CLI ("Claude Boot").
 *
 * Framework-free + side-effect-free so it is unit-testable in the node vitest
 * env (`tests/claude-args.test.ts`). The persistence + IPC layer
 * (`claude-config.ts`) reads the user's global / per-folder config and feeds it
 * here together with the app-managed `base` args (`--resume <uuid>` etc.).
 *
 * SECURITY / CORRECTNESS: a handful of flags would break the embedded-terminal
 * session model (the app owns session identity) or the interactive mode. They
 * are NEVER emitted by the structured fields below, and are stripped from the
 * free-form `extraArgs` escape hatch by {@link filterDenylistedArgs}. This
 * module is the single source of truth for that denylist.
 */

/**
 * User-configurable launch options, persisted per-scope (global + per-folder).
 * Every field is optional: an absent field means "inherit" (folder scope) or
 * "not set" (global scope). Booleans are tri-state — `undefined` inherits,
 * `true`/`false` are explicit (so a folder can turn OFF a flag the global
 * config turned ON). Strings/arrays treat empty as "not set" (see
 * `mergeBootConfig`).
 */
export interface ClaudeBootConfig {
  // ── single-value flags ────────────────────────────────────────────────────
  /** `--model` (alias like `opus`/`sonnet`/`fable`/`haiku` or a full id). */
  model?: string
  /** `--effort` (low | medium | high | xhigh | max). */
  effort?: string
  /** `--permission-mode` (acceptEdits | auto | bypassPermissions | manual | dontAsk | plan). */
  permissionMode?: string
  /** `--agent`. */
  agent?: string
  /** `--from-pr` (PR number/URL, or empty for the interactive picker). */
  fromPr?: string
  /** `-n, --name` display name. */
  name?: string
  /** `--settings` (path to a JSON file or an inline JSON string). */
  settings?: string
  /** `--setting-sources` (comma list: user, project, local). */
  settingSources?: string

  // ── multiline text ────────────────────────────────────────────────────────
  /** `--system-prompt` (replaces the default system prompt). */
  systemPrompt?: string
  /** `--append-system-prompt`. */
  appendSystemPrompt?: string
  /** Positional prompt — a per-folder "pre-prompt" sent on launch. */
  prePrompt?: string

  // ── list flags ────────────────────────────────────────────────────────────
  /** `--add-dir` extra tool-access directories. */
  addDirs?: string[]
  /** `--allowedTools`. */
  allowedTools?: string[]
  /** `--disallowedTools`. */
  disallowedTools?: string[]
  /** `--mcp-config` (JSON file paths or inline strings). */
  mcpConfig?: string[]

  // ── booleans (tri-state) ──────────────────────────────────────────────────
  /** `--chrome` (true) / `--no-chrome` (false) / inherit (undefined). */
  chrome?: boolean
  /** `--ide`. */
  ide?: boolean
  /** `--verbose`. */
  verbose?: boolean
  /** `--bare`. */
  bare?: boolean
  /** `--safe-mode`. */
  safeMode?: boolean
  /** `--strict-mcp-config`. */
  strictMcpConfig?: boolean
  /** `--dangerously-skip-permissions` (⚠ dangerous). */
  dangerouslySkipPermissions?: boolean

  // ── remote control (operator-only) ────────────────────────────────────────
  /**
   * `--remote-control [name]` — enable Claude Code's own Remote Control /
   * phone bridge for this session. OPERATOR-ONLY: deliberately NOT part of the
   * agent `bootOverride` allowlist (see `mcp/agent-boot.ts#ALLOWED_KEYS`), so
   * an MCP-spawned (untrusted) agent can never turn it on. Tri-typed:
   * `true` emits the bare `--remote-control`; a non-empty string emits
   * `--remote-control <name>` (a named bridge); `false`/absent emits nothing.
   *
   * SECURITY: enabling lets reads be pulled off-device through Claude's bridge;
   * mutations still require Harnu's desk confirm overlay (which does NOT reach
   * the phone → unanswered = deny). The Harnu MCP mutation server stays loopback.
   */
  remoteControl?: boolean | string

  // ── provider (local / custom Anthropic-compatible endpoint) ───────────────
  /**
   * Reference to a named {@link EndpointProfile} (`EndpointProfile.id`) in the
   * global registry. Absence (or an empty string) means the hosted Anthropic
   * API — the default. A set value resolves to `ANTHROPIC_*` env vars injected
   * at spawn time (see `claude-config.ts#resolveProviderEnv`), NOT to a CLI
   * flag. Cascades for free through {@link mergeBootConfig} like every other
   * field, so a folder/session can point a launch at a local model.
   */
  provider?: string

  // ── escape hatch ──────────────────────────────────────────────────────────
  /** Raw extra args appended verbatim (tokenized, denylist-filtered). */
  extraArgs?: string
}

/**
 * A custom Anthropic-compatible endpoint (e.g. a local model served by LM
 * Studio at `http://127.0.0.1:1234`). Definitions live in the global registry
 * (`claude-boot.json#endpoints`); a {@link ClaudeBootConfig.provider} only ever
 * *references* one by `id`. Resolved to env vars at spawn — Harnu never calls
 * the Anthropic API itself, it spawns the `claude` CLI, so pointing a session
 * at a local model reduces to setting `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`.
 */
export interface EndpointProfile {
  /** Stable opaque id (uuid). The `provider` field references this. */
  id: string
  /** User-facing label shown in the picker + provenance badge (e.g. "LM Studio"). */
  name: string
  /** `ANTHROPIC_BASE_URL` — the base URL of the Anthropic-compatible server. */
  baseUrl: string
  /** Default `ANTHROPIC_MODEL` for this endpoint. A per-scope free-text model overrides it. */
  model?: string
  /**
   * Optional bearer token sent as `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`.
   * Plaintext on disk (O-4): fine for keyless localhost; revisit (OS keychain)
   * before supporting remote keyed endpoints.
   */
  authToken?: string
}

/**
 * Boolean flags that break the embedded-session / interactive model and must
 * never reach the spawned `claude`. `DENY_VALUE` additionally consume a value
 * token (`--resume <uuid>`), so the filter drops the following token too.
 */
const DENY_BOOL = new Set([
  '--print',
  '-p',
  '--help',
  '-h',
  '--version',
  '-v',
  '--continue',
  '-c',
  '--fork-session',
  '--no-session-persistence',
  '--replay-user-messages',
  '--include-partial-messages',
  '--include-hook-events'
])
const DENY_VALUE = new Set(['--resume', '-r', '--session-id', '--output-format', '--input-format'])

/** The combined denylist (for a renderer-side live-warning mirror / docs). */
export const DENYLISTED_FLAGS: readonly string[] = [...DENY_BOOL, ...DENY_VALUE]

/**
 * Split a free-form arg string into tokens, honoring single/double quotes
 * (so `--append-system-prompt "be terse"` stays one token). Backslash escapes
 * a `"` or `\` inside double quotes. Whitespace outside quotes separates.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started) {
        tokens.push(cur)
        cur = ''
        started = false
      }
    } else {
      cur += c
      started = true
    }
  }
  if (started) tokens.push(cur)
  return tokens
}

/**
 * Strip denylisted flags (and the value token of value-taking ones) from a
 * tokenized arg list. Returns the surviving args plus the dropped tokens so a
 * caller can warn. Matches `--flag` and `--flag=value` forms.
 */
export function filterDenylistedArgs(tokens: string[]): { args: string[]; dropped: string[] } {
  const args: string[] = []
  const dropped: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const flag = tok.split('=')[0]
    if (DENY_BOOL.has(flag)) {
      dropped.push(tok)
      continue
    }
    if (DENY_VALUE.has(flag)) {
      dropped.push(tok)
      // Separate value form (`--resume X`): drop the value token too, unless
      // the next token is itself a flag (`--resume --foo`).
      if (!tok.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        dropped.push(tokens[++i])
      }
      continue
    }
    args.push(tok)
  }
  return { args, dropped }
}

/** Trim + drop empty entries from a list field. */
function cleanList(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean)
}

/**
 * Tools a READ-ONLY session (T245's review companion) must never be able to
 * call. These are hard `--disallowedTools` denials, not permission prompts:
 * `--permission-mode plan` is only the mode a session STARTS in — the operator
 * can cycle out of it inside Claude's own TUI — whereas a denied tool stays
 * denied for the life of the process.
 *
 * Every name here MUST be a tool the installed `claude` actually has: an unknown
 * name is not silently ignored, it prints `Permission deny rule "X" matches no
 * known tool — check for typos` into the session on boot (observed live with a
 * speculative `MultiEdit`, which no longer exists). A guard whose first act is to
 * tell the operator it is misconfigured is worse than the tool it was guarding.
 *
 * `Bash` is deliberately NOT here. A reviewer that cannot run the tests or grep
 * for a symbol's other call sites is the "detached copy" the PRD (§2.1)
 * considered and rejected, and it would take the feature's usefulness with it.
 * So `bash -c 'echo … > file'` remains reachable, and this list is honest about
 * being a guard against the ACCIDENTAL edit ("fix that for me"), not a sandbox.
 */
export const READ_ONLY_DENIED_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

/**
 * Flags in the free-form `extraArgs` escape hatch that would re-grant write
 * access to a read-only session, stripped by {@link forceReadOnlyPermission}.
 *
 * `--allowedTools` is deliberately absent: Claude resolves a deny over an
 * allow, so an allowlist cannot re-grant a tool {@link READ_ONLY_DENIED_TOOLS}
 * denied — and stripping a variadic flag from a token stream would orphan its
 * values as stray positionals, which is a worse argv than the one we started
 * with.
 */
const READ_ONLY_STRIP_BOOL = new Set(['--dangerously-skip-permissions'])
const READ_ONLY_STRIP_VALUE = new Set(['--permission-mode'])

/**
 * Force a resolved {@link ClaudeBootConfig} into READ-ONLY shape before it is
 * used to spawn T245's review companion. The sibling of
 * `mcp/agent-boot.ts#forceDowngradePermission`, and applied at the same point in
 * `pty.ts` — AFTER the user's global/folder scopes have been merged, so no
 * Claude Boot setting can quietly hand the reviewer a pen.
 *
 * Five moves, each closing a different door:
 *  - `permissionMode: 'plan'` — the mode the PRD (§2.1) names.
 *  - `disallowedTools` += {@link READ_ONLY_DENIED_TOOLS} — the part plan mode
 *    cannot guarantee, because plan mode is exitable from inside the TUI.
 *  - `dangerouslySkipPermissions` dropped entirely.
 *  - the `extraArgs` escape hatch scrubbed of the flags that would undo the
 *    above — they are appended AFTER the structured flags by
 *    {@link buildClaudeArgs}, so an unscrubbed `--permission-mode acceptEdits`
 *    there would be the argv that wins.
 *  - `prePrompt` dropped entirely (T247 / AC-21 + AC-25). This one is not about
 *    permissions, and it is the reason this list grew: a pre-prompt is emitted
 *    as a POSITIONAL, which the `claude` CLI reads as a first USER turn. On a
 *    read-only companion that means two separate harms at once — the session
 *    generates an unrequested opening response (the auto-summary PRD §2 forbids,
 *    which then anchors every later answer), and an operator's folder-scope
 *    prompt ("always run the tests and fix what fails") arrives as a read-only
 *    stranger's opening instruction, addressed to a session that cannot fix
 *    anything. Unlike an `--append-system-prompt`, there is no delimiter that
 *    makes a user turn stop being a user turn, so the only correct handling is
 *    not to emit one. Harnu's own orientation for this session travels through
 *    `--append-system-prompt` instead (`review-corrective.ts`).
 *
 * Pure; never mutates its input. Inert fields are preserved verbatim.
 */
export function forceReadOnlyPermission(cfg: ClaudeBootConfig): ClaudeBootConfig {
  const out: ClaudeBootConfig = { ...cfg }
  delete out.dangerouslySkipPermissions
  delete out.prePrompt
  out.permissionMode = 'plan'
  out.disallowedTools = [...cleanList(cfg.disallowedTools), ...READ_ONLY_DENIED_TOOLS]
  const extra = cfg.extraArgs?.trim()
  if (extra) {
    const tokens = tokenizeArgs(extra)
    const kept: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      const flag = tok.split('=')[0]
      if (READ_ONLY_STRIP_BOOL.has(flag)) continue
      if (READ_ONLY_STRIP_VALUE.has(flag)) {
        // Separate value form (`--permission-mode acceptEdits`): drop the value
        // token too, unless the next token is itself a flag.
        if (!tok.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++
        continue
      }
      kept.push(tok)
    }
    out.extraArgs = kept.join(' ')
  }
  return out
}

/**
 * Separator inserted between two scopes' values of an ACCUMULATE-type text
 * field (see {@link ACCUMULATE_TEXT_KEYS}). A blank line + horizontal rule +
 * blank line reads clearly whether the field is a system-prompt fragment or a
 * pre-prompt message, and is stable across the global→folder→session chain
 * (each `mergeBootConfig` fold inserts exactly one).
 */
export const ACCUMULATE_SEP = '\n\n---\n\n'

/**
 * Text fields whose semantics are ADDITIVE, not replace: a lower scope's value
 * is **concatenated after** the inherited one (global + sep + folder + sep +
 * session), never dropped. `--append-system-prompt` is added to the default
 * system prompt, and the pre-prompt is a launch message — for both, a folder or
 * session value that silently discarded the global one is a footgun (T57 #1).
 * `systemPrompt` (`--system-prompt`) is deliberately NOT here: it *replaces* the
 * default prompt, so stacking two replacements is meaningless — it stays a
 * scalar override.
 */
export const ACCUMULATE_TEXT_KEYS = ['appendSystemPrompt', 'prePrompt'] as const

/**
 * List fields that UNION across scopes (dedup, order-preserving) instead of the
 * lower scope replacing the whole list. Extra dirs / allowed / disallowed tools
 * / mcp configs are all "add these too", so a folder that adds one dir should
 * not wipe the global set (T57 #1).
 */
export const ACCUMULATE_LIST_KEYS = [
  'addDirs',
  'allowedTools',
  'disallowedTools',
  'mcpConfig'
] as const

/** The full set of additive keys — mirrored by the renderer form for its copy. */
export const ACCUMULATE_KEYS: readonly (keyof ClaudeBootConfig)[] = [
  ...ACCUMULATE_TEXT_KEYS,
  ...ACCUMULATE_LIST_KEYS
]

const ACCUMULATE_TEXT_SET = new Set<string>(ACCUMULATE_TEXT_KEYS)
const ACCUMULATE_LIST_SET = new Set<string>(ACCUMULATE_LIST_KEYS)

/** Union two lists preserving order, deduping (and dropping empties) by trimmed value. */
function unionLists(base: string[], add: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...base, ...add]) {
    const k = item.trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/**
 * Merge a folder config over a global one. Folder values win **when set**;
 * `undefined` inherits global, and empty strings / empty arrays count as
 * "not set" (so a blank field in the folder form inherits the global value
 * rather than clearing it). Booleans pass through `false` as an explicit
 * override (the only way a folder turns OFF a global-ON flag).
 *
 * ADDITIVE fields are the exception (T57 #1): {@link ACCUMULATE_TEXT_KEYS} are
 * concatenated with {@link ACCUMULATE_SEP} (global text kept, folder text added
 * after) and {@link ACCUMULATE_LIST_KEYS} are unioned (dedup, order-preserving).
 * Because the resolve chain folds this function global→folder→session, the
 * accumulation composes across all three scopes with a single separator between
 * adjacent scopes. Every other (scalar) field still replaces.
 */
export function mergeBootConfig(
  global: ClaudeBootConfig,
  folder: ClaudeBootConfig
): ClaudeBootConfig {
  const out: ClaudeBootConfig = { ...global }
  for (const key of Object.keys(folder) as (keyof ClaudeBootConfig)[]) {
    const v = folder[key]
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue

    // Additive text: keep the inherited value and append this scope's after it.
    if (ACCUMULATE_TEXT_SET.has(key) && typeof v === 'string') {
      const base = out[key]
      if (typeof base === 'string' && base.trim()) {
        Object.assign(out, { [key]: base + ACCUMULATE_SEP + v })
        continue
      }
    }
    // Additive list: union with the inherited list rather than replacing it.
    if (ACCUMULATE_LIST_SET.has(key) && Array.isArray(v)) {
      const base = out[key]
      if (Array.isArray(base) && base.length) {
        Object.assign(out, { [key]: unionLists(base, v) })
        continue
      }
    }

    Object.assign(out, { [key]: v })
  }
  return out
}

/**
 * Compose the effective `--append-system-prompt` value from an optional Harnu
 * preamble (the self-awareness doc, T55) and the user's own append. The preamble
 * goes FIRST, the user's value after — with {@link ACCUMULATE_SEP} between them —
 * so the user's append stays closest to the model's recent context. Either side
 * may be empty; the user's value is NEVER discarded. When there's no preamble
 * (feature OFF, the default caller passes `undefined`) the result is exactly the
 * user's append, so behavior is byte-identical to before the feature. Pure.
 */
export function composeAppendSystemPrompt(
  preamble: string | undefined,
  userAppend: string | undefined
): string {
  const parts: string[] = []
  if (preamble?.trim()) parts.push(preamble)
  if (userAppend?.trim()) parts.push(userAppend)
  return parts.join(ACCUMULATE_SEP)
}

// ── The end-of-options separator ──────────────────────────────────────────────

/**
 * The bare `--` end-of-options separator {@link buildClaudeArgs} emits in front of
 * the positional pre-prompt.
 *
 * Everything after it is a POSITIONAL argument as far as the `claude` CLI is
 * concerned. A flag appended past it is not "a flag in an unusual place" — it is
 * silently swallowed as prompt text and never parsed. BUG-86 was exactly that:
 * `--plugin-dir` (bundled skills) and `--settings` (the T92 hook bridge) were
 * appended to a fully-built argv that already ended with `-- <prompt>`, so a
 * freshly spawned session got neither, while resumed sessions (no pre-prompt, no
 * separator) worked — which is why it hid for a whole release.
 *
 * Nothing may `[...args, '--flag', value]` a claude argv. Use
 * {@link insertOptionArgs}, or {@link withOptionArgs} at the spawn site.
 */
export const OPTIONS_END = '--'

/**
 * Split a claude argv at the FIRST bare `--` into its option portion and the
 * positional tail. The separator stays with the tail, so
 * `[...options, ...promptTail]` reconstructs the input byte-for-byte. An argv with
 * no separator yields an empty tail.
 */
export function splitOptionArgs(args: readonly string[]): {
  options: string[]
  promptTail: string[]
} {
  const i = args.indexOf(OPTIONS_END)
  if (i < 0) return { options: [...args], promptTail: [] }
  return { options: args.slice(0, i), promptTail: args.slice(i) }
}

/**
 * Insert option tokens so they land BEFORE the bare `--` separator (a plain append
 * when the argv carries none). The separator-safe replacement for
 * `[...args, ...tokens]` — every argv injector uses this.
 */
export function insertOptionArgs(args: readonly string[], inserted: readonly string[]): string[] {
  if (inserted.length === 0) return [...args]
  const { options, promptTail } = splitOptionArgs(args)
  return [...options, ...inserted, ...promptTail]
}

/**
 * Run `apply` over the OPTION portion of a claude argv and re-append the
 * `--`/positional tail afterwards.
 *
 * This is the shape that keeps BUG-86 fixed as the app grows: the spawn path
 * composes EVERY argv injector inside this one callback, so the tail is put back
 * last no matter how many injectors are added later, and there is no trailing
 * `args = <inject>(args)` line at the spawn site inviting the next contributor to
 * append past the separator. The injectors are separator-aware on their own too
 * (belt and braces) — this is the part that does not depend on them being so.
 */
export async function withOptionArgs(
  args: readonly string[],
  apply: (options: string[]) => string[] | Promise<string[]>
): Promise<string[]> {
  const { options, promptTail } = splitOptionArgs(args)
  return [...(await apply(options)), ...promptTail]
}

/**
 * Build the full argv: app-managed `base` (e.g. `['--resume', uuid]`) followed
 * by the user's resolved config. The pre-prompt is emitted last as a positional
 * after a `--` separator so a preceding variadic flag (`--add-dir a b`) can't
 * swallow it.
 *
 * `harnuPreamble` (T55) is an optional string prepended to the effective
 * `--append-system-prompt` (see {@link composeAppendSystemPrompt}); the caller
 * (the shell, `pty.ts`) decides whether the feature is on and loads the doc, so
 * this function stays pure. Passing `undefined` reproduces the old behavior.
 */
export function buildClaudeArgs(
  base: string[],
  cfg: ClaudeBootConfig,
  harnuPreamble?: string
): string[] {
  const args: string[] = [...base]
  const push = (...a: string[]): void => {
    args.push(...a)
  }

  if (cfg.model?.trim()) push('--model', cfg.model.trim())
  if (cfg.effort?.trim()) push('--effort', cfg.effort.trim())
  if (cfg.permissionMode?.trim()) push('--permission-mode', cfg.permissionMode.trim())
  if (cfg.agent?.trim()) push('--agent', cfg.agent.trim())
  if (cfg.name?.trim()) push('--name', cfg.name.trim())
  if (cfg.settings?.trim()) push('--settings', cfg.settings.trim())
  if (cfg.settingSources?.trim()) push('--setting-sources', cfg.settingSources.trim())
  // `--from-pr` takes an optional value; emit bare when blank-but-enabled is not
  // expressible here, so we only emit it when a value is provided.
  if (cfg.fromPr?.trim()) push('--from-pr', cfg.fromPr.trim())

  if (cfg.systemPrompt?.trim()) push('--system-prompt', cfg.systemPrompt)
  // `--append-system-prompt` = optional Harnu preamble (T55) + the user's append,
  // composed so the user's value is never dropped. Never touches `--system-prompt`.
  const appendSystemPrompt = composeAppendSystemPrompt(harnuPreamble, cfg.appendSystemPrompt)
  if (appendSystemPrompt) push('--append-system-prompt', appendSystemPrompt)

  const addDirs = cleanList(cfg.addDirs)
  if (addDirs.length) push('--add-dir', ...addDirs)
  const allowed = cleanList(cfg.allowedTools)
  if (allowed.length) push('--allowedTools', ...allowed)
  const disallowed = cleanList(cfg.disallowedTools)
  if (disallowed.length) push('--disallowedTools', ...disallowed)
  const mcp = cleanList(cfg.mcpConfig)
  if (mcp.length) push('--mcp-config', ...mcp)

  if (cfg.chrome === true) push('--chrome')
  else if (cfg.chrome === false) push('--no-chrome')
  if (cfg.ide) push('--ide')
  if (cfg.verbose) push('--verbose')
  if (cfg.bare) push('--bare')
  if (cfg.safeMode) push('--safe-mode')
  if (cfg.strictMcpConfig) push('--strict-mcp-config')
  if (cfg.dangerouslySkipPermissions) push('--dangerously-skip-permissions')

  // `--remote-control [name]` takes an OPTIONAL value: `true` → bare flag, a
  // non-empty string → named bridge. Operator-only (never in agent allowlist).
  if (cfg.remoteControl === true) push('--remote-control')
  else if (typeof cfg.remoteControl === 'string' && cfg.remoteControl.trim())
    push('--remote-control', cfg.remoteControl.trim())

  if (cfg.extraArgs?.trim()) {
    const { args: extra } = filterDenylistedArgs(tokenizeArgs(cfg.extraArgs))
    push(...extra)
  }

  // The bare `--` separator MUST stay last: every token after it is a positional
  // argument, so an option flag appended past this point is read as prompt text
  // and never parsed (BUG-86). Injectors must use `insertOptionArgs` /
  // `withOptionArgs` (above) instead of appending to the argv.
  if (cfg.prePrompt?.trim()) push(OPTIONS_END, cfg.prePrompt.trim())

  return args
}
