import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on 8787. In production the API serves the built files itself.
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } }, build: { outDir: 'dist', sourcemap: false } });
