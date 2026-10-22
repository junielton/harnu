/**
 * Tiny pure rules the plan-level content check shares with the verbs (T569 delta 1, F6), kept import-light so
 * `content-check.ts` does not pull the file-system parts of the page protocol.
 */
export { isDeniedPagePath } from './page-url'

/** Every patch mode but `remove` needs `html`. */
export function isPatchModeNeedingHtml(mode: string): boolean {
  return mode === 'inner' || mode === 'outer' || mode === 'append' || mode === 'prepend'
}
