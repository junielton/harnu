import { describe, it, expect } from 'vitest'
import { FOLDER_HUES, folderHue, folderInitial } from '../src/renderer/src/lib/folder-hue'
import * as schedulerList from '../src/renderer/src/components/scheduler-list'

describe('folder-hue (shared lib, T591 AC-3)', () => {
  it('is the same rule the Scheduler uses — scheduler-list re-exports it', () => {
    expect(schedulerList.folderHue).toBe(folderHue)
    expect(schedulerList.folderInitial).toBe(folderInitial)
    expect(schedulerList.FOLDER_HUES).toBe(FOLDER_HUES)
  })

  it('keeps the FNV-1a pin: the empty path lands on magenta', () => {
    expect(folderHue('')).toBe('magenta')
  })

  it('is stable per path and always inside the six-slot pool', () => {
    for (const p of ['/a/b', '/home/x/harnu', '~/Workspace/org/www']) {
      expect(folderHue(p)).toBe(folderHue(p))
      expect(FOLDER_HUES).toContain(folderHue(p))
    }
  })

  it('uses the first character, uppercased, for the avatar', () => {
    expect(folderInitial('harnu')).toBe('H')
    expect(folderInitial('  org/www')).toBe('O')
    expect(folderInitial('')).toBe('·')
  })
})
