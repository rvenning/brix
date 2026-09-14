// One problem being played: the simulation plus everything a presentation needs
// around it (pausing, an input queue for pointer gestures, event draining).
//
// Rules live in rules.ts; timing in simulation.ts. This class only sequences them.

import { createGame, peek } from './rules.ts';
import { PIT_HZ, Simulation } from './simulation.ts';
import { Command, type GameEvent, type GameState, type GridPosition } from './types.ts';
import { Tile, isBlock, type LevelData } from '../levels/format.ts';
import type { ClockState } from './types.ts';

export interface PlayOptions {
  blastFreezeMs: number;
  /** Carried over from the session: cumulative score and, on a retry, the clock and retries. */
  score?: number;
  clock?: ClockState;
  retriesLeft?: number;
}

export interface InputRecord {
  /** Simulated time (PIT counts) at which the command was handed to the rules. */
  counts: number;
  command: Command;
}

export class Play {
  readonly level: LevelData;
  readonly state: GameState;
  readonly sim: Simulation;
  paused = false;
  /** Commands waiting to be fed one per loop pass (pointer paths and drags). */
  private queue: Command[] = [];
  /** Every command handed to the rules, with its time, so a run can be replayed exactly. */
  readonly inputs: InputRecord[] = [];

  constructor(level: LevelData, opts: PlayOptions) {
    this.level = level;
    this.state = createGame(level);
    if (opts.score !== undefined) this.state.score = opts.score;
    if (opts.clock) this.state.clock = { ...opts.clock, running: true };
    if (opts.retriesLeft !== undefined) this.state.retriesLeft = opts.retriesLeft;
    this.sim = new Simulation(this.state, { blastFreezeMs: opts.blastFreezeMs });
  }

  get status() { return this.state.status; }

  private replay: InputRecord[] | null = null;
  private replayIndex = 0;
  private replayTarget = 0;

  /** Play back recorded inputs at exactly their recorded simulated times; live input is ignored. */
  startReplay(inputs: InputRecord[]): void {
    this.replay = inputs;
    this.replayIndex = 0;
    this.replayTarget = this.sim.counts;
  }

  get replaying(): boolean {
    return this.replay !== null;
  }

  private updateReplay(dtMs: number): void {
    const inputs = this.replay!;
    this.replayTarget += (dtMs * PIT_HZ) / 1000;
    while (this.replayIndex < inputs.length && inputs[this.replayIndex].counts <= this.replayTarget && this.state.status === 'playing') {
      const input = inputs[this.replayIndex++];
      while (this.sim.counts < input.counts && this.state.status === 'playing') this.sim.step();
      this.sim.press(input.command);
    }
    this.sim.runUntil(Math.floor(this.replayTarget));
  }

  /** Advance real time. Feeds queued commands between loop passes. */
  update(dtMs: number): void {
    if (this.paused || this.state.status !== 'playing') return;
    if (this.replay) {
      this.updateReplay(dtMs);
      return;
    }
    // Feed the queue in small slices so a path of several moves resolves within a frame
    // but still one command per pass, as the original's single-key latch requires.
    let left = dtMs;
    while (left > 0 && this.state.status === 'playing') {
      this.feed();
      const slice = Math.min(left, 2);
      this.sim.advance(slice);
      left -= slice;
    }
  }

  private feed(): void {
    const s = this.state;
    if (this.queue.length === 0) return;
    if (s.latched !== null) {
      // A push into something solid will never succeed: abandon the rest of the drag's pushes.
      if ((s.latched === Command.Left || s.latched === Command.Right) && s.carrying && s.falling.length === 0) {
        const d = s.latched === Command.Left ? -1 : 1;
        if (peek(s, s.cursor.x + d, s.cursor.y) !== Tile.Empty) {
          this.queue = this.queue.filter(c => c === Command.Select);
          if (this.queue.length) this.pressNow(this.queue.shift()!);
        }
      }
      return;
    }
    this.pressNow(this.queue.shift()!);
  }

  private pressNow(command: Command): void {
    this.inputs.push({ counts: this.sim.counts, command });
    this.sim.press(command);
  }

  /** A key press: replaces whatever is latched, exactly like the original keyboard read. */
  press(command: Command): void {
    if (this.paused || this.replay || this.state.status !== 'playing') return;
    this.queue = [];
    this.pressNow(command);
  }

  /**
   * Queue commands to be delivered in order, each once the previous one has acted.
   * A new gesture (`replace`) starts by replacing whatever is latched, just as a key press
   * would: otherwise a command that can never act (a pick-up aimed at a block that fell or
   * blasted before the cursor arrived) would hold every later tap in the queue forever.
   */
  enqueue(commands: Command[], replace = true): void {
    if (this.paused || this.replay || this.state.status !== 'playing') return;
    if (replace) {
      this.queue = [];
      if (this.state.latched !== null && commands.length) {
        this.pressNow(commands[0]);
        commands = commands.slice(1);
      }
    }
    this.queue.push(...commands);
  }

  get queued(): readonly Command[] { return this.queue; }

  /** Cursor route to `target` through every cell the cursor may enter (everything but the frame). */
  pathTo(target: GridPosition, from: GridPosition = this.state.cursor): Command[] | null {
    const s = this.state;
    if (from.x === target.x && from.y === target.y) return [];
    const w = s.width, h = s.height;
    const prev = new Int32Array(w * h).fill(-1);
    const seen = new Uint8Array(w * h);
    const q = [from.y * w + from.x];
    seen[q[0]] = 1;
    const dirs: [number, number, Command][] = [[0, -1, Command.Up], [0, 1, Command.Down], [-1, 0, Command.Left], [1, 0, Command.Right]];
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % w, y = (i - x) / w;
      if (x === target.x && y === target.y) break;
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || peek(s, nx, ny) === Tile.Frame || peek(s, nx, ny) === Tile.Void) continue;
        seen[ni] = 1;
        prev[ni] = i;
        q.push(ni);
      }
    }
    const t = target.y * w + target.x;
    if (!seen[t]) return null;
    const out: Command[] = [];
    for (let i = t; i !== from.y * w + from.x; i = prev[i]) {
      const p = prev[i];
      const dx = (i % w) - (p % w), dy = Math.round((i - p - dx) / w);
      out.push(dx === 1 ? Command.Right : dx === -1 ? Command.Left : dy === 1 ? Command.Down : Command.Up);
    }
    return out.reverse();
  }

  /** Pointer: go to a cell. Drops a carried block first. Returns false if the cell cannot be reached. */
  goTo(target: GridPosition, thenSelect = false): boolean {
    const s = this.state;
    const cmds: Command[] = [];
    const from = s.cursor;
    if (s.carrying) {
      if (from.x === target.x && from.y === target.y) return true;
      cmds.push(Command.Select);
    }
    const path = this.pathTo(target, from);
    if (!path) return false;
    cmds.push(...path);
    if (thenSelect && isBlock(peek(s, target.x, target.y))) cmds.push(Command.Select);
    this.enqueue(cmds);
    return true;
  }

  drainEvents(): GameEvent[] {
    const e = this.state.events;
    this.state.events = [];
    return e;
  }
}
