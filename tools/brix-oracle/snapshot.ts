// A canonical, comparable snapshot of rules state — the same shape whether it is
// read from the original's memory (oracle.mjs) or from the modern engine.

import type { GameState } from '../../src/game/types.ts';
import { Command } from '../../src/game/types.ts';

export interface Snapshot {
  board: number[][]; // [y][x]
  cursor: [number, number];
  carrying: number;
  riding: number;
  cursorFalling: number;
  falling: [number, number][];
  fallOffset: number;
  elevator: { x: number; y: number; stack: number; offset: number; dir: number; pause: number } | null;
  chain: number;
  remaining: number;
  counts: number[];
  score: number;
  latched: number;
}

export const KEY_CODES: Record<Command, number> = {
  [Command.Up]: 0x48, [Command.Down]: 0x50, [Command.Left]: 0x4b, [Command.Right]: 0x4d, [Command.Select]: 0x20,
};
export const COMMAND_OF_CODE = new Map<number, Command>(Object.entries(KEY_CODES).map(([c, k]) => [k, c as Command]));

export function engineSnapshot(s: GameState): Snapshot {
  const board: number[][] = [];
  for (let y = 0; y < s.height; y++) board.push(Array.from(s.cells.subarray(y * s.width, (y + 1) * s.width)));
  return {
    board,
    cursor: [s.cursor.x, s.cursor.y],
    carrying: +s.carrying,
    riding: +s.riding,
    cursorFalling: +s.cursorFalling,
    falling: s.falling.map(f => [f.x, f.y]),
    fallOffset: s.fallOffset,
    elevator: s.elevator ? { ...s.elevator } : null,
    chain: s.chain,
    remaining: s.remaining,
    counts: [...s.counts],
    score: s.score,
    latched: s.latched === null ? 0 : KEY_CODES[s.latched],
  };
}

// Shape produced by Oracle.state() in oracle.mjs.
export interface OracleState {
  board: number[][];
  cursor: [number, number];
  carrying: number;
  riding: number;
  fallingWithBlock: number;
  falling: [number, number][];
  fallOffset: number;
  elevator: Snapshot['elevator'];
  chain: number;
  remaining: number;
  counts: number[];
  score: number;
  key: number;
}

export function oracleSnapshot(o: OracleState): Snapshot {
  return {
    board: o.board,
    cursor: o.cursor,
    carrying: o.carrying,
    riding: o.riding,
    cursorFalling: o.fallingWithBlock,
    falling: o.falling,
    fallOffset: o.fallOffset,
    elevator: o.elevator,
    chain: o.chain,
    remaining: o.remaining,
    counts: o.counts,
    score: o.score,
    latched: COMMAND_OF_CODE.has(o.key) ? o.key : 0,
  };
}

export function snapshotKey(s: Snapshot): string {
  return JSON.stringify(s);
}

export function hashSnapshot(s: Snapshot): string {
  const str = snapshotKey(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const TILE_NAME: Record<number, string> = { 0: 'EMPTY', 10: 'WALL', 11: 'FRAME', 12: 'ELEVATOR', 13: 'VOID' };
export const tileName = (v: number) => TILE_NAME[v] ?? (v >= 1 && v <= 8 ? `BLOCK_${v}` : `0x${v.toString(16)}`);

/** Human-readable differences, e.g. "cell (4,7): expected BLOCK_3, actual BLOCK_5". */
export function diffSnapshots(expected: Snapshot, actual: Snapshot): string[] {
  const out: string[] = [];
  for (let y = 0; y < expected.board.length; y++) {
    for (let x = 0; x < expected.board[y].length; x++) {
      const e = expected.board[y][x], a = actual.board[y]?.[x];
      if (e !== a) out.push(`cell (${x},${y}): expected ${tileName(e)}, actual ${a === undefined ? 'missing' : tileName(a)}`);
    }
  }
  for (const k of Object.keys(expected) as (keyof Snapshot)[]) {
    if (k === 'board') continue;
    const e = JSON.stringify(expected[k]), a = JSON.stringify(actual[k]);
    if (e !== a) out.push(`${k}: expected ${e}, actual ${a}`);
  }
  return out;
}
