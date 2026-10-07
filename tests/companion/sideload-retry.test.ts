import { describe, expect, it } from 'vitest'
import {
  RETRY_WINDOW_MS,
  injectedPluginDirs,
  shouldRetryWithoutSideload,
  stripInjectedPluginDirs
} from '../../src/main/companion/sideload-retry-core'

const base = { injected: true, exitCode: 1, livedMs: 800, helloSeen: false, retried: false }

describe('shouldRetryWithoutSideload', () => {
  it('retry truth table', () => {
    expect(shouldRetryWithoutSideload(base)).toBe(true)
    // flip any one input and it is false
    expect(shouldRetryWithoutSideload({ ...base, injected: false })).toBe(false)
    expect(shouldRetryWithoutSideload({ ...base, exitCode: 0 })).toBe(false)
    expect(shouldRetryWithoutSideload({ ...base, livedMs: RETRY_WINDOW_MS })).toBe(false)
    expect(shouldRetryWithoutSideload({ ...base, livedMs: 12_000 })).toBe(false)
    expect(shouldRetryWithoutSideload({ ...base, helloSeen: true })).toBe(false)
    expect(shouldRetryWithoutSideload({ ...base, retried: true })).toBe(false)
  })

  it('just under the window still retries; any non-zero code counts', () => {
    expect(shouldRetryWithoutSideload({ ...base, livedMs: RETRY_WINDOW_MS - 1 })).toBe(true)
    expect(shouldRetryWithoutSideload({ ...base, exitCode: 137 })).toBe(true)
  })
})

describe('injectedPluginDirs and stripInjectedPluginDirs', () => {
  const user = ['--model', 'x', '--plugin-dir', '/user/own']

  it('finds the directories Harnu added, not the user’s', () => {
    const after = [
      '--model',
      'x',
      '--plugin-dir',
      '/c',
      '--plugin-dir',
      '/user/own',
      '--plugin-dir',
      '/skills'
    ]
    expect(injectedPluginDirs(user, after)).toEqual(['/c', '/skills'])
    expect(injectedPluginDirs(user, user)).toEqual([])
  })

  it('strips only Harnu’s flags', () => {
    const argv = [
      '--model',
      'x',
      '--plugin-dir',
      '/c',
      '--plugin-dir',
      '/user/own',
      '--plugin-dir',
      '/skills',
      '--',
      'keep --plugin-dir /c in the prompt'
    ]
    expect(stripInjectedPluginDirs(argv, ['/c', '/skills'])).toEqual([
      '--model',
      'x',
      '--plugin-dir',
      '/user/own',
      '--',
      'keep --plugin-dir /c in the prompt'
    ])
  })

  it('strips the =<dir> spelling too and is a no-op with nothing injected', () => {
    expect(stripInjectedPluginDirs(['--plugin-dir=/c', '--x'], ['/c'])).toEqual(['--x'])
    const argv = ['--plugin-dir', '/u']
    expect(stripInjectedPluginDirs(argv, [])).toEqual(argv)
  })
})
