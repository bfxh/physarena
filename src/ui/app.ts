import type { EngineMeta, EngineStats, IPhysicsEngine, Vec3 } from '../core/types';
import { Simulation } from '../core/simulation';
import { DEFAULT_BENCH, resultsToCsv, runBenchmark, type BenchResult } from '../core/bench';
import { loadRegistry, type EngineEntry } from '../engines/registry';
import { PROBES, runSelfTest, selfTestToCsv, type SelfTestRow } from '../core/selftest';
import { SCENARIOS } from '../scenarios';
import { importedScenario } from '../scenarios/imported';
import type { Scenario } from '../scenarios/types';
import { slotRects } from '../render/layout';
import { loadRenderers, rendererById, type RendererEntry } from '../render/registry';
import type { IRenderEngine, RenderStats } from '../render/types';
import { collectMetrics, metricsToRows, type MetricSection } from '../core/metrics';
import { FrameWatchdog, Guards, type GuardKind } from '../core/guard';
import { clear, download, fmt, fmtBytes, h } from './dom';
import { loadModelFile } from './importer';

type Mode = 'sandbox' | 'bench' | 'compare';

interface Slot {
  entry: EngineEntry;
  engine: IPhysicsEngine | null;
  sim: Simulation | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  bootMs?: number;
  /** Scenario + load signature the current world was built from. */
  sceneKey: string;
  lastUsed: number;
}

/**
 * How many engines may hold a live *world* at once. The engine instance and
 * its wasm module are never dropped - see evictStale.
 */
const MAX_LIVE_WORLDS = 3;
/** A boot that takes longer than this is reported as a failure, not a spinner. */
const BOOT_TIMEOUT_MS = 45000;

const SHAPE_LABEL: Record<string, string> = {
  box: '盒', sphere: '球', capsule: '胶囊', cylinder: '圆柱', cone: '圆锥',
  convex: '凸包', trimesh: '三角网', compound: '复合体',
};
const JOINT_LABEL: Record<string, string> = {
  fixed: '固定', revolute: '转动', prismatic: '棱柱', spherical: '球形', distance: '距离', spring: '弹簧',
};

export class App {
  private root: HTMLElement;
  private engines: EngineEntry[] = [];
  private scenarios: Scenario[] = [...SCENARIOS];

  private viewport!: IRenderEngine;
  private slots = new Map<string, Slot>();

  /** Renderers are an independent axis: any of them can drive any physics engine. */
  private renderers: RendererEntry[] = [];
  private rendererId = 'three';
  private rendererStats: RenderStats = { drawCalls: 0, triangles: 0 };
  /** Wall-clock ms of the last successful renderer swap, shown in the panel. */
  private lastSwapMs = 0;

  private mode: Mode = 'sandbox';
  private scenario: Scenario = SCENARIOS[0];
  private bodies = SCENARIOS[0].defaultBodies;
  private gravity: Vec3 = [0, -9.81, 0];
  private seed = 20260915;
  private paused = false;
  /** Fixed step, kept at app level so a recreated Simulation inherits it. */
  private fixedDt = 1 / 60;

  private sandboxEngineId = 'rapier3d';
  private compareIds: string[] = [];
  private benchEngineIds = new Set<string>();
  private benchScenarioIds = new Set<string>();

  private benchResults: BenchResult[] = [];
  private benchRunning = false;
  private benchProgress = { done: 0, total: 1, message: '' };

  private selfTestRows: SelfTestRow[] = [];
  private selfTestRunning = false;
  private selfTestMessage = '';

  /** Both long runners step engines on the main thread; only one may run. */
  private get busy(): boolean {
    return this.benchRunning || this.selfTestRunning;
  }

  /**
   * Every crossing into third-party code goes through these: a trapped wasm
   * module, a throwing solver or a lost context degrades one subsystem instead
   * of the page.
   */
  private guards = new Guards();
  private watchdog = new FrameWatchdog(250);
  /** Last full metric set, kept so the automation hooks can export it. */
  private lastMetrics: MetricSection[] = [];

  /** Frames per second of the render loop itself, not of the physics. */
  private renderFps = 0;
  private lastFrame = 0;

  private els!: {
    engineList: HTMLElement;
    scenarioList: HTMLElement;
    rendererList: HTMLElement;
    inspector: HTMLElement;
    /** Persistent container so the metric panel updates without a rebuild. */
    metrics: HTMLElement;
    stage: HTMLElement;
    benchPane: HTMLElement;
    hud: HTMLElement;
    overlay: HTMLElement;
    controls: HTMLElement;
  };

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.engines = await loadRegistry();
    this.renderers = await loadRenderers();

