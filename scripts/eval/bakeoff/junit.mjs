/**
 * Reads the JUnit XML a hidden suite wrote. A scorer that accepted half a file would count a
 * killed run as a short pass, so the structure is checked strictly: a truncated file, unbalanced
 * tags or another root element is `JUNIT_CORRUPT`. Text content is not validated, since reporters
 * differ on what they escape in captured output.
 */

const corrupt = (message) => ({ code: 'JUNIT_CORRUPT', message })
const ROOTS = new Set(['testsuites', 'testsuite'])
const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity] ?? whole
    const hex = entity[1] === 'x' || entity[1] === 'X'
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

function attributesOf(source) {
  const attributes = {}
  for (const [, name, double, single] of source.matchAll(ATTRIBUTE)) {
    attributes[name] = decode(double ?? single)
  }
  return attributes
}

/** The index just past a tag's closing `>`, skipping quoted values; -1 when it never closes. */
function tagEnd(xml, from) {
  let quote = null
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i]
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i + 1
    }
  }
  return -1
}

/** What a special construct ends with, by how it starts; null for an ordinary tag. */
function delimited(xml, at) {
  for (const [open, close] of [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>']
  ]) {
    if (xml.startsWith(open, at)) return close
  }
  return null
}

/** Walks the document into one record per `testcase`, or a coded error. */
function readCases(xml) {
  const cases = []
  const stack = []
  let current = null
  let pendingError = null
  let rootSeen = false
  let i = 0

  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    const text = xml.slice(i, lt === -1 ? xml.length : lt)
    if (stack.length === 0 && text.trim() !== '') {
      return corrupt('There is text outside the root element.')
    }
    if (pendingError !== null) pendingError.text += text
    if (lt === -1) break

    const close = delimited(xml, lt)
    if (close !== null) {
      const end = xml.indexOf(close, lt)
      if (end === -1) return corrupt('A comment, CDATA section or instruction never closes.')
      if (close === ']]>' && pendingError !== null) {
        pendingError.text += xml.slice(lt + '<![CDATA['.length, end)
      }
      i = end + close.length
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = tagEnd(xml, lt)
      if (end === -1) return corrupt('A declaration never closes.')
      i = end
      continue
    }

    const end = tagEnd(xml, lt + 1)
    if (end === -1) return corrupt('A tag never closes.')
    const inner = xml.slice(lt + 1, end - 1)
    i = end

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (stack.pop() !== name) return corrupt(`The closing tag ${name} does not match.`)
      if (name === 'testcase') current = null
      if (name === 'error') pendingError = null
      continue
    }

    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameEnd = body.search(/\s/)
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd)
    if (name === '') return corrupt('A tag has no name.')
    const attributes = attributesOf(nameEnd === -1 ? '' : body.slice(nameEnd))

    if (stack.length === 0) {
      if (rootSeen) return corrupt('There is more than one root element.')
      if (!ROOTS.has(name)) return corrupt(`The root element is ${name}.`)
      rootSeen = true
    }

    if (name === 'testcase') {
      if (attributes.name === undefined) return corrupt('A testcase has no name.')
      current = {
        name: `${attributes.classname ?? ''}::${attributes.name}`,
        children: new Set(),
        errors: []
      }
      cases.push(current)
    } else if (current !== null && stack.at(-1) === 'testcase') {
      current.children.add(name)
      if (name === 'error') {
        const record = { message: attributes.message, text: '' }
        current.errors.push(record)
        if (!selfClosing) pendingError = record
      }
    }

    if (selfClosing) {
      if (name === 'testcase') current = null
    } else {
      stack.push(name)
    }
  }

  if (!rootSeen) return corrupt('There is no root element.')
  if (stack.length > 0) return corrupt('The document ends inside an element.')
  return { cases }
}

function statusOf({ children }) {
  if (children.has('failure')) return 'failed'
  if (children.has('error')) return 'error'
  if (children.has('skipped')) return 'skipped'
  return 'passed'
}

/**
 * Parse a JUnit XML document.
 *
 * @param {string} xml
 * @returns {{ testcases: { name: string, status: 'passed' | 'failed' | 'error' | 'skipped' }[] }
 *   | { code: 'JUNIT_CORRUPT', message: string }}
 */
export function parseJunit(xml) {
  const read = readCases(xml)
  if ('code' in read) return read
  return {
    testcases: read.cases.map((testcase) => ({
      name: testcase.name,
      status: statusOf(testcase)
    }))
  }
}

/**
 * Whether each test name passed in one run. A name that appears twice (a pytest teardown error
 * reports beside the call) passes only when every testcase carrying it passed.
 *
 * @param {{ name: string, status: string }[]} testcases
 * @returns {Map<string, boolean>}
 */
export function passedNames(testcases) {
  const passed = new Map()
  for (const { name, status } of testcases) {
    passed.set(name, (passed.get(name) ?? true) && status === 'passed')
  }
  return passed
}

/**
 * True when a `testcase` has an `error` child whose message matches `/collect/i`. The message is
 * the attribute; a traceback body is read only when there is none, because a traceback that merely
 * imports `collections` would match.
 *
 * @param {string} xml
 * @returns {boolean}
 */
export function hasCollectionError(xml) {
  const read = readCases(xml)
  if ('code' in read) return false
  return read.cases.some((testcase) =>
    testcase.errors.some(({ message, text }) => /collect/i.test(message ?? text))
  )
}
