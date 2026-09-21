import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'canvas2d',
  name: 'Canvas2D 软件投影',
  language: 'TypeScript',
  backend: 'Canvas2D',
  license: 'MIT',
  homepage: 'https://developer.mozilla.org/docs/Web/API/Canvas_API',
  accent: '#7fb069',
  blurb: '完全不用 GPU：三角形在 CPU 上投影、背面剔除、按深度排序后逐个填充。作为「没有硬件加速时会怎样」的下限对照。',
  features: { instancing: false, lighting: true, antialias: false, scissorPanes: true, depthBuffer: false },
  status: 'stable',
  costKb: 0,
};

/** Triangle budget per pane. Exceeding it lowers quality rather than frame rate. */
const TRI_BUDGET = 9000;
/** Above this many instances the far ones are dropped and reported. */
const INSTANCE_BUDGET = 420;

// ------------------------------------------------------------------ maths
type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const out = new Float32Array(16);
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// ------------------------------------------------------------------ lighting
// Same rig as the GPU backends, so a swap does not change the look.
const SKY: Vec3 = [1, 1, 1];
const GROUND: Vec3 = [0.7216, 0.7529, 0.8];
const L1 = norm([18, 30, 14]);
const L2 = norm([-16, 12, -20]);
const L1C: Vec3 = [1.5, 1.5, 1.5];
const L2C: Vec3 = [0.55 * 0.8745, 0.55 * 0.9098, 0.55];

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Flat-shaded colour for one triangle. Computed per triangle rather than per
 * vertex: at these triangle sizes the difference is invisible and it keeps the
 * inner loop to three multiply-adds per channel.
 */
