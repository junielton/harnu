/* eslint-disable */
const childProcess = require('child_process')
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const commander = require('../')

const ENV_VAR = 'BAKEOFF_PRESUBCOMMAND_VALUE'

afterEach(() => {
  delete process.env[ENV_VAR]
})

function makeQuietProgram() {
  const program = new commander.Command()
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  return program
}

describe('hook registration', () => {
  test('when add preSubcommand hook then does not throw', () => {
    const program = new commander.Command()
    expect(() => program.hook('preSubcommand', () => {})).not.toThrow()
  })

  test('when add preSubcommand hook then returns the command for chaining', () => {
    const program = new commander.Command()
    expect(program.hook('preSubcommand', () => {})).toBe(program)
  })

  test('when add unrecognised hook event then still throws', () => {
    const program = new commander.Command()
    expect(() => program.hook('preSubcommands', () => {})).toThrow()
  })

  test('when read typings then HookEvent includes preSubcommand', () => {
    const typings = fs.readFileSync(path.join(__dirname, '../typings/index.d.ts'), 'utf8')
    expect(typings).toMatch(/HookEvent\s*=[^;]*['"]preSubcommand['"]/)
  })
})

describe('listener arguments', () => {
  test('when subcommand dispatched then listener gets thisCommand and subcommand', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook)
    const sub = program.command('sub').action(() => {})
    program.parse(['sub'], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][0]).toBe(program)
    expect(hook.mock.calls[0][1]).toBe(sub)
  })

  test('when several subcommands exist then listener gets the one dispatched', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook)
    program.command('first').action(() => {})
    const second = program.command('second').action(() => {})
    program.parse(['second'], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][1]).toBe(second)
  })
})

describe('timing relative to option processing', () => {
  test('when hook sets environment then subcommand Option.env sees it', () => {
    let seen
    const program = new commander.Command()
    program.hook('preSubcommand', () => {
      process.env[ENV_VAR] = 'from-hook'
    })
    program
      .command('sub')
      .addOption(new commander.Option('--value <value>').env(ENV_VAR))
      .action((options) => {
        seen = options.value
      })
    program.parse(['sub'], { from: 'user' })
    expect(seen).toBe('from-hook')
  })

  test('when hook reads program option then value is parsed', () => {
    let seen
    const program = new commander.Command()
    program.option('--env-file <file>').hook('preSubcommand', (thisCommand) => {
      seen = thisCommand.opts().envFile
    })
    program.command('sub').action(() => {})
    program.parse(['--env-file', 'custom.env', 'sub'], { from: 'user' })
    expect(seen).toBe('custom.env')
  })

  test('when program option defaulted then hook reads the default', () => {
    let seen
    const program = new commander.Command()
    program
      .addOption(new commander.Option('--env-file <file>').default('.env'))
      .hook('preSubcommand', (thisCommand) => {
        seen = thisCommand.opts().envFile
      })
    program.command('sub').action(() => {})
    program.parse(['sub'], { from: 'user' })
    expect(seen).toBe('.env')
  })

  test('when program option backed by environment then hook reads it', () => {
    let seen
    process.env[ENV_VAR] = 'program-env'
    const program = new commander.Command()
    program
      .addOption(new commander.Option('--env-file <file>').env(ENV_VAR))
      .hook('preSubcommand', (thisCommand) => {
        seen = thisCommand.opts().envFile
      })
    program.command('sub').action(() => {})
    program.parse(['sub'], { from: 'user' })
    expect(seen).toBe('program-env')
  })

  test('when enablePositionalOptions then hook reads program option and sets subcommand env', () => {
    let seen
    const program = new commander.Command()
    program
      .enablePositionalOptions()
      .option('--env-file <file>')
      .hook('preSubcommand', (thisCommand) => {
        process.env[ENV_VAR] = thisCommand.opts().envFile
      })
    program
      .command('sub')
      .addOption(new commander.Option('--value <value>').env(ENV_VAR))
      .action((options) => {
        seen = options.value
      })
    program.parse(['--env-file', 'positional.env', 'sub'], { from: 'user' })
    expect(seen).toBe('positional.env')
  })

  test('when hook runs then subcommand option parser has not run', () => {
    const calls = []
    const program = new commander.Command()
    program.hook('preSubcommand', () => calls.push('hook'))
    program
      .command('sub')
      .addOption(
        new commander.Option('--value <value>').argParser((value) => {
          calls.push('parse')
          return value
        })
      )
      .action(() => {})
    program.parse(['sub', '--value', 'x'], { from: 'user' })
    expect(calls).toEqual(['hook', 'parse'])
  })

  test('when hook runs then subcommand options are not set yet', () => {
    let seen = 'unset'
    const program = new commander.Command()
    program.hook('preSubcommand', (thisCommand, subcommand) => {
      seen = subcommand.opts().value
    })
    program
      .command('sub')
      .option('--value <value>')
      .action(() => {})
    program.parse(['sub', '--value', 'x'], { from: 'user' })
    expect(seen).toBeUndefined()
  })
})

