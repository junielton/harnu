/**
 * One scripted headless agent turn for the mission behavior eval (T358 S5).
 *
 * Runs `claude -p` pointed at the isolated Harnu instance's `harnu.mcp.json` — the
 * same port + bearer-token document Harnu hands a session it spawns — so every
 * `mission_*` call crosses the real HTTP transport and auth. By default the agent
 * gets NO built-in tools (`--tools ""`): it cannot read or edit a mission file,
 * only call verbs, so whatever lands on disk got there through the server. A
 * phase may grant named built-ins (`tools: ["Read", "Write"]`) — an owner turn
 * reads a shipped skill, and end-before-dispatch writes its dispatch stand-in
 * files — and the mission files stay the server's alone either way.
 *
 * The stream-json output is kept as run evidence (which verbs were called, what
 * came back) but is never graded: grading reads `.harnu/missions-v4/*.md` and the
 * plain files a recorded turn leaves (`turnRecord`).
 *
 * Roles (Missions v4 S-33): `scripted` (the exact calls are listed), `owner` (a skill
 * is read, the agent decides, framed as an orchestration), `session` (the same, framed
 * as an ordinary session, so a proactive-mission rule is not announced by the frame)
 * and `cold` (a fresh session with NO tool and NO Harnu server: it answers from the
 * text in its prompt alone).
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cleanEnv } from './harnu.mjs'
import { escalate } from './procs.mjs'

/**
 * Turn cap for one scripted run. The longest scenario prompt spells out six
 * calls (one turn each, plus the final reply); 12 leaves margin for a refused
 * call without letting a confused agent loop on the operator's bill.
 */
export const MAX_TURNS = 12

/**
 * Turn cap for an `owner` turn (Mission v2 S4): the agent reads a whole skill,
 * then decides its own calls, so it needs more room than a scripted list —
 * still bounded, so a confused owner cannot loop on the operator's bill.
 */
export const OWNER_MAX_TURNS = 18

/** `claude -p` processes currently running, so an interrupted run can kill them. */
const running = new Set()

/** Kill every scripted agent still running (SIGTERM, then SIGKILL after the grace). */
export function killAgents() {
  const targets = [...running].map((child) => ({
    label: `claude -p pid ${child.pid}`,
    alive: () => child.exitCode === null && child.signalCode === null,
    send: (signal) => child.kill(signal)
  }))
  return escalate(targets)
}

/**
 * Every verb an eval agent may call: the catalog's `mission_*` verbs less the ones the v4 fate table
 * removes (`mission_link_child`, `mission_set_end`, `mission_verify_step`, `mission_add_check`,
 * `mission_import_legacy`, `mission_transfer_owner`). Anything else is refused by `claude` itself.
 * `tests/mission-v4-eval-scenarios.test.ts` pins this list to the catalog, so a verb added or removed
 * there fails the pin until it is listed here.
 */
export const MISSION_VERBS = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_step',
  'mission_update_step',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_request_close',
  'mission_add_milestone',
  'mission_add_ac',
  'mission_link',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_attach'
]

/**
 * The fixed frame every scripted prompt runs in. Deliberately tiny: a headless
 * run costs real API time, and the scenario's own lines carry the calls.
 */
function scriptedFrame(sessionId, body) {
  return [
    'You are a scripted test agent driving the Harnu MCP server (tools named mcp__harnu__*).',
    `Your own Claude session UUID is ${sessionId}.`,
    'Make exactly the tool calls listed below, with exactly the arguments given, in order.',
    'Do not call any other tool. Do not retry a call that is refused. When done, reply DONE.',
    '',
    body
  ].join('\n')
}

/**
 * The frame of an `owner` turn (Mission v2 S4): a BEHAVIOR test of a bundled
 * skill. Unlike the scripted frame it lists no calls — the scenario body names
 * the skill file and the situation, and the agent decides what to call from the
 * skill alone. The frame only states what this sandbox lacks (every verb that is
 * not `mission_*`, and `AskUserQuestion`, which `claude -p` does not have) and
 * how a question to the operator is expressed instead, so a missing tool is
 * never mistaken for a rule of the skill.
 */