    // Deep links: ?engine=jolt&scene=pyramid&bodies=300 preselects the sandbox.
    // The hash written by syncHash is parsed as a fallback so a shared/reloaded
    // URL restores what its own hash claims.
    const q = new URLSearchParams(location.search || location.hash.replace(/^#/, ''));
    const wantEngine = q.get('engine');
    const wantScene = q.get('scene');
    const wantMode = q.get('mode');
    if (wantScene && SCENARIOS.some((s) => s.id === wantScene)) {
      this.scenario = SCENARIOS.find((s) => s.id === wantScene)!;
      this.bodies = this.scenario.defaultBodies;
    }
    const bodiesParam = Number(q.get('bodies'));
    if (Number.isFinite(bodiesParam) && bodiesParam > 0) {
      // Same clamps the slider applies: min 8 and the scenario's own ceiling.
      this.bodies = this.scenario.scalable
        ? Math.max(8, Math.min(bodiesParam, this.scenario.maxBodies))
        : this.scenario.defaultBodies;
    }
    this.sandboxEngineId = this.engines.some((e) => e.meta.id === wantEngine)
      ? wantEngine!
      : this.engines[0].meta.id;
    this.compareIds = this.engines.slice(0, 2).map((e) => e.meta.id);
    for (const e of this.engines) {
      this.benchEngineIds.add(e.meta.id);
    }
    for (const s of SCENARIOS.slice(0, 4)) this.benchScenarioIds.add(s.id);

    this.buildShell();
    // The renderer is a plug-in too, so it boots after the shell exists.
    await this.bootRenderer(this.rendererId);
    this.bindKeys();
    this.syncHash();
    this.exposeAutomationHooks();
    if (wantMode && wantMode !== 'sandbox' && ['bench', 'compare'].includes(wantMode)) {
      (this.root.querySelector(`[data-mode="${wantMode}"]`) as HTMLElement | null)?.click();
    } else {
      await this.activateForMode();
    }
    requestAnimationFrame(this.loop);

    // ?selftest=1 boots every engine and publishes the compatibility matrix
    // on window.__physarena_report so CI or a script can read it.
    if (new URLSearchParams(location.search).has('selftest')) {
      (this.root.querySelector('[data-mode="bench"]') as HTMLElement | null)?.click();
      void this.runSelfTestNow();
    }
  }

  // ------------------------------------------------------------------ shell

  private buildShell(): void {
    const engines = h('aside', { class: 'pa-panel' });
    const inspector = h('aside', { class: 'pa-panel pa-panel-right' });
    const stage = h('div', { class: 'pa-stage' });
    const benchPane = h('div', { class: 'pa-bench', style: 'display:none' });
    const controls = h('div', { class: 'pa-controls' });

    const tabs = h('div', { class: 'pa-tabs' });
    const setMode = (m: Mode) => {
      // A run owns the CPU and its results; switching modes mid-run would
      // rebuild worlds under it and invalidate every sample.
      if (this.busy && m !== this.mode) return;
      this.mode = m;
      for (const btn of tabs.children) {
        (btn as HTMLElement).classList.toggle('on', (btn as HTMLElement).dataset.mode === m);
      }
      stage.style.display = m === 'bench' ? 'none' : '';
      benchPane.style.display = m === 'bench' ? '' : 'none';
      engines.style.display = m === 'bench' ? 'none' : '';
      inspector.style.display = m === 'bench' ? 'none' : '';
      controls.style.display = m === 'bench' ? 'none' : '';
      this.renderControls();
      if (m === 'bench') this.renderBenchPane();
      else void this.activateForMode();
      this.syncHash();
    };
    for (const [m, label] of [['sandbox', '沙盒'], ['bench', '跑分'], ['compare', '并排对比']] as [Mode, string][]) {
      tabs.append(h('button', { dataset: { mode: m }, text: label, onclick: () => setMode(m) }));
    }
    tabs.children[0].classList.add('on');

    const header = h(
      'header',
      { class: 'pa-header' },
      h('div', { class: 'pa-brand' }, h('b', { text: 'PhysArena' }), h('span', { text: '浏览器物理引擎测试场' })),
      tabs,
      h('div', { class: 'pa-header-right' }, h('span', { text: `${this.engines.length} 个引擎 · ${this.scenarios.length} 个场景` })),
    );

    // stage internals
    this.els = {
      engineList: engines,
      scenarioList: h('div'),
      rendererList: h('div'),
      inspector,
      metrics: h('div'),
      stage,
      benchPane,
      hud: h('div', { class: 'pa-hud' }),
      overlay: h('div', { class: 'pa-stage-msg', style: 'display:none' }),
      controls,
    };

    const sidebarLeft = h('aside', { class: 'pa-panel pa-panel-left' });
    sidebarLeft.append(
      h('div', { class: 'pa-panel-title', text: '物理引擎' }),
      engines,
      h('div', { class: 'pa-panel-title', text: '测试场景' }),
      this.els.scenarioList,
    );

    stage.append(this.els.hud, this.els.overlay);
    benchPane.append(h('aside', { class: 'pa-panel' }, h('div', { class: 'pa-panel-title', text: '跑分设置' }), h('div', { id: 'pa-bench-cfg' })), h('div', { class: 'pa-bench-main', id: 'pa-bench-main' }));

    const shell = h('div', { class: 'pa-shell' }, header, sidebarLeft, stage, inspector, benchPane, controls);
    this.root.append(shell);

    stage.append(this.els.overlay);

    this.setupDropTarget(stage);
    this.renderEngineList();
    this.renderScenarioList();
    this.renderRendererList();
    this.renderInspector();
    this.renderControls();
    requestAnimationFrame(() => this.layoutOverlay());
  }

  // --------------------------------------------------------------- renderer

  /**
   * Boots a renderer and makes it current.
   *
   * The replacement is created *first*: a renderer that cannot start (no WebGPU
   * adapter, a blocked dynamic import) must not take the working one down with
   * it, so the old context is only disposed once the new one is up.
   *
   * Every layer belongs to one renderer instance, so a swap replays each slot's
   * `setBodies` against the new backend - that is what keeps the two axes
   * (physics / rendering) genuinely independent.
   */
  private async bootRenderer(id: string): Promise<void> {
    const entry = rendererById(this.renderers, id);
    const engine = await entry.boot(this.els.stage);
    engine.onResize = () => this.layoutOverlay();
    engine.onContextLost = () => {
      this.showOverlay(
        `${esc(entry.meta.name)} 的绘图上下文丢失（通常是显卡驱动重置或显存不足）。<br>` +
        '刷新页面即可恢复；也可以先关掉其它占用 GPU 的标签页，或在右侧换一个渲染引擎。',
        true,
      );
    };
    const previous = this.viewport;
    this.viewport = engine;
    this.rendererId = id;
    // Framing is per-renderer (camera lives inside the backend), so the next
    // activate pass must re-frame instead of trusting the old camera.
    this.framed = false;
    previous?.dispose();
    this.replayLayers();
    this.renderRendererList();
    this.draw();
  }

  /** Re-creates every slot's layer on the current renderer. */
  private replayLayers(): void {
    for (const s of this.slots.values()) {
      if (!s.sim) continue;
      const layer = this.viewport.addLayer(s.entry.meta.id, parseInt(s.entry.meta.accent.slice(1), 16));
      layer.setBodies(s.sim.world?.bodies ?? []);
    }
  }

  /** Runtime renderer swap, driven by the sidebar. Never throws. */
  private async setRenderer(id: string): Promise<void> {
    if (id === this.rendererId) return;
    const entry = rendererById(this.renderers, id);
    if (entry.unavailable) {
      this.showOverlay(
        `${esc(entry.meta.name)} 在当前环境不可用：<br>${esc(entry.unavailable)}`,
        true,
      );
      return;
    }
    const name = entry.meta.name;
    this.showOverlay(`正在启动 ${esc(name)} …`);
    const t0 = performance.now();
    try {
      await this.bootRenderer(id);
      await this.activateForMode(true);
      this.renderRendererList();
      this.lastSwapMs = performance.now() - t0;
      this.hideOverlay();
    } catch (e) {
      this.lastSwapMs = 0;
      this.showOverlay(
        `${esc(name)} 启动失败：${esc(e instanceof Error ? e.message : String(e))}<br>` +
        `已保留 ${esc(rendererById(this.renderers, this.rendererId).meta.name)}。`,
        true,
      );
      this.renderRendererList();
    }
  }

  /** One frame of drawing, shared by the loop and by explicit re-renders. */
  private draw(): void {
    if (!this.viewport) return;
    const ids = this.activeIds();
    this.viewport.render(ids.map((id) => ({ id, label: id })));
    this.viewport.updateCamera();
  }

  private setupDropTarget(stage: HTMLElement): void {
    const show = (on: boolean) => {
      stage.style.outline = on ? '2px dashed var(--accent)' : '';
      stage.style.outlineOffset = on ? '-8px' : '';
    };
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      show(true);
    });
    stage.addEventListener('dragleave', () => show(false));
    stage.addEventListener('drop', async (e) => {
      e.preventDefault();
      show(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      this.showOverlay(`正在解析 ${esc(file.name)} …`);
      try {
        const model = await loadModelFile(file);
        const scenario = importedScenario(model);
        this.scenarios = [...SCENARIOS.filter((s) => !s.id.startsWith('import:')), scenario];
        this.scenario = scenario;
        this.bodies = scenario.defaultBodies;
        this.renderScenarioList();
        this.renderInspector();
        this.hideOverlay();
        await this.activateForMode(true);
      } catch (err) {
        this.showOverlay(`导入失败：${esc(err instanceof Error ? err.message : String(err))}`, true);
      }
    });
  }

