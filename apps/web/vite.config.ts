import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/v1', '/auth', '/connect', '/oauth', '/openapi.json'].map((p) => [p, { target: 'http://localhost:8080', changeOrigin: false }])),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
