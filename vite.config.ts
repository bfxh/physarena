import { defineConfig } from 'vite';

// Engines that ship raw .wasm / non-ESM emscripten glue must not be pre-bundled
// by esbuild, otherwise the wasm locateFile lookup breaks at runtime.
const RAW_WASM_PKGS = [
  'physx-js-webidl',
  'jolt-physics',
  'ammojs-typed',
  '@babylonjs/havok',
  'crashcat',
  'oimo',
];

export default defineConfig({
  // Relative base so the built site works from any sub-path. GitHub Pages
  // serves user sites from /<repo>/, and absolute /assets/... URLs break there.
  base: './',
  server: {
    port: 5180,
    strictPort: false,
    headers: {
      // Required so SharedArrayBuffer-based multithreaded engine builds can
      // initialise if the user enables them.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: RAW_WASM_PKGS,
    include: ['three'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
  },
  assetsInclude: ['**/*.wasm'],
});
