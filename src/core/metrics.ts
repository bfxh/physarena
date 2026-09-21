import type { EngineMeta, EngineStats } from './types';
import type { Simulation } from './simulation';
import { summarize } from './stats';
import type { RenderEngineMeta, RenderStats } from '../render/types';
import { geometryCacheBytes, geometryCacheSize } from '../render/geometry';

/**
 * One metric vocabulary shared by every mode.
 *
 * The lab used to show different numbers in sandbox / bench / compare, which
 * made two runs impossible to line up. Everything now goes through
 * `collectMetrics`, so all three modes print the same rows in the same order,
 * with the same caveats attached.
 *
 * A row with `missing` set is printed as "—" plus the reason. Never as 0.
 */
export interface MetricRow {
  key: string;
  label: string;
  /** Pre-formatted for display. */
  value: string;
  /** Raw number, for sorting / export. Absent when the engine cannot measure it. */
  raw?: number;
  unit?: string;
  /** Measurement caveat, shown as a tooltip. */
  hint?: string;
  /** Why there is no number, when there is none. */
  missing?: string;
}

export interface MetricSection {
  key: string;
  title: string;
  rows: MetricRow[];
}

export interface MetricSources {
  sim: Simulation | null;
  engineMeta?: EngineMeta;
  engineStats?: EngineStats;
  rendererMeta?: RenderEngineMeta;
  renderStats?: RenderStats;
  /** Frames per second of the render loop itself. */
  renderFps: number;
  /** Fixed step used by the accumulator. */
  fixedDt: number;
  /** Wall-clock ms spent in the last renderer swap, 0 when never swapped. */
  rendererSwapMs?: number;
  /** Identity + build cost of the world currently under test. */
  scenarioName?: string;
  buildMs?: number;
  stateHash?: string;
  /** Engine boot latency measured by the host, itself a comparison metric. */
  engineBootMs?: number;
}

// --------------------------------------------------------------- formatting

export function fmtBytes(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

export function fmtMs(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v < 1) return v.toFixed(3);
  if (v < 100) return v.toFixed(2);
  if (v < 1000) return v.toFixed(1);
  return v.toFixed(0);
}

export function fmtInt(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('zh-CN');
}

