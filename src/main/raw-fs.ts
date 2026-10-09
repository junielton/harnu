/**
 * `fs.promises` WITHOUT Electron's asar patch, for destructive recursive walks.
 *
 * Inside Electron's main process `node:fs` treats any `*.asar` file as a directory. A recursive
 * delete of a tree that holds one (every Electron repo ships
 * `node_modules/electron/dist/resources/default_app.asar`) therefore cannot remove it and ends
 * `ENOTEMPTY`, which halted every Cleanup Remove at drop-deps. Electron's `original-fs` is the
 * same module with the patch off, so a recursive delete over arbitrary user trees goes through
 * this, never through `node:fs`.
 *
 * Outside Electron (vitest, plain node) there is no patch and no `original-fs`, so it falls back
 * to `node:fs`; `tests/asar-safe-removal.test.ts` runs the real thing under Electron.
 */

import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

type FsPromises = typeof nodeFs.promises

function load(): FsPromises {
  if (!process.versions.electron) return nodeFs.promises
  // A variable specifier keeps the bundler from trying to resolve an Electron-only module.
  const name = 'original-fs'
  const req: NodeRequire = typeof require === 'function' ? require : createRequire(import.meta.url)
  return (req(name) as typeof nodeFs).promises
}

let cached: FsPromises | null = null

/** The promises API with asar handling off. Resolved lazily so importing stays side-effect free. */
export function rawFs(): FsPromises {
  return (cached ??= load())
}

/** `rm -rf` that never mistakes a `*.asar` file for a directory. */
export function rawRm(target: string, opts: nodeFs.RmOptions): Promise<void> {
  return rawFs().rm(target, opts)
}
