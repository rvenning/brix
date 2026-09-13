import { describe, expect, it } from 'vitest';
import { Command } from '../src/game/types.ts';
import { elevatorStep, fallStep, keyPass, matchScan, peek, SUBSTEPS } from '../src/game/rules.ts';
import { Tile } from '../src/levels/format.ts';
import { elevatorSteps, game, key, picture, settle } from './helpers.ts';

describe('board creation', () => {
  it('counts blocks per type and in total', () => {
    const s = game([
      '######',
      '#1.2.#',
      '#1=2.#',
      '######',
    ]);
    expect(s.remaining).toBe(4);
    expect(s.counts[1]).toBe(2);
    expect(s.counts[2]).toBe(2);
  });

  it('places the elevator from the level metadata, over whatever the grid holds', () => {
    const s = game([
      '#####',
      '#...#',
      '#...#',
      '#####',
    ], { elevator: [1, 2, -1] });
    expect(peek(s, 1, 2)).toBe(Tile.Elevator);
    expect(s.elevator).toMatchObject({ x: 1, y: 2, dir: -1, stack: 0, offset: 0 });
  });
});

describe('cursor', () => {
  const rows = [
    '#####',
    '#.=.#',
    '#...#',
    '#####',
  ];

  it('moves freely over empty cells and inner walls', () => {
    const s = game(rows, { cursor: [1, 1] });
    key(s, Command.Right);
    expect(s.cursor).toEqual({ x: 2, y: 1 });
    key(s, Command.Right);
    expect(s.cursor).toEqual({ x: 3, y: 1 });
  });

  it('stops at the frame, and the key stays latched', () => {
    const s = game(rows, { cursor: [1, 1] });
    key(s, Command.Up);
    expect(s.cursor).toEqual({ x: 1, y: 1 });
    expect(s.latched).toBe(Command.Up);
    // a new key replaces a latched one
    key(s, Command.Down);
    expect(s.cursor).toEqual({ x: 1, y: 2 });
    expect(s.latched).toBeNull();
  });
});

describe('picking up and moving blocks', () => {
  it('only picks up blocks', () => {
    const s = game(['#####', '#.1.#', '#####'], { cursor: [1, 1] });
    key(s, Command.Select);
    expect(s.carrying).toBe(false);
    expect(s.latched).toBe(Command.Select);
    key(s, Command.Right);
    key(s, Command.Select);
    expect(s.carrying).toBe(true);
  });

  it('moves a carried block sideways into empty cells only', () => {
    const s = game(['######', '#.1.=#', '######'], { cursor: [2, 1] });
    key(s, Command.Select);
    key(s, Command.Right);
    expect(picture(s)[1]).toBe('#..1=#');
    expect(s.cursor).toEqual({ x: 3, y: 1 });
    key(s, Command.Right); // wall
    expect(picture(s)[1]).toBe('#..1=#');
    expect(s.latched).toBe(Command.Right);
  });

  it('never moves a block vertically', () => {
    const s = game(['####', '#..#', '#1.#', '####'], { cursor: [1, 2] });
    key(s, Command.Select);
    key(s, Command.Up);
    expect(s.cursor).toEqual({ x: 1, y: 2 });
    expect(picture(s)[2]).toBe('#1.#');
  });

  it('refuses every block move while anything is falling, then applies the latched move', () => {
    const s = game([
      '######',
      '#2...#',
      '#=..1#',
      '#=...#',
      '######',
    ], { cursor: [1, 1] });
    // block 1 at (4,2) is unsupported and starts falling on the first fall step
    fallStep(s);
    expect(s.falling.length).toBe(1);
    key(s, Command.Select);
    key(s, Command.Right);
    expect(s.cursor.x).toBe(1);
    expect(s.latched).toBe(Command.Right);
    settle(s);
    keyPass(s);
    expect(s.cursor.x).toBe(2);
    expect(picture(s)[1]).toBe('#.2..#');
  });

  it('resets the chain when a block is moved', () => {
    const s = game(['#####', '#1..#', '#####'], { cursor: [1, 1] });
    s.chain = 5;
    key(s, Command.Select);
    key(s, Command.Right);
    expect(s.chain).toBe(0);
  });
});

describe('gravity', () => {
  const ledge = [
    '#####',
    '#1..#',
    '#=..#',
    '#=..#',
    '#####',
  ];

  it('drops an unsupported block one cell per 16 fall steps', () => {
    const s = game(ledge, { cursor: [1, 1] });
    key(s, Command.Select);
    key(s, Command.Right);
    fallStep(s); // finds the falling block and moves it 1/16
    expect(s.falling).toEqual([{ x: 2, y: 1 }]);
    for (let i = 1; i < SUBSTEPS; i++) fallStep(s);
    expect(picture(s)[2]).toBe('#=1.#');
    settle(s);
    expect(picture(s)[3]).toBe('#=1.#');
  });

  it('carries the cursor down with a carried block', () => {
    const s = game(ledge, { cursor: [1, 1] });
    key(s, Command.Select);
    key(s, Command.Right);
    settle(s);
    expect(s.cursor).toEqual({ x: 2, y: 3 });
    expect(s.carrying).toBe(true);
  });
});

