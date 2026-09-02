import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // PGlite is WASM + a single logical connection: keep files serial.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
