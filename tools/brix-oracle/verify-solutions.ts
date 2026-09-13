// Plays the solver's solutions in the emulated original BRIX.EXE and checks that the
// original declares each level cleared.
//
//   node tools/brix-oracle/verify-solutions.ts [levels...]
//
// Moves are replayed closed-loop, in the original's own timing: before each move the
// executor waits for the original's board to settle (and, for a "wait" move, for its
// elevator to reach the next row), then keys in the cursor path, Space, the push, Space.

import fs from 'node:fs';
import path from 'node:path';
import type { LevelData } from '../../src/levels/format.ts';
import { Oracle, KEYS } from './oracle.mjs';
import type { OracleState } from './snapshot.ts';

const root = path.resolve(import.meta.dirname, '../..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const solDir = path.join(root, 'tests/fixtures/solutions');
const only = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);

type Key = keyof typeof KEYS;
const oracle = new Oracle(path.join(root, 'reference/brix100'));

const settled = (s: OracleState) => s.falling.length === 0 && s.fallOffset === 0;

/**
 * Wait until pred holds for stableMs of *running* game loop. During a blast the original's
 * loop is frozen inside the match routine, so the board looks settled while blocks are
 * still about to vanish; fall steps are counted to tell the difference.
 */
function waitFor(pred: (s: OracleState) => boolean, stableMs: number, maxMs = 15000): boolean {
  let stable = 0, sinceFall = 0;
  for (let t = 0; t < maxMs; t += 2) {
    if (oracle.ended != null) return true;
    const before = oracle.events!.length;
    oracle.runMs(2);
    sinceFall = oracle.events!.slice(before).some(e => e.type === 'fall') ? 0 : sinceFall + 2;
    if (sinceFall <= 16 && pred(oracle.state())) {
      stable += 2;
      if (stable >= stableMs) return true;
    } else stable = 0;
  }
  return false;
}

function press(key: Key): void {
  oracle.press(...KEYS[key]);
  oracle.runMs(14); // the original redraws the cursor on the vertical retrace, so it takes about one key per frame
}

function cursorPath(s: OracleState, tx: number, ty: number): Key[] {
  const h = s.board.length, w = s.board[0].length;
  const [cx, cy] = s.cursor;
  const prev = new Map<number, number>([[cy * w + cx, -1]]);
  const q = [cy * w + cx];
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % w, y = (c - x) / w;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx, ny = y + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || prev.has(n) || s.board[ny][nx] === 0x0b) continue;
      prev.set(n, c);
      q.push(n);
    }
  }
  const out: Key[] = [];
  for (let c = ty * w + tx; prev.get(c) !== -1; c = prev.get(c)!) {
    const p = prev.get(c)!;
    if (p === undefined) return [];
    const dx = (c % w) - (p % w);
    out.push(dx === 1 ? 'right' : dx === -1 ? 'left' : c > p ? 'down' : 'up');
  }
  return out.reverse();
}

let cleared = 0, total = 0;
for (const file of fs.readdirSync(solDir).filter(f => f.endsWith('.json')).sort()) {
  const sol = JSON.parse(fs.readFileSync(path.join(solDir, file), 'utf8')) as { level: number; moves: string; finalScore: number };
  if (only.length && !only.includes(sol.level)) continue;
  total++;
  const level = pack.levels[sol.level - 1];
  oracle.loadProblem(sol.level - 1);
  oracle.startRecording();
  let note = '';
  for (const move of sol.moves.split(' ')) {
    if (oracle.ended != null) break;
    if (move === 'wait') {
      const e0 = oracle.state().elevator!;
      const y0 = e0.y, d0 = e0.dir;
      waitFor(s => !!s.elevator && (s.elevator.y !== y0 || s.elevator.dir !== d0) && s.elevator.offset === 0 && s.elevator.pause === 0, 1, 20000);
      waitFor(settled, 40);
      continue;
    }
    const m = /^(\d+),(\d+)([LR])(\d*)(?:@(-?\d+),(-?\d+),(-?\d+),(\d+))?$/.exec(move)!;
    const x = Number(m[1]), y = Number(m[2]);
    if (!waitFor(settled, 40)) { note = 'never settled'; break; }
    const s = oracle.state();
    if (s.board[y][x] < 1 || s.board[y][x] > 8) { note = `no block at ${x},${y} before move ${move}`; break; }
    for (const k of cursorPath(s, x, y)) press(k);
    if (m[5] !== undefined) {
      // phase-lock the pick-up to the elevator state the solver made it at
      const [ey, off, dir, pause] = [m[5], m[6], m[7], m[8]].map(Number);
      const locked = waitFor(st => !!st.elevator && st.elevator.y === ey && st.elevator.offset === off && st.elevator.dir === dir && st.elevator.pause === pause && settled(st), 0.1, 30000);
      if (!locked) { note = `elevator never reached ${m[5]},${m[6]},${m[7]},${m[8]}`; break; }
    }
    press('space');
    for (let i = 0; i < (Number(m[4]) || 1); i++) press(m[3] === 'L' ? 'left' : 'right');
    press('space');
  }
  if (oracle.ended == null) waitFor(() => oracle.ended != null, 1, 10000);
  const ok = oracle.ended === 2;
  if (ok) cleared++;
  const st = oracle.state();
  console.log(`level ${sol.level}: ${ok ? 'CLEARED in the original' : `NOT cleared${note ? ` (${note})` : ''}`} · original score ${st.score} before bonuses, time left ${st.time[0]}:${String(st.time[1]).padStart(2, '0')}${level.elevator ? ' [elevator]' : ''}`);
}
console.log(`${cleared} / ${total} solutions clear the original`);
process.exit(cleared === total ? 0 : 1);
