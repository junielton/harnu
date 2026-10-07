// Static scan of the companion mod's source (P1W2 §7.7, drift way 1) and the authoring rules
// that are assertions on the SOURCE, independent of the manifest (MOD-1, MOD-3, SEC-9). No I/O:
// the caller reads the files. Deliberately small and regex-based: the mod's source is tiny and
// controlled, `claude plugin validate` (way 2) and a real load (way 3) are the other two checks.

/**
 * One pass over `text`: `code` has comments removed and strings intact (module specifiers and
 * event names live in strings); `blank` also replaces the CONTENT of every string and template
 * literal with spaces (so `$` or `import` inside a string never counts).
 */
function split(text) {
  let code = ''
  let blank = ''
  for (let i = 0; i < text.length;) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      code += c
      blank += c
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') {
          code += text[i]
          blank += ' '
          i++
        }
        if (i < text.length) {
          code += text[i]
          blank += text[i] === '\n' ? '\n' : ' '
          i++
        }
      }
      if (i < text.length) {
        code += c
        blank += c
        i++
      }
    } else {
      code += c
      blank += c
      i++
    }
  }
  return { code, blank }
}

export function stripCommentsAndStrings(text) {
  return split(text).blank
}

const uniqSorted = (set) => [...set].sort()

/**
 * Runs `re` over `blank` (so a match can never start inside a string or a comment) and hands the
 * callback the SAME span of `code`, where the string contents are still readable. The two share
 * offsets by construction.
 */
function* outsideStrings(blank, code, re) {
  for (const m of blank.matchAll(re))
    yield {
      index: m.index,
      text: code.slice(m.index, m.index + m[0].length),
      end: m.index + m[0].length
    }
}

