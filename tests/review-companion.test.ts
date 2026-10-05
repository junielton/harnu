// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../src/renderer/src/components/ReviewPane.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useRoadmapStore } from '../src/renderer/src/stores/roadmap'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { paneRegistry } from '../src/renderer/src/lib/pane-registry'
import { paneComponents } from '../src/renderer/src/lib/pane-components'
import { stubTakeoverShellTargets, takeoverShellActions } from './helpers/takeover-shell-stub'
import {
  READ_ONLY_DENIED_TOOLS,
  buildClaudeArgs,
  forceReadOnlyPermission
} from '../src/main/claude-args'
import { assembleEvidence, parseUnifiedDiff } from '../src/main/review-core'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * T245 U1 — the review companion's contract.
 *
 * The feature is one sentence ("a fresh Claude beside the diff") resting on four
 * promises that, if any of them quietly stopped holding, would make the pane
 * worse than not having one:
 *
 *  - AC-2  the interlocutor is a STRANGER — never the session that wrote the
 *          branch, and there is no affordance offering to make it one.
 *  - AC-2b it is READ-ONLY, and promotion is the single, review-ending door out.
 *  - AC-3  nothing it emits reaches the review pane's evidence surfaces.
 *  - AC-4  Harnu never speaks first.
 *  - AC-6  closing the review DISPOSES it — verified against the lifecycle that
 *          actually runs, not the one it would be convenient to assume.
 *
 * The live PTY half of AC-2/AC-2b/AC-4/AC-6 lives in
 * `review-companion-lifecycle.test.ts`, which mounts the real `HelperPane`.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/**
 * Put a session with `sessionId` into the sessions model — the renderer's own
 * proof that Claude wrote the transcript, which is what makes a companion
 * promotable. The JSONL watcher is what does this in the app.
 */
function seedTranscript(sessionId: string, folderPath = '/repos/harnu'): void {
  const sessions = useSessionsStore()
  sessions.folders = [
    {
      path: folderPath,
      alias: 'harnu',
      expanded: true,
      sessions: [{ sessionId, projectPath: folderPath }]
    }
  ] as never
}

