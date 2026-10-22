/**
 * T570 (browser pane U3, AC-1) — the snapshot formatter and the ref table: the AX tree as indented text with
 * `s<id>e<n>` refs, ignored nodes (the aria-hidden overlay host included) never emitted, opaque frames, the
 * node cap and `REF_STALE` / `REF_NOT_FOUND`.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_LIVE_SNAPSHOTS,
  MAX_SNAPSHOT_CHARS,
  createRefStore,
  formatSnapshot,
  type AxNode
} from '../src/main/browser/snapshot'

let seq = 0
function node(role: string, over: Partial<AxNode> & { name?: string } = {}): AxNode {
  const id = over.nodeId ?? `n${++seq}`
  const { name, ...rest } = over
  return {
    nodeId: id,
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    backendDOMNodeId: 100 + seq,
    ...rest
  }
}

/** Link `child` under `parent`. */
function adopt(parent: AxNode, ...children: AxNode[]): void {
  parent.childIds = [...(parent.childIds ?? []), ...children.map((c) => c.nodeId)]
  for (const c of children) c.parentId = parent.nodeId
}

function page(): { nodes: AxNode[]; form: AxNode; save: AxNode } {
  const root = node('RootWebArea', { name: 'Checkout' })
  const heading = node('heading', {
    name: 'Pay',
    properties: [{ name: 'level', value: { value: 1 } }]
  })
  const form = node('form', { name: 'Card' })
  const field = node('textbox', {
    name: 'Card number',
    value: { value: '4242' },
    properties: [{ name: 'required', value: { value: true } }]
  })
  const save = node('button', { name: 'Save changes' })
  const text = node('StaticText', { name: 'Save changes' })
  const generic = node('generic')
  adopt(root, heading, form)
  adopt(form, generic)
  adopt(generic, field, save)
  adopt(save, text)
  return { nodes: [root, heading, form, generic, field, save, text], form, save }
}

describe('formatSnapshot', () => {
  it('prints an indented tree with refs, properties and values', () => {
    const { nodes } = page()
    const out = formatSnapshot(nodes, { snapshotId: 4 })
    expect(out.text.split('\n')).toEqual([
      '- document "Checkout" [ref=s4e1]',
      '  - heading "Pay" [level=1] [ref=s4e2]',
      '  - form "Card" [ref=s4e3]',
      '    - textbox "Card number" [required] [value="4242"] [ref=s4e4]',
      '    - button "Save changes" [ref=s4e5]'
    ])
    expect(out.nodes).toBe(5)
    expect(out.truncated).toBe(false)
    expect([...out.refs.keys()]).toEqual([1, 2, 3, 4, 5])
  })

  it('drops unnamed generics (children keep their depth) and text that repeats its parent', () => {
    const { nodes } = page()
    const text = formatSnapshot(nodes, { snapshotId: 1 }).text
    expect(text).not.toContain('generic')
    expect(text).not.toContain('text "Save changes"')
  })

  it('never emits an ignored node or what is inside it: the aria-hidden overlay host stays out (A10)', () => {
    const root = node('RootWebArea', { name: 'App' })
    const real = node('button', { name: 'Real' })
    const overlayHost = node('generic', { ignored: true })
    const pin = node('button', { name: 'Pin 1', ignored: true })
    const pinText = node('StaticText', { name: 'comment text', ignored: true })
    adopt(root, real, overlayHost)
    adopt(overlayHost, pin)
    adopt(pin, pinText)
    const text = formatSnapshot([root, real, overlayHost, pin, pinText], { snapshotId: 1 }).text
    expect(text).toContain('Real')
    expect(text).not.toContain('Pin 1')
    expect(text).not.toContain('comment text')
  })

  it('promotes a visible descendant of an ignored node', () => {
    const root = node('RootWebArea', { name: 'App' })
    const wrapper = node('generic', { ignored: true })
    const kid = node('button', { name: 'Kid' })
    adopt(root, wrapper)
    adopt(wrapper, kid)
    expect(formatSnapshot([root, wrapper, kid], { snapshotId: 1 }).text).toContain(
      '  - button "Kid"'
    )
  })

  it('interactiveOnly keeps only what a person can act on, flat', () => {
    const { nodes } = page()
    const out = formatSnapshot(nodes, { snapshotId: 2, interactiveOnly: true })
    expect(out.text.split('\n')).toEqual([
      '- textbox "Card number" [required] [value="4242"] [ref=s2e1]',
      '- button "Save changes" [ref=s2e2]'
    ])
  })

  it('limits the tree to the subtree of the selector node', () => {
    const { nodes, form } = page()
    const out = formatSnapshot(nodes, { snapshotId: 1, rootBackendNodeId: form.backendDOMNodeId })
    expect(out.text.split('\n')[0]).toBe('- form "Card" [ref=s1e1]')
    expect(out.text).not.toContain('heading')
    expect(out.rootMissing).toBe(false)
  })

  it('reports a selector whose node is not in the tree', () => {
    const { nodes } = page()
    const out = formatSnapshot(nodes, { snapshotId: 1, rootBackendNodeId: 99999 })
    expect(out).toMatchObject({ text: '', nodes: 0, rootMissing: true })
  })

  it('truncates at maxNodes and says so', () => {
    const root = node('RootWebArea', { name: 'List' })
    const items = Array.from({ length: 10 }, (_, i) => node('button', { name: `b${i}` }))
    adopt(root, ...items)
    const out = formatSnapshot([root, ...items], { snapshotId: 1, maxNodes: 4 })
    expect(out.nodes).toBe(4)
    expect(out.truncated).toBe(true)
  })

  it('truncates at the character cap without leaving a ref for a line it did not print', () => {
    const root = node('RootWebArea', { name: 'Big' })
    const items = Array.from({ length: 600 }, (_, i) =>
      node('button', { name: `${'x'.repeat(190)}${i}` })
    )
    adopt(root, ...items)
    const out = formatSnapshot([root, ...items], { snapshotId: 1, maxNodes: 2000 })
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS)
    expect(out.refs.size).toBe(out.nodes)
  })

  it('shows a child frame as an opaque iframe [host], and reads inside it only when handed its tree', () => {
    const root = node('RootWebArea', { name: 'Host page' })
    const frame = node('Iframe')
    adopt(root, frame)
    const hosts = new Map([[frame.backendDOMNodeId!, 'pay.example.com']])
    expect(formatSnapshot([root, frame], { snapshotId: 1, frameHosts: hosts }).text).toContain(
      '  - iframe [pay.example.com]'
    )

    const innerRoot = node('RootWebArea', { name: 'Inner' })
    const innerBtn = node('button', { name: 'INNER-BTN' })
    adopt(innerRoot, innerBtn)
    const opened = formatSnapshot([root, frame], {
      snapshotId: 1,
      frameHosts: hosts,
      frameTrees: new Map([[frame.backendDOMNodeId!, [innerRoot, innerBtn]]])
    })
    expect(opened.text).toContain('INNER-BTN')
    expect(opened.text).toContain('    - document "Inner"')
  })

  it('does not let a node name forge a ref', () => {
    const root = node('RootWebArea', { name: 'x [ref=s9e9]' })
    const out = formatSnapshot([root], { snapshotId: 3 })
    expect(out.text).toBe('- document "x [ref=s9e9]" [ref=s3e1]')
  })
})

