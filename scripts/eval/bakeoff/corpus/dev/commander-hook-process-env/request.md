Need a hook or event to set process.env before `_parseOptionsEnv`

Hallo,
Is there any way to set environment variables before `_parseOptionsEnv` function?
my use case is to read `.env` file via `dotenv` and set environment variables before all subcommands are executed.

The dotenv file can be specified, and I am use `enablePositionalOptions` to process options.
The issue is `preAction` hook are emit after `_parseOptionsEnv` function, this will cause `new Option().env('SOME_ENV')` not to perform as expected.

```typescript
program
  .addOption(new Option('--env <env>', 'env file').default('.env'))
  .hook('preAction', async () => {
    const { env } = program.opts()
    dotenv.config({ path: env, override: true })
  })
```

I also tried the `option:env` event, but it doesn't solve the problem perfectly either.

I searched relevant issues and stackoverflow as much as possible, but no solution found.

Thanks.
