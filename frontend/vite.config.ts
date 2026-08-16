import { defineConfig } from 'vite';

// base './' keeps every asset reference relative, so the same build works at
// https://<user>.github.io/piggy/, on a custom domain, or served by the backend.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Only used in full-stack dev; the GH Pages build never calls /api.
      '/api': {
        target: process.env.PIGGY_API_URL || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
