import { describe, it, expect } from 'vitest'
import { parseProcStat, parseProcStatm, PAGE_SIZE_BYTES } from '../src/main/monitor/proc-parse'

describe('parseProcStat', () => {
  it('parses a normal /proc/<pid>/stat line', () => {
    const line =
      '1234 (claude) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 4 0 999 0 0 18446744073709551615'
    expect(parseProcStat(line)).toEqual({
      pid: 1234,
      ppid: 1,
      comm: 'claude',
      utime: 250,
      stime: 50
    })
  })

  it('handles a comm containing spaces and parens (e.g. "(sd-pam)")', () => {
    const line =
      '99 (node (worker)) S 1 99 99 0 -1 4194304 5 0 0 0 12 3 0 0 20 0 4 0 999 0 0 18446744073709551615'
    expect(parseProcStat(line)).toEqual({
      pid: 99,
      ppid: 1,
      comm: 'node (worker)',
      utime: 12,
      stime: 3
    })
  })

  it('returns null for an empty string', () => {
    expect(parseProcStat('')).toBeNull()
  })

  it('returns null when there is no parenthesized comm', () => {
    expect(parseProcStat('1234 claude S 1')).toBeNull()
  })

  it('returns null when the fields after comm are truncated (no utime/stime)', () => {
    expect(parseProcStat('1234 (claude) S 1')).toBeNull()
  })
})

describe('parseProcStatm', () => {
  it('parses resident pages into bytes using the default page size', () => {
    // size=1000 resident=250 pages
    expect(parseProcStatm('1000 250 200 10 0 500 0')).toBe(250 * PAGE_SIZE_BYTES)
  })

  it('honors a custom page size', () => {
    expect(parseProcStatm('1000 250 200 10 0 500 0', 16384)).toBe(250 * 16384)
  })

  it('returns null for unparseable input', () => {
    expect(parseProcStatm('')).toBeNull()
    expect(parseProcStatm('not-a-number')).toBeNull()
  })
})
