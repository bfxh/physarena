import type { BodyDesc, BodyState, Vec3 } from '../../core/types';
import { instanceColors } from '../geometry';
import { slotGrid } from '../layout';
import {
  OrbitCamera, axisLines, floorLines, linkProgram, renderable, r2, r3,
} from '../glCommon';
import type {
  IRenderEngine, IRenderLayer, RenderEngineMeta, RenderProbe, RenderSlot, RenderStats,
} from '../types';

export const meta: RenderEngineMeta = {
  id: 'points',
  name: '点云（WebGL2）',
  language: 'GLSL',
  backend: 'WebGL2',
  license: 'MIT',
  homepage: 'https://registry.khronos.org/webgl/',
  accent: '#f0a03a',
  blurb:
    '最小可行管线：每个刚体只提交一个顶点，一次 drawArrays 画完整个场景。不提交几何、不做光照、按距离给圆盘半径——这是「保真度换速度」的极限，也是其余后端的速度上界。',
  features: { instancing: true, lighting: false, antialias: false, scissorPanes: true, depthBuffer: true },
  status: 'stable',
  costKb: 0,
};

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
uniform float uHeightPx;
out vec3 vColor;
void main() {
  vec4 clip = uViewProj * vec4(aPosition, 1.0);
  gl_Position = clip;
  // Perspective-correct size: this is the only "3D" work this backend does.
  float w = max(clip.w, 0.001);
  gl_PointSize = clamp(uHeightPx * 0.02 / w, 1.5, 48.0);
  vColor = aColor;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  // Round sprite instead of a square: at these sizes a square reads as a grid.
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  fragColor = vec4(vColor, 1.0);
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

/**
 * One physics engine's state as a point cloud.
 *
 * There is no per-shape geometry at all: the bucket structure that the other
 * backends need simply does not exist here, which is precisely why this is the
 * fastest backend in the lab. What it cannot do is show orientation or size.
 */
export class PointsLayer implements IRenderLayer {
  private gl: WebGL2RenderingContext;
  private positions: Float32Array;
  private colors: Float32Array;
  private capacity = 0;
  private count = 0;
  private posBuf: WebGLBuffer | null = null;
  private colBuf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private disposed = false;

  constructor(readonly id: string, gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.positions = new Float32Array(3);
    this.colors = new Float32Array(3);
  }

  setBodies(bodies: BodyDesc[]) {
    const gl = this.gl;
    const n = Math.max(1, bodies.length);
    this.count = bodies.length;

    if (n > this.capacity) {
      this.capacity = Math.max(n, this.capacity * 2, 64);
      this.positions = new Float32Array(this.capacity * 3);
      this.colors = new Float32Array(this.capacity * 3);
      this.rebuildBuffers();
    }

    // Colours are per body and static for the scene.
    const all = instanceColors(bodies, bodies.map((_, i) => i));
    this.colors.set(all.subarray(0, bodies.length * 3));

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private rebuildBuffers(): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.posBuf) gl.deleteBuffer(this.posBuf);
    if (this.colBuf) gl.deleteBuffer(this.colBuf);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.vao = vao;
    this.posBuf = posBuf;
    this.colBuf = colBuf;
  }

  sync(states: BodyState[]) {
    const p = this.positions;
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      const s = states[i];
      if (!renderable(s)) {
        // Park unrenderable bodies far below the floor rather than at the
        // origin, where they would form a bright blob on the base plane.
        p[k] = 0; p[k + 1] = -1e6; p[k + 2] = 0;
      } else {
        p[k] = s!.position[0]; p[k + 1] = s!.position[1]; p[k + 2] = s!.position[2];
      }
      k += 3;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  get drawable(): { vao: WebGLVertexArrayObject | null; count: number } {
    return { vao: this.vao, count: this.count };
  }

  get instanceCount(): number {
    return this.count;
  }

  probe(): unknown {
    // The point cloud keeps no matrices - only positions - so the diagnostic
    // reports positions. Saying so is better than faking a matrix readback.
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    const p = this.positions;
    for (let i = 0; i < this.count; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
    return [{
      count: this.count,
      visible: true,
      maxScale: 1,
      worstInstance: -1,
      x: minX === Infinity ? null : [r2(minX), r2(maxX)],
      y: minY === Infinity ? null : [r2(minY), r2(maxY)],
      geometry: 'gl.POINTS',
      params: { note: '点云后端不保存实例矩阵，只保存位置' },
      samples: [],
    }];
  }

  clear() {
    if (this.disposed) return;
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.posBuf) gl.deleteBuffer(this.posBuf);
    if (this.colBuf) gl.deleteBuffer(this.colBuf);
    this.vao = null;
    this.posBuf = null;
    this.colBuf = null;
    this.capacity = 0;
    this.count = 0;
    this.positions = new Float32Array(3);
    this.colors = new Float32Array(3);
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }
}

export class PointsRenderEngine implements IRenderEngine {
  readonly meta = meta;
  private gl!: WebGL2RenderingContext;
  private canvasEl!: HTMLCanvasElement;
  private canvasHost!: HTMLElement;
  private pointProgram!: WebGLProgram;
  private lineProgram!: WebGLProgram;
  private pointUniforms: Record<string, WebGLUniformLocation | null> = {};
  private lineUniforms: Record<string, WebGLUniformLocation | null> = {};
  private floorVao!: WebGLVertexArrayObject;
  private floorCount = 0;
  private floorBufs: WebGLBuffer[] = [];
  private axisVao!: WebGLVertexArrayObject;
  private axisCount = 0;
  private axisBufs: WebGLBuffer[] = [];
  private layers = new Map<string, PointsLayer>();
  readonly camera = new OrbitCamera();
  private disposed = false;
  private lastDrawCalls = 0;
  private lastInstances = 0;

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
    if (!gl) throw new Error('点云后端需要 WebGL2，当前浏览器不支持。');
    this.gl = gl;
    this.canvasEl = canvas;
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.onContextLost?.();
    });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // No cull face: points and lines have no facing.

    this.pointProgram = linkProgram(gl, VS, FS);
    this.lineProgram = linkProgram(gl, LINE_VS, LINE_FS);
    for (const name of ['uViewProj', 'uHeightPx']) {
      this.pointUniforms[name] = gl.getUniformLocation(this.pointProgram, name);
    }
    for (const name of ['uViewProj', 'uAlpha']) {
      this.lineUniforms[name] = gl.getUniformLocation(this.lineProgram, name);
    }

    const floor = floorLines(100);
    const f = this.makeLineVao(floor.verts);
    this.floorVao = f.vao;
    this.floorCount = floor.count;
    this.floorBufs = [f.buffer];
    const axes = axisLines(3);
    const a = this.makeLineVao(axes.verts);
    this.axisVao = a.vao;
    this.axisCount = axes.count;
    this.axisBufs = [a.buffer];

    this.camera.attach(canvas);
    this.resize();
  }

  private makeLineVao(verts: Float32Array): { vao: WebGLVertexArrayObject; buffer: WebGLBuffer } {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, buffer: buf };
  }

  get canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  addLayer(id: string, accent = 0x4c7dff): IRenderLayer {
    let l = this.layers.get(id);
    if (!l) {
      l = new PointsLayer(id, this.gl);
      this.layers.set(id, l);
    }
    void accent;
    return l;
  }

  removeLayer(id: string) {
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
  }

  layer(id: string): IRenderLayer | undefined {
    return this.layers.get(id);
  }

  setVisibleLayer(_id: string | null): void { /* the pane chooses its own layer */ }

  resize() {
    if (this.disposed) return;
    const w = this.canvasHost.clientWidth || 1;
    const h = this.canvasHost.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvasEl.width = Math.max(1, Math.round(w * dpr));
    this.canvasEl.height = Math.max(1, Math.round(h * dpr));
    this.canvasEl.style.width = w + 'px';
    this.canvasEl.style.height = h + 'px';
    this.onResize();
  }

  frame(contentRadius: number, groundSize = 0, extent = contentRadius, target?: Vec3, radiusScale = 2.6) {
    this.camera.frame(contentRadius, groundSize, target, radiusScale);
    void extent;
  }

  updateCamera(): void { /* orbit state applies at draw time */ }

  render(slots: RenderSlot[]) {
    if (this.disposed) return;
    const gl = this.gl;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.933, 0.945, 0.965, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let drawCalls = 0;
    let instances = 0;
    const n = Math.max(1, slots.length);
    const panes: { id: string | null; rect: [number, number, number, number] }[] = [];
    if (n === 1) {
      panes.push({ id: slots[0]?.id ?? null, rect: [0, 0, w, h] });
    } else {
      const { cols, rows } = slotGrid(n);
      const cw = Math.floor(w / cols);
      const ch = Math.floor(h / rows);
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        panes.push({ id: slots[i].id, rect: [col * cw, h - (row + 1) * ch, cw, ch] });
      }
    }
    if (panes.length > 1) gl.enable(gl.SCISSOR_TEST);

    for (const pane of panes) {
      const [x, y, pw, ph] = pane.rect;
      gl.viewport(x, y, pw, ph);
      if (panes.length > 1) gl.scissor(x, y, pw, ph);
      const vp = this.camera.viewProj(pw, ph);

      // Floor first, depth-write off so the points always win.
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, vp);
      gl.uniform1f(this.lineUniforms.uAlpha, 0.55);
      gl.depthMask(false);
      gl.bindVertexArray(this.floorVao);
      gl.drawArrays(gl.LINES, 0, this.floorCount);
      gl.bindVertexArray(this.axisVao);
      gl.uniform1f(this.lineUniforms.uAlpha, 1);
      gl.drawArrays(gl.LINES, 0, this.axisCount);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      drawCalls += 2;

      if (pane.id) {
        const layer = this.layers.get(pane.id);
        if (layer) {
          const d = layer.drawable;
          if (d.vao && d.count > 0) {
            gl.useProgram(this.pointProgram);
            gl.uniformMatrix4fv(this.pointUniforms.uViewProj, false, vp);
            gl.uniform1f(this.pointUniforms.uHeightPx, ph);
            gl.bindVertexArray(d.vao);
            // One call for the entire scene. That is the whole point.
            gl.drawArrays(gl.POINTS, 0, d.count);
            gl.bindVertexArray(null);
            drawCalls++;
            instances += d.count;
          }
        }
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    this.lastDrawCalls = drawCalls;
    this.lastInstances = instances;
  }

  stats(): RenderStats {
    if (this.disposed) return {};
    let bufferBytes = 0;
    let points = 0;
    for (const l of this.layers.values()) {
      bufferBytes += (l as unknown as { positions: Float32Array }).positions.byteLength
        + (l as unknown as { colors: Float32Array }).colors.byteLength;
      points = Math.max(points, l.instanceCount);
    }
    return {
      drawCalls: this.lastDrawCalls,
      // A point is not a triangle. The column says so rather than reporting 0
      // (which would look like "this backend drew nothing").
      triangles: 0,
      instances: this.lastInstances,
      geometries: 0,
      textures: 0,
      programs: 2,
      bufferBytes,
      notes: {
        triangles: '点云后端不提交三角形，每个刚体只有一个顶点',
        drawCalls: '整个场景一次 drawArrays + 网格与坐标轴各一次',
        geometries: '没有几何体：点云不携带形状信息',
        instances: `场景中共 ${points} 个点，与刚体数一一对应`,
      },
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
      aspect: r3(this.canvasEl.width / Math.max(1, this.canvasEl.height)),
      rendererSize: [this.canvasEl.width, this.canvasEl.height],
      cssSize: [this.canvasEl.clientWidth, this.canvasEl.clientHeight],
    };
    out.__backend = { kind: 'webgl2', renderer: meta.name, mode: 'points' };
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const b of [...this.floorBufs, ...this.axisBufs]) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.floorVao);
    gl.deleteVertexArray(this.axisVao);
    gl.deleteProgram(this.pointProgram);
    gl.deleteProgram(this.lineProgram);
    this.canvasEl.remove();
  }
}

export function create(): IRenderEngine {
  return new PointsRenderEngine();
}