describe('option precedence', () => {
  function runWithHookEnv(args, configure) {
    const result = {}
    const program = new commander.Command()
    program.hook('preSubcommand', () => {
      process.env[ENV_VAR] = '8080'
    })
    const option = new commander.Option('--port <number>').env(ENV_VAR)
    if (configure) configure(option)
    const sub = program
      .command('sub')
      .addOption(option)
      .action((options) => {
        result.port = options.port
        result.source = sub.getOptionValueSource('port')
      })
    program.parse(['sub', ...args], { from: 'user' })
    return result
  }

  test('when hook sets environment and option on CLI then CLI wins', () => {
    const result = runWithHookEnv(['--port', '1'])
    expect(result.port).toBe('1')
    expect(result.source).toBe('cli')
  })

  test('when hook sets environment and option has default then environment wins', () => {
    const result = runWithHookEnv([], (option) => option.default('3000'))
    expect(result.port).toBe('8080')
    expect(result.source).toBe('env')
  })

  test('when hook sets environment then value source is env', () => {
    expect(runWithHookEnv([]).source).toBe('env')
  })

  test('when hook sets environment then custom parser applied', () => {
    const result = runWithHookEnv([], (option) => option.argParser((value) => Number(value)))
    expect(result.port).toBe(8080)
  })
})

