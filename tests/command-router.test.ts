import { describe, it, expect, vi } from 'vitest'

/**
 * The renderer-side command router (`makeCommandRouter`) is the single place
 * that turns a validated MCP op + payload into a concrete store mutation. It is
 * a PURE factory (ADR-0001 pure-core / thin-shell): every side-effecting store
 * action is injected, so it unit-tests with no Pinia.
 *
 * Contract pinned here:
 *   - `session.create` on a KNOWN folder rides the agent-create path (T16,
 *     `makeAgentSession`) — minting a fresh non-deduped synthetic + correlation
 *     token — and returns `{ syntheticId, correlationId }`.
 *   - `session.create` on an UNKNOWN folder returns `{ error: 'FOLDER_NOT_FOUND' }`
 *     and never mints/inserts anything.
 *   - `pane.split` is HEADLESS: it appends a helper to the TARGET worktree's
 *     stack directly (`addShellHelper` / `addResumeHelper`) — never selecting it
 *     first — even when that worktree is not the currently-selected one.
 *   - `pane.split` with `kind: 'claude'` requires a `sessionId` (else BAD_ARGS).
 *   - malformed payloads return `{ error: 'BAD_ARGS' }`.
 *   - an action that THROWS is caught and reported as `{ ok: false, error }`.
 */

import {
  makeCommandRouter,
  isCommandOp,
  COMMAND_OPS,
  type CommandRouterActions
} from '../src/renderer/src/stores/command-router'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'

/** Deterministic, injectable id generator: 'u1', 'u2', 'u3', … */
const counter = (): (() => string) => {
  let n = 0
  return () => `u${++n}`
}

/**
 * Build a router over fully-spied fake store actions. `knownFolders` decides
 * which paths `folderExists` accepts; everything else is a vi.fn() the test can
 * assert against. The fake helpers return stable pane ids so `{ paneId }` is
 * pinnable. Mirrors `spawn-spec.test.ts`'s factory-of-fakes pattern.
 */
function makeRouter(knownFolders: string[] = [], over: Partial<CommandRouterActions> = {}) {
  const known = new Set(knownFolders)
  const inserted: AgentSession[] = []
  const actions: CommandRouterActions = {
    folderExists: vi.fn((p: string) => known.has(p)),
    insertAgentSession: vi.fn((s: AgentSession) => {
      inserted.push(s)
    }),
    addShellHelper: vi.fn((_wt: string, _cwd: string) => 'pane-shell'),
    addResumeHelper: vi.fn((_wt: string, _s: string, _cwd: string) => 'pane-claude'),
    addMarkdownHelper: vi.fn((_wt: string, _fp: string, _cwd: string) => 'pane-markdown'),
    addCanvasHelper: vi.fn((_wt: string, _fp: string, _cwd: string) => 'pane-canvas'),
    closeHelperByPath: vi.fn((_wt: string, _path: string) => 'pane-closed-by-path'),
    closeHelperById: vi.fn((_wt: string, _id: string) => true),
    notifyAgent: vi.fn(() => 'notif-1'),
    speechContext: vi.fn(() => ({
      enabled: true,
      muted: false,
      windowFocused: false,
      selectedId: null as string | null
    })),
    speakUtterance: vi.fn(),
    wakeSession: vi.fn(() => true),
    genId: counter(),
    ...over
  }
  return { dispatch: makeCommandRouter(actions), actions, inserted }
}

