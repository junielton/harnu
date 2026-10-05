import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The ONE subscription-free e2e that runs in CI (T05 track 2). It launches the
 * BUILT app headless via `_electron.launch()` (no dev server, no CDP attach) and
 * exercises the MCP control server's real marshaling in-process: enabling it
 * writes `harnu.mcp.json`/prefs (prefs.ts) and starts the loopback server
 * (server.ts). This turns "covered by a nonexistent e2e" into real per-PR
 * execution for those two env-bound shells — the exact glue ADR-0001 keeps out
 * of unit tests.
 *
 * Requires `npm run build` first (needs `out/main/index.js` + `out/renderer`).
 * HOME + --user-data-dir point at a throwaway tmpdir so `~/.claude` is untouched
 * (empty fleet, zero side effects). NO --remote-debugging-port: on a packaged
 * build that would flip `is.dev` and send the renderer to the dev URL (lesson 002).
 */
test('boots headless; MCP toggles on; get_fleet redaction holds', async () => {
  const testInfo = test.info()
  const userData = mkdtempSync(join(tmpdir(), 'harnu-ci-'))
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, HOME: userData }
  })

  // Trace the electron context so a CI failure isn't blind — the trace + a
  // screenshot are persisted on failure and uploaded by the e2e job (T65 AC4).
  // Guarded: unsupported tracing must never break the happy path.
  await app
    .context()
    .tracing.start({ screenshots: true, snapshots: true })
    .catch(() => {})

  let failed = false
  try {
    const page = await app.firstWindow()
    await expect(page.locator('body')).toBeVisible()

    // Enable the control server through the real preload bridge → prefs write +
    // loopback server start.
    const status = (await page.evaluate(() =>
      (
        window as unknown as { api: { mcpSetEnabled(v: boolean): Promise<unknown> } }
      ).api.mcpSetEnabled(true)
    )) as { enabled: boolean; port: number }
    expect(status.enabled).toBe(true)
    expect(status.port).toBeGreaterThan(0)

    // The prefs shell wrote the agent-facing config into the isolated userData.
    const cfg = JSON.parse(readFileSync(join(userData, 'harnu.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>
    }
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(['harnu'])
    const server = Object.values(cfg.mcpServers ?? {})[0]
    expect(server?.url).toContain(`:${status.port}`)

    // The config must never leak the real home path or transcript wording.
    const raw = readFileSync(join(userData, 'harnu.mcp.json'), 'utf8')
    expect(raw).not.toContain(homedir())
  } catch (err) {
    failed = true
    await app
      .firstWindow()
      .then((page) => page.screenshot({ path: testInfo.outputPath('failure.png') }))
      .catch(() => {})
    throw err
  } finally {
    // Keep the trace only on failure so the artifact stays lean (T65 AC4).
    await app
      .context()
      .tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined)
      .catch(() => {})
    await app.close()
  }
})
