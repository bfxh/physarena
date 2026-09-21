import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import {
  cachedGeometryData, instanceColors, signature, type GeometryData,
} from '../geometry';
import { slotGrid } from '../layout';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'webgl2',
  name: '原生 WebGL2',
  language: 'GLSL',
  backend: 'WebGL2',
  license: 'MIT',
  homepage: 'https://registry.khronos.org/webgl/',
  accent: '#e4573c',
  blurb: '不经任何框架，手写 instancing 管线：顶点属性分频、自己算矩阵、自己管 VAO。零额外依赖。',
  features: { instancing: true, lighting: true, antialias: true, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  costKb: 0,
};

// ------------------------------------------------------------------ mat4
// Just enough matrix maths for a fixed camera. Column-major, matching WebGL.
type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
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
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
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

// ------------------------------------------------------------------ shaders

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aInst0;
layout(location=3) in vec4 aInst1;
layout(location=4) in vec4 aInst2;
layout(location=5) in vec4 aInst3;
layout(location=6) in vec3 aInstColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vColor;
void main() {
  mat4 m = mat4(aInst0, aInst1, aInst2, aInst3);
  vec4 world = m * vec4(aPosition, 1.0);
  vNormal = mat3(m) * aNormal;
  vColor = aInstColor;
  gl_Position = uViewProj * world;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
// Matches the three.js baseline: hemisphere ambient + two directionals.
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uLightDir1;
uniform vec3 uLightCol1;
uniform vec3 uLightDir2;
uniform vec3 uLightCol2;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  // HemisphereLight(0xffffff, 0xb8c0cc, 1.05): blend by the up component.
  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5) * 1.05;
  vec3 c = vColor * ambient;
  c += vColor * uLightCol1 * max(dot(n, uLightDir1), 0.0);
  c += vColor * uLightCol2 * max(dot(n, uLightDir2), 0.0);
  fragColor = vec4(c, 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uAlpha;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, uAlpha); }`;

// ------------------------------------------------------------------ helpers

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader 失败');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败：' + log);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram 失败');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('着色器链接失败：' + log);
  }
  return prog;
}

interface GlBucket {
  key: string;
  vao: WebGLVertexArrayObject;
  program: WebGLProgram;
  buffers: WebGLBuffer[];
  indexType: number;
  indexCount: number;
  count: number;
  indices: number[];
  /** Instance matrices are CPU-side too: probe() and stats() read them back. */
  matrices: Float32Array;
}

/**
 * One physics engine's visual state, drawn with hand-written GL.
 *
 * The buckets mirror the three.js layer exactly (one draw call per shape
 * signature), which is the point: the same batching strategy on both backends
 * means any frame-time difference is the pipeline, not the algorithm.
 */
export class WebGL2Layer implements IRenderLayer {
  private gl: WebGL2RenderingContext;
  private buckets: GlBucket[] = [];
  private disposed = false;

  constructor(readonly id: string, gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  setBodies(bodies: BodyDesc[]) {
    this.clear();
    const gl = this.gl;

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
      const n = bucket.indices.length;
      const data = bucket.data;
      const buffers: WebGLBuffer[] = [];

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const posBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      buffers.push(posBuf);

      const nrmBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      buffers.push(nrmBuf);

      // Instance matrices: 4 vec4 slots, advanced once per instance.
      const matBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, matBuf);
      gl.bufferData(gl.ARRAY_BUFFER, n * 64, gl.DYNAMIC_DRAW);
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(2 + k);
        gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 64, k * 16);
        gl.vertexAttribDivisor(2 + k, 1);
      }
      buffers.push(matBuf);

      const colBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceColors(bodies, bucket.indices), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(6, 1);
      buffers.push(colBuf);

      const idxBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      const indexType = data.indices.length > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      const indexData = indexType === gl.UNSIGNED_INT ? data.indices : new Uint16Array(data.indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
      buffers.push(idxBuf);

      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      this.buckets.push({
        key,
        vao: vao!,
        program: null as unknown as WebGLProgram, // set at draw time
        buffers,
        indexType,
        indexCount: data.indices.length,
        count: n,
        indices: bucket.indices,
        matrices: new Float32Array(n * 16),
      });
    }
  }

  sync(states: BodyState[]) {
    const huge = 1e5;
    for (const b of this.buckets) {
      const n = b.indices.length;
      const m = b.matrices;
      for (let k = 0; k < n; k++) {
        const o = k * 16;
        const s = states[b.indices[k]];
        if (!s || !isRenderable(s, huge)) {
          // Collapse instead of drawing a ghost from the previous frame.
          m.fill(0, o, o + 16);
          continue;
        }
        writeInstanceMatrix(m, o, s);
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffers[2]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m);
    }
  }

  /** Buckets as bound VAOs, for the engine's draw pass. */
  get drawables(): GlBucket[] {
    return this.buckets;
  }

  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets) n += b.count;
    return n;
  }

  get triangleCount(): number {
    let n = 0;
    for (const b of this.buckets) n += (b.indexCount / 3) * b.count;
    return Math.round(n);
  }

  get bufferBytes(): number {
    let bytes = 0;
    for (const b of this.buckets) {
      bytes += b.indexCount * (b.indexType === this.gl.UNSIGNED_INT ? 4 : 2);
      bytes += b.count * 64; // instance matrices
      bytes += b.count * 12; // instance colours
      bytes += b.matrices.byteLength * 0 + 0;
    }
    return bytes;
  }

  /** Diagnostic snapshot, same shape as the three.js backend's. */
  probe(): unknown[] {
    const meshes: unknown[] = [];
    for (const b of this.buckets) {
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      let maxScale = 0;
      let worst = -1;
      const samples: unknown[] = [];
      for (let i = 0; i < b.count; i++) {
        const o = i * 16;
        const m = b.matrices;
        const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
        const sx = Math.hypot(m[o], m[o + 1], m[o + 2]);
        const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]);
        const sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]);
        const sc = Math.max(sx, sy, sz);
        if (sc > maxScale) { maxScale = sc; worst = i; }
        if (Number.isFinite(py)) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
        if (Number.isFinite(px)) { if (px < minX) minX = px; if (px > maxX) maxX = px; }
        if (i < 3) {
          samples.push({
            i,
            p: [round2(px), round2(py), round2(pz)],
            s: [round2(sx), round2(sy), round2(sz)],
          });
        }
      }
      meshes.push({
        count: b.count,
        visible: true,
        maxScale: round3(maxScale),
        worstInstance: worst,
        x: minX === Infinity ? null : [round2(minX), round2(maxX)],
        y: minY === Infinity ? null : [round2(minY), round2(maxY)],
        geometry: 'WebGL2Buffer',
        params: { signature: b.key, indexCount: b.indexCount },
        samples,
      });
    }
    return meshes;
  }

  clear() {
    if (this.disposed) return;
    const gl = this.gl;
    for (const b of this.buckets) {
      gl.deleteVertexArray(b.vao);
      for (const buf of b.buffers) gl.deleteBuffer(buf);
    }
    this.buckets = [];
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
}

function round2(v: number): number { return Number(v.toFixed(2)); }
function round3(v: number): number { return Number(v.toFixed(3)); }

function isRenderable(s: BodyState, huge: number): boolean {
  const p = s.position;
  const r = s.rotation;
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) &&
    Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && Number.isFinite(r[3]) &&
    Math.abs(p[0]) < huge && Math.abs(p[1]) < huge && Math.abs(p[2]) < huge;
}

/** Composes a TRS matrix into `out` at `o`, column-major, matching WebGL. */
function writeInstanceMatrix(out: Float32Array, o: number, s: BodyState) {
  const x = s.rotation[0], y = s.rotation[1], z = s.rotation[2], w = s.rotation[3];
  const len = Math.hypot(x, y, z, w) || 1;
  const qx = x / len, qy = y / len, qz = z / len, qw = w / len;

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[o + 0] = 1 - (yy + zz);
  out[o + 1] = xy + wz;
  out[o + 2] = xz - wy;
  out[o + 3] = 0;
  out[o + 4] = xy - wz;
  out[o + 5] = 1 - (xx + zz);
  out[o + 6] = yz + wx;
  out[o + 7] = 0;
  out[o + 8] = xz + wy;
  out[o + 9] = yz - wx;
  out[o + 10] = 1 - (xx + yy);
  out[o + 11] = 0;
  out[o + 12] = s.position[0];
  out[o + 13] = s.position[1];
  out[o + 14] = s.position[2];
  out[o + 15] = 1;
}

// ------------------------------------------------------------------ engine

interface OrbitState {
  target: Vec3;
  radius: number;
  theta: number;
  phi: number;
}

export class WebGL2RenderEngine implements IRenderEngine {
  readonly meta = meta;
  private gl!: WebGL2RenderingContext;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private meshProgram!: WebGLProgram;
  private lineProgram!: WebGLProgram;
  private meshUniforms: Record<string, WebGLUniformLocation | null> = {};
  private lineUniforms: Record<string, WebGLUniformLocation | null> = {};
  private gridVao!: WebGLVertexArrayObject;
  private gridBuffers: WebGLBuffer[] = [];
  private gridVertexCount = 0;
  private axesVao!: WebGLVertexArrayObject;
  private axesBuffers: WebGLBuffer[] = [];
  private axesVertexCount = 0;
  private layers = new Map<string, WebGL2Layer>();
  private visible: string | null = null;
  private orbit: OrbitState = { target: [0, 3, 0], radius: 30, theta: 0.678, phi: 0.836 };
  private disposed = false;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastInstances = 0;
  private dragging = false;
  private lastPointer: [number, number] = [0, 0];

  onResize: () => void = () => {};
  onContextLost: (() => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    this.canvasHost = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'pa-canvas';
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('无法创建 WebGL2 上下文：浏览器可能只支持 WebGL1，或禁用硬件加速。请改用 three.js 或 Canvas2D 渲染器。');
    }
    this.gl = gl;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.meshProgram = link(gl, MESH_VS, MESH_FS);
    this.lineProgram = link(gl, LINE_VS, LINE_FS);
    for (const name of ['uViewProj', 'uSky', 'uGround', 'uLightDir1', 'uLightCol1', 'uLightDir2', 'uLightCol2']) {
      this.meshUniforms[name] = gl.getUniformLocation(this.meshProgram, name);
    }
    for (const name of ['uViewProj', 'uAlpha']) {
      this.lineUniforms[name] = gl.getUniformLocation(this.lineProgram, name);
    }

    this.buildGrid();
    this.buildAxes();
    this.bindPointer(canvas);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  /** 200 m floor with 2 m cells and a brighter pair of axes, as in three.js. */
  private buildGrid(): void {
    const gl = this.gl;
    const half = 100;
    const step = 2;
    const lines: number[] = [];
    const major: [number, number, number] = [0.765, 0.796, 0.847];
    const minor: [number, number, number] = [0.867, 0.890, 0.925];
    for (let i = -half; i <= half; i += step) {
      const c = i % 10 === 0 ? major : minor;
      lines.push(-half, 0, i, ...c, half, 0, i, ...c);
      lines.push(i, 0, -half, ...c, i, 0, half, ...c);
    }
    this.gridVertexCount = lines.length / 6;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.gridVao = vao;
    this.gridBuffers = [buf];
  }

  private buildAxes(): void {
    const gl = this.gl;
    const data = new Float32Array([
      0, 0, 0, 1, 0.24, 0.24,
      3, 0, 0, 1, 0.24, 0.24,
      0, 0, 0, 0.24, 0.8, 0.24,
      0, 3, 0, 0.24, 0.8, 0.24,
      0, 0, 0, 0.24, 0.4, 1,
      0, 0, 3, 0.24, 0.4, 1,
    ]);
    this.axesVertexCount = 6;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.axesVao = vao;
    this.axesBuffers = [buf];
  }

  /** Orbit camera written from scratch - the point is not to depend on a lib. */
  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastPointer = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer[0];
      const dy = e.clientY - this.lastPointer[1];
      this.lastPointer = [e.clientX, e.clientY];
      this.orbit.theta -= dx * 0.006;
      this.orbit.phi = clamp(this.orbit.phi - dy * 0.006, 0.08, Math.PI * 0.495);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.orbit.radius = clamp(this.orbit.radius * (1 + Math.sign(e.deltaY) * 0.12), 1.5, 4000);
      },
      { passive: false },
    );
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let layer = this.layers.get(id);
    if (!layer) {
      layer = new WebGL2Layer(id, this.gl);
      void accent;
      this.layers.set(id, layer);
    }
    return layer;
  }

  removeLayer(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    l.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined {
    return this.layers.get(id);
  }

  setVisibleLayer(id: string | null) {
    this.visible = id;
  }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    // Same cap as the other backends: without it a 4K+dpr2 canvas becomes the
    // bottleneck and the renderer comparison stops being about the renderer.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvasEl.width = Math.max(1, Math.round(w * dpr));
    this.canvasEl.height = Math.max(1, Math.round(h * dpr));
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
    // Same offset direction as the three.js baseline: (0.5, 0.72, 0.62) * r.
    this.orbit.radius = r * Math.hypot(0.5, 0.72, 0.62);
    this.orbit.phi = Math.acos(0.72 / Math.hypot(0.5, 0.72, 0.62));
    this.orbit.theta = Math.atan2(0.5, 0.62);
    void extent;
  }

  updateCamera(): void {
    // Nothing damped: the orbit state is applied directly at draw time.
  }

  /** Camera eye position derived from the orbit state. */
  private eye(): Vec3 {
    const { target, radius, theta, phi } = this.orbit;
    const sp = Math.sin(phi);
    return [
      target[0] + radius * sp * Math.sin(theta),
      target[1] + radius * Math.cos(phi),
      target[2] + radius * sp * Math.cos(theta),
    ];
  }

  private viewProj(w: number, h: number): Mat4 {
    const proj = perspective((50 * Math.PI) / 180, w / h, 0.1, 40000);
    const view = lookAt(this.eye(), this.orbit.target, [0, 1, 0]);
    return multiply(proj, view);
  }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const gl = this.gl;
    const cssW = this.canvasHost.clientWidth || 1;
    const cssH = this.canvasHost.clientHeight || 1;
    const dpr = this.canvasEl.width / cssW;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    void cssW; void cssH;

    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.933, 0.945, 0.965, 1); // #eef1f6, matching three.js
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let drawCalls = 0;
    let triangles = 0;
    let instances = 0;
    const n = Math.max(1, slots.length);

    const drawPane = (id: string | null, vp: [number, number, number, number]) => {
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      const vpMat = this.viewProj(vp[2], vp[3]);
      this.drawGrid(vpMat, dpr);
      if (id) {
        const layer = this.layers.get(id);
        if (layer) {
          const r = this.drawLayer(layer, vpMat);
          drawCalls += r.drawCalls;
          triangles += r.triangles;
          instances += r.instances;
        }
      }
    };

    if (n === 1) {
      drawPane(slots[0]?.id ?? null, [0, 0, w, h]);
    } else {
      const { cols, rows } = slotGrid(n);
      const cw = Math.floor(w / cols);
      const ch = Math.floor(h / rows);
      gl.enable(gl.SCISSOR_TEST);
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * cw;
        const y = h - (row + 1) * ch;
        gl.scissor(x, y, cw, ch);
        drawPane(slots[i].id, [x, y, cw, ch]);
      }
      gl.disable(gl.SCISSOR_TEST);
    }

    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
    this.lastInstances = instances;
  }

  private drawGrid(vpMat: Mat4, dpr: number): void {
    const gl = this.gl;
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, vpMat);
    gl.uniform1f(this.lineUniforms.uAlpha, 0.55);
    gl.depthMask(false);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.LINES, 0, this.gridVertexCount);
    gl.bindVertexArray(this.axesVao);
    gl.uniform1f(this.lineUniforms.uAlpha, 1);
    gl.drawArrays(gl.LINES, 0, this.axesVertexCount);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    void dpr;
  }

  private drawLayer(layer: WebGL2Layer, vpMat: Mat4): { drawCalls: number; triangles: number; instances: number } {
    const gl = this.gl;
    gl.useProgram(this.meshProgram);
    gl.uniformMatrix4fv(this.meshUniforms.uViewProj, false, vpMat);
    // Matches the three.js lighting rig so switching backends is a fair swap.
    gl.uniform3f(this.meshUniforms.uSky, 1, 1, 1);
    gl.uniform3f(this.meshUniforms.uGround, 0.7216, 0.7529, 0.8);
    uniformDir(gl, this.meshUniforms.uLightDir1, [18, 30, 14]);
    gl.uniform3f(this.meshUniforms.uLightCol1, 1.5, 1.5, 1.5);
    uniformDir(gl, this.meshUniforms.uLightDir2, [-16, 12, -20]);
    gl.uniform3f(this.meshUniforms.uLightCol2, 0.55 * 0.8745, 0.55 * 0.9098, 0.55);

    let drawCalls = 0;
    let triangles = 0;
    let instances = 0;
    for (const bucket of layer.drawables) {
      gl.bindVertexArray(bucket.vao);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        bucket.indexCount,
        bucket.indexType,
        0,
        bucket.count,
      );
      gl.bindVertexArray(null);
      drawCalls++;
      instances += bucket.count;
      triangles += Math.round((bucket.indexCount / 3) * bucket.count);
    }
    return { drawCalls, triangles, instances };
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let bufferBytes = 0;
    for (const l of this.layers.values()) bufferBytes += l.bufferBytes;
    const primitives = 2 + this.layers.size; // grid + axes + one VAO per bucket
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      instances: this.lastInstances,
      geometries: primitives,
      textures: 0,
      // Two programs: mesh + line. Reported so it is comparable with three.js,
      // whose "programs" counter means something slightly different.
      programs: 2,
      bufferBytes,
      notes: {
        programs: '手写管线固定两个程序（网格 / 线条），不随场景增长',
        geometries: '统计 VAO 数量（含地面网格与坐标轴）',
        bufferBytes: '顶点 + 索引 + 实例矩阵 + 实例颜色，不含帧缓冲',
      },
    };
  }

  probe(): RenderProbe {
    const out: RenderProbe = {};
    if (this.disposed) return out;
    for (const [id, layer] of this.layers) {
      out[id] = { visible: this.visible === id, meshes: layer.probe() };
    }
    const eye = this.eye();
    out.__camera = {
      pos: [round2(eye[0]), round2(eye[1]), round2(eye[2])],
      target: [round2(this.orbit.target[0]), round2(this.orbit.target[1]), round2(this.orbit.target[2])],
      fov: 50,
      near: 0.1,
      far: 40000,
      aspect: round3(this.canvasEl.width / Math.max(1, this.canvasEl.height)),
      radius: round2(this.orbit.radius),
      theta: round3(this.orbit.theta),
      phi: round3(this.orbit.phi),
      rendererSize: [this.canvasEl.width, this.canvasEl.height],
      cssSize: [this.canvasEl.clientWidth, this.canvasEl.clientHeight],
    };
    out.__backend = { kind: 'webgl2', renderer: meta.name };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const buf of [...this.gridBuffers, ...this.axesBuffers]) gl.deleteBuffer(buf);
    gl.deleteVertexArray(this.gridVao);
    gl.deleteVertexArray(this.axesVao);
    gl.deleteProgram(this.meshProgram);
    gl.deleteProgram(this.lineProgram);
    this.canvasEl.remove();
  }
}

function uniformDir(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null, v: Vec3): void {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  gl.uniform3f(loc, v[0] / len, v[1] / len, v[2] / len);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function create(): IRenderEngine {
  return new WebGL2RenderEngine();
}
