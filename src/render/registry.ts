import type { IRenderEngine, RenderEngineMeta } from './types';

/**
 * Renderers are plug-ins, exactly like the physics engines.
 *
 * `meta` is loaded eagerly (a few hundred bytes) so the sidebar can list every
 * renderer without paying for its code; the actual implementation is a dynamic
 * import that only happens when the user selects it.
 */
export interface RendererEntry {
  meta: RenderEngineMeta;
  /** Creates the context and mounts a canvas into `host`. */
  boot(host: HTMLElement): Promise<IRenderEngine>;
  /**
   * Set when the backend exists but cannot run in this environment (no WebGPU
   * adapter, missing extension). The card stays in the sidebar with the reason
   * attached: "your browser cannot run this" is a fact worth showing, not a
   * renderer that quietly does not exist.
   */
  unavailable?: string;
}

/** Order defines the sidebar order: frameworks, then hand-written GL, then CPU. */
const MODULE_IDS = [
  'three', 'babylon', 'webgpu', 'webgl2', 'webgl1', 'points', 'wireframe', 'canvas2d', 'svg', 'css3d',
] as const;

interface RendererModule {
  meta: RenderEngineMeta;
  create(): IRenderEngine;
  availability?(): string | undefined;
}

type Loader = () => Promise<RendererModule>;

const LOADERS: Record<string, Loader> = {
  three: () => import('./engines/three') as Promise<any>,
  babylon: () => import('./engines/babylon') as Promise<any>,
  webgpu: () => import('./engines/webgpu') as Promise<any>,
  webgl2: () => import('./engines/webgl2') as Promise<any>,
  webgl1: () => import('./engines/webgl1') as Promise<any>,
  points: () => import('./engines/points') as Promise<any>,
  wireframe: () => import('./engines/wireframe') as Promise<any>,
  canvas2d: () => import('./engines/canvas2d') as Promise<any>,
  svg: () => import('./engines/svg') as Promise<any>,
  css3d: () => import('./engines/css3d') as Promise<any>,
};

let cached: RendererEntry[] | null = null;

/**
 * Loads only the metadata (a few hundred bytes each) and asks every module
 * whether it can actually run here. A module that fails to load at all is
 * dropped; one that loads but cannot run stays listed, disabled, with the
 * reason - the distinction matters, because the second case is a property of
 * the environment rather than a broken renderer.
 */
export async function loadRenderers(): Promise<RendererEntry[]> {
  if (cached) return cached;
  const settled = await Promise.allSettled(MODULE_IDS.map((id) => LOADERS[id]()));
  const entries: RendererEntry[] = [];
  const failed: string[] = [];
  settled.forEach((r, i) => {
    const id = MODULE_IDS[i];
    if (r.status === 'rejected') {
      failed.push(`${id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    const mod = r.value;
    let unavailable: string | undefined;
    try {
      unavailable = mod.availability?.();
    } catch (e) {
      unavailable = e instanceof Error ? e.message : String(e);
    }
    entries.push({
      meta: mod.meta,
      unavailable,
      boot: async (host: HTMLElement) => {
        const engine = mod.create();
        await engine.init(host);
        return engine;
      },
    });
  });
  if (failed.length) {
    console.warn('[physarena] 渲染器模块加载失败（已跳过）:\n' + failed.join('\n'));
  }
  if (!entries.length) throw new Error('没有可用的渲染引擎：' + failed.join('; '));
  cached = entries;
  return entries;
}

export function rendererById(entries: RendererEntry[], id: string): RendererEntry {
  const e = entries.find((x) => x.meta.id === id);
  if (!e) throw new Error(`未知渲染引擎：${id}`);
  return e;
}
