/**
 * T389 P4W1 part A — the pure core of the Mods audit pane.
 *
 * Fixtures under tests/fixtures/mods-audit/ are REAL `claude plugin validate --json`
 * reports (CLI 2.1.289, paths scrubbed to `/plugins/<name>`) and a synthetic 202-row
 * `claude plugin list --json` shaped like the one measured on 2026-10-02 (18 unique
 * ids; scopes local 180, user 16, project 5, synced 1).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  CAPABILITY_ORDER,
  buildAnalysis,
  cacheKey,
  deriveCapabilities,
  emptyCache,
  evictOldest,
  normalizeInstalled,
  parseCacheFile,
  parseValidateReport,
  pickPermissionHookers,
  planRows,
  previousAnalysisFor,
  retargetPath,
  rowKey,
  type CapabilityId,
  type ModAnalysis,
  type ModRow
} from '../src/main/mods-audit-core'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'mods-audit', name), 'utf8'))
}

const META = { hash: 'a'.repeat(64), hashKind: 'content' as const, cliVersion: '2.1.289' }

function analysis(over: Partial<ModAnalysis> = {}): ModAnalysis {
  return {
    status: 'ok',
    hasModule: true,
    hash: 'h1',
    hashKind: 'content',
    analysedAt: 1000,
    cliVersion: '2.1.289',
    hooks: [],
    calls: [],
    env: { reads: [], writes: [] },
    state: { reads: [], writes: [], foreignUnchecked: [] },
    unparsed: [],
    errors: [],
    warnings: [],
    capabilities: [],
    ...over
  }
}

describe('mods-audit-core', () => {
  it('parses notes into structured facts', () => {
    const guard = parseValidateReport(fixture('validate-tool-call.json'))
    expect(guard.ok).toBe(true)
    expect(guard.hooks).toEqual([
      { file: './register.ts', event: 'tool.call', matcher: 'tool=Edit', opaque: false },
      { file: './register.ts', event: 'tool.call', matcher: 'tool=Bash', opaque: false }
    ])
    expect(guard.calls).toEqual([{ file: './register.ts', op: 'ui.status' }])
    expect(guard.hasModule).toBe(true)

    const diff = parseValidateReport(fixture('validate-diff.json'))
    expect(diff.hooks.map((h) => h.event)).toEqual([
      'session.start',
      'ui.render',
      'ui.render',
      'command.run',
      'ui.close',
      'ui.focus',
      'ui.scroll',
      'command.run',
      'tool.call',
      'prompt.submit'
    ])
    expect(diff.hooks.find((h) => h.matcher === 'command=clear|resume')).toBeTruthy()
    // a non-literal matcher prints `?` and is marked opaque
    expect(diff.hooks.find((h) => h.event === 'ui.close')).toMatchObject({
      matcher: 'id=?',
      opaque: true
    })
    expect(diff.hooks.find((h) => h.matcher === 'tool=?|?')?.opaque).toBe(true)
    expect(diff.calls.map((c) => c.op)).toContain('process.run')
    expect(diff.calls.map((c) => c.op)).toContain('fs.read')
    expect(diff.env).toEqual({ reads: ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'], writes: [] })
    expect(diff.unparsed).toEqual([])

    // braces nest inside a matcher; a call's `(via a, b)` keeps its comma
    const agents = parseValidateReport(fixture('validate-agents-md.json'))
    expect(agents.hooks.find((h) => h.matcher === 'instructionFiles has {kind=?}')).toMatchObject({
      event: 'prompt.context',
      opaque: true
    })
    expect(agents.calls.find((c) => c.op === 'env.get')).toEqual({
      file: './register.ts',
      op: 'env.get',
      via: 'attachesOnRead, homeOf'
    })
    expect(agents.env.reads).toEqual([
      'CLAUDE_CODE_DISABLE_ATTACHMENTS',
      'CLAUDE_CODE_SIMPLE',
      'HOME',
      'USERPROFILE'
    ])

    // an invalid report still carries its facts, plus the errors
    const pane = parseValidateReport(fixture('validate-pane-invalid.json'))
    expect(pane.success).toBe(false)
    expect(pane.errors.length).toBeGreaterThan(0)
    expect(pane.state.reads).toEqual(['tool-calls.calls'])
    expect(pane.state.writes).toEqual(['tool-calls.calls'])
    expect(pane.state.foreignUnchecked).toEqual(['tool-calls.calls'])
    expect(Array.isArray(pane.warnings)).toBe(true)
  })

  it('keeps what it cannot parse', () => {
    const report = {
      success: true,
      manifest: { type: 'plugin', errors: [], warnings: [], notes: [] },
      contents: [
        {
          file: '/p/hooks/hooks.json',
          type: 'hooks',
          errors: [],
          warnings: [],
          notes: [
            './a.ts frobnicates: x, y',
            'no label at all',
            './a.ts hooks: foo{unclosed, bar',
            './a.ts calls: weird-call, $.fs.read',
            './a.ts hooks: tool.call{tool=Bash}',
            42,
            null
          ]
        }
      ]
    }
    expect(() => parseValidateReport(report)).not.toThrow()
    const parsed = parseValidateReport(report)
    expect(parsed.unparsed).toContain('./a.ts frobnicates: x, y')
    expect(parsed.unparsed).toContain('no label at all')
    expect(parsed.unparsed).toContain('./a.ts hooks: foo{unclosed, bar')
    expect(parsed.unparsed).toContain('./a.ts calls: weird-call')
    // what did parse is kept
    expect(parsed.calls).toEqual([{ file: './a.ts', op: 'fs.read' }])
    expect(parsed.hooks).toEqual([
      { file: './a.ts', event: 'tool.call', matcher: 'tool=Bash', opaque: false }
    ])
    // a call the table does not know is shown, never silently dropped
    expect(parseValidateReport(fixture('validate-sec-default.json')).unparsed).toEqual([
      './register.ts calls: next.to:append'
    ])
  })

  it('never throws on a non-report', () => {
    for (const junk of [
      null,
      undefined,
      7,
      'x',
      [],
      {},
      { contents: 'nope' },
      { contents: [null] }
    ]) {
      expect(() => parseValidateReport(junk)).not.toThrow()
    }
    expect(parseValidateReport(null).ok).toBe(false)
    expect(parseValidateReport({ contents: [] }).ok).toBe(false)
  })

  it('re-targets the marketplace trap', () => {
    const market = parseValidateReport(fixture('validate-marketplace.json'))
    expect(market.type).toBe('marketplace')
    expect(retargetPath(market, '/plugins/market', true)).toBe(
      '/plugins/market/.claude-plugin/plugin.json'
    )
    // no plugin.json to point at: nothing to retry
    expect(retargetPath(market, '/plugins/market', false)).toBeNull()
    // a plugin report with contents is final
    const diff = parseValidateReport(fixture('validate-diff.json'))
    expect(retargetPath(diff, '/plugins/diff', true)).toBeNull()
    // `contents` empty while plugin.json exists is the same trap
    const emptyPlugin = parseValidateReport({
      success: true,
      manifest: { type: 'plugin', errors: [], warnings: [], notes: [] },
      contents: []
    })
    expect(retargetPath(emptyPlugin, '/p', true)).toBe('/p/.claude-plugin/plugin.json')
    // an unparseable report is a failure, not a trap
    expect(retargetPath(parseValidateReport(null), '/p', true)).toBeNull()
  })

  it('de-duplicates installed rows per folder', () => {
    const raw = fixture('plugin-list-202.json')
    expect((raw as unknown[]).length).toBe(202)

    const global = normalizeInstalled(raw, null)
    expect(global).not.toBeNull()
    expect(global!.length).toBe(18)
    expect(new Set(global!.map((r) => r.id)).size).toBe(18)
    // global scope: user-scope enabled rows, plus the enabled synced one
    const loadingGlobal = global!.filter((r) => r.loadsInFolder === 'yes').map((r) => r.id)
    const expectedGlobal = Array.from({ length: 16 }, (_, i) => i)
      .filter((i) => i % 4 !== 0)
      .concat([17])
      .map((i) => `plugin-${String(i).padStart(2, '0')}@market-${i % 3}`)
    expect(loadingGlobal.sort()).toEqual(expectedGlobal.sort())

    // a folder adds the ids installed for that projectPath
    const proj = '/home/user/Workspace/org/proj-0/www'
    const forProj = normalizeInstalled(raw, proj)!
    expect(forProj.length).toBe(18)
    const loads = (id: string): string | undefined =>
      forProj.find((r) => r.id === id)?.loadsInFolder
    expect(loads('plugin-16@market-1')).toBe('yes') // local row for proj-0 only
    const elsewhere = normalizeInstalled(raw, '/home/user/Workspace/org/other')!
    expect(elsewhere.find((r) => r.id === 'plugin-16@market-1')?.loadsInFolder).toBe('no')
    // user-scope rows keep loading in every folder
    expect(elsewhere.find((r) => r.id === 'plugin-01@market-1')?.loadsInFolder).toBe('yes')
    // a disabled user-scope plugin does not load anywhere by itself
    expect(elsewhere.find((r) => r.id === 'plugin-04@market-1')?.loadsInFolder).not.toBe('yes')

    // every kept row carries a root and the CLI's own scope word
    for (const r of forProj) {
      expect(r.root).toMatch(/^\/home\/user\/\.claude\/plugins\/cache\//)
      expect(['user', 'project', 'local', 'synced']).toContain(r.scope)
    }
  })

  it('ignores unknown shapes of plugin list', () => {
    expect(normalizeInstalled({ plugins: [] }, null)).toBeNull()
    expect(normalizeInstalled('nope', null)).toBeNull()
    expect(normalizeInstalled([{ nothing: true }, null, 3], null)).toEqual([])
    const extra = normalizeInstalled(
      [
        {
          id: 'a@m',
          scope: 'user',
          enabled: true,
          installPath: '/x/a',
          somethingNew: { nested: 1 }
        }
      ],
      null
    )
    expect(extra).toHaveLength(1)
  })

  it('maps facts to capability chips', () => {
    const hook = (
      event: string,
      opaque = false
    ): { file: string; event: string; opaque: boolean } => ({
      file: './r.ts',
      event,
      opaque
    })
    const call = (op: string): { file: string; op: string } => ({ file: './r.ts', op })
    const noEnv = { reads: [], writes: [] }
    const cap = (
      hooks: ReturnType<typeof hook>[],
      calls: ReturnType<typeof call>[],
      env = noEnv
    ): CapabilityId[] => deriveCapabilities({ hooks, calls, env })

    expect(cap([], [call('process.run')])).toEqual(['process'])
    expect(cap([], [call('process.spawn')])).toEqual(['process'])
    expect(cap([], [call('http.fetch')])).toEqual(['network'])
    expect(cap([], [call('fs.read')])).toEqual(['files'])
    expect(cap([], [call('fs.write')])).toEqual(['files'])
    for (const e of ['prompt.submit', 'turn.start', 'classic.UserPromptSubmit']) {
      expect(cap([hook(e)], [])).toEqual(['prompts'])
    }
    for (const e of ['prompt.compose', 'prompt.section', 'prompt.context']) {
      expect(cap([hook(e)], [])).toEqual(['system-prompt'])
    }
    for (const e of ['tool.call', 'classic.PreToolUse']) {
      expect(cap([hook(e)], [])).toEqual(['tool-calls'])
    }
    for (const e of ['tool.check', 'classic.PermissionRequest']) {
      expect(cap([hook(e)], [])).toEqual(['permissions'])
    }
    for (const op of ['prompt.submit', 'command.run', 'session.send']) {
      expect(cap([], [call(op)])).toEqual(['submit'])
    }
    for (const op of ['model.complete', 'model.fork', 'model.classify']) {
      expect(cap([], [call(op)])).toEqual(['model'])
    }
    expect(cap([], [call('mcp.call')])).toEqual(['mcp'])
    for (const e of [
      'http.fetch',
      'env.get',
      'store.get',
      'store.*',
      'state.set',
      'fs.*',
      'fs.read'
    ]) {
      expect(cap([hook(e)], [])).toContain('other-mods')
    }
    expect(cap([hook('plugin.register')], [])).toEqual(['gate'])
    expect(cap([], [], { reads: ['HOME'], writes: [] })).toEqual(['env'])
    expect(cap([], [], { reads: [], writes: ['HOME'] })).toEqual([])
    expect(cap([hook('ui.render')], [])).toEqual(['terminal'])
    expect(cap([hook('session.start', true)], [])).toEqual(['opaque'])

    // lifecycle hooks and harmless calls are not capabilities
    expect(
      cap([hook('session.start'), hook('command.run')], [call('ui.status'), call('clock.now')])
    ).toEqual([])

    // a wildcard classic hook sees every classic event
    expect(cap([hook('classic.*')], [])).toEqual(['prompts', 'tool-calls', 'permissions'])

    // table order, whatever order the facts come in
    const everything = cap(
      [
        hook('ui.render'),
        hook('plugin.register'),
        hook('fs.*'),
        hook('tool.check'),
        hook('tool.call'),
        hook('prompt.compose'),
        hook('prompt.submit'),
        hook('x.y', true)
      ],
      [
        call('mcp.call'),
        call('model.fork'),
        call('command.run'),
        call('fs.stat'),
        call('http.fetch'),
        call('process.run')
      ],
      { reads: ['HOME'], writes: [] }
    )
    expect(everything).toEqual([...CAPABILITY_ORDER])
    expect(CAPABILITY_ORDER).toHaveLength(15)
  })

  it('derives chips for real reports', () => {
    const chips = (name: string): CapabilityId[] =>
      buildAnalysis(parseValidateReport(fixture(name)), { ...META, now: 5 }, null).capabilities
    expect(chips('validate-sec-default.json')).toEqual([
      'prompts',
      'system-prompt',
      'tool-calls',
      'permissions',
      'gate'
    ])
    expect(chips('validate-tool-call.json')).toEqual(['tool-calls'])
    expect(chips('validate-diff.json')).toEqual([
      'process',
      'files',
      'prompts',
      'tool-calls',
      'env',
      'terminal',
      'opaque'
    ])
  })

  it('records a change', () => {
    const parsed = parseValidateReport(fixture('validate-tool-call.json'))
    const first = buildAnalysis(parsed, { ...META, hash: 'h1', now: 1000 }, null)
    expect(first.changedSince).toBeUndefined()
    expect(first.analysedAt).toBe(1000)

    const same = buildAnalysis(parsed, { ...META, hash: 'h1', now: 2000 }, first)
    expect(same.changedSince).toBeUndefined()

    const changed = buildAnalysis(parsed, { ...META, hash: 'h2', now: 3000 }, first)
    expect(changed.hash).toBe('h2')
    expect(changed.changedSince).toBe(1000)
    expect(changed.analysedAt).toBe(3000)
  })

  it('classifies run outcomes without a report', () => {
    const base = { ...META, now: 1 }
    expect(buildAnalysis(parseValidateReport(null), base, null).status).toBe('failed')
    const invalid = buildAnalysis(
      parseValidateReport(fixture('validate-pane-invalid.json')),
      base,
      null
    )
    expect(invalid.status).toBe('invalid')
    expect(invalid.errors.length).toBeGreaterThan(0)
    // an unparseable report is `failed`, an unsupported CLI is `unsupported`
    expect(buildAnalysis(null, { ...base, outcome: 'unsupported' }, null).status).toBe(
      'unsupported'
    )
    expect(buildAnalysis(null, { ...base, outcome: 'failed' }, null).status).toBe('failed')
    // a plugin with no hooks module is not a mod
    const marketplace = buildAnalysis(
      parseValidateReport({
        success: true,
        manifest: { type: 'plugin', errors: [], warnings: [], notes: [] },
        contents: [{ file: 'x', type: 'skills', errors: [], warnings: [], notes: ['hello'] }]
      }),
      base,
      null
    )
    expect(marketplace.hasModule).toBe(false)
    expect(marketplace.status).toBe('ok')
  })

  it('plans one row per root', () => {
    const stage = '/data/companion/harnu-companion'
    const rows = planRows({
      folder: null,
      harnuDir: stage,
      harnuSkillsDir: null,
      installed: [
        {
          id: 'zeta@m',
          name: 'zeta',
          version: '1.0.0',
          scope: 'user',
          enabled: true,
          root: '/c/zeta',
          loadsInFolder: 'yes'
        },
        {
          id: 'alpha@m',
          name: 'alpha',
          version: '1.0.0',
          scope: 'user',
          enabled: true,
          root: '/c/alpha',
          loadsInFolder: 'yes'
        },
        {
          id: 'off@m',
          name: 'off',
          version: '1.0.0',
          scope: 'user',
          enabled: false,
          root: '/c/off',
          loadsInFolder: 'no'
        }
      ],
      skillsDirs: [
        { name: 'mine', root: '/home/u/.claude/skills/mine' },
        // the same directory is also an installed row: the installed one wins
        { name: 'alpha', root: '/c/alpha/' }
      ],
      // the companion directory named by the settings env list too
      bootDirs: [
        { name: 'harnu-companion', root: `${stage}/` },
        { name: 'dev', root: '/w/dev' }
      ]
    })
    const roots = rows.map((r) => r.root)
    expect(new Set(roots).size).toBe(roots.length)
    expect(rows.filter((r) => r.root.startsWith(stage))).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'harnu',
      name: 'harnu-companion',
      loadsInFolder: 'yes',
      analysis: null
    })
    // then by name; rows that cannot load are not listed
    expect(rows.slice(1).map((r) => r.name)).toEqual(['alpha', 'dev', 'mine', 'zeta'])
    expect(rows.find((r) => r.name === 'alpha')?.source).toBe('installed')
    expect(rows.find((r) => r.name === 'off')).toBeUndefined()
    expect(rows.find((r) => r.name === 'mine')).toMatchObject({
      source: 'skills-dir',
      enabled: null,
      loadsInFolder: 'unknown'
    })
    expect(rows.find((r) => r.name === 'dev')).toMatchObject({
      source: 'boot-arg',
      enabled: null,
      loadsInFolder: 'yes'
    })
    // keys are source + id-or-name + root
    expect(rows[0]!.key).toBe(rowKey('harnu', 'harnu-companion', stage))
    expect(rows.find((r) => r.name === 'alpha')!.key).toBe(
      rowKey('installed', 'alpha@m', '/c/alpha')
    )
  })

  it('has no companion row when the companion is not staged', () => {
    const rows = planRows({
      folder: null,
      harnuDir: null,
      harnuSkillsDir: null,
      installed: [],
      skillsDirs: [],
      bootDirs: []
    })
    expect(rows).toEqual([])
  })

  it('keys the cache by hash and CLI version', () => {
    expect(cacheKey('abc', '2.1.289')).toBe('abc\u0000' + '2.1.289')
    expect(cacheKey('abc', '2.1.289')).not.toBe(cacheKey('abc', '2.1.290'))
  })

  it('treats a corrupt cache file as empty', () => {
    for (const text of ['', 'not json', '{"v":2,"entries":{}}', '[]', '{"v":1}', 'null']) {
      expect(parseCacheFile(text)).toEqual(emptyCache())
    }
    const ok = parseCacheFile(
      JSON.stringify({ v: 1, entries: { k: { rowKey: 'r', analysis: analysis() } } })
    )
    expect(Object.keys(ok.entries)).toEqual(['k'])
  })

  it('evicts the oldest cache entries first', () => {
    const entries: Record<string, { rowKey: string; analysis: ModAnalysis }> = {}
    for (let i = 0; i < 5; i++)
      entries[`k${i}`] = { rowKey: `r${i}`, analysis: analysis({ analysedAt: i }) }
    const kept = evictOldest({ v: 1, entries }, 3)
    expect(Object.keys(kept.entries).sort()).toEqual(['k2', 'k3', 'k4'])
  })

  it('finds the previous analysis of the same row', () => {
    const cache = {
      v: 1 as const,
      entries: {
        a: { rowKey: 'r1', analysis: analysis({ analysedAt: 10, hash: 'x' }) },
        b: { rowKey: 'r1', analysis: analysis({ analysedAt: 20, hash: 'y' }) },
        c: { rowKey: 'r2', analysis: analysis({ analysedAt: 30, hash: 'z' }) }
      }
    }
    expect(previousAnalysisFor(cache, 'r1')?.hash).toBe('y')
    expect(previousAnalysisFor(cache, 'nope')).toBeNull()
  })

  it('permission hookers come from the cache only', () => {
    const row = (
      name: string,
      caps: CapabilityId[],
      hash: string,
      over: Partial<ModRow> = {}
    ): ModRow => ({
      key: rowKey('installed', name, `/c/${name}`),
      name,
      source: 'installed',
      root: `/c/${name}`,
      enabled: true,
      loadsInFolder: 'yes',
      analysis: analysis({ hash, capabilities: caps }),
      ...over
    })
    const rows: ModRow[] = [
      row('fresh-perm', ['permissions'], 'h-ok'),
      row('fresh-tool', ['tool-calls', 'terminal'], 'h-ok'),
      row('stale-perm', ['permissions'], 'h-old'),
      row('fresh-quiet', ['network'], 'h-ok'),
      row('never-analysed', [], 'h-ok', { analysis: null }),
      row('not-loading', ['permissions'], 'h-ok', { loadsInFolder: 'no' }),
      row('maybe-loading', ['permissions'], 'h-ok', { loadsInFolder: 'unknown' }),
      row('harnu-companion', ['permissions'], 'h-ok', { source: 'harnu' })
    ]
    const current = (root: string): string | null => (root.endsWith('gone') ? null : 'h-ok')
    expect(pickPermissionHookers(rows, current)).toEqual([
      { name: 'fresh-perm', root: '/c/fresh-perm' },
      { name: 'fresh-tool', root: '/c/fresh-tool' }
    ])
    // a directory that vanished is not fresh either
    expect(pickPermissionHookers([row('gone', ['permissions'], 'h-ok')], current)).toEqual([])
  })
})