/** Source with comments stripped: prose ABOUT a rule is not a violation of it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')
}

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe('AC-2 — the companion is a fresh session, with no way to make it the author', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('spawns a `claude-new` PTY and is never persisted', () => {
    const entry = paneRegistry['review-companion']
    expect(entry.ptyKind).toBe('claude-new')
    // The trap the PRD names: `claude-fork-pending` resolves into `claude`,
    // which IS persistable — a companion built on that pattern would be written
    // to helpers.json and reopen on every future boot as a permanent tab.
    expect(entry.persistable).toBe(false)
    expect(paneRegistry['claude'].persistable).toBe(true)
    expect(paneComponents['review-companion']).toBe(paneComponents['shell'])
  })

  it('carries a freshly minted session uuid — never one that already exists', () => {
    const helpers = useHelpersStore()
    const id = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const pane = helpers.byWorktree.get('/repos/harnu')!.panes.find((p) => p.id === id)!
    expect(pane.type).toBe('review-companion')
    const companion = pane as Extract<typeof pane, { type: 'review-companion' }>
    expect(companion.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    // Not derived from anything: no source session, no resume target.
    expect(companion).not.toHaveProperty('sourceSessionId')
    expect(companion).not.toHaveProperty('pendingSynthId')
    // A second invocation reveals the stranger already running rather than
    // stacking another one with no shared context.
    expect(helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')).toBe(id)
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(1)
  })

  it('the review pane offers no author-session path at all', () => {
    const code = codeOnly(read('src/renderer/src/components/ReviewPane.vue'))
    for (const forbidden of ['addResumeHelper', 'addForkHelper', 'createForkedSession']) {
      expect(code, `ReviewPane reaches for ${forbidden}`).not.toContain(forbidden)
    }
    expect(code).toContain('addReviewCompanionHelper')
    // The frozen spec's "switch to author" badge predates the 2026-08-27
    // fresh-session decision and is deliberately not built.
    expect(code).not.toMatch(/switch to author/i)
    expect(read('src/renderer/src/i18n/en.json')).not.toMatch(/switch to author/i)
  })
})

// ── AC-2b ───────────────────────────────────────────────────────────────────

describe('AC-2b — read-only, with promotion as the only door out', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('the registry, not a call site, is what marks the pane read-only', () => {
    expect(paneRegistry['review-companion'].readOnly).toBe(true)
    for (const type of ['shell', 'claude', 'claude-fork-pending'] as const) {
      expect(paneRegistry[type].readOnly, `${type} must not be read-only`).toBeUndefined()
    }
  })

  it('a hostile Claude Boot config cannot hand the reviewer a pen', () => {
    // Every escape hatch a user's own global/folder config could carry, at once.
    const hostile = {
      permissionMode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
      disallowedTools: ['WebFetch'],
      extraArgs: '--permission-mode acceptEdits --dangerously-skip-permissions --verbose'
    }
    const argv = buildClaudeArgs(['--session-id', 'u'], forceReadOnlyPermission(hostile))
    const modeAt = argv.indexOf('--permission-mode')
    expect(modeAt).toBeGreaterThan(-1)
    expect(argv[modeAt + 1]).toBe('plan')
    // Exactly one, and nothing later in the argv can win over it.
    expect(argv.filter((a) => a === '--permission-mode')).toHaveLength(1)
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('acceptEdits')
    // The part plan mode alone cannot promise: plan is the mode a session STARTS
    // in and the operator can cycle out of it inside Claude's own TUI, whereas a
    // denied tool stays denied for the life of the process.
    const denyAt = argv.indexOf('--disallowedTools')
    expect(argv.slice(denyAt + 1)).toEqual(
      expect.arrayContaining(['WebFetch', 'Edit', 'Write', 'NotebookEdit'])
    )
    // Every denied name must be a tool the CLI actually has — an unknown one
    // prints `matches no known tool` into the session on boot, which is a guard
    // announcing its own misconfiguration.
    expect(READ_ONLY_DENIED_TOOLS).toEqual(['Edit', 'Write', 'NotebookEdit'])
    // Untouched flags survive — this is a downgrade, not a reset.
    expect(argv).toContain('--verbose')
    expect(argv.slice(0, 2)).toEqual(['--session-id', 'u'])
  })

  it('leaves a config that was already read-only alone, and never mutates its input', () => {
    const cfg = { permissionMode: 'plan', model: 'opus' }
    const out = forceReadOnlyPermission(cfg)
    expect(cfg).toEqual({ permissionMode: 'plan', model: 'opus' })
    expect(out.model).toBe('opus')
    expect(out.permissionMode).toBe('plan')
  })

  it('main applies the downgrade AFTER the user scopes are merged', () => {
    const pty = codeOnly(read('src/main/pty.ts'))
    // Rebuilt from a config that no longer contains a way out — not
    // post-filtered off an argv the user's scopes already shaped.
    const branch = pty.slice(pty.indexOf('if (opts.readOnly) {'))
    const body = branch.slice(0, branch.indexOf('} else if'))
    expect(body).toContain('forceReadOnlyPermission(merged)')
    expect(body).toContain('getResolvedConfig(opts.cwd)')
    // And WITHHOLDING Harnu's MCP server: a reviewer holding create_session /
    // create_worktree could put an agent's hands on the worktree it may not edit.
    expect(body).not.toContain('orderMcpArgs')
  })

  it('promotion replaces the read-only PTY with a resume of the same transcript', () => {
    const helpers = useHelpersStore()
    const paneId = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const before = helpers.byWorktree.get('/repos/harnu')!.panes[0] as {
      type: string
      sessionId: string
    }
    seedTranscript(before.sessionId)

    const newId = helpers.promoteReviewCompanion('/repos/harnu', paneId)

    const after = helpers.byWorktree.get('/repos/harnu')!.panes
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(newId)
    // A REPLACEMENT, not a mutation: `--permission-mode plan` is argv, fixed for
    // the life of a process, so read-only can only be left by respawning.
    expect(after[0].id).not.toBe(paneId)
    expect(after[0].type).toBe('claude')
    // Same transcript — the conversation survives the change of posture.
    expect((after[0] as { sessionId: string }).sessionId).toBe(before.sessionId)
    expect(paneRegistry[after[0].type].readOnly).toBeUndefined()
    expect(paneRegistry[after[0].type].ptyKind).toBe('claude-resume')
  })

  it('refuses to promote a session nobody has spoken to yet', () => {
    // `--session-id` reserves the uuid at spawn, but Claude writes the JSONL on
    // the FIRST turn. Promoting before then would `claude --resume` a
    // conversation that does not exist — observed live as "No conversation found
    // with session ID" plus a dead pane and a stale-session toast.
    const helpers = useHelpersStore()
    const paneId = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const pane = helpers.byWorktree.get('/repos/harnu')!.panes[0]

    expect(helpers.canPromoteReviewCompanion(pane as never)).toBe(false)
    expect(helpers.promoteReviewCompanion('/repos/harnu', paneId)).toBeNull()
    // And the read-only pane is left exactly as it was — a refused promote is
    // not allowed to cost the operator the conversation they were having.
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toEqual([pane])

    seedTranscript((pane as unknown as { sessionId: string }).sessionId)
    expect(helpers.canPromoteReviewCompanion(pane as never)).toBe(true)
  })

  it('refuses to promote anything that is not a companion', () => {
    const helpers = useHelpersStore()
    const shellId = helpers.addShellHelper('/repos/harnu', '/repos/harnu')
    expect(helpers.promoteReviewCompanion('/repos/harnu', shellId)).toBeNull()
    expect(helpers.promoteReviewCompanion('/repos/harnu', 'h-nope')).toBeNull()
    expect(helpers.byWorktree.get('/repos/harnu')!.panes[0].type).toBe('shell')
  })

  it('promoting ENDS the review — the gesture is never free', () => {
    const pane = read('src/renderer/src/components/HelperPane.vue')
    // The one call site, and it closes the takeover in the same breath. A
    // reviewer that edits IS the author; keeping the diff on screen while its
    // reader gains a pen is the collapse the fresh-session decision prevents.
    expect(pane).toMatch(
      /function onPromote\(\)[\s\S]{0,400}promoteReviewCompanion\([\s\S]{0,160}ui\.closeReview\(\)/
    )
    // `promoteReviewCompanion` has exactly one caller in the renderer.
    const callers = [
      'src/renderer/src/App.vue',
      'src/renderer/src/components/ReviewPane.vue',
      'src/renderer/src/components/HelperStack.vue',
      'src/renderer/src/components/FolderView.vue'
    ].filter((rel) => codeOnly(read(rel)).includes('promoteReviewCompanion'))
    expect(callers).toEqual([])
  })
})

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe('AC-3 — nothing the session emits renders inside the review pane', () => {
  const DIFF = `diff --git a/src/main/reaper/scan-core.ts b/src/main/reaper/scan-core.ts
--- a/src/main/reaper/scan-core.ts
+++ b/src/main/reaper/scan-core.ts
@@ -1,2 +1,3 @@
 const ttlMs = 30 * 60_000
-export const fresh = (age: number) => age < ttlMs
+export const fresh = (age: number, sha: string) => age < ttlMs && sha === recorded
`

  function snapshot(): unknown {
    return {
      folder: '/repos/harnu',
      branch: 'bug/57',
      base: 'main',
      isRepo: true,
      evidence: assembleEvidence({
        branch: 'bug/57',
        base: 'main',
        revListCount: '2\n',
        behindCount: '0\n',
        numstat: '1\t1\tsrc/main/reaper/scan-core.ts\n',
        nameStatus: 'M\tsrc/main/reaper/scan-core.ts\n',
        porcelain: '',
        remotes: 'origin\n',
        prListJson: '[]',
        session: 'done'
      }),
      files: parseUnifiedDiff(DIFF),
      truncated: false,
      omittedFiles: [] as string[],
      totalRows: 3,
      viewed: { prNodeId: null, remoteKnown: false, files: {} },
      fetchedAt: 0
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => snapshot(),
      reviewBlastRadius: async () => ({ globs: [] }),
      reviewSetViewed: async (a: { path: string }) => ({
        path: a.path,
        state: 'viewed',
        error: null
      }),
      onReviewBlastRadiusChanged: () => () => {},
      roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
      onRoadmapCardAdded: () => () => {},
      onRoadmapCardChanged: () => () => {},
      onRoadmapCardRemoved: () => () => {},
      helpersGet: async () => null,
      helpersSet: async () => {}
    }
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  it('the pane renders no helper pane and reads no pane state', () => {
    const src = read('src/renderer/src/components/ReviewPane.vue')
    const code = codeOnly(src)
    for (const forbidden of [
      'HelperPane',
      'HelperStack',
      'pane-components',
      'panesForCurrentWorktree',
      'liveHelpers',
      'onPtyData'
    ]) {
      expect(code, `ReviewPane reaches for ${forbidden}`).not.toContain(forbidden)
    }
    // Its ONLY business with the helper stack is opening the companion and
    // bringing it into focus once open (BUG-94 AC-1) — never reading pane
    // content or state.
    const helperCalls = [...code.matchAll(/helpers\.(\w+)/g)].map((m) => m[1])
    expect(new Set(helperCalls)).toEqual(new Set(['addReviewCompanionHelper', 'maximizePane']))
  })

  it('a live companion changes nothing on the evidence header, strip or diff', async () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    useReviewStore().snapshot = snapshot() as never
    useRoadmapStore().folderPath = '/repos/harnu'
    ui.openReview('/repos/harnu', null)

    const before = mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()
    const withoutCompanion = before.html()
    before.unmount()

    helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const after = mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(after.html()).toBe(withoutCompanion)
    // And nothing of the companion's own vocabulary leaks in. (`review.companionHint`
    // — the opener's own tooltip — is the pane's copy, not the session's.)
    for (const word of [
      en.reviewCompanion.title,
      en.reviewCompanion.subtitle,
      en.reviewCompanion.promote,
      en.reviewCompanion.readOnlyHint
    ]) {
      expect(after.html()).not.toContain(word)
    }
    after.unmount()
  })
})

// ── AC-4 ────────────────────────────────────────────────────────────────────

/**
 * **AMENDED 2026-08-28 by T247 (T245 U2), with the operator's signature.**
 *
 * AC-4 as U1 merged it read "Harnu never sends an initial message", and these
 * tests pinned it by forbidding the companion pane and its opener to carry ANY
 * text at all. That was the right pin for U1 and the wrong pin after T246.
 *
 * The reason it had to move: T246 decoupled the reviewed head from the folder's
 * `HEAD`, so the companion's cheapest instinct — `git status` — began returning
 * a confident, correct, IRRELEVANT answer about the folder while the operator
 * was reading someone else's diff. A session with no information asks. A session
 * with wrong-looking information guesses. The deliberate blindness U1 shipped
 * only works while the session KNOWS it is blind.
 *
 * The amendment is exactly this, and no wider: **Harnu may deliver a fixed,
 * evaluation-free orientation string via `--append-system-prompt`.** Everything
 * AC-4 was actually protecting is still forbidden, and is still pinned below:
 *
 *  - **no user turn.** No `prePrompt` (a positional IS a first user turn: the
 *    session would generate an unrequested opening response, that reply would
 *    anchor every later answer, and Harnu would be ventriloquizing the operator),
 *    and no `ptyWrite`.
 *  - **no composition from `evidence`.** The opener may now read `snapshot` —
 *    that is the softening, and it is bounded to base/head SHAs, the head's
 *    state, `isRepo` and the PR number — but `evidence` stays forbidden, because
 *    CI state, PR state, counts and a ranked file list are triage substrate and
 *    triage is an unresolved product decision.
 *  - **no widening by accident.** The pane's key set is still pinned exactly,
 *    and the corrective's own key set is pinned too, so the five-scalar door
 *    cannot quietly grow into the briefing three adversarial reviews rejected.
 *
 * Neither test was deleted or loosened. Both got NARROWER in the dimension that
 * matters (they now assert the shape of what may travel, not merely that nothing
 * does) and wider only where the operator signed off.
 */
