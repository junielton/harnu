import { defineConfig } from 'vitest/config'

// The scale-fixture perf suite (T697). Kept out of the main `vitest run`: timing needs a quiet
// process, so files run one at a time in one fork, and the sharded unit run would only add noise.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.ts'],
    globals: false,
    reporters: ['default'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60_000
  }
})
