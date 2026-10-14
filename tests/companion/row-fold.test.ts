import { describe, expect, it } from 'vitest'
import {
  TEXT_MAX,
  countsOf,
  emptyFold,
  foldAppend,
  foldTitle,
  restoredFold,
  wireOf,
  type Fold
} from '../../resources/companion/hooks/lib/row-fold'
import {
  attachment,
  clearCommandRows,
  engineNote,
  hookContext,
  loopRefireFixed,
  loopRefireSelfPaced,
  notice,
  pastedPrompt,
  peerMessage,
  pluginPrompt,
  probeStream,
  responseText,
  responseThinking,
  responseToolUse,
  subagentHandback,
  subagentPrompt,
  taskNotification,
  teammateReply,
  toolResult,
  typed,
  typedCommand,
  unclassifiedCommand,
  type TraceRow
} from '../../resources/companion/tests/fixtures/row-traces'

/**
 * T455 W1 AC-1: the row fold, golden traces over synthetic rows (spec §5.2 with the W0 findings'
 * M1, M2, M3a, M3b and correction D1). `null` = none seen by this process; ABSENT = unknown.
 */

const T0 = 1_790_000_000_000

/** Folds the rows in order, one ms apart, and returns the fold. */
function run(rows: TraceRow[], fold: Fold = emptyFold()): Fold {
  rows.forEach((r, i) => foldAppend(fold, r, T0 + i))
  return fold
}

describe('row fold: the empty and the restored row', () => {
  it('a new fold has every text null and every count zero', () => {
    expect(wireOf(emptyFold().row)).toEqual({
      fold: 1,
      firstPrompt: null,
      lastPrompt: null,
      lastAssistant: null,
      title: null,
      toolCalls: 0,
      subagentToolCalls: 0,
      userRows: 0,
      lastRowAt: null,
      lastUuid: null
    })
  })

  it('a restored fold has the counts and NO text field (absent = unknown)', () => {
    const counts = {
      toolCalls: 3,
      subagentToolCalls: 1,
      userRows: 5,
      lastRowAt: T0,
      lastUuid: 'u9'
    }
    const wire = wireOf(restoredFold(counts).row)
    expect(wire).toEqual({ fold: 1, ...counts })
    for (const k of ['firstPrompt', 'lastPrompt', 'lastAssistant', 'title'])
      expect(wire).not.toHaveProperty(k)
  })

  it('after a reload the first prompt stays unknown: the host has it', () => {
    const f = restoredFold({
      toolCalls: 0,
      subagentToolCalls: 0,
      userRows: 2,
      lastRowAt: T0,
      lastUuid: 'u1'
    })
    run([typed('a later ask')], f)
    expect(wireOf(f.row)).not.toHaveProperty('firstPrompt')
    expect(f.row.lastPrompt).toBe('a later ask')
    expect(f.row.userRows).toBe(3)
  })
})

