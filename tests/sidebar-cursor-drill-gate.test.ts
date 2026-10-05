// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

describe('sidebar keyboard cursor gate during drill mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('cursorDown still moves the cursor when drill mode is off', () => {
    const store = useSessionsStore()
    store.folders.push({
      path: '/repos/alpha',
      alias: 'alpha',
      gitBranch: '',
      sessions: [],
      expanded: false,
      pinned: true
    } as never)
    store.cursorDown()
    expect(store.keyboardCursor).not.toBeNull()
  })
})
