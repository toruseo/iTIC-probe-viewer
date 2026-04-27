import { defineConfig } from 'vite';

// Relative base ('./') so the build runs at any subdirectory — including
// GitHub Pages' `https://<user>.github.io/<repo>/` URL.
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: { strict: false },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