describe('AC-4 (amended by T247) — Harnu never sends an initial message, and may send only orientation', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('the companion pane carries orientation and nothing else', () => {
    const helpers = useHelpersStore()
    const id = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const pane = helpers.byWorktree.get('/repos/harnu')!.panes.find((p) => p.id === id)!
    // `corrective` is the ONE key the amendment adds. Still pinned exactly: a
    // sixth key is how a prompt field arrives without anyone deciding to add one.
    expect(Object.keys(pane).sort()).toEqual(
      ['corrective', 'cwd', 'id', 'ratio', 'sessionId', 'type'].sort()
    )
    // And the orientation itself is five scalars wide — the enforcement of the
    // spec's normative exclusion list, not a promise about the call sites.
    expect(Object.keys((pane as { corrective: object }).corrective).sort()).toEqual(
      ['baseSha', 'headSha', 'isRepo', 'prNumber', 'state'].sort()
    )
  })

  it('no synthesized USER turn reaches the spawn path', () => {
    const store = codeOnly(read('src/renderer/src/stores/helpers.ts'))
    const factory = store.slice(store.indexOf('function addReviewCompanionHelper'))
    const body = factory.slice(0, factory.indexOf('\n  }'))
    for (const forbidden of ['prePrompt', 'ptyWrite', 'pendingAgentPrompts', 'bootOverride']) {
      expect(body, `the companion factory reaches for ${forbidden}`).not.toContain(forbidden)
    }
    // The ReviewPane's opener composes no turn either. `snapshot` is now allowed
    // (that is the amendment, and it is what the SHAs come from); `evidence`
    // stays forbidden, because a corrective built from it is a briefing.
    const opener = codeOnly(read('src/renderer/src/components/ReviewPane.vue'))
    const fn = opener.slice(opener.indexOf('function openCompanion'))
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/prePrompt|ptyWrite|evidence/)
  })

  it('the read-only spawn path drops any pre-prompt the operator configured', () => {
    // An operator's folder-scope pre-prompt ("always run the tests and fix what
    // fails") would otherwise arrive as a read-only stranger's opening
    // instruction — a user turn addressed to a session that cannot fix anything.
    // There is no delimiter that makes a user turn stop being one, so the only
    // correct handling is not to emit it (T247 AC-21 + AC-25).
    const argv = buildClaudeArgs(
      ['--session-id', 'u'],
      forceReadOnlyPermission({ prePrompt: 'always run the tests and fix what fails' })
    )
    expect(argv).not.toContain('--')
    expect(argv.join(' ')).not.toContain('always run the tests')
  })
})