function shade(base: [number, number, number], n: Vec3, out: string): string {
  const up = n[1] * 0.5 + 0.5;
  const ar = GROUND[0] + (SKY[0] - GROUND[0]) * up;
  const ag = GROUND[1] + (SKY[1] - GROUND[1]) * up;
  const ab = GROUND[2] + (SKY[2] - GROUND[2]) * up;
  const d1 = Math.max(0, n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]);
  const d2 = Math.max(0, n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
  const r = base[0] * (ar * 1.05 + L1C[0] * d1 + L2C[0] * d2);
  const g = base[1] * (ag * 1.05 + L1C[1] * d1 + L2C[1] * d2);
  const b = base[2] * (ab * 1.05 + L1C[2] * d1 + L2C[2] * d2);
  void out;
  return `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
}

function clamp255(v: number): number {
  const n = v * 255;
  return n < 0 ? 0 : n > 255 ? 255 : n | 0;
}

// ------------------------------------------------------------------ geometry
interface SoftGeometry {
  /** Flat triangle list: 3 vertices x 3 floats per triangle. */
  pos: Float32Array;
  nrm: Float32Array;
  triCount: number;
  /** Full-resolution triangle count, so the panel can show the reduction. */
  sourceTris: number;
}

/**
 * De-indexes and decimates a geometry for CPU rasterisation.
 *
 * Dropping every k-th triangle is enough: the shapes here are convex and
 * densely tessellated, so the silhouette stays recognisable while the fill
 * count drops by the factor that actually matters.
 */
function toSoftGeometry(data: GeometryData, maxTris: number): SoftGeometry {
  const source = data.indices.length / 3;
  const stride = Math.max(1, Math.ceil(source / Math.max(8, maxTris)));
  const kept: number[] = [];
  for (let t = 0; t < source; t += stride) kept.push(t);
  const n = kept.length;
  const pos = new Float32Array(n * 9);
  const nrm = new Float32Array(n * 9);
  let w = 0;
  for (const t of kept) {
    for (let v = 0; v < 3; v++) {
      const idx = data.indices[t * 3 + v];
      for (let c = 0; c < 3; c++) {
        pos[w * 9 + v * 3 + c] = data.positions[idx * 3 + c];
        nrm[w * 9 + v * 3 + c] = data.normals[idx * 3 + c];
      }
    }
    w++;
  }
  return { pos, nrm, triCount: n, sourceTris: source };
}

interface SoftBucket {
  key: string;
  geo: SoftGeometry;
  indices: number[];
  /** Instance count, kept as a field for parity with the WebGL bucket. */
  count: number;
  /** Per-instance RGB, 0..1. */
  colors: Float32Array;
  /** Flat 16-float matrix per instance, kept CPU-side so probe() works. */
  matrices: Float32Array;
}

export class Canvas2DLayer implements IRenderLayer {
  private buckets: SoftBucket[] = [];
  private disposed = false;
  private decoded: GeometryData[] = [];

  /**
   * Ground bodies are not drawn as rigid bodies here.
   *
   * A painter's algorithm has no depth buffer, so a 200 m slab sorted as one
   * instance would paint over the grid lines it is supposed to sit under. The
   * engine draws a floor plane instead, sized from `groundExtent`.
   */
  readonly groundIndices = new Set<number>();
  groundExtent = 0;

  constructor(readonly id: string) {}

  setBodies(bodies: BodyDesc[]) {
    this.clear();
    this.groundIndices.clear();
    this.groundExtent = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.tag !== 'ground' && b.tag !== 'ground-far') continue;
      this.groundIndices.add(i);
      if (b.shape.kind === 'box') {
        this.groundExtent = Math.max(this.groundExtent, b.shape.halfExtents[0]);
      }
    }

    const grouped = new Map<string, { data: GeometryData; indices: number[] }>();
    for (let i = 0; i < bodies.length; i++) {
      const key = signature(bodies[i].shape);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = { data: cachedGeometryData(bodies[i].shape, key), indices: [] };
        grouped.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    // Decimation is decided per bucket from the instance count, so a single
    // heavy mesh gets simplified while a few hero bodies stay detailed.
    const perBucketBudget = Math.max(24, Math.floor(TRI_BUDGET / Math.max(1, grouped.size)));
    for (const [key, bucket] of grouped) {
      const n = bucket.indices.length;
      const share = Math.max(12, Math.floor(perBucketBudget / Math.max(1, n)));
      const geo = toSoftGeometry(bucket.data, share);
      const colors = new Float32Array(n * 3);
      const src = instanceColors(bodies, bucket.indices);
      for (let k = 0; k < n * 3; k++) colors[k] = src[k];
      this.buckets.push({
        key,
        geo,
        indices: bucket.indices,
        count: n,
        colors,
        matrices: new Float32Array(n * 16),
      });
    }
    void this.decoded;
  }

  sync(states: BodyState[]) {
    const huge = 1e5;
    for (const b of this.buckets) {
      const n = b.indices.length;
      const m = b.matrices;
      for (let k = 0; k < n; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!s || !renderable(s, huge)) {
          m.fill(0, o, o + 16);
          continue;
        }
        writeInstanceMatrix(m, o, s);
      }
    }
  }

  get drawables(): SoftBucket[] {
    return this.buckets;
  }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  get triCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.geo.triCount * b.count;
    return n;
  }

  probe(): unknown[] {
    const meshes: unknown[] = [];
    for (const b of this.buckets) {
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      let maxScale = 0, worst = -1;
      const samples: unknown[] = [];
      for (let i = 0; i < b.count; i++) {
        const o = i * 16;
        const m = b.matrices;
        const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
        const sc = Math.max(
          Math.hypot(m[o], m[o + 1], m[o + 2]),
          Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
          Math.hypot(m[o + 8], m[o + 9], m[o + 10]),
        );
        if (sc > maxScale) { maxScale = sc; worst = i; }
        if (Number.isFinite(py)) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
        if (Number.isFinite(px)) { if (px < minX) minX = px; if (px > maxX) maxX = px; }
        if (i < 3) samples.push({ i, p: [r2(px), r2(py), r2(pz)], s: [r2(sc), r2(sc), r2(sc)] });
      }
      meshes.push({
        count: b.count,
        visible: true,
        maxScale: r3(maxScale),
        worstInstance: worst,
        x: minX === Infinity ? null : [r2(minX), r2(maxX)],
        y: minY === Infinity ? null : [r2(minY), r2(maxY)],
        geometry: 'SoftTriangles',
        params: { signature: b.key, drawnTris: b.geo.triCount, sourceTris: b.geo.sourceTris },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    this.buckets = [];
    this.decoded = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

function r2(v: number): number { return Number(v.toFixed(2)); }
function r3(v: number): number { return Number(v.toFixed(3)); }

function renderable(s: BodyState, huge: number): boolean {
  const p = s.position, r = s.rotation;
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) &&
    Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && Number.isFinite(r[3]) &&
    Math.abs(p[0]) < huge && Math.abs(p[1]) < huge && Math.abs(p[2]) < huge;
}

function writeInstanceMatrix(out: Float32Array, o: number, s: BodyState) {
  const x = s.rotation[0], y = s.rotation[1], z = s.rotation[2], w = s.rotation[3];
  const len = Math.hypot(x, y, z, w) || 1;
  const qx = x / len, qy = y / len, qz = z / len, qw = w / len;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[o] = 1 - (yy + zz); out[o + 1] = xy + wz; out[o + 2] = xz - wy; out[o + 3] = 0;
  out[o + 4] = xy - wz; out[o + 5] = 1 - (xx + zz); out[o + 6] = yz + wx; out[o + 7] = 0;
  out[o + 8] = xz + wy; out[o + 9] = yz - wx; out[o + 10] = 1 - (xx + yy); out[o + 11] = 0;
  out[o + 12] = s.position[0]; out[o + 13] = s.position[1]; out[o + 14] = s.position[2];
  out[o + 15] = 1;
}

// ------------------------------------------------------------------ engine

interface OrbitState { target: Vec3; radius: number; theta: number; phi: number }
interface DrawInstance {
  bucket: SoftBucket;
  offset: number;
  depth: number;
}

export class Canvas2DRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private ctx!: CanvasRenderingContext2D;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private layers = new Map<string, Canvas2DLayer>();
  private orbit: OrbitState = { target: [0, 3, 0], radius: 30, theta: 0.678, phi: 0.836 };
  private disposed = false;
  private dragging = false;
  private lastPointer: [number, number] = [0, 0];
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastInstances = 0;
  private lastDropped = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布上下文。');
    this.ctx = ctx;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('contextlost', () => this.onContextLost?.(), false);
    this.bindPointer(canvas);
    this.resize();
  }

  get canvas(): HTMLCanvasElement { return this.canvasEl; }

  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastPointer = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer[0];
      const dy = e.clientY - this.lastPointer[1];
      this.lastPointer = [e.clientX, e.clientY];
      this.orbit.theta -= dx * 0.006;
      this.orbit.phi = clamp(this.orbit.phi - dy * 0.006, 0.08, Math.PI * 0.495);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.radius = clamp(this.orbit.radius * (1 + Math.sign(e.deltaY) * 0.12), 1.5, 4000);
    }, { passive: false });
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new Canvas2DLayer(id);
      void accent;
      this.layers.set(id, l);
    }
    return l;
  }

  removeLayer(id: string) {
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined { return this.layers.get(id); }

  setVisibleLayer(_id: string | null): void {
    // Canvas2D draws one pane at a time; the visible id is passed to render().
  }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    // Canvas2D is CPU bound, so super-sampling is never worth it: keep the
    // backing store at CSS resolution whatever the device pixel ratio is.
    this.canvasEl.width = Math.max(1, Math.round(w));
    this.canvasEl.height = Math.max(1, Math.round(h));
    this.canvasEl.style.width = w + 'px';
    this.canvasEl.style.height = h + 'px';
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3,
    radiusScale = 2.6) {
    const wanted = Math.max(9, contentRadius * radiusScale);
    const r = groundSize > 0 ? Math.min(wanted, Math.max(11, groundSize * 0.6)) : wanted;
    const t: Vec3 = target ?? [0, Math.max(1.4, contentRadius * 0.4), 0];
    this.orbit.target = [t[0], t[1], t[2]];
    this.orbit.radius = r * Math.hypot(0.5, 0.72, 0.62);
    this.orbit.phi = Math.acos(0.72 / Math.hypot(0.5, 0.72, 0.62));
    this.orbit.theta = Math.atan2(0.5, 0.62);
    void extent;
  }

  updateCamera(): void { /* orbit state applies directly at draw time */ }

  private eye(): Vec3 {
    const { target, radius, theta, phi } = this.orbit;
    const sp = Math.sin(phi);
    return [
      target[0] + radius * sp * Math.sin(theta),
      target[1] + radius * Math.cos(phi),
      target[2] + radius * sp * Math.cos(theta),
    ];
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const ctx = this.ctx;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    ctx.fillStyle = '#eef1f6';
    ctx.fillRect(0, 0, w, h);
    ctx.lineJoin = 'round';

    let drawCalls = 0, triangles = 0, instances = 0, dropped = 0;
    const n = Math.max(1, slots.length);
    const panes = n === 1
      ? [{ id: slots[0]?.id ?? null, x: 0, y: 0, w, h, cols: 1, rows: 1, index: 0 }]
      : (() => {
        const { cols, rows } = slotGrid(n);
        const cw = Math.floor(w / cols), ch = Math.floor(h / rows);
        return slots.map((s, i) => ({
          id: s.id,
          x: (i % cols) * cw,
          y: Math.floor(i / cols) * ch,
          w: cw,
          h: ch,
          cols,
          rows,
          index: i,
        }));
      })();

    for (const pane of panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pane.x, pane.y, pane.w, pane.h);
      ctx.clip();
      if (panes.length > 1) {
        ctx.strokeStyle = '#d7dde7';
        ctx.lineWidth = 1;
        ctx.strokeRect(pane.x + 0.5, pane.y + 0.5, pane.w - 1, pane.h - 1);
      }
      const vp = multiply(
        perspective((50 * Math.PI) / 180, pane.w / Math.max(1, pane.h), 0.1, 40000),
        lookAt(this.eye(), this.orbit.target, [0, 1, 0]),
      );
      const layer = pane.id ? this.layers.get(pane.id) : undefined;
      this.drawFloor(ctx, vp, pane, layer?.groundExtent ?? 100);
      if (layer) {
        const r = this.drawLayer(ctx, layer, vp, pane);
        drawCalls += r.drawCalls;
        triangles += r.triangles;
        instances += r.instances;
        dropped += r.dropped;
      }
      ctx.restore();
    }

    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
    this.lastInstances = instances;
    this.lastDropped = dropped;
  }

  /** Projects a world point into pane pixels; null when behind the eye. */
  private project(vp: Mat4, p: Vec3, pane: { x: number; y: number; w: number; h: number }):
    [number, number, number] | null {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const z = vp[2] * p[0] + vp[6] * p[1] + vp[10] * p[2] + vp[14];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw <= 1e-4) return null;
    const sx = pane.x + ((x / cw) * 0.5 + 0.5) * pane.w;
    const sy = pane.y + (1 - ((y / cw) * 0.5 + 0.5)) * pane.h;
    return [sx, sy, z / cw];
  }

  /**
   * Draws the floor plane plus the 2 m grid.
   *
   * The plane replaces the ground *body*: with no depth buffer, one 200 m slab
   * sorted as a single painter instance would cover the grid drawn beneath it.
   * Painting a real quad and then the lines gives the same read as the GPU
   * backends, where the grid simply wins the depth fight on a 2 cm offset.
   */
  private drawFloor(
    ctx: CanvasRenderingContext2D,
    vp: Mat4,
    pane: { x: number; y: number; w: number; h: number },
    halfExtent: number,
  ): void {
    const half = Math.max(20, halfExtent);
    const corners: Vec3[] = [
      [-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half],
    ];
    const pts = corners.map((c) => this.project(vp, c, pane));
    if (pts.every((p) => p !== null)) {
      ctx.fillStyle = 'rgba(152,162,177,0.95)';
      ctx.beginPath();
      ctx.moveTo(pts[0]![0], pts[0]![1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(196,204,216,0.85)';
    ctx.beginPath();
    const step = 2;
    for (let i = -half; i <= half; i += step) {
      const a = this.project(vp, [-half, 0, i], pane);
      const b = this.project(vp, [half, 0, i], pane);
      if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      const c = this.project(vp, [i, 0, -half], pane);
      const d = this.project(vp, [i, 0, half], pane);
      if (c && d) { ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); }
    }
    ctx.stroke();

    const axes: [Vec3, string][] = [
      [[3, 0, 0], '#ff3d3d'],
      [[0, 3, 0], '#3dcc3d'],
      [[0, 0, 3], '#3d66ff'],
    ];
    for (const [end, color] of axes) {
      const o = this.project(vp, [0, 0, 0], pane);
      const e = this.project(vp, end, pane);
      if (!o || !e) continue;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(o[0], o[1]);
      ctx.lineTo(e[0], e[1]);
      ctx.stroke();
    }
  }

  private drawLayer(
    ctx: CanvasRenderingContext2D,
    layer: Canvas2DLayer,
    vp: Mat4,
    pane: { x: number; y: number; w: number; h: number },
  ): { drawCalls: number; triangles: number; instances: number; dropped: number } {
    const list: DrawInstance[] = [];
    for (const b of layer.drawables) {
      for (let i = 0; i < b.count; i++) {
        // Ground is drawn as the floor plane, not as a rigid body.
        if (layer.groundIndices.has(b.indices[i])) continue;
        const o = i * 16;
        const m = b.matrices;
        if (m[o + 15] === 0) continue; // collapsed: no state or non-finite pose
        const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
        // Camera-space depth, used only for ordering: the painter's algorithm
        // needs instances far-to-near, not exact per-triangle depth.
        const dz = Math.hypot(px - this.eye()[0], py - this.eye()[1], pz - this.eye()[2]);
        list.push({ bucket: b, offset: o, depth: dz });
      }
    }
    // Far to near. Instances are convex, so intra-instance order is irrelevant.
    list.sort((a, b) => b.depth - a.depth);
    const budget = Math.min(list.length, INSTANCE_BUDGET);
    const dropped = list.length - budget;

    const eye = this.eye();
    let triangles = 0;
    const kept = list.slice(dropped);
    for (const item of kept) {
      triangles += this.drawInstance(ctx, item, vp, pane, eye);
    }
    return {
      drawCalls: kept.length,
      triangles,
      instances: kept.length,
      dropped,
    };
  }

  private drawInstance(
    ctx: CanvasRenderingContext2D,
    item: DrawInstance,
    vp: Mat4,
    pane: { x: number; y: number; w: number; h: number },
    eye: Vec3,
  ): number {
    const { bucket, offset } = item;
    const m = bucket.matrices;
    // The instance matrix carries rotation + translation only (nothing in this
    // lab scales a body), so the upper-left 3x3 rotates normals directly.
    const r = [
      m[offset], m[offset + 1], m[offset + 2],
      m[offset + 4], m[offset + 5], m[offset + 6],
      m[offset + 8], m[offset + 9], m[offset + 10],
    ];

    const ox = m[offset + 12], oy = m[offset + 13], oz = m[offset + 14];
    const geo = bucket.geo;
    const colBase = itemIndex(bucket, offset) * 3;
    const base: [number, number, number] = [
      bucket.colors[colBase], bucket.colors[colBase + 1], bucket.colors[colBase + 2],
    ];

    let drawn = 0;
    for (let t = 0; t < geo.triCount; t++) {
      const to = t * 9;
      // World-space normal (flat shading).
      const nx0 = geo.nrm[to], ny0 = geo.nrm[to + 1], nz0 = geo.nrm[to + 2];
      const nx = r[0] * nx0 + r[3] * ny0 + r[6] * nz0;
      const ny = r[1] * nx0 + r[4] * ny0 + r[7] * nz0;
      const nz = r[2] * nx0 + r[5] * ny0 + r[8] * nz0;

      // Vertices in world space.
      const wx: number[] = [], wy: number[] = [], wz: number[] = [];
      for (let v = 0; v < 3; v++) {
        const p = to + v * 3;
        const vx = geo.pos[p], vy = geo.pos[p + 1], vz = geo.pos[p + 2];
        wx.push(ox + r[0] * vx + r[3] * vy + r[6] * vz);
        wy.push(oy + r[1] * vx + r[4] * vy + r[7] * vz);
        wz.push(oz + r[2] * vx + r[5] * vy + r[8] * vz);
      }
      // Back-face cull in world space: independent of winding conventions.
      const cx = (wx[0] + wx[1] + wx[2]) / 3;
      const cy = (wy[0] + wy[1] + wy[2]) / 3;
      const cz = (wz[0] + wz[1] + wz[2]) / 3;
      if (nx * (eye[0] - cx) + ny * (eye[1] - cy) + nz * (eye[2] - cz) <= 0) continue;

      const a = this.project(vp, [wx[0], wy[0], wz[0]], pane);
      const b = this.project(vp, [wx[1], wy[1], wz[1]], pane);
      const c = this.project(vp, [wx[2], wy[2], wz[2]], pane);
      if (!a || !b || !c) continue;

      ctx.fillStyle = shade(base, [nx, ny, nz], '');
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.closePath();
      ctx.fill();
      drawn++;
    }
    return drawn;
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let bufferBytes = 0;
    let geometries = 0;
    for (const l of this.layers.values()) {
      for (const b of l.drawables) {
        bufferBytes += b.matrices.byteLength + b.geo.pos.byteLength + b.geo.nrm.byteLength;
        geometries++;
      }
    }
    const notes: Record<string, string> = {
      drawCalls: '每个实例一次 fill()——Canvas2D 没有批处理概念，这就是它的短板',
      bufferBytes: 'CPU 侧顶点与实例矩阵数组；软件光栅没有 GPU 缓冲',
      programs: '没有着色器程序，光照在 CPU 上按三角形计算',
      triangles: '实际填充的三角形：已按预算降采样，且背面已剔除，因此约为 GPU 后端提交数的一半',
      geometries: '按形状签名分桶后的降采样几何数量',
    };
    if (this.lastDropped) {
      notes.instances = `实例数超过 ${INSTANCE_BUDGET}，丢弃了最远的 ${this.lastDropped} 个`;
    }
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      instances: this.lastInstances,
      geometries,
      textures: 0,
      programs: 0,
      bufferBytes,
      notes,
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: true, meshes: layer.probe() };
    }
    const eye = this.eye();
    out.__camera = {
      pos: [r2(eye[0]), r2(eye[1]), r2(eye[2])],
      target: [r2(this.orbit.target[0]), r2(this.orbit.target[1]), r2(this.orbit.target[2])],
      fov: 50, near: 0.1, far: 40000,
      aspect: r3(this.canvasEl.width / Math.max(1, this.canvasEl.height)),
      radius: r2(this.orbit.radius),
      theta: r3(this.orbit.theta),
      phi: r3(this.orbit.phi),
      rendererSize: [this.canvasEl.width, this.canvasEl.height],
      cssSize: [this.canvasEl.clientWidth, this.canvasEl.clientHeight],
    };
    out.__backend = { kind: 'canvas2d', renderer: meta.name, mode: 'software-raster' };
    out.__budget = { triBudget: TRI_BUDGET, instanceBudget: INSTANCE_BUDGET, dropped: this.lastDropped };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.canvasEl.remove();
  }
}

/** Recovers the instance index from a flat matrix offset. */
function itemIndex(bucket: SoftBucket, offset: number): number {
  return offset / 16;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function create(): IRenderEngine {
  return new Canvas2DRenderEngine();
}
