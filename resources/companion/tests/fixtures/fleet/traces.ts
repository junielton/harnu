/**
 * Golden traces for the fleet sensors (T389 P1W5 §11, QA-7): the six event orders of smoke A4
 * (answer, auto-allowed tool, approved permission, denied permission, background subagent, Esc)
 * plus the idle notification. They are rebuilt from the order and the payload shapes the smoke
 * recorded (docs/studies/T389-smoke-evidence.md, A4); no prompt text, tool input or path is in
 * them (SEC-8).
 *
 * One file feeds both sides. The mod test replays `steps` through the hooks and expects `wire`;
 * the host test replays `wire` through the pure map and the adapter and expects `bridge` and
 * `final`. A trace that changes here changes for both.
 */

export type StepHook =
  | 'prompt.submit'
  | 'turn.start'
  | 'tool.check'
  | 'turn.complete'
  | 'classic.PermissionRequest'
  | 'classic.Notification'
  | 'classic.PostToolUse'
  | 'classic.PostToolUseFailure'
  | 'classic.Stop'
  | 'classic.StopFailure'
  | 'classic.SubagentStart'
  | 'classic.SubagentStop'

export interface FleetStep {
  hook: StepHook
  input: Record<string, unknown>
  /** What the engine's own `tool.check` answers (only for `tool.check`). */
  verdict?: 'allow' | 'ask' | 'deny'
}

export interface WireExpect {
  t: string
  d: Record<string, unknown>
  turnId?: string
  agentId?: string
}

export interface BridgeExpect {
  event: string
  matcher?: string
}

export interface FleetTrace {
  name: string
  steps: FleetStep[]
  /** What the mod emits, in order (the `d` payloads are matched as a subset). */
  wire: WireExpect[]
  /** What the host's pure map produces from `wire`, in order. */
  bridge: BridgeExpect[]
  /** The folded task state after the last bridge event. */
  final: 'idle' | 'working' | 'needs-input' | 'completed' | 'failed'
}

const SID = '11111111-1111-4111-8111-111111111111'
const base = { session_id: SID, transcript_path: '/tmp/example.jsonl', cwd: '/tmp/example-project' }
const composer = { kind: 'composer' }

const submit = (origin: Record<string, unknown> = composer): FleetStep => ({
  hook: 'prompt.submit',
  input: { text: 'p', wait: false, origin }
})
const start = (turnId: string): FleetStep => ({
  hook: 'turn.start',
  input: { text: 'p', turnId }
})
const check = (verdict: 'allow' | 'ask', tool: string, id: string): FleetStep => ({
  hook: 'tool.check',
  verdict,
  input: { tool, input: {}, tool_use_id: id }
})
const request = (tool: string): FleetStep => ({
  hook: 'classic.PermissionRequest',
  input: { ...base, hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: {} }
})
const notification = (type: string): FleetStep => ({
  hook: 'classic.Notification',
  input: { ...base, hook_event_name: 'Notification', message: 'm', notification_type: type }
})
const post = (tool: string, id: string): FleetStep => ({
  hook: 'classic.PostToolUse',
  input: {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: {},
    tool_response: {},
    tool_use_id: id
  }
})
const stop = (tasks: unknown[] = []): FleetStep => ({
  hook: 'classic.Stop',
  input: { ...base, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: tasks }
})
const complete = (
  turnId: string,
  reason: 'answer' | 'aborted',
  extra: Record<string, unknown> = {}
): FleetStep => ({
  hook: 'turn.complete',
  input: {
    answer: '',
    durationMs: 3200,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...extra
  }
})

export const FLEET_USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 40,
  model: 'claude-haiku-4-5'
}

export const answer: FleetTrace = {
  name: 'answer',
  steps: [submit(), start('t1'), stop(), complete('t1', 'answer', { usage: FLEET_USAGE })],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    {
      t: 'turn.completed',
      d: {
        reason: 'answer',
        isAborted: false,
        durationMs: 3200,
        backgroundTasks: 0,
        backgroundSubagents: 0,
        usage: {
          model: 'claude-haiku-4-5',
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheCreationTokens: 40
        }
      },
      turnId: 't1'
    }
  ],
  bridge: [{ event: 'UserPromptSubmit' }, { event: 'Stop' }],
  final: 'idle'
}

export const autoAllowed: FleetTrace = {
  name: 'auto-allowed tool',
  steps: [
    submit(),
    start('t1'),
    check('allow', 'Read', 'u1'),
    post('Read', 'u1'),
    stop(),
    complete('t1', 'answer')
  ],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    { t: 'turn.completed', d: { reason: 'answer', isAborted: false }, turnId: 't1' }
  ],
  bridge: [{ event: 'UserPromptSubmit' }, { event: 'Stop' }],
  final: 'idle'
}

export const approved: FleetTrace = {
  name: 'approved permission',
  steps: [
    submit(),
    start('t1'),
    check('ask', 'Bash', 'u1'),
    request('Bash'),
    post('Bash', 'u1'),
    stop(),
    complete('t1', 'answer')
  ],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    {
      t: 'attention.raised',
      d: { kind: 'permission', source: 'check', toolUseId: 'u1', tool: 'Bash' }
    },
    {
      t: 'attention.raised',
      d: { kind: 'permission', source: 'request', toolUseId: 'u1', tool: 'Bash' }
    },
    { t: 'attention.cleared', d: { kind: 'permission', toolUseId: 'u1', cause: 'tool-settled' } },
    { t: 'turn.completed', d: { reason: 'answer', isAborted: false }, turnId: 't1' }
  ],
  bridge: [
    { event: 'UserPromptSubmit' },
    { event: 'PermissionRequest' },
    { event: 'PostToolUse' },
    { event: 'Stop' }
  ],
  final: 'idle'
}

