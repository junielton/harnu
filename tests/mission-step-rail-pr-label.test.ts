// @vitest-environment jsdom
/**
 * BUG-273 — the PR line of a mission step rail row must always print a human label.
 * A draft PR used to ask for `mission.pr.state.isDraft`, a key that does not exist
 * (the locale files carry `draft`), so the rail printed the raw key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionStepRail from '../src/renderer/src/components/MissionStepRail.vue'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import type { MissionStepSignals } from '../src/main/mcp/tool-handlers'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const pr = (number: number, state: string, isDraft = false) => ({
  number,
  title: `PR ${number}`,
  state,
  isDraft,
  ci: 'passing',
  url: `https://example.test/pull/${number}`,
  baseRefName: 'main'
})

/** Mount the real rail for a mission whose current step reaches the given PRs. */
function mountRail(prs: unknown[]): ReturnType<typeof mount> {
  const base = fixtureView('faq-like')
  const counted = base.mission.steps.filter((s) => base.progress.states[s.id] !== undefined)
  const currentId = counted[base.progress.current!.from - 1].id
  const links = [
    {
      kind: 'worktree',
      ref: '/wt',
      exists: true,
      branch: 'card/x',
      head: { sha: 'a', subject: 's', at: new Date(FIXTURE_NOW).toISOString() },
      commits: 1,
      prs
    } as MissionStepSignals['links'][number]
  ]
  const view = fixtureView('faq-like', { derivedStep: { [currentId]: { links } } })
  const model = buildMissionModel(view, FIXTURE_NOW)
  return mount(MissionStepRail, {
    props: { view, model, busy: false },
    global: { plugins: [i18n] }
  })
}

const prLines = (w: ReturnType<typeof mount>, n: number): string =>
  w.get(`[data-test="mission-pr"][data-pr="${n}"]`).text()

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  i18n.global.locale.value = 'en'
})

describe('mission step rail — PR label', () => {
  it('reads "PR #n · draft" for a draft pull request, never a raw key', () => {
    const w = mountRail([pr(7, 'OPEN', true)])
    expect(prLines(w, 7)).toContain('PR #7 · draft')
    expect(w.text()).not.toContain('mission.pr.state')
  })

  it('reads the Portuguese counterpart for a draft pull request', () => {
    i18n.global.locale.value = 'pt-BR'
    const w = mountRail([pr(7, 'OPEN', true)])
    expect(prLines(w, 7)).toContain('PR #7 · rascunho')
    expect(w.text()).not.toContain('mission.pr.state')
  })

  it('prints no raw mission.pr.* key for open, draft or merged', () => {
    for (const locale of ['en', 'pt-BR'] as const) {
      i18n.global.locale.value = locale
      const w = mountRail([pr(9, 'MERGED'), pr(8, 'OPEN'), pr(7, 'OPEN', true)])
      expect(w.text()).not.toMatch(/mission\.pr\./)
      expect(prLines(w, 8)).toContain(locale === 'en' ? 'open' : 'aberta')
      expect(prLines(w, 9)).toContain(locale === 'en' ? 'merged' : 'mergeada')
    }
  })
})
