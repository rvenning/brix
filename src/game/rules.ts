// The rules of BRIX 1.00.
//
// Each exported procedure corresponds to one routine of the original executable and
// is written to reach the same state for the same inputs, including the quirks
// (latched keys, stale stack counts, duplicate stack matches). Addresses refer to
// the game code segment of BRIX.EXE; docs/brix-mechanics.md describes each rule in
// prose, and tests/oracle-replay.test.ts checks this file against the original.
//
// Nothing in here knows about time, rendering or sound. The simulation decides when
// fallStep / elevatorStep / keyPass run; renderers read state and drain `events`.

import { Tile, isBlock, type LevelData, tileByte } from '../levels/format.ts';
import { blastPoints, chainBonus, clearBonus, timeBonus } from './scoring.ts';
import { createClock, secondsLeft } from './clock.ts';
import { Command, type GameState, type GridPosition } from './types.ts';

/** Sixteenths of a cell; both falling blocks and the elevator move one sixteenth per step. */
export const SUBSTEPS = 16;
/** Elevator steps the elevator waits after reversing (s309:26BC). */
export const ELEVATOR_PAUSE = 10;

const u16 = (v: number) => v & 0xffff;
const u8 = (v: number) => v & 0xff;

// ---------------------------------------------------------------------------
// Board access. The original stores the board column-major (x * 12 + y), so a
// coordinate just off the top of one column reads the bottom of the previous
// column. Reads and writes go through the same aliasing to stay exact.

function index(s: GameState, x: number, y: number): number {
  const i = x * s.height + y;
  if (i < 0 || i >= s.width * s.height) return -1;
  return (i % s.height) * s.width + Math.floor(i / s.height);
}
export function peek(s: GameState, x: number, y: number): number {
  const i = index(s, x, y);
  return i < 0 ? Tile.Void : s.cells[i];
}
function poke(s: GameState, x: number, y: number, v: number): void {
  const i = index(s, x, y);
  if (i >= 0) s.cells[i] = v;
}

// ---------------------------------------------------------------------------
// Level loading (s309:1453 and s309:08D0).

