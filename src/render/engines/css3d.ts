import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { colorFor } from '../geometry';
import { OrbitCamera, renderable, r2 } from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'css3d',
  name: 'CSS 3D 合成',
  language: 'TypeScript',
  backend: 'Software',
  license: 'MIT',
  homepage: 'https://developer.mozilla.org/docs/Web/CSS/transform',
  accent: '#3f8fbf',
  blurb:
    '一行 WebGL 都不写：每个刚体是一个 div，透视和深度排序由浏览器的合成器负责。它证明「把 3D 交给 GPU」并不必然需要 canvas——也顺带说明为什么复杂几何最终还是要回到 GPU 管线。',
  features: { instancing: false, lighting: false, antialias: true, scissorPanes: false, depthBuffer: false },
  status: 'stable',
  costKb: 0,
};

/** Composited layers are cheap but not free; beyond this the browser thrashes. */
const INSTANCE_BUDGET = 400;
/** World units to CSS pixels. The camera distance is expressed in the same unit. */
const PX_PER_UNIT = 26;

interface Body {
  el: HTMLDivElement;
  size: number;
  isSphere: boolean;
}

export class Css3dLayer implements IRenderLayer {
  private host: HTMLElement;
  private bodies: Body[] = [];
  private matrices: Float32Array = new Float32Array(0);
  private disposed = false;

  constructor(readonly id: string, host: HTMLElement) {
    this.host = host;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();
    this.matrices = new Float32Array(bodies.length * 16);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const size = boundingRadius(b.shape);
      const el = document.createElement('div');
      el.className = 'pa-c3d-obj';
      const isSphere = b.shape.kind === 'sphere';
      const px = size * PX_PER_UNIT;
      el.style.width = `${px}px`;
      el.style.height = `${px}px`;
      el.style.marginLeft = `${-px / 2}px`;
      el.style.marginTop = `${-px / 2}px`;
      const hex = colorFor(b.tag, i);
      const r = (hex >> 16) & 255, g = (hex >> 8) & 255, bl = hex & 255;
      el.style.background = `rgb(${r},${g},${bl})`;
      if (isSphere) el.style.borderRadius = '50%';
      frag.appendChild(el);
      this.bodies.push({ el, size, isSphere });
    }
    this.host.appendChild(frag);
  }

  sync(states: BodyState[]) {
    for (let i = 0; i < this.bodies.length; i++) {
      const s = states[i];
      const b = this.bodies[i];
      const o = i * 16;
      if (!renderable(s)) {
        // Hide rather than park at the origin, where the browser's own depth
        // sorting would leave a bright clump.
        b.el.style.display = 'none';
        this.matrices[o + 15] = 0;
        continue;
      }
      b.el.style.display = '';
      const q = s!.rotation;
      const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      const qx = q[0] / l, qy = q[1] / l, qz = q[2] / l, qw = q[3] / l;
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2;
      const yy = qy * y2, yz = qy * z2, zz = qz * z2;
      const wx = qw * x2, wy = qw * y2, wz = qw * z2;
      const m = this.matrices;
      m[o] = 1 - (yy + zz); m[o + 1] = xy + wz; m[o + 2] = xz - wy; m[o + 3] = 0;
      m[o + 4] = xy - wz; m[o + 5] = 1 - (xx + zz); m[o + 6] = yz + wx; m[o + 7] = 0;
      m[o + 8] = xz + wy; m[o + 9] = yz - wx; m[o + 10] = 1 - (xx + yy); m[o + 11] = 0;
      m[o + 12] = s!.position[0] * PX_PER_UNIT;
      m[o + 13] = -s!.position[1] * PX_PER_UNIT; // CSS y grows downward
      m[o + 14] = s!.position[2] * PX_PER_UNIT;
      m[o + 15] = 1;

      // matrix3d takes a column-major 4x4, same as the GL backends - so the
      // same numbers work, with the Y flip applied above.
      b.el.style.transform = `matrix3d(${m[o]},${m[o + 1]},${-m[o + 2]},${m[o + 3]},` +
        `${m[o + 4]},${m[o + 5]},${-m[o + 6]},${m[o + 7]},` +
        `${-m[o + 8]},${-m[o + 9]},${m[o + 10]},${m[o + 11]},` +
        `${m[o + 12]},${m[o + 13]},${m[o + 14]},${m[o + 15]})`;
    }
  }

  get instanceCount(): number {
    return this.bodies.length;
  }

  probe(): unknown[] {
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    let maxScale = 0, worst = -1;
    const m = this.matrices;
    for (let i = 0; i < this.bodies.length; i++) {
      const o = i * 16;
      const px = m[o + 12] / PX_PER_UNIT;
      const py = -m[o + 13] / PX_PER_UNIT;
      const sc = Math.max(
        Math.hypot(m[o], m[o + 1], m[o + 2]),
        Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
        Math.hypot(m[o + 8], m[o + 9], m[o + 10]),
      );
      if (sc > maxScale) { maxScale = sc; worst = i; }
      if (m[o + 15] === 0) continue;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
    }
    return [{
      count: this.bodies.length,
      visible: true,
      maxScale: r2(maxScale),
      worstInstance: worst,
      x: minX === Infinity ? null : [r2(minX), r2(maxX)],
      y: minY === Infinity ? null : [r2(minY), r2(maxY)],
      geometry: 'CSS transform',
      params: { unit: PX_PER_UNIT, note: 'CSS 后端用包围半径的方片表示刚体' },
      samples: [],
    }];
  }

  clear() {
    for (const b of this.bodies) b.el.remove();
    this.bodies = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }

  get isDisposed(): boolean { return this.disposed; }
}

