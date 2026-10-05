import { describe, it, expect } from 'vitest'

/**
 * T1 spike (S-ESM / S-SDKVER / S-TRANSPORT): prove the MCP SDK's ESM subpaths
 * resolve and expose constructable classes under the node test env, BEFORE any
 * shell (T24 server.ts) commits to them. This is a cheap proxy for "does the
 * dependency load"; the Electron-externalized-main runtime risk is re-checked at
 * T24 (see spec §risks). zod must also resolve since T5/T10 build tool schemas
 * with it.
 */
describe('mcp sdk + zod resolve (T1 spike)', () => {
  it('loads the high-level McpServer from the ESM subpath', async () => {
    const mod = await import('@modelcontextprotocol/sdk/server/mcp.js')
    expect(typeof mod.McpServer).toBe('function')
  })

  it('loads StreamableHTTPServerTransport (the M1 transport)', async () => {
    const mod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
    expect(typeof mod.StreamableHTTPServerTransport).toBe('function')
  })

  it('loads zod (tool input schemas)', async () => {
    const { z } = await import('zod')
    expect(typeof z.object).toBe('function')
  })
})
