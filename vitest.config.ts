import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// happy-dom gives the DOM the Greenhouse adapter needs, without a browser.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
