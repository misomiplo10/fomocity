import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Two pages: the game (/) and the "How it works" guide (/how).
    rollupOptions: { input: { main: 'index.html', how: 'how.html' } },
  },
});
