import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app/',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/v1', '/auth', '/connect', '/oauth', '/openapi.json'].map((p) => [p, { target: 'http://localhost:8080', changeOrigin: false }])),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
