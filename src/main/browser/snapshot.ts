/**
 * The browser pane's snapshot, pure core (T564 U3, spec §6.1 row 4 and §6.2): a CDP
 * `Accessibility.getFullAXTree` result turned into an indented text tree with stable element refs.
 *
 *   - button "Save changes" [ref=s4e12]
 *
 * The tree is what a person perceives (the accessibility tree), not the DOM. A ref is `s<snapshotId>e<n>` and
 * maps to a CDP `backendNodeId`; it is valid for the page it was made on and dies on navigation
 * (`REF_STALE`). Nodes the browser marks `ignored` are never emitted, which is also how the point-and-comment
 * overlay stays out of the tree: its host carries `aria-hidden="true"`, and Chromium then marks the whole
 * subtree ignored (spec §6.2, assumption A10). Child frames are opaque `iframe [host]` nodes unless the caller
 * supplies their trees (assumption A11). Pure (ADR-0001): no electron, no clock.
 */

/** The slice of a CDP `Accessibility.AXNode` this module reads. */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

export const DEFAULT_MAX_NODES = 2000
export const MAX_NODES_CEILING = 2000
export const MAX_SNAPSHOT_CHARS = 60_000
const MAX_NAME_CHARS = 200
/** Hard recursion guard for a pathological tree (the walk is iterative, this bounds its output depth). */
const MAX_DEPTH = 80

/** Roles a person can act on; `interactiveOnly` keeps exactly these. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'slider',
  'spinbutton',
  'treeitem',
  'disclosuretriangle',
  'popupbutton',
  'colorwell',
  'textfield',
  'textarea'
])

/** Fields whose value is printed on their own line. */
const INPUT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

/** Roles that carry no meaning of their own: dropped when unnamed, their children keep their depth. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set(['generic', 'none', 'presentation', 'group'])
/** Roles never emitted, children included (text fragments the parent already names). */
const SKIPPED_ROLES: ReadonlySet<string> = new Set(['inlinetextbox', 'linebreak'])

const FLAG_PROPERTIES = [
  'checked',
  'disabled',
  'expanded',
  'selected',
  'pressed',
  'required',
  'readonly',
  'invalid',
  'multiselectable'
] as const

export interface FormatOptions {
  /** The id this snapshot was allocated by the ref store: refs are written as `s<id>e<n>` directly. */
  snapshotId: number
  interactiveOnly?: boolean
  maxNodes?: number
  /** Only the subtree of the AX node(s) for this DOM node (the `selector` form). */
  rootBackendNodeId?: number
  /** Opaque child frames: the iframe element's backendNodeId → the frame's AX nodes (the `frames` form). */
  frameTrees?: ReadonlyMap<number, readonly AxNode[]>
  /** Opaque child frames: the iframe element's backendNodeId → the host to show (`iframe [host]`). */
  frameHosts?: ReadonlyMap<number, string>
}

export interface FormattedSnapshot {
  text: string
  /** Nodes emitted. */
  nodes: number
  truncated: boolean
  /** The selector's DOM node had no AX node at all (display:none, aria-hidden), so nothing was emitted. */
  rootMissing: boolean
  /** `n` (the number after `e` in a ref) → the CDP backendNodeId it stands for. */
  refs: Map<number, number>
  /** `n` → the role and name the line showed, to tell later whether the element still looks the same. */
  labels: Map<number, string>
}

interface Source {
  byId: Map<string, AxNode>
}

function indexOf(nodes: readonly AxNode[]): Source {
  return { byId: new Map(nodes.map((n) => [n.nodeId, n])) }
}

function roleOf(n: AxNode): string {
  const raw = n.role?.value
  const role = typeof raw === 'string' ? raw : ''
  return role
}

function displayRole(role: string): string {
  switch (role) {
    case 'StaticText':
      return 'text'
    case 'RootWebArea':
    case 'WebArea':
      return 'document'
    case 'Iframe':
      return 'iframe'
    case 'LabelText':
      return 'label'
    default:
      return role
  }
}

function strOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function cleanName(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_NAME_CHARS ? flat : `${flat.slice(0, MAX_NAME_CHARS)}…`
}

function propertyOf(n: AxNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value
}