export function fmtPct(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

// -------------------------------------------------------------- collection

const MISSING_MEMORY = '该引擎未上报自己的堆占用，且不使用页面 JS 堆数字冒充';

function row(
  key: string,
  label: string,
  value: string,
  extra: Partial<MetricRow> = {},
): MetricRow {
  return { key, label, value, ...extra };
}

/**
 * Builds the full metric set for the current frame.
 *
 * Pure: it reads state, never mutates it, so it is safe to call from the HUD,
 * the bench report and the automation hooks alike.
 */
export function collectMetrics(src: MetricSources): MetricSection[] {
  const sim = src.sim;
  const es = src.engineStats;
  const rs = src.renderStats;
  const timing = sim ? summarize(sim.window.values()) : null;

  const sections: MetricSection[] = [];

  // --------------------------------------------------------- identity
  sections.push({
    key: 'identity',
    title: '场景与引擎',
    rows: [
      row('id-scenario', '场景', src.scenarioName ?? '—', {}),
      row('id-engine', '物理引擎', src.engineMeta?.name ?? '—', {
        hint: src.engineMeta
          ? `${src.engineMeta.language} · ${src.engineMeta.backend} · ${src.engineMeta.solver}`
          : undefined,
      }),
      row('id-engine-boot', '引擎启动耗时', src.engineBootMs ? fmtMs(src.engineBootMs) + ' ms' : '—', {
        raw: src.engineBootMs,
        hint: '动态导入 + wasm 实例化 + 建世界；只有首次选中时才会付这笔钱',
      }),
      row('id-build', '世界构建耗时', src.buildMs !== undefined ? fmtMs(src.buildMs) + ' ms' : '—', {
        raw: src.buildMs,
        hint: '把 WorldDesc 灌进求解器所需的时间，不含推进',
      }),
      row('id-hash', '状态指纹', src.stateHash ?? '—', {
        hint: '位姿的确定性摘要：同一场景两个引擎跑出同样的指纹，说明轨迹一致',
      }),
    ],
  });

  // ------------------------------------------------------------- time
  const timeRows: MetricRow[] = [
    row('step-p50', '物理步 p50', fmtMs(timing?.p50), {
      raw: timing?.p50,
      unit: 'ms',
      hint: '最近 240 步的中位耗时，单位毫秒',
    }),
    row('step-p95', '物理步 p95', fmtMs(timing?.p95), {
      raw: timing?.p95,
      unit: 'ms',
      hint: '95% 的步都快于这个值；它比均值更能反映卡顿',
    }),
    row('step-p99', '物理步 p99', fmtMs(timing?.p99), { raw: timing?.p99, unit: 'ms' }),
    row('step-peak', '物理步峰值', fmtMs(timing?.max), { raw: timing?.max, unit: 'ms' }),
    row('step-jitter', '抖动（标准差）', fmtMs(timing?.stddev), {
      raw: timing?.stddev,
      unit: 'ms',
      hint: '同一场景下抖动小，说明帧时间稳定',
    }),
    row('phys-fps', '等效物理 FPS', fmtInt(timing?.equivalentFps), {
      raw: timing?.equivalentFps,
      hint: '1 / 平均步耗时，即这个求解器在这套配置下能撑住的物理频率',
    }),
    row('render-fps', '渲染帧率', fmtInt(src.renderFps), { raw: src.renderFps }),
    row('fixed-dt', '固定步长', `${(src.fixedDt * 1000).toFixed(1)} ms`, {
      raw: src.fixedDt * 1000,
      hint: '所有引擎每帧收到完全相同的 dt 序列，否则计时与轨迹都不可比',
    }),
    row('steps', '已推进步数', fmtInt(sim?.steps), { raw: sim?.steps }),
    row('sim-time', '仿真时间', `${(sim?.simTime ?? 0).toFixed(2)} s`, {
      raw: sim?.simTime,
      hint: '物理世界推进的总时间，与墙钟时间无关（暂停时不增长）',
    }),
  ];
  sections.push({ key: 'time', title: '时间', rows: timeRows });

  // --------------------------------------------------------- workload
  const states = sim?.readStates() ?? [];
  const sleeping = states.filter((s) => s.sleeping === true).length;
  const reported = states.filter((s) => s.sleeping !== undefined).length;
  const workloadRows: MetricRow[] = [
    row('bodies-dynamic', '动态刚体', fmtInt(sim?.dynamicCount), { raw: sim?.dynamicCount }),
    row('bodies-total', '刚体总数', fmtInt(src.sim?.world?.bodies.length), {
      raw: src.sim?.world?.bodies.length,
    }),
    row('joints', '关节', fmtInt(src.sim?.world?.joints.length), {
      raw: src.sim?.world?.joints.length,
    }),
    row('engine-bodies', '引擎原生刚体', fmtInt(es?.bodyCount), {
      raw: es?.bodyCount,
      missing: es?.bodyCount === undefined ? '该引擎未上报原生刚体数' : undefined,
    }),
    row('engine-shapes', '原生碰撞形状', fmtInt(es?.shapeCount), {
      raw: es?.shapeCount,
      missing: es?.shapeCount === undefined ? '该引擎未上报形状数量' : undefined,
    }),
    row('contacts', '每步接触对', fmtInt(es?.contactCount), {
      raw: es?.contactCount,
      missing: es?.contactCount === undefined ? '该引擎未暴露接触对计数' : undefined,
      hint: '接触对数量是「这个场景有多难」最直接的指标，比刚体数更能解释耗时差异',
    }),
    row('engine-joints', '引擎约束数', fmtInt(es?.jointCount), {
      raw: es?.jointCount,
      missing: es?.jointCount === undefined ? '该引擎未上报约束数量' : undefined,
    }),
    row(
      'sleeping',
      '已休眠刚体',
      reported === 0
        ? '—'
        : `${fmtInt(sleeping)} / ${fmtInt(states.length)}（${fmtPct(sleeping / Math.max(1, states.length), 0)}）`,
      {
        raw: reported === 0 ? undefined : sleeping,
        missing: reported === 0 ? '该绑定未暴露激活状态，无法判断休眠' : undefined,
        hint: '跑分窗口刻意避开休眠期——休眠后的样本会让排名失真',
      },
    ),
  ];
  if (es?.solverIterations) {
    for (const [k, v] of Object.entries(es.solverIterations)) {
      workloadRows.push(row(`iter-${k}`, `求解迭代 · ${k}`, fmtInt(v), {
        raw: v,
        hint: '迭代次数越多，求解越准也越慢',
      }));
    }
  }
  sections.push({ key: 'workload', title: '工作量', rows: workloadRows });

  // ----------------------------------------------------------- memory
  const jsHeap = readJsHeap();
  const memoryRows: MetricRow[] = [
    row('engine-memory', '引擎堆占用', es?.memoryBytes === undefined ? '—' : fmtBytes(es.memoryBytes), {
      raw: es?.memoryBytes,
      hint: es?.notes?.memoryBytes ?? '引擎自报的堆/内存使用量',
      missing: es?.memoryBytes === undefined ? (es?.notes?.memoryBytes ?? MISSING_MEMORY) : undefined,
    }),
    row('render-bytes', '渲染缓冲', fmtBytes(rs?.bufferBytes), {
      raw: rs?.bufferBytes,
      hint: rs?.notes?.bufferBytes ?? '顶点 / 索引 / 实例矩阵 / 实例颜色',
      missing: rs?.bufferBytes === undefined ? '该后端未上报缓冲占用' : undefined,
    }),
    row('geom-cache', '共享几何缓存', `${fmtBytes(geometryCacheBytes())} · ${geometryCacheSize()} 项`, {
      raw: geometryCacheBytes(),
      hint: '所有渲染后端共用的引擎无关几何数据（上限 384 项）',
    }),
    row('js-heap', '页面 JS 堆', jsHeap === null ? '—' : fmtBytes(jsHeap), {
      raw: jsHeap ?? undefined,
      missing: jsHeap === null ? '此浏览器未暴露 performance.memory（非 Chromium 内核）' : undefined,
      hint: '整个页面的数字，包含 UI 与三个渲染器；不是求解器的内存',
    }),
  ];
  sections.push({ key: 'memory', title: '内存', rows: memoryRows });

  // ----------------------------------------------------------- render
  const renderRows: MetricRow[] = [
    row('r-backend', '渲染后端', src.rendererMeta?.backend ?? '—', {}),
    row('r-name', '渲染器', src.rendererMeta?.name ?? '—', {}),
    row('r-drawcalls', '绘制调用', fmtInt(rs?.drawCalls), {
      raw: rs?.drawCalls,
      hint: rs?.notes?.drawCalls ?? '最近一帧提交的绘制调用数，越少越好',
    }),
    row('r-triangles', '三角形', fmtInt(rs?.triangles), {
      raw: rs?.triangles,
      hint: rs?.notes?.triangles ?? '最近一帧提交/填充的三角形数',
    }),
    row('r-instances', '实例数', fmtInt(rs?.instances), {
      raw: rs?.instances,
      hint: rs?.notes?.instances,
    }),
    row('r-geometries', '几何体', fmtInt(rs?.geometries), { raw: rs?.geometries }),
    row('r-textures', '纹理', fmtInt(rs?.textures), { raw: rs?.textures }),
    row('r-programs', '着色器程序', fmtInt(rs?.programs), {
      raw: rs?.programs,
      hint: rs?.notes?.programs,
    }),
    row('r-cost', '渲染器体积', sourceCostLabel(src.rendererMeta), {}),
    row('r-swap', '切换耗时', src.rendererSwapMs ? fmtMs(src.rendererSwapMs) + ' ms' : '—', {
      raw: src.rendererSwapMs || undefined,
      hint: '最近一次热切换渲染器的墙钟耗时',
    }),
  ];
  sections.push({ key: 'render', title: '渲染管线', rows: renderRows });

  // ------------------------------------------------------------- host
  const canvas = document.querySelector('canvas');
  const hostRows: MetricRow[] = [
    row('h-viewport', '视口（CSS 像素）', canvas ? `${canvas.clientWidth} × ${canvas.clientHeight}` : '—'),
    row('h-backing', '绘图缓冲', canvas ? `${canvas.width} × ${canvas.height}` : '—', {
      hint: '硬件后端会按像素比放大缓冲；软件光栅保持 1:1',
    }),
    row('h-dpr', '设备像素比', String(window.devicePixelRatio || 1), {
      raw: window.devicePixelRatio || 1,
    }),
    row('h-hardware', '硬件加速', probeWebgl2(), {}),
  ];
  sections.push({ key: 'host', title: '宿主', rows: hostRows });

  return sections;
}

function sourceCostLabel(meta?: RenderEngineMeta): string {
  if (!meta) return '—';
  return meta.costKb > 0 ? `+${meta.costKb} kB（gzip）` : '零额外依赖';
}

function readJsHeap(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const v = mem?.usedJSHeapSize;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

let webgl2Probe: string | null = null;
function probeWebgl2(): string {
  if (webgl2Probe !== null) return webgl2Probe;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) {
      webgl2Probe = '不可用（无 WebGL2）';
      return webgl2Probe;
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    webgl2Probe = name.length > 42 ? name.slice(0, 40) + '…' : name;
  } catch {
    webgl2Probe = '探测失败';
  }
  return webgl2Probe;
}

/** Flattens the sections for CSV / JSON export. */
export function metricsToRows(sections: MetricSection[]): { section: string; key: string; label: string; value: string; raw?: number }[] {
  const out: { section: string; key: string; label: string; value: string; raw?: number }[] = [];
  for (const s of sections) {
    for (const r of s.rows) {
      out.push({ section: s.title, key: r.key, label: r.label, value: r.value, raw: r.raw });
    }
  }
  return out;
}
