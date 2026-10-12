#!/usr/bin/env node
/**
 * T460 — before/after visual baseline of every dialog, against the REAL built app
 * (spec docs/specs/T460-dialog-standardization/spec.md §6.3).
 *
 * jsdom has no layout engine; "the footer is on screen" can only be proven in a browser. This
 * driver launches one BUILT side of the app per run, seeds the same on-disk world on both sides,
 * opens every reachable dialog through its UI route, and records what is true about it. A later run
 * on the other side, then `diff`, turns "only the intended §3.3 deltas changed" into a checkable
 * claim.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────────────────────────
 *  1. Two builds, two worktrees. `before` = a detached worktree at the batch's merge-base
 *     (`git worktree add --detach ../harnu-before <merge-base>`); `after` = the branch's own
 *     worktree. Each needs its own `npm ci` (native node-pty is rebuilt per checkout) and
 *     `npm run build`, which produces `out/main/index.js` + `out/renderer`. The sides share nothing
 *     but the seed (same world path, rebuilt per capture — so run the two sides one after the other).
 *  2. `_electron.launch()`, NO `--remote-debugging-port`. Exactly as tests/e2e/ci/* does it:
 *     `args: ['out/main/index.js', '--user-data-dir=<dir>', '--no-sandbox', '--disable-gpu']`,
 *     `env: { ...process.env, HOME: <dir> }`, cwd = that side's worktree. Each side has its OWN
 *     `<dir>` (`<tmp>/dialog-baseline-<user>/side-<label>`): the single-instance lock is keyed on userData, so
 *     the two sides — and the user's own running Harnu — never collide. A CDP port would flip
 *     IS_DEV (docs/dev/live-verify-second-instance.md) and send the window to :5174, which two
 *     sides cannot both own; with no port each side loads its own `out/renderer`. The two Electron
 *     processes would not collide, but both sides use ONE seeded world path (step 3) that is rebuilt
 *     by every capture, so run the sides one after the other, never concurrently.
 *  3. Seed: tests/e2e/ci/fixtures/dialog-seed.ts (`seedDialogWorld`) — the long-list repo (67
 *     worktrees, BUG-184's shape), pinned folders, a roadmap, missions. Fixed names, fixed commit dates, no randomness.
 *     DOCKER IS A STAND-IN: the seed puts a `docker` shim first on the app's PATH
 *     (`seedLaunchEnv`) that reports an empty, healthy daemon — no containers, no volumes, no
 *     images, no build cache. Docker rows (volumes, build cache, the Docker card's sizes) are
 *     therefore NEVER real in this baseline, which is what makes it identical on a laptop and a CI
 *     runner (a blind or cache-heavy daemon changes what Cleanup offers). It also means
 *     ContainersRemoveDialog stays unreachable here (it needs a real stack); see
 *     scripts/dev/dialog-routes/unreachable.mjs for every surface with no route.
 *  4. Per theme × window height (1280×900 and 1280×560, `BrowserWindow.setContentSize`) × route
 *     (scripts/dev/dialog-routes/*, one entry per way of opening a dialog) it records a viewport
 *     PNG and a JSON measurement: rects of card / header / body / footer, computed width,
 *     max-height, height, border-radius, background, padding, the title's font-size/weight, the
 *     scrim's background and z-index, `overflow-y` of <body>, `document.activeElement`, and the
 *     body's scrollHeight/clientHeight (scripts/dev/dialog-routes/measure.mjs).
 *  5. `diff <before> <after>`: prints a per-dialog table of changed properties and EXITS 1 on any
 *     change not listed in the batch's expected-deltas file (schema + the §3.3 catalog:
 *     scripts/dev/dialog-routes/expected-deltas.*). Independently it checks the geometry invariants
 *     on `after` (card.top ≥ 0, footer.bottom ≤ innerHeight, header+footer on screen, the body
 *     scrolls when the content is long) — BUG-184's acceptance criteria as a loop over every dialog.
 *  6. Output: `<out>/<label>/…` (default `.harnu/out/dialog-baseline/`, gitignored). The PR body
 *     carries the diff table and 2–3 hand-picked PNG pairs, never the whole set.
 *  7. Themes: default dark + `light` every batch; one more dark and one more light once per batch.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────────
 *   xvfb-run -a node scripts/dev/dialog-baseline.mjs capture --build-dir <worktree> --label before
 *   xvfb-run -a node scripts/dev/dialog-baseline.mjs capture --build-dir . --label after
 *   node scripts/dev/dialog-baseline.mjs diff .harnu/out/dialog-baseline/before \
 *        .harnu/out/dialog-baseline/after --expected <batch>-deltas.json
 *
 *   capture options
 *     --build-dir <dir>   the worktree whose `out/` is launched (required)
 *     --label <name>      `before` | `after` (or any name; becomes the output folder)
 *     --out <dir>         output root (default `.harnu/out/dialog-baseline`)
 *     --themes <a,b>      data-theme ids (default `default-dark,light`)
 *     --heights <a,b>     window heights (default `900,560`)
 *     --only <id,id>      only these route ids (substring match)
 *     --no-png            skip screenshots
 *
 *   diff options
 *     --expected <file>   expected-deltas JSON (see expected-deltas.schema.json); none = nothing allowed
 *     --allow-violations  print geometry violations on `after` but do not fail on them
 *
 * Linux/xvfb only: macOS and Windows window chrome and focus are covered by the human pass
 * (spec §6.5), not by this driver. NOT seedable here (spec §6.3 step 3): Containers (needs Docker),
 * ReviewPane confirm (needs a PR), the MCP gate (needs an MCP caller), ImageLightbox (needs a
 * pasted image) — they stay on unit tests + the human pass.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validateDeltas } from './dialog-routes/deltas.mjs'

const HERE = new URL('.', import.meta.url).pathname

const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_')

// ── capture ─────────────────────────────────────────────────────────────────────────────────

async function capture(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'build-dir': { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string', default: '.harnu/out/dialog-baseline' },
      themes: { type: 'string', default: 'default-dark,light' },
      heights: { type: 'string', default: '900,560' },
      only: { type: 'string' },
      'no-png': { type: 'boolean', default: false }
    }
  })
  if (!values['build-dir'] || !values.label) {
    throw new Error('capture needs --build-dir <worktree> and --label <name>')
  }
  const buildDir = resolve(values['build-dir'])
  if (!existsSync(join(buildDir, 'out', 'main', 'index.js'))) {
    throw new Error(
      `${buildDir}/out/main/index.js is missing — run \`npm run build\` in that worktree`
    )
  }

  // Imported lazily so `diff` needs neither Playwright nor git.
  const { seedDialogWorld, seedLaunchEnv } = await import(
    new URL('../../tests/e2e/ci/fixtures/dialog-seed.ts', import.meta.url).href
  )
  const { launchSide, setViewport, setTheme } = await import('./dialog-routes/launch.mjs')
  const { ROUTES, MEASURED_ROUTES, closeRoute } = await import('./dialog-routes/index.mjs')
  const { measureDialog } = await import('./dialog-routes/measure.mjs')

  const label = values.label
  // The label becomes a directory name that is `rm -rf`-ed: no separators, no `..`, no dot-leading names.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) || label.includes('..')) {
    throw new Error(`--label "${label}" must be a plain name (letters, digits, . _ -), e.g. before`)
  }
  const outDir = resolve(values.out, label)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // Per-side userData / HOME (spec §6.3 step 2) — but ONE world path for both sides: the repo path
  // is printed in on-screen hints (`git worktree unlock <path>`), and a longer path wraps to more
  // lines, which moved the bulk dialog's height by 128px between two captures of the same build.
  // The world is rebuilt from scratch on every capture, so run the two sides one after the other.
  // Scoped to the OS user so two users on one machine never share (or delete) each other's world.
  const scratch = join(
    tmpdir(),
    `dialog-baseline-${userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_')}`
  )
  const root = join(scratch, 'world')
  const userData = join(scratch, `side-${label}`)
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  const seed = seedDialogWorld({ root, userData })

  const only = values.only?.split(',').filter(Boolean)
  const routes = ROUTES.filter((r) => !only || only.some((o) => r.id.includes(o)))
  const themes = values.themes.split(',').filter(Boolean)
  const heights = values.heights.split(',').map(Number)

  const { app, page } = await launchSide({
    buildDir,
    userData: seed.userData,
    env: seedLaunchEnv(seed),
    height: heights[0]
  })
  const results = {
    version: 1,
    label,
    buildDir,
    root,
    userData,
    only: only ?? null,
    seed: { states: seed.states, worktrees: seed.worktrees.length },
    entries: []
  }
  try {
    // The first-run "Harnu mod" toast covers the footer and is not part of any dialog.
    await page.waitForTimeout(1500)
    for (const theme of themes) {
      await setTheme(page, theme)
      for (const height of heights) {
        await setViewport(app, 1280, height)
        await page.waitForTimeout(250)
        for (const route of routes) {
          const key = { id: route.id, theme, height }
          if (!MEASURED_ROUTES.includes(route)) {
            results.entries.push({ ...key, reach: route.reach, note: route.note ?? null })
            continue
          }
          const ctx = { page, app, seed }
          try {
            await route.open(ctx)
            const measured = await measureDialog(page, { settleMs: 150 })
            if (!values['no-png']) {
              const png = join(outDir, 'png', theme, String(height), `${safe(route.id)}.png`)
              mkdirSync(join(png, '..'), { recursive: true })
              await page.screenshot({ path: png })
            }
            results.entries.push({
              ...key,
              reach: route.reach,
              longContent: !!route.longContent,
              measured
            })
            console.log(`  ✓ ${theme} @${height} ${route.id}`)
          } catch (err) {
            results.entries.push({
              ...key,
              reach: route.reach,
              error: String(err?.message ?? err).slice(0, 400)
            })
            console.log(
              `  ✗ ${theme} @${height} ${route.id}: ${String(err?.message ?? err).split('\n')[0]}`
            )
          } finally {
            await closeRoute(route, ctx).catch(async () => {
              // A route that cannot close cleanly must not poison the rest of the run.
              await page.keyboard.press('Escape').catch(() => {})
            })
          }
        }
      }
    }
  } finally {
    await app.close().catch(() => {})
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  const ok = results.entries.filter((e) => e.measured).length
  const failed = results.entries.filter((e) => e.error).length
  console.log(`\n${label}: ${ok} measured, ${failed} failed → ${join(outDir, 'results.json')}`)
}

// ── diff ────────────────────────────────────────────────────────────────────────────────────

/** Flatten an object to `a.b.c → leaf` (arrays by index). */
function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else out[prefix] = value
  return out
}

