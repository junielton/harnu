/**
 * Every icon-only control has a tooltip (design.md §6 "Tooltip"). The app tooltip shows an element's
 * `title`, or the `aria-label` of a control with no visible text, so a control with neither shows
 * nothing on hover and has no accessible name. This walks every renderer template and fails on a
 * `<button>` (or `role="button"`, `tab`, `menuitem`) whose content has no text and that binds neither.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const ROOT = resolve(__dirname, '..')
const SRC = join(ROOT, 'src/renderer/src')

// compiler-core node types
const ELEMENT = 1
const TEXT = 2
const INTERPOLATION = 5
const ATTRIBUTE = 6
const DIRECTIVE = 7
const IF = 9
const IF_BRANCH = 10
const FOR = 11

const CONTROL_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return vueFiles(p)
    return d.name.endsWith('.vue') ? [p] : []
  })
}

/** `name` set statically, bound with `:name`, or possibly via a bare `v-bind="obj"`. */
function hasAttr(el: Node, name: string): boolean {
  return el.props.some(
    (p: Node) =>
      (p.type === ATTRIBUTE && p.name === name) ||
      (p.type === DIRECTIVE && p.name === 'bind' && (!p.arg || p.arg.content === name))
  )
}

/** Whether a node renders visible text: literal text, an interpolation, `v-text`/`v-html`, or a slot. */
function hasText(n: Node): boolean {
  if (n.type === TEXT) return n.content.trim().length > 0
  if (n.type === INTERPOLATION) return true
  if (n.type === ELEMENT) {
    if (n.tag === 'slot') return true
    if (n.props.some((p: Node) => p.type === DIRECTIVE && (p.name === 'text' || p.name === 'html')))
      return true
    return (n.children ?? []).some(hasText)
  }
  if (n.type === IF) return n.branches.some(hasText)
  if (n.type === IF_BRANCH || n.type === FOR) return n.children.some(hasText)
  return false
}

function isControl(el: Node): boolean {
  if (el.tag === 'button') return true
  // The design-system `<Button>` in its icon-only size.
  if (
    el.tag === 'Button' &&
    el.props.some(
      (p: Node) => p.type === ATTRIBUTE && p.name === 'size' && p.value?.content === 'icon'
    )
  )
    return true
  const role = el.props.find((p: Node) => p.type === ATTRIBUTE && p.name === 'role')?.value?.content
  return role !== undefined && CONTROL_ROLES.has(role)
}

function unlabelled(file: string): string[] {
  const { descriptor } = parse(readFileSync(file, 'utf8'))
  if (!descriptor.template?.ast) return []
  const out: string[] = []
  const walk = (n: Node): void => {
    if (
      n.type === ELEMENT &&
      isControl(n) &&
      !(n.children ?? []).some(hasText) &&
      !hasAttr(n, 'title') &&
      !hasAttr(n, 'aria-label') &&
      !hasAttr(n, 'aria-labelledby')
    ) {
      out.push(`${relative(ROOT, file)}:${n.loc.start.line}`)
    }
    for (const c of n.children ?? []) walk(c)
    for (const b of n.branches ?? []) walk(b)
  }
  walk(descriptor.template.ast)
  return out
}

describe('icon-only controls', () => {
  it('every icon-only control carries a title or an aria-label', () => {
    const offenders = vueFiles(SRC).flatMap(unlabelled)
    expect(offenders).toEqual([])
  })
})
