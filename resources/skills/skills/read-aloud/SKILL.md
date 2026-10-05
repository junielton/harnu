---
name: read-aloud
description: Speak a short, ear-friendly summary of a result out loud — through Harnu's `speak` verb when the session runs inside Harnu, or a text-to-speech command already on the machine when it does not. Use when the operator asks to hear something instead of reading it — "read that out loud", "read it to me", "say that out loud", "tell me what happened", "I'm away from the screen, speak it" — with no argument (the last result produced in this conversation), a file path (that file), or quoted text (that text). Rewrite for the ear before speaking: outcome first, no markdown, no file paths, no code identifiers, capped at about a minute. Do NOT use to read a whole transcript, log or source file aloud (audio cannot be skimmed), and do NOT use it to leave the operator a message they can scroll back to later — that is `notify`.
---

# Read aloud — say the outcome, not the bytes

The operator is not looking at the screen. A chime tells them something finished;
it does not tell them _what_. This skill closes that gap by saying the result out
loud in the shape an ear can hold: the outcome first, in plain words, short enough
to finish before attention does.

The rewriting **is** the skill. A command that pipes the raw result into a speech
synthesiser reads `src/main/mcp/tool-catalog.ts:95` out letter by letter and says
nothing useful. Anything that skips step 2 below is worse than silence.

Speaking is ephemeral, and that is the point. This skill never reaches for the
`notify` verb: a notification persists a row in Activity the operator can scroll
back to, and a read-aloud is heard once and leaves no history. The operator asked
to hear it, so speak regardless of whether Harnu has focus.

## The five steps, in order

### 1. Resolve the target

| The operator typed        | Speak                                          |
| ------------------------- | ---------------------------------------------- |
| nothing                   | the last result produced in this conversation  |
| a path (`docs/report.md`) | that file's content                            |
| quoted text (`"ship it"`) | that text, rewritten the same as anything else |

"The last result" is the substantive thing that just happened — the review verdict,
the test run, the PR that opened, the answer to the question — not your own last
sentence and not the tool output verbatim. If the conversation has produced no
result yet, say so in text and stop; do not narrate the conversation.

### 2. Rewrite it for the ear

Write what you would _say_ to someone standing behind you, not what you would print.

- **Lead with the outcome.** "The build passed." "Twenty-three files changed, no
  conflicts." "It failed on the type check." The first clause must carry the news;
  everything after it is optional detail the ear can drop.
- **No markdown.** No headings, bullets, backticks, asterisks, tables, emoji. A
  synthesiser pronounces them, and they mean nothing out loud.
- **No file paths, no code identifiers, no URLs, no hashes.** Say "the tool catalog"
  and "the read-aloud skill", not `src/main/mcp/tool-catalog.ts` or
  `parseSkillFrontmatter`. Say "pull request two thirty-one is open", never the URL.
- **Numbers as words the mouth can say.** "two thirty-one", "twenty-three files",
  "about a minute" — not "231", "23", "~60s".
- **Short sentences.** One clause each. The ear has no scrollback and cannot re-read
  a subordinate clause.
- **No preamble.** Never open with "Here is a summary of" or "I have finished". The
  operator asked to be told the thing; tell them the thing.

### 3. Cap it at about a minute

**Hard limit: ~800 characters of spoken text** (roughly sixty seconds). Audio cannot
be skimmed, so a long reading is not thoroughness, it is a hostage situation.

If the honest summary does not fit, do not truncate mid-thought. Speak what matters
most and close by saying where the remainder is, in words: "the three failures are
on screen", "the rest of the report is in the pane". Then stop.

Reading an entire transcript, log or source file aloud is out of scope. When the
target is that large, speak its verdict and say the body is on screen.

### 4. Speak it

There are two paths, and exactly one thing decides which you take: **is the `speak`
verb in your tool list?**

#### Inside Harnu — call `speak`

`speak` is the right door whenever it exists. It goes through the operator's own
voice engine and the switches they set on it, and it leaves nothing behind — no
Activity row, no toast, no history.

```
speak({
  folder: "<absolute path of the folder or worktree this session is working in>",
  text:   "<the rewritten summary from step 2>"
})
```

Three things about that call are deliberate:

- **`folder` is the gate anchor**, not decoration. It is the absolute path of the
  folder this session is working in; the operator's voice setting is resolved
  against it (a global default with per-folder overrides).
- **Omit `sessionId`, on purpose.** The verb uses that id for a focus rule that
  drops an utterance while the operator is looking at that very session — a rule
  that exists to stop a session chattering at a screen they are already reading.
  A read-aloud is the opposite case: they _asked_ to hear this, and they are almost
  certainly looking at the session they typed the request into. Passing the id here
  would swallow the one thing they asked for. Name the cost rather than hiding it:
  the rate limit is then counted per folder instead of per session.
- **One utterance is capped at 300 characters by the verb** — well under step 3's
  ceiling. Over-cap text is truncated at a word boundary, never rejected. So when
  you speak through `speak`, aim the spoken line at the headline and leave the
  detail on screen, rather than letting the verb cut you off mid-thought. Do not
  split a long summary across several calls to dodge the cap: it is one line, and
  the verb is rate-limited to five utterances a minute.

