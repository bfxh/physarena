import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BodyDesc, BodyState, Vec3 } from '../core/types';
import { buildGeometry, colorFor, signature } from './meshFactory';

interface Group {
  key: string;
  mesh: THREE.InstancedMesh;
  indices: number[];
}

/**
 * Grid layout for the multi-engine view. Shared with the DOM overlay labels so
 * the chrome always lines up with the WebGL scissor rectangles.
 */
export function slotRects(n: number, w: number, h: number) {
  const count = Math.max(1, n);
  const cols = count === 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / cols);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (i % cols) * (w / cols),
      y: Math.floor(i / cols) * (h / rows),
      w: w / cols,
      h: h / rows,
    });
  }
  return out;
}

/**
 * One engine's visual state. Every layer lives in the shared scene but only one
 * is visible per render pass, which is how side-by-side comparison works
 * without duplicating cameras or the renderer.
 */
export class ViewLayer {
  readonly group = new THREE.Group();
  private groups: Group[] = [];
  /**
   * Geometries owned by the CURRENT scene. They are released on the next
   * rebuild so GPU memory tracks one scene instead of every scene visited.
   */
  private geometries: THREE.BufferGeometry[] = [];
  private material: THREE.Material;
  private tmp = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(
    readonly id: string,
    accent: number,
  ) {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.group.visible = false;
    void accent;
  }

  get objects(): THREE.Object3D {
    return this.group;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();

    // Group by geometry signature. TWO passes on purpose: THREE.InstancedMesh
    // allocates its instance buffers from the count passed to the constructor,
    // so creating it with 0 and assigning `count` afterwards renders nothing.
    const buckets = new Map<string, { geometry: THREE.BufferGeometry; indices: number[] }>();
    for (let i = 0; i < bodies.length; i++) {
      const key = signature(bodies[i].shape);
      let bucket = buckets.get(key);
      if (!bucket) {
        const geometry = buildGeometry(bodies[i].shape);
        this.geometries.push(geometry);
        bucket = { geometry, indices: [] };
        buckets.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    for (const [key, bucket] of buckets) {
      const n = bucket.indices.length;
      const mesh = new THREE.InstancedMesh(bucket.geometry, this.material, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const colors = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let k = 0; k < n; k++) {
        const b = bodies[bucket.indices[k]];
        c.setHex(colorFor(b.tag, bucket.indices[k]));
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.groups.push({ key, mesh, indices: bucket.indices });
    }
  }

  sync(states: BodyState[]) {
    const huge = 1e5;
    for (const g of this.groups) {
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

  clear() {
    for (const g of this.groups) {
      g.mesh.removeFromParent();
      g.mesh.dispose();
    }
    this.groups = [];
    for (const geom of this.geometries) geom.dispose();
    this.geometries = [];
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}

export interface ViewportOptions {
  /** Cap the device pixel ratio so the GPU does not become the bottleneck. */
  maxPixelRatio?: number;
  onResize?: () => void;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private layers = new Map<string, ViewLayer>();
  private order: string[] = [];
  private grid: THREE.GridHelper;
  private helper = new THREE.Group();
  private canvasHost: HTMLElement;
  private maxPixelRatio: number;

  constructor(host: HTMLElement, opts: ViewportOptions = {}) {
    this.canvasHost = host;
    this.maxPixelRatio = opts.maxPixelRatio ?? 1.5;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        stencil: false,
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
    this.renderer.domElement.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });
    this.renderer.setClearColor(0xeef1f6, 1);
    this.renderer.shadowMap.enabled = false;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('pa-canvas');

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40000);
    this.camera.position.set(22, 16, 26);
    this.camera.layers.enableAll();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
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

    if (opts.onResize) this.onResize = opts.onResize;
    this.resize();
  }

  onResize: () => void = () => {};
  /** Set by the app so a lost GPU context can be surfaced to the user. */
  onContextLost: (() => void) | null = null;

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  addLayer(id: string, accent: number): ViewLayer {
    if (this.layers.has(id)) return this.layers.get(id)!;
    // Each layer gets its own geometry cache. Sharing one across layers meant a
    // geometry could be handed to meshes belonging to different materials and
    // programs, which is legal but produced a degenerate giant mesh in the Jolt
    // pane while the identical Rapier pane rendered correctly.
    const layer = new ViewLayer(id, accent);
    this.layers.set(id, layer);
    this.order.push(id);
    this.scene.add(layer.group);
    return layer;
  }

  removeLayer(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    this.scene.remove(l.group);
    l.dispose();
    this.layers.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  layer(id: string): ViewLayer | undefined {
    return this.layers.get(id);
  }

  /**
   * Diagnostic: what each layer's meshes actually contain.
   *
   * `scale` is the longest basis vector of the instance matrix, so a
   * degenerate giant mesh shows up immediately as an absurd number instead
   * of as a mystery on screen.
   */
  renderProbe(): unknown {
    const out: Record<string, unknown> = {};
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (const [id, layer] of this.layers) {
      const meshes: unknown[] = [];
      layer.group.traverse((o) => {
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh) return;
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
      });
      out[id] = { visible: layer.group.visible, meshes };
    }
    const cam = this.camera;
    const t = this.controls.target;
    (out as Record<string, unknown>).__camera = {
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
    return out;
  }

  /** Live renderer counters, used to verify nothing accumulates. */
  resourceInfo(): Record<string, number> {
    const info = this.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      drawCalls: info.render.calls,
    };
  }

  /** 0 = show the empty grid only (used while a scene is being rebuilt). */
  setVisibleLayer(id: string | null) {
    for (const [key, layer] of this.layers) layer.group.visible = key === id;
  }

  resize() {
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

  /**
   * Frames a scene around its content.
   *
   * `contentRadius` is the reach of the moving bodies around `target` (the
   * content centre) and is what drives the distance. `extent` deliberately
   * does NOT: it is inflated by the ground plane (120-200 m), so using it put
   * the camera ~100 m out and left a 7 m pyramid a few pixels tall in the
   * middle of an empty floor.
   *
   * The ground is only a ceiling on the distance, so a very large floor no
   * longer pushes the camera away, and the ground still reads as a floor.
   */
  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3,
    radiusScale = 2.6) {
    const wanted = Math.max(9, contentRadius * radiusScale);
    const r = groundSize > 0 ? Math.min(wanted, Math.max(11, groundSize * 0.6)) : wanted;
    // Default target: the content centre (falling back to the old origin-relative
    // guess when no centre is supplied).
    const t: Vec3 = target ?? [0, Math.max(1.4, contentRadius * 0.4), 0];
    this.controls.target.set(t[0], t[1], t[2]);
    // Steeper than a 27-degree tilt so the ground plane reads as a floor.
    this.camera.position.set(t[0] + r * 0.5, t[1] + r * 0.72, t[2] + r * 0.62);
    this.controls.update();
    this.grid.position.set(t[0], 0, t[2]);
    this.grid.scale.setScalar(Math.max(1, extent / 60));
  }

  /**
   * Renders `slots` panes across the canvas, each showing exactly one layer.
   * A single slot renders fullscreen with no scissor work at all.
   */
  render(slots: { id: string; label: string }[]) {
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

    const cols = n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rows = Math.ceil(n / cols);
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

  dispose() {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
