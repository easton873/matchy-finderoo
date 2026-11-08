import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const server = process.env.GAME_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  root: __dirname,
  build: {
    outDir: resolve(__dirname, '../dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        host: resolve(__dirname, 'host.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: server, ws: true },
      '/api': server,
    },
  },
});
