# 002-no-shell-string-interpolation-of-paths: never interpolate a disk/renderer-derived path into a `sh -c` string

**Category:** security
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug

`buildMissingDirNotice(cwd)` in `src/main/pty.ts` builds a POSIX notice as a
**hand-written shell command**: `{ command: '/bin/sh', args: ['-c', `printf '%b' '${styled}'`] }`.
The session `cwd` is interpolated into `styled` twice. The first site is inside a
benign run of text, but the second re-wraps the value in **literal single quotes**:

```ts
const escCwd = cwd.replace(/'/g, "'\\''") // correct ONLY for a single single-quote level
const styled = [
  `  \\033[2m${escCwd}\\033[0m`,
  `Recreate the directory (\\033[36mmkdir -p '${escCwd}'\\033[0m)` // ← literal quotes around escCwd
].join('\\n')
return { command: '/bin/sh', args: ['-c', `printf '%b' '${styled}'`] } // whole thing single-quoted
```

The outer argument is `printf '%b' '…mkdir -p '<escCwd>'…'`. The literal `'`
characters the template puts **around** `escCwd` are not part of the escaping —
they close the outer `printf '...'` quote. A `cwd` that contains no single quote
(so `escCwd` leaves it untouched) but does contain `$(...)` or backticks breaks
out and **executes**. Proven: opening a `claude-*` session whose `cwd` does not
exist on disk and equals `$(touch /tmp/PWNED)` creates the file. `cwd` is the
session's `projectPath`, derived from disk (`~/.claude/projects/` or a pinned
folder) and never validated — i.e. attacker-influenceable via a shared/restored
session or a crafted directory name.

## Root cause

Building a shell command **string** from data, then "escaping" with a routine
(`replace(/'/g, "'\\''")`) that only neutralizes the value for a **single**
quoting context. The moment the template also emits its own literal quotes around
the value, the escape is void. The defect class is _string-built shell commands
over untrusted data_ — the same class `security/001` calls out for `spawn`/`exec`
(args as an array, never a shell string), here realized in a `/bin/sh -c`.

## The fix (and why)

Don't put the path in the `-c` string at all. Pass it as a **positional arg** and
reference it as `"$1"`, kept outside every static `printf` fragment — the shell
never re-parses it:

```ts
// POSIX: cwd travels as $1, never concatenated into the program text
const body = `printf '%b' '${staticA}'; printf '%s' "$1"; printf '%b' '${staticB}'`
return { command: '/bin/sh', args: ['-c', body, 'sh', cwd] }
```

Simpler still: print the notice straight from Node (no shell), then spawn a
trivial interactive shell.

## How to detect in reviews

1. Grep for hand-built shell programs:
   ```bash
   git grep -nE "'-c'|\"-c\"|, *'-c'" src/main
   ```
   Any `${...}` that lands inside a `'...'`/`"..."` that becomes a shell argument
   is suspect.
2. Treat `cwd`/`projectPath`/branch/any disk- or renderer-derived string as
   untrusted before it touches a shell.
3. A `.replace(/'/g, ...)` "escape" is a smell — verify the value sits in exactly
   one quoting level and nothing emits literal quotes around it. Prefer argv
   arrays + positional `$1`.

## Related

- `src/main/pty.ts` — `buildMissingDirNotice` (POSIX `/bin/sh -c` branch)
- `security/001-ipc-path-validation` — sibling rule for `spawn`/`exec` (argv arrays)
- Sibling argument-injection risk: `external.ts` `spawn('code', [p])` and any
  positional arg to `git`/`claude` should validate `path.isAbsolute` / pass `--`
  before user-controlled refs so a leading `-` can't become a flag.
