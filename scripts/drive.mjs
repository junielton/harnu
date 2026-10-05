#!/usr/bin/env node
/**
 * scripts/drive.mjs — CDP driver for the dev Electron renderer.
 *
 * Connects to the running Electron app via `connectOverCDP(http://localhost:9222)`
 * and exposes a tiny CLI so external callers (Bash, Claude Code, anyone) can:
 *   - take screenshots
 *   - click selectors
 *   - eval arbitrary JS in the renderer
 *   - dump the accessibility snapshot
 *   - inspect the current URL / title
 *
 * Prereqs:
 *   1. `src/main/index.ts` enables `--remote-debugging-port=9222` in dev (it does).
 *   2. `npm run dev` is running.
 *   3. `playwright-core` is installed (devDependency).
 *
 * Usage:
 *   node scripts/drive.mjs url
 *   node scripts/drive.mjs title
 *   node scripts/drive.mjs screenshot [path]
 *   node scripts/drive.mjs click <selector>
 *   node scripts/drive.mjs type <selector> <text>
 *   node scripts/drive.mjs eval <js-expression>
 *   node scripts/drive.mjs snapshot          # accessibility tree as JSON
 *   node scripts/drive.mjs html [selector]   # outerHTML of selector (default: body)
 *   node scripts/drive.mjs wait <selector>   # wait until visible
 *
 * Each command exits the process when done so chained Bash invocations are clean.
 * Single shared CDP attach per invocation — fast enough for interactive work.
 */
import { chromium } from 'playwright-core'

const CDP_URL = process.env.CDP_URL ?? 'http://localhost:9222'

async function getPage() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  if (!ctx) {
    throw new Error('No browser context found at ' + CDP_URL + '. Is the Electron app running?')
  }
  // Prefer the renderer page (vite dev URL). Skip devtools/inspector pages.
  const pages = ctx.pages()
  const renderer =
    pages.find((p) => /^http:\/\/localhost:5\d{3}/.test(p.url())) ??
    pages.find((p) => !/devtools/.test(p.url())) ??
    pages[0]
  if (!renderer) throw new Error('No renderer page found.')
  return { browser, page: renderer }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) {
    console.error('usage: node scripts/drive.mjs <cmd> [args]')
    process.exit(2)
  }

  const { browser, page } = await getPage()

  try {
    switch (cmd) {
      case 'url': {
        console.log(page.url())
        break
      }
      case 'title': {
        console.log(await page.title())
        break
      }
      case 'screenshot': {
        const out = rest[0] ?? '/tmp/om2tab.png'
        await page.screenshot({ path: out })
        console.log('saved ' + out)
        break
      }
      case 'click': {
        const sel = rest[0]
        if (!sel) throw new Error('click requires a selector')
        await page.click(sel, { timeout: 4000 })
        console.log('clicked ' + sel)
        break
      }
      case 'type': {
        const sel = rest[0]
        const text = rest.slice(1).join(' ')
        if (!sel || text === undefined) throw new Error('type requires <selector> <text>')
        await page.fill(sel, text, { timeout: 4000 })
        console.log('typed into ' + sel)
        break
      }
      case 'eval': {
        const expr = rest.join(' ')
        if (!expr) throw new Error('eval requires an expression')
        const result = await page.evaluate(expr)
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        break
      }
      case 'snapshot': {
        const ax = await page.accessibility.snapshot({ interestingOnly: true })
        console.log(JSON.stringify(ax, null, 2))
        break
      }
      case 'html': {
        const sel = rest[0] ?? 'body'
        const html = await page
          .locator(sel)
          .first()
          .evaluate((el) => el.outerHTML)
        console.log(html)
        break
      }
      case 'wait': {
        const sel = rest[0]
        if (!sel) throw new Error('wait requires a selector')
        await page.locator(sel).waitFor({ state: 'visible', timeout: 8000 })
        console.log('visible: ' + sel)
        break
      }
      case 'press': {
        const key = rest[0]
        if (!key) throw new Error('press requires a key (e.g. "Meta+K", "Escape", "ArrowDown")')
        await page.keyboard.press(key)
        console.log('pressed ' + key)
        break
      }
      case 'keyboard': {
        // Type text via Playwright's keyboard.type which delivers real key
        // events — xterm.js receives them through its helper textarea like
        // any other keystroke. Use `press` for single non-printable keys
        // (Enter, Escape, Arrow*); use this for printable runs.
        const text = rest.join(' ')
        if (!text) throw new Error('keyboard requires text')
        await page.keyboard.type(text, { delay: 8 })
        console.log('typed ' + JSON.stringify(text))
        break
      }
      case 'xterm-output': {
        // Convenience: print the last N chars (default 600) of the visible
        // xterm screen — useful for "did Claude respond yet?" checks.
        const n = Number(rest[0] ?? '600')
        const out = await page.evaluate(
          (n) => document.querySelector('.xterm-screen')?.innerText?.slice(-n) ?? '',
          n
        )
        console.log(out)
        break
      }
      case 'logs': {
        // Attach a console listener and capture lines for N ms, then dump.
        // Useful for tracing fire patterns during a known interaction window.
        // Usage: node scripts/drive.mjs logs 6000 &  → triggers something →
        // wait for the listener window to close → see captured output.
        const lines = []
        page.on('console', (msg) => lines.push('[' + msg.type() + '] ' + msg.text()))
        const ms = Number(rest[0] ?? '4000')
        await new Promise((r) => setTimeout(r, ms))
        for (const l of lines) console.log(l)
        break
      }
      default:
        console.error('unknown command: ' + cmd)
        process.exit(2)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err?.message ?? err)
  process.exit(1)
})
