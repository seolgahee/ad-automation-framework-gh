import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 15000,
    pool: 'forks',
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
});
