/**
 * The browser pane's console buffer (T564 U3, spec §6.1 row 6 and §6.2): a ring of 500 entries / 256 KiB per
 * pane, fed from CDP `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Log.entryAdded`, from the moment
 * the pane is created. Errors keep their stack. Pure (ADR-0001): the host forwards raw CDP params in.
 */
import { createCursorRing, type CursorRing, type CursorRead } from './cursor-ring'

export const CONSOLE_MAX_ENTRIES = 500
export const CONSOLE_MAX_BYTES = 256 * 1024
/** One argument's text, and one whole entry's text, are cut here so a single log line cannot fill the ring. */
const MAX_ARG_CHARS = 2_000
const MAX_TEXT_CHARS = 4_000
const MAX_STACK_FRAMES = 20

export const CONSOLE_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

export interface ConsoleEntry {
  /** Epoch ms. */
  ts: number
  level: ConsoleLevel
  /** Where it came from: a `console.*` call, an uncaught exception, or the browser's own log. */
  source: 'console' | 'exception' | 'browser'
  text: string
  url?: string
  line?: number
  /** Present on errors, and on `console.trace`. */
  stack?: string
}

/** The slice of a CDP `Runtime.RemoteObject` we read. */
interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  className?: string
}

interface CallFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

interface StackTrace {
  callFrames?: CallFrame[]
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function renderArg(arg: RemoteObject): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  if (arg.value !== undefined) {
    if (typeof arg.value === 'string') return cut(arg.value, MAX_ARG_CHARS)
    try {
      return cut(JSON.stringify(arg.value) ?? String(arg.value), MAX_ARG_CHARS)
    } catch {
      return String(arg.value)
    }
  }
  if (arg.subtype === 'null') return 'null'
  return cut(arg.description ?? arg.className ?? arg.type ?? '', MAX_ARG_CHARS)
}

function formatStack(trace: StackTrace | undefined): string | undefined {
  const frames = trace?.callFrames
  if (!frames || frames.length === 0) return undefined
  return frames
    .slice(0, MAX_STACK_FRAMES)
    .map((f) => {
      const where = `${f.url ?? ''}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1}`
      return f.functionName ? `at ${f.functionName} (${where})` : `at ${where}`
    })
    .join('\n')
}

/** `console.warning` → `warn`, `console.dir` → `log`: CDP's type names folded onto the five levels. */
export function levelOfConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case 'debug':
      return 'debug'
    case 'info':
      return 'info'
    case 'warning':
      return 'warn'
    case 'error':
    case 'assert':
      return 'error'
    default:
      return 'log'
  }
}

function levelOfLogLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'verbose':
      return 'debug'
    case 'info':
      return 'info'
    case 'warning':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'log'
  }
}

/** `Runtime.consoleAPICalled` → an entry, or `null` for the types that are not messages (`clear`). */
export function entryFromConsoleCall(
  params: {
    type?: string
    args?: RemoteObject[]
    timestamp?: number
    stackTrace?: StackTrace
  },
  now: number
): ConsoleEntry | null {
  const type = params.type ?? 'log'
  if (type === 'clear' || type === 'endGroup') return null
  const level = levelOfConsoleType(type)
  const text = cut((params.args ?? []).map(renderArg).join(' '), MAX_TEXT_CHARS)
  const top = params.stackTrace?.callFrames?.[0]
  const entry: ConsoleEntry = {
    ts: Math.round(params.timestamp ?? now),
    level,
    source: 'console',
    text
  }
  if (top?.url) {
    entry.url = top.url
    entry.line = (top.lineNumber ?? 0) + 1
  }
  // Errors and traces keep their stack (spec §6.2); a plain log does not need one.
  if (level === 'error' || type === 'trace') {
    const stack = formatStack(params.stackTrace)
    if (stack) entry.stack = stack
  }
  return entry
}

