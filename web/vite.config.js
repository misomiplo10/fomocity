import { defineConfig } from 'vite';

export default defineConfig({
  // Local stand-in for the Vercel relay (api/rpc.js): /api/rpc → DEV_RPC_TARGET.
  server: {
    proxy: {
      '/api/rpc': { target: process.env.DEV_RPC_TARGET ?? 'http://127.0.0.1:8899', changeOrigin: true, rewrite: () => '/' },
    },
  },
  build: {
    target: 'es2022',
    // Two pages: the game (/) and the "How it works" guide (/how).
    rollupOptions: { input: { main: 'index.html', how: 'how.html' } },
  },
});
