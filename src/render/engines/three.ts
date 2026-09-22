import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import {
  buildGeometryData, instanceColors, cachedGeometryData, signature, type GeometryData,
} from '../geometry';
import { slotGrid } from '../layout';
import { glContextAttributes } from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'three',
  name: 'three.js',
  language: 'JavaScript',
  backend: 'WebGL2',
  license: 'MIT',
  homepage: 'https://threejs.org',
  accent: '#4c7dff',
  blurb: '最主流的 WebGL 封装。InstancedMesh 批处理 + Lambert 光照，是其余渲染器的对照基线。',
  features: { instancing: true, lighting: true, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  costKb: 0,
};

interface Bucket {
  key: string;
  mesh: THREE.InstancedMesh;
  indices: number[];
}

/** GeometryData -> three geometry. The data itself is shared and cached. */
function toThreeGeometry(data: GeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return g;
}

/**
 * One physics engine's visual state.
 *
 * Every layer lives in the shared scene but only one is visible per render
 * pass, which is how side-by-side comparison works without duplicating the
 * camera or the renderer.
 */
export class ThreeRenderLayer implements IRenderLayer {
  readonly group = new THREE.Group();
  private buckets: Bucket[] = [];
  /**
   * Geometries owned by the CURRENT scene. Released on the next rebuild so GPU
   * memory tracks one scene instead of every scene visited.
   */
  private geometries: THREE.BufferGeometry[] = [];
  private material: THREE.Material;
  private tmp = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(readonly id: string, accent = 0x4c7dff) {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.group.visible = false;
    // Accent is accepted for interface parity; the shared colour policy decides
    // per-instance colour so every backend renders identical hues.
    void accent;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();

    // Group by geometry signature. TWO passes on purpose: THREE.InstancedMesh
    // allocates its instance buffers from the count passed to the constructor,
    // so creating it with 0 and assigning `count` afterwards renders nothing.
    const buckets = new Map<string, { data: GeometryData; indices: number[] }>();
    for (let i = 0; i < bodies.length; i++) {
      const key = signature(bodies[i].shape);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { data: cachedGeometryData(bodies[i].shape, key), indices: [] };
        buckets.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    for (const [key, bucket] of buckets) {
      const n = bucket.indices.length;
      const geometry = toThreeGeometry(bucket.data);
      this.geometries.push(geometry);
      const mesh = new THREE.InstancedMesh(geometry, this.material, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const colors = instanceColors(bodies, bucket.indices);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.buckets.push({ key, mesh, indices: bucket.indices });
    }
  }

  sync(states: BodyState[]) {
    const huge = 1e5;
    for (const g of this.buckets) {
      const n = g.indices.length;
      for (let k = 0; k < n; k++) {
        const s = states[g.indices[k]];
        if (!s) {
          // No state for this index: collapse the instance instead of leaving
          // the previous frame's transform (a ghost body) or a zero matrix.
          this.tmp.makeScale(0, 0, 0);
          g.mesh.setMatrixAt(k, this.tmp);
          continue;
        }
        const p = s.position;
        const r = s.rotation;
        const bad =
          !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]) ||
          !Number.isFinite(r[0]) || !Number.isFinite(r[1]) ||
          !Number.isFinite(r[2]) || !Number.isFinite(r[3]) ||
          Math.abs(p[0]) > huge || Math.abs(p[1]) > huge || Math.abs(p[2]) > huge;
        if (bad) {
          // A single non-finite or absurd transform drags the whole instanced
          // draw into degenerate giant triangles that blot out the viewport
          // (seen with Jolt on the domino scene). Collapse that one instance
          // instead of letting it destroy the frame.
          this.tmp.makeScale(0, 0, 0);
          g.mesh.setMatrixAt(k, this.tmp);
          continue;
        }
        this.pos.set(p[0], p[1], p[2]);
        this.quat.set(r[0], r[1], r[2], r[3]);
        this.tmp.compose(this.pos, this.quat, this.one);
        g.mesh.setMatrixAt(k, this.tmp);
      }
      g.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Instances currently drawn by this layer. */
  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.mesh.count;
    return n;
  }

  /** GPU bytes held by this layer's geometry + instance buffers. */
  get gpuBytes(): number {
    let bytes = 0;
    for (const g of this.geometries) {
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      if (pos) bytes += pos.array.byteLength;
      if (nrm) bytes += nrm.array.byteLength;
      if (g.index) bytes += g.index.array.byteLength;
    }
    for (const b of this.buckets) {
      bytes += b.mesh.instanceMatrix.array.byteLength;
      if (b.mesh.instanceColor) bytes += b.mesh.instanceColor.array.byteLength;
    }
    return bytes;
  }

  /** Diagnostic snapshot mirroring the documented `renderProbe()` shape. */
  probe(): unknown[] {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const meshes: unknown[] = [];
    for (const bucket of this.buckets) {
      const mesh = bucket.mesh;
      let maxScale = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      let worst = -1;
      const samples: unknown[] = [];
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        m.decompose(p, q, s);
        const sc = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
        if (sc > maxScale) { maxScale = sc; worst = i; }
        if (Number.isFinite(p.y)) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        if (Number.isFinite(p.x)) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
        if (i < 3) {
          samples.push({
            i,
            p: [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))],
            s: [Number(s.x.toFixed(3)), Number(s.y.toFixed(3)), Number(s.z.toFixed(3))],
          });
        }
      }
      meshes.push({
        count: mesh.count,
        visible: mesh.visible,
        maxScale: Number(maxScale.toFixed(3)),
        worstInstance: worst,
        // null means "no transform was ever written" (a zero matrix reads as
        // Infinity here), which is data state, not absurd data.
        x: minX === Infinity ? null : [Number(minX.toFixed(2)), Number(maxX.toFixed(2))],
        y: minY === Infinity ? null : [Number(minY.toFixed(2)), Number(maxY.toFixed(2))],
        geometry: mesh.geometry.type,
        params: (mesh.geometry as unknown as { parameters?: unknown }).parameters ?? null,
        samples,
      });
    }
    return meshes;
  }

  clear() {
    for (const b of this.buckets) {
      b.mesh.removeFromParent();
      b.mesh.dispose();
    }
    this.buckets = [];
    for (const geom of this.geometries) geom.dispose();
    this.geometries = [];
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}