function describeProps(n: AxNode): string {
  const parts: string[] = []
  const level = propertyOf(n, 'level')
  if (typeof level === 'number') parts.push(`level=${level}`)
  for (const key of FLAG_PROPERTIES) {
    const v = propertyOf(n, key)
    if (v === undefined || v === false || v === 'false') continue
    parts.push(v === true || v === 'true' ? key : `${key}=${strOf(v)}`)
  }
  if (propertyOf(n, 'focused') === true) parts.push('focused')
  const value = strOf(n.value?.value)
  if (value !== '') parts.push(`value=${JSON.stringify(cleanName(value))}`)
  return parts.length === 0 ? '' : ` [${parts.join('] [')}]`
}

interface Frame {
  source: Source
  id: string
  depth: number
  /** The emitted ancestor's name, to drop a text node that only repeats it. */
  parentName: string
}

/**
 * Format `nodes` (the first is the root, as `Accessibility.getFullAXTree` returns them) into a snapshot.
 * Refs are numbered from 1 in the order lines are emitted, and written into the text as final `s<id>e<n>` names
 * (never a placeholder rewritten afterwards, which a page could forge in a node name).
 */
export function formatSnapshot(nodes: readonly AxNode[], opts: FormatOptions): FormattedSnapshot {
  const maxNodes = Math.min(Math.max(1, opts.maxNodes ?? DEFAULT_MAX_NODES), MAX_NODES_CEILING)
  const lines: string[] = []
  const refs = new Map<number, number>()
  const labels = new Map<number, string>()
  let chars = 0
  let truncated = false
  let rootMissing = false
  let nextRef = 1

  const root = indexOf(nodes)
  const start: Frame[] = []
  if (opts.rootBackendNodeId !== undefined) {
    const hits = nodes.filter((n) => n.backendDOMNodeId === opts.rootBackendNodeId)
    if (hits.length === 0) rootMissing = true
    for (const h of hits.reverse())
      start.push({ source: root, id: h.nodeId, depth: 0, parentName: '' })
  } else if (nodes.length > 0) {
    // The root(s): nodes with no parent in this list.
    const roots = nodes.filter((n) => n.parentId === undefined || !root.byId.has(n.parentId))
    for (const r of (roots.length > 0 ? roots : [nodes[0]!]).reverse()) {
      start.push({ source: root, id: r.nodeId, depth: 0, parentName: '' })
    }
  }

  const stack: Frame[] = start
  while (stack.length > 0) {
    const frame = stack.pop()!
    const node = frame.source.byId.get(frame.id)
    if (!node) continue
    const role = roleOf(node)
    const lower = role.toLowerCase()
    const name = cleanName(strOf(node.name?.value))
    const children = (node.childIds ?? []).slice().reverse()
    const pushChildren = (depth: number, parentName: string): void => {
      if (depth > MAX_DEPTH) return
      for (const c of children) stack.push({ source: frame.source, id: c, depth, parentName })
    }

    if (SKIPPED_ROLES.has(lower)) continue
    if (node.ignored === true) {
      // An ignored node is invisible, but a non-ignored descendant (rare) is promoted to its depth.
      pushChildren(frame.depth, frame.parentName)
      continue
    }
    const isText = role === 'StaticText'
    if (isText && (name === '' || name === frame.parentName)) continue
    if (TRANSPARENT_ROLES.has(lower) && name === '') {
      pushChildren(frame.depth, frame.parentName)
      continue
    }
    const interactive = INTERACTIVE_ROLES.has(lower)
    if (opts.interactiveOnly && !interactive) {
      pushChildren(frame.depth, frame.parentName)
      continue
    }

    if (lines.length >= maxNodes) {
      truncated = true
      break
    }
    const isFrame = role === 'Iframe'
    const backend = node.backendDOMNodeId
    let line = `${'  '.repeat(opts.interactiveOnly ? 0 : frame.depth)}- ${displayRole(role)}`
    if (name !== '' && !isFrame) line += ` ${JSON.stringify(name)}`
    if (isFrame) {
      const host = backend !== undefined ? opts.frameHosts?.get(backend) : undefined
      if (host) line += ` [${host}]`
    }
    line += describeProps(node)
    if (backend !== undefined && !isText) {
      const n = nextRef++
      refs.set(n, backend)
      labels.set(n, refLabel(role, name))
      line += ` [ref=${refName(opts.snapshotId, n)}]`
    }
    if (chars + line.length + 1 > MAX_SNAPSHOT_CHARS) {
      truncated = true
      // Un-allocate the ref this line would have owned.
      if (backend !== undefined && !isText) {
        refs.delete(nextRef - 1)
        labels.delete(nextRef - 1)
        nextRef--
      }
      break
    }
    chars += line.length + 1
    lines.push(line)

    // A frame's own tree replaces the opaque node's (non-existent) children when the caller read it.
    const inner = isFrame && backend !== undefined ? opts.frameTrees?.get(backend) : undefined
    if (inner && inner.length > 0) {
      const innerSource = indexOf(inner)
      const innerRoots = inner.filter(
        (n) => n.parentId === undefined || !innerSource.byId.has(n.parentId)
      )
      for (const r of (innerRoots.length > 0 ? innerRoots : [inner[0]!]).reverse()) {
        stack.push({ source: innerSource, id: r.nodeId, depth: frame.depth + 1, parentName: '' })
      }
    } else {
      // A field's own value is printed on its line; the text node that repeats it is noise.
      const fieldValue = INPUT_ROLES.has(lower) ? cleanName(strOf(node.value?.value)) : ''
      pushChildren(frame.depth + 1, fieldValue !== '' ? fieldValue : name)
    }
  }

  return { text: lines.join('\n'), nodes: lines.length, truncated, rootMissing, refs, labels }
}