describe('matching', () => {
  it('removes two touching blocks of a type and scores 100', () => {
    const s = game(['######', '#1.1.#', '#2==2#', '######'], { cursor: [1, 1] });
    key(s, Command.Select);
    key(s, Command.Right);
    fallStep(s);
    expect(picture(s)[1]).toBe('#....#');
    expect(s.score).toBe(100);
    expect(s.events.some(e => e.type === 'blast')).toBe(true);
  });

  it('removes a whole connected group at once, scoring (n - 1) x 100', () => {
    const s = game([
      '#####',
      '#...#',
      '#11.#',
      '#1=2#',
      '#2===',
      '#####',
    ], { cursor: [3, 1] });
    matchScan(s, 1);
    expect(picture(s)[2]).toBe('#...#');
    expect(s.score).toBe(200);
    expect(s.chain).toBe(3);
  });

  it('adds a chain bonus once more than three blocks have gone since the last move', () => {
    const s = game([
      '######',
      '#11..#',
      '#==..#',
      '#11..#',
      '#=2=2#',
      '######',
    ]);
    matchScan(s, 1);
    // both pairs are found in one scan: 4 cells listed
    expect(s.chain).toBe(4);
    expect(s.score).toBe(300 + 400);
  });

  it('does not match blocks that are still falling', () => {
    const s = game([
      '#####',
      '#1..#',
      '#...#',
      '#1..#',
      '#####',
    ]);
    fallStep(s);
    expect(s.falling).toEqual([{ x: 1, y: 1 }]);
    expect(s.remaining).toBe(2);
    settle(s);
    expect(s.remaining).toBe(0);
  });

  it('ends the level when the last blocks go, with the clear and time bonuses', () => {
    const s = game(['#####', '#11.#', '#####'], { time: [0, 30], tree: 3 });
    fallStep(s);
    expect(s.status).toBe('cleared');
    // 100 for the pair + 3 x 1000 clear bonus + 30 s x 3 x 100
    expect(s.score).toBe(100 + 3000 + 9000);
  });
});

describe('elevator', () => {
  // the two 5s never meet; they only keep the level from counting as cleared
  const shaft = [
    '#####',
    '#.=5#',
    '#.==#',
    '#.=5#',
    '#E==#',
    '#####',
  ];

  it('moves a sixteenth of a cell per step and changes row after 16', () => {
    const s = game(shaft, { elevator: [1, 4, -1] });
    elevatorStep(s); // at rest: starts moving
    expect(s.elevator!.offset).toBe(-1);
    elevatorSteps(s, 15);
    expect(s.elevator!.y).toBe(3);
    expect(peek(s, 1, 3)).toBe(Tile.Elevator);
    expect(peek(s, 1, 4)).toBe(Tile.Empty);
  });

  it('reverses at an obstruction and waits 10 steps', () => {
    const s = game(shaft, { elevator: [1, 4, -1] });
    elevatorSteps(s, 16 * 3); // up to row 1
    expect(s.elevator!.y).toBe(1);
    elevatorStep(s); // blocked above: reverse
    expect(s.elevator!.dir).toBe(1);
    expect(s.elevator!.pause).toBe(10);
    elevatorSteps(s, 10);
    expect(s.elevator!.offset).toBe(0);
    elevatorStep(s);
    expect(s.elevator!.offset).toBe(1);
  });

  it('lifts the blocks standing on it', () => {
    const s = game([
      '#####',
      '#..=#',
      '#..=#',
      '#2.=#',
      '#E.=#',
      '#####',
    ], { elevator: [1, 4, -1] });
    elevatorSteps(s, 16);
    expect(picture(s).slice(2, 5)).toEqual(['#2.=#', '#E.=#', '#..=#']);
    expect(s.elevator!.stack).toBe(1);
  });

  it('lists the middle of three equal stacked blocks twice (original quirk)', () => {
    const s = game([
      '####',
      '#.=#',
      '#3=#',
      '#3=#',
      '#3=#',
      '#E=#',
      '####',
    ], { elevator: [1, 5, -1] });
    // add a fourth, unrelated block so the level does not end
    s.cells[1 * 4 + 1] = 4;
    s.remaining = 4;
    elevatorStep(s); // at rest: recount, mode-3 scan
    const blast = s.events.find(e => e.type === 'blast');
    expect(blast && blast.type === 'blast' && blast.cells.length).toBe(4);
    // three blocks went, but four were subtracted
    expect(s.remaining).toBe(0);
    expect(s.status).toBe('cleared');
  });
});
