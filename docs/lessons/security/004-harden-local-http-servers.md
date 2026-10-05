# 004-harden-local-http-servers: a localhost HTTP server is still an attack surface

**Category:** security
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug class

The app runs local HTTP servers (the Hook Bridge in `src/main/hook-bridge.ts`;
the new Harnu MCP server under `src/main/mcp/`). "It only binds 127.0.0.1" is **not**
a security boundary: a loopback server is reachable by any co-resident process
running as the same user, and — via **DNS-rebinding** — by a web page in the
user's browser that resolves a hostname to `127.0.0.1`.

The MCP `http-guard.ts` gets the hardening right and is the reference to copy. The
Hook Bridge predates it and is weaker: it authenticates via a UUID embedded in the
URL path compared with a plain `parts[1] !== token` (**not** constant-time), and
the token lives in `~/.claude/settings.json`, readable by same-user processes.

## Root cause

Treating "localhost" as "private". Loopback limits _remote_ network reach, not
_local_ processes or rebinding browsers. Auth, origin checks, and token handling
still matter exactly as they would for a public endpoint.

## The fix (and why)

Checklist for every local server (the MCP guard already does 1–5):

```ts
// 1. Bind explicitly to loopback
server.listen(port, '127.0.0.1')

// 2. Constant-time token compare behind an equal-length guard
function constantTimeEqual(a: string, b: string) {
  const ab = Buffer.from(a),
    bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// 3. DNS-rebind defense: Host must be loopback + present; Origin (when present)
//    must be loopback or the literal 'null' — reject otherwise.
// 4. Body cap enforced WHILE READING the stream, not only on a declared
//    Content-Length (a chunked request with no Content-Length bypasses that check).
// 5. Route-lock (only the expected method+path); everything else 404/405.

// 6. Token: crypto.randomBytes(>=32) base64url, regenerated per session.
// 7. Any token-bearing file on disk (e.g. the --mcp-config) → mode 0o600 in a
//    per-user dir, deleted on teardown.
```

## How to detect in reviews

1. `git grep -nE "\.listen\(|createServer" src/main` — every hit is a surface;
   confirm the loopback bind, the auth check, and the origin/host validation.
2. Any token compare with `===`/`!==` on a secret → must be `timingSafeEqual`.
3. Any size limit that reads only `Content-Length` → enforce a hard ceiling while
   consuming the stream too.
4. Any config/token file written without an explicit `{ mode: 0o600 }`.

## Related

- `src/main/mcp/http-guard.ts` (reference), `src/main/mcp/config-file.ts`, `src/main/hook-bridge.ts`
- `framework/004-http-hooks-obey-response-body-decisions` — the Hook Bridge protocol
