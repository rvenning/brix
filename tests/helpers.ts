import type { ElevatorDirection, LevelData } from '../src/levels/format.ts';
import { createGame, elevatorStep, fallStep, keyPass, pressKey } from '../src/game/rules.ts';
import type { Command, GameState } from '../src/game/types.ts';

/** Build a level from rows of tile characters ('#' frame, '=' wall, '.' empty, '1'-'8' blocks, 'E' elevator). */
export function level(rows: string[], opts: {
  cursor?: [number, number];
  elevator?: [number, number, ElevatorDirection];
  time?: [number, number];
  tree?: number;
} = {}): LevelData {
  const width = rows[0].length;
  return {
    format: 'brix-level/1',
    id: 'test',
    number: 0,
    origin: 'custom',
    tree: opts.tree ? { level: opts.tree, choice: 1, problem: 1 } : undefined,
    width,
    height: rows.length,
    tiles: rows,
    cursor: { x: opts.cursor?.[0] ?? 1, y: opts.cursor?.[1] ?? 1 },
    elevator: opts.elevator ? { x: opts.elevator[0], y: opts.elevator[1], direction: opts.elevator[2] } : null,
    timeLimit: { minutes: opts.time?.[0] ?? 1, seconds: opts.time?.[1] ?? 0 },
  };
}

export function game(rows: string[], opts: Parameters<typeof level>[1] = {}): GameState {
  return createGame(level(rows, opts));
}

/** The board as rows of tile characters, for readable assertions. */
export function picture(s: GameState): string[] {
  const ch: Record<number, string> = { 0: '.', 10: '=', 11: '#', 12: 'E', 13: ' ' };
  const rows: string[] = [];
  for (let y = 0; y < s.height; y++) {
    let r = '';
    for (let x = 0; x < s.width; x++) {
      const v = s.cells[y * s.width + x];
      r += ch[v] ?? String(v);
    }
    rows.push(r);
  }
  return rows;
}

export function key(s: GameState, command: Command): void {
  pressKey(s, command);
  keyPass(s);
}

/** Run fall steps until nothing is falling (and one more to let the match scan run). */
export function settle(s: GameState, maxSteps = 2000): void {
  for (let i = 0; i < maxSteps; i++) {
    fallStep(s);
    if (s.falling.length === 0 && s.fallOffset === 0) {
      fallStep(s);
      if (s.falling.length === 0) return;
    }
  }
  throw new Error('board never settled');
}

export function elevatorSteps(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) elevatorStep(s);
}