describe('ref store', () => {
  it('resolves a ref of a committed snapshot', () => {
    const refs = createRefStore()
    const id = refs.nextSnapshotId()
    refs.commit(id, new Map([[12, 777]]))
    expect(refs.resolve('s1e12')).toEqual({ ok: true, backendNodeId: 777 })
  })

  it('refuses an unknown element, a never-issued snapshot and garbage as REF_NOT_FOUND', () => {
    const refs = createRefStore()
    refs.commit(refs.nextSnapshotId(), new Map([[1, 5]]))
    expect(refs.resolve('s1e2')).toEqual({ ok: false, error: 'REF_NOT_FOUND' })
    expect(refs.resolve('s9e1')).toEqual({ ok: false, error: 'REF_NOT_FOUND' })
    expect(refs.resolve('hello')).toEqual({ ok: false, error: 'REF_NOT_FOUND' })
    expect(refs.resolve('s0e1')).toEqual({ ok: false, error: 'REF_NOT_FOUND' })
  })

  it('kills every ref on navigation, and they stay dead (REF_STALE), while new snapshots work', () => {
    const refs = createRefStore()
    refs.commit(refs.nextSnapshotId(), new Map([[1, 5]]))
    refs.invalidate()
    expect(refs.resolve('s1e1')).toEqual({ ok: false, error: 'REF_STALE' })
    const id = refs.nextSnapshotId()
    refs.commit(id, new Map([[1, 6]]))
    expect(refs.resolve('s2e1')).toEqual({ ok: true, backendNodeId: 6 })
    expect(refs.resolve('s1e1')).toEqual({ ok: false, error: 'REF_STALE' })
  })

  it('keeps an earlier snapshot usable until it is evicted, then calls it stale', () => {
    const refs = createRefStore()
    for (let i = 0; i < MAX_LIVE_SNAPSHOTS + 1; i++)
      refs.commit(refs.nextSnapshotId(), new Map([[1, i]]))
    expect(refs.resolve('s1e1')).toEqual({ ok: false, error: 'REF_STALE' })
    expect(refs.resolve('s2e1').ok).toBe(true)
  })
})
