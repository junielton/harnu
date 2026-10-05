/**
 * Which directories the Explorer pane must expand to make `target` visible.
 *
 * The tree is lazy — a row exists only once its parent directory has been
 * listed AND expanded — so revealing a path is a walk down the chain from the
 * root. Pure and separator-agnostic: the renderer has no node `path`, and the
 * same code runs against POSIX and Windows absolute paths.
 *
 * Returns the chain shallowest-first, EXCLUDING `target` (a directory target is
 * expanded by the caller as a separate step; a file target is never expanded),
 * or `null` when `target` is the root itself or lies outside it.
 */
export function ancestorChain(root: string, target: string): string[] | null {
  const sep = target.includes('\\') && !target.includes('/') ? '\\' : '/'
  const trimmedRoot = root.replace(/[/\\]+$/, '')
  const trimmedTarget = target.replace(/[/\\]+$/, '')
  if (!trimmedRoot || !trimmedTarget) return null
  if (trimmedTarget === trimmedRoot) return null
  if (!trimmedTarget.startsWith(trimmedRoot + sep)) return null

  const rel = trimmedTarget.slice(trimmedRoot.length + 1)
  const segments = rel.split(/[/\\]/).filter(Boolean)
  // Drop the last segment — that's the target itself.
  const dirs = segments.slice(0, -1)
  const out: string[] = []
  let current = trimmedRoot
  for (const seg of dirs) {
    current = `${current}${sep}${seg}`
    out.push(current)
  }
  return out
}
