import { describe, it, expect } from 'vitest'
import {
  isChainParticipant,
  isNoiseEntry,
  lastChainParticipant,
  toolUseNames,
  deriveTurnState,
  deriveTitles,
  pickTitle,
  pickWhatsHappening,
  extractAwaySummary,
  contextWindowForModel,
  computeCtxPct,
  deriveTranscriptTruth,
  DEFAULT_CONTEXT_WINDOW,
  LARGE_CONTEXT_WINDOW,
  type TranscriptEntry
} from '../src/main/transcript-truth'

/**
 * T91 — transcript ground-truth derivations. Fixtures mirror the REAL on-disk
 * shapes captured from `~/.claude/projects`:
 * assistant `message.stop_reason`/`usage`, `system` subtypes
 * (turn_duration/stop_hook_summary/away_summary/compact_boundary), and the
 * metadata tail (last-prompt/custom-title/ai-title/mode/permission-mode/bridge).
 */

let uid = 0
const nextUuid = (): string => `uuid-${++uid}`

// --- Real-shaped entry builders ------------------------------------------------

const userMsg = (text: string): TranscriptEntry => ({
  type: 'user',
  uuid: nextUuid(),
  parentUuid: null,
  isSidechain: false,
  message: { role: 'user', content: text }
})

const toolResult = (): TranscriptEntry => ({
  type: 'user',
  uuid: nextUuid(),
  isSidechain: false,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
})

const assistantText = (
  text: string,
  stop_reason: string | null = 'end_turn',
  model = 'claude-opus-4-8'
): TranscriptEntry => ({
  type: 'assistant',
  uuid: nextUuid(),
  isSidechain: false,
  requestId: 'req_1',
  message: {
    role: 'assistant',
    model,
    stop_reason,
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 8945,
      cache_creation_input_tokens: 15947,
      cache_read_input_tokens: 19380,
      output_tokens: 279
    }
  }
})

const assistantToolUse = (
  toolName: string,
  model = 'claude-opus-4-8',
  usage?: Record<string, number>
): TranscriptEntry => ({
  type: 'assistant',
  uuid: nextUuid(),
  isSidechain: false,
  message: {
    role: 'assistant',
    model,
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'let me do that' },
      { type: 'tool_use', id: 't1', name: toolName, input: {} }
    ],
    usage: usage ?? {
      input_tokens: 1000,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 3000,
      output_tokens: 10
    }
  }
})

const sys = (subtype: string, extra: Record<string, unknown> = {}): TranscriptEntry => ({
  type: 'system',
  uuid: nextUuid(),
  isSidechain: false,
  subtype,
  ...extra
})

const turnDuration = (): TranscriptEntry =>
  sys('turn_duration', { durationMs: 1736422, messageCount: 465, isMeta: false })
const stopHookSummary = (): TranscriptEntry =>
  sys('stop_hook_summary', { hookCount: 1, preventedContinuation: false, stopReason: '' })
const awaySummary = (content: string): TranscriptEntry =>
  sys('away_summary', { content, isMeta: false })
const compactBoundary = (postTokens: number, preTokens = 854842): TranscriptEntry =>
  sys('compact_boundary', {
    parentUuid: null,
    logicalParentUuid: 'x',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens, postTokens, precomputed: true }
  })

// The metadata block the CLI re-appends at EOF on pause/switch/resume — NONE of
// these carry a `uuid`, so the chain filter must drop them all.
const metadataTail = (): TranscriptEntry[] => [
  { type: 'last-prompt', lastPrompt: 'continue the work', leafUuid: 'l1', sessionId: 's1' },
  { type: 'custom-title', customTitle: 'My renamed session', sessionId: 's1' },
  { type: 'mode', mode: 'normal', sessionId: 's1' },
  { type: 'permission-mode', permissionMode: 'auto', sessionId: 's1' },
  { type: 'bridge-session', sessionId: 's1', bridgeSessionId: 'cse_x', lastSequenceNum: 0 }
]