export function createGame(level: LevelData): GameState {
  const { width, height } = level;
  const cells = new Uint8Array(width * height);
  level.tiles.forEach((row, y) => {
    for (let x = 0; x < width; x++) cells[y * width + x] = tileByte(row[x]);
  });
  const s: GameState = {
    levelId: level.id,
    levelNumber: level.tree?.level ?? 1,
    width,
    height,
    cells,
    cursor: { ...level.cursor },
    latched: null,
    carrying: false,
    riding: false,
    cursorFalling: false,
    falling: [],
    fallOffset: 0,
    elevator: null,
    chain: 0,
    remaining: 0,
    counts: new Array(9).fill(0),
    score: 0,
    clock: createClock(level.timeLimit.minutes, level.timeLimit.seconds),
    retriesLeft: 2,
    status: 'playing',
    events: [],
  };
  if (level.elevator) {
    const { x, y, direction } = level.elevator;
    // The loader writes the elevator tile over whatever the grid holds (level 88 relies on it).
    poke(s, x, y, Tile.Elevator);
    s.elevator = { x, y, stack: 0, offset: 0, dir: direction, pause: 0 };
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const v = peek(s, x, y);
      if (isBlock(v)) {
        s.remaining = u8(s.remaining + 1);
        s.counts[v] = u8(s.counts[v] + 1);
      }
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Keys (s309:3592, in-game branch).

/** A new key replaces whatever was latched, as the original's keyboard read keeps only the last key. */
export function pressKey(s: GameState, command: Command): void {
  s.latched = command;
}

/** One pass of the main loop's key handler. A command that cannot act stays latched and is tried again next pass. */
export function keyPass(s: GameState): void {
  const cmd = s.latched;
  if (cmd === null || s.status !== 'playing') return;
  const c = s.cursor;
  switch (cmd) {
    case Command.Up:
    case Command.Down: {
      if (s.carrying) return; // blocks never move vertically; the key stays latched
      const ny = c.y + (cmd === Command.Up ? -1 : 1);
      if (peek(s, c.x, ny) === Tile.Frame) return;
      s.events.push({ type: 'cursorMoved', from: { ...c }, to: { x: c.x, y: ny } });
      c.y = ny;
      s.latched = null;
      return;
    }
    case Command.Left:
    case Command.Right: {
      const d = cmd === Command.Left ? -1 : 1;
      if (!s.carrying) {
        if (peek(s, c.x + d, c.y) === Tile.Frame) return;
        s.events.push({ type: 'cursorMoved', from: { ...c }, to: { x: c.x + d, y: c.y } });
        c.x += d;
        s.latched = null;
        return;
      }
      if (!canMove(s, d)) return;
      const block = peek(s, c.x, c.y);
      poke(s, c.x + d, c.y, block);
      poke(s, c.x, c.y, Tile.Empty);
      s.events.push({ type: 'blockMoved', from: { ...c }, to: { x: c.x + d, y: c.y }, block });
      c.x += d;
      s.chain = 0;
      s.latched = null;
      if (s.riding) compactStackAfterLeaving(s, c.x - d);
      return;
    }
    case Command.Select: {
      const v = peek(s, c.x, c.y);
      if (!isBlock(v) || s.cursorFalling) return;
      s.carrying = !s.carrying;
      s.events.push({ type: s.carrying ? 'pickedUp' : 'putDown', at: { ...c }, block: v });
      toggleRiding(s);
      s.latched = null;
      return;
    }
  }
}

/** s309:4281 */
function canMove(s: GameState, d: number): boolean {
  const c = s.cursor;
  if (peek(s, c.x + d, c.y) !== Tile.Empty || s.falling.length !== 0) return false;
  const e = s.elevator;
  const offset = e?.offset ?? 0;
  if (s.riding && offset !== 0) return false;
  if (e && c.x + d === e.x) {
    if (e.y + 1 === c.y && offset > 0) return false;
    if (e.y - e.stack - 1 === c.y && offset < 0) return false;
  }
  return true;
}

/**
 * s309:3C45 / s309:4005: a block pulled sideways out of the elevator stack takes its
 * cell with it; everything above drops one row at once. The stack count is left stale.
 */
function compactStackAfterLeaving(s: GameState, column: number): void {
  const e = s.elevator;
  const top = e ? u16(e.y - e.stack) : 0;
  let y = u8(s.cursor.y);
  while (y > top) {
    poke(s, column, y, peek(s, column, y - 1));
    y = u8(y - 1);
  }
  s.riding = false;
  poke(s, column, y, Tile.Empty);
}

/** s309:4226 */
function toggleRiding(s: GameState): void {
  const e = s.elevator;
  if (!e || s.cursor.x !== e.x || e.stack === 0) return;
  const y = s.cursor.y;
  if (u16(e.y - 1) < y) return;
  if (u16(e.y - e.stack) > y) return;
  s.riding = !s.riding;
}

// ---------------------------------------------------------------------------
// Falling (s309:1F95, s309:1E56, s309:2229).

/** s309:1E56: collect every block with nothing under it, then look for matches. */
function findFalling(s: GameState): void {
  const e = s.elevator;
  const dir = e?.dir ?? 0;
  const falling: GridPosition[] = [];
  for (let x = s.width - 2; x > 0; x--) {
    for (let y = s.height - 2; y > 0; y--) {
      if (!isBlock(peek(s, x, y))) continue;
      const below = peek(s, x, y + 1);
      let candidate = below === Tile.Empty;
      // A block resting on a descending elevator's stack but not counted in it keeps falling with it.
      if (!candidate && e && dir > 0 && e.y - e.stack === y + 1 && x === e.x) candidate = true;
      if (!candidate) continue;
      if (e && dir > 0 && below !== Tile.Empty && e.offset === 0 && x === e.x) continue;
      falling.push({ x, y });
    }
  }
  s.falling = falling;
  matchScan(s, 1);
}

/** One fall step: falling blocks advance a sixteenth of a cell. */
export function fallStep(s: GameState): void {
  if (s.status !== 'playing') return;
  if (s.fallOffset === 0) findFalling(s);
  if (s.falling.length === 0) return;
  s.fallOffset++;
  const c = s.cursor;
  for (let i = 0; i < s.falling.length; i++) {
    const { x, y } = s.falling[i];
    if (x === c.x && y === c.y && s.carrying) s.cursorFalling = true;
    if (!landOnElevator(s, x, y)) continue;
    if (s.cursorFalling && x === c.x && y === c.y) {
      s.riding = true;
      s.cursorFalling = false;
      if (s.elevator!.dir < 0) c.y++;
    }
    s.events.push({ type: 'landed', at: { x, y }, block: peek(s, x, y) });
    s.falling.splice(i, 1);
    i--;
    if (s.falling.length === 0) s.fallOffset = 0;
    matchScan(s, 3);
  }
  if (s.fallOffset === SUBSTEPS) {
    s.fallOffset = 0;
    if (s.cursorFalling) {
      c.y++;
      s.cursorFalling = false;
    }
    for (const { x, y } of s.falling) {
      poke(s, x, y + 1, peek(s, x, y));
      poke(s, x, y, Tile.Empty);
    }
    for (const { x, y } of s.falling) {
      if (peek(s, x, y + 2) !== Tile.Empty) s.events.push({ type: 'landed', at: { x, y: y + 1 }, block: peek(s, x, y + 1) });
    }
  }
}

/** s309:2229: a falling block meets the moving elevator mid-cell and joins its stack. */
function landOnElevator(s: GameState, x: number, y: number): boolean {
  const e = s.elevator;
  if (!e || x !== e.x) return false;
  if (e.dir > 0) {
    if (e.y - e.stack - 1 === y && u16(e.offset) <= u16(s.fallOffset)) {
      e.stack++;
      return true;
    }
    return false;
  }
  if (e.dir < 0 && e.y - e.stack - 2 === y && u16(e.offset + SUBSTEPS) <= u16(s.fallOffset)) {
    e.stack++;
    poke(s, x, y + 1, peek(s, x, y));
    poke(s, x, y, Tile.Empty);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The elevator (s309:2346, s309:22D5).

/** s309:22D5: count the blocks standing on the elevator. */
function recountStack(s: GameState): void {
  const e = s.elevator;
  if (!e) return;
  let i = 0;
  while (isBlock(peek(s, e.x, e.y - i - 1))) {
    if (s.cursor.x === e.x && e.y - i - 1 === s.cursor.y && s.carrying) s.riding = true;
    i++;
  }
  e.stack = i;
}

/** One elevator step: the elevator advances a sixteenth of a cell, or turns round at an obstruction. */
export function elevatorStep(s: GameState): void {
  const e = s.elevator;
  if (!e || s.status !== 'playing') return;
  if (e.pause !== 0) {
    e.pause--;
    return;
  }
  if (e.offset !== 0) {
    e.offset += e.dir;
    if (Math.abs(e.offset) !== SUBSTEPS) return;
    e.offset = 0;
    if (e.dir < 0) {
      for (let i = e.stack + 1; i > 0; i--) poke(s, e.x, e.y - i, peek(s, e.x, e.y - i + 1));
      poke(s, e.x, e.y, Tile.Empty);
      e.y--;
    } else {
      for (let i = 0; i <= e.stack; i++) poke(s, e.x, e.y - i + 1, peek(s, e.x, e.y - i));
      poke(s, e.x, e.y - e.stack, Tile.Empty);
      e.y++;
    }
    if (s.riding) s.cursor.y += e.dir;
    matchScan(s, 2);
    return;
  }
  recountStack(s);
  matchScan(s, 3);
  if (s.status !== 'playing') return;
  if (peek(s, e.x, e.y - 1 - e.stack) === Tile.Empty && e.dir < 0) {
    e.offset += e.dir;
  } else if (peek(s, e.x, e.y + 1) === Tile.Empty && e.dir > 0) {
    e.offset += e.dir;
  } else {
    e.dir = -e.dir as -1 | 0 | 1;
    e.pause = ELEVATOR_PAUSE;
    if (e.dir !== 0) s.events.push({ type: 'elevatorReversed', at: { x: e.x, y: e.y } });
  }
}

// ---------------------------------------------------------------------------
// Matching (s309:4301).

/** s309:4DA3 */
function isFalling(s: GameState, x: number, y: number): boolean {
  return s.falling.some(f => f.x === x && f.y === y);
}

/** s309:4D27: is (x, y) the elevator or one of the cells its stack spans, allowing for motion? */
function onElevator(s: GameState, x: number, y: number): boolean {
  const e = s.elevator;
  if (!e || x !== e.x) return false;
  if (e.offset > 0) return !(u16(e.y - e.stack) > y) && !(u16(e.y + 1) < y);
  if (e.offset < 0) return !(u16(e.y - e.stack - 1) > y) && !(y > e.y);
  return !(u16(e.y - e.stack) > y) && !(y > e.y);
}

/**
 * Mode 1 scans the whole board: every settled block with a settled neighbour of the same
 * type is listed once. Mode 2 (the elevator has just changed row) compares each stack block
 * with its left and right neighbours. Mode 3 (the elevator is at rest, or a block has just
 * landed on it) compares each stack block with the cell above it and lists *both* — so a
 * stack of three equal blocks lists the middle one twice.
 */
export function matchScan(s: GameState, mode: 1 | 2 | 3): void {
  const list: GridPosition[] = [];
  const e = s.elevator;
  if (mode === 1) {
    const settledNeighbour = (x: number, y: number, v: number) =>
      peek(s, x, y) === v && !(onElevator(s, x, y) && e!.offset !== 0) && !isFalling(s, x, y);
    for (let x = 1; x < s.width - 1; x++) {
      for (let y = 1; y < s.height - 1; y++) {
        const v = peek(s, x, y);
        if (!isBlock(v) || isFalling(s, x, y)) continue;
        if (onElevator(s, x, y) && e!.offset !== 0) continue;
        if (settledNeighbour(x, y - 1, v) || settledNeighbour(x, y + 1, v)
          || settledNeighbour(x + 1, y, v) || settledNeighbour(x - 1, y, v)) {
          list.push({ x, y });
        }
      }
    }
  } else if (e) {
    if (mode === 2) recountStack(s);
    let sideMatch = false;
    for (let i = 0; i < e.stack; i++) {
      const y = e.y - i - 1;
      const v = peek(s, e.x, y);
      if (mode === 2) {
        if (peek(s, e.x - 1, y) === v && !isFalling(s, e.x - 1, y)) {
          list.push({ x: e.x - 1, y });
          sideMatch = true;
        }
        if (peek(s, e.x + 1, y) === v && !isFalling(s, e.x + 1, y)) {
          list.push({ x: e.x + 1, y });
          sideMatch = true;
        }
        if (sideMatch) {
          list.push({ x: e.x, y });
          sideMatch = false;
        }
      } else if (peek(s, e.x, y - 1) === v) {
        list.push({ x: e.x, y }, { x: e.x, y: y - 1 });
      }
    }
  }
  if (list.length > 0) blast(s, list);
  if (s.status === 'playing' && s.remaining === 0) finishLevel(s);
}

function blast(s: GameState, list: GridPosition[]): void {
  s.chain = u8(s.chain + list.length);
  const cells = list.map(({ x, y }) => ({ x, y, block: peek(s, x, y) }));
  for (const { x, y } of list) {
    const v = peek(s, x, y);
    s.counts[v] = u8(s.counts[v] - 1);
    s.remaining = u8(s.remaining - 1);
    poke(s, x, y, Tile.Empty);
    recountStack(s);
    if (x === s.cursor.x && y === s.cursor.y) {
      s.carrying = false;
      s.riding = false;
    }
  }
  const points = blastPoints(list.length);
  const bonus = chainBonus(s.chain);
  s.score += points + bonus;
  s.events.push({ type: 'blast', cells, chain: s.chain, points, bonus, elevatorOffset: s.elevator?.offset ?? 0 });
}

/** s309:5223 with argument 2. */
function finishLevel(s: GameState): void {
  const clear = clearBonus(s.levelNumber, s.retriesLeft);
  const time = timeBonus(s.levelNumber, secondsLeft(s.clock));
  s.score += clear + time;
  s.clock.running = false;
  s.status = 'cleared';
  s.events.push({ type: 'cleared', bonus: clear + time, clearBonus: clear, timeBonus: time });
}

/** Time ran out (s309:5223 with argument 1). */
export function expire(s: GameState): void {
  if (s.status !== 'playing') return;
  s.status = 'timeUp';
  s.events.push({ type: 'timeUp' });
}
