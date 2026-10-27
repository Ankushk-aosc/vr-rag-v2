/**
 * Adaptive Voice Activity Detection.
 *
 * Fed with RMS energy samples (~30 per second). Tracks the room's noise floor with a slow
 * exponential average and derives start/stop thresholds from it (with hysteresis), so the same
 * settings work for a quiet office and a noisy laptop fan. End-of-utterance is declared after a
 * continuous silence once enough speech has been heard — the same turn-taking ChatGPT and Claude
 * voice modes use.
 */

export interface VadOptions {
  /** Silence after speech that ends the user's turn (ms). */
  silenceMs?: number;
  /** Minimum voiced duration before an utterance counts (ms). */
  minSpeechMs?: number;
  /** Absolute floor for the start threshold so near-silent rooms don't trigger on breaths. */
  minStartThreshold?: number;
  /** Multiplier over the noise floor required to count as speech. */
  startRatio?: number;
  stopRatio?: number;
}

export interface VadFrame {
  /** Currently above the speech threshold. */
  voiced: boolean;
  /** An utterance has started (enough voiced audio heard). */
  inUtterance: boolean;
  /** The utterance just ended on this frame. */
  endOfUtterance: boolean;
  /** Milliseconds of silence since the last voiced frame (0 while voiced). */
  silenceMs: number;
  /** Normalised level for visualisers, 0..1. */
  level: number;
}

export class AdaptiveVad {
  private floor = 0.004;
  private voicedMs = 0;
  private lastVoicedAt = 0;
  private lastSampleAt = 0;
  private inUtterance = false;
  private voiced = false;
  private smoothLevel = 0;
  /** RMS of the last ~1.5 s, for minimum-statistics noise tracking. */
  private recent: number[] = [];
  private readonly opts: Required<VadOptions>;

  constructor(options: VadOptions = {}) {
    this.opts = {
      silenceMs: options.silenceMs ?? 1100,
      minSpeechMs: options.minSpeechMs ?? 280,
      minStartThreshold: options.minStartThreshold ?? 0.012,
      startRatio: options.startRatio ?? 3.0,
      stopRatio: options.stopRatio ?? 1.8,
    };
  }

  get noiseFloor(): number {
    return this.floor;
  }

  get startThreshold(): number {
    return Math.max(this.opts.minStartThreshold, this.floor * this.opts.startRatio);
  }

  /** Forget the current utterance but keep the learned noise floor. */
  reset(): void {
    this.voicedMs = 0;
    this.lastVoicedAt = 0;
    this.inUtterance = false;
    this.voiced = false;
  }

  update(rms: number, now: number): VadFrame {
    const dt = this.lastSampleAt ? Math.min(100, now - this.lastSampleAt) : 33;
    this.lastSampleAt = now;

    const start = this.startThreshold;
    const stop = Math.max(this.opts.minStartThreshold * 0.6, this.floor * this.opts.stopRatio);
    this.voiced = this.voiced ? rms > stop : rms > start;

    if (!this.voiced) {
      // Learn the noise floor only from non-speech frames; rise slowly, fall faster.
      const rate = rms > this.floor ? 0.02 : 0.08;
      this.floor = Math.max(0.0015, this.floor + (rms - this.floor) * rate);
    }
    // Minimum statistics: speech always has short dips between words, steady noise never does.
    // If even the quietest frame of the last 1.5 s sits above the floor, the floor is too low
    // (fan noise, AGC boosting a quiet room) and would otherwise pin the VAD in "speech" forever.
    this.recent.push(rms);
    if (this.recent.length > 45) this.recent.shift();
    if (this.recent.length >= 30) {
      const quietest = Math.min(...this.recent);
      if (quietest > this.floor) this.floor += (quietest - this.floor) * 0.06;
    }

    let endOfUtterance = false;
    if (this.voiced) {
      this.voicedMs += dt;
      this.lastVoicedAt = now;
      if (!this.inUtterance && this.voicedMs >= this.opts.minSpeechMs) this.inUtterance = true;
    } else if (!this.inUtterance && this.lastVoicedAt && now - this.lastVoicedAt > 600) {
      // a short blip (cough, click) that never became speech
      this.voicedMs = 0;
    }

    const silenceMs = this.voiced || !this.lastVoicedAt ? 0 : now - this.lastVoicedAt;
    if (this.inUtterance && !this.voiced && silenceMs >= this.opts.silenceMs) {
      endOfUtterance = true;
      this.reset();
    }

    const target = Math.min(1, Math.max(0, (rms - this.floor) / 0.09));
    this.smoothLevel += (target - this.smoothLevel) * (target > this.smoothLevel ? 0.55 : 0.18);

    return { voiced: this.voiced, inUtterance: this.inUtterance, endOfUtterance, silenceMs, level: this.smoothLevel };
  }
}

/** Root-mean-square energy of a time-domain buffer. */
export function rmsOf(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}
