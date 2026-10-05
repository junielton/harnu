/**
 * Approval Inbox — PURE CORE (approval-inbox spec §4.1). Zero electron/node deps
 * (only types), mirroring hook-state.ts / responder-dispatch.ts. Extracts the
 * tool call from a gated hook body and builds a short, readable summary so the
 * operator can decide without opening the tab. Fail-safe + total: never throws.
 */

/** The gate that originated the approval. */
export type ApprovalKind = 'permission_request' | 'permission_prompt'

/** Why a pending approval left the queue (drives the optimistic toast). */
export type ApprovalResolvedReason = 'decided' | 'timeout' | 'superseded'

/**
 * The wire shape of a pending approval (main → renderer). `requestId`,
 * `createdAtMs`, `deadlineMs` are supplied by the caller (the dispatch layer);
 * the rest is extracted from the hook body.
 */
export interface PendingApprovalWire {
  requestId: string
  sessionId: string
  kind: ApprovalKind
  /** body.tool_name, '' when absent. */
  toolName: string
  /** body.tool_input normalized to a flat string→string record (complex values
   *  become short JSON). Never null. */
  toolInput: Record<string, string>
  /** Short readable summary (e.g. `Bash(rm -rf build)`) — computed here so the
   *  renderer never has to import the pure fn across the process boundary. A
   *  technical string (tool names untranslated, §8), not i18n copy. */
  summary: string
  createdAtMs: number
  deadlineMs: number
}

interface ApprovalMeta {
  requestId: string
  kind: ApprovalKind
  createdAtMs: number
  deadlineMs: number
}

function shortJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Normalize a raw tool_input into a flat string→string record. */
function normalizeInput(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : shortJson(v)
  }
  return out
}

/**
 * Extract the approval fields from a hook POST body. PURE, fail-safe: tool_name
 * absent → ''; tool_input absent/non-object → {}; non-string tool_input values
 * are serialized (short JSON). Never throws. requestId/createdAtMs/deadlineMs
 * come from `meta` (the dispatch layer), not the body.
 */
export function parseApprovalBody(
  body: Record<string, unknown>,
  meta: ApprovalMeta
): PendingApprovalWire {
  const toolName =
    typeof body.tool_name === 'string'
      ? body.tool_name
      : typeof body.toolName === 'string'
        ? body.toolName
        : ''
  const sessionId = String(body.session_id ?? body.sessionId ?? '')
  const toolInput = normalizeInput(body.tool_input ?? body.toolInput)
  return {
    requestId: meta.requestId,
    sessionId,
    kind: meta.kind,
    toolName,
    toolInput,
    summary: toolSummary(toolName, toolInput),
    createdAtMs: meta.createdAtMs,
    deadlineMs: meta.deadlineMs
  }
}

/** The primary argument to surface per known tool. */
const PRIMARY_ARG: Record<string, string> = {
  Bash: 'command',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern'
}

const DEFAULT_MAX_LEN = 48

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…'
}

/**
 * Build the short, readable summary of a tool call (e.g. `Bash(rm -rf build)`,
 * `Edit(.env)`, `mcp__github__create_pr(repo=x)`). Truncates the argument at
 * `maxLen`. PURE — returns the raw technical tool name verbatim (NOT an i18n
 * key; tool names are untranslated technical nouns, §8). Falls back to the bare
 * tool name when there's no obvious argument. Never throws.
 */
export function toolSummary(
  toolName: string,
  toolInput: Record<string, string>,
  maxLen: number = DEFAULT_MAX_LEN
): string {
  if (!toolName) return ''
  let arg: string | undefined
  if (toolName.startsWith('mcp__')) {
    const firstKey = Object.keys(toolInput)[0]
    if (firstKey !== undefined) arg = `${firstKey}=${toolInput[firstKey]}`
  } else {
    const key = PRIMARY_ARG[toolName]
    if (key !== undefined && toolInput[key] !== undefined) arg = toolInput[key]
  }
  if (arg === undefined || arg === '') return toolName
  return `${toolName}(${truncate(arg, maxLen)})`
}
