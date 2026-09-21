/**
 * Guard rails.
 *
 * This lab deliberately runs nine third-party solvers, four renderers and a
 * pile of wasm across one page, and every one of those boundaries can fail in a
 * way that used to take the whole session down:
 *
 *  - an unrecoverable wasm trap (Jolt's `DestroyBody`, PhysX's hull bake)
 *    leaves the module permanently poisoned, so every later call throws;
 *  - a lost GPU context leaves a blank stage with no explanation;
 *  - one solver stepping a 500-body scene can eat the frame budget and make the
 *    UI feel frozen even though nothing crashed;
 *  - a solver's own `stats()` / `readStates()` throwing takes the HUD with it.
 *
 * Every one of those crossings now goes through a guard. A failure degrades
 * *that* engine (or *that* renderer) and leaves an explicit, timestamped record
 * instead of a blank page - the "door" the user asked for.
 */

export type GuardKind =
  /** A guarded call threw. */
  | 'throw'
  /** A guarded call exceeded its time budget. */
  | 'budget'
  /** A subsystem reported itself unusable (context lost, module poisoned). */
  | 'fault'
  /** A quota (instances / triangles / memory) was exceeded and cut back. */
  | 'quota';

export interface GuardEvent {
  kind: GuardKind;
  /** Which subsystem: a scene id, an engine id, a renderer id, 'frame'. */
  scope: string;
  message: string;
  at: number;
  /** Consecutive occurrences of the same (kind, scope) pair. */
  repeat: number;
}

export interface GuardListener {
  (event: GuardEvent): void;
}

/** Per-scope bookkeeping for quarantine decisions. */
interface ScopeState {
  failures: number;
  lastAt: number;
  quarantined: boolean;
  reason?: string;
}

/**
 * A failing engine is quarantined after this many consecutive failures, so a
 * poisoned wasm module cannot keep burning frames (or keep throwing into the
 * console) for the rest of the session.
 */
const QUARANTINE_AFTER = 3;

export class Guards {
  private events: GuardEvent[] = [];
  private scopes = new Map<string, ScopeState>();
  private listeners: GuardListener[] = [];
  /** Cap so a runaway failure loop cannot grow this without bound. */
  private readonly maxEvents = 200;
  /** Suppress repeated identical reports within this window. */
  private readonly repeatWindowMs = 4000;

  onEvent(fn: GuardListener): void {
    this.listeners.push(fn);
  }

  /** Every recorded event, newest last. */
  get log(): readonly GuardEvent[] {
    return this.events;
  }

  recent(n = 6): GuardEvent[] {
    return this.events.slice(-n);
  }

  clear(): void {
    this.events = [];
  }

  isQuarantined(scope: string): boolean {
    return this.scopes.get(scope)?.quarantined === true;
  }

  quarantineReason(scope: string): string | undefined {
    return this.scopes.get(scope)?.reason;
  }

  /** Lifts a quarantine (used when a world is rebuilt from scratch). */
  release(scope: string): void {
    this.scopes.delete(scope);
  }

  /**
   * Runs `fn`, returning `fallback` if it throws.
   *
   * Use on every boundary that crosses into third-party code. The failure is
   * recorded, and after QUARANTINE_AFTER consecutive failures the scope is
   * marked unusable so callers can skip it entirely.
   */
  attempt<T>(scope: string, fn: () => T, fallback: T): T {
    try {
      const out = fn();
      this.succeed(scope);
      return out;
    } catch (e) {
      this.report('throw', scope, describe(e));
      return fallback;
    }
  }