describe('makeCommandRouter — session.create', () => {
  it('known folder → agent-create path (T16), returns { syntheticId, correlationId }', () => {
    const { dispatch, actions, inserted } = makeRouter(['/repo/app'])

    const res = dispatch('session.create', { folder: '/repo/app' })

    // Mints via makeAgentSession with the injected counter → u1 / u2.
    expect(res).toEqual({ syntheticId: 'synthetic-u1', correlationId: 'agent-corr-u2' })
    expect(actions.folderExists).toHaveBeenCalledWith('/repo/app')
    // The fresh synthetic is handed to the store for insertion.
    expect(actions.insertAgentSession).toHaveBeenCalledTimes(1)
    expect(inserted).toEqual([
      { syntheticId: 'synthetic-u1', correlationId: 'agent-corr-u2', folderPath: '/repo/app' }
    ])
  })

  it('forwards an optional prePrompt to the store (no bootOverride)', () => {
    const { dispatch, actions } = makeRouter(['/repo/app'])
    dispatch('session.create', { folder: '/repo/app', prePrompt: 'ship it' })
    expect(actions.insertAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ folderPath: '/repo/app' }),
      'ship it',
      undefined
    )
  })

  it('forwards the allowlisted bootOverride model/effort (T33-A′), dropping other keys', () => {
    const { dispatch, actions } = makeRouter(['/repo/app'])
    dispatch('session.create', {
      folder: '/repo/app',
      bootOverride: { model: 'haiku', effort: 'low', dangerous: true }
    })
    expect(actions.insertAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ folderPath: '/repo/app' }),
      undefined,
      { model: 'haiku', effort: 'low' }
    )
  })

  it('unknown folder → { error: FOLDER_NOT_FOUND }, nothing minted', () => {
    const { dispatch, actions } = makeRouter([]) // no known folders

    const res = dispatch('session.create', { folder: '/nope' })

    expect(res).toEqual({ error: 'FOLDER_NOT_FOUND' })
    expect(actions.insertAgentSession).not.toHaveBeenCalled()
  })

  it('missing / non-string folder → { error: BAD_ARGS } (before any folder lookup)', () => {
    const { dispatch, actions } = makeRouter(['/repo/app'])
    expect(dispatch('session.create', {})).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.create', { folder: 123 })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.create', { folder: '' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.create', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.folderExists).not.toHaveBeenCalled()
  })
})

describe('makeCommandRouter — pane.split (headless)', () => {
  it('kind:shell → addShellHelper on the TARGET worktree even when not selected, returns { paneId }', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.split', {
      target: 'split',
      worktreePath: '/repo/wt-b',
      cwd: '/repo/wt-b',
      kind: 'shell'
    })

    expect(res).toEqual({ paneId: 'pane-shell' })
    // Headless: appends to the target worktree's stack directly — never selects it.
    expect(actions.addShellHelper).toHaveBeenCalledWith('/repo/wt-b', '/repo/wt-b')
    expect(actions.addResumeHelper).not.toHaveBeenCalled()
  })

  it('cwd defaults to worktreePath when omitted', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('pane.split', { target: 'split', worktreePath: '/repo/wt-c', kind: 'shell' })
    expect(actions.addShellHelper).toHaveBeenCalledWith('/repo/wt-c', '/repo/wt-c')
  })

  it('kind:claude with sessionId → addResumeHelper on the target, returns { paneId }', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.split', {
      target: 'split',
      worktreePath: '/repo/wt-b',
      cwd: '/repo/wt-b',
      kind: 'claude',
      sessionId: 'sess-1'
    })

    expect(res).toEqual({ paneId: 'pane-claude' })
    expect(actions.addResumeHelper).toHaveBeenCalledWith('/repo/wt-b', 'sess-1', '/repo/wt-b')
    expect(actions.addShellHelper).not.toHaveBeenCalled()
  })

  it('kind:claude WITHOUT a sessionId → { error: BAD_ARGS }, no helper appended', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.split', {
      target: 'split',
      worktreePath: '/repo/wt-b',
      cwd: '/repo/wt-b',
      kind: 'claude'
    })

    expect(res).toEqual({ error: 'BAD_ARGS' })
    expect(actions.addResumeHelper).not.toHaveBeenCalled()
  })

  it('garbage args (missing worktreePath / unknown kind / non-object) → { error: BAD_ARGS }', () => {
    const { dispatch } = makeRouter()
    expect(dispatch('pane.split', { target: 'split', kind: 'shell' })).toEqual({
      error: 'BAD_ARGS'
    })
    expect(dispatch('pane.split', { target: 'split', worktreePath: '/x', kind: 'wat' })).toEqual({
      error: 'BAD_ARGS'
    })
    expect(dispatch('pane.split', null)).toEqual({ error: 'BAD_ARGS' })
  })
})