// --- isChainParticipant / tail filtering (T91 §2) ------------------------------

describe('isChainParticipant', () => {
  it('accepts user/assistant/system with a uuid', () => {
    expect(isChainParticipant(userMsg('hi'))).toBe(true)
    expect(isChainParticipant(assistantText('yo'))).toBe(true)
    expect(isChainParticipant(turnDuration())).toBe(true)
  })

  it('rejects every re-appended metadata entry (no uuid)', () => {
    for (const m of metadataTail()) expect(isChainParticipant(m)).toBe(false)
  })

  it('rejects attachments and unknown types even if they carry a uuid', () => {
    expect(isChainParticipant({ type: 'attachment', uuid: 'a1' })).toBe(false)
    expect(isChainParticipant({ type: 'ai-title', aiTitle: 't' })).toBe(false)
  })

  it('rejects malformed input', () => {
    expect(isChainParticipant(null)).toBe(false)
    expect(isChainParticipant(undefined)).toBe(false)
    expect(isChainParticipant({})).toBe(false)
    expect(isChainParticipant({ type: 'user' })).toBe(false) // no uuid
    expect(isChainParticipant({ uuid: 'x' })).toBe(false) // no type
  })
})

describe('lastChainParticipant', () => {
  it('skips the metadata tail to find the real last chain entry', () => {
    const entries = [
      userMsg('start'),
      assistantText('done', 'end_turn'),
      turnDuration(),
      ...metadataTail()
    ]
    const last = lastChainParticipant(entries)
    expect(last?.type).toBe('system')
    expect(last?.subtype).toBe('turn_duration')
  })

  it('returns null when nothing is a chain participant', () => {
    expect(lastChainParticipant(metadataTail())).toBeNull()
    expect(lastChainParticipant([])).toBeNull()
  })
})

// --- isNoiseEntry (T91 §6) -----------------------------------------------------

describe('isNoiseEntry', () => {
  it('flags content-replacement and marble-origami-* for skipping', () => {
    expect(isNoiseEntry({ type: 'content-replacement', uuids: ['a', 'b'] })).toBe(true)
    expect(isNoiseEntry({ type: 'marble-origami-commit' })).toBe(true)
    expect(isNoiseEntry({ type: 'marble-origami-snapshot' })).toBe(true)
    expect(isNoiseEntry({ type: 'marble-origami-anything' })).toBe(true)
  })
  it('does not flag real entries', () => {
    expect(isNoiseEntry(userMsg('hi'))).toBe(false)
    expect(isNoiseEntry(assistantText('x'))).toBe(false)
  })
  it('flags malformed entries', () => {
    expect(isNoiseEntry(null)).toBe(true)
    expect(isNoiseEntry({})).toBe(true)
  })
})

// --- toolUseNames --------------------------------------------------------------

describe('toolUseNames', () => {
  it('extracts tool_use block names', () => {
    expect(toolUseNames(assistantToolUse('Bash'))).toEqual(['Bash'])
    expect(toolUseNames(assistantToolUse('AskUserQuestion'))).toEqual(['AskUserQuestion'])
  })
  it('returns [] for a text-only assistant turn', () => {
    expect(toolUseNames(assistantText('hi'))).toEqual([])
  })
})

// --- deriveTurnState: the state machine (T91 §1) -------------------------------

