// Real-time scheduling of the rules.
//
// BRIX 1.00's main loop (s309:2BCC) reads the keyboard, runs the key handler, and
// then fires two timers measured in PIT counts (1,193,182 per second):
//
//   A: more than 30,000 counts since A last fired  -> fall step, then elevator step
//   B: more than 15,000 counts since B last fired  -> fall step
//
// so blocks fall about three sixteenths of a cell per 25 ms and the elevator moves
// one sixteenth. A match freezes the loop — and the clock — while the blast
// animation plays. Because *everything* freezes, the freeze length changes no rule
// outcome and is a presentation choice here (the original's is ~1.47 s).
//
// This scheduler is deterministic: the same inputs at the same simulated times
// always produce the same states, independent of frame rate.

import { clockTick } from './clock.ts';
import { elevatorStep, expire, fallStep, keyPass, pressKey } from './rules.ts';
import type { Command, GameState } from './types.ts';

export const PIT_HZ = 1193182;
export const COUNTS_PER_TICK = 65536;
export const TIMER_A_COUNTS = 30000;
export const TIMER_B_COUNTS = 15000;
/** One main-loop pass. The original's passes are well under a millisecond; 600 counts reproduces its step rates. */
export const PASS_COUNTS = 600;
export const ORIGINAL_BLAST_FREEZE_MS = 1470;

const msToCounts = (ms: number) => Math.round((ms * PIT_HZ) / 1000);

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    cells: s.cells.slice(),
    cursor: { ...s.cursor },
    falling: s.falling.map(f => ({ ...f })),
    elevator: s.elevator ? { ...s.elevator } : null,
    counts: [...s.counts],
    clock: { ...s.clock },
    events: [],
  };
}

export interface SimulationOptions {
  /** How long a blast freezes the game, in ms. */
  blastFreezeMs?: number;
}

export class Simulation {
  readonly state: GameState;
  /** Simulated time in PIT counts. */
  counts = 0;
  private target = 0;
  private lastA = 0;
  private lastB = 0;
  private nextTick = COUNTS_PER_TICK;
  private freeze = 0;
  private readonly blastFreeze: number;
  /** Rule steps run so far; handy for debug overlays. */
  passes = 0;

  constructor(state: GameState, opts: SimulationOptions = {}) {
    this.state = state;
    this.blastFreeze = msToCounts(opts.blastFreezeMs ?? ORIGINAL_BLAST_FREEZE_MS);
  }

  get frozen(): boolean {
    return this.freeze > 0;
  }

  /** Remaining freeze as a fraction 0..1 of the full blast freeze (1 = just started). */
  get freezeProgress(): number {
    return this.blastFreeze ? 1 - this.freeze / this.blastFreeze : 1;
  }

  /** Progress 0..1 towards the next elevator step, for smoothing elevator motion between steps. */
  get elevatorPhase(): number {
    if (this.freeze > 0) return 0;
    return Math.min(1, (this.target - this.lastA) / TIMER_A_COUNTS);
  }

  get elapsedMs(): number {
    return (this.counts * 1000) / PIT_HZ;
  }

  press(command: Command): void {
    pressKey(this.state, command);
  }

  /** An independent copy of the simulation and its game state (for search and what-if tools). */
  clone(): Simulation {
    const c = new Simulation(cloneState(this.state), { blastFreezeMs: (this.blastFreeze * 1000) / PIT_HZ });
    c.counts = this.counts;
    c.target = this.target;
    c.lastA = this.lastA;
    c.lastB = this.lastB;
    c.nextTick = this.nextTick;
    c.freeze = this.freeze;
    c.passes = this.passes;
    return c;
  }

  /** Run exactly one main-loop pass. */
  step(): void {
    if (this.state.status === 'playing') this.pass();
    this.target = Math.max(this.target, this.counts);
  }

  /** Advance simulated time by `ms`, running every loop pass that falls inside it. */
  advance(ms: number): void {
    this.target += msToCounts(ms);
    while (this.counts + PASS_COUNTS <= this.target && this.state.status === 'playing') this.pass();
    if (this.state.status !== 'playing') this.target = this.counts;
  }

  /** Run loop passes until simulated time reaches exactly `counts` (used to replay recorded inputs). */
  runUntil(counts: number): void {
    while (this.counts + PASS_COUNTS <= counts && this.state.status === 'playing') this.pass();
    this.target = Math.max(this.target, this.counts);
  }

  private pass(): void {
    const s = this.state;
    this.counts += PASS_COUNTS;
    this.passes++;
    if (this.freeze > 0) {
      this.freeze -= PASS_COUNTS;
      // the INT 1Ch handler skips ticks while [90h] is clear
      while (this.counts >= this.nextTick) this.nextTick += COUNTS_PER_TICK;
      if (this.freeze <= 0) {
        this.freeze = 0;
        // both timers are long overdue when the loop resumes, so each fires once
        this.lastA = this.counts - TIMER_A_COUNTS - 1;
        this.lastB = this.counts - TIMER_B_COUNTS - 1;
      }
      return;
    }
    while (this.counts >= this.nextTick) {
      this.nextTick += COUNTS_PER_TICK;
      if (clockTick(s.clock)) {
        expire(s);
        return;
      }
    }
    const before = s.events.length;
    keyPass(s);
    if (this.counts - this.lastA > TIMER_A_COUNTS) {
      this.lastA = this.counts;
      fallStep(s);
      elevatorStep(s);
    }
    if (this.counts - this.lastB > TIMER_B_COUNTS) {
      this.lastB = this.counts;
      fallStep(s);
    }
    for (let i = before; i < s.events.length; i++) {
      if (s.events[i].type === 'blast' && s.status === 'playing') {
        this.freeze = this.blastFreeze;
        break;
      }
    }
  }
}
