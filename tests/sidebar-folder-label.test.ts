// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import { useSessionsStore, type Folder, type Session } from '../src/renderer/src/stores/sessions'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-78 — a sidebar session row uses `agentName` only for a real T99 teammate
 * (`teamName` set). A plain session that carries a stray `agentName` (the CLI's
 * `agent-name` rename line, as an older reader scraped it) shows its `summary`.
 * Mount pattern from `tests/sidebar-folder-click.test.ts`; fixtures are neutral.
 */

const CWD = '/work/Demo'

function makeSession(over: Partial<Session> & { sessionId: string }): Session {
  const now = new Date().toISOString()
  return {
    summary: '',
    firstPrompt: '',
    created: now,
    modified: now,
    status: 'idle',
    isSidechain: false,
    resumable: true,
    bridged: false,
    synthetic: false,
    isShellTerminal: false,
    ...over
  } as Session
}

/** Mount a headerless `SidebarFolder` (rows render without expanding the folder). */
function mountFolder(folder: Folder): VueWrapper {
  return mount(SidebarFolder, {
    props: { folder, headerless: true },
    global: { plugins: [i18n] }
  })
}

function folderOf(sessions: Session[]): Folder {
  return { path: CWD, alias: 'Demo', gitBranch: '', sessions, expanded: true } as Folder
}

/** The visible label of a top-level session row. */
function rowLabel(w: VueWrapper, sessionId: string): string {
  const row = w.find(`[data-session-row][data-session-id="${sessionId}"]`)
  if (!row.exists()) throw new Error(`no session row for ${sessionId}`)
  return row.find('span.truncate').text().trim()
}

describe('sidebar session label (BUG-78)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('AC6: a non-teammate row with a stray agentName renders its summary', () => {
    const s = makeSession({ sessionId: 'aaaa0000-0000-4000-8000-000000000001' })
    Object.assign(s, { agentName: 'A', teamName: '', summary: 'B' })
    const w = mountFolder(folderOf([s]))
    expect(rowLabel(w, s.sessionId)).toBe('B')
  })

  it('AC7: a teammate row nested under its lead renders its agent name', () => {
    const lead = makeSession({
      sessionId: '7399191c-0ea7-4d4e-90ab-bf36a3f5c610',
      summary: 'lead-name'
    })
    const mate = makeSession({
      sessionId: '03777eec-00f1-46a5-a7d0-2df48cb65492',
      summary: 'teammate-summary',
      firstPrompt: 'internal team message'
    })
    Object.assign(mate, { teamName: 'session-7399191c', agentName: 'spec-ui' })
    useSessionsStore().toggleTeammatesExpanded(lead.sessionId)
    const w = mountFolder(folderOf([lead, mate]))
    const row = w.find(`[data-teammate-row][data-session-id="${mate.sessionId}"]`)
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('spec-ui')
    expect(row.text()).not.toContain('teammate-summary')
  })

  it('AC10: a plain synthetic row still renders the "New session" placeholder', () => {
    const s = makeSession({ sessionId: 'synthetic-aaaa0000-0000-4000-8000-000000000002' })
    Object.assign(s, { synthetic: true })
    const w = mountFolder(folderOf([s]))
    expect(rowLabel(w, s.sessionId)).toBe(i18n.global.t('session.newPlaceholder'))
  })

  it('AC10: a real row with no name still renders "Untitled"', () => {
    const s = makeSession({ sessionId: 'aaaa0000-0000-4000-8000-000000000003' })
    const w = mountFolder(folderOf([s]))
    expect(rowLabel(w, s.sessionId)).toBe(i18n.global.t('session.unnamed'))
  })
})

/**
 * AC8 (render half) — a row that STARTS stale (`agentName: 'A'`, no
 * `teamName`) and receives the B rename live through `session:updated`
 * renders `B`. The store half lives in `tests/sessions-store.test.ts`.
 */
describe('sidebar session label — live rename (BUG-78 AC8)', () => {
  const ID = 'aaaa0000-0000-4000-8000-000000000004'
  let cb: Record<string, ((...a: unknown[]) => void) | undefined>
  let disk: FolderEntry[]

  function installApi(): void {
    cb = {}
    const on =
      (name: string) =>
      (fn: (...a: unknown[]) => void): (() => void) => {
        cb[name] = fn
        return () => {}
      }
    const load = vi.fn(async () =>
      disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
    )
    ;(window as unknown as { api: unknown }).api = {
      foldersLoad: load,
      rescan: load,
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: on('onProjectAdded'),
      onProjectRemoved: on('onProjectRemoved'),
      onSessionAdded: on('onSessionAdded'),
      onSessionRemoved: on('onSessionRemoved'),
      onSessionUpdated: on('onSessionUpdated'),
      onHook: on('onHook'),
      onScreenState: on('onScreenState'),
      onSessionRegistry: on('onSessionRegistry'),
      fleetReportShellSessions: vi.fn(),
      onApprovalPending: on('onApprovalPending'),
      onApprovalResolved: on('onApprovalResolved'),
      approvalsList: vi.fn(async () => []),
      onNotifyActivate: on('onNotifyActivate'),
      onIndexUpdated: on('onIndexUpdated'),
      onWatcherDegraded: on('onWatcherDegraded'),
      onSubagentUpdated: on('onSubagentUpdated'),
      onSubagentRemoved: on('onSubagentRemoved')
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    const now = new Date().toISOString()
    disk = [
      {
        path: CWD,
        alias: 'Demo',
        gitBranch: '',
        sessions: [
          {
            sessionId: ID,
            fullPath: `${CWD}/${ID}.jsonl`,
            fileMtime: 1,
            firstPrompt: 'first prompt',
            summary: 'A',
            messageCount: 1,
            created: now,
            modified: now,
            gitBranch: '',
            projectPath: CWD,
            isSidechain: false,
            status: 'idle',
            agents: [],
            resumable: true,
            bridged: false,
            teamName: '',
            agentName: 'A'
          } as FolderEntry['sessions'][number]
        ]
      }
    ]
    installApi()
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('a stale row renamed to B live renders B', async () => {
    const store = useSessionsStore()
    await store.init()
    const row = store.folders.find((f) => f.path === CWD)!.sessions.find((s) => s.sessionId === ID)!
    expect(row.agentName).toBe('A') // the stale precondition

    cb.onSessionUpdated!({
      slug: encodePathToSlug(CWD),
      sessionId: ID,
      // The watcher pre-derives the rename; the `agent-name` line never reaches here.
      renameTitle: 'B'
    })

    const folder = store.folders.find((f) => f.path === CWD)!
    expect(folder.sessions.find((s) => s.sessionId === ID)!.summary).toBe('B')
    const w = mountFolder(folder)
    expect(rowLabel(w, ID)).toBe('B')
  })
})
