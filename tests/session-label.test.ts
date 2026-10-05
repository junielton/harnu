// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import { useSessionsStore, type Folder, type Session } from '../src/renderer/src/stores/sessions'
import {
  isForkSyntheticLike,
  sessionTitle,
  type SessionLike
} from '../src/renderer/src/lib/session-label'

/**
 * BUG-78 slice 2 (AC12, AC14) — `sessionTitle` is the one name a session shows
 * on every surface. Table-driven over spec §5.3's resolution order; the stub
 * `t` echoes the key and its params so a placeholder is visible as such.
 */

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}(${JSON.stringify(params)})` : key

const s = (over: Partial<SessionLike> & { sessionId: string }): SessionLike => ({ ...over })

const SRC = 'aaaa0000-0000-4000-8000-000000000001'

interface Row {
  name: string
  session: SessionLike
  sessions?: SessionLike[]
  want: string
}

const rows: Row[] = [
  {
    name: 'teammate → agentName',
    session: s({
      sessionId: 'mate',
      teamName: 'session-7399191c',
      agentName: 'spec-ui',
      summary: 'teammate-summary',
      firstPrompt: 'internal team message'
    }),
    want: 'spec-ui'
  },
  {
    name: 'teammate fields without teamName (the BUG-78 case) → summary',
    session: s({ sessionId: 'x', teamName: '', agentName: 'first-name', summary: 'latest-name' }),
    want: 'latest-name'
  },
  {
    name: 'agentName with teamName undefined → summary',
    session: s({ sessionId: 'x', agentName: 'first-name', summary: 'latest-name' }),
    want: 'latest-name'
  },
  {
    name: 'fork with a named source',
    session: s({ sessionId: 'synthetic-f', synthetic: true, forkSourceId: SRC }),
    sessions: [s({ sessionId: SRC, summary: 'first-name', firstPrompt: 'a prompt' })],
    want: 'session.forkPlaceholder({"summary":"first-name"})'
  },
  {
    name: 'fork whose source is named only by aiSummary.title',
    session: s({ sessionId: 'synthetic-f', synthetic: true, forkSourceId: SRC }),
    sessions: [
      s({ sessionId: SRC, summary: '', aiSummary: { title: 'haiku-title' }, firstPrompt: 'p' })
    ],
    want: 'session.forkPlaceholder({"summary":"haiku-title"})'
  },
  {
    name: 'fork whose source is a teammate → its agent name',
    session: s({ sessionId: 'synthetic-f', synthetic: true, forkSourceId: SRC }),
    sessions: [
      s({ sessionId: SRC, teamName: 'session-7399191c', agentName: 'spec-ui', summary: 'x' })
    ],
    want: 'session.forkPlaceholder({"summary":"spec-ui"})'
  },
  {
    name: 'fork with an unknown source → unnamed',
    session: s({ sessionId: 'synthetic-f', synthetic: true, forkSourceId: SRC }),
    sessions: [],
    want: 'session.forkPlaceholder({"summary":"session.unnamed"})'
  },
  {
    name: 'fork with a nameless source → unnamed',
    session: s({ sessionId: 'synthetic-f', synthetic: true, forkSourceId: SRC }),
    sessions: [s({ sessionId: SRC, summary: '  ', firstPrompt: '' })],
    want: 'session.forkPlaceholder({"summary":"session.unnamed"})'
  },
  {
    name: 'fork of a fork → depth 1, the source is not resolved as a fork',
    session: s({ sessionId: 'synthetic-f2', synthetic: true, forkSourceId: 'synthetic-f1' }),
    sessions: [
      s({ sessionId: 'synthetic-f1', synthetic: true, forkSourceId: SRC }),
      s({ sessionId: SRC, summary: 'first-name' })
    ],
    want: 'session.forkPlaceholder({"summary":"session.unnamed"})'
  },
  {
    name: 'plain synthetic → newPlaceholder',
    session: s({ sessionId: 'synthetic-n', synthetic: true, summary: '' }),
    want: 'session.newPlaceholder'
  },
  {
    name: 'summary wins over aiSummary and firstPrompt',
    session: s({
      sessionId: 'x',
      summary: 'latest-name',
      aiSummary: { title: 'haiku-title' },
      firstPrompt: 'a prompt'
    }),
    want: 'latest-name'
  },
  {
    name: 'aiSummary.title only',
    session: s({
      sessionId: 'x',
      summary: '',
      aiSummary: { title: 'haiku-title' },
      firstPrompt: ''
    }),
    want: 'haiku-title'
  },
  {
    name: 'aiSummary.title beats firstPrompt',
    session: s({ sessionId: 'x', aiSummary: { title: 'haiku-title' }, firstPrompt: 'a prompt' }),
    want: 'haiku-title'
  },
  {
    name: 'firstPrompt only',
    session: s({ sessionId: 'x', summary: '', firstPrompt: 'a prompt' }),
    want: 'a prompt'
  },
  {
    name: 'whitespace-only summary falls through to firstPrompt',
    session: s({ sessionId: 'x', summary: '   ', firstPrompt: 'a prompt' }),
    want: 'a prompt'
  },
  {
    name: 'candidates are trimmed',
    session: s({ sessionId: 'x', summary: '  latest-name \n' }),
    want: 'latest-name'
  },
  {
    name: 'whitespace-only aiSummary.title falls through to firstPrompt',
    session: s({ sessionId: 'x', aiSummary: { title: ' ' }, firstPrompt: 'a prompt' }),
    want: 'a prompt'
  },
  {
    name: 'nothing → empty string (the caller supplies its own fallback)',
    session: s({ sessionId: 'x', summary: '', firstPrompt: '' }),
    want: ''
  },
  {
    name: 'nothing, all fields absent → empty string',
    session: s({ sessionId: 'x' }),
    want: ''
  }
]

describe('sessionTitle (BUG-78 AC12)', () => {
  it.each(rows)('$name', ({ session, sessions, want }) => {
    expect(sessionTitle(session, sessions ?? [], t)).toBe(want)
  })

  it('never returns the session id', () => {
    expect(sessionTitle(s({ sessionId: SRC }), [], t)).not.toContain(SRC)
  })
})

describe('isForkSyntheticLike', () => {
  it('needs synthetic === true and a non-empty forkSourceId', () => {
    expect(isForkSyntheticLike(s({ sessionId: 'a', synthetic: true, forkSourceId: SRC }))).toBe(
      true
    )
    expect(isForkSyntheticLike(s({ sessionId: 'a', synthetic: true, forkSourceId: '' }))).toBe(
      false
    )
    expect(isForkSyntheticLike(s({ sessionId: 'a', synthetic: true }))).toBe(false)
    expect(isForkSyntheticLike(s({ sessionId: 'a', forkSourceId: SRC }))).toBe(false)
  })
})

describe('consistency (BUG-78 AC14, helper half)', () => {
  it('an aiSummary-only session is named by its Haiku title', () => {
    const only = s({
      sessionId: 'x',
      summary: '',
      aiSummary: { title: 'haiku-title' },
      firstPrompt: 'a prompt'
    })
    expect(sessionTitle(only, [only], t)).toBe('haiku-title')
  })
})

/** A real (on-disk) session named only by its Haiku title. */
function haikuOnly(sessionId: string): Session {
  return {
    sessionId,
    fullPath: `/work/Demo/${sessionId}.jsonl`,
    fileMtime: 1,
    firstPrompt: 'a prompt',
    summary: '',
    aiSummary: { title: 'haiku-title', summary: 'one line' },
    messageCount: 1,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    gitBranch: '',
    projectPath: '/work/Demo',
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false
  } as Session
}

function seed(store: ReturnType<typeof useSessionsStore>, sessions: Session[]): Folder {
  const folder = {
    path: '/work/Demo',
    alias: 'Demo',
    gitBranch: '',
    sessions,
    expanded: true,
    pinned: true
  } as Folder
  store.folders.splice(0, store.folders.length, folder)
  return folder
}

describe('consistency (BUG-78 AC14, mounted surfaces)', () => {
  const ID = 'aaaa0000-0000-4000-8000-0000000000a1'

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { api: unknown }).api = {
      openPath: vi.fn(),
      openInVSCode: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue(null),
      shellOpenExternal: vi.fn()
    }
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    localStorage.clear()
  })

  it('the sidebar row and the topbar both show the Haiku title', () => {
    const store = useSessionsStore()
    const folder = seed(store, [haikuOnly(ID)])
    store.select(ID)

    const side = mount(SidebarFolder, {
      props: { folder, headerless: true },
      global: { plugins: [i18n] }
    })
    const row = side.find(`[data-session-row][data-session-id="${ID}"]`)
    expect(row.find('span.truncate').text().trim()).toBe('haiku-title')

    const top = mount(Topbar, { global: { plugins: [i18n] } })
    expect(top.text()).toContain('haiku-title')
    expect(top.text()).not.toContain('a prompt')
  })

  it('a blur without an edit leaves summary alone; a real edit still writes it', async () => {
    const store = useSessionsStore()
    seed(store, [haikuOnly(ID)])
    store.select(ID)
    const top = mount(Topbar, { global: { plugins: [i18n] }, attachTo: document.body })
    const title = top.find('[contenteditable="true"]')

    // Unchanged title (the Haiku one): not an edit, must not freeze into `summary`.
    await title.trigger('blur')
    expect(store.selectedSession?.summary).toBe('')

    // A real edit is persisted.
    title.element.textContent = 'my own name'
    await title.trigger('blur')
    expect(store.selectedSession?.summary).toBe('my own name')
    top.unmount()
  })
})

describe('sidebar filter (BUG-78 AC16)', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => localStorage.clear())

  it('finds an aiSummary-only session by the Haiku title it shows', () => {
    const store = useSessionsStore()
    seed(store, [haikuOnly('aaaa0000-0000-4000-8000-0000000000a2')])
    store.setFilterQuery('haiku-title')

    // The tree filter (`filteredFolders` → `visibleFolders`).
    expect(JSON.stringify(store.visibleFolders)).toContain('/work/Demo')
    // The board filter (`boardBuckets`).
    const ids = store.boardBuckets.flatMap((b) => b.sessions.map((x) => x.sessionId))
    expect(ids).toEqual(['aaaa0000-0000-4000-8000-0000000000a2'])
  })

  it('still finds nothing for a query no field or name matches', () => {
    const store = useSessionsStore()
    seed(store, [haikuOnly('aaaa0000-0000-4000-8000-0000000000a3')])
    store.setFilterQuery('no-such-name')
    expect(JSON.stringify(store.visibleFolders)).not.toContain('/work/Demo')
    expect(store.boardBuckets.flatMap((b) => b.sessions)).toEqual([])
  })
})
