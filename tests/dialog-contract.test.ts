// @vitest-environment jsdom
/**
 * T460 batch 1 — the behaviour contract of the shared `ui/Dialog.vue` shell
 * (spec docs/specs/T460-dialog-standardization/spec.md §6.1). One assertion per row; the IDs
 * C01..C22 are stable so a failing PR can name them. The `D*` block pins that design.md and the
 * code agree token for token (batch 1 acceptance criterion 4).
 *
 * jsdom has no layout engine and does not resolve Tailwind classes into computed styles, so C17..C20
 * are a class / inline-style contract, NOT layout proof — their real-layout twin is the baseline
 * geometry run (spec §6.3, `tests/e2e/ci/dialog-geometry.spec.ts`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, type PropType } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { i18n } from '@renderer/i18n'
import Dialog from '../src/renderer/src/components/ui/Dialog.vue'
import { installLayoutStubs } from './dialog-surfaces/harness'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')
const STYLES = join(RENDERER, 'styles')

let restoreLayout: () => void
beforeAll(() => {
  restoreLayout = installLayoutStubs()
})
afterAll(() => restoreLayout())

let wrappers: VueWrapper[] = []
afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const body = (): HTMLElement => document.body
const card = (): HTMLElement => body().querySelector<HTMLElement>('[role="dialog"]') as HTMLElement
const scrim = (): HTMLElement =>
  body().querySelector<HTMLElement>('[role="presentation"]') as HTMLElement
const q = <T extends HTMLElement = HTMLElement>(sel: string): T => body().querySelector<T>(sel) as T

type DialogProps = InstanceType<typeof Dialog>['$props']

/** Two focusable probes in the body so Tab has somewhere to wrap. */
const probes = (): ReturnType<typeof h>[] => [
  h('button', { id: 'first' }, 'first'),
  h('button', { id: 'last' }, 'last')
]

function mountDialog(
  props: Partial<DialogProps> = {},
  slots: Record<string, () => unknown> = {}
): VueWrapper {
  const w = mount(Dialog, {
    attachTo: document.body,
    props: { open: true, title: 'Probe title', ...props } as DialogProps,
    slots: { default: () => probes(), ...slots } as never,
    global: { plugins: [i18n] }
  })
  wrappers.push(w)
  return w
}

function key(target: EventTarget, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(ev)
  return ev
}
const esc = (target: EventTarget = document.body): KeyboardEvent => key(target, { key: 'Escape' })
const tab = (target: EventTarget, shiftKey = false): KeyboardEvent =>
  key(target, { key: 'Tab', shiftKey })

const closes = (w: VueWrapper): unknown[][] => (w.emitted('close') ?? []) as unknown[][]

// ============================================================================================
// The shell
// ============================================================================================

describe('C01 — teleported to body', () => {
  it('renders into document.body, not in place', () => {
    const w = mountDialog()
    expect(card()).toBeTruthy()
    expect(w.element.contains(card())).toBe(false)
    expect(card().closest('body')).toBe(document.body)
  })

  it('open=false renders nothing', () => {
    mountDialog({ open: false })
    expect(body().querySelector('[role="dialog"]')).toBeNull()
    expect(body().querySelector('[role="presentation"]')).toBeNull()
  })
})

describe('C02 — roles', () => {
  it('card is a modal dialog; the scrim is presentation', () => {
    mountDialog()
    expect(card().getAttribute('role')).toBe('dialog')
    expect(card().getAttribute('aria-modal')).toBe('true')
    expect(scrim().getAttribute('role')).toBe('presentation')
    expect(card().parentElement).toBe(scrim())
  })
})