// ── AC-6 ────────────────────────────────────────────────────────────────────

describe('AC-6 — closing the review disposes the companion', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = new Proxy(
      { helpersGet: async () => null, helpersSet: async () => {} } as Record<string, unknown>,
      { get: (t, p: string) => (p in t ? t[p] : () => () => {}) }
    )
  })

  it('every close edge reaches the helper store — X, Esc, and a sibling takeover', () => {
    for (const close of [
      (ui: ReturnType<typeof useUiStore>) => ui.closeReview(),
      (ui: ReturnType<typeof useUiStore>) => ui.closeAllTakeovers(),
      (ui: ReturnType<typeof useUiStore>) => ui.closeAll(),
      (ui: ReturnType<typeof useUiStore>) => ui.openRoadmap('/repos/harnu', 'harnu')
    ]) {
      setActivePinia(createPinia())
      const ui = useUiStore()
      const helpers = useHelpersStore()
      ui.openReview('/repos/harnu', null)
      helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
      expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(1)

      close(ui)

      expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(0)
    }
  })

  it('leaves every other pane in the stack alone', () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)
    const shell = helpers.addShellHelper('/repos/harnu', '/repos/harnu')
    helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')

    ui.closeReview()

    const left = helpers.byWorktree.get('/repos/harnu')!.panes
    expect(left.map((p) => p.id)).toEqual([shell])
  })

  it('sweeps companions in worktrees the operator has since navigated away from', () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/a', null)
    helpers.addReviewCompanionHelper('/repos/a', '/repos/a')
    // The operator wandered off to another folder before closing the review.
    helpers.addShellHelper('/repos/b', '/repos/b')

    ui.closeReview()

    expect(helpers.byWorktree.get('/repos/a')!.panes).toHaveLength(0)
    expect(helpers.byWorktree.get('/repos/b')!.panes).toHaveLength(1)
  })

  it('opening the review does not dispose the pane it is about to host', () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)
    helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    // Re-pointing the review at a different card routes through
    // `closeAllTakeovers` — the close edge must be the REVIEW ending, not any
    // pass through that helper.
    ui.openReview('/repos/harnu', 'bug-57')
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(0)
    // (A re-open IS a close of the previous review, so the companion goes. What
    //  must not happen is the reverse: a companion opened AFTER, disposed by the
    //  same call.)
    helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(1)
  })

  it('a promoted pane survives the close — it is no longer a companion', () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)
    const paneId = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    seedTranscript(
      (helpers.byWorktree.get('/repos/harnu')!.panes[0] as unknown as { sessionId: string })
        .sessionId
    )

    const promoted = helpers.promoteReviewCompanion('/repos/harnu', paneId)
    ui.closeReview()

    const left = helpers.byWorktree.get('/repos/harnu')!.panes
    expect(left.map((p) => p.id)).toEqual([promoted])
  })

  it('the helper stack renders beside the review — or the pane would be invisible', () => {
    const app = read('src/renderer/src/App.vue')
    const decl = app.slice(app.indexOf('const showHelperStack'))
    const expr = decl.slice(0, decl.indexOf('\n)'))
    for (const term of ['showRoadmap', 'showTerminal', 'showFolder', 'showReview']) {
      expect(expr, `showHelperStack is missing ${term}`).toContain(term)
    }
  })
})