The ACK says what actually happened — `spoken`, and when it is `false` a `reason`
and a `hint`. Read it. Step 5 is what to do with each answer.

#### Outside Harnu — the shell command

A session running in a plain terminal, or in someone else's harness, has no MCP
verbs at all. The skill must still work there, so when `speak` is absent, speak
through whatever text-to-speech command the operator has on their PATH: read
`HARNU_TTS_COMMAND` when it is set, then the pre-rename `CAPY_TTS_COMMAND`,
otherwise fall back to the voice the OS ships: `say` on macOS, `spd-say -w`
(speech-dispatcher) elsewhere. Never hardcode an absolute path, and never assume a
particular engine beyond that default.

```bash
case "$(uname -s)" in
  Darwin) default_tts=say ;;
  *) default_tts='spd-say -w' ;;
esac
tts=${HARNU_TTS_COMMAND:-${CAPY_TTS_COMMAND:-$default_tts}}
text=$(
  cat <<'SPEECH'
The build passed. Twenty-three files changed, no conflicts. Pull request two thirty-one is open.
SPEECH
)
if command -v "${tts%% *}" >/dev/null 2>&1; then
  $tts "$text"
else
  echo "no-tts"
fi
```

Three details in that snippet are load-bearing:

- **The text never enters the program text.** It arrives through a heredoc whose
  delimiter is quoted (`<<'SPEECH'`), so the shell performs no expansion inside it
  — a summary that happens to contain a quote, a `$`, or a backtick is spoken, not
  executed. Never paste the summary directly between quotes in the command line:
  the result you are summarising is data, and building a shell program out of data
  is how a summary ends up being run instead of read.
- `${tts%% *}` strips any arguments before the `command -v` check, so
  `HARNU_TTS_COMMAND="espeak-ng -s 150"` is tested as `espeak-ng`.
- `$tts` is deliberately left unquoted at the call site so those arguments split
  into words, while `"$text"` stays quoted and arrives as a single argument.

Do not pipe the raw result into the command, and do not run it in the background
and report success before it returns.

#### Never fall back to the shell after `speak` refused

This is the one mistake that would matter. A refusal from `speak` is the operator's
own switch answering — voice is off, or this folder is muted, or the folder is
blocked for agents. Reaching for the shell command afterwards would route around a
gate they set on purpose and use the speakers they just closed.

**The fallback is for a verb that does not exist. Never for a verb that said no.**

### 5. Report what actually happened

Never claim to have spoken unless something was actually heard. When it was not,
say so in one line and then print the rewritten summary as text, so the work of
step 2 is not wasted.

| What came back                             | Say                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `spoken: true`                             | nothing extra — it was heard                                                       |
| `spoken: true`, `truncated: true`          | it was cut to fit; the rest is on screen                                           |
| `spoken: false`, `reason: "engine-off"`    | the speech engine itself is switched off in Settings → Voice, so nothing was heard |
| `spoken: false`, `reason: "muted"`         | voice is muted right now, so nothing was heard — do not retry                      |
| `spoken: false`, `reason: "focused"`       | it was dropped because the operator is looking at this session — do not retry      |
| `VOICE_DISABLED`                           | agent voice is not on for this folder; it is turned on in Settings → Voice         |
| `VOICE_MUTED_FOR_FOLDER`                   | this folder is muted — just print the summary (see below)                          |
| `SPEAK_RATE_LIMITED`                       | too many utterances in the last minute — do not retry                              |
| `FOLDER_NOT_ALLOWED`                       | this folder is blocked for agents; voice is not a way in                           |
| no `speak` verb and no TTS command on PATH | the line below                                                                     |
| the TTS command exited non-zero            | that it failed — say nothing about having spoken                                   |

> No text-to-speech command found — set `HARNU_TTS_COMMAND` to one on your PATH
> (on Linux, installing speech-dispatcher provides `spd-say`).

**`VOICE_MUTED_FOR_FOLDER` is not an invitation to argue.** An explicit per-folder
mute is a decision the operator made deliberately, and it beats the global switch by
design. Report it in one line, print the summary, and stop — do not tell them how to
undo it, do not suggest they turn it on "just for this", do not ask again next time.
`VOICE_DISABLED` is the different case: voice has simply never been turned on, so
naming the switch **once** is help rather than lobbying.

## Boundaries

- Never claim to have spoken when the verb refused, the command was missing, the
  call failed, or the ACK said `spoken: false`.
- Never use `notify` to produce speech — it persists a row in Activity; this must
  leave no history at all. A read-aloud that files a notice is the failure this
  verb exists to avoid.
- Never fall back to the shell command because `speak` refused. See step 4.
- Never read a full transcript, log, diff or source file aloud.
- Never speak secrets, tokens, keys or anything from a `.env`. Audio in a shared
  room is a disclosure channel like any other.
- Never install a speech engine or add a dependency to make this work. If neither
  the verb nor a command is available, that is step 5's answer, not a problem to
  solve.
