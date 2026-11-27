import { availableParallelism, cpus } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const parallelism = availableParallelism?.() ?? cpus().length;
const maxWorkers = Math.max(1, Math.floor(parallelism / 2));
export default defineConfig({
  // Preserve assignment fields, including declarations inherited from a base class.
  oxc: {
    target: 'esnext',
    assumptions: { setPublicClassFields: true },
    typescript: { removeClassFieldsWithoutInitializer: true },
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve('src')}/` },
      { find: /^@test\//, replacement: `${resolve('tests')}/` },
      { find: /^obsidian$/, replacement: resolve('tests/__mocks__/obsidian.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    maxWorkers,
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    // Preserve mock history and hook registration order.
    clearMocks: false,
    sequence: { hooks: 'list' },
    taskTitleValueFormatTruncate: 0,
    setupFiles: ['tests/setupWindow.ts'],
  },
});