describe('makeCommandRouter — pane.openMarkdown (T74 open_file, headless)', () => {
  it('appends a markdown viewer on the TARGET worktree, returns { paneId }', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.openMarkdown', {
      worktreePath: '/repo/wt-b',
      filePath: '/repo/wt-b/report.md',
      cwd: '/repo/wt-b'
    })

    expect(res).toEqual({ paneId: 'pane-markdown' })
    // Headless / background: appends directly, never selecting the worktree (T78).
    expect(actions.addMarkdownHelper).toHaveBeenCalledWith(
      '/repo/wt-b',
      '/repo/wt-b/report.md',
      '/repo/wt-b'
    )
  })

  it('cwd defaults to worktreePath when omitted', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('pane.openMarkdown', { worktreePath: '/repo/wt-c', filePath: '/repo/wt-c/hot.md' })
    expect(actions.addMarkdownHelper).toHaveBeenCalledWith(
      '/repo/wt-c',
      '/repo/wt-c/hot.md',
      '/repo/wt-c'
    )
  })

  it('missing worktreePath or filePath → { error: BAD_ARGS }, no helper appended', () => {
    const { dispatch, actions } = makeRouter()
    expect(dispatch('pane.openMarkdown', { filePath: '/a/x.md' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('pane.openMarkdown', { worktreePath: '/a' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('pane.openMarkdown', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.addMarkdownHelper).not.toHaveBeenCalled()
    expect(actions.addCanvasHelper).not.toHaveBeenCalled()
  })
})

/**
 * T218 U4 — `open_file` picks WHICH viewer by the file's suffix. This is the
 * routing decision the unit exists for, and the two directions of AC U4-2 are
 * asserted against each other here: a `*.harnucanvas.json` reaches
 * `addCanvasHelper`, and every other file — a plain `.json` very much included —
 * keeps reaching `addMarkdownHelper`.
 */
describe('makeCommandRouter — pane.openMarkdown routes canvas files (T218 U4)', () => {
  it('U4-1 — a *.harnucanvas.json opens the CANVAS pane, headlessly', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.openMarkdown', {
      worktreePath: '/repo/wt-b',
      filePath: '/repo/wt-b/.harnu/out/canvas/board.harnucanvas.json',
      cwd: '/repo/wt-b'
    })

    expect(res).toEqual({ paneId: 'pane-canvas' })
    expect(actions.addCanvasHelper).toHaveBeenCalledWith(
      '/repo/wt-b',
      '/repo/wt-b/.harnu/out/canvas/board.harnucanvas.json',
      '/repo/wt-b'
    )
    // Same background contract as the markdown arm: the worktree is never
    // selected first, so an agent's open cannot steal the operator's focus (T78).
    expect(actions.addMarkdownHelper).not.toHaveBeenCalled()
  })

  it('U4-2 — a plain .json still opens the TEXT pane (the extname trap)', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('pane.openMarkdown', {
      worktreePath: '/repo/wt-b',
      filePath: '/repo/wt-b/package.json'
    })

    // `extname` would report `.json` for the canvas file above too — routing on
    // it would have swallowed this one into the canvas pane.
    expect(res).toEqual({ paneId: 'pane-markdown' })
    expect(actions.addMarkdownHelper).toHaveBeenCalledWith(
      '/repo/wt-b',
      '/repo/wt-b/package.json',
      '/repo/wt-b'
    )
    expect(actions.addCanvasHelper).not.toHaveBeenCalled()
  })

  it('U4-3 — .md and every other ordinary file keep reaching the text pane', () => {
    const { dispatch, actions } = makeRouter()
    for (const f of ['/repo/wt-b/report.md', '/repo/wt-b/app.ts', '/repo/wt-b/shot.png']) {
      dispatch('pane.openMarkdown', { worktreePath: '/repo/wt-b', filePath: f })
    }
    expect(actions.addMarkdownHelper).toHaveBeenCalledTimes(3)
    expect(actions.addCanvasHelper).not.toHaveBeenCalled()
  })

  it('the canvas match is case-insensitive and never a mere substring', () => {
    const { dispatch, actions } = makeRouter()

    dispatch('pane.openMarkdown', {
      worktreePath: '/repo/wt-b',
      filePath: '/repo/wt-b/Board.CapyCanvas.JSON'
    })
    expect(actions.addCanvasHelper).toHaveBeenCalledTimes(1)

    // Near-misses stay on the text arm: no separating dot, a trailing suffix,
    // and a different extension.
    for (const f of [
      '/repo/wt-b/capycanvas.json',
      '/repo/wt-b/board.harnucanvas.json.bak',
      '/repo/wt-b/board.capycanvas.yaml'
    ]) {
      dispatch('pane.openMarkdown', { worktreePath: '/repo/wt-b', filePath: f })
    }
    expect(actions.addCanvasHelper).toHaveBeenCalledTimes(1)
    expect(actions.addMarkdownHelper).toHaveBeenCalledTimes(3)
  })

  it('cwd defaults to worktreePath on the canvas arm too', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('pane.openMarkdown', {
      worktreePath: '/repo/wt-c',
      filePath: '/repo/wt-c/board.harnucanvas.json'
    })
    expect(actions.addCanvasHelper).toHaveBeenCalledWith(
      '/repo/wt-c',
      '/repo/wt-c/board.harnucanvas.json',
      '/repo/wt-c'
    )
  })
})

