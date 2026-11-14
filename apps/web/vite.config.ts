import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('apps/web'),
  plugins: [react()],
  build: { outDir: resolve('dist/web'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: process.env.SITES_MANAGED_LINUX_CONTAINER === '1' ? ['terminal.local'] : [],
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 4310}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