// ── AC-7 ────────────────────────────────────────────────────────────────────

describe('AC-7 — every new string exists in both locales', () => {
  function flatten(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) return [prefix]
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k)
    )
  }

  it('en.json and pt-BR.json carry the same reviewCompanion.* key set', () => {
    const enKeys = flatten((en as Record<string, unknown>).reviewCompanion).sort()
    const ptKeys = flatten((ptBR as Record<string, unknown>).reviewCompanion).sort()
    expect(enKeys).toEqual([
      // T247 AC-26/AC-31 — the disclosure's LABEL is UI copy and belongs here.
      // The corrective it reveals is model-facing prose and deliberately is not
      // a locale key: a translated corrective forks model behaviour by the
      // operator's language setting.
      'disclosure',
      'promote',
      'promoteHint',
      'promoteNotYet',
      'readOnly',
      'readOnlyHint',
      'subtitle',
      'title'
    ])
    expect(ptKeys).toEqual(enKeys)
  })

  it('the review pane opener names keys that exist on both sides', () => {
    for (const key of ['companion', 'companionHint'] as const) {
      expect(typeof (en.review as Record<string, unknown>)[key]).toBe('string')
      expect(typeof (ptBR.review as Record<string, unknown>)[key]).toBe('string')
    }
  })

  it('the companion header holds no bare string literal outside $t()', () => {
    const pane = read('src/renderer/src/components/HelperPane.vue')
    const template = pane.slice(pane.indexOf('<template>'))
    const literals = [...template.matchAll(/\{\{\s*'([^']+)'\s*\}\}/g)].map((m) => m[1])
    expect(literals).toEqual([])
  })
})