export const denied: FleetTrace = {
  name: 'denied permission',
  steps: [
    submit(),
    start('t1'),
    check('ask', 'Bash', 'u1'),
    request('Bash'),
    notification('permission_prompt'),
    // the user pressed "No": no PostToolUse and no classic.Stop (smoke A4)
    complete('t1', 'answer')
  ],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    { t: 'attention.raised', d: { kind: 'permission', source: 'check', toolUseId: 'u1' } },
    { t: 'attention.raised', d: { kind: 'permission', source: 'request', toolUseId: 'u1' } },
    { t: 'attention.raised', d: { kind: 'permission', source: 'notification' } },
    {
      t: 'attention.cleared',
      d: { kind: 'permission', toolUseId: 'u1', cause: 'turn-completed' }
    },
    {
      t: 'turn.completed',
      d: { reason: 'answer', isAborted: false, backgroundTasks: 0, backgroundSubagents: 0 },
      turnId: 't1'
    }
  ],
  bridge: [
    { event: 'UserPromptSubmit' },
    { event: 'PermissionRequest' },
    { event: 'Notification', matcher: 'permission_prompt' },
    { event: 'Stop' }
  ],
  final: 'idle'
}

const subTask = {
  id: 'a1',
  type: 'subagent',
  status: 'running',
  description: 'd',
  agent_type: 'general-purpose'
}

export const backgroundSubagent: FleetTrace = {
  name: 'background subagent',
  steps: [
    submit(),
    start('t1'),
    check('allow', 'Agent', 'u1'),
    post('Agent', 'u1'),
    {
      hook: 'classic.SubagentStart',
      input: {
        ...base,
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      }
    },
    stop([subTask]),
    complete('t1', 'answer'),
    // the subagent finishes: its own turn.complete, then its stop
    {
      hook: 'turn.complete',
      input: {
        answer: '',
        durationMs: 900,
        isAborted: false,
        turnId: 't1',
        agentId: 'a1',
        reason: 'answer',
        usage: FLEET_USAGE
      }
    },
    {
      hook: 'classic.SubagentStop',
      input: {
        ...base,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: 'a1',
        agent_transcript_path: '/tmp/a1.jsonl',
        agent_type: 'general-purpose'
      }
    },
    // the completion notice starts the next main turn
    submit({ kind: 'task-notification' }),
    start('t2'),
    stop(),
    complete('t2', 'answer'),
    // the stray stop that follows most turns (smoke A4): dropped
    {
      hook: 'classic.SubagentStop',
      input: {
        ...base,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: '',
        agent_transcript_path: '',
        agent_type: ''
      }
    }
  ],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    { t: 'subagent.started', d: { agentType: 'general-purpose', agentId: 'a1' } },
    {
      t: 'turn.completed',
      d: { reason: 'answer', backgroundTasks: 1, backgroundSubagents: 1 },
      turnId: 't1'
    },
    { t: 'turn.completed', d: { reason: 'answer' }, agentId: 'a1' },
    { t: 'subagent.stopped', d: { agentType: 'general-purpose', agentId: 'a1' } },
    { t: 'turn.started', d: { origin: 'unknown' }, turnId: 't2' },
    {
      t: 'turn.completed',
      d: { reason: 'answer', backgroundTasks: 0, backgroundSubagents: 0 },
      turnId: 't2'
    }
  ],
  bridge: [
    { event: 'UserPromptSubmit' },
    // the held completion and the subagent's own completion produce nothing
    { event: 'Stop' }, // the last subagent stop releases the hold
    { event: 'UserPromptSubmit' },
    { event: 'Stop' }
  ],
  final: 'idle'
}

export const esc: FleetTrace = {
  name: 'Esc mid-turn',
  steps: [submit(), start('t1'), check('allow', 'Bash', 'u1'), complete('t1', 'aborted')],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    { t: 'turn.completed', d: { reason: 'aborted', isAborted: true }, turnId: 't1' }
  ],
  bridge: [{ event: 'UserPromptSubmit' }, { event: 'Stop' }],
  final: 'idle'
}

export const idle: FleetTrace = {
  name: 'idle notification',
  steps: [submit(), start('t1'), stop(), complete('t1', 'answer'), notification('idle_prompt')],
  wire: [
    { t: 'turn.started', d: { origin: 'human' }, turnId: 't1' },
    { t: 'turn.completed', d: { reason: 'answer', isAborted: false }, turnId: 't1' },
    { t: 'attention.raised', d: { kind: 'idle', source: 'notification' } }
  ],
  bridge: [
    { event: 'UserPromptSubmit' },
    { event: 'Stop' },
    { event: 'Notification', matcher: 'idle_prompt' }
  ],
  final: 'idle'
}

export const FLEET_TRACES: readonly FleetTrace[] = [
  answer,
  autoAllowed,
  approved,
  denied,
  backgroundSubagent,
  esc,
  idle
]