  /** Same as `attempt`, for async boundaries. */
  async attemptAsync<T>(scope: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const out = await fn();
      this.succeed(scope);
      return out;
    } catch (e) {
      this.report('throw', scope, describe(e));
      return fallback;
    }
  }

  /**
   * Measures a synchronous call and reports when it blows its budget.
   *
   * The call still completes - JavaScript cannot be interrupted - but an
   * over-budget frame is recorded and surfaced, which is what turns "the UI
   * felt stuck" into a number the user can act on.
   */
  budgeted<T>(scope: string, budgetMs: number, fn: () => T, fallback: T): T {
    const t0 = performance.now();
    const out = this.attempt(scope, fn, fallback);
    const dt = performance.now() - t0;
    if (dt > budgetMs) {
      this.report(
        'budget',
        scope,
        `${dt.toFixed(1)} ms 超过 ${budgetMs} ms 预算（本帧其余工作被挤掉）`,
      );
    }
    return out;
  }

  /** Records a subsystem fault (lost context, poisoned module). */
  fault(scope: string, message: string): void {
    this.report('fault', scope, message);
  }

  /** Records a quota being applied, so silently reduced quality is visible. */
  quota(scope: string, message: string): void {
    this.report('quota', scope, message);
  }

  report(kind: GuardKind, scope: string, message: string): void {
    const now = Date.now();
    const st = this.scopes.get(scope) ?? { failures: 0, lastAt: 0, quarantined: false };

    // Success/failure bookkeeping only counts real failures, not quotas.
    if (kind === 'throw' || kind === 'fault') {
      st.failures++;
      st.lastAt = now;
      if (st.failures >= QUARANTINE_AFTER && !st.quarantined) {
        st.quarantined = true;
        st.reason = `${scope} 连续失败 ${st.failures} 次，已隔离：${message}`;
      }
    }
    this.scopes.set(scope, st);

    // Collapse a repeating identical failure into one entry with a counter,
    // instead of filling the log (and the console) with thousands of lines.
    const last = this.events[this.events.length - 1];
    if (last && last.kind === kind && last.scope === scope && last.message === message &&
        now - last.at < this.repeatWindowMs) {
      last.repeat++;
      last.at = now;
      this.emit(last);
      return;
    }

    const event: GuardEvent = { kind, scope, message, at: now, repeat: 1 };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.emit(event);
  }

  private succeed(scope: string): void {
    const st = this.scopes.get(scope);
    // A clean call clears the consecutive-failure count, but a quarantine is
    // only lifted explicitly: a poisoned wasm module can throw-then-work once
    // in a while, and re-admitting it silently would just repeat the failure.
    if (st && st.failures > 0 && !st.quarantined) {
      st.failures = 0;
    }
  }

  private emit(event: GuardEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // A broken listener must not break the guard itself.
      }
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/**
 * Frame-time watchdog.
 *
 * A single frame that takes far longer than the display period is the earliest
 * visible symptom of a solver run away with the main thread. This tracks the
 * worst recent frame and reports when it crosses a hard ceiling, so the panel
 * can say "this engine stalls the page" rather than the user guessing.
 */
export class FrameWatchdog {
  private lastAt = 0;
  private worstMs = 0;
  private worstAt = 0;

  constructor(private readonly ceilingMs = 250) {}

  /** Call once per frame; returns the frame duration in ms. */
  tick(now: number): number {
    if (this.lastAt === 0) {
      this.lastAt = now;
      return 0;
    }
    const dt = now - this.lastAt;
    this.lastAt = now;
    if (dt > this.worstMs) {
      this.worstMs = dt;
      this.worstAt = now;
    }
    return dt;
  }

  get worst(): number {
    return this.worstMs;
  }

  get worstAtMs(): number {
    return this.worstAt;
  }

  /** True when the worst recent frame blew the ceiling. */
  get stalled(): boolean {
    return this.worstMs > this.ceilingMs;
  }

  /** Human-readable verdict for the metric panel. */
  verdict(): string {
    if (this.worstMs === 0) return '尚无样本';
    if (this.worstMs > this.ceilingMs) {
      return `${this.worstMs.toFixed(0)} ms（超过 ${this.ceilingMs} ms 上限）`;
    }
    return `${this.worstMs.toFixed(0)} ms（正常）`;
  }

  reset(): void {
    this.lastAt = 0;
    this.worstMs = 0;
    this.worstAt = 0;
  }
}

/**
 * Bounds a promise that crosses into an API which can simply never settle.
 *
 * WebGPU is the case that forced this: `requestAdapter()` on a headless or
 * software-rendered Chrome does not reject, it hangs - the page sits there with
 * no error, no spinner and no way to switch renderer. A timeout turns "the tab
 * is frozen" into a message the user can act on.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
