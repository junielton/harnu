import { describe, it, expect } from 'vitest'
import { sortSessions } from '../src/renderer/src/components/session-sort'

/**
 * Session sort generalizes the attention float into the three user-facing sort
 * modes: `attention` (needs-input → failed → rest), `recent` (newest modified
 * first), and `name` (case-insensitive A→Z over summary/firstPrompt). Every
 * mode is stable (equal keys keep input order) and returns a new array.
 */
const s = (
  id: string,
  fields: { taskState?: string; modified?: string; summary?: string; firstPrompt?: string } = {}
): { id: string; taskState?: string; modified: string; summary: string; firstPrompt: string } => ({
  id,
  taskState: fields.taskState,
  modified: fields.modified ?? '',
  summary: fields.summary ?? '',
  firstPrompt: fields.firstPrompt ?? ''
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids = (arr: ReadonlyArray<{ id: string }>): string[] => arr.map((x) => x.id)

describe('sortSessions', () => {
  describe("'attention' mode", () => {
    it('floats needs-input then failed to the top, keeping the rest in input order', () => {
      const input = [
        s('a'),
        s('b', { taskState: 'needs-input' }),
        s('c', { taskState: 'working' }),
        s('d', { taskState: 'failed' }),
        s('e', { taskState: 'needs-input' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'attention'))).toEqual(['b', 'e', 'd', 'a', 'c'])
    })

    it('preserves input order when ranks are equal (stable)', () => {
      const input = [
        s('a', { taskState: 'needs-input' }),
        s('b', { taskState: 'needs-input' }),
        s('c', { taskState: 'needs-input' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'attention'))).toEqual(['a', 'b', 'c'])
    })
  })

  describe("'recent' mode", () => {
    it('orders by modified date descending (newest first)', () => {
      const input = [
        s('a', { modified: '2026-01-01T00:00:00.000Z' }),
        s('b', { modified: '2026-06-10T12:00:00.000Z' }),
        s('c', { modified: '2026-03-15T08:00:00.000Z' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'recent'))).toEqual(['b', 'c', 'a'])
    })

    it('keeps input order for two equal dates (stable)', () => {
      const input = [
        s('a', { modified: '2026-06-10T12:00:00.000Z' }),
        s('b', { modified: '2026-06-10T12:00:00.000Z' }),
        s('c', { modified: '2026-06-10T12:00:00.000Z' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'recent'))).toEqual(['a', 'b', 'c'])
    })

    it('sorts an invalid/empty modified string to the end', () => {
      const input = [
        s('a', { modified: 'not-a-date' }),
        s('b', { modified: '2026-01-01T00:00:00.000Z' }),
        s('c', { modified: '' }),
        s('d', { modified: '2026-06-10T12:00:00.000Z' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = ids(sortSessions(input as any, 'recent'))
      expect(out).toEqual(['d', 'b', 'a', 'c'])
    })
  })

  describe("'name' mode", () => {
    it('sorts case-insensitively ascending by summary', () => {
      const input = [
        s('a', { summary: 'Zebra' }),
        s('b', { summary: 'apple' }),
        s('c', { summary: 'Mango' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(sortSessions(input as any, 'name').map((x) => x.summary)).toEqual([
        'apple',
        'Mango',
        'Zebra'
      ])
    })

    it('falls back to firstPrompt when summary is empty', () => {
      const input = [
        s('a', { summary: 'Zebra' }),
        s('b', { summary: '', firstPrompt: 'apple' }),
        s('c', { summary: 'Mango' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'name'))).toEqual(['b', 'c', 'a'])
    })

    it('preserves input order for equal names (stable)', () => {
      const input = [
        s('a', { summary: 'same' }),
        s('b', { summary: 'Same' }),
        s('c', { summary: 'SAME' })
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(ids(sortSessions(input as any, 'name'))).toEqual(['a', 'b', 'c'])
    })
  })

  describe('purity', () => {
    it('returns a new array and does not mutate the input for any mode', () => {
      const input = [
        s('a', { taskState: 'idle', modified: '2026-01-01T00:00:00.000Z', summary: 'Zebra' }),
        s('b', { taskState: 'needs-input', modified: '2026-06-10T12:00:00.000Z', summary: 'apple' })
      ]
      const snapshot = JSON.parse(JSON.stringify(input))
      for (const mode of ['attention', 'recent', 'name'] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = sortSessions(input as any, mode)
        expect(out).not.toBe(input)
        expect(input).toEqual(snapshot)
      }
    })
  })
})
