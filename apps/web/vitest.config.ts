import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['lib/**/*.test.ts', 'lib/**/__tests__/*.test.ts'],
    environment: 'node',
  },
});