describe('scope', () => {
  test('when nested subcommands then program hook fires once for direct subcommand', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook)
    const middle = program.command('middle')
    middle.command('leaf').action(() => {})
    program.parse(['middle', 'leaf'], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][1]).toBe(middle)
  })

  test('when hook on intermediate command then listener gets it and the leaf', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    const middle = program.command('middle').hook('preSubcommand', hook)
    const leaf = middle.command('leaf').action(() => {})
    program.parse(['middle', 'leaf'], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][0]).toBe(middle)
    expect(hook.mock.calls[0][1]).toBe(leaf)
  })

  test('when hooks at each level then outermost fires first', () => {
    const calls = []
    const program = new commander.Command()
    program.hook('preSubcommand', () => calls.push('program'))
    const middle = program.command('middle').hook('preSubcommand', () => calls.push('middle'))
    middle.command('leaf').action(() => calls.push('action'))
    program.parse(['middle', 'leaf'], { from: 'user' })
    expect(calls).toEqual(['program', 'middle', 'action'])
  })

  test('when program hook sets environment then nested leaf Option.env sees it', () => {
    let seen
    const program = new commander.Command()
    program.hook('preSubcommand', () => {
      process.env[ENV_VAR] = 'for-leaf'
    })
    program
      .command('middle')
      .command('leaf')
      .addOption(new commander.Option('--value <value>').env(ENV_VAR))
      .action((options) => {
        seen = options.value
      })
    program.parse(['middle', 'leaf'], { from: 'user' })
    expect(seen).toBe('for-leaf')
  })

  test('when hook on dispatched leaf then leaf hook does not fire', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    program
      .command('sub')
      .hook('preSubcommand', hook)
      .action(() => {})
    program.parse(['sub'], { from: 'user' })
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('several listeners', () => {
  test('when two listeners then called in order added', () => {
    const calls = []
    const program = new commander.Command()
    program
      .hook('preSubcommand', () => calls.push('1'))
      .hook('preSubcommand', () => calls.push('2'))
    program.command('sub').action(() => calls.push('action'))
    program.parse(['sub'], { from: 'user' })
    expect(calls).toEqual(['1', '2', 'action'])
  })
})

describe('async', () => {
  test('when synchronous hook and parse then subcommand runs before parse returns', () => {
    const action = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', () => {})
    program.command('sub').action(action)
    program.parse(['sub'], { from: 'user' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  test('when async hook and parseAsync then awaited before subcommand action', async () => {
    const calls = []
    const program = new commander.Command()
    program.hook('preSubcommand', async () => {
      calls.push('hook-start')
      await Promise.resolve()
      calls.push('hook-end')
    })
    program.command('sub').action(() => calls.push('action'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(calls).toEqual(['hook-start', 'hook-end', 'action'])
  })

  test('when async listeners then run one after another in order added', async () => {
    const calls = []
    const program = new commander.Command()
    program
      .hook('preSubcommand', async () => {
        calls.push('1-start')
        await Promise.resolve()
        await Promise.resolve()
        calls.push('1-end')
      })
      .hook('preSubcommand', async () => {
        calls.push('2-start')
        await Promise.resolve()
        calls.push('2-end')
      })
    program.command('sub').action(() => calls.push('action'))
    await program.parseAsync(['sub'], { from: 'user' })
    expect(calls).toEqual(['1-start', '1-end', '2-start', '2-end', 'action'])
  })

  test('when async hook sets environment late then subcommand Option.env sees it', async () => {
    let seen
    const program = new commander.Command()
    program.hook('preSubcommand', async () => {
      await Promise.resolve()
      process.env[ENV_VAR] = 'async-value'
    })
    program
      .command('sub')
      .addOption(new commander.Option('--value <value>').env(ENV_VAR))
      .action((options) => {
        seen = options.value
      })
    await program.parseAsync(['sub'], { from: 'user' })
    expect(seen).toBe('async-value')
  })

  test('when async action then parseAsync resolves after hook and action', async () => {
    const calls = []
    const program = new commander.Command()
    program.hook('preSubcommand', async () => {
      calls.push('hook')
    })
    program.command('sub').action(async () => {
      await Promise.resolve()
      calls.push('action')
    })
    await program.parseAsync(['sub'], { from: 'user' })
    expect(calls).toEqual(['hook', 'action'])
  })
})

describe('errors', () => {
  test('when listener throws then parse throws and subcommand does not run', () => {
    const action = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', () => {
      throw new Error('hook failed')
    })
    program.command('sub').action(action)
    expect(() => program.parse(['sub'], { from: 'user' })).toThrow('hook failed')
    expect(action).not.toHaveBeenCalled()
  })

  test('when listener rejects then parseAsync rejects and subcommand does not run', async () => {
    const action = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', async () => {
      throw new Error('hook failed')
    })
    program.command('sub').action(action)
    await expect(program.parseAsync(['sub'], { from: 'user' })).rejects.toThrow('hook failed')
    expect(action).not.toHaveBeenCalled()
  })
})

describe('kinds of dispatch', () => {
  test('when called by alias then listener gets the real subcommand', () => {
    const hook = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook)
    const sub = program
      .command('sub')
      .alias('s')
      .action(() => {})
    program.parse(['s'], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][1]).toBe(sub)
  })

  test('when default command dispatched then hook fires', () => {
    const hook = jest.fn()
    const action = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook)
    const sub = program.command('sub', { isDefault: true }).action(action)
    program.parse([], { from: 'user' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0][1]).toBe(sub)
    expect(action).toHaveBeenCalledTimes(1)
  })

  describe('executable subcommand', () => {
    let spawnSpy
    let calls

    beforeEach(() => {
      calls = []
      spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        calls.push('spawn')
        return new EventEmitter()
      })
    })

    afterEach(() => {
      spawnSpy.mockRestore()
    })

    test('when executable subcommand then hook fires before spawn', () => {
      const program = new commander.Command()
      program.hook('preSubcommand', () => calls.push('hook'))
      program.command('external', 'external description')
      program.parse(['external'], { from: 'user' })
      expect(calls).toEqual(['hook', 'spawn'])
    })

    test('when executable subcommand then listener gets the subcommand', () => {
      let seenName
      const program = new commander.Command()
      program.hook('preSubcommand', (thisCommand, subcommand) => {
        seenName = subcommand.name()
      })
      program.command('external', 'external description')
      program.parse(['external'], { from: 'user' })
      expect(seenName).toBe('external')
    })

    test('when async hook and executable subcommand then spawn waits for hook', async () => {
      const program = new commander.Command()
      program.hook('preSubcommand', async () => {
        await Promise.resolve()
        calls.push('hook')
      })
      program.command('external', 'external description')
      await program.parseAsync(['external'], { from: 'user' })
      expect(calls).toEqual(['hook', 'spawn'])
    })
  })
})

