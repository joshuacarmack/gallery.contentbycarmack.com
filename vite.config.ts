import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // During `vite` dev, forward API and download routes to `wrangler dev`.
      '/api': 'http://localhost:8787',
      '/d': 'http://localhost:8787',
      '/z': 'http://localhost:8787',
    },
  },
});
