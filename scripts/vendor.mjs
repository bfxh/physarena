/**
 * Copies the WASM / classic-script payloads that cannot be resolved through the
 * bundler into `public/vendor/`, so every engine loads from a stable URL at
 * runtime instead of fighting Vite's asset pipeline.
 *
 * Run with:  npm run vendor      (executed automatically by `npm run dev|build`)
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');

/** [sourceRelativeToNodeModules, destinationRelativeToPublic] */
const TARGETS = [
  // Havok ships the wasm next to the ESM glue; we serve it ourselves.
  ['@babylonjs/havok/lib/esm/HavokPhysics.wasm', 'vendor/havok/HavokPhysics.wasm'],
  // PhysX 5 - same story, non-inlined build.
  ['physx-js-webidl/physx-js-webidl.wasm', 'vendor/physx/physx-js-webidl.wasm'],
  // Bullet ships only the asm.js build here (no wasm at all). It is a CJS/UMD
  // module whose factory assigns to `this`, so it must be loaded as a classic
  // script where `this === window`.
  ['ammojs-typed/ammo/ammo.js', 'vendor/ammo/ammo.js'],
];

let copied = 0;
let skipped = 0;

for (const [src, dest] of TARGETS) {
  const from = join(nm, src);
  const to = join(root, 'public', dest);
  if (!existsSync(from)) {
    console.warn(`[vendor] MISSING source: ${src}`);
    skipped++;
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const kb = (statSync(to).size / 1024).toFixed(0);
  copied++;
  console.log(`[vendor] ${src} -> public/${dest}  (${kb} KB)`);
}

console.log(`[vendor] done: ${copied} copied, ${skipped} skipped`);
