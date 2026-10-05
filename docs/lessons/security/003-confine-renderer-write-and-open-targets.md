# 003-confine-renderer-write-and-open-targets: write/open IPCs must pin the destination and allowlist keys, not just block `..`

**Category:** security
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug class

`security/001` covers validating a path **before a read/delete**. The **write**
and **open** sides have their own gaps that `001`'s traversal check does not close:

1. **Arbitrary-path JSON write — `settings:save`** (`src/main/settings.ts`).
   The handler takes `{ path, data }` straight from the renderer and:

   ```ts
   async function writeSettings(path: string, patch: Partial<SettingsData>) {
     await mkdir(dirname(path), { recursive: true })
     const merged = { ...existing, ...sanitizePatch(patch) } // sanitizePatch only clamps terminalFontSize
     await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
   }
   ```

   The renderer controls **both** the destination path **and** (via extra keys
   that pass through the spread) the JSON content. Because it is read-modify-write
   over JSON, pointing it at an existing config (`~/.claude.json`, a project
   `.mcp.json`) lets an attacker **surgically inject keys** — e.g. an `mcpServers`
   entry that runs a command — into a file another tool trusts → RCE.

2. **Unrestricted dot-path patch — `claudeSettings:patch`**
   (`src/main/claude-settings-ipc.ts`). Applies a `{ set, unset }` patch with no
   key allowlist, so the renderer can write `hooks.PreToolUse` or
   `statusLine.command` (command-executing) into `~/.claude/settings.json`.

3. **OS-launch of a renderer path — `external:openPath` / `settings:openExternal`.**
   `shell.openPath(p)` hands an arbitrary renderer-supplied path to the OS default
   handler; an executable/`.desktop`/script just runs.

## Root cause

Trusting the renderer to choose **where** to write/open and **which** keys to set.
Containment against `..` (the `001` rule) is necessary but not sufficient on the
write/open side — the destination must be pinned to an app-owned root and the
keys/values must be allowlisted.

## The fix (and why)

```ts
// 1. Destination: pin to an app-owned root, never a renderer string
const ROOT = app.getPath('userData')
const abs = resolve(ROOT, basename(name)) // or a dir chosen via the native dialog
if (abs !== ROOT && !abs.startsWith(ROOT + sep)) throw new Error('outside userData')

// 2. Content: drop unknown keys instead of spreading them through
function sanitizePatch(p: unknown): Partial<SettingsData> {
  const out: Partial<SettingsData> = {}
  if (typeof p?.terminalFontSize === 'number') out.terminalFontSize = clamp(p.terminalFontSize)
  return out // everything else is discarded
}

// 3. Dot-path patches: allowlist the editable fields; reject hooks/statusLine/command subtrees
// 4. openPath: stat + reject non-directories (the "reveal folder" use case), or constrain to known roots
```

## How to detect in reviews

1. Grep handlers that write or launch with a renderer-threaded arg:
   ```bash
   git grep -nE "writeFile|mkdir|shell\.openPath|openExternal" src/main
   ```
   For each: is the destination pinned to an app root, or taken from the wire?
2. Any `{ ...patch }` / `{ ...args }` **spread** that is persisted — unknown keys
   ride through. Allowlist explicitly.
3. Any dot-path/JSON-merge IPC without a key allowlist — can it reach `hooks`,
   `statusLine`, `command`, `mcpServers`?

## Related

- `security/001-ipc-path-validation` — the read/delete-side counterpart
- `framework/002-cc-strips-settings-hook-keys` — `~/.claude/settings.json` is co-owned
- `src/main/settings.ts` (`writeSettings`/`sanitizePatch`), `src/main/claude-settings-ipc.ts`, `src/main/external.ts`
