import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine as BabylonEngine,
  HemisphericLight, Mesh, Scene, StandardMaterial, Vector3, VertexData, Viewport,
} from '@babylonjs/core';
import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { cachedGeometryData, instanceColors, signature, type GeometryData } from '../geometry';
import { slotGrid } from '../layout';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'babylon',
  name: 'Babylon.js',
  language: 'TypeScript',
  backend: 'WebGL2',
  license: 'Apache-2.0',
  homepage: 'https://www.babylonjs.com',
  accent: '#c9438a',
  blurb: '功能最全的 WebGL 框架：自带相机控制、材质系统与多视口。和 three.js 同场对照，能看出「框架抽象」与「最小封装」各自的代价。',
  features: { instancing: true, lighting: true, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  // Measured from the built chunk (gzip). Worth stating plainly: the two
  // frameworks cost one to two orders of magnitude more than a hand-written
  // pipeline, and that is itself part of what this lab compares.
  costKb: 1343,
};

interface BbBucket {
  key: string;
  mesh: Mesh;
  count: number;
  indices: number[];
  /** Flat 16-float matrices, CPU-side so probe() works like the other backends. */
  matrices: Float32Array;
  /** RGBA per instance, matching the thin-instance colour buffer. */
  colors: Float32Array;
  material: StandardMaterial;
}

export class BabylonLayer implements IRenderLayer {
  private buckets: BbBucket[] = [];
  private scene: Scene;

  constructor(readonly id: string, scene: Scene) {
    this.scene = scene;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();
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

    for (const [key, bucket] of grouped) {
      const data = bucket.data;
      const n = bucket.indices.length;
      const mesh = new Mesh(`pa-${this.id}-${key}`, this.scene);

      const vd = new VertexData();
      vd.positions = Array.from(data.positions);
      vd.normals = Array.from(data.normals);
      vd.indices = Array.from(data.indices);
      vd.applyToMesh(mesh);

      const mat = new StandardMaterial(`pa-mat-${this.id}-${key}`, this.scene);
      // Match the other backends: pure Lambert, no specular, no self-emission.
      mat.specularColor = Color3.Black();
      mat.emissiveColor = Color3.Black();
      mat.ambientColor = new Color3(1, 1, 1);
      mat.diffuseColor = new Color3(1, 1, 1);
      mat.backFaceCulling = true;
      mesh.material = mat;
      mesh.isPickable = false;

      // Thin instances: one buffer for transforms, one for per-instance colour.
      // This is Babylon's equivalent of InstancedMesh / instanced attributes.
      const matrices = new Float32Array(n * 16);
      const rgba = new Float32Array(n * 4);
      const rgb = instanceColors(bodies, bucket.indices);
      for (let k = 0; k < n; k++) {
        rgba[k * 4] = rgb[k * 3];
        rgba[k * 4 + 1] = rgb[k * 3 + 1];
        rgba[k * 4 + 2] = rgb[k * 3 + 2];
        rgba[k * 4 + 3] = 1;
      }
      mesh.thinInstanceSetBuffer('matrix', matrices, 16);
      mesh.thinInstanceSetBuffer('color', rgba, 4);
      mesh.alwaysSelectAsActiveMesh = true;

      this.buckets.push({ key, mesh, count: n, indices: bucket.indices, matrices, colors: rgba, material: mat });
    }
  }