describe('deriveTurnState', () => {
  it('end_turn → stop_hook_summary → turn_duration reads idle (even with metadata tail)', () => {
    const entries = [
      userMsg('do the thing'),
      assistantText('all done', 'end_turn'),
      stopHookSummary(),
      turnDuration(),
      ...metadataTail()
    ]
    expect(deriveTurnState(entries)).toBe('idle')
  })

  it('a bare end_turn assistant (no markers yet) reads idle', () => {
    expect(deriveTurnState([userMsg('q'), assistantText('a', 'end_turn')])).toBe('idle')
  })

  it('last assistant stop_reason tool_use (normal tool) reads working', () => {
    const entries = [userMsg('run tests'), assistantToolUse('Bash')]
    expect(deriveTurnState(entries)).toBe('working')
  })

  it('mid-turn AskUserQuestion tool_use with no result reads needs-input', () => {
    const entries = [userMsg('which db?'), assistantToolUse('AskUserQuestion')]
    expect(deriveTurnState(entries)).toBe('needs-input')
  })

  it('mid-turn ExitPlanMode with no result reads needs-input', () => {
    const entries = [userMsg('plan it'), assistantToolUse('ExitPlanMode')]
    expect(deriveTurnState(entries)).toBe('needs-input')
  })

  it('an AskUserQuestion that WAS answered (tool_result follows) is not needs-input', () => {
    // The answered tool_result makes the user turn the last chain entry → working.
    const entries = [userMsg('which db?'), assistantToolUse('AskUserQuestion'), toolResult()]
    expect(deriveTurnState(entries)).toBe('working')
  })

  it('needs-input survives a polluted metadata tail', () => {
    const entries = [userMsg('which db?'), assistantToolUse('AskUserQuestion'), ...metadataTail()]
    expect(deriveTurnState(entries)).toBe('needs-input')
  })

  it('a still-streaming assistant (stop_reason null) reads working', () => {
    expect(deriveTurnState([userMsg('go'), assistantText('partial', null)])).toBe('working')
  })

  it('a trailing user prompt reads working', () => {
    expect(deriveTurnState([assistantText('done', 'end_turn'), userMsg('now do X')])).toBe(
      'working'
    )
  })

  it('an away_summary marks the turn idle', () => {
    const entries = [
      userMsg('q'),
      assistantText('a', 'end_turn'),
      awaySummary('Goal: ship. Next: test.')
    ]
    expect(deriveTurnState(entries)).toBe('idle')
  })

  it('an empty or metadata-only window is unknown (caller falls back to quiet-timer)', () => {
    expect(deriveTurnState([])).toBe('unknown')
    expect(deriveTurnState(metadataTail())).toBe('unknown')
  })
})

// --- Titles (T91 §3) -----------------------------------------------------------

describe('deriveTitles / pickTitle / pickWhatsHappening', () => {
  it('latest custom-title and ai-title win', () => {
    const entries: TranscriptEntry[] = [
      { type: 'ai-title', aiTitle: 'First AI title' },
      { type: 'custom-title', customTitle: 'User title' },
      { type: 'ai-title', aiTitle: 'Second AI title' },
      { type: 'last-prompt', lastPrompt: 'keep going' }
    ]
    const t = deriveTitles(entries)
    expect(t.customTitle).toBe('User title')
    expect(t.aiTitle).toBe('Second AI title')
    expect(t.lastPrompt).toBe('keep going')
  })

  it('pickTitle prefers custom-title over ai-title (never clobbers user)', () => {
    expect(pickTitle({ customTitle: 'mine', aiTitle: 'auto' })).toBe('mine')
    expect(pickTitle({ customTitle: '', aiTitle: 'auto' })).toBe('auto')
    expect(pickTitle({ customTitle: '', aiTitle: '' })).toBe('')
  })

  it('pickWhatsHappening cascades task-summary → last-prompt → firstPrompt', () => {
    expect(pickWhatsHappening({ taskSummary: 'summary', lastPrompt: 'lp' }, 'fp')).toBe('summary')
    expect(pickWhatsHappening({ taskSummary: '', lastPrompt: 'lp' }, 'fp')).toBe('lp')
    expect(pickWhatsHappening({ taskSummary: '', lastPrompt: '' }, 'fp')).toBe('fp')
    expect(pickWhatsHappening({ taskSummary: '', lastPrompt: '' }, '')).toBe('')
  })
})

// --- away_summary (T91 §4) -----------------------------------------------------