describe('C03 — accessible name', () => {
  it('aria-labelledby resolves to an element whose text is the title', () => {
    mountDialog({ title: 'Rename folder' })
    const id = card().getAttribute('aria-labelledby')
    expect(id).toBeTruthy()
    expect(document.getElementById(id as string)?.textContent?.trim()).toBe('Rename folder')
    expect(card().hasAttribute('aria-label')).toBe(false)
  })

  it('with #header + ariaLabel, aria-label is set instead of aria-labelledby', () => {
    mountDialog(
      { title: undefined, ariaLabel: 'Card dossier' },
      { header: () => h('span', 'custom header') }
    )
    expect(card().getAttribute('aria-label')).toBe('Card dossier')
    expect(card().hasAttribute('aria-labelledby')).toBe(false)
  })

  it('never neither: a nameless dialog is reported in dev', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mountDialog({ title: undefined }, { header: () => h('span', 'custom header') })
    expect(err).toHaveBeenCalledWith(expect.stringContaining('accessible name'))
  })
})

describe('C04 — describedby', () => {
  it('is forwarded when given, absent otherwise', () => {
    mountDialog({ describedby: 'body-copy' })
    expect(card().getAttribute('aria-describedby')).toBe('body-copy')
    document.body.innerHTML = ''
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    mountDialog()
    expect(card().hasAttribute('aria-describedby')).toBe(false)
  })
})

// ============================================================================================
// Keyboard and pointer
// ============================================================================================

describe('C05 — Esc', () => {
  it('emits close("esc") exactly once', () => {
    const w = mountDialog()
    esc()
    expect(closes(w)).toEqual([['esc']])
  })

  it('works with focus inside the card too', () => {
    const w = mountDialog()
    q('#first').focus()
    esc(q('#first'))
    expect(closes(w)).toEqual([['esc']])
  })
})

