import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],

    // One PostgreSQL container for the whole run, and files that do not run at
    // the same time. Each test starts from an empty database, and two files
    // truncating each other's rows halfway through would make failures depend on
    // scheduling — the kind of flake that gets a suite ignored.
    fileParallelism: false,

    // Pulling and starting the container happens once, but it happens.
    testTimeout: 30_000,
    hookTimeout: 120_000,

    include: ['tests/**/*.test.ts'],
  },
})
