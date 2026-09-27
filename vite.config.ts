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
  // The Pages deployment lives at /bshsq/. A relative base ('./') broke the
  // engines: the emscripten glue resolves its .wasm against the *page* URL, not
  // the chunk URL, so /bshsq/ + './assets/x.wasm' pointed somewhere that did
  // not exist - locally (served at /) the same lookup worked, which is why it
  // only failed after deploy. The absolute sub-path keeps every lookup correct;
  // if the repo is ever renamed or moves to a custom domain, change this line.
  base: '/bshsq/',
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
