export const DEFAULT_LIVE_RATE_WINDOW_MS = 2000;
export const MIN_LIVE_RATE_WINDOW_MS = 500;
export const MAX_LIVE_RATE_WINDOW_MS = 10000;
export const MIN_LIVE_RATE_SAMPLE_MS = 300;

/** Resolve the rolling window without allowing an accidental redraw-heavy value. */
export function liveRateWindowMs(raw = process.env.PI_ACTIVITY_LIVE_WINDOW_MS) {
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_LIVE_RATE_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LIVE_RATE_WINDOW_MS;
  return Math.min(MAX_LIVE_RATE_WINDOW_MS, Math.max(MIN_LIVE_RATE_WINDOW_MS, Math.round(value)));
}

/**
 * A short rolling decode-rate estimate over cumulative streamed characters.
 *
 * Each checkpoint is the character total after one streaming delta. The
 * oldest checkpoint inside the window is the baseline, so the first burst is
 * not divided by a near-zero interval. Passing `now` to rate() makes the value
 * decay during a stall even when the provider emits no new events.
 */
export class LiveTokenRate {
  constructor(windowMs = DEFAULT_LIVE_RATE_WINDOW_MS, minSampleMs = MIN_LIVE_RATE_SAMPLE_MS) {
    this.windowMs = windowMs;
    this.minSampleMs = minSampleMs;
    this.totalChars = 0;
    this.checkpoints = [];
    this.head = 0;
  }

  reset() {
    this.totalChars = 0;
    this.checkpoints = [];
    this.head = 0;
  }

  add(chars, now = Date.now()) {
    if (!Number.isFinite(chars) || chars <= 0 || !Number.isFinite(now)) return;
    this.totalChars += chars;
    const last = this.checkpoints.at(-1);
    if (last?.at === now) {
      last.totalChars = this.totalChars;
    } else {
      this.checkpoints.push({ at: now, totalChars: this.totalChars });
    }
  }

  rate(now = Date.now()) {
    if (!Number.isFinite(now) || this.checkpoints.length === 0) return undefined;
    const cutoff = now - this.windowMs;
    // Retain one cumulative checkpoint at/before the window as its baseline.
    while (this.head + 1 < this.checkpoints.length && this.checkpoints[this.head + 1].at <= cutoff) {
      this.head += 1;
    }
    // Compact occasionally; advancing an index avoids repeated O(n) shifts on
    // high-frequency streams.
    if (this.head > 1024 && this.head * 2 > this.checkpoints.length) {
      this.checkpoints = this.checkpoints.slice(this.head);
      this.head = 0;
    }
    const baseline = this.checkpoints[this.head];
    const elapsedMs = Math.max(0, now - baseline.at);
    if (elapsedMs < this.minSampleMs) return undefined;
    const chars = Math.max(0, this.totalChars - baseline.totalChars);
    return (chars / 4) / (elapsedMs / 1000);
  }
}
