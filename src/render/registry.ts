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
}

/** Order defines the sidebar order: established engines first, minimal last. */
const MODULE_IDS = ['three'] as const;

type Loader = () => Promise<{ meta: RenderEngineMeta; create(): IRenderEngine }>;

const LOADERS: Record<string, Loader> = {
  three: () => import('./engines/three') as Promise<any>,
};

let cached: RendererEntry[] | null = null;

/**
 * Loads only the metadata. A renderer whose module fails to load (an optional
 * dependency that is not installed, say) is dropped from the list rather than
 * breaking the whole boot - the guard rail the user asked for.
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
    entries.push({
      meta: mod.meta,
      boot: async (host: HTMLElement) => {
        const engine = mod.create();
        await engine.init(host);
        return engine;
      },
    });
  });
  if (failed.length) {
    console.warn('[physarena] 渲染器加载失败（已跳过）:\n' + failed.join('\n'));
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
