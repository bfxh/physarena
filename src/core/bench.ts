import type { EngineEntry } from '../engines/registry';
import type { IPhysicsEngine, Vec3 } from './types';
import { summarize, type TimingSummary } from './stats';
import type { Scenario } from '../scenarios/types';

export interface BenchConfig {
  warmupSteps: number;
  measureSteps: number;
  /** Hard ceiling per (engine, scenario) cell so one slow engine cannot hang the run. */
  maxCellMs: number;
  gravity: Vec3;
}

export const DEFAULT_BENCH: BenchConfig = {
  // Deliberately short. Once a scene has settled the engines put it to
  // sleep and the measured cost collapses to the sleeping fast path, which
  // measured a 300-body pyramid at 1.7 M steps/s on Jolt. A 3 s window
  // keeps the scene active, which is what the numbers are meant to
  // compare; the sleep fraction is reported alongside so a settled run is
  // visible rather than silent.
  warmupSteps: 30,
  measureSteps: 180,
  maxCellMs: 30000,
  gravity: [0, -9.81, 0],
};

export interface BenchResult {
  engineId: string;
  engineName: string;
  language: string;
  backend: string;
  scenarioId: string;
  scenarioName: string;
  dynamicBodies: number;
  buildMs: number;
  bootMs: number;
  timing: TimingSummary;
  warmupSteps: number;
  memoryBytes?: number;
  notes: string[];
  stateHash: string;
  /** Fraction of dynamic bodies still awake at the end; 1 when unreported. */
  awakeFraction: number;
  /**
   * Step index (within the measured window) at which every dynamic body
   * reported sleeping; -1 when the scene stayed active for the whole window.
   * Samples after this point are discarded - they measure the sleep fast path,
   * not the solver.
   */
  sleepOnsetStep: number;
  /** false when the time budget was hit; timing is then partial. */
  completed: boolean;
  error?: string;
}

export interface BenchProgress {
  phase: 'boot' | 'build' | 'warmup' | 'measure' | 'done' | 'error';
  engineId: string;
  engineName: string;
  scenarioId?: string;
  scenarioName?: string;
  index: number;
  total: number;
  message?: string;
}

