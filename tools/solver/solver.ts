// A best-first solver for BRIX problems, running the modern engine itself.
//
// A move is "push the block at (x, y) one cell left or right", then let the board settle.
// On elevator levels a "wait" move lets the elevator travel to its next row, and every
// push also records the elevator's exact state when the block was picked up, so the move
// can be replayed phase-locked (by the modern scheduler or the emulated original).
//
// Levels without an elevator are searched on the rules alone: with nothing else moving,
// only fall steps change the board, so settling is just "fall step until quiet".
// Solutions are then realised as timed key presses through the real scheduler, with a
// key at most every KEY_GAP_PASSES passes (the original accepts about one key per frame).

import { Simulation } from '../../src/game/simulation.ts';
import { createGame, fallStep, keyPass, peek, pressKey } from '../../src/game/rules.ts';
import { cloneState } from '../../src/game/simulation.ts';
import { Command, type ElevatorState, type GameState } from '../../src/game/types.ts';
import { Tile, isBlock, type LevelData } from '../../src/levels/format.ts';

export type ElevatorMark = Pick<ElevatorState, 'y' | 'offset' | 'dir' | 'pause'>;
export type Action =
  | { kind: 'push'; x: number; y: number; dir: -1 | 1; cells: number; at?: ElevatorMark }
  | { kind: 'wait' };

export interface TimedCommand { counts: number; command: Command }

export interface Solution {
  actions: Action[];
  inputs: TimedCommand[];
  clearedAtCounts: number;
  score: number;
  nodesExpanded: number;
}

export interface SolveOptions {
  maxNodes?: number;
  maxMs?: number;
  blastFreezeMs?: number;
  /** Depth weights to try in turn (see solve). */
  weights?: number[];
  /** On elevator levels, retry with the fine state key if the coarse searches fail. */
  fineFallback?: boolean;
}

/** 28 passes = 16,800 PIT counts = 14.1 ms: one key per 71 Hz retrace, like the original. */
export const KEY_GAP_PASSES = 28;
let keyGap = KEY_GAP_PASSES;
/** Passes between key presses (search and realisation must use the same value). */
export function setKeyGap(passes: number): void { keyGap = passes; }
const SETTLE_PASSES = 80;
let DEPTH_WEIGHT = 0.5;
export function setDepthWeight(w: number): void { DEPTH_WEIGHT = w; }
const MAX_WAIT_PASSES = 30000;

// ------------------------------------------------------------------ shared helpers

function boardCounts(s: GameState): number[] {
  const c = new Array(9).fill(0);
  for (const v of s.cells) if (isBlock(v)) c[v]++;
  return c;
}
const remainingBlocks = (s: GameState) => boardCounts(s).reduce((a, b) => a + b, 0);

/** Sum over blocks of the Manhattan distance to the nearest other block of the same type. */
function separation(s: GameState): number {
  const pos: [number, number][][] = Array.from({ length: 9 }, () => []);
  for (let i = 0; i < s.cells.length; i++) if (isBlock(s.cells[i])) pos[s.cells[i]].push([i % s.width, Math.floor(i / s.width)]);
  let total = 0;
  for (const list of pos) {
    for (const [x, y] of list) {
      let best = 99;
      for (const [x2, y2] of list) if (x2 !== x || y2 !== y) best = Math.min(best, Math.abs(x - x2) + Math.abs(y - y2) - 1);
      if (best < 99) total += best;
    }
  }
  return total;
}
const hopeless = (s: GameState) => !s.elevator && boardCounts(s).some(n => n === 1);

type Push = { x: number; y: number; dir: -1 | 1; cells: number };

/**
 * Every push of a block by 1..n cells in one direction. A multi-cell push stops at the first
 * cell where the block would fall or would touch a block of its own type, because in play
 * the fall or the blast happens before the next key could arrive.
 */
