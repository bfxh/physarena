import type { EngineMeta, IPhysicsEngine } from '../core/types';

export interface EngineEntry {
  meta: EngineMeta;
  /**
   * Boots the engine: dynamic import + wasm instantiation + `init()`.
   * Timed by the caller, because startup latency is itself a comparison metric.
   */
  boot(): Promise<IPhysicsEngine>;
}

/** Import order defines the default sidebar order (Rust / C++ first, JS last). */
const MODULE_IDS = [
  'vxl',
  'rapier3d',
  'jolt',
  'physx5',
  'bullet',
  'havok',
  'crashcat',
  'cannon',
  'oimo',
] as const;

type Loader = () => Promise<{ meta: EngineMeta; create(): IPhysicsEngine }>;

const LOADERS: Record<string, Loader> = {
  vxl: () => import('./vxl') as any,
  rapier3d: () => import('./rapier3d') as any,
  jolt: () => import('./jolt') as any,
  physx5: () => import('./physx5') as any,
  bullet: () => import('./bullet') as any,
  havok: () => import('./havok') as any,
  crashcat: () => import('./crashcat') as any,
  cannon: () => import('./cannon') as any,
  oimo: () => import('./oimo') as any,
};

let cached: EngineEntry[] | null = null;

/**
 * Loads only the eight metadata objects (a few hundred bytes each); the heavy
 * wasm payloads stay untouched until a user actually selects an engine.
 */
export async function loadRegistry(): Promise<EngineEntry[]> {
  if (cached) return cached;
  const mods = await Promise.all(MODULE_IDS.map((id) => LOADERS[id]()));
  cached = MODULE_IDS.map((id, i) => ({
    meta: mods[i].meta,
    boot: async () => {
      const engine = mods[i].create();
      await engine.init();
      return engine;
    },
  }));
  return cached;
}

export function engineById(entries: EngineEntry[], id: string): EngineEntry {
  const e = entries.find((x) => x.meta.id === id);
  if (!e) throw new Error(`unknown engine: ${id}`);
  return e;
}
