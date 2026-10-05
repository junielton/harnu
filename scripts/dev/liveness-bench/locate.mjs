// Locates logpoint lines in the built main bundle by pattern instead of by hard-coded
// line number, so the bench survives any rebuild. A pattern that stops matching throws:
// that is the signal to update the pattern, never to guess a line.
import { readFileSync } from 'node:fs'

/** 1-based line of the `occurrence`-th line matching `pattern` in the built main bundle. */
export function locateLine(bundleText, pattern, occurrence = 0) {
  const lines = bundleText.split('\n')
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      if (seen === occurrence) return i + 1
      seen++
    }
  }
  throw new Error(`pattern not found in bundle: ${pattern}`)
}

export function loadBundle(path = 'out/main/index.js') {
  return readFileSync(path, 'utf8')
}

/**
 * Logpoint lines for every counter the bench reads, as 1-based lines of `out/main/index.js`.
 * Offsets are relative to the matched line; each one lands on the first statement of the
 * region (a V8 breakpoint on a continuation line never fires).
 */
export function locateLogpoints(B = loadBundle()) {
  return {
    // `const { stdout } = await runFile(` two lines above the rev-parse argv
    gitRev: locateLine(B, /"rev-parse", "--abbrev-ref", "HEAD", "--git-common-dir"/) - 2,
    // `try {` above `git status --porcelain` in the per-folder probe
    gitStatus: locateLine(B, /"git", \["-C", folderPath, "status", "--porcelain"\]/) - 1,
    // U2's header cache: a miss re-scrapes the whole head, a known file reads only its
    // appended bytes.
    jsonlMiss: locateLine(B, /const fresh = await scrapeJsonlHeaderFresh\(absPath/),
    jsonlAppend: locateLine(B, /const header = await scrapeJsonlHeaderAppend\(absPath/),
    subHdr: locateLine(B, /^async function scrapeSubagentHeader\(/) + 1,
    notify: locateLine(B, /^function notifySlugChanged\(/) + 2,
    slugStart: locateLine(B, /scanStats\.slugScans \+= 1/),
    slugEnd: locateLine(B, /= mergeSlugSessions\(/),
    fullStart: locateLine(B, /scanStats\.fullScans \+= 1/, 1),
    fullEnd: locateLine(B, /= replaceAllSessions\(/, 1),
    // Session and subagent updates leave through the watcher's coalescer (U3a): one
    // `send(ev.channel, ev.payload)` in its flush carries both channels, and the logpoint
    // tells them apart by `ev.channel`.
    sessUpd: locateLine(B, /^\s*send2?\(ev\.channel, ev\.payload\)/),
    scanUncached: locateLine(B, /^async function scanFoldersUncached\(/) + 1
  }
}
