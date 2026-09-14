import { describe, expect, it } from 'vitest';
import { Play } from '../src/game/Play.ts';
import { Command } from '../src/game/types.ts';
import { level } from './helpers.ts';

const rows = [
  '#######',
  '#.....#',
  '#.1...#',
  '#=2=12#',
  '#######',
];

describe('pointer input queue', () => {
  it('a new tap is not blocked by a command that can no longer act', () => {
    const play = new Play(level(rows, { cursor: [1, 1] }), { blastFreezeMs: 700 });
    // a tap meant to pick up a block that has gone by the time the cursor arrives:
    // its select is left latched on an empty cell
    play.enqueue([Command.Select]);
    play.update(50);
    expect(play.state.latched).toBe(Command.Select);
    // the next tap must still move the cursor
    expect(play.goTo({ x: 4, y: 1 })).toBe(true);
    play.update(200);
    expect(play.state.cursor).toEqual({ x: 4, y: 1 });
  });

  it('keeps taking taps after many blasts', () => {
    const play = new Play(level([
      '########',
      '#......#',
      '#1.1.2.#',
      '#==3=3=#',
      '#2=====#',
      '########',
    ], { cursor: [1, 1] }), { blastFreezeMs: 700 });
    play.goTo({ x: 1, y: 2 }, true);
    play.update(300);
    play.enqueue([Command.Right, Command.Select], false);
    play.update(3000);
    expect(play.state.score).toBeGreaterThan(0);
    // tap an empty cell, then another
    play.goTo({ x: 6, y: 1 });
    play.update(500);
    play.goTo({ x: 2, y: 1 });
    play.update(500);
    expect(play.state.cursor).toEqual({ x: 2, y: 1 });
  });
});
