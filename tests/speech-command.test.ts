import { describe, it, expect } from 'vitest'
import { isAbsolute } from 'node:path'
import {
  defaultSpeechCommand,
  tokenizeCommand,
  buildSpeechSpawn,
  speechSpawnPath,
  normalizeSpeechCommand,
  DEFAULT_SPEECH_COMMAND,
  MAX_SPEECH_COMMAND_CHARS,
  MAX_SPEECH_TEXT_CHARS
} from '../src/main/speech-command'

describe('the shipped default command (T237 AC-4)', () => {
  it('is a TTS the OS already ships, resolved on PATH', () => {
    expect(defaultSpeechCommand('darwin')).toBe('say')
    expect(defaultSpeechCommand('linux')).toBe('spd-say -w')
    expect(defaultSpeechCommand('freebsd')).toBe('spd-say -w')
  })

  it('is empty on Windows, where the only built-in voice would need a shell', () => {
    expect(defaultSpeechCommand('win32')).toBe('')
    expect(buildSpeechSpawn(defaultSpeechCommand('win32'), 'hello')).toBeNull()
  })

  it('matches the platform this process runs on', () => {
    expect(DEFAULT_SPEECH_COMMAND).toBe(defaultSpeechCommand(process.platform))
  })

  it('carries no absolute path — nothing tied to one machine or one home dir', () => {
    expect(isAbsolute(DEFAULT_SPEECH_COMMAND)).toBe(false)
    expect(DEFAULT_SPEECH_COMMAND).not.toMatch(/[/\\]/)
    expect(DEFAULT_SPEECH_COMMAND).not.toMatch(/~|\$HOME|Users|home/)
  })
})

describe('normalizeSpeechCommand', () => {
  it('keeps a well-formed command verbatim', () => {
    expect(normalizeSpeechCommand('espeak -s 150')).toBe('espeak -s 150')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeSpeechCommand('  say  ')).toBe('say')
  })

  it('falls back to the default for junk rather than storing something unspawnable', () => {
    expect(normalizeSpeechCommand(undefined)).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand(null)).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand(42)).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand({ command: 'say' })).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand('')).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand('   ')).toBe(DEFAULT_SPEECH_COMMAND)
    expect(normalizeSpeechCommand('say "unterminated')).toBe(DEFAULT_SPEECH_COMMAND)
  })

  it('refuses an oversized command', () => {
    expect(normalizeSpeechCommand('x'.repeat(MAX_SPEECH_COMMAND_CHARS + 1))).toBe(
      DEFAULT_SPEECH_COMMAND
    )
  })
})

describe('tokenizeCommand', () => {
  it('splits a plain command on whitespace', () => {
    expect(tokenizeCommand('espeak -s 150 -v en')).toEqual(['espeak', '-s', '150', '-v', 'en'])
  })

  it('collapses runs of whitespace and trims', () => {
    expect(tokenizeCommand('  say   -r  200 ')).toEqual(['say', '-r', '200'])
  })

  it('keeps a quoted argument with spaces as one token', () => {
    expect(tokenizeCommand('"/opt/my tts/say" -v "pt br"')).toEqual([
      '/opt/my tts/say',
      '-v',
      'pt br'
    ])
  })

  it('supports single quotes', () => {
    expect(tokenizeCommand("say -v 'Luciana'")).toEqual(['say', '-v', 'Luciana'])
  })

  it('keeps an empty quoted token', () => {
    expect(tokenizeCommand('say ""')).toEqual(['say', ''])
  })

  it('returns null for an unterminated quote rather than running half the command', () => {
    expect(tokenizeCommand('say -v "pt')).toBeNull()
  })

  it('returns an empty list for an empty command', () => {
    expect(tokenizeCommand('   ')).toEqual([])
  })
})

describe('buildSpeechSpawn', () => {
  it('appends the utterance as the last argument, never a shell string', () => {
    expect(buildSpeechSpawn('espeak', 'PR two thirty-one is open')).toEqual({
      file: 'espeak',
      args: ['PR two thirty-one is open']
    })
  })

  it('keeps configured arguments ahead of the text', () => {
    expect(buildSpeechSpawn('espeak -s 150', 'done')).toEqual({
      file: 'espeak',
      args: ['-s', '150', 'done']
    })
  })

  it('passes shell metacharacters through as one literal argv entry, not as syntax', () => {
    const payload = 'build failed ; echo $HOME && whoami | tee /tmp/x'
    const spec = buildSpeechSpawn('espeak', payload)
    expect(spec).not.toBeNull()
    expect(spec!.args).toEqual([payload])
  })

  it('refuses an empty command', () => {
    expect(buildSpeechSpawn('', 'hello')).toBeNull()
    expect(buildSpeechSpawn('   ', 'hello')).toBeNull()
  })

  it('refuses a malformed command', () => {
    expect(buildSpeechSpawn('say "unterminated', 'hello')).toBeNull()
  })

  it('refuses an empty utterance', () => {
    expect(buildSpeechSpawn('espeak', '   ')).toBeNull()
  })

  it('strips leading dashes so the text can never land as a flag', () => {
    expect(buildSpeechSpawn('espeak', '--help me')?.args).toEqual(['help me'])
    expect(buildSpeechSpawn('espeak', '-')).toBeNull()
  })

  it('caps the utterance in main, whatever the renderer claimed to clamp', () => {
    const spec = buildSpeechSpawn('espeak', 'a'.repeat(MAX_SPEECH_TEXT_CHARS + 500))
    expect(spec).not.toBeNull()
    expect(spec!.args[0]).toHaveLength(MAX_SPEECH_TEXT_CHARS)
  })
})

describe('speechSpawnPath', () => {
  it('appends the well-known user bin dirs on linux', () => {
    const out = speechSpawnPath('/usr/bin', '/home/dev', 'linux')
    expect(out.split(':')).toEqual(['/usr/bin', '/home/dev/.local/bin', '/usr/local/bin'])
  })

  it('adds the homebrew dir on darwin', () => {
    expect(speechSpawnPath('/usr/bin', '/Users/dev', 'darwin').split(':')).toContain(
      '/opt/homebrew/bin'
    )
  })

  it('never reorders what the operator already has on PATH', () => {
    const out = speechSpawnPath('/home/dev/.local/bin:/usr/bin', '/home/dev', 'linux')
    expect(out.split(':').slice(0, 2)).toEqual(['/home/dev/.local/bin', '/usr/bin'])
  })

  it('does not duplicate a dir already on PATH', () => {
    const out = speechSpawnPath('/usr/local/bin', '/home/dev', 'linux')
    expect(out.split(':').filter((p) => p === '/usr/local/bin')).toHaveLength(1)
  })

  it('leaves the windows PATH alone, with its own separator', () => {
    expect(speechSpawnPath('C:\\bin;C:\\other', 'C:\\Users\\dev', 'win32')).toBe(
      'C:\\bin;C:\\other'
    )
  })

  it('survives an undefined PATH', () => {
    expect(speechSpawnPath(undefined, '/home/dev', 'linux')).toBe(
      '/home/dev/.local/bin:/usr/local/bin'
    )
  })
})
