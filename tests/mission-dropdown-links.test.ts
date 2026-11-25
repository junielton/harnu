// @vitest-environment jsdom
/**
 * Mission dropdown · S-4 · AC-14 (card BUG-288) — the "Links" block of an open step: every link opens something
 * real, a worktree reads as its branch name, the evidence is one "Evidence" link, a path has a copy button and is
 * never drawn, and a link that opens nothing is not drawn (design.md §6 "Mission dropdown" → "What it draws" 4;
 * mockup `docs/design/mission-dropdown/`, states `step-open` and `blocked`).
 *
 * The pure rules (`lib/mission-dropdown-links.ts`) are pinned first, then the component is mounted against the
 * real stores with `window.api` faked: what each link draws and what a click does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionDropdownStep from '../src/renderer/src/components/MissionDropdownStep.vue'
import {
  dropdownLinks,
  isAbsolutePath,
  pathsToProbe,
  type KnownFolder
} from '../src/renderer/src/lib/mission-dropdown-links'
import { stepLinkRows, type PaneStepRow } from '../src/renderer/src/lib/mission-pane-view'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

// Neutral shapes (CLAUDE.md "Client confidentiality"): `/home/dev/acme/web` is the repo, its worktrees live
// under `.claude/worktrees`.
const REPO = '/home/dev/acme/web'
const WT = `${REPO}/.claude/worktrees/card-score-proofs`
const WT2 = `${REPO}/.claude/worktrees/card-score-slices`
const EVIDENCE_DIR = `${REPO}/.harnu/out/score-proofs`
const EVIDENCE_FILE = `${REPO}/.harnu/out/score-proofs/report.md`
const PR = 'https://git.example/acme/web/pull/21'

type Raw = { kind: 'pr' | 'url' | 'doc' | 'worktree' | 'session'; ref: string }

const folder = (path: string, over: Partial<KnownFolder> = {}): KnownFolder => ({
  path,
  gitBranch: null,
  pinned: true,
  ...over
})

describe('the pure rules', () => {
  it('knows an absolute path from anything else', () => {
    expect(isAbsolutePath('/home/dev/acme/web')).toBe(true)
    expect(isAbsolutePath('C:\\work\\acme')).toBe(true)
    expect(isAbsolutePath('docs/x.md')).toBe(false)
    expect(isAbsolutePath('https://git.example/x')).toBe(false)
  })

  it('label and click target of each link kind', () => {
    const raw: Raw[] = [
      { kind: 'pr', ref: PR },
      { kind: 'worktree', ref: WT },
      { kind: 'worktree', ref: WT2 },
      { kind: 'worktree', ref: `${REPO}/.claude/worktrees/card-gone` },
      { kind: 'doc', ref: EVIDENCE_DIR },
      { kind: 'url', ref: 'http://localhost:5173/score-report' },
      { kind: 'url', ref: 'https://tracker.example/task/412' }
    ]
    const out = dropdownLinks({
      rows: stepLinkRows(raw, []),
      raw,
      folders: [
        folder(WT, { gitBranch: 'card/score-proofs' }),
        folder(WT2, { pinned: false, gitBranch: 'card/score-slices' })
      ],
      kinds: {
        [WT]: 'dir',
        [WT2]: 'dir',
        [`${REPO}/.claude/worktrees/card-gone`]: 'missing',
        [EVIDENCE_DIR]: 'dir',
        [`${EVIDENCE_DIR}/README.md`]: 'file'
      },
      root: REPO
    })
    const byKind = (k: string) => out.filter((l) => l.kind === k)

    // The pull request: a link to its address, first.
    expect(out[0]).toMatchObject({ kind: 'pr', label: '#21', url: PR })

    // A worktree reads as its branch name, resolved from the folder at that path; with no folder known, the last
    // path segment. A click selects a pinned folder and offers to add one that is not pinned.
    const wts = byKind('worktree')
    expect(wts.map((l) => l.label)).toEqual(['card/score-proofs', 'card/score-slices', 'card-gone'])
    expect(wts[0]).toMatchObject({ path: WT, action: 'select', removed: false })
    expect(wts[1]).toMatchObject({ path: WT2, action: 'offer-add', removed: false })
    // A path that no longer exists stays readable, opens nothing, and still offers its copy.
    expect(wts[2]).toMatchObject({ removed: true, action: 'none' })
    // Never an absolute path as a label; a tooltip may hold a repo-relative one.
    for (const l of wts) expect(l.label.startsWith('/')).toBe(false)
    expect(wts[0].relPath).toBe('.claude/worktrees/card-score-proofs')

    // The evidence: ONE "Evidence" link; a folder opens its README in the viewer.
    const ev = byKind('evidence')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      path: EVIDENCE_DIR,
      target: `${EVIDENCE_DIR}/README.md`,
      relPath: '.harnu/out/score-proofs'
    })

    // An address on this machine opens as before; so does any other address.
    expect(byKind('page')[0]).toMatchObject({
      label: 'localhost:5173/score-report',
      url: 'http://localhost:5173/score-report'
    })
    expect(byKind('link')[0]).toMatchObject({ url: 'https://tracker.example/task/412' })
  })

  it('the evidence file is opened itself; a folder with no README, a missing path or an unchecked one is not drawn', () => {
    const ev = (kinds: Record<string, 'file' | 'dir' | 'missing'>, ref = EVIDENCE_FILE) =>
      dropdownLinks({
        rows: [],
        raw: [{ kind: 'doc', ref }],
        folders: [],
        kinds,
        root: REPO
      }).filter((l) => l.kind === 'evidence')
    expect(ev({ [EVIDENCE_FILE]: 'file' })[0]).toMatchObject({ target: EVIDENCE_FILE })
    expect(
      ev({ [EVIDENCE_DIR]: 'dir', [`${EVIDENCE_DIR}/README.md`]: 'missing' }, EVIDENCE_DIR)
    ).toHaveLength(0)
    expect(ev({ [EVIDENCE_FILE]: 'missing' })).toHaveLength(0)
    expect(ev({})).toHaveLength(0)
    // A repo-relative path is read against the folder the step belongs to.
    expect(ev({ [`${REPO}/docs/report.md`]: 'file' }, 'docs/report.md')[0]).toMatchObject({
      target: `${REPO}/docs/report.md`
    })
  })

  it('several evidence paths are still one link: the first one that opens something', () => {
    const a = `${REPO}/.harnu/out/a`
    const b = `${REPO}/.harnu/out/b`
    const out = dropdownLinks({
      rows: [],
      raw: [
        { kind: 'doc', ref: a },
        { kind: 'doc', ref: b }
      ],
      folders: [],
      kinds: { [a]: 'missing', [b]: 'dir', [`${b}/README.md`]: 'file' },
      root: REPO
    }).filter((l) => l.kind === 'evidence')
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe(b)
  })

  it('a link that opens nothing is not drawn: a pull request with no address, a repo path that is not evidence, a session', () => {
    const raw: Raw[] = [
      { kind: 'pr', ref: '412' },
      { kind: 'url', ref: 'not an address' },
      { kind: 'worktree', ref: 'relative/worktree' },
      { kind: 'session', ref: 'S1' }
    ]
    expect(
      dropdownLinks({ rows: stepLinkRows(raw, []), raw, folders: [], kinds: {}, root: REPO })
    ).toEqual([])
  })

  it('asks the disk about the worktrees and the evidence, and the README of an evidence folder, once each', () => {
    const raw: Raw[] = [
      { kind: 'worktree', ref: WT },
      { kind: 'worktree', ref: WT },
      { kind: 'doc', ref: EVIDENCE_DIR },
      { kind: 'doc', ref: 'https://tracker.example/doc' },
      { kind: 'pr', ref: '21' }
    ]
    expect(pathsToProbe(raw, REPO).sort()).toEqual(
      [WT, EVIDENCE_DIR, `${EVIDENCE_DIR}/README.md`].sort()
    )
    expect(pathsToProbe([], REPO)).toEqual([])
  })
})

// ---- the component -----------------------------------------------------------------------------------------

let wrapper: VueWrapper | null = null
let kinds: Record<string, 'file' | 'dir' | 'missing'>
let openExternal: ReturnType<typeof vi.fn>
let probe: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

const stepOf = (raw: Raw[]): PaneStepRow =>
  ({
    id: 'stp-1',
    title: 'Score the proofs',
    state: 'waiting-review',
    blocked: false,
    needsYou: false,
    pr: null,
    criteria: [],
    prUrl: null,
    verified: 0,
    open: [],
    blockers: [],
    links: stepLinkRows(raw, [])
  }) as PaneStepRow

async function mountLinks(
  raw: Raw[],
  folders: Array<Record<string, unknown>> = [],
  parentClick?: () => void
): Promise<VueWrapper> {
  openExternal = vi.fn(async () => undefined)
  probe = vi.fn(async (paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, kinds[p] ?? 'missing']))
  )
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  ;(window as unknown as { api: unknown }).api = {
    shellOpenExternal: openExternal,
    missionPathKinds: probe,
    missionV4Door: vi.fn(async () => ({ ok: true, changed: true })),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: REPO, sessions: [{ sessionId: 'S1', projectPath: REPO }] },
    ...folders
  ] as never
  sessions.select('S1')
  const w = mount(
    {
      components: { MissionDropdownStep },
      props: ['step', 'raw'],
      template: `<div data-test="host" @click="onClick"><MissionDropdownStep :step="step" :raw-links="raw" /></div>`,
      methods: { onClick: () => parentClick?.() }
    },
    {
      props: { step: stepOf(raw), raw },
      global: { plugins: [i18n] },
      attachTo: document.body
    }
  )
  wrapper = w
  await flushPromises()
  // Links are closed by default (T810): every case below reads them open.
  const toggle = w.find('[data-test="links-toggle"]')
  if (toggle.exists()) await toggle.trigger('click')
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  kinds = {}
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const links = (w: VueWrapper) => w.findAll('[data-test="step-link"]')
const kindOf = (w: VueWrapper, k: string) => w.findAll(`[data-test="step-link"][data-kind="${k}"]`)

describe('links are folded behind their count (T810)', () => {
  it('are closed by default under "Links · N", and a button (Enter, Space, click) opens and closes them', async () => {
    const w = await mountLinks([
      { kind: 'pr', ref: PR },
      { kind: 'url', ref: 'http://localhost:5173/score-report' }
    ])
    const toggle = w.get('[data-test="links-toggle"]')
    // `mountLinks` opened it: close it again and read the closed state.
    await toggle.trigger('click')
    // A native <button>: Enter and Space press it with no key handler of our own.
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('type')).toBe('button')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toBe('Links · 2')
    expect(links(w)).toHaveLength(0)
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(links(w)).toHaveLength(2)
  })
})

describe('label and click target of each link kind', () => {
  it('the pull request opens its address and never toggles the step', async () => {
    const onParent = vi.fn()
    const w = await mountLinks([{ kind: 'pr', ref: PR }], [], onParent)
    onParent.mockClear() // opening the links was a click of its own
    const pr = kindOf(w, 'pr')
    expect(pr).toHaveLength(1)
    expect(pr[0].text()).toBe('#21')
    expect(pr[0].attributes('role')).toBe('link')
    await pr[0].trigger('click')
    expect(openExternal).toHaveBeenCalledWith(PR)
    expect(onParent).not.toHaveBeenCalled()
  })

  it('a worktree is its branch name, and a click selects the folder in the sidebar', async () => {
    kinds = { [WT]: 'dir' }
    const w = await mountLinks(
      [{ kind: 'worktree', ref: WT }],
      [{ path: WT, pinned: true, gitBranch: 'card/score-proofs', sessions: [] }]
    )
    const sessions = useSessionsStore()
    const select = vi.spyOn(sessions, 'selectFolder')
    const wt = kindOf(w, 'worktree')
    expect(wt).toHaveLength(1)
    expect(wt[0].text()).toContain('card/score-proofs')
    await wt[0].get('[data-test="link-open"]').trigger('click')
    expect(select).toHaveBeenCalledWith(WT)
  })

  it('a worktree whose folder is not known reads as its last path segment', async () => {
    kinds = { [WT]: 'dir' }
    const w = await mountLinks([{ kind: 'worktree', ref: WT }])
    expect(kindOf(w, 'worktree')[0].text()).toContain('card-score-proofs')
  })

  it('a click on a worktree that is not pinned offers to add it, and adding selects it', async () => {
    kinds = { [WT]: 'dir' }
    const w = await mountLinks(
      [{ kind: 'worktree', ref: WT }],
      [{ path: WT, pinned: false, gitBranch: 'card/score-proofs', sessions: [] }]
    )
    const sessions = useSessionsStore()
    const select = vi.spyOn(sessions, 'selectFolder')
    const pin = vi.spyOn(sessions, 'pinFolder').mockResolvedValue(undefined)
    await w.get('[data-test="link-open"]').trigger('click')
    expect(select).not.toHaveBeenCalled()
    expect(w.find('[data-test="link-add-offer"]').exists()).toBe(true)
    expect(w.get('[data-test="link-add-offer"]').text()).toContain(
      enMessages.missionDropdown.step.addOffer
    )
    await w.get('[data-test="link-add"]').trigger('click')
    await flushPromises()
    expect(pin).toHaveBeenCalledWith(WT)
    expect(select).toHaveBeenCalledWith(WT)
    expect(w.find('[data-test="link-add-offer"]').exists()).toBe(false)
  })

  it('the offer can be declined and adds nothing', async () => {
    kinds = { [WT]: 'dir' }
    const w = await mountLinks([{ kind: 'worktree', ref: WT }])
    const sessions = useSessionsStore()
    const pin = vi.spyOn(sessions, 'pinFolder').mockResolvedValue(undefined)
    await w.get('[data-test="link-open"]').trigger('click')
    await w.get('[data-test="link-add-cancel"]').trigger('click')
    expect(pin).not.toHaveBeenCalled()
    expect(w.find('[data-test="link-add-offer"]').exists()).toBe(false)
  })

  it('a worktree that no longer exists says "removed — branch kept", stays readable and opens nothing', async () => {
    kinds = { [WT]: 'missing' }
    const w = await mountLinks(
      [{ kind: 'worktree', ref: WT }],
      [{ path: WT, pinned: true, gitBranch: 'card/score-proofs', sessions: [] }]
    )
    const sessions = useSessionsStore()
    const select = vi.spyOn(sessions, 'selectFolder')
    const wt = kindOf(w, 'worktree')[0]
    expect(wt.text()).toContain('card/score-proofs')
    expect(wt.text()).toContain(enMessages.missionDropdown.step.removed)
    expect(enMessages.missionDropdown.step.removed).toBe('removed — branch kept')
    expect(wt.find('[data-test="link-open"]').exists()).toBe(false)
    // The text is selectable, and the path is still copyable.
    expect(wt.find('[data-test="link-label"]').classes()).toContain('select-text')
    await wt.get('[data-test="link-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(WT)
    expect(select).not.toHaveBeenCalled()
  })

  it('the evidence is one "Evidence" link that opens its README in the viewer pane', async () => {
    kinds = { [EVIDENCE_DIR]: 'dir', [`${EVIDENCE_DIR}/README.md`]: 'file' }
    const w = await mountLinks([{ kind: 'doc', ref: EVIDENCE_DIR }])
    const helpers = useHelpersStore()
    const add = vi.spyOn(helpers, 'addMarkdownHelper').mockReturnValue('h-1')
    const ev = kindOf(w, 'evidence')
    expect(ev).toHaveLength(1)
    expect(ev[0].text()).toContain(enMessages.missionDropdown.step.evidence)
    await ev[0].get('[data-test="link-open"]').trigger('click')
    expect(add).toHaveBeenCalledWith(REPO, `${EVIDENCE_DIR}/README.md`, REPO)
  })

  it('the evidence that is a file opens the file itself', async () => {
    kinds = { [EVIDENCE_FILE]: 'file' }
    const w = await mountLinks([{ kind: 'doc', ref: EVIDENCE_FILE }])
    const helpers = useHelpersStore()
    const add = vi.spyOn(helpers, 'addMarkdownHelper').mockReturnValue('h-1')
    await kindOf(w, 'evidence')[0].get('[data-test="link-open"]').trigger('click')
    expect(add).toHaveBeenCalledWith(REPO, EVIDENCE_FILE, REPO)
  })

  it('an address on this machine opens as before, labelled with its host', async () => {
    const w = await mountLinks([{ kind: 'url', ref: 'http://localhost:5173/score-report' }])
    const page = kindOf(w, 'page')
    expect(page).toHaveLength(1)
    expect(page[0].text()).toBe('Page · localhost:5173/score-report')
    await page[0].trigger('click')
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/score-report')
  })

  it('a path link has a copy button that copies its path and a label that is selectable; the path is never drawn', async () => {
    kinds = {
      [WT]: 'dir',
      [EVIDENCE_DIR]: 'dir',
      [`${EVIDENCE_DIR}/README.md`]: 'file'
    }
    const w = await mountLinks([
      { kind: 'pr', ref: PR },
      { kind: 'worktree', ref: WT },
      { kind: 'doc', ref: EVIDENCE_DIR }
    ])
    // Only the path links (worktree, evidence) have a copy button; the pull request has no path.
    expect(kindOf(w, 'pr')[0].find('[data-test="link-copy"]').exists()).toBe(false)
    const copy = kindOf(w, 'worktree')[0].get('[data-test="link-copy"]')
    expect(copy.attributes('aria-label')).toBe(enMessages.missionDropdown.step.copy)
    await copy.trigger('click')
    expect(writeText).toHaveBeenCalledWith(WT)
    await flushPromises()
    // The acknowledgement: the button says so, in a live region, for a moment.
    expect(kindOf(w, 'worktree')[0].get('[data-test="link-copy"]').attributes('aria-label')).toBe(
      enMessages.missionDropdown.step.copied
    )
    await kindOf(w, 'evidence')[0].get('[data-test="link-copy"]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith(EVIDENCE_DIR)

    for (const l of kindOf(w, 'worktree').concat(kindOf(w, 'evidence'))) {
      expect(l.find('[data-test="link-label"]').classes()).toContain('select-text')
    }
    // No absolute path, home or otherwise, anywhere in what is drawn (text or attributes).
    const html = w.html()
    expect(html).not.toContain('/home/')
    expect(html).not.toContain(REPO)
    expect(html).not.toContain(WT)
    expect(html).not.toContain(EVIDENCE_DIR)
  })

  it('a link that opens nothing is not drawn, and with no link the heading is not drawn', async () => {
    kinds = { [EVIDENCE_DIR]: 'dir' } // a folder with no README
    const w = await mountLinks([
      { kind: 'pr', ref: '412' },
      { kind: 'doc', ref: EVIDENCE_DIR },
      { kind: 'worktree', ref: 'relative/path' }
    ])
    expect(links(w)).toHaveLength(0)
    expect(w.find('[data-test="step-links"]').exists()).toBe(false)
    expect(w.find('[data-test="links-toggle"]').exists()).toBe(false)
    expect(w.find('[data-test="step-links-empty"]').exists()).toBe(false)
  })

  it('asks the disk once for what it needs, and not at all when no link is a path', async () => {
    kinds = { [WT]: 'dir' }
    await mountLinks([{ kind: 'worktree', ref: WT }])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][0]).toEqual([WT])
    wrapper?.unmount()
    await mountLinks([{ kind: 'pr', ref: PR }])
    expect(probe).not.toHaveBeenCalled()
  })

  it('the heading, the evidence name, the copy button and the worktree title are in both languages', () => {
    const en = enMessages.missionDropdown.step
    const pt = ptMessages.missionDropdown.step
    for (const key of [
      'linksCount',
      'evidence',
      'copy',
      'copied',
      'worktreeTitle',
      'removed',
      'evidenceTitle'
    ] as const) {
      expect(en[key], key).toBeTruthy()
      expect(pt[key], key).toBeTruthy()
    }
    expect(pt.evidence).not.toBe(en.evidence)
    expect(pt.removed).not.toBe(en.removed)
  })
})
