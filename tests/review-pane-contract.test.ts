// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../src/renderer/src/components/ReviewPane.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useRoadmapStore } from '../src/renderer/src/stores/roadmap'
import { assembleEvidence, parseUnifiedDiff } from '../src/main/review-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * The T164 review pane's ACCOUNTABILITY contract — the four claims that, if
 * they ever stopped being true, would make the pane worse than not having one.
 *
 * These are deliberately not render-detail tests. They pin:
 *
 *  - AC-9  Close still has exactly ONE writer of `status: done` in `src/main`.
 *  - AC-10 Bounce lands the note before it moves the card, and never writes done.
 *  - AC-12 No agent-produced claim, and no model call, on the v1 code path.
 *  - AC-13 Every `review.*` string exists in BOTH locale files.
 */

const REPO = join(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') || full.endsWith('.vue')) out.push(full)
  }
  return out
}

// ── AC-9 ────────────────────────────────────────────────────────────────────

describe('AC-9 — `status: done` keeps exactly one writer', () => {
  /**
   * The grep the acceptance criterion names, run as a test so it cannot rot.
   * A second writer is not a style problem: Close is the human's decision, and
   * two doors onto it means one of them can skip the close-trigger side effects
   * (`roadmap:closeCard`'s memory append, the epic entry in `decisions.md`).
   */
  it('src/main writes `status: done` in exactly one place', () => {
    const hits: string[] = []
    for (const file of walk(join(REPO, 'src/main'))) {
      const text = readFileSync(file, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        // The write expression, not the word: a comment ABOUT the writer is not
        // a writer, and `status: 'review'` / `'ready'` are different columns.
        if (/status:\s*'done'/.test(line)) hits.push(`${relative(REPO, file)}:${i + 1}`)
      }
    }
    expect(hits, `writers of \`status: 'done'\`: ${hits.join(', ')}`).toHaveLength(1)
    expect(hits[0]).toMatch(/^src\/main\/roadmap-ipc\.ts:/)
  })

  it('the review pane never writes a status itself — it calls the roadmap store', () => {
    const pane = readFileSync(join(REPO, 'src/renderer/src/components/ReviewPane.vue'), 'utf8')
    expect(pane).not.toMatch(/roadmapSetStatus|roadmapCloseCard|roadmapAppendBody/)
    expect(pane).toMatch(/roadmap\.closeCard\(/)
  })
})

// ── AC-12 ───────────────────────────────────────────────────────────────────

describe('AC-12 — no agent-produced claim renders in v1', () => {
  const FILES = [
    'src/renderer/src/components/ReviewPane.vue',
    'src/renderer/src/components/review-format.ts',
    'src/renderer/src/stores/review.ts',
    // T243 — the viewed mark's main-process halves. The shell runs
    // `gh api graphql` and nothing else, and this list is what keeps that true.
    'src/main/review-viewed.ts',
    'src/main/review-viewed-store.ts',
    // T244 — the submit guard. The one path that WRITES to GitHub, and the one
    // where a model call would be worst: a verdict this file inferred would be
    // submitted under the operator's name.
    'src/main/review-submit-core.ts'
  ]

  it('the v1 code path calls no model and runs no review command', () => {
    for (const rel of FILES) {
      const text = readFileSync(join(REPO, rel), 'utf8')
      // Comments are prose about the rule; only code may not do these things.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      for (const forbidden of [
        '/code-review',
        'haiku',
        'anthropic',
        'claude-opus',
        'claude-sonnet',
        'messages.create',
        'ptyCreate',
        'runClaude'
      ]) {
        expect(code.toLowerCase(), `${rel} reaches for ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('the only text the pane renders comes from git, the locale files, or the card', () => {
    const store = readFileSync(join(REPO, 'src/renderer/src/stores/review.ts'), 'utf8')
    const apiCalls = [...store.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1])
    // RE-PINNED, never loosened: T243 widened this surface for the first time,
    // by exactly one write — `reviewSetViewed`, one boolean per file scoped to
    // the operator's own account. The pin, not the keyword grep above it, is
    // the binding guarantee that this path never reaches for a model or an
    // unexpected network call.
    //
    // T247 did NOT widen it: the companion's orientation is built from the
    // snapshot this store already loaded, so it costs no new IPC call at all.
    expect(new Set(apiCalls)).toEqual(
      new Set([
        'reviewLoad',
        'reviewBlastRadius',
        'onReviewBlastRadiusChanged',
        'reviewSetViewed',
        // T244 — the second write, and the first one another human can see.
        // It carries the operator's own words to GitHub under their own
        // identity, and it is reachable ONLY from a click in the pane: see the
        // catalog test below, which fails if an MCP verb is ever added for it.
        'reviewSubmitReview'
      ])
    )
  })

  /**
   * T247 — the one text Harnu now composes FOR a model on this path, pinned to
   * what it may be built from.
   *
   * This is the criterion AC-12 would otherwise have quietly stopped covering.
   * The review companion is a model, and Harnu now speaks to it — so "no
   * agent-produced claim renders in v1" needs its converse pinned too: no
   * pane-produced claim reaches an agent. The orientation is five scalars, and
   * `evidence` — the CI chips, the PR state, the counts, the discrepancy strip's
   * inputs — is the half that must never be among them, because that content is
   * triage substrate and triage is an unresolved product decision.
   */
  it('the companion is told only orientation, never evidence', () => {
    const corrective = readFileSync(join(REPO, 'src/main/review-corrective.ts'), 'utf8')
    const iface = corrective.slice(
      corrective.indexOf('export interface ReviewCorrective'),
      corrective.indexOf('}', corrective.indexOf('export interface ReviewCorrective'))
    )
    // RE-PINNED, never loosened. Each name here is a commit SHA, a state, a
    // boolean or an integer; none of them can carry prose, a path or a count.
    const fields = [...iface.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort()
    expect(fields).toEqual(['baseSha', 'headSha', 'isRepo', 'prNumber', 'state'])
    for (const forbidden of ['evidence', 'files', 'omittedFiles', 'totalRows', 'truncated']) {
      expect(iface, `the orientation carries ${forbidden}`).not.toContain(forbidden)
    }
    // And the opener that fills it never reads the evidence header either.
    const opener = readFileSync(join(REPO, 'src/renderer/src/components/ReviewPane.vue'), 'utf8')
    const fn = opener.slice(opener.indexOf('function openCompanion'))
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toContain('evidence')
  })
})

// ── AC-13 ───────────────────────────────────────────────────────────────────

describe('AC-13 — every review string exists in both locales', () => {
  function flatten(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) return [prefix]
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k)
    )
  }

  it('en.json and pt-BR.json carry the same review.* key set', () => {
    const enKeys = flatten((en as Record<string, unknown>).review).sort()
    const ptKeys = flatten((ptBR as Record<string, unknown>).review).sort()
    expect(enKeys.length).toBeGreaterThan(40)
    expect(ptKeys).toEqual(enKeys)
  })

  it('every key the pane and its format layer name is present in en.json', () => {
    const enReview = (en as Record<string, unknown>).review as Record<string, unknown>
    const get = (path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], enReview)

    // The dynamic families: `review.receipt.*`, `review.value.*`, `review.flag.*`,
    // `review.contract.*`. Their leaves are produced by review-format, so the
    // pane's `t()` calls are dynamic and vue-tsc cannot see them — this is what
    // catches a key that only exists on one side.
    for (const family of ['receipt', 'value', 'flag', 'contract', 'empty', 'verdict', 'refusal']) {
      expect(get(family), `review.${family} missing`).toBeTruthy()
    }
    for (const literal of [
      'title',
      'close',
      'refresh',
      'loading',
      'errorTitle',
      'closeCard',
      'closed',
      'closeFailed',
      'bounce',
      'bounceHeading',
      'bounceLabel',
      'bouncePlaceholder',
      'bounceCancel',
      'bounceSend',
      'bounced',
      'bounceFailed',
      'bounceNoteOnly',
      'openInTerminal',
      // T246 — the one gesture that leaves the "not fetched yet" state.
      'fetchHead',
      // T244 — submitting a review to GitHub.
      'submitReview',
      'submitLabel',
      'submitPlaceholder',
      'submitBoundary',
      'submitCancel',
      'submitted',
      'submitFailed',
      'confirmTitle',
      'confirmBoundary',
      'confirmCancel',
      'confirmSubmit',
      'confirmSubmitting',
      // T243 — the viewed mark's four states, in words.
      'markViewed',
      'markUnviewed',
      'viewedPending',
      'viewedDismissed',
      'viewedFailed',
      'intentLabel',
      'intentStrip',
      'sensitiveBadge',
      'binary',
      'binaryBody',
      'unchangedLines',
      'noNewline',
      'truncated'
    ]) {
      expect(typeof get(literal), `review.${literal} missing`).toBe('string')
    }
  })

  it('the pane holds no bare user-facing string literal outside $t()', () => {
    const pane = readFileSync(join(REPO, 'src/renderer/src/components/ReviewPane.vue'), 'utf8')
    const template = pane.slice(pane.indexOf('<template>'))
    // Interpolations must all be t(...) or data; a `{{ 'literal' }}` is the
    // shape that slips past the i18n contract.
    const literals = [...template.matchAll(/\{\{\s*'([^']+)'\s*\}\}/g)].map((m) => m[1])
    expect(literals).toEqual([])
  })
})

// ── AC-10 (+ AC-1's store half) ─────────────────────────────────────────────

const DIFF = `diff --git a/src/main/reaper/scan-core.ts b/src/main/reaper/scan-core.ts
--- a/src/main/reaper/scan-core.ts
+++ b/src/main/reaper/scan-core.ts
@@ -1,2 +1,3 @@
 const ttlMs = 30 * 60_000
-export const fresh = (age: number) => age < ttlMs
+export const fresh = (age: number, sha: string) => age < ttlMs && sha === recorded
`

function snapshot(): ReturnType<typeof buildSnapshot> {
  return buildSnapshot()
}

function buildSnapshot() {
  const files = parseUnifiedDiff(DIFF)
  return {
    folder: '/repos/harnu',
    branch: 'bug/57',
    base: 'main',
    // T247 — the immutable half of the snapshot's identity. Present here so the
    // pane's own tests run against the shape the app actually loads.
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
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '1\t1\tsrc/main/reaper/scan-core.ts\n',
      nameStatus: 'M\tsrc/main/reaper/scan-core.ts\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      session: 'done'
    }),
    files,
    truncated: false,
    omittedFiles: [] as string[],
    totalRows: 3,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0
  }
}

const CARD = {
  id: 'BUG-57',
  slug: 'bug-57',
  title: 'Reaper sweep skips force-pushed worktrees',
  status: 'review',
  rawStatus: 'review',
  column: 'review',
  blocked: false,
  evidence: [],
  deps: [],
  kind: 'bug',
  complexity: 'standard',
  priority: 'high',
  provenance: { author: 'human', at: '2026-08-25T00:00:00Z' },
  body: 'A force-push rewrites the head sha.',
  malformed: false
}

describe('AC-10 — Bounce back', () => {
  let appendBody: ReturnType<typeof vi.fn>
  let setStatus: ReturnType<typeof vi.fn>
  let closeCard: ReturnType<typeof vi.fn>
  let calls: string[]

  async function mountPane(): Promise<ReturnType<typeof mount>> {
    const ui = useUiStore()
    const review = useReviewStore()
    const roadmap = useRoadmapStore()
    roadmap.cards = [CARD] as never
    roadmap.folderPath = '/repos/harnu'
    review.snapshot = snapshot() as never
    ui.openReview('/repos/harnu', CARD.slug)
    const wrapper = mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    calls = []
    appendBody = vi.fn(async () => {
      calls.push('append')
      return { ok: true, stampVoided: false }
    })
    setStatus = vi.fn(async (_slug: string, status: string) => {
      calls.push(`status:${status}`)
      return { ok: true }
    })
    closeCard = vi.fn(async () => {
      calls.push('close')
      return { ok: true, epic: false }
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => snapshot(),
      reviewBlastRadius: async () => ({ globs: [] }),
      reviewSetViewed: async (a: { path: string }) => ({
        path: a.path,
        state: 'viewed',
        error: null
      }),
      onReviewBlastRadiusChanged: () => () => {},
      roadmapLoad: async () => ({ repoKey: 'harnu', cards: [CARD] }),
      onRoadmapCardAdded: () => () => {},
      onRoadmapCardChanged: () => () => {},
      onRoadmapCardRemoved: () => () => {}
    }
    // jsdom has no ResizeObserver; the pane measures its own body to decide the
    // ~1000px rail breakpoint. A no-op observer leaves it in the wide layout,
    // which is the one these tests exercise.
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  function patchRoadmap(): void {
    const roadmap = useRoadmapStore()
    roadmap.appendBody = appendBody as never
    roadmap.setStatus = setStatus as never
    roadmap.closeCard = closeCard as never
  }

  it('writes the note FIRST, then returns the card to ready — never done', async () => {
    const wrapper = await mountPane()
    patchRoadmap()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Bounce back')!
      .trigger('click')
    await flushPromises()
    await wrapper.find('textarea').setValue('The AC about the extra gh call is not met.')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Bounce back')!
      .trigger('click')
    await flushPromises()

    expect(calls).toEqual(['append', 'status:ready'])
    expect(appendBody.mock.calls[0][1]).toContain('The AC about the extra gh call is not met.')
    expect(setStatus.mock.calls[0][1]).toBe('ready')
    expect(closeCard).not.toHaveBeenCalled()
  })

  it('does NOT move the card when the note could not be written', async () => {
    appendBody = vi.fn(async () => {
      calls.push('append')
      return { ok: false as const, code: 'write-failed' as const }
    })
    const wrapper = await mountPane()
    patchRoadmap()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Bounce back')!
      .trigger('click')
    await flushPromises()
    await wrapper.find('textarea').setValue('not good enough')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Bounce back')!
      .trigger('click')
    await flushPromises()

    expect(calls).toEqual(['append'])
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('refuses to bounce with an empty note — the note is the whole point', async () => {
    const wrapper = await mountPane()
    patchRoadmap()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Bounce back')!
      .trigger('click')
    await flushPromises()
    const send = wrapper.findAll('button').find((b) => b.text() === 'Bounce back')!
    expect(send.attributes('disabled')).toBeDefined()
    await send.trigger('click')
    await flushPromises()
    expect(calls).toEqual([])
  })

  it('Close goes through roadmap.closeCard and writes no status of its own', async () => {
    const wrapper = await mountPane()
    patchRoadmap()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Close')!
      .trigger('click')
    await flushPromises()

    expect(calls).toEqual(['close'])
    expect(setStatus).not.toHaveBeenCalled()
  })
})

// ── T243 — the viewed mark ─────────────────────────────────────────────────

const VIEWED_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 one
+two
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 one
+two
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 5555555..6666666 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,1 +1,2 @@
 on: push
+  pull_request:
`

const SENSITIVE = '.github/workflows/ci.yml'

function viewedSnapshot(
  files: Record<string, string> = {},
  prNodeId: string | null = null
): ReturnType<typeof buildSnapshot> {
  const parsed = parseUnifiedDiff(VIEWED_DIFF)
  return {
    ...buildSnapshot(),
    files: parsed,
    evidence: assembleEvidence({
      branch: 'bug/57',
      base: 'main',
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '1\t0\tsrc/a.ts\n1\t0\tsrc/b.ts\n1\t0\t.github/workflows/ci.yml\n',
      nameStatus: 'M\tsrc/a.ts\nM\tsrc/b.ts\nM\t.github/workflows/ci.yml\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      blastRadiusGlobs: ['.github/workflows/**']
    }),
    totalRows: 9,
    viewed: { prNodeId, remoteKnown: prNodeId !== null, files }
  } as ReturnType<typeof buildSnapshot>
}

describe('T243 AC-3 — marking is a point patch, never a reload', () => {
  let loads: number
  let setViewedCalls: { path: string; viewed: boolean; prNodeId: string | null }[]
  let snap: ReturnType<typeof viewedSnapshot>

  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    loads = 0
    setViewedCalls = []
    snap = viewedSnapshot({}, 'PR_node_1')
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => {
        loads += 1
        return snap
      },
      reviewBlastRadius: async () => ({ globs: ['.github/workflows/**'] }),
      reviewSetViewed: async (a: { path: string; viewed: boolean; prNodeId: string | null }) => {
        setViewedCalls.push({ path: a.path, viewed: a.viewed, prNodeId: a.prNodeId })
        return { path: a.path, state: a.viewed ? 'viewed' : 'unviewed', error: null }
      },
      onReviewBlastRadiusChanged: () => () => {}
    }
  })

  /**
   * The failure this pins is self-inflicted and total: `load()` re-seeds
   * `expanded` on purpose (a genuinely new diff must not inherit stale
   * overrides), so routing a mark through it would reset every OTHER file's
   * expand/collapse state on every click — the exact "loses their place"
   * problem the mark exists to fix.
   */
  it('does not re-load the snapshot, and leaves every other file untouched', async () => {
    const store = useReviewStore()
    await store.load('/repos/harnu')
    expect(loads).toBe(1)

    // The operator's own overrides, made before any mark.
    store.toggleFile('src/b.ts')
    const before = { ...store.expanded }
    const snapshotIdentity = store.snapshot

    const error = await store.markViewed('src/a.ts', true)

    expect(error).toBeNull()
    expect(loads, 'marking re-loaded the snapshot').toBe(1)
    // The PR node id rides the snapshot, so a mark is ONE round-trip: no
    // second `gh pr list` just to learn which pull request this is.
    expect(setViewedCalls).toEqual([{ path: 'src/a.ts', viewed: true, prNodeId: 'PR_node_1' }])
    expect(store.snapshot, 'the snapshot object was replaced').toBe(snapshotIdentity)
    expect(store.viewedOf('src/a.ts')).toBe('viewed')
    // Only the marked file's own row moved; every other key is byte-identical.
    expect(store.expanded['src/b.ts']).toBe(before['src/b.ts'])
    expect(store.expanded[SENSITIVE]).toBe(before[SENSITIVE])
    expect(store.viewedOf('src/b.ts')).toBe('unviewed')
  })

  it('a mark that could not reach GitHub is returned as an error, not swallowed', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api.reviewSetViewed = async (a: {
      path: string
    }) => ({ path: a.path, state: 'pending', error: 'HTTP 403: Resource not accessible' })
    const store = useReviewStore()
    await store.load('/repos/harnu')

    const error = await store.markViewed('src/a.ts', true)

    expect(error).toContain('403')
    // AC-6: it must not read as synced. `pending` is the state that says so.
    expect(store.viewedOf('src/a.ts')).toBe('pending')
  })
})

describe('T243 AC-7 — the mark never outranks the blast radius', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => viewedSnapshot({ [SENSITIVE]: 'viewed', 'src/a.ts': 'viewed' }),
      reviewBlastRadius: async () => ({ globs: ['.github/workflows/**'] }),
      reviewSetViewed: async (a: { path: string }) => ({
        path: a.path,
        state: 'viewed',
        error: null
      }),
      onReviewBlastRadiusChanged: () => () => {}
    }
  })

  it('a sensitive file that was read still opens expanded; an ordinary one collapses', async () => {
    const store = useReviewStore()
    await store.load('/repos/harnu')
    expect(store.isExpanded(SENSITIVE), 'a read sensitive file was auto-collapsed').toBe(true)
    expect(store.isExpanded('src/a.ts')).toBe(false)
  })

  it('marking a sensitive file read does not collapse it', async () => {
    const store = useReviewStore()
    ;(window as unknown as { api: Record<string, unknown> }).api.reviewLoad = async () =>
      viewedSnapshot({})
    await store.load('/repos/harnu')
    expect(store.isExpanded(SENSITIVE)).toBe(true)

    await store.markViewed(SENSITIVE, true)

    expect(store.isExpanded(SENSITIVE)).toBe(true)
  })

  it('the pane never dims a sensitive file, read or not', () => {
    const pane = readFileSync(join(REPO, 'src/renderer/src/components/ReviewPane.vue'), 'utf8')
    // The one dim in the file box is guarded by `!isSensitive` — the guard, not
    // the styling, is the contract.
    expect(pane).toContain("isRead(file.path) && !isSensitive(file.path) ? 'text-text-3'")
  })
})

describe('T243 AC-8 — no aggregate "all viewed" state exists, at any data combination', () => {
  const COMBINATIONS: Record<string, string>[] = [
    {},
    { 'src/a.ts': 'viewed' },
    { 'src/a.ts': 'viewed', 'src/b.ts': 'pending' },
    { 'src/a.ts': 'viewed', 'src/b.ts': 'viewed' },
    { 'src/a.ts': 'viewed', 'src/b.ts': 'viewed', [SENSITIVE]: 'viewed' },
    { 'src/a.ts': 'dismissed', 'src/b.ts': 'viewed', [SENSITIVE]: 'dismissed' }
  ]

  async function textOutsideFileBoxes(viewed: Record<string, string>): Promise<string> {
    setActivePinia(createPinia())
    // T300/U3: the header (including the Teleport targets every mount here
    // resolves against) now lives outside ReviewPane's own render tree — see
    // `takeover-shell-stub.ts`. `document.body.innerHTML` is reset per call,
    // so these six mounts must run one at a time, not via `Promise.all`
    // (concurrent calls would each wipe the DOM node a sibling call's
    // Teleport is still mounted into).
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => viewedSnapshot(viewed),
      reviewBlastRadius: async () => ({ globs: ['.github/workflows/**'] }),
      reviewSetViewed: async (a: { path: string }) => ({
        path: a.path,
        state: 'viewed',
        error: null
      }),
      onReviewBlastRadiusChanged: () => () => {},
      roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
      onRoadmapCardAdded: () => () => {},
      onRoadmapCardChanged: () => () => {},
      onRoadmapCardRemoved: () => () => {}
    }
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
    useUiStore().openReview('/repos/harnu', '')
    const wrapper = mount(ReviewPane, { global: { plugins: [i18n] } })
    await flushPromises()
    const root = wrapper.element.cloneNode(true) as HTMLElement
    // Every per-file statement lives inside its own `<article>`; an AGGREGATE
    // has nowhere to live but outside them. Removing the boxes is therefore the
    // whole test — whatever survives must not vary with how much was read.
    for (const box of [...root.querySelectorAll('article')]) box.remove()
    const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim()
    wrapper.unmount()
    return text
  }

  /**
   * Verified as a TEST rather than by eye, and that is the point: a plain
   * "7/9" passes a visual check while functioning as exactly the forbidden
   * completion badge. R2 forbids any state that reads as "all clear", and a
   * progress count over a review is the purest form of one.
   */
  it('renders the same chrome whether nothing or everything has been read', async () => {
    const rendered: string[] = []
    for (const combination of COMBINATIONS) rendered.push(await textOutsideFileBoxes(combination))
    for (const [i, text] of rendered.entries()) {
      expect(text, `combination ${i} changed the pane outside its file boxes`).toBe(rendered[0])
    }
  })

  it('renders no n/m progress count anywhere, at any combination', async () => {
    for (const combination of COMBINATIONS) {
      setActivePinia(createPinia())
      stubTakeoverShellTargets()
      ;(window as unknown as { api: Record<string, unknown> }).api = {
        reviewLoad: async () => viewedSnapshot(combination),
        reviewBlastRadius: async () => ({ globs: ['.github/workflows/**'] }),
        reviewSetViewed: async (a: { path: string }) => ({
          path: a.path,
          state: 'viewed',
          error: null
        }),
        onReviewBlastRadiusChanged: () => () => {},
        roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
        onRoadmapCardAdded: () => () => {},
        onRoadmapCardChanged: () => () => {},
        onRoadmapCardRemoved: () => () => {}
      }
      global.ResizeObserver = class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      } as never
      useUiStore().openReview('/repos/harnu', '')
      const wrapper = mount(ReviewPane, { global: { plugins: [i18n] } })
      await flushPromises()
      expect(wrapper.text()).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
      wrapper.unmount()
    }
  })

  it('neither the pane nor its format layer computes a viewed total', () => {
    for (const rel of [
      'src/renderer/src/components/ReviewPane.vue',
      'src/renderer/src/components/review-format.ts'
    ]) {
      const text = readFileSync(join(REPO, rel), 'utf8')
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      expect(code, `${rel} counts viewed files`).not.toMatch(
        /viewed(Count|Total|Progress|Ratio|Summary)|allViewed|everyViewed/i
      )
    }
  })
})

// ── T244 — submitting a review to GitHub ───────────────────────────────────

/**
 * The one path in this pane that WRITES, and the only surface in Harnu that
 * speaks under the operator's own GitHub identity. Everything below pins a way
 * it could stop being trustworthy — an agent reaching it, a verdict submitted
 * without a confirm, approving becoming cheaper than objecting, or a failure
 * rendering as a success.
 */

// ── AC-4 — no agent may reach the submit path ──────────────────────────────

describe('T244 AC-4 — the submit handler is unreachable from the agent surface', () => {
  const WHY = [
    'The review pane submits to GitHub under the OPERATOR’S OWN IDENTITY.',
    'Approving someone’s code is an *accept* door, and Harnu’s zero-friction',
    'principle keeps accept doors shut to everything but a human gesture —',
    'that is the whole reason Harnu can be trusted to dispatch work unattended.',
    'If you are adding an MCP verb for this: do not. Deleting this test is the',
    'gesture that undoes the guarantee, and it is not a formality.'
  ].join('\n')

  it('`review:submitReview` appears in no MCP tool definition', () => {
    const catalog = readFileSync(join(REPO, 'src/main/mcp/tool-catalog.ts'), 'utf8')
    expect(catalog, WHY).not.toContain('review:submitReview')
    expect(catalog, WHY).not.toContain('submitReview')
    expect(catalog.toLowerCase(), WHY).not.toContain('reviewsubmit')
  })

  it('nothing under src/main/mcp reaches the submit seam at all', () => {
    for (const file of walk(join(REPO, 'src/main/mcp'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${relative(REPO, file)} — ${WHY}`).not.toContain('submitReview')
      expect(text, `${relative(REPO, file)} — ${WHY}`).not.toContain('review-submit-core')
      expect(text, `${relative(REPO, file)} — ${WHY}`).not.toContain('gh pr review')
    }
  })

  it('the only registration of the channel is the human-facing IPC handler', () => {
    const hits: string[] = []
    for (const file of walk(join(REPO, 'src/main'))) {
      const text = readFileSync(file, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes("'review:submitReview'")) hits.push(`${relative(REPO, file)}:${i + 1}`)
      }
    }
    expect(hits, `registrations of review:submitReview: ${hits.join(', ')}`).toHaveLength(1)
    expect(hits[0]).toMatch(/^src\/main\/review-ipc\.ts:/)
  })
})

// ── The pane, with a PR to review ──────────────────────────────────────────

const PR_JSON = (over: Record<string, unknown> = {}): string =>
  JSON.stringify([
    {
      number: 244,
      id: 'PR_node_244',
      title: 'Approve from the review pane',
      headRefName: 'bug/57',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: null,
      statusCheckRollup: [],
      url: 'https://github.com/junielton/harnu/pull/244',
      author: { login: 'someone' },
      updatedAt: '2026-08-28T00:00:00Z',
      ...over
    }
  ])

function prSnapshot(prJson = PR_JSON()): ReturnType<typeof buildSnapshot> {
  const base = buildSnapshot()
  return {
    ...base,
    base: 'origin/main',
    head: {
      kind: 'local',
      name: 'bug/57',
      ref: 'bug/57',
      state: 'ready',
      prNumber: 244,
      freshness: 'current',
      sha: 'a'.repeat(40),
      fetchedAt: null,
      fetchFailed: false
    },
    evidence: assembleEvidence({
      branch: 'bug/57',
      base: 'origin/main',
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '1\t1\tsrc/main/reaper/scan-core.ts\n',
      nameStatus: 'M\tsrc/main/reaper/scan-core.ts\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: prJson
    })
  } as ReturnType<typeof buildSnapshot>
}

interface SubmitCall {
  verdict: string
  body: string
  base: string
  headRef: string
  headOid: string | null
  prNumber: number | null
}

function stubApi(
  snap: ReturnType<typeof buildSnapshot>,
  submit: (a: SubmitCall) => unknown,
  calls: SubmitCall[]
): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    reviewLoad: async () => snap,
    reviewBlastRadius: async () => ({ globs: [] }),
    reviewSetViewed: async (a: { path: string }) => ({
      path: a.path,
      state: 'viewed',
      error: null
    }),
    reviewSubmitReview: async (a: SubmitCall) => {
      calls.push(a)
      return submit(a)
    },
    onReviewBlastRadiusChanged: () => () => {},
    roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
    onRoadmapCardAdded: () => () => {},
    onRoadmapCardChanged: () => () => {},
    onRoadmapCardRemoved: () => () => {}
  }
  global.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as never
}

async function mountWithPr(
  snap: ReturnType<typeof buildSnapshot> = prSnapshot(),
  submit: (a: SubmitCall) => unknown = () => ({
    ok: true,
    refusal: null,
    detail: null,
    error: null
  }),
  calls: SubmitCall[] = []
): Promise<ReturnType<typeof mount>> {
  setActivePinia(createPinia())
  stubApi(snap, submit, calls)
  useUiStore().openReview('/repos/harnu', '')
  const wrapper = mount(ReviewPane, { global: { plugins: [i18n], stubs: { Teleport: true } } })
  await flushPromises()
  return wrapper
}

async function openComposer(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper
    .findAll('button')
    .find((b) => b.text() === 'Submit review')!
    .trigger('click')
  await flushPromises()
}

// ── AC-2 / AC-5 — equal prominence, and no inferred verdict ────────────────

describe('T244 AC-2 — the three verdicts are equal, and none is pre-selected', () => {
  /**
   * The disease this whole epic exists to treat: a surface where approving is
   * one click and objecting is three teaches people to approve. Verified
   * structurally rather than by eye, because "they look about the same" is
   * exactly the check that rots.
   */
  it('renders Approve / Request changes / Comment with byte-identical classes', async () => {
    const wrapper = await mountWithPr()
    await openComposer(wrapper)

    const buttons = wrapper
      .findAll('button')
      .filter((b) => ['Approve', 'Request changes', 'Comment'].includes(b.text()))
    expect(buttons.map((b) => b.text())).toEqual(['Approve', 'Request changes', 'Comment'])

    const classes = buttons.map((b) => b.attributes('class'))
    expect(
      new Set(classes).size,
      `the three verdicts differ visually: ${classes.join(' | ')}`
    ).toBe(1)
    // No accent fill, no bolder weight, no primary treatment on any of them.
    expect(classes[0]).not.toMatch(/bg-accent|font-semibold/)
    // None is pre-selected: `aria-pressed`/`data-selected` would be the shapes
    // a default takes, and there is no default.
    for (const b of buttons) {
      expect(b.attributes('aria-pressed')).toBeUndefined()
      expect(b.attributes('data-selected')).toBeUndefined()
    }
    wrapper.unmount()
  })

  it('all three cost the same: open, type, pick, confirm — no shortcut on any', async () => {
    for (const label of ['Approve', 'Request changes', 'Comment']) {
      const calls: SubmitCall[] = []
      const wrapper = await mountWithPr(prSnapshot(), () => ({ ok: true }), calls)
      await openComposer(wrapper)
      await wrapper.find('textarea#review-verdict-body').setValue('I read the whole diff.')
      await wrapper
        .findAll('button')
        .find((b) => b.text() === label)!
        .trigger('click')
      await flushPromises()
      // The verdict click opened a confirm and submitted nothing (AC-3).
      expect(calls, `${label} submitted without a confirm`).toEqual([])
      wrapper.unmount()
    }
  })
})

describe('T244 AC-5 — no affordance recommends, pre-fills or gates a verdict', () => {
  const CI_STATES = [
    { statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'COMPLETED' }] },
    { statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'FAILURE', status: 'COMPLETED' }] },
    { statusCheckRollup: [] },
    { reviewDecision: 'APPROVED' },
    { reviewDecision: 'CHANGES_REQUESTED' },
    { isDraft: true }
  ]

  /**
   * R1 with more force than anywhere else in the pane: the evidence header
   * states facts, the human draws the conclusion, the tool carries it. Approve
   * is neither disabled by red checks (which would read as the tool having an
   * opinion) nor encouraged by green ones (which would read as endorsement).
   */
  it('renders the same three controls under every CI and review state', async () => {
    const renders: string[] = []
    for (const over of CI_STATES) {
      const wrapper = await mountWithPr(prSnapshot(PR_JSON(over)))
      await openComposer(wrapper)
      const buttons = wrapper
        .findAll('button')
        .filter((b) => ['Approve', 'Request changes', 'Comment'].includes(b.text()))
      renders.push(
        buttons
          .map((b) => `${b.text()}|${b.attributes('class')}|${b.attributes('disabled')}`)
          .join()
      )
      wrapper.unmount()
    }
    for (const [i, r] of renders.entries()) {
      expect(r, `CI/review state ${i} changed the verdict controls`).toBe(renders[0])
    }
  })

  it('the body starts empty — nothing is pre-filled for the operator', async () => {
    const wrapper = await mountWithPr()
    await openComposer(wrapper)
    expect(
      (wrapper.find('textarea#review-verdict-body').element as HTMLTextAreaElement).value
    ).toBe('')
    wrapper.unmount()
  })

  it('the pane derives no verdict from CI, checks or the review decision', () => {
    const pane = readFileSync(join(REPO, 'src/renderer/src/components/ReviewPane.vue'), 'utf8')
    const code = pane
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    // A verdict that reads `ci`/`reviewDecision` is a recommendation, whatever
    // it is called. The submit block must not be able to see them at all.
    const submitBlock = code.slice(
      code.indexOf('const pendingVerdict'),
      code.indexOf('// ── Lifecycle')
    )
    for (const forbidden of ['ci', 'reviewDecision', 'mergeable', 'statusCheck']) {
      expect(submitBlock, `the submit path reads ${forbidden}`).not.toMatch(
        new RegExp(`\\.${forbidden}\\b`, 'i')
      )
    }
  })
})

// ── AC-3 / AC-7 / AC-8 — the confirm, the absence, the failure ─────────────

describe('T244 AC-7 — with no PR the affordance is absent, not inert', () => {
  it('renders no submit control at all when there is no pull request', async () => {
    // `prListJson: '[]'` is the no-gh / no-PR shape the base snapshot carries.
    const wrapper = await mountWithPr(buildSnapshot() as never)
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Submit review')
    expect(wrapper.find('textarea#review-verdict-body').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('T244 AC-3 — a confirm precedes every submission', () => {
  it('names the verdict, the repo and the PR number before anything is sent', async () => {
    const calls: SubmitCall[] = []
    const wrapper = await mountWithPr(prSnapshot(), () => ({ ok: true }), calls)
    await openComposer(wrapper)
    await wrapper.find('textarea#review-verdict-body').setValue('Looks right to me.')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Approve')!
      .trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists(), 'no confirm was shown').toBe(true)
    const text = dialog.text()
    expect(text).toContain('Approve')
    expect(text).toContain('junielton/harnu')
    expect(text).toContain('#244')
    // §1.2 — the copy-paste boundary, said out loud at the one moment where
    // saying it changes what someone does next. Pinned against the locale file
    // itself so a reworded sentence still has to carry the point.
    const boundary = ((en as Record<string, unknown>).review as Record<string, string>)
      .confirmBoundary
    expect(boundary.toLowerCase()).toContain('identity')
    expect(text.replace(/\s+/g, ' ')).toContain(boundary)
    expect(calls).toEqual([])
    wrapper.unmount()
  })

  it('submits only from the confirm, carrying the pinned base and head', async () => {
    const calls: SubmitCall[] = []
    const wrapper = await mountWithPr(
      prSnapshot(),
      () => ({ ok: true, refusal: null, detail: null, error: null }),
      calls
    )
    await openComposer(wrapper)
    await wrapper.find('textarea#review-verdict-body').setValue('The guard is where it should be.')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Request changes')!
      .trigger('click')
    await flushPromises()
    await wrapper
      .find('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text().startsWith('Submit'))!
      .trigger('click')
    await flushPromises()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      verdict: 'request-changes',
      prNumber: 244,
      body: 'The guard is where it should be.',
      // What the operator READ, not what the branch says now: main re-reads the
      // live values and refuses when the two disagree.
      base: 'origin/main',
      headRef: 'bug/57',
      headOid: 'a'.repeat(40)
    })
    wrapper.unmount()
  })

  it('dismissing the confirm submits nothing and keeps the prose', async () => {
    const calls: SubmitCall[] = []
    const wrapper = await mountWithPr(prSnapshot(), () => ({ ok: true }), calls)
    await openComposer(wrapper)
    await wrapper.find('textarea#review-verdict-body').setValue('Not yet.')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Approve')!
      .trigger('click')
    await flushPromises()
    await wrapper
      .find('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click')
    await flushPromises()

    expect(calls).toEqual([])
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(
      (wrapper.find('textarea#review-verdict-body').element as HTMLTextAreaElement).value
    ).toBe('Not yet.')
    wrapper.unmount()
  })
})

describe('T244 AC-8 — a failure is told, and never renders as submitted', () => {
  /**
   * An approval the operator believes happened and did not is strictly worse
   * than a visible error: they stop watching a PR that is still blocked, or
   * they tell someone it is unblocked when it is not.
   */
  const FAILURES = [
    {
      name: 'a guard refusal (the head moved under the diff)',
      result: { ok: false, refusal: 'head-moved', detail: 'aaaaaaa → bbbbbbb', error: null },
      expect: 'moved'
    },
    {
      name: 'a gh failure, surfaced verbatim',
      result: {
        ok: false,
        refusal: null,
        detail: null,
        error: 'GraphQL: Can not approve your own pull request (addPullRequestReview)'
      },
      expect: 'approve your own pull request'
    }
  ]

  for (const failure of FAILURES) {
    it(`surfaces ${failure.name} and keeps the composer open`, async () => {
      const calls: SubmitCall[] = []
      const wrapper = await mountWithPr(prSnapshot(), () => failure.result, calls)
      const ui = useUiStore()
      const toasts: unknown[] = []
      ui.pushToast = ((toast: unknown) => {
        toasts.push(toast)
      }) as never

      await openComposer(wrapper)
      await wrapper.find('textarea#review-verdict-body').setValue('Read it all.')
      await wrapper
        .findAll('button')
        .find((b) => b.text() === 'Approve')!
        .trigger('click')
      await flushPromises()
      await wrapper
        .find('[role="dialog"]')
        .findAll('button')
        .find((b) => b.text().startsWith('Submit'))!
        .trigger('click')
      await flushPromises()

      expect(calls).toHaveLength(1)
      expect(toasts).toHaveLength(1)
      expect(toasts[0]).toMatchObject({ kind: 'danger' })
      expect(JSON.stringify(toasts[0])).toContain(failure.expect)
      // The prose survives, so the operator can fix and retry rather than retype.
      const box = wrapper.find('textarea#review-verdict-body')
      expect(box.exists(), 'the composer closed on a failure').toBe(true)
      expect((box.element as HTMLTextAreaElement).value).toBe('Read it all.')
      wrapper.unmount()
    })
  }

  it('a success closes the composer and says which verdict went out', async () => {
    const wrapper = await mountWithPr(prSnapshot(), () => ({
      ok: true,
      refusal: null,
      detail: null,
      error: null
    }))
    const ui = useUiStore()
    const toasts: Record<string, unknown>[] = []
    ui.pushToast = ((toast: Record<string, unknown>) => {
      toasts.push(toast)
    }) as never

    await openComposer(wrapper)
    await wrapper.find('textarea#review-verdict-body').setValue('Read it all.')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Comment')!
      .trigger('click')
    await flushPromises()
    await wrapper
      .find('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text().startsWith('Submit'))!
      .trigger('click')
    await flushPromises()

    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('success')
    expect(String(toasts[0].title)).toContain('#244')
    expect(wrapper.find('textarea#review-verdict-body').exists()).toBe(false)
    wrapper.unmount()
  })
})