  sync(states: BodyState[]) {
    const huge = 1e5;
    for (const b of this.buckets) {
      const m = b.matrices;
      for (let k = 0; k < b.count; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!s || !renderable(s, huge)) {
          m.fill(0, o, o + 16);
          continue;
        }
        writeInstanceMatrix(m, o, s);
      }
      // The color buffer is static per scene; only the matrices move.
      b.mesh.thinInstanceBufferUpdated('matrix');
    }
  }

  setVisible(on: boolean): void {
    for (const b of this.buckets) b.mesh.setEnabled(on);
  }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  /** One draw call per shape signature, same batching as the other backends. */
  get bucketCount(): number {
    return this.buckets.length;
  }

  get triCount(): number {
    let n = 0;
    for (const b of this.buckets) n += (b.mesh.getTotalIndices() / 3) * b.count;
    return Math.round(n);
  }

  /**
   * GPU bytes held by this layer.
   *
   * Counted from vertex/index totals rather than Babylon's internal buffers so
   * the figure is in the same units as the hand-written WebGL2 backend's.
   */
  get gpuBytes(): number {
    let bytes = 0;
    for (const b of this.buckets) {
      const verts = b.mesh.getTotalVertices();
      const idx = b.mesh.getTotalIndices();
      bytes += verts * 3 * 4; // position
      bytes += verts * 3 * 4; // normal
      bytes += idx * 4;       // index
      bytes += b.count * 64;  // instance matrices
      bytes += b.count * 16;  // instance colours
    }
    return bytes;
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
        visible: b.mesh.isEnabled(),
        maxScale: r3(maxScale),
        worstInstance: worst,
        x: minX === Infinity ? null : [r2(minX), r2(maxX)],
        y: minY === Infinity ? null : [r2(minY), r2(maxY)],
        geometry: 'ThinInstances',
        params: { signature: b.key, thinCount: b.mesh.thinInstanceCount },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    for (const b of this.buckets) {
      b.mesh.dispose(false, false);
      b.material.dispose();
    }
    this.buckets = [];
  }

  dispose() {
    this.clear();
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

/**
 * Quaternion+translation to a 4x4 matrix.
 *
 * Babylon stores matrices row-major, unlike the GL backends, so the same TRS is
 * laid out transposed relative to `webgl2.ts`.
 */
function writeInstanceMatrix(out: Float32Array, o: number, s: BodyState) {
  const x = s.rotation[0], y = s.rotation[1], z = s.rotation[2], w = s.rotation[3];
  const l = Math.hypot(x, y, z, w) || 1;
  const qx = x / l, qy = y / l, qz = z / l, qw = w / l;
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

export class BabylonRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private engine!: BabylonEngine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private layers = new Map<string, BabylonLayer>();
  private disposed = false;
  private orbit = { target: new Vector3(0, 3, 0), radius: 30, alpha: Math.atan2(0.62, 0.5), beta: 0.836 };
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastInstances = 0;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    const engine = new BabylonEngine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!engine.getRenderingCanvas()) {
      throw new Error('Babylon.js 无法创建 WebGL 上下文。');
    }
    this.engine = engine;
    this.canvasEl = canvas;
    host.appendChild(canvas);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.933, 0.945, 0.965, 1);
    // Panes are drawn one after another into the same canvas, so the clear has
    // to happen once up front instead of per render call.
    scene.autoClear = false;
    scene.autoClearDepthAndStencil = false;
    this.scene = scene;

    this.camera = new ArcRotateCamera(
      'pa-cam',
      this.orbit.alpha,
      this.orbit.beta,
      this.orbit.radius,
      this.orbit.target.clone(),
      scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.lowerBetaLimit = 0.08;
    this.camera.upperBetaLimit = Math.PI * 0.495;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 40000;
    this.camera.fov = (50 * Math.PI) / 180;
    this.camera.wheelDeltaPercentage = 0.02;
    // Deliberately NO engine.runRenderLoop() here. Babylon's loop runs its own
    // beginFrame/endFrame every rAF tick, and endFrame swaps the back buffer -
    // so an empty render loop presents an empty frame *after* the frame this
    // lab drew, leaving a blank canvas that still reports correct draw counts.
    // The host owns the loop; render() below does the frame.

    // Same rig as the other backends.
    const hemi = new HemisphericLight('pa-hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.05;
    hemi.diffuse = new Color3(1, 1, 1);
    hemi.groundColor = new Color3(0.7216, 0.7529, 0.8);
    const key = new DirectionalLight('pa-key', new Vector3(-18, -30, -14).normalize(), scene);
    key.intensity = 1.5;
    key.diffuse = new Color3(1, 1, 1);
    const fill = new DirectionalLight('pa-fill', new Vector3(16, -12, 20).normalize(), scene);
    fill.intensity = 0.55;
    fill.diffuse = new Color3(0.8745, 0.9098, 1);

    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new BabylonLayer(id, this.scene);
      void accent;
      this.layers.set(id, l);
    }
    return l;
  }

  removeLayer(id: string) {
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined {
    return this.layers.get(id);
  }

  setVisibleLayer(id: string | null) {
    for (const [key, layer] of this.layers) layer.setVisible(key === id);
  }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    // Cap the pixel ratio exactly like the other backends, so the renderer
    // comparison is never accidentally a resolution comparison.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
    this.engine.resize();
    this.onResize();
    void w; void h;
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3,
    radiusScale = 2.6) {
    const wanted = Math.max(9, contentRadius * radiusScale);
    const r = groundSize > 0 ? Math.min(wanted, Math.max(11, groundSize * 0.6)) : wanted;
    const t: Vec3 = target ?? [0, Math.max(1.4, contentRadius * 0.4), 0];
    this.orbit.target = new Vector3(t[0], t[1], t[2]);
    this.orbit.radius = r * Math.hypot(0.5, 0.72, 0.62);
    this.orbit.beta = Math.acos(0.72 / Math.hypot(0.5, 0.72, 0.62));
    // Babylon measures alpha from +X (`x = r*cos(a)*sin(b)`), three.js from +Z.
    // Using atan2(0.5, 0.62) here would mirror the camera across the diagonal,
    // which makes a side-by-side renderer comparison look different for no
    // reason other than a naming convention.
    this.orbit.alpha = Math.atan2(0.62, 0.5);
    this.camera.setTarget(this.orbit.target.clone());
    this.camera.radius = this.orbit.radius;
    this.camera.beta = this.orbit.beta;
    this.camera.alpha = this.orbit.alpha;
    void extent;
  }

  updateCamera(): void {
    // ArcRotateCamera handles its own input; nothing to pump here.
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const engine = this.engine;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const n = Math.max(1, slots.length);

    engine.clear(new Color4(0.933, 0.945, 0.965, 1), true, true);

    let drawCalls = 0, triangles = 0, instances = 0;
    if (n === 1) {
      this.setVisibleLayer(slots[0]?.id ?? null);
      this.camera.viewport = new Viewport(0, 0, 1, 1);
      this.scene.render();
      const s = this.collect(slots[0]?.id ?? null);
      drawCalls = s.drawCalls; triangles = s.triangles; instances = s.instances;
    } else {
      const { cols, rows } = slotGrid(n);
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        this.setVisibleLayer(slots[i].id);
        // Babylon's viewport is normalised, with the origin bottom-left.
        this.camera.viewport = new Viewport(col / cols, (rows - 1 - row) / rows, 1 / cols, 1 / rows);
        this.scene.render();
        const s = this.collect(slots[i].id);
        drawCalls += s.drawCalls; triangles += s.triangles; instances += s.instances;
      }
    }
    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
    this.lastInstances = instances;
  }

  private collect(id: string | null): { drawCalls: number; triangles: number; instances: number } {
    if (!id) return { drawCalls: 0, triangles: 0, instances: 0 };
    const layer = this.layers.get(id);
    if (!layer) return { drawCalls: 0, triangles: 0, instances: 0 };
    return {
      drawCalls: layer.bucketCount,
      triangles: layer.triCount,
      instances: layer.instanceCount,
    };
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    const scene = this.scene;
    let instances = 0;
    let bufferBytes = 0;
    for (const l of this.layers.values()) {
      instances += l.instanceCount;
      bufferBytes += l.gpuBytes;
    }
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      instances,
      // Babylon tracks its own counts; report them rather than guessing.
      geometries: scene.meshes.length,
      textures: scene.textures.length,
      programs: (this.engine as unknown as { _compiledEffects?: Record<string, unknown> })._compiledEffects
        ? Object.keys((this.engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects).length
        : undefined,
      bufferBytes,
      notes: {
        geometries: '场景中的 Mesh 数量（每个形状签名一个，thin instance 不额外计数）',
        programs: 'Babylon 内部已编译 effect 的数量',
        bufferBytes: '顶点 + 索引 + 实例矩阵与颜色',
      },
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: true, meshes: layer.probe() };
    }
    const cam = this.camera;
    out.__camera = {
      pos: [r2(cam.position.x), r2(cam.position.y), r2(cam.position.z)],
      target: [r2(cam.target.x), r2(cam.target.y), r2(cam.target.z)],
      fov: 50, near: cam.minZ, far: cam.maxZ,
      aspect: r3(cam.getEngine().getAspectRatio(cam)),
      radius: r2(cam.radius),
      theta: r3(cam.alpha),
      phi: r3(cam.beta),
      rendererSize: [this.engine.getRenderWidth(), this.engine.getRenderHeight()],
      cssSize: [this.canvasEl.clientWidth, this.canvasEl.clientHeight],
    };
    out.__backend = { kind: 'webgl2', renderer: meta.name, framework: 'babylon' };
    // Internal state, because "probe says the data is right but the pane is
    // blank" is a pipeline problem and the pipeline lives inside Babylon.
    out.__diag = {
      meshes: this.scene.meshes.length,
      activeCamera: this.scene.activeCamera ? this.scene.activeCamera.name : null,
      cameraViewport: this.camera.viewport
        ? [this.camera.viewport.x, this.camera.viewport.y, this.camera.viewport.width, this.camera.viewport.height]
        : null,
      renderSize: [this.engine.getRenderWidth(), this.engine.getRenderHeight()],
      hardwareScale: this.engine.getHardwareScalingLevel(),
      autoClear: this.scene.autoClear,
      renderPasses: this.scene.getActiveMeshes().length,
      meshesDetail: this.scene.meshes.map((m) => ({
        name: m.name,
        verts: m.getTotalVertices(),
        indices: m.getTotalIndices(),
        thin: (m as unknown as { thinInstanceCount?: number }).thinInstanceCount ?? 0,
        enabled: m.isEnabled(),
        visible: m.isVisible,
        hasMaterial: !!m.material,
        materialReady: m.material ? m.material.isReady(m) : false,
      })),
    };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.scene?.dispose();
    this.engine?.dispose();
    this.canvasEl.remove();
  }
}

export function create(): IRenderEngine {
  return new BabylonRenderEngine();
}