export interface BenchRunOptions {
  engines: EngineEntry[];
  scenarios: Scenario[];
  bodiesFor: (scenario: Scenario) => number;
  config?: Partial<BenchConfig>;
  onProgress?: (p: BenchProgress) => void;
  /** Called between cells so the UI can paint. */
  yieldToUi?: () => Promise<void>;
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Awake accounting over DYNAMIC bodies only. Including static bodies made the
 * column incomparable: Jolt/Havok report every fixed body as "not active", so
 * their scenes always looked partly asleep (and a wall counted as a sleeper).
 */
function awakeStats(
  states: { sleeping?: boolean }[],
  dynamic: boolean[],
): { reported: number; awake: number } {
  let reported = 0;
  let awake = 0;
  for (let i = 0; i < states.length; i++) {
    if (!dynamic[i]) continue;
    const s = states[i];
    if (s?.sleeping !== undefined) {
      reported++;
      if (!s.sleeping) awake++;
    }
  }
  return { reported, awake };
}

/**
 * Runs every engine over every scenario, sequentially.
 *
 * Sequential execution is deliberate: running engines in parallel would make
 * them contend for the same CPU and the numbers would stop meaning anything.
 */
export async function runBenchmark(opts: BenchRunOptions): Promise<BenchResult[]> {
  const cfg: BenchConfig = { ...DEFAULT_BENCH, ...(opts.config ?? {}) };
  const results: BenchResult[] = [];
  const total = opts.engines.length * opts.scenarios.length;
  let index = 0;

  for (const entry of opts.engines) {
    let engine: IPhysicsEngine | null = null;
    let bootMs = 0;
    let bootError: string | undefined;

    opts.onProgress?.({
      phase: 'boot', engineId: entry.meta.id, engineName: entry.meta.name,
      index, total, message: '加载引擎…',
    });
    await (opts.yieldToUi?.() ?? nextFrame());

    const t0 = performance.now();
    try {
      engine = await entry.boot();
      bootMs = performance.now() - t0;
    } catch (e) {
      bootMs = performance.now() - t0;
      bootError = e instanceof Error ? e.message : String(e);
    }

    for (const scenario of opts.scenarios) {
      const bodies = opts.bodiesFor(scenario);
      const base: BenchResult = {
        engineId: entry.meta.id,
        engineName: entry.meta.name,
        language: entry.meta.language,
        backend: entry.meta.backend,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        dynamicBodies: 0,
        buildMs: 0,
        bootMs,
        timing: summarize([]),
        warmupSteps: cfg.warmupSteps,
        notes: [],
        stateHash: '',
        awakeFraction: 1,
        sleepOnsetStep: -1,
        completed: false,
      };

      if (bootError || !engine) {
        results.push({ ...base, error: bootError ?? '引擎未就绪' });
        index++;
        continue;
      }

      opts.onProgress?.({
        phase: 'build', engineId: entry.meta.id, engineName: entry.meta.name,
        scenarioId: scenario.id, scenarioName: scenario.name, index, total,
        message: `构建 ${scenario.name}…`,
      });
      await (opts.yieldToUi?.() ?? nextFrame());

      try {
        const builder = scenario.build({ bodies, seed: 20260915, gravity: cfg.gravity });
        builder.gravity = cfg.gravity;
        const world = builder.finish();
        const dynamic = world.bodies.map((b) => b.type === 'dynamic');
        base.dynamicBodies = builder.dynamicCount;

        const tb = performance.now();
        engine.build(world);
        base.buildMs = performance.now() - tb;
        engine.readStates();

        opts.onProgress?.({
          phase: 'warmup', engineId: entry.meta.id, engineName: entry.meta.name,
          scenarioId: scenario.id, scenarioName: scenario.name, index, total,
          message: `预热 ${cfg.warmupSteps} 步…`,
        });
        const dt = 1 / 60;
        let budgetStart = performance.now();
        for (let i = 0; i < cfg.warmupSteps; i++) engine.step(dt);
        await (opts.yieldToUi?.() ?? nextFrame());

        opts.onProgress?.({
          phase: 'measure', engineId: entry.meta.id, engineName: entry.meta.name,
          scenarioId: scenario.id, scenarioName: scenario.name, index, total,
          message: `测量 ${cfg.measureSteps} 步…`,
        });

        const samples = new Float64Array(cfg.measureSteps);
        budgetStart = performance.now();
        let done = 0;
        let budgetHit = false;
        // Sleep-aware window: once every dynamic body reports sleeping, the
        // remaining samples would measure the sleep fast path (~1.7 M steps/s
        // on Jolt), not the solver. The window stops there and says so.
        // The probe runs outside the timed region, so extraction cost never
        // enters a sample.
        for (let i = 0; i < cfg.measureSteps; i++) {
          const s0 = performance.now();
          engine.step(dt);
          samples[i] = performance.now() - s0;
          done = i + 1;
          if ((i & 15) === 15) {
            const a = awakeStats(engine.readStates(), dynamic);
            if (a.reported > 0 && a.awake === 0) {
              base.sleepOnsetStep = i + 1;
              break;
            }
          }
          if ((i & 15) === 0 && performance.now() - budgetStart > cfg.maxCellMs) {
            budgetHit = true;
            break;
          }
        }
        // A sleep-truncated window is complete-as-designed; a budget-hit one is not.
        base.completed = done === cfg.measureSteps || base.sleepOnsetStep > 0;
        base.timing = summarize(samples.subarray(0, done));

        const states = engine.readStates();
        let h = 2166136261 >>> 0;
        for (const s of states) {
          for (let k = 0; k < 3; k++) {
            h ^= Math.round(s.position[k] * 100) | 0;
            h = Math.imul(h, 16777619) >>> 0;
          }
        }
        base.stateHash = h.toString(16);
        const finalAwake = awakeStats(states, dynamic);
        if (finalAwake.reported) {
          base.awakeFraction = finalAwake.awake / finalAwake.reported;
          if (base.awakeFraction < 0.5) {
            base.notes.push(
              `${Math.round((1 - base.awakeFraction) * 100)}% 动态刚体已休眠，该数字主要反映休眠开销`,
            );
          }
        }
        if (base.sleepOnsetStep > 0) {
          base.notes.push(`第 ${base.sleepOnsetStep} 步后全部动态刚体休眠，测量窗口止于此`);
        }

        const eng = engine as unknown as { notes?: Set<string>; skippedJoints?: number };
        if (eng.notes) base.notes.push(...eng.notes);
        if (eng.skippedJoints) base.notes.push(`跳过 ${eng.skippedJoints} 个关节`);

        try {
          const st = engine.stats?.();
          if (st?.memoryBytes) base.memoryBytes = st.memoryBytes;
        } catch { /* optional */ }

        if (!base.completed && budgetHit) base.notes.push(`达到 ${cfg.maxCellMs / 1000}s 时间上限，样本不完整`);
      } catch (e) {
        base.error = e instanceof Error ? e.message : String(e);
      }

      results.push(base);
      index++;
    }

    engine?.dispose();
    opts.onProgress?.({
      phase: 'done', engineId: entry.meta.id, engineName: entry.meta.name,
      index, total, message: `${entry.meta.name} 完成`,
    });
    await (opts.yieldToUi?.() ?? nextFrame());
  }

  return results;
}

export function resultsToCsv(results: BenchResult[]): string {
  const head = [
    'engine', 'language', 'backend', 'scenario', 'dynamic_bodies', 'boot_ms', 'build_ms',
    'steps', 'mean_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'stddev_ms',
    'equivalent_fps', 'memory_mb', 'awake_pct', 'sleep_onset_step', 'state_hash', 'completed', 'notes', 'error',
  ];
  const rows = results.map((r) => [
    r.engineName, r.language, r.backend, r.scenarioName, r.dynamicBodies,
    r.bootMs.toFixed(1), r.buildMs.toFixed(2),
    r.timing.samples, r.timing.mean.toFixed(3), r.timing.p50.toFixed(3),
    r.timing.p95.toFixed(3), r.timing.p99.toFixed(3), r.timing.max.toFixed(3),
    r.timing.stddev.toFixed(3), r.timing.equivalentFps.toFixed(1),
    r.memoryBytes ? (r.memoryBytes / 1048576).toFixed(1) : '',
    (r.awakeFraction * 100).toFixed(0),
    r.sleepOnsetStep > 0 ? String(r.sleepOnsetStep) : '',
    r.stateHash, String(r.completed), r.notes.join(' '), r.error ?? '',
  ]);
  return [head, ...rows]
    .map((r) => r.map((c) => (String(c).includes(',') ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(','))
    .join('\n');
}
