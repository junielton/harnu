/**
 * Golden traces for the row fold (T455 W1, spec §5.2 with the W0 findings' amendments M1, M2,
 * M3a, M3b). Every row is SYNTHETIC: the shapes copy what the W0 probe recorded per door and
 * origin (04-w0-findings.md §2.1, §3.1), the texts are invented. No real transcript text, path or
 * id ever lands here.
 *
 * Shared by the pure fold test (`tests/companion/row-fold.test.ts`, vitest) and the mod's own
 * engine tests (`resources/companion/tests/row.test.ts`, the test kit).
 */

/** One `session.append`, as the step hands it to the fold: the event's door, origin and agent, the
 * stored row's message and uuid. */
export interface TraceRow {
  door: string
  origin: { kind: string; [k: string]: unknown }
  uuid: string
  agentId?: string
  message: {
    type: 'user' | 'assistant' | 'attachment' | 'system'
    role?: 'user' | 'assistant'
    isMeta?: true
    name?: string
    content: { type: string; [k: string]: unknown }[]
  }
}

let n = 0
/** A fresh synthetic uuid per row, readable in a failing diff. */
const id = (tag: string): string => `${tag}-${String(++n).padStart(3, '0')}`

const text = (t: string) => ({ type: 'text', text: t })

/** A row the person typed at the composer (door `prompt`, origin `composer`). */
export const typed = (t: string, uuid = id('typed')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid,
  message: { type: 'user', role: 'user', content: [text(t)] }
})

/** The stored text of a slash command, as the CLI writes it. */
export const commandBody = (name: string, args = ''): string =>
  `<command-message>${name.replace(/^\//, '')}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`

/** A slash command the person typed (door `command`, origin `composer`, §3.1). */
export const typedCommand = (name: string, args = '', uuid = id('cmd')): TraceRow => ({
  door: 'command',
  origin: { kind: 'composer' },
  uuid,
  message: { type: 'user', role: 'user', content: [text(commandBody(name, args))] }
})

/** A row of an unstamped command (`/clear`, `/exit`, a self-paced `/loop` re-fire). */
export const unclassifiedCommand = (body: string, isMeta = false, uuid = id('ucmd')): TraceRow => ({
  door: 'command',
  origin: { kind: 'unclassified' },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    ...(isMeta ? { isMeta: true as const } : {}),
    content: [text(body)]
  }
})

/** A background task's notification (door `prompt`, NOT `isMeta`: §3.2, 338 of 338). */
export const taskNotification = (uuid = id('task')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'task-notification' },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    content: [text('<task-notification>a background build finished</task-notification>')]
  }
})

/** A cross-session message (door `prompt`, origin `peer`, `isMeta`). */
export const peerMessage = (uuid = id('peer')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'peer' },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    isMeta: true,
    content: [text('Another Claude session sent a message: please rebase')]
  }
})

/** A fixed-interval `/loop` re-fire (door `prompt`, origin `unclassified`, `isMeta`). */
export const loopRefireFixed = (uuid = id('loopf')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'unclassified' },
  uuid,
  message: { type: 'user', role: 'user', isMeta: true, content: [text('check the queue again')] }
})

/** A self-paced `/loop` re-fire (door `command`, origin `unclassified`, not `isMeta`). */
export const loopRefireSelfPaced = (uuid = id('loops')): TraceRow =>
  unclassifiedCommand(commandBody('/loop', 'check the queue again'), false, uuid)

/** A teammate's reply in the lead's session (door `note`, origin `engine`, not `isMeta`). */
export const teammateReply = (uuid = id('team')): TraceRow => ({
  door: 'note',
  origin: { kind: 'engine' },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    content: [
      text(
        'Another Claude session sent a message: <teammate-message teammate_id="helper">the tests pass</teammate-message>'
      )
    ]
  }
})

/** A note the engine adds (a command's expansion, a skill body): `isMeta`. */
export const engineNote = (t = 'expanded command instructions', uuid = id('note')): TraceRow => ({
  door: 'note',
  origin: { kind: 'engine' },
  uuid,
  message: { type: 'user', role: 'user', isMeta: true, content: [text(t)] }
})

/** A plugin's own prompt (P2W2 §7.5): the bare text with `asUser`, framed without it. */
export const pluginPrompt = (t: string, asUser: boolean, uuid = id('plug')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'plugin', name: 'example-plugin', ...(asUser ? { asUser: true } : {}) },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    content: [
      text(
        asUser ? t : `The example-plugin plugin sent a message: ${t}\n\nAddress the message above.`
      )
    ]
  }
})

/** A settings hook's row (door `hook-context`): an attachment, sometimes never written (M1). */
export const hookContext = (name = 'hook_success', uuid = id('hook')): TraceRow => ({
  door: 'hook-context',
  origin: { kind: 'hook', event: 'PostToolUse' },
  uuid,
  message: { type: 'attachment', name, content: [] }
})