/** Hooks (`on('…'`), `$.noun.method(` calls and literal `$.env.get('…')` reads. */
export function scanSurface(texts) {
  const hooks = new Set()
  const calls = new Set()
  const envReads = new Set()
  for (const text of texts) {
    const { code, blank } = split(text)
    for (const m of outsideStrings(blank, code, /\bon\(\s*(['"`])[^'"`]*\1/g)) {
      hooks.add(/(['"`])([^'"`]*)\1/.exec(m.text)[2])
    }
    for (const m of blank.matchAll(/\$\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
      calls.add(`$.${m[1]}.${m[2]}`)
    }
    for (const m of outsideStrings(blank, code, /\$\.env\.get\(\s*(['"`])[^'"`]*\1/g)) {
      const name = /(['"`])([^'"`$]+)\1/.exec(m.text)
      if (name) envReads.add(name[2])
    }
  }
  return { hooks: uniqSorted(hooks), calls: uniqSorted(calls), envReads: uniqSorted(envReads) }
}

/** The keys a plugin declares under `PluginState` in its contract. */
export function scanStateKeys(dts, plugin) {
  const { code } = split(dts)
  const at = code.indexOf(`'${plugin}'`)
  if (at < 0) return []
  const open = code.indexOf('{', at)
  const colon = code.indexOf(':', at)
  if (open < 0 || colon < 0 || code.slice(colon + 1, open).trim() !== '') return [] // e.g. Record<…>
  let depth = 0
  let end = open
  for (; end < code.length; end++) {
    if (code[end] === '{') depth++
    else if (code[end] === '}' && --depth === 0) break
  }
  const keys = new Set()
  let level = 0
  for (const line of code.slice(open + 1, end).split('\n')) {
    if (level === 0) {
      const m = /^\s*(['"]?)([A-Za-z_][\w-]*)\1\??\s*:/.exec(line)
      if (m) keys.add(m[2])
    }
    for (const ch of line) {
      if (ch === '{' || ch === '<' || ch === '(' || ch === '[') level++
      else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') level--
    }
  }
  return uniqSorted(keys)
}

/** Balanced `{ … }` starting at `from` (which must point at `{`); null when unbalanced. */
function balanced(code, from) {
  let depth = 0
  for (let i = from; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(from, i + 1)
  }
  return null
}

/** True unless the matcher PROVABLY cannot match the tool name `Bash` (MOD-3, B4 / #92533). */
function matcherCanMatchBash(argsFrom) {
  const rest = argsFrom.trimStart()
  if (!rest.startsWith('{')) return true // no matcher at all, or one we cannot read
  const obj = balanced(rest, 0)
  if (!obj) return true
  const m = /\btool\s*:\s*/.exec(obj)
  if (!m) return true
  const value = obj.slice(m.index + m[0].length)
  const str = /^(['"`])([^'"`]*)\1/.exec(value)
  if (str) return str[2] === 'Bash'
  if (value.startsWith('/')) {
    const re = /^\/((?:\\.|[^/\\\n])+)\/([a-z]*)/.exec(value)
    if (!re) return true
    try {
      return new RegExp(re[1], re[2]).test('Bash')
    } catch {
      return true
    }
  }
  return true
}

/** Violations of MOD-1, MOD-3 and SEC-9, as readable lines. `files`: `{ rel, text }[]`. */
export function checkForbidden(files) {
  const out = []
  for (const { rel, text } of files) {
    const { code, blank } = split(text)
    for (const m of outsideStrings(blank, code, /\bon\(\s*(['"`])[^'"`]*\1\s*,/g)) {
      if (!/tool\.call/.test(m.text) || !/^on\(\s*(['"`])tool\.call\1/.test(m.text)) continue
      if (matcherCanMatchBash(code.slice(m.end))) {
        out.push(
          `${rel}: a tool.call hook whose matcher can match Bash (breaks worktree isolation, #92533)`
        )
      }
    }
    for (const m of outsideStrings(blank, code, /\bon\(\s*(['"`])[^'"`]*\1/g)) {
      const name = /(['"`])([^'"`]*)\1/.exec(m.text)[2]
      if (name.includes('*')) out.push(`${rel}: the '*' event is forbidden`)
      if (name === 'turn.step') out.push(`${rel}: the turn.step event is forbidden`)
    }
    if (/\$\.process\./.test(blank)) out.push(`${rel}: $.process is forbidden`)
    if (/\$\.mcp\.call\b/.test(blank)) out.push(`${rel}: $.mcp.call is forbidden`)
    for (const m of outsideStrings(blank, code, /\$\.env\.get\(\s*[^)]*/g)) {
      if (!/^\$\.env\.get\(\s*(['"`])[^'"`$]+\1\s*$/.test(m.text.replace(/\s+$/, ''))) {
        out.push(`${rel}: $.env.get takes a literal name`)
      }
    }
    if (!/(^|\/)register\.tsx?$/.test(rel) && /(?<![\w$.])\$(?![\w$])/.test(blank)) {
      out.push(`${rel}: only register.ts may take or use \`$\` (MOD-1)`)
    }
  }
  return out
}

const STAGED = ['hooks', 'types']

const posixJoin = (dir, rel) => {
  const parts = dir.split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

/**
 * MOD-1 import discipline: `hooks/contract.ts` has no imports at all; every other import is the
 * engine's own `claude-code` or relative AND lands in a directory that is staged (`hooks/`,
 * `types/`): tests, fixtures and `api-surface.json` are never shipped.
 */
export function checkImports(files) {
  const out = []
  for (const { rel, text } of files) {
    const { code } = split(text)
    const specs = []
    for (const m of code.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?(['"])([^'"]+)\1/g
    )) {
      specs.push(m[2])
    }
    const dynamic = /\bimport\s*\(|\brequire\s*\(/.test(code)
    if (rel === 'hooks/contract.ts') {
      if (specs.length > 0 || dynamic) out.push(`${rel}: contract.ts must have zero imports`)
      continue
    }
    if (dynamic) out.push(`${rel}: dynamic import and require are forbidden`)
    for (const spec of specs) {
      if (spec === 'claude-code') continue
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        out.push(`${rel}: '${spec}' is not relative (no bundler: only relative imports)`)
        continue
      }
      const target = posixJoin(rel.split('/').slice(0, -1).join('/'), spec)
      if (!STAGED.some((d) => target === d || target.startsWith(`${d}/`))) {
        out.push(`${rel}: '${spec}' resolves outside the staged directories (${target})`)
      }
    }
  }
  return out
}