export class ThreeRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private renderer!: THREE.WebGLRenderer;
  private canvasHost!: HTMLElement;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private layers = new Map<string, ThreeRenderLayer>();
  private grid!: THREE.GridHelper;
  private helper = new THREE.Group();
  private maxPixelRatio = 1.5;
  private disposed = false;

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        stencil: false,
        // Follows the shared switch. Without preservation a canvas cannot be
        // read back from inside the page once the frame is composited, which
        // makes the acceptance script blind to this backend while it renders
        // perfectly well.
        preserveDrawingBuffer: glContextAttributes().preserveDrawingBuffer === true,
      });
    } catch (e) {
      // Without this the constructor throw was swallowed by the async boot
      // path and the user just saw an empty page.
      throw new Error(
        '无法创建 WebGL 上下文：' + (e instanceof Error ? e.message : String(e)) +
        '。请确认浏览器启用硬件加速，并且没有把显卡驱动更新挂起。',
      );
    }
    this.renderer = renderer;
    renderer.domElement.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });
    renderer.setClearColor(0xeef1f6, 1);
    renderer.shadowMap.enabled = false;
    host.appendChild(renderer.domElement);
    renderer.domElement.classList.add('pa-canvas');

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40000);
    this.camera.position.set(22, 16, 26);
    this.camera.layers.enableAll();

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 3, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(18, 30, 14);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55);
    fill.position.set(-16, 12, -20);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(200, 100, 0xc3cbd8, 0xdde3ec);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(this.grid);
    this.scene.add(this.helper);
    this.helper.add(new THREE.AxesHelper(3));

    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get objects(): THREE.Object3D {
    return this.scene;
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    const existing = this.layers.get(id);
    if (existing) return existing;
    // Each layer gets its own geometry cache. Sharing one across layers meant a
    // geometry could be handed to meshes belonging to different materials and
    // programs, which is legal but produced a degenerate giant mesh in the Jolt
    // pane while the identical Rapier pane rendered correctly.
    const layer = new ThreeRenderLayer(id, accent);
    this.layers.set(id, layer);
    this.scene.add(layer.group);
    return layer;
  }

  removeLayer(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    this.scene.remove(l.group);
    l.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined {
    return this.layers.get(id);
  }

  setVisibleLayer(id: string | null) {
    for (const [key, layer] of this.layers) layer.group.visible = key === id;
  }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Notify the host: slot labels are positioned in CSS pixels and must be
    // relaid out whenever the stage geometry changes.
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3,
    radiusScale = 2.6) {
    const wanted = Math.max(9, contentRadius * radiusScale);
    const r = groundSize > 0 ? Math.min(wanted, Math.max(11, groundSize * 0.6)) : wanted;
    const t: Vec3 = target ?? [0, Math.max(1.4, contentRadius * 0.4), 0];
    this.controls.target.set(t[0], t[1], t[2]);
    // Steeper than a 27-degree tilt so the ground plane reads as a floor.
    this.camera.position.set(t[0] + r * 0.5, t[1] + r * 0.72, t[2] + r * 0.62);
    this.controls.update();
    this.grid.position.set(t[0], 0, t[2]);
    this.grid.scale.setScalar(Math.max(1, extent / 60));
  }

  updateCamera() {
    if (!this.disposed) this.controls.update();
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    const n = Math.max(1, slots.length);

    this.renderer.setScissorTest(false);
    if (n === 1) {
      this.setVisibleLayer(slots[0]?.id ?? null);
      this.renderer.setViewport(0, 0, w, h);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const { cols, rows } = slotGrid(n);
    this.renderer.setScissorTest(true);
    const cw = w / cols;
    const ch = h / rows;
    const savedAspect = this.camera.aspect;
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cw;
      const y = h - (row + 1) * ch;
      this.setVisibleLayer(slots[i].id);
      // Each pane is its own projection region; without this the panes render
      // with the full-canvas aspect and everything looks stretched.
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setViewport(x, y, cw, ch);
      this.renderer.setScissor(x, y, cw, ch);
      this.renderer.render(this.scene, this.camera);
    }
    this.camera.aspect = savedAspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(false);
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    const info = this.renderer.info;
    let instances = 0;
    let bufferBytes = 0;
    for (const l of this.layers.values()) {
      instances += l.instanceCount;
      bufferBytes += l.gpuBytes;
    }
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      instances,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      bufferBytes,
      notes: {
        bufferBytes: 'position + normal + index + instanceMatrix/instanceColor，按 layer 实际持有的缓冲统计',
        drawCalls: '最近一次 render() 的提交次数（含分屏的每次提交）',
      },
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: layer.group.visible, meshes: layer.probe() };
    }
    const cam = this.camera;
    const t = this.controls.target;
    out.__camera = {
      pos: [Number(cam.position.x.toFixed(2)), Number(cam.position.y.toFixed(2)), Number(cam.position.z.toFixed(2))],
      target: [Number(t.x.toFixed(2)), Number(t.y.toFixed(2)), Number(t.z.toFixed(2))],
      fov: cam.fov,
      near: cam.near,
      far: cam.far,
      aspect: Number(cam.aspect.toFixed(3)),
      zoom: cam.zoom,
      gridScale: Number(this.grid.scale.x.toFixed(3)),
      gridY: Number(this.grid.position.y.toFixed(2)),
      rendererSize: [this.renderer.domElement.width, this.renderer.domElement.height],
      cssSize: [this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight],
    };
    out.__backend = { kind: 'webgl2', renderer: this.meta.name };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}

export function create(): IRenderEngine {
  return new ThreeRenderEngine();
}
