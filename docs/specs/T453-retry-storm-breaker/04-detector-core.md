# T453 — The detector, `hooks/core.ts` (normative)

**Part of:** [`00-spec.md`](00-spec.md) §3 (U-1) · **Used by:** the mod
([`02-prototype.md`](02-prototype.md)), Harnu's host twin (`00-spec.md` §5.4), and the corpus replay
([`01-corpus-scan.md`](01-corpus-scan.md) §1)

This file is the definition of "the same failure". Where the prose of `00-spec.md` §3 and this code
disagree, **this code wins**, and the prose is the bug. Three details the prose only summarises:

- **The error fold.** `normalizeError` first strips the mod's own notice lines, then folds every
  `\b[0-9a-f]{7,40}\b` (case-insensitive) to `H` and every number to `N`. Because the class is
  `[0-9a-f]`, the hex fold also folds any 7–40 letter word made only of the letters a–f (`defaced`)
  and any 7+ digit number. That is accepted: it can only merge two errors that differ in such a
  token, never split one.
- **The shell reader.** `simpleCommands` splits a Bash command into simple commands at unquoted
  `; & | newline ( ) { }`. It keeps `2>&1`, `&>` and `<&` as words, not separators. `commandWords`
  skips shell keywords, `NAME=value` assignments, the wrappers `env nice nohup time command exec sudo`,
  and `timeout` with its options (`-s KILL`, `-k 5`, `--signal=…`, `--kill-after=…`) and its duration.
  When the command word is `bash`, `sh`, `zsh`, `dash` or `ksh` with a `-c` option, the string after it
  is read again, to depth 3, and replaces the shell word. It is a reader for command words, not a
  shell: it never expands anything, and `eval`, `xargs`, `ssh host '…'` and script files stay opaque.
- **Server waits are read from the text.** `isServerWait` looks at the failure's text only, whatever
  the tool or client (`curl`, `psql`, a test runner, `docker compose exec`, `WebFetch`, any MCP tool).
- **Unknown means changed.** `isMutation` answers true for any `Bash` command word outside its
  read-only list, for any MCP tool whose verb is not a read verb, and for any built-in outside its
  read-only list. A wrong guess there can only reset a count early, never trip one.

Zero imports, so Harnu's main process and the replay import it unchanged.