describe('extractAwaySummary', () => {
  it('returns the latest away_summary content verbatim', () => {
    const entries = [
      awaySummary('old recap'),
      assistantText('work', 'end_turn'),
      awaySummary('Goal: land T91. Next: run gates.')
    ]
    expect(extractAwaySummary(entries)).toBe('Goal: land T91. Next: run gates.')
  })
  it('returns empty when no away_summary is present', () => {
    expect(extractAwaySummary([userMsg('hi'), assistantText('yo')])).toBe('')
  })
})

// --- ctx% (T91 §5) -------------------------------------------------------------

describe('contextWindowForModel', () => {
  it('is 200k by default and 1M for [1m] models', () => {
    expect(contextWindowForModel('claude-opus-4-8')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowForModel('claude-sonnet-5[1m]')).toBe(LARGE_CONTEXT_WINDOW)
    expect(contextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowForModel(null)).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('computeCtxPct', () => {
  it('uses the last assistant usage (input + cache_creation + cache_read) over the window', () => {
    // 8945 + 15947 + 19380 = 44272 / 200000 = 22.136% → 22
    const ctx = computeCtxPct([userMsg('q'), assistantText('a', 'end_turn')])
    expect(ctx).not.toBeNull()
    expect(ctx?.usedTokens).toBe(44272)
    expect(ctx?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(ctx?.pct).toBe(22)
  })

  it('the LATEST assistant usage wins', () => {
    const big = assistantToolUse('Bash', 'claude-opus-4-8', {
      input_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1
    })
    const ctx = computeCtxPct([assistantText('a', 'end_turn'), big])
    expect(ctx?.usedTokens).toBe(100_000)
    expect(ctx?.pct).toBe(50)
  })

  it('scales to 1M for a [1m] model', () => {
    const a = assistantToolUse('Bash', 'claude-sonnet-5[1m]', {
      input_tokens: 500_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1
    })
    const ctx = computeCtxPct([a])
    expect(ctx?.contextWindow).toBe(LARGE_CONTEXT_WINDOW)
    expect(ctx?.pct).toBe(50)
  })

  it('resets the baseline from compact_boundary.postTokens when no assistant follows', () => {
    const entries = [
      assistantText('big turn', 'end_turn'), // usage 44272
      compactBoundary(21298) // compaction with no assistant after
    ]
    const ctx = computeCtxPct(entries)
    expect(ctx?.usedTokens).toBe(21298)
    expect(ctx?.pct).toBe(11) // 21298 / 200000 = 10.6% → 11
  })

  it('a post-compaction assistant usage wins over the boundary baseline', () => {
    const entries = [
      assistantText('big turn', 'end_turn'),
      compactBoundary(21298),
      assistantToolUse('Bash', 'claude-opus-4-8', {
        input_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1
      })
    ]
    expect(computeCtxPct(entries)?.usedTokens).toBe(5000)
  })

  it('returns null when no usage is present (caller falls back to statusline)', () => {
    expect(computeCtxPct([userMsg('hi')])).toBeNull()
    expect(computeCtxPct(metadataTail())).toBeNull()
  })
})

// --- aggregate -----------------------------------------------------------------

describe('deriveTranscriptTruth', () => {
  it('composes every derivation over a realistic tail window', () => {
    const entries = [
      userMsg('implement T91'),
      assistantText('working on it', 'end_turn'),
      stopHookSummary(),
      turnDuration(),
      awaySummary('Goal: finish T91. Next: commit.'),
      { type: 'ai-title', aiTitle: 'T91 reader truth' },
      { type: 'custom-title', customTitle: 'T91' },
      { type: 'last-prompt', lastPrompt: 'run the gates' }
    ]
    const truth = deriveTranscriptTruth(entries)
    expect(truth.transcriptState).toBe('idle')
    expect(pickTitle(truth.titles)).toBe('T91')
    expect(truth.awaySummary).toBe('Goal: finish T91. Next: commit.')
    expect(truth.ctx?.pct).toBe(22)
  })
})
