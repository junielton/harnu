// @vitest-environment jsdom
// "No dead ends" (unit B): the guided dialog states the facts main read just now and offers the one
// action that clears the refusal — AC-B3 (lock reason), B4 (idle session), B5 (shared stack: choose),
// B6 (unreadable path + fix + check again), B7 (Docker hint + scan again), B9 (pending state).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CleanupGuidedDialog from '../src/renderer/src/components/CleanupGuidedDialog.vue'
import { i18n } from '@renderer/i18n'
import type { GcGuidance } from '../src/main/gc/gc-wire'

const base = (over: Partial<GcGuidance> = {}): GcGuidance => ({
  id: 'a',
  lock: null,
  sessions: null,
  stacks: [],
  unreadable: null,
  docker: null,
  ...over
})

let w: VueWrapper | null = null
async function open(props: Record<string, unknown>): Promise<VueWrapper> {
  w = mount(CleanupGuidedDialog, {
    props: {
      rows: [{ id: 'a', title: 'www › PROJ-1-slug', sub: 'feat/proj-1' }],
      guidance: { a: base() },
      loadError: false,
      pending: false,
      stale: false,
      ...props
    } as never,
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await flushPromises()
  return w
}
const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const text = (sel: string): string => q(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

describe('unlock and remove (AC-B3)', () => {
  it('shows the lock reason git recorded and names the action', async () => {
    await open({
      action: 'unlock-remove',
      guidance: { a: base({ lock: { reason: 'portable disk' } }) }
    })
    expect(text('[data-testid="guided-lock"]')).toContain('portable disk')
    expect(text('[data-testid="guided-confirm"]')).toBe('Unlock and remove')
    q('[data-testid="guided-confirm"]')!.click()
    expect(w!.emitted('confirm')).toEqual([[null]])
  })

  it('says so when git recorded no reason', async () => {
    await open({ action: 'unlock-remove', guidance: { a: base({ lock: { reason: null } }) } })
    expect(text('[data-testid="guided-lock"]')).toContain('no reason')
  })

  it('waits for the facts: nothing to confirm while they are being read', async () => {
    await open({ action: 'unlock-remove', guidance: null })
    expect(q('[data-testid="guided-loading"]')).not.toBeNull()
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('cannot confirm facts it could not read', async () => {
    await open({ action: 'unlock-remove', guidance: null, loadError: true })
    expect(q('[data-testid="guided-load-error"]')).not.toBeNull()
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('close the session and remove (AC-B4)', () => {
  it('says how many idle sessions it will close, and that the conversation stays', async () => {
    await open({
      action: 'close-session-remove',
      guidance: { a: base({ sessions: { idle: 2, busy: 0 } }) }
    })
    expect(text('[data-testid="guided-sessions"]')).toContain('2 idle sessions')
    expect(text('[data-testid="guided-confirm"]')).toBe('Close session and remove')
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('never offers to close a session that is working, and says why', async () => {
    await open({
      action: 'close-session-remove',
      guidance: { a: base({ sessions: { idle: 1, busy: 1 } }) }
    })
    expect(text('[data-testid="guided-sessions"]')).toContain('working or waiting')
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a session outside Harnu is not Harnu’s to close', async () => {
    await open({
      action: 'close-session-remove',
      guidance: { a: base({ sessions: { idle: 0, busy: 0 } }) }
    })
    expect(text('[data-testid="guided-sessions"]')).toContain('not one Harnu')
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a stack shared with other folders (AC-B5)', () => {
  const shared = (binds: boolean): GcGuidance =>
    base({
      stacks: [
        {
          id: 'web',
          name: 'web',
          otherFolders: ['/ws/org/proj/www'],
          bindsThisFolder: binds,
          containers: 3
        }
      ]
    })

  it('names the stack and the other folders using it', async () => {
    await open({ action: 'shared-stack', guidance: { a: shared(false) } })
    expect(text('[data-testid="guided-stack"]')).toContain('web')
    expect(text('[data-testid="guided-stack"]')).toContain('/ws/org/proj/www')
  })

  it('lets the operator choose: stop the stack, or leave it running', async () => {
    await open({ action: 'shared-stack', guidance: { a: shared(false) } })
    expect(text('[data-testid="guided-choice-stop"]')).toContain('Stop stack and remove')
    expect(text('[data-testid="guided-choice-leave"]')).toContain('leave the stack')
    expect(text('[data-testid="guided-confirm"]')).toBe('Stop stack and remove')
    ;(q('[data-testid="guided-choice-leave"] input') as HTMLInputElement).click()
    await flushPromises()
    expect(text('[data-testid="guided-confirm"]')).toBe('Remove and leave the stack')
    q('[data-testid="guided-confirm"]')!.click()
    expect(w!.emitted('confirm')).toEqual([['leave']])
  })

  it('stopping is the default, and never touches a volume', async () => {
    await open({ action: 'shared-stack', guidance: { a: shared(false) } })
    expect(text('[data-testid="guided-choice-stop"]')).toContain('volumes are kept')
    q('[data-testid="guided-confirm"]')!.click()
    expect(w!.emitted('confirm')).toEqual([['stop']])
  })

  it('does not offer to leave a stack that uses this folder, and says why', async () => {
    await open({ action: 'shared-stack', guidance: { a: shared(true) } })
    expect(q('[data-testid="guided-choice-leave"]')).toBeNull()
    expect(text('[data-testid="guided-leave-unavailable"]')).toContain('uses this folder')
  })
})

describe('an unreadable folder (AC-B6)', () => {
  const unreadable = base({
    unreadable: {
      path: '/ws/wt/private',
      owner: 'root',
      fixCommand: 'sudo chown -R $USER /ws/wt/private'
    }
  })

  it('names the exact path and its owner, with a copyable fix', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await open({ action: 'fix-unreadable', guidance: { a: unreadable } })
    expect(text('[data-testid="guided-unreadable"]')).toContain('/ws/wt/private')
    expect(text('[data-testid="guided-unreadable"]')).toContain('root')
    expect(text('[data-testid="guided-fix"]')).toBe('sudo chown -R $USER /ws/wt/private')
    q('[data-testid="guided-copy"]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('sudo chown -R $USER /ws/wt/private')
  })

  it('offers Check again after the fix, and no removal', async () => {
    await open({ action: 'fix-unreadable', guidance: { a: unreadable } })
    expect(q('[data-testid="guided-confirm"]')).toBeNull()
    q('[data-testid="guided-recheck"]')!.click()
    expect(w!.emitted('recheck')).toHaveLength(1)
  })

  it('says it reads fine now when nothing is unreadable any more', async () => {
    await open({ action: 'fix-unreadable', guidance: { a: base() } })
    expect(text('[data-testid="guided-unreadable-ok"]')).toContain('can read')
  })
})

describe('Docker was not running at scan time (AC-B7)', () => {
  it('offers Scan again, with the command that starts Docker where the platform has one', async () => {
    await open({
      action: 'docker-down',
      guidance: { a: base({ docker: { hint: 'open -a Docker' } }) }
    })
    expect(text('[data-testid="guided-docker"]')).toContain("Docker wasn't running")
    expect(text('[data-testid="guided-docker-hint"]')).toBe('open -a Docker')
    q('[data-testid="guided-scan"]')!.click()
    expect(w!.emitted('scan')).toHaveLength(1)
  })

  it('points at the Docker app where there is no command', async () => {
    await open({ action: 'docker-down', guidance: { a: base({ docker: { hint: null } }) } })
    expect(q('[data-testid="guided-docker-hint"]')).toBeNull()
    expect(text('[data-testid="guided-docker-app"]')).toContain('Docker')
  })
})

describe('a guided action never goes silent (AC-B9)', () => {
  it('shows a pending state and disables the confirm while it runs', async () => {
    await open({
      action: 'unlock-remove',
      guidance: { a: base({ lock: { reason: null } }) },
      pending: true
    })
    expect(q('[data-testid="guided-pending"]')).not.toBeNull()
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks the confirm when what it showed moved underneath it', async () => {
    await open({
      action: 'unlock-remove',
      guidance: { a: base({ lock: { reason: null } }) },
      stale: true
    })
    expect(q('[data-testid="guided-stale"]')).not.toBeNull()
    expect((q('[data-testid="guided-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Cancel and Escape close it', async () => {
    await open({ action: 'unlock-remove', guidance: { a: base({ lock: { reason: null } }) } })
    q('[data-testid="guided-cancel"]')!.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w!.emitted('cancel')!.length).toBeGreaterThanOrEqual(1)
  })
})
