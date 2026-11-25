/**
 * The doc-reader read gate (T1 spike, shipped in T2): the decision a `PreToolUse` hook makes before the main
 * model reads a large documentation file into its own context.
 *
 * The idea comes from Spotify's `shunt` plugin. A full read of a large doc is cheaper when a small
 * model (the `doc-reader` subagent, on Haiku) reads it and answers a question about it, so only
 * the answer enters the main model's context. The gate does not trust the model to remember that.
 * It refuses the full read and says what to do instead.
 *
 * PURE: no fs, no electron. The caller supplies `countLines`, so the same rule runs behind the
 * Hook Bridge and inside the standalone eval plugin (`evals/doc-reader/`).
 *
 * What the gate lets through, and why:
 * - **Any subagent's call.** Subagents cannot start subagents, so pointing one at `doc-reader`
 *   would strand it. That includes `doc-reader` itself, which must read the files it was sent.
 * - **A targeted read.** That is a `Read` whose `limit` is set and at most the threshold, or
 *   `head`/`tail`/`sed -n`/`grep`. The model already knows which part it needs, which is exactly
 *   what it should do before an edit.
 * - **A file that is not documentation, or that is small.** Below the threshold the cost of
 *   delegating is higher than the saving.
 * - **A Bash read whose output is filtered or redirected.** `cat big.md | grep x` and
 *   `cat big.md > out` do not put the doc in the model's context.
 * - **Anything it cannot judge.** It fails open: a missing file, an unreadable file, a command it
 *   does not parse.
 *
 * **The span cap (T2).** A `Read` passes as targeted only when `limit` is a positive number no
 * larger than the threshold. `offset` alone reads to the end of the file, so it is judged like a
 * full read, and so is a `limit` above the threshold (`offset: 1, limit: 5000` is the whole doc).
 * Bash stays cooperative: only the first command before a chain is judged.
 */

import * as path from 'node:path'

/** Default line threshold. Shunt's default, and the eval decides whether it is right for docs. */
export const DOC_READER_DEFAULT_MIN_LINES = 350

/** File extensions the gate treats as documentation (lower-case, with the dot). */
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc'
])

/** The fields of a `PreToolUse` hook payload the gate reads. Everything else is ignored. */
export interface GateInput {
  tool_name?: unknown
  tool_input?: unknown
  /** Present only when a subagent made the call. */
  agent_id?: unknown
  agent_type?: unknown
  cwd?: unknown
}

export interface GateOptions {
  minLines: number
  /** Line count of an absolute path, or `null` when it is missing or unreadable. */
  countLines: (absPath: string) => number | null
  /** How the model is told to call the agent, e.g. `harnu:doc-reader`. */
  agentName: string
}

export type GateDecision =
  | { action: 'allow'; why: AllowReason }
  | { action: 'deny'; reason: string; path: string; lines: number }

export type AllowReason =
  'subagent' | 'not-a-read' | 'targeted' | 'not-a-doc' | 'missing' | 'small' | 'unparsed'

/** The smallest and largest per-folder threshold Harnu accepts. */
export const DOC_READER_MIN_LINES_FLOOR = 50
export const DOC_READER_MIN_LINES_CEILING = 100_000

/** Clamp a stored threshold into range; anything that is not a finite number is the default. */
export function clampMinLines(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DOC_READER_DEFAULT_MIN_LINES
  return Math.min(DOC_READER_MIN_LINES_CEILING, Math.max(DOC_READER_MIN_LINES_FLOOR, Math.round(n)))
}

/** Parse a threshold from the environment; anything but a positive integer falls back to the default. */
export function parseMinLines(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DOC_READER_DEFAULT_MIN_LINES
  const n = Number(raw.trim())
  return n > 0 ? n : DOC_READER_DEFAULT_MIN_LINES
}

export function isDocPath(p: string): boolean {
  return DOC_EXTENSIONS.has(path.extname(p).toLowerCase())
}

