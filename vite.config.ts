import {defineConfig, normalizePath} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {createDevMiddleware} from './service/dev.ts';

const runtimeDirectory = resolve(process.env.REZZKA_DATA_DIR ?? '.local/data');

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'webos-classic-entry',
    // Packaged TV apps are loaded with file://. Keep the production entry classic;
    // the development server still uses native modules and HMR.
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        return context.bundle ? html.replace(/type="module"\s+crossorigin/g, 'defer').replace(/ crossorigin(?=[ >])/g, '') : html;
      },
    },
  }, {
    name: 'rezzka-local-service',
    configureServer(server) {
      const bridge = createDevMiddleware(runtimeDirectory);
      server.middlewares.use(bridge.handle);
      server.httpServer?.once('close', () => { void bridge.close(); });
    },
  }],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    fs: { deny: [
      // Preserve the defaults of the pinned Vite version when adding private
      // runtime data. Denial also applies to /@fs paths and ?raw imports.
      '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
      '**/.local/**', `${normalizePath(runtimeDirectory)}/**`, '**/source-session.json', '**/source-session.json.*.tmp',
      '**/kinopoisk-key.json', '**/kinopoisk-key.json.*.tmp',
    ] },
  },
  build: {
    target: 'chrome132', sourcemap: true, outDir: 'dist', modulePreload: false,
    rolldownOptions: {output: {format: 'iife', codeSplitting: false}},
  },
});