/** Properties that are noise by construction: absolute paths and counters, never layout. */
const IGNORED = [/^viewport\./]

function load(dir) {
  const file = existsSync(dir) && dir.endsWith('.json') ? dir : join(dir, 'results.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Replace the side's tmp root with a placeholder so two sides compare equal text. */
function normalize(v, root) {
  return typeof v === 'string' && root ? v.split(root).join('<ROOT>') : v
}

const globToRe = (g) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

function isExpected(deltas, id, theme, height, prop, before, after) {
  return deltas.find((d) => {
    if (d.dialog !== '*' && !globToRe(d.dialog).test(id)) return false
    if (d.height !== undefined && d.height !== height) return false
    if (d.theme !== undefined && d.theme !== theme) return false
    if (!globToRe(d.property).test(prop)) return false
    if (d.from !== undefined && String(d.from) !== String(before)) return false
    if (d.to !== undefined && String(d.to) !== String(after)) return false
    return true
  })
}

async function diff(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      expected: { type: 'string' },
      'allow-violations': { type: 'boolean', default: false }
    }
  })
  if (positionals.length !== 2) throw new Error('diff needs <before-dir> <after-dir>')
  const before = load(positionals[0])
  const after = load(positionals[1])
  const deltas = values.expected
    ? validateDeltas(JSON.parse(readFileSync(values.expected, 'utf8'))).deltas
    : []
  const { violations } = await import('./dialog-routes/measure.mjs')

  const keyOf = (e) => `${e.theme}@${e.height}|${e.id}`
  const bMap = new Map(before.entries.map((e) => [keyOf(e), e]))
  const aMap = new Map(after.entries.map((e) => [keyOf(e), e]))

  const rows = []
  let unexpected = 0
  const used = new Set()

  for (const [key, b] of bMap) {
    const a = aMap.get(key)
    if (!b.measured) continue // not-seedable / reference / errored on `before`: nothing to compare
    const id = b.id
    if (!a && after.only) continue // `after` was captured with --only: that route was not asked for
    if (!a?.measured) {
      rows.push({
        id,
        theme: b.theme,
        height: b.height,
        prop: '(dialog)',
        before: 'opens',
        after: a?.error ? `error: ${a.error}` : 'missing',
        status: 'UNEXPECTED'
      })
      unexpected++
      continue
    }
    const fb = flatten(b.measured)
    const fa = flatten(a.measured)
    for (const prop of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
      if (IGNORED.some((re) => re.test(prop))) continue
      const vb = normalize(fb[prop], before.root)
      const va = normalize(fa[prop], after.root)
      if (vb === va) continue
      const hit = isExpected(
        deltas,
        id.split('#')[0] === id ? id : id,
        b.theme,
        b.height,
        prop,
        vb,
        va
      )
      if (hit) used.add(hit)
      else unexpected++
      rows.push({
        id,
        theme: b.theme,
        height: b.height,
        prop,
        before: vb,
        after: va,
        status: hit ? `expected (${hit.reason})` : 'UNEXPECTED'
      })
    }
  }
  for (const [key, a] of aMap) {
    if (a.measured && !bMap.get(key)?.measured && bMap.has(key) === false) {
      rows.push({
        id: a.id,
        theme: a.theme,
        height: a.height,
        prop: '(dialog)',
        before: 'absent',
        after: 'opens',
        status: 'UNEXPECTED'
      })
      unexpected++
    }
  }

  // Per-dialog table.
  console.log('dialog | theme@height | property | before → after | status')
  for (const r of rows) {
    console.log(
      `${r.id} | ${r.theme}@${r.height} | ${r.prop} | ${r.before} → ${r.after} | ${r.status}`
    )
  }
  console.log(
    `\n${rows.length} changed properties, ${unexpected} not listed in the expected deltas`
  )
  const unusedDeltas = deltas.filter((d) => !used.has(d))
  if (unusedDeltas.length) {
    console.log(
      `\n${unusedDeltas.length} expected delta(s) matched nothing (a delta the batch promised but did not show):`
    )
    for (const d of unusedDeltas) console.log(`  ${d.dialog} ${d.property} — ${d.reason}`)
  }

  // Geometry invariants on `after`, at every recorded height.
  let geometry = 0
  console.log('\ngeometry invariants on `after`:')
  for (const e of after.entries) {
    if (!e.measured) continue
    const v = violations(e.measured, { longContent: e.longContent })
    if (v.length) {
      geometry += v.length
      console.log(`  ✗ ${e.theme}@${e.height} ${e.id}: ${v.join('; ')}`)
    }
  }
  if (!geometry) console.log('  ✓ none violated')

  const fail = unexpected > 0 || (geometry > 0 && !values['allow-violations'])
  process.exitCode = fail ? 1 : 0
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'capture') await capture(rest)
  else if (cmd === 'diff') await diff(rest)
  else {
    console.error(
      `usage: dialog-baseline.mjs capture|diff …  (see the header of ${HERE}dialog-baseline.mjs)`
    )
    process.exitCode = 2
  }
} catch (err) {
  console.error(err?.message ?? err)
  process.exitCode = 2
}