// ── BUG-94 ────────────────────────────────────────────────────────────────
//
// Three defects on this same path, all shipped with U1 and found by
// adversarial review — verified in-tree, not taken from a report.

function reviewSnapshot(): unknown {
  return {
    folder: '/repos/harnu',
    branch: 'bug/57',
    base: 'main',
    // T247 — the SHA half of the snapshot the companion's orientation is built
    // from. Present here so the click path exercises the real shape.
    baseSha: 'a'.repeat(40),
    head: {
      kind: 'local',
      name: 'bug/57',
      ref: 'bug/57',
      sha: 'b'.repeat(40),
      state: 'ready',
      prNumber: null,
      freshness: 'unknown',
      fetchedAt: null,
      fetchFailed: false
    },
    isRepo: true,
    evidence: assembleEvidence({
      branch: 'bug/57',
      base: 'main',
      revListCount: '1\n',
      behindCount: '0\n',
      numstat: '1\t0\tsrc/a.ts\n',
      nameStatus: 'M\tsrc/a.ts\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      session: null
    }),
    files: parseUnifiedDiff(
      `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n`
    ),
    truncated: false,
    omittedFiles: [] as string[],
    totalRows: 1,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0
  }
}

// AC-1 — a second activation must not be a silent no-op ────────────────────