export function ownerFrame(sessionId, folder, body, tools = []) {
  // A phase that grants `Bash` is testing whether the agent reaches for `gh` or the
  // fleet to learn dispatch state, so `gh` must be reachable (it fails: the sandbox
  // repo has no remote). Otherwise "no gh call" would hold only because the frame
  // said `gh` does not exist.
  const bash = tools.includes('Bash')
  const absent = bash
    ? 'board, worktree, session, notify, memory'
    : 'board, worktree, session, notify, memory, gh'
  return [
    'You are the owner session of a Harnu orchestration, running headless for a behavior test.',
    `Your own Claude session UUID is ${sessionId} — pass it wherever a verb asks for your session id.`,
    `The repo is your current directory; pass folder="${folder}" to every mcp__harnu__ verb.`,
    'Read the skill file named below first, then act exactly as it says for the situation described. Decide your calls yourself.',
    'This sandbox has only the mcp__harnu__mission_* verbs and the built-in tools you were given. Every other verb the skill mentions (' +
      absent +
      ') does not exist here: skip what needs it, never ask for it.' +
      (bash ? ' Bash exists, but this repo has no GitHub remote.' : ''),
    'AskUserQuestion does not exist here either. When the skill tells you to ask the operator something, put the question in your final reply and end your turn — the answer arrives in a later turn.',
    'This turn has no memory of earlier turns: the mission (mission_get) is the state.',
    'End your turn with your message to the operator.',
    '',
    body
  ].join('\n')
}

/**
 * The frame of a `session` turn (Missions v4 S-33): the same behavior test as an `owner` turn, framed
 * as an ordinary Claude Code session the operator is working with, NOT as an orchestration. The
 * proactive-mission scenarios use it: if the frame said "orchestration", a model would create a mission
 * because the frame told it to, and the rule the scenario tests (create one at the first sign of
 * multi-step work, and none for a one-line question) would prove nothing. It names the skill file to
 * read and states only what the sandbox lacks. It never names the verb a scenario grades.
 */
export function sessionFrame(sessionId, folder, body, tools = []) {
  const bash = tools.includes('Bash')
  return [
    'You are a Claude Code session working with an operator in the repo that is your current directory, running headless for a behavior test.',
    `Your own Claude session UUID is ${sessionId} — pass it wherever a verb asks for your session id.`,
    `Harnu is connected: its verbs are the tools named mcp__harnu__*; pass folder="${folder}" to every one. The skill file named below is one of your skills: read it first, then handle the operator's message as you normally would.`,
    'Only the mcp__harnu__mission_* verbs and the built-in tools you were given exist here' +
      (bash ? ' (Bash exists, but this repo has no GitHub remote).' : '.') +
      ' Any other Harnu verb a skill mentions does not exist: skip what needs it, never ask for it.',
    'AskUserQuestion does not exist here. When you need to ask the operator something, put the question in your final reply and end your turn.',
    'This turn has no memory of earlier turns.',
    'End your turn with your reply to the operator.',
    '',
    body
  ].join('\n')
}

/**
 * The frame of a `cold` turn (Missions v4 S-33, AC-78): a fresh session that starts from a mission
 * summary alone. It has no tool and no Harnu server (see {@link buildAgentArgs}), so what it can answer
 * is exactly what the summary in its prompt says.
 */
export function coldFrame(body) {
  return [
    'You are a Claude Code session that has just started, with no memory of any earlier work, running headless for a behavior test.',
    'You have no tools. The mission summary below is all you know: answer from it alone and invent nothing.',
    '',
    body
  ].join('\n')
}

/**
 * Whether an owner's final reply puts a question to the operator: a `?`, or the
 * word "confirm". `claude -p` has no `AskUserQuestion`, so a headless owner asks
 * in its reply and ends the turn; the harness records this as `asked=<b>`.
 */
