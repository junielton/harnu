import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * T481 (AC-B4-5, renderer half) — the folder-menu toggle's state lives in the sessions store as a
 * set of EXACT paths; both locale files carry its two labels; the menu wires the entry.
 */

describe('terminalReadPaths (folder-menu toggle state)', () => {
  let rows: Array<{ path: string; agentTerminalRead?: boolean }>
  const setTerminalRead = vi.fn(async (p: string, enabled: boolean) => {
    const rec = rows.find((r) => r.path === p)
    if (rec) rec.agentTerminalRead = enabled
    else rows.push({ path: p, agentTerminalRead: enabled })
    return { projects: rows, hiddenPaths: [] }
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    rows = []
    setTerminalRead.mockClear()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: rows, hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        userProjectsSetTerminalRead: setTerminalRead
      }
    }
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('is empty by default, then tracks exactly the folder that was toggled', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    expect(store.terminalReadPaths.size).toBe(0)

    await store.setFolderTerminalRead('/repos/app', true)
    expect(setTerminalRead).toHaveBeenCalledWith('/repos/app', true)
    expect(store.terminalReadPaths.has('/repos/app')).toBe(true)
    // A worktree of it is a different path: not a member.
    expect(store.terminalReadPaths.has('/repos/app/.claude/worktrees/wt')).toBe(false)

    await store.setFolderTerminalRead('/repos/app', false)
    expect(store.terminalReadPaths.has('/repos/app')).toBe(false)
  })

  it('hydrates from the persisted projects on reload', async () => {
    rows = [
      { path: '/repos/a', agentTerminalRead: true },
      { path: '/repos/b', agentTerminalRead: false }
    ]
    const store = useSessionsStore()
    await store.reloadModel()
    expect([...store.terminalReadPaths]).toEqual(['/repos/a'])
  })
})

describe('folder menu entry + copy', () => {
  it('both locale files carry the two labels', () => {
    for (const messages of [en, ptBR]) {
      const menu = messages.folderMenu as Record<string, string>
      expect(menu.terminalReadOn).toBeTruthy()
      expect(menu.terminalReadOff).toBeTruthy()
    }
    expect(en.folderMenu.terminalReadOn).toBe('Let agents read terminals I open')
  })

  it('FolderMenu wires the entry to the store, behind the exact-path set', () => {
    const src = readFileSync(
      join(__dirname, '../src/renderer/src/components/FolderMenu.vue'),
      'utf8'
    )
    expect(src).toContain("id: 'terminal-read'")
    expect(src).toContain('sessions.terminalReadPaths.has(path)')
    expect(src).toContain('sessions.setFolderTerminalRead(')
  })
})