/** Commands that put a whole file on screen. `head`/`tail`/`sed`/`grep` are targeted and pass. */
const WHOLE_FILE_COMMANDS = new Set(['cat', 'less', 'more', 'bat'])

/**
 * The first shell operator in a command: a chain (`&&`, `||`, `;`, `&`, newline), a pipe, or a
 * redirect (`&>`, `>`, `<`). Two-character operators come first so `&&` is not read as `&`.
 */
const FIRST_OPERATOR = /&&|\|\||&>|[|;&<>\n]/

/**
 * The single file a Bash command reads whole, or `null` when the command is anything else.
 *
 * Only the first segment, before any operator, is judged. A chain (`cat big.md && echo ok`)
 * still prints the whole file, so it counts. A pipe filters what reaches the output and a
 * redirect sends it to a file, so neither counts. Substitutions and several file operands
 * fail open.
 */
export function wholeFileReadTarget(command: string): string | null {
  const cmd = command.trim()
  const op = FIRST_OPERATOR.exec(cmd)
  if (op !== null && ['|', '&>', '>', '<'].includes(op[0])) return null
  const head = (op === null ? cmd : cmd.slice(0, op.index)).trim()
  if (head === '' || /[`$(){}]/.test(head)) return null
  const [name, ...args] = head.split(/\s+/)
  if (!WHOLE_FILE_COMMANDS.has(name)) return null
  const operands = args.filter((a) => !a.startsWith('-'))
  if (operands.length !== 1) return null
  return operands[0].replace(/^(['"])(.*)\1$/, '$2')
}

function deny(file: string, lines: number, opts: GateOptions): GateDecision {
  return {
    action: 'deny',
    path: file,
    lines,
    reason:
      `${file} is ${lines} lines of documentation (threshold ${opts.minLines}). ` +
      `Do not load it whole into your context. Ask the ${opts.agentName} agent your question ` +
      `about it instead (pass the file path and the exact question); it reads the file and ` +
      `returns only the answer. If you need exact text to quote or edit, Read just that section ` +
      `with offset and limit (limit at most ${opts.minLines} lines).`
  }
}

export function decideDocRead(input: GateInput, opts: GateOptions): GateDecision {
  if (typeof input.agent_id === 'string' && input.agent_id !== '')
    return { action: 'allow', why: 'subagent' }
  if (typeof input.agent_type === 'string' && input.agent_type !== '')
    return { action: 'allow', why: 'subagent' }

  const toolInput =
    input.tool_input && typeof input.tool_input === 'object'
      ? (input.tool_input as Record<string, unknown>)
      : {}
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()

  let target: string
  if (input.tool_name === 'Read') {
    // The span cap: only a bounded `limit` is targeted. `offset` alone reads to the end.
    const limit = toolInput.limit
    if (typeof limit === 'number' && limit > 0 && limit <= opts.minLines)
      return { action: 'allow', why: 'targeted' }
    if (typeof toolInput.file_path !== 'string' || toolInput.file_path === '')
      return { action: 'allow', why: 'unparsed' }
    target = toolInput.file_path
  } else if (input.tool_name === 'Bash') {
    if (typeof toolInput.command !== 'string') return { action: 'allow', why: 'unparsed' }
    const file = wholeFileReadTarget(toolInput.command)
    if (file === null) return { action: 'allow', why: 'not-a-read' }
    target = file
  } else {
    return { action: 'allow', why: 'not-a-read' }
  }

  if (!isDocPath(target)) return { action: 'allow', why: 'not-a-doc' }
  const abs = path.resolve(cwd, target)
  const lines = opts.countLines(abs)
  if (lines === null) return { action: 'allow', why: 'missing' }
  if (lines <= opts.minLines) return { action: 'allow', why: 'small' }
  return deny(target, lines, opts)
}

/** The hook's stdout for a decision, in Claude Code's `PreToolUse` output shape. */
export function gateHookOutput(decision: GateDecision): string {
  if (decision.action === 'allow') return '{}'
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason
    }
  })
}
