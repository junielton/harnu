/**
 * Folder hue (design.md §2 "Folder hue") — shared by every surface that groups or
 * marks rows by folder: the Scheduler worker list (T590) and the System Monitor's
 * session cards and rows (T591). No Vue import, so it unit-tests in the plain `node`
 * vitest environment.
 */

/**
 * The six `--term-ansi-*` slots a folder may wear, in pool order. `green` / `red`
 * are excluded on purpose: they already mean running / failing, and a hue must
 * never read as a status. The component side maps each name to a `.fh-<name>`
 * helper class in `main.css`.
 */
export const FOLDER_HUES = [
  'blue',
  'magenta',
  'cyan',
  'yellow',
  'bright-red',
  'bright-blue'
] as const
export type FolderHue = (typeof FOLDER_HUES)[number]

/**
 * `FNV-1a(path) % 6`. Stable per path — never per render order — so a folder keeps
 * its colour across restarts, sorts and filters, and adding a folder never recolours
 * another. Hashes 16-bit code units; the exact hash is part of the design contract.
 */
export function folderHue(path: string): FolderHue {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return FOLDER_HUES[h % FOLDER_HUES.length]
}

/** The avatar letter: first character of the folder name, uppercased. */
export function folderInitial(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '·'
}
