# 002-sanitize-terminal-output-strip-nf-and-osc-not-just-csi: stripping ESC alone leaves charset-designation residue

**Category:** code-patterns (terminal-output sanitization / PTY)
**Discovered in:** Fleet board last-PTY-line hardening, `344ceb2` (Jun 2026)
**Status:** active

## The bug

The board's one-line PTY preview showed literal `(B` / `(B(B` residue in some
cards (e.g. `Fleet status board specification(B(B`). The `lastPtyLine` sanitizer
stripped CSI sequences (`ESC [ … `) and lone control bytes, but a bare ESC strip
removed only the `ESC` of an `ESC ( B` charset-designation sequence and left the
trailing `(B` as visible text.

## Root cause

Terminal output carries more escape families than CSI. `ESC ( B` (select ASCII
into G0), `ESC ) 0`, `ESC # 8`, etc. are **nF escape sequences** (`ESC` +
intermediate bytes `0x20–0x2F` + a final byte), and window-title writes are
**OSC** (`ESC ] … BEL/ST`). A regex that only handles `ESC [ …` plus a
control-char class will delete the `ESC` (it's `0x1B`, a control byte) but leave
the sequence's remaining printable bytes behind — corrupted, not removed.

## The fix (and why)

Match the escape families wholesale, in priority order, before the control-byte
fallback:

```ts
// src/renderer/src/components/fleet-board.ts
const ANSI_AND_CONTROL =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)   // OSC (… BEL or ST)
  |\x1b\[[0-9;?]*[ -/]*[@-~]       // CSI
  |\x1b[ -/]+[0-~]                 // nF escapes incl. charset designation (ESC ( B)
  |\x1b[@-_]                       // 2-char Fe escapes
  |[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g  // remaining control bytes
```

## How to detect in reviews

1. Any code that "strips ANSI" from PTY/terminal output with a regex that only
   covers `\x1b\[...` (CSI). Ask: does it handle `ESC ( B` (charset), OSC titles,
   and bare Fe escapes? If not, expect printable residue like `(B`.
2. Prefer matching escape _sequences_ wholesale over deleting `ESC` and hoping
   the rest is harmless — the rest is printable and will leak.
3. Unit-test with real residue: `'\x1b(Bhello'` → `'hello'`,
   `'\x1b]0;title\x07ok'` → `'ok'`, `'done\x1b(B'` → `'done'`.

## Related

- `src/renderer/src/components/fleet-board.ts` (`lastPtyLine`, `ANSI_AND_CONTROL`)
- `tests/fleet-board.test.ts` ("strips charset-designation escapes", "strips OSC sequences")
- `src/main/pty-ring-buffer.ts` — the raw snapshot source ("can begin mid-escape")