export function replyAsks(reply) {
  return /\?/.test(reply) || /\bconfirm\b/i.test(reply)
}

/**
 * The turn cap per role: a scripted list is short, an `owner` or `session` turn reads a skill and then
 * decides, and a `cold` turn only answers.
 */
function maxTurnsOf(role) {
  if (role === 'cold') return 3
  return role === 'owner' || role === 'session' ? OWNER_MAX_TURNS : MAX_TURNS
}

/**
 * The `claude` argument list of one turn. Exported so the unit suite can pin what each role is given:
 * a `cold` turn gets NO MCP server (`--strict-mcp-config` with no `--mcp-config` loads none), no verb
 * allowance and no built-in tool, so it cannot look anything up.
 */
export function buildAgentArgs({
  sessionId,
  folder,
  prompt,
  mcpConfigPath,
  model,
  tools = [],
  role = 'scripted'
}) {
  const cold = role === 'cold'
  const body =
    role === 'owner'
      ? ownerFrame(sessionId, folder, prompt, tools)
      : role === 'session'
        ? sessionFrame(sessionId, folder, prompt, tools)
        : cold
          ? coldFrame(prompt)
          : scriptedFrame(sessionId, prompt)
  return [
    '-p',
    '--model',
    model,
    '--session-id',
    sessionId,
    '--no-session-persistence',
    '--max-turns',
    String(maxTurnsOf(role)),
    ...(cold ? [] : ['--mcp-config', mcpConfigPath]),
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--tools',
    cold ? '' : tools.join(','),
    ...(cold
      ? []
      : ['--allowedTools', [...tools, ...MISSION_VERBS.map((v) => `mcp__harnu__${v}`)].join(',')]),
    '--output-format',
    'stream-json',
    '--verbose',
    body
  ]
}

/**
 * What a recorded turn leaves in the sandbox (`.eval/turn-<tag>.txt`): the tools it called in order,
 * whether its reply asks the operator something, and the reply itself. A grader reads it as a plain
 * file, so a scenario with no mission (the one-line question) is still graded on what the turn did.
 */
export function turnRecord(r) {
  return `tools=${r.toolCalls.join(',')}\nasked=${replyAsks(r.result)}\n---\n${r.result}\n`
}

/**
 * Run one agent turn to completion.
 *
 * @returns {Promise<{ code: number, toolCalls: string[], isError: boolean, result: string, costUsd: number, ms: number }>}
 */
export function runAgent({
  sessionId,
  folder,
  prompt,
  mcpConfigPath,
  model,
  logFile,
  timeoutMs,
  tools = [],
  role = 'scripted'
}) {
  const args = buildAgentArgs({ sessionId, folder, prompt, mcpConfigPath, model, tools, role })
  const started = Date.now()
  return new Promise((resolve) => {
    // ENABLE_TOOL_SEARCH=false loads the verbs up front instead of behind a
    // ToolSearch round-trip — one fewer turn per run.
    const child = spawn('claude', args, {
      cwd: folder,
      env: cleanEnv({ ENABLE_TOOL_SEARCH: 'false' }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    running.add(child)
    const out = createWriteStream(logFile)
    const toolCalls = []
    let final = null
    let buf = ''
    child.stdout.on('data', (chunk) => {
      out.write(chunk)
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') toolCalls.push(c.name.replace(/^mcp__harnu__/, ''))
          }
        }
        if (ev.type === 'result') final = ev
      }
    })
    child.stderr.on('data', (chunk) => out.write(chunk))
    // The deadline escalates: SIGTERM, then SIGKILL if it is still alive 5s later.
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5_000).unref()
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      running.delete(child)
      out.end()
      resolve({
        code: code ?? -1,
        toolCalls,
        isError: final ? final.is_error === true : true,
        result: final?.result ?? '(no result event)',
        costUsd: final?.total_cost_usd ?? 0,
        ms: Date.now() - started
      })
    })
  })
}