/** Bounding radius of a shape, in world units. */
function boundingRadius(shape: BodyDesc['shape']): number {
  switch (shape.kind) {
    case 'sphere': return shape.radius * 2;
    case 'box': return Math.max(...shape.halfExtents) * 2;
    case 'capsule': return (shape.halfHeight + shape.radius) * 2;
    case 'cylinder': case 'cone': return Math.max(shape.radius, shape.halfHeight) * 2;
    case 'convex': {
      let r = 0;
      for (let i = 0; i + 2 < shape.points.length; i += 3) {
        r = Math.max(r, Math.hypot(shape.points[i], shape.points[i + 1], shape.points[i + 2]));
      }
      return r * 2;
    }
    case 'trimesh': {
      let r = 0;
      for (let i = 0; i + 2 < shape.vertices.length; i += 3) {
        r = Math.max(r, Math.hypot(shape.vertices[i], shape.vertices[i + 1], shape.vertices[i + 2]));
      }
      return r * 2;
    }
    case 'compound': return Math.max(...shape.children.map((c) => boundingRadius(c.shape))) * 1.4;
  }
}

export class Css3dRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private host!: HTMLElement;
  private sceneEl!: HTMLDivElement;
  private camEl!: HTMLDivElement;
  private layers = new Map<string, Css3dLayer>();
  /** Same framing maths as the GL backends; CSS just consumes its angles. */
  readonly camera = new OrbitCamera();
  private dragging = false;
  private last: [number, number] = [0, 0];
  private disposed = false;
  private lastInstances = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    const scene = document.createElement('div');
    scene.className = 'pa-canvas pa-c3d-scene';
    const cam = document.createElement('div');
    cam.className = 'pa-c3d-cam';
    scene.appendChild(cam);
    host.appendChild(scene);
    this.sceneEl = scene;
    this.camEl = cam;
    this.bindPointer(scene);
    this.resize();
  }

  private bindPointer(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.last = [e.clientX, e.clientY];
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last[0];
      const dy = e.clientY - this.last[1];
      this.last = [e.clientX, e.clientY];
      this.camera.theta -= dx * 0.006;
      this.camera.phi = Math.max(0.08, Math.min(Math.PI * 0.495, this.camera.phi - dy * 0.006));
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.radius = Math.max(1.5, Math.min(4000, this.camera.radius * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });
  }

  get canvas(): HTMLCanvasElement {
    return this.camEl as unknown as HTMLCanvasElement;
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new Css3dLayer(id, this.camEl);
      this.layers.set(id, l);
    }
    void accent;
    return l;
  }

  removeLayer(id: string) {
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined { return this.layers.get(id); }

  setVisibleLayer(id: string | null) {
    for (const [key, layer] of this.layers) {
      (layer as unknown as { bodies: { el: HTMLElement }[] }).bodies.forEach((b) => {
        b.el.style.visibility = key === id ? '' : 'hidden';
      });
    }
  }

  resize() {
    if (this.disposed) return;
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3, radiusScale = 2.6) {
    this.camera.frame(contentRadius, groundSize, target, radiusScale);
    void extent;
  }

  /** Applies the orbit state to the CSS camera wrapper. */
  updateCamera(): void {
    const dist = Math.max(1, this.camera.radius * PX_PER_UNIT);
    this.camEl.style.perspective = `${dist}px`;
    // The scene is rotated instead of the camera: CSS has one fixed eye.
    const phiDeg = (this.camera.phi * 180) / Math.PI - 90;
    const thetaDeg = (this.camera.theta * 180) / Math.PI;
    this.camEl.style.transform =
      `translateZ(${-dist}px) rotateX(${(-phiDeg).toFixed(2)}deg) rotateY(${thetaDeg.toFixed(2)}deg)`;
    const t = this.camera.target;
    this.sceneEl.style.setProperty('--pa-c3d-target-y', `${-t[1] * PX_PER_UNIT}px`);
    this.camEl.style.marginTop = `${t[1] * PX_PER_UNIT}px`;
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    this.updateCamera();
    if (slots.length === 1) {
      this.setVisibleLayer(slots[0]?.id ?? null);
    } else {
      // CSS has no scissor: panes would need separate scene wrappers, so the
      // compare view shows the first slot and says so.
      this.setVisibleLayer(slots[0]?.id ?? null);
    }
    let instances = 0;
    for (const [key, l] of this.layers) {
      if (key === slots[0]?.id) instances += l.instanceCount;
    }
    this.lastInstances = Math.min(instances, INSTANCE_BUDGET);
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    const notes: Record<string, string> = {
      drawCalls: 'CSS 没有绘制调用：合成器把每个 div 当作一个图层来合成',
      triangles: 'CSS 后端不提交三角形，刚体用包围半径的方片表示',
      bufferBytes: 'DOM 元素不是 GPU 缓冲，没有可比的字节数',
      programs: '没有着色器',
      instances: `预算 ${INSTANCE_BUDGET} 个合成图层，超过会明显掉帧`,
      geometries: '没有几何体：形状被简化为方片（球用 border-radius）',
    };
    return {
      triangles: 0,
      instances: this.lastInstances,
      geometries: 0,
      textures: 0,
      programs: 0,
      notes,
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: true, meshes: layer.probe() };
    }
    const eye = this.camera.eye();
    out.__camera = {
      ...this.camera.probe(),
      pos: [r2(eye[0]), r2(eye[1]), r2(eye[2])],
      aspect: r2((this.host.clientWidth || 1) / Math.max(1, this.host.clientHeight || 1)),
      rendererSize: [this.sceneEl.clientWidth, this.sceneEl.clientHeight],
      cssSize: [this.sceneEl.clientWidth, this.sceneEl.clientHeight],
    };
    out.__backend = { kind: 'css3d', renderer: meta.name, note: '分屏对比模式下只渲染第一个面板' };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.sceneEl.remove();
  }
}

export function create(): IRenderEngine {
  return new Css3dRenderEngine();
}
