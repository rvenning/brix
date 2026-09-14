// Original sound design, synthesised with the Web Audio API: no audio files, nothing
// from any BRIX release. Sound effects and music have independent switches.

type Wave = OscillatorType;

/** Sounds allowed to overlap. Beyond this, new effects are skipped rather than overloading the audio thread. */
export const MAX_VOICES = 24;
/** Music scheduling lookahead (s). */
const LOOKAHEAD = 0.2;
/** Silence (ms) after which the context is suspended, so the audio thread does no work on quiet screens. */
export const IDLE_SUSPEND_MS = 3000;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  soundOn = true;
  musicOn = true;
  private musicTimer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private intensity = 0;
  /** Sources currently scheduled or playing. */
  activeVoices = 0;
  private idleTimer: number | null = null;

  /** Must be called from a user gesture before anything is audible. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.32;
      this.musicBus.connect(this.master);
      const len = this.ctx.sampleRate * 0.5;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setSound(on: boolean): void { this.soundOn = on; }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (!on) this.stopMusic();
  }

  /**
   * Every node of a voice is disconnected once its source ends. WebKit (iPad Safari) keeps
   * connected nodes alive, so without this the audio graph grows with every sound and the
   * audio thread eventually underruns, which is heard as crackling.
   */
  private track(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.activeVoices++;
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      for (const n of nodes) n.disconnect();
      this.scheduleIdleSuspend();
    };
  }

  private scheduleIdleSuspend(): void {
    if (this.activeVoices > 0 || this.musicTimer !== null || this.idleTimer !== null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.activeVoices === 0 && this.musicTimer === null && this.ctx?.state === 'running') void this.ctx.suspend();
    }, IDLE_SUSPEND_MS);
  }

  private wake(): void {
    if (this.idleTimer !== null) { window.clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume();
  }

  /** Start time for a sound: never in the past, where ramps would jump and click. */
  private startAt(delay: number): number {
    const ctx = this.ctx!;
    return ctx.currentTime + Math.max(0, delay);
  }

  private tone(freq: number, dur: number, opts: { type?: Wave; gain?: number; slideTo?: number; delay?: number; attack?: number; bus?: 'sfx' | 'music'; filter?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || this.activeVoices >= MAX_VOICES) return;
    this.wake();
    const bus = opts.bus === 'music' ? this.musicBus! : this.sfxBus!;
    const t = this.startAt(opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
    const peak = opts.gain ?? 0.2, attack = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = osc;
    const chain: AudioNode[] = [osc, g];
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      node.connect(f);
      node = f;
      chain.push(f);
    }
    node.connect(g).connect(bus);
    this.track(osc, chain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private hiss(dur: number, gain: number, from: number, to: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.activeVoices >= MAX_VOICES) return;
    this.wake();
    const t = this.startAt(delay);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus!);
    this.track(src, [src, f, g]);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  private get can(): boolean { return this.soundOn && !!this.ctx; }

  move(): void { if (this.can) this.tone(740, 0.045, { type: 'triangle', gain: 0.05 }); }
  push(): void { if (this.can) { this.tone(330, 0.07, { type: 'triangle', gain: 0.12, slideTo: 260 }); this.hiss(0.05, 0.04, 1800, 900); } }
  pick(): void { if (this.can) this.tone(520, 0.09, { type: 'sine', gain: 0.14, slideTo: 880 }); }
  drop(): void { if (this.can) this.tone(700, 0.09, { type: 'sine', gain: 0.12, slideTo: 420 }); }
  blocked(): void { if (this.can) this.tone(140, 0.08, { type: 'square', gain: 0.05, filter: 700 }); }
  land(): void { if (this.can) { this.tone(180, 0.1, { type: 'sine', gain: 0.18, slideTo: 90 }); this.hiss(0.06, 0.05, 600, 300); } }
  ui(): void { if (this.can) this.tone(980, 0.05, { type: 'triangle', gain: 0.07 }); }

  /** The flash before a blast; `chain` raises the pitch. */
  charge(chain: number): void {
    if (!this.can) return;
    const base = 440 * Math.pow(2, Math.min(chain, 8) / 12);
    for (let i = 0; i < 4; i++) this.tone(base * (1 + i * 0.25), 0.06, { type: 'square', gain: 0.035, delay: i * 0.06, filter: 3000 });
  }

  blast(chain: number, delay: number): void {
    if (!this.can) return;
    const base = 523.25 * Math.pow(2, Math.min(chain, 10) / 12);
    this.hiss(0.35, 0.22, 3000, 200, delay);
    this.tone(base, 0.4, { type: 'triangle', gain: 0.16, delay });
    this.tone(base * 1.25, 0.4, { type: 'triangle', gain: 0.12, delay: delay + 0.03 });
    this.tone(base * 1.5, 0.5, { type: 'sine', gain: 0.12, delay: delay + 0.06 });
    this.tone(base * 2, 0.6, { type: 'sine', gain: 0.06, delay: delay + 0.09 });
  }

  bonus(delay: number): void {
    if (!this.can) return;
    [0, 4, 7, 12, 16].forEach((st, i) => this.tone(659.25 * Math.pow(2, st / 12), 0.18, { type: 'square', gain: 0.05, delay: delay + i * 0.06, filter: 4000 }));
  }

  clear(): void {
    if (!this.can) return;
    const notes = [0, 4, 7, 12, 7, 12, 16, 19];
    notes.forEach((st, i) => this.tone(392 * Math.pow(2, st / 12), i === notes.length - 1 ? 0.7 : 0.16, { type: 'triangle', gain: 0.16, delay: i * 0.09 }));
    this.tone(196, 1.0, { type: 'sine', gain: 0.12, delay: 0.63 });
  }

  countUp(): void { if (this.can) this.tone(1320, 0.03, { type: 'square', gain: 0.025, filter: 5000 }); }
  warning(): void { if (this.can) this.tone(1046, 0.08, { type: 'square', gain: 0.05, filter: 2500 }); }
  timeUp(): void {
    if (!this.can) return;
    [7, 4, 0, -5].forEach((st, i) => this.tone(392 * Math.pow(2, st / 12), 0.3, { type: 'triangle', gain: 0.15, delay: i * 0.18 }));
  }

  /** 0 calm .. 1 urgent: the music thickens as the clock runs down. */
  setIntensity(v: number): void { this.intensity = Math.max(0, Math.min(1, v)); }

  startMusic(): void {
    if (!this.ctx || !this.musicOn || this.musicTimer !== null) return;
    this.wake();
    this.nextNoteTime = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.musicTimer = window.setInterval(() => this.schedule(), 50);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
    this.scheduleIdleSuspend();
  }

  // A gentle pentatonic loop: bass on beats, arpeggio on eighths, sparkles when urgent.
  schedule(): void {
    const ctx = this.ctx!;
    const beat = 60 / (100 + this.intensity * 30) / 2;
    const chords = [[0, 7, 12, 16], [-3, 4, 9, 12], [-7, 0, 5, 9], [-5, 2, 7, 11]];
    const root = 261.63;
    // A timer that fired late (a busy frame, a throttled tab) must not play every missed
    // note at once: skip ahead to now instead.
    if (this.nextNoteTime < ctx.currentTime) {
      const missed = Math.ceil((ctx.currentTime - this.nextNoteTime) / beat);
      this.nextNoteTime += missed * beat;
      this.step += missed;
    }
    while (this.nextNoteTime < ctx.currentTime + LOOKAHEAD) {
      const bar = Math.floor(this.step / 8) % chords.length;
      const chord = chords[bar];
      const i = this.step % 8;
      const delay = this.nextNoteTime - ctx.currentTime;
      if (i % 4 === 0) this.tone(root / 4 * Math.pow(2, chord[0] / 12), beat * 3.2, { type: 'triangle', gain: 0.22, delay, bus: 'music', filter: 600 });
      const note = chord[[0, 1, 2, 3, 2, 1, 2, 3][i]];
      this.tone(root * Math.pow(2, note / 12), beat * 1.6, { type: 'sine', gain: 0.07, delay, bus: 'music', attack: 0.01 });
      if (this.intensity > 0.6 && i % 2 === 1) this.tone(root * 2 * Math.pow(2, chord[3] / 12), beat, { type: 'triangle', gain: 0.03, delay, bus: 'music' });
      this.nextNoteTime += beat;
      this.step++;
    }
  }
}

export const audio = new SoundEngine();
