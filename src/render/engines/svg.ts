import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import { OrbitCamera, renderable, r2 } from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'svg',
  name: 'SVG 多边形',
  language: 'TypeScript',
  backend: 'Software',
  license: 'MIT',
  homepage: 'https://developer.mozilla.org/docs/Web/SVG',
  accent: '#a06ad4',
  blurb:
    '不用 canvas 也不用 GPU：每个三角形是一个 <polygon> 元素。作为「浏览器 DOM 能不能当渲染后端」的下限对照——它慢得很有教育意义，也最能说明为什么会有 canvas 和 WebGL。',
  features: { instancing: false, lighting: true, antialias: true, scissorPanes: false, depthBuffer: false },
  status: 'stable',
  costKb: 0,
};

/** DOM nodes are ~100x more expensive than triangles; the budget is tiny. */
const TRI_BUDGET = 1400;
const INSTANCE_BUDGET = 120;

const SKY: Vec3 = [1, 1, 1];
const GROUND: Vec3 = [0.7216, 0.7529, 0.8];
const L1: Vec3 = [0.4683, 0.7805, 0.3642];
const L2: Vec3 = [-0.5946, 0.4459, -0.7432];
const L1C: Vec3 = [1.5, 1.5, 1.5];
const L2C: Vec3 = [0.481, 0.5004, 0.55];

interface SvgBucket {
  key: string;
  geo: { pos: Float32Array; nrm: Float32Array; triCount: number };
  count: number;
  indices: number[];
  colors: Float32Array;
  matrices: Float32Array;
}

export class SvgLayer implements IRenderLayer {
  private buckets: SvgBucket[] = [];
  private groundIndices = new Set<number>();
  groundExtent = 0;
  private disposed = false;

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

    const perBucket = Math.max(24, Math.floor(TRI_BUDGET / Math.max(1, grouped.size)));
    for (const [key, bucket] of grouped) {
      const n = bucket.indices.length;
      const share = Math.max(9, Math.floor(perBucket / Math.max(1, n)));
      const src = bucket.data.indices.length / 3;
      const stride = Math.max(1, Math.ceil(src / share));
      const kept: number[] = [];
      for (let t = 0; t < src; t += stride) kept.push(t);
      const pos = new Float32Array(kept.length * 9);
      const nrm = new Float32Array(kept.length * 9);
      let w = 0;
      for (const t of kept) {
        for (let v = 0; v < 3; v++) {
          const idx = bucket.data.indices[t * 3 + v];
          for (let c = 0; c < 3; c++) {
            pos[w * 9 + v * 3 + c] = bucket.data.positions[idx * 3 + c];
            nrm[w * 9 + v * 3 + c] = bucket.data.normals[idx * 3 + c];
          }
        }
        w++;
      }
      const rgb = instanceColors(bodies, bucket.indices);
      const colors = new Float32Array(n * 3);
      for (let k = 0; k < n * 3; k++) colors[k] = rgb[k];
      this.buckets.push({
        key,
        geo: { pos, nrm, triCount: kept.length },
        count: n,
        indices: bucket.indices,
        colors,
        matrices: new Float32Array(n * 16),
      });
    }
  }

  sync(states: BodyState[]) {
    for (const b of this.buckets) {
      const m = b.matrices;
      for (let k = 0; k < b.count; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!renderable(s)) {
          m.fill(0, o, o + 16);
          continue;
        }
        const q = s!.rotation;
        const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        const qx = q[0] / l, qy = q[1] / l, qz = q[2] / l, qw = q[3] / l;
        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        const xx = qx * x2, xy = qx * y2, xz = qx * z2;
        const yy = qy * y2, yz = qy * z2, zz = qz * z2;
        const wx = qw * x2, wy = qw * y2, wz = qw * z2;
        m[o] = 1 - (yy + zz); m[o + 1] = xy + wz; m[o + 2] = xz - wy; m[o + 3] = 0;
        m[o + 4] = xy - wz; m[o + 5] = 1 - (xx + zz); m[o + 6] = yz + wx; m[o + 7] = 0;
        m[o + 8] = xz + wy; m[o + 9] = yz - wx; m[o + 10] = 1 - (xx + yy); m[o + 11] = 0;
        m[o + 12] = s!.position[0]; m[o + 13] = s!.position[1]; m[o + 14] = s!.position[2];
        m[o + 15] = 1;
      }
    }
  }

  get drawables(): SvgBucket[] { return this.buckets; }
  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }
  isGround(i: number): boolean { return this.groundIndices.has(i); }

  probe(): unknown[] {
    return this.buckets.map((b) => ({
      count: b.count,
      visible: true,
      maxScale: 1,
      worstInstance: -1,
      x: null,
      y: null,
      geometry: 'SVG polygon',
      params: { signature: b.key, trianglesPerInstance: b.geo.triCount },
      samples: [],
    }));
  }

  clear() {
    this.buckets = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
}

