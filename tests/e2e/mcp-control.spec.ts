import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Harnu MCP control server E2E smoke (harnu-mcp-server-design spec, T32).
 *
 * Connects to the running dev app over CDP (:9222 from `npm run dev`) and
 * exercises the agent-drives-Harnu surface end-to-end. This is the shell-proof
 * gate: the SECURITY COMPOSITION lives in unit-tested pure cores
 * (mcp/{permission-core,plan-tool-call,confirm-core,agent-boot,…}); this spec
 * proves the env-bound shells (HTTP transport, IPC, execFile, adopt) wire those
 * cores together correctly in the real process.
 *
 * Preconditions: `npm run dev` running. `@playwright/test` installed (it is a
 * manual/dev dependency, not in CI — same as every other tests/e2e/*.spec.ts).
 *
 * AUTOMATED here: server enable/disable + status; the loopback READ path
 * (`get_fleet` over token'd HTTP) and its redaction boundary; the auth guards.
 *
 * POSTURE (post-reversal): the server is ON by default and agents act WITHOUT a
 * confirm. The manual checklist below is therefore mostly about proving the
 * ABSENCE of friction — the old steps that waited for a confirm overlay now only
 * apply in the opt-in `ask` mode.
 *
 * MANUAL CHECKLIST (needs an agent or a scripted tool call; the acceptance steps
 * the read-path smoke can't cover alone):
 *   1. create_session in a BRAND-NEW folder that was never pinned → the session
 *      starts with NO confirm overlay, and `get_session` on the returned id works
 *      immediately (this is the bug the reversal fixes: it used to dead-end on
 *      FOLDER_NOT_ALLOWED and leave the machine idle).
 *   2. spawn_terminal {target:'split'} for an OFF-SCREEN worktree → the pane
 *      spawns headlessly (no viewport steal), no confirm.
 *   3. create_worktree → the worktree auto-adopts into the sidebar, grouped under
 *      its repo (`folders:adopted`), and a session can be created in it in the
 *      same breath (no separate grant step).
 *   4. Folder menu → "Block agent control" on a repo → any verb in that repo (and
 *      in its worktrees) is denied FOLDER_NOT_ALLOWED, with no confirm offered.
 *   5. Settings → Control server → "Ask before agent actions" ON → every mutating
 *      verb parks the confirm overlay again, DISCLOSING prompt + mode + flags;
 *      confirm timeout (don't click) → DENY; transport abort mid-confirm → DENY.
 *   6. submit_manifest ALWAYS parks its checklist confirm, in both modes.
 *   7. Server kill switch OFF → every verb, reads included, denies SERVER_DISABLED.
 */

async function connect(): Promise<{
  page: import('playwright-core').Page
  close: () => Promise<void>
}> {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]
  return { page, close: () => browser.close() }
}

test('MCP control server: on by default, toggles, reports a loopback port', async () => {
  const { page, close } = await connect()
  try {
    // ON out of the box now — the kill switch is an explicit opt-OUT.
    const before = await page.evaluate(() =>
      (window as { api: { mcpStatus(): Promise<{ enabled: boolean }> } }).api.mcpStatus()
    )
    expect(before).toBeTruthy()

    const after = await page.evaluate(() =>
      (
        window as {
          api: { mcpSetEnabled(b: boolean): Promise<{ enabled: boolean; port: number }> }
        }
      ).api.mcpSetEnabled(true)
    )
    expect(after.enabled).toBe(true)
    expect(after.port).toBeGreaterThan(0)
  } finally {
    await close()
  }
})

test('MCP read path: get_fleet over token-guarded HTTP is redacted (no paths/transcript)', async () => {
  const { page, close } = await connect()
  try {
    await page.evaluate(() =>
      (window as { api: { mcpSetEnabled(b: boolean): Promise<unknown> } }).api.mcpSetEnabled(true)
    )
    const status = await page.evaluate(() =>
      (window as { api: { mcpStatus(): Promise<{ port: number }> } }).api.mcpStatus()
    )

    // Discover the per-boot bearer token Harnu wrote for the agent to use. It
    // lives at <userData>/harnu.mcp.json (0600). Skip if userData isn't the
    // default location (isolated --user-data-dir dev runs).
    const cfgPath = join(homedir(), '.config', 'harnu', 'harnu.mcp.json')
    let token = ''
    try {
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
      token = String(cfg.mcpServers?.harnu?.headers?.Authorization ?? '').replace(/^Bearer /, '')
    } catch {
      /* not found / isolated userData */
    }
    test.skip(!token, 'harnu.mcp.json token not found at the default userData path')

    const base = `http://127.0.0.1:${status.port}/mcp`
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    }

    // Wrong token → 403 (auth guard).
    const bad = await fetch(base, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer nope' },
      body: '{}'
    })
    expect(bad.status).toBe(403)

    // Initialize + list tools: the read tools exist, no remove_worktree.
    const init = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' }
        }
      })
    })
    expect(init.ok).toBe(true)

    const listed = await (
      await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      })
    ).text()
    expect(listed).toContain('get_fleet')
    expect(listed).not.toContain('remove_worktree')

    // get_fleet must never leak absolute home paths or transcript bytes.
    const fleet = await (
      await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'get_fleet', arguments: {} }
        })
      })
    ).text()
    expect(fleet).not.toContain(homedir())
    expect(fleet.toLowerCase()).not.toContain('transcript')
  } finally {
    await close()
  }
})
