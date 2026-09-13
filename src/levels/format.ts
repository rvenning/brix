// Canonical level format, shared by the game, the editor and the extraction tools.
//
// A level is stored exactly as the original LEVELS record describes it: the
// tile grid as it appears in the file (the elevator is *placed* by the loader,
// not read from the grid — see level 88) and every metadata byte, including
// the ones the original ignores, so that encoding a canonical level gives back
// the original 178 bytes. docs/level-format.md explains each field.

export const ORIGINAL_WIDTH = 14;
export const ORIGINAL_HEIGHT = 12;
export const ORIGINAL_RECORD_SIZE = 178;
export const ORIGINAL_LEVEL_COUNT = 112;

export const Tile = {
  Empty: 0x00,
  Wall: 0x0a, // inner wall: solid, the cursor may pass over it
  Frame: 0x0b, // frame wall: solid, the cursor stops at it
  Elevator: 0x0c,
  Void: 0x0d, // outside the playfield
} as const;

export const MIN_BLOCK = 1;
export const MAX_BLOCK = 8;

export const isBlock = (v: number): boolean => v >= MIN_BLOCK && v <= MAX_BLOCK;

const CHAR_OF: Record<number, string> = {
  [Tile.Empty]: '.', [Tile.Wall]: '=', [Tile.Frame]: '#', [Tile.Elevator]: 'E', [Tile.Void]: ' ',
};
for (let b = MIN_BLOCK; b <= MAX_BLOCK; b++) CHAR_OF[b] = String(b);
const BYTE_OF: Record<string, number> = Object.fromEntries(Object.entries(CHAR_OF).map(([b, c]) => [c, Number(b)]));

export const tileChar = (v: number): string => {
  const c = CHAR_OF[v];
  if (c === undefined) throw new Error(`unknown tile byte 0x${v.toString(16)}`);
  return c;
};
export const tileByte = (c: string): number => {
  const b = BYTE_OF[c];
  if (b === undefined) throw new Error(`unknown tile character ${JSON.stringify(c)}`);
  return b;
};

/** -1 = starts moving up, +1 = starts moving down, 0 = never moves. */
export type ElevatorDirection = -1 | 0 | 1;

export interface LevelData {
  format: 'brix-level/1';
  id: string;
  number: number;
  origin: 'original' | 'custom';
  name?: string;
  /** Position in the original level tree, 1-based. Only for original levels. */
  tree?: { level: number; choice: number; problem: number };
  width: number;
  height: number;
  /** One string per row, top to bottom. Characters: see tileChar(). */
  tiles: string[];
  cursor: { x: number; y: number };
  elevator: { x: number; y: number; direction: ElevatorDirection } | null;
  timeLimit: { minutes: number; seconds: number };
  /** Bytes of the original record that carry no gameplay meaning but are kept for exact round-trips. */
  original?: {
    offset: number;
    elevatorDirectionByte: number;
    secondaryElevator: [number, number, number];
  };
}

/** The original loader's reading of the direction byte (s309:1644). */
export function directionFromByte(b: number): ElevatorDirection {
  if (b === 0) return 0;
  return b === 1 ? -1 : 1;
}
function byteFromDirection(d: ElevatorDirection): number {
  return d === 0 ? 0 : d === -1 ? 1 : 2;
}

/** Index 0..111 in file order -> position in the tree (7 levels, level n has n choices of 4 problems). */
export function treePosition(index: number): { level: number; choice: number; problem: number } {
  const choiceIndex = Math.floor(index / 4);
  let level = 1;
  while ((level * (level + 1)) / 2 <= choiceIndex) level++;
  const choice = choiceIndex - ((level - 1) * level) / 2 + 1;
  return { level, choice, problem: (index % 4) + 1 };
}
export function treeIndex(level: number, choice: number, problem: number): number {
  return (((level - 1) * level) / 2 + (choice - 1)) * 4 + (problem - 1);
}

export function decodeOriginalRecord(record: Uint8Array, index: number): LevelData {
  if (record.length !== ORIGINAL_RECORD_SIZE) throw new Error(`record must be ${ORIGINAL_RECORD_SIZE} bytes`);
  const tiles: string[] = [];
  for (let y = 0; y < ORIGINAL_HEIGHT; y++) {
    let row = '';
    for (let x = 0; x < ORIGINAL_WIDTH; x++) row += tileChar(record[y * ORIGINAL_WIDTH + x]);
    tiles.push(row);
  }
  const m = record.subarray(ORIGINAL_WIDTH * ORIGINAL_HEIGHT);
  const hasElevator = m[2] !== 0 && m[3] !== 0; // s309:15D7 - both coordinates must be non-zero
  const number = index + 1;
  return {
    format: 'brix-level/1',
    id: `original-${String(number).padStart(3, '0')}`,
    number,
    origin: 'original',
    tree: treePosition(index),
    width: ORIGINAL_WIDTH,
    height: ORIGINAL_HEIGHT,
    tiles,
    cursor: { x: m[0], y: m[1] },
    elevator: hasElevator ? { x: m[2], y: m[3], direction: directionFromByte(m[4]) } : null,
    timeLimit: { minutes: m[8], seconds: m[9] },
    original: {
      offset: index * ORIGINAL_RECORD_SIZE,
      elevatorDirectionByte: m[4],
      secondaryElevator: [m[5], m[6], m[7]],
    },
  };
}

export function encodeOriginalRecord(level: LevelData): Uint8Array {
  if (level.width !== ORIGINAL_WIDTH || level.height !== ORIGINAL_HEIGHT) {
    throw new Error(`only ${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT} levels fit the original format`);
  }
  const out = new Uint8Array(ORIGINAL_RECORD_SIZE);
  level.tiles.forEach((row, y) => {
    for (let x = 0; x < ORIGINAL_WIDTH; x++) out[y * ORIGINAL_WIDTH + x] = tileByte(row[x]);
  });
  const o = ORIGINAL_WIDTH * ORIGINAL_HEIGHT;
  out[o] = level.cursor.x;
  out[o + 1] = level.cursor.y;
  if (level.elevator) {
    out[o + 2] = level.elevator.x;
    out[o + 3] = level.elevator.y;
  }
  out[o + 4] = level.original?.elevatorDirectionByte ?? (level.elevator ? byteFromDirection(level.elevator.direction) : 0);
  const sec = level.original?.secondaryElevator ?? [0, 0, 0];
  out[o + 5] = sec[0];
  out[o + 6] = sec[1];
  out[o + 7] = sec[2];
  out[o + 8] = level.timeLimit.minutes;
  out[o + 9] = level.timeLimit.seconds;
  return out;
}

/** Structural problems that would make a level unloadable. Returns human-readable messages. */
export function lintLevel(level: LevelData): string[] {
  const problems: string[] = [];
  if (level.tiles.length !== level.height) problems.push(`expected ${level.height} rows, found ${level.tiles.length}`);
  level.tiles.forEach((row, y) => {
    if (row.length !== level.width) problems.push(`row ${y} has ${row.length} characters, expected ${level.width}`);
    for (const ch of row) if (BYTE_OF[ch] === undefined) problems.push(`row ${y} has unknown tile ${JSON.stringify(ch)}`);
  });
  const { x, y } = level.cursor;
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) problems.push('cursor outside the board');
  return problems;
}
