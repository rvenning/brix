import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 8129, strictPort: true },
  preview: { port: 8129, strictPort: true },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'] },
});