/** Flat Lambert, matching the GPU backends' rig. */
function shade(base: Float32Array, offset: number, n: Vec3, alpha = 1): string {
  const up = n[1] * 0.5 + 0.5;
  const ar = GROUND[0] + (SKY[0] - GROUND[0]) * up;
  const ag = GROUND[1] + (SKY[1] - GROUND[1]) * up;
  const ab = GROUND[2] + (SKY[2] - GROUND[2]) * up;
  const d1 = Math.max(0, n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]);
  const d2 = Math.max(0, n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
  const r = base[offset] * (ar * 1.05 + L1C[0] * d1 + L2C[0] * d2);
  const g = base[offset + 1] * (ag * 1.05 + L1C[1] * d1 + L2C[1] * d2);
  const b = base[offset + 2] * (ab * 1.05 + L1C[2] * d1 + L2C[2] * d2);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return alpha >= 1
    ? `rgb(${c(r)},${c(g)},${c(b)})`
    : `rgba(${c(r)},${c(g)},${c(b)},${alpha})`;
}

export class SvgRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private host!: HTMLElement;
  private svg!: SVGSVGElement;
  private layers = new Map<string, SvgLayer>();
  readonly camera = new OrbitCamera();
  private disposed = false;
  private lastTriangles = 0;
  private lastInstances = 0;
  private lastDropped = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pa-canvas');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.background = '#eef1f6';
    svg.style.display = 'block';
    host.appendChild(svg);
    this.svg = svg;
    this.camera.attach(host as unknown as HTMLCanvasElement);
    this.resize();
  }

  /** Exposed so the host can still treat this like a canvas. */
  get canvas(): HTMLCanvasElement {
    return this.svg as unknown as HTMLCanvasElement;
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new SvgLayer(id);
      this.layers.set(id, l);
    }
    void accent;
    return l;
  }

  removeLayer(id: string) {
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined { return this.layers.get(id); }

  setVisibleLayer(_id: string | null): void { /* pane picks its own layer */ }

  resize() {
    if (this.disposed) return;
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3, radiusScale = 2.6) {
    this.camera.frame(contentRadius, groundSize, target, radiusScale);
    void extent;
  }

  updateCamera(): void { /* nothing damped */ }

  private project(vp: Float32Array, p: Vec3, w: number, h: number): [number, number] | null {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw <= 1e-4) return null;
    return [((x / cw) * 0.5 + 0.5) * w, (1 - ((y / cw) * 0.5 + 0.5)) * h];
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const n = Math.max(1, slots.length);
    const parts: string[] = [];
    parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#eef1f6"/>`);

    let triangles = 0, instances = 0, dropped = 0;
    const panes = n === 1
      ? [{ id: slots[0]?.id ?? null, x: 0, y: 0, w, h }]
      : (() => {
        const { cols, rows } = slotGrid(n);
        const cw = w / cols, ch = h / rows;
        return slots.map((s, i) => ({
          id: s.id,
          x: (i % cols) * cw,
          y: Math.floor(i / cols) * ch,
          w: cw,
          h: ch,
        }));
      })();

    for (const pane of panes) {
      const vp = this.camera.viewProj(pane.w, pane.h);
      const layer = pane.id ? this.layers.get(pane.id) : undefined;
      const half = layer ? Math.max(20, Math.min(layer.groundExtent, this.camera.radius * 4)) : 100;
      this.floorPaths(parts, vp, pane, half);
      if (!layer) continue;

      const eye = this.camera.eye();
      // Painter's algorithm, same as the Canvas2D backend.
      const order: { b: SvgBucket; i: number; depth: number }[] = [];
      for (const b of layer.drawables) {
        for (let i = 0; i < b.count; i++) {
          if (layer.isGround(b.indices[i])) continue;
          if (b.matrices[i * 16 + 15] === 0) continue;
          const ox = b.matrices[i * 16 + 12], oy = b.matrices[i * 16 + 13], oz = b.matrices[i * 16 + 14];
          order.push({ b, i, depth: Math.hypot(ox - eye[0], oy - eye[1], oz - eye[2]) });
        }
      }
      order.sort((a, b) => b.depth - a.depth);
      const budget = Math.min(order.length, INSTANCE_BUDGET);
      dropped += order.length - budget;

      for (const item of order.slice(order.length - budget)) {
        const r = this.drawInstance(parts, item.b, item.i, vp, pane, eye);
        triangles += r;
        instances++;
      }
      if (panes.length > 1) {
        parts.push(`<rect x="${pane.x + 0.5}" y="${pane.y + 0.5}" width="${pane.w - 1}" height="${pane.h - 1}" fill="none" stroke="#d7dde7"/>`);
      }
    }

    this.svg.innerHTML = parts.join('');
    this.lastTriangles = triangles;
    this.lastInstances = instances;
    this.lastDropped = dropped;
  }

  private floorPaths(parts: string[], vp: Float32Array, pane: { x: number; y: number; w: number; h: number }, half: number): void {
    const eye = this.camera.eye();
    // Horizon fill, for the same reason as Canvas2D: the quad's corners are
    // behind the camera, so the plane is bounded by the horizon line instead.
    let dx = this.camera.target[0] - eye[0];
    let dz = this.camera.target[2] - eye[2];
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const far = this.project(vp, [eye[0] + dx * 1e5, 0, eye[2] + dz * 1e5], pane.w, pane.h);
    if (far) {
      const y = Math.max(pane.y, Math.min(pane.y + pane.h, pane.y + far[1]));
      const height = pane.y + pane.h - y;
      if (height > 0) {
        parts.push(`<rect x="${pane.x}" y="${y}" width="${pane.w}" height="${height}" fill="rgba(152,162,177,0.95)"/>`);
      }
    }
    const lines: string[] = [];
    for (let i = -half; i <= half; i += 4) {
      const a = this.project(vp, [-half, 0, i], pane.w, pane.h);
      const b = this.project(vp, [half, 0, i], pane.w, pane.h);
      if (a && b) lines.push(`M${r2(pane.x + a[0])} ${r2(pane.y + a[1])}L${r2(pane.x + b[0])} ${r2(pane.y + b[1])}`);
      const c = this.project(vp, [i, 0, -half], pane.w, pane.h);
      const d = this.project(vp, [i, 0, half], pane.w, pane.h);
      if (c && d) lines.push(`M${r2(pane.x + c[0])} ${r2(pane.y + c[1])}L${r2(pane.x + d[0])} ${r2(pane.y + d[1])}`);
    }
    if (lines.length) {
      parts.push(`<path d="${lines.join('')}" stroke="rgba(196,204,216,0.8)" fill="none"/>`);
    }
  }

  private drawInstance(
    parts: string[],
    b: SvgBucket,
    i: number,
    vp: Float32Array,
    pane: { x: number; y: number; w: number; h: number },
    eye: Vec3,
  ): number {
    const o = i * 16;
    const m = b.matrices;
    const r = [
      m[o], m[o + 1], m[o + 2],
      m[o + 4], m[o + 5], m[o + 6],
      m[o + 8], m[o + 9], m[o + 10],
    ];
    const ox = m[o + 12], oy = m[o + 13], oz = m[o + 14];
    const geo = b.geo;
    const co = i * 3;
    let drawn = 0;

    for (let t = 0; t < geo.triCount; t++) {
      const to = t * 9;
      const nx0 = geo.nrm[to], ny0 = geo.nrm[to + 1], nz0 = geo.nrm[to + 2];
      const nx = r[0] * nx0 + r[3] * ny0 + r[6] * nz0;
      const ny = r[1] * nx0 + r[4] * ny0 + r[7] * nz0;
      const nz = r[2] * nx0 + r[5] * ny0 + r[8] * nz0;

      const cx: number[] = [], cy: number[] = [], cz: number[] = [];
      for (let v = 0; v < 3; v++) {
        const p = to + v * 3;
        const vx = geo.pos[p], vy = geo.pos[p + 1], vz = geo.pos[p + 2];
        cx.push(ox + r[0] * vx + r[3] * vy + r[6] * vz);
        cy.push(oy + r[1] * vx + r[4] * vy + r[7] * vz);
        cz.push(oz + r[2] * vx + r[5] * vy + r[8] * vz);
      }
      const mx = (cx[0] + cx[1] + cx[2]) / 3;
      const my = (cy[0] + cy[1] + cy[2]) / 3;
      const mz = (cz[0] + cz[1] + cz[2]) / 3;
      if (nx * (eye[0] - mx) + ny * (eye[1] - my) + nz * (eye[2] - mz) <= 0) continue;

      const a = this.project(vp, [cx[0], cy[0], cz[0]], pane.w, pane.h);
      const bb = this.project(vp, [cx[1], cy[1], cz[1]], pane.w, pane.h);
      const cc = this.project(vp, [cx[2], cy[2], cz[2]], pane.w, pane.h);
      if (!a || !bb || !cc) continue;

      parts.push(
        `<polygon points="${r2(pane.x + a[0])},${r2(pane.y + a[1])} ${r2(pane.x + bb[0])},${r2(pane.y + bb[1])} ${r2(pane.x + cc[0])},${r2(pane.y + cc[1])}" fill="${shade(b.colors, co, [nx, ny, nz])}"/>`,
      );
      drawn++;
    }
    return drawn;
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let instances = 0, geometries = 0;
    for (const l of this.layers.values()) {
      instances += l.instanceCount;
      geometries += l.drawables.length;
    }
    const notes: Record<string, string> = {
      drawCalls: 'DOM 没有绘制调用：每个三角形是一个 <polygon> 元素，由浏览器合成',
      triangles: `实际生成的 <polygon> 数量（预算 ${TRI_BUDGET}，之后按形状降采样）`,
      instances: `超过 ${INSTANCE_BUDGET} 个实例后丢弃最远的`,
      bufferBytes: 'DOM 元素不是 GPU 缓冲，没有可比的字节数',
      programs: '没有着色器，光照在 JS 里按三角形计算',
    };
    if (this.lastDropped) notes.instances = `实例超过 ${INSTANCE_BUDGET}，丢弃了最远的 ${this.lastDropped} 个`;
    return {
      drawCalls: undefined,
      triangles: this.lastTriangles,
      instances: this.lastInstances,
      geometries,
      textures: 0,
      programs: 0,
      bufferBytes: undefined,
      notes,
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: true, meshes: layer.probe() };
    }
    out.__camera = {
      ...this.camera.probe(),
      aspect: r2((this.host.clientWidth || 1) / Math.max(1, this.host.clientHeight || 1)),
      rendererSize: [this.svg.clientWidth, this.svg.clientHeight],
      cssSize: [this.svg.clientWidth, this.svg.clientHeight],
    };
    out.__backend = { kind: 'svg', renderer: meta.name };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.svg.remove();
  }
}

export function create(): IRenderEngine {
  return new SvgRenderEngine();
}
