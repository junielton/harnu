# 001-ipc-path-validation: validate every file-touching IPC payload

**Category:** security
**Discovered in:** `5ef9969` (Delete IPC, May 2026)
**Status:** active

## The bug class

The renderer process is **untrusted** from the main process's perspective.
`contextIsolation: true` is good but doesn't help if the main-process IPC
handler blindly does `fs.unlink(args.fullPath)` with whatever the renderer
sends. A renderer compromise (XSS-in-a-prompt, malicious image, npm supply
chain) could pass `fullPath: '/etc/passwd'` and we'd delete it.

## Root cause

IPC payloads are crossed the trust boundary. The main process must treat
every argument as untrusted input.

## The fix (and why)

Defense-in-depth pattern, lifted from `src/main/session-ops.ts`:

```ts
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

function isUnderProjectsRoot(absPath: string): boolean {
  const normalized = resolve(absPath)
  const sep = '/'
  return normalized === PROJECTS_ROOT || normalized.startsWith(PROJECTS_ROOT + sep)
}

ipcMain.handle('session:delete', async (_e, args: DeleteArgs) => {
  // 1. Type-check every field — IPC payloads are `unknown` at the boundary
  if (typeof args.sessionId !== 'string' || !args.sessionId) {
    return { ok: false, error: 'invalid sessionId' }
  }
  if (typeof args.fullPath !== 'string' || !args.fullPath) {
    return { ok: false, error: 'invalid fullPath' }
  }

  // 2. Path validation — refuse anything outside the known root
  if (!isUnderProjectsRoot(args.fullPath)) {
    return { ok: false, error: `refusing to delete outside ~/.claude/projects/: ${args.fullPath}` }
  }

  // 3. Type validation — restrict to the file extension you expect
  if (!args.fullPath.endsWith('.jsonl')) {
    return { ok: false, error: 'refusing to delete a non-.jsonl file' }
  }

  // 4. Now the actual operation
  await fs.unlink(args.fullPath)
})
```

Three layers:

- `typeof === 'string'` validates the shape (untrusted input is `unknown`)
- `path.resolve` collapses `..` segments so `~/.claude/projects/../../etc/passwd` doesn't sneak through
- `startsWith(root + sep)` — the trailing separator avoids the
  `/home/user/.claude/projects-other/` false positive that naive prefix
  checks allow
- Extension check is the cherry on top (limit blast radius even if the
  path check fails)

## How to detect in reviews

When reviewing a new IPC handler in `src/main/*.ts`:

1. **Find every `args.X` access** — is X type-checked before use?
2. **Find every `fs.*`, `child_process.*`, `path.*` call** that uses an IPC
   arg — is the path validated against an allowlist? Is the path
   `resolve()`'d to collapse `..`?
3. **Find every `await` on file ops** — does the catch handler distinguish
   recoverable errors (ENOENT = idempotent) from real failures?
4. **Look for `spawn(...)` / `exec(...)`** — args MUST be passed as an
   array (`[binary, ...args]`), never as a single shell string. Otherwise
   command injection via the renderer is trivial.

## Related

- `src/main/session-ops.ts` — canonical implementation
- `src/main/pty.ts` — `resolveCwd()` ancestor-walk validation (B-1)
- `memories/task/001/findings/04-pty-xterm-production.md` §1 — node-pty
  execve-style spawn (no shell)
- `CLAUDE.md` — "Adding a new IPC capability" checklist