describe('when no subcommand is dispatched', () => {
  test('when program runs its own action then hook does not fire', () => {
    const hook = jest.fn()
    const action = jest.fn()
    const program = new commander.Command()
    program.hook('preSubcommand', hook).action(action)
    program.command('sub').action(() => {})
    program.parse([], { from: 'user' })
    expect(hook).not.toHaveBeenCalled()
    expect(action).toHaveBeenCalledTimes(1)
  })

  test('when intermediate command runs its own action then its hook does not fire', () => {
    const hook = jest.fn()
    const action = jest.fn()
    const program = new commander.Command()
    const middle = program.command('middle').hook('preSubcommand', hook).action(action)
    middle.command('leaf').action(() => {})
    program.parse(['middle'], { from: 'user' })
    expect(hook).not.toHaveBeenCalled()
    expect(action).toHaveBeenCalledTimes(1)
  })

  test('when no subcommand given then hook does not fire', () => {
    const hook = jest.fn()
    const program = makeQuietProgram()
    program.hook('preSubcommand', hook)
    program.command('sub').action(() => {})
    expect(() => program.parse([], { from: 'user' })).toThrow()
    expect(hook).not.toHaveBeenCalled()
  })

  test('when unknown subcommand given then hook does not fire', () => {
    const hook = jest.fn()
    const program = makeQuietProgram()
    program.hook('preSubcommand', hook)
    program.command('sub').action(() => {})
    expect(() => program.parse(['nonesuch'], { from: 'user' })).toThrow()
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('relation to action hooks', () => {
  test('when all hooks present then preSubcommand runs before action hooks', () => {
    const calls = []
    const program = new commander.Command()
    program
      .hook('preSubcommand', () => calls.push('preSubcommand'))
      .hook('preAction', () => calls.push('preAction'))
      .hook('postAction', () => calls.push('postAction'))
    program.command('sub').action(() => calls.push('action'))
    program.parse(['sub'], { from: 'user' })
    expect(calls).toEqual(['preSubcommand', 'preAction', 'action', 'postAction'])
  })

  test('when only action hooks then behaviour unchanged', () => {
    const calls = []
    const program = new commander.Command()
    program
      .hook('preAction', () => calls.push('preAction'))
      .hook('postAction', () => calls.push('postAction'))
    program.command('sub').action(() => calls.push('action'))
    program.parse(['sub'], { from: 'user' })
    expect(calls).toEqual(['preAction', 'action', 'postAction'])
  })

  test('when no hooks then subcommand still dispatched', () => {
    const action = jest.fn()
    const program = new commander.Command()
    program.command('sub').action(action)
    program.parse(['sub'], { from: 'user' })
    expect(action).toHaveBeenCalledTimes(1)
  })
})