describe('makeCommandRouter — pane.closeFile (T171 close_file, headless)', () => {
  it('closes a pane by (worktreePath, path) and returns its paneId', () => {
    const { dispatch, actions } = makeRouter()
    const result = dispatch('pane.closeFile', { worktreePath: '/wt', path: '/wt/a.md' })
    expect(result).toEqual({ paneId: 'pane-closed-by-path' })
    expect(actions.closeHelperByPath).toHaveBeenCalledWith('/wt', '/wt/a.md')
  })

  it('returns { closed: false } when nothing matched', () => {
    const { dispatch } = makeRouter([], { closeHelperByPath: vi.fn(() => undefined) })
    const result = dispatch('pane.closeFile', { worktreePath: '/wt', path: '/wt/nope.md' })
    expect(result).toEqual({ closed: false })
  })

  it('rejects malformed payloads with BAD_ARGS', () => {
    const { dispatch } = makeRouter()
    expect(dispatch('pane.closeFile', { worktreePath: '/wt' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('pane.closeFile', {})).toEqual({ error: 'BAD_ARGS' })
  })
})

describe('makeCommandRouter — pane.closePane (T171 close_pane, headless)', () => {
  it('closes a pane by (worktreePath, paneId) and returns { closed: true }', () => {
    const { dispatch, actions } = makeRouter()
    const result = dispatch('pane.closePane', { worktreePath: '/wt', paneId: 'h-1' })
    expect(result).toEqual({ closed: true })
    expect(actions.closeHelperById).toHaveBeenCalledWith('/wt', 'h-1')
  })

  it('returns { closed: false } when the pane id does not exist', () => {
    const { dispatch } = makeRouter([], { closeHelperById: vi.fn(() => false) })
    const result = dispatch('pane.closePane', { worktreePath: '/wt', paneId: 'h-gone' })
    expect(result).toEqual({ closed: false })
  })

  it('rejects malformed payloads with BAD_ARGS', () => {
    const { dispatch } = makeRouter()
    expect(dispatch('pane.closePane', { worktreePath: '/wt' })).toEqual({ error: 'BAD_ARGS' })
  })
})

describe('makeCommandRouter — notify.push (T116 notify, "Session says")', () => {
  it('appends an agent notice, defaulting kind to info, returns { id }', () => {
    const { dispatch, actions } = makeRouter()

    const res = dispatch('notify.push', { folderPath: '/repo/app', title: 'Migration finished' })

    expect(res).toEqual({ id: 'notif-1' })
    expect(actions.notifyAgent).toHaveBeenCalledWith({
      folderPath: '/repo/app',
      title: 'Migration finished',
      kind: 'info'
    })
  })

  it('forwards the optional description/kind/sessionId when present', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('notify.push', {
      folderPath: '/repo/app',
      title: 'Migration finished',
      description: '12 of 12 files, no conflicts',
      kind: 'success',
      sessionId: 'sess-1'
    })
    expect(actions.notifyAgent).toHaveBeenCalledWith({
      folderPath: '/repo/app',
      title: 'Migration finished',
      description: '12 of 12 files, no conflicts',
      kind: 'success',
      sessionId: 'sess-1'
    })
  })

  it('an unrecognized kind falls back to info (cosmetic default, not a rejection)', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('notify.push', { folderPath: '/repo/app', title: 'hi', kind: 'urgent' })
    expect(actions.notifyAgent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' }))
  })

  it('missing folderPath or title → { error: BAD_ARGS }, nothing recorded', () => {
    const { dispatch, actions } = makeRouter()
    expect(dispatch('notify.push', { title: 'hi' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('notify.push', { folderPath: '/repo/app' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('notify.push', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.notifyAgent).not.toHaveBeenCalled()
  })

  it('a VALID request before the action is wired → { ok: false, error } (staged rollout)', () => {
    const { dispatch } = makeRouter([], { notifyAgent: undefined })
    const res = dispatch('notify.push', { folderPath: '/repo/app', title: 'hi' })
    expect(res).toEqual({ ok: false, error: 'notifyAgent not wired' })
  })
})

describe('makeCommandRouter — speech.say (T238 speak)', () => {
  /** A router whose voice/attention state is exactly `ctx`. */
  const withContext = (ctx: {
    enabled?: boolean
    muted?: boolean
    windowFocused?: boolean
    selectedId?: string | null
  }) =>
    makeRouter([], {
      speechContext: vi.fn(() => ({
        enabled: ctx.enabled ?? true,
        muted: ctx.muted ?? false,
        windowFocused: ctx.windowFocused ?? false,
        selectedId: ctx.selectedId ?? null
      }))
    })

  it('hands a gated utterance to the engine and reports spoken:true', () => {
    const { dispatch, actions } = makeRouter()
    const res = dispatch('speech.say', {
      folderPath: '/repo/app',
      text: 'The migration finished, zero conflicts.',
      sessionId: 'sess-1'
    })
    expect(res).toEqual({ spoken: true })
    expect(actions.speakUtterance).toHaveBeenCalledWith({
      text: 'The migration finished, zero conflicts.',
      sessionId: 'sess-1',
      focus: { windowFocused: false, isSelected: false }
    })
  })

  it('AC-2: speaking NEVER appends an Activity row', () => {
    const { dispatch, actions } = makeRouter()
    dispatch('speech.say', { folderPath: '/repo/app', text: 'done', sessionId: 'sess-1' })
    expect(actions.notifyAgent).not.toHaveBeenCalled()
  })

  it('AC-5: suppressed when its OWN session is the one in front of the operator', () => {
    const { dispatch, actions } = withContext({ windowFocused: true, selectedId: 'sess-1' })
    const res = dispatch('speech.say', {
      folderPath: '/repo/app',
      text: 'you can already read this',
      sessionId: 'sess-1'
    })
    // A success, not an error: nothing went wrong, and an agent that read a
    // refusal here would retry a line the operator can already see.
    expect(res).toEqual({ spoken: false, reason: 'focused' })
    expect(actions.speakUtterance).not.toHaveBeenCalled()
  })

  it('AC-5: a DIFFERENT session being selected does not suppress it', () => {
    const { dispatch, actions } = withContext({ windowFocused: true, selectedId: 'sess-2' })
    const res = dispatch('speech.say', {
      folderPath: '/repo/app',
      text: 'over here',
      sessionId: 'sess-1'
    })
    expect(res).toEqual({ spoken: true })
    expect(actions.speakUtterance).toHaveBeenCalledWith(
      expect.objectContaining({ focus: { windowFocused: true, isSelected: false } })
    )
  })

  it('AC-5: its session selected but the WINDOW unfocused still speaks', () => {
    const { dispatch } = withContext({ windowFocused: false, selectedId: 'sess-1' })
    expect(
      dispatch('speech.say', { folderPath: '/repo/app', text: 'behind you', sessionId: 'sess-1' })
    ).toEqual({ spoken: true })
  })

  it('an anonymous caller can never be suppressed by focus — it matches no selection', () => {
    const { dispatch } = withContext({ windowFocused: true, selectedId: 'sess-1' })
    expect(dispatch('speech.say', { folderPath: '/repo/app', text: 'who am i' })).toEqual({
      spoken: true
    })
  })

  it('the engine being off or muted is reported by name, not as a failure', () => {
    expect(
      withContext({ enabled: false }).dispatch('speech.say', {
        folderPath: '/repo/app',
        text: 'hi'
      })
    ).toEqual({ spoken: false, reason: 'engine-off' })
    expect(
      withContext({ muted: true }).dispatch('speech.say', { folderPath: '/repo/app', text: 'hi' })
    ).toEqual({ spoken: false, reason: 'muted' })
  })

  it('missing folderPath or text → { error: BAD_ARGS }, nothing spoken', () => {
    const { dispatch, actions } = makeRouter()
    expect(dispatch('speech.say', { text: 'hi' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('speech.say', { folderPath: '/repo/app' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('speech.say', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.speakUtterance).not.toHaveBeenCalled()
  })

  it('a VALID request before the action is wired → { ok: false, error } (staged rollout)', () => {
    const { dispatch } = makeRouter([], { speakUtterance: undefined })
    expect(dispatch('speech.say', { folderPath: '/repo/app', text: 'hi' })).toEqual({
      ok: false,
      error: 'speakUtterance not wired'
    })
  })

  it('speech.say is a recognized command op', () => {
    expect(COMMAND_OPS).toContain('speech.say')
    expect(isCommandOp('speech.say')).toBe(true)
  })
})

describe('makeCommandRouter — session.dispatchCard (T113 + BUG-63 registerFolder)', () => {
  /** Deterministic order log so call-ORDER (not just call presence) is pinnable. */
  function makeDispatchRouter(over: Partial<CommandRouterActions> = {}) {
    const order: string[] = []
    const registered: unknown[] = []
    const actions: CommandRouterActions = {
      folderExists: vi.fn(() => true),
      insertAgentSession: vi.fn(),
      addShellHelper: vi.fn(),
      addResumeHelper: vi.fn(),
      addMarkdownHelper: vi.fn(),
      registerFolder: vi.fn((payload: unknown) => {
        order.push('registerFolder')
        registered.push(payload)
      }),
      dispatchCardSession: vi.fn(() => {
        order.push('dispatchCardSession')
        return 'synthetic-drain-1'
      }),
      ...over
    }
    return { dispatch: makeCommandRouter(actions), actions, order, registered }
  }

  it('an `adopted` payload registers the folder BEFORE dispatching (closes BUG-63)', () => {
    const { dispatch, actions, order, registered } = makeDispatchRouter()

    const res = dispatch('session.dispatchCard', {
      folderPath: '/repo/.claude/worktrees/card-a',
      prompt: 'boot:a',
      adopted: { path: '/repo/.claude/worktrees/card-a', gitBranch: 'card/a' }
    })

    expect(res).toEqual({ sessionId: 'synthetic-drain-1' })
    // registerFolder must run BEFORE dispatchCardSession — a caller that awaits
    // this ONE command has already registered the folder by the time
    // dispatchCardSession's own findFolderByPath lookup runs, no 250ms debounce
    // roundtrip required.
    expect(order).toEqual(['registerFolder', 'dispatchCardSession'])
    expect(registered).toEqual([{ path: '/repo/.claude/worktrees/card-a', gitBranch: 'card/a' }])
    expect(actions.dispatchCardSession).toHaveBeenCalledWith(
      '/repo/.claude/worktrees/card-a',
      'boot:a',
      undefined
    )
  })

  it('no `adopted` payload (session/teammate substrate) never calls registerFolder', () => {
    const { dispatch, actions } = makeDispatchRouter()
    dispatch('session.dispatchCard', { folderPath: '/repo', prompt: 'boot:a' })
    expect(actions.registerFolder).not.toHaveBeenCalled()
    expect(actions.dispatchCardSession).toHaveBeenCalledWith('/repo', 'boot:a', undefined)
  })

  it('a malformed `adopted` (missing path) → { error: BAD_ARGS }, nothing dispatched', () => {
    const { dispatch, actions } = makeDispatchRouter()
    const res = dispatch('session.dispatchCard', {
      folderPath: '/repo',
      prompt: 'boot:a',
      adopted: { gitBranch: 'card/a' }
    })
    expect(res).toEqual({ error: 'BAD_ARGS' })
    expect(actions.registerFolder).not.toHaveBeenCalled()
    expect(actions.dispatchCardSession).not.toHaveBeenCalled()
  })

  it('forwards the allowlisted bootOverride alongside a registered adopted folder', () => {
    const { dispatch, actions, order } = makeDispatchRouter()
    dispatch('session.dispatchCard', {
      folderPath: '/repo/wt',
      prompt: 'boot:a',
      bootOverride: { model: 'sonnet', effort: 'high' },
      adopted: { path: '/repo/wt' }
    })
    expect(order).toEqual(['registerFolder', 'dispatchCardSession'])
    expect(actions.dispatchCardSession).toHaveBeenCalledWith('/repo/wt', 'boot:a', {
      model: 'sonnet',
      effort: 'high'
    })
  })

  it('unknown folder (action returns null) → { error: FOLDER_NOT_FOUND }', () => {
    const { dispatch } = makeDispatchRouter({ dispatchCardSession: vi.fn(() => null) })
    const res = dispatch('session.dispatchCard', { folderPath: '/nope', prompt: 'boot:a' })
    expect(res).toEqual({ error: 'FOLDER_NOT_FOUND' })
  })

  it('dispatchCardSession not wired → { ok: false, error } (staged rollout)', () => {
    const { dispatch } = makeDispatchRouter({ dispatchCardSession: undefined })
    const res = dispatch('session.dispatchCard', { folderPath: '/repo', prompt: 'boot:a' })
    expect(res).toEqual({ ok: false, error: 'dispatchCardSession not wired' })
  })

  it('missing folderPath / prompt → { error: BAD_ARGS }', () => {
    const { dispatch, actions } = makeDispatchRouter()
    expect(dispatch('session.dispatchCard', { prompt: 'boot:a' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.dispatchCard', { folderPath: '/repo' })).toEqual({
      error: 'BAD_ARGS'
    })
    expect(dispatch('session.dispatchCard', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.dispatchCardSession).not.toHaveBeenCalled()
  })
})

describe('makeCommandRouter — COMMAND_OPS drift valve', () => {
  it('pane.openMarkdown is a recognized command op (T74)', () => {
    expect(COMMAND_OPS).toContain('pane.openMarkdown')
    expect(isCommandOp('pane.openMarkdown')).toBe(true)
  })

  it('notify.push is a recognized command op (T116)', () => {
    expect(COMMAND_OPS).toContain('notify.push')
    expect(isCommandOp('notify.push')).toBe(true)
  })

  it('session.wake is a recognized command op (T215)', () => {
    expect(COMMAND_OPS).toContain('session.wake')
    expect(isCommandOp('session.wake')).toBe(true)
  })
})

describe('makeCommandRouter — session.wake (T215)', () => {
  it('queues the resume and acks { queued: true }', () => {
    const { dispatch, actions } = makeRouter()
    expect(dispatch('session.wake', { sessionId: 'sess-1' })).toEqual({ queued: true })
    expect(actions.wakeSession).toHaveBeenCalledWith('sess-1')
  })

  it('NEVER selects the session — no selection action is reachable from this op', () => {
    // The whole point of routing the wake through the renderer is to reuse the
    // ordinary resume machinery WITHOUT selection's side effects: an agent
    // messaging a parked peer must not move the operator's view. The router's
    // injected action surface has exactly one entry point for a wake, and it
    // is not a selection.
    const { dispatch, actions } = makeRouter(['/repo/app'])
    dispatch('session.wake', { sessionId: 'sess-1' })
    // Nothing that mints or selects a session ran — only the wake queue.
    expect(actions.insertAgentSession).not.toHaveBeenCalled()
    expect(actions.addResumeHelper).not.toHaveBeenCalled()
    // And the injected action surface exposes no selection primitive at all,
    // so no future edit to this handler can reach one by accident.
    expect(Object.keys(actions)).not.toContain('selectSession')
  })

  it('validates its payload: a missing/blank/non-string sessionId is BAD_ARGS', () => {
    const { dispatch, actions } = makeRouter()
    expect(dispatch('session.wake', {})).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.wake', { sessionId: '' })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.wake', { sessionId: 7 })).toEqual({ error: 'BAD_ARGS' })
    expect(dispatch('session.wake', null)).toEqual({ error: 'BAD_ARGS' })
    expect(actions.wakeSession).not.toHaveBeenCalled()
  })

  it('an unknown session → FOLDER_NOT_FOUND, never a silent success', () => {
    // The model can move between the gate and this actuation; acking a wake
    // that will never happen would leave main waiting out its full window.
    const { dispatch } = makeRouter([], { wakeSession: vi.fn(() => false) })
    expect(dispatch('session.wake', { sessionId: 'gone' })).toEqual({ error: 'FOLDER_NOT_FOUND' })
  })

  it('un-wired action → { ok: false, error }, never a silent no-op', () => {
    const { dispatch } = makeRouter([], { wakeSession: undefined })
    expect(dispatch('session.wake', { sessionId: 'sess-1' })).toEqual({
      ok: false,
      error: 'wakeSession not wired'
    })
  })
})

describe('makeCommandRouter — failure modes', () => {
  it('unknown command → { error: BAD_ARGS }', () => {
    const { dispatch } = makeRouter(['/repo/app'])
    expect(dispatch('totally.bogus', { folder: '/repo/app' })).toEqual({ error: 'BAD_ARGS' })
  })

  it('a thrown store action is caught → { ok: false, error }', () => {
    const { dispatch } = makeRouter([], {
      addShellHelper: vi.fn(() => {
        throw new Error('helper boom')
      })
    })

    const res = dispatch('pane.split', {
      target: 'split',
      worktreePath: '/repo/wt-b',
      cwd: '/repo/wt-b',
      kind: 'shell'
    })

    expect(res).toEqual({ ok: false, error: 'helper boom' })
  })

  it('a thrown insertAgentSession is caught → { ok: false, error }', () => {
    const { dispatch } = makeRouter(['/repo/app'], {
      insertAgentSession: vi.fn(() => {
        throw new Error('insert boom')
      })
    })

    const res = dispatch('session.create', { folder: '/repo/app' })
    expect(res).toEqual({ ok: false, error: 'insert boom' })
  })
})