```ts
// The detector: pure functions, zero imports. This file IS the definition (spec §3): the mod runs
// it in-session, Harnu's host twin imports it, and the corpus scan replays it.

export type ErrorClass =
  | 'person'
  | 'interrupted'
  | 'permission'
  | 'invalid-input'
  | 'edit-mismatch'
  | 'not-found'
  | 'timeout'
  | 'exit-nonzero'
  | 'other'

export type Failure = { at: number; head: string }

export type Entry = {
  /** `exact:<callSig>|<errSig>` or `same-error:<tool>|<errSig>`. */
  key: string
  rule: 'exact' | 'same-error'
  tool: string
  sig: string
  count: number
  /** The loop's call index when this run began: with `key`, the run's identity. */
  since: number
  /** The loop's call index at the last failure (the call window). */
  lastIndex: number
  failures: Failure[]
  denied: number
}

export type Ledger = {
  /** Calls seen per loop (`main` or a subagent's agentId). */
  seen: Record<string, number>
  entries: Record<string, Entry[]>
  muted: string[]
}

export const RULES = {
  exact: { notice: 3, ask: 4 },
  sameError: { notice: 4, ask: 5 },
  windowCalls: 20,
  windowMs: 10 * 60_000,
  abortAfterDenied: 2
} as const

// ── a small shell reader: enough to find command words, never to run anything ──────────

/** Simple commands of a Bash `command`: argv lists split at unquoted ; & | newline ( ) { }. */
export function simpleCommands(command: string): string[][] {
  const out: string[][] = []
  let argv: string[] = []
  let word = ''
  let inWord = false
  let quote: '' | "'" | '"' = ''
  const endWord = (): void => {
    if (inWord) argv.push(word)
    word = ''
    inWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (argv.length) out.push(argv)
    argv = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (
      c === '&' &&
      (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')
    ) {
      word += c // a redirection (2>&1, &>file), not a separator
      inWord = true
    } else if (';&|\n(){}'.includes(c)) endCommand()
    else if (c === ' ' || c === '\t') endWord()
    else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return out
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'for',
  'in',
  '!',
  'fi',
  'done'
])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const WRAPPERS = new Set(['env', 'nice', 'nohup', 'time', 'command', 'exec', 'sudo'])

/** Each simple command's argv from its command word on, and whether a while/until loop leads it. */
export function commandWords(command: string, depth = 0): { argv: string[]; looped: boolean }[] {
  return simpleCommands(command).flatMap((raw) => {
    let i = 0
    let looped = false
    while (i < raw.length) {
      const w = raw[i] as string
      if (KEYWORDS.has(w)) {
        if (w === 'while' || w === 'until') looped = true
        i++
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++
      else if (w === 'timeout') {
        i++
        // timeout's options (`-s KILL`, `-k 5`, `--signal=KILL`), then its duration.
        while (i < raw.length && (raw[i] as string).startsWith('-')) {
          i += /^(-s|-k|--signal|--kill-after)$/.test(raw[i] as string) ? 2 : 1
        }
        i++
      } else break
    }
    const argv = raw.slice(i).map((w, n) => (n === 0 ? (w.split('/').pop() ?? w) : w))
    // `bash -c '…'` runs a command string: read it too, in place of the shell word.
    if (depth < 3 && SHELLS.has(argv[0] ?? '')) {
      const c = argv.findIndex((a, n) => n > 0 && /^-[a-zA-Z]*c$/.test(a))
      if (c > 0 && argv[c + 1] !== undefined)
        return commandWords(argv[c + 1] as string, depth + 1).map((x) => ({
          argv: x.argv,
          looped: x.looped || looped
        }))
    }
    return [{ argv, looped }]
  })
}

const POLL_WORDS = new Set(['sleep', 'watch', 'wait-on', 'wait-for', 'wait-for-it'])
const POLL_PREFIXES = [
  ['gh', 'pr', 'checks'],
  ['gh', 'run', 'view'],
  ['gh', 'run', 'watch'],
  ['kubectl', 'rollout', 'status'],
  ['kubectl', 'wait']
]
const startsWith = (argv: string[], prefix: string[]): boolean =>
  prefix.every((p, i) => argv[i] === p)

const READ_VERB =
  /^(get|list|read|query|search|find|fetch|wait|poll|status|check|describe|show)(_|$)/
const NOT_YET = /not.?found|not.?ready|pending|spawning|in.?flight|starting|unavailable/i

/** The verb of an MCP tool, `mcp__<server>__<verb>`; undefined for a built-in. */
export const mcpVerb = (tool: string): string | undefined =>
  tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : undefined

/** Polling is repetition by design (X5): never counted, by either rule. */
export function isPoll(tool: string, input: unknown, text: string): boolean {
  if (tool === 'Bash') {
    const cmds = commandWords(str((input as Record<string, unknown> | undefined)?.command))
    // A bare while/until is iteration (`… | while read f`), not polling: a wait word must be there.
    return cmds.some(
      (c) => POLL_WORDS.has(c.argv[0] ?? '') || POLL_PREFIXES.some((p) => startsWith(c.argv, p))
    )
  }
  const verb = mcpVerb(tool)
  return verb !== undefined && READ_VERB.test(verb) && NOT_YET.test(text)
}

const REFUSED = new RegExp(
  [
    'Connection refused|ECONNREFUSED|ERR_CONNECTION_REFUSED|Couldn.t connect|Failed to connect',
    'Connection reset|Empty reply from server|not ready|is starting',
    'returned error: 50[234]|HTTP/[0-9.]+ 50[234]|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)'
  ].join('|'),
  'i'
)

/**
 * Waiting for a server (X7): something refused or was not up yet. Never counted, whatever the
 * client: `curl`, `psql`, a test runner, `docker compose exec`, `WebFetch` to localhost. The text is
 * the evidence, so a `bash -c` wrapper, a `timeout` wrapper or an unknown client does not matter.
 */
export function isServerWait(_tool: string, _input: unknown, text: string): boolean {
  return REFUSED.test(text)
}

const READ_ONLY_TOOLS = new Set(
  'Read Grep Glob LS WebFetch WebSearch TaskOutput ToolSearch ListAgents NotebookRead'.split(' ')
)
const READ_ONLY_WORDS = new Set(
  'cat ls head tail wc grep rg echo printf pwd which file stat du df ps date jq sort uniq cut tr awk diff test [ true false basename dirname realpath readlink whoami id uname nproc free uptime tree'.split(
    ' '
  )
)
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog'
])

/** A success that may have changed the world (R2). Unknown counts as a change: it never trips. */
export function isMutation(tool: string, input: unknown): boolean {
  if (tool === 'Bash') {
    const command = str((input as Record<string, unknown> | undefined)?.command)
    if (/(^|[^0-9&<>])>>?\s*(?!\/dev\/)\S/.test(command.replace(/\d?>&\d/g, ''))) return true
    return commandWords(command).some(({ argv }) => {
      const w = argv[0] ?? ''
      if (w === 'git') return !READ_ONLY_GIT.has(argv[1] ?? '')
      if (w === 'sed' || w === 'perl') return argv.some((a) => /^-[a-zA-Z]*i/.test(a))
      if (w === 'find')
        return argv.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')
      return w !== '' && !READ_ONLY_WORDS.has(w)
    })
  }
  const verb = mcpVerb(tool)
  if (verb !== undefined) return !READ_VERB.test(verb)
  return !READ_ONLY_TOOLS.has(tool)
}

/** cyrb53: a 53-bit string hash, synchronous (the module has no Node crypto). */
export function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function canon(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(rec)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(rec[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value) ?? 'null'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v))

/** What "the same call" compares, per tool (spec §3.2). */
export function callSig(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash':
      return 'Bash:' + hash(str(i.command).replace(/\s+/g, ' ').trim())
    case 'Edit':
      return 'Edit:' + hash(str(i.file_path) + '\0' + str(i.old_string))
    case 'Read':
      return 'Read:' + hash(str(i.file_path) + '\0' + str(i.offset) + '\0' + str(i.limit))
    case 'Write':
      return 'Write:' + hash(str(i.file_path))
    case 'NotebookEdit':
      return 'NotebookEdit:' + hash(str(i.notebook_path) + '\0' + str(i.cell_id))
    case 'Grep':
    case 'Glob':
      return tool + ':' + hash(str(i.pattern) + '\0' + str(i.path) + '\0' + str(i.glob))
    case 'Agent':
      return 'Agent:' + hash(str(i.subagent_type) + '\0' + str(i.isolation))
    default: {
      const rest = { ...i }
      delete rest.description
      return tool + ':' + hash(canon(rest))
    }
  }
}

/** Error classes (spec §3.3). The first three are never counted (X1–X3). */
export function classify(text: string): ErrorClass {
  const t = text.slice(0, 2000)
  if (/The user doesn't want to proceed|The user wants to clarify/.test(t)) return 'person'
  if (/^\[Request interrupted|Interrupted by user|\[Tool call interrupted/.test(t))
    return 'interrupted'
  if (
    /auto mode cannot determine|rate-limited\), so auto|requested permissions to .* but you haven't granted|This command requires approval|Permission to use .* (has been )?denied|Permission for this action was denied|PreToolUse:\w+ hook error/.test(
      t
    )
  )
    return 'permission'
  if (/InputValidationError|Input validation error|could not be parsed as JSON/.test(t))
    return 'invalid-input'
  if (/String to replace not found|No changes to make|Found \d+ matches of the string/.test(t))
    return 'edit-mismatch'
  if (/does not exist|ENOENT|No such file or directory|NOT_FOUND|not found/i.test(t))
    return 'not-found'
  if (/timed out|timeout/i.test(t)) return 'timeout'
  if (/^Exit code \d+/.test(t)) return 'exit-nonzero'
  return 'other'
}

export const COUNTED = (c: ErrorClass): boolean =>
  c !== 'person' && c !== 'interrupted' && c !== 'permission'

/** Normative fold (spec §3.3). Note: `[0-9a-f]{7,40}` also folds a 7+ letter word of only a–f. */
export function normalizeError(text: string): string {
  return text
    .replace(/\n*\[retry-breaker\][^\n]*/g, '') // our own notice, as stored
    .slice(0, 4000)
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, 'H')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

export const errSig = (text: string): string => hash(normalizeError(text))

/** A bare exit status says nothing about the cause: no same-error rule on it (X8). */
export const isGeneric = (text: string): boolean => /^(Exit code N|N)$/.test(normalizeError(text))

/** Why a failure is not counted, or null when it is (X1–X3, X5, X7). X4 is the caller's. */
export function exclusion(tool: string, input: unknown, text: string): string | null {
  const c = classify(text)
  if (!COUNTED(c)) return c
  if (isPoll(tool, input, text)) return 'poll'
  if (isServerWait(tool, input, text)) return 'server-wait'
  return null
}

export const emptyLedger = (): Ledger => ({ seen: {}, entries: {}, muted: [] })

/** Counts one call into the loop's window; returns the call's index. */
export function tick(l: Ledger, loop: string): number {
  l.seen[loop] = (l.seen[loop] ?? 0) + 1
  return l.seen[loop]
}

function expire(l: Ledger, loop: string, now: number): void {
  const idx = l.seen[loop] ?? 0
  l.entries[loop] = (l.entries[loop] ?? []).filter(
    (e) =>
      idx - e.lastIndex <= RULES.windowCalls &&
      now - (e.failures.at(-1)?.at ?? now) <= RULES.windowMs
  )
}

/** R1: a success clears its own signature and its tool's same-error run. R2: a mutation clears the loop. */
export function recordSuccess(
  l: Ledger,
  loop: string,
  tool: string,
  input: unknown,
  now: number
): void {
  expire(l, loop, now)
  if (isMutation(tool, input)) {
    l.entries[loop] = []
    return
  }
  const sig = callSig(tool, input)
  l.entries[loop] = (l.entries[loop] ?? []).filter(
    (e) => e.sig !== sig && !(e.rule === 'same-error' && e.tool === tool)
  )
}

/** R4/R6: start a loop, or every loop, over. R6 also lifts every mute. */
export function resetLedger(l: Ledger, loop?: string): void {
  if (loop === undefined) {
    l.entries = {}
    l.muted = []
  } else l.entries[loop] = []
}

export type Verdict = { entry: Entry; rung: 0 | 1 | 2 }

/** Counts one counted failure under both rules; returns the higher rung it reaches. */
export function recordFailure(
  l: Ledger,
  loop: string,
  tool: string,
  input: unknown,
  text: string,
  now: number
): Verdict | null {
  expire(l, loop, now)
  const list = (l.entries[loop] ??= [])
  const sig = callSig(tool, input)
  const err = errSig(text)
  const head = text
    .replace(/\n*\[retry-breaker\][^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  const bump = (key: string, rule: Entry['rule']): Entry => {
    let e = list.find((x) => x.key === key)
    if (!e) {
      const since = l.seen[loop] ?? 0
      list.push(
        (e = { key, rule, tool, sig, count: 0, since, lastIndex: since, failures: [], denied: 0 })
      )
    }
    e.count += 1
    e.lastIndex = l.seen[loop] ?? 0
    e.failures = [...e.failures, { at: now, head }].slice(-4)
    return e
  }
  const verdicts: Verdict[] = []
  const ex = bump(`exact:${sig}|${err}`, 'exact')
  verdicts.push({
    entry: ex,
    rung: ex.count >= RULES.exact.ask ? 2 : ex.count >= RULES.exact.notice ? 1 : 0
  })
  if (!isGeneric(text)) {
    const se = bump(`same-error:${tool}|${err}`, 'same-error')
    const q = RULES.sameError
    verdicts.push({ entry: se, rung: se.count >= q.ask ? 2 : se.count >= q.notice ? 1 : 0 })
  }
  const live = verdicts.filter((v) => !l.muted.includes(v.entry.key))
  live.sort((a, b) => b.rung - a.rung)
  return live[0] ?? null
}

/** The exact entry a new call would repeat, if it has reached the refusal rung. */
export function refusalFor(l: Ledger, loop: string, sig: string): Entry | null {
  const e = (l.entries[loop] ?? []).find((x) => x.rule === 'exact' && x.sig === sig)
  if (!e || l.muted.includes(e.key) || e.count < RULES.exact.ask) return null
  return e
}

export function noticeText(e: Entry): string {
  const n = e.count
  return e.rule === 'exact'
    ? `[retry-breaker] This exact ${e.tool} call has now failed ${n} times with the same error. ` +
        `Repeating it unchanged will fail again: change the input, check the cause, or stop and say what blocks you.`
    : `[retry-breaker] ${e.tool} has failed ${n} times with the same error across different inputs. ` +
        `The cause is likely outside the input: check it, or stop and say what blocks you.`
}

export function refusalReason(e: Entry): string {
  return (
    `retry-breaker: this exact ${e.tool} call already failed ${e.count} times with the same error ` +
    `("${e.failures.at(-1)?.head ?? ''}"). Change the call or the cause first. ` +
    `The person can lift this with /retry-breaker reset.`
  )
}

/** The system notice a reset or a mute leaves in the transcript, so the host twin sees it (§5.4). */
export const RESET_NOTICE = '[retry-breaker] reset'
export const MUTE_NOTICE = '[retry-breaker] muted'
```
