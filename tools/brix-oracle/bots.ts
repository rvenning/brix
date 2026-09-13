// Controllers that drive the original while a trace is recorded.

import { Command } from '../../src/game/types.ts';
import type { Controller } from './trace.ts';
import type { OracleState } from './snapshot.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isBlock = (v: number) => v >= 1 && v <= 8;

/**
 * Wanders the board picking up blocks and pushing them a few cells. It reads the
 * original's state, so it plays whatever the original actually does — including
 * pressing keys at awkward moments, which is the point.
 */
export function explorer(seed: number, interval = 110): Controller {
  const rnd = mulberry32(seed);
  let target: { x: number; y: number; dir: number; steps: number } | null = null;
  return {
    interval,
    decide(s: OracleState): Command[] {
      const [cx, cy] = s.cursor;
      const at = (x: number, y: number) => s.board[y]?.[x] ?? 13;
      if (rnd() < 0.04) {
        // occasionally mash a random key, to exercise latching and odd timings
        const all = [Command.Up, Command.Down, Command.Left, Command.Right, Command.Select];
        return [all[Math.floor(rnd() * all.length)]];
      }
      if (s.carrying) {
        if (!target || target.steps <= 0) {
          target = null;
          return [Command.Select];
        }
        target.steps--;
        return [target.dir < 0 ? Command.Left : Command.Right];
      }
      if (!target) {
        const movable: { x: number; y: number; dirs: number[] }[] = [];
        for (let y = 1; y < s.board.length - 1; y++) {
          for (let x = 1; x < s.board[y].length - 1; x++) {
            if (!isBlock(at(x, y))) continue;
            const dirs = [-1, 1].filter(d => at(x + d, y) === 0);
            if (dirs.length) movable.push({ x, y, dirs });
          }
        }
        if (!movable.length) return [];
        const pick = movable[Math.floor(rnd() * movable.length)];
        target = { x: pick.x, y: pick.y, dir: pick.dirs[Math.floor(rnd() * pick.dirs.length)], steps: 1 + Math.floor(rnd() * 3) };
      }
      if (cx === target.x && cy === target.y) {
        if (!isBlock(at(cx, cy))) { target = null; return []; }
        return [Command.Select];
      }
      // stale target (it fell or vanished): re-pick next time
      if (!isBlock(at(target.x, target.y))) { target = null; return []; }
      if (cx !== target.x) {
        const d = target.x < cx ? -1 : 1;
        if (at(cx + d, cy) !== 11) return [d < 0 ? Command.Left : Command.Right];
      }
      if (cy !== target.y) {
        const d = target.y < cy ? -1 : 1;
        if (at(cx, cy + d) !== 11) return [d < 0 ? Command.Up : Command.Down];
      }
      // boxed in by frame walls on the straight route: take a random step
      target = null;
      return [[Command.Up, Command.Down, Command.Left, Command.Right][Math.floor(rnd() * 4)]];
    },
  };
}
