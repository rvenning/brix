export type GridPosition = { x: number; y: number };

/** Commands the rules understand. Input devices translate into these; nothing else touches game state. */
export const Command = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  /** Space in the original: pick up / put down the block under the cursor. */
  Select: 'select',
} as const;
export type Command = (typeof Command)[keyof typeof Command];

export interface ElevatorState {
  x: number;
  /** Row of the elevator tile itself. Riding blocks are stacked directly above it. */
  y: number;
  /** Number of blocks stacked on the elevator, as last counted (the original lets this go stale). */
  stack: number;
  /** Sub-cell offset in sixteenths of a cell, -16..16. Non-zero while the elevator is between rows. */
  offset: number;
  /** -1 up, +1 down, 0 never moves. */
  dir: -1 | 0 | 1;
  /** Elevator steps left to wait after reversing. */
  pause: number;
}

export type GameStatus = 'playing' | 'cleared' | 'timeUp';

export type GameEvent =
  | { type: 'cursorMoved'; from: GridPosition; to: GridPosition }
  | { type: 'blockMoved'; from: GridPosition; to: GridPosition; block: number }
  | { type: 'pickedUp'; at: GridPosition; block: number }
  | { type: 'putDown'; at: GridPosition; block: number }
  | { type: 'blocked'; command: Command }
  | { type: 'landed'; at: GridPosition; block: number }
  | { type: 'elevatorReversed'; at: GridPosition }
  | {
      type: 'blast';
      cells: { x: number; y: number; block: number }[];
      /** Blocks destroyed since the player last moved a block, including these. */
      chain: number;
      points: number;
      bonus: number;
      /** Elevator offset at the moment of the blast, for drawing stack cells mid-motion. */
      elevatorOffset: number;
    }
  | { type: 'cleared'; bonus: number; clearBonus: number; timeBonus: number }
  | { type: 'timeUp' };

export interface GameState {
  levelId: string;
  /** Tree column 1..7; scales the clear and time bonuses. */
  levelNumber: number;
  width: number;
  height: number;
  /** Row-major: cells[y * width + x]. Values are the original tile bytes. */
  cells: Uint8Array;
  cursor: GridPosition;
  /** The key the original is still holding in [0A3h]. A command that cannot act stays latched. */
  latched: Command | null;
  carrying: boolean;
  /** The carried block is part of the elevator stack. */
  riding: boolean;
  /** The carried block is falling and the cursor follows it. */
  cursorFalling: boolean;
  falling: GridPosition[];
  /** Sub-cell progress of the falling blocks, 0..16. */
  fallOffset: number;
  elevator: ElevatorState | null;
  /** Blocks destroyed since the last block move ([0A6h], a byte). */
  chain: number;
  /** Blocks the original believes are left ([8DAh], a byte). The level is cleared when it reaches zero. */
  remaining: number;
  /** Per-type counts for the side panel ([1208h + type]). Index 0 is written by a duplicate-removal quirk. */
  counts: number[];
  score: number;
  clock: ClockState;
  retriesLeft: number;
  status: GameStatus;
  events: GameEvent[];
}

export interface ClockState {
  minutes: number;
  seconds: number;
  /** BIOS ticks until the displayed time drops by one second. Starts at 21. */
  subTicks: number;
  running: boolean;
}
