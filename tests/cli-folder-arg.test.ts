import { describe, it, expect } from 'vitest'
import { resolveCliFolderArg } from '../src/main/cli-folder-arg'

/** T45 — pure resolver for `harnu .` / `harnu <path>`. */
describe('resolveCliFolderArg', () => {
  it('packaged: resolves "." against cwd', () => {
    expect(resolveCliFolderArg(['harnu', '.'], '/home/u/proj', 1)).toBe('/home/u/proj')
  })

  it('packaged: passes an absolute path through', () => {
    expect(resolveCliFolderArg(['harnu', '/abs/path'], '/home/u', 1)).toBe('/abs/path')
  })

  it('packaged: resolves a relative path against cwd', () => {
    expect(resolveCliFolderArg(['harnu', 'sub/dir'], '/home/u', 1)).toBe('/home/u/sub/dir')
  })

  it('skips flags and takes the first positional', () => {
    expect(resolveCliFolderArg(['harnu', '--remote-debugging-port=9222', '.'], '/w', 1)).toBe('/w')
  })

  it('returns null when there is no positional arg', () => {
    expect(resolveCliFolderArg(['harnu'], '/w', 1)).toBeNull()
    expect(resolveCliFolderArg(['harnu', '--flag'], '/w', 1)).toBeNull()
  })

  it('dev shape: startIndex 2 skips the app-path token at index 1', () => {
    // `electron . /proj` — index 1 is the app dir, index 2 is the user's folder.
    expect(resolveCliFolderArg(['electron', '.', '/proj'], '/w', 2)).toBe('/proj')
    // with only the app path, no user folder → null
    expect(resolveCliFolderArg(['electron', '.'], '/w', 2)).toBeNull()
  })
})