describe('AC-1 (BUG-94) — a second activation reveals/focuses the running companion', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => reviewSnapshot(),
      reviewBlastRadius: async () => ({ globs: [] }),
      reviewSetViewed: async (a: { path: string }) => ({
        path: a.path,
        state: 'viewed',
        error: null
      }),
      onReviewBlastRadiusChanged: () => () => {},
      roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
      onRoadmapCardAdded: () => () => {},
      onRoadmapCardChanged: () => () => {},
      onRoadmapCardRemoved: () => () => {},
      helpersGet: async () => null,
      helpersSet: async () => {}
    }
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  it('a second click on "Ask a fresh session" focuses the companion instead of doing nothing', async () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)

    mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const button = takeoverShellActions().get('button[aria-label="Ask a fresh session"]')
    await button.trigger('click')
    await flushPromises()

    const panes = helpers.byWorktree.get('/repos/harnu')!.panes
    expect(panes).toHaveLength(1)
    const companionId = panes[0].id

    // A second, unrelated pane grabs the maximize slot — simulating the
    // operator having since focused something else in the stack.
    const shellId = helpers.addShellHelper('/repos/harnu', '/repos/harnu')
    helpers.toggleMaximizePane('/repos/harnu', shellId)
    expect(helpers.maximizedPaneId('/repos/harnu')).toBe(shellId)

    await button.trigger('click')
    await flushPromises()

    // Still exactly one companion — the dedup guard did its job.
    expect(
      helpers.byWorktree.get('/repos/harnu')!.panes.filter((p) => p.type === 'review-companion')
    ).toHaveLength(1)
    // And the return value was actually consumed: the companion is now the
    // pane holding focus, not silently ignored.
    expect(helpers.maximizedPaneId('/repos/harnu')).toBe(companionId)
  })
})

// AC-2/AC-3 — the button must not open a companion with no review context ──

describe('AC-2/AC-3 (BUG-94) — no companion can be opened with no snapshot loaded', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  it('disables the button while the load errored, with a hover reason, and refuses to spawn even if the attribute is bypassed', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => {
        throw new Error('boom')
      },
      onReviewBlastRadiusChanged: () => () => {},
      helpersGet: async () => null,
      helpersSet: async () => {}
    }
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)

    mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const button = takeoverShellActions().get('button[aria-label="Ask a fresh session"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).not.toBe('')

    // The store-level guard, not just the template attribute: bypass the
    // disabled attribute and confirm the click handler itself refuses.
    ;(button.element as HTMLButtonElement).removeAttribute('disabled')
    await button.trigger('click')
    await flushPromises()

    expect(helpers.byWorktree.get('/repos/harnu')).toBeUndefined()
  })

  it('enables the button once a snapshot is loaded', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => reviewSnapshot(),
      reviewBlastRadius: async () => ({ globs: [] }),
      onReviewBlastRadiusChanged: () => () => {},
      helpersGet: async () => null,
      helpersSet: async () => {}
    }
    const ui = useUiStore()
    ui.openReview('/repos/harnu', null)

    mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const button = takeoverShellActions().get('button[aria-label="Ask a fresh session"]')
    expect(button.attributes('disabled')).toBeUndefined()
  })
})

// AC-4 — reviewFolderPath is gone ───────────────────────────────────────────

describe('AC-4 (BUG-94) — reviewFolderPath is removed rather than left as dead weight', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('the companion pane no longer carries the field, and the type declares no such key', () => {
    const helpers = useHelpersStore()
    const id = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const pane = helpers.byWorktree.get('/repos/harnu')!.panes.find((p) => p.id === id)!
    // `corrective` (T247) is the only key added since; `reviewFolderPath` is
    // still gone, and this list is still exact.
    expect(Object.keys(pane).sort()).toEqual(
      ['corrective', 'cwd', 'id', 'ratio', 'sessionId', 'type'].sort()
    )

    // The parameter name (feeding `cwd`) is fine to keep — it's the FIELD on
    // the pane object that was dead weight, and that field is gone.
    const src = read('src/renderer/src/stores/helpers.ts')
    const iface = src.slice(
      src.indexOf('export interface HelperPaneReviewCompanion'),
      src.indexOf('}', src.indexOf('export interface HelperPaneReviewCompanion'))
    )
    expect(iface).not.toContain('reviewFolderPath')
  })
})