/** `Runtime.exceptionThrown` → an `error` entry carrying the exception's description (message and stack). */
export function entryFromException(
  params: {
    timestamp?: number
    exceptionDetails?: {
      text?: string
      url?: string
      lineNumber?: number
      exception?: RemoteObject
      stackTrace?: StackTrace
    }
  },
  now: number
): ConsoleEntry {
  const d = params.exceptionDetails ?? {}
  const described = d.exception?.description
  const text = cut(
    described ? (described.split('\n')[0] ?? '') : (d.text ?? 'Uncaught'),
    MAX_TEXT_CHARS
  )
  const entry: ConsoleEntry = {
    ts: Math.round(params.timestamp ?? now),
    level: 'error',
    source: 'exception',
    text
  }
  if (d.url) {
    entry.url = d.url
    entry.line = (d.lineNumber ?? 0) + 1
  }
  const stack = described && described.includes('\n') ? described : formatStack(d.stackTrace)
  if (stack) entry.stack = cut(stack, MAX_TEXT_CHARS)
  return entry
}

/** `Log.entryAdded` (the browser's own messages: network errors, deprecations, CSP) → an entry. */
export function entryFromLog(
  params: {
    entry?: {
      level?: string
      text?: string
      timestamp?: number
      url?: string
      lineNumber?: number
      stackTrace?: StackTrace
    }
  },
  now: number
): ConsoleEntry | null {
  const e = params.entry
  if (!e || typeof e.text !== 'string') return null
  const out: ConsoleEntry = {
    ts: Math.round(e.timestamp ?? now),
    level: levelOfLogLevel(e.level ?? 'info'),
    source: 'browser',
    text: cut(e.text, MAX_TEXT_CHARS)
  }
  if (e.url) {
    out.url = e.url
    if (e.lineNumber !== undefined) out.line = e.lineNumber + 1
  }
  const stack = out.level === 'error' ? formatStack(e.stackTrace) : undefined
  if (stack) out.stack = stack
  return out
}

function entryBytes(e: ConsoleEntry): number {
  return 48 + e.text.length + (e.url?.length ?? 0) + (e.stack?.length ?? 0)
}

export interface ConsoleBuffer {
  ingest(method: string, params: unknown): void
  push(entry: ConsoleEntry): void
  read(req: ConsoleReadRequest): ConsoleReadResult
}

export interface ConsoleReadRequest {
  mode: 'tail' | 'since'
  /** `tail`: how many of the newest entries (1..500). `since`: the page size (1..500). */
  lines: number
  since?: string
  levels?: readonly ConsoleLevel[]
  clear?: boolean
}

export type ConsoleReadResult =
  | { ok: true; entries: ConsoleEntry[]; cursor: string; droppedEntries: number }
  | { ok: false; error: 'CURSOR_EXPIRED' | 'BAD_ARGS' }

export function createConsoleBuffer(now: () => number): ConsoleBuffer {
  const ring: CursorRing<ConsoleEntry> = createCursorRing(
    { maxEntries: CONSOLE_MAX_ENTRIES, maxBytes: CONSOLE_MAX_BYTES },
    entryBytes
  )
  return {
    ingest(method, params) {
      const p = (params ?? {}) as Record<string, never>
      let entry: ConsoleEntry | null = null
      if (method === 'Runtime.consoleAPICalled') entry = entryFromConsoleCall(p, now())
      else if (method === 'Runtime.exceptionThrown') entry = entryFromException(p, now())
      else if (method === 'Log.entryAdded') entry = entryFromLog(p, now())
      if (entry) ring.push(entry)
    },
    push: (entry) => void ring.push(entry),
    read(req) {
      const keep =
        req.levels && req.levels.length > 0
          ? (e: ConsoleEntry) => req.levels!.includes(e.level)
          : undefined
      let res: CursorRead<ConsoleEntry>
      if (req.mode === 'since') {
        if (req.since === undefined) return { ok: false, error: 'BAD_ARGS' }
        res = ring.since(req.since, req.lines, keep)
      } else {
        res = ring.tail(req.lines, keep)
      }
      if (!res.ok) return res
      if (req.clear) ring.clear()
      return {
        ok: true,
        entries: res.entries.map((e) => e.value),
        cursor: res.cursor,
        droppedEntries: res.droppedEntries
      }
    }
  }
}
