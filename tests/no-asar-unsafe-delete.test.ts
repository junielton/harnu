import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

/**
 * Inside Electron, `node:fs` treats a `*.asar` file as a directory, so a recursive delete over a
 * user's tree cannot remove one and ends ENOTEMPTY. Every recursive delete in `src/main` therefore
 * goes through `rawRm` (`src/main/raw-fs.ts`, `original-fs`), except the app-owned folders listed
 * in {@link APP_OWNED}. This reads the AST, so a multi-line options object, a bare `rm` import, an
 * alias or `fs.promises.rm` cannot slip past the way a one-line regex let them.
 */

const repoRoot = path.resolve(__dirname, '..')

const DELETERS = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync'])

const isTrue = (n: ts.Expression): boolean => n.kind === ts.SyntaxKind.TrueKeyword

/** Where a recursive (or unverifiably optioned) delete is called in `source`. */
export function recursiveDeletes(source: string, file = 'x.ts'): number[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  // `import { rm as remove } from 'node:fs/promises'` makes `remove` a deleter too.
  const aliases = new Set<string>()
  sf.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
    if (!/^(node:)?fs(\/promises)?$/.test(node.moduleSpecifier.text)) return
    const named = node.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) return
    for (const el of named.elements) {
      if (DELETERS.has((el.propertyName ?? el.name).text)) aliases.add(el.name.text)
    }
  })
  const hits: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      const viaImport = ts.isIdentifier(callee) && aliases.has(callee.text)
      const viaMember = ts.isPropertyAccessExpression(callee) && name !== null && DELETERS.has(name)
      const viaBare = ts.isIdentifier(callee) && name !== null && DELETERS.has(name)
      if (viaImport || viaMember || viaBare) {
        const opts = node.arguments[1]
        const recursive =
          opts === undefined
            ? false
            : ts.isObjectLiteralExpression(opts)
              ? opts.properties.some(
                  (p) =>
                    ts.isPropertyAssignment(p) &&
                    p.name.getText(sf) === 'recursive' &&
                    isTrue(p.initializer)
                )
              : true // options we cannot read: assume the worst
        if (recursive) hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/**
 * Recursive deletes that stay on `node:fs` because they only ever touch folders Harnu itself created
 * (its own userData, a temp dir it made, a skill dir it installed): no user tree, no `node_modules`.
 * The Cleanup engine (`gc/`, `reaper/`) has NO entry here. Anything new goes through `rawRm`.
 */
const APP_OWNED: Record<string, string> = {
  'bundled-skills.ts': 'skill folders Harnu installs into its own staging and ~/.claude/skills',
  'migrate-userdata.ts': 'temp copies inside the new userData folder',
  'speech-kokoro.ts': 'the downloaded model folder in userData',
  'statusline.ts': 'its own inbox folder in userData',
  'staging.ts': "the companion mod's own staging folder",
  'memory-store.ts': "the project's own .harnu/memory files",
  'data-dir.ts': 'the userData migration, which only touches folders it created'
}

/**
 * A known gap, carded separately and out of scope for the Cleanup fixes: the worktree seed path
 * replaces a destination inside a user's worktree (`worktree-ipc.ts`). Remove the entry when it
 * moves to `rawRm`; the test then guards it too.
 */
const CARDED_GAPS: Record<string, string> = {
  'worktree-ipc.ts': 'seed replace of a destination inside a worktree'
}

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* tsFiles(p)
    else if (e.name.endsWith('.ts')) yield p
  }
}

describe('the detector', () => {
  it('catches a multi-line options object', () => {
    const src = `import { promises as fs } from 'node:fs'\nawait fs.rm(p, {\n  force: true,\n  recursive: true\n})`
    expect(recursiveDeletes(src)).toEqual([2])
  })
  it('catches a bare rm import, an alias and rmSync', () => {
    expect(
      recursiveDeletes(`import { rm } from 'node:fs/promises'\nawait rm(p, { recursive: true })`)
    ).toEqual([2])
    expect(
      recursiveDeletes(
        `import { rm as remove } from 'fs/promises'\nawait remove(p, { recursive: true })`
      )
    ).toEqual([2])
    expect(
      recursiveDeletes(
        `import { rmSync } from 'node:fs'\nrmSync(p, { recursive: true, force: true })`
      )
    ).toEqual([2])
  })
  it('catches fs.promises.rm and options held in a variable', () => {
    expect(recursiveDeletes(`await fs.promises.rm(p, { recursive: true })`)).toEqual([1])
    expect(recursiveDeletes(`const o = { recursive: true }\nawait fs.rm(p, o)`)).toEqual([2])
  })
  it('leaves a non-recursive delete and a recursive: false alone', () => {
    expect(recursiveDeletes(`await fs.rm(p, { force: true })\nawait fs.rm(p)`)).toEqual([])
    expect(recursiveDeletes(`await fs.rm(p, { recursive: false })`)).toEqual([])
  })
})

describe('no recursive node:fs delete in src/main outside the app-owned folders', () => {
  it('every recursive rm goes through rawRm', async () => {
    const offenders: string[] = []
    for await (const file of tsFiles(path.join(repoRoot, 'src/main'))) {
      const rel = path.relative(path.join(repoRoot, 'src/main'), file)
      const base = path.basename(file)
      if (rel === 'raw-fs.ts' || APP_OWNED[base] || CARDED_GAPS[base]) continue
      for (const line of recursiveDeletes(await fs.readFile(file, 'utf8'), file)) {
        offenders.push(`src/main/${rel}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the Cleanup engine has no exemption at all', () => {
    for (const exempt of [...Object.keys(APP_OWNED), ...Object.keys(CARDED_GAPS)]) {
      expect(exempt).not.toMatch(/^(gc|reaper)\//)
      expect(['dehydrate-shell.ts', 'worktree-admin-shell.ts']).not.toContain(exempt)
    }
  })
})