function pushMoves(s: GameState): Push[] {
  const moves: Push[] = [];
  for (let y = 1; y < s.height - 1; y++) {
    for (let x = 1; x < s.width - 1; x++) {
      const v = peek(s, x, y);
      if (!isBlock(v)) continue;
      // a block with something on top uncovers it on the first step, and that block's fall
      // blocks the next push, so such blocks only ever move one cell at a time
      const covered = isBlock(peek(s, x, y - 1));
      for (const dir of [-1, 1] as const) {
        for (let n = 1; peek(s, x + dir * n, y) === Tile.Empty; n++) {
          moves.push({ x, y, dir, cells: n });
          const nx = x + dir * n;
          const falls = peek(s, nx, y + 1) === Tile.Empty;
          const touches = [[0, -1], [0, 1], [dir, 0]].some(([dx, dy]) => peek(s, nx + dx, y + dy) === v);
          if (falls || touches || covered) break;
        }
      }
    }
  }
  return moves;
}

export function cursorPath(s: GameState, tx: number, ty: number): Command[] | null {
  const w = s.width, h = s.height;
  const start = s.cursor.y * w + s.cursor.x, goal = ty * w + tx;
  const prev = new Int32Array(w * h).fill(-2);
  prev[start] = -1;
  const q = [start];
  for (let i = 0; i < q.length && prev[goal] === -2; i++) {
    const c = q[i], x = c % w, y = (c - x) / w;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -2 || peek(s, nx, ny) === Tile.Frame) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[goal] === -2) return null;
  const out: Command[] = [];
  for (let c = goal; prev[c] !== -1; c = prev[c]) {
    const p = prev[c], dx = (c % w) - (p % w);
    out.push(dx === 1 ? Command.Right : dx === -1 ? Command.Left : c > p ? Command.Down : Command.Up);
  }
  return out.reverse();
}

/** Min-heap by cost; ties resolve in insertion order so searches are deterministic. */
/** A move chain stored as parent links, so search nodes do not copy their history. */
interface Trail { action: Action; parent: Trail | null; depth: number }
const extend = (parent: Trail | null, action: Action): Trail => ({ action, parent, depth: (parent?.depth ?? 0) + 1 });
function unwind(trail: Trail | null): Action[] {
  const out: Action[] = [];
  for (let t = trail; t; t = t.parent) out.push(t.action);
  return out.reverse();
}