describe('C06 — Esc is swallowed', () => {
  it('a bubbling listener on document does not see it', () => {
    mountDialog()
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    esc()
    document.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('C07 — dismissible=false', () => {
  it('Esc and scrim mousedown emit nothing; no ✕; Esc still does not reach document', () => {
    const w = mountDialog({ dismissible: false })
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    esc()
    document.removeEventListener('keydown', seen)
    scrim().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes(w)).toEqual([])
    expect(seen).not.toHaveBeenCalled()
    expect(card().querySelector('header button')).toBeNull()
  })
})

describe('C08 — scrim', () => {
  it('mousedown on the scrim itself emits close("scrim")', () => {
    const w = mountDialog()
    scrim().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes(w)).toEqual([['scrim']])
  })

  it('mousedown inside the card does not', () => {
    const w = mountDialog()
    q('#first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    card().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes(w)).toEqual([])
  })

  it('a drag that starts inside and ends on the scrim (mousedown in, mouseup out) does not', () => {
    const w = mountDialog()
    q('#first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    scrim().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    scrim().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(closes(w)).toEqual([])
  })

  it('a mousedown inside the card does not reach document (popovers behind keep their state)', () => {
    mountDialog()
    const seen = vi.fn()
    document.addEventListener('mousedown', seen)
    q('#first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.removeEventListener('mousedown', seen)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('C09 — the ✕', () => {
  it('emits close("button"); its aria-label is t("dialog.close")', () => {
    const w = mountDialog()
    const x = card().querySelector<HTMLButtonElement>('header button') as HTMLButtonElement
    expect(x.getAttribute('aria-label')).toBe(i18n.global.t('dialog.close'))
    expect(x.getAttribute('aria-label')).toBe('Close')
    x.click()
    expect(closes(w)).toEqual([['button']])
  })
})

describe('C10 — a nested dropdown owns its Esc', () => {
  it.each(['data-esc-owner', 'data-branch-combobox-panel'])(
    'Esc from inside [%s] does not emit and is not swallowed',
    (attr) => {
      const w = mountDialog(
        {},
        { default: () => h('div', { [attr]: '' }, [h('input', { id: 'in-panel' })]) }
      )
      const seen = vi.fn()
      document.addEventListener('keydown', seen)
      esc(q('#in-panel'))
      document.removeEventListener('keydown', seen)
      expect(closes(w)).toEqual([])
      expect(seen).toHaveBeenCalledTimes(1)
    }
  )

  it('escIgnore replaces the default selector', () => {
    const w = mountDialog(
      { escIgnore: '.mine' },
      { default: () => h('div', { class: 'mine' }, [h('input', { id: 'in-mine' })]) }
    )
    esc(q('#in-mine'))
    expect(closes(w)).toEqual([])
  })
})

// ============================================================================================
// Focus
// ============================================================================================

describe('C11 — initial focus', () => {
  it('an initialFocus selector wins', async () => {
    mountDialog({ initialFocus: '#last' })
    await flushPromises()
    expect(document.activeElement).toBe(q('#last'))
  })

  it('an initialFocus getter wins', async () => {
    mountDialog({ initialFocus: () => q('#last') })
    await flushPromises()
    expect(document.activeElement).toBe(q('#last'))
  })

  it('an unresolved initialFocus falls back to the first focusable', async () => {
    mountDialog({ initialFocus: '#nope' })
    await flushPromises()
    expect(document.activeElement).toBe(card().querySelector('header button'))
  })

  it('no initialFocus: the first focusable', async () => {
    mountDialog()
    await flushPromises()
    expect(document.activeElement).toBe(card().querySelector('header button'))
  })

  it('nothing focusable: the card itself', async () => {
    mountDialog({ dismissible: false }, { default: () => h('p', 'no controls') })
    await flushPromises()
    expect(document.activeElement).toBe(card())
  })
})

describe('C12 — Tab wraps inside the card', () => {
  it('Tab on the last focusable wraps to the first', async () => {
    mountDialog({ dismissible: false })
    await flushPromises()
    q('#last').focus()
    const ev = tab(q('#last'))
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('#first'))
  })

  it('Shift+Tab on the first focusable wraps to the last', async () => {
    mountDialog({ dismissible: false })
    await flushPromises()
    q('#first').focus()
    const ev = tab(q('#first'), true)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('#last'))
  })

  it('Tab with focus outside the card pulls it in', async () => {
    mountDialog({ dismissible: false })
    await flushPromises()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const ev = tab(outside)
    expect(ev.defaultPrevented).toBe(true)
    expect(card().contains(document.activeElement)).toBe(true)
  })
})

describe('C13 — focus restore', () => {
  async function openFromOpener(): Promise<{ w: VueWrapper; opener: HTMLButtonElement }> {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const w = mountDialog({ open: false })
    await w.setProps({ open: true })
    await flushPromises()
    expect(card().contains(document.activeElement)).toBe(true)
    return { w, opener }
  }

  it('closing restores focus to the element focused before opening', async () => {
    const { w, opener } = await openFromOpener()
    await w.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })

  it('if that element was removed, nothing throws and focus falls back to body', async () => {
    const { w, opener } = await openFromOpener()
    opener.remove()
    await expect(w.setProps({ open: false })).resolves.not.toThrow()
    await flushPromises()
    expect(document.activeElement).toBe(document.body)
  })
})

// ============================================================================================
// The stack (C14..C16) — two real dialogs, a parent and a child
// ============================================================================================

const Pair = defineComponent({
  props: {
    parent: { type: Boolean, default: false },
    child: { type: Boolean, default: false },
    /** `false` drops each ✕, so the probe buttons are the only focusables. */
    dismissible: { type: Boolean, default: true },
    parentOpts: { type: Object as PropType<Record<string, unknown>>, default: () => ({}) }
  },
  emits: ['parent-close', 'child-close'],
  setup(props, { emit }) {
    return () => [
      h(
        Dialog,
        {
          open: props.parent,
          title: 'Parent',
          dismissible: props.dismissible,
          'data-testid': 'parent',
          onClose: (r: string) => emit('parent-close', r),
          ...props.parentOpts
        },
        {
          default: () => [h('button', { id: 'p-first' }, 'p1'), h('button', { id: 'p-last' }, 'p2')]
        }
      ),
      h(
        Dialog,
        {
          open: props.child,
          title: 'Child',
          dismissible: props.dismissible,
          'data-testid': 'child',
          onClose: (r: string) => emit('child-close', r)
        },
        {
          default: () => [h('button', { id: 'c-first' }, 'c1'), h('button', { id: 'c-last' }, 'c2')]
        }
      )
    ]
  }
})

function mountPair(
  initial: { parent?: boolean; child?: boolean; dismissible?: boolean } = {}
): VueWrapper {
  const w = mount(Pair, {
    attachTo: document.body,
    props: { parent: false, child: false, ...initial },
    global: { plugins: [i18n] }
  })
  wrappers.push(w)
  return w
}
const pClose = (w: VueWrapper): unknown[][] => (w.emitted('parent-close') ?? []) as unknown[][]
const cClose = (w: VueWrapper): unknown[][] => (w.emitted('child-close') ?? []) as unknown[][]

describe('C03 — two open dialogs never share a title id', () => {
  it('each card is labelled by its own title', async () => {
    const w = mountPair({ parent: true, child: true })
    await flushPromises()
    const ids = [...body().querySelectorAll('[role="dialog"]')].map((c) =>
      c.getAttribute('aria-labelledby')
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(w.exists()).toBe(true)
  })
})

describe('C14 — stack: Esc reaches only the top dialog', () => {
  it('with two open, Esc emits from the child only; after it closes, from the parent', async () => {
    const w = mountPair({ parent: true })
    await w.setProps({ child: true })
    esc()
    expect(cClose(w)).toEqual([['esc']])
    expect(pClose(w)).toEqual([])

    await w.setProps({ child: false })
    esc()
    expect(pClose(w)).toEqual([['esc']])
    expect(cClose(w)).toHaveLength(1)
  })

  it('Esc is swallowed once for the whole stack, not once per dialog', async () => {
    const w = mountPair({ parent: true })
    await w.setProps({ child: true })
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    esc()
    document.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('C15 — stack: the parent’s trap is suspended under a child', () => {
  async function openBoth(): Promise<{ w: VueWrapper; opener: HTMLButtonElement }> {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const w = mountPair({ dismissible: false })
    await w.setProps({ parent: true })
    await flushPromises()
    q('#p-last').focus()
    await w.setProps({ child: true })
    await flushPromises()
    return { w, opener }
  }

  it('the parent does not handle Tab while the child is open', async () => {
    await openBoth()
    const parentFirst = q('#p-first')
    const focusSpy = vi.spyOn(parentFirst, 'focus')
    // The child is the second card in the DOM.
    const childCard = q('[data-testid="child"]')
    expect(childCard.contains(document.activeElement)).toBe(true)
    q('#c-last').focus()
    tab(q('#c-last'))
    expect(document.activeElement).toBe(q('#c-first'))
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('when the child closes, focus returns INSIDE the parent, not to the page opener', async () => {
    const { w, opener } = await openBoth()
    await w.setProps({ child: false })
    await flushPromises()
    expect(document.activeElement).toBe(q('#p-last'))
    expect(document.activeElement).not.toBe(opener)
    // and the parent traps again
    const ev = tab(q('#p-last'))
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('#p-first'))
  })

  it('closing the child by Esc then the parent restores the page opener at the end', async () => {
    const { w, opener } = await openBoth()
    await w.setProps({ child: false })
    await flushPromises()
    await w.setProps({ parent: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })

  it('the parent does not steal focus back to the page opener when it closes under the child', async () => {
    const { w, opener } = await openBoth()
    await w.setProps({ parent: false })
    await flushPromises()
    expect(document.activeElement).not.toBe(opener)
    expect(q('[data-testid="child"]').contains(document.activeElement)).toBe(true)
  })
})

describe('C16 — stack: out-of-order closes leave no dangling listener', () => {
  it('closing the parent first, then the child, leaves nothing behind', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const w = mountPair({ parent: true })
    await w.setProps({ child: true })
    await flushPromises()

    await w.setProps({ parent: false })
    // the child is still the top, still reachable
    esc()
    expect(cClose(w)).toEqual([['esc']])
    expect(pClose(w)).toEqual([])

    await w.setProps({ child: false })
    await flushPromises()
    esc()
    expect(cClose(w)).toHaveLength(1)
    expect(pClose(w)).toEqual([])

    const count = (spy: typeof add, type: string): number =>
      spy.mock.calls.filter((c) => c[0] === type).length
    for (const type of ['keydown', 'focusin']) {
      expect(count(remove, type), type).toBe(count(add, type))
    }
    expect(count(add, 'keydown')).toBeGreaterThan(0)
  })
})

// ============================================================================================
// Structure (class / inline-style contract — jsdom does not resolve Tailwind)
// ============================================================================================

const SIZES = ['sm', 'md', 'lg', 'xl'] as const

describe('C17 — structure', () => {
  it('card is a flex column; header/footer shrink-0 with no overflow; body is the only scroller', () => {
    mountDialog({}, { footer: () => h('button', 'ok') })
    const c = card()
    expect(c.classList.contains('flex')).toBe(true)
    expect(c.classList.contains('flex-col')).toBe(true)
    expect([...c.classList].some((k) => k.startsWith('overflow'))).toBe(false)

    const header = c.querySelector('header') as HTMLElement
    const footer = c.querySelector('footer') as HTMLElement
    for (const el of [header, footer]) {
      expect(el.classList.contains('shrink-0')).toBe(true)
      expect([...el.classList].some((k) => k.startsWith('overflow'))).toBe(false)
    }
    const bodyEl = [...c.children].find((el) => el !== header && el !== footer) as HTMLElement
    for (const k of ['min-h-0', 'flex-1', 'overflow-y-auto']) {
      expect(bodyEl.classList.contains(k), k).toBe(true)
    }
    // header → body → footer, in that order
    expect([...c.children]).toEqual([header, bodyEl, footer])
  })

  it('no footer slot, no footer element', () => {
    mountDialog()
    expect(card().querySelector('footer')).toBeNull()
  })

  it('the meta slot sits left of the footer actions', () => {
    mountDialog(
      {},
      {
        meta: () => h('span', { id: 'meta' }, 'meta'),
        footer: () => h('button', { id: 'act' }, 'act')
      }
    )
    const footer = card().querySelector('footer') as HTMLElement
    expect(footer.firstElementChild?.contains(q('#meta'))).toBe(true)
    expect(footer.lastElementChild).toBe(q('#act'))
  })
})

describe('C18 — the cap', () => {
  it.each(SIZES)('size=%s renders the cap and its own width token', (size) => {
    mountDialog({ size })
    expect(card().classList.contains('max-h-(--dialog-max-h)')).toBe(true)
    expect(card().classList.contains(`w-(--dialog-w-${size})`)).toBe(true)
    expect(card().classList.contains('max-w-[90vw]')).toBe(true)
  })

  it('size defaults to md', () => {
    mountDialog()
    expect(card().classList.contains('w-(--dialog-w-md)')).toBe(true)
  })

  it('a fixed height is applied as given and keeps the cap', () => {
    mountDialog({ size: 'xl', height: '60vh' })
    expect(card().style.height).toBe('60vh')
    expect(card().classList.contains('max-h-(--dialog-max-h)')).toBe(true)
  })

  it.each(['100vh', '90vh', '5000px'])(
    'a height longer than the cap (%s) is rejected in dev',
    (height) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      mountDialog({ height })
      expect(err).toHaveBeenCalledWith(expect.stringContaining('exceeds the cap'))
    }
  )

  it.each(['min(80vh, 720px)', 'min(70vh, 560px)', '84vh', '300px', 'calc(100vh - 200px)'])(
    'a height within the cap (%s) is accepted',
    (height) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      mountDialog({ height })
      expect(err).not.toHaveBeenCalled()
    }
  )
})

describe('C19 — $attrs land on the card', () => {
  it('data-testid, data-dsqa and class go to the card, not the scrim', () => {
    mountDialog({
      'data-testid': 'bulk-dialog',
      'data-dsqa': 'containers-remove-dialog--orphan',
      class: 'extra-class'
    } as Partial<DialogProps>)
    expect(card().getAttribute('data-testid')).toBe('bulk-dialog')
    expect(card().getAttribute('data-dsqa')).toBe('containers-remove-dialog--orphan')
    expect(card().classList.contains('extra-class')).toBe(true)
    // the shell classes survive the merge
    expect(card().classList.contains('flex-col')).toBe(true)
    for (const a of ['data-testid', 'data-dsqa']) expect(scrim().hasAttribute(a)).toBe(false)
    expect(scrim().classList.contains('extra-class')).toBe(false)
  })
})

describe('C20 — layer → z', () => {
  it('dialog → --z-dialog, raised → --z-dialog-raised, on the scrim', () => {
    mountDialog()
    expect(scrim().classList.contains('z-(--z-dialog)')).toBe(true)
    expect(scrim().classList.contains('z-(--z-dialog-raised)')).toBe(false)
    document.body.innerHTML = ''
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    mountDialog({ layer: 'raised' })
    expect(scrim().classList.contains('z-(--z-dialog-raised)')).toBe(true)
    expect(scrim().classList.contains('z-(--z-dialog)')).toBe(false)
  })

  it('the scrim paints the scrim token and fades in', () => {
    mountDialog()
    expect(scrim().classList.contains('bg-scrim')).toBe(true)
    expect(scrim().classList.contains('anim-overlay-fade')).toBe(true)
    expect(card().classList.contains('anim-fade-in-scale')).toBe(true)
  })

  it('placement=top anchors the card to the top, center centers it', () => {
    mountDialog({ placement: 'top' })
    expect(scrim().classList.contains('items-start')).toBe(true)
    document.body.innerHTML = ''
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    mountDialog()
    expect(scrim().classList.contains('items-center')).toBe(true)
  })
})

describe('C21 — listeners', () => {
  it('unmounting while open removes every listener it added', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const w = mountDialog()
    await flushPromises()
    w.unmount()
    wrappers = wrappers.filter((x) => x !== w)
    const count = (spy: typeof add, type: string): number =>
      spy.mock.calls.filter((c) => c[0] === type).length
    expect(count(add, 'keydown')).toBeGreaterThan(0)
    for (const type of ['keydown', 'focusin']) {
      expect(count(remove, type), type).toBe(count(add, type))
    }
  })

  it('a closed dialog holds no listener, and Esc is not swallowed', async () => {
    const w = mountDialog({ open: false })
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    esc()
    document.removeEventListener('keydown', seen)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(closes(w)).toEqual([])
  })

  it('closing then reopening installs exactly one live handler', async () => {
    const w = mountDialog()
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    await nextTick()
    esc()
    expect(closes(w)).toEqual([['esc']])
  })
})

describe('C22 — the shell invariant that makes a scroll lock unnecessary', () => {
  it('main.css still declares overflow: hidden on html, body, #app', () => {
    const css = readFileSync(join(STYLES, 'main.css'), 'utf8')
    const rule = /(?:^|\n)html,\s*body,\s*#app\s*\{([^}]*)\}/.exec(css)
    expect(rule, 'the `html, body, #app` rule moved or was split').toBeTruthy()
    expect(rule?.[1]).toMatch(/overflow\s*:\s*hidden/)
  })
})

// ============================================================================================
// D* — design.md and the code agree token for token (batch 1 AC-4)
// ============================================================================================

const themesCss = readFileSync(join(STYLES, 'themes.css'), 'utf8')
const mainCss = readFileSync(join(STYLES, 'main.css'), 'utf8')
const designMd = readFileSync(join(__dirname, '..', 'design.md'), 'utf8')

/** `--name: value;` declarations of a CSS source, comments stripped. */
function declarations(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2].trim().replace(/\s+/g, ' ')])
  }
  return out
}

function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** The §9 `:root` block of design.md, as declarations. */
function designTokenBlock(): Map<string, string[]> {
  const section = designMd.split('\n## 9. Tokens (CSS)')[1] ?? ''
  const block = /```css\n([\s\S]*?)\n```/.exec(section)?.[1] ?? ''
  return declarations(block)
}

const DIALOG_TOKENS: Record<string, string> = {
  '--color-scrim': 'rgba(0, 0, 0, 0.55)',
  '--color-scrim-strong': 'rgba(0, 0, 0, 0.82)',
  '--dialog-max-h': '84vh',
  '--dialog-w-sm': '480px',
  '--dialog-w-md': '560px',
  '--dialog-w-lg': '720px',
  '--dialog-w-xl': '940px',
  '--z-dialog': '60',
  '--z-dialog-raised': '65',
  '--z-palette': '70'
}

describe('D01 — --dialog-max-h is declared exactly once (BUG-184 owns it)', () => {
  it('no stylesheet and no component redeclares it', () => {
    const sites: string[] = []
    for (const file of sourceFiles(RENDERER, ['.css', '.vue', '.ts'])) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const _ of text.matchAll(/--dialog-max-h\s*:/g)) sites.push(file)
    }
    expect(sites).toEqual([join(STYLES, 'themes.css')])
  })
})

describe('D02 — themes.css declares the dialog tokens with the specced values', () => {
  const decl = declarations(themesCss)
  it.each(Object.entries(DIALOG_TOKENS))('%s = %s, declared once', (name, value) => {
    expect(decl.get(name), name).toEqual([value])
  })

  it('main.css declares the title type token (13.5px / 20px)', () => {
    const decl2 = declarations(mainCss)
    expect(decl2.get('--text-dialog-title')).toEqual(['13.5px'])
    expect(decl2.get('--text-dialog-title--line-height')).toEqual(['20px'])
  })
})

describe('D03 — design.md §9 lists every dialog token with the same value', () => {
  const doc = designTokenBlock()
  it.each(Object.entries(DIALOG_TOKENS))('%s', (name, value) => {
    expect(doc.get(name), `${name} missing from design.md §9`).toEqual([value])
  })
})

describe('D04 — design.md §6 "Dialog" states the size scale and layers the code ships', () => {
  const section = (designMd.split('\n### Dialog\n')[1] ?? '').split('\n### ')[0]

  it('has the section', () => {
    expect(section.length).toBeGreaterThan(500)
  })

  it.each([
    ['--dialog-w-sm', '480px'],
    ['--dialog-w-md', '560px'],
    ['--dialog-w-lg', '720px'],
    ['--dialog-w-xl', '940px']
  ])('size row %s = %s', (token, px) => {
    const row = section.split('\n').find((l) => l.includes(`\`${token}\``))
    expect(row, token).toBeTruthy()
    expect(row).toContain(px)
  })

  it.each([
    ['--z-dialog', '60'],
    ['--z-dialog-raised', '65'],
    ['--z-palette', '70']
  ])('layer row %s = %s', (token, z) => {
    const row = section.split('\n').find((l) => l.startsWith(`| \`${token}\``))
    expect(row, token).toBeTruthy()
    expect(row).toContain(z)
  })

  it('names the cap, the scrim tokens and the title type token', () => {
    for (const t of [
      '--dialog-max-h',
      '--color-scrim',
      '--color-scrim-strong',
      '--text-dialog-title'
    ]) {
      expect(section, t).toContain(t)
    }
  })

  it('the stale footer fill and 9px radius are gone', () => {
    expect(section).not.toContain('#0f0f12')
    expect(section).not.toMatch(/radius\s*9px/i)
  })
})

describe('D05 — Dialog.vue reads only tokens', () => {
  const src = readFileSync(join(RENDERER, 'components', 'ui', 'Dialog.vue'), 'utf8')
  const template = src.split('<template>')[1] ?? ''

  it('every width class names a declared width token', () => {
    const decl = declarations(themesCss)
    const used = [...src.matchAll(/w-\((--dialog-w-[a-z]+)\)/g)].map((m) => m[1])
    expect(new Set(used)).toEqual(
      new Set(['--dialog-w-sm', '--dialog-w-md', '--dialog-w-lg', '--dialog-w-xl'])
    )
    for (const t of used) expect(decl.has(t), t).toBe(true)
  })

  it('no raw z-index, raw colour or raw radius in the template', () => {
    expect(src).not.toMatch(/z-\[\d+\]|z-index\s*:\s*\d/)
    expect(template).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}\b|bg-\[|border-\[|rounded-\[/)
  })

  it('uses the dialog.close key, present in both locales', () => {
    expect(src).toContain("t('dialog.close')")
    for (const loc of ['en', 'pt-BR']) {
      const json = JSON.parse(readFileSync(join(RENDERER, 'i18n', `${loc}.json`), 'utf8'))
      expect(typeof json.dialog.close, loc).toBe('string')
    }
  })
})