/** The identity of an element as a snapshot line shows it: its role and its (cleaned) accessible name. */
export function refLabel(role: string, name: string): string {
  return `${displayRole(role)}|${cleanName(name)}`
}

export function refName(snapshotId: number, n: number): string {
  return `s${snapshotId}e${n}`
}

/* ------------------------------------------------------------------------------------------------ */
/* The ref table                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/** Snapshots whose refs still resolve (an agent may act on an earlier one while the page has not navigated). */
export const MAX_LIVE_SNAPSHOTS = 8

export type RefResolution =
  | { ok: true; backendNodeId: number; label?: string }
  | { ok: false; error: 'REF_STALE' | 'REF_NOT_FOUND' }

export interface RefStore {
  /** Allocate the id for the snapshot about to be taken. */
  nextSnapshotId(): number
  /** Remember a finished snapshot's refs, evicting the oldest beyond {@link MAX_LIVE_SNAPSHOTS}. */
  commit(
    snapshotId: number,
    refs: ReadonlyMap<number, number>,
    labels?: ReadonlyMap<number, string>
  ): void
  /** `s<id>e<n>` → the backendNodeId. */
  resolve(ref: string): RefResolution
  /** The page navigated: every ref made so far is dead (`REF_STALE`), and stays dead. */
  invalidate(): void
}

export function createRefStore(): RefStore {
  let issued = 0
  const live = new Map<number, ReadonlyMap<number, number>>()
  const liveLabels = new Map<number, ReadonlyMap<number, string>>()
  return {
    nextSnapshotId: () => ++issued,
    commit(snapshotId, refs, labels) {
      live.set(snapshotId, refs)
      if (labels) liveLabels.set(snapshotId, labels)
      while (live.size > MAX_LIVE_SNAPSHOTS) {
        const oldest = live.keys().next().value
        if (oldest === undefined) break
        live.delete(oldest)
        liveLabels.delete(oldest)
      }
    },
    resolve(ref) {
      const m = /^s(\d{1,9})e(\d{1,9})$/.exec(ref)
      if (!m) return { ok: false, error: 'REF_NOT_FOUND' }
      const snapshotId = Number(m[1])
      const n = Number(m[2])
      // A snapshot this pane never took cannot have made this ref.
      if (snapshotId < 1 || snapshotId > issued) return { ok: false, error: 'REF_NOT_FOUND' }
      const table = live.get(snapshotId)
      // Taken, but navigated away from or evicted: dead.
      if (!table) return { ok: false, error: 'REF_STALE' }
      const backendNodeId = table.get(n)
      if (backendNodeId === undefined) return { ok: false, error: 'REF_NOT_FOUND' }
      const label = liveLabels.get(snapshotId)?.get(n)
      return { ok: true, backendNodeId, ...(label !== undefined ? { label } : {}) }
    },
    invalidate() {
      live.clear()
      liveLabels.clear()
    }
  }
}
