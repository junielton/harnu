import { vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../../src/renderer/src/components/ReviewPane.vue'
import { useUiStore } from '../../src/renderer/src/stores/ui'
import { useReviewStore } from '../../src/renderer/src/stores/review'
import { assembleEvidence, parseUnifiedDiff } from '../../src/main/review-core'
import { stubTakeoverShellTargets } from './takeover-shell-stub'

/**
 * T257 U1 — one diff that exercises every selection shape: two hunks in one
 * file (a clamp edge), a mixed delete+add change block, a rename, a deletion
 * and a binary.
 */
export const SELECTION_DIFF = `diff --git a/src/main/speech.ts b/src/main/speech.ts
index 1111111..2222222 100644
--- a/src/main/speech.ts
+++ b/src/main/speech.ts
@@ -10,5 +10,6 @@ function speak() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
 const e = 6
@@ -40,4 +41,4 @@ function stop() {
 const f = 7
-const g = 8
+const g = 9
 const h = 10
 const i = 11
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index 3333333..4444444 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,2 +1,2 @@
 export const x = 1
-export const y = 2
+export const y = 3
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 5555555..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = 1
-export const gone2 = 2
diff --git a/brand/logo.png b/brand/logo.png
index 6666666..7777777 100644
Binary files a/brand/logo.png and b/brand/logo.png differ
`

export const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const HEAD_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432'
export const MOVED_SHA = 'e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d'

/** A `ReviewSnapshot`-shaped object, loose on purpose (the pane reads a subset). */
export function selectionSnapshot(over: Record<string, unknown> = {}): never {
  return {
    folder: '/repos/harnu',
    branch: 'feat/x',
    base: 'main',
    baseSha: BASE_SHA,
    head: {
      kind: 'branch',
      state: 'ready',
      ref: 'feat/x',
      name: 'feat/x',
      sha: HEAD_SHA,
      prNumber: null,
      freshness: 'current',
      fetchedAt: null,
      fetchFailed: false
    },
    isRepo: true,
    evidence: assembleEvidence({
      branch: 'feat/x',
      base: 'main',
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '2\t1\tsrc/main/speech.ts\n',
      nameStatus: 'M\tsrc/main/speech.ts\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      session: 'done'
    }),
    files: parseUnifiedDiff(SELECTION_DIFF),
    truncated: false,
    omittedFiles: [] as string[],
    totalRows: 12,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0,
    ...over
  } as never
}

export function stubReviewApi(): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    reviewLoad: async () => selectionSnapshot(),
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
    onRoadmapCardRemoved: () => () => {}
  }
  global.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as never
}

export async function mountSelectionPane(): Promise<ReturnType<typeof mount>> {
  stubTakeoverShellTargets()
  const ui = useUiStore()
  const review = useReviewStore()
  review.snapshot = selectionSnapshot()
  ui.openReview('/repos/harnu')
  const wrapper = mount(ReviewPane, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  // Everything open: the auto-expand rule is not what these tests are about.
  review.expanded = Object.fromEntries(review.snapshot!.files.map((f) => [f.path, true]))
  await flushPromises()
  return wrapper
}