describe('row fold: prompts (M3a lastPrompt, M3b firstPrompt)', () => {
  it('a typed prompt is both the first and the last prompt, whitespace collapsed', () => {
    const f = run([typed('fix   the\nflaky\ttest ')])
    expect(f.row.firstPrompt).toBe('fix the flaky test')
    expect(f.row.lastPrompt).toBe('fix the flaky test')
  })

  it('a typed slash command: lastPrompt is "/name args", firstPrompt its name (the reader)', () => {
    const f = run([typedCommand('/hello', 'world')])
    expect(f.row.lastPrompt).toBe('/hello world')
    expect(f.row.firstPrompt).toBe('/hello')
  })

  it('a typed slash command with no args reads "/name"', () => {
    expect(run([typedCommand('/context')]).row.lastPrompt).toBe('/context')
  })

  it('machine-made prompt rows never become the last prompt', () => {
    const f = run([
      typed('the real ask'),
      taskNotification(),
      peerMessage(),
      loopRefireFixed(),
      loopRefireSelfPaced(),
      teammateReply(),
      engineNote(),
      subagentHandback(),
      unclassifiedCommand('<local-command-stdout>done</local-command-stdout>')
    ])
    expect(f.row.lastPrompt).toBe('the real ask')
    expect(f.row.firstPrompt).toBe('the real ask')
  })

  it('origins the corpus never showed are skipped for lastPrompt (untested defaults)', () => {
    for (const kind of [
      'bridge',
      'plugin',
      'scheduled-trigger',
      'sdk',
      'slack-ping',
      'channel',
      'auto-continuation',
      'peer-send-message',
      'projects-relay',
      'observer'
    ]) {
      const row = typed('from elsewhere')
      row.origin = { kind }
      const f = run([typed('typed first'), row])
      expect(f.row.lastPrompt, kind).toBe('typed first')
    }
  })

  it('a teammate session: the first prompt mirrors the reader (any door), the last skips it', () => {
    const opening: TraceRow = {
      ...teammateReply(),
      message: {
        type: 'user',
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<teammate-message teammate_id="lead">sort the list</teammate-message>'
          }
        ]
      }
    }
    const f = run([opening])
    expect(f.row.firstPrompt).toBe(
      '<teammate-message teammate_id="lead">sort the list</teammate-message>'
    )
    expect(f.row.lastPrompt).toBeNull()
  })

  it('a peer row is never a first prompt (P2W2 §7.7)', () => {
    const f = run([peerMessage(), typed('then the person asked')])
    expect(f.row.firstPrompt).toBe('then the person asked')
  })

  it('an unstamped command is a first prompt (the reader resolves it to its name)', () => {
    const f = run(clearCommandRows())
    expect(f.row.firstPrompt).toBe('/clear')
    expect(f.row.lastPrompt).toBeNull()
  })

  it('a meta-only first row is skipped by the reader rule, not by isMeta', () => {
    // the caveat is pure meta: stripped to nothing, so the next row decides
    const f = run([
      unclassifiedCommand(
        '<local-command-caveat>Caveat: local command.</local-command-caveat>',
        true
      ),
      engineNote('a skill body the engine expanded')
    ])
    expect(f.row.firstPrompt).toBe('a skill body the engine expanded')
  })

  it('plugin rows follow P2W2 §7.7 for the first prompt: asUser bare, framed stripped', () => {
    expect(run([pluginPrompt('review the diff', true)]).row.firstPrompt).toBe('review the diff')
    expect(run([pluginPrompt('review the diff', false)]).row.firstPrompt).toBe('review the diff')
    const meta = pluginPrompt('context for the model', true)
    meta.message.isMeta = true
    expect(run([meta]).row.firstPrompt).toBeNull()
  })

  it('D1: a pasted-content wrapper is removed from the last prompt, its content kept', () => {
    const f = run([pastedPrompt('line one\nline two')])
    expect(f.row.lastPrompt).toBe('line one line two')
    expect(f.row.lastPrompt).not.toContain('pasted_content')
  })

  it('the first prompt never changes once set', () => {
    const f = run([typed('first'), typed('second'), typedCommand('/third')])
    expect(f.row.firstPrompt).toBe('first')
    expect(f.row.lastPrompt).toBe('/third')
  })

  it('texts are capped at 240 characters', () => {
    const f = run([typed('word '.repeat(200))])
    expect(f.row.lastPrompt!.length).toBe(TEXT_MAX)
    expect(f.row.lastPrompt!.endsWith('…')).toBe(true)
    expect(f.row.firstPrompt!.length).toBeLessThanOrEqual(TEXT_MAX)
  })
})

describe('row fold: assistant text, tools and user rows', () => {
  it('the last non-empty assistant text; thinking and tool_use are not text', () => {
    const f = run([
      typed('go'),
      responseText('first answer'),
      responseThinking(),
      responseToolUse(2),
      responseText('  final\n answer ')
    ])
    expect(f.row.lastAssistant).toBe('final answer')
    expect(f.row.toolCalls).toBe(2)
  })

  it('tool results count as user rows; attachments, hook rows and notices do not', () => {
    const f = run([
      typed('go'),
      responseToolUse(1),
      hookContext(),
      toolResult(),
      attachment(),
      notice()
    ])
    expect(f.row.userRows).toBe(2)
  })

  it('every main-loop user row counts, machine-made ones included (the reader counts them)', () => {
    const f = run([typed('a'), taskNotification(), peerMessage(), teammateReply(), engineNote()])
    expect(f.row.userRows).toBe(5)
  })

  it('subagent rows are counted apart and change nothing else (main loop only)', () => {
    const f = run([
      typed('delegate it'),
      subagentPrompt('agent-1'),
      responseToolUse(2, 'agent-1'),
      toolResult('agent-1'),
      responseText('subagent text', 'agent-1'),
      subagentHandback()
    ])
    expect(f.row.subagentToolCalls).toBe(2)
    expect(f.row.toolCalls).toBe(0)
    expect(f.row.lastAssistant).toBeNull()
    expect(f.row.lastPrompt).toBe('delegate it')
    expect(f.row.userRows).toBe(2) // the typed prompt and the hand-back, both main-loop rows
  })
})

