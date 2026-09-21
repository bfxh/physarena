/** Timing aggregation used by both the live HUD and the benchmark report. */

export interface TimingSummary {
  samples: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  stddev: number;
  /** 1 / mean, i.e. how many steps this solver could sustain per second. */
  equivalentFps: number;
}

export function summarize(samples: Float64Array | number[]): TimingSummary {
  const n = samples.length;
  if (n === 0) {
    return {
      samples: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0,
      stddev: 0, equivalentFps: 0,
    };
  }

  const sorted = Float64Array.from(samples as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i] - mean;
    variance += d * d;
  }
  variance /= n;

  return {
    samples: n,
    mean,
    min: sorted[0],
    max: sorted[n - 1],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    stddev: Math.sqrt(variance),
    equivalentFps: mean > 0 ? 1000 / mean : 0,
  };
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Rolling window used for the live per-frame readout. */
export class RollingWindow {
  private buf: Float64Array;
  private count = 0;
  private head = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear() {
    this.count = 0;
    this.head = 0;
  }

  get length() {
    return this.count;
  }

  /**
   * The window's values in buffer order (NOT recency order once the ring has
   * wrapped). `summarize` sorts, so the order is irrelevant to every current
   * caller - do not assume "most recent first" here.
   */
  values(): Float64Array {
    return this.buf.slice(0, this.count);
  }

  summary(): TimingSummary {
    return summarize(this.values());
  }
}
