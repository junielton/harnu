import { describe, expect, it } from 'vitest'
import {
  attachedSummary,
  batchBarVisible,
  batchSummary,
  composerKeyAction,
  destinationOptions,
  effectiveDestination,
  openPin
} from '../src/renderer/src/lib/browser-comment'
import type { CommentPinView } from '../src/shared/browser-comment'

const pin = (over: Partial<CommentPinView> = {}): CommentPinView => ({
  id: 'a',
  n: 1,
  state: 'draft',
  selector: '#a',
  component: null,
  styleCount: 14,
  hasCrop: true,
  hasHtml: true,
  comment: '',
  ...over
})

describe('composerKeyAction', () => {
  it('Enter sends, Shift+Enter keeps a draft, Esc closes', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false })).toBe('send')
    expect(composerKeyAction({ key: 'Enter', shiftKey: true })).toBe('draft')
    expect(composerKeyAction({ key: 'Escape', shiftKey: false })).toBe('close')
  })
  it('Ctrl/Cmd+Enter also sends; Alt+Enter and other keys do nothing', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, metaKey: true })).toBe('send')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe('send')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, altKey: true })).toBeNull()
    expect(composerKeyAction({ key: 'a', shiftKey: false })).toBeNull()
  })
  it('never submits while an IME composition is in progress', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull()
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBeNull()
    expect(composerKeyAction({ key: 'Escape', shiftKey: false, isComposing: true })).toBeNull()
  })
})

describe('batch bar', () => {
  it('counts drafts that have text and sent pins; an open empty composer is neither', () => {
    const pins = [
      pin({ id: '1', state: 'sent', comment: 'x' }),
      pin({ id: '2', comment: 'second' }),
      pin({ id: '3', comment: '   ' }),
      pin({ id: '4', comment: '' })
    ]
    expect(batchSummary(pins)).toEqual({ drafts: 1, sent: 1 })
    expect(batchBarVisible(pins)).toBe(true)
  })
  it('is hidden with nothing to show', () => {
    expect(batchBarVisible([])).toBe(false)
    expect(batchBarVisible([pin()])).toBe(false)
  })
})

describe('attachedSummary', () => {
  it('reports what rides with the pin', () => {
    expect(attachedSummary(pin())).toEqual({ crop: true, html: true, styles: 14 })
    expect(attachedSummary(pin({ hasCrop: false, styleCount: 0 }))).toEqual({
      crop: false,
      html: true,
      styles: 0
    })
  })
})

describe('destination', () => {
  const folder = ['s1', 's2', 's3']
  it('prefers the remembered choice, then the owner, then the selected session', () => {
    expect(
      effectiveDestination({
        remembered: 's3',
        owner: 's1',
        selectedId: 's2',
        folderSessionIds: folder
      })
    ).toBe('s3')
    expect(
      effectiveDestination({
        remembered: null,
        owner: 's1',
        selectedId: 's2',
        folderSessionIds: folder
      })
    ).toBe('s1')
    expect(
      effectiveDestination({
        remembered: null,
        owner: null,
        selectedId: 's2',
        folderSessionIds: folder
      })
    ).toBe('s2')
  })
  it('ignores a remembered or owner session that is no longer in the folder', () => {
    expect(
      effectiveDestination({
        remembered: 'gone',
        owner: 'gone2',
        selectedId: 's2',
        folderSessionIds: folder
      })
    ).toBe('s2')
  })
  it('is null when there is no session at all (the comment goes to the clipboard)', () => {
    expect(
      effectiveDestination({
        remembered: null,
        owner: null,
        selectedId: null,
        folderSessionIds: []
      })
    ).toBeNull()
    expect(
      effectiveDestination({
        remembered: null,
        owner: null,
        selectedId: 'x',
        folderSessionIds: ['s1']
      })
    ).toBeNull()
  })
  it('lists the owner first and marks it', () => {
    const list = destinationOptions(
      [
        { id: 's1', title: 'A' },
        { id: 's2', title: 'B' },
        { id: 's3', title: 'C' }
      ],
      's2'
    )
    expect(list.map((o) => [o.id, o.isOwner])).toEqual([
      ['s2', true],
      ['s1', false],
      ['s3', false]
    ])
  })
})

describe('openPin', () => {
  it('finds the open pin or null', () => {
    const pins = [pin({ id: 'a' }), pin({ id: 'b' })]
    expect(openPin(pins, 'b')?.id).toBe('b')
    expect(openPin(pins, 'zzz')).toBeNull()
    expect(openPin(pins, null)).toBeNull()
  })
})
