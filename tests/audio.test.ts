// The sound engine against a fake Web Audio context, which records node lifetimes and
// start times. Guards the causes of crackling on iPad: leaked nodes, catch-up bursts,
// notes starting in the past, and unbounded overlap.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDLE_SUSPEND_MS, MAX_VOICES, SoundEngine } from '../src/audio/audio.ts';

class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
}

class FakeNode {
  static live = 0;
  connected = false;
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  threshold = new FakeParam();
  ratio = new FakeParam();
  type = '';
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startTime = -1;
  stopTime = -1;
  readonly ctx: FakeContext;
  constructor(ctx: FakeContext) { this.ctx = ctx; }
  connect<T>(next: T): T {
    if (!this.connected) FakeNode.live++;
    this.connected = true;
    return next;
  }
  disconnect() {
    if (this.connected) FakeNode.live--;
    this.connected = false;
  }
  start(t: number) { this.startTime = t; this.ctx.sources.push(this); }
  stop(t: number) { this.stopTime = t; }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  state = 'running';
  destination = {};
  sources: FakeNode[] = [];
  createGain() { return new FakeNode(this); }
  createOscillator() { return new FakeNode(this); }
  createBiquadFilter() { return new FakeNode(this); }
  createBufferSource() { return new FakeNode(this); }
  createDynamicsCompressor() { return new FakeNode(this); }
  createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  /** Advance time, firing onended for every source whose stop time has passed. */
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const s of this.sources) {
      if (s.onended && s.stopTime <= this.currentTime) {
        const fn = s.onended;
        s.onended = null;
        fn();
      }
    }
  }
}

let ctx: FakeContext;
let timers: { fn: () => void; at: number }[] = [];
let clock = 0;
const runTimers = (ms: number) => { clock += ms; for (const tm of timers.filter(x => x.at <= clock)) { timers = timers.filter(x => x !== tm); tm.fn(); } };
beforeEach(() => {
  FakeNode.live = 0;
  timers = [];
  clock = 0;
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: class { constructor() { ctx = new FakeContext(); return ctx; } },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => { const tm = { fn, at: clock + ms }; timers.push(tm); return timers.length; },
    clearTimeout: () => { timers = []; },
  };
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function engine(): SoundEngine {
  const a = new SoundEngine();
  a.unlock();
  return a;
}

describe('sound engine', () => {
  it('releases every node once its sound has finished', () => {
    const a = engine();
    const busNodes = FakeNode.live;
    for (let level = 0; level < 20; level++) {
      a.push(); a.land(); a.charge(3); a.blast(3, 0.3); a.bonus(0.4); a.clear();
      ctx.advance(3);
    }
    expect(a.activeVoices).toBe(0);
    expect(FakeNode.live).toBe(busNodes);
  });

  it('caps overlapping sounds', () => {
    const a = engine();
    for (let i = 0; i < 200; i++) a.countUp();
    expect(a.activeVoices).toBe(MAX_VOICES);
  });

  it('never schedules a sound in the past', () => {
    const a = engine();
    ctx.currentTime = 10;
    a.blast(2, -0.5);
    expect(Math.min(...ctx.sources.map(s => s.startTime))).toBeGreaterThanOrEqual(10);
  });

  it('skips missed music instead of playing it all at once when the timer runs late', () => {
    const a = engine();
    a.startMusic();
    a.schedule();
    const before = ctx.sources.length;
    ctx.advance(5); // the scheduler did not run for five seconds
    a.schedule();
    const burst = ctx.sources.slice(before);
    expect(burst.length).toBeLessThan(6);
    expect(Math.min(...burst.map(s => s.startTime))).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it('suspends the audio context on a quiet screen and wakes it for the next sound', () => {
    const a = engine();
    a.ui();
    ctx.advance(1);
    runTimers(IDLE_SUSPEND_MS);
    expect(ctx.state).toBe('suspended');
    a.ui();
    expect(ctx.state).toBe('running');
  });

  it('stays awake while music is playing', () => {
    const a = engine();
    a.startMusic();
    a.ui();
    ctx.advance(1);
    runTimers(IDLE_SUSPEND_MS * 3);
    expect(ctx.state).toBe('running');
  });
});
