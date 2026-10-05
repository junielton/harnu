// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import CleanupTimeline from '../src/renderer/src/components/CleanupTimeline.vue'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import {
  classify,
  type BranchFacts,
  type Checkpoint,
  type PrFacts
} from '../src/main/reaper/reaper-core'

/**
 * BUG-127: an uncorroborated upstream PR is kept out of the verdict (BUG-93),
 * and must also be kept out of the timeline's *unqualified* greens. These mount
 * the real component over the real classifier's output.
 */
const NOW = 1_800_000_000_000

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 59,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: '2026-07-01T00:00:00Z',
    headRefOid: 'ownersha',
    ...over
  }
}

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: '/repo',
    branch: 'feat/sibling',
    path: '/repo/.claude/worktrees/feat-sibling',
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: null,
    patchIdContained: null,
    lastCommitAt: NOW,
    pr: pr(),
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name',
    ...over
  }
}

/** The BUG-93 sibling: shares one upstream with the branch that owns merged PR #59. */
const SIBLING = classify(
  facts({
    prProvenance: 'upstream-unverified',
    ancestorOfDefault: false,
    patchIdContained: false,
    unpushed: true
  }),
  NOW
).checkpoints
const OWN = classify(facts({ pr: pr({ number: 92 }) }), NOW).checkpoints

const LABEL: Record<Checkpoint['id'], string> = {
  pr: en.cleanup.checkpoint.pr,
  review: en.cleanup.checkpoint.review,
  ci: en.cleanup.checkpoint.ci,
  'pr-merged': en.cleanup.checkpoint.prMerged,
  'in-main': en.cleanup.checkpoint.inMain,
  'remote-gone': en.cleanup.checkpoint.remoteGone,
  'local-clean': en.cleanup.checkpoint.localClean
}

function render(checkpoints: Checkpoint[]) {
  return mount(CleanupTimeline, { props: { checkpoints }, global: { plugins: [i18n] } })
}
type Wrapper = ReturnType<typeof render>
const dots = (w: Wrapper) => w.findAll('div.z-10')
const labels = (w: Wrapper) => w.findAll('span')
/** The connector leading INTO column `i` (column 0 has none). */
const connector = (w: Wrapper, i: number) => w.findAll('div.grid > div')[i].find('div.absolute')

afterEach(() => {
  i18n.global.locale.value = 'en'
})

describe('CleanupTimeline — an uncorroborated upstream PR (BUG-127)', () => {
  it('AC-1: never paints pr-merged — or any PR-backed dot — as the solid green', () => {
    const w = render(SIBLING)
    const merged = dots(w)[3]
    expect(merged.classes()).not.toContain('bg-green')
    expect(merged.classes()).toContain('border-green')
    for (const i of [0, 1, 2, 3]) expect(dots(w)[i].classes()).not.toContain('bg-green')
    // …and the chain into it is not drawn as this branch's green either.
    expect(connector(w, 3).classes()).not.toContain('bg-green/55')
  })

  it('AC-2: names the provenance on the row — label and tooltip', () => {
    const w = render(SIBLING)
    const via = en.cleanup.checkpoint.viaUpstream
    expect(labels(w)[0].text()).toBe(en.cleanup.checkpoint.prViaUpstream)
    expect(dots(w)[0].attributes('title')).toBe(`#59 — ${via}`)
    expect(dots(w)[3].attributes('title')).toBe(`2026-07-01T00:00:00Z — ${via}`)
    // A PR-backed dot with no detail of its own still says whose fact it shows.
    expect(dots(w)[1].attributes('title')).toBe(via)
  })

  it('leaves the checkpoints that are not about the PR untouched', () => {
    const w = render(SIBLING)
    expect(labels(w)[4].text()).toBe(LABEL['in-main'])
    expect(dots(w)[4].attributes('title')).toBe(SIBLING[4].detail)
    // The sibling's own facts keep their solid fill: remote-gone green, and
    // local-clean red (it carries unpushed commits).
    expect(dots(w)[5].classes()).toContain('bg-green')
    expect(connector(w, 5).classes()).toContain('bg-green/55')
    expect(dots(w)[6].classes()).toContain('bg-red')
  })

  it('AC-3: renders a PR resolved by the branch own name exactly as before', () => {
    const w = render(OWN)
    OWN.forEach((cp, i) => {
      expect(labels(w)[i].text()).toBe(LABEL[cp.id])
      expect(dots(w)[i].attributes('title')).toBe(cp.detail)
      expect(dots(w)[i].classes()).toEqual(
        expect.arrayContaining(['border-green', 'bg-green', 'text-bg'])
      )
      if (i > 0) expect(connector(w, i).classes()).toContain('bg-green/55')
    })
    expect(dots(w)[0].attributes('title')).toBe('#92')
  })
})

describe('CleanupTimeline — upstream provenance copy (AC-5)', () => {
  it('uses the key names design.md fixes, present in both locales', () => {
    const design = readFileSync(resolve(__dirname, '../design.md'), 'utf8')
    for (const key of ['prViaUpstream', 'viaUpstream'] as const) {
      expect(design).toContain(`cleanup.checkpoint.${key}`)
      expect(en.cleanup.checkpoint[key]).toBeTruthy()
      expect(ptBR.cleanup.checkpoint[key]).toBeTruthy()
    }
  })

  it('renders the pt-BR wording under pt-BR', () => {
    i18n.global.locale.value = 'pt-BR'
    const w = render(SIBLING)
    expect(labels(w)[0].text()).toBe(ptBR.cleanup.checkpoint.prViaUpstream)
    expect(dots(w)[1].attributes('title')).toBe(ptBR.cleanup.checkpoint.viaUpstream)
  })
})
