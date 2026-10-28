import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 15000,
  },
})