describe('row fold: lastUuid and lastRowAt (M1)', () => {
  it('a hook-context row never moves lastUuid or lastRowAt', () => {
    const f = emptyFold()
    const a = typed('go')
    foldAppend(f, a, T0 + 5)
    foldAppend(f, hookContext(), T0 + 9)
    expect(f.row.lastUuid).toBe(a.uuid)
    expect(f.row.lastRowAt).toBe(T0 + 5)
  })

  it('a subagent row never moves lastUuid or lastRowAt (its rows are another file)', () => {
    const f = emptyFold()
    const a = typed('go')
    foldAppend(f, a, T0 + 5)
    foldAppend(f, responseToolUse(1, 'agent-1'), T0 + 9)
    expect(f.row.lastUuid).toBe(a.uuid)
    expect(f.row.lastRowAt).toBe(T0 + 5)
  })

  it('a notice moves them, but is not a change worth a push', () => {
    const f = run([typed('go')])
    const n = notice()
    expect(foldAppend(f, n, T0 + 50)).toBe(false)
    expect(f.row.lastUuid).toBe(n.uuid)
    expect(f.row.lastRowAt).toBe(T0 + 50)
  })

  it('an attachment, and a door the fold does not know (2.1.299 `queue`), change nothing', () => {
    const f = run([typed('go')])
    const before = JSON.stringify(f.row)
    expect(foldAppend(f, attachment(), T0 + 60)).toBe(false)
    const queued: TraceRow = { ...typed('the queued -p prompt'), door: 'queue' }
    expect(foldAppend(f, queued, T0 + 70)).toBe(false)
    expect(JSON.stringify(f.row)).toBe(before)
  })

  it('the /clear reorder: the new conversation aligns on its last command row', () => {
    // appended: the three /clear rows, then two SessionStart hook rows (stored BEFORE them)
    const rows = [
      ...clearCommandRows(),
      hookContext('hook_success'),
      hookContext('hook_additional_context')
    ]
    const f = run(rows)
    expect(f.row.lastUuid).toBe(rows[2]!.uuid)
    expect(f.row.userRows).toBe(3)
    expect(f.row.firstPrompt).toBe('/clear')
    expect(f.row.lastPrompt).toBeNull()
  })
})

describe('row fold: what is a change worth a push', () => {
  it('the probe stream: only the prompt, the tool call, the tool result and the answer change', () => {
    const changed = probeStream()
      .map(({ at, row }) => ({
        door: row.door,
        changed: foldAppend(emptyFoldOnce(), row, T0 + at)
      }))
      .filter((x) => x.changed)
      .map((x) => x.door)
    expect(changed).toEqual(['prompt', 'response', 'tool-result', 'response'])
  })
})

let shared: Fold | null = null
/** One fold across the whole probe stream (the `map` above folds every row into it). */
function emptyFoldOnce(): Fold {
  shared ??= emptyFold()
  return shared
}

describe('row fold: title (M2)', () => {
  it('the latest session_title, recorded; absent or empty changes nothing', () => {
    const f = emptyFold()
    expect(foldTitle(f, undefined)).toBe(false)
    expect(foldTitle(f, '')).toBe(false)
    expect(f.row.title).toBeNull()
    expect(foldTitle(f, 'renamed  session')).toBe(true)
    expect(f.row.title).toBe('renamed session')
    expect(foldTitle(f, 'renamed session')).toBe(false)
  })
})

describe('row fold: redaction and fail-closed fields (§5.5 rule 2)', () => {
  it('every text field passes through the wire redaction', () => {
    const token = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('')
    const f = run([typed(`use ${token} please`), responseText(`I used ${token}`)])
    foldTitle(f, `title ${token}`)
    for (const v of [f.row.firstPrompt, f.row.lastPrompt, f.row.lastAssistant, f.row.title]) {
      expect(v).toContain('[REDACTED:github-token]')
      expect(v).not.toContain(token)
    }
  })

  it('a secret past the 240-char cap is redacted before the cut, never cut in half', () => {
    const token = ['gh', 'p_', 'Z9y8X7w6'.repeat(5)].join('')
    const f = run([typed(`${'x'.repeat(225)} ${token}`)])
    expect(f.row.lastPrompt).not.toContain(token.slice(0, 12))
  })

  it('a throwing redaction sends that field null, never the raw text', () => {
    const f = emptyFold()
    const boom = (): string => {
      throw new Error('redaction failed')
    }
    foldAppend(f, typed('a prompt'), T0, boom)
    foldAppend(f, responseText('an answer'), T0 + 1, boom)
    expect(f.row.lastPrompt).toBeNull()
    expect(f.row.firstPrompt).toBeNull()
    expect(f.row.lastAssistant).toBeNull()
    // the counts still move: only the text is withheld
    expect(f.row.userRows).toBe(1)
    // and the next prompt is not mistaken for the first one
    foldAppend(f, typed('a second prompt'), T0 + 2)
    expect(f.row.firstPrompt).toBeNull()
    expect(f.row.lastPrompt).toBe('a second prompt')
  })
})

describe('row fold: counts for $.state carry no text', () => {
  it('countsOf holds only counts, the time and the uuid', () => {
    const f = run([typed('a secret-looking prompt'), responseText('a secret-looking answer')])
    const c = countsOf(f.row)
    expect(Object.keys(c).sort()).toEqual(
      ['lastRowAt', 'lastUuid', 'subagentToolCalls', 'toolCalls', 'userRows'].sort()
    )
    expect(JSON.stringify(c)).not.toContain('secret-looking')
  })
})