class Frontier<T extends { cost: number }> {
  private heap: { node: T; seq: number }[] = [];
  private seq = 0;
  get size() { return this.heap.length; }
  private less(a: number, b: number): boolean {
    const x = this.heap[a], y = this.heap[b];
    return x.node.cost < y.node.cost || (x.node.cost === y.node.cost && x.seq < y.seq);
  }
  push(node: T): void {
    const h = this.heap;
    h.push({ node, seq: this.seq++ });
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop(): T {
    const h = this.heap;
    const top = h[0].node;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(l, m)) m = l;
        if (r < h.length && this.less(r, m)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------------ static levels

function settleStatic(s: GameState): void {
  let quiet = 0;
  for (let i = 0; i < 100000 && s.status === 'playing'; i++) {
    fallStep(s);
    if (s.falling.length === 0 && s.fallOffset === 0) {
      if (++quiet >= 2) return;
    } else quiet = 0;
  }
}

export function solveStatic(level: LevelData, maxNodes: number, deadline: number): { actions: Action[]; nodes: number } | null {
  const start = createGame(level);
  settleStatic(start);
  const frontier = new Frontier<{ s: GameState; trail: Trail | null; cost: number }>();
  frontier.push({ s: start, trail: null, cost: 0 });
  const seen = new Set<string>([String.fromCharCode(...start.cells)]);
  let nodes = 0;
  while (frontier.size && nodes < maxNodes && Date.now() < deadline) {
    const node = frontier.pop();
    nodes++;
    for (const m of pushMoves(node.s)) {
      const s = cloneState(node.s);
      s.cursor = { x: m.x, y: m.y };
      for (const c of [Command.Select, ...new Array<Command>(m.cells).fill(m.dir < 0 ? Command.Left : Command.Right), Command.Select]) {
        pressKey(s, c);
        keyPass(s);
      }
      if (s.latched !== null) continue;
      settleStatic(s);
      const trail = extend(node.trail, { kind: 'push', ...m });
      if (s.status === 'cleared') return { actions: unwind(trail), nodes };
      if (s.status !== 'playing' || hopeless(s)) continue;
      const key = String.fromCharCode(...s.cells);
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push({ s, trail, cost: remainingBlocks(s) * 3 + separation(s) + trail.depth * DEPTH_WEIGHT });
    }
  }
  return null;
}

// ------------------------------------------------------------------ scheduler-driven execution

const blocksSettled = (sim: Simulation) => {
  const s = sim.state;
  return s.falling.length === 0 && s.fallOffset === 0 && !sim.frozen && (s.latched === null || s.latched === Command.Select);
};

function settle(sim: Simulation): boolean {
  let quiet = 0;
  for (let i = 0; i < MAX_WAIT_PASSES && sim.state.status === 'playing'; i++) {
    sim.step();
    if (blocksSettled(sim)) { if (++quiet >= SETTLE_PASSES) return true; } else quiet = 0;
  }
  return sim.state.status === 'cleared';
}

/** Press commands KEY_GAP_PASSES apart; a command still latched when the next is due fails the move. */
function keyIn(sim: Simulation, commands: Command[], inputs: TimedCommand[]): boolean {
  for (const command of commands) {
    if (sim.state.status !== 'playing') return sim.state.status === 'cleared';
    inputs.push({ counts: sim.counts, command });
    sim.press(command);
    for (let i = 0; i < keyGap; i++) {
      sim.step();
      if (sim.state.status !== 'playing') return sim.state.status === 'cleared';
    }
    // a put-down stays latched while the carried block falls and happens when it lands
    if (sim.state.latched !== null && sim.state.latched !== Command.Select) return false;
  }
  return true;
}

const markOf = (e: ElevatorState): ElevatorMark => ({ y: e.y, offset: e.offset, dir: e.dir, pause: e.pause });
const sameMark = (e: ElevatorState, m: ElevatorMark) => e.y === m.y && e.offset === m.offset && e.dir === m.dir && e.pause === m.pause;

function waitForNextRow(sim: Simulation): boolean {
  const e0 = sim.state.elevator!;
  const y0 = e0.y, d0 = e0.dir;
  for (let i = 0; i < MAX_WAIT_PASSES && sim.state.status === 'playing'; i++) {
    sim.step();
    const e = sim.state.elevator!;
    if ((e.y !== y0 || e.dir !== d0) && e.offset === 0 && e.pause === 0) return settle(sim);
  }
  return false;
}

/**
 * Carry out one move through the scheduler. For a push on an elevator level with a mark,
 * wait (after walking the cursor over) until the elevator is exactly in the marked state.
 */
export function perform(sim: Simulation, move: Action, inputs: TimedCommand[], lockToMark: boolean): { ok: boolean; mark?: ElevatorMark } {
  if (move.kind === 'wait') return { ok: waitForNextRow(sim) };
  if (!settle(sim)) return { ok: sim.state.status === 'cleared' };
  const path = cursorPath(sim.state, move.x, move.y);
  if (!path || !keyIn(sim, path, inputs)) return { ok: false };
  if (lockToMark && move.at) {
    let found = false;
    for (let i = 0; i < MAX_WAIT_PASSES && sim.state.status === 'playing'; i++) {
      if (sameMark(sim.state.elevator!, move.at) && blocksSettled(sim)) { found = true; break; }
      sim.step();
    }
    if (!found) return { ok: false };
  }
  if (!isBlock(peek(sim.state, sim.state.cursor.x, sim.state.cursor.y))) return { ok: false };
  const mark = sim.state.elevator ? markOf(sim.state.elevator) : undefined;
  const ok = keyIn(sim, [Command.Select, ...new Array<Command>(move.cells).fill(move.dir < 0 ? Command.Left : Command.Right), Command.Select], inputs);
  return { ok: ok && (sim.state.status !== 'playing' || settle(sim)), mark };
}

let fineElevatorKey = false;
/** Distinguish elevator states by sub-cell phase too (slower, but needed where timing matters). */
export function setFineElevatorKey(on: boolean): void { fineElevatorKey = on; }

function stateKey(sim: Simulation): string {
  const s = sim.state, e = s.elevator!;
  if (fineElevatorKey) return `${String.fromCharCode(...s.cells)}|${e.y},${e.offset},${e.dir},${e.pause},${e.stack}`;
  // deliberately coarse: the elevator's sub-cell phase is left out, so states that differ only
  // in where the lift is within a cell count as one (the exact phase is kept in each move)
  return `${String.fromCharCode(...s.cells)}|${e.y},${e.dir}`;
}

export function solveElevator(level: LevelData, maxNodes: number, deadline: number, blastFreezeMs: number): { actions: Action[]; nodes: number } | null {
  const root = new Simulation(createGame(level), { blastFreezeMs });
  settle(root);
  const frontier = new Frontier<{ sim: Simulation; trail: Trail | null; cost: number }>();
  frontier.push({ sim: root, trail: null, cost: 0 });
  const seen = new Set<string>([stateKey(root)]);
  let nodes = 0;
  while (frontier.size && nodes < maxNodes && Date.now() < deadline) {
    const node = frontier.pop();
    nodes++;
    const moves: Action[] = [...pushMoves(node.sim.state).map(m => ({ kind: 'push' as const, ...m })), { kind: 'wait' }];
    for (const move of moves) {
      const sim = node.sim.clone();
      const res = perform(sim, move, [], false);
      const done: Action = move.kind === 'push' ? { ...move, at: res.mark } : move;
      const trail = extend(node.trail, done);
      if (sim.state.status === 'cleared') return { actions: unwind(trail), nodes };
      if (!res.ok || sim.state.status !== 'playing') continue;
      const key = stateKey(sim);
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push({ sim, trail, cost: remainingBlocks(sim.state) * 3 + separation(sim.state) + trail.depth * DEPTH_WEIGHT + (move.kind === 'wait' ? 0.5 : 0) });
    }
  }
  return null;
}

// ------------------------------------------------------------------ public API

/** Turn moves into timed key presses through a fresh scheduler, and check they clear the level. */
export function realise(level: LevelData, actions: Action[], blastFreezeMs = 1470): Solution | null {
  const sim = new Simulation(createGame(level), { blastFreezeMs });
  const inputs: TimedCommand[] = [];
  for (const move of actions) {
    if (sim.state.status !== 'playing') break;
    if (!perform(sim, move, inputs, true).ok && sim.state.status === 'playing') return null;
  }
  for (let i = 0; i < MAX_WAIT_PASSES && sim.state.status === 'playing'; i++) sim.step();
  if (sim.state.status !== 'cleared') return null;
  return { actions, inputs, clearedAtCounts: sim.counts, score: sim.state.score, nodesExpanded: 0 };
}

export function solve(level: LevelData, opts: SolveOptions = {}): Solution | null {
  const maxNodes = opts.maxNodes ?? 200000;
  const deadline = Date.now() + (opts.maxMs ?? 60000);
  const blast = opts.blastFreezeMs ?? 1470;
  // no single weighting suits every level: greedy finds long easy chains fast, heavier depth
  // weights avoid stranding the last pair. Try several, each with a share of the budget.
  const weights = opts.weights ?? [4, 1, 0.5, 8];
  const start = Date.now(), total = deadline - start;
  for (let i = 0; i < weights.length; i++) {
    setDepthWeight(weights[i]);
    const share = Math.max(1, Math.floor((total - (Date.now() - start)) / (weights.length - i)));
    const until = Math.min(deadline, Date.now() + share);
    const found = level.elevator ? solveElevator(level, maxNodes, until, blast) : solveStatic(level, maxNodes, until);
    if (!found) continue;
    const sol = realise(level, found.actions, blast);
    if (sol) { sol.nodesExpanded = found.nodes; return sol; }
  }
  if (level.elevator && opts.fineFallback) {
    setFineElevatorKey(true);
    setDepthWeight(1);
    const found = solveElevator(level, maxNodes, deadline + (opts.maxMs ?? 60000), blast);
    setFineElevatorKey(false);
    const sol = found && realise(level, found.actions, blast);
    if (sol) { sol.nodesExpanded = found!.nodes; return sol; }
  }
  return null;
}

/** Replay timed commands through a fresh simulation, exactly as recorded. */
export function replaySolution(level: LevelData, inputs: TimedCommand[], blastFreezeMs = 1470): { status: GameState['status']; score: number; counts: number } {
  const sim = new Simulation(createGame(level), { blastFreezeMs });
  for (const input of inputs) {
    while (sim.counts < input.counts && sim.state.status === 'playing') sim.step();
    if (sim.state.status !== 'playing') break;
    sim.press(input.command);
  }
  for (let i = 0; i < 400000 && sim.state.status === 'playing'; i++) sim.step();
  return { status: sim.state.status, score: sim.state.score, counts: sim.counts };
}