  private syncHash(): void {
    const p = new URLSearchParams();
    p.set('mode', this.mode);
    p.set('engine', this.sandboxEngineId);
    p.set('scene', this.scenario.id);
    p.set('bodies', String(this.bodies));
    history.replaceState(null, '', `#${p.toString()}`);
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.paused = !this.paused;
        this.renderControls();
      } else if (e.key === 'r' || e.key === 'R') {
        void this.rebuildScene();
      } else if (e.key === 'ArrowRight') {
        this.stepOnce();
      }
    });
    window.addEventListener('resize', () => {
      this.viewport.resize();
      this.layoutOverlay();
    });
  }

  // ----------------------------------------------------------- engine slots

  private slot(id: string): Slot | undefined {
    return this.slots.get(id);
  }

  private async ensureSlot(id: string): Promise<Slot> {
    let s = this.slots.get(id);
    if (!s) {
      const entry = this.engines.find((e) => e.meta.id === id);
      if (!entry) throw new Error(`未知引擎 ${id}`);
      s = { entry, engine: null, sim: null, status: 'idle', sceneKey: '', lastUsed: 0 };
      this.slots.set(id, s);
    }
    s.lastUsed = performance.now();

    if (s.status === 'idle') {
      s.status = 'loading';
      this.renderEngineList();
      const t0 = performance.now();
      const bootPromise = s.entry.boot();
      try {
        s.engine = await withTimeout(bootPromise, BOOT_TIMEOUT_MS, s.entry.meta.name);
        s.bootMs = performance.now() - t0;
        s.status = 'ready';
        this.viewport.addLayer(id, parseInt(s.entry.meta.accent.slice(1), 16));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/超时/.test(msg)) {
          // A timeout is often transient (wasm stalls under load). Reset to
          // idle so the card can be retried instead of being dead for the
          // rest of the session, and dispose the instance if it ever arrives.
          s.status = 'idle';
          s.error = msg;
          bootPromise.then(
            (late) => { try { late.dispose(); } catch { /* ignore */ } },
            () => { /* the original rejection was already handled */ },
          );
        } else {
          s.status = 'error';
          s.error = msg;
        }
      }
      this.renderEngineList();
    }
    if (s.status !== 'ready') throw new Error(s.error ?? '引擎加载失败');
    this.evictStale(new Set(this.activeIds()));
    return s;
  }

  /**
   * Drops the world of engines that have been idle for a while.
   *
   * The engine instance and its wasm module are deliberately kept: a wasm
   * instantiation is the expensive part (PhysX 5 MB, Havok 2 MB, ammo.js
   * 1.8 MB of asm.js), and re-running it on every card click froze the tab
   * for minutes. Only the per-scene data - rigid bodies, shapes, the broad
   * phase - is released, and that is where the bulk of the memory lives.
   */
  private evictStale(protectedIds: Set<string>): void {
    const live = [...this.slots.values()].filter((s) => s.status === 'ready' && s.sim);
    if (live.length <= MAX_LIVE_WORLDS) return;
    live
      .filter((s) => !protectedIds.has(s.entry.meta.id))
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, live.length - MAX_LIVE_WORLDS)
      .forEach((s) => {
        s.sim?.dispose();
        s.sim = null;
        s.sceneKey = '';
        // The layer survives; only its meshes go away. Tearing layers down
        // and rebuilding them on every engine switch produced a degenerate
        // giant mesh in the Jolt pane even though the physics state was
        // byte-identical to the Rapier pane's.
        this.viewport.layer(s.entry.meta.id)?.setBodies([]);
      });
  }

  private sceneKey(): string {
    return `${this.scenario.id}|${this.bodies}|${this.seed}|${this.gravity.join(',')}`;
  }

  private async prepareSlot(id: string): Promise<Slot> {
    const s = await this.ensureSlot(id);
    const key = this.sceneKey();
    if (!s.sim) {
      s.sim = new Simulation({
        scenario: this.scenario,
        bodies: this.bodies,
        seed: this.seed,
        gravity: this.gravity,
      });
      s.sim.engine = s.engine;
      s.sim.fixedDt = this.fixedDt;
    }
    s.sim.opts = { scenario: this.scenario, bodies: this.bodies, seed: this.seed, gravity: this.gravity };
    if (s.sceneKey !== key) {
      s.sim.rebuild();
      s.sim.paused = this.paused;
      s.sceneKey = key;
    }
    // Unconditional: the layer must always describe the world the simulation is
    // actually running, never a previously built one.
    const layer = this.viewport.layer(id);
    layer?.setBodies(s.sim.world?.bodies ?? []);
    // Populate the instance matrices right away. A fresh InstancedMesh buffer
    // is zero-filled, and while paused the render loop never syncs - without
    // this a rebuild-while-paused showed an empty viewport until unpause.
    layer?.sync(s.sim.readStates());
    s.sim.paused = this.paused;
    return s;
  }

  private activeIds(): string[] {
    if (this.mode === 'compare') return this.compareIds;
    return [this.sandboxEngineId];
  }

  private async activateForMode(reframe = false): Promise<void> {
    const ids = this.activeIds();
    if (!ids.length) return;
    this.showOverlay('正在加载引擎…');
    let first = true;
    let failed: string[] = [];
    for (const id of ids) {
      try {
        await this.prepareSlot(id);
      } catch (e) {
        failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const slot = this.slot(id);
      if (first && slot?.sim) {
        if (reframe || !this.framed) {
          this.viewport.frame(
            slot.sim.contentRadius,
            slot.sim.groundSize,
            slot.sim.extent,
            slot.sim.contentCenter,
          );
          this.framed = true;
        }
        first = false;
      }
    }
    this.hideOverlay();
    if (failed.length && failed.length === ids.length) {
      this.showOverlay(`引擎加载失败：<br>${failed.map(esc).join('<br>')}`, true);
    }
    this.renderEngineList();
    this.renderInspector();
    this.renderControls();
    this.layoutOverlay();
    this.syncHash();
  }

  private framed = false;

  private async rebuildScene(): Promise<void> {
    for (const s of this.slots.values()) s.sceneKey = '';
    await this.activateForMode();
  }

  private stepOnce(): void {
    for (const id of this.activeIds()) {
      const s = this.slot(id);
      if (!s?.sim) continue;
      s.sim.stepOnce();
      const layer = this.viewport.layer(id);
      layer?.sync(s.sim.readStates());
    }
  }

  // ------------------------------------------------------------------- loop

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60;
    this.lastFrame = now;
    this.renderFps = this.renderFps ? this.renderFps * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1 : 1 / dt;
    this.watchdog.tick(now);

    const ids = this.activeIds();
    for (const id of ids) {
      const s = this.slot(id);
      if (!s?.sim) continue;
      // Guarded: a solver that throws, or a wasm module that has trapped and is
      // now permanently poisoned, must cost this one pane rather than the
      // session. The budget is a "clearly stalled the page" line, not a 60 fps
      // target - solving 500 bodies legitimately takes tens of ms.
      const steps = this.guards.budgeted(`step:${id}`, 140, () => s.sim!.advance(dt), 0);
      if (steps > 0) {
        const states = this.guards.attempt(`read:${id}`, () => s.sim!.readStates(), []);
        const layer = this.viewport.layer(id);
        if (layer && states.length) {
          this.guards.attempt(`sync:${id}`, () => layer.sync(states), undefined);
        }
      }
    }
    if (this.mode !== 'bench') {
      this.guards.attempt('render', () => this.draw(), undefined);
    }
    this.updateHud();
    this.metricsAccum++;
    if (this.metricsAccum % 12 === 0) this.updateMetrics();
  };

  private metricsAccum = 0;

  private hudAccum = 0;
  private updateHud(): void {
    if (this.mode === 'bench') return;
    this.hudAccum++;
    if (this.hudAccum % 6 !== 0) return;
    // Sampled with the HUD rather than every frame: the counters walk every
    // layer's buffers, which is real work at 500 bodies.
    this.rendererStats = this.viewport.stats();
    const ids = this.activeIds();
    const multi = ids.length > 1;
    const el = clear(this.els.hud);
    if (!multi) {
      const s = this.slot(ids[0]);
      const sim = s?.sim;
      if (!sim) return;
      const t = sim.timing;
      el.append(
        row('引擎', s!.entry.meta.name),
        row('语言 / 后端', `${s!.entry.meta.language} · ${s!.entry.meta.backend}`),
        row('启动耗时', s!.bootMs ? `${s!.bootMs.toFixed(0)} ms` : '—'),
        sep(),
        row('动态刚体', String(sim.dynamicCount)),
        row('已跑步数', String(sim.steps)),
        row('仿真时间', `${sim.simTime.toFixed(2)} s`),
        row('物理 dt', `${(sim.fixedDt * 1000).toFixed(1)} ms`),
        sep(),
        row('当前步耗时', `${sim.lastStepMs.toFixed(3)} ms`),
        row('p50 步耗时', `${t.p50.toFixed(3)} ms`),
        row('p95 步耗时', `${t.p95.toFixed(3)} ms`),
        row('峰值步耗时', `${sim.peakStepMs.toFixed(3)} ms`),
        row('等效物理 FPS', t.equivalentFps.toFixed(0)),
        row('渲染 FPS', this.renderFps.toFixed(0)),
      );
      this.els.hud.style.top = '12px';
      this.els.hud.style.left = '12px';
    } else {
      el.append(h('div', { class: 'pa-hud-row' }, h('span', { text: '并排对比' }), h('span', { text: `${ids.length} 个引擎同步推进` })));
      el.append(sep());
      for (const id of ids) {
        const s = this.slot(id);
        if (!s?.sim) continue;
        el.append(row(s.entry.meta.name, `${s.sim.timing.p50.toFixed(2)} ms/步`));
      }
      this.els.hud.style.top = '12px';
      this.els.hud.style.left = '12px';
    }
  }

  /** Reentrancy guard: layoutOverlay() -> viewport.resize() -> onResize -> layoutOverlay(). */
  private layoutBusy = false;

  private layoutOverlay(): void {
    if (this.layoutBusy) return;
    this.layoutBusy = true;
    try {
      this.viewport?.resize();
      const stage = this.els?.stage;
      if (!stage) return;
      for (const el of [...stage.querySelectorAll('.pa-slot-label')]) el.remove();
      if (this.mode !== 'compare') return;
      const ids = this.compareIds;
      const rects = slotRects(ids.length, stage.clientWidth, stage.clientHeight);
      ids.forEach((id, i) => {
        const s = this.slot(id);
        const r = rects[i];
        if (!r) return;
        const label = h(
          'div',
          { class: 'pa-slot-label', style: `left:${r.x + 12}px; top:${r.y + 12}px;` },
          h('i', { class: 'pa-dot', style: `background:${s?.entry.meta.accent ?? '#888'}` }),
          s?.entry.meta.name ?? id,
          h('small', { text: s?.sim ? `${s.sim.timing.p50.toFixed(2)}ms` : '加载中' }),
        );
        this.els.stage.append(label);
      });
    } finally {
      this.layoutBusy = false;
    }
  }

  // -------------------------------------------------------------- rendering

  private renderEngineList(): void {
    const el = clear(this.els.engineList);
    const showCheck = this.mode !== 'sandbox';
    for (const entry of this.engines) {
      const s = this.slot(entry.meta.id);
      const loading = s?.status === 'loading';
      const errored = s?.status === 'error';
      const selected = this.mode === 'compare'
        ? this.compareIds.includes(entry.meta.id)
        : this.sandboxEngineId === entry.meta.id;

      const card = h(
        'button',
        {
          class: `pa-engine${selected ? ' on' : ''}${errored ? ' err' : ''}`,
          onclick: () => void this.selectEngine(entry.meta.id),
        },
        h(
          'div',
          { class: 'pa-engine-head' },
          h('i', { class: 'pa-dot', style: `background:${entry.meta.accent}` }),
          h('span', { class: 'pa-engine-name', text: entry.meta.name }),
          h(
            'span',
            { class: 'pa-engine-badges' },
            h('span', { class: `pa-badge lang-${entry.meta.language.split('+')[0]}`, text: entry.meta.language }),
            h('span', { class: 'pa-badge', text: entry.meta.backend }),
          ),
        ),
        h('div', { class: 'pa-engine-blurb', text: entry.meta.blurb }),
        h(
          'div',
          { class: 'pa-engine-meta' },
          h('span', { text: entry.meta.license }),
          s?.bootMs ? h('span', { text: `启动 ${s.bootMs.toFixed(0)}ms` }) : null,
          s?.status === 'ready' ? h('span', { class: 'pa-ok', text: '就绪' }) : null,
          loading ? h('span', { text: '加载中…' }) : null,
        ),
        errored ? h('div', { class: 'pa-engine-msg', text: s?.error }) : null,
      );
      if (showCheck && !selected) {
        // keeps the multi-select affordance visible in compare mode
        card.dataset.multi = '1';
      }
      el.append(card);
    }
  }

  /**
   * The renderer axis.
   *
   * Single-select on purpose: one backend drives every pane. That keeps the
   * physics comparison honest (all panes rasterised identically) and makes the
   * renderer comparison measurable (same physics, different backend).
   */
  private renderRendererList(): void {
    const el = clear(this.els.rendererList);
    for (const entry of this.renderers) {
      const selected = entry.meta.id === this.rendererId;
      // A backend the environment cannot run stays visible but disabled, with
      // the reason attached - hiding it would suggest the lab only has 9 backends.
      const blocked = !!entry.unavailable;
      el.append(
        h(
          'button',
          {
            class: `pa-engine${selected ? ' on' : ''}${blocked ? ' err' : ''}`,
            title: blocked ? entry.unavailable! : entry.meta.homepage,
            disabled: blocked ? true : undefined,
            onclick: () => void this.setRenderer(entry.meta.id),
          },
          h(
            'div',
            { class: 'pa-engine-head' },
            h('i', { class: 'pa-dot', style: `background:${entry.meta.accent}` }),
            h('span', { class: 'pa-engine-name', text: entry.meta.name }),
            h(
              'span',
              { class: 'pa-engine-badges' },
              h('span', { class: 'pa-badge', text: entry.meta.backend }),
            ),
          ),
          h('div', { class: 'pa-engine-blurb', text: entry.meta.blurb }),
          h(
            'div',
            { class: 'pa-engine-meta' },
            h('span', { text: entry.meta.license }),
            entry.meta.costKb > 0
              ? h('span', { text: `+${entry.meta.costKb} kB` })
              : h('span', { class: 'pa-ok', text: '零额外依赖' }),
            selected && this.lastSwapMs
              ? h('span', { text: `切换 ${this.lastSwapMs.toFixed(0)} ms` })
              : null,
          ),
          blocked
            ? h('div', { class: 'pa-engine-msg', text: '当前环境不可用：' + entry.unavailable })
            : null,
        ),
      );
    }
  }

  // -------------------------------------------------------------- metrics

  /**
   * Engine-reported counters. A solver whose `stats()` throws reports "no
   * data" rather than taking the panel down with it.
   */
  private engineStatsFor(id: string | undefined): EngineStats | undefined {
    if (!id) return undefined;
    const s = this.slot(id);
    if (!s?.engine) return undefined;
    return this.guards.attempt(`stats:${id}`, () => s.engine!.stats?.(), undefined);
  }

  /**
   * The single metric panel.
   *
   * All three modes render this exact component with this exact row order, so
   * a sandbox reading and a bench reading can always be lined up. Rows the
   * active engine cannot measure print "—" plus the reason; never a 0.
   */
  private updateMetrics(): void {
    const host = this.els?.metrics;
    if (!host) return;
    const id = this.activeIds()[0];
    const slot = id ? this.slot(id) : undefined;
    const sim = slot?.sim ?? null;
    const rendererMeta = this.renderers.find((r) => r.meta.id === this.rendererId)?.meta;

    const sections = collectMetrics({
      sim,
      engineMeta: slot?.entry.meta,
      engineStats: this.engineStatsFor(id),
      rendererMeta,
      renderStats: this.rendererStats,
      renderFps: this.renderFps,
      fixedDt: this.fixedDt,
      rendererSwapMs: this.lastSwapMs,
      scenarioName: this.scenario.name,
      buildMs: sim?.buildMs,
      stateHash: sim ? this.guards.attempt(`hash:${id}`, () => sim.stateHash(), undefined) : undefined,
      engineBootMs: slot?.bootMs,
    });
    this.lastMetrics = sections;

    const el = clear(host);
    for (const s of sections) {
      const box = h('div', { class: 'pa-section' });
      box.append(h('h4', { text: s.title }));
      for (const r of s.rows) {
        const line = h(
          'div',
          { class: 'pa-metric' },
          h('span', { class: 'k', text: r.label }),
          h('span', { class: r.missing ? 'v miss' : 'v', text: r.missing ? '—' : r.value }),
        );
        const tip = r.missing ?? r.hint;
        if (tip) line.title = tip;
        box.append(line);
      }
      el.append(box);
    }

    // Guard section: the "door" the user asked for, made visible. Only listed
    // when something actually happened - an empty log is not worth a row.
    const events = this.guards.recent(5);
    const box = h('div', { class: 'pa-section' });
    box.append(h('h4', { text: '守卫' }));
    box.append(
      metricLine('最差帧', this.watchdog.verdict(), this.watchdog.stalled ? 'warn' : undefined),
      metricLine(
        '引擎隔离',
        this.quarantinedEngines().length
          ? `${this.quarantinedEngines().length} 个已隔离：${this.quarantinedEngines().join('、')}`
          : '无',
        this.quarantinedEngines().length ? 'warn' : undefined,
      ),
      metricLine('记录事件', events.length ? `${events.reduce((a, e) => a + e.repeat, 0)} 次` : '无'),
    );
    for (const e of events.reverse()) {
      const line = metricLine(
        kindLabel(e.kind),
        `${e.scope} · ${e.message}${e.repeat > 1 ? `（重复 ${e.repeat} 次）` : ''}`,
        'warn',
      );
      line.title = new Date(e.at).toLocaleTimeString();
      box.append(line);
    }
    el.append(box);
  }

  private quarantinedEngines(): string[] {
    return this.engines
      .filter((e) => this.guards.isQuarantined(`step:${e.meta.id}`))
      .map((e) => e.meta.name);
  }

  private async selectEngine(id: string): Promise<void> {
    if (this.mode === 'compare') {
      if (this.compareIds.includes(id)) {
        if (this.compareIds.length > 1) this.compareIds = this.compareIds.filter((x) => x !== id);
      } else if (this.compareIds.length < 4) {
        this.compareIds = [...this.compareIds, id];
      }
      this.renderEngineList();
      await this.activateForMode(true);
      return;
    }
    if (this.sandboxEngineId === id) return;
    this.sandboxEngineId = id;
    this.renderEngineList();
    await this.activateForMode();
  }

  private renderScenarioList(): void {
    const el = clear(this.els.scenarioList);
    const groups = new Map<string, Scenario[]>();
    for (const s of this.scenarios) {
      const arr = groups.get(s.group) ?? [];
      arr.push(s);
      groups.set(s.group, arr);
    }
    for (const [group, list] of groups) {
      el.append(h('div', { class: 'pa-group-title', text: group }));
      for (const s of list) {
        el.append(
          h(
            'button',
            {
              class: `pa-scenario${s.id === this.scenario.id ? ' on' : ''}`,
              title: s.description,
              onclick: () => void this.selectScenario(s),
            },
            h('b', { text: s.name }),
            h('i', { text: `${s.defaultBodies}${s.scalable ? '+' : ''}` }),
          ),
        );
      }
    }
  }

  private async selectScenario(s: Scenario): Promise<void> {
    this.scenario = s;
    this.bodies = Math.min(this.bodies, s.maxBodies);
    if (!s.scalable) this.bodies = s.defaultBodies;
    this.renderScenarioList();
    this.renderInspector();
    this.renderControls();
    await this.activateForMode(true);
  }

  private renderInspector(): void {
    const el = clear(this.els.inspector);
    const slot = this.slot(this.activeIds()[0] ?? '');
    const meta: EngineMeta | undefined = slot?.entry.meta;
    const sim = slot?.sim ?? null;

    el.append(
      h('div', { class: 'pa-panel-title', text: '渲染引擎' }),
      h('div', {
        class: 'pa-desc',
        text: '渲染与物理是两条独立的轴：任意渲染器都能驱动任意物理引擎，两边互不知情。',
      }),
      this.els.rendererList,
    );
    this.renderRendererList();

    // Metrics sit right under the renderer picker: they are what actually gets
    // read while a scene runs, so they must not be below the fold.
    if (sim) {
      el.append(
        h('div', { class: 'pa-panel-title', text: '运行指标' }),
        h('div', {
          class: 'pa-desc',
          text: '沙盒 / 跑分 / 并排三种模式共用同一套字段与口径；测不到的项目写「—」和原因，不写 0。',
        }),
        this.els.metrics,
      );
      const runNotes = sim.notes;
      if (runNotes.length) {
        el.append(
          h('div', { class: 'pa-section' }, ...runNotes.map((n) => h('span', { class: 'pa-note', text: n }))),
        );
      }
    }

    el.append(
      h('div', { class: 'pa-panel-title', text: '当前场景' }),
      h(
        'div',
        { class: 'pa-section' },
        h('h4', { text: this.scenario.name }),
        h('div', { class: 'pa-desc', text: this.scenario.description }),
        h('div', { style: 'height:8px' }),
        kv('分组', this.scenario.group),
        kv('可扩展', this.scenario.scalable ? `是（上限 ${this.scenario.maxBodies}）` : '否（固定）'),
      ),
    );

    if (meta) {
      el.append(
        h('div', { class: 'pa-panel-title', text: '引擎能力' }),
        h(
          'div',
          { class: 'pa-section' },
          kv('实现语言', `${meta.language} · ${meta.backend}`),
          kv('求解器', meta.solver),
          kv('许可', meta.license),
          h('div', { style: 'height:8px' }),
          h('h4', { text: '碰撞体' }),
          h(
            'div',
            { class: 'pa-caps' },
            ...Object.keys(SHAPE_LABEL).map((k) =>
              h('span', { class: `pa-cap${meta.capabilities.shapes.includes(k as any) ? '' : ' no'}`, text: SHAPE_LABEL[k] }),
            ),
          ),
          h('div', { style: 'height:8px' }),
          h('h4', { text: '约束 / 关节' }),
          h(
            'div',
            { class: 'pa-caps' },
            ...Object.keys(JOINT_LABEL).map((k) =>
              h('span', { class: `pa-cap${meta.capabilities.joints.includes(k as any) ? '' : ' no'}`, text: JOINT_LABEL[k] }),
            ),
          ),
          h('div', { style: 'height:8px' }),
          kv('连续碰撞 CCD', meta.capabilities.ccd ? '支持' : '不支持'),
          kv('传感器 / 触发器', meta.capabilities.sensors ? '支持' : '不支持'),
          meta.homepage ? h('div', { style: 'height:6px' }) : null,
          meta.homepage
            ? h('a', { href: meta.homepage, target: '_blank', rel: 'noreferrer', style: 'font-size:11.5px;color:var(--accent)', text: meta.homepage })
            : null,
        ),
      );
    }

    el.append(
      h('div', { class: 'pa-panel-title', text: '说明' }),
      h(
        'div',
        { class: 'pa-section' },
        h('div', { class: 'pa-desc', html: '所有引擎共用同一个<strong>固定步长</strong>累加器，同一帧接收完全相同的 dt 序列——否则计时和轨迹都不可比。' }),
        h('div', { style: 'height:6px' }),
        h('div', { class: 'pa-desc', html: '引擎不支持的碰撞体会按 <em>圆锥→凸包→盒</em> 逐级降级，并在上方标出，不会静默替换。' }),
        h('div', { style: 'height:6px' }),
        h('div', { class: 'pa-desc', text: '把 .glb / .gltf / .obj 拖进画面即可用它做凸包碰撞体。' }),
        h('div', { style: 'height:6px' }),
        h('div', { class: 'pa-desc', text: '快捷键：空格暂停 · R 重置 · → 单步' }),
      ),
    );
  }

  private renderControls(): void {
    const el = clear(this.els.controls);
    const s = this.slot(this.activeIds()[0] ?? '');
    el.append(
      h('button', { class: 'pa-btn primary', text: this.paused ? '▶ 继续' : '❚❚ 暂停', onclick: () => { this.paused = !this.paused; this.renderControls(); } }),
      h('button', { class: 'pa-btn', text: '▸ 单步', onclick: () => this.stepOnce() }),
      h('button', { class: 'pa-btn', text: '↺ 重置', onclick: () => void this.rebuildScene() }),
      h(
        'label',
        { class: 'pa-field' },
        '刚体数',
        h('input', {
          type: 'range',
          min: '8',
          max: String(this.scenario.maxBodies),
          step: '1',
          value: String(this.bodies),
          disabled: !this.scenario.scalable,
          oninput: (e) => {
            this.bodies = Number((e.target as HTMLInputElement).value);
            (el.querySelector('output') as HTMLOutputElement).textContent = String(this.bodies);
          },
          onchange: () => void this.rebuildScene(),
        }),
        h('output', { text: String(this.bodies) }),
      ),
      h(
        'label',
        { class: 'pa-field' },
        '固定步长',
        h('input', {
          type: 'number',
          min: '1',
          max: '60',
          step: '1',
          value: String(Math.round(1000 * (s?.sim?.fixedDt ?? this.fixedDt))),
          onchange: (e) => {
            const ms = Math.max(1, Math.min(60, Number((e.target as HTMLInputElement).value)));
            this.fixedDt = ms / 1000;
            for (const slot of this.slots.values()) if (slot.sim) slot.sim.fixedDt = this.fixedDt;
            this.renderControls();
          },
        }),
        'ms',
      ),
      h(
        'label',
        { class: 'pa-field' },
        '重力',
        h('input', {
          type: 'number',
          step: '0.5',
          value: String(this.gravity[1]),
          onchange: (e) => {
            this.gravity = [0, Number((e.target as HTMLInputElement).value), 0];
            void this.rebuildScene();
          },
        }),
        'm/s²',
      ),
      h('div', { style: 'margin-left:auto' }, h('span', { class: 'pa-chip', text: this.mode === 'compare' ? `并排：${this.compareIds.length} 个引擎` : `沙盒：${s?.entry.meta.name ?? '—'}` })),
    );
  }

  // ------------------------------------------------------------------ bench

  private renderBenchPane(): void {
    const cfg = document.getElementById('pa-bench-cfg');
    const main = document.getElementById('pa-bench-main');
    if (!cfg || !main) return;

    clear(cfg).append(
      h('div', { class: 'pa-section' }, h('h4', { text: '参与的引擎' }), ...[...this.engines].map((e) =>
        h('label', { class: 'pa-check' },
          h('input', {
            type: 'checkbox',
            checked: this.benchEngineIds.has(e.meta.id),
            onchange: (ev) => {
              const on = (ev.target as HTMLInputElement).checked;
              if (on) this.benchEngineIds.add(e.meta.id); else this.benchEngineIds.delete(e.meta.id);
            },
          }),
          h('i', { class: 'pa-dot', style: `background:${e.meta.accent}` }),
          h('span', { text: e.meta.name }),
        ),
      )),
      h('div', { class: 'pa-section' }, h('h4', { text: '测试场景' }), ...[...this.scenarios].map((s) =>
        h('label', { class: 'pa-check' },
          h('input', {
            type: 'checkbox',
            checked: this.benchScenarioIds.has(s.id),
            onchange: (ev) => {
              const on = (ev.target as HTMLInputElement).checked;
              if (on) this.benchScenarioIds.add(s.id); else this.benchScenarioIds.delete(s.id);
            },
          }),
          h('span', { text: s.name }),
        ),
      )),
      h('div', { class: 'pa-section' },
        h('h4', { text: '参数' }),
        kv('预热步数', String(DEFAULT_BENCH.warmupSteps)),
        kv('测量步数', String(DEFAULT_BENCH.measureSteps)),
        kv('单元时间上限', `${DEFAULT_BENCH.maxCellMs / 1000} s`),
        h('div', { style: 'height:6px' }),
        h('div', { class: 'pa-desc', text: '每个引擎先启动一次，再逐个场景构建→预热→测量。顺序执行，避免多引擎争抢 CPU 让数据失真。' }),
        h('div', { style: 'height:8px' }),
        h('button', {
          class: 'pa-btn primary',
          text: this.benchRunning ? '运行中…' : '▶ 开始跑分',
          disabled: this.busy,
          onclick: () => void this.runBench(),
        }),
        this.benchResults.length
          ? h('button', { class: 'pa-btn', style: 'margin-left:6px', text: '导出 CSV', onclick: () => download('physarena-bench.csv', resultsToCsv(this.benchResults), 'text/csv') })
          : null,
        this.benchResults.length
          ? h('button', { class: 'pa-btn', style: 'margin-left:6px', text: '导出 JSON', onclick: () => download('physarena-bench.json', JSON.stringify(this.benchResults, null, 2), 'application/json') })
          : null,
      ),
      this.benchRunning || this.benchProgress.message
        ? h('div', { class: 'pa-section' },
            h('div', { id: 'pa-bench-msg', class: 'pa-desc', text: this.benchProgress.message || '准备中…' }),
            h('div', { class: 'pa-progress' }, h('i', { style: `width:${Math.round((this.benchProgress.done / Math.max(1, this.benchProgress.total)) * 100)}%` })),
          )
        : null,
    );

    this.renderSelfTestPanel(cfg);
    this.renderBenchResults(main);
  }

  /** Exposes a small API so the lab can be driven from a script or CI. */
  private exposeAutomationHooks(): void {
    (window as unknown as Record<string, unknown>).__physarena = {
      engineIds: () => this.engines.map((e) => e.meta.id),
      scenarioIds: () => this.scenarios.map((s) => s.id),
      selectEngine: (id: string) => this.selectEngine(id),
      selectScenario: (id: string) => {
        const s = this.scenarios.find((x) => x.id === id);
        return s ? this.selectScenario(s) : Promise.resolve();
      },
      setBodies: (n: number) => {
        this.bodies = n;
        return this.rebuildScene();
      },
      runBench: () => this.runBench(),
      /**
       * Scripted sweep: benchmark explicit engine/scenario id pairs and return
       * the rows. Used by the headless driver (scripts/arena-drive.mjs).
       */
      runBenchCells: async (engineIds: string[], scenarioIds: string[], bodies?: number) => {
        const engines = this.engines.filter((e) => engineIds.includes(e.meta.id));
        const scenarios = this.scenarios.filter((s) => scenarioIds.includes(s.id));
        for (const s of this.slots.values()) {
          s.sim?.dispose();
          s.sim = null;
          s.sceneKey = '';
        }
        const results = await runBenchmark({
          engines,
          scenarios,
          bodiesFor: (sc) => bodies ?? sc.defaultBodies,
        });
        this.benchResults = [...this.benchResults, ...results];
        return results;
      },
      runSelfTest: () => this.runSelfTestNow(),
      /** Scripted subset: run only the named probes on the named engines. */
      runProbes: async (engineIds: string[], probeIds: string[]) => {
        const engines = this.engines.filter((e) => engineIds.includes(e.meta.id));
        for (const s of this.slots.values()) {
          s.sim?.dispose();
          s.sim = null;
          s.sceneKey = '';
        }
        return await runSelfTest(engines, undefined, undefined, probeIds);
      },
      getBenchResults: () => this.benchResults,
      getSelfTestResults: () => this.selfTestRows,
      hudText: () => this.els.hud.textContent ?? '',
      /** Diagnostic: live GPU resource counters (geometries / programs / draw calls). */
      resourceInfo: () => this.viewport.stats(),
      /** Diagnostic: per-layer instance matrix decomposition. */
      renderProbe: () => this.viewport.probe(),
      /** Renderer axis, scriptable: list / read current / hot-swap. */
      listRenderers: () => this.renderers.map((r) => r.meta),
      currentRenderer: () => this.rendererId,
      selectRenderer: (id: string) => this.setRenderer(id),
      rendererStats: () => this.viewport.stats(),
      /** The shared metric set, flattened for export. */
      metrics: () => metricsToRows(this.lastMetrics),
      /** Guard log: what failed, where, and how often. */
      guardLog: () => this.guards.log,
      frameWorstMs: () => this.watchdog.worst,
      /** Diagnostic: per active engine, any body pose that is not renderable. */
      simStateSummary: () =>
        this.activeIds().map((id) => {
          const sim = this.slot(id)?.sim;
          const states = sim?.readStates() ?? [];
          let bad = 0;
          let maxAbs = 0;
          let minQuat = Infinity;
          for (const s of states) {
            const v = [...s.position, ...s.rotation];
            if (v.some((x) => !Number.isFinite(x))) bad++;
            maxAbs = Math.max(maxAbs, ...s.position.map(Math.abs));
            minQuat = Math.min(
              minQuat,
              Math.hypot(s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]),
            );
          }
          return {
            id,
            bodies: states.length,
            nonFinite: bad,
            maxAbs: Number(maxAbs.toFixed(1)),
            minQuatNorm: states.length ? Number(minQuat.toFixed(4)) : null,
          };
        }),
    };
  }

  // --------------------------------------------------------------- selftest

  private async runSelfTestNow(): Promise<void> {
    if (this.busy) return;
    this.selfTestRunning = true;
    this.selfTestRows = [];
    this.selfTestMessage = '准备中…';
    for (const s of this.slots.values()) {
      s.sim?.dispose();
      s.sim = null;
      s.sceneKey = '';
    }
    this.renderBenchPane();
    try {
      this.selfTestRows = await runSelfTest(this.engines, (p) => {
        this.selfTestMessage = `${p.engineName} · ${p.probeName} (${p.index}/${p.total})`;
        const node = document.getElementById('pa-selftest-msg');
        if (node) node.textContent = this.selfTestMessage;
        const bar = document.querySelector('#pa-selftest-progress > i') as HTMLElement | null;
        if (bar) bar.style.width = `${Math.round((p.index / p.total) * 100)}%`;
      });
    } catch (e) {
      this.selfTestMessage = `自检失败：${e instanceof Error ? e.message : String(e)}`;
    }
    this.selfTestRunning = false;
    this.selfTestMessage = '完成';
    (window as unknown as Record<string, unknown>).__physarena_report = this.selfTestRows;
    this.renderBenchPane();
    await this.activateForMode(true);
  }

  private renderSelfTestPanel(cfg: HTMLElement): void {
    const box = h('div', { class: 'pa-section' });
    box.append(
      h('h4', { text: '兼容性自检' }),
      h('div', {
        class: 'pa-desc',
        text: `${PROBES.length} 项探针 × ${this.engines.length} 个引擎：形状能否落地、约束拉不拉得住、堆叠会不会塌、CCD 挡不挡得住高速弹丸。`,
      }),
      h('div', { style: 'height:8px' }),
      h('button', {
        class: 'pa-btn',
        text: this.selfTestRunning ? '自检中…' : '▶ 运行自检矩阵',
        disabled: this.busy,
        onclick: () => void this.runSelfTestNow(),
      }),
      this.selfTestRows.length
        ? h('button', {
            class: 'pa-btn', style: 'margin-left:6px', text: '导出 CSV',
            onclick: () => download('physarena-selftest.csv', selfTestToCsv(this.selfTestRows), 'text/csv'),
          })
        : null,
      this.selfTestRunning || this.selfTestRows.length
        ? h('div', { style: 'height:8px' })
        : null,
      this.selfTestRunning
        ? h('div', {}, h('div', { id: 'pa-selftest-msg', class: 'pa-desc', text: this.selfTestMessage }),
            h('div', { class: 'pa-progress', id: 'pa-selftest-progress' }, h('i', { style: 'width:0%' })))
        : null,
    );
    cfg.append(box);
  }

  private renderSelfTestMatrix(main: HTMLElement): void {
    if (!this.selfTestRows.length) return;
    const probes = PROBES.map((p) => ({ id: p.id, name: p.name, group: p.group }));
    const table = h('table', { class: 'pa-table' });
    table.append(h('thead', {}, h('tr', {},
      h('th', { text: '引擎' }),
      h('th', { text: '通过 / 降级 / 失败' }),
      ...probes.map((p) => h('th', { title: p.name, text: p.group })),
    )));
    const tbody = h('tbody');
    for (const r of this.selfTestRows) {
      const cells = probes.map((p) => {
        const res = r.results.find((x) => x.probeId === p.id);
        const sym = !res ? '·' : res.status === 'pass' ? '✔' : res.status === 'degraded' ? '△' : '✘';
        const cls = !res ? '' : res.status === 'pass' ? 'win' : res.status === 'degraded' ? '' : 'slow';
        return h('td', { class: `num ${cls}`, title: res ? `${p.name}：${res.detail}` : '', text: sym });
      });
      tbody.append(h('tr', {},
        h('td', { title: r.bootError ?? '', text: r.engineName }),
        h('td', { class: 'num', text: `${r.passCount} / ${r.degradedCount} / ${r.failCount}` }),
        ...cells,
      ));
    }
    table.append(tbody);
    main.append(
      h('h4', { style: 'margin:22px 0 8px', text: '兼容性矩阵' }),
      h('div', { class: 'pa-toolbar' },
        h('span', { class: 'pa-chip', text: '✔ 通过' }),
        h('span', { class: 'pa-chip', text: '△ 通过但能力被降级 / 该约束不被支持' }),
        h('span', { class: 'pa-chip', text: '✘ 行为不正确' }),
        h('span', { class: 'pa-chip', text: '鼠标悬停看详情' }),
      ),
      h('div', { class: 'pa-scroll-x' }, table),
    );
  }

  private async runBench(): Promise<void> {
    if (this.busy) return;
    const engines = this.engines.filter((e) => this.benchEngineIds.has(e.meta.id));
    const scenarios = this.scenarios.filter((s) => this.benchScenarioIds.has(s.id));
    if (!engines.length || !scenarios.length) {
      alert('请至少选择一个引擎和一个场景');
      return;
    }
    // Benchmarking needs exclusive CPU; drop the live worlds first.
    for (const s of this.slots.values()) {
      s.sim?.dispose();
      s.sim = null;
      s.sceneKey = '';
    }

    this.benchRunning = true;
    this.benchResults = [];
    this.benchProgress = { done: 0, total: engines.length * scenarios.length, message: '准备中…' };
    this.renderBenchPane();

    try {
      this.benchResults = await runBenchmark({
        engines,
        scenarios,
        bodiesFor: (sc) => sc.defaultBodies,
        onProgress: (p) => {
          const idx = p.index + (p.phase === 'done' ? 1 : 0);
          this.benchProgress = {
            done: Math.min(idx, engines.length * scenarios.length),
            total: engines.length * scenarios.length,
            message: `${p.engineName}${p.scenarioName ? ' · ' + p.scenarioName : ''} — ${p.message ?? p.phase}`,
          };
          const box = document.querySelector('#pa-bench-cfg .pa-progress > i') as HTMLElement | null;
          if (box) {
            box.style.width = `${Math.round((this.benchProgress.done / this.benchProgress.total) * 100)}%`;
          }
          // Write to the dedicated element: the previous selector grabbed the
          // static 参数 paragraph (whose text has no em dash) and the guard
          // never passed, so the message stayed "准备中…" for the whole run.
          const txt = document.getElementById('pa-bench-msg');
          if (txt) txt.textContent = this.benchProgress.message;
        },
      });
    } catch (e) {
      this.benchProgress.message = `跑分失败：${e instanceof Error ? e.message : String(e)}`;
    }

    this.benchRunning = false;
    this.renderBenchPane();
    // Live worlds were torn down for the run; bring the sandbox back.
    await this.activateForMode(true);
  }

  private sortKey = 'p50';
  private sortAsc = true;

  private renderBenchResults(main: HTMLElement): void {
    const el = clear(main);
    if (!this.benchResults.length) {
      el.append(h('div', { class: 'pa-empty' }, h('div', { text: '还没有跑分结果' }), h('div', { style: 'font-size:11.5px;margin-top:6px', text: '在左侧选好引擎和场景，点「开始跑分」。每个单元会跑 30 步预热 + 180 步测量（场景全部休眠则提前结束）。' })));
      this.renderSelfTestMatrix(el);
      return;
    }

    const rows = [...this.benchResults].sort((a, b) => {
      const va = this.metric(a);
      const vb = this.metric(b);
      return this.sortAsc ? va - vb : vb - va;
    });

    const head = [
      ['engineName', '引擎'], ['language', '语言'], ['backend', '后端'], ['scenarioName', '场景'],
      ['dynamicBodies', '动态体'], ['bootMs', '启动 ms'], ['buildMs', '构建 ms'],
      ['p50', 'p50 ms'], ['p95', 'p95 ms'], ['maxMs', '峰值 ms'],
      ['mean', '均值 ms'], ['eqFps', '等效 FPS'], ['memoryBytes', '内存'],
      ['awakeFraction', '活跃 %'], ['stateHash', '状态指纹'],
    ] as [string, string][];

    const table = h('table', { class: 'pa-table' });
    const thead = h('tr');
    const sortable = new Set([
      'p50', 'p95', 'maxMs', 'mean', 'eqFps', 'bootMs', 'buildMs', 'dynamicBodies', 'awakeFraction',
    ]);
    for (const [key, label] of head) {
      const canSort = sortable.has(key);
      thead.append(h('th', {
        text: label + (this.sortKey === key ? (this.sortAsc ? ' ▲' : ' ▼') : ''),
        onclick: () => {
          // Columns without a metric (memory / hash / text) used to fall
          // through to p50 - the arrow moved but the order silently didn't.
          if (!canSort) return;
          if (this.sortKey === key) this.sortAsc = !this.sortAsc;
          else { this.sortKey = key; this.sortAsc = true; }
          this.renderBenchResults(main);
        },
      }));
    }
    table.append(h('thead', {}, thead));

    const best = {
      p50: Math.min(...rows.filter((r) => !r.error && r.timing.samples).map((r) => r.timing.p50)),
      eqFps: Math.max(...rows.filter((r) => !r.error && r.timing.samples).map((r) => r.timing.equivalentFps)),
    };

    const tbody = h('tbody');
    for (const r of rows) {
      if (r.error) {
        tbody.append(h('tr', {},
          h('td', { text: r.engineName }),
          h('td', { colspan: '14', class: 'pa-err', text: `启动/运行失败：${r.error}` }),
        ));
        continue;
      }
      const isBest = r.timing.p50 === best.p50 && best.p50 > 0;
      const isSlow = !isBest && r.timing.p50 > best.p50 * 3;
      tbody.append(h('tr', { title: r.notes.join(' · ') || undefined },
        h('td', {}, h('i', { class: 'pa-dot', style: `background:${this.engines.find((e) => e.meta.id === r.engineId)?.meta.accent ?? '#999'};display:inline-block;margin-right:6px` }), r.engineName + (r.notes.length ? ' *' : '')),
        h('td', { text: r.language }),
        h('td', { text: r.backend }),
        h('td', { text: r.scenarioName }),
        h('td', { class: 'num', text: String(r.dynamicBodies) }),
        h('td', { class: 'num', text: fmt(r.bootMs, 0) }),
        h('td', { class: 'num', text: fmt(r.buildMs, 1) }),
        h('td', { class: `num ${isBest ? 'win' : isSlow ? 'slow' : ''}`, text: fmt(r.timing.p50, 3) }),
        h('td', { class: 'num', text: fmt(r.timing.p95, 3) }),
        h('td', { class: 'num', text: fmt(r.timing.max, 3) }),
        h('td', { class: 'num', text: fmt(r.timing.mean, 3) }),
        h('td', { class: 'num', text: fmt(r.timing.equivalentFps, 0) }),
        h('td', { class: 'num', text: fmtBytes(r.memoryBytes) }),
        h('td', {
          class: `num ${r.awakeFraction < 0.5 ? 'slow' : ''}`,
          title: r.awakeFraction < 0.5 ? '多数刚体已休眠，该数字主要反映休眠开销' : '',
          text: `${Math.round(r.awakeFraction * 100)}%`,
        }),
        h('td', { class: 'num', text: r.stateHash }),
      ));
      if (r.notes.length) {
        tbody.append(h('tr', {}, h('td', { colspan: '14', style: 'color:var(--text-faint);font-size:10.5px;padding-top:0' , text: '   ↳ ' + r.notes.join(' · ') })));
      }
    }
    table.append(tbody);
    el.append(h('div', { class: 'pa-toolbar' },
      h('span', { class: 'pa-chip', text: `${rows.length} 条结果` }),
      h('span', { class: 'pa-chip', text: '点表头可排序' }),
      h('span', { class: 'pa-chip', text: '测量窗口 30 步预热 + 180 步测量（3 秒），避免场景休眠后测的其实是休眠开销' }),
      h('span', { class: 'pa-chip', text: '绿色 = 该列最快' }),
    ), h('div', { class: 'pa-scroll-x' }, table));

    this.renderBars(el, rows);
    this.renderSelfTestMatrix(el);
  }

  private metric(r: BenchResult): number {
    switch (this.sortKey) {
      case 'p50': return r.timing.p50;
      case 'p95': return r.timing.p95;
      case 'maxMs': return r.timing.max;
      case 'mean': return r.timing.mean;
      case 'eqFps': return -r.timing.equivalentFps;
      case 'bootMs': return r.bootMs;
      case 'buildMs': return r.buildMs;
      case 'dynamicBodies': return r.dynamicBodies;
      case 'awakeFraction': return -r.awakeFraction;
      default: return r.timing.p50;
    }
  }

  private renderBars(parent: HTMLElement, rows: BenchResult[]): void {
    const ok = rows.filter((r) => r.timing.samples > 0);
    if (!ok.length) return;
    const max = Math.max(...ok.map((r) => r.timing.p50)) || 1;
    const wrap = h('div', { class: 'pa-bars' }, h('h4', { class: 'pa-panel-title', style: 'position:static;border:0;padding:0 0 8px', text: 'p50 单步耗时（越短越好）' }));
    for (const r of [...ok].sort((a, b) => a.timing.p50 - b.timing.p50)) {
      const meta = this.engines.find((e) => e.meta.id === r.engineId)?.meta;
      wrap.append(h('div', { class: 'pa-bar-row' },
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: `${r.engineName} · ${r.scenarioName}` }),
        h('div', { class: 'pa-bar-track' }, h('div', { class: 'pa-bar-fill', style: `width:${Math.max(1, (r.timing.p50 / max) * 100)}%;background:${meta?.accent ?? '#666'}` })),
        h('span', { class: 'pa-bar-val', text: `${r.timing.p50.toFixed(3)}` }),
      ));
    }
    parent.append(wrap);
  }

  // ---------------------------------------------------------------- overlay

  private showOverlay(msg: string, isError = false): void {
    const el = this.els.overlay;
    el.style.display = 'flex';
    clear(el).append(h('div', {},
      isError ? null : h('div', { class: 'pa-spinner' }),
      h('div', { html: msg, style: isError ? 'color:var(--danger)' : '' }),
    ));
  }

  private hideOverlay(): void {
    this.els.overlay.style.display = 'none';
  }
}

function row(k: string, v: string): HTMLElement {
  return h('div', { class: 'pa-hud-row' }, h('span', { text: k }), h('span', { text: v }));
}
function sep(): HTMLElement {
  return h('div', { class: 'pa-hud-sep' });
}
/** Rejects instead of hanging forever when a wasm instantiation stalls. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} 启动超时（${Math.round(ms / 1000)} 秒）；可能是 wasm 实例化卡住`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function kv(k: string, v: string): HTMLElement {
  return h('div', { class: 'pa-kv' }, h('span', { text: k }), h('span', { text: v }));
}

/** One row of the shared metric panel. */
function metricLine(k: string, v: string, variant?: 'warn'): HTMLElement {
  return h(
    'div',
    { class: 'pa-metric' },
    h('span', { class: 'k', text: k }),
    h('span', { class: variant ? `v ${variant}` : 'v', text: v }),
  );
}

function kindLabel(kind: GuardKind): string {
  switch (kind) {
    case 'throw': return '调用异常';
    case 'budget': return '超出预算';
    case 'fault': return '子系统故障';
    case 'quota': return '配额降级';
  }
}

/** Escapes user-controlled text before it goes through the `html:` sink. */
function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}