/** An attachment the engine adds beside the conversation. */
export const attachment = (name = 'date', uuid = id('att')): TraceRow => ({
  door: 'attachment',
  origin: { kind: 'engine' },
  uuid,
  message: { type: 'attachment', name, content: [] }
})

/** A notice (`stop_hook_summary`, `turn_duration`). */
export const notice = (name = 'turn_duration', uuid = id('notice')): TraceRow => ({
  door: 'notice',
  origin: { kind: 'engine' },
  uuid,
  message: { type: 'system', name, content: [text('notice')] }
})

/** One response row per block, as the engine appends them (§2.1). */
export const responseText = (t: string, agentId?: string, uuid = id('resp')): TraceRow => ({
  door: 'response',
  origin: { kind: 'model', model: 'example-model' },
  uuid,
  ...(agentId !== undefined ? { agentId } : {}),
  message: { type: 'assistant', role: 'assistant', content: [text(t)] }
})

export const responseThinking = (uuid = id('think')): TraceRow => ({
  door: 'response',
  origin: { kind: 'model', model: 'example-model' },
  uuid,
  message: {
    type: 'assistant',
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'planning the step' }]
  }
})

export const responseToolUse = (tools = 1, agentId?: string, uuid = id('tool')): TraceRow => ({
  door: 'response',
  origin: { kind: 'model', model: 'example-model' },
  uuid,
  ...(agentId !== undefined ? { agentId } : {}),
  message: {
    type: 'assistant',
    role: 'assistant',
    content: Array.from({ length: tools }, (_, i) => ({
      type: 'tool_use',
      id: `${uuid}-t${i}`,
      name: 'Bash',
      input: { command: 'ls' }
    }))
  }
})

export const toolResult = (agentId?: string, uuid = id('res')): TraceRow => ({
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Bash' },
  uuid,
  ...(agentId !== undefined ? { agentId } : {}),
  message: {
    type: 'user',
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file-a file-b' }]
  }
})

/** A subagent's opening prompt (origin `coordinator`, WITH `agentId`, §2.5). */
export const subagentPrompt = (agentId: string, uuid = id('subp')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'coordinator' },
  uuid,
  agentId,
  message: { type: 'user', role: 'user', content: [text('list the files in the folder')] }
})

/** A subagent's hand-back to the parent (origin `peer`, `isMeta`, WITHOUT `agentId`, §2.5). */
export const subagentHandback = (uuid = id('hand')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'peer' },
  uuid,
  message: { type: 'user', role: 'user', isMeta: true, content: [text('the subagent is done')] }
})

/** A typed prompt whose stored row carries a paste wrapper (correction D1). */
export const pastedPrompt = (inner: string, uuid = id('paste')): TraceRow => ({
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid,
  message: {
    type: 'user',
    role: 'user',
    content: [text(`<pasted_content id="p7">\n${inner}\n</pasted_content>`)]
  }
})

/**
 * The three rows of a live `/clear` under the new conversation's id, in APPEND order (§2.1: they
 * are appended before the new conversation's SessionStart hook rows and stored after them).
 */
export const clearCommandRows = (): TraceRow[] => [
  unclassifiedCommand(
    '<local-command-caveat>Caveat: the messages below were generated by a local command.</local-command-caveat>',
    true
  ),
  unclassifiedCommand(commandBody('/clear')),
  unclassifiedCommand('<local-command-stdout></local-command-stdout>')
]

/**
 * The probe stream of 03-prototype.md §P.3-§P.4: one turn with one Bash call, 26 appended rows.
 * `at` is the offset (ms) from the session's start when the row is appended. The first row, a
 * `hook_success` before `session.start`, is the one the `-p` run never wrote.
 */
export function probeStream(): { at: number; row: TraceRow }[] {
  const out: { at: number; row: TraceRow }[] = []
  const add = (at: number, row: TraceRow): void => void out.push({ at, row })
  add(0, hookContext('hook_success'))
  add(2_500, typed('Use the Bash tool to list the files, then say you are finished.'))
  for (let i = 0; i < 12; i++) add(2_500 + i, attachment(`context_${i}`))
  add(3_600, responseThinking())
  add(3_610, responseToolUse(1))
  for (let i = 0; i < 3; i++) add(3_620 + i, hookContext('hook_success'))
  add(3_700, toolResult())
  add(3_705, attachment('prompt_snapshot'))
  add(3_706, attachment('total_tokens_reminder'))
  add(8_800, responseText('Finished.'))
  add(8_805, hookContext('hook_success'))
  add(8_806, hookContext('hook_success'))
  add(8_810, notice('stop_hook_summary'))
  return out
}

/** When the probe stream's turn completes, and the row that follows it. */
export const PROBE_TURN_COMPLETE_AT = 8_850
export const probeAfterTurn = (): TraceRow => notice('turn_duration')
