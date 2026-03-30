import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4178,
    proxy: {
      '/api': 'http://localhost:4179'
    }
  },
  build: {
    outDir: 'dist/client'
  }
});
